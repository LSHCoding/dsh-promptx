// 小窗界面的总控（技术方案 5.5）：组装各模块，接主进程的事件，处理核心路径上的操作
// （复制并隐藏、隐藏、清空、保存）和窗口级快捷键。React 组件只读状态、调用这里的方法。

import type { BridgeEvents, PromptxBridge, ResolvedConfig } from '../../../shared/bridge.ts'
import { DEFAULT_PREFS, type Prefs } from '../../../shared/bridge.ts'
import { PANE_LIMITS } from '../../../shared/layout.ts'
import { resolveLocale } from '../../../shared/i18n/index.ts'
import { isBlank } from '../../../shared/text-metrics.ts'
import type { ErrorInfo, SettingsSection } from '../../../shared/types.ts'
import { isComposingKey } from '../appearance.ts'
import { createEditorController, type EditorController } from '../editor/controller.ts'
import { focusWithin, nothingFocused } from '../focus.ts'
import { matchWindowCommand } from '../shortcuts.ts'
import { initialState, type AppState, type DialogResult, type FocusRequest, type MenuState, type PaneSizes } from '../state/state.ts'
import { createStore, type Store } from '../state/store.ts'
import { failure, reason, runTask, text, type Context } from './context.ts'
import { Dialogs } from './dialogs.ts'
import { Draft } from './draft.ts'
import { PaneLayout } from './layout.ts'
import { Library } from './library.ts'
import { CONFIRM_METADATA_BUTTON, LibrarySave, type SaveOutcome } from './library-save.ts'
import { Optimize } from './optimize.ts'
import { Toasts } from './toasts.ts'

export interface AppControllerOptions {
  bridge: PromptxBridge
  /** 测试可以换成自己的编辑区；默认用 CodeMirror。 */
  editor?: EditorController
  /** 拿到配置之前用的语言和明暗（主进程在 hello 回复之后才有配置）。 */
  locale?: 'zh' | 'en'
  theme?: 'light' | 'dark'
}

export interface CopyOutcome {
  ok: boolean
  error?: ErrorInfo
}

/** 键盘事件里窗口级快捷键用到的字段。 */
export interface WindowKeyEvent {
  key: string
  code: string
  keyCode: number
  isComposing: boolean
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
  metaKey: boolean
  preventDefault(): void
  stopPropagation(): void
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(Math.max(value, min), max)
}

/** 偏好里的栏宽可能被手改过：收紧到需求 5.7 的范围内。 */
export function clampPaneSizes(sizes: PaneSizes): PaneSizes {
  return {
    folderWidth: clamp(sizes.folderWidth, PANE_LIMITS.folder.min, PANE_LIMITS.folder.max),
    listWidth: clamp(sizes.listWidth, PANE_LIMITS.list.min, 4096),
    previewHeight: clamp(sizes.previewHeight, PANE_LIMITS.preview.min, 4096),
    sessionWidth: clamp(sizes.sessionWidth, PANE_LIMITS.session.min, PANE_LIMITS.session.max),
  }
}

export class AppController {
  readonly store: Store<AppState>
  readonly bridge: PromptxBridge
  readonly editor: EditorController
  readonly toasts: Toasts
  readonly dialogs: Dialogs
  readonly layout: PaneLayout
  readonly draft: Draft
  readonly saver: LibrarySave
  readonly library: Library
  readonly optimize: Optimize
  private readonly ctx: Context
  private readonly subscriptions: Array<() => void> = []
  private focusSeq = 0
  private focusHandled = 0
  private editorReady = false
  /** 草稿第一次载入的结果；null 表示还没结束。 */
  private draftLoaded: boolean | null = null
  private reportedReady: boolean | null = null
  private started = false

