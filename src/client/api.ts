// Client 与 Host 之间的 HTTP 接口，以及每个打开的 dsh 页面常驻的长轮询循环（design-spec 4.3、4.4、4.8，D5、D13）。
//
// - 请求一律用相对路径 `api/dsh-promptx/...`：dsh 自己的 RPC 客户端也是相对页面地址发请求，dsh 用 `--public-url`
//   挂在路径前缀下时同样能用；桌面版 `dsh-app://` 页面会把这些请求转发给 Host。鉴权靠 dsh 的 cookie。
// - Host 往页面推送用长轮询：`GET status?since=<seq>`，状态有变化或 25 秒后返回。SSE 在桌面版的转发器上能不能保持长连接
//   没有验证过，所以不用。
// - 配置页和「打开配置页」的导航共用同一个循环，状态只有一份。
// - Host 的回复是跨进程边界来的数据，先检查形状再用。Host 和 Client 随同一个包发布，形状不对就按出错处理，不猜。

import { PromptxError, toErrorInfo } from '../shared/errors.ts'
import type {
  CompanionState,
  ConfigFieldError,
  ConfigUpdateResult,
  ErrorInfo,
  PanelStatus,
  PromptxConfig,
  RuntimeSource,
  RuntimeState,
  RuntimeStatus,
  ShortcutStatus,
} from '../shared/types.ts'

/** 本插件在 dsh Host 上的路由前缀，相对页面地址。 */
export const API_BASE = 'api/dsh-promptx/'

/** 「打开配置页」请求的有效期（design-spec 4.8：请求 60 秒内有效）。 */
export const NAVIGATE_MAX_AGE_MS = 60_000

/** 长轮询出错后的等待：第一次 1 秒，之后每次 5 秒；成功一次后重新计数。 */
export const POLL_BACKOFF_MS: readonly number[] = [1_000, 5_000]

/**
 * 单次长轮询的兜底超时。Host 最多挂 25 秒就回复；40 秒还没有回复，说明连接卡在中间某处（代理、电脑睡眠后唤醒），
 * 主动断开重连，不然页面上的状态会一直停在旧值。
 */
export const POLL_GUARD_MS = 40_000

/**
 * 序号没变却很快就回来的轮询，下一次至少隔这么久再发。正常的 Host 只在序号变化或 25 秒超时后回复；
 * 如果 Host 那边不挂起（例如没认出 since 参数、正在退出），不加这道限制页面会不停地发请求，拖慢 dsh。
 */
export const POLL_MIN_IDLE_MS = 1_000

/** 配置项的字段，顺序与 PromptxConfig 一致。 */
export const CONFIG_FIELDS = [
  'libraryDir', 'confirmDelete', 'optimizeInstruction', 'globalShortcut', 'hideOnBlur', 'runtimeSource',
] as const satisfies readonly (keyof PromptxConfig)[]

export type CompanionAction = 'restart' | 'show'
export type RuntimeAction = 'download' | 'delete'

/**
 * 动作类请求（`/companion`、`/runtime`、`/client-state`）的结果。design-spec 4.3 只写了 `{ ok }`；
 * 删除运行时时 Host 另外返回没有删除的版本（被其他 profile 的存活租约使用）。
 */
export interface ActionResult {
  ok: boolean
  error?: ErrorInfo
  inUseBy?: Array<{ profile: string; version: string }>
}

/** 页面上报给 Host 的状态（design-spec 4.7、4.8）：当前生效的界面语言和页面是否可见。 */
export interface ClientStateReport {
  /** 每个页面加载时随机生成，Host 用它区分页面，只切最近一个可见页面。 */
  clientId: string
  /** `ctx.locale.getLocale().active`：页面当前生效的界面语言（dsh 没有语言偏好时跟随浏览器，Host 自己看不到）。 */
  locale: string
  visible: boolean
}

