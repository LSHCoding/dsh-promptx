import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest'
import { redo, undo } from '@codemirror/commands'
import type { BridgeResult } from '../../../src/shared/bridge.ts'
import type { DraftRecord, ErrorInfo, OptimizeRound, OptimizeSession } from '../../../src/shared/types.ts'
import { AppController } from '../../../src/app/renderer/controller/app.ts'
import { mergeSession } from '../../../src/app/renderer/controller/optimize.ts'
import {
  chooseDialog,
  deferred,
  draftRecord,
  FakeBridge,
  fail,
  ok,
  openDialog,
  round,
  session,
  settle,
  startController,
  toastText,
  trapUnhandled,
  type,
  type Deferred,
} from './helpers.ts'

let checkUnhandled: () => void
const controllers: AppController[] = []

beforeEach(() => {
  vi.useFakeTimers()
  checkUnhandled = trapUnhandled()
})

afterEach(() => {
  for (const controller of controllers.splice(0)) controller.dispose()
  vi.useRealTimers()
  checkUnhandled()
})

async function start(bridge: FakeBridge): Promise<AppController> {
  const controller = await startController(bridge)
  controllers.push(controller)
  return controller
}

/**
 * 模仿插件的 OptimizeService：会话在「插件」这边，结构变化先推 session 快照，再回复请求（和真实实现的顺序一致）。
 */
class FakeHost {
  current: OptimizeSession | null = null
  private seq = 0

  constructor(private readonly bridge: FakeBridge) {
    bridge.handle('optimize.start', ({ text }) => {
      this.current = session(`s${++this.seq}`, [this.newRound('initial', text)])
      this.push()
      return ok({ session: this.snapshot() })
    })
    bridge.handle('optimize.followup', ({ text }) => {
      if (this.current === null) return fail('promptx/optimize/no-session')
      if (this.running() !== undefined) return fail('promptx/optimize/busy')
      this.current.rounds.push(this.newRound('followup', text))
      this.push()
      return ok({ session: this.snapshot() })
    })
    bridge.handle('optimize.retry', ({ roundId }) => {
      const current = this.current
      const index = current?.rounds.findIndex(item => item.id === roundId) ?? -1
      const previous = current?.rounds[index]
      if (current === null || previous === undefined) return fail('promptx/optimize/stale')
      current.rounds.splice(index, 1)
      current.rounds.push(this.newRound(previous.kind, previous.input))
      this.push()
      return ok({ session: this.snapshot() })
    })
    bridge.handle('optimize.cancel', () => {
      const active = this.running()
      if (active !== undefined) {
        active.status = 'cancelled'
        this.push()
      }
      return ok({ session: this.snapshot() })
    })
    bridge.handle('optimize.clear', () => {
      const had = this.current !== null
      this.current = null
      if (had) bridge.emit('optimize.event', { type: 'session', session: null })
      return ok({})
    })
  }

  running(): OptimizeRound | undefined {
    return this.current?.rounds.find(item => item.status === 'running')
  }

  delta(text: string): void {
    const active = this.running()
    if (this.current === null || active === undefined) return
    active.reply += text
    this.bridge.emit('optimize.event', { type: 'delta', sessionId: this.current.id, roundId: active.id, text })
  }

  finish(status: 'done' | 'failed', options: { reply?: string; candidate?: string | null; error?: ErrorInfo } = {}): void {
    const active = this.running()
    if (active === undefined) throw new Error('no running round')
    if (options.reply !== undefined) active.reply = options.reply
    active.status = status
    active.candidate = options.candidate ?? null
    if (options.error !== undefined) active.error = options.error
    this.push()
  }

  discard(error: ErrorInfo): void {
    const id = this.current?.id ?? ''
    this.current = null
    this.bridge.emit('optimize.event', { type: 'discarded', sessionId: id, error })
  }

  private newRound(kind: OptimizeRound['kind'], input: string): OptimizeRound {
    return round(`r${++this.seq}`, { kind, input })
  }

  private snapshot(): OptimizeSession {
    return structuredClone(this.current) as OptimizeSession
  }

  private push(): void {
    this.bridge.emit('optimize.event', { type: 'session', session: this.snapshot() })
  }
}

