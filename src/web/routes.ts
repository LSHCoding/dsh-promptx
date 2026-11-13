// Client ↔ Host 的 /api/dsh-promptx/* 路由（design-spec 4.3、D5）。
//
// 第三方插件用不了 dsh 内部的 Typert 远程接口，也不该用 session command（会写 session 日志），所以用
// connection.fetch.register() 注册精确路径的 Fetch 路由：只有 owner 能访问，鉴权由 dsh 的 cookie 完成，
// 桌面版 dsh-app:// 页面的请求也会转发给这些路由。往页面推送用长轮询（GET status?since=<seq>），不用 SSE：
// 桌面版的转发器能否保持长连接没有验证过，长轮询在 dsh-codex-pets 里已经在桌面版上用过。
//
// 处理函数一律不抛异常：Host 进程里任何未处理的拒绝都会让整个 dsh 退出（dsh-app-boot 的 fail-loud），
// 而 dsh 的 node:http 桥接对处理函数的拒绝不做兜底。请求格式不对返回 400，业务失败（PromptxError）返回 409，
// 其他异常返回 500，响应体都是 JSON 且带 ok: false。日志只记错误码和系统信息，不记请求内容。

import { background } from '../background.ts'
import type { HostLogger } from '../services.ts'
import { PromptxError, toErrorInfo } from '../shared/errors.ts'
import type { E2eCommand, E2eResult } from '../shared/protocol.ts'
import type { ConfigUpdateResult } from '../shared/types.ts'
import { DEFAULT_POLL_TIMEOUT_MS } from './status-store.ts'
import type { StatusStore } from './status-store.ts'

export const API_PREFIX = '/api/dsh-promptx'

export const ROUTE_PATHS = {
  status: `${API_PREFIX}/status`,
  config: `${API_PREFIX}/config`,
  companion: `${API_PREFIX}/companion`,
  runtime: `${API_PREFIX}/runtime`,
  clientState: `${API_PREFIX}/client-state`,
  e2e: `${API_PREFIX}/e2e`,
} as const

export type FetchMethod = 'GET' | 'HEAD' | 'POST'

/** dsh-client-connection 的 ConnectionFetchRoute（0.2.2-rc.1）里用到的部分。 */
export interface FetchRoute {
  path: string
  methods: readonly FetchMethod[]
  requestBody: 'buffered' | 'streaming'
  fetch: (request: Request) => Promise<Response>
}

/** ctx.connection 里用到的部分。register 返回异步的注销函数。 */
export interface FetchRegistry {
  fetch: { register(route: FetchRoute): () => Promise<void> }
}

export interface ClientStateReport {
  /** 页面自己生成的标识，同一个页面不变（刷新后换新的）。 */
  clientId: string
  /** 页面当前生效的界面语言（ctx.locale.getLocale().active），例如 zh-CN、en。 */
  locale: string
  /** 页面是否可见（document.visibilityState === 'visible'）。 */
  visible: boolean
}

export interface RuntimeRemoveResult {
  removed: string[]
  /** 被其他 profile 的小程序使用、因而没有删的版本。 */
  inUseBy: Array<{ profile: string; version: string }>
}

export interface RouteDeps {
  store: StatusStore
  /** 配置页「保存」：createConfigUpdater 的结果。 */
  updateConfig: (patch: unknown) => Promise<ConfigUpdateResult>
  /** 配置页的「重启小窗」「显示小窗」「打开 PromptX 设置」。抛 PromptxError 时以 409 返回错误码。 */
  companion: {
    restart: () => Promise<void> | void
    show: () => Promise<void> | void
    settings: () => Promise<void> | void
  }
  /** 配置页的「下载 / 重试」「删除运行时」。 */
  runtime: {
    download: () => Promise<void> | void
    remove: () => Promise<RuntimeRemoveResult>
  }
  /**
   * 页面上报的生效语言和可见性（design-spec 4.7、4.8）。路由已经用它刷新了 store 里的页面记录，
   * 这里只需要记下语言（Host 在 dsh 没有语言偏好时用最近一次上报的值）。
   */
  reportClientState: (state: ClientStateReport) => void
  /**
   * 端到端测试命令。只在 Host 进程的环境变量 DSH_PROMPTX_E2E=1 时提供（见 isE2eEnabled）；
   * 不提供时 /e2e 路由根本不注册（审查 S10）。
   */
  e2e?: ((command: E2eCommand) => Promise<E2eResult>) | undefined
  /** 长轮询的等待时长，测试时调小。默认 25 秒。 */
  pollTimeoutMs?: number | undefined
  logger?: Pick<HostLogger, 'warn'> | undefined
}

/**
 * 端到端测试路由的开关。只认 DSH_PROMPTX_E2E=1：dsh 会把项目目录的 .env 读进 process.env，
 * 但拒绝 DSH_ 前缀的变量，所以克隆下来的仓库里的 .env 打不开测试钩子；PROMPTX_E2E 这类名字不算数（审查 S10、D17）。
 */
