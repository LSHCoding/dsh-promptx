// 优化会话（需求 O-01 至 O-08，design-spec 4.6、6.3）。
//
// 会话放在 Host 内存里：小程序重启后小窗用 optimize.state 恢复显示，dsh 重启后丢失（Q4）。会话开始时记下
// 模型、优化指令和语言的快照：之后改配置只影响新会话（O-08），追加和重试都沿用快照。
// 每一轮直接调用 dsh 的 llm.stream()，不经 Agent 循环；只取 text-delta 显示，reasoning-delta 等一律丢弃。
// 增量文本按 50 ms 合并后推送，避免逐 token 发通知把 stdio 管道塞满；结构变化（开始、结束、失败、取消）推整个会话。
//
// 推送顺序的约定：
// - 一轮里已经收到但还没推出去的增量，总在下一次推送整个会话之前先推出去。会话快照里的回复已经包含这些文字，
//   小窗收到会话快照就整体替换，所以快照之后不会再出现它已包含的增量。
// - start、followup、retry 同步建好会话和这一轮、推送会话，真正发请求（和取模型显示名）推迟到下一个宏任务。
//   RPC 的回复在微任务里发出，这样它总排在这一轮的任何后续事件（增量、失败、丢弃）之前；否则适配器同步抛出
//   NO_ADAPTER 时，「丢弃」事件会先于 RPC 回复到达，小窗再用回复里那份「进行中」的快照把会话栏重新打开、一直转圈。
//
// 日志和错误里不放 Prompt 内容：错误只带错误码和模型服务返回的第一行系统信息。

import { randomBytes } from 'node:crypto'
import { background } from '../background.ts'
import type { HostLogger, LlmChunk, LlmLike, OptimizeApi, OptimizeServiceOptions } from '../services.ts'
import { extractCandidate } from '../shared/candidate.ts'
import { PromptxError } from '../shared/errors.ts'
import type { ErrorCode } from '../shared/errors.ts'
import { buildSystemPrompt } from '../shared/instructions.ts'
import { isBlank } from '../shared/text-metrics.ts'
import type { ErrorInfo, OptimizeEvent, OptimizeModel, OptimizeRound, OptimizeSession } from '../shared/types.ts'

/** 增量文本合并推送的间隔。 */
export const DELTA_FLUSH_MS = 50

/** 取模型显示名的超时；超时或失败时显示模型 id。 */
export const MODEL_NAME_TIMEOUT_MS = 5_000

/** llm.stream 的 purpose：dsh 的适配器可以据此把这类请求和普通对话区分开。 */
export const OPTIMIZE_PURPOSE = 'promptx-optimize'

/** 错误信息的长度上限（和 toErrorInfo 一致）。 */
const MAX_DETAIL = 300

/**
 * 「dsh 里没有可用的模型」类错误（design-spec 4.6）。没配置 API Key 这类问题要等第一轮请求发出才知道，
 * 由适配器在请求时以失败的 finish 返回（dsh-llm-deepseek-api-key 每次调用时才解析密钥）。
 */
const NO_MODEL_CODES: ReadonlySet<string> = new Set([
  'MISSING_CREDENTIAL',
  'INVALID_CREDENTIAL',
  'ACCOUNT_SIGN_IN_REQUIRED',
  'NO_ADAPTER',
  'UNKNOWN_MODEL',
])

/** dsh-llm 的失败码 → PromptX 的错误码（小窗按错误码取文案）。 */
const FAILURE_CODES: ReadonlyMap<string, ErrorCode> = new Map([
  ['AUTH', 'promptx/optimize/auth'],
  ['RATE_LIMIT', 'promptx/optimize/rate-limit'],
  ['QUOTA', 'promptx/optimize/rate-limit'],
  ['ACCOUNT_QUOTA', 'promptx/optimize/rate-limit'],
  ['TRANSPORT', 'promptx/optimize/network'],
  ['TIMEOUT', 'promptx/optimize/timeout'],
  ['EMPTY_RESPONSE', 'promptx/optimize/empty-response'],
])

