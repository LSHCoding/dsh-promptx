// 窗口级快捷键只在 PromptX 小窗获得焦点时处理。工具栏键位来自配置，复制并隐藏保留固定键位。

import { acceleratorFromKeyEvent, formatAccelerator, physicalShortcutKey, type AcceleratorKeyEvent } from '../../shared/accelerator.ts'
import { COPY_AND_HIDE_SHORTCUT, DEFAULT_TOOLBAR_SHORTCUTS, TOOLBAR_COMMAND_FIELDS, type ToolbarCommand, type ToolbarShortcuts } from '../../shared/window-shortcuts.ts'

export type WindowCommand = ToolbarCommand | 'copyAndHide'
export type ShortcutKeyEvent = AcceleratorKeyEvent

const WINDOW_COMMANDS: readonly WindowCommand[] = ['copyAndHide', ...Object.keys(TOOLBAR_COMMAND_FIELDS) as ToolbarCommand[]]

export function windowShortcut(command: WindowCommand, shortcuts: ToolbarShortcuts = DEFAULT_TOOLBAR_SHORTCUTS): string {
  return command === 'copyAndHide' ? COPY_AND_HIDE_SHORTCUT : shortcuts[TOOLBAR_COMMAND_FIELDS[command]]
}

export function matchesShortcut(event: ShortcutKeyEvent, accelerator: string, platform: string): boolean {
  const actual = acceleratorFromKeyEvent(event, platform, 'window')
  if (actual === null) return false
  const expected = physicalShortcutKey(accelerator, platform, 'window')
  return expected !== null && (actual === expected || plusShortcutAlias(event, actual) === expected)
}

/** 没有匹配的窗口级命令时放行按键，让编辑区或输入框按正常方式处理。 */
export function matchWindowCommand(event: ShortcutKeyEvent, platform: string, shortcuts?: ToolbarShortcuts): WindowCommand | null {
  const actual = acceleratorFromKeyEvent(event, platform, 'window')
  if (actual === null) return null
  const find = (key: string) => WINDOW_COMMANDS.find(command => key === physicalShortcutKey(windowShortcut(command, shortcuts), platform, 'window'))
  const exact = find(actual)
  if (exact !== undefined) return exact
  const plus = plusShortcutAlias(event, actual)
  return plus === null ? null : find(plus) ?? null
}

/** 主键盘产生 + 可能要按 Shift。若没有为物理组合单独设键位，再尝试手填的 Plus。 */
function plusShortcutAlias(event: ShortcutKeyEvent, actual: string): string | null {
  if (event.key !== '+' || event.code === 'NumpadAdd') return null
  const modifiers = actual.split('+').slice(0, -1).filter(modifier => modifier !== 'Shift')
  return [...modifiers, 'Plus'].join('+')
}

export function formatShortcut(accelerator: string, platform: string): string {
  return formatAccelerator(accelerator, platform, 'window')
}
