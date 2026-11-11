// 小窗的显示、隐藏与切换（需求 F-01、F-02、Q19，design-spec 5.4、D10）。
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
  /** show 事件之后多久把「所有空间可见」关掉。 */
  workspaceResetDelayMs?: number
}

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
  readonly #workspaceResetDelayMs: number

  #showToken = 0
  /** 已经排过「关闭所有空间可见」的那一次显示的代号。 */
  #scheduledToken = 0
  #workspaceTimer: ReturnType<typeof setTimeout> | null = null
  #workspaceFallback: ReturnType<typeof setTimeout> | null = null
  #disposed = false

  constructor(options: WindowControllerOptions) {
    this.#mac = options.platform === 'darwin'
    this.#window = options.window
    this.#app = options.app
    this.#beforeShow = options.beforeShow
    this.#onShown = options.onShown
    this.#onHidden = options.onHidden
    this.#logger = options.logger
    this.#workspaceResetDelayMs = options.workspaceResetDelayMs ?? 50
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

  /** 全局快捷键和菜单栏按可见状态切换，失焦后再次按下也能收起小窗。 */
  toggle(reason: string): void {
    if (this.visible) this.hide(reason)
    else this.show(reason)
  }

  dispose(): void {
    this.#disposed = true
    this.#cancelWorkspaceReset()
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
}
