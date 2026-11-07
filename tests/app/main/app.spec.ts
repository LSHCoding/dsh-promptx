// CompanionApp 的集成测试：假平台 + 真实协议（帧编解码和 RpcPeer 跑在两条管道上）+ 假界面。
// 覆盖启动顺序、配置与外观、窗口与快捷键、IPC、退出前写回草稿、渲染进程崩溃、冒烟和端到端模式。

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CompanionApp, type CompanionTimings } from '../../../src/app/main/app.ts'
import { IPC_CHANNELS } from '../../../src/app/main/channels.ts'
import { companionPaths, type CompanionEnv, type CompanionPaths } from '../../../src/app/main/env.ts'
import { physicalShortcutKey, shortcutLockPath } from '../../../src/app/main/shortcut-lock.ts'
import type { ResolvedConfig } from '../../../src/shared/bridge.ts'
import { PromptxError } from '../../../src/shared/errors.ts'
import { initialWindowBounds } from '../../../src/shared/layout.ts'
import { RPC_ERROR, type E2eResult, type HelloResult } from '../../../src/shared/protocol.ts'
import type { CompanionStatus } from '../../../src/shared/types.ts'
import {
  BASE_CONFIG,
  FakeHost,
  FakePlatform,
  FakeRenderer,
  sleep,
  until,
  WORK_AREA,
  type FakePlatformOptions,
} from './fakes.ts'
import { MemoryLogger, trapProcessErrors, useTempDir } from './helpers.ts'

trapProcessErrors()
const tempDir = useTempDir('app')

const FAST: Partial<CompanionTimings> = {
  helloTimeoutMs: 2000,
  flushMs: 300,
  signalFlushMs: 100,
  replyWriteMs: 100,
  parentCheckMs: 30,
  heldRetryMs: 30,
  settingsToastMs: 60,
  smokeWaitMs: 500,
  smokeReportMs: 300,
  rendererUnresponsiveMs: 80,
}

const SENTINEL = 'PROMPTX_SENTINEL_写作助手'

interface Harness {
  app: CompanionApp
  platform: FakePlatform
  host: FakeHost
  logger: MemoryLogger
  paths: CompanionPaths
}

interface StartOptions {
  platform?: FakePlatformOptions
  hello?: Partial<Omit<HelloResult, 'protocol'>> & { protocol?: number }
  timings?: Partial<CompanionTimings>
  parentPid?: number | null
  /** 启动前写好的 prefs.json 内容。 */
  prefs?: unknown
}

const running: Harness[] = []

// 记下测试期间创建的计时器：小程序退出后不能留下任何还在跑的 interval 或没到期的 timeout。
const pendingTimers = new Set<unknown>()
const realTimers = {
  setTimeout: globalThis.setTimeout,
  clearTimeout: globalThis.clearTimeout,
  setInterval: globalThis.setInterval,
  clearInterval: globalThis.clearInterval,
}

beforeEach(() => {
  pendingTimers.clear()
  globalThis.setTimeout = ((callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
    const handle = realTimers.setTimeout((...inner: unknown[]) => {
      pendingTimers.delete(handle)
      callback(...inner)
    }, ms, ...args)
    pendingTimers.add(handle)
    return handle
  }) as typeof setTimeout
  globalThis.clearTimeout = (handle?: Parameters<typeof clearTimeout>[0]) => {
    pendingTimers.delete(handle)
    realTimers.clearTimeout(handle)
  }
  globalThis.setInterval = ((callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
    const handle = realTimers.setInterval(callback, ms, ...args)
    pendingTimers.add(handle)
    return handle
  }) as typeof setInterval
  globalThis.clearInterval = (handle?: Parameters<typeof clearInterval>[0]) => {
    pendingTimers.delete(handle)
    realTimers.clearInterval(handle)
  }
})

afterEach(async () => {
  try {
    for (const harness of running.splice(0)) {
      if (harness.platform.exitCode === null) await harness.app.shutdown('test-end', 0, null)
      harness.host.close()
    }
    // 退出时排下的 setTimeout(0)、管道写完的回调都在这一小段时间里结束。
    await sleep(20)
    expect(pendingTimers.size).toBe(0)
  } finally {
    Object.assign(globalThis, realTimers)
  }
})

function start(options: StartOptions = {}): Harness {
  const platform = new FakePlatform(options.platform)
  const host = new FakeHost(options.hello)
  const logger = new MemoryLogger()
  const env: CompanionEnv = {
    dataDir: join(tempDir(), 'promptx'),
    profile: 'promptx-dev',
    profileHash: 'abcdef0123456789',
    parentPid: options.parentPid === undefined ? null : options.parentPid,
  }
  const paths = companionPaths(env)
  if (options.prefs !== undefined) {
    mkdirSync(env.dataDir, { recursive: true })
    writeFileSync(paths.prefs, JSON.stringify(options.prefs))
  }
  const app = new CompanionApp({
    platform,
    env,
    paths,
    logger,
    input: host.toCompanion,
    output: host.fromCompanion,
    timings: { ...FAST, ...options.timings },
  })
  app.start()
  const harness = { app, platform, host, logger, paths }
  running.push(harness)
  return harness
}

