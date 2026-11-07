import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  API_BASE,
  createApi,
  createClientId,
  createClientStateReporter,
  createNavigationHandler,
  createStatusLoop,
  NAVIGATE_MAX_AGE_MS,
  parseConfigUpdateResult,
  parsePanelStatus,
  POLL_GUARD_MS,
  type ActionResult,
  type ClientStateReport,
  type FetchLike,
  type PromptxApi,
  type StatusSnapshot,
} from '../../src/client/api.ts'
import { PromptxError } from '../../src/shared/errors.ts'
import type { PanelStatus } from '../../src/shared/types.ts'
import { deferred, installRejectionTraps, jsonResponse, makeStatus, type Deferred } from './fixtures.ts'

installRejectionTraps()

afterEach(() => {
  vi.useRealTimers()
})

interface FetchCall {
  input: string
  init: RequestInit
}

function fakeFetch(respond: (call: FetchCall) => Promise<Response>): { fetch: FetchLike; calls: FetchCall[] } {
  const calls: FetchCall[] = []
  return {
    calls,
    fetch: (input, init) => {
      const call = { input, init }
      calls.push(call)
      return respond(call)
    },
  }
}

function bodyOf(call: FetchCall | undefined): unknown {
  const body = call?.init.body
  expect(typeof body).toBe('string')
  return JSON.parse(body as string)
}

