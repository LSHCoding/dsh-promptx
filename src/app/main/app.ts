// 小程序主进程的组装：和 Host 的连接、窗口、全局快捷键、菜单栏图标、IPC、偏好、退出流程。
// 只依赖 platform.ts 的接口，Electron 的调用都在 electron-platform.ts；测试用假的平台对象驱动这里。
//
// 启动顺序（design-spec 5.3、5.4）：
// 1. 立即开始读 stdin 并发 hello（在 app ready 之前、创建任何窗口之前）；
// 2. app ready 后：macOS 设为 accessory、装「编辑」菜单、建好隐藏的窗口并加载界面（N-01：呼出时直接显示）、建菜单栏图标；
// 3. 第一份配置（hello 的回复）到了、窗口也建好之后登记全局快捷键，结果用 status 通知 Host。
// nativeTheme、系统语言、screen 这些接口在 app ready 之前不保证可用，所以 hello 早到时只记下配置，等 ready 后再应用。
//
// 退出（design-spec 5.2、审查 S07）：Host 的 shutdown 请求、stdin 结束、父进程消失、before-quit、信号都走同一个流程：
// 先让渲染进程把草稿写回 Host（最多 1.5 秒），再释放快捷键和锁、写掉偏好，然后退出。

import type { BridgeResult, ResolvedConfig, WindowBounds } from '../../shared/bridge.ts'
import { PromptxError, toErrorInfo } from '../../shared/errors.ts'
import { DEFAULT_WINDOW, type Rect } from '../../shared/layout.ts'
import {
  LONG_REQUEST_TIMEOUT_MS,
  PROTOCOL_VERSION,
  type CompanionMode,
  type HelloResult,
  type RendererForwardedMethod,
  type SmokeReport,
} from '../../shared/protocol.ts'
import { RpcError } from '../../shared/rpc.ts'
import type { CompanionConfig, CompanionStatus, ErrorInfo } from '../../shared/types.ts'
import { parseCompanionConfig, resolveConfig, resolveLocale, WINDOW_BACKGROUND, type Locale } from './appearance.ts'
import { ClipboardWriter } from './clipboard.ts'
import { EntryEditorManager } from './entry-editor.ts'
import { runE2eCommand, type CopyTiming, type E2eDeps, type RendererE2eRequest } from './e2e.ts'
import type { CompanionEnv, CompanionPaths } from './env.ts'
import { FlushCoordinator } from './flush.ts'
import { HostLink, type CompanionPeer, type HostLinkClose, type InputStream, type OutputStream } from './host-link.ts'
import { registerEntryEditorIpc, registerIpcHandlers, type E2eRendererResult, type ReadyInfo } from './ipc.ts'
import { errorCode, type CompanionLogger } from './logger.ts'
import { boundsForReset, boundsForShow, growToMinimum, minimumSize, resizeWidth, sameRect } from './placement.ts'
import type { CompanionPlatform, MainWindow, TrayHandle } from './platform.ts'
import { PrefsStore } from './prefs.ts'
import {
  RENDERER_CRASH_WINDOW_MS,
  RENDERER_FATAL_EXIT_CODE,
  RENDERER_UNRESPONSIVE_LIMIT_MS,
  RendererHealth,
} from './renderer-health.ts'
import { planSettingsOpen } from './settings.ts'
import { LOCK_REFRESH_MS, ShortcutLocks } from './shortcut-lock.ts'
import { ShortcutManager } from './shortcut-manager.ts'
import { runTask, withTimeout } from './tasks.ts'
import { buildTrayModel, type TrayAction } from './tray-model.ts'
import { EventWaiters, ReplyWaiters } from './waiters.ts'
import { WindowController } from './window-controller.ts'

export interface CompanionTimings {
  /** 等 hello 回复的上限；Host 自己的握手超时是 15 秒，这里放宽一点，由 Host 先判定。 */
  helloTimeoutMs: number
  /** 退出前等草稿写回的上限（Host 等 shutdown 回复最多 2 秒）。 */
  flushMs: number
  /** 收到 SIGTERM、SIGINT 时等草稿写回的上限：Host 发 SIGTERM 后 0.5 秒就会 SIGKILL。 */
  signalFlushMs: number
  /** 回复 shutdown 后等这一帧写进管道的上限。 */
  replyWriteMs: number
  /** 父进程检查的间隔。 */
  parentCheckMs: number
  /**
   * 快捷键锁的心跳间隔（审查 F2）：多久刷新一次自己持有的锁、看一次锁有没有被接管，被另一个 profile 占着时也按这个间隔
   * 看对方是否已经退出。超过 LOCK_REFRESH_MS 时按 LOCK_REFRESH_MS。
   */
  heldRetryMs: number
  /** 「设置」在网页模式下提示停留的时间。 */
  settingsToastMs: number
  /** 冒烟测试里等窗口显示、等快捷键检查完成的上限。 */
  smokeWaitMs: number
  /** 冒烟模式下界面一直没报告就绪时，最多等这么久也要把报告发出去，失败原因才看得出来。 */
  smokeReportMs: number
  /** 转发的请求耗时超过这个值时记日志。 */
  slowCallMs: number
  /** 渲染进程两次崩溃间隔在这之内就退出（design-spec 5.4：30 秒）。 */
  rendererCrashWindowMs: number
  /** 界面 unresponsive 超过这么久就退出（design-spec 5.4：10 秒）。 */
  rendererUnresponsiveMs: number
}

export const DEFAULT_TIMINGS: CompanionTimings = {
  helloTimeoutMs: 20_000,
  flushMs: 1500,
  signalFlushMs: 400,
  replyWriteMs: 500,
  parentCheckMs: 2000,
  heldRetryMs: 5000,
  settingsToastMs: 2000,
  smokeWaitMs: 5000,
  smokeReportMs: 30_000,
  slowCallMs: 1000,
  rendererCrashWindowMs: RENDERER_CRASH_WINDOW_MS,
  rendererUnresponsiveMs: RENDERER_UNRESPONSIVE_LIMIT_MS,
}