/** 启动、ready、等窗口建好并上报过快捷键状态。 */
async function boot(options: StartOptions = {}): Promise<Harness & { renderer: FakeRenderer }> {
  const harness = start(options)
  await until(() => harness.host.hello !== null, 2000, 'hello')
  harness.platform.ready()
  await until(() => harness.platform.windows.length === 1 && harness.host.of('status').length > 0, 2000, 'boot')
  const renderer = new FakeRenderer(harness.platform)
  return { ...harness, renderer }
}

function statuses(host: FakeHost): CompanionStatus[] {
  return host.of('status') as CompanionStatus[]
}

describe('startup order (design-spec 5.3, 5.4)', () => {
  it('sends hello right away, before app ready and before any window', async () => {
    const { host, platform, app } = start()
    await until(() => host.hello !== null, 2000, 'hello')
    expect(host.hello).toEqual({ protocol: 1, appVersion: '0.1.0', electron: '44.10.2', platform: 'darwin', arch: 'arm64' })
    expect(platform.windows).toHaveLength(0)
    expect(platform.calls).toEqual([])
    await until(() => app.mode !== null, 2000, 'hello reply')
    expect(app.mode).toBe('normal')
    // 配置早到了也只记下：nativeTheme、系统语言在 ready 之前不保证可用。
    expect(platform.appearanceBeforeReady).toBe(false)
    expect(app.config).toBeNull()
  })

  it('on ready becomes an accessory app with only an Edit menu, creates the hidden window, the tray and the shortcut', async () => {
    const { platform, host } = await boot()
    expect(platform.calls.slice(0, 4)).toEqual(['becomeAccessory', 'installEditMenu', 'createWindow', 'createTray'])
    expect(platform.window.visible).toBe(false)
    expect(platform.window.options).toEqual({ width: 980, height: 600, backgroundColor: '#ffffff' })
    expect([...platform.shortcuts.registered.keys()]).toEqual(['Control+P'])
    await until(() => statuses(host).some(status => status.shortcut?.registered === true), 2000, 'status')
    expect(host.lastStatus()).toEqual({ shortcut: { accelerator: 'Control+P', registered: true }, tray: true, visible: false })
    expect(platform.appearanceBeforeReady).toBe(false)
  })

  it('keeps running without a tray (only logged) and still registers the shortcut', async () => {
    const harness = start()
    harness.platform.trayFails = true
    harness.platform.ready()
    await until(() => statuses(harness.host).some(status => status.shortcut?.registered === true), 2000, 'status')
    expect(harness.host.lastStatus()).toMatchObject({ tray: false })
    expect(harness.logger.events('warn')).toContain('tray.failed')
    expect(harness.platform.exitCode).toBeNull()
  })

  it('exits with code 1 when the window cannot be created', async () => {
    const harness = start()
    harness.platform.windowFails = true
    harness.platform.ready()
    await expect(harness.platform.exited).resolves.toBe(1)
    expect(harness.logger.events('error')).toContain('boot.window-failed')
  })

  it('exits with code 1 without a window when the Host speaks another protocol version', async () => {
    const harness = start({ hello: { protocol: 2 } })
    await expect(harness.platform.exited).resolves.toBe(1)
    expect(harness.platform.windows).toHaveLength(0)
    expect(harness.logger.find('hello.failed')?.fields).toEqual({ error: 'promptx/companion/protocol-mismatch' })
  })
})

