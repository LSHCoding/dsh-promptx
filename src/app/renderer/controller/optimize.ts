// 优化会话（需求 O-01 至 O-08，技术方案 5.5「优化的快照」「优化的其他规则」，审查 COV-08、TC-07）。
// 会话放在插件内存里，小窗只显示插件推来的快照和增量，发起、追加、重试、取消、清空都是请求。

import { isBlank } from '../../../shared/text-metrics.ts'
import type { ErrorInfo, OptimizeEvent, OptimizeRound, OptimizeSession } from '../../../shared/types.ts'
import type { OptimizeSlice } from '../state/state.ts'
import { describe, dialogButton, reason, runTask, text, type Context } from './context.ts'
import type { Dialogs } from './dialogs.ts'
import type { PaneLayout } from './layout.ts'
import type { Toasts } from './toasts.ts'

function isRunning(round: OptimizeRound): boolean {
  return round.status === 'running'
}

type SubmissionSource = 'editor' | 'chat' | 'followup'

/**
 * 请求的结果和推送的快照可能乱序到达。结果里的会话不能让已经结束的一轮退回「进行中」，
 * 也不能丢掉已经收到的增量文字：同一轮在本地更长、且以结果里的回复开头时保留本地的。
 */
export function mergeSession(current: OptimizeSession | null, incoming: OptimizeSession): OptimizeSession {
  if (current === null || current.id !== incoming.id) return incoming
  const rounds = incoming.rounds.map((round) => {
    const known = current.rounds.find(item => item.id === round.id)
    if (known === undefined) return round
    if (!isRunning(known) && isRunning(round)) return known
    if (isRunning(known) && isRunning(round) && known.reply.length > round.reply.length && known.reply.startsWith(round.reply)) {
      return { ...round, reply: known.reply }
    }
    return round
  })
  return { ...incoming, rounds }
}

export class Optimize {
  /** 每一轮开始时（第一轮、追加、重试）编辑区的全文。「应用」拿编辑区和这一轮的快照比较（O-04）。 */
  private readonly snapshots = new Map<string, string>()
  /** 已经丢弃或清空的会话：迟到的请求结果不能把它们重新显示出来。 */
  private readonly ended = new Set<string>()
  /** 无可用模型时只收起由这轮优化自动展开的聊天栏。 */
  private autoOpenedSessionId: string | null = null
  /** 聊天栏发起的第一轮被丢弃时，可以把已提交的文字放回输入框。 */
  private chatStartedSessionId: string | null = null

  constructor(
    private readonly ctx: Context,
    private readonly toasts: Toasts,
    private readonly dialogs: Dialogs,
    private readonly layout: PaneLayout,
    /** 一轮结束时把焦点放到追加输入框（O-05：只在焦点原本在会话栏里或小窗里没有焦点时）。 */
    private readonly focusFollowup: () => void,
  ) {}

  get state(): OptimizeSlice {
    return this.ctx.store.getState().optimize
  }

  runningRound(): OptimizeRound | undefined {
    return this.state.session?.rounds.find(isRunning)
  }

  // ───────────────────────────── 发起、取消（O-01、O-06） ─────────────────────────────

  /** 工具栏「优化 / 停止」和 ⇧⌘O：空闲时开始新会话（旧会话丢弃），进行中等同于取消这一轮。 */
  async toggle(): Promise<void> {
    this.toasts.beginAction()
    if (this.runningRound() !== undefined) {
      await this.cancel()
      return
    }
    if (this.state.submitting) return
    const draft = this.ctx.editor.getText()
    if (isBlank(draft)) {
      this.toasts.error(text(this.ctx, 'toast.nothingToOptimize'))
      return
    }
    await this.submit(draft, 'editor')
  }

  async cancel(): Promise<void> {
    const running = this.runningRound()?.id
    const result = await this.ctx.bridge.call('optimize.cancel', {})
    if (!result.ok) {
      this.toasts.error(describe(this.ctx, result.error))
      return
    }
    const session = result.value.session
    if (session !== null) this.setSession(session, true)
    // 请求到达插件前这一轮刚好完成时没有可取消的，不报「已取消」；已经收到的内容都还在会话栏里（O-01）。
    const round = session?.rounds.find(item => item.id === running)
    if (round?.status === 'cancelled') this.toasts.success(text(this.ctx, 'toast.optimizeCancelled'))
  }

