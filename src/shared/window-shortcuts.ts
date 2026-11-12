import { physicalShortcutKey } from './accelerator.ts'

export const TOOLBAR_COMMAND_FIELDS = {
  library: 'shortcutLibrary',
  save: 'shortcutSave',
  optimize: 'shortcutOptimize',
  clear: 'shortcutClear',
  chat: 'shortcutChat',
  settings: 'shortcutSettings',
  hide: 'shortcutClose',
} as const

export type ToolbarCommand = keyof typeof TOOLBAR_COMMAND_FIELDS
export type ToolbarShortcutField = typeof TOOLBAR_COMMAND_FIELDS[ToolbarCommand]
export type ToolbarShortcuts = Record<ToolbarShortcutField, string>

export const TOOLBAR_SHORTCUT_FIELDS = Object.values(TOOLBAR_COMMAND_FIELDS)
export const SHORTCUT_CONFIG_FIELDS = ['globalShortcut', ...TOOLBAR_SHORTCUT_FIELDS] as const

export const DEFAULT_TOOLBAR_SHORTCUTS: Readonly<ToolbarShortcuts> = {
  shortcutLibrary: 'CommandOrControl+L',
  shortcutSave: 'CommandOrControl+S',
  shortcutOptimize: 'CommandOrControl+Shift+O',
  shortcutClear: '',
  shortcutChat: '',
  shortcutSettings: '',
  shortcutClose: 'Escape',
}

export const COPY_AND_HIDE_SHORTCUT = 'CommandOrControl+Enter'

export function readToolbarShortcuts(read: (field: ToolbarShortcutField) => string): ToolbarShortcuts {
  return Object.fromEntries(TOOLBAR_SHORTCUT_FIELDS.map(field => [field, read(field)])) as ToolbarShortcuts
}

type ShortcutField = ToolbarShortcutField | 'globalShortcut'
type ShortcutValues = ToolbarShortcuts & { globalShortcut: string }

/** 检查修改涉及的冲突，保留旧 profile 已有的组合，直到用户修改该组合。 */
export function conflictingShortcutFields(
  patch: Partial<ShortcutValues>,
  current: ShortcutValues,
  platform: string,
): ShortcutField[] {
  const values = { ...current, ...patch }
  const keys = new Map<ShortcutField, string>()
  for (const field of SHORTCUT_CONFIG_FIELDS) {
    const key = physicalShortcutKey(values[field], platform, field === 'globalShortcut' ? 'global' : 'window')
    if (key !== null) keys.set(field, key)
  }
  const copy = physicalShortcutKey(COPY_AND_HIDE_SHORTCUT, platform, 'window')
  return [...keys].filter(([field, key]) => patch[field] !== undefined
    && (key === copy || [...keys].some(([other, otherKey]) => other !== field && otherKey === key)))
    .map(([field]) => field)
}