  constructor(options: AppControllerOptions) {
    const platform = options.bridge.platform
    const locale = options.locale ?? 'zh'
    this.store = createStore(initialState(platform, locale, options.theme ?? 'light'))
    this.bridge = options.bridge
    this.editor = options.editor ?? createEditorController({
      platform,
      placeholder: '',
      ariaLabel: '',
    })
    this.ctx = { store: this.store, bridge: this.bridge, editor: this.editor }
    this.toasts = new Toasts(this.store)
    this.dialogs = new Dialogs(this.store)
    this.layout = new PaneLayout(this.ctx)
    this.draft = new Draft(this.ctx, (loaded) => {
      this.onDraftLoaded(loaded)
    })
    this.saver = new LibrarySave(this.ctx, this.draft, this.toasts, this.dialogs, () => {
      if (this.store.getState().library.open) runTask(this.library.refresh(false))
    })
    this.library = new Library(this.ctx, this.draft, this.toasts, this.dialogs, this.layout, () => {
      this.requestFocus('search')
    })
    this.optimize = new Optimize(this.ctx, this.toasts, this.dialogs, this.layout, () => {
      this.focusFollowupIfIdle()
    })
    this.applyLabels()
  }

  /** 订阅主进程事件，读配置、偏好、草稿和优化会话。 */
  async start(): Promise<void> {
    if (this.started) return
    this.started = true
    const { bridge } = this
    this.subscriptions.push(
      bridge.on('config', (config) => {
        this.applyConfig(config)
      }),
      bridge.on('optimize.event', (event) => {
        this.optimize.onEvent(event)
      }),
      bridge.on('library.changed', ({ libraryDir }) => {
        runTask(this.library.onLibraryChanged(libraryDir))
      }),
      bridge.on('library.entriesChanged', ({ libraryDir }) => {
        const state = this.store.getState()
        if (state.config?.libraryDir !== libraryDir || !state.library.open) return
        // 条目编辑只刷新库内容，主草稿的保存标记和未知创建请求保持原样。
        runTask(this.library.reload())
      }),
      bridge.on('window.shown', () => {
        this.onShown()
      }),
      bridge.on('window.hidden', () => {
        this.onHidden()
      }),
      bridge.on('flush', ({ id }) => {
        runTask(this.flushFor(id))
      }),
      bridge.on('e2e', (command) => {
        runTask(this.runE2e(command))
      }),
    )
    this.layout.syncMinWidth()
    await Promise.all([
      this.loadConfig(),
      this.loadPrefs(),
      this.draft.load(),
      this.optimize.restore(),
    ])
  }

  dispose(): void {
    for (const unsubscribe of this.subscriptions.splice(0)) unsubscribe()
    this.saver.dispose()
    this.dialogs.dispose()
    this.toasts.dispose()
    this.draft.dispose()
    this.library.dispose()
  }

  // ───────────────────────────── 启动 ─────────────────────────────

  private async loadConfig(): Promise<void> {
    try {
      const config = await this.bridge.getConfig()
      if (config !== null) this.applyConfig(config)
    } catch {
      // 拿不到配置时沿用启动时的语言和明暗，等主进程推 config 事件。
    }
  }

  private async loadPrefs(): Promise<void> {
    let prefs: Prefs = DEFAULT_PREFS
    try {
      prefs = await this.bridge.prefs.get()
    } catch {
      // 偏好读不出来时用默认值（技术方案 7.6）。
    }
    const { panes, library } = prefs
    this.store.update(state => ({
      ...state,
      panes: clampPaneSizes(panes),
      library: { ...state.library, folder: library.folder, scope: library.scope, tag: library.tag },
    }))
    if (panes.library) {
      this.layout.restoreOpen('library')
      await this.library.refresh(true)
    }
  }

  private applyConfig(config: ResolvedConfig): void {
    this.store.update(state => ({ ...state, config, locale: config.resolvedLocale, theme: config.resolvedTheme }))
    this.editor.setInputConversions({ middleDot: config.convertMiddleDot, yen: config.convertYen })
    this.applyLabels()
    this.draft.checkLibraryDir(config.libraryDir)
  }

  private applyLabels(): void {
    this.editor.setLabels({ placeholder: text(this.ctx, 'editor.placeholder'), ariaLabel: text(this.ctx, 'editor.label') })
  }