/** 可选的日志（OptimizeServiceOptions 之外的扩展）：只用于后台任务兜底，不记 Prompt 内容。 */
export type OptimizeServiceExtras = { logger?: Pick<HostLogger, 'warn'> | undefined }

interface SessionState {
  id: string
  model: OptimizeModel
  reasoningEffort: string | undefined
  /** 会话开始时按当时的指令和语言拼好的系统说明（O-08：改指令只影响新会话）。 */
  system: string
  rounds: OptimizeRound[]
}

/** 进行中的一轮。cancel、start、clear、dispose 会把它换掉；换掉之后它收到的一切都丢弃。 */
interface ActiveRun {
  session: SessionState
  round: OptimizeRound
  controller: AbortController
  /** 收到过 text-delta（判断「第一轮在收到任何文字前失败」）。 */
  sawText: boolean
  /** 已收到、还没推出去的增量。 */
  pending: string
  timer: ReturnType<typeof setTimeout> | undefined
}

type Outcome =
  | { kind: 'done' }
  | { kind: 'cancelled' }
  | { kind: 'failed'; error: ErrorInfo; noModel: boolean }

export class OptimizeService implements OptimizeApi {
  readonly #options: OptimizeServiceOptions
  readonly #logger: Pick<HostLogger, 'warn'>
  #session: SessionState | null = null
  #active: ActiveRun | null = null
  /** 进行中的取模型显示名请求，dispose 时中止。 */
  readonly #lookups = new Set<AbortController>()
  /** 推迟到下一个宏任务的工作（见文件头「推送顺序的约定」），dispose 时清掉。 */
  readonly #deferred = new Set<ReturnType<typeof setTimeout>>()
  #disposed = false

  constructor(options: OptimizeServiceOptions & OptimizeServiceExtras) {
    this.#options = options
    this.#logger = options.logger ?? { warn: () => {} }
  }

