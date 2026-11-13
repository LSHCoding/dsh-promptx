// 小窗渲染进程能用的接口：预加载脚本用 contextBridge 暴露为 window.promptx。
// 渲染进程不能直接访问 Node 和 Electron，只能经过这些白名单方法；主进程再核对消息来源，
// 数据类请求转给 Host（见 protocol.ts 的 RENDERER_FORWARDED_METHODS）。

import type { CompanionRequests, RendererForwardedMethod } from './protocol.ts'
import { folderOf, normalizeTagPhrases } from './library-rules.ts'
import type {
  Binding,
  CompanionConfig,
  ConfigUpdateResult,
  EntryMetadataDraft,
  ErrorInfo,
  FolderSel,
  LibraryScope,
  OptimizeEvent,
  PromptMetadata,
  PromptxConfig,
  SaveConflict,
  SettingsData,
  SettingsSection,
  ShortcutStatus,
  TextSelection,
} from './types.ts'

/** 小窗偏好，存在 `<dsh 数据目录>/promptx/prefs.json`，由主进程写入。 */
export interface Prefs {
  version: 1
  window: { x: number; y: number; width: number; height: number } | null
  /** 聊天栏展开时实际渲染的编辑区宽度。小程序重新启动时用它重建无聊天栏的窗口。 */
  editorWidth: number | null
  panes: {
    library: boolean
    folderWidth: number
    listWidth: number
    previewHeight: number
    sessionWidth: number
  }
  library: {
    folder: FolderSel
    scope: LibraryScope
    tag: string | null
  }
}

export const DEFAULT_PREFS: Prefs = {
  version: 1,
  window: null,
  editorWidth: null,
  panes: { library: true, folderWidth: 150, listWidth: 300, previewHeight: 232, sessionWidth: 420 },
  library: { folder: { kind: 'all' }, scope: 'all', tag: null },
}

/** 主进程推给渲染进程的事件。 */
export interface BridgeEvents {
  /** 独立编辑窗口的完整状态；正文和绑定不写入主窗口的草稿。 */
  'entryEditor.state': EntryEditorSnapshot
  /** 设置窗口的完整状态（V0.1.6）。 */
  'settings.state': SettingsSnapshot
  /** 设置窗口正在录制快捷键时按下了已登记的全局快捷键：系统先拦下了这次按键，由主进程转来作为录到的组合。 */
  'settings.shortcutPressed': { accelerator: string }
  /** Host 推来的配置；外观里的「跟随系统」已由主进程解析成具体的语言和明暗。 */
  'config': ResolvedConfig
  'optimize.event': OptimizeEvent
  'library.changed': { libraryDir: string }
  /** 同一库的条目内容有更新，只刷新列表，不改变主草稿的来源或保存重试代次。 */
  'library.entriesChanged': { libraryDir: string }
  /** 小窗刚显示：渲染进程把焦点放回编辑区。 */
  'window.shown': Record<string, never>
  /** 小窗刚隐藏。 */
  'window.hidden': Record<string, never>
  /** 主进程要退出或隐藏前请求立即写回草稿；渲染进程写完后调用 flushed(id)。 */
  'flush': { id: number }
  /** 端到端测试命令（只在 e2e 模式下发送），渲染进程处理后调用 e2eDone。 */
  'e2e': { id: number; action: string; text?: string; size?: number; metadata?: PromptMetadata; folder?: string }
}

export type BridgeEventName = keyof BridgeEvents

/** 渲染进程拿到的配置：在 CompanionConfig 基础上补了解析后的语言和明暗。 */
export interface ResolvedConfig extends CompanionConfig {
  resolvedLocale: 'zh' | 'en'
  resolvedTheme: 'light' | 'dark'
}

export type BridgeResult<T> = { ok: true; value: T } | { ok: false; error: ErrorInfo }

/** 同一时刻一个库条目编辑窗口；主进程保管目标和原始文件版本。 */
export interface EntryEditorSnapshot {
  /** 仅 open/恢复/明确 reload 替换文档时递增；保存回包不可覆盖用户后续输入。 */
  generation: number
  /** 切换/重新载入/关闭前的只读屏障；子窗回传最终内容后主进程才继续。 */
  freezeId: number | null
  binding: Binding
  text: string
  selection: TextSelection | null
  metadata: EntryMetadataDraft
  folders: string[]
  config: ResolvedConfig | null
  saving: boolean
  error: ErrorInfo | null
  conflict: SaveConflict | null
  recovered: boolean
}

export type EntryMetadataFields = Pick<EntryMetadataDraft, 'title' | 'tags' | 'folder'>

export function entryFolderPatch(binding: Binding, fields: EntryMetadataFields): string | undefined {
  return fields.folder === folderOf(binding.relPath) ? undefined : fields.folder
}

/** 正文保存只带实际改动的元数据，保留历史标签和原来的 front matter 写法。 */
export function entryMetadataPatch(snapshot: EntryEditorSnapshot, fields: EntryMetadataFields): Partial<PromptMetadata> {
  const patch: Partial<PromptMetadata> = {}
  const title = fields.title.trim()
  if (title !== snapshot.binding.title) patch.title = title
  if (fields.tags !== snapshot.metadata.savedTags.join(', ')) {
    const tags = normalizeTagPhrases([fields.tags])
    const savedTags = snapshot.metadata.savedTags
    if (tags.length !== savedTags.length || tags.some((tag, index) => tag !== savedTags[index])) patch.tags = tags
  }
  return patch
}

export function isEntryDirty(snapshot: EntryEditorSnapshot, text: string, metadata: EntryMetadataFields): boolean {
  return text !== snapshot.binding.savedBody || entryFolderPatch(snapshot.binding, metadata) !== undefined ||
    Object.keys(entryMetadataPatch(snapshot, metadata)).length > 0
}

