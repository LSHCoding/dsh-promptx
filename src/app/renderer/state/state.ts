// 小窗界面的状态分片（技术方案 5.5）：草稿与绑定、编辑区统计、库侧栏与回收站、栏宽、优化会话、对话框、提示、配置。
// 编辑区的正文不放在这里：它在 CodeMirror 的 EditorState 里，按键时只更新编辑器，不触发 React 渲染（N-01）。

import type { ResolvedConfig } from '../../../shared/bridge.ts'
import { DEFAULT_PREFS } from '../../../shared/bridge.ts'
import type { Locale } from '../../../shared/i18n/index.ts'
import type {
  Binding,
  EntryMeta,
  ErrorInfo,
  FolderSel,
  LibraryListResult,
  LibraryScope,
  OptimizeSession,
  TrashEntry,
  TrashListResult,
} from '../../../shared/types.ts'

/** 底栏的保存状态（E-03）。 */
export type SaveStatus = 'blank' | 'unsaved' | 'saved'

export interface DraftSlice {
  /** 草稿是否已从插件读回（F-01）。读回之前编辑区不可编辑，也不发任何保存请求。 */
  load: 'loading' | 'ready' | 'error'
  loadError: ErrorInfo | null
  binding: Binding | null
  /** 最近一次草稿保存失败的原因；下一次保存成功前一直显示（E-02）。 */
  saveError: ErrorInfo | null
  /** 有一个 library.save 在途（L-08）。 */
  librarySaving: boolean
}

export interface EditorSlice {
  /** 输入停顿 150 ms 后才重算（技术方案 5.5），10 万字时不必每次按键都扫全文。 */
  chars: number
  status: SaveStatus
}

export interface PreviewSlice {
  relPath: string
  /** 读取中预览区留空，不显示不完整的内容（L-05）。 */
  status: 'loading' | 'ready' | 'error'
  entry: EntryMeta
  body: string
  error: ErrorInfo | null
}

export interface TrashPreviewSlice {
  file: string
  status: 'loading' | 'ready' | 'error'
  entry: TrashEntry
  body: string
  error: ErrorInfo | null
}

export interface LibrarySlice {
  open: boolean
  /** 文件夹栏选中「回收站」时列表栏显示回收站（L-11）。 */
  view: 'library' | 'trash'
  folder: FolderSel
  scope: LibraryScope
  tag: string | null
  query: string
  list: LibraryListResult | null
  listError: ErrorInfo | null
  selected: string | null
  preview: PreviewSlice | null
  trash: TrashListResult | null
  trashError: ErrorInfo | null
  trashSelected: string | null
  trashPreview: TrashPreviewSlice | null
}

export interface PaneSizes {
  folderWidth: number
  listWidth: number
  previewHeight: number
  sessionWidth: number
}

export interface OptimizeSlice {
  session: OptimizeSession | null
  paneOpen: boolean
  /** 追加输入框里的文字。 */
  followup: string
}

export interface DialogButton {
  id: string
  label: string
  /** primary：主要动作的样式；danger：删除这类动作的样式。 */
  tone?: 'primary' | 'danger'
}

/** 重命名 / 标签对话框的输入框（L-09）。 */
export interface RenameForm {
  title: string
  tags: string
}

export interface DialogSpec {
  title: string
  message?: string
  /** 从左到右的顺序，跟随 dsh 的习惯：取消在左，主要动作在右。 */
  buttons: DialogButton[]
  /** 打开时焦点所在的按钮（技术方案 5.5 的表）。 */
  defaultButton: string
  /** Esc 等于哪个按钮。O-04 的对话框没有「取消」，Esc 等于「保持当前内容」。 */
  escapeButton: string
  form?: RenameForm
}

export interface DialogState extends DialogSpec {
  id: number
}

export interface DialogResult {
  button: string
  form?: RenameForm
}

export interface Toast {
  id: number
  /** success 约 2 秒后消失；error 一直显示，直到下一次操作或用户关掉（E-03）。 */
  kind: 'success' | 'error'
  text: string
}

export interface MenuState {
  id: string
  /** 菜单按钮在窗口里的位置，菜单贴着它的下沿弹出。 */
  anchor: { left: number; top: number; right: number; bottom: number }
}

/** 请某个输入区域拿到焦点；seq 每次加一，同一个目标连续请求也会生效。 */
export interface FocusRequest {
  target: 'search' | 'followup'
  seq: number
}

export interface AppState {
  platform: string
  locale: Locale
  theme: 'light' | 'dark'
  config: ResolvedConfig | null
  draft: DraftSlice
  editor: EditorSlice
  library: LibrarySlice
  panes: PaneSizes
  optimize: OptimizeSlice
  dialog: DialogState | null
  toast: Toast | null
  menu: MenuState | null
  focus: FocusRequest | null
}

export function initialState(platform: string, locale: Locale, theme: 'light' | 'dark'): AppState {
  const { panes, library } = DEFAULT_PREFS
  return {
    platform,
    locale,
    theme,
    config: null,
    draft: { load: 'loading', loadError: null, binding: null, saveError: null, librarySaving: false },
    editor: { chars: 0, status: 'blank' },
    library: {
      open: false,
      view: 'library',
      folder: library.folder,
      scope: library.scope,
      tag: library.tag,
      query: '',
      list: null,
      listError: null,
      selected: null,
      preview: null,
      trash: null,
      trashError: null,
      trashSelected: null,
      trashPreview: null,
    },
    panes: {
      folderWidth: panes.folderWidth,
      listWidth: panes.listWidth,
      previewHeight: panes.previewHeight,
      sessionWidth: panes.sessionWidth,
    },
    optimize: { session: null, paneOpen: false, followup: '' },
    dialog: null,
    toast: null,
    menu: null,
    focus: null,
  }
}