async function optimizeStarted(draft = '原始草稿'): Promise<{ bridge: FakeBridge; host: FakeHost; controller: AppController }> {
  const bridge = new FakeBridge()
  const host = new FakeHost(bridge)
  const controller = await start(bridge)
  type(controller, draft)
  await controller.optimize.toggle()
  await controller.layout.settled()
  return { bridge, host, controller }
}

function lastRound(controller: AppController): OptimizeRound | undefined {
  return controller.store.getState().optimize.session?.rounds.at(-1)
}

describe('发起与取消（O-01）', () => {
  it('草稿为空或只有空白：提示「没有可优化的内容。」，不发请求', async () => {
    const bridge = new FakeBridge()
    const controller = await start(bridge)
    type(controller, '  \n')
    await controller.optimize.toggle()
    expect(bridge.callsTo('optimize.start')).toEqual([])
    expect(controller.store.getState().toast).toMatchObject({ kind: 'error', text: '没有可优化的内容。' })
  })

  it('以编辑区内容开始新会话，会话栏展开（向右加宽），进行中可以继续编辑', async () => {
    const { bridge, controller } = await optimizeStarted()
    expect(bridge.callsTo('optimize.start')).toEqual([{ text: '原始草稿' }])
    const state = controller.store.getState()
    expect(state.optimize.paneOpen).toBe(true)
    expect(state.optimize.session?.model.name).toBe('DeepSeek-V4')
    expect(bridge.window.setWidth).toHaveBeenCalledWith(980 + 421, 'left')
    type(controller, '，继续写')
    expect(controller.editor.getText()).toBe('原始草稿，继续写')
  })

  it('开始失败（例如没有可用模型）：只在底栏提示，不开始会话，会话栏不展开', async () => {
    const bridge = new FakeBridge()
    bridge.handle('optimize.start', () => fail('promptx/optimize/no-model'))
    const controller = await start(bridge)
    type(controller, '草稿')
    await controller.optimize.toggle()
    const state = controller.store.getState()
    expect(state.optimize.session).toBeNull()
    expect(state.optimize.paneOpen).toBe(false)
    expect(state.toast).toMatchObject({ kind: 'error', text: 'dsh 里还没有可用的模型，请先在 dsh 设置中配置模型。' })
  })

  it('进行中再按优化键等于取消这一轮：提示「已取消优化。」，已有的内容还在', async () => {
    const { host, controller } = await optimizeStarted()
    host.delta('已经生成的一段')
    await controller.optimize.toggle()
    expect(lastRound(controller)).toMatchObject({ status: 'cancelled', reply: '已经生成的一段' })
    expect(toastText(controller)).toBe('已取消优化。')
  })

  it('取消请求到达前这一轮刚好完成：不报「已取消」', async () => {
    const { bridge, host, controller } = await optimizeStarted()
    bridge.handle('optimize.cancel', () => {
      host.finish('done', { reply: '完成了', candidate: '完成了' })
      return ok({ session: host.current })
    })
    await controller.optimize.cancel()
    expect(lastRound(controller)?.status).toBe('done')
    expect(toastText(controller)).not.toBe('已取消优化。')
  })

  it('第一轮在收到文字前因为没有可用模型结束（discarded）：会话丢弃，会话栏收起，只在底栏提示（审查 TC-07）', async () => {
    const { bridge, host, controller } = await optimizeStarted()
    host.discard({ code: 'promptx/optimize/no-model' })
    await controller.layout.settled()
    const state = controller.store.getState()
    expect(state.optimize.session).toBeNull()
    expect(state.optimize.paneOpen).toBe(false)
    expect(state.toast).toMatchObject({ kind: 'error', text: 'dsh 里还没有可用的模型，请先在 dsh 设置中配置模型。' })
    // 会话栏收起后窗口宽度复原（5.7 规则 4）。
    expect(bridge.bounds.width).toBe(980)
  })

  it('discarded 比打开会话栏先到：会话栏不会在丢弃之后才打开', async () => {
    const bridge = new FakeBridge()
    const host = new FakeHost(bridge)
    const controller = await start(bridge)
    type(controller, '草稿')
    const starting = controller.optimize.toggle()
    host.discard({ code: 'promptx/optimize/no-model' })
    await starting
    await controller.layout.settled()
    expect(controller.store.getState().optimize.paneOpen).toBe(false)
    expect(controller.store.getState().optimize.session).toBeNull()
  })
})