export interface EntryEditorBridge {
  /** 仅主窗口可调用。已有未保存编辑时先确认，再切换条目。 */
  open(relPath: string): Promise<BridgeResult<null>>
  /** 以下方法只接受独立编辑窗口的 sender。 */
  getState(): Promise<BridgeResult<EntryEditorSnapshot>>
  update(text: string, selection: TextSelection, generation: number, metadata?: EntryMetadataFields): void
  prepared(id: number, generation: number, text: string, selection: TextSelection, metadata?: EntryMetadataFields): void
  save(generation: number): Promise<BridgeResult<null>>
  /** 外部版本冲突时，由用户明确操作后重新载入，载入前确认放弃修改。 */
  reload(generation: number): Promise<BridgeResult<null>>
  /** 尚未读回状态时可不带代次；有状态时携带代次，避免旧界面关闭新条目。 */
  close(generation?: number): Promise<void>
}

/** 设置窗口的状态，由主进程组装：Host 给的配置和说明，加上小程序自己知道的快捷键登记结果和版本。 */
export interface SettingsSnapshot {
  /** Host 给的配置和说明；还没取到或取失败时为 null。 */
  data: SettingsData | null
  /** 最近一次取数失败的原因；取到后为 null。 */
  error: ErrorInfo | null
  /** 小程序登记全局快捷键的结果（菜单栏状态行用的是同一份）；没有配置快捷键时为 null。 */
  shortcut: ShortcutStatus | null
  /** 小程序运行的 Electron 版本。 */
  electronVersion: string
  /** 外观：语言和明暗已按系统解析好。 */
  config: ResolvedConfig | null
  /** 入口要求显示的分区。seq 递增，页面只在看到更大的 seq 时切换，用户自己切的分区不会被之后的刷新冲掉。 */
  section: { seq: number; section: SettingsSection }
}

/** 设置窗口的接口（V0.1.6）。只接受设置窗口自己的 webContents。 */
export interface SettingsBridge {
  getState(): Promise<BridgeResult<SettingsSnapshot>>
  /** 提交改动，Host 校验后写入；字段错误放在结果里。 */
  update(patch: Partial<PromptxConfig>): Promise<BridgeResult<ConfigUpdateResult>>
  /** 弹出系统的选择文件夹对话框；取消时为 null。 */
  chooseLibraryDir(): Promise<BridgeResult<string | null>>
  /** 在文件管理器里打开当前生效的库目录（路径由主进程决定，不由页面传入）。 */
  openLibraryDir(): Promise<BridgeResult<null>>
  /** 打开 dsh 插件页里 PromptX 的配置页（原来的「设置」流程），之后隐藏小窗。navigated 表示已有 dsh 页面切过去。 */
  openInDsh(): Promise<BridgeResult<{ navigated: boolean }>>
  /** 开始或结束录制快捷键：录制期间全局快捷键不切换小窗。 */
  setRecording(active: boolean): void
  close(): Promise<void>
}

export interface WindowBounds {
  x: number
  y: number
  width: number
  height: number
  /** 小窗所在屏幕的可用区域。 */
  workArea: { x: number; y: number; width: number; height: number }
}

export interface PromptxBridge {
  entryEditor: EntryEditorBridge
  settings: SettingsBridge
  /** 运行平台（process.platform）。 */
  readonly platform: string
  /** 把请求转给 Host。失败时 Promise 以 { ok: false, error } 结束，不抛异常。 */
  call<M extends RendererForwardedMethod>(method: M, params: CompanionRequests[M]['params']): Promise<BridgeResult<CompanionRequests[M]['result']>>
  /** 订阅主进程事件，返回取消订阅的函数。 */
  on<E extends BridgeEventName>(event: E, listener: (payload: BridgeEvents[E]) => void): () => void
  /** 界面已挂载、草稿已读回（冒烟测试和性能统计用）。 */
  ready(info: { editorMounted: boolean; draftLoaded: boolean }): void
  /** 响应 flush 事件。 */
  flushed(id: number): void
  /** 响应 e2e 事件。 */
  e2eDone(id: number, result: { ok: boolean; data: Record<string, unknown> }): void
  /** 当前配置（主进程收到 hello 回复后才有；之前为 null）。 */
  getConfig(): Promise<ResolvedConfig | null>
  window: {
    /** 隐藏小窗并把焦点还给原来的应用。 */
    hide(): Promise<void>
    /** 写剪贴板（纯文本），成功后隐藏小窗。写入失败时不隐藏。 */
    copyAndHide(text: string): Promise<BridgeResult<null>>
    /** 只写剪贴板，不隐藏（复制候选、复制正文）。 */
    copyText(text: string): Promise<BridgeResult<null>>
    getBounds(): Promise<WindowBounds>
    /** 调整宽度（5.7 的空间分配），保持在屏幕可用区域内；返回实际宽度和 x。 */
    setWidth(width: number, anchor: 'left' | 'right'): Promise<WindowBounds>
    /** 打开设置窗口（V0.1.6），可指定分区。 */
    openSettings(section?: SettingsSection): Promise<BridgeResult<null>>
    /** 按打开的栏位调整窗口的最小宽度（5.7：打开的栏位最小宽度之和，不超过屏幕可用区域）。 */
    setMinWidth(width: number): void
  }
  prefs: {
    get(): Promise<Prefs>
    /** 合并写入（主进程防抖后落盘）。 */
    set(patch: Partial<Pick<Prefs, 'editorWidth' | 'panes' | 'library'>>): void
  }
}

/** 预加载脚本挂到 window 上的属性名。 */
export const BRIDGE_KEY = 'promptx'
