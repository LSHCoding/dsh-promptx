// Host 与小程序之间的通信协议：方法表、参数和结果类型。这是唯一来源；改协议要同时改两端和协议测试，
// 并提升 PROTOCOL_VERSION。帧格式见 ndjson.ts，请求与响应的处理见 rpc.ts。

import type {
  Binding,
  CompanionConfig,
  CompanionStatus,
  DraftRecord,
  ErrorInfo,
  LibraryListParams,
  LibraryListResult,
  LibraryReadResult,
  MetaPatch,
  MetaResult,
  OptimizeEvent,
  OptimizeSession,
  RestoreResult,
  RestoreTarget,
  SaveMode,
  SaveResult,
  TextSelection,
  TrashEntry,
  TrashListResult,
} from './types.ts'

// 2：status 加了 locale 和 rendererError（审查 F5、CR-03）。
export const PROTOCOL_VERSION = 2

type Empty = Record<string, never>

export interface HelloParams {
  protocol: number
  appVersion: string
  electron: string
  platform: string
  arch: string
}

export interface HelloResult {
  protocol: number
  hostVersion: string
  config: CompanionConfig
  /**
   * 运行模式。冒烟测试和端到端测试的处理函数只在这里说是 smoke / e2e 时才启用；
   * 不从环境变量读，避免项目目录里的 .env 打开测试钩子（design-spec 9）。
   */
  mode: CompanionMode
}

/** 端到端测试命令，只在 PROMPTX_E2E=1 时注册。 */
export type E2eCommand =
  | { action: 'core-path'; text: string }
  | { action: 'save-to-library' }
  | { action: 'state' }
  /** Host 自己处理：计时读取一条库条目（N-01 的 256 KiB 读取）。 */
  | { action: 'host-read'; relPath: string }
  /** 转给小窗：在 size 字的草稿里插入一个字符，测到绘制完成的耗时（N-01）。 */
  | { action: 'typing-latency'; size: number }

export interface E2eResult {
  ok: boolean
  /** 各步骤耗时（毫秒）和观察到的状态，按命令不同而不同。 */
  data: Record<string, unknown>
  error?: ErrorInfo
}

export interface SmokeReport {
  windowCreated: boolean
  windowShown: boolean
  rendererReady: boolean
  editorMounted: boolean
  draftLoaded: boolean
  shortcut: CompanionStatus['shortcut']
  tray: boolean
  noSandbox: boolean
  /** 向窗口发 close 后进程没有退出、窗口变为隐藏（Windows 的 Alt+F4 等系统关闭只隐藏）。 */
  closeHides: boolean
}

/** 小程序 → Host 的请求。 */
export interface CompanionRequests {
  'hello': { params: HelloParams; result: HelloResult }
  'draft.load': { params: Empty; result: { record: DraftRecord | null } }
  'draft.save': { params: { text: string; selection: TextSelection | null; binding: Binding | null }; result: { updatedAt: string } }
  'library.list': { params: LibraryListParams; result: LibraryListResult }
  'library.read': { params: { relPath: string }; result: LibraryReadResult }
  /** requestId 用于新建文件去重：同一个 requestId 重发时返回已经建好的文件，不再建第二个。 */
  'library.save': { params: { text: string; binding: Binding | null; folder: string | null; mode: SaveMode; requestId: string }; result: SaveResult }
  'library.updateMeta': { params: { relPath: string; patch: MetaPatch; addFrontMatter: boolean }; result: MetaResult }
  'library.delete': { params: { relPath: string }; result: { trashFile: string } }
  'trash.list': { params: { query: string }; result: TrashListResult }
  'trash.read': { params: { file: string }; result: { entry: TrashEntry; body: string } }
  /** target 为 alternative 时带上对话框里显示的替代路径；这个路径已被占用时 Host 再返回 occupied。 */
  'trash.restore': { params: { file: string; target: RestoreTarget; alternative: string | null; acceptModified: boolean }; result: RestoreResult }
  'optimize.start': { params: { text: string }; result: { session: OptimizeSession } }
  'optimize.followup': { params: { text: string }; result: { session: OptimizeSession } }
  'optimize.retry': { params: { roundId: string }; result: { session: OptimizeSession } }
  'optimize.cancel': { params: Empty; result: { session: OptimizeSession | null } }
  'optimize.clear': { params: Empty; result: Empty }
  'optimize.state': { params: Empty; result: { session: OptimizeSession | null } }
  /** 打开 dsh 插件页里 PromptX 的配置页。返回要用系统打开的地址（`dsh://open` 或 dsh 网页地址），没有则为 null。 */
  'host.openSettings': { params: Empty; result: { open: string | null; navigated: boolean } }
}