describe('createApi：请求的地址和格式', () => {
  it('用相对路径 api/dsh-promptx/…，兼容 --public-url', () => {
    expect(API_BASE).toBe('api/dsh-promptx/')
  })

  it('第一次长轮询不带 since，之后带上序号和页面 id', async () => {
    const { fetch, calls } = fakeFetch(() => Promise.resolve(jsonResponse(makeStatus({ seq: 7 }))))
    const api = createApi(fetch)
    const signal = new AbortController().signal
    await expect(api.status({ since: null, clientId: 'abc' }, signal)).resolves.toEqual(makeStatus({ seq: 7 }))
    await api.status({ since: 7, clientId: 'abc' }, signal)
    expect(calls.map(call => call.input)).toEqual([
      'api/dsh-promptx/status?clientId=abc',
      'api/dsh-promptx/status?since=7&clientId=abc',
    ])
    expect(calls[0]?.init.method).toBe('GET')
    expect(calls[0]?.init.signal).toBe(signal)
  })

  it('长轮询的 HTTP 错误、不是 JSON、形状不对都抛 PromptxError', async () => {
    const signal = new AbortController().signal
    const responses = [
      new Response('nope', { status: 503 }),
      new Response('not json', { status: 200 }),
      jsonResponse({ seq: 1 }),
    ]
    const { fetch } = fakeFetch(() => Promise.resolve(responses.shift()!))
    const api = createApi(fetch)
    for (const detail of ['HTTP 503', 'malformed status', 'malformed status']) {
      const error: unknown = await api.status({ since: null, clientId: 'x' }, signal).then(() => null, (e: unknown) => e)
      expect(error).toBeInstanceOf(PromptxError)
      expect((error as PromptxError).toInfo()).toEqual({ code: 'promptx/internal', detail })
    }
  })

  it('保存配置：POST { patch } 的 JSON', async () => {
    const { fetch, calls } = fakeFetch(() => Promise.resolve(jsonResponse({ ok: true })))
    const result = await createApi(fetch).saveConfig({ libraryDir: '/x', hideOnBlur: true })
    expect(result).toEqual({ ok: true })
    expect(calls[0]?.input).toBe('api/dsh-promptx/config')
    expect(calls[0]?.init.method).toBe('POST')
    expect(calls[0]?.init.headers).toMatchObject({ 'content-type': 'application/json' })
    expect(bodyOf(calls[0])).toEqual({ patch: { libraryDir: '/x', hideOnBlur: true } })
  })

  it('保存配置：字段错误原样带回，不认识的字段和错误码丢掉', async () => {
    const { fetch } = fakeFetch(() => Promise.resolve(jsonResponse({
      ok: false,
      errors: { libraryDir: 'library-dir-reserved', globalShortcut: 'nonsense', bogus: 'value-invalid' },
    }, 400)))
    expect(await createApi(fetch).saveConfig({ libraryDir: '/x' })).toEqual({ ok: false, errors: { libraryDir: 'library-dir-reserved' } })
  })

  it('保存配置：连不上、回复不是 JSON 时不抛异常，以失败结果返回', async () => {
    const offline = fakeFetch(() => Promise.reject(new TypeError('Failed to fetch')))
    expect(await createApi(offline.fetch).saveConfig({ hideOnBlur: true })).toEqual({
      ok: false, errors: {}, error: { code: 'promptx/channel/closed', detail: 'Failed to fetch' },
    })
    const broken = fakeFetch(() => Promise.resolve(new Response('<html>', { status: 502 })))
    expect(await createApi(broken.fetch).saveConfig({ hideOnBlur: true })).toEqual({
      ok: false, errors: {}, error: { code: 'promptx/internal', detail: 'HTTP 502' },
    })
    const unavailable = fakeFetch(() => Promise.resolve(jsonResponse({ ok: false, errors: {}, error: { code: 'promptx/settings/unavailable' } }, 503)))
    expect(await createApi(unavailable.fetch).saveConfig({ hideOnBlur: true })).toEqual({
      ok: false, errors: {}, error: { code: 'promptx/settings/unavailable' },
    })
  })

  it('动作：重启、显示小窗，下载、删除运行时，上报页面状态', async () => {
    const replies: unknown[] = [{ ok: true }, { ok: true }, { ok: true }, { ok: true, inUseBy: [{ profile: 'work', version: '44.9.0' }] }, { ok: true }]
    const { fetch, calls } = fakeFetch(() => Promise.resolve(jsonResponse(replies.shift())))
    const api = createApi(fetch)
    expect(await api.companion('restart')).toEqual({ ok: true })
    expect(await api.companion('show')).toEqual({ ok: true })
    expect(await api.runtime('download')).toEqual({ ok: true })
    expect(await api.runtime('delete')).toEqual({ ok: true, inUseBy: [{ profile: 'work', version: '44.9.0' }] })
    const report: ClientStateReport = { clientId: 'c1', locale: 'zh-CN', visible: true }
    expect(await api.clientState(report)).toEqual({ ok: true })
    expect(calls.map(call => call.input)).toEqual([
      'api/dsh-promptx/companion', 'api/dsh-promptx/companion', 'api/dsh-promptx/runtime', 'api/dsh-promptx/runtime', 'api/dsh-promptx/client-state',
    ])
    expect(calls.map(bodyOf)).toEqual([
      { action: 'restart' }, { action: 'show' }, { action: 'download' }, { action: 'delete' }, report,
    ])
  })

  it('动作失败：带回 Host 的错误；没有错误时按 HTTP 状态码归类；连不上算连接断开', async () => {
    const replies = [
      jsonResponse({ ok: false, error: { code: 'promptx/runtime/in-use', detail: 'work' } }, 409),
      jsonResponse({ ok: false }, 500),
      new Response('', { status: 404 }),
      jsonResponse({ ok: false }),
    ]
    const { fetch } = fakeFetch(() => Promise.resolve(replies.shift()!))
    const api = createApi(fetch)
    expect(await api.runtime('delete')).toEqual({ ok: false, error: { code: 'promptx/runtime/in-use', detail: 'work' } })
    expect(await api.companion('restart')).toEqual({ ok: false, error: { code: 'promptx/internal', detail: 'HTTP 500' } })
    expect(await api.companion('show')).toEqual({ ok: false, error: { code: 'promptx/internal', detail: 'HTTP 404' } })
    expect(await api.runtime('download')).toEqual({ ok: false, error: { code: 'promptx/internal' } })
    const offline = fakeFetch(() => Promise.reject(new Error('offline')))
    expect(await createApi(offline.fetch).runtime('download')).toEqual({ ok: false, error: { code: 'promptx/channel/closed', detail: 'offline' } })
  })

  it('默认用页面的 fetch，并且不脱离 window 调用', async () => {
    const original = globalThis.fetch
    const spy = vi.fn<typeof fetch>(() => Promise.resolve(jsonResponse({ ok: true })))
    vi.stubGlobal('fetch', spy)
    try {
      expect(await createApi().companion('show')).toEqual({ ok: true })
      expect(spy).toHaveBeenCalledTimes(1)
    } finally {
      vi.stubGlobal('fetch', original)
      vi.unstubAllGlobals()
    }
  })
})