/** 读写大文件、扫描库的请求给更长的超时（protocol.ts LONG_REQUEST_TIMEOUT_MS）。 */
const LONG_METHODS: ReadonlySet<RendererForwardedMethod> = new Set([
  'library.list', 'library.read', 'library.save', 'library.updateMeta', 'library.delete',
  'trash.list', 'trash.read', 'trash.restore',
])

export interface CompanionAppOptions {
  platform: CompanionPlatform
  env: CompanionEnv
  paths: CompanionPaths
  logger: CompanionLogger
  input: InputStream
  output: OutputStream
  timings?: Partial<CompanionTimings>
}

type WindowEvent = 'show' | 'hide' | 'focus'

/**
 * 冒烟报告。closeHides 是在协议的 SmokeReport 之外多报的一项（审查 TC-11）：向窗口发 close（等同 Alt+F4），
 * 窗口应当只隐藏、不销毁，进程也不退出。Host 那边的冒烟测试没法直接让窗口关闭，只能由小程序自己做这一步。
 */
export type CompanionSmokeReport = SmokeReport & { closeHides: boolean }

function errorInfoOf(error: unknown): ErrorInfo {
  if (error instanceof RpcError) return error.info
  return toErrorInfo(error)
}

function parseMode(mode: unknown): CompanionMode {
  return mode === 'smoke' || mode === 'e2e' ? mode : 'normal'
}

export class CompanionApp {
  readonly #platform: CompanionPlatform
  readonly #env: CompanionEnv
  readonly #logger: CompanionLogger
  readonly #timings: CompanionTimings
  readonly #link: HostLink
  readonly #peer: CompanionPeer
  readonly #prefs: PrefsStore
  readonly #shortcuts: ShortcutManager
  readonly #flush: FlushCoordinator
  readonly #health: RendererHealth
  readonly #clipboard: ClipboardWriter
  readonly #e2eReplies = new ReplyWaiters<E2eRendererResult>()
  readonly #events = new EventWaiters<WindowEvent>()
  readonly #handshake: Promise<boolean>
  #resolveHandshake: (ok: boolean) => void = () => {}
  #handshakeState: 'pending' | 'done' | 'failed' = 'pending'

  #startedAt = 0
  #mode: CompanionMode | null = null
  #config: CompanionConfig | null = null
  #resolved: ResolvedConfig | null = null
  #window: MainWindow | null = null
  #controller: WindowController | null = null
  #entryEditor: EntryEditorManager | null = null
  #tray: TrayHandle | null = null
  #booted = false
  #rendererReady = false
  #readyInfo: ReadyInfo | null = null
  #smokeStarted = false
  #requestedMinWidth = 0
  #pendingCommand: 'show' | 'hide' | 'toggle' | null = null
  #lastStatus: string | null = null
  /** 界面进程崩溃后正在重新加载：随 status 报给 Host（design-spec 5.4，审查 CR-03）；界面重新就绪后清掉。 */
  #rendererError: ErrorInfo | null = null
  #copyTiming: CopyTiming = { requestedAt: null, verifiedAt: null, hiddenAt: null }
  #visibilityEpoch = 0
  #hideTimer: ReturnType<typeof setTimeout> | null = null
  #trayTimer: ReturnType<typeof setTimeout> | null = null
  #smokeTimer: ReturnType<typeof setTimeout> | null = null
  #parentTimer: ReturnType<typeof setInterval> | null = null
  #heldTimer: ReturnType<typeof setInterval> | null = null
  #exitFlush: Promise<void> | null = null
  #quitting = false
  #finalized = false

