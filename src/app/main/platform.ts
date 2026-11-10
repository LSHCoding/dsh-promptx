// 主进程用到的 Electron 能力，写成接口：app.ts 只依赖这些接口，测试传假实现，
// 真正的 Electron 调用集中在 electron-platform.ts（薄适配，不放逻辑）。

import type { BridgeEventName } from '../../shared/bridge.ts'
import type { Rect } from '../../shared/layout.ts'
import type { ClipboardLike } from './clipboard.ts'
import type { IpcMainLike } from './ipc.ts'
import type { ShortcutBackend } from './shortcut-manager.ts'
import type { TrayAction, TrayModel } from './tray-model.ts'
import type { ControlledWindow } from './window-controller.ts'

/**
 * 窗口事件。moved、resized 由适配层按平台对上：macOS、Windows 用 Electron 的 moved / resized，
 * Linux 上没有这两个事件，换成 move / resize（拖动过程中会连续触发，偏好本来就防抖 500 ms 再写）。
 */
export type WindowEventName =
  | 'show'
  | 'hide'
  | 'focus'
  | 'blur'
  | 'moved'
  | 'resized'
  | 'will-move'
  | 'will-resize'
  | 'unresponsive'
  | 'responsive'

export interface MainWindow extends ControlledWindow {
  getBounds(): Rect
  setBounds(bounds: Rect): void
  setMinimumSize(width: number, height: number): void
  setBackgroundColor(color: string): void
  setTitle(title: string): void
  destroy(): void
  /** 发事件给渲染进程；webContents 已销毁时什么都不做。 */
  send(event: BridgeEventName, payload: unknown): void
  /** IPC 消息是否来自这个窗口自己的 webContents。 */
  isSender(sender: unknown): boolean
  /** 重新加载界面（渲染进程崩溃后）。 */
  reload(): void
  /** 和系统发起的关闭（Alt+F4、窗口管理器的关闭键）走同一条路：先发 close 事件，没被阻止才真的关。冒烟测试用。 */
  close(): void
  isDestroyed(): boolean
  on(event: WindowEventName, listener: () => void): void
  /** 窗口要关闭（系统发起的关闭、Alt+F4）；调用 prevent() 阻止。 */
  onClose(listener: (prevent: () => void) => void): void
  /** render-process-gone，参数是 details.reason。 */
  onRendererGone(listener: (reason: string) => void): void
}

export interface TrayHandle {
  update(model: TrayModel): void
  destroy(): void
}

export interface WindowCreateOptions {
  width: number
  height: number
  backgroundColor: string
  parent?: MainWindow
  entryEditor?: boolean
}

export interface MessageBoxOptions {
  title: string
  message: string
  buttons: string[]
  defaultId: number
  cancelId: number
}

export interface CompanionPlatform {
  readonly platform: string
  readonly arch: string
  readonly argv: readonly string[]
  readonly electronVersion: string
  readonly appVersion: string
  readonly pid: number
  /** 单调时钟（毫秒），只用于计算耗时和间隔。 */
  now(): number
  whenReady(): Promise<void>
  exit(code: number): void
  /** macOS：app.setActivationPolicy('accessory') 并隐藏 Dock 图标。其他平台什么都不做。 */
  becomeAccessory(): void
  /** 只有「编辑」菜单的应用菜单：没有 Dock 图标的应用也要能用 ⌘C、⌘V、⌘A。 */
  installEditMenu(): void
  /** 以下三个只在 macOS 上有作用。 */
  appShow(): void
  appHide(): void
  appFocusSteal(): void
  /** 以下四个只在 app ready 之后调用（nativeTheme、系统语言在 ready 之前不保证可用）。 */
  preferredLanguages(): string[]
  systemDark(): boolean
  setThemeSource(theme: 'light' | 'dark' | 'system'): void
  onThemeUpdated(listener: () => void): void
  /** screen 模块只能在 app ready 之后用。 */
  displays(): { workArea: Rect }[]
  cursorWorkArea(): Rect
  primaryWorkArea(): Rect
  workAreaFor(bounds: Rect): Rect
  readonly clipboard: ClipboardLike
  openExternal(url: string): Promise<void>
  readonly shortcuts: ShortcutBackend & { unregisterAll(): void }
  /** macOS 上读系统快捷键的 plist XML；其他平台没有。 */
  readonly readSystemHotkeys: (() => Promise<string | null>) | undefined
  readonly ipc: IpcMainLike
  /** 建好隐藏的窗口并开始加载界面。 */
  createWindow(options: WindowCreateOptions): MainWindow
  showMessageBox(window: MainWindow, options: MessageBoxOptions): Promise<number>
  /** 建不出来（例如桌面环境没有托盘）时返回 null。 */
  createTray(onAction: (action: TrayAction) => void): TrayHandle | null
  onBeforeQuit(listener: (prevent: () => void) => void): void
  onSignal(listener: (signal: string) => void): void
  isProcessAlive(pid: number): boolean
}