export function isE2eEnabled(env: Readonly<Record<string, string | undefined>>): boolean {
  return env.DSH_PROMPTX_E2E === '1'
}

/** 注册所有路由，返回各自的注销函数。 */
export function registerRoutes(connection: FetchRegistry, deps: RouteDeps): Array<() => Promise<void>> {
  const logger = deps.logger ?? SILENT
  const routes = buildRoutes(deps, logger)
  const disposers: Array<() => Promise<void>> = []
  try {
    for (const route of routes) disposers.push(connection.fetch.register(route))
  } catch (error) {
    // 中途失败（例如路径已被占用）时撤掉已经注册的，再把异常交给调用方。
    for (const dispose of disposers) background(logger, 'promptx route dispose', dispose)
    throw error
  }
  return disposers
}

// ───────────────────────────── 路由 ─────────────────────────────

/** 请求体上限（字符）。最大的合法请求是带 10 万字优化指令的配置改动，JSON 转义后也远小于它。 */
const MAX_BODY_CHARS = 1_000_000

/** 页面标识：只用来区分页面，限定字符集和长度，避免把任意内容存进内存。 */
const CLIENT_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/

/** 语言标签，照 dsh-client-locale 的 LOCALE_ID_PATTERN，另外容忍下划线分隔。 */
const LOCALE_PATTERN = /^[A-Za-z]{2,8}(?:[-_][A-Za-z0-9]{1,8})*$/

const E2E_ACTION_PATTERN = /^[a-z][a-z0-9-]{0,63}$/

const SILENT: Pick<HostLogger, 'warn'> = {
  warn: () => {},
}

function buildRoutes(deps: RouteDeps, logger: Pick<HostLogger, 'warn'>): FetchRoute[] {
  const pollTimeoutMs = deps.pollTimeoutMs ?? DEFAULT_POLL_TIMEOUT_MS
  const routes: FetchRoute[] = [
    route(ROUTE_PATHS.status, ['GET'], logger, async (request) => {
      const url = new URL(request.url)
      const since = parseSince(url.searchParams.get('since'))
      const clientId = parseOptionalClientId(url.searchParams.get('clientId'))
      // request.signal 在页面断开时中止（dsh 的 node:http 桥接在 res close 时 abort），等待随之结束、计时器清掉。
      const status = await deps.store.waitForChange(since, request.signal, pollTimeoutMs, clientId)
      return json(200, status)
    }),
    route(ROUTE_PATHS.config, ['POST'], logger, async (request) => {
      const body = await readJsonObject(request)
      onlyKeys(body, ['patch'])
      if (!isPlainObject(body.patch)) throw new BadRequest('patch must be an object')
      return json(200, await deps.updateConfig(body.patch))
    }, { errors: {} }),
    route(ROUTE_PATHS.companion, ['POST'], logger, async (request) => {
      const body = await readJsonObject(request)
      onlyKeys(body, ['action'])
      switch (body.action) {
        case 'restart':
          await deps.companion.restart()
          break
        case 'show':
          await deps.companion.show()
          break
        case 'settings':
          await deps.companion.settings()
          break
        default:
          throw new BadRequest('action must be restart, show or settings')
      }
      return json(200, { ok: true })
    }),
    route(ROUTE_PATHS.runtime, ['POST'], logger, async (request) => {
      const body = await readJsonObject(request)
      onlyKeys(body, ['action'])
      switch (body.action) {
        case 'download':
          await deps.runtime.download()
          return json(200, { ok: true })
        case 'delete': {
          const result = await deps.runtime.remove()
          return json(200, { ok: true, removed: result.removed, inUseBy: result.inUseBy })
        }
        default:
          throw new BadRequest('action must be download or delete')
      }
    }),
    route(ROUTE_PATHS.clientState, ['POST'], logger, async (request) => {
      const body = await readJsonObject(request)
      onlyKeys(body, ['clientId', 'locale', 'visible'])
      const clientId = parseClientId(body.clientId)
      if (typeof body.locale !== 'string' || !LOCALE_PATTERN.test(body.locale)) throw new BadRequest('locale must be a language tag')
      if (typeof body.visible !== 'boolean') throw new BadRequest('visible must be a boolean')
      deps.store.touchClient(clientId, body.visible)
      deps.reportClientState({ clientId, locale: body.locale, visible: body.visible })
      return json(200, { ok: true })
    }),
  ]
  const e2e = deps.e2e
  if (e2e !== undefined) {
    routes.push(route(ROUTE_PATHS.e2e, ['POST'], logger, async (request) => {
      const body = await readJsonObject(request)
      onlyKeys(body, ['command'])
      return json(200, await e2e(parseE2eCommand(body.command)))
    }))
  }
  return routes
}

/** 请求格式不对。只在这个文件里抛出和捕获，变成 400。 */
class BadRequest extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BadRequest'
  }
}

/**
 * 包一层：任何异常都变成 JSON 响应。failureExtras 是失败响应里额外带的字段
 * （配置路由带 errors: {}，让响应仍符合 ConfigUpdateResult 的形状）。
 */
