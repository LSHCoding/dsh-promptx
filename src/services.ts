// Host 内部各服务的接口。index.ts 只做组装：按这些接口创建服务，把小程序的协议请求分发给它们，
// 把 dsh 的服务（存储、模型、设置、路由）接进来。各服务的实现在对应的功能域目录里。

import type { Logger } from '@deepseek-ai/cordis'
import type { CompanionNotifications, CompanionRequests, HelloResult, HostNotifications, HostRequests } from './shared/protocol.ts'
import type { RpcPeer } from './shared/rpc.ts'
import type {
  Binding,
  CompanionState,
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
  RuntimeSource,
  RuntimeStatus,
  SaveMode,
  SaveResult,
  TextSelection,
  TrashEntry,
  TrashListResult,
} from './shared/types.ts'

/** 只记状态和错误的日志接口（cordis Logger 的子集），方便测试替换。 */
export type HostLogger = Pick<Logger, 'debug' | 'info' | 'warn' | 'error'>

// ───────────────────────────── 库（src/library/service.ts） ─────────────────────────────

export interface LibraryServiceOptions {
  /** 当前库目录的绝对路径（配置变了会返回新值）。 */
  getRoot: () => string
  /** 新建 Prompt 提取不到标题时用的占位标题（按界面语言）。 */
  untitledTitle: () => string
  now?: () => Date
  /** 生成 id 的随机字节，测试时可以固定。 */
  randomBytes?: (size: number) => Uint8Array
  /**
   * 每次操作前重新检查库目录的位置限制（design-spec 7.4，配置可能被手改）。返回 null 表示可以用；
   * 返回错误时 list 报 unavailable，其他操作抛 promptx/library/unavailable。
   */
  checkRoot?: (root: string) => Promise<ErrorInfo | null>
  /** 扫描时要跳过的目录（realpath）：dsh 数据目录、已知技能目录、`<dsh>/promptx`。 */
  skipRealpaths?: () => readonly string[]
}

export interface LibraryApi {
  list(params: LibraryListParams): Promise<LibraryListResult>
  read(relPath: string): Promise<LibraryReadResult>
  /** requestId：新建文件时用于去重，同一个 requestId 重发返回已经建好的文件（Host 进程内记住最近的 100 个）。 */
  save(params: { text: string; binding: Binding | null; folder: string | null; mode: SaveMode; requestId: string }): Promise<SaveResult>
  updateMeta(params: { relPath: string; patch: MetaPatch; addFrontMatter: boolean }): Promise<MetaResult>
  delete(relPath: string): Promise<{ trashFile: string }>
  trashList(query: string): Promise<TrashListResult>
  trashRead(file: string): Promise<{ entry: TrashEntry; body: string }>
  trashRestore(params: { file: string; target: RestoreTarget; alternative: string | null; acceptModified: boolean }): Promise<RestoreResult>
  /** 库目录变了：丢掉索引缓存。 */
  reset(): void
}

// ───────────────────────────── 草稿（src/draft/service.ts） ─────────────────────────────

/**
 * 草稿存储。每个 profile 一个 layout: 'single' 的存储单元（名字是 profile 名哈希），记录损坏、版本不认识、
 * 读不出来时打开失败（fail closed），不会被当成「没有记录」（design-spec 4.5）。
 * 存储单元在第一次 load() 时打开，失败后下一次 load() 重试（小窗的「重试」）。
 */
export interface DraftApi {
  /** 没有记录时返回 null；打不开或记录不合法时抛 PromptxError('promptx/draft/unreadable')。成功后才允许 save。 */
  load(): Promise<DraftRecord | null>
  /** 还没有成功 load 过、或存储单元不可用时抛 promptx/draft/unreadable；写入失败抛 promptx/draft/write-failed。 */
  save(input: { text: string; selection: TextSelection | null; binding: Binding | null }): Promise<{ updatedAt: string }>
  /** 等在途写入完成后关闭。 */
  close(): Promise<void>
}

// ───────────────────────────── 优化（src/optimize/service.ts） ─────────────────────────────

/** dsh 当前默认模型（agentDefaultModel.currentSelection() 的结果）。 */
export interface ModelSelection {
  provider: string
  model: string
  reasoningEffort?: string
}

export interface OptimizeServiceOptions {
  /** dsh 的 llm 服务；不存在时返回 undefined。类型用宽松的接口，避免和 dsh-llm 的具体实现耦合。 */
  getLlm: () => LlmLike | undefined
  getModel: () => ModelSelection | undefined
  /** 配置里的优化指令（可能为空白）。 */
  getInstruction: () => string
  getLocale: () => 'zh' | 'en'
  emit: (event: OptimizeEvent) => void
  /** 生成助手消息（dsh-llm 的 createAssistantMessage），测试时可以替换。 */
  createAssistantMessage: (text: string, source: { provider: string; model: string }) => unknown
  now?: () => number
}

/** 用到的 llm 服务子集。 */
export interface LlmLike {
  stream(options: {
    provider: string
    model: string
    reasoningEffort?: string
    system?: string
    messages: unknown[]
    signal?: AbortSignal
    purpose?: string
  }): AsyncIterable<LlmChunk>
  resolveModelInfo(provider: string, model: string, signal?: AbortSignal): Promise<{ name: string }>
}

