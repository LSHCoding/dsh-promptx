import { describe, it, expect } from 'vitest'
import { formatShortcut, matchesShortcut, matchWindowCommand, windowShortcut, type ShortcutKeyEvent } from '../../../src/app/renderer/shortcuts.ts'
import { DEFAULT_TOOLBAR_SHORTCUTS } from '../../../src/shared/window-shortcuts.ts'

function key(init: Partial<ShortcutKeyEvent> & { key: string }): ShortcutKeyEvent {
  return { code: '', ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...init }
}

describe('窗口级快捷键（S-02 的表）', () => {
  it('键位和需求一致', () => {
    const commands = ['copyAndHide', 'save', 'library', 'optimize', 'hide', 'clear', 'chat', 'settings'] as const
    expect(Object.fromEntries(commands.map(command => [command, windowShortcut(command)]))).toEqual({
      copyAndHide: 'CommandOrControl+Enter',
      save: 'CommandOrControl+S',
      library: 'CommandOrControl+L',
      optimize: 'CommandOrControl+Shift+O',
      hide: 'Escape',
      clear: '',
      chat: '',
      settings: '',
    })
  })

  it('macOS 上 Mod 是 ⌘', () => {
    expect(matchWindowCommand(key({ key: 'Enter', metaKey: true }), 'darwin')).toBe('copyAndHide')
    expect(matchWindowCommand(key({ key: 's', code: 'KeyS', metaKey: true }), 'darwin')).toBe('save')
    expect(matchWindowCommand(key({ key: 'l', code: 'KeyL', metaKey: true }), 'darwin')).toBe('library')
    expect(matchWindowCommand(key({ key: 'O', code: 'KeyO', metaKey: true, shiftKey: true }), 'darwin')).toBe('optimize')
    expect(matchWindowCommand(key({ key: 'Escape' }), 'darwin')).toBe('hide')
    // ⌃↩ 在 macOS 上不是复制并隐藏。
    expect(matchWindowCommand(key({ key: 'Enter', ctrlKey: true }), 'darwin')).toBeNull()
  })

  it('Windows、Linux 上 Mod 是 Ctrl', () => {
    for (const platform of ['win32', 'linux']) {
      expect(matchWindowCommand(key({ key: 'Enter', ctrlKey: true }), platform)).toBe('copyAndHide')
      expect(matchWindowCommand(key({ key: 's', code: 'KeyS', ctrlKey: true }), platform)).toBe('save')
      expect(matchWindowCommand(key({ key: 'O', code: 'KeyO', ctrlKey: true, shiftKey: true }), platform)).toBe('optimize')
      expect(matchWindowCommand(key({ key: 'Enter', metaKey: true }), platform)).toBeNull()
    }
  })

  it('修饰键必须完全一致：多一个、少一个都不算', () => {
    expect(matchWindowCommand(key({ key: 'Enter' }), 'darwin')).toBeNull()
    expect(matchWindowCommand(key({ key: 'Enter', metaKey: true, shiftKey: true }), 'darwin')).toBeNull()
    expect(matchWindowCommand(key({ key: 'o', code: 'KeyO', metaKey: true }), 'darwin')).toBeNull()
    expect(matchWindowCommand(key({ key: 'Escape', shiftKey: true }), 'darwin')).toBeNull()
    expect(matchWindowCommand(key({ key: 'Escape', metaKey: true }), 'darwin')).toBeNull()
  })

  it('⌥ 或输入法改变了 e.key 时按物理键位认字母', () => {
    expect(matchesShortcut(key({ key: 'ß', code: 'KeyS', metaKey: true }), 'CommandOrControl+S', 'darwin')).toBe(true)
    expect(matchesShortcut(key({ key: 'ø', code: 'KeyO', metaKey: true, shiftKey: true }), 'CommandOrControl+Shift+O', 'darwin')).toBe(true)
  })

  it('空写法没有快捷键', () => {
    expect(matchesShortcut(key({ key: 'Enter' }), '', 'darwin')).toBe(false)
  })

  it('支持方向键、数字和用户设置的组合，旧组合可停用', () => {
    const shortcuts = {
      ...DEFAULT_TOOLBAR_SHORTCUTS,
      shortcutLibrary: '',
      shortcutClear: 'Alt+Shift+1',
      shortcutChat: 'CommandOrControl+Right',
      shortcutSettings: 'Control+Enter',
    }
    expect(matchWindowCommand(key({ key: 'l', metaKey: true }), 'darwin', shortcuts)).toBeNull()
    expect(matchWindowCommand(key({ key: '⁄', code: 'Digit1', altKey: true, shiftKey: true }), 'darwin', shortcuts)).toBe('clear')
    expect(matchWindowCommand(key({ key: 'ArrowRight', code: 'ArrowRight', metaKey: true }), 'darwin', shortcuts)).toBe('chat')
    expect(matchWindowCommand(key({ key: 'Enter', ctrlKey: true }), 'darwin', shortcuts)).toBe('settings')
  })

  it('支持手填 Plus，同时优先匹配主键盘明确配置的物理组合', () => {
    const shortcuts = { ...DEFAULT_TOOLBAR_SHORTCUTS, shortcutChat: 'Command+Plus' }
    const plus = key({ key: '+', code: 'Equal', metaKey: true, shiftKey: true })
    expect(matchWindowCommand(plus, 'darwin', shortcuts)).toBe('chat')
    expect(matchWindowCommand(plus, 'darwin', { ...shortcuts, shortcutSettings: 'Command+Shift+=' })).toBe('settings')
    expect(matchWindowCommand(key({ key: '+', code: 'NumpadAdd', metaKey: true }), 'darwin', shortcuts)).toBe('chat')
  })
})

describe('formatShortcut（悬停提示和底栏按钮旁的写法）', () => {
  it('macOS 用符号', () => {
    expect(formatShortcut(windowShortcut('copyAndHide'), 'darwin')).toBe('⌘↩')
    expect(formatShortcut(windowShortcut('save'), 'darwin')).toBe('⌘S')
    expect(formatShortcut(windowShortcut('library'), 'darwin')).toBe('⌘L')
    expect(formatShortcut(windowShortcut('optimize'), 'darwin')).toBe('⇧⌘O')
    expect(formatShortcut(windowShortcut('hide'), 'darwin')).toBe('Esc')
  })

  it('其他平台写成 Ctrl+…', () => {
    for (const platform of ['win32', 'linux']) {
      expect(formatShortcut(windowShortcut('copyAndHide'), platform)).toBe('Ctrl+Enter')
      expect(formatShortcut(windowShortcut('save'), platform)).toBe('Ctrl+S')
      expect(formatShortcut(windowShortcut('optimize'), platform)).toBe('Ctrl+Shift+O')
      expect(formatShortcut(windowShortcut('hide'), platform)).toBe('Esc')
    }
  })

  it('没有快捷键时是空串，界面上不显示', () => {
    expect(formatShortcut('', 'darwin')).toBe('')
    expect(formatShortcut('   ', 'win32')).toBe('')
  })
})
