import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DELTA_FLUSH_MS, MODEL_NAME_TIMEOUT_MS, OPTIMIZE_PURPOSE, OptimizeService } from '../../src/optimize/service.ts'
import type { LlmChunk, LlmLike, ModelSelection } from '../../src/services.ts'
import { PromptxError } from '../../src/shared/errors.ts'
import { buildSystemPrompt, DEFAULT_INSTRUCTION, FORMAT_CONTRACT } from '../../src/shared/instructions.ts'
import type { OptimizeEvent, OptimizeSession } from '../../src/shared/types.ts'

// ───────────────────────────── 未处理的异常 ─────────────────────────────

// Host 里任何未处理的拒绝都会让整个 dsh 退出，测试里一旦出现就判失败。
const unexpected: unknown[] = []
const trap = (error: unknown) => {
  unexpected.push(error)
}

beforeEach(() => {
  unexpected.length = 0
  process.on('unhandledRejection', trap)
  process.on('uncaughtException', trap)
  vi.useFakeTimers()
})

afterEach(async () => {
  vi.useRealTimers()
  // 给迟到的拒绝一个机会冒出来。
  await new Promise(resolve => setImmediate(resolve))
  process.off('unhandledRejection', trap)
  process.off('uncaughtException', trap)
  expect(unexpected).toEqual([])
})

// ───────────────────────────── 模拟的 llm 服务 ─────────────────────────────

type StreamOptions = Parameters<LlmLike['stream']>[0]

/**
 * 由测试逐块喂数据的流。默认像 dsh-llm 一样理会 AbortSignal：中止后以 ABORTED 的 aborted finish 结束；
 * ignoreAbort 时不理会中止，继续吐测试喂进来的片段（用来验证迟到的片段被丢弃）。
 */
class ControlledStream {
  readonly #queue: LlmChunk[] = []
  #wake: (() => void) | null = null
  #ended = false
  #aborted = false
  /** 迭代器已结束（正常结束或被调用方 return()）。 */
  closed = false
  ignoreAbort = false

  constructor(signal: AbortSignal | undefined) {
    signal?.addEventListener('abort', () => {
      this.#aborted = true
      this.#notify()
    })
  }

  push(...chunks: LlmChunk[]): void {
    this.#queue.push(...chunks)
    this.#notify()
  }

  text(...parts: string[]): void {
    this.push(...parts.map((text): LlmChunk => ({ type: 'text-delta', index: 0, text })))
  }

  finish(kind: 'stop' | 'max-tokens' = 'stop'): void {
    this.push({ type: 'finish', reason: { kind } })
  }

  fail(code: string, message = `${code} failure`, kind: 'error' | 'aborted' = 'error'): void {
    this.push({ type: 'finish', reason: { kind, failure: { code, message } } })
  }

  end(): void {
    this.#ended = true
    this.#notify()
  }

  #notify(): void {
    const wake = this.#wake
    this.#wake = null
    wake?.()
  }

  async *iterate(): AsyncGenerator<LlmChunk> {
    try {
      for (;;) {
        const next = this.#queue.shift()
        if (next !== undefined) {
          yield next
          continue
        }
        if (this.#ended) return
        if (this.#aborted && !this.ignoreAbort) {
          yield { type: 'finish', reason: { kind: 'aborted', failure: { code: 'ABORTED', message: 'aborted' } } }
          return
        }
        await new Promise<void>((resolve) => {
          this.#wake = resolve
        })
      }
    } finally {
      this.closed = true
    }
  }
}

class FakeLlm implements LlmLike {
  readonly calls: StreamOptions[] = []
  readonly streams: ControlledStream[] = []
  /** 返回 undefined 时用 ControlledStream；否则用它的结果（模拟同步抛出或自定义的流）。 */
  override: ((options: StreamOptions) => AsyncIterable<LlmChunk>) | undefined
  ignoreAbort = false
  modelInfo: (provider: string, model: string, signal?: AbortSignal) => Promise<{ name: string }> = () => Promise.resolve({ name: 'DeepSeek Chat' })
  readonly infoCalls: Array<{ provider: string; model: string; signal: AbortSignal | undefined }> = []

  stream(options: StreamOptions): AsyncIterable<LlmChunk> {
    this.calls.push(options)
    if (this.override !== undefined) return this.override(options)
    const stream = new ControlledStream(options.signal)
    stream.ignoreAbort = this.ignoreAbort
    this.streams.push(stream)
    return stream.iterate()
  }

  resolveModelInfo(provider: string, model: string, signal?: AbortSignal): Promise<{ name: string }> {
    this.infoCalls.push({ provider, model, signal })
    return this.modelInfo(provider, model, signal)
  }

