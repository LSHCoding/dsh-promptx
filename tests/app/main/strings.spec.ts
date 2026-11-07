import { describe, expect, it } from 'vitest'
import { fill, MAIN_STRINGS, systemHotkeyName } from '../../../src/app/main/strings.ts'
import { trapProcessErrors } from './helpers.ts'

trapProcessErrors()

function placeholders(text: string): string[] {
  return [...text.matchAll(/\{(\w+)\}/g)].map(match => match[1] ?? '').sort()
}

describe('MAIN_STRINGS', () => {
  it('has the same keys in Chinese and English', () => {
    expect(Object.keys(MAIN_STRINGS.zh).sort()).toEqual(Object.keys(MAIN_STRINGS.en).sort())
  })

  it('uses the same placeholders in both languages', () => {
    for (const key of Object.keys(MAIN_STRINGS.zh) as (keyof typeof MAIN_STRINGS.zh)[]) {
      expect(placeholders(MAIN_STRINGS.zh[key]), key).toEqual(placeholders(MAIN_STRINGS.en[key]))
    }
  })

  it('has no empty text', () => {
    for (const strings of Object.values(MAIN_STRINGS)) {
      for (const text of Object.values(strings) as string[]) expect(text.trim()).not.toBe('')
    }
  })
})

describe('fill', () => {
  it('replaces known placeholders and keeps unknown ones visible', () => {
    expect(fill('运行时 {version}', { version: '44.10.2' })).toBe('运行时 44.10.2')
    expect(fill('{a} and {b}', { a: '1' })).toBe('1 and {b}')
  })

  it('does not interpret replacement patterns in values', () => {
    expect(fill('{name}', { name: '$& $1' })).toBe('$& $1')
  })
})

describe('systemHotkeyName', () => {
  it('names well-known macOS symbolic hotkeys in both languages', () => {
    expect(systemHotkeyName(64, 'zh')).toBe('显示“聚焦”搜索')
    expect(systemHotkeyName(64, 'en')).toBe('Show Spotlight search')
    expect(systemHotkeyName(60, 'en')).toBe('Select the previous input source')
    expect(systemHotkeyName(61, 'zh')).toBe('选择“输入法”菜单中的下一个输入法')
  })

  it('numbers the switch-to-desktop shortcuts', () => {
    expect(systemHotkeyName(118, 'en')).toBe('Switch to Desktop 1')
    expect(systemHotkeyName(133, 'zh')).toBe('切换到桌面 16')
  })

  it('uses a generic name for unknown ids', () => {
    expect(systemHotkeyName(9999, 'zh')).toBe('系统快捷键')
    expect(systemHotkeyName(134, 'en')).toBe('system shortcut')
  })
})