export interface PromptxApi {
  /** 长轮询。`since` 为 null 时请 Host 立即回复（页面刚打开，还没有序号）。 */
  readonly status: (params: { since: number | null; clientId: string }, signal: AbortSignal) => Promise<PanelStatus>
  /** 一次提交所有改动过的字段（design-spec 4.4）。不会抛异常，网络错误也以 `{ ok: false, error }` 返回。 */
  readonly saveConfig: (patch: Partial<PromptxConfig>) => Promise<ConfigUpdateResult>
  readonly companion: (action: CompanionAction) => Promise<ActionResult>
  readonly runtime: (action: RuntimeAction) => Promise<ActionResult>
  readonly clientState: (report: ClientStateReport) => Promise<ActionResult>
}

/** fetch 的子集，测试时替换。 */
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>

const ACCEPT_JSON = { accept: 'application/json' }
const POST_JSON = { accept: 'application/json', 'content-type': 'application/json' }

/**
 * 创建接口对象。默认用页面的 fetch：这里包一层箭头函数再调用，不把 `window.fetch` 存成别的对象的属性去调，
 * 脱离 window 调用浏览器会抛 Illegal invocation。
 */
export function createApi(fetchImpl?: FetchLike): PromptxApi {
  const send: FetchLike = fetchImpl ?? ((input, init) => fetch(input, init))
  return {
    status: async ({ since, clientId }, signal) => {
      const query = new URLSearchParams()
      if (since !== null) query.set('since', String(since))
      query.set('clientId', clientId)
      const response = await send(`${API_BASE}status?${query.toString()}`, { method: 'GET', headers: ACCEPT_JSON, signal })
      if (!response.ok) throw new PromptxError('promptx/internal', `HTTP ${response.status}`)
      let body: unknown
      try {
        body = await response.json()
      } catch {
        throw new PromptxError('promptx/internal', 'malformed status')
      }
      const status = parsePanelStatus(body)
      if (status === null) throw new PromptxError('promptx/internal', 'malformed status')
      return status
    },
    saveConfig: async (patch) => {
      const outcome = await postJson(send, 'config', { patch })
      if (outcome.kind === 'failed') return { ok: false, errors: {}, error: outcome.error }
      return parseConfigUpdateResult(outcome.body) ?? { ok: false, errors: {}, error: responseError(outcome) }
    },
    companion: async action => toActionResult(await postJson(send, 'companion', { action })),
    runtime: async action => toActionResult(await postJson(send, 'runtime', { action })),
    clientState: async report => toActionResult(await postJson(send, 'client-state', report)),
  }
}

type PostOutcome =
  | { kind: 'response'; status: number; ok: boolean; body: unknown }
  | { kind: 'failed'; error: ErrorInfo }

/** POST 一个 JSON。不抛异常：连不上返回 failed，回复不是 JSON 时 body 为 null。 */
async function postJson(send: FetchLike, path: string, payload: unknown): Promise<PostOutcome> {
  let response: Response
  try {
    response = await send(`${API_BASE}${path}`, { method: 'POST', headers: POST_JSON, body: JSON.stringify(payload) })
  } catch (error) {
    return { kind: 'failed', error: toErrorInfo(error, 'promptx/channel/closed') }
  }
  let body: unknown = null
  try {
    body = await response.json()
  } catch {
    body = null
  }
  return { kind: 'response', status: response.status, ok: response.ok, body }
}

/** 回复里带了 `error` 就用它，否则归成内部错误；不是 2xx 时把 HTTP 状态码写进 detail。 */
function responseError(outcome: { status: number; ok: boolean; body: unknown }): ErrorInfo {
  const body = outcome.body
  const fromBody = isRecord(body) ? parseErrorInfo(body.error) : undefined
  if (fromBody !== undefined) return fromBody
  return outcome.ok ? { code: 'promptx/internal' } : { code: 'promptx/internal', detail: `HTTP ${outcome.status}` }
}

function toActionResult(outcome: PostOutcome): ActionResult {
  if (outcome.kind === 'failed') return { ok: false, error: outcome.error }
  const body = outcome.body
  if (isRecord(body) && typeof body.ok === 'boolean') {
    const result: ActionResult = { ok: body.ok }
    const error = parseErrorInfo(body.error)
    if (error !== undefined) result.error = error
    else if (!body.ok) result.error = responseError(outcome)
    const inUseBy = parseInUseBy(body.inUseBy)
    if (inUseBy !== undefined) result.inUseBy = inUseBy
    return result
  }
  return outcome.ok ? { ok: true } : { ok: false, error: responseError(outcome) }
}

