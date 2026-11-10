// CompanionApp 集成测试用的假对象：平台（窗口、托盘、剪贴板、快捷键、IPC、屏幕）、扮演 Host 的协议端、扮演界面的渲染进程。
// 和真实 Electron 的行为对齐的几处：show() 在窗口原本隐藏时同步发 show 事件；close() 先发可阻止的 close 事件；
// 主进程发给渲染进程的消息异步送达、按发送顺序处理。

import { PassThrough } from 'node:stream'
import { IPC_CHANNELS } from '../../../src/app/main/channels.ts'
import type { ClipboardLike } from '../../../src/app/main/clipboard.ts'
import type { IpcEventLike, IpcMainLike } from '../../../src/app/main/ipc.ts'
import type { CompanionPlatform, MainWindow, MessageBoxOptions, TrayHandle, WindowCreateOptions, WindowEventName } from '../../../src/app/main/platform.ts'
import type { TrayAction, TrayModel } from '../../../src/app/main/tray-model.ts'
import type { WorkspaceOptions } from '../../../src/app/main/window-controller.ts'
import type { BridgeEventName, BridgeResult } from '../../../src/shared/bridge.ts'
import type { Rect } from '../../../src/shared/layout.ts'
import { encodeFrame, FrameDecoder } from '../../../src/shared/ndjson.ts'
import {
  COMPANION_NOTIFICATION_METHODS,
  MAX_FRAME_BYTES,
  PROTOCOL_VERSION,
  type CompanionNotifications,
  type CompanionRequests,
  type HelloParams,
  type HelloResult,
  type HostNotifications,
  type HostRequests,
} from '../../../src/shared/protocol.ts'
import { RpcPeer } from '../../../src/shared/rpc.ts'
import type { CompanionConfig } from '../../../src/shared/types.ts'

export const WORK_AREA: Rect = { x: 0, y: 25, width: 1440, height: 875 }

type Listener = () => void

export class FakeWindow implements MainWindow {
  visible = false
  focused = false
  destroyed = false
  bounds: Rect
  minimum = { width: 0, height: 0 }
  background: string
  readonly options: WindowCreateOptions
  readonly calls: string[] = []
  readonly sent: { event: BridgeEventName; payload: unknown }[] = []
  readonly sender = { id: 'own webContents' }
  /** 收到 send 时调用（FakeRenderer 挂在这里）。 */
  onSend: ((event: BridgeEventName, payload: unknown) => void) | null = null
  readonly #listeners = new Map<string, Listener[]>()
  #once: Listener[] = []
  readonly #close: ((prevent: () => void) => void)[] = []
  readonly #gone: ((reason: string) => void)[] = []

  constructor(options: WindowCreateOptions) {
    this.options = options
    this.background = options.backgroundColor
    this.bounds = { x: 100, y: 100, width: options.width, height: options.height }
  }

  isVisible(): boolean {
    return this.visible
  }

  isFocused(): boolean {
    return this.focused
  }

  show(): void {
    this.calls.push('show')
    if (this.visible) return
    this.visible = true
    this.emit('show')
    const once = this.#once
    this.#once = []
    for (const listener of once) listener()
  }

  hide(): void {
    this.calls.push('hide')
    if (!this.visible) return
    this.visible = false
    if (this.focused) {
      this.focused = false
      this.emit('blur')
    }
    this.emit('hide')
  }

  focus(): void {
    this.calls.push('focus')
    if (!this.visible || this.focused) return
    this.focused = true
    this.emit('focus')
  }

  /** 用户切到了别的应用。 */
  blur(): void {
    if (!this.focused) return
    this.focused = false
    this.emit('blur')
  }

  setVisibleOnAllWorkspaces(visible: boolean, options: WorkspaceOptions): void {
    this.calls.push(`workspaces:${visible}:${options.visibleOnFullScreen}`)
  }

  onceShow(listener: () => void): void {
    this.#once.push(listener)
  }

  getBounds(): Rect {
    return { ...this.bounds }
  }

  setBounds(bounds: Rect): void {
    this.calls.push('setBounds')
    this.bounds = { ...bounds }
  }

