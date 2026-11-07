import { describe, it, expect } from 'vitest'
import { formatShortcut, matchesShortcut, matchWindowCommand, WINDOW_SHORTCUTS, type ShortcutKeyEvent } from '../../../src/app/renderer/shortcuts.ts'

function key(init: Partial<ShortcutKeyEvent> & { key: string }): ShortcutKeyEvent {
  return { code: '', ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...init }
}

describe('窗口级快捷键（S-02 的表）', () => {
  it('键位和需求一致', () => {
    expect(WINDOW_SHORTCUTS).toEqual({
      copyAndHide: 'CommandOrControl+Enter',
      save: 'CommandOrControl+S',
      library: 'CommandOrControl+L',
      optimize: 'CommandOrControl+Shift+O',
      hide: 'Escape',
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
})

describe('formatShortcut（悬停提示和底栏按钮旁的写法）', () => {
  it('macOS 用符号', () => {
    expect(formatShortcut(WINDOW_SHORTCUTS.copyAndHide, 'darwin')).toBe('⌘↩')
    expect(formatShortcut(WINDOW_SHORTCUTS.save, 'darwin')).toBe('⌘S')
    expect(formatShortcut(WINDOW_SHORTCUTS.library, 'darwin')).toBe('⌘L')
    expect(formatShortcut(WINDOW_SHORTCUTS.optimize, 'darwin')).toBe('⇧⌘O')
    expect(formatShortcut(WINDOW_SHORTCUTS.hide, 'darwin')).toBe('Esc')
  })

  it('其他平台写成 Ctrl+…', () => {
    for (const platform of ['win32', 'linux']) {
      expect(formatShortcut(WINDOW_SHORTCUTS.copyAndHide, platform)).toBe('Ctrl+Enter')
      expect(formatShortcut(WINDOW_SHORTCUTS.save, platform)).toBe('Ctrl+S')
      expect(formatShortcut(WINDOW_SHORTCUTS.optimize, platform)).toBe('Ctrl+Shift+O')
      expect(formatShortcut(WINDOW_SHORTCUTS.hide, platform)).toBe('Esc')
    }
  })

  it('没有快捷键时是空串，界面上不显示', () => {
    expect(formatShortcut('', 'darwin')).toBe('')
    expect(formatShortcut('   ', 'win32')).toBe('')
  })
})
