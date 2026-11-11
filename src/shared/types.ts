// Host、Client、小程序共用的数据类型。这里只放类型，不放实现，也不 import node、DOM、React、Electron。

/** 业务错误。code 形如 `promptx/<领域>/<原因>`（见 errors.ts）；detail 只放系统错误信息，不放用户内容。 */
export interface ErrorInfo {
  code: string
  detail?: string
}

/** 编辑区的选区，按字符偏移（CodeMirror 的位置）。 */
export interface TextSelection {
  anchor: number
  head: number
}

// ───────────────────────────── Prompt 库 ─────────────────────────────

/** 文件夹选择：全部、未分类（只含库根目录下的文件）、某个真实文件夹（含所有子文件夹）。 */
export type FolderSel =
  | { kind: 'all' }
  | { kind: 'root' }
  | { kind: 'folder'; path: string }

/** 分段筛选：全部、最近 30 天、收藏。 */
export type LibraryScope = 'all' | 'recent' | 'favorites'

/** 列表里一条 Prompt 的元数据。不含正文。 */
export interface EntryMeta {
  /** 库根目录下的相对路径，正斜杠分隔，例如 `写作/评审/评审意见.md`。 */
  relPath: string
  /** 所在文件夹的相对路径；库根目录是空串。 */
  folder: string
  id: string | null
  title: string
  tags: string[]
  favorite: boolean
  /** 排序和相对时间用的更新时间（毫秒）：front matter 的 `updated`，解析不了时用文件修改时间。 */
  updatedAt: number
  /** front matter 的 `created`（毫秒），没有或解析不了时为 null。 */
  createdAt: number | null
  /**
   * ok：正常；unreadable：超过 2 MiB、不是 UTF-8 或读取失败，不能打开、插入、复制；
   * invalid-meta：front matter 写坏了，按没有 front matter 显示，插件不改写这个文件。
   */
  status: 'ok' | 'unreadable' | 'invalid-meta'
  /** status 为 unreadable 时的原因。 */
  unreadableReason?: 'too-large' | 'not-utf8' | 'read-failed'
  hasFrontMatter: boolean
}

export interface LibraryListParams {
  folder: FolderSel
  scope: LibraryScope
  /** null 表示全部标签。 */
  tag: string | null
  query: string
  /** true 时先刷新索引（展开侧栏时）；搜索输入时为 false，只查询。 */
  refresh: boolean
}

export interface LibraryListResult {
  /** ok：可用；missing：库目录还不存在（列表为空）；unavailable：不可读或不是目录。 */
  state: 'ok' | 'missing' | 'unavailable'
  error?: ErrorInfo
  /** 库根目录的绝对路径（显示用）。 */
  root: string
  /** 所有子文件夹的相对路径（含空文件夹），按名称排序。 */
  folders: string[]
  /** 库里出现过的所有标签，按名称排序。 */
  tags: string[]
  /** 符合条件的条目，已排好序。 */
  entries: EntryMeta[]
  /** 库里的条目总数（不论筛选），用于区分「还没有保存的 Prompt」和「没有匹配的 Prompt」。 */
  total: number
}

/** 文件版本：文件全部字节的 SHA-256 和字节数。两者都相同才算没被外部修改。 */
export interface FileVersion {
  sha256: string
  size: number
}

export interface LibraryReadResult {
  entry: EntryMeta
  /** 正文，CRLF、CR 已统一成 LF。 */
  body: string
  version: FileVersion
}

/** 草稿与库文件的绑定。 */
export interface Binding {
  /** 绑定时的库目录（绝对路径）。库目录变了就解除绑定。 */
  libraryDir: string
  relPath: string
  id: string | null
  title: string
  sha256: string
  size: number
  /** 载入或上次保存时的正文（LF），用于判断「已保存 / 未保存」。 */
  savedBody: string
}

/** normal：按绑定状态保存；saveAsNew：另存为库根目录下的新 Prompt；addFrontMatter：用户确认后给没有 front matter 的文件补上再保存。 */
export type SaveMode = 'normal' | 'saveAsNew' | 'addFrontMatter'

export type SaveConflict = 'modified' | 'missing' | 'noFrontMatter' | 'invalidFrontMatter'