describe('configuration and appearance (S-03)', () => {
  it('sends the renderer a resolved config that follows the system for language and theme', async () => {
    const { platform, renderer } = await boot({ platform: { languages: ['zh-Hans-CN', 'en-US'], dark: true } })
    expect(platform.window.options.backgroundColor).toBe('#151517')
    const config = await renderer.invoke(IPC_CHANNELS.getConfig) as ResolvedConfig
    expect(config).toEqual({ ...BASE_CONFIG, resolvedLocale: 'zh', resolvedTheme: 'dark' })
  })

  it('re-sends the config when the system theme changes, and only then', async () => {
    const { platform, host, renderer } = await boot({ platform: { dark: true } })
    host.peer.notify('config', { ...BASE_CONFIG })
    await sleep(20)
    expect(renderer.events('config')).toEqual([])
    platform.dark = false
    platform.themeUpdated()
    platform.themeUpdated()
    await renderer.idle()
    await until(() => renderer.events('config').length === 1, 2000, 'config event')
    expect(renderer.events('config')[0]).toMatchObject({ resolvedTheme: 'light', resolvedLocale: 'en' })
    expect(platform.window.background).toBe('#ffffff')
  })

  it('picks up a changed system language at the latest on the next show (S-03)', async () => {
    const { platform, renderer } = await boot()
    platform.languages = ['zh-TW']
    platform.shortcuts.press('Control+P')
    await until(() => renderer.events('config').length === 1, 2000, 'config event')
    expect(renderer.events('config')[0]).toMatchObject({ resolvedLocale: 'zh' })
    // 界面先拿到新配置，再收到 window.shown。
    await until(() => renderer.received.length >= 2, 2000, 'events')
    expect(renderer.received.slice(0, 2).map(item => item.event)).toEqual(['config', 'window.shown'])
  })

  it('applies an explicit dsh theme to nativeTheme and to the resolved config', async () => {
    const { platform, host, renderer } = await boot()
    host.peer.notify('config', { ...BASE_CONFIG, theme: 'dark', locale: 'en' })
    await until(() => renderer.events('config').length === 1, 2000, 'config event')
    expect(platform.themeSource).toBe('dark')
    expect(renderer.events('config')[0]).toMatchObject({ theme: 'dark', resolvedTheme: 'dark', resolvedLocale: 'en' })
    expect(platform.window.background).toBe('#151517')
  })

  it('rebinds the shortcut live when the Host pushes a new combination (S-01, S-02)', async () => {
    const { platform, host } = await boot()
    host.peer.notify('config', { ...BASE_CONFIG, globalShortcut: 'Control+Alt+Shift+F9' })
    await until(() => (host.lastStatus() as CompanionStatus).shortcut?.accelerator === 'Control+Alt+Shift+F9', 2000, 'rebind')
    expect([...platform.shortcuts.registered.keys()]).toEqual(['Control+Alt+Shift+F9'])
    expect(platform.shortcuts.calls).toEqual(['register Control+P', 'unregister Control+P', 'register Control+Alt+Shift+F9'])
  })

  it('ignores a config notification that is not an object', async () => {
    const { platform, host, logger } = await boot()
    host.peer.notify('config', 'nonsense' as never)
    await until(() => logger.events('warn').includes('config.invalid'), 2000, 'warning')
    expect([...platform.shortcuts.registered.keys()]).toEqual(['Control+P'])
  })

  it('rebuilds the tray menu in the new language', async () => {
    const { platform, host } = await boot({ hello: { config: { ...BASE_CONFIG, locale: 'en' } } })
    await until(() => platform.tray?.statusLine().startsWith('● Running') === true, 2000, 'english tray')
    host.peer.notify('config', { ...BASE_CONFIG, locale: 'zh' })
    await until(() => platform.tray?.statusLine().startsWith('● 运行中') === true, 2000, 'chinese tray')
    expect(platform.tray?.statusLine()).toBe('● 运行中 · 全局快捷键已生效 · 运行时 44.10.2')
    expect(JSON.stringify(platform.tray?.last)).not.toMatch(/quit|退出/i)
  })
})

