// @vitest-environment jsdom
// 设置窗口（V0.1.6 design-spec 3、6）：分区导航、逐项生效、提交后的覆盖值、快捷键录制、库目录、优化指令。

import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { SettingsSnapshot } from '../../../src/shared/bridge.ts'
import type { SettingsData, SettingsSection } from '../../../src/shared/types.ts'
import { SettingsApp } from '../../../src/app/renderer/settings/App.tsx'
import { INSTRUCTION_DELAY_MS, PENDING_MS, SettingsController } from '../../../src/app/renderer/settings/controller.ts'
import { describeGlobalShortcut, effectiveConfig, localShortcutError, settlePending, shortcutTokens } from '../../../src/app/renderer/settings/model.ts'
import { config, deferred, fail, FakeBridge, keyEvent, ok, settle } from './helpers.ts'

const controllers: SettingsController[] = []

afterEach(() => {
  cleanup()
  for (const controller of controllers.splice(0)) controller.dispose()
  vi.useRealTimers()
  document.body.removeAttribute('data-ds-dark-theme')
})

function data(overrides: Partial<SettingsData['config']> = {}): SettingsData {
  return {
    config: {
      libraryDir: '', confirmDelete: true, convertMiddleDot: true, convertYen: true, optimizeInstruction: '', globalShortcut: 'Control+P',
      shortcutLibrary: 'CommandOrControl+L', shortcutSave: 'CommandOrControl+S', shortcutOptimize: 'CommandOrControl+Shift+O',
      shortcutClear: '', shortcutChat: '', shortcutSettings: '', shortcutClose: 'Escape', hideOnBlur: false, runtimeSource: 'auto',
      ...overrides,
    },
    effectiveLibraryDir: '/Users/me/.dsh/promptx/library',
    defaultLibraryDir: '/Users/me/.dsh/promptx/library',
    defaultShortcut: 'Control+P',
    defaultInstruction: { zh: '默认优化指令', en: 'Default instruction' },
    platform: 'darwin',
    hostVersion: '0.1.6',
    profile: 'promptx-dev',
    runtime: { version: '44.10.2', source: 'mirror' },
  }
}

function snapshot(overrides: Partial<SettingsSnapshot> = {}, section: { seq: number; section: SettingsSection } = { seq: 0, section: 'shortcuts' }): SettingsSnapshot {
  return {
    data: data(),
    error: null,
    shortcut: { accelerator: 'Control+P', registered: true },
    electronVersion: '44.10.2',
    config: config(),
    section,
    ...overrides,
  }
}

interface Started {
  controller: SettingsController
  bridge: FakeBridge
}

/** 扮演主进程：写入后先推一份写入之后取的快照，再回复（main/settings-window.ts 的 update）。 */
function applyWrites(bridge: FakeBridge, initial: SettingsData = data()): void {
  let current = initial
  bridge.settings.update.mockImplementation(async (patch) => {
    current = { ...current, config: { ...current.config, ...patch } }
    if (patch.libraryDir !== undefined) {
      current = { ...current, effectiveLibraryDir: patch.libraryDir === '' ? current.defaultLibraryDir : patch.libraryDir }
    }
    bridge.emit('settings.state', snapshot({ data: current }))
    return ok({ ok: true as const })
  })
}

async function start(initial: SettingsSnapshot = snapshot(), bridge = new FakeBridge()): Promise<Started> {
  bridge.settings.getState.mockResolvedValue(ok(initial))
  const controller = new SettingsController(bridge, { locale: 'zh' })
  controllers.push(controller)
  await controller.start()
  return { controller, bridge }
}

async function mount(initial: SettingsSnapshot = snapshot(), bridge = new FakeBridge()): Promise<Started> {
  bridge.settings.getState.mockResolvedValue(ok(initial))
  const controller = new SettingsController(bridge, { locale: 'zh' })
  controllers.push(controller)
  render(<SettingsApp controller={controller} />)
  await act(async () => { await controller.start() })
  return { controller, bridge }
}

