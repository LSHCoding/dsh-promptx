// platform.ts 接口的 Electron 实现。这里只做「把调用转给 Electron」，判断和流程都在 app.ts 等可测试的模块里。
// 窗口的选项和安全设置照 design-spec 5.4：隐藏创建、无边框、置顶、沙箱化、上下文隔离；
// 导航、新窗口、权限请求一律拒绝，CSP 写在 index.html 里。

import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  nativeTheme,
  screen,
  shell,
  Tray,
  type MenuItemConstructorOptions,
  type NativeImage,
} from 'electron'
import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { MIN_WINDOW } from '../../shared/layout.ts'
import { IPC_CHANNELS } from './channels.ts'
import { errorCode, type CompanionLogger } from './logger.ts'
import type { CompanionPlatform, MainWindow, TrayHandle, WindowCreateOptions, WindowEventName } from './platform.ts'
import { isProcessAlive } from './shortcut-lock.ts'
import { runTask } from './tasks.ts'
import type { TrayAction, TrayIconState, TrayItem } from './tray-model.ts'

export interface ElectronPlatformOptions {
  /** lib/app 目录：preload.cjs、renderer/index.html、assets/tray/ 都在这里。 */
  appDir: string
  logger: CompanionLogger
}

export function createElectronPlatform(options: ElectronPlatformOptions): CompanionPlatform {
  const { appDir, logger } = options
  const mac = process.platform === 'darwin'
  const windows = new WeakMap<MainWindow, BrowserWindow>()
  return {
    platform: process.platform,
    arch: process.arch,
    argv: process.argv,
    electronVersion: process.versions.electron,
    appVersion: app.getVersion(),
    pid: process.pid,
    now: () => performance.now(),
    whenReady: () => app.whenReady(),
    exit: (code) => {
      app.exit(code)
    },
    becomeAccessory: () => {
      if (!mac) return
      app.setActivationPolicy('accessory')
      app.dock?.hide()
    },
    installEditMenu: () => {
      Menu.setApplicationMenu(Menu.buildFromTemplate([{ role: 'editMenu' }]))
    },
    // app.show()、app.hide() 只在 macOS 上存在。
    appShow: () => {
      if (mac) app.show()
    },
    appHide: () => {
      if (mac) app.hide()
    },
    appFocusSteal: () => {
      app.focus({ steal: true })
    },
    preferredLanguages: () => app.getPreferredSystemLanguages(),
    systemDark: () => nativeTheme.shouldUseDarkColors,
    setThemeSource: (theme) => {
      nativeTheme.themeSource = theme
    },
    onThemeUpdated: (listener) => {
      nativeTheme.on('updated', listener)
    },
    displays: () => screen.getAllDisplays().map(display => ({ workArea: display.workArea })),
    cursorWorkArea: () => screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea,
    primaryWorkArea: () => screen.getPrimaryDisplay().workArea,
    workAreaFor: bounds => screen.getDisplayMatching(bounds).workArea,
    clipboard: {
      writeText: text => clipboard.writeText(text),
      readText: () => clipboard.readText(),
    },
    openExternal: url => shell.openExternal(url),
    shortcuts: {
      register: (accelerator, callback) => globalShortcut.register(accelerator, callback),
      unregister: (accelerator) => {
        globalShortcut.unregister(accelerator)
      },
      unregisterAll: () => {
        globalShortcut.unregisterAll()
      },
    },
    readSystemHotkeys: mac ? readSymbolicHotkeysXml : undefined,
    ipc: ipcMain,
    createWindow: windowOptions => createMainWindow(appDir, windowOptions, logger, windows),
    async showMessageBox(window, box) {
      const native = windows.get(window)
      if (native === undefined || native.isDestroyed()) return box.cancelId
      const result = await dialog.showMessageBox(native, { ...box, type: 'question', noLink: true })
      return result.response
    },
    createTray: onAction => createTray(appDir, onAction, logger),
    onBeforeQuit: (listener) => {
      app.on('before-quit', (event) => {
        listener(() => {
          event.preventDefault()
        })
      })
    },
    onSignal: (listener) => {
      for (const signal of ['SIGTERM', 'SIGINT'] as const) {
        process.on(signal, () => {
          listener(signal)
        })
      }
    },
    isProcessAlive,
  }
}

/**
 * `defaults export com.apple.symbolichotkeys -` 输出系统快捷键的 plist XML。用绝对路径，不受 PATH 影响；
 * 失败（超时、不存在、非零退出）时得到 null，不提示冲突。execFile 带回调时启动失败也走回调，不会抛 error 事件。
 */
function readSymbolicHotkeysXml(): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    try {
      execFile('/usr/bin/defaults', ['export', 'com.apple.symbolichotkeys', '-'], {
        encoding: 'utf8',
        timeout: 3000,
        maxBuffer: 4 * 1024 * 1024,
        windowsHide: true,
      }, (error, stdout) => {
        resolve(error === null ? stdout : null)
      })
    } catch {
      resolve(null)
    }
  })
}

