// 小窗渲染进程能用的接口：预加载脚本用 contextBridge 暴露为 window.promptx。
// 渲染进程不能直接访问 Node 和 Electron，只能经过这些白名单方法；主进程再核对消息来源，
// 数据类请求转给 Host（见 protocol.ts 的 RENDERER_FORWARDED_METHODS）。

import type { CompanionRequests, RendererForwardedMethod } from './protocol.ts'
import type { Binding, CompanionConfig, ErrorInfo, FolderSel, LibraryScope, OptimizeEvent, SaveConflict, TextSelection } from './types.ts'

/** 小窗偏好，存在 `<dsh 数据目录>/promptx/prefs.json`，由主进程写入。 */
export interface Prefs {
  version: 1
  window: { x: number; y: number; width: number; height: number } | null
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
  panes: { library: false, folderWidth: 150, listWidth: 300, previewHeight: 232, sessionWidth: 420 },
  library: { folder: { kind: 'all' }, scope: 'all', tag: null },
}

/** 主进程推给渲染进程的事件。 */
export interface BridgeEvents {
  /** 独立编辑窗口的完整状态；正文和绑定不写入主窗口的草稿。 */
  'entryEditor.state': EntryEditorSnapshot
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
  'e2e': { id: number; action: string; text?: string; size?: number }
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
  config: ResolvedConfig | null
  saving: boolean
  error: ErrorInfo | null
  conflict: SaveConflict | null
  recovered: boolean
}

export interface EntryEditorBridge {
  /** 仅主窗口可调用。已有未保存编辑时先确认，再切换条目。 */
  open(relPath: string): Promise<BridgeResult<null>>
  /** 以下方法只接受独立编辑窗口的 sender。 */
  getState(): Promise<BridgeResult<EntryEditorSnapshot>>
  update(text: string, selection: TextSelection, generation: number): void
  prepared(id: number, generation: number, text: string, selection: TextSelection): void
  save(generation: number): Promise<BridgeResult<null>>
  /** 外部版本冲突时，由用户明确操作后重新载入，载入前确认放弃修改。 */
  reload(generation: number): Promise<BridgeResult<null>>
  /** 尚未读回状态时可不带代次；有状态时携带代次，避免旧界面关闭新条目。 */
  close(generation?: number): Promise<void>
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
    /** 打开 dsh 插件页里 PromptX 的配置页，然后隐藏小窗。 */
    openSettings(): Promise<BridgeResult<{ navigated: boolean }>>
    /** 对话框打开或关闭；打开期间失焦不自动隐藏。 */
    setModalOpen(open: boolean): void
    /** 按打开的栏位调整窗口的最小宽度（5.7：打开的栏位最小宽度之和，不超过屏幕可用区域）。 */
    setMinWidth(width: number): void
  }
  prefs: {
    get(): Promise<Prefs>
    /** 合并写入（主进程防抖后落盘）。 */
    set(patch: Partial<Pick<Prefs, 'panes' | 'library'>>): void
  }
}

/** 预加载脚本挂到 window 上的属性名。 */
export const BRIDGE_KEY = 'promptx'