// ───────────────────────────── 回复的形状检查 ─────────────────────────────

const RUNTIME_STATES: readonly RuntimeState[] = ['unsupported', 'missing', 'downloading', 'extracting', 'ready', 'failed']
const COMPANION_STATES: readonly CompanionState[] = ['stopped', 'waiting-runtime', 'starting', 'running', 'restarting', 'failed']
const RUNTIME_SOURCES: readonly RuntimeSource[] = ['auto', 'mirror', 'official']
const INSTANCE_STATES: readonly PanelStatus['instance'][] = ['active', 'duplicate']
const FIELD_ERRORS: readonly ConfigFieldError[] = [
  'library-dir-relative', 'library-dir-reserved', 'library-dir-skills', 'shortcut-invalid', 'value-invalid',
]

type JsonRecord = Record<string, unknown>

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback
}

export function parseErrorInfo(value: unknown): ErrorInfo | undefined {
  if (!isRecord(value)) return undefined
  const { code, detail } = value
  if (typeof code !== 'string') return undefined
  return typeof detail === 'string' ? { code, detail } : { code }
}

function parseInUseBy(value: unknown): Array<{ profile: string; version: string }> | undefined {
  if (!Array.isArray(value)) return undefined
  const items: Array<{ profile: string; version: string }> = []
  for (const item of value as unknown[]) {
    if (!isRecord(item)) continue
    const { profile, version } = item
    if (typeof profile === 'string' && typeof version === 'string') items.push({ profile, version })
  }
  return items
}

function parseConfig(value: unknown): PromptxConfig | null {
  if (!isRecord(value)) return null
  const { libraryDir, confirmDelete, optimizeInstruction, globalShortcut, hideOnBlur, runtimeSource } = value
  if (typeof libraryDir !== 'string' || typeof confirmDelete !== 'boolean' || typeof optimizeInstruction !== 'string') return null
  if (typeof globalShortcut !== 'string' || typeof hideOnBlur !== 'boolean' || !oneOf(runtimeSource, RUNTIME_SOURCES)) return null
  return { libraryDir, confirmDelete, optimizeInstruction, globalShortcut, hideOnBlur, runtimeSource }
}

function parseRuntime(value: unknown): RuntimeStatus | null {
  if (!isRecord(value)) return null
  const { state, version, dir, paused, source, received, total } = value
  if (!oneOf(state, RUNTIME_STATES) || typeof version !== 'string') return null
  const runtime: RuntimeStatus = { state, version, dir: stringOr(dir, '') }
  if (typeof paused === 'boolean') runtime.paused = paused
  const inUseBy = parseInUseBy(value.inUseBy)
  if (inUseBy !== undefined) runtime.inUseBy = inUseBy
  if (source === 'mirror' || source === 'official') runtime.source = source
  if (isFiniteNumber(received)) runtime.received = received
  if (isFiniteNumber(total)) runtime.total = total
  const error = parseErrorInfo(value.error)
  if (error !== undefined) runtime.error = error
  return runtime
}

function parseCompanion(value: unknown): PanelStatus['companion'] | null {
  if (!isRecord(value)) return null
  const { state, restartsExhausted } = value
  if (!oneOf(state, COMPANION_STATES)) return null
  const companion: PanelStatus['companion'] = { state }
  const error = parseErrorInfo(value.error)
  if (error !== undefined) companion.error = error
  if (typeof restartsExhausted === 'boolean') companion.restartsExhausted = restartsExhausted
  return companion
}

function parseShortcut(value: unknown): ShortcutStatus | null {
  if (!isRecord(value)) return null
  const { accelerator, registered } = value
  if (typeof accelerator !== 'string' || typeof registered !== 'boolean') return null
  const shortcut: ShortcutStatus = { accelerator, registered }
  const error = parseErrorInfo(value.error)
  if (error !== undefined) shortcut.error = error
  const warning = parseErrorInfo(value.warning)
  if (warning !== undefined) shortcut.warning = warning
  return shortcut
}