  /** 编辑区挂到页面上之后由界面调用。 */
  editorMounted(): void {
    this.editorReady = true
    this.reportReady()
  }

  private onDraftLoaded(loaded: boolean): void {
    this.draftLoaded = loaded
    this.reportReady()
    // 载入期间小窗已经显示：读回后把焦点交给编辑区，用户可以直接打字。
    if (loaded && typeof document !== 'undefined' && document.hasFocus()) this.editor.focus()
  }

  /** 界面已挂载、草稿已读回（冒烟测试和性能统计用）。读取失败后重试成功时再报一次。 */
  private reportReady(): void {
    if (!this.editorReady || this.draftLoaded === null || this.reportedReady === this.draftLoaded) return
    this.reportedReady = this.draftLoaded
    this.bridge.ready({ editorMounted: true, draftLoaded: this.draftLoaded })
  }

  retryLoad(): Promise<void> {
    return this.draft.load()
  }

  // ───────────────────────────── 窗口事件 ─────────────────────────────

  /**
   * 每次呼出焦点都先给编辑区（F-01、L-02），侧栏和会话栏保持原样。
   * 隐藏前还开着的对话框例外：对话框是模态的，焦点留在对话框里，编辑区抢走焦点后 Esc、Tab 都对不上。
   */
  private onShown(): void {
    if (this.dialogs.isOpen()) return
    this.editor.focus()
  }

  private onHidden(): void {
    // 正文读取完成前隐藏了小窗：这次插入作废（L-06）。
    this.library.cancelInsert()
    this.closeMenu()
    this.draft.flushSoon()
  }

  /** 主进程退出或隐藏前请求立即写回草稿，写完后回复（技术方案 5.2「停止」、5.3 shutdown）。 */
  private async flushFor(id: number): Promise<void> {
    try {
      await Promise.all([
        this.layout.settled().then(() => {
          this.layout.persistEditorWidth()
        }),
        this.draft.saver.flush(),
      ])
    } finally {
      this.bridge.flushed(id)
    }
  }

  // ───────────────────────────── 核心路径 ─────────────────────────────

  /**
   * 复制并隐藏（F-03）：草稿为空时不复制、不隐藏；否则立即保存草稿（不等结果），写剪贴板，写成功后主进程隐藏小窗。
   * 写剪贴板失败时不隐藏，提示原因，草稿不变。
   */
  async copyAndHide(): Promise<CopyOutcome> {
    this.toasts.beginAction()
    this.closeMenu()
    const body = this.editor.getText()
    if (isBlank(body)) {
      this.toasts.error(text(this.ctx, 'toast.nothingToCopy'))
      return { ok: false }
    }
    this.library.cancelInsert()
    this.draft.flushSoon()
    const result = await this.bridge.window.copyAndHide(body)
    if (!result.ok) {
      this.toasts.error(text(this.ctx, 'toast.copyFailed', { reason: reason(this.ctx, result.error) }))
      return { ok: false, error: result.error }
    }
    this.toasts.success(text(this.ctx, 'toast.copied'))
    return { ok: true }
  }

  /** 隐藏小窗并把焦点还给原来的应用；不清空草稿，不打断优化（F-01）。 */
  async hide(): Promise<void> {
    this.library.cancelInsert()
    this.closeMenu()
    this.draft.flushSoon()
    await this.bridge.window.hide()
  }

  /** 清空（E-04）：一步可以撤销；解除绑定，撤销时内容回来但绑定不回来；库文件不受影响。 */
  clear(): void {
    this.toasts.beginAction()
    if (!this.draft.ready || isBlank(this.editor.getText())) return
    const binding = this.draft.binding
    this.editor.replaceAll('')
    this.draft.setBinding(null, true)
    this.draft.flushSoon()
    this.toasts.success(binding === null
      ? text(this.ctx, 'toast.cleared')
      : text(this.ctx, 'toast.clearedBound', { title: binding.title }))
    this.editor.focus()
  }

