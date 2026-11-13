// 设置窗口（V0.1.6 design-spec 1、5）：主窗口的子窗口，只有一个实例。
//
// - 配置和说明由 Host 的 settings.get 提供；改动经 settings.update 交给 Host，和 dsh 配置页走同一套校验和写入。
//   主进程把 Host 的数据和自己知道的快捷键登记结果、Electron 版本、外观合成一份快照推给设置页。
// - 主窗口隐藏时设置窗口一起关闭，再呼出小窗时不自动回来：设置没有未保存的内容（优化指令在失焦和隐藏时提交），
//   这样呼出后焦点总在主窗口的编辑区，不打断「呼出 → 编辑 → 复制 → 隐藏」。
// - 「打开」库目录用 Host 给的生效库目录，不收设置页传来的路径。

import type { BridgeResult, ResolvedConfig, SettingsSnapshot } from '../../shared/bridge.ts'
import { toErrorInfo } from '../../shared/errors.ts'
import { translate } from '../../shared/i18n/index.ts'
import type { CompanionRequests } from '../../shared/protocol.ts'
import { RpcError } from '../../shared/rpc.ts'
import type { ConfigUpdateResult, ErrorInfo, PromptxConfig, SettingsData, SettingsSection, ShortcutStatus } from '../../shared/types.ts'
import { WINDOW_BACKGROUND } from './appearance.ts'
import type { CompanionLogger } from './logger.ts'
import { centerOver } from './placement.ts'
import type { CompanionPlatform, MainWindow } from './platform.ts'
import { runTask } from './tasks.ts'

type SettingsMethod = 'settings.get' | 'settings.update'

export const SETTINGS_WINDOW_SIZE = { width: 720, height: 540 } as const
export const SETTINGS_WINDOW_MIN = { width: 600, height: 440 } as const

export interface SettingsWindowOptions {
  platform: CompanionPlatform
  parent: MainWindow
  config(): ResolvedConfig | null
  /** 小程序登记全局快捷键的结果。 */
  shortcut(): ShortcutStatus | null
  request<M extends SettingsMethod>(method: M, params: CompanionRequests[M]['params']): Promise<CompanionRequests[M]['result']>
  /** 「在 DeepSeek Harness 中打开」：原来的设置流程，由 app.ts 打开 dsh 并隐藏小窗。 */
  openInDsh(): Promise<BridgeResult<{ navigated: boolean }>>
  logger: CompanionLogger
}

const closed: ErrorInfo = { code: 'promptx/channel/closed' }

function errorInfoOf(error: unknown): ErrorInfo {
  if (error instanceof RpcError) return error.info
  return toErrorInfo(error)
}

export class SettingsWindowManager {
  private window: MainWindow | null = null
  private active = false
  private disposed = false
  private requested = false
  private data: SettingsData | null = null
  private error: ErrorInfo | null = null
  private section: { seq: number; section: SettingsSection } = { seq: 0, section: 'shortcuts' }
  private fetching: Promise<void> | null = null
  private refetch = false
  private recordingShortcut = false

  constructor(private readonly options: SettingsWindowOptions) {}

  get focused(): boolean { return this.active && (this.window?.isFocused() ?? false) }
  get visible(): boolean { return this.active && (this.window?.isVisible() ?? false) }
  get windowCreated(): boolean { return this.window !== null && !this.window.isDestroyed() }
  /** 设置页已经来取过快照（页面加载完成、总控已启动）。 */
  get stateRequested(): boolean { return this.requested }
  get recording(): boolean { return this.active && this.recordingShortcut }
  get current(): SettingsData | null { return this.data }

  isSender(sender: unknown): boolean {
    return this.window?.isSender(sender) ?? false
  }

  /** 打开（已打开时只聚焦）。section 指定时切到那个分区。 */
  open(section?: SettingsSection): BridgeResult<null> {
    if (this.disposed) return { ok: false, error: closed }
    if (section !== undefined) this.section = { seq: this.section.seq + 1, section }
    const created = this.ensureWindow()
    const window = this.window
    if (window === null) return { ok: false, error: closed }
    if (created || !window.isVisible()) this.place(window)
    this.active = true
    window.show()
    window.focus()
    this.publish()
    runTask(this.options.logger, 'settings-open-refresh', this.refresh())
    return { ok: true, value: null }
  }

  /** 用户关闭（×、Esc、⌘W、系统关闭）：隐藏并把焦点交回主窗口。 */
  close(): void {
    if (!this.active) return
    this.deactivate()
    if (this.options.parent.isVisible()) this.options.parent.focus()
  }

  /** 主窗口隐藏了：一起关闭，不抢焦点。 */
  hide(): void {
    if (this.active) this.deactivate()
  }

  getState(): BridgeResult<SettingsSnapshot> {
    if (this.disposed) return { ok: false, error: closed }
    this.requested = true
    return { ok: true, value: this.snapshot() }
  }

  /** 重新向 Host 取数并推给设置页。窗口没打开时不取，下次打开时再取。同时只取一次，期间再要求就在结束后补一次。 */
  refresh(): Promise<void> {
    if (!this.active || this.disposed) return Promise.resolve()
    if (this.fetching !== null) {
      this.refetch = true
      return this.fetching
    }
    const task = this.fetch().finally(() => {
      this.fetching = null
      if (this.refetch) {
        this.refetch = false
        runTask(this.options.logger, 'settings-refetch', this.refresh())
      }
    })
    this.fetching = task
    return task
  }