function parseNavigate(value: unknown): PanelStatus['navigate'] {
  if (!isRecord(value)) return null
  const { seq, ageMs } = value
  return isFiniteNumber(seq) && isFiniteNumber(ageMs) ? { seq, ageMs } : null
}

/** 检查长轮询拿到的状态。核心字段（序号、配置、运行时、小程序、实例）不对时返回 null；次要字段缺了用空值。 */
export function parsePanelStatus(value: unknown): PanelStatus | null {
  if (!isRecord(value)) return null
  const { seq, instance, defaultInstruction, companionPid } = value
  const config = parseConfig(value.config)
  const runtime = parseRuntime(value.runtime)
  const companion = parseCompanion(value.companion)
  if (!isFiniteNumber(seq) || config === null || runtime === null || companion === null || !oneOf(instance, INSTANCE_STATES)) return null
  const instructions = isRecord(defaultInstruction) ? defaultInstruction : {}
  const status: PanelStatus = {
    seq,
    config,
    effectiveLibraryDir: stringOr(value.effectiveLibraryDir, ''),
    defaultShortcut: stringOr(value.defaultShortcut, ''),
    defaultInstruction: { zh: stringOr(instructions.zh, ''), en: stringOr(instructions.en, '') },
    runtime,
    companion,
    shortcut: parseShortcut(value.shortcut),
    navigate: parseNavigate(value.navigate),
    platform: stringOr(value.platform, ''),
    instance,
  }
  if (isFiniteNumber(companionPid)) status.companionPid = companionPid
  return status
}

/** 检查保存配置的回复。不是 `{ ok: true }` 或 `{ ok: false, errors }` 时返回 null。只保留认识的字段和错误码。 */
export function parseConfigUpdateResult(value: unknown): ConfigUpdateResult | null {
  if (!isRecord(value)) return null
  if (value.ok === true) return { ok: true }
  if (value.ok !== false) return null
  const errors: Partial<Record<keyof PromptxConfig, ConfigFieldError>> = {}
  const rawErrors = value.errors
  if (isRecord(rawErrors)) {
    for (const field of CONFIG_FIELDS) {
      const code = rawErrors[field]
      if (oneOf(code, FIELD_ERRORS)) errors[field] = code
    }
  }
  const error = parseErrorInfo(value.error)
  return error === undefined ? { ok: false, errors } : { ok: false, errors, error }
}

// ───────────────────────────── 长轮询循环 ─────────────────────────────

export interface StatusSnapshot {
  /** 最近一次拿到的状态；还没拿到过时为 null。 */
  readonly status: PanelStatus | null
  /** 最近一次轮询失败的原因；下一次成功后清掉。 */
  readonly error: ErrorInfo | null
}

/** 配置页读状态用的外部 store（`useSyncExternalStore` 的两个参数）。写成属性而不是方法，组件可以直接传引用。 */
export interface StatusStore {
  readonly getSnapshot: () => StatusSnapshot
  readonly subscribe: (listener: () => void) => () => void
}

export interface StatusLoop extends StatusStore {
  readonly start: () => void
  /** 停止循环：中止在途的请求和等待中的重试，之后不再发请求。 */
  readonly dispose: () => void
}

export interface StatusLoopOptions {
  readonly api: Pick<PromptxApi, 'status'>
  readonly clientId: string
  /** 每拿到一次状态调用一次（导航判断）。抛出的异常不影响轮询。 */
  readonly onStatus?: (status: PanelStatus) => void
  readonly backoffMs?: readonly number[]
  readonly guardMs?: number
  readonly minIdleMs?: number
}

const INITIAL_SNAPSHOT: StatusSnapshot = { status: null, error: null }