  // ───────────────────────────── 追加与重试（O-05、O-06） ─────────────────────────────

  setFollowup(followup: string): void {
    this.update(optimize => (optimize.followup === followup ? optimize : { ...optimize, followup }))
  }

  /** 聊天输入框在空会话时发送待优化的 Prompt，之后发送追加要求。 */
  async sendMessage(): Promise<void> {
    this.toasts.beginAction()
    const followup = this.state.followup
    if (isBlank(followup) || this.state.submitting || this.runningRound() !== undefined) return
    await this.submit(followup, this.state.session === null ? 'chat' : 'followup')
  }

  private async submit(input: string, source: SubmissionSource): Promise<void> {
    // 即使第一轮来自聊天栏，「应用」也要用提交时的主编辑区全文检查后续修改。
    const draft = this.ctx.editor.getText()
    this.update(optimize => ({ ...optimize, submitting: true, followup: source === 'followup' ? '' : optimize.followup }))
    try {
      const method = source === 'followup' ? 'optimize.followup' : 'optimize.start'
      const result = await this.ctx.bridge.call(method, { text: input })
      if (!result.ok) {
        if (source === 'followup' && this.state.followup === '') this.setFollowup(input)
        this.toasts.error(describe(this.ctx, result.error))
        return
      }
      const session = result.value.session
      // 第一轮可能在请求返回前就被 Host 丢弃或被用户清空。
      if (this.ended.has(session.id)) return
      if (this.state.session?.id !== session.id) this.snapshots.clear()
      this.recordSnapshot(session, draft)
      this.setSession(session, true)
      if (source === 'chat') {
        this.chatStartedSessionId = session.id
        if (this.state.followup === input) this.setFollowup('')
      }
      if (source === 'editor') {
        this.autoOpenedSessionId = this.state.paneOpen ? null : session.id
        await this.layout.open('session')
      }
    } finally {
      this.update(optimize => ({ ...optimize, submitting: false }))
    }
  }

  /** 只能重试失败或取消的轮次：插件去掉那一轮，用同样的输入追加新的一轮。 */
  async retry(roundId: string): Promise<void> {
    this.toasts.beginAction()
    const retried = this.state.session?.rounds.find(round => round.id === roundId)
    const draft = this.ctx.editor.getText()
    const result = await this.ctx.bridge.call('optimize.retry', { roundId })
    if (!result.ok) {
      this.toasts.error(describe(this.ctx, result.error))
      return
    }
    // 失败时回到输入框的文字已经由重试发出去了，清掉，免得用户再发一遍。
    if (retried?.kind === 'followup' && this.state.followup === retried.input) this.setFollowup('')
    this.recordSnapshot(result.value.session, draft)
    this.setSession(result.value.session, true)
  }

  /** 新的一轮是会话里最后一轮，记下它开始时的编辑区全文。 */
  private recordSnapshot(session: OptimizeSession, draft: string): void {
    const round = session.rounds.at(-1)
    if (round !== undefined) this.snapshots.set(round.id, draft)
  }

  // ───────────────────────────── 候选（O-04） ─────────────────────────────

  private currentRound(roundId: string): OptimizeRound | undefined {
    return this.state.session?.rounds.find(round => round.id === roundId)
  }