  private async fetch(): Promise<void> {
    try {
      const data = await this.options.request('settings.get', {})
      if (this.disposed) return
      this.data = data
      this.error = null
    } catch (error) {
      if (this.disposed) return
      this.error = errorInfoOf(error)
      this.options.logger.warn('settings.fetch-failed', { code: this.error.code })
    }
    this.publish()
  }

  async update(patch: Partial<PromptxConfig>): Promise<BridgeResult<ConfigUpdateResult>> {
    if (this.disposed) return { ok: false, error: closed }
    let result: ConfigUpdateResult
    try {
      result = await this.options.request('settings.update', { patch })
    } catch (error) {
      const info = errorInfoOf(error)
      this.options.logger.warn('settings.update-failed', { code: info.code })
      return { ok: false, error: info }
    }
    // dsh 的 settings.update 在新值应用到插件之后才返回（dsh-config-editor 的 edit），这时再取一次就是写入之后的配置。
    // 等这次取数推给设置页之后再回复：页面收到回复时手里已经是最新快照，可以直接去掉自己的提交值，
    // 两处几乎同时改同一项时，界面立刻显示最后写入的那个值（V0.1.6 追加 2）。
    if (result.ok) await this.refreshAfterWrite()
    return { ok: true, value: result }
  }

  /** 取一次「写入之后才开始」的快照。正在进行的那次可能在写入之前就开始了，先等它结束。 */
  private async refreshAfterWrite(): Promise<void> {
    const inFlight = this.fetching
    if (inFlight !== null) await inFlight
    await this.refresh()
  }

  async chooseLibraryDir(): Promise<BridgeResult<string | null>> {
    const window = this.window
    if (window === null || !this.active) return { ok: false, error: closed }
    const locale = this.options.config()?.resolvedLocale ?? 'en'
    try {
      const path = await this.options.platform.chooseDirectory(window, {
        title: translate(locale, 'settings.library.chooseTitle'),
        defaultPath: this.data?.effectiveLibraryDir ?? '',
      })
      return { ok: true, value: path }
    } catch (error) {
      return { ok: false, error: errorInfoOf(error) }
    }
  }

  async openLibraryDir(): Promise<BridgeResult<null>> {
    const path = this.data?.effectiveLibraryDir
    if (path === undefined || path === '') return { ok: false, error: { code: 'promptx/library/unavailable' } }
    try {
      await this.options.platform.openPath(path)
      return { ok: true, value: null }
    } catch {
      // openPath 的错误说明里有路径，不记日志、不传给页面。
      this.options.logger.warn('settings.open-library-failed')
      return { ok: false, error: { code: 'promptx/library/unavailable' } }
    }
  }

  openInDsh(): Promise<BridgeResult<{ navigated: boolean }>> {
    return this.options.openInDsh()
  }

  setRecording(active: boolean): void {
    this.recordingShortcut = active
  }

  /** 录制期间按下了已登记的全局快捷键：系统先拦下了它，转给设置页作为录到的组合。 */
  shortcutPressed(accelerator: string): void {
    if (!this.recording || accelerator === '') return
    this.window?.send('settings.shortcutPressed', { accelerator })
  }

  /** 外观或快捷键登记状态变了。 */
  publish(): void {
    const window = this.window
    if (window === null || this.disposed) return
    const snapshot = this.snapshot()
    window.send('settings.state', snapshot)
    const locale = snapshot.config?.resolvedLocale ?? 'en'
    window.setTitle(translate(locale, 'settings.windowTitle'))
    window.setBackgroundColor(WINDOW_BACKGROUND[snapshot.config?.resolvedTheme ?? 'light'])
  }

  dispose(): void {
    this.disposed = true
    this.active = false
    this.window?.destroy()
    this.window = null
  }

  private deactivate(): void {
    this.active = false
    this.recordingShortcut = false
    this.window?.hide()
  }

  private snapshot(): SettingsSnapshot {
    return {
      data: this.data,
      error: this.error,
      shortcut: this.options.shortcut(),
      electronVersion: this.options.platform.electronVersion,
      config: this.options.config(),
      section: this.section,
    }
  }

  /** 返回这次是否新建了窗口。 */
  private ensureWindow(): boolean {
    if (this.window !== null && !this.window.isDestroyed()) return false
    const theme = this.options.config()?.resolvedTheme ?? 'light'
    const window = this.options.platform.createWindow({
      ...SETTINGS_WINDOW_SIZE,
      minWidth: SETTINGS_WINDOW_MIN.width,
      minHeight: SETTINGS_WINDOW_MIN.height,
      backgroundColor: WINDOW_BACKGROUND[theme],
      parent: this.options.parent,
      page: 'settings',
    })
    this.window = window
    window.onClose((prevent) => {
      if (this.disposed) return
      // 系统发起的关闭（Alt+F4、窗口管理器的关闭键）只隐藏，窗口留着下次直接显示。
      prevent()
      this.close()
    })
    window.onRendererGone((reason) => {
      if (this.disposed) return
      this.options.logger.warn('settings.renderer-gone', { reason })
      this.requested = false
      window.reload()
    })
    return true
  }

  /** 放到主窗口中间，收回屏幕可用区域以内。 */
  private place(window: MainWindow): void {
    try {
      const parent = this.options.parent.getBounds()
      const current = window.getBounds()
      const size = current.width > 0 && current.height > 0 ? current : SETTINGS_WINDOW_SIZE
      window.setBounds(centerOver(parent, size, this.options.platform.workAreaFor(parent)))
    } catch (error) {
      this.options.logger.warn('settings.place-failed', { error: toErrorInfo(error).code })
    }
  }
}