describe('showing and hiding (F-01, F-02, D10)', () => {
  it('toggles with the global shortcut: hidden → shown, focused → hidden, unfocused → focused', async () => {
    const { platform, renderer } = await boot()
    const window = platform.window
    platform.shortcuts.press('Control+P')
    expect(window.visible && window.focused).toBe(true)
    expect(platform.calls.slice(-2)).toEqual(['app.show', 'app.focus'])
    expect(window.calls.slice(-3)).toEqual(['workspaces:true:true', 'show', 'focus'])
    await until(() => window.calls.includes('workspaces:false:true'), 2000, 'workspace reset')
    await until(() => renderer.events('window.shown').length === 1, 2000, 'window.shown')

    await sleep(160)
    platform.shortcuts.press('Control+P')
    expect(window.visible).toBe(false)
    expect(platform.calls.at(-1)).toBe('app.hide')
    await until(() => renderer.events('window.hidden').length === 1, 2000, 'window.hidden')

    await sleep(160)
    platform.shortcuts.press('Control+P')
    window.blur()
    await sleep(160)
    platform.shortcuts.press('Control+P')
    expect(window.visible && window.focused).toBe(true)
    // 可见但没有焦点：拿回焦点，不隐藏；界面同样收到 window.shown，把焦点交给编辑区。
    await until(() => renderer.events('window.shown').length === 3, 2000, 'third window.shown')
  })

  it('keeps visibleOnFullScreen on both workspace calls (TC-03)', async () => {
    const { platform } = await boot()
    platform.shortcuts.press('Control+P')
    await until(() => platform.window.calls.includes('workspaces:false:true'), 2000, 'workspace reset')
    const workspaceCalls = platform.window.calls.filter(call => call.startsWith('workspaces'))
    expect(workspaceCalls).toEqual(['workspaces:true:true', 'workspaces:false:true'])
  })

  it('places the first show on the cursor screen with the default size, later shows at the saved place', async () => {
    const { platform, host } = await boot()
    host.peer.notify('window.command', { command: 'show' })
    await until(() => platform.window.visible, 2000, 'show')
    expect(platform.window.bounds).toEqual(initialWindowBounds(WORK_AREA))

    const other = await boot({ prefs: { version: 1, window: { x: 300, y: 200, width: 900, height: 500 } } })
    other.host.peer.notify('window.command', { command: 'show' })
    await until(() => other.platform.window.visible, 2000, 'show')
    expect(other.platform.window.bounds).toEqual({ x: 300, y: 200, width: 900, height: 500 })
    expect(other.platform.window.options).toMatchObject({ width: 900, height: 500 })
  })

  it('runs Host window commands and remembers one that came before the window existed', async () => {
    const harness = start()
    await until(() => harness.app.mode !== null, 2000, 'hello')
    harness.host.peer.notify('window.command', { command: 'show' })
    await sleep(20)
    harness.platform.ready()
    await until(() => harness.platform.windows[0]?.visible === true, 2000, 'pending show')
    harness.host.peer.notify('window.command', { command: 'hide' })
    await until(() => !harness.platform.window.visible, 2000, 'hide')
    harness.host.peer.notify('window.command', { command: 'toggle' })
    await until(() => harness.platform.window.visible, 2000, 'toggle')
    harness.host.peer.notify('window.command', { command: 'explode' } as never)
    await sleep(20)
    expect(harness.platform.window.visible).toBe(true)
  })

  it('only hides on a system close (Alt+F4) and does not exit (TC-11)', async () => {
    const { platform } = await boot()
    platform.shortcuts.press('Control+P')
    platform.window.close()
    expect(platform.window.visible).toBe(false)
    expect(platform.window.destroyed).toBe(false)
    await sleep(30)
    expect(platform.exitCode).toBeNull()
  })

  it('hides on blur when the option is on', async () => {
    const { platform } = await boot({ hello: { config: { ...BASE_CONFIG, hideOnBlur: true } } })
    platform.shortcuts.press('Control+P')
    platform.window.blur()
    await until(() => !platform.window.visible, 2000, 'hide on blur')
  })

  it('reports visibility changes to the Host', async () => {
    const { platform, host } = await boot()
    platform.shortcuts.press('Control+P')
    await until(() => (host.lastStatus() as CompanionStatus).visible, 2000, 'visible status')
    platform.window.hide()
    await until(() => !(host.lastStatus() as CompanionStatus).visible, 2000, 'hidden status')
  })
})

describe('tray menu (F-05)', () => {
  it('shows, hides, resets the position, opens settings and asks the Host to restart', async () => {
    const { platform, host } = await boot()
    host.peer.handle('host.openSettings', () => ({ open: 'dsh://open', navigated: false }))
    platform.clickTray('toggle')
    expect(platform.window.visible).toBe(true)
    await until(() => platform.tray?.last?.items.some(item => item.kind === 'action' && item.label === 'Hide PromptX') === true, 2000, 'label')
    platform.window.setBounds({ x: 5000, y: 5000, width: 600, height: 400 })
    platform.clickTray('reset-position')
    expect(platform.window.bounds).toEqual(initialWindowBounds(WORK_AREA))
    platform.clickTray('settings')
    await until(() => platform.opened.length === 1, 2000, 'open settings')
    expect(platform.opened).toEqual(['dsh://open'])
    expect(platform.window.visible).toBe(false)
    platform.clickTray('restart')
    await until(() => host.of('host.restartCompanion').length === 1, 2000, 'restart')
  })

  it('shows the shortcut next to Show/Hide and warns in the first line when it is not active', async () => {
    const { platform } = await boot()
    await until(() => platform.tray?.last !== undefined, 2000, 'tray')
    const toggle = platform.tray?.last?.items.find(item => item.kind === 'action' && item.action === 'toggle')
    expect(toggle).toMatchObject({ label: 'Show PromptX', accelerator: 'Control+P' })
    expect(platform.tray?.last?.icon).toBe('normal')
  })
})