  last(): ControlledStream {
    const stream = this.streams.at(-1)
    if (stream === undefined) throw new Error('no stream yet')
    return stream
  }
}

interface Harness {
  service: OptimizeService
  llm: FakeLlm
  events: OptimizeEvent[]
  config: { instruction: string; locale: 'zh' | 'en'; model: ModelSelection | undefined; llm: boolean }
}

function setup(overrides: Partial<Harness['config']> = {}): Harness {
  const llm = new FakeLlm()
  const events: OptimizeEvent[] = []
  const config: Harness['config'] = {
    instruction: '',
    locale: 'zh',
    model: { provider: 'deepseek-official', model: 'deepseek-chat' },
    llm: true,
    ...overrides,
  }
  const service = new OptimizeService({
    getLlm: () => (config.llm ? llm : undefined),
    getModel: () => config.model,
    getInstruction: () => config.instruction,
    getLocale: () => config.locale,
    emit: (event) => {
      events.push(structuredClone(event))
    },
    createAssistantMessage: (text, source) => ({ role: 'assistant', content: [{ type: 'text', text }], source }),
  })
  return { service, llm, events, config }
}

/** 推进假计时器并让微任务跑完（async generator 的每一块都要经过好几次微任务）。 */
async function tick(ms = 0): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms)
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

function user(text: string) {
  return { role: 'user', content: [{ type: 'text', text }] }
}

function assistant(text: string) {
  return { role: 'assistant', content: [{ type: 'text', text }], source: { provider: 'deepseek-official', model: 'deepseek-chat' } }
}

function lastSession(events: OptimizeEvent[]): OptimizeSession | null | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!
    if (event.type === 'session') return event.session
  }
  return undefined
}

const REPLY = '改写如下：\n\n````prompt\n请审查这段代码。\n````\n'

/** 开始一个会话并让第一轮正常完成。 */
async function doneFirstRound(h: Harness, input = '草稿全文', reply = REPLY): Promise<OptimizeSession> {
  await h.service.start(input)
  await tick()
  h.llm.last().text(reply)
  h.llm.last().finish()
  await tick()
  const session = h.service.state()
  expect(session?.rounds.at(-1)?.status).toBe('done')
  return session!
}

// ───────────────────────────── 测试 ─────────────────────────────

describe('OptimizeService: request assembly', () => {
  it('sends the snapshot system prompt, the draft as the only message, the selected model and the purpose', async () => {
    const h = setup({ instruction: '把它改得更短。', locale: 'zh', model: { provider: 'p', model: 'm', reasoningEffort: 'high' } })
    const session = await h.service.start('草稿全文')
    expect(session.rounds).toHaveLength(1)
    expect(session.rounds[0]).toMatchObject({ kind: 'initial', input: '草稿全文', status: 'running', reply: '', candidate: null })
    // 请求推迟到下一个宏任务才发出。
    expect(h.llm.calls).toHaveLength(0)
    await tick()
    expect(h.llm.calls).toHaveLength(1)
    const options = h.llm.calls[0]!
    expect(options.provider).toBe('p')
    expect(options.model).toBe('m')
    expect(options.reasoningEffort).toBe('high')
    expect(options.system).toBe(buildSystemPrompt('把它改得更短。', 'zh'))
    expect(options.system).toContain(FORMAT_CONTRACT.zh)
    expect(options.messages).toEqual([user('草稿全文')])
    expect(options.signal).toBeInstanceOf(AbortSignal)
    expect(options.purpose).toBe(OPTIMIZE_PURPOSE)
    h.service.dispose()
  })

  it('omits reasoningEffort when the dsh default model has none', async () => {
    const h = setup()
    await h.service.start('草稿')
    await tick()
    expect(Object.hasOwn(h.llm.calls[0]!, 'reasoningEffort')).toBe(false)
    h.service.dispose()
  })

  it('puts only done rounds into the history, user and assistant alternating, then the new input', async () => {
    const h = setup()
    await doneFirstRound(h, '草稿全文', '第一轮回复')

    // 第二轮失败：不进历史。
    await h.service.followup('再精简一些')
    await tick()
    h.llm.last().fail('TRANSPORT')
    await tick()
    // 第三轮取消：不进历史。
    await h.service.followup('换个语气')
    await tick()
    h.service.cancel()
    await tick()
    // 第四轮完成。
    await h.service.followup('加上示例')
    await tick()
    h.llm.last().text('第四轮回复')
    h.llm.last().finish()
    await tick()

    await h.service.followup('最后一轮')
    await tick()
    expect(h.llm.calls.at(-1)!.messages).toEqual([
      user('草稿全文'),
      assistant('第一轮回复'),
      user('加上示例'),
      assistant('第四轮回复'),
      user('最后一轮'),
    ])
    h.service.dispose()
  })

  it('ignores reasoning deltas, usage and block markers', async () => {
    const h = setup()
    await h.service.start('草稿')
    await tick()
    const stream = h.llm.last()
    stream.push({ type: 'block-start', index: 0, blockType: 'reasoning' } as LlmChunk)
    stream.push({ type: 'reasoning-delta', index: 0, text: '思考中' } as LlmChunk)
    stream.push({ type: 'usage', usage: { inputTokens: 1, outputTokens: 2 } } as LlmChunk)
    stream.text('正文')
    stream.finish()
    await tick(DELTA_FLUSH_MS)
    expect(h.service.state()!.rounds[0]!.reply).toBe('正文')
    expect(h.events.filter(event => event.type === 'delta').map(event => event.type === 'delta' && event.text).join('')).toBe('正文')
    h.service.dispose()
  })
})