describe('流式回复（O-02）', () => {
  it('增量依次追加到这一轮；取消后迟到的片段丢弃（O-06）', async () => {
    const { bridge, host, controller } = await optimizeStarted()
    host.delta('第一段')
    host.delta('，第二段')
    expect(lastRound(controller)?.reply).toBe('第一段，第二段')
    const roundId = lastRound(controller)?.id ?? ''
    await controller.optimize.cancel()
    bridge.emit('optimize.event', { type: 'delta', sessionId: host.current?.id ?? '', roundId, text: '迟到的' })
    expect(lastRound(controller)?.reply).toBe('第一段，第二段')
  })

  it('请求结果比推送旧时，不把已经结束的一轮退回进行中，也不丢已经收到的文字', () => {
    const done = session('s', [round('r', { status: 'done', reply: '完整回复', candidate: '完整回复' })])
    const stale = session('s', [round('r', { status: 'running', reply: '完整' })])
    expect(mergeSession(done, stale).rounds[0]).toMatchObject({ status: 'done', reply: '完整回复' })

    const streaming = session('s', [round('r', { reply: '已经收到更多' })])
    const older = session('s', [round('r', { reply: '已经' })])
    expect(mergeSession(streaming, older).rounds[0]?.reply).toBe('已经收到更多')
    expect(mergeSession(null, older)).toBe(older)
    expect(mergeSession(session('other', []), older)).toBe(older)
  })
})