export type SaveResult =
  | { kind: 'saved'; binding: Binding; entry: EntryMeta; created: boolean }
  | { kind: 'conflict'; conflict: SaveConflict }

export interface PromptMetadata {
  title: string
  tags: string[]
}

export interface MetaPatch {
  title?: string
  tags?: string[]
  favorite?: boolean
}

export type MetaConflict = 'modified' | 'missing' | 'noFrontMatter' | 'invalidFrontMatter' | 'unsupportedLayout'

/**
 * before 是 Host 读到并在其上修改的版本，after 是写入后的版本。小窗据此更新绑定：
 * 改的是绑定的文件且 before 等于绑定记下的版本时，把绑定的版本换成 after（并更新标题）；
 * 否则绑定不动，下次保存照常弹「文件已被外部修改」（design-spec 6.1）。
 */
export type MetaResult =
  | { kind: 'saved'; entry: EntryMeta; before: FileVersion; after: FileVersion }
  | { kind: 'conflict'; conflict: MetaConflict }

// ───────────────────────────── 回收站 ─────────────────────────────

export interface TrashEntry {
  /** `_trash/` 下的文件名。 */
  file: string
  title: string
  /** 删除时间（毫秒）；没有记录时为 null。 */
  deletedAt: number | null
  /** 原来的相对路径；没有记录（原位置未知）时为 null。 */
  originalPath: string | null
}

export interface TrashListResult {
  /** 回收站记录文件读不出来时为 unreadable，此时所有条目都是「原位置未知」。 */
  recordState: 'ok' | 'missing' | 'unreadable'
  entries: TrashEntry[]
}

export type RestoreTarget = 'original' | 'alternative'

export type RestoreResult =
  | { kind: 'restored'; relPath: string }
  | { kind: 'occupied'; alternative: string }
  | { kind: 'modified' }
  | { kind: 'missing' }

// ───────────────────────────── 草稿 ─────────────────────────────

export interface EntryMetadataDraft {
  title: string
  tags: string
  savedTags: string[]
}

export interface DraftRecord {
  version: 1
  text: string
  selection: TextSelection | null
  binding: Binding | null
  entryMetadata?: EntryMetadataDraft
  /** ISO 8601 UTC。 */
  updatedAt: string
}

// ───────────────────────────── 优化 ─────────────────────────────

export interface OptimizeModel {
  provider: string
  model: string
  /** dsh 返回的显示名，取不到时是模型 id。 */
  name: string
}

export interface OptimizeRound {
  id: string
  kind: 'initial' | 'followup'
  input: string
  status: 'running' | 'done' | 'failed' | 'cancelled'
  reply: string
  /** 完成后从回复里提取的候选；提取不到时为 null。 */
  candidate: string | null
  error?: ErrorInfo
}

export interface OptimizeSession {
  id: string
  model: OptimizeModel
  rounds: OptimizeRound[]
}

export type OptimizeEvent =
  | { type: 'session'; session: OptimizeSession | null }
  | { type: 'delta'; sessionId: string; roundId: string; text: string }
  /**
   * 第一轮在收到任何文本前以「没有可用模型」类错误结束：会话已丢弃，小窗收起会话栏，
   * 只在底栏提示（需求 O-01「不开始会话」）。
   */
  | { type: 'discarded'; sessionId: string; error: ErrorInfo }

// ───────────────────────────── 配置与状态 ─────────────────────────────

/** 插件配置（dsh 的 Config）。字段全部 volatile，修改不重启插件。 */
export interface PromptxConfig {
  /** 空串表示默认的 `<dsh 数据目录>/promptx/library`。 */
  libraryDir: string
  confirmDelete: boolean
  convertMiddleDot: boolean
  convertYen: boolean
  /** 空白表示用默认指令。 */
  optimizeInstruction: string
  /** Electron 加速键写法，例如 `Control+P`；空串表示不注册全局快捷键。 */
  globalShortcut: string
  hideOnBlur: boolean
  runtimeSource: RuntimeSource
}

export type RuntimeSource = 'auto' | 'mirror' | 'official'