describe('OptimizeService: streaming and events', () => {
  it('emits the session on start, coalesces deltas every 50 ms and pushes the finished session with its candidate', async () => {
    const h = setup()
    const session = await h.service.start('草稿')
    expect(h.events).toEqual([{ type: 'session', session }])
    await tick()
    const stream = h.llm.last()
    const roundId = session.rounds[0]!.id

    stream.text('改写', '如下：')
    await tick(10)
    stream.text('\n')
    await tick(DELTA_FLUSH_MS - 20)
    expect(h.events.filter(event => event.type === 'delta')).toEqual([])
    await tick(20)
    expect(h.events.filter(event => event.type === 'delta')).toEqual([
      { type: 'delta', sessionId: session.id, roundId, text: '改写如下：\n' },
    ])

    stream.text('\n````prompt\n请审查这段代码。\n````\n')
    stream.finish()
    await tick()
    const deltas = h.events.filter(event => event.type === 'delta')
    expect(deltas.map(event => event.type === 'delta' && event.text).join('')).toBe(REPLY)
    // 最后一段增量在结束的会话快照之前推出。
    const finalIndex = h.events.length - 1
    expect(h.events[finalIndex - 1]?.type).toBe('delta')
    const finished = lastSession(h.events)!
    expect(finished.rounds[0]).toMatchObject({ status: 'done', reply: REPLY, candidate: '请审查这段代码。' })
    expect(vi.getTimerCount()).toBe(0)
    h.service.dispose()
  })

  it('leaves the candidate null when the reply has no prompt block', async () => {
    const h = setup()
    await h.service.start('草稿')
    await tick()
    h.llm.last().text('没有代码块的回复')
    h.llm.last().finish('max-tokens')
    await tick()
    expect(h.service.state()!.rounds[0]).toMatchObject({ status: 'done', candidate: null })
    h.service.dispose()
  })

  it('settles on the finish chunk without waiting for the stream to close', async () => {
    const h = setup()
    const chunks: LlmChunk[] = [{ type: 'text-delta', index: 0, text: REPLY }, { type: 'finish', reason: { kind: 'stop' } }]
    let returned = false
    h.llm.override = () => ({
      [Symbol.asyncIterator]: () => ({
        next: () => {
          const value = chunks.shift()
          return Promise.resolve(value === undefined ? { done: true as const, value: undefined } : { done: false as const, value })
        },
        // 关闭适配器的流很慢（永远不结束）。
        return: () => {
          returned = true
          return new Promise<IteratorResult<LlmChunk>>(() => {})
        },
      }),
    })
    await h.service.start('草稿')
    await tick()
    expect(returned).toBe(true)
    expect(h.service.state()!.rounds[0]).toMatchObject({ status: 'done', candidate: '请审查这段代码。' })
    h.service.dispose()
  })

  it('treats a stream that ends without a finish chunk as done', async () => {
    const h = setup()
    await h.service.start('草稿')
    await tick()
    h.llm.last().text(REPLY)
    h.llm.last().end()
    await tick()
    expect(h.service.state()!.rounds[0]).toMatchObject({ status: 'done', candidate: '请审查这段代码。' })
    h.service.dispose()
  })

  it('fails a round that finished without any text as empty-response, keeping it out of the history', async () => {
    const h = setup()
    await doneFirstRound(h)
    await h.service.followup('再改')
    await tick()
    h.llm.last().text('  \n')
    h.llm.last().finish()
    await tick()
    expect(h.service.state()!.rounds[1]).toMatchObject({ status: 'failed', error: { code: 'promptx/optimize/empty-response' } })
    h.service.dispose()
  })

  it('returns deep copies from state()', async () => {
    const h = setup()
    await doneFirstRound(h)
    const copy = h.service.state()!
    copy.rounds[0]!.reply = 'changed'
    copy.model.name = 'changed'
    copy.rounds.pop()
    expect(h.service.state()!.rounds[0]!.reply).toBe(REPLY)
    expect(h.service.state()!.model.name).not.toBe('changed')
    h.service.dispose()
  })
})