  async apply(roundId: string): Promise<void> {
    this.toasts.beginAction()
    // 草稿读回之前编辑区不可编辑（F-01，技术方案 4.5），这一条对「应用」同样成立（审查 CR-01）：CodeMirror 的 readOnly
    // 只挡用户输入，挡不住程序派发的整篇替换。载入中应用的候选会被随后读回的草稿悄悄盖掉，读取失败时只读的编辑区里
    // 却显示着候选、⌘↩ 能把它复制走。和插入到光标、在编辑器中打开、清空一样，不提示，什么都不做。
    if (this.ctx.store.getState().draft.load !== 'ready') return
    const round = this.currentRound(roundId)
    if (round?.status !== 'done' || round.candidate === null) {
      // 会话已经清空或换成新会话后，旧的「应用」不再生效。
      this.toasts.error(text(this.ctx, 'toast.candidateStale'))
      return
    }
    const candidate = round.candidate
    // 小程序重启后没有快照：第一轮以原输入为参照，追加轮按草稿可能改过处理。
    const snapshot = this.snapshots.get(roundId) ?? (round.kind === 'initial' ? round.input : null)
    if (snapshot === null || snapshot !== this.ctx.editor.getText()) {
      const choice = await this.dialogs.open({
        title: text(this.ctx, 'dialog.optimizeModified.title'),
        message: text(this.ctx, 'dialog.optimizeModified.message'),
        buttons: [
          dialogButton(this.ctx, 'copy', 'dialog.optimizeModified.copy'),
          dialogButton(this.ctx, 'keep', 'dialog.optimizeModified.keep'),
          dialogButton(this.ctx, 'apply', 'dialog.optimizeModified.apply', 'primary'),
        ],
        defaultButton: 'keep',
        // 这个对话框没有「取消」，Esc 等于「保持当前内容」（技术方案 5.5）。
        escapeButton: 'keep',
      })
      if (choice.button === 'copy') {
        await this.copy(candidate, 'toast.candidateCopied')
        return
      }
      if (choice.button !== 'apply') return
      if (this.currentRound(roundId)?.candidate !== candidate) {
        this.toasts.error(text(this.ctx, 'toast.candidateStale'))
        return
      }
    }
    // 整篇换成候选，一步可以撤销；不改变绑定（O-04、Q11）。
    this.ctx.editor.replaceAll(candidate)
    this.ctx.editor.focus()
    this.toasts.success(text(this.ctx, 'toast.optimizeApplied'))
  }

  async copyCandidate(roundId: string): Promise<void> {
    this.toasts.beginAction()
    const candidate = this.currentRound(roundId)?.candidate
    if (candidate === null || candidate === undefined) {
      this.toasts.error(text(this.ctx, 'toast.candidateStale'))
      return
    }
    await this.copy(candidate, 'toast.candidateCopied')
  }

  async copyReply(roundId: string): Promise<void> {
    this.toasts.beginAction()
    const round = this.currentRound(roundId)
    if (round === undefined) {
      this.toasts.error(text(this.ctx, 'toast.candidateStale'))
      return
    }
    await this.copy(round.reply, 'toast.replyCopied')
  }

  /** 只写剪贴板，小窗不隐藏。 */
  private async copy(value: string, success: 'toast.candidateCopied' | 'toast.replyCopied'): Promise<void> {
    const result = await this.ctx.bridge.window.copyText(value)
    if (result.ok) this.toasts.success(text(this.ctx, success))
    else this.toasts.error(text(this.ctx, 'toast.copyFailed', { reason: reason(this.ctx, result.error) }))
  }

  // ───────────────────────────── 清空会话与会话栏开合（O-07） ─────────────────────────────

  /** 有一轮在进行时插件先取消，然后清空消息，保留聊天栏的开合状态。 */
  async clear(): Promise<void> {
    this.toasts.beginAction()
    const session = this.state.session
    const result = await this.ctx.bridge.call('optimize.clear', {})
    if (!result.ok) {
      this.toasts.error(describe(this.ctx, result.error))
      return
    }
    if (this.state.session?.id === session?.id) this.drop(session)
  }

  /** 工具栏「聊天」：收起或展开聊天栏，内容不丢。 */
  async togglePane(): Promise<void> {
    this.toasts.beginAction()
    this.autoOpenedSessionId = null
    await this.layout.toggleSession()
  }

  /** 启动时从插件恢复会话（小程序重启后会话仍在插件内存里）。聊天栏先收起，用「聊天」按钮打开。 */
  async restore(): Promise<void> {
    const result = await this.ctx.bridge.call('optimize.state', {})
    if (result.ok && result.value.session !== null && this.state.session === null) this.setSession(result.value.session, false)
  }

  // ───────────────────────────── 插件推送 ─────────────────────────────

  onEvent(event: OptimizeEvent): void {
    switch (event.type) {
      case 'session':
        if (event.session === null) {
          this.drop(this.state.session)
        } else {
          this.setSession(event.session, false)
        }
        return
      case 'delta':
        this.appendDelta(event.sessionId, event.roundId, event.text)
        return
      case 'discarded':
        this.discard(event.sessionId, event.error)
        return
    }
  }