describe('renderer requests over IPC (5.3, 9)', () => {
  it('refuses requests from any other webContents', async () => {
    const { platform } = await boot()
    await expect(platform.ipc.invoke({ id: 'devtools' }, IPC_CHANNELS.call, 'draft.load', {})).rejects.toThrow('untrusted sender')
    await expect(platform.ipc.invoke({ id: 'devtools' }, IPC_CHANNELS.windowCopyAndHide, 'x')).rejects.toThrow('untrusted sender')
  })

  it('forwards allowed requests to the Host and returns BridgeResults', async () => {
    const { host, renderer } = await boot()
    host.peer.handle('draft.load', () => ({ record: null }))
    host.peer.handle('library.read', () => {
      throw new PromptxError('promptx/library/not-found')
    })
    await expect(renderer.call('draft.load', {})).resolves.toEqual({ ok: true, value: { record: null } })
    await expect(renderer.call('library.read', { relPath: 'a.md' })).resolves.toEqual({ ok: false, error: { code: 'promptx/library/not-found' } })
    await expect(renderer.call('hello', {})).resolves.toEqual({ ok: false, error: { code: 'promptx/internal', detail: 'invalid arguments' } })
  })

  it('waits for the handshake before forwarding', async () => {
    const harness = start()
    harness.platform.ready()
    await until(() => harness.platform.windows.length === 1, 2000, 'window')
    harness.host.peer.handle('draft.load', () => ({ record: null }))
    const renderer = new FakeRenderer(harness.platform)
    await expect(renderer.call('draft.load', {})).resolves.toEqual({ ok: true, value: { record: null } })
  })

  it('copy-and-hide writes and verifies the clipboard, then hides (F-03)', async () => {
    const { platform, renderer } = await boot()
    platform.shortcuts.press('Control+P')
    const text = '  # 标题\n\n- 列表\n    - 缩进\n\n'
    await expect(renderer.invoke(IPC_CHANNELS.windowCopyAndHide, text)).resolves.toEqual({ ok: true, value: null })
    expect(platform.clipboard.text).toBe(text)
    expect(platform.window.visible).toBe(false)
    expect(platform.calls.at(-1)).toBe('app.hide')
  })

  it('keeps the window when the clipboard write fails', async () => {
    const { platform, renderer } = await boot()
    platform.shortcuts.press('Control+P')
    platform.clipboard.failWrite = true
    await expect(renderer.invoke(IPC_CHANNELS.windowCopyAndHide, 'x')).resolves.toEqual({
      ok: false,
      error: { code: 'promptx/clipboard/write-failed', detail: 'clipboard busy' },
    })
    expect(platform.window.visible).toBe(true)
  })

  it('copyText writes the clipboard without hiding (COV-09)', async () => {
    const { platform, renderer } = await boot()
    platform.shortcuts.press('Control+P')
    await expect(renderer.invoke(IPC_CHANNELS.windowCopyText, '候选')).resolves.toEqual({ ok: true, value: null })
    expect(platform.clipboard.text).toBe('候选')
    expect(platform.window.visible).toBe(true)
  })

  it('opens settings: dsh://open hides at once; a page that navigated keeps the toast for a moment', async () => {
    const { platform, host, renderer } = await boot()
    const replies = [{ open: 'dsh://open', navigated: true }, { open: null, navigated: true }]
    host.peer.handle('host.openSettings', () => replies.shift() ?? { open: null, navigated: false })
    platform.shortcuts.press('Control+P')
    await expect(renderer.invoke(IPC_CHANNELS.windowOpenSettings)).resolves.toEqual({ ok: true, value: { navigated: true } })
    expect(platform.opened).toEqual(['dsh://open'])
    expect(platform.window.visible).toBe(false)

    await sleep(160)
    platform.shortcuts.press('Control+P')
    await expect(renderer.invoke(IPC_CHANNELS.windowOpenSettings)).resolves.toEqual({ ok: true, value: { navigated: true } })
    expect(platform.window.visible).toBe(true)
    await until(() => !platform.window.visible, 2000, 'delayed hide')
    expect(platform.opened).toEqual(['dsh://open'])
  })

  it('reports a settings failure and keeps the window', async () => {
    const { platform, host, renderer } = await boot()
    host.peer.handle('host.openSettings', () => {
      throw new PromptxError('promptx/settings/unavailable')
    })
    platform.shortcuts.press('Control+P')
    await expect(renderer.invoke(IPC_CHANNELS.windowOpenSettings)).resolves.toEqual({ ok: false, error: { code: 'promptx/settings/unavailable' } })
    expect(platform.window.visible).toBe(true)
  })

  it('reads bounds, sets the width and follows the minimum width of the open panes (COV-13)', async () => {
    const { platform, renderer } = await boot()
    renderer.send(IPC_CHANNELS.windowSetMinWidth, 1100)
    expect(platform.window.minimum).toEqual({ width: 1100, height: 360 })
    expect(platform.window.bounds.width).toBe(1100)
    renderer.send(IPC_CHANNELS.windowSetMinWidth, 5000)
    expect(platform.window.minimum).toEqual({ width: WORK_AREA.width, height: 360 })
    renderer.send(IPC_CHANNELS.windowSetMinWidth, 0)
    expect(platform.window.minimum).toEqual({ width: 520, height: 360 })
    const bounds = await renderer.invoke(IPC_CHANNELS.windowSetWidth, 900, 'right')
    expect(bounds).toMatchObject({ width: 900, workArea: WORK_AREA })
    await expect(renderer.invoke(IPC_CHANNELS.windowGetBounds)).resolves.toEqual({ ...platform.window.bounds, workArea: WORK_AREA })
  })

  it('stores panes from the renderer and the window position from dragging (7.6)', async () => {
    const { app, platform, renderer, paths } = await boot()
    platform.shortcuts.press('Control+P')
    renderer.send(IPC_CHANNELS.prefsSet, { panes: { library: true, listWidth: 280 } })
    platform.window.moveTo(222, 111)
    await app.shutdown('test', 0, null)
    const prefs = JSON.parse(readFileSync(paths.prefs, 'utf8')) as { window: { x: number; y: number }; panes: { library: boolean; listWidth: number } }
    expect(prefs.window).toMatchObject({ x: 222, y: 111 })
    expect(prefs.panes).toMatchObject({ library: true, listWidth: 280 })
    await expect(renderer.invoke(IPC_CHANNELS.prefsGet)).resolves.toMatchObject({ panes: { library: true } })
  })
})