describe('应用候选与草稿快照（O-04，技术方案 5.5，审查 COV-08）', () => {
  it('优化期间没改过草稿：直接整篇换成候选，一步可以撤销，绑定不变', async () => {
    const { host, controller } = await optimizeStarted()
    host.finish('done', { reply: '说明\n````prompt\n改写稿\n````', candidate: '改写稿' })
    await controller.optimize.apply(lastRound(controller)?.id ?? '')
    expect(controller.store.getState().dialog).toBeNull()
    expect(controller.editor.getText()).toBe('改写稿')
    expect(toastText(controller)).toBe('已应用优化。')
    expect(controller.editor.runCommand(undo)).toBe(true)
    expect(controller.editor.getText()).toBe('原始草稿')
    expect(controller.editor.runCommand(redo)).toBe(true)
    expect(controller.editor.getText()).toBe('改写稿')
  })

  it('应用 → 追加 → 再应用：每一轮比较自己的快照，不误报「草稿在优化期间已经修改」', async () => {
    const { bridge, host, controller } = await optimizeStarted()
    host.finish('done', { candidate: '第一版' })
    await controller.optimize.apply(lastRound(controller)?.id ?? '')
    controller.optimize.setFollowup('再精简一些')
    await controller.optimize.sendFollowup()
    expect(bridge.callsTo('optimize.followup')).toEqual([{ text: '再精简一些' }])
    expect(controller.store.getState().optimize.followup).toBe('')
    host.finish('done', { candidate: '第二版' })
    await controller.optimize.apply(lastRound(controller)?.id ?? '')
    expect(controller.store.getState().dialog).toBeNull()
    expect(controller.editor.getText()).toBe('第二版')
  })

  it('优化期间改过草稿：先确认；默认和 Esc 都是「保持当前内容」', async () => {
    const { host, controller } = await optimizeStarted()
    type(controller, '，手工改的')
    host.finish('done', { candidate: '改写稿' })
    const roundId = lastRound(controller)?.id ?? ''
    const applying = controller.optimize.apply(roundId)
    await settle()
    const dialog = openDialog(controller)
    expect(dialog.title).toBe('草稿在优化期间已经修改')
    expect(dialog.message).toBe('应用候选会替换当前的手工编辑。')
    expect(dialog.buttons.map(button => button.label)).toEqual(['复制候选', '保持当前内容', '仍然应用'])
    expect(dialog.defaultButton).toBe('keep')
    expect(dialog.escapeButton).toBe('keep')
    controller.escapeDialog()
    await applying
    expect(controller.editor.getText()).toBe('原始草稿，手工改的')
  })

  it('确认框里「复制候选」只写剪贴板，「仍然应用」替换', async () => {
    const { bridge, host, controller } = await optimizeStarted()
    type(controller, '！')
    host.finish('done', { candidate: '改写稿' })
    const roundId = lastRound(controller)?.id ?? ''

    const copying = controller.optimize.apply(roundId)
    await settle()
    chooseDialog(controller, 'copy')
    await copying
    expect(bridge.window.copyText).toHaveBeenCalledWith('改写稿')
    expect(toastText(controller)).toBe('候选已复制。')
    expect(controller.editor.getText()).toBe('原始草稿！')

    const applying = controller.optimize.apply(roundId)
    await settle()
    chooseDialog(controller, 'apply')
    await applying
    expect(controller.editor.getText()).toBe('改写稿')
  })

  it('确认期间会话被清空：旧的「应用」不再生效，提示候选已过期', async () => {
    const { host, controller } = await optimizeStarted()
    type(controller, '！')
    host.finish('done', { candidate: '改写稿' })
    const applying = controller.optimize.apply(lastRound(controller)?.id ?? '')
    await settle()
    await controller.optimize.clear()
    // 清空会话不会关掉别的流程开着的对话框：这里由用户继续选。
    chooseDialog(controller, 'apply')
    await applying
    expect(controller.editor.getText()).toBe('原始草稿！')
    expect(toastText(controller)).toBe('该候选已过期，请重新生成。')
  })

  it('没有候选的轮次：「应用」提示过期；「复制回复」复制整段回复', async () => {
    const { bridge, host, controller } = await optimizeStarted()
    host.finish('done', { reply: '整段回复，没有代码块', candidate: null })
    const roundId = lastRound(controller)?.id ?? ''
    await controller.optimize.apply(roundId)
    expect(toastText(controller)).toBe('该候选已过期，请重新生成。')
    await controller.optimize.copyReply(roundId)
    expect(bridge.window.copyText).toHaveBeenLastCalledWith('整段回复，没有代码块')
    expect(toastText(controller)).toBe('回复已复制。')
  })

  it('复制候选：写剪贴板，小窗不隐藏；失败时说明原因', async () => {
    const { bridge, host, controller } = await optimizeStarted()
    host.finish('done', { candidate: '改写稿' })
    const roundId = lastRound(controller)?.id ?? ''
    await controller.optimize.copyCandidate(roundId)
    expect(bridge.window.copyText).toHaveBeenCalledWith('改写稿')
    expect(bridge.window.hide).not.toHaveBeenCalled()
    bridge.window.copyText.mockResolvedValueOnce(fail('promptx/clipboard/write-failed'))
    await controller.optimize.copyCandidate(roundId)
    expect(toastText(controller)).toBe('复制失败：写入剪贴板失败')
  })

  it('小程序重启后恢复的会话没有快照：第一轮按它的输入比较，追加轮按「改过」处理', async () => {
    const bridge = new FakeBridge()
    bridge.handle('optimize.state', () => ok({
      session: session('s1', [
        round('r1', { input: '原始草稿', status: 'done', candidate: '一' }),
        round('r2', { kind: 'followup', input: '再改', status: 'done', candidate: '二' }),
      ]),
    }))
    const controller = await start(bridge)
    type(controller, '原始草稿')
    await controller.optimize.apply('r1')
    expect(controller.store.getState().dialog).toBeNull()
    expect(controller.editor.getText()).toBe('一')
    const applying = controller.optimize.apply('r2')
    await settle()
    expect(openDialog(controller).title).toBe('草稿在优化期间已经修改')
    controller.escapeDialog()
    await applying
  })
})