  save(): Promise<SaveOutcome> {
    this.toasts.beginAction()
    this.closeMenu()
    return this.saver.save()
  }

  saveAsNew(): Promise<SaveOutcome> {
    this.toasts.beginAction()
    this.closeMenu()
    return this.saver.saveAsNew()
  }

  /** 工具栏「设置」、「打开设置」快捷键、库侧栏的「打开设置」：打开 PromptX 自己的设置窗口（V0.1.6），小窗不隐藏。 */
  async openSettings(section?: SettingsSection): Promise<void> {
    this.toasts.beginAction()
    this.closeMenu()
    this.draft.flushSoon()
    const result = await this.bridge.window.openSettings(section)
    if (!result.ok) {
      // 「无法打开设置：{原因}」的前缀就是 settings/unavailable 自己的文案，认不出原因时不再说两遍（审查 CR-04）。
      this.toasts.error(failure(this.ctx, 'toast.settingsFailed', 'promptx/settings/unavailable', result.error))
    }
  }

  /** 切换库侧栏前收起弹出菜单。 */
  async libraryShortcut(): Promise<void> {
    this.closeMenu()
    await this.library.toggle()
  }

  // ───────────────────────────── 窗口级快捷键 ─────────────────────────────

  /**
   * 窗口级快捷键（技术方案 5.5），在捕获阶段处理，先于编辑区和输入框。输入法组字中一律放行；
   * 对话框打开时交给对话框自己处理。⌘↩ 在追加输入框里也是复制编辑区内容，不会发起新一轮（F-03）。
   */
  handleKeydown(event: WindowKeyEvent): void {
    if (isComposingKey(event)) return
    if (this.dialogs.isOpen()) {
      // 对话框打开时只处理 Esc（等于取消，O-04 等于「保持当前内容」）；Tab、Enter 由对话框自己处理。
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        this.dialogs.escape()
      }
      return
    }
    const { config, platform, menu } = this.store.getState()
    if (menu !== null && event.key === 'Escape' && !event.ctrlKey && !event.altKey && !event.shiftKey && !event.metaKey) {
      event.preventDefault()
      event.stopPropagation()
      this.closeMenu()
      return
    }
    const command = matchWindowCommand(event, platform, config?.windowShortcuts)
    if (command === null) return
    event.preventDefault()
    event.stopPropagation()
    switch (command) {
      case 'hide':
        runTask(this.hide())
        return
      case 'copyAndHide':
        runTask(this.copyAndHide())
        return
      case 'save':
        runTask(this.save())
        return
      case 'library':
        runTask(this.libraryShortcut())
        return
      case 'optimize':
        this.closeMenu()
        runTask(this.optimize.toggle())
        return
      case 'clear':
        this.closeMenu()
        this.clear()
        return
      case 'chat':
        this.closeMenu()
        runTask(this.optimize.togglePane())
        return
      case 'settings':
        runTask(this.openSettings())
        return
    }
  }

  // ───────────────────────────── 界面状态 ─────────────────────────────

  resolveDialog(id: number, result: DialogResult): void {
    this.dialogs.resolve(id, result)
  }

  escapeDialog(): void {
    this.dialogs.escape()
  }

  dismissToast(id: number): void {
    this.toasts.dismiss(id)
  }

  openMenu(id: string, anchor: MenuState['anchor']): void {
    this.store.update(state => ({ ...state, menu: { id, anchor } }))
  }

  closeMenu(): void {
    this.store.update(state => (state.menu === null ? state : { ...state, menu: null }))
  }

  requestFocus(target: FocusRequest['target']): void {
    const focus: FocusRequest = { target, seq: ++this.focusSeq }
    this.store.update(state => ({ ...state, focus }))
  }

  /** 组件处理焦点请求前调用：同一个请求只处理一次（组件重新挂载时不会再抢一次焦点）。 */
  takeFocus(request: FocusRequest): boolean {
    if (request.seq <= this.focusHandled) return false
    this.focusHandled = request.seq
    return true
  }

  /** 一轮结束时：焦点原本在会话栏里，或小窗里没有焦点，才把焦点放到追加输入框（O-05）。 */
  private focusFollowupIfIdle(): void {
    if (!this.store.getState().optimize.paneOpen) return
    if (focusWithin('session') || nothingFocused()) this.requestFocus('followup')
  }

  /** 拖动分隔线时更新栏宽；松开时 commit 写进偏好。 */
  resizePanes(patch: Partial<PaneSizes>): void {
    this.store.update(state => ({ ...state, panes: clampPaneSizes({ ...state.panes, ...patch }) }))
  }

  commitPaneSizes(): void {
    const state = this.store.getState()
    this.bridge.prefs.set({ panes: { library: state.library.open, ...state.panes } })
  }

  // ───────────────────────────── 端到端测试 ─────────────────────────────

  /**
   * 端到端测试命令（只在 e2e 模式下由主进程发来），走和用户操作完全相同的路径。
   * 回复里只有耗时、状态和长度，不带正文（N-02：日志和测试结果里不出现 Prompt 内容）。
   */
  private async runE2e(command: BridgeEvents['e2e']): Promise<void> {
    let result: E2eReply
    try {
      result = await this.e2eAction(command)
    } catch (error) {
      result = { ok: false, data: { error: error instanceof Error ? error.name : 'unknown' } }
    }
    this.bridge.e2eDone(command.id, result)
  }

  private async e2eAction(command: BridgeEvents['e2e']): Promise<E2eReply> {
    const state = this.store.getState()
    const body = command.text
    switch (command.action) {
      case 'core-path': {
        if (!this.draft.ready) return { ok: false, data: { error: 'draft-not-loaded' } }
        this.editor.replaceAll(body ?? '')
        const started = performance.now()
        const outcome = await this.copyAndHide()
        const copyMs = performance.now() - started
        // 脚本接着会检查草稿记录文件，等这次立即保存落盘后再回复。
        await this.draft.saver.flush()
        return {
          ok: outcome.ok,
          data: { copyMs, error: outcome.error?.code ?? null, draftSaveError: this.store.getState().draft.saveError?.code ?? null },
        }
      }
      case 'save-to-library':
        return this.e2eSave(command.id)
      case 'typing-latency':
        return this.measureTyping(e2eSize(command))
      case 'toggle-chat': {
        if (typeof document === 'undefined') return { ok: false, data: {} }
        const label = text(this.ctx, 'toolbar.session')
        const button = [...document.querySelectorAll<HTMLButtonElement>('.px-toolbar button')]
          .find(item => item.getAttribute('aria-label') === label)
        if (button === undefined) return { ok: false, data: {} }
        button.click()
        await this.layout.settled()
        return { ok: this.store.getState().optimize.paneOpen !== state.optimize.paneOpen, data: {} }
      }
      case 'state': {
        const column = typeof document === 'undefined' ? null : document.querySelector('.px-editor-column')
        const toolbar = column?.querySelector('.px-toolbar')
        return {
          ok: true,
          data: {
            draftLoaded: state.draft.load === 'ready',
            textLength: this.editor.getText().length,
            status: this.draft.currentStatus(),
            boundRelPath: state.draft.binding?.relPath ?? null,
            libraryOpen: state.library.open,
            sessionOpen: state.optimize.paneOpen,
            chatComposerReady: typeof document !== 'undefined' && document.querySelector('.px-followup-input') !== null,
            chatShortcut: state.config?.windowShortcuts.shortcutChat ?? null,
            editorWidth: column?.getBoundingClientRect().width ?? null,
            toolbarInEditor: toolbar !== undefined && toolbar !== null
              && toolbar.getBoundingClientRect().width === column?.getBoundingClientRect().width,
          },
        }
      }
      default:
        return { ok: false, data: { error: 'unknown-action' } }
    }
  }

  /** 隔离测试可用手填路径保存，不依赖真实模型。 */
  private async e2eSave(id: number): Promise<E2eReply> {
    let metadataFallback = false
    let handledDialog: number | undefined
    const stop = this.store.subscribe(() => {
      const { dialog } = this.store.getState()
      if (dialog?.defaultButton !== CONFIRM_METADATA_BUTTON || dialog.form === undefined || dialog.id === handledDialog) return
      handledDialog = dialog.id
      const { form } = dialog
      const fallback = form.title === ''
      metadataFallback ||= fallback
      queueMicrotask(() => {
        this.resolveDialog(dialog.id, dialog.error !== undefined
          ? { button: dialog.escapeButton }
          : {
            button: CONFIRM_METADATA_BUTTON,
            form: fallback ? { title: `E2E Prompt ${id}`, tags: 'E2E Save' } : form,
          })
      })
    })
    const started = performance.now()
    try {
      const outcome = await this.save()
      const ms = performance.now() - started
      return { ok: outcome === 'saved', data: { outcome, ms, relPath: this.saver.lastSavedRelPath, metadataFallback } }
    } finally {
      stop()
    }
  }

  /**
   * N-01「草稿 100,000 字符时，按键到字符出现 ≤ 50 ms」：换成 size 字的草稿，等它画完，再在文末输入一个字，
   * 量到下一帧画完的耗时；量完换回原来的草稿。和用户打字一样经过编辑区的完整更新（自动保存、字符数计时都会触发）。
   */
  private async measureTyping(size: number): Promise<E2eReply> {
    if (!this.draft.ready) return { ok: false, data: { error: 'draft-not-loaded' } }
    const previous = { text: this.editor.getText(), selection: this.editor.getSelection() }
    const filler = fillerText(size)
    this.editor.load(filler, null)
    await nextPaint()
    const started = performance.now()
    this.editor.dispatch({
      changes: { from: filler.length, insert: 'x' },
      selection: { anchor: filler.length + 1 },
      userEvent: 'input.type',
    })
    const painted = await nextPaint()
    const ms = performance.now() - started
    this.editor.load(previous.text, previous.selection)
    return { ok: true, data: { ms, size: filler.length, painted } }
  }
}