  /** 以 text 开始新会话：有进行中的一轮先取消，旧会话丢弃。 */
  start(text: string): Promise<OptimizeSession> {
    // 同步完成所有状态变更，再以 Promise 返回；同步抛出的 PromptxError 变成拒绝。
    return new Promise((resolve) => {
      resolve(this.#start(text))
    })
  }

  /** 追加要求：有进行中的一轮时拒绝（busy）。 */
  followup(text: string): Promise<OptimizeSession> {
    return new Promise((resolve) => {
      resolve(this.#followup(text))
    })
  }

  /** 重试失败或取消的一轮：去掉它，用同样的输入和类型在末尾追加新的一轮。 */
  retry(roundId: string): Promise<OptimizeSession> {
    return new Promise((resolve) => {
      resolve(this.#retry(roundId))
    })
  }

  /** 取消进行中的一轮，标为 cancelled；之后到达的片段丢弃。没有进行中的一轮时什么也不做。 */
  cancel(): OptimizeSession | null {
    const run = this.#active
    if (run !== null) {
      // 取消前已经收到的文字属于这一轮的回复（O-01：会话栏里已有的内容还在），先推出去。
      this.#flushDelta(run)
      this.#detach(run)
      run.round.status = 'cancelled'
      this.#emitSession()
    }
    return this.state()
  }

  /** 先取消，再丢弃整个会话（O-07）。 */
  clear(): void {
    const had = this.#session !== null
    const run = this.#active
    if (run !== null) this.#detach(run)
    this.#session = null
    if (had) this.#emit({ type: 'session', session: null })
  }

  state(): OptimizeSession | null {
    return this.#session === null ? null : snapshotSession(this.#session)
  }

  /** 插件卸载：中止进行中的请求和计时器，之后不再推送任何事件。 */
  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    const run = this.#active
    if (run !== null) this.#detach(run)
    for (const timer of this.#deferred) clearTimeout(timer)
    this.#deferred.clear()
    for (const lookup of this.#lookups) lookup.abort()
    this.#lookups.clear()
    this.#session = null
  }

  // ───────────────────────────── 会话操作 ─────────────────────────────

  #start(text: string): OptimizeSession {
    this.#assertOpen()
    if (isBlank(text)) throw new PromptxError('promptx/optimize/empty')
    const llm = this.#options.getLlm()
    const selection = this.#options.getModel()
    // llm、agentDefaultModel 服务不在时在开始会话前就拒绝（O-01「不开始会话」；dsh-base 总会挂载它们，这里是兜底）。
    if (llm === undefined || selection === undefined || isBlank(selection.provider) || isBlank(selection.model)) {
      throw new PromptxError('promptx/optimize/no-model')
    }
    // 指令和语言在会话开始时取快照；先算好再动旧会话，取配置出错时旧会话保持原样。
    const system = buildSystemPrompt(this.#options.getInstruction(), this.#options.getLocale())

    const previous = this.#active
    if (previous !== null) this.#detach(previous)

    const session: SessionState = {
      id: newId(),
      // 显示名先用模型 id，取到 dsh 的显示名后再推一次会话（取名最多等 5 秒，不能挡住第一轮请求）。
      model: { provider: selection.provider, model: selection.model, name: selection.model },
      reasoningEffort: selection.reasoningEffort,
      system,
      rounds: [],
    }
    const round = newRound('initial', text)
    session.rounds.push(round)
    this.#session = session
    this.#emitSession()
    this.#launch(session, round, llm)
    this.#defer(() => {
      if (this.#session === session) this.#lookupModelName(session, llm)
    })
    return snapshotSession(session)
  }

  #followup(text: string): OptimizeSession {
    this.#assertOpen()
    if (isBlank(text)) throw new PromptxError('promptx/optimize/empty')
    const session = this.#session
    if (session === null) throw new PromptxError('promptx/optimize/no-session')
    if (this.#active !== null) throw new PromptxError('promptx/optimize/busy')
    const llm = this.#options.getLlm()
    if (llm === undefined) throw new PromptxError('promptx/optimize/no-model')
    const round = newRound('followup', text)
    session.rounds.push(round)
    this.#emitSession()
    this.#launch(session, round, llm)
    return snapshotSession(session)
  }

  #retry(roundId: string): OptimizeSession {
    this.#assertOpen()
    const session = this.#session
    if (session === null) throw new PromptxError('promptx/optimize/no-session')
    if (this.#active !== null) throw new PromptxError('promptx/optimize/busy')
    const index = session.rounds.findIndex(item => item.id === roundId)
    const previous = session.rounds[index]
    // 找不到这一轮（会话已换过）或它不是失败、取消的轮次：小窗手里的状态过期了。
    if (previous === undefined || (previous.status !== 'failed' && previous.status !== 'cancelled')) {
      throw new PromptxError('promptx/optimize/stale')
    }
    const llm = this.#options.getLlm()
    if (llm === undefined) throw new PromptxError('promptx/optimize/no-model')
    session.rounds.splice(index, 1)
    const round = newRound(previous.kind, previous.input)
    session.rounds.push(round)
    this.#emitSession()
    this.#launch(session, round, llm)
    return snapshotSession(session)
  }

  #assertOpen(): void {
    if (this.#disposed) throw new PromptxError('promptx/internal', 'optimize service disposed')
  }

  // ───────────────────────────── 一轮请求 ─────────────────────────────

  #launch(session: SessionState, round: OptimizeRound, llm: LlmLike): void {
    const run: ActiveRun = { session, round, controller: new AbortController(), sawText: false, pending: '', timer: undefined }
    this.#active = run
    // 下一个宏任务再发请求（见文件头）；在那之前被取消或换掉的一轮不再发请求。
    this.#defer(() => {
      if (this.#isCurrent(run)) background(this.#logger, 'optimize round', this.#run(run, llm))
    })
  }

  #defer(task: () => void): void {
    const timer = setTimeout(() => {
      this.#deferred.delete(timer)
      if (this.#disposed) return
      try {
        task()
      } catch {
        // 计时器回调里抛出的异常会成为未捕获异常，让整个 dsh 退出；这里的任务本身不抛，兜底而已。
        try {
          this.#logger.warn('optimize deferred task failed')
        } catch {
          // 日志本身出错时也不能抛出。
        }
      }
    }, 0)
    this.#deferred.add(timer)
  }

  /** 跑完一轮。所有异常都在这里变成这一轮的结果，返回的 Promise 不会拒绝。 */
  async #run(run: ActiveRun, llm: LlmLike): Promise<void> {
    let outcome: Outcome | null
    try {
      const { session, round } = run
      const stream = llm.stream({
        provider: session.model.provider,
        model: session.model.model,
        ...(session.reasoningEffort === undefined ? {} : { reasoningEffort: session.reasoningEffort }),
        system: session.system,
        messages: this.#messagesFor(session, round),
        signal: run.controller.signal,
        purpose: OPTIMIZE_PURPOSE,
      })
      outcome = await this.#consume(run, stream)
    } catch (error) {
      outcome = this.#isCurrent(run) ? outcomeFromThrown(error) : null
    }
    if (outcome !== null) this.#settle(run, outcome)
  }