  constructor(options: CompanionAppOptions) {
    this.#platform = options.platform
    this.#env = options.env
    this.#logger = options.logger
    this.#timings = { ...DEFAULT_TIMINGS, ...options.timings }
    this.#handshake = new Promise<boolean>((resolve) => {
      this.#resolveHandshake = resolve
    })
    this.#link = new HostLink({
      input: options.input,
      output: options.output,
      logger: options.logger,
      onClose: (why) => {
        this.#hostGone(why)
      },
    })
    this.#peer = this.#link.peer
    this.#prefs = new PrefsStore({ file: options.paths.prefs, logger: options.logger, pid: options.platform.pid })
    const locks = new ShortcutLocks({
      dir: options.paths.locksDir,
      pid: options.platform.pid,
      profile: options.env.profile,
      isAlive: pid => options.platform.isProcessAlive(pid),
      onProblem: (code) => {
        this.#logger.warn('shortcut.lock-problem', { code })
      },
      // 心跳的确认期按单调时钟算（审查 F2）：系统睡眠时不走，睡醒后持有者来得及先刷新。
      now: () => options.platform.now(),
    })
    this.#shortcuts = new ShortcutManager({
      platform: options.platform.platform,
      backend: options.platform.shortcuts,
      locks,
      ...(options.platform.readSystemHotkeys === undefined ? {} : { readSystemHotkeys: options.platform.readSystemHotkeys }),
      locale: () => this.#locale(),
      onTrigger: () => {
        if (this.#entryEditor?.focused === true) this.#controller?.hide('shortcut')
        else this.#controller?.toggle('shortcut')
      },
      onStatus: () => {
        this.#scheduleTrayUpdate()
        this.#reportStatus()
      },
      logger: options.logger,
      now: () => options.platform.now(),
    })
    this.#flush = new FlushCoordinator({
      send: (id) => {
        if (this.#window === null || !this.#rendererReady) return false
        this.#window.send('flush', { id })
        return true
      },
    })
    this.#health = new RendererHealth({
      now: () => options.platform.now(),
      crashWindowMs: this.#timings.rendererCrashWindowMs,
      unresponsiveLimitMs: this.#timings.rendererUnresponsiveMs,
      onFatal: (reason) => {
        this.#logger.error('renderer.fatal', { reason })
        runTask(this.#logger, 'renderer-fatal-exit', () => this.shutdown(`renderer-${reason}`, RENDERER_FATAL_EXIT_CODE, null))
      },
    })
    this.#clipboard = new ClipboardWriter(options.platform.clipboard)
  }

  /** 当前生效的配置（测试和诊断用）。 */
  get config(): ResolvedConfig | null {
    return this.#resolved
  }

  get mode(): CompanionMode | null {
    return this.#mode
  }

  start(): void {
    this.#startedAt = this.#platform.now()
    this.#registerHostHandlers()
    this.#link.start()
    runTask(this.#logger, 'hello', () => this.#hello())
    this.#prefs.load()
    this.#watchParent()
    registerIpcHandlers(this.#platform.ipc, {
      isTrusted: sender => this.#window?.isSender(sender) ?? false,
      onRejected: (channel, why) => {
        this.#logger.warn('ipc.rejected', { channel, why })
      },
      handlers: {
        call: (method, params) => this.#forward(method, params),
        getConfig: () => this.#resolved,
        hide: () => {
          this.#controller?.hide('renderer')
        },
        copyAndHide: text => this.#copy(text, true),
        copyText: text => this.#copy(text, false),
        getBounds: () => this.#windowBounds(),
        setWidth: (width, anchor) => this.#setWidth(width, anchor),
        openSettings: () => this.#openSettings('window'),
        getPrefs: () => this.#prefs.get(),
        ready: (info) => {
          this.#onRendererReady(info)
        },
        flushed: (id) => {
          this.#flush.flushed(id)
        },
        e2eDone: (id, result) => {
          this.#e2eReplies.resolve(id, result)
        },
        setModalOpen: (open) => {
          this.#controller?.setModalOpen(open)
        },
        setMinWidth: (width) => {
          this.#requestedMinWidth = width
          this.#applyMinimumSize()
        },
        setPrefs: (patch) => {
          this.#prefs.set(patch)
        },
      },
    })
    registerEntryEditorIpc(this.#platform.ipc, sender => this.#window?.isSender(sender) ?? false, () => this.#entryEditor)
    this.#platform.onBeforeQuit((prevent) => {
      if (this.#finalized) return
      // 系统注销、关机时 Electron 走 before-quit：先拦下来写回草稿，再自己退出（app.exit 不再触发 before-quit）。
      prevent()
      runTask(this.#logger, 'before-quit', () => this.shutdown('before-quit', 0, this.#timings.flushMs))
    })
    this.#platform.onSignal((signal) => {
      runTask(this.#logger, 'signal', () => this.shutdown(`signal-${signal}`, 0, this.#timings.signalFlushMs))
    })
    runTask(this.#logger, 'boot', () => this.#platform.whenReady().then(() => {
      this.#boot()
    }))
  }

  /** 退出：先写回草稿（flushMs 为 null 时不等），再清理并退出。多条退出路径同时到达时只执行一次。 */
  shutdown(reason: string, code: number, flushMs: number | null): Promise<void> {
    return this.#beginExit(reason, flushMs).then(() => {
      this.#exitNow(code)
    })
  }

  /** 主进程出现未捕获的异常：状态已经不可信，不等写回，立即清理并退出，交给 Host 重启。 */
  crash(code = 1): void {
    if (this.#finalized) return
    this.#logger.error('main.crash', { code })
    this.#exitNow(code)
  }

  // ───────────────────────────── Host ─────────────────────────────

  #registerHostHandlers(): void {
    this.#peer.handle('ping', () => ({}))
    // e2e.run 一开始就注册，但要等握手完成、且 Host 在 hello 回复里说是 e2e 模式才执行（design-spec 9）。
    // 不能等握手之后再注册：Host 回复 hello 后立刻就算「运行中」，紧跟着发来的请求可能和 hello 的回复
    // 在同一次读取里到达，那时握手的后续处理（一个微任务）还没执行，处理函数还不存在（本机端到端测试复现）。
    this.#peer.handle('e2e.run', async (command) => {
      const ok = await this.#handshake
      if (!ok || this.#mode !== 'e2e') throw new PromptxError('promptx/internal', 'e2e disabled')
      if (command.action === 'edit-entry') {
        const editor = this.#entryEditor
        if (editor === null) return { ok: false, data: { windowCreated: false } }
        this.#controller?.show('e2e-entry')
        const opened = await editor.open(command.relPath)
        if (!opened.ok) return { ok: false, data: {}, error: opened.error }
        const deadline = this.#platform.now() + 3000
        while (!editor.stateRequested && this.#platform.now() < deadline) {
          await new Promise(resolve => setTimeout(resolve, 10))
        }
        const stateRequested = editor.stateRequested
        // getState 表示子窗实际请求初始文档，不把它记作 OS 输入法或DOM挂载验收。
        await new Promise(resolve => setTimeout(resolve, 100))
        editor.sendE2eText(command.text)
        const textDeadline = this.#platform.now() + 3000
        let echoed = editor.getState()
        while ((!echoed.ok || echoed.value.text !== command.text) && this.#platform.now() < textDeadline) {
          await new Promise(resolve => setTimeout(resolve, 10))
          echoed = editor.getState()
        }
        if (!echoed.ok || echoed.value.text !== command.text) return { ok: false, data: { stateRequested, rendererEchoed: false } }
        const saved = await editor.save()
        const snapshot = editor.getState()
        const result = {
          ok: saved.ok && stateRequested,
          data: {
            windowCreated: editor.windowCreated, stateRequested,
            rendererEchoed: true,
            targetRelPath: snapshot.ok ? snapshot.value.binding.relPath : null,
            savedBodyMatches: snapshot.ok && snapshot.value.binding.savedBody === command.text,
          },
        }
        if (saved.ok) await editor.close()
        return result
      }
      return runE2eCommand(command, this.#e2eDeps())
    })
    this.#peer.handle('shutdown', async () => {
      await this.#beginExit('host-shutdown', this.#timings.flushMs)
      // 回复是在这个函数返回之后才写出去的：排到下一轮再退出，并等这一帧真的写进管道（macOS 上写管道是异步的）。
      setTimeout(() => {
        runTask(this.#logger, 'exit-after-reply', () => this.#link.whenWritten(this.#timings.replyWriteMs).then(() => {
          this.#exitNow(0)
        }))
      }, 0)
      return {}
    })
    this.#peer.on('config', (raw) => {
      const config = parseCompanionConfig(raw, this.#config)
      if (config === null) {
        this.#logger.warn('config.invalid')
        return
      }
      this.#applyConfig(config)
    })
    this.#peer.on('window.command', (payload: unknown) => {
      this.#windowCommand(typeof payload === 'object' && payload !== null ? (payload as Record<string, unknown>).command : undefined)
    })
    this.#peer.on('optimize.event', (event) => {
      this.#window?.send('optimize.event', event)
    })
    this.#peer.on('library.changed', (payload) => {
      this.#window?.send('library.changed', payload)
    })
  }

  async #hello(): Promise<void> {
    const started = this.#platform.now()
    let result: HelloResult
    try {
      result = await this.#peer.request('hello', {
        protocol: PROTOCOL_VERSION,
        appVersion: this.#platform.appVersion,
        electron: this.#platform.electronVersion,
        platform: this.#platform.platform,
        arch: this.#platform.arch,
      }, { timeoutMs: this.#timings.helloTimeoutMs })
      if (result.protocol !== PROTOCOL_VERSION) throw new PromptxError('promptx/companion/protocol-mismatch')
    } catch (error) {
      this.#logger.error('hello.failed', { error: errorCode(error) })
      this.#handshakeState = 'failed'
      this.#resolveHandshake(false)
      await this.shutdown('hello-failed', 1, null)
      return
    }
    this.#mode = parseMode(result.mode)
    this.#logger.info('hello.done', { ms: this.#platform.now() - started, mode: this.#mode })
    this.#handshakeState = 'done'
    this.#resolveHandshake(true)
    const config = parseCompanionConfig(result.config, null)
    if (config === null) this.#logger.warn('config.invalid')
    else this.#applyConfig(config)
    this.#reportStatus()
    if (this.#mode === 'smoke') {
      // 界面迟迟不报告就绪时也要发出报告，冒烟测试才能看到是哪一步没做到，而不是只等到超时。
      this.#smokeTimer = setTimeout(() => {
        this.#smokeTimer = null
        this.#startSmoke(null)
      }, this.#timings.smokeReportMs)
      this.#maybeStartSmoke()
    }
  }

  #hostGone(why: HostLinkClose): void {
    // stdout 断了：草稿请求发不出去，不必等写回。stdin 结束时 stdout 可能还通，尽量写回一次。
    const flushMs = why === 'stdout-error' ? null : this.#timings.flushMs
    runTask(this.#logger, 'host-gone', () => this.shutdown(why, 0, flushMs))
  }

  /** 防孤儿的兜底（design-spec 5.2）：stdin 结束是主要信号，这里每 2 秒确认一次父进程还在。 */
  #watchParent(): void {
    const pid = this.#env.parentPid
    if (pid === null) return
    this.#parentTimer = setInterval(() => {
      if (this.#platform.isProcessAlive(pid)) return
      if (this.#parentTimer !== null) clearInterval(this.#parentTimer)
      this.#parentTimer = null
      this.#logger.warn('host.parent-gone')
      runTask(this.#logger, 'parent-gone', () => this.shutdown('parent-gone', 0, this.#timings.flushMs))
    }, this.#timings.parentCheckMs)
  }

  #applyConfig(config: CompanionConfig): void {
    this.#config = config
    // app ready 之前只记下来，#boot 里再应用。
    if (!this.#booted) return
    this.#applyThemeSource(config.theme)
    this.#refreshAppearance()
    this.#controller?.setHideOnBlur(config.hideOnBlur)
    this.#shortcuts.apply(config.globalShortcut)
  }

  /**
   * nativeTheme.themeSource 跟着 dsh 的明暗走：原生控件（菜单栏菜单、滚动条）和渲染进程里的 prefers-color-scheme
   * 都随之一致。只用于外观，解析明暗时 system 仍然看系统设置。
   */
  #applyThemeSource(theme: CompanionConfig['theme']): void {
    try {
      this.#platform.setThemeSource(theme)
    } catch (error) {
      this.#logger.warn('theme.source-failed', { error: errorCode(error) })
    }
  }

  /** 配置或系统外观变了：重新解析语言和明暗，有变化才推给渲染进程。 */
  #refreshAppearance(): void {
    if (this.#config === null) return
    const next = resolveConfig(this.#config, { languages: this.#platform.preferredLanguages(), dark: this.#platform.systemDark() })
    const previous = this.#resolved
    if (previous !== null && JSON.stringify(previous) === JSON.stringify(next)) return
    this.#resolved = next
    this.#entryEditor?.applyConfig()
    this.#window?.send('config', next)
    this.#window?.setBackgroundColor(WINDOW_BACKGROUND[next.resolvedTheme])
    if (previous?.resolvedLocale !== next.resolvedLocale) {
      this.#shortcuts.refreshLocale()
      this.#scheduleTrayUpdate()
      // Host 按小窗的语言选优化默认指令（审查 F5）。
      this.#reportStatus()
    }
  }

  #locale(): Locale {
    return this.#resolved?.resolvedLocale ?? resolveLocale(null, this.#platform.preferredLanguages())
  }

  #windowCommand(command: unknown): void {
    if (command !== 'show' && command !== 'hide' && command !== 'toggle') return
    const controller = this.#controller
    if (controller === null) {
      // 窗口还没建好：记下最后一条，建好后执行。
      this.#pendingCommand = command
      return
    }
    if (command === 'show') controller.show('host')
    else if (command === 'hide') controller.hide('host')
    else if (this.#entryEditor?.focused === true) controller.hide('host')
    else controller.toggle('host')
  }

  /**
   * 状态有变化才通知 Host（快捷键、托盘、可见性、语言、界面崩溃）。握手完成之前 Host 还不认这个连接；
   * app ready 之前还没有托盘和快捷键，系统语言也不保证读得到，#boot 末尾会报第一次。
   */
  #reportStatus(): void {
    if (this.#handshakeState !== 'done' || !this.#booted || this.#finalized) return
    const status: CompanionStatus = {
      shortcut: this.#shortcuts.status(),
      tray: this.#tray !== null,
      visible: this.#window?.isVisible() ?? false,
      locale: this.#locale(),
      rendererError: this.#rendererError,
    }
    const key = JSON.stringify(status)
    if (key === this.#lastStatus) return
    this.#lastStatus = key
    this.#peer.notify('status', status)
  }

  // ───────────────────────────── 窗口 ─────────────────────────────

  #boot(): void {
    if (this.#finalized) return
    this.#platform.onThemeUpdated(() => {
      this.#refreshAppearance()
    })
    // 这两步失败只影响 Dock 图标和 ⌘C/⌘V 菜单，不值得为它退出。
    try {
      this.#platform.becomeAccessory()
    } catch (error) {
      this.#logger.warn('boot.accessory-failed', { error: errorCode(error) })
    }
    try {
      this.#platform.installEditMenu()
    } catch (error) {
      this.#logger.warn('boot.menu-failed', { error: errorCode(error) })
    }
    if (this.#config !== null) {
      this.#applyThemeSource(this.#config.theme)
      this.#refreshAppearance()
    }
    try {
      const saved = this.#prefs.get().window
      const theme = this.#resolved?.resolvedTheme ?? (this.#platform.systemDark() ? 'dark' : 'light')
      const window = this.#platform.createWindow({
        width: saved?.width ?? DEFAULT_WINDOW.width,
        height: saved?.height ?? DEFAULT_WINDOW.height,
        backgroundColor: WINDOW_BACKGROUND[theme],
      })
      this.#window = window
      this.#entryEditor = new EntryEditorManager({
        platform: this.#platform,
        parent: window,
        config: () => this.#resolved,
        request: async (method, params) => {
          if (!(await this.#handshake)) throw new PromptxError('promptx/channel/closed')
          return this.#peer.request(method, params)
        },
        changed: (libraryDir) => { window.send('library.entriesChanged', { libraryDir }) },
        onBlur: () => { this.#controller?.handleBlur() },
        logger: this.#logger,
      })
      runTask(this.#logger, 'entry-editor-initialize', () => this.#entryEditor?.initialize() ?? Promise.resolve())
      this.#controller = new WindowController({
        platform: this.#platform.platform,
        window,
        app: {
          show: () => {
            this.#platform.appShow()
          },
          hide: () => {
            this.#platform.appHide()
          },
          focusSteal: () => {
            this.#platform.appFocusSteal()
          },
        },
        beforeShow: () => {
          this.#placeForShow()
        },
        onShown: (reason) => {
          // 语言跟随系统时，系统语言改了没有事件可听；需求 S-03 要求最晚在下次呼出时更新，所以每次呼出顺手核对一次
          // （一次原生调用加一次比较，没变化时什么都不发）。
          this.#refreshAppearance()
          this.#onVisibility('window.shown', reason)
          this.#entryEditor?.show()
        },
        onHidden: (reason) => {
          this.#entryEditor?.hide()
          this.#copyTiming = { ...this.#copyTiming, hiddenAt: this.#platform.now() }
          this.#onVisibility('window.hidden', reason)
        },
        logger: this.#logger,
        now: () => this.#platform.now(),
        isRelatedFocused: () => this.#entryEditor?.protectingFocus ?? false,
      })
      this.#controller.setHideOnBlur(this.#config?.hideOnBlur ?? false)
      this.#wireWindow(window)
    } catch (error) {
      // 没有窗口小程序就没有用处：退出码非零，交给 Host 的重启策略。
      this.#logger.error('boot.window-failed', { error: errorCode(error) })
      runTask(this.#logger, 'boot-failed-exit', () => this.shutdown('boot-failed', 1, null))
      return
    }
    try {
      this.#tray = this.#platform.createTray((action) => {
        this.#trayAction(action)
      })
    } catch (error) {
      // 托盘建不出来只记日志：快捷键照常可用，配置页的「显示小窗」是替代入口（F-05）。
      this.#logger.warn('tray.failed', { error: errorCode(error) })
      this.#tray = null
    }
    this.#booted = true
    this.#logger.info('boot.done', { ms: this.#platform.now() - this.#startedAt, tray: this.#tray !== null })
    if (this.#config !== null) this.#shortcuts.apply(this.#config.globalShortcut)
    // 快捷键锁的心跳和「被别的 profile 占着时等它退出」共用这个计时器（审查 F2）。间隔不超过锁的刷新上限，
    // 否则别的 PromptX 会把还活着的这一个当成死锁接管。unref：不靠它让进程留着（退出由 #exitNow 清掉它）。
    this.#heldTimer = setInterval(() => {
      this.#shortcuts.heartbeat()
    }, Math.min(this.#timings.heldRetryMs, LOCK_REFRESH_MS))
    this.#heldTimer.unref()
    this.#updateTray()
    this.#reportStatus()
    if (this.#pendingCommand !== null) {
      const command = this.#pendingCommand
      this.#pendingCommand = null
      this.#windowCommand(command)
    }
    this.#maybeStartSmoke()
  }

  #wireWindow(window: MainWindow): void {
    window.on('show', () => {
      this.#events.emit('show')
      this.#scheduleTrayUpdate()
      this.#reportStatus()
    })
    window.on('hide', () => {
      this.#events.emit('hide')
      this.#scheduleTrayUpdate()
      this.#reportStatus()
    })
    window.on('focus', () => {
      this.#events.emit('focus')
      this.#controller?.handleFocus()
    })
    window.on('blur', () => {
      this.#controller?.handleBlur()
    })
    window.on('will-move', () => {
      this.#controller?.noteMoveOrResize()
    })
    window.on('will-resize', () => {
      this.#controller?.noteMoveOrResize()
    })
    // 只记录用户在可见窗口上的拖动和缩放；隐藏时程序摆放的位置由摆放的地方自己记。
    // 否则窗口刚建好时的默认位置也会被记下来，第一次显示就不会出现在鼠标所在的屏幕上了。
    const saveBounds = (): void => {
      if (window.isVisible()) this.#prefs.setWindow(window.getBounds())
    }
    window.on('moved', saveBounds)
    window.on('resized', saveBounds)
    window.on('unresponsive', () => {
      this.#logger.warn('renderer.unresponsive')
      this.#health.unresponsive()
    })
    window.on('responsive', () => {
      this.#health.responsive()
    })
    window.onClose((prevent) => {
      // 系统发起的关闭（Windows 的 Alt+F4、Linux 窗口管理器的关闭键）只隐藏，不退出（审查 TC-11）。
      if (this.#quitting) return
      prevent()
      this.#controller?.hide('close')
    })
    window.onRendererGone((reason) => {
      // 退出过程中 Electron 会自己结束渲染进程，这时不能当成崩溃去重新加载（会让退出前的草稿写回等到超时）。
      if (this.#quitting) {
        this.#rendererReady = false
        return
      }
      const decision = this.#health.gone(reason)
      this.#logger.warn('renderer.gone', { reason, decision })
      if (decision !== 'reload') return
      // 重新加载期间界面没有草稿：flush 跳过，等界面重新报告就绪（草稿重新读回之前编辑区不可编辑，由界面保证）。
      this.#rendererReady = false
      // 崩溃时开着的对话框随界面一起没了，界面不会再发 setModalOpen(false)：这里清掉，否则失焦隐藏一直不生效（审查 CR-02）。
      this.#controller?.setModalOpen(false)
      this.#rendererError = { code: 'promptx/companion/renderer-gone', detail: reason }
      this.#reportStatus()
      this.#scheduleTrayUpdate()
      window.reload()
    })
  }

  #onVisibility(event: 'window.shown' | 'window.hidden', reason: string): void {
    this.#visibilityEpoch++
    this.#cancelDelayedHide()
    this.#window?.send(event, {})
    this.#logger.info(event, { reason })
    this.#scheduleTrayUpdate()
    this.#reportStatus()
  }

  /** 从隐藏变为显示之前：放到可见位置。 */
  #placeForShow(): void {
    const target = boundsForShow(this.#prefs.get().window, this.#platform.displays(), this.#platform.cursorWorkArea())
    this.#applyBounds(target)
  }

  /** 按目标位置所在屏幕设最小尺寸，再放到目标位置并记下。 */
  #applyBounds(target: Rect): void {
    const window = this.#window
    if (window === null) return
    const workArea = this.#platform.workAreaFor(target)
    const minimum = minimumSize(this.#requestedMinWidth, workArea)
    window.setMinimumSize(minimum.width, minimum.height)
    const next = growToMinimum(target, minimum, workArea)
    if (!sameRect(next, window.getBounds())) window.setBounds(next)
    this.#prefs.setWindow(next)
  }

  /** 渲染进程按打开的栏位请求最小宽度（5.7，审查 COV-13）：按所在屏幕收紧，窗口比它窄时随之加宽。 */
  #applyMinimumSize(): void {
    const window = this.#window
    if (window === null) return
    const bounds = window.getBounds()
    const workArea = this.#platform.workAreaFor(bounds)
    const minimum = minimumSize(this.#requestedMinWidth, workArea)
    window.setMinimumSize(minimum.width, minimum.height)
    const next = growToMinimum(bounds, minimum, workArea)
    if (sameRect(next, bounds)) return
    window.setBounds(next)
    this.#prefs.setWindow(next)
  }

  #windowBounds(): WindowBounds {
    const window = this.#window
    if (window === null) throw new PromptxError('promptx/internal', 'window not ready')
    const bounds = window.getBounds()
    return { ...bounds, workArea: this.#platform.workAreaFor(bounds) }
  }

  #setWidth(width: number, anchor: 'left' | 'right'): WindowBounds {
    const window = this.#window
    if (window === null) throw new PromptxError('promptx/internal', 'window not ready')
    const bounds = window.getBounds()
    const workArea = this.#platform.workAreaFor(bounds)
    const next = resizeWidth(bounds, width, anchor, workArea, minimumSize(this.#requestedMinWidth, workArea).width)
    if (!sameRect(next, bounds)) window.setBounds(next)
    this.#prefs.setWindow(next)
    return { ...window.getBounds(), workArea }
  }

  #cancelDelayedHide(): void {
    if (this.#hideTimer !== null) clearTimeout(this.#hideTimer)
    this.#hideTimer = null
  }

  /** 网页模式的「设置」：提示停留一会儿再隐藏；期间小窗被隐藏或重新呼出过就不再隐藏。 */
  #hideLater(ms: number): void {
    this.#cancelDelayedHide()
    const epoch = this.#visibilityEpoch
    this.#hideTimer = setTimeout(() => {
      this.#hideTimer = null
      if (epoch === this.#visibilityEpoch) this.#controller?.hide('settings')
    }, ms)
  }

  #onRendererReady(info: ReadyInfo): void {
    this.#rendererReady = true
    this.#readyInfo = info
    this.#health.recovered()
    if (this.#rendererError !== null) {
      this.#rendererError = null
      this.#reportStatus()
    }
    this.#logger.info('renderer.ready', {
      editorMounted: info.editorMounted,
      draftLoaded: info.draftLoaded,
      ms: this.#platform.now() - this.#startedAt,
    })
    this.#scheduleTrayUpdate()
    this.#maybeStartSmoke()
  }

  // ───────────────────────────── 渲染进程的请求 ─────────────────────────────

  async #forward(method: RendererForwardedMethod, params: Record<string, unknown>): Promise<BridgeResult<unknown>> {
    const started = this.#platform.now()
    // 握手完成前 Host 还不认这个连接：等 hello 回来再转发。
    if (!(await this.#handshake)) return { ok: false, error: { code: 'promptx/channel/closed' } }
    try {
      const value = await this.#request(method, params)
      const ms = this.#platform.now() - started
      if (ms >= this.#timings.slowCallMs) this.#logger.info('call.slow', { method, ms })
      return { ok: true, value }
    } catch (error) {
      const info = errorInfoOf(error)
      this.#logger.warn('call.failed', { method, code: info.code, ms: this.#platform.now() - started })
      return { ok: false, error: info }
    }
  }

  #request(method: RendererForwardedMethod, params: Record<string, unknown>): Promise<unknown> {
    const options = LONG_METHODS.has(method) ? { timeoutMs: LONG_REQUEST_TIMEOUT_MS } : {}
    // 方法名已经核对过在白名单里；参数的具体形状由 Host 校验，主进程不重复一遍协议表的类型检查。
    return this.#peer.request(method, params as never, options)
  }

  /**
   * 写剪贴板并读回核对（F-03、审查 COV-09）。只有剪贴板写入要等；草稿保存由渲染进程同时发出，这里不等
   * （需求 4.1：保存失败时复制照常完成）。hide 为 true 时核对通过才隐藏，写入失败时小窗留着，渲染进程提示原因。
   */
  async #copy(text: string, hide: boolean): Promise<BridgeResult<null>> {
    const started = this.#platform.now()
    if (hide) this.#copyTiming = { requestedAt: started, verifiedAt: null, hiddenAt: this.#copyTiming.hiddenAt }
    const result = await this.#clipboard.write(text)
    if (!result.ok) {
      this.#logger.warn('clipboard.failed', { code: result.error.code, hide })
      return result
    }
    if (hide) {
      this.#copyTiming = { ...this.#copyTiming, verifiedAt: this.#platform.now() }
      this.#controller?.hide('copy')
    }
    this.#logger.info('clipboard.copied', { hide, ms: this.#platform.now() - started })
    return result
  }

  async #openSettings(source: 'window' | 'tray'): Promise<BridgeResult<{ navigated: boolean }>> {
    let result: { open: string | null; navigated: boolean }
    try {
      if (!(await this.#handshake)) throw new PromptxError('promptx/channel/closed')
      result = await this.#peer.request('host.openSettings', {})
    } catch (error) {
      const info = errorInfoOf(error)
      this.#logger.warn('settings.failed', { code: info.code, source })
      return { ok: false, error: info }
    }
    const plan = planSettingsOpen(result, source)
    if (plan.error !== null) {
      this.#logger.warn('settings.failed', { code: plan.error.code, source })
      return { ok: false, error: plan.error }
    }
    if (plan.openUrl !== null) {
      try {
        // 地址可能带口令（dsh web），只交给系统打开，不写日志。
        await this.#platform.openExternal(plan.openUrl)
      } catch (error) {
        this.#logger.warn('settings.open-failed', { error: errorCode(error), source })
        return { ok: false, error: { code: 'promptx/settings/unavailable' } }
      }
    }
    this.#logger.info('settings.opened', { source, hide: plan.hide, navigated: result.navigated })
    if (plan.hide === 'now') this.#controller?.hide('settings')
    else if (plan.hide === 'delayed') this.#hideLater(this.#timings.settingsToastMs)
    return { ok: true, value: { navigated: result.navigated } }
  }

  // ───────────────────────────── 菜单栏图标 ─────────────────────────────

  #trayAction(action: TrayAction): void {
    const controller = this.#controller
    switch (action) {
      case 'toggle':
        if (controller === null) return
        if (controller.visible) controller.hide('tray')
        else controller.show('tray')
        return
      case 'reset-position':
        this.#applyBounds(boundsForReset(this.#platform.primaryWorkArea()))
        this.#logger.info('window.reset-position')
        return
      case 'settings':
        runTask(this.#logger, 'tray-settings', () => this.#openSettings('tray'))
        return
      case 'restart':
        // Host 会走正常的停止流程（shutdown 请求里写回草稿）再启动新的小程序（F-05：草稿不丢）。
        this.#logger.info('restart.requested')
        this.#peer.notify('host.restartCompanion', {})
        return
    }
  }

  /**
   * 菜单在显示、隐藏、状态变化时整份重建。合并到下一轮事件循环再做：一次呼出会连着触发好几次，
   * 也不让重建菜单挡在显示窗口的路上（N-01）。
   */
  #scheduleTrayUpdate(): void {
    if (this.#tray === null || this.#trayTimer !== null || this.#finalized) return
    this.#trayTimer = setTimeout(() => {
      this.#trayTimer = null
      this.#updateTray()
    }, 0)
  }

  #updateTray(): void {
    const tray = this.#tray
    if (tray === null || this.#finalized) return
    try {
      tray.update(buildTrayModel({
        locale: this.#locale(),
        platform: this.#platform.platform,
        visible: this.#window?.isVisible() ?? false,
        shortcut: this.#shortcuts.status(),
        runtimeVersion: this.#platform.electronVersion,
        rendererHealthy: this.#health.healthy,
      }))
    } catch (error) {
      this.#logger.warn('tray.update-failed', { error: errorCode(error) })
    }
  }

  // ───────────────────────────── 冒烟测试与端到端测试 ─────────────────────────────

  #maybeStartSmoke(): void {
    if (this.#mode !== 'smoke' || this.#readyInfo === null || !this.#booted) return
    this.#startSmoke(this.#readyInfo)
  }

  /** info 为 null：界面一直没报告就绪，照实报告。 */
  #startSmoke(info: ReadyInfo | null): void {
    if (this.#smokeStarted || this.#finalized) return
    this.#smokeStarted = true
    if (this.#smokeTimer !== null) clearTimeout(this.#smokeTimer)
    this.#smokeTimer = null
    runTask(this.#logger, 'smoke', () => this.#runSmoke(info))
  }

  async #runSmoke(info: ReadyInfo | null): Promise<void> {
    const window = this.#window
    let windowShown = false
    let closeHides = false
    if (window !== null && this.#controller !== null && info !== null) {
      const shown = this.#events.wait('show', this.#timings.smokeWaitMs)
      this.#controller.show('smoke')
      windowShown = (await shown) || window.isVisible()
      await withTimeout(this.#shortcuts.settled(), this.#timings.smokeWaitMs, undefined)
      if (windowShown) closeHides = await this.#smokeCloseCheck(window)
    }
    const report: CompanionSmokeReport = {
      windowCreated: window !== null,
      windowShown,
      rendererReady: this.#rendererReady,
      editorMounted: info?.editorMounted ?? false,
      draftLoaded: info?.draftLoaded ?? false,
      shortcut: this.#shortcuts.status(),
      tray: this.#tray !== null,
      noSandbox: this.#platform.argv.includes('--no-sandbox'),
      closeHides,
    }
    if (this.#finalized) return
    this.#peer.notify('smoke.report', report)
    this.#logger.info('smoke.reported', { windowShown, rendererReady: report.rendererReady, draftLoaded: report.draftLoaded, closeHides })
  }

  /** 向窗口发 close（等同 Alt+F4 等系统关闭）：应当只隐藏，窗口不销毁，进程不退出（审查 TC-11）。 */
  async #smokeCloseCheck(window: MainWindow): Promise<boolean> {
    const hidden = this.#events.wait('hide', this.#timings.smokeWaitMs)
    window.close()
    const result = (await hidden) || !window.isVisible()
    return result && !window.isDestroyed() && !this.#finalized
  }

  #e2eDeps(): E2eDeps {
    return {
      isVisible: () => this.#window?.isVisible() ?? false,
      show: (reason) => {
        this.#controller?.show(reason)
      },
      hide: (reason) => {
        this.#controller?.hide(reason)
      },
      waitForFocus: ms => (this.#window?.isFocused() === true ? Promise.resolve(true) : this.#events.wait('focus', ms)),
      waitForHidden: ms => (this.#window?.isVisible() === true ? this.#events.wait('hide', ms) : Promise.resolve(true)),
      askRenderer: (request, ms) => this.#askRenderer(request, ms),
      clipboard: this.#platform.clipboard,
      now: () => this.#platform.now(),
      copyTiming: () => ({ ...this.#copyTiming }),
      state: () => ({
        mode: this.#mode,
        booted: this.#booted,
        visible: this.#window?.isVisible() ?? false,
        focused: this.#window?.isFocused() ?? false,
        rendererReady: this.#rendererReady,
        rendererHealthy: this.#health.healthy,
        tray: this.#tray !== null,
        shortcut: this.#shortcuts.status(),
        bounds: this.#window?.getBounds() ?? null,
      }),
    }
  }

  #askRenderer(request: RendererE2eRequest, timeoutMs: number): Promise<E2eRendererResult | null> {
    const window = this.#window
    if (window === null || !this.#rendererReady) return Promise.resolve(null)
    const id = this.#e2eReplies.nextId()
    const reply = this.#e2eReplies.wait(id, timeoutMs)
    window.send('e2e', { id, ...request })
    return reply
  }

  // ───────────────────────────── 退出 ─────────────────────────────

  /** 所有退出路径共用一次写回：stdin 结束、shutdown 请求、before-quit、信号可能先后到达。 */
  #beginExit(reason: string, flushMs: number | null): Promise<void> {
    if (this.#exitFlush !== null) return this.#exitFlush
    this.#quitting = true
    this.#logger.info('exit.begin', { reason })
    this.#exitFlush = flushMs === null
      ? Promise.resolve()
      : withTimeout(Promise.allSettled([
        this.#flush.flush(flushMs).then((result) => { this.#logger.info('exit.flush', { result }) }),
        this.#entryEditor?.flushForExit() ?? Promise.resolve(),
      ]).then(() => {}), flushMs, undefined)
    return this.#exitFlush
  }

  #exitNow(code: number): void {
    if (this.#finalized) return
    this.#finalized = true
    this.#quitting = true
    const steps: [string, () => void][] = [
      ['timers', () => {
        for (const timer of [this.#parentTimer, this.#heldTimer]) {
          if (timer !== null) clearInterval(timer)
        }
        for (const timer of [this.#hideTimer, this.#trayTimer, this.#smokeTimer]) {
          if (timer !== null) clearTimeout(timer)
        }
        this.#parentTimer = null
        this.#heldTimer = null
        this.#hideTimer = null
        this.#trayTimer = null
        this.#smokeTimer = null
        this.#controller?.dispose()
        this.#entryEditor?.dispose()
        this.#health.dispose()
        this.#flush.dispose()
        this.#e2eReplies.dispose()
        this.#events.dispose()
      }],
      ['prefs', () => {
        this.#prefs.flushSync()
      }],
      ['shortcuts', () => {
        this.#shortcuts.dispose()
        this.#platform.shortcuts.unregisterAll()
      }],
      ['tray', () => {
        this.#tray?.destroy()
      }],
      ['link', () => {
        this.#peer.close()
      }],
    ]
    for (const [step, run] of steps) {
      try {
        run()
      } catch (error) {
        this.#logger.warn('exit.step-failed', { step, error: errorCode(error) })
      }
    }
    this.#logger.info('exit', { code, ms: this.#platform.now() - this.#startedAt })
    this.#platform.exit(code)
  }
}