describe('OptimizeService: cancel and late chunks', () => {
  it('marks the running round cancelled, keeps the text so far and drops chunks that arrive afterwards', async () => {
    const h = setup()
    h.llm.ignoreAbort = true
    const session = await h.service.start('草稿')
    await tick()
    const stream = h.llm.last()
    const signal = h.llm.calls[0]!.signal!
    stream.text('已经收到的')
    await tick(10)

    const cancelled = h.service.cancel()
    expect(signal.aborted).toBe(true)
    expect(cancelled!.rounds[0]).toMatchObject({ status: 'cancelled', reply: '已经收到的' })
    // 取消前收到的增量先推出，再推取消后的会话。
    expect(h.events.slice(-2)).toEqual([
      { type: 'delta', sessionId: session.id, roundId: session.rounds[0]!.id, text: '已经收到的' },
      { type: 'session', session: cancelled },
    ])
    const count = h.events.length

    // 适配器不理会中止，继续吐片段：全部丢弃，迭代器被关掉。
    stream.text('迟到的片段')
    stream.finish()
    await tick(DELTA_FLUSH_MS * 2)
    expect(h.events).toHaveLength(count)
    expect(h.service.state()!.rounds[0]).toMatchObject({ status: 'cancelled', reply: '已经收到的' })
    expect(stream.closed).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
    h.service.dispose()
  })

  it('returns the session unchanged and emits nothing when no round is running', async () => {
    const h = setup()
    expect(h.service.cancel()).toBeNull()
    await doneFirstRound(h)
    const count = h.events.length
    expect(h.service.cancel()!.rounds[0]!.status).toBe('done')
    expect(h.events).toHaveLength(count)
    h.service.dispose()
  })

  it('does not send the request when the round is cancelled before it starts', async () => {
    const h = setup()
    await h.service.start('草稿')
    h.service.cancel()
    await tick()
    expect(h.llm.calls).toHaveLength(0)
    expect(h.service.state()!.rounds[0]!.status).toBe('cancelled')
    h.service.dispose()
  })

  it('cancels the running round when a new session starts, and the old stream cannot touch the new session', async () => {
    const h = setup()
    h.llm.ignoreAbort = true
    const first = await h.service.start('第一份草稿')
    await tick()
    const oldStream = h.llm.last()
    const oldSignal = h.llm.calls[0]!.signal!

    const second = await h.service.start('第二份草稿')
    expect(oldSignal.aborted).toBe(true)
    expect(second.id).not.toBe(first.id)
    oldStream.text('旧会话的迟到片段')
    oldStream.finish()
    await tick(DELTA_FLUSH_MS)
    expect(h.events.some(event => event.type === 'delta' && event.sessionId === first.id)).toBe(false)
    expect(h.service.state()).toMatchObject({ id: second.id, rounds: [{ input: '第二份草稿', status: 'running' }] })
    h.service.dispose()
  })
})