export function createStatusLoop(options: StatusLoopOptions): StatusLoop {
  const backoff = options.backoffMs ?? POLL_BACKOFF_MS
  const guardMs = options.guardMs ?? POLL_GUARD_MS
  const minIdleMs = options.minIdleMs ?? POLL_MIN_IDLE_MS
  const stop = new AbortController()
  const listeners = new Set<() => void>()
  let snapshot = INITIAL_SNAPSHOT
  let started = false

  const publish = (next: StatusSnapshot): void => {
    snapshot = next
    for (const listener of [...listeners]) listener()
  }

  // 一次长轮询。请求的中止有两个来源：dispose（stop）和兜底超时；只有后者算超时错误。
  const poll = async (since: number | null): Promise<PanelStatus> => {
    const request = new AbortController()
    const guard = setTimeout(() => {
      request.abort()
    }, guardMs)
    // dispose 时当场清掉兜底计时器，不等请求的拒绝传回来，卸载后立刻不剩计时器。
    const onStop = (): void => {
      clearTimeout(guard)
      request.abort()
    }
    stop.signal.addEventListener('abort', onStop)
    try {
      return await options.api.status({ since, clientId: options.clientId }, request.signal)
    } catch (error) {
      if (request.signal.aborted && !stop.signal.aborted) throw new PromptxError('promptx/channel/timeout')
      throw error
    } finally {
      clearTimeout(guard)
      stop.signal.removeEventListener('abort', onStop)
    }
  }

  // 可被 dispose 打断的等待，打断后不留下计时器。
  const sleep = (ms: number): Promise<void> => new Promise<void>((resolve) => {
    if (stop.signal.aborted) {
      resolve()
      return
    }
    const finish = (): void => {
      clearTimeout(timer)
      stop.signal.removeEventListener('abort', finish)
      resolve()
    }
    const timer = setTimeout(finish, ms)
    stop.signal.addEventListener('abort', finish)
  })

  // 用函数读停止标志：await 之后它可能已经变了，直接写 stop.signal.aborted 会被类型收窄当成一直是 false。
  const stopped = (): boolean => stop.signal.aborted

  const run = async (): Promise<void> => {
    // 第一次不带序号：Host 立即回复当前状态，新打开的页面不用先等 25 秒。
    let since: number | null = null
    let failures = 0
    while (!stopped()) {
      const startedAt = Date.now()
      let status: PanelStatus
      try {
        status = await poll(since)
      } catch (error) {
        if (stopped()) return
        publish({ status: snapshot.status, error: toErrorInfo(error, 'promptx/channel/closed') })
        const delay = backoff[Math.min(failures, backoff.length - 1)] ?? POLL_GUARD_MS
        failures += 1
        await sleep(delay)
        continue
      }
      if (stopped()) return
      failures = 0
      const unchanged = since !== null && status.seq === since
      since = status.seq
      publish({ status, error: null })
      try {
        options.onStatus?.(status)
      } catch {
        // 导航出错（例如插件页的服务正在重新加载）不能打断状态轮询；下一次状态到达时还会再判断。
      }
      if (unchanged && Date.now() - startedAt < minIdleMs) await sleep(minIdleMs)
    }
  }

  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    start: () => {
      if (started || stop.signal.aborted) return
      started = true
      run().catch((error: unknown) => {
        publish({ status: snapshot.status, error: toErrorInfo(error) })
      })
    },
    dispose: () => {
      stop.abort()
      listeners.clear()
    },
  }
}

// ───────────────────────────── 「打开配置页」的导航 ─────────────────────────────

export interface NavigationHandler {
  /** 每拿到一次状态调用一次。 */
  readonly handle: (status: PanelStatus) => void
  /** 插件页的导航服务刚出现时调用：上次因为服务不在而没切成、仍在有效期内的请求，现在切。 */
  readonly retry: () => void
}

/**
 * 小窗的「设置」和菜单栏的「设置…」由 Host 记成一次 navigate 请求（序号 + 发出至今的毫秒数）。规则（design-spec 4.4、4.8，
 * 独立审查 TC-06）：序号比本页处理过的大、且请求不到 60 秒时切到插件页，并记下这个序号；第一次轮询同样适用，
 * 所以由系统浏览器新打开的页面也会切过去，同一个请求只切一次。
 *
 * Host 只给出请求的「年龄」而不是绝对时间，因为远程浏览器的时钟可能和运行 dsh 的电脑不一致。
 * 状态序号变小（Host 重启时时钟被往回拨过）时把处理过的序号清掉，否则新 Host 的请求会被当成处理过的旧请求。
 *
 * open 返回 false 表示这次没能切（插件页的导航服务暂时不在）：不记下这个请求，记成待切，等服务出现时（retry）
 * 或下一次拿到状态时再试，仍以 60 秒为限。新打开的页面最需要这一条：dsh 的插件管理页要等 Host 确认访问权限之后
 * 才提供导航服务，第一次轮询的结果常常先到。open 抛异常时照样记下，不对同一个请求反复重试。
 *
 * 待切请求的过期时间按本页收到它时的本地时钟推算（收到时的 ageMs 加上之后经过的时间），不和 Host 的时钟比较。
 */