describe('writing the draft back before exit (S07, design-spec 5.2)', () => {
  it('on shutdown asks the renderer to flush, waits for the save, replies and exits 0', async () => {
    const { platform, host, renderer } = await boot()
    const order: string[] = []
    host.peer.handle('draft.save', (params) => {
      order.push(`save:${params.text}`)
      return { updatedAt: '2026-11-08T00:00:00Z' }
    })
    renderer.text = 'latest draft'
    renderer.ready()
    const reply = host.peer.request('shutdown', { reason: 'dispose' }).then((result) => {
      order.push('reply')
      return result
    })
    await expect(reply).resolves.toEqual({})
    await expect(platform.exited).resolves.toBe(0)
    expect(order).toEqual(['save:latest draft', 'reply'])
    expect(renderer.events('flush')).toEqual([{ id: 1 }])
  })

  it('replies at once when the renderer has no draft loaded yet', async () => {
    const { platform, host, renderer } = await boot()
    await expect(host.peer.request('shutdown', { reason: 'dispose' })).resolves.toEqual({})
    await expect(platform.exited).resolves.toBe(0)
    expect(renderer.events('flush')).toEqual([])
  })

  it('does not let a stuck renderer hold the exit for longer than the flush limit', async () => {
    const { platform, host, renderer } = await boot()
    renderer.answerFlush = false
    renderer.ready()
    const started = Date.now()
    await expect(host.peer.request('shutdown', { reason: 'dispose' })).resolves.toEqual({})
    expect(Date.now() - started).toBeGreaterThanOrEqual(250)
    await expect(platform.exited).resolves.toBe(0)
  })

  it('exits when stdin ends (Host gone), after trying to write the draft back', async () => {
    const { platform, host, renderer } = await boot()
    renderer.ready()
    host.toCompanion.end()
    await expect(platform.exited).resolves.toBe(0)
    await until(() => renderer.events('flush').length === 1, 2000, 'flush')
  })

  it('exits when the parent process is gone (orphan prevention)', async () => {
    const harness = start({ parentPid: 999 })
    await expect(harness.platform.exited).resolves.toBe(0)
    expect(harness.logger.events('warn')).toContain('host.parent-gone')
  })

  it('keeps running while the parent is alive', async () => {
    const harness = start({ parentPid: 999 })
    harness.platform.alive.add(999)
    await sleep(100)
    expect(harness.platform.exitCode).toBeNull()
  })

  it('intercepts before-quit, writes the draft back, then exits', async () => {
    const { platform, renderer } = await boot()
    renderer.ready()
    expect(platform.beforeQuit()).toBe(true)
    await expect(platform.exited).resolves.toBe(0)
    await until(() => renderer.events('flush').length === 1, 2000, 'flush')
    expect(platform.beforeQuit()).toBe(false)
  })

  it('exits on SIGTERM', async () => {
    const { platform } = await boot()
    platform.signal('SIGTERM')
    await expect(platform.exited).resolves.toBe(0)
  })

  it('releases the shortcut and its lock, removes the tray and stops every timer on exit', async () => {
    const { app, platform, paths } = await boot()
    const lock = shortcutLockPath(paths.locksDir, physicalShortcutKey('Control+P', 'darwin') ?? '')
    expect(existsSync(lock)).toBe(true)
    await app.shutdown('test', 0, null)
    expect(platform.shortcuts.registered.size).toBe(0)
    expect(platform.shortcuts.calls.at(-1)).toBe('unregisterAll')
    expect(existsSync(lock)).toBe(false)
    expect(readdirSync(paths.locksDir)).toEqual([])
    expect(platform.tray?.destroyed).toBe(true)
    expect(platform.exitCode).toBe(0)
  })

  it('runs the exit steps once even when several exit paths arrive together', async () => {
    const { app, platform, host } = await boot()
    platform.signal('SIGTERM')
    host.toCompanion.end()
    await app.shutdown('again', 5, null)
    await sleep(20)
    expect(platform.calls.filter(call => call.startsWith('exit'))).toEqual(['exit 0'])
  })
})