describe('OptimizeService: failure mapping', () => {
  const mapped: Array<[string, string]> = [
    ['AUTH', 'promptx/optimize/auth'],
    ['RATE_LIMIT', 'promptx/optimize/rate-limit'],
    ['QUOTA', 'promptx/optimize/rate-limit'],
    ['ACCOUNT_QUOTA', 'promptx/optimize/rate-limit'],
    ['TRANSPORT', 'promptx/optimize/network'],
    ['TIMEOUT', 'promptx/optimize/timeout'],
    ['EMPTY_RESPONSE', 'promptx/optimize/empty-response'],
    ['MISSING_CREDENTIAL', 'promptx/optimize/no-model'],
    ['INVALID_CREDENTIAL', 'promptx/optimize/no-model'],
    ['ACCOUNT_SIGN_IN_REQUIRED', 'promptx/optimize/no-model'],
    ['NO_ADAPTER', 'promptx/optimize/no-model'],
    ['UNKNOWN_MODEL', 'promptx/optimize/no-model'],
  ]

  it.each(mapped)('maps a %s finish to %s without the provider message', async (code, expected) => {
    const h = setup()
    await h.service.start('草稿')
    await tick()
    // 先收到文字，避免触发「第一轮没有可用模型就丢弃会话」。
    h.llm.last().text('部分')
    h.llm.last().fail(code, `${code}: secret provider text`)
    await tick()
    const round = h.service.state()!.rounds[0]!
    expect(round.status).toBe('failed')
    expect(round.error).toEqual({ code: expected })
    h.service.dispose()
  })

  it.each(mapped)('maps a thrown error with code %s to %s', async (code, expected) => {
    const h = setup()
    await doneFirstRound(h)
    h.llm.override = () => ({
      [Symbol.asyncIterator]: () => ({
        next: () => Promise.reject(Object.assign(new Error('thrown'), { code })),
      }),
    })
    await h.service.followup('再改')
    await tick()
    expect(h.service.state()!.rounds[1]).toMatchObject({ status: 'failed', error: { code: expected } })
    h.service.dispose()
  })

  it('treats an ABORTED failure as a cancellation', async () => {
    const h = setup()
    await h.service.start('草稿')
    await tick()
    h.llm.last().text('部分')
    h.llm.last().fail('ABORTED', 'aborted', 'aborted')
    await tick()
    expect(h.service.state()!.rounds[0]).toMatchObject({ status: 'cancelled', reply: '部分' })
    expect(h.service.state()!.rounds[0]!.error).toBeUndefined()
    h.service.dispose()
  })

  it('treats an aborted finish with an unknown code as a cancellation', async () => {
    const h = setup()
    await h.service.start('草稿')
    await tick()
    h.llm.last().fail('SOMETHING_ELSE', 'stopped', 'aborted')
    await tick()
    expect(h.service.state()!.rounds[0]!.status).toBe('cancelled')
    h.service.dispose()
  })

  it('reports other failures with the first line of the message, at most 300 characters', async () => {
    const h = setup()
    await h.service.start('草稿')
    await tick()
    h.llm.last().fail('PROVIDER_DOWN', 'upstream returned 503\nstack line 1\nstack line 2')
    await tick()
    expect(h.service.state()!.rounds[0]!.error).toEqual({ code: 'promptx/optimize/failed', detail: 'upstream returned 503' })

    await h.service.retry(h.service.state()!.rounds[0]!.id)
    await tick()
    h.llm.last().fail('PROVIDER_DOWN', 'x'.repeat(500))
    await tick()
    expect(h.service.state()!.rounds[0]!.error).toEqual({ code: 'promptx/optimize/failed', detail: 'x'.repeat(300) })

    await h.service.retry(h.service.state()!.rounds[0]!.id)
    await tick()
    h.llm.last().fail('', '')
    await tick()
    expect(h.service.state()!.rounds[0]!.error).toEqual({ code: 'promptx/optimize/failed' })
    h.service.dispose()
  })

  it('reports an error thrown without a code as failed with its first line', async () => {
    const h = setup()
    h.llm.override = () => ({
      [Symbol.asyncIterator]: () => ({
        next: () => Promise.reject(new TypeError('fetch failed\n    at undici')),
      }),
    })
    await h.service.start('草稿')
    await tick()
    expect(h.service.state()!.rounds[0]).toMatchObject({ status: 'failed', error: { code: 'promptx/optimize/failed', detail: 'fetch failed' } })
    h.service.dispose()
  })

  it('treats an AbortError thrown by the stream as a cancellation', async () => {
    const h = setup()
    await doneFirstRound(h)
    h.llm.override = () => ({
      [Symbol.asyncIterator]: () => ({
        next: () => Promise.reject(new DOMException('The operation was aborted.', 'AbortError')),
      }),
    })
    await h.service.followup('再改')
    await tick()
    expect(h.service.state()!.rounds[1]!.status).toBe('cancelled')
    h.service.dispose()
  })
})