describe('parsePanelStatus：长轮询回复的形状检查', () => {
  it('合法的状态原样通过', () => {
    const status = makeStatus({
      navigate: { seq: 3, ageMs: 1200 },
      shortcut: { accelerator: 'Control+P', registered: false, error: { code: 'promptx/shortcut/taken' } },
      runtime: {
        state: 'downloading', version: '44.10.2', dir: '/r', received: 10, total: 20, source: 'mirror', paused: false,
        inUseBy: [{ profile: 'work', version: '44.9.0' }], error: { code: 'promptx/runtime/locked' },
      },
      companion: { state: 'failed', error: { code: 'promptx/companion/exited' }, restartsExhausted: true },
    })
    expect(parsePanelStatus(JSON.parse(JSON.stringify(status)))).toEqual(status)
  })

  it('核心字段不对时整份拒绝', () => {
    const good = makeStatus()
    const broken: unknown[] = [
      null,
      [],
      { ...good, seq: '1' },
      { ...good, config: { ...good.config, hideOnBlur: 'yes' } },
      { ...good, config: { ...good.config, runtimeSource: 'ftp' } },
      { ...good, runtime: { ...good.runtime, state: 'sleeping' } },
      { ...good, companion: { state: 'zombie' } },
      { ...good, instance: 'other' },
    ]
    for (const value of broken) expect(parsePanelStatus(value)).toBeNull()
  })

  it('次要字段缺了用空值', () => {
    const { effectiveLibraryDir: _a, defaultShortcut: _b, defaultInstruction: _c, platform: _d, companionPid: _e, ...core } = makeStatus()
    const parsed = parsePanelStatus({ ...core, shortcut: { accelerator: 1 }, navigate: { seq: 'x' } })
    expect(parsed).toMatchObject({
      effectiveLibraryDir: '', defaultShortcut: '', defaultInstruction: { zh: '', en: '' }, platform: '', shortcut: null, navigate: null,
    })
    expect(parsed).not.toHaveProperty('companionPid')
  })

  it('保存结果的形状检查', () => {
    expect(parseConfigUpdateResult({ ok: true, extra: 1 })).toEqual({ ok: true })
    expect(parseConfigUpdateResult({ ok: false })).toEqual({ ok: false, errors: {} })
    expect(parseConfigUpdateResult({ ok: false, errors: [], error: { code: 'promptx/internal', detail: 'x' } }))
      .toEqual({ ok: false, errors: {}, error: { code: 'promptx/internal', detail: 'x' } })
    expect(parseConfigUpdateResult({ ok: 'yes' })).toBeNull()
    expect(parseConfigUpdateResult('ok')).toBeNull()
  })
})

interface StatusCall {
  since: number | null
  clientId: string
  signal: AbortSignal
  reply: Deferred<PanelStatus>
}

/** 一个可以逐个回复的长轮询接口；请求被中止时以 AbortError 结束，和浏览器的 fetch 一样。 */
function fakeStatusApi(): { api: Pick<PromptxApi, 'status'>; calls: StatusCall[] } {
  const calls: StatusCall[] = []
  return {
    calls,
    api: {
      status: ({ since, clientId }, signal) => {
        const reply = deferred<PanelStatus>()
        signal.addEventListener('abort', () => {
          reply.reject(new DOMException('The operation was aborted.', 'AbortError'))
        })
        calls.push({ since, clientId, signal, reply })
        return reply.promise
      },
    },
  }
}