/** 流式输出的块（只列 PromptX 用到的字段）。 */
export type LlmChunk =
  | { type: 'text-delta'; index: number; text: string }
  | { type: 'finish'; reason: { kind: 'stop' | 'tool-calls' | 'max-tokens' } | { kind: 'aborted' | 'error'; failure: { code: string; message: string } } }
  | { type: string }

export interface OptimizeApi {
  start(text: string): Promise<OptimizeSession>
  followup(text: string): Promise<OptimizeSession>
  retry(roundId: string): Promise<OptimizeSession>
  cancel(): OptimizeSession | null
  clear(): void
  state(): OptimizeSession | null
  dispose(): void
}

// ───────────────────────────── 运行时（src/companion/runtime.ts） ─────────────────────────────

export interface RuntimeManagerOptions {
  /** `<dsh>/promptx/runtime` */
  root: string
  getSource: () => RuntimeSource
  /** 本 profile 的名字和哈希：运行时目录在所有 profile 间共享，用租约记下谁在用哪个版本。 */
  profile: { name: string; hash: string }
  platform?: string
  arch?: string
  /** 测试时替换下载地址；默认是镜像和 GitHub Releases。 */
  baseUrls?: { mirror: string; official: string }
  /** 测试时替换版本和校验值。 */
  release?: { version: string; file: string; sha256: string; size: number }
  /** 测试时替换解压实现。默认：macOS ditto、Windows tar.exe、Linux unzip。 */
  extract?: (zipFile: string, destDir: string) => Promise<void>
  fetch?: typeof fetch
  logger?: HostLogger
  /** 超时（毫秒），测试时调小。 */
  timeouts?: { connectMs?: number; stallMs?: number }
  /** 至少要有的空闲磁盘空间（字节）。 */
  requiredFreeBytes?: number
}

export interface RuntimeInstall {
  /** Electron 可执行文件的绝对路径。 */
  executable: string
  /** 版本目录。 */
  dir: string
}

export interface RuntimeApi {
  status(): RuntimeStatus
  /**
   * 确保运行时可用：已安装就直接返回；否则下载、校验、解压。同一时间只有一个任务，重复调用共享结果。
   * 暂停状态（删除运行时之后）下不下载，抛 promptx/runtime/download-failed 并保持 missing。
   */
  ensure(signal?: AbortSignal): Promise<RuntimeInstall>
  /** 解除暂停（配置页「下载」「重试」）。 */
  resume(): void
  /** 小程序启动前登记租约，退出后释放；清理和删除不会动有存活租约的版本。 */
  acquireLease(version: string, pid: number): Promise<void>
  releaseLease(): Promise<void>
  /**
   * 删除运行时（调用方先停本 profile 的小程序）。其他 profile 的存活租约所在的版本不删，返回它们；
   * 之后进入暂停状态。
   */
  remove(): Promise<{ removed: string[]; inUseBy: Array<{ profile: string; version: string }> }>
  onChange(listener: (status: RuntimeStatus) => void): () => void
  dispose(): void
}

// ───────────────────────────── 小程序进程（src/companion/supervisor.ts） ─────────────────────────────

/** Host 一侧的协议端：发 Host 的请求和通知，处理小程序的请求和通知。 */
export type HostPeer = RpcPeer<HostRequests, HostNotifications, CompanionRequests, CompanionNotifications>

export interface LaunchSpec {
  executable: string
  args: string[]
  env: Record<string, string>
}

export interface SupervisorOptions {
  /** 每次启动前调用：确保运行时可用并给出启动命令（运行时没准备好时会等待）。stop() 时 signal 被中止。 */
  prepareLaunch: (signal: AbortSignal) => Promise<LaunchSpec>
  /** 进程启动后（拿到 pid）和退出后调用，用于登记、释放运行时租约。 */
  onProcess?: (event: { type: 'spawned'; pid: number } | { type: 'exited'; pid: number }) => void
  /**
   * 每次建立新连接时调用，用来注册请求和通知的处理函数（每个新 peer 都要注册一遍）。
   * hello 由监管器自己处理（核对协议版本、标记 running），不要在这里注册。
   */
  attach: (peer: HostPeer) => void
  /** 生成 hello 的回复（协议版本由监管器核对，这里只需要给出配置）。 */
  helloResult: () => Omit<HelloResult, 'protocol'>
  /** 握手完成（hello 已回复）后调用。 */
  onReady?: (peer: HostPeer) => void
  onStateChange?: (state: CompanionState, error: ErrorInfo | undefined) => void
  logger?: HostLogger
  /** 时序参数（毫秒），测试时调小。 */
  timings?: {
    handshakeMs?: number
    heartbeatMs?: number
    heartbeatTimeoutMs?: number
    heartbeatMissLimit?: number
    restartWindowMs?: number
    restartLimit?: number
    backoffMs?: number[]
    shutdownGraceMs?: number
    exitWaitMs?: number
    killWaitMs?: number
  }
}

export interface SupervisorApi {
  state(): CompanionState
  error(): ErrorInfo | undefined
  /** 是否因为连续失败停止了自动重启。 */
  restartsExhausted(): boolean
  /** 当前已握手的 peer；没有时为 null。 */
  peer(): HostPeer | null
  start(): void
  /** 停止（总时长受 timings 控制，默认 ≤ 4 秒）。之后不会自动重启。 */
  stop(reason: string): Promise<void>
  /** 手动重启：重置失败计数。 */
  restart(): Promise<void>
}