/** 小程序 → Host 的通知。 */
export interface CompanionNotifications {
  'status': CompanionStatus
  /** 菜单栏「重启小窗」。 */
  'host.restartCompanion': Empty
  'smoke.report': SmokeReport
}

/** Host → 小程序的请求。 */
export interface HostRequests {
  'ping': { params: Empty; result: Empty }
  /** 小程序回复前先把草稿写回 Host。 */
  'shutdown': { params: { reason: string }; result: Empty }
  'e2e.run': { params: E2eCommand; result: E2eResult }
}

/** Host → 小程序的通知。 */
export interface HostNotifications {
  'config': CompanionConfig
  'window.command': { command: 'show' | 'hide' | 'toggle' }
  'optimize.event': OptimizeEvent
  /** 库目录变了：小窗刷新侧栏，绑定的库目录不同时解除绑定。 */
  'library.changed': { libraryDir: string }
}

export type CompanionRequestMethod = keyof CompanionRequests
export type CompanionNotificationMethod = keyof CompanionNotifications
export type HostRequestMethod = keyof HostRequests
export type HostNotificationMethod = keyof HostNotifications

/** 方法表，供两端注册处理函数时核对（测试检查两端的注册与这里一致）。 */
export const COMPANION_REQUEST_METHODS = [
  'hello', 'draft.load', 'draft.save',
  'library.list', 'library.read', 'library.save', 'library.updateMeta', 'library.delete',
  'trash.list', 'trash.read', 'trash.restore',
  'optimize.start', 'optimize.followup', 'optimize.retry', 'optimize.cancel', 'optimize.clear', 'optimize.state',
  'host.openSettings',
] as const satisfies readonly CompanionRequestMethod[]

export const COMPANION_NOTIFICATION_METHODS = [
  'status', 'host.restartCompanion', 'smoke.report',
] as const satisfies readonly CompanionNotificationMethod[]

export const HOST_REQUEST_METHODS = ['ping', 'shutdown', 'e2e.run'] as const satisfies readonly HostRequestMethod[]

export const HOST_NOTIFICATION_METHODS = [
  'config', 'window.command', 'optimize.event', 'library.changed',
] as const satisfies readonly HostNotificationMethod[]

/** 渲染进程可以经主进程转给 Host 的请求（白名单）。hello 由主进程自己发。 */
export const RENDERER_FORWARDED_METHODS = [
  'draft.load', 'draft.save',
  'library.list', 'library.read', 'library.save', 'library.updateMeta', 'library.delete',
  'trash.list', 'trash.read', 'trash.restore',
  'optimize.start', 'optimize.followup', 'optimize.retry', 'optimize.cancel', 'optimize.clear', 'optimize.state',
] as const satisfies readonly CompanionRequestMethod[]

export type RendererForwardedMethod = typeof RENDERER_FORWARDED_METHODS[number]

/** 请求超时（毫秒）。保存、读取大文件给得更长。 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 15_000
export const LONG_REQUEST_TIMEOUT_MS = 30_000

/** 单帧上限。草稿 10 万字、单个库文件 2 MiB，JSON 转义后都远小于它。 */
export const MAX_FRAME_BYTES = 16 * 1024 * 1024

/** JSON-RPC 错误码：标准码之外的项目码。 */
export const RPC_ERROR = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
  protocolMismatch: -32001,
  timeout: -32002,
  channelClosed: -32003,
  business: -32010,
} as const

/**
 * 小程序启动时由 Host 设置的环境变量。值都由 Host 计算，Host 从不把自己继承到的 PROMPTX_* 传下去。
 * 运行模式不走环境变量，见 HelloResult.mode。
 */
export const COMPANION_ENV = {
  /** 小程序的数据目录：`<dsh 数据目录>/promptx`。 */
  dataDir: 'PROMPTX_DATA_DIR',
  /** profile 名（显示用）。 */
  profile: 'PROMPTX_PROFILE',
  /** profile 名的哈希（文件名用）。 */
  profileHash: 'PROMPTX_PROFILE_HASH',
  parentPid: 'PROMPTX_PARENT_PID',
} as const

/** 启动参数里的标记，便于在进程列表里认出小程序（`pkill -f -- '--promptx-companion='`）。Electron 和 Chromium 都忽略它。 */
export const COMPANION_MARKER_ARG = '--promptx-companion'

/** 小程序的退出码：界面进程 30 秒内第二次崩溃或卡死超过 10 秒。Host 据此报「小窗界面崩溃」（design-spec 5.4）。 */
export const RENDERER_FATAL_EXIT_CODE = 3

export type CompanionMode = 'normal' | 'smoke' | 'e2e'