describe('OptimizeService: no model on the first round (O-01, review TC-07)', () => {
  const noModelCodes = ['MISSING_CREDENTIAL', 'INVALID_CREDENTIAL', 'ACCOUNT_SIGN_IN_REQUIRED', 'NO_ADAPTER', 'UNKNOWN_MODEL']

  it.each(noModelCodes)('discards the session when the first round ends with %s before any text', async (code) => {
    const h = setup()
    const session = await h.service.start('草稿')
    await tick()
    h.llm.last().fail(code, `${code}: configure a key`)
    await tick()
    expect(h.service.state()).toBeNull()
    expect(h.events.at(-1)).toEqual({ type: 'discarded', sessionId: session.id, error: { code: 'promptx/optimize/no-model' } })
    // 丢弃时不再推送失败的会话快照（会话栏不会先展开一轮失败再收起）。
    expect(h.events.some(event => event.type === 'session' && event.session?.rounds.some(round => round.status !== 'running'))).toBe(false)
    await expect(h.service.followup('追加')).rejects.toMatchObject({ code: 'promptx/optimize/no-session' })
    h.service.dispose()
  })

  it('discards the session when the adapter throws NO_ADAPTER synchronously, after the start result is delivered', async () => {
    const h = setup()
    h.llm.override = () => {
      throw Object.assign(new Error('no adapter registered for provider'), { code: 'NO_ADAPTER' })
    }
    let typesWhenResolved: string[] = []
    const session = await h.service.start('草稿').then((result) => {
      typesWhenResolved = h.events.map(event => event.type)
      return result
    })
    // start 的结果交出时只推过「开始」的会话；丢弃事件在那之后才推，小窗不会用过期的「进行中」快照盖掉它。
    expect(session.rounds[0]!.status).toBe('running')
    expect(typesWhenResolved).toEqual(['session'])
    await tick()
    expect(h.events.map(event => event.type)).toEqual(['session', 'discarded'])
    expect(h.service.state()).toBeNull()
    // 会话已丢弃，不再去取模型显示名。
    expect(h.llm.infoCalls).toHaveLength(0)
    h.service.dispose()
  })

  it('keeps the session as a normal failure when text arrived before the no-model failure', async () => {
    const h = setup()
    await h.service.start('草稿')
    await tick()
    h.llm.last().text('部分回复')
    h.llm.last().fail('MISSING_CREDENTIAL')
    await tick()
    expect(h.service.state()!.rounds[0]).toMatchObject({ status: 'failed', error: { code: 'promptx/optimize/no-model' } })
    expect(h.events.some(event => event.type === 'discarded')).toBe(false)
    h.service.dispose()
  })

  it('treats the same code on a follow-up round as a normal failure', async () => {
    const h = setup()
    await doneFirstRound(h)
    await h.service.followup('再精简一些')
    await tick()
    h.llm.last().fail('MISSING_CREDENTIAL')
    await tick()
    const state = h.service.state()!
    expect(state.rounds).toHaveLength(2)
    expect(state.rounds[1]).toMatchObject({ kind: 'followup', status: 'failed', error: { code: 'promptx/optimize/no-model' } })
    expect(h.events.some(event => event.type === 'discarded')).toBe(false)
    h.service.dispose()
  })

  it('refuses to start without the llm service or a default model, leaving the current session alone', async () => {
    const h = setup()
    const session = await doneFirstRound(h)
    const count = h.events.length
    h.config.llm = false
    await expect(h.service.start('草稿')).rejects.toMatchObject({ code: 'promptx/optimize/no-model' })
    h.config.llm = true
    h.config.model = undefined
    await expect(h.service.start('草稿')).rejects.toMatchObject({ code: 'promptx/optimize/no-model' })
    h.config.model = { provider: '', model: 'deepseek-chat' }
    await expect(h.service.start('草稿')).rejects.toBeInstanceOf(PromptxError)
    expect(h.service.state()!.id).toBe(session.id)
    expect(h.events).toHaveLength(count)
    h.service.dispose()
  })

  it('refuses follow-ups and retries when the llm service disappeared', async () => {
    const h = setup()
    await doneFirstRound(h)
    h.config.llm = false
    await expect(h.service.followup('追加')).rejects.toMatchObject({ code: 'promptx/optimize/no-model' })
    h.service.dispose()
  })
})

