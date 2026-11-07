import { describe, it, expect } from 'vitest'
import {
  acceleratorFromKeyEvent,
  DEFAULT_SHORTCUT_BY_PLATFORM,
  defaultShortcut,
  formatAccelerator,
  parseAccelerator,
  type AcceleratorKeyEvent,
} from '../../src/shared/accelerator.ts'

const canonical = (s: string): string | null => {
  const parsed = parseAccelerator(s)
  return parsed.ok ? parsed.canonical : null
}

const reason = (s: string): string | null => {
  const parsed = parseAccelerator(s)
  return parsed.ok ? null : parsed.reason
}

describe('parseAccelerator：合法组合', () => {
  it('默认快捷键', () => {
    expect(parseAccelerator('Control+P')).toEqual({ ok: true, modifiers: ['Control'], key: 'P', canonical: 'Control+P' })
    expect(parseAccelerator('Control+Alt+P')).toEqual({ ok: true, modifiers: ['Control', 'Alt'], key: 'P', canonical: 'Control+Alt+P' })
  })

  it('修饰键别名不区分大小写，规范成全称', () => {
    expect(canonical('ctrl+p')).toBe('Control+P')
    expect(canonical('CTRL+ALT+P')).toBe('Control+Alt+P')
    expect(canonical('Cmd+K')).toBe('Command+K')
    expect(canonical('command+k')).toBe('Command+K')
    expect(canonical('CmdOrCtrl+Shift+O')).toBe('CommandOrControl+Shift+O')
    expect(canonical('commandorcontrol+o')).toBe('CommandOrControl+O')
    expect(canonical('Option+Space')).toBe('Alt+Space')
    expect(canonical('Meta+F5')).toBe('Super+F5')
    expect(canonical('super+f5')).toBe('Super+F5')
  })

  it('修饰键按固定顺序排列，主键放最后', () => {
    expect(canonical('Shift+Alt+Control+P')).toBe('Control+Alt+Shift+P')
    expect(canonical('P+Control')).toBe('Control+P')
    expect(canonical('Super+Shift+Ctrl+A')).toBe('Control+Shift+Super+A')
    expect(canonical('Shift+Alt+CmdOrCtrl+A')).toBe('CommandOrControl+Alt+Shift+A')
    expect(canonical('Shift+Command+Control+Alt+Z')).toBe('Command+Control+Alt+Shift+Z')
  })

  it('加号两侧和首尾的空白忽略', () => {
    expect(canonical('  Control + Alt + P  ')).toBe('Control+Alt+P')
  })

  it('字母、数字、F1 到 F24', () => {
    expect(canonical('Control+a')).toBe('Control+A')
    expect(canonical('Control+0')).toBe('Control+0')
    expect(canonical('Alt+9')).toBe('Alt+9')
    expect(canonical('Control+f1')).toBe('Control+F1')
    expect(canonical('Control+F24')).toBe('Control+F24')
  })

  it('Space、方向键、Plus', () => {
    expect(canonical('Control+space')).toBe('Control+Space')
    expect(canonical('Control+up')).toBe('Control+Up')
    expect(canonical('Alt+Down')).toBe('Alt+Down')
    expect(canonical('Alt+LEFT')).toBe('Alt+Left')
    expect(canonical('Alt+Right')).toBe('Alt+Right')
    expect(canonical('Control+plus')).toBe('Control+Plus')
  })

  it('常见标点', () => {
    for (const mark of ['`', '-', '=', '[', ']', '\\', ';', '\'', ',', '.', '/']) {
      expect(canonical(`Control+${mark}`)).toBe(`Control+${mark}`)
    }
  })

  it('Shift 和其他修饰键一起用是合法的', () => {
    expect(canonical('Shift+Control+P')).toBe('Control+Shift+P')
  })

  it('Command 和 Control 可以同时用', () => {
    expect(canonical('Command+Control+P')).toBe('Command+Control+P')
  })
})