describe('renderer crashes (S14, design-spec 5.4)', () => {
  it('reloads after a crash, shows the error icon until ready, and exits 3 on a second crash within 30 s', async () => {
    const { platform, renderer } = await boot()
    renderer.ready()
    platform.window.rendererGone('crashed')
    expect(platform.window.calls).toContain('reload')
    await until(() => platform.tray?.last?.icon === 'error', 2000, 'error icon')
    renderer.ready()
    await until(() => platform.tray?.last?.icon === 'normal', 2000, 'normal icon')
    expect(platform.exitCode).toBeNull()
    platform.window.rendererGone('oom')
    await expect(platform.exited).resolves.toBe(3)
  })

  it('ignores a clean exit of the renderer', async () => {
    const { platform } = await boot()
    platform.window.rendererGone('clean-exit')
    await sleep(20)
    expect(platform.window.calls).not.toContain('reload')
    expect(platform.exitCode).toBeNull()
  })

  it('exits 3 when the window stays unresponsive', async () => {
    const { platform } = await boot()
    platform.window.emit('unresponsive')
    await expect(platform.exited).resolves.toBe(3)
  })

  it('keeps running when the window becomes responsive again in time', async () => {
    const { platform } = await boot()
    platform.window.emit('unresponsive')
    await sleep(30)
    platform.window.emit('responsive')
    await sleep(100)
    expect(platform.exitCode).toBeNull()
  })
})

describe('global shortcut coordination (TC-02, D22)', () => {
  it('does not register a combination another live PromptX holds, and takes it over once that one is gone', async () => {
    const harness = start()
    const lock = shortcutLockPath(harness.paths.locksDir, 'Control+P')
    mkdirSync(harness.paths.locksDir, { recursive: true })
    writeFileSync(lock, JSON.stringify({ pid: 777, profile: 'work' }))
    harness.platform.alive.add(777)
    harness.platform.ready()
    await until(() => statuses(harness.host).some(status => status.shortcut?.error?.code === 'promptx/shortcut/held-by-profile'), 2000, 'held')
    expect(harness.host.lastStatus()).toMatchObject({
      shortcut: { accelerator: 'Control+P', registered: false, error: { code: 'promptx/shortcut/held-by-profile', detail: 'work' } },
    })
    expect(harness.platform.shortcuts.registered.size).toBe(0)
    await until(() => harness.platform.tray?.last?.icon === 'warn', 2000, 'warn icon')
    expect(harness.platform.tray?.statusLine()).toBe('⚠ Global shortcut not active: used by PromptX in profile work · Runtime 44.10.2')

    harness.platform.alive.delete(777)
    await until(() => (harness.host.lastStatus() as CompanionStatus).shortcut?.registered === true, 2000, 'takeover')
    expect(JSON.parse(readFileSync(lock, 'utf8'))).toMatchObject({ pid: 4242, profile: 'promptx-dev' })
  })

  it('warns about a macOS system shortcut but keeps the registration', async () => {
    const empty = '<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0">\n<dict/>\n</plist>\n'
    const { host, platform } = await boot({
      platform: { readSystemHotkeys: () => Promise.resolve(empty) },
      hello: { config: { ...BASE_CONFIG, globalShortcut: 'Command+Space' } },
    })
    await until(() => (host.lastStatus() as CompanionStatus).shortcut?.warning !== undefined, 2000, 'warning')
    expect(host.lastStatus()).toEqual({
      shortcut: {
        accelerator: 'Command+Space',
        registered: true,
        warning: { code: 'promptx/shortcut/system-conflict', detail: 'Show Spotlight search' },
      },
      tray: true,
      visible: false,
    })
    expect(platform.shortcuts.registered.has('Command+Space')).toBe(true)
  })
})