function route(
  path: string,
  methods: readonly FetchMethod[],
  logger: Pick<HostLogger, 'warn'>,
  handler: (request: Request) => Promise<Response>,
  failureExtras: Record<string, unknown> = {},
): FetchRoute {
  return {
    path,
    methods,
    requestBody: 'buffered',
    fetch: async (request: Request): Promise<Response> => {
      try {
        return await handler(request)
      } catch (error) {
        if (error instanceof BadRequest) {
          return json(400, { ok: false, ...failureExtras, error: { code: 'promptx/internal', detail: `bad request: ${error.message}` } })
        }
        const info = toErrorInfo(error)
        if (error instanceof PromptxError) return json(409, { ok: false, ...failureExtras, error: info })
        try {
          logger.warn('%s failed: %s%s', path, info.code, info.detail === undefined ? '' : ` (${info.detail})`)
        } catch {
          // 日志本身出错也不能让处理函数抛出。
        }
        return json(500, { ok: false, ...failureExtras, error: info })
      }
    },
  }
}

function json(status: number, body: unknown): Response {
  // 长轮询和动作结果都不能被浏览器或桌面版的转发层缓存。
  return Response.json(body, { status, headers: { 'cache-control': 'no-store' } })
}

async function readJsonObject(request: Request): Promise<Record<string, unknown>> {
  let text: string
  try {
    text = await request.text()
  } catch {
    throw new BadRequest('body unreadable')
  }
  if (text.length > MAX_BODY_CHARS) throw new BadRequest('body too large')
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new BadRequest('body is not JSON')
  }
  if (!isPlainObject(value)) throw new BadRequest('body must be a JSON object')
  return value
}

/** 不认识的字段一律拒绝：Client 和 Host 随同一个包发布，字段对不上说明有一边写错了，宁可报错也不默默忽略。 */
function onlyKeys(body: Record<string, unknown>, allowed: readonly string[]): void {
  for (const key of Object.keys(body)) {
    if (!allowed.includes(key)) throw new BadRequest(`unexpected field: ${key.slice(0, 64)}`)
  }
}

/** since 缺省或为空表示第一次轮询；e2e 脚本用 since=-1 表示「立即返回」，所以接受负数。 */
function parseSince(raw: string | null): number | null {
  if (raw === null || raw === '') return null
  if (!/^-?\d{1,16}$/.test(raw)) throw new BadRequest('since must be an integer')
  const value = Number(raw)
  if (!Number.isSafeInteger(value)) throw new BadRequest('since must be an integer')
  return value
}

function parseOptionalClientId(raw: string | null): string | undefined {
  if (raw === null || raw === '') return undefined
  return parseClientId(raw)
}

function parseClientId(value: unknown): string {
  if (typeof value !== 'string' || !CLIENT_ID_PATTERN.test(value)) throw new BadRequest('clientId must be 1-128 letters, digits or ._:-')
  return value
}

/**
 * 端到端命令。protocol.ts 里列出的命令按类型严格校验；其他命令（端到端脚本可能先于协议类型加上的）
 * 只允许标量字段，原样交给 e2e 处理函数，由它再校验。
 */
function parseE2eCommand(value: unknown): E2eCommand {
  if (!isPlainObject(value)) throw new BadRequest('command must be an object')
  const action = value.action
  if (typeof action !== 'string' || !E2E_ACTION_PATTERN.test(action)) throw new BadRequest('command.action must be a lowercase name')
  switch (action) {
    case 'core-path':
      onlyKeys(value, ['action', 'text'])
      if (typeof value.text !== 'string') throw new BadRequest('command.text must be a string')
      return { action, text: value.text }
    case 'edit-entry': {
      onlyKeys(value, ['action', 'relPath', 'text', 'metadata', 'folder'])
      if (typeof value.text !== 'string' || typeof value.relPath !== 'string') throw new BadRequest('entry path and text must be strings')
      const { metadata, relPath, text, folder } = value
      if (folder !== undefined && typeof folder !== 'string') throw new BadRequest('entry folder must be a string')
      const destination = folder === undefined ? {} : { folder }
      if (metadata === undefined) return { action, relPath, text, ...destination }
      if (!isPlainObject(metadata) || typeof metadata.title !== 'string' || !Array.isArray(metadata.tags) ||
        !metadata.tags.every((tag: unknown): tag is string => typeof tag === 'string')) throw new BadRequest('invalid entry metadata')
      onlyKeys(metadata, ['title', 'tags'])
      return { action, relPath, text, metadata: { title: metadata.title, tags: metadata.tags }, ...destination }
    }
    case 'save-to-library':
    case 'state':
    case 'toggle-chat':
      onlyKeys(value, ['action'])
      return { action }
    default:
      for (const [key, field] of Object.entries(value)) {
        if (field !== null && typeof field !== 'string' && typeof field !== 'number' && typeof field !== 'boolean') {
          throw new BadRequest(`command.${key.slice(0, 64)} must be a scalar`)
        }
      }
      return value as unknown as E2eCommand
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value) as unknown
  return proto === Object.prototype || proto === null
}