  setMinimumSize(width: number, height: number): void {
    this.minimum = { width, height }
  }

  setBackgroundColor(color: string): void {
    this.background = color
  }

  setTitle(title: string): void {
    this.calls.push(`title ${title}`)
  }

  destroy(): void {
    this.destroyed = true
    this.visible = false
  }

  send(event: BridgeEventName, payload: unknown): void {
    if (this.destroyed) return
    this.sent.push({ event, payload })
    this.onSend?.(event, payload)
  }

  isSender(sender: unknown): boolean {
    return sender === this.sender
  }

  reload(): void {
    this.calls.push('reload')
  }

  close(): void {
    this.calls.push('close')
    let prevented = false
    for (const listener of this.#close) {
      listener(() => {
        prevented = true
      })
    }
    if (prevented) return
    this.visible = false
    this.destroyed = true
  }

  isDestroyed(): boolean {
    return this.destroyed
  }

  on(event: WindowEventName, listener: () => void): void {
    const list = this.#listeners.get(event) ?? []
    list.push(listener)
    this.#listeners.set(event, list)
  }

  onClose(listener: (prevent: () => void) => void): void {
    this.#close.push(listener)
  }

  onRendererGone(listener: (reason: string) => void): void {
    this.#gone.push(listener)
  }

  emit(event: WindowEventName): void {
    for (const listener of this.#listeners.get(event) ?? []) listener()
  }

  rendererGone(reason: string): void {
    for (const listener of this.#gone) listener(reason)
  }

  /** 用户拖动了窗口。 */
  moveTo(x: number, y: number): void {
    this.emit('will-move')
    this.bounds = { ...this.bounds, x, y }
    this.emit('moved')
  }
}

export class FakeTray implements TrayHandle {
  readonly models: TrayModel[] = []
  destroyed = false

  update(model: TrayModel): void {
    this.models.push(model)
  }

  destroy(): void {
    this.destroyed = true
  }

  get last(): TrayModel | undefined {
    return this.models.at(-1)
  }

  statusLine(): string {
    const first = this.last?.items[0]
    return first?.kind === 'status' ? first.label : ''
  }
}

export class FakeClipboard implements ClipboardLike {
  text = 'previous clipboard'
  failWrite = false
  readonly writes: string[] = []

  writeText(text: string): Promise<void> {
    if (this.failWrite) return Promise.reject(new Error('clipboard busy'))
    this.writes.push(text)
    this.text = text
    return Promise.resolve()
  }

  readText(): Promise<string> {
    return Promise.resolve(this.text)
  }
}

export class FakeShortcuts {
  readonly registered = new Map<string, () => void>()
  readonly taken = new Set<string>()
  readonly calls: string[] = []

  register(accelerator: string, callback: () => void): boolean {
    this.calls.push(`register ${accelerator}`)
    if (this.taken.has(accelerator)) return false
    this.registered.set(accelerator, callback)
    return true
  }

  unregister(accelerator: string): void {
    this.calls.push(`unregister ${accelerator}`)
    this.registered.delete(accelerator)
  }

  unregisterAll(): void {
    this.calls.push('unregisterAll')
    this.registered.clear()
  }

  press(accelerator: string): void {
    const callback = this.registered.get(accelerator)
    if (callback === undefined) throw new Error(`${accelerator} is not registered`)
    callback()
  }
}

type IpcListener = (event: IpcEventLike, ...args: unknown[]) => unknown

export class FakeIpc implements IpcMainLike {
  readonly handlers = new Map<string, IpcListener>()
  readonly listeners = new Map<string, IpcListener>()

  handle(channel: string, listener: IpcListener): void {
    this.handlers.set(channel, listener)
  }

  on(channel: string, listener: IpcListener): void {
    this.listeners.set(channel, listener)
  }

  /** ipcRenderer.invoke：处理函数抛出时以拒绝结束。 */
  async invoke(sender: unknown, channel: string, ...args: unknown[]): Promise<unknown> {
    const handler = this.handlers.get(channel)
    if (handler === undefined) throw new Error(`no handler for ${channel}`)
    await Promise.resolve()
    return handler({ sender }, ...args)
  }

  send(sender: unknown, channel: string, ...args: unknown[]): void {
    const listener = this.listeners.get(channel)
    if (listener === undefined) throw new Error(`no listener for ${channel}`)
    listener({ sender }, ...args)
  }
}

export interface FakePlatformOptions {
  platform?: string
  languages?: string[]
  dark?: boolean
  argv?: string[]
  readSystemHotkeys?: () => Promise<string | null>
}

export class FakePlatform implements CompanionPlatform {
  readonly messageBoxes: MessageBoxOptions[] = []
  readonly messageBoxAnswers: number[] = []
  readonly platform: string
  readonly arch = 'arm64'
  readonly argv: readonly string[]
  readonly electronVersion = '44.10.2'
  readonly appVersion = '0.1.0'
  readonly pid = 4242
  readonly clipboard = new FakeClipboard()
  readonly shortcuts = new FakeShortcuts()
  readonly ipc = new FakeIpc()
  readonly readSystemHotkeys: (() => Promise<string | null>) | undefined
  readonly calls: string[] = []
  readonly windows: FakeWindow[] = []
  readonly opened: string[] = []
  languages: string[]
  dark: boolean
  themeSource = 'system'
  /** 平台的外观接口在 ready 之前被调用过：真实 Electron 里不保证可用。 */
  appearanceBeforeReady = false
  tray: FakeTray | null = null
  trayFails = false
  windowFails = false
  openFails = false
  alive = new Set<number>([4242])
  exitCode: number | null = null
  readonly exited: Promise<number>
  #resolveExit: (code: number) => void = () => {}
  #ready = false
  #resolveReady: () => void = () => {}
  readonly #readyPromise: Promise<void>
  #themeListeners: (() => void)[] = []
  #beforeQuit: ((prevent: () => void) => void)[] = []
  #signals: ((signal: string) => void)[] = []
  #trayAction: ((action: TrayAction) => void) | null = null

  constructor(options: FakePlatformOptions = {}) {
    this.platform = options.platform ?? 'darwin'
    this.argv = options.argv ?? ['/Applications/Electron.app/Contents/MacOS/Electron', '/lib/app', '--promptx-companion=abc']
    this.languages = options.languages ?? ['en-US']
    this.dark = options.dark ?? false
    this.readSystemHotkeys = options.readSystemHotkeys
    this.exited = new Promise<number>((resolve) => {
      this.#resolveExit = resolve
    })
    this.#readyPromise = new Promise<void>((resolve) => {
      this.#resolveReady = resolve
    })
  }