  private appendDelta(sessionId: string, roundId: string, delta: string): void {
    this.update((optimize) => {
      const session = optimize.session
      if (session?.id !== sessionId) return optimize
      const index = session.rounds.findIndex(round => round.id === roundId)
      const round = session.rounds[index]
      // 取消后迟到的片段直接丢弃，不显示（O-06）。
      if (round === undefined || !isRunning(round)) return optimize
      const rounds = [...session.rounds]
      rounds[index] = { ...round, reply: round.reply + delta }
      return { ...optimize, session: { ...session, rounds } }
    })
  }

  /**
   * 第一轮在收到任何文字前以「没有可用模型」类错误结束（审查 TC-07）：会话已丢弃，收起会话栏，
   * 只在底栏提示「dsh 里还没有可用的模型…」（O-01「不开始会话」）。
   */
  private discard(sessionId: string, error: ErrorInfo): void {
    this.ended.add(sessionId)
    const session = this.state.session
    if (session === null || session.id === sessionId) {
      const close = this.autoOpenedSessionId === sessionId
      const initialInput = this.chatStartedSessionId === sessionId
        ? session?.rounds.find(round => round.kind === 'initial')?.input
        : undefined
      const pendingInput = this.state.followup
      // 丢弃会话会移除已发送的首条消息，把它和之后写的内容一起留在输入框。
      const restoredInput = initialInput === undefined || initialInput === pendingInput
        ? pendingInput
        : [initialInput, pendingInput].filter(value => value !== '').join('\n\n')
      this.drop(session, restoredInput)
      // 打开可能还在等原生窗口调整宽度，关闭在布局队列中排在它之后。
      if (close) runTask(this.layout.close('session'))
    }
    this.toasts.error(describe(this.ctx, error))
  }

  private drop(session: OptimizeSession | null, followup = ''): void {
    if (session !== null) this.ended.add(session.id)
    this.autoOpenedSessionId = null
    this.chatStartedSessionId = null
    this.snapshots.clear()
    this.update(optimize => ({ ...optimize, session: null, followup }))
  }

  /** fromResult：来自请求结果的会话要和本地合并（可能比推送旧）；推送的快照直接采用。 */
  private setSession(next: OptimizeSession, fromResult: boolean): void {
    if (this.ended.has(next.id)) return
    const previous = this.state.session
    const session = fromResult ? mergeSession(previous, next) : next
    this.update(optimize => ({ ...optimize, session }))
    if (previous !== null && previous.id !== session.id) {
      // 新会话替换了旧会话（O-01：旧会话丢弃）：旧会话迟到的推送不能再把它显示出来，旧的快照也用不上了。
      this.ended.add(previous.id)
      for (const round of previous.rounds) this.snapshots.delete(round.id)
    }
    if (previous?.id !== session.id) return
    for (const round of session.rounds) {
      const before = previous.rounds.find(item => item.id === round.id)
      if (before !== undefined && isRunning(before) && !isRunning(round)) this.onRoundEnded(round)
    }
  }

  private onRoundEnded(round: OptimizeRound): void {
    switch (round.status) {
      case 'done':
        // 会话栏收起时有一轮完成，底栏提示（O-07）。
        if (!this.state.paneOpen) this.toasts.success(text(this.ctx, 'toast.optimizeReturned'))
        this.focusFollowup()
        return
      case 'failed':
        this.toasts.error(describe(this.ctx, round.error ?? { code: 'promptx/optimize/failed' }))
        this.returnFollowupText(round)
        return
      case 'cancelled':
        this.returnFollowupText(round)
        return
      case 'running':
        return
    }
  }

  /** 追加那一轮失败或被取消：这一轮的文字回到追加输入框（输入框为空时），第一轮只显示「重试」（O-06）。 */
  private returnFollowupText(round: OptimizeRound): void {
    if (round.kind === 'followup' && isBlank(this.state.followup)) this.setFollowup(round.input)
  }

  private update(updater: (optimize: OptimizeSlice) => OptimizeSlice): void {
    this.ctx.store.update((state) => {
      const optimize = updater(state.optimize)
      return optimize === state.optimize ? state : { ...state, optimize }
    })
  }
}
