// 小窗的显示、隐藏、切换与失焦隐藏（需求 F-01、F-02、Q19，design-spec 5.4、D10）。
// 窗口和 app 都通过接口传进来，测试用假对象记录调用顺序；主进程里传 BrowserWindow 和 app 的适配。
//
// macOS 显示序列（不用 type: 'panel'，它会让窗口出现在所有桌面空间）：
//   setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true })
//   → app.show() → win.show() → win.focus() → app.focus({ steal: true })
//   窗口 show 事件之后约 50 ms：setVisibleOnAllWorkspaces(false, { visibleOnFullScreen: true, skipTransformProcessType: true })
// 第一步让窗口出现在当前空间（包括全屏应用的空间），最后一步让它留在这个空间、切换空间时不跟着走。
// 两次都必须带 visibleOnFullScreen: true：第二次不带的话 Electron 按 false 处理，会清掉 FullScreenAuxiliary，
// 小窗就不能留在全屏应用上方。skipTransformProcessType 避免进程类型来回切换让 Dock 图标闪出来。
// 隐藏：win.hide() 后 app.hide()，系统把激活状态还给呼出前的应用。Windows、Linux 只 show/focus、hide，焦点由系统决定。

import { errorCode, type CompanionLogger } from './logger.ts'

export interface WorkspaceOptions {
  visibleOnFullScreen: boolean
  skipTransformProcessType: boolean
}

export interface ControlledWindow {
  isVisible(): boolean
  isFocused(): boolean
  show(): void
  hide(): void
  focus(): void
  setVisibleOnAllWorkspaces(visible: boolean, options: WorkspaceOptions): void
  /** 只听下一次 show 事件。 */
  onceShow(listener: () => void): void
}

export interface ControlledApp {
  show(): void
  hide(): void
  /** app.focus({ steal: true }) */
  focusSteal(): void
}

export interface WindowControllerOptions {
  platform: string
  window: ControlledWindow
  app: ControlledApp
  /** 从隐藏变为显示之前调用：挪回可见位置、按所在屏幕设最小尺寸。已经可见时不调用，不挪动用户正在看的窗口。 */
  beforeShow: () => void
  onShown: (reason: string) => void
  onHidden: (reason: string) => void
  logger: CompanionLogger
  now?: () => number
  /** show 事件之后多久把「所有空间可见」关掉。 */
  workspaceResetDelayMs?: number
  /** 失焦后多久判断要不要隐藏。 */
  blurCheckDelayMs?: number
  /** 拖动、缩放窗口也会触发 blur：最近这么久内有过 will-move / will-resize 时不因失焦隐藏。 */
  moveGuardMs?: number
  /** 非模态条目编辑子窗拿到焦点时，父窗失焦不能触发自动隐藏。 */
  isRelatedFocused?: () => boolean
}

export type ToggleResult = 'shown' | 'focused' | 'hidden'

const MAC_WORKSPACE_OPTIONS: WorkspaceOptions = { visibleOnFullScreen: true, skipTransformProcessType: true }

/** show 事件迟迟不来（极少见）时，最多等这么久也要把「所有空间可见」关掉，否则小窗会跟着切换空间。 */
const WORKSPACE_RESET_FALLBACK_MS = 1000

export class WindowController {
  readonly #mac: boolean
  readonly #window: ControlledWindow
  readonly #app: ControlledApp
  readonly #beforeShow: () => void
  readonly #onShown: (reason: string) => void
  readonly #onHidden: (reason: string) => void
  readonly #logger: CompanionLogger
  readonly #now: () => number
  readonly #workspaceResetDelayMs: number
  readonly #blurCheckDelayMs: number
  readonly #moveGuardMs: number
  readonly #isRelatedFocused: () => boolean

  #hideOnBlur = false
  #modalOpen = false
  #lastMoveAt = Number.NEGATIVE_INFINITY
  #showToken = 0
  /** 已经排过「关闭所有空间可见」的那一次显示的代号。 */
  #scheduledToken = 0
  #workspaceTimer: ReturnType<typeof setTimeout> | null = null
  #workspaceFallback: ReturnType<typeof setTimeout> | null = null
  #blurTimer: ReturnType<typeof setTimeout> | null = null
  #disposed = false

  constructor(options: WindowControllerOptions) {
    this.#mac = options.platform === 'darwin'
    this.#window = options.window
    this.#app = options.app
    this.#beforeShow = options.beforeShow
    this.#onShown = options.onShown
    this.#onHidden = options.onHidden
    this.#logger = options.logger
    this.#now = options.now ?? (() => performance.now())
    this.#workspaceResetDelayMs = options.workspaceResetDelayMs ?? 50
    this.#blurCheckDelayMs = options.blurCheckDelayMs ?? 100
    this.#moveGuardMs = options.moveGuardMs ?? 500
    this.#isRelatedFocused = options.isRelatedFocused ?? (() => false)
  }

  get visible(): boolean {
    return this.#window.isVisible()
  }

  get focused(): boolean {
    return this.#window.isFocused()
  }

