import { describe, expect, it, vi } from 'vitest'
import { PromptxError } from '../../src/shared/errors.ts'
import type { E2eCommand, E2eResult } from '../../src/shared/protocol.ts'
import type { ConfigUpdateResult, PanelStatus } from '../../src/shared/types.ts'
import { isE2eEnabled, registerRoutes, ROUTE_PATHS } from '../../src/web/routes.ts'
import type { ClientStateReport, FetchRoute, RouteDeps, RuntimeRemoveResult } from '../../src/web/routes.ts'
import { NAVIGATE_TTL_MS, StatusStore } from '../../src/web/status-store.ts'
import { manualClock, statusPieces, trapUnexpectedErrors } from './fixtures.ts'

trapUnexpectedErrors()

// ───────────────────────────── 模拟的 connection 与依赖 ─────────────────────────────

function fakeConnection() {
  const routes = new Map<string, FetchRoute>()
  const disposed: string[] = []
  const connection = {
    fetch: {
      register(route: FetchRoute): () => Promise<void> {
        // 和 dsh-client-connection 一样：同一路径不能注册两次。
        if (routes.has(route.path)) throw new Error(`connection: exact Fetch route ${route.path} is already registered`)
        routes.set(route.path, route)
        return () => {
          routes.delete(route.path)
          disposed.push(route.path)
          return Promise.resolve()
        }
      },
    },
  }
  return { connection, routes, disposed }
}

interface Calls {
  updateConfig: unknown[]
  restart: number
  show: number
  download: number
  remove: number
  reports: ClientStateReport[]
  e2e: E2eCommand[]
}

function setup(overrides: Partial<RouteDeps> = {}, options: { e2e?: boolean; pollTimeoutMs?: number } = {}) {
  const time = manualClock(50_000_000)
  const store = new StatusStore(statusPieces(), { now: time.now })
  const calls: Calls = { updateConfig: [], restart: 0, show: 0, download: 0, remove: 0, reports: [], e2e: [] }
  const removeResult: RuntimeRemoveResult = { removed: ['44.10.2-darwin-arm64'], inUseBy: [{ profile: 'work', version: '44.10.1' }] }
  const e2e = (command: E2eCommand) => {
    calls.e2e.push(command)
    return Promise.resolve<E2eResult>({ ok: true, data: { action: command.action } })
  }
  const deps: RouteDeps = {
    store,
    updateConfig: (patch) => {
      calls.updateConfig.push(patch)
      return Promise.resolve<ConfigUpdateResult>({ ok: true })
    },
    companion: {
      restart: () => {
        calls.restart += 1
        return Promise.resolve()
      },
      show: () => {
        calls.show += 1
      },
    },
    runtime: {
      download: () => {
        calls.download += 1
      },
      remove: () => {
        calls.remove += 1
        return Promise.resolve(removeResult)
      },
    },
    reportClientState: (state) => {
      calls.reports.push(state)
    },
    pollTimeoutMs: options.pollTimeoutMs ?? 60_000,
    ...(options.e2e === true ? { e2e } : {}),
    ...overrides,
  }
  const { connection, routes, disposed } = fakeConnection()
  const disposers = registerRoutes(connection, deps)
  return { time, store, calls, deps, routes, disposed, disposers }
}

interface Reply {
  status: number
  body: Record<string, unknown>
  headers: Headers
}