describe('parseAccelerator：不合法组合', () => {
  it('空串和空白', () => {
    expect(reason('')).toBe('empty')
    expect(reason('   ')).toBe('empty')
  })

  it('裸字母、裸功能键没有修饰键', () => {
    expect(reason('P')).toBe('no-modifier')
    expect(reason('f5')).toBe('no-modifier')
    expect(reason('Space')).toBe('no-modifier')
  })

  it('只有 Shift', () => {
    expect(reason('Shift+P')).toBe('shift-only')
    expect(reason('Shift+1')).toBe('shift-only')
  })

  it('多余的加号', () => {
    expect(reason('Control+')).toBe('syntax')
    expect(reason('+P')).toBe('syntax')
    expect(reason('Control++P')).toBe('syntax')
    expect(reason('Control++')).toBe('syntax')
    expect(reason('Control + + P')).toBe('syntax')
  })

  it('只有修饰键没有主键', () => {
    expect(reason('Control+Alt')).toBe('syntax')
    expect(reason('Shift')).toBe('syntax')
  })

  it('主键不止一个', () => {
    expect(reason('Control+P+Q')).toBe('syntax')
    expect(reason('Control+P+P')).toBe('syntax')
    expect(reason('P+Q')).toBe('syntax')
  })

  it('同一个修饰键写了两遍（含别名）', () => {
    expect(reason('Control+Ctrl+P')).toBe('syntax')
    expect(reason('Alt+Option+P')).toBe('syntax')
    expect(reason('Super+Meta+P')).toBe('syntax')
    expect(reason('Cmd+Command+P')).toBe('syntax')
    expect(reason('Shift+Shift+Control+P')).toBe('syntax')
  })

  it('在某个平台上落到同一个键的修饰键组合', () => {
    expect(reason('Command+Super+P')).toBe('syntax')
    expect(reason('CommandOrControl+Command+P')).toBe('syntax')
    expect(reason('CmdOrCtrl+Control+P')).toBe('syntax')
    expect(reason('CmdOrCtrl+Super+P')).toBe('syntax')
  })

  it('不认识或不支持的键名', () => {
    expect(reason('Control+Foo')).toBe('bad-key')
    expect(reason('Hyper+P')).toBe('bad-key')
    expect(reason('AltGr+P')).toBe('bad-key')
    expect(reason('Control+Tab')).toBe('bad-key')
    expect(reason('Control+Enter')).toBe('bad-key')
    expect(reason('Control+Escape')).toBe('bad-key')
    expect(reason('Control+F25')).toBe('bad-key')
    expect(reason('Control+F0')).toBe('bad-key')
    expect(reason('Control+num1')).toBe('bad-key')
    expect(reason('Control+ä')).toBe('bad-key')
    expect(reason('Control+!')).toBe('bad-key')
    expect(reason('Control+PP')).toBe('bad-key')
    expect(reason('⌃P')).toBe('bad-key')
  })
})

describe('formatAccelerator', () => {
  it('macOS 用 ⌃⌥⇧⌘ 符号，顺序固定', () => {
    expect(formatAccelerator('Control+P', 'darwin')).toBe('⌃P')
    expect(formatAccelerator('Control+Alt+P', 'darwin')).toBe('⌃⌥P')
    expect(formatAccelerator('Shift+Command+Alt+Control+K', 'darwin')).toBe('⌃⌥⇧⌘K')
  })

  it('macOS 上 CommandOrControl、Super 都显示为 ⌘', () => {
    expect(formatAccelerator('CmdOrCtrl+Shift+O', 'darwin')).toBe('⇧⌘O')
    expect(formatAccelerator('Super+P', 'darwin')).toBe('⌘P')
  })

  it('macOS 上方向键用箭头，Space 照写，Plus 显示为 +', () => {
    expect(formatAccelerator('Control+Up', 'darwin')).toBe('⌃↑')
    expect(formatAccelerator('Control+Down', 'darwin')).toBe('⌃↓')
    expect(formatAccelerator('Control+Left', 'darwin')).toBe('⌃←')
    expect(formatAccelerator('Control+Right', 'darwin')).toBe('⌃→')
    expect(formatAccelerator('Alt+Space', 'darwin')).toBe('⌥Space')
    expect(formatAccelerator('Command+Plus', 'darwin')).toBe('⌘+')
    expect(formatAccelerator('Command+F5', 'darwin')).toBe('⌘F5')
  })

  it('Windows 写法', () => {
    expect(formatAccelerator('Control+Alt+P', 'win32')).toBe('Ctrl+Alt+P')
    expect(formatAccelerator('Shift+Super+Alt+Control+P', 'win32')).toBe('Ctrl+Alt+Shift+Win+P')
    expect(formatAccelerator('CmdOrCtrl+Shift+O', 'win32')).toBe('Ctrl+Shift+O')
    expect(formatAccelerator('Command+P', 'win32')).toBe('Win+P')
    expect(formatAccelerator('Control+Up', 'win32')).toBe('Ctrl+Up')
    expect(formatAccelerator('Control+Plus', 'win32')).toBe('Ctrl+Plus')
  })

  it('Linux 上 Super 键照写', () => {
    expect(formatAccelerator('Super+Alt+P', 'linux')).toBe('Alt+Super+P')
    expect(formatAccelerator('ctrl+alt+p', 'linux')).toBe('Ctrl+Alt+P')
  })

  it('不合法的写法原样返回', () => {
    expect(formatAccelerator('  Foo+Bar ', 'darwin')).toBe('Foo+Bar')
    expect(formatAccelerator('P', 'win32')).toBe('P')
    expect(formatAccelerator('', 'darwin')).toBe('')
  })
})

