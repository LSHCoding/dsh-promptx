// 小窗内的快捷键（需求 S-02，技术方案 5.5）：只在小窗有焦点时有效，V0.1.0 用固定键位。
// 写法沿用 Electron 加速键（与全局快捷键一致），显示时尽量交给 shared/accelerator.ts 的 formatAccelerator。

import { formatAccelerator } from '../../shared/accelerator.ts'

export type WindowCommand = 'copyAndHide' | 'save' | 'library' | 'optimize' | 'hide'

/** 固定键位（S-02 的表）。值为空串时表示没有快捷键，按钮旁和悬停提示里都不显示。 */
export const WINDOW_SHORTCUTS: Readonly<Record<WindowCommand, string>> = {
  copyAndHide: 'CommandOrControl+Enter',
  save: 'CommandOrControl+S',
  library: 'CommandOrControl+L',
  optimize: 'CommandOrControl+Shift+O',
  hide: 'Escape',
}

/** 匹配用到的键盘事件字段（DOM KeyboardEvent 的子集，测试里可以直接传对象）。 */
export interface ShortcutKeyEvent {
  key: string
  code: string
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
  metaKey: boolean
}

interface ParsedShortcut {
  /** CommandOrControl：macOS 上是 ⌘，其他平台是 Ctrl。 */
  mod: boolean
  ctrl: boolean
  alt: boolean
  shift: boolean
  meta: boolean
  key: string
}

function parse(accelerator: string): ParsedShortcut | null {
  if (accelerator.trim() === '') return null
  const parsed: ParsedShortcut = { mod: false, ctrl: false, alt: false, shift: false, meta: false, key: '' }
  for (const part of accelerator.split('+').map(token => token.trim().toLowerCase())) {
    if (part === 'commandorcontrol' || part === 'cmdorctrl') parsed.mod = true
    else if (part === 'control' || part === 'ctrl') parsed.ctrl = true
    else if (part === 'alt' || part === 'option') parsed.alt = true
    else if (part === 'shift') parsed.shift = true
    else if (part === 'command' || part === 'cmd' || part === 'super' || part === 'meta') parsed.meta = true
    else parsed.key = part
  }
  return parsed.key === '' ? null : parsed
}

function keyMatches(event: ShortcutKeyEvent, key: string): boolean {
  if (key === 'enter') return event.key === 'Enter'
  if (key === 'escape' || key === 'esc') return event.key === 'Escape'
  if (event.key.toLowerCase() === key) return true
  // ⌥ 和输入法会改变 e.key（⌥O 是「ø」），字母键再按物理键位比一次。
  return /^[a-z]$/.test(key) && event.code === `Key${key.toUpperCase()}`
}

export function matchesShortcut(event: ShortcutKeyEvent, accelerator: string, platform: string): boolean {
  const shortcut = parse(accelerator)
  if (shortcut === null) return false
  const mac = platform === 'darwin'
  const wantMeta = shortcut.meta || (shortcut.mod && mac)
  const wantCtrl = shortcut.ctrl || (shortcut.mod && !mac)
  return event.metaKey === wantMeta
    && event.ctrlKey === wantCtrl
    && event.altKey === shortcut.alt
    && event.shiftKey === shortcut.shift
    && keyMatches(event, shortcut.key)
}

/** 这次按键对应哪个窗口级命令；都不是时返回 null。 */
export function matchWindowCommand(event: ShortcutKeyEvent, platform: string): WindowCommand | null {
  for (const command of Object.keys(WINDOW_SHORTCUTS) as WindowCommand[]) {
    if (matchesShortcut(event, WINDOW_SHORTCUTS[command], platform)) return command
  }
  return null
}

/**
 * 显示用的快捷键写法：macOS 用 ⌘⇧ 符号，其他平台用 Ctrl+Shift+O。
 * formatAccelerator 只认全局快捷键可用的主键，不认 Enter 和 Esc：这两个键先用一个它认识的字母代替，
 * 让它排好修饰键，再把字母换回来。
 */
export function formatShortcut(accelerator: string, platform: string): string {
  const shortcut = parse(accelerator)
  if (shortcut === null) return ''
  const mac = platform === 'darwin'
  if (shortcut.key === 'escape' || shortcut.key === 'esc') {
    const hasModifier = shortcut.mod || shortcut.ctrl || shortcut.alt || shortcut.shift || shortcut.meta
    if (!hasModifier) return 'Esc'
  }
  if (shortcut.key === 'enter' || shortcut.key === 'escape' || shortcut.key === 'esc') {
    const stand = accelerator.split('+').map((part) => {
      const lower = part.trim().toLowerCase()
      return lower === 'enter' || lower === 'escape' || lower === 'esc' ? 'A' : part
    }).join('+')
    const modifiers = formatAccelerator(stand, platform).slice(0, -1)
    const keyLabel = shortcut.key === 'enter' ? (mac ? '↩' : 'Enter') : 'Esc'
    return modifiers + keyLabel
  }
  return formatAccelerator(accelerator, platform)
}