  /** 显示并把焦点给小窗。已经可见时同样走一遍：可见但没焦点、或在别的桌面空间时，把它带到当前空间并拿回焦点。 */
  show(reason: string): void {
    if (this.#disposed) return
    this.#cancelBlurCheck()
    const wasVisible = this.#window.isVisible()
    if (!wasVisible) {
      try {
        this.#beforeShow()
      } catch (error) {
        // 位置算不出来也要显示：用窗口当前的位置。
        this.#logger.warn('window.place-failed', { error: errorCode(error) })
      }
    }
    if (this.#mac) {
      this.#showMac(wasVisible)
    } else {
      this.#window.show()
      this.#window.focus()
    }
    this.#onShown(reason)
  }

  hide(reason: string): void {
    if (this.#disposed) return
    this.#cancelBlurCheck()
    if (!this.#window.isVisible()) return
    this.#window.hide()
    if (this.#mac) {
      // 显示后 50 ms 内就隐藏（复制并隐藏很快）：那一步还没做，现在补上，窗口不留在「所有空间可见」的状态里。
      if (this.#workspaceTimer !== null || this.#workspaceFallback !== null) {
        this.#cancelWorkspaceReset()
        this.#window.setVisibleOnAllWorkspaces(false, MAC_WORKSPACE_OPTIONS)
      }
      this.#app.hide()
    }
    this.#onHidden(reason)
  }

  /** 全局快捷键：可见且有焦点 → 隐藏；可见但没有焦点 → 拿回焦点；不可见 → 显示。 */
  toggle(reason: string): ToggleResult {
    if (!this.#window.isVisible()) {
      this.show(reason)
      return 'shown'
    }
    if (this.#window.isFocused()) {
      this.hide(reason)
      return 'hidden'
    }
    this.show(reason)
    return 'focused'
  }

  setHideOnBlur(on: boolean): void {
    this.#hideOnBlur = on
    if (!on) this.#cancelBlurCheck()
  }

  setModalOpen(open: boolean): void {
    this.#modalOpen = open
  }

  /** 窗口 will-move / will-resize。 */
  noteMoveOrResize(): void {
    this.#lastMoveAt = this.#now()
  }

  /**
   * 窗口 blur。不立即隐藏，稍等一下再判断：拖动窗口时 blur 可能先于 will-move 到达，
   * 也可能只是焦点在窗口内部的短暂切换（系统菜单弹出又收起）。判断时窗口已经拿回焦点就不隐藏。
   */
  handleBlur(): void {
    if (!this.#hideOnBlur || this.#disposed) return
    this.#cancelBlurCheck()
    this.#blurTimer = setTimeout(() => {
      this.#blurTimer = null
      if (this.#shouldHideAfterBlur()) this.hide('blur')
    }, this.#blurCheckDelayMs)
  }

  handleFocus(): void {
    this.#cancelBlurCheck()
  }

  dispose(): void {
    this.#disposed = true
    this.#cancelBlurCheck()
    this.#cancelWorkspaceReset()
  }

  #shouldHideAfterBlur(): boolean {
    if (!this.#hideOnBlur || this.#modalOpen || this.#isRelatedFocused()) return false
    if (!this.#window.isVisible() || this.#window.isFocused()) return false
    return this.#now() - this.#lastMoveAt >= this.#moveGuardMs
  }

  #showMac(wasVisible: boolean): void {
    this.#cancelWorkspaceReset()
    const token = ++this.#showToken
    if (!wasVisible) {
      // 先挂好 show 监听再显示：show 事件可能在 win.show() 里同步发出。
      this.#window.onceShow(() => {
        this.#scheduleWorkspaceReset(token)
      })
      this.#workspaceFallback = setTimeout(() => {
        this.#workspaceFallback = null
        this.#scheduleWorkspaceReset(token)
      }, WORKSPACE_RESET_FALLBACK_MS)
    }
    this.#window.setVisibleOnAllWorkspaces(true, MAC_WORKSPACE_OPTIONS)
    this.#app.show()
    this.#window.show()
    this.#window.focus()
    this.#app.focusSteal()
    // 已经可见的窗口不会再收到 show 事件，直接排上关闭「所有空间可见」的那一步。
    if (wasVisible) this.#scheduleWorkspaceReset(token)
  }

  #scheduleWorkspaceReset(token: number): void {
    // 旧的显示序列留下的 show 监听、已经排过的这一次：都不再排。
    if (token !== this.#showToken || token === this.#scheduledToken || this.#disposed) return
    this.#scheduledToken = token
    if (this.#workspaceFallback !== null) {
      clearTimeout(this.#workspaceFallback)
      this.#workspaceFallback = null
    }
    this.#workspaceTimer = setTimeout(() => {
      this.#workspaceTimer = null
      if (this.#disposed) return
      this.#window.setVisibleOnAllWorkspaces(false, MAC_WORKSPACE_OPTIONS)
    }, this.#workspaceResetDelayMs)
  }

  #cancelWorkspaceReset(): void {
    if (this.#workspaceTimer !== null) clearTimeout(this.#workspaceTimer)
    if (this.#workspaceFallback !== null) clearTimeout(this.#workspaceFallback)
    this.#workspaceTimer = null
    this.#workspaceFallback = null
  }

  #cancelBlurCheck(): void {
    if (this.#blurTimer !== null) clearTimeout(this.#blurTimer)
    this.#blurTimer = null
  }
}