function createMainWindow(
  appDir: string, options: WindowCreateOptions, logger: CompanionLogger, windows: WeakMap<MainWindow, BrowserWindow>,
): MainWindow {
  const parent = options.parent === undefined ? undefined : windows.get(options.parent)
  const win = new BrowserWindow({
    width: options.width,
    height: options.height,
    minWidth: MIN_WINDOW.width,
    minHeight: MIN_WINDOW.height,
    show: false,
    frame: false,
    resizable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    ...(parent === undefined ? {} : { parent }),
    modal: false,
    backgroundColor: options.backgroundColor,
    title: 'PromptX',
    webPreferences: {
      preload: join(appDir, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
      backgroundThrottling: false,
    },
  })
  win.setAlwaysOnTop(true, 'floating')
  const contents = win.webContents
  contents.on('will-navigate', (event) => {
    event.preventDefault()
  })
  contents.setWindowOpenHandler(() => ({ action: 'deny' }))
  contents.session.setPermissionRequestHandler((_contents, _permission, callback) => {
    callback(false)
  })
  contents.session.setPermissionCheckHandler(() => false)

  const indexHtml = join(appDir, 'renderer', 'index.html')
  const load = (): void => {
    // loadFile 的 Promise 在页面加载失败（包括被中止）时拒绝；只记日志，冒烟测试会发现界面没有就绪。
    runTask(logger, 'window-load', () => win.loadFile(indexHtml, options.entryEditor === true ? { hash: 'entry-editor' } : {}))
  }
  load()

  // BrowserWindow 的 on() 按事件名分了很多重载，联合类型的事件名匹配不上任何一个，按普通 EventEmitter 用。
  const emitter: NodeJS.EventEmitter = win
  // moved、resized 只在 macOS、Windows 上有；Linux 上换成 move、resize（拖动过程中连续触发，偏好写入本来就防抖）。
  const linux = process.platform === 'linux'
  const nativeEvent = (event: WindowEventName): string => {
    if (linux && event === 'moved') return 'move'
    if (linux && event === 'resized') return 'resize'
    return event
  }
  const window: MainWindow = {
    isVisible: () => win.isVisible(),
    isFocused: () => win.isFocused(),
    show: () => {
      win.show()
    },
    hide: () => {
      win.hide()
    },
    focus: () => {
      win.focus()
    },
    setVisibleOnAllWorkspaces: (visible, workspaceOptions) => {
      win.setVisibleOnAllWorkspaces(visible, workspaceOptions)
    },
    onceShow: (listener) => {
      win.once('show', listener)
    },
    getBounds: () => win.getBounds(),
    setBounds: (bounds) => {
      win.setBounds(bounds)
    },
    setMinimumSize: (width, height) => {
      win.setMinimumSize(width, height)
    },
    setBackgroundColor: (color) => {
      win.setBackgroundColor(color)
    },
    setTitle: (title) => { win.setTitle(title) },
    destroy: () => { win.destroy() },
    send: (event, payload) => {
      if (win.isDestroyed() || contents.isDestroyed()) return
      contents.send(IPC_CHANNELS.event, event, payload)
    },
    isSender: sender => sender === contents,
    reload: load,
    close: () => {
      win.close()
    },
    isDestroyed: () => win.isDestroyed(),
    on: (event, listener) => {
      emitter.on(nativeEvent(event), listener)
    },
    onClose: (listener) => {
      win.on('close', (event) => {
        listener(() => {
          event.preventDefault()
        })
      })
    },
    onRendererGone: (listener) => {
      contents.on('render-process-gone', (_event, details) => {
        listener(details.reason)
      })
    },
  }
  windows.set(window, win)
  return window
}

function createTray(appDir: string, onAction: (action: TrayAction) => void, logger: CompanionLogger): TrayHandle | null {
  const mac = process.platform === 'darwin'
  const images = new Map<TrayIconState, NativeImage>()
  // macOS 用模板图（文件名带 Template，系统按菜单栏明暗着色）；@2x 版本由 nativeImage 按同名规则自动加载。
  const imageFor = (state: TrayIconState): NativeImage => {
    let image = images.get(state)
    if (image === undefined) {
      image = nativeImage.createFromPath(join(appDir, 'assets', 'tray', mac ? `tray-${state}Template.png` : `tray-${state}.png`))
      if (mac) image.setTemplateImage(true)
      if (image.isEmpty()) logger.warn('tray.icon-missing', { state })
      images.set(state, image)
    }
    return image
  }

  let tray: Tray
  try {
    tray = new Tray(imageFor('normal'))
  } catch (error) {
    logger.warn('tray.create-failed', { error: errorCode(error) })
    return null
  }
  tray.setToolTip('PromptX')
  // Windows 上左键点击通知区图标默认不弹菜单，需求是「点击图标打开菜单」。
  if (process.platform === 'win32') {
    tray.on('click', () => {
      tray.popUpContextMenu()
    })
  }
  let icon: TrayIconState = 'normal'
  let tooltip = 'PromptX'
  let menuKey = ''
  return {
    // 内容没变就不重建：菜单正开着时整份替换会让它闪一下。
    update(model) {
      if (model.icon !== icon) {
        icon = model.icon
        tray.setImage(imageFor(icon))
      }
      if (model.tooltip !== tooltip) {
        tooltip = model.tooltip
        tray.setToolTip(tooltip)
      }
      const key = JSON.stringify(model.items)
      if (key === menuKey) return
      menuKey = key
      tray.setContextMenu(Menu.buildFromTemplate(model.items.map(item => toMenuItem(item, onAction))))
    },
    destroy() {
      tray.destroy()
    },
  }
}

function toMenuItem(item: TrayItem, onAction: (action: TrayAction) => void): MenuItemConstructorOptions {
  switch (item.kind) {
    case 'status':
      return { label: item.label, enabled: false }
    case 'separator':
      return { type: 'separator' }
    case 'action':
      return {
        label: item.label,
        // 只显示组合，不登记成菜单快捷键：全局快捷键已经由 globalShortcut 登记过了。
        ...(item.accelerator === null ? {} : { accelerator: item.accelerator, registerAccelerator: false }),
        click: () => {
          onAction(item.action)
        },
      }
  }
}