describe('model', () => {
  it('draws one key cap per modifier and the main key, per platform', () => {
    expect(shortcutTokens('Control+Shift+P', 'globalShortcut', 'darwin')).toEqual(['⌃', '⇧', 'P'])
    expect(shortcutTokens('CommandOrControl+Enter', 'shortcutSave', 'darwin')).toEqual(['⌘', '↩'])
    expect(shortcutTokens('CommandOrControl+Shift+O', 'shortcutOptimize', 'win32')).toEqual(['Ctrl', 'Shift', 'O'])
    expect(shortcutTokens('Super+Escape', 'shortcutClose', 'linux')).toEqual(['Super', 'Esc'])
    expect(shortcutTokens('', 'shortcutClear', 'darwin')).toEqual([])
  })

  it('finds conflicts with another action or Copy and hide before submitting', () => {
    const current = data().config
    expect(localShortcutError('shortcutLibrary', 'Command+S', current, 'darwin')).toBe('shortcut-conflict')
    expect(localShortcutError('shortcutClear', 'Command+Enter', current, 'darwin')).toBe('shortcut-conflict')
    expect(localShortcutError('shortcutClear', 'Command+K', current, 'darwin')).toBeNull()
    expect(localShortcutError('globalShortcut', 'P', current, 'darwin')).toBe('shortcut-invalid')
    expect(localShortcutError('shortcutClear', '', current, 'darwin')).toBeNull()
  })

  it('describes the global shortcut status like the dsh settings page', () => {
    expect(describeGlobalShortcut('zh', 'Control+P', { accelerator: 'Control+P', registered: true }, 'darwin')).toEqual({ tone: 'done', text: '已生效' })
    expect(describeGlobalShortcut('zh', '', null, 'darwin').tone).toBe('idle')
    expect(describeGlobalShortcut('zh', 'Control+P', null, 'darwin')).toEqual({ tone: 'ongoing', text: '正在登记…' })
    expect(describeGlobalShortcut('zh', 'Control+P', { accelerator: 'Control+P', registered: false, error: { code: 'promptx/shortcut/taken' } }, 'darwin'))
      .toEqual({ tone: 'error', text: '没有生效：快捷键已被其他应用占用' })
    expect(describeGlobalShortcut('zh', 'Control+K', {
      accelerator: 'Control+P', registered: true, error: { code: 'promptx/shortcut/taken', detail: 'Control+K' },
    }, 'darwin')).toEqual({ tone: 'warning', text: '⌃K 没有生效（快捷键已被其他应用占用），仍在使用 ⌃P' })
    expect(describeGlobalShortcut('zh', 'Control+P', { accelerator: 'Control+P', registered: true, warning: { code: 'promptx/shortcut/system-conflict' } }, 'darwin'))
      .toEqual({ tone: 'warning', text: '已生效，可能与系统快捷键冲突' })
  })

  it('keeps a submitted value until the Host config shows it or it expires', () => {
    const base = data().config
    const pending = { convertYen: { value: false, until: 1000 } }
    expect(effectiveConfig(base, pending, 500).convertYen).toBe(false)
    expect(settlePending(pending, base, 500)).toBe(pending)
    expect(settlePending(pending, { ...base, convertYen: false }, 500)).toEqual({})
    expect(settlePending(pending, base, 1001)).toEqual({})
    expect(effectiveConfig(base, pending, 1001).convertYen).toBe(true)
  })
})