describe('acceleratorFromKeyEvent', () => {
  const event = (code: string, key: string, mods: Partial<Omit<AcceleratorKeyEvent, 'code' | 'key'>> = {}): AcceleratorKeyEvent => ({
    code,
    key,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    metaKey: false,
    ...mods,
  })

  it('录下默认快捷键', () => {
    expect(acceleratorFromKeyEvent(event('KeyP', 'p', { ctrlKey: true }), 'darwin')).toBe('Control+P')
    expect(acceleratorFromKeyEvent(event('KeyP', 'p', { ctrlKey: true, altKey: true }), 'win32')).toBe('Control+Alt+P')
  })

  it('主键按物理键位取，不受 Option、Shift 改变的字符影响', () => {
    expect(acceleratorFromKeyEvent(event('KeyP', 'π', { altKey: true, metaKey: true }), 'darwin')).toBe('Command+Alt+P')
    expect(acceleratorFromKeyEvent(event('Digit1', '!', { ctrlKey: true, shiftKey: true }), 'linux')).toBe('Control+Shift+1')
    expect(acceleratorFromKeyEvent(event('Slash', '?', { ctrlKey: true, shiftKey: true }), 'win32')).toBe('Control+Shift+/')
  })

  it('metaKey 在 macOS 上是 Command，在其他平台上是 Super', () => {
    expect(acceleratorFromKeyEvent(event('KeyK', 'k', { metaKey: true }), 'darwin')).toBe('Command+K')
    expect(acceleratorFromKeyEvent(event('KeyK', 'k', { metaKey: true }), 'win32')).toBe('Super+K')
    expect(acceleratorFromKeyEvent(event('KeyK', 'k', { metaKey: true }), 'linux')).toBe('Super+K')
  })

  it('功能键、空格、方向键和标点', () => {
    expect(acceleratorFromKeyEvent(event('F12', 'F12', { ctrlKey: true }), 'darwin')).toBe('Control+F12')
    expect(acceleratorFromKeyEvent(event('F24', 'F24', { altKey: true }), 'darwin')).toBe('Alt+F24')
    expect(acceleratorFromKeyEvent(event('Space', ' ', { altKey: true }), 'darwin')).toBe('Alt+Space')
    expect(acceleratorFromKeyEvent(event('ArrowUp', 'ArrowUp', { ctrlKey: true }), 'win32')).toBe('Control+Up')
    expect(acceleratorFromKeyEvent(event('ArrowDown', 'ArrowDown', { ctrlKey: true }), 'win32')).toBe('Control+Down')
    expect(acceleratorFromKeyEvent(event('ArrowLeft', 'ArrowLeft', { ctrlKey: true }), 'win32')).toBe('Control+Left')
    expect(acceleratorFromKeyEvent(event('ArrowRight', 'ArrowRight', { ctrlKey: true }), 'win32')).toBe('Control+Right')
    const punctuation: Array<[string, string]> = [
      ['Backquote', '`'], ['Minus', '-'], ['Equal', '='], ['BracketLeft', '['], ['BracketRight', ']'], ['Backslash', '\\'],
      ['Semicolon', ';'], ['Quote', '\''], ['Comma', ','], ['Period', '.'], ['Slash', '/'],
    ]
    for (const [code, mark] of punctuation) {
      expect(acceleratorFromKeyEvent(event(code, mark, { ctrlKey: true }), 'darwin')).toBe(`Control+${mark}`)
    }
  })

  it('只按下修饰键时返回 null', () => {
    expect(acceleratorFromKeyEvent(event('ControlLeft', 'Control', { ctrlKey: true }), 'darwin')).toBeNull()
    expect(acceleratorFromKeyEvent(event('AltRight', 'Alt', { ctrlKey: true, altKey: true }), 'win32')).toBeNull()
    expect(acceleratorFromKeyEvent(event('ShiftLeft', 'Shift', { shiftKey: true }), 'linux')).toBeNull()
    expect(acceleratorFromKeyEvent(event('MetaLeft', 'Meta', { metaKey: true }), 'darwin')).toBeNull()
    expect(acceleratorFromKeyEvent(event('AltRight', 'AltGraph', { ctrlKey: true, altKey: true }), 'win32')).toBeNull()
  })

  it('不合法的组合返回 null', () => {
    expect(acceleratorFromKeyEvent(event('KeyP', 'p'), 'darwin')).toBeNull()
    expect(acceleratorFromKeyEvent(event('KeyP', 'P', { shiftKey: true }), 'darwin')).toBeNull()
  })

  it('不支持的主键返回 null', () => {
    expect(acceleratorFromKeyEvent(event('Tab', 'Tab', { ctrlKey: true }), 'darwin')).toBeNull()
    expect(acceleratorFromKeyEvent(event('Enter', 'Enter', { ctrlKey: true }), 'darwin')).toBeNull()
    expect(acceleratorFromKeyEvent(event('Escape', 'Escape', { ctrlKey: true }), 'darwin')).toBeNull()
    expect(acceleratorFromKeyEvent(event('Numpad1', '1', { ctrlKey: true }), 'win32')).toBeNull()
    expect(acceleratorFromKeyEvent(event('IntlBackslash', '§', { ctrlKey: true }), 'darwin')).toBeNull()
    expect(acceleratorFromKeyEvent(event('CapsLock', 'CapsLock', { ctrlKey: true }), 'darwin')).toBeNull()
  })

  it('录下的结果能被 parseAccelerator 原样接受', () => {
    const recorded = acceleratorFromKeyEvent(event('KeyO', 'o', { ctrlKey: true, shiftKey: true, metaKey: true }), 'darwin')
    expect(recorded).toBe('Command+Control+Shift+O')
    expect(canonical(recorded ?? '')).toBe(recorded)
  })
})

describe('默认快捷键', () => {
  it('macOS 是 ⌃P，Windows、Linux 是 Ctrl+Alt+P', () => {
    expect(DEFAULT_SHORTCUT_BY_PLATFORM).toEqual({ darwin: 'Control+P', win32: 'Control+Alt+P', linux: 'Control+Alt+P' })
    expect(defaultShortcut('darwin')).toBe('Control+P')
    expect(defaultShortcut('win32')).toBe('Control+Alt+P')
    expect(defaultShortcut('linux')).toBe('Control+Alt+P')
  })

  it('不认识的平台按 Windows、Linux 的默认值', () => {
    expect(defaultShortcut('freebsd')).toBe('Control+Alt+P')
  })

  it('默认值本身合法，并且已经是规范写法', () => {
    for (const shortcut of Object.values(DEFAULT_SHORTCUT_BY_PLATFORM)) {
      expect(canonical(shortcut)).toBe(shortcut)
    }
    expect(formatAccelerator(defaultShortcut('darwin'), 'darwin')).toBe('⌃P')
    expect(formatAccelerator(defaultShortcut('win32'), 'win32')).toBe('Ctrl+Alt+P')
  })
})