async function call(
  routes: Map<string, FetchRoute>,
  path: string,
  init: { method?: 'GET' | 'POST'; body?: unknown; raw?: string; query?: string; signal?: AbortSignal } = {},
): Promise<Reply> {
  const route = routes.get(path)
  if (route === undefined) throw new Error(`route ${path} not registered`)
  const method = init.method ?? (init.body === undefined && init.raw === undefined ? 'GET' : 'POST')
  const request = new Request(`http://dsh.internal${path}${init.query ?? ''}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(init.raw !== undefined ? { body: init.raw } : init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    ...(init.signal !== undefined ? { signal: init.signal } : {}),
  })
  const response = await route.fetch(request)
  return { status: response.status, body: await response.json() as Record<string, unknown>, headers: response.headers }
}

/** 配置页的切页规则（design-spec 4.4）。 */
function shouldNavigate(status: PanelStatus, handled: number): boolean {
  return status.navigate !== null && status.navigate.seq > handled && status.navigate.ageMs < NAVIGATE_TTL_MS
}

// ───────────────────────────── 注册 ─────────────────────────────

describe('registerRoutes', () => {
  it('registers the exact /api/dsh-promptx routes from design-spec 4.3 with buffered bodies', () => {
    const { routes, disposers } = setup()
    expect([...routes.keys()].sort()).toEqual([
      '/api/dsh-promptx/client-state',
      '/api/dsh-promptx/companion',
      '/api/dsh-promptx/config',
      '/api/dsh-promptx/runtime',
      '/api/dsh-promptx/status',
    ])
    expect(routes.get(ROUTE_PATHS.status)!.methods).toEqual(['GET'])
    for (const path of [ROUTE_PATHS.config, ROUTE_PATHS.companion, ROUTE_PATHS.runtime, ROUTE_PATHS.clientState]) {
      expect(routes.get(path)!.methods).toEqual(['POST'])
    }
    for (const route of routes.values()) expect(route.requestBody).toBe('buffered')
    expect(disposers).toHaveLength(5)
  })

  it('returns disposers that remove each route', async () => {
    const { routes, disposed, disposers } = setup()
    await Promise.all(disposers.map(dispose => dispose()))
    expect(routes.size).toBe(0)
    expect(disposed.sort()).toEqual([...Object.values(ROUTE_PATHS)].filter(path => path !== ROUTE_PATHS.e2e).sort())
  })

  it('removes the routes it already registered when a later registration fails', async () => {
    const { connection, routes, disposed } = fakeConnection()
    connection.fetch.register({ path: ROUTE_PATHS.runtime, methods: ['POST'], requestBody: 'buffered', fetch: () => Promise.resolve(new Response()) })
    const store = new StatusStore(statusPieces())
    const deps = setup().deps
    expect(() => registerRoutes(connection, { ...deps, store })).toThrow(/already registered/)
    await new Promise(resolve => setImmediate(resolve))
    expect(disposed.sort()).toEqual([ROUTE_PATHS.companion, ROUTE_PATHS.config, ROUTE_PATHS.status].sort())
    expect([...routes.keys()]).toEqual([ROUTE_PATHS.runtime])
  })
})

// ───────────────────────────── 端到端开关（审查 S10） ─────────────────────────────

describe('e2e route gate (review S10, D17)', () => {
  it('only opens with DSH_PROMPTX_E2E=1, never with PROMPTX_* values a project .env could set', () => {
    expect(isE2eEnabled({})).toBe(false)
    expect(isE2eEnabled({ PROMPTX_E2E: '1' })).toBe(false)
    expect(isE2eEnabled({ PROMPTX_MODE: 'e2e', PROMPTX_E2E: 'true' })).toBe(false)
    expect(isE2eEnabled({ DSH_PROMPTX_E2E: 'true' })).toBe(false)
    expect(isE2eEnabled({ DSH_PROMPTX_E2E: '0' })).toBe(false)
    expect(isE2eEnabled({ DSH_PROMPTX_E2E: '1' })).toBe(true)
  })

  it('registers nothing for /e2e unless the e2e handler is provided', () => {
    const plain = setup()
    expect(plain.routes.has(ROUTE_PATHS.e2e)).toBe(false)
    // index.ts 只在开关打开时提供 e2e 处理函数；PROMPTX_E2E=1 不算，所以不注册。
    const fromProjectEnv = setup({}, { e2e: isE2eEnabled({ PROMPTX_E2E: '1' }) })
    expect(fromProjectEnv.routes.has(ROUTE_PATHS.e2e)).toBe(false)
    const enabled = setup({}, { e2e: isE2eEnabled({ DSH_PROMPTX_E2E: '1' }) })
    expect(enabled.routes.get(ROUTE_PATHS.e2e)?.methods).toEqual(['POST'])
  })

  it('validates known e2e commands and passes the result through', async () => {
    const { routes, calls } = setup({}, { e2e: true })
    const ok = await call(routes, ROUTE_PATHS.e2e, { body: { command: { action: 'core-path', text: '# 标题\n\n- 一项\n' } } })
    expect(ok.status).toBe(200)
    expect(ok.body).toEqual({ ok: true, data: { action: 'core-path' } })
    expect(calls.e2e).toEqual([{ action: 'core-path', text: '# 标题\n\n- 一项\n' }])
    await expect(call(routes, ROUTE_PATHS.e2e, { body: { command: { action: 'save-to-library' } } })).resolves.toMatchObject({ status: 200 })
    await expect(call(routes, ROUTE_PATHS.e2e, { body: { command: { action: 'state' } } })).resolves.toMatchObject({ status: 200 })

    for (const body of [
      { command: { action: 'core-path' } },
      { command: { action: 'core-path', text: 1 } },
      { command: { action: 'state', extra: true } },
      { command: { action: 'Core Path' } },
      { command: 'core-path' },
      { command: { action: 'core-path', text: 'x' }, more: 1 },
      { command: { action: 'host-read', relPath: { nested: true } } },
    ]) {
      const reply = await call(routes, ROUTE_PATHS.e2e, { body })
      expect(reply.status, JSON.stringify(body)).toBe(400)
      expect(reply.body.ok).toBe(false)
    }
    expect(calls.e2e).toHaveLength(3)
  })

  it('passes other e2e actions with scalar fields through to the handler', async () => {
    // scripts/e2e-local.mjs 用到的 host-read、typing-latency 还不在 protocol.ts 的 E2eCommand 里。
    const { routes, calls } = setup({}, { e2e: true })
    await expect(call(routes, ROUTE_PATHS.e2e, { body: { command: { action: 'host-read', relPath: 'e2e-256k.md' } } })).resolves.toMatchObject({ status: 200 })
    await expect(call(routes, ROUTE_PATHS.e2e, { body: { command: { action: 'typing-latency', size: 100_000 } } })).resolves.toMatchObject({ status: 200 })
    expect(calls.e2e).toEqual([{ action: 'host-read', relPath: 'e2e-256k.md' }, { action: 'typing-latency', size: 100_000 }])
  })
})

// ───────────────────────────── 状态长轮询 ─────────────────────────────

describe('status route', () => {
  it('answers the first poll immediately with the full status and no-store caching', async () => {
    const { routes, store } = setup()
    const reply = await call(routes, ROUTE_PATHS.status)
    expect(reply.status).toBe(200)
    expect(reply.headers.get('cache-control')).toBe('no-store')
    expect(reply.body).toEqual(JSON.parse(JSON.stringify(store.snapshot())))
    // e2e 脚本用 since=-1 表示「立即返回」。
    await expect(call(routes, ROUTE_PATHS.status, { query: '?since=-1' })).resolves.toMatchObject({ status: 200, body: { seq: store.seq } })
    await expect(call(routes, ROUTE_PATHS.status, { query: '?since=' })).resolves.toMatchObject({ status: 200 })
  })

  it('rejects malformed since and clientId values with 400', async () => {
    const { routes } = setup()
    for (const query of ['?since=abc', '?since=1.5', '?since=99999999999999999', '?since=0x10', '?clientId=has%20space', `?clientId=${'a'.repeat(129)}`]) {
      const reply = await call(routes, ROUTE_PATHS.status, { query })
      expect(reply.status, query).toBe(400)
      expect(reply.body).toMatchObject({ ok: false, error: { code: 'promptx/internal' } })
    }
  })

  it('holds the poll until the status changes', async () => {
    const { routes, store } = setup()
    const since = store.seq
    let done = false
    const pending = call(routes, ROUTE_PATHS.status, { query: `?since=${since}` }).then((reply) => {
      done = true
      return reply
    })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(done).toBe(false)
    store.patch({ companion: { state: 'running' }, companionPid: 123 })
    const reply = await pending
    expect(reply.body).toMatchObject({ seq: since + 1, companion: { state: 'running' }, companionPid: 123 })
  })

  it('answers with the unchanged status after the poll timeout', async () => {
    const { routes, store } = setup({}, { pollTimeoutMs: 30 })
    const reply = await call(routes, ROUTE_PATHS.status, { query: `?since=${store.seq}` })
    expect(reply.status).toBe(200)
    expect(reply.body.seq).toBe(store.seq)
  })

  it('ends the wait and clears its timer when the page disconnects', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const { routes, store } = setup()
    const controller = new AbortController()
    const pending = call(routes, ROUTE_PATHS.status, { query: `?since=${store.seq}`, signal: controller.signal })
    await vi.waitFor(() => {
      expect(vi.getTimerCount()).toBe(1)
    })
    controller.abort()
    const reply = await pending
    expect(reply.status).toBe(200)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('lets a freshly loaded page navigate to a 59 s old request but not a 61 s old one, and only once (review TC-06)', async () => {
    const { routes, store, time } = setup()
    const requestedAt = time.now()
    const seq = store.requestNavigate()

    time.set(requestedAt + 59_000)
    const fresh = await call(routes, ROUTE_PATHS.status)
    const freshStatus = fresh.body as unknown as PanelStatus
    expect(freshStatus.navigate).toEqual({ seq, ageMs: 59_000 })
    expect(shouldNavigate(freshStatus, 0)).toBe(true)

    // 同一个页面记下处理过的序号，下一次轮询不再切。
    const again = await call(routes, ROUTE_PATHS.status, { query: `?since=${freshStatus.seq - 1}` })
    expect(shouldNavigate(again.body as unknown as PanelStatus, seq)).toBe(false)

    time.set(requestedAt + 61_000)
    const late = await call(routes, ROUTE_PATHS.status)
    const lateStatus = late.body as unknown as PanelStatus
    expect(lateStatus.navigate).toEqual({ seq, ageMs: 61_000 })
    expect(shouldNavigate(lateStatus, 0)).toBe(false)
  })

  it('shows a targeted navigate request only to the most recently visible page', async () => {
    const { routes, store, time } = setup()
    await call(routes, ROUTE_PATHS.clientState, { body: { clientId: 'page-a', locale: 'zh-CN', visible: true } })
    time.advance(1_000)
    await call(routes, ROUTE_PATHS.clientState, { body: { clientId: 'page-b', locale: 'zh-CN', visible: true } })
    const seq = store.requestNavigate()
    const a = await call(routes, ROUTE_PATHS.status, { query: '?clientId=page-a' })
    const b = await call(routes, ROUTE_PATHS.status, { query: '?clientId=page-b' })
    expect(a.body.navigate).toBeNull()
    expect(b.body.navigate).toEqual({ seq, ageMs: 0 })
  })

  it('turns an unexpected failure into a 500 JSON response instead of throwing', async () => {
    const store = new StatusStore(statusPieces())
    vi.spyOn(store, 'waitForChange').mockImplementation(() => Promise.reject(new Error('boom')))
    const warnings: unknown[][] = []
    const { routes } = setup({ store, logger: { warn: (...args: unknown[]) => warnings.push(args) } })
    const reply = await call(routes, ROUTE_PATHS.status)
    expect(reply.status).toBe(500)
    expect(reply.body).toEqual({ ok: false, error: { code: 'promptx/internal', detail: 'boom' } })
    expect(warnings).toHaveLength(1)
  })
})

// ───────────────────────────── 配置 ─────────────────────────────

describe('config route', () => {
  it('hands the patch to the config updater and returns its result', async () => {
    const { routes, calls } = setup()
    const reply = await call(routes, ROUTE_PATHS.config, { body: { patch: { hideOnBlur: true, globalShortcut: 'Control+Alt+Shift+F9' } } })
    expect(reply).toMatchObject({ status: 200, body: { ok: true } })
    expect(calls.updateConfig).toEqual([{ hideOnBlur: true, globalShortcut: 'Control+Alt+Shift+F9' }])
  })

  it('returns field errors from the updater with status 200', async () => {
    const result: ConfigUpdateResult = { ok: false, errors: { libraryDir: 'library-dir-skills' } }
    const { routes } = setup({ updateConfig: () => Promise.resolve(result) })
    const reply = await call(routes, ROUTE_PATHS.config, { body: { patch: { libraryDir: '~/.agents/skills' } } })
    expect(reply).toEqual(expect.objectContaining({ status: 200, body: result }))
  })

  it('rejects malformed bodies with 400 in the ConfigUpdateResult shape', async () => {
    const { routes, calls } = setup()
    const cases: Array<{ raw?: string; body?: unknown }> = [
      { raw: '{not json' },
      { raw: '' },
      { body: [] },
      { body: 'patch' },
      { body: {} },
      { body: { patch: null } },
      { body: { patch: ['libraryDir'] } },
      { body: { patch: {}, extra: true } },
    ]
    for (const init of cases) {
      const reply = await call(routes, ROUTE_PATHS.config, { method: 'POST', ...init })
      expect(reply.status, JSON.stringify(init)).toBe(400)
      expect(reply.body).toMatchObject({ ok: false, errors: {}, error: { code: 'promptx/internal' } })
    }
    expect(calls.updateConfig).toEqual([])
  })

  it('rejects oversized bodies', async () => {
    const { routes, calls } = setup()
    const reply = await call(routes, ROUTE_PATHS.config, { body: { patch: { optimizeInstruction: 'x'.repeat(1_100_000) } } })
    expect(reply.status).toBe(400)
    expect(calls.updateConfig).toEqual([])
  })

  it('answers 500 with the ConfigUpdateResult shape when the updater throws', async () => {
    const { routes } = setup({ updateConfig: () => Promise.reject(new Error('settings gone')) })
    const reply = await call(routes, ROUTE_PATHS.config, { body: { patch: { hideOnBlur: true } } })
    expect(reply.status).toBe(500)
    expect(reply.body).toEqual({ ok: false, errors: {}, error: { code: 'promptx/internal', detail: 'settings gone' } })
  })
})

// ───────────────────────────── 动作 ─────────────────────────────

describe('companion and runtime routes', () => {
  it('runs the companion actions', async () => {
    const { routes, calls } = setup()
    await expect(call(routes, ROUTE_PATHS.companion, { body: { action: 'restart' } })).resolves.toMatchObject({ status: 200, body: { ok: true } })
    await expect(call(routes, ROUTE_PATHS.companion, { body: { action: 'show' } })).resolves.toMatchObject({ status: 200, body: { ok: true } })
    expect(calls).toMatchObject({ restart: 1, show: 1 })
  })

  it('runs the runtime actions and reports versions another profile still uses', async () => {
    const { routes, calls } = setup()
    await expect(call(routes, ROUTE_PATHS.runtime, { body: { action: 'download' } })).resolves.toMatchObject({ status: 200, body: { ok: true } })
    const removed = await call(routes, ROUTE_PATHS.runtime, { body: { action: 'delete' } })
    expect(removed).toMatchObject({
      status: 200,
      body: { ok: true, removed: ['44.10.2-darwin-arm64'], inUseBy: [{ profile: 'work', version: '44.10.1' }] },
    })
    expect(calls).toMatchObject({ download: 1, remove: 1 })
  })

  it('rejects unknown actions and extra fields with 400', async () => {
    const { routes, calls } = setup()
    for (const [path, body] of [
      [ROUTE_PATHS.companion, { action: 'quit' }],
      [ROUTE_PATHS.companion, {}],
      [ROUTE_PATHS.companion, { action: 'show', force: true }],
      [ROUTE_PATHS.runtime, { action: 'remove' }],
      [ROUTE_PATHS.runtime, { action: ['download'] }],
    ] as const) {
      const reply = await call(routes, path, { body })
      expect(reply.status, JSON.stringify(body)).toBe(400)
      expect(reply.body.ok).toBe(false)
    }
    expect(calls).toMatchObject({ restart: 0, show: 0, download: 0, remove: 0 })
  })

  it('answers a business failure with 409 and its error code, anything else with 500', async () => {
    const { routes } = setup({
      companion: {
        restart: () => Promise.reject(new PromptxError('promptx/runtime/download-failed', 'ECONNRESET')),
        show: () => {
          throw new Error('peer closed')
        },
      },
    })
    const business = await call(routes, ROUTE_PATHS.companion, { body: { action: 'restart' } })
    expect(business).toMatchObject({ status: 409, body: { ok: false, error: { code: 'promptx/runtime/download-failed', detail: 'ECONNRESET' } } })
    const internal = await call(routes, ROUTE_PATHS.companion, { body: { action: 'show' } })
    expect(internal).toMatchObject({ status: 500, body: { ok: false, error: { code: 'promptx/internal', detail: 'peer closed' } } })
  })
})

// ───────────────────────────── 页面状态 ─────────────────────────────

describe('client-state route', () => {
  it('records the page and reports its effective language', async () => {
    const { routes, calls, store } = setup()
    const reply = await call(routes, ROUTE_PATHS.clientState, { body: { clientId: 'page-1', locale: 'zh-CN', visible: true } })
    expect(reply).toMatchObject({ status: 200, body: { ok: true } })
    expect(calls.reports).toEqual([{ clientId: 'page-1', locale: 'zh-CN', visible: true }])
    expect(store.hasVisibleClient(1_000)).toBe(true)
    await call(routes, ROUTE_PATHS.clientState, { body: { clientId: 'page-1', locale: 'en', visible: false } })
    expect(store.hasVisibleClient(1_000)).toBe(false)
    expect(store.hasAnyClient(1_000)).toBe(true)
  })

  it('rejects incomplete or malformed reports', async () => {
    const { routes, calls } = setup()
    for (const body of [
      { locale: 'zh-CN', visible: true },
      { clientId: 'page-1', visible: true },
      { clientId: 'page-1', locale: 'zh-CN' },
      { clientId: 'page-1', locale: 'zh-CN', visible: 'yes' },
      { clientId: 'page 1', locale: 'zh-CN', visible: true },
      { clientId: 'page-1', locale: '中文', visible: true },
      { clientId: 'page-1', locale: '', visible: true },
      { clientId: 'page-1', locale: 'zh-CN', visible: true, theme: 'dark' },
    ]) {
      const reply = await call(routes, ROUTE_PATHS.clientState, { body })
      expect(reply.status, JSON.stringify(body)).toBe(400)
    }
    expect(calls.reports).toEqual([])
  })

  it('accepts common language tag spellings', async () => {
    const { routes, calls } = setup()
    for (const locale of ['zh', 'zh-Hans-CN', 'en-US', 'en_US', 'fr']) {
      await expect(call(routes, ROUTE_PATHS.clientState, { body: { clientId: 'p', locale, visible: true } })).resolves.toMatchObject({ status: 200 })
    }
    expect(calls.reports.map(report => report.locale)).toEqual(['zh', 'zh-Hans-CN', 'en-US', 'en_US', 'fr'])
  })
})