describe('草稿读回之前不能应用候选（F-01、技术方案 4.5，审查 CR-01）', () => {
  /** 小程序重启后从插件恢复的会话：第一轮已经完成，带候选。 */
  function withRestoredSession(bridge: FakeBridge): FakeBridge {
    bridge.handle('optimize.state', () => ok({
      session: session('s1', [round('r1', { input: '原始草稿', status: 'done', reply: '改写稿', candidate: '改写稿' })]),
    }))
    return bridge
  }

  /** 修复前这里会弹「草稿在优化期间已经修改」：照用户的做法选「仍然应用」，看候选会不会写进编辑区。 */
  async function applyAnyway(controller: AppController, roundId: string): Promise<void> {
    const applying = controller.optimize.apply(roundId)
    await settle()
    if (controller.store.getState().dialog !== null) chooseDialog(controller, 'apply')
    await applying
  }

  it('载入中：不替换、不提示「已应用优化。」；读回的是草稿本身，之后照常可以应用', async () => {
    const bridge = withRestoredSession(new FakeBridge())
    const load: Deferred<BridgeResult<{ record: DraftRecord | null }>> = deferred()
    bridge.handle('draft.load', () => load.promise)
    const controller = new AppController({ bridge, locale: 'zh' })
    controllers.push(controller)
    const started = controller.start()
    await settle()
    expect(controller.store.getState().draft.load).toBe('loading')
    expect(controller.store.getState().optimize.session?.id).toBe('s1')

    await applyAnyway(controller, 'r1')
    expect(controller.editor.getText()).toBe('')
    expect(toastText(controller)).not.toBe('已应用优化。')

    load.resolve(ok({ record: draftRecord('原始草稿') }))
    await started
    expect(controller.editor.getText()).toBe('原始草稿')
    await controller.optimize.apply('r1')
    expect(controller.store.getState().dialog).toBeNull()
    expect(controller.editor.getText()).toBe('改写稿')
    expect(toastText(controller)).toBe('已应用优化。')
  })

  it('读取失败：只读的编辑区里不出现候选，⌘↩ 也不会把候选复制走', async () => {
    const bridge = withRestoredSession(new FakeBridge())
    bridge.handle('draft.load', () => fail('promptx/draft/unreadable'))
    const controller = await start(bridge)
    expect(controller.store.getState().draft.load).toBe('error')

    await applyAnyway(controller, 'r1')
    expect(controller.editor.getText()).toBe('')
    expect(toastText(controller)).not.toBe('已应用优化。')
    expect(await controller.copyAndHide()).toEqual({ ok: false })
    expect(bridge.window.copyAndHide).not.toHaveBeenCalled()
    expect(toastText(controller)).toBe('没有可复制的内容。')
  })
})

describe('追加要求、失败与重试（O-05、O-06）', () => {
  it('只有空白时不发送；有一轮在进行时不能发送', async () => {
    const { bridge, controller } = await optimizeStarted()
    controller.optimize.setFollowup('再精简')
    await controller.optimize.sendFollowup()
    expect(bridge.callsTo('optimize.followup')).toEqual([])
    expect(controller.store.getState().optimize.followup).toBe('再精简')
  })

  it('追加那一轮失败：底栏显示原因，这一轮的文字回到追加输入框', async () => {
    const { host, controller } = await optimizeStarted()
    host.finish('done', { candidate: '一' })
    controller.optimize.setFollowup('再精简')
    await controller.optimize.sendFollowup()
    expect(controller.store.getState().optimize.followup).toBe('')
    host.finish('failed', { error: { code: 'promptx/optimize/network' } })
    expect(controller.store.getState().optimize.followup).toBe('再精简')
    expect(controller.store.getState().toast).toMatchObject({ kind: 'error', text: '网络不通，连不上模型服务' })
  })

  it('追加那一轮被取消：文字回到输入框；输入框里已经有新写的内容时不覆盖', async () => {
    const { host, controller } = await optimizeStarted()
    host.finish('done', { candidate: '一' })
    controller.optimize.setFollowup('第二轮')
    await controller.optimize.sendFollowup()
    await controller.optimize.cancel()
    expect(controller.store.getState().optimize.followup).toBe('第二轮')

    controller.optimize.setFollowup('第三轮')
    await controller.optimize.sendFollowup()
    controller.optimize.setFollowup('还在想的下一条')
    host.finish('failed', { error: { code: 'promptx/optimize/timeout' } })
    expect(controller.store.getState().optimize.followup).toBe('还在想的下一条')
  })

  it('第一轮失败或取消：只显示重试，不把草稿全文填进追加输入框', async () => {
    const { host, controller } = await optimizeStarted()
    host.finish('failed', { error: { code: 'promptx/optimize/auth' } })
    expect(controller.store.getState().optimize.followup).toBe('')
    expect(lastRound(controller)?.status).toBe('failed')
  })

  it('重试：用同样的输入追加新的一轮；回到输入框的文字已经发出去，清掉', async () => {
    const { bridge, host, controller } = await optimizeStarted()
    host.finish('done', { candidate: '一' })
    controller.optimize.setFollowup('再精简')
    await controller.optimize.sendFollowup()
    host.finish('failed', { error: { code: 'promptx/optimize/network' } })
    const failedId = lastRound(controller)?.id ?? ''
    await controller.optimize.retry(failedId)
    expect(bridge.callsTo('optimize.retry')).toEqual([{ roundId: failedId }])
    expect(controller.store.getState().optimize.followup).toBe('')
    expect(lastRound(controller)).toMatchObject({ kind: 'followup', input: '再精简', status: 'running' })
  })

  it('一轮结束时小窗里没有焦点：把焦点请求交给追加输入框', async () => {
    const { host, controller } = await optimizeStarted()
    host.finish('done', { candidate: '一' })
    expect(controller.store.getState().focus?.target).toBe('followup')
  })
})