export interface E2eReply {
  ok: boolean
  data: Record<string, unknown>
}

/** typing-latency 命令的草稿长度。主进程转来的事件可能带 size，也可能只把它放在 text 里；都没有时按 N-01 的 10 万字。 */
function e2eSize(command: BridgeEvents['e2e']): number {
  const raw: unknown = (command as BridgeEvents['e2e'] & { size?: unknown }).size ?? command.text
  const size = Number(raw)
  return Number.isSafeInteger(size) && size > 0 ? Math.min(size, 1_000_000) : 100_000
}

function fillerText(size: number): string {
  const line = '这是一行用来测量输入延迟的文字，内容没有意义。\n'
  return line.repeat(Math.ceil(size / line.length)).slice(0, size)
}

/**
 * 等到下一帧画完。窗口隐藏时 Chromium 不出帧，requestAnimationFrame 不会回调，所以只等一个宏任务，
 * 并在结果里说明没有等到绘制（painted: false），由测试脚本判断。
 */
function nextPaint(): Promise<boolean> {
  return new Promise((resolve) => {
    if (typeof document === 'undefined' || document.visibilityState !== 'visible' || typeof requestAnimationFrame !== 'function') {
      setTimeout(() => {
        resolve(false)
      }, 0)
      return
    }
    let done = false
    const finish = (painted: boolean) => {
      if (done) return
      done = true
      resolve(painted)
    }
    // rAF 回调在绘制之前；再排一个宏任务，量到这一帧真正画完之后。
    requestAnimationFrame(() => {
      setTimeout(() => {
        finish(true)
      }, 0)
    })
    // 兜底：窗口在等待期间被隐藏时 rAF 不再回调。
    setTimeout(() => {
      finish(false)
    }, 1000)
  })
}

/** 拿到配置之前的语言：跟随系统（主进程拿到 dsh 的语言后会推 config）。 */
export function fallbackLocale(): 'zh' | 'en' {
  return resolveLocale(typeof navigator === 'undefined' ? null : navigator.language)
}