/** Host 推给小程序的配置。 */
export interface CompanionConfig {
  globalShortcut: string
  hideOnBlur: boolean
  confirmDelete: boolean
  convertMiddleDot: boolean
  convertYen: boolean
  /** null 表示跟随系统语言。 */
  locale: 'zh' | 'en' | null
  theme: 'light' | 'dark' | 'system'
  /** 展开后的库目录绝对路径，用于判断绑定是否还有效。 */
  libraryDir: string
  profile: string
}

/**
 * 约定：改快捷键时新组合登记失败，会退回旧组合——此时 registered 为 true、accelerator 是旧组合（和配置不同），
 * 并带 error 或 warning 说明新组合为什么没生效。
 */
export interface ShortcutStatus {
  accelerator: string
  /** 是否在系统里登记成功。macOS 的登记不是独占的，成功也可能和别的应用冲突（见 warning）。 */
  registered: boolean
  /** 没有登记的原因：组合不合法、登记失败、已被另一个 profile 的 PromptX 使用。 */
  error?: ErrorInfo
  /** 登记成功但可能冲突：与 macOS 的系统快捷键相同。 */
  warning?: ErrorInfo
}

/** 小程序上报给 Host 的状态。 */
export interface CompanionStatus {
  /** 没有配置全局快捷键时为 null。 */
  shortcut: ShortcutStatus | null
  tray: boolean
  visible: boolean
  /**
   * 小窗界面实际用的语言。dsh 没有语言偏好、也没有页面上报过时，小窗跟随系统语言，Host 看不到系统语言列表，
   * 优化的默认指令和「未命名 Prompt」按这里的值取（需求 O-08，design-spec 4.7）。
   */
  locale: 'zh' | 'en'
  /** 界面进程崩溃后正在重新加载时是 promptx/companion/renderer-gone（detail 是崩溃原因）；界面就绪后为 null（design-spec 5.4）。 */
  rendererError: ErrorInfo | null
}

export type RuntimeState = 'unsupported' | 'missing' | 'downloading' | 'extracting' | 'ready' | 'failed'

/**
 * 约定：state 为 downloading 但没有 received 时，表示在等另一个 dsh 进程完成下载（它持有下载锁）。
 */
export interface RuntimeStatus {
  state: RuntimeState
  version: string
  /** 删除运行时后暂停自动下载，直到用户点「下载」或下次插件启动。 */
  paused?: boolean
  /** 正在使用某个运行时版本的其他 profile（删除运行时被拒绝时显示）。 */
  inUseBy?: Array<{ profile: string; version: string }>
  /** 当前或最后一次使用的下载源。 */
  source?: 'mirror' | 'official'
  received?: number
  total?: number
  error?: ErrorInfo
  /** 运行时目录（显示用）。 */
  dir: string
}

export type CompanionState = 'stopped' | 'waiting-runtime' | 'starting' | 'running' | 'restarting' | 'failed'

/** 配置页长轮询拿到的完整状态。 */
export interface PanelStatus {
  seq: number
  config: PromptxConfig
  effectiveLibraryDir: string
  defaultShortcut: string
  defaultInstruction: { zh: string; en: string }
  runtime: RuntimeStatus
  companion: {
    state: CompanionState
    error?: ErrorInfo
    restartsExhausted?: boolean
  }
  shortcut: ShortcutStatus | null
  /**
   * 最近一次「打开配置页」请求：seq 是序号，ageMs 是请求发出至今的毫秒数（由 Host 计算，不传绝对时间，
   * 远程浏览器的时钟可能不同）。页面看到比自己处理过的更大的 seq 且 ageMs < 60000 时切到插件页。
   */
  navigate: { seq: number; ageMs: number } | null
  /** 平台（`process.platform`），配置页按它显示快捷键写法。 */
  platform: string
  /** 同一个 profile 已有另一个 dsh 进程在运行 PromptX 时为 duplicate：这个进程不打开草稿、不启动小程序。 */
  instance: 'active' | 'duplicate'
  /** 小程序进程号（运行中时），手工验收时用来结束进程。 */
  companionPid?: number
}

export type ConfigFieldError =
  | 'library-dir-relative'
  | 'library-dir-reserved'
  | 'library-dir-skills'
  | 'shortcut-invalid'
  | 'value-invalid'

export type ConfigUpdateResult =
  | { ok: true }
  | { ok: false; errors: Partial<Record<keyof PromptxConfig, ConfigFieldError>>; error?: ErrorInfo }