  /**
   * 请求历史（O-05、O-06）：之前每个成功（done）的轮次按「用户 / 助手」交替放进去，失败和取消的不带；
   * 最后是这一轮的输入（第一轮是草稿全文，之后是追加要求）。
   */
  #messagesFor(session: SessionState, current: OptimizeRound): unknown[] {
    const source = { provider: session.model.provider, model: session.model.model }
    const messages: unknown[] = []
    for (const round of session.rounds) {
      if (round === current || round.status !== 'done') continue
      messages.push(userMessage(round.input))
      messages.push(this.#options.createAssistantMessage(round.reply, source))
    }
    messages.push(userMessage(current.input))
    return messages
  }

  /**
   * 读流。返回 null 表示不需要再结算：这一轮已被换掉（取消、新会话、清空），或者已经按 finish 结算过。
   */
  async #consume(run: ActiveRun, stream: AsyncIterable<LlmChunk>): Promise<Outcome | null> {
    for await (const chunk of stream) {
      // 取消后迟到的片段直接丢弃（O-06）；跳出循环会调用迭代器的 return()，让 llm 尽快结束请求。
      if (!this.#isCurrent(run)) return null
      const text = textDelta(chunk)
      if (text !== null) {
        run.sawText = true
        if (text !== '') this.#appendText(run, text)
        continue
      }
      const reason = finishReason(chunk)
      if (reason !== null) {
        // 收到 finish 就结算，不等迭代器关闭：跳出循环时 dsh-llm 还要关掉适配器的流（例如 HTTP 响应体），
        // 那一步慢的话会让会话栏在回复完整之后还转一会儿圈。
        this.#settle(run, outcomeFromFinish(reason))
        return null
      }
      // reasoning-delta、usage、block-start/end 等与显示无关。
    }
    // 没有 finish 就结束的流：按正常结束处理，回复为空时在 #settle 里归为「没有返回内容」。
    return this.#isCurrent(run) ? { kind: 'done' } : null
  }