describe('OptimizeService: retry, busy, empty, clear', () => {
  it('retries a failed round by removing it and appending a new round with the same input and kind', async () => {
    const h = setup()
    await doneFirstRound(h, '草稿全文', '第一轮回复')
    await h.service.followup('再精简一些')
    await tick()
    h.llm.last().fail('TIMEOUT')
    await tick()
    const failed = h.service.state()!.rounds[1]!
    expect(failed.status).toBe('failed')

    const retried = await h.service.retry(failed.id)
    expect(retried.rounds).toHaveLength(2)
    expect(retried.rounds.some(round => round.id === failed.id)).toBe(false)
    expect(retried.rounds[1]).toMatchObject({ kind: 'followup', input: '再精简一些', status: 'running', reply: '' })
    expect(retried.rounds[1]!.error).toBeUndefined()
    await tick()
    expect(h.llm.calls.at(-1)!.messages).toEqual([user('草稿全文'), assistant('第一轮回复'), user('再精简一些')])
    h.llm.last().text('第二轮回复')
    h.llm.last().finish()
    await tick()
    expect(h.service.state()!.rounds[1]).toMatchObject({ status: 'done', reply: '第二轮回复' })
    h.service.dispose()
  })

  it('retries a cancelled first round as an initial round', async () => {
    const h = setup()
    const session = await h.service.start('草稿全文')
    await tick()
    h.service.cancel()
    const retried = await h.service.retry(session.rounds[0]!.id)
    expect(retried.rounds).toEqual([expect.objectContaining({ kind: 'initial', input: '草稿全文', status: 'running' })])
    await tick()
    expect(h.llm.calls.at(-1)!.messages).toEqual([user('草稿全文')])
    h.service.dispose()
  })

  it('rejects retries of rounds that are done, unknown or when there is no session', async () => {
    const h = setup()
    await expect(h.service.retry('nope')).rejects.toMatchObject({ code: 'promptx/optimize/no-session' })
    const session = await doneFirstRound(h)
    await expect(h.service.retry(session.rounds[0]!.id)).rejects.toMatchObject({ code: 'promptx/optimize/stale' })
    await expect(h.service.retry('unknown-round')).rejects.toMatchObject({ code: 'promptx/optimize/stale' })
    h.service.dispose()
  })

  it('rejects follow-ups and retries while a round is running', async () => {
    const h = setup()
    const session = await doneFirstRound(h)
    await h.service.followup('第二轮')
    await expect(h.service.followup('第三轮')).rejects.toMatchObject({ code: 'promptx/optimize/busy' })
    await expect(h.service.retry(session.rounds[0]!.id)).rejects.toMatchObject({ code: 'promptx/optimize/busy' })
    h.service.dispose()
  })

  it('rejects blank text without touching anything', async () => {
    const h = setup()
    await expect(h.service.start('  \n\t　')).rejects.toMatchObject({ code: 'promptx/optimize/empty' })
    await expect(h.service.followup('')).rejects.toMatchObject({ code: 'promptx/optimize/empty' })
    await doneFirstRound(h)
    const count = h.events.length
    await expect(h.service.followup(' \n ')).rejects.toMatchObject({ code: 'promptx/optimize/empty' })
    expect(h.events).toHaveLength(count)
    expect(h.service.state()!.rounds).toHaveLength(1)
    h.service.dispose()
  })

  it('rejects a follow-up without a session', async () => {
    const h = setup()
    await expect(h.service.followup('追加')).rejects.toMatchObject({ code: 'promptx/optimize/no-session' })
    h.service.dispose()
  })

  it('clear cancels the running round, drops the session and pushes an empty session', async () => {
    const h = setup()
    h.llm.ignoreAbort = true
    await h.service.start('草稿')
    await tick()
    const stream = h.llm.last()
    h.service.clear()
    expect(h.llm.calls[0]!.signal!.aborted).toBe(true)
    expect(h.service.state()).toBeNull()
    expect(h.events.at(-1)).toEqual({ type: 'session', session: null })
    const count = h.events.length
    stream.text('迟到')
    stream.finish()
    await tick(DELTA_FLUSH_MS)
    expect(h.events).toHaveLength(count)
    // 没有会话时清空不推送。
    h.service.clear()
    expect(h.events).toHaveLength(count)
    h.service.dispose()
  })
})

describe('OptimizeService: instruction and locale snapshots (O-08)', () => {
  it('keeps the instruction of the running session when the configuration changes', async () => {
    const h = setup({ instruction: '指令 A' })
    await doneFirstRound(h)
    h.config.instruction = '指令 B'
    await h.service.followup('追加')
    await tick()
    expect(h.llm.calls.at(-1)!.system).toBe(buildSystemPrompt('指令 A', 'zh'))
    h.llm.last().text('好')
    h.llm.last().finish()
    await tick()
    await h.service.start('新草稿')
    await tick()
    expect(h.llm.calls.at(-1)!.system).toBe(buildSystemPrompt('指令 B', 'zh'))
    h.service.dispose()
  })

  it('uses the default instruction in the session language when the instruction is blank', async () => {
    const h = setup({ instruction: '  \n ', locale: 'en' })
    await h.service.start('draft')
    await tick()
    expect(h.llm.calls[0]!.system).toBe(`${DEFAULT_INSTRUCTION.en}\n\n${FORMAT_CONTRACT.en}`)
    h.service.dispose()
  })

  it('keeps the language snapshot for follow-ups and picks up the new language for a new session', async () => {
    const h = setup({ instruction: '', locale: 'zh' })
    await doneFirstRound(h)
    expect(h.llm.calls[0]!.system).toBe(`${DEFAULT_INSTRUCTION.zh}\n\n${FORMAT_CONTRACT.zh}`)
    h.config.locale = 'en'
    await h.service.followup('追加')
    await tick()
    expect(h.llm.calls.at(-1)!.system).toBe(`${DEFAULT_INSTRUCTION.zh}\n\n${FORMAT_CONTRACT.zh}`)
    h.service.cancel()
    await h.service.start('new draft')
    await tick()
    expect(h.llm.calls.at(-1)!.system).toBe(`${DEFAULT_INSTRUCTION.en}\n\n${FORMAT_CONTRACT.en}`)
    h.service.dispose()
  })
})