  get window(): FakeWindow {
    const window = this.windows[0]
    if (window === undefined) throw new Error('no window yet')
    return window
  }

  now(): number {
    return performance.now()
  }

  whenReady(): Promise<void> {
    return this.#readyPromise
  }

  /** 模拟 app ready。 */
  ready(): void {
    this.#ready = true
    this.#resolveReady()
  }

  exit(code: number): void {
    this.calls.push(`exit ${code}`)
    if (this.exitCode === null) this.exitCode = code
    this.#resolveExit(code)
  }

  becomeAccessory(): void {
    this.calls.push('becomeAccessory')
  }

  installEditMenu(): void {
    this.calls.push('installEditMenu')
  }

  appShow(): void {
    this.calls.push('app.show')
  }

  appHide(): void {
    this.calls.push('app.hide')
  }

  appFocusSteal(): void {
    this.calls.push('app.focus')
  }

  preferredLanguages(): string[] {
    this.#checkReady()
    return this.languages
  }

  systemDark(): boolean {
    this.#checkReady()
    return this.dark
  }

  setThemeSource(theme: 'light' | 'dark' | 'system'): void {
    this.#checkReady()
    if (theme === this.themeSource) return
    this.themeSource = theme
    // nativeTheme 改了 themeSource 会发 updated。
    for (const listener of this.#themeListeners) listener()
  }

  onThemeUpdated(listener: () => void): void {
    this.#themeListeners.push(listener)
  }

  /** 系统明暗变了。 */
  themeUpdated(): void {
    for (const listener of this.#themeListeners) listener()
  }

  displays(): { workArea: Rect }[] {
    this.#checkReady()
    return [{ workArea: WORK_AREA }]
  }

  cursorWorkArea(): Rect {
    return WORK_AREA
  }

  primaryWorkArea(): Rect {
    return WORK_AREA
  }

  workAreaFor(): Rect {
    return WORK_AREA
  }

  openExternal(url: string): Promise<void> {
    if (this.openFails) return Promise.reject(new Error('no handler'))
    this.opened.push(url)
    return Promise.resolve()
  }

  createWindow(options: WindowCreateOptions): MainWindow {
    this.calls.push('createWindow')
    if (this.windowFails) throw new Error('GPU process failed')
    const window = new FakeWindow(options)
    this.windows.push(window)
    return window
  }

  showMessageBox(_window: MainWindow, options: MessageBoxOptions): Promise<number> {
    this.messageBoxes.push(options)
    return Promise.resolve(this.messageBoxAnswers.shift() ?? options.cancelId)
  }

  createTray(onAction: (action: TrayAction) => void): TrayHandle | null {
    this.calls.push('createTray')
    if (this.trayFails) throw new Error('no status area')
    this.#trayAction = onAction
    this.tray = new FakeTray()
    return this.tray
  }

  clickTray(action: TrayAction): void {
    if (this.#trayAction === null) throw new Error('no tray')
    this.#trayAction(action)
  }

  onBeforeQuit(listener: (prevent: () => void) => void): void {
    this.#beforeQuit.push(listener)
  }

  /** 模拟 app.quit()：返回 before-quit 有没有被阻止。 */
  beforeQuit(): boolean {
    let prevented = false
    for (const listener of this.#beforeQuit) {
      listener(() => {
        prevented = true
      })
    }
    return prevented
  }

  onSignal(listener: (signal: string) => void): void {
    this.#signals.push(listener)
  }

  signal(name: string): void {
    for (const listener of this.#signals) listener(name)
  }

  isProcessAlive(pid: number): boolean {
    return this.alive.has(pid)
  }

  #checkReady(): void {
    if (!this.#ready) this.appearanceBeforeReady = true
  }
}

export type HostSide = RpcPeer<HostRequests, HostNotifications, CompanionRequests, CompanionNotifications>

export const BASE_CONFIG: CompanionConfig = {
  globalShortcut: 'Control+P',
  hideOnBlur: false,
  confirmDelete: true,
  convertMiddleDot: true,
  convertYen: true,
  locale: null,
  theme: 'system',
  libraryDir: '/Users/me/.dsh/promptx/library',
  profile: 'promptx-dev',
}

/** 扮演 Host：用真实的帧编解码和 RpcPeer，和小程序之间是两条 PassThrough 管道。 */
export class FakeHost {
  entryDraftSave: (
    params: CompanionRequests['entryDraft.save']['params'],
  ) => CompanionRequests['entryDraft.save']['result'] | Promise<CompanionRequests['entryDraft.save']['result']> = () => ({
    updatedAt: new Date().toISOString(),
  })
  readonly toCompanion = new PassThrough()
  readonly fromCompanion = new PassThrough()
  readonly peer: HostSide
  readonly notifications: { method: string; params: unknown }[] = []
  hello: HelloParams | null = null
  helloResult: Omit<HelloResult, 'protocol'> & { protocol?: number }

  constructor(helloResult: Partial<Omit<HelloResult, 'protocol'>> & { protocol?: number } = {}) {
    this.helloResult = { hostVersion: '0.1.0', config: BASE_CONFIG, mode: 'normal', ...helloResult }
    const decoder = new FrameDecoder({
      maxFrameBytes: MAX_FRAME_BYTES,
      onFrame: (value) => {
        this.peer.receive(value)
      },
    })
    this.fromCompanion.on('data', (chunk: Buffer) => {
      decoder.push(chunk)
    })
    this.peer = new RpcPeer({
      send: (message) => {
        this.toCompanion.write(encodeFrame(message))
      },
      defaultTimeoutMs: 5000,
    })
    this.peer.handle('hello', (params) => {
      this.hello = params
      return { protocol: PROTOCOL_VERSION, ...this.helloResult }
    })
    this.peer.handle('entryDraft.load', () => ({ record: null }))
    this.peer.handle('entryDraft.save', params => this.entryDraftSave(params))
    for (const method of COMPANION_NOTIFICATION_METHODS) {
      this.peer.on(method, (params) => {
        this.notifications.push({ method, params })
      })
    }
  }

  of(method: string): unknown[] {
    return this.notifications.filter(note => note.method === method).map(note => note.params)
  }

  lastStatus(): unknown {
    return this.of('status').at(-1)
  }

  close(): void {
    this.peer.close()
    this.toCompanion.end()
    this.fromCompanion.destroy()
  }
}

/**
 * 扮演界面：收到主进程的事件后按真实界面的方式回应（经 FakeIpc 调用预加载脚本暴露的那些通道）。
 * 消息异步送达，按发送顺序处理。
 */
export class FakeRenderer {
  readonly received: { event: BridgeEventName; payload: unknown }[] = []
  readonly saves: string[] = []
  /** false：收到 flush 后不回应（卡住的界面）。 */
  answerFlush = true
  /** 编辑区里的文字：flush 时保存它，core-path 时换成命令带来的文字。 */
  text = ''
  readonly #platform: FakePlatform
  readonly #window: FakeWindow
  #queue: Promise<void> = Promise.resolve()

  constructor(platform: FakePlatform) {
    this.#platform = platform
    this.#window = platform.window
    this.#window.onSend = (event, payload) => {
      this.#queue = this.#queue.then(() => this.#handle(event, payload))
    }
  }

  /** 界面挂载完成、草稿读回。 */
  ready(draftLoaded = true): void {
    this.#platform.ipc.send(this.#window.sender, IPC_CHANNELS.ready, { editorMounted: true, draftLoaded })
  }

  invoke(channel: string, ...args: unknown[]): Promise<unknown> {
    return this.#platform.ipc.invoke(this.#window.sender, channel, ...args)
  }

  send(channel: string, ...args: unknown[]): void {
    this.#platform.ipc.send(this.#window.sender, channel, ...args)
  }

  call(method: string, params: unknown): Promise<BridgeResult<unknown>> {
    return this.invoke(IPC_CHANNELS.call, method, params) as Promise<BridgeResult<unknown>>
  }

  events(name: BridgeEventName): unknown[] {
    return this.received.filter(item => item.event === name).map(item => item.payload)
  }

  idle(): Promise<void> {
    return this.#queue
  }

  async #handle(event: BridgeEventName, payload: unknown): Promise<void> {
    await new Promise<void>((resolve) => {
      setImmediate(resolve)
    })
    this.received.push({ event, payload })
    if (event === 'flush') {
      if (!this.answerFlush) return
      const { id } = payload as { id: number }
      const result = await this.call('draft.save', { text: this.text, selection: null, binding: null })
      if (result.ok) this.saves.push(this.text)
      this.send(IPC_CHANNELS.flushed, id)
      return
    }
    if (event === 'e2e') {
      const command = payload as { id: number; action: string; text?: string }
      if (command.action === 'core-path') {
        this.text = command.text ?? ''
        const result = await this.invoke(IPC_CHANNELS.windowCopyAndHide, this.text) as BridgeResult<null>
        this.send(IPC_CHANNELS.e2eDone, command.id, { ok: result.ok, data: { copied: result.ok } })
        return
      }
      if (command.action === 'state') {
        this.send(IPC_CHANNELS.e2eDone, command.id, { ok: true, data: { textLength: this.text.length } })
        return
      }
      if (command.action === 'save-to-library') {
        this.send(IPC_CHANNELS.e2eDone, command.id, { ok: true, data: { outcome: 'saved', relPath: 'e2e.md' } })
      }
    }
  }
}

/** 轮询直到条件成立（最多 timeoutMs），用来等跨管道、跨事件循环的结果。 */
export async function until(predicate: () => boolean, timeoutMs = 2000, what = 'condition'): Promise<void> {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${what}`)
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 2)
    })
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}