  #settle(run: ActiveRun, outcome: Outcome): void {
    if (!this.#isCurrent(run)) return
    this.#flushDelta(run)
    this.#detach(run, false)
    const { session, round } = run

    let result = outcome
    // 正常结束但没有任何文字（例如只有推理内容）：没有可用的回复，按「模型没有返回内容」失败处理，
    // 也避免把空的助手消息带进之后的请求历史。
    if (result.kind === 'done' && isBlank(round.reply)) {
      result = { kind: 'failed', error: { code: 'promptx/optimize/empty-response' }, noModel: false }
    }

    switch (result.kind) {
      case 'done':
        round.status = 'done'
        round.candidate = extractCandidate(round.reply)
        break
      case 'cancelled':
        round.status = 'cancelled'
        break
      case 'failed':
        // 第一轮在收到任何文字前以「没有可用模型」类错误结束：丢弃整个会话，小窗收起会话栏，只在底栏提示
        // （O-01「不开始会话」，审查 TC-07）。追加轮遇到同样的错误码按普通失败处理。
        if (result.noModel && !run.sawText && round.kind === 'initial' && !session.rounds.some(item => item.status === 'done')) {
          if (this.#session === session) this.#session = null
          this.#emit({ type: 'discarded', sessionId: session.id, error: result.error })
          return
        }
        round.status = 'failed'
        round.error = result.error
        break
    }
    if (this.#session === session) this.#emitSession()
  }

  #appendText(run: ActiveRun, text: string): void {
    run.round.reply += text
    run.pending += text
    if (run.timer !== undefined) return
    run.timer = setTimeout(() => {
      run.timer = undefined
      this.#flushDelta(run)
    }, DELTA_FLUSH_MS)
  }

  /** 把这一轮攒下的增量推出去。 */
  #flushDelta(run: ActiveRun): void {
    if (run.timer !== undefined) {
      clearTimeout(run.timer)
      run.timer = undefined
    }
    if (run.pending === '') return
    const text = run.pending
    run.pending = ''
    if (!this.#isCurrent(run)) return
    this.#emit({ type: 'delta', sessionId: run.session.id, roundId: run.round.id, text })
  }

  /** 让 run 不再是进行中的一轮。abort 为 true 时同时中止请求（取消、换会话、清空、卸载）。 */
  #detach(run: ActiveRun, abort = true): void {
    if (run.timer !== undefined) {
      clearTimeout(run.timer)
      run.timer = undefined
    }
    run.pending = ''
    if (this.#active === run) this.#active = null
    // 先解除再中止：llm 在 abort 监听里同步吐出的片段也会被当成迟到的片段丢掉。
    if (abort) run.controller.abort()
  }

  #isCurrent(run: ActiveRun): boolean {
    return !this.#disposed && this.#active === run
  }

  // ───────────────────────────── 模型显示名 ─────────────────────────────

  #lookupModelName(session: SessionState, llm: LlmLike): void {
    const controller = new AbortController()
    this.#lookups.add(controller)
    const { provider, model } = session.model
    const task = resolveModelName(llm, provider, model, controller).then((name) => {
      this.#lookups.delete(controller)
      if (this.#session !== session || session.model.name === name) return
      session.model.name = name
      this.#emitSession()
    })
    background(this.#logger, 'optimize model name', task)
  }

  // ───────────────────────────── 推送 ─────────────────────────────

  #emitSession(): void {
    const session = this.#session
    if (session === null) return
    // 快照包含了还没推出去的增量，先把它们推出去，保证快照之后不会再收到它已包含的文字。
    const run = this.#active
    if (run !== null && run.session === session) this.#flushDelta(run)
    this.#emit({ type: 'session', session: snapshotSession(session) })
  }

  #emit(event: OptimizeEvent): void {
    if (this.#disposed) return
    try {
      this.#options.emit(event)
    } catch {
      // 推送失败（例如小程序正在重启）不能打断会话状态的维护；小窗重连后用 optimize.state 取最新状态。
      try {
        this.#logger.warn('optimize event %s not delivered', event.type)
      } catch {
        // 日志本身出错时也不能抛出。
      }
    }
  }
}

// ───────────────────────────── 工具函数 ─────────────────────────────

function newId(): string {
  // crypto.randomUUID 被 lint 禁用（浏览器在非安全上下文里不给它）；Host 用 node:crypto 的随机字节。
  return randomBytes(8).toString('hex')
}

function newRound(kind: OptimizeRound['kind'], input: string): OptimizeRound {
  return { id: newId(), kind, input, status: 'running', reply: '', candidate: null }
}

function userMessage(text: string): { role: 'user'; content: Array<{ type: 'text'; text: string }> } {
  return { role: 'user', content: [{ type: 'text', text }] }
}

function snapshotSession(session: SessionState): OptimizeSession {
  return { id: session.id, model: { ...session.model }, rounds: session.rounds.map(snapshotRound) }
}

function snapshotRound(round: OptimizeRound): OptimizeRound {
  const copy: OptimizeRound = {
    id: round.id,
    kind: round.kind,
    input: round.input,
    status: round.status,
    reply: round.reply,
    candidate: round.candidate,
  }
  if (round.error !== undefined) copy.error = { ...round.error }
  return copy
}

function textDelta(chunk: LlmChunk): string | null {
  if (chunk.type !== 'text-delta') return null
  const text = (chunk as { text?: unknown }).text
  return typeof text === 'string' ? text : null
}

interface FinishReasonLike {
  kind: string
  failure?: unknown
}