describe('SettingsController', () => {
  it('loads the snapshot, follows the requested section only when its seq grows, and keeps the user’s own choice', async () => {
    const { controller, bridge } = await start(snapshot({}, { seq: 3, section: 'library' }))
    expect(controller.store.getState()).toMatchObject({ load: 'ready', section: 'library', locale: 'zh' })
    controller.selectSection('about')
    bridge.emit('settings.state', snapshot({}, { seq: 3, section: 'library' }))
    expect(controller.store.getState().section).toBe('about')
    bridge.emit('settings.state', snapshot({}, { seq: 4, section: 'optimize' }))
    expect(controller.store.getState().section).toBe('optimize')
  })

  it('shows a load error with the reason and recovers on retry', async () => {
    const bridge = new FakeBridge()
    bridge.settings.getState.mockResolvedValueOnce(fail('promptx/channel/closed'))
    const controller = new SettingsController(bridge, { locale: 'zh' })
    controllers.push(controller)
    await controller.start()
    expect(controller.store.getState()).toMatchObject({ load: 'error', loadError: { code: 'promptx/channel/closed' } })
    bridge.settings.getState.mockResolvedValueOnce(ok(snapshot()))
    await controller.load()
    expect(controller.store.getState().load).toBe('ready')
  })

  it('submits a toggle at once and shows the submitted value while the request is in flight', async () => {
    const { controller, bridge } = await start()
    const reply = deferred<ReturnType<typeof ok<{ ok: true }>>>()
    bridge.settings.update.mockReturnValueOnce(reply.promise)
    controller.setToggle('convertYen', false)
    expect(bridge.settings.update).toHaveBeenCalledWith({ convertYen: false })
    expect(controller.config()?.convertYen).toBe(false)
    expect(controller.store.getState().saving.convertYen).toBe(true)
    // 别的推送（写入之前取的）还是旧值：继续显示提交值。
    bridge.emit('settings.state', snapshot())
    expect(controller.config()?.convertYen).toBe(false)
    // 主进程在回复之前推来写入之后的快照。
    bridge.emit('settings.state', snapshot({ data: data({ convertYen: false }) }))
    reply.resolve(ok({ ok: true }))
    await settle()
    expect(controller.store.getState().saving.convertYen).toBeUndefined()
    expect(controller.store.getState().pending).toEqual({})
    expect(controller.config()?.convertYen).toBe(false)
  })

  it('shows the last write once the Host answers, even when the other page changed the same field right after (V0.1.6 追加 2)', async () => {
    const { controller, bridge } = await start()
    const reply = deferred<ReturnType<typeof ok<{ ok: true }>>>()
    bridge.settings.update.mockReturnValueOnce(reply.promise)
    controller.setToggle('convertYen', false)
    // 写入之后取的快照里已经是 dsh 插件页紧接着保存的 true：它是最后一次写入。
    bridge.emit('settings.state', snapshot({ data: data({ convertYen: true }) }))
    expect(controller.config()?.convertYen).toBe(false)
    reply.resolve(ok({ ok: true }))
    await settle()
    expect(controller.config()?.convertYen).toBe(true)
  })

  it('keeps the submitted value until it expires when reading the config after the write failed', async () => {
    vi.useFakeTimers()
    const { controller, bridge } = await start()
    bridge.settings.update.mockImplementationOnce(async () => {
      bridge.emit('settings.state', snapshot({ error: { code: 'promptx/channel/timeout' } }))
      return ok({ ok: true as const })
    })
    controller.setToggle('confirmDelete', false)
    await vi.advanceTimersByTimeAsync(0)
    expect(controller.config()?.confirmDelete).toBe(false)
    await vi.advanceTimersByTimeAsync(PENDING_MS + 50)
    expect(controller.config()?.confirmDelete).toBe(true)
  })

  it('shows field errors from the Host on the field and a notice for other failures, keeping the previous value', async () => {
    const { controller, bridge } = await start()
    bridge.settings.chooseLibraryDir.mockResolvedValueOnce(ok('/Users/me/.dsh/sessions'))
    bridge.settings.update.mockResolvedValueOnce(ok({ ok: false, errors: { libraryDir: 'library-dir-reserved' } }))
    await controller.chooseLibraryDir()
    expect(controller.store.getState().errors).toEqual({ libraryDir: 'library-dir-reserved' })
    expect(controller.config()?.libraryDir).toBe('')
    bridge.settings.update.mockResolvedValueOnce(fail('promptx/settings/unavailable'))
    await controller.submit({ convertMiddleDot: false })
    expect(controller.config()?.convertMiddleDot).toBe(true)
    expect(controller.store.getState().notice).toMatchObject({ tone: 'error', text: '没有保存：设置暂时不可用' })
  })

  it('records a shortcut: modifiers alone wait, Esc cancels, a conflict is refused locally, a valid combination is submitted', async () => {
    const { controller, bridge } = await start()
    controller.startRecording('shortcutClear')
    expect(bridge.settings.setRecording).toHaveBeenLastCalledWith(true)
    expect(controller.recordKey(keyEvent({ key: 'Meta', code: 'MetaLeft', metaKey: true }))).toBe(true)
    expect(controller.store.getState().recording).toBe('shortcutClear')
    expect(controller.recordKey(keyEvent({ key: 'Escape', code: 'Escape' }))).toBe(true)
    expect(controller.store.getState().recording).toBeNull()
    expect(bridge.settings.setRecording).toHaveBeenLastCalledWith(false)

    controller.startRecording('shortcutClear')
    controller.recordKey(keyEvent({ key: 's', code: 'KeyS', metaKey: true }))
    expect(controller.store.getState().errors.shortcutClear).toBe('shortcut-conflict')
    expect(bridge.settings.update).not.toHaveBeenCalled()

    controller.startRecording('shortcutClear')
    expect(controller.store.getState().errors.shortcutClear).toBeUndefined()
    controller.recordKey(keyEvent({ key: 'k', code: 'KeyK', metaKey: true }))
    expect(bridge.settings.update).toHaveBeenLastCalledWith({ shortcutClear: 'Command+K' })
    expect(controller.store.getState().recording).toBeNull()
  })

  it('takes the global shortcut that the main process caught while recording', async () => {
    const { controller, bridge } = await start()
    controller.startRecording('shortcutChat')
    bridge.emit('settings.shortcutPressed', { accelerator: 'Control+P' })
    // 和全局快捷键相同：本地查出冲突，不提交。
    expect(controller.store.getState().errors.shortcutChat).toBe('shortcut-conflict')
    controller.startRecording('globalShortcut')
    bridge.emit('settings.shortcutPressed', { accelerator: 'Control+P' })
    // 录到的就是当前组合：没有变化，不提交。
    expect(bridge.settings.update).not.toHaveBeenCalled()
    expect(controller.store.getState().recording).toBeNull()
  })

  it('clears and restores shortcuts', async () => {
    const { controller, bridge } = await start(snapshot({ data: data({ shortcutLibrary: 'Command+K' }) }))
    controller.resetShortcut('shortcutLibrary')
    expect(bridge.settings.update).toHaveBeenLastCalledWith({ shortcutLibrary: 'CommandOrControl+L' })
    controller.clearShortcut('globalShortcut')
    expect(bridge.settings.update).toHaveBeenLastCalledWith({ globalShortcut: '' })
  })

  it('changes the library folder only through the picker or the reset button, and reports an unopenable folder', async () => {
    const { controller, bridge } = await start(snapshot({ data: { ...data({ libraryDir: '~/Prompts' }), effectiveLibraryDir: '/Users/me/Prompts' } }))
    await controller.chooseLibraryDir()
    expect(bridge.settings.update).not.toHaveBeenCalled()
    bridge.settings.chooseLibraryDir.mockResolvedValueOnce(ok('/Users/me/Work'))
    await controller.chooseLibraryDir()
    expect(bridge.settings.update).toHaveBeenLastCalledWith({ libraryDir: '/Users/me/Work' })
    await controller.resetLibraryDir()
    expect(bridge.settings.update).toHaveBeenLastCalledWith({ libraryDir: '' })
    bridge.settings.openLibraryDir.mockResolvedValueOnce(fail('promptx/library/unavailable'))
    await controller.openLibraryDir()
    expect(controller.store.getState().notice).toMatchObject({ tone: 'error', section: 'library' })
  })

  it('submits the instruction after a pause, on flush, and keeps unsaved input when the submit fails', async () => {
    vi.useFakeTimers()
    const { controller, bridge } = await start()
    controller.editInstruction('新的')
    controller.editInstruction('新的指令')
    expect(bridge.settings.update).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(INSTRUCTION_DELAY_MS + 10)
    expect(bridge.settings.update).toHaveBeenCalledTimes(1)
    expect(bridge.settings.update).toHaveBeenLastCalledWith({ optimizeInstruction: '新的指令' })
    expect(controller.store.getState().instruction).toMatchObject({ text: '新的指令', dirty: false, status: 'saved' })

    bridge.settings.update.mockResolvedValueOnce(fail('promptx/channel/closed'))
    controller.editInstruction('再改一次')
    await controller.flushInstruction()
    expect(controller.store.getState().instruction).toMatchObject({ text: '再改一次', dirty: true, status: 'idle' })
  })

  it('starts from the default instruction and restores the default', async () => {
    vi.useFakeTimers()
    const { controller, bridge } = await start(snapshot({ data: data({ optimizeInstruction: '自定义' }) }))
    expect(controller.store.getState().instruction?.text).toBe('自定义')
    await controller.restoreDefaultInstruction()
    expect(bridge.settings.update).toHaveBeenLastCalledWith({ optimizeInstruction: '' })
    controller.startFromDefault()
    expect(controller.store.getState().instruction?.text).toBe('默认优化指令')
    await vi.advanceTimersByTimeAsync(INSTRUCTION_DELAY_MS + 10)
    expect(bridge.settings.update).toHaveBeenLastCalledWith({ optimizeInstruction: '默认优化指令' })
  })

  it('follows instruction changes from elsewhere while the box has no unsaved input', async () => {
    const { controller, bridge } = await start()
    bridge.emit('settings.state', snapshot({ data: data({ optimizeInstruction: 'dsh 页面里改的' }) }))
    expect(controller.store.getState().instruction?.text).toBe('dsh 页面里改的')
    controller.editInstruction('正在写')
    bridge.emit('settings.state', snapshot({ data: data({ optimizeInstruction: '别处又改了' }) }))
    expect(controller.store.getState().instruction?.text).toBe('正在写')
  })

  it('closes on Esc or ⌘W after submitting the pending instruction; Esc while recording only cancels', async () => {
    const { controller, bridge } = await start()
    controller.startRecording('shortcutClear')
    expect(controller.handleKeydown(keyEvent({ key: 'Escape', code: 'Escape' }))).toBe(true)
    await settle()
    expect(bridge.settings.close).not.toHaveBeenCalled()
    controller.editInstruction('关窗前的输入')
    expect(controller.handleKeydown(keyEvent({ key: 'Escape', code: 'Escape' }))).toBe(true)
    await settle()
    expect(bridge.settings.update).toHaveBeenLastCalledWith({ optimizeInstruction: '关窗前的输入' })
    expect(bridge.settings.close).toHaveBeenCalledTimes(1)
    expect(controller.handleKeydown(keyEvent({ key: 'w', code: 'KeyW', metaKey: true }))).toBe(true)
    await settle()
    expect(bridge.settings.close).toHaveBeenCalledTimes(2)
    expect(controller.handleKeydown(keyEvent({ key: 'Escape', code: 'Escape', isComposing: true }))).toBe(false)
  })

  it('says when dsh opened the plugin page, or why it could not', async () => {
    const { controller, bridge } = await start()
    bridge.settings.openInDsh.mockResolvedValueOnce(ok({ navigated: true }))
    await controller.openInDsh()
    expect(controller.store.getState().notice).toMatchObject({ tone: 'info', text: '已在 dsh 页面打开 PromptX 插件页。', section: 'about' })
    bridge.settings.openInDsh.mockResolvedValueOnce(fail('promptx/channel/closed'))
    await controller.openInDsh()
    expect(controller.store.getState().notice).toMatchObject({ tone: 'error', text: '无法打开 DeepSeek Harness：与插件的连接已断开' })
  })
})