describe('清空会话与会话栏开合（O-07）', () => {
  it('「会话」按钮收起再展开，消息都在', async () => {
    const { host, controller } = await optimizeStarted()
    host.finish('done', { candidate: '一' })
    await controller.optimize.togglePane()
    expect(controller.store.getState().optimize.paneOpen).toBe(false)
    expect(controller.store.getState().optimize.session?.rounds).toHaveLength(1)
    await controller.optimize.togglePane()
    expect(controller.store.getState().optimize.paneOpen).toBe(true)
  })

  it('会话栏收起时有一轮完成：底栏提示「优化结果已返回。」；展开时不提示', async () => {
    const { host, controller } = await optimizeStarted()
    await controller.optimize.togglePane()
    host.finish('done', { candidate: '一' })
    expect(toastText(controller)).toBe('优化结果已返回。')
    await vi.advanceTimersByTimeAsync(2000)

    await controller.optimize.togglePane()
    controller.optimize.setFollowup('再改')
    await controller.optimize.sendFollowup()
    host.finish('done', { candidate: '二' })
    expect(toastText(controller)).not.toBe('优化结果已返回。')
  })

  it('清空会话：插件先取消再丢弃，会话栏收起，窗口宽度复原', async () => {
    const { bridge, controller } = await optimizeStarted()
    await controller.optimize.clear()
    await controller.layout.settled()
    expect(bridge.callsTo('optimize.clear')).toHaveLength(1)
    expect(controller.store.getState().optimize.session).toBeNull()
    expect(controller.store.getState().optimize.paneOpen).toBe(false)
    expect(bridge.bounds.width).toBe(980)
  })

  it('开始新会话后，旧会话迟到的推送不会把它显示回来', async () => {
    const { bridge, host, controller } = await optimizeStarted()
    const old = structuredClone(host.current) as OptimizeSession
    host.finish('done', { candidate: '一' })
    await controller.optimize.toggle()
    const fresh = controller.store.getState().optimize.session?.id
    expect(fresh).not.toBe(old.id)
    bridge.emit('optimize.event', { type: 'session', session: old })
    expect(controller.store.getState().optimize.session?.id).toBe(fresh)
  })

  it('启动时从插件恢复会话（小程序重启后），会话栏先收起', async () => {
    const bridge = new FakeBridge()
    bridge.handle('optimize.state', () => ok({ session: session('s1', [round('r1', { status: 'done', candidate: 'x' })]) }))
    const controller = await start(bridge)
    expect(controller.store.getState().optimize.session?.id).toBe('s1')
    expect(controller.store.getState().optimize.paneOpen).toBe(false)
  })
})