describe('createStatusLoop：长轮询循环', () => {
  it('第一次不带序号，之后每次带上上一次的序号；拿到的状态推给订阅者', async () => {
    vi.useFakeTimers()
    const { api, calls } = fakeStatusApi()
    const seen: PanelStatus[] = []
    const loop = createStatusLoop({ api, clientId: 'page-1', onStatus: status => seen.push(status) })
    const snapshots: StatusSnapshot[] = []
    const unsubscribe = loop.subscribe(() => snapshots.push(loop.getSnapshot()))
    expect(loop.getSnapshot()).toEqual({ status: null, error: null })
    loop.start()
    loop.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ since: null, clientId: 'page-1' })

    calls[0]!.reply.resolve(makeStatus({ seq: 4 }))
    await vi.advanceTimersByTimeAsync(0)
    expect(loop.getSnapshot()).toEqual({ status: makeStatus({ seq: 4 }), error: null })
    expect(seen.map(status => status.seq)).toEqual([4])
    expect(calls).toHaveLength(2)
    expect(calls[1]?.since).toBe(4)

    unsubscribe()
    calls[1]!.reply.resolve(makeStatus({ seq: 9 }))
    await vi.advanceTimersByTimeAsync(0)
    expect(snapshots).toHaveLength(1)
    expect(calls[2]?.since).toBe(9)
    loop.dispose()
  })

  it('出错后先等 1 秒，再出错等 5 秒；成功一次后重新计数', async () => {
    vi.useFakeTimers()
    const { api, calls } = fakeStatusApi()
    const loop = createStatusLoop({ api, clientId: 'p' })
    loop.start()
    await vi.advanceTimersByTimeAsync(0)

    calls[0]!.reply.reject(new TypeError('Failed to fetch'))
    await vi.advanceTimersByTimeAsync(0)
    expect(loop.getSnapshot()).toEqual({ status: null, error: { code: 'promptx/channel/closed', detail: 'Failed to fetch' } })
    await vi.advanceTimersByTimeAsync(999)
    expect(calls).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(calls).toHaveLength(2)
    expect(calls[1]?.since).toBeNull()

    calls[1]!.reply.reject(new PromptxError('promptx/internal', 'HTTP 502'))
    await vi.advanceTimersByTimeAsync(4_999)
    expect(calls).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(calls).toHaveLength(3)

    calls[2]!.reply.resolve(makeStatus({ seq: 2 }))
    await vi.advanceTimersByTimeAsync(0)
    expect(loop.getSnapshot()).toEqual({ status: makeStatus({ seq: 2 }), error: null })

    // 有过状态之后再出错：保留旧状态，同时给出错误；等待重新从 1 秒算起。
    calls[3]!.reply.reject(new TypeError('Failed to fetch'))
    await vi.advanceTimersByTimeAsync(0)
    expect(loop.getSnapshot().status).toEqual(makeStatus({ seq: 2 }))
    expect(loop.getSnapshot().error?.code).toBe('promptx/channel/closed')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(calls).toHaveLength(5)
    expect(calls[4]?.since).toBe(2)
    loop.dispose()
  })

  it('一次轮询 40 秒还没回复就断开重连，记为超时', async () => {
    vi.useFakeTimers()
    const { api, calls } = fakeStatusApi()
    const loop = createStatusLoop({ api, clientId: 'p' })
    loop.start()
    await vi.advanceTimersByTimeAsync(POLL_GUARD_MS - 1)
    expect(calls[0]?.signal.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(calls[0]?.signal.aborted).toBe(true)
    expect(loop.getSnapshot().error).toEqual({ code: 'promptx/channel/timeout' })
    await vi.advanceTimersByTimeAsync(1_000)
    expect(calls).toHaveLength(2)
    loop.dispose()
  })

  it('dispose 中止在途的请求，之后不再发请求，也不留计时器', async () => {
    vi.useFakeTimers()
    const { api, calls } = fakeStatusApi()
    const loop = createStatusLoop({ api, clientId: 'p' })
    loop.start()
    await vi.advanceTimersByTimeAsync(0)
    loop.dispose()
    expect(calls[0]?.signal.aborted).toBe(true)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(calls).toHaveLength(1)
    expect(vi.getTimerCount()).toBe(0)
    expect(loop.getSnapshot()).toEqual({ status: null, error: null })
    loop.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(calls).toHaveLength(1)
  })

  it('等待重试期间 dispose：等待立即结束，不留计时器', async () => {
    vi.useFakeTimers()
    const { api, calls } = fakeStatusApi()
    const loop = createStatusLoop({ api, clientId: 'p' })
    loop.start()
    await vi.advanceTimersByTimeAsync(0)
    calls[0]!.reply.reject(new TypeError('Failed to fetch'))
    await vi.advanceTimersByTimeAsync(0)
    expect(vi.getTimerCount()).toBe(1)
    loop.dispose()
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(calls).toHaveLength(1)
  })

  it('序号没变却马上回来的轮询（Host 没挂起）：下一次至少隔 1 秒，不会把页面拖进死循环', async () => {
    vi.useFakeTimers()
    const { api, calls } = fakeStatusApi()
    const loop = createStatusLoop({ api, clientId: 'p' })
    loop.start()
    await vi.advanceTimersByTimeAsync(0)
    calls[0]!.reply.resolve(makeStatus({ seq: 4 }))
    await vi.advanceTimersByTimeAsync(0)
    // 序号变了（第一次）：立即发下一次。
    expect(calls).toHaveLength(2)
    calls[1]!.reply.resolve(makeStatus({ seq: 4 }))
    await vi.advanceTimersByTimeAsync(999)
    expect(calls).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(calls).toHaveLength(3)
    // 正常的超时回复（挂了 25 秒、序号没变）：立即重新挂上。
    await vi.advanceTimersByTimeAsync(25_000)
    calls[2]!.reply.resolve(makeStatus({ seq: 4 }))
    await vi.advanceTimersByTimeAsync(0)
    expect(calls).toHaveLength(4)
    loop.dispose()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('onStatus 抛出的异常不影响轮询', async () => {
    vi.useFakeTimers()
    const { api, calls } = fakeStatusApi()
    const loop = createStatusLoop({
      api,
      clientId: 'p',
      onStatus: () => {
        throw new Error('navigation broke')
      },
    })
    loop.start()
    await vi.advanceTimersByTimeAsync(0)
    calls[0]!.reply.resolve(makeStatus({ seq: 3 }))
    await vi.advanceTimersByTimeAsync(0)
    expect(loop.getSnapshot()).toEqual({ status: makeStatus({ seq: 3 }), error: null })
    expect(calls).toHaveLength(2)
    loop.dispose()
  })
})

describe('createNavigationHandler：打开配置页的规则', () => {
  const at = (seq: number, navigate: PanelStatus['navigate']): PanelStatus => makeStatus({ seq, navigate })
  const opener = () => vi.fn<() => boolean>(() => true)

  it('新页面第一次轮询拿到 59 秒前的请求就切页（testing-plan api.spec）', () => {
    const open = opener()
    createNavigationHandler(open).handle(at(1_700_000_000_500, { seq: 1_700_000_000_000, ageMs: 59_000 }))
    expect(open).toHaveBeenCalledTimes(1)
  })

  it('新页面第一次轮询拿到 61 秒前的请求不切', () => {
    const open = opener()
    createNavigationHandler(open).handle(at(1_700_000_000_500, { seq: 1_700_000_000_000, ageMs: 61_000 }))
    expect(open).not.toHaveBeenCalled()
  })

  it('第一次轮询拿到 60 秒内的请求就切页；同一个请求只切一次', () => {
    const open = opener()
    const handler = createNavigationHandler(open)
    handler.handle(at(10, { seq: 1, ageMs: 59_999 }))
    expect(open).toHaveBeenCalledTimes(1)
    handler.handle(at(11, { seq: 1, ageMs: 200 }))
    handler.handle(at(12, { seq: 1, ageMs: 30_000 }))
    expect(open).toHaveBeenCalledTimes(1)
    handler.handle(at(13, { seq: 2, ageMs: 10 }))
    expect(open).toHaveBeenCalledTimes(2)
  })

  it('超过 60 秒的请求不切（新打开的页面不会被很久以前的请求带走）', () => {
    const open = opener()
    const handler = createNavigationHandler(open)
    handler.handle(at(1, { seq: 5, ageMs: NAVIGATE_MAX_AGE_MS }))
    handler.handle(at(2, { seq: 5, ageMs: 120_000 }))
    expect(open).not.toHaveBeenCalled()
    handler.handle(at(3, null))
    expect(open).not.toHaveBeenCalled()
  })

  it('序号比处理过的小时不切', () => {
    const open = opener()
    const handler = createNavigationHandler(open)
    handler.handle(at(5, { seq: 4, ageMs: 0 }))
    handler.handle(at(6, { seq: 3, ageMs: 0 }))
    expect(open).toHaveBeenCalledTimes(1)
  })

  it('状态序号变小（Host 重启时时钟被往回拨过）后，新 Host 的请求照样切页', () => {
    const open = opener()
    const handler = createNavigationHandler(open)
    handler.handle(at(80, { seq: 3, ageMs: 100 }))
    expect(open).toHaveBeenCalledTimes(1)
    handler.handle(at(2, null))
    handler.handle(at(3, { seq: 1, ageMs: 100 }))
    expect(open).toHaveBeenCalledTimes(2)
  })

  it('切页出错也记下这个请求，不反复重试', () => {
    const open = vi.fn<() => boolean>(() => {
      throw new Error('panel unavailable')
    })
    const handler = createNavigationHandler(open)
    expect(() => {
      handler.handle(at(1, { seq: 1, ageMs: 0 }))
    }).toThrow('panel unavailable')
    handler.handle(at(2, { seq: 1, ageMs: 0 }))
    expect(open).toHaveBeenCalledTimes(1)
  })

  it('导航服务出现时（retry）补切待切的请求；过期按收到时的 ageMs 加上本地经过的时间算', () => {
    let clock = 1_000_000
    let available = false
    const open = vi.fn<() => boolean>(() => available)
    const handler = createNavigationHandler(open, { now: () => clock })
    // 没有待切的请求时 retry 什么也不做。
    handler.retry()
    expect(open).not.toHaveBeenCalled()

    handler.handle(at(1, { seq: 3, ageMs: 2_000 }))
    expect(open).toHaveBeenCalledTimes(1)
    clock += 30_000
    available = true
    handler.retry()
    expect(open).toHaveBeenCalledTimes(2)
    // 切成了：同一个请求不再切。
    handler.retry()
    handler.handle(at(2, { seq: 3, ageMs: 33_000 }))
    expect(open).toHaveBeenCalledTimes(2)
  })

  it('待切的请求过期后，导航服务再出现也不切', () => {
    let clock = 0
    const open = vi.fn<() => boolean>(() => false)
    const handler = createNavigationHandler(open, { now: () => clock })
    handler.handle(at(1, { seq: 3, ageMs: 50_000 }))
    clock += 9_999
    handler.retry()
    expect(open).toHaveBeenCalledTimes(2)
    clock += 1
    open.mockImplementation(() => true)
    handler.retry()
    expect(open).toHaveBeenCalledTimes(2)
  })

  it('最新状态里已经没有这个页面该切的请求（Host 改成只切别的页面）：待切的作废', () => {
    const open = vi.fn<() => boolean>(() => false)
    const handler = createNavigationHandler(open)
    handler.handle(at(1, { seq: 3, ageMs: 0 }))
    handler.handle(at(2, null))
    open.mockImplementation(() => true)
    handler.retry()
    expect(open).toHaveBeenCalledTimes(1)
  })

  it('retry 时切页出错：记为处理过，异常照常抛出', () => {
    const open = vi.fn<() => boolean>(() => false)
    const handler = createNavigationHandler(open)
    handler.handle(at(1, { seq: 3, ageMs: 0 }))
    open.mockImplementation(() => {
      throw new Error('panel unavailable')
    })
    expect(() => {
      handler.retry()
    }).toThrow('panel unavailable')
    handler.retry()
    handler.handle(at(2, { seq: 3, ageMs: 100 }))
    expect(open).toHaveBeenCalledTimes(2)
  })

  it('导航服务暂时不在（open 返回 false）：不算处理过，60 秒内下一次拿到状态时再切', () => {
    let available = false
    const open = vi.fn<() => boolean>(() => available)
    const handler = createNavigationHandler(open)
    handler.handle(at(1, { seq: 7, ageMs: 1_000 }))
    expect(open).toHaveBeenCalledTimes(1)
    available = true
    handler.handle(at(2, { seq: 7, ageMs: 26_000 }))
    expect(open).toHaveBeenCalledTimes(2)
    // 这次切成了：之后同一个请求不再切。
    handler.handle(at(3, { seq: 7, ageMs: 40_000 }))
    expect(open).toHaveBeenCalledTimes(2)
    // 过了 60 秒还没切成的请求也不再切。
    const late = vi.fn<() => boolean>(() => false)
    const lateHandler = createNavigationHandler(late)
    lateHandler.handle(at(1, { seq: 9, ageMs: 50_000 }))
    lateHandler.handle(at(2, { seq: 9, ageMs: 75_000 }))
    expect(late).toHaveBeenCalledTimes(1)
  })

  it('接在长轮询循环上：页面刚打开的第一次轮询就切页', async () => {
    vi.useFakeTimers()
    const { api, calls } = fakeStatusApi()
    const open = opener()
    const handler = createNavigationHandler(open)
    const loop = createStatusLoop({ api, clientId: 'p', onStatus: handler.handle })
    loop.start()
    await vi.advanceTimersByTimeAsync(0)
    calls[0]!.reply.resolve(at(1, { seq: 1, ageMs: 2_000 }))
    await vi.advanceTimersByTimeAsync(0)
    expect(open).toHaveBeenCalledTimes(1)
    calls[1]!.reply.resolve(at(2, { seq: 1, ageMs: 27_000 }))
    await vi.advanceTimersByTimeAsync(0)
    expect(open).toHaveBeenCalledTimes(1)
    loop.dispose()
  })
})

describe('createClientStateReporter：页面状态上报', () => {
  interface Setup {
    reporter: ReturnType<typeof createClientStateReporter>
    replies: Array<Deferred<ActionResult>>
    sent: ClientStateReport[]
    state: ClientStateReport
  }

  function setup(): Setup {
    const replies: Array<Deferred<ActionResult>> = []
    const sent: ClientStateReport[] = []
    const state: ClientStateReport = { clientId: 'c1', locale: 'zh-CN', visible: true }
    const reporter = createClientStateReporter({
      api: {
        clientState: (report) => {
          sent.push(report)
          const reply = deferred<ActionResult>()
          replies.push(reply)
          return reply.promise
        },
      },
      read: () => ({ ...state }),
    })
    return { reporter, replies, sent, state }
  }

  it('发出的是发送时的最新状态', () => {
    const { reporter, sent, state } = setup()
    state.locale = 'en'
    reporter.report()
    expect(sent).toEqual([{ clientId: 'c1', locale: 'en', visible: true }])
  })

  it('在途期间的多次变化合并成一次，回来后按最新状态再发', async () => {
    const { reporter, replies, sent, state } = setup()
    reporter.report()
    state.visible = false
    reporter.report()
    state.locale = 'en'
    reporter.report()
    expect(sent).toHaveLength(1)
    replies[0]!.resolve({ ok: true })
    await Promise.resolve()
    await Promise.resolve()
    expect(sent).toEqual([
      { clientId: 'c1', locale: 'zh-CN', visible: true },
      { clientId: 'c1', locale: 'en', visible: false },
    ])
  })

  it('上报失败不抛异常，下一次变化照常发', async () => {
    const { reporter, replies, sent } = setup()
    reporter.report()
    replies[0]!.reject(new TypeError('Failed to fetch'))
    await Promise.resolve()
    await Promise.resolve()
    reporter.report()
    expect(sent).toHaveLength(2)
  })

  it('dispose 之后不再发，排队的也丢掉', async () => {
    const { reporter, replies, sent } = setup()
    reporter.report()
    reporter.report()
    reporter.dispose()
    replies[0]!.resolve({ ok: true })
    await Promise.resolve()
    await Promise.resolve()
    reporter.report()
    expect(sent).toHaveLength(1)
  })

  it('请求同步抛错也不会卡住后面的上报', () => {
    let calls = 0
    const reporter = createClientStateReporter({
      api: {
        clientState: () => {
          calls += 1
          if (calls === 1) throw new Error('boom')
          return Promise.resolve({ ok: true })
        },
      },
      read: () => ({ clientId: 'c', locale: 'en', visible: true }),
    })
    expect(() => {
      reporter.report()
    }).not.toThrow()
    reporter.report()
    expect(calls).toBe(2)
  })

  it('读取状态出错时这次不发，之后还能再发', () => {
    let fail = true
    const sent: ClientStateReport[] = []
    const reporter = createClientStateReporter({
      api: {
        clientState: (report) => {
          sent.push(report)
          return Promise.resolve({ ok: true })
        },
      },
      read: () => {
        if (fail) throw new Error('locale service gone')
        return { clientId: 'c', locale: 'en', visible: true }
      },
    })
    reporter.report()
    expect(sent).toHaveLength(0)
    fail = false
    reporter.report()
    expect(sent).toHaveLength(1)
  })
})

describe('createClientId', () => {
  it('16 个随机字节写成 32 位小写十六进制', () => {
    const id = createClientId((bytes) => {
      bytes.forEach((_, index) => {
        bytes[index] = index * 17
      })
    })
    expect(id).toBe('00112233445566778899aabbccddeeff')
  })

  it('默认用 crypto.getRandomValues（不用浏览器在非安全来源上不给的 randomUUID）', () => {
    const spy = vi.spyOn(crypto, 'getRandomValues')
    try {
      const a = createClientId()
      const b = createClientId()
      expect(a).toMatch(/^[0-9a-f]{32}$/)
      expect(a).not.toBe(b)
      expect(spy).toHaveBeenCalledTimes(2)
    } finally {
      spy.mockRestore()
    }
  })
})