describe('SettingsApp', () => {
  it('renders the five sections, switches between them, and closes from the × button', async () => {
    const { bridge } = await mount()
    const nav = screen.getByRole('navigation', { name: '设置分区' })
    expect(within(nav).getAllByRole('button').map(button => button.textContent)).toEqual(['快捷键', '编辑器', 'Prompt 库', '优化', '关于'])
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('快捷键')
    fireEvent.click(within(nav).getByRole('button', { name: '关于' }))
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('关于')
    expect(screen.getByText('0.1.6')).toBeTruthy()
    expect(screen.getByText('Electron 44.10.2')).toBeTruthy()
    expect(screen.getByText('promptx-dev')).toBeTruthy()
    // 上下方向键在分区之间移动。
    fireEvent.keyDown(within(nav).getByRole('button', { name: '关于' }), { key: 'ArrowUp' })
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('优化')
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '关闭' }))
      await settle()
    })
    expect(bridge.settings.close).toHaveBeenCalledTimes(1)
  })

  it('shows the shortcuts with key caps, the registration status and the fixed Copy and hide row', async () => {
    await mount()
    expect(screen.getByText('已生效')).toBeTruthy()
    const recorder = screen.getByRole('button', { name: /^呼出 PromptX：⌃P/ })
    expect(recorder.getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(recorder)
    expect(recorder.getAttribute('aria-pressed')).toBe('true')
    expect(recorder.textContent).toBe('按下组合键…')
    expect(screen.getByText('复制并隐藏')).toBeTruthy()
    expect(screen.getByText('固定')).toBeTruthy()
  })

  it('toggles a switch in the Editor section', async () => {
    const bridge = new FakeBridge()
    applyWrites(bridge)
    await mount(snapshot({}, { seq: 0, section: 'editor' }), bridge)
    const toggle = screen.getByRole('switch', { name: '连打「¥」转「$」' })
    expect(toggle.getAttribute('aria-checked')).toBe('true')
    await act(async () => {
      fireEvent.click(toggle)
      await settle()
    })
    expect(bridge.settings.update).toHaveBeenCalledWith({ convertYen: false })
    expect(toggle.getAttribute('aria-checked')).toBe('false')
  })

  it('shows the library folder with a Default badge, and offers Use the default location only for a custom folder', async () => {
    const bridge = new FakeBridge()
    await mount(snapshot({}, { seq: 0, section: 'library' }), bridge)
    expect(screen.getByText('/Users/me/.dsh/promptx/library')).toBeTruthy()
    expect(screen.getByText('默认')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '恢复默认位置' })).toBeNull()
    bridge.settings.chooseLibraryDir.mockResolvedValueOnce(ok('/Users/me/Work'))
    const reply = deferred<ReturnType<typeof ok<{ ok: true }>>>()
    bridge.settings.update.mockReturnValueOnce(reply.promise)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '更改…' }))
      await settle()
    })
    // Host 回复之前就显示刚选的目录。
    expect(screen.getByText('/Users/me/Work')).toBeTruthy()
    expect(screen.getByRole('button', { name: '恢复默认位置' })).toBeTruthy()
    await act(async () => {
      bridge.emit('settings.state', snapshot({ data: { ...data({ libraryDir: '/Users/me/Work' }), effectiveLibraryDir: '/Users/me/Work' } }, { seq: 0, section: 'library' }))
      reply.resolve(ok({ ok: true }))
      await settle()
    })
    expect(screen.getByText('/Users/me/Work')).toBeTruthy()
    expect(screen.queryByText('默认')).toBeNull()
  })

  it('edits the instruction with the default as placeholder and a Start from the default button', async () => {
    await mount(snapshot({}, { seq: 0, section: 'optimize' }))
    const box = screen.getByRole<HTMLTextAreaElement>('textbox', { name: '优化指令' })
    expect(box.placeholder).toBe('默认优化指令')
    expect(screen.getByText('正在使用默认指令')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '从默认指令开始改' }))
    expect(box.value).toBe('默认优化指令')
    expect(screen.getByRole('button', { name: '恢复默认指令' })).toBeTruthy()
  })

  it('shows a load failure with Retry', async () => {
    const bridge = new FakeBridge()
    bridge.settings.getState.mockResolvedValue(fail('promptx/channel/closed'))
    const controller = new SettingsController(bridge, { locale: 'zh' })
    controllers.push(controller)
    render(<SettingsApp controller={controller} />)
    await act(async () => { await controller.start() })
    expect(screen.getByRole('alert').textContent).toContain('读取设置失败')
    bridge.settings.getState.mockResolvedValue(ok(snapshot()))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '重试' }))
      await settle()
    })
    expect(screen.getByText('已生效')).toBeTruthy()
  })

  it('follows the dark theme and the window title from the snapshot', async () => {
    await mount(snapshot({ config: config({ resolvedTheme: 'dark', resolvedLocale: 'en' }) }))
    expect(document.body.hasAttribute('data-ds-dark-theme')).toBe(true)
    expect(document.title).toBe('PromptX Settings')
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Shortcuts')
  })
})