function finishReason(chunk: LlmChunk): FinishReasonLike | null {
  if (chunk.type !== 'finish') return null
  const reason = (chunk as { reason?: unknown }).reason
  if (typeof reason !== 'object' || reason === null) return { kind: 'stop' }
  const kind = (reason as { kind?: unknown }).kind
  return { kind: typeof kind === 'string' ? kind : 'stop', failure: (reason as { failure?: unknown }).failure }
}

function outcomeFromFinish(reason: FinishReasonLike): Outcome {
  if (reason.kind !== 'error' && reason.kind !== 'aborted') return { kind: 'done' }
  const failure = reason.failure
  const code = readString(failure, 'code')
  const message = readString(failure, 'message')
  return classifyFailure(code, message, reason.kind === 'aborted')
}

function outcomeFromThrown(error: unknown): Outcome {
  if (error instanceof PromptxError) {
    return { kind: 'failed', error: error.toInfo(), noModel: error.code === 'promptx/optimize/no-model' }
  }
  // 中途被别处中止（不是这一轮的取消，那种情况在这之前已经丢弃了）：按取消显示。
  if (error instanceof Error && error.name === 'AbortError') return { kind: 'cancelled' }
  const code = readString(error, 'code')
  const message = error instanceof Error ? error.message : readString(error, 'message')
  return classifyFailure(code, message, false)
}

/**
 * 失败归类（design-spec 4.6）。ABORTED 按取消处理；认识的码给固定的错误码，不带模型服务的原文；
 * 其他失败带上原文的第一行（最多 300 字）作为原因。
 */
function classifyFailure(code: string, message: string, aborted: boolean): Outcome {
  if (code === 'ABORTED') return { kind: 'cancelled' }
  if (NO_MODEL_CODES.has(code)) return { kind: 'failed', error: { code: 'promptx/optimize/no-model' }, noModel: true }
  const mapped = FAILURE_CODES.get(code)
  if (mapped !== undefined) return { kind: 'failed', error: { code: mapped }, noModel: false }
  // 不是我们发起的中止、码也不认识：仍然是一次中止，按取消显示。
  if (aborted) return { kind: 'cancelled' }
  const detail = (message.split(/\r?\n/, 1)[0] ?? '').trim().slice(0, MAX_DETAIL)
  return { kind: 'failed', error: detail === '' ? { code: 'promptx/optimize/failed' } : { code: 'promptx/optimize/failed', detail }, noModel: false }
}

function readString(value: unknown, key: string): string {
  if (typeof value !== 'object' || value === null) return ''
  const field = (value as Record<string, unknown>)[key]
  return typeof field === 'string' ? field : ''
}

/**
 * 模型显示名：llm.resolveModelInfo 的 name，5 秒内取不到、失败或为空时用模型 id。
 * 不依赖适配器理会 signal：超时后直接给出结果。返回的 Promise 不会拒绝。
 */
function resolveModelName(llm: LlmLike, provider: string, model: string, controller: AbortController): Promise<string> {
  return new Promise<string>((resolve) => {
    let done = false
    const finish = (name: string) => {
      if (done) return
      done = true
      clearTimeout(timer)
      controller.signal.removeEventListener('abort', onAbort)
      resolve(name)
    }
    const onAbort = () => {
      finish(model)
    }
    const timer = setTimeout(() => {
      finish(model)
      // 超时后让适配器停下正在进行的查询。
      controller.abort()
    }, MODEL_NAME_TIMEOUT_MS)
    ;(timer as { unref?: () => void }).unref?.()
    controller.signal.addEventListener('abort', onAbort, { once: true })
    let pending: Promise<{ name: string }>
    try {
      pending = llm.resolveModelInfo(provider, model, controller.signal)
    } catch {
      finish(model)
      return
    }
    pending.then(
      (info) => {
        // 适配器返回的结构不受类型保证，按 unknown 读。
        const raw = (info as { name?: unknown } | null)?.name
        const name = typeof raw === 'string' ? raw.trim() : ''
        finish(name === '' ? model : name)
      },
      () => {
        finish(model)
      },
    )
  })
}