describe('smoke mode', () => {
  it('after the renderer is ready shows the window, checks that close only hides, and reports', async () => {
    const { platform, host, renderer } = await boot({ hello: { mode: 'smoke' } })
    renderer.ready()
    await until(() => host.of('smoke.report').length === 1, 3000, 'smoke report')
    expect(host.of('smoke.report')[0]).toEqual({
      windowCreated: true,
      windowShown: true,
      rendererReady: true,
      editorMounted: true,
      draftLoaded: true,
      shortcut: { accelerator: 'Control+P', registered: true },
      tray: true,
      noSandbox: false,
      closeHides: true,
    })
    expect(platform.window.destroyed).toBe(false)
    expect(platform.exitCode).toBeNull()
  })

  it('reports --no-sandbox and a failed draft load as they are', async () => {
    const { host, renderer } = await boot({
      hello: { mode: 'smoke' },
      platform: { argv: ['/opt/electron/electron', '/lib/app', '--promptx-companion=abc', '--no-sandbox'] },
    })
    renderer.ready(false)
    await until(() => host.of('smoke.report').length === 1, 3000, 'smoke report')
    expect(host.of('smoke.report')[0]).toMatchObject({ noSandbox: true, draftLoaded: false, rendererReady: true })
  })

  it('still reports when the renderer never becomes ready', async () => {
    const { host } = await boot({ hello: { mode: 'smoke' } })
    await until(() => host.of('smoke.report').length === 1, 3000, 'smoke report')
    expect(host.of('smoke.report')[0]).toMatchObject({
      windowCreated: true,
      windowShown: false,
      rendererReady: false,
      editorMounted: false,
      draftLoaded: false,
      closeHides: false,
    })
  })

  it('does nothing of the sort in normal mode', async () => {
    const { host, renderer, platform } = await boot()
    renderer.ready()
    await sleep(350)
    expect(host.of('smoke.report')).toEqual([])
    expect(platform.window.visible).toBe(false)
  })
})

describe('e2e mode (testing-plan 5, D17)', () => {
  it('does not register e2e.run unless the Host said e2e', async () => {
    const { host } = await boot()
    await expect(host.peer.request('e2e.run', { action: 'state' })).rejects.toMatchObject({ rpcCode: RPC_ERROR.methodNotFound })
  })

  it('runs the core path: show, copy and hide through the renderer, verify and restore the clipboard', async () => {
    const { platform, host, renderer } = await boot({ hello: { mode: 'e2e' } })
    renderer.ready()
    const text = '# 写作助手\n\n## 要求\n\n- 第一项\n    - 缩进的子项\n'
    const result = await host.peer.request('e2e.run', { action: 'core-path', text })
    expect(result).toMatchObject({
      ok: true,
      data: {
        focused: true,
        rendererAck: true,
        hidden: true,
        clipboardMatches: true,
        clipboardBeforeHide: true,
        renderer: { copied: true },
      },
    })
    expect(typeof result.data.showMs).toBe('number')
    expect(typeof result.data.copyToHiddenMs).toBe('number')
    expect(platform.window.visible).toBe(false)
    expect(platform.clipboard.text).toBe('previous clipboard')
    expect(platform.clipboard.writes).toEqual([text, 'previous clipboard'])
  })

  it('reports state and save results from the renderer', async () => {
    const { host, renderer } = await boot({ hello: { mode: 'e2e' } })
    renderer.ready()
    const state: E2eResult = await host.peer.request('e2e.run', { action: 'state' })
    expect(state).toMatchObject({ ok: true, data: { mode: 'e2e', booted: true, rendererReady: true, tray: true, renderer: { textLength: 0 } } })
    const saved: E2eResult = await host.peer.request('e2e.run', { action: 'save-to-library' })
    expect(saved).toMatchObject({ ok: true, data: { outcome: 'saved', relPath: 'e2e.md' } })
    expect(typeof saved.data.ms).toBe('number')
  })
})

describe('logs (N-02)', () => {
  it('never contain the text that went through the companion', async () => {
    const { platform, host, renderer, logger } = await boot({ hello: { mode: 'e2e', config: { ...BASE_CONFIG, profile: SENTINEL } } })
    host.peer.handle('draft.save', () => {
      throw new PromptxError('promptx/draft/write-failed', 'ENOSPC: no space left on device')
    })
    renderer.ready()
    await renderer.call('draft.save', { text: SENTINEL, selection: null, binding: null })
    await renderer.invoke(IPC_CHANNELS.windowCopyText, SENTINEL)
    await host.peer.request('e2e.run', { action: 'core-path', text: SENTINEL })
    platform.clipboard.failWrite = true
    await renderer.invoke(IPC_CHANNELS.windowCopyAndHide, SENTINEL)
    expect(logger.entries.length).toBeGreaterThan(5)
    expect(logger.dump()).not.toContain('PROMPTX_SENTINEL')
    expect(logger.find('call.failed')?.fields).toMatchObject({ method: 'draft.save', code: 'promptx/draft/write-failed' })
  })
})