describe('OptimizeService: model name', () => {
  it('starts with the model id and pushes the dsh display name once resolved', async () => {
    const h = setup()
    const session = await h.service.start('草稿')
    expect(session.model).toEqual({ provider: 'deepseek-official', model: 'deepseek-chat', name: 'deepseek-chat' })
    await tick()
    expect(h.llm.infoCalls).toHaveLength(1)
    expect(h.llm.infoCalls[0]).toMatchObject({ provider: 'deepseek-official', model: 'deepseek-chat' })
    expect(h.llm.infoCalls[0]!.signal).toBeInstanceOf(AbortSignal)
    expect(lastSession(h.events)!.model.name).toBe('DeepSeek Chat')
    expect(h.service.state()!.model.name).toBe('DeepSeek Chat')
    h.service.dispose()
  })

  it('falls back to the model id after 5 seconds and aborts the lookup', async () => {
    const h = setup()
    let lookupSignal: AbortSignal | undefined
    h.llm.modelInfo = (_provider, _model, signal) => {
      lookupSignal = signal
      return new Promise(() => {})
    }
    await h.service.start('草稿')
    await tick()
    h.llm.last().text('回复')
    h.llm.last().finish()
    await tick()
    const count = h.events.length
    await tick(MODEL_NAME_TIMEOUT_MS)
    expect(lookupSignal?.aborted).toBe(true)
    expect(h.service.state()!.model.name).toBe('deepseek-chat')
    expect(h.events).toHaveLength(count)
    expect(vi.getTimerCount()).toBe(0)
    h.service.dispose()
  })

  it('falls back to the model id when the lookup fails, throws or returns a blank name', async () => {
    for (const modelInfo of [
      () => Promise.reject(new Error('unknown model')),
      () => {
        throw new Error('sync failure')
      },
      () => Promise.resolve({ name: '   ' }),
    ]) {
      const h = setup()
      h.llm.modelInfo = modelInfo
      await h.service.start('草稿')
      await tick()
      expect(h.service.state()!.model.name).toBe('deepseek-chat')
      expect(h.events.filter(event => event.type === 'session')).toHaveLength(1)
      h.service.dispose()
    }
  })

  it('does not rename a session that was replaced before the name arrived', async () => {
    const h = setup()
    let release: ((info: { name: string }) => void) | undefined
    h.llm.modelInfo = () => new Promise((resolve) => {
      release = resolve
    })
    const first = await h.service.start('第一份')
    await tick()
    h.llm.modelInfo = () => new Promise(() => {})
    await h.service.start('第二份')
    release?.({ name: 'Late Name' })
    await tick()
    expect(h.events.some(event => event.type === 'session' && event.session?.id === first.id && event.session.model.name === 'Late Name')).toBe(false)
    expect(h.service.state()!.model.name).toBe('deepseek-chat')
    h.service.dispose()
  })
})

describe('OptimizeService: dispose and emitter failures', () => {
  it('aborts the running round, clears every timer and stays silent afterwards', async () => {
    const h = setup()
    h.llm.modelInfo = () => new Promise(() => {})
    await h.service.start('草稿')
    await tick()
    h.llm.last().text('部分')
    await tick(10)
    const signal = h.llm.calls[0]!.signal!
    const count = h.events.length
    h.service.dispose()
    expect(signal.aborted).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
    expect(h.service.state()).toBeNull()
    await tick(MODEL_NAME_TIMEOUT_MS)
    expect(h.events).toHaveLength(count)
    await expect(h.service.start('草稿')).rejects.toMatchObject({ code: 'promptx/internal' })
  })

  it('drops pending deferred work when disposed right after start', async () => {
    const h = setup()
    await h.service.start('草稿')
    h.service.dispose()
    expect(vi.getTimerCount()).toBe(0)
    await tick()
    expect(h.llm.calls).toHaveLength(0)
    expect(h.llm.infoCalls).toHaveLength(0)
  })

  it('keeps working when the event sink throws', async () => {
    const llm = new FakeLlm()
    const warnings: string[] = []
    const service = new OptimizeService({
      getLlm: () => llm,
      getModel: () => ({ provider: 'p', model: 'm' }),
      getInstruction: () => '',
      getLocale: () => 'zh',
      emit: () => {
        throw new Error('pipe closed')
      },
      createAssistantMessage: text => ({ role: 'assistant', text }),
      logger: {
        warn: (...args: unknown[]) => {
          warnings.push(args.map(String).join(' '))
        },
      },
    })
    await service.start('草稿')
    await tick()
    llm.last().text(REPLY)
    llm.last().finish()
    await tick(DELTA_FLUSH_MS)
    expect(service.state()!.rounds[0]!.status).toBe('done')
    expect(warnings.length).toBeGreaterThan(0)
    expect(warnings.join('\n')).not.toContain('草稿')
    service.dispose()
  })
})