export function createNavigationHandler(
  open: () => boolean,
  options: { maxAgeMs?: number; now?: () => number } = {},
): NavigationHandler {
  const maxAgeMs = options.maxAgeMs ?? NAVIGATE_MAX_AGE_MS
  const now = options.now ?? (() => Date.now())
  let handledSeq = Number.NEGATIVE_INFINITY
  let lastStatusSeq: number | null = null
  let pending: { seq: number; expiresAt: number } | null = null

  const attempt = (seq: number, expiresAt: number): void => {
    let opened: boolean
    try {
      opened = open()
    } catch (error) {
      handledSeq = seq
      pending = null
      throw error
    }
    if (opened) {
      handledSeq = seq
      pending = null
    } else {
      pending = { seq, expiresAt }
    }
  }

  return {
    handle: (status) => {
      if (lastStatusSeq !== null && status.seq < lastStatusSeq) handledSeq = Number.NEGATIVE_INFINITY
      lastStatusSeq = status.seq
      const navigate = status.navigate
      // 最新状态里没有这个页面该切的请求（已处理、过期，或 Host 改成只切别的页面）：之前待切的也作废。
      if (navigate === null || navigate.seq <= handledSeq || navigate.ageMs >= maxAgeMs) {
        pending = null
        return
      }
      attempt(navigate.seq, now() + maxAgeMs - navigate.ageMs)
    },
    retry: () => {
      if (pending === null) return
      if (now() >= pending.expiresAt) {
        pending = null
        return
      }
      attempt(pending.seq, pending.expiresAt)
    },
  }
}

// ───────────────────────────── 页面状态上报 ─────────────────────────────

export interface ClientStateReporter {
  /** 上报一次当前状态（启动时、界面语言切换时、页面可见性变化时调用）。 */
  readonly report: () => void
  readonly dispose: () => void
}

/**
 * 页面状态上报。同一时间只有一个请求在途，在途期间的新变化合并成一次，回来后再按最新状态发：
 * 两个请求并发时 Host 可能后收到旧的那个，用旧值覆盖新值。上报失败不重试，下一次变化时会再报。
 */
export function createClientStateReporter(options: {
  readonly api: Pick<PromptxApi, 'clientState'>
  /** 发送时才读取，保证发出去的是最新状态。 */
  readonly read: () => ClientStateReport
}): ClientStateReporter {
  let sending = false
  let queued = false
  let disposed = false

  const settle = (): void => {
    sending = false
    if (queued && !disposed) {
      queued = false
      send()
    }
  }

  const send = (): void => {
    if (disposed) return
    if (sending) {
      queued = true
      return
    }
    sending = true
    let pending: Promise<unknown>
    try {
      pending = options.api.clientState(options.read())
    } catch {
      // 读不到状态（例如 locale 服务正在重新加载）或请求同步抛错：这次不发，标志复位，下一次变化时再报。
      sending = false
      return
    }
    pending.then(settle, settle)
  }

  return {
    report: send,
    dispose: () => {
      disposed = true
      queued = false
    },
  }
}

/** 每个页面一个随机 id（16 字节，32 位十六进制）。不用 crypto.randomUUID：浏览器在非安全来源（局域网 HTTP 页面）上不提供它。 */
export function createClientId(fill: (bytes: Uint8Array<ArrayBuffer>) => void = (bytes) => {
  crypto.getRandomValues(bytes)
}): string {
  const bytes = new Uint8Array(16)
  fill(bytes)
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
}
