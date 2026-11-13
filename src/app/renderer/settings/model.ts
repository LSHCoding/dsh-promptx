// 设置页的纯逻辑（V0.1.6）：快捷键字段表、本地校验、登记状态说明、提交后等待 Host 新配置期间的覆盖值。
// 不碰 DOM 和 React，单测直接跑。

import { formatAccelerator, parseAccelerator, type AcceleratorModifier } from '../../../shared/accelerator.ts'
import { errorReason, translate, type Locale, type MessageKey } from '../../../shared/i18n/index.ts'
import type { ConfigFieldError, ErrorInfo, PromptxConfig, SettingsData, ShortcutStatus } from '../../../shared/types.ts'
import {
  conflictingShortcutFields,
  DEFAULT_TOOLBAR_SHORTCUTS,
  TOOLBAR_COMMAND_FIELDS,
  type ToolbarCommand,
  type ToolbarShortcutField,
} from '../../../shared/window-shortcuts.ts'

export type ShortcutField = 'globalShortcut' | ToolbarShortcutField

export type ConfigField = keyof PromptxConfig

export type FieldErrors = Partial<Record<ConfigField, ConfigFieldError>>

/** 「小窗内」卡片的行，顺序和工具栏一致。 */
export const WINDOW_COMMAND_ROWS: ReadonlyArray<{ command: ToolbarCommand; field: ToolbarShortcutField; label: MessageKey }> = [
  { command: 'library', field: TOOLBAR_COMMAND_FIELDS.library, label: 'settings.command.library' },
  { command: 'save', field: TOOLBAR_COMMAND_FIELDS.save, label: 'settings.command.save' },
  { command: 'optimize', field: TOOLBAR_COMMAND_FIELDS.optimize, label: 'settings.command.optimize' },
  { command: 'clear', field: TOOLBAR_COMMAND_FIELDS.clear, label: 'settings.command.clear' },
  { command: 'chat', field: TOOLBAR_COMMAND_FIELDS.chat, label: 'settings.command.chat' },
  { command: 'settings', field: TOOLBAR_COMMAND_FIELDS.settings, label: 'settings.command.settings' },
  { command: 'hide', field: TOOLBAR_COMMAND_FIELDS.hide, label: 'settings.command.hide' },
]

export function shortcutScope(field: ShortcutField): 'global' | 'window' {
  return field === 'globalShortcut' ? 'global' : 'window'
}

/** 规范写法：合法时用 shared/accelerator 的 canonical（和 Host 写入前的规范化一致），不合法时只去掉首尾空白。 */
export function canonicalShortcut(value: string, field: ShortcutField): string {
  const trimmed = value.trim()
  if (trimmed === '') return ''
  const parsed = parseAccelerator(trimmed, shortcutScope(field))
  return parsed.ok ? parsed.canonical : trimmed
}

export function defaultShortcutOf(field: ShortcutField, data: SettingsData): string {
  return field === 'globalShortcut' ? data.defaultShortcut : DEFAULT_TOOLBAR_SHORTCUTS[field]
}

/** 按平台显示；空串返回空串。 */
export function displayShortcut(value: string, field: ShortcutField, platform: string): string {
  return value.trim() === '' ? '' : formatAccelerator(value, platform, shortcutScope(field))
}

const MAC_KEY_SYMBOLS: Readonly<Record<string, string>> = {
  Up: '↑', Down: '↓', Left: '←', Right: '→', Plus: '+', Enter: '↩', Escape: 'Esc',
}

/**
 * 录制框里逐个画成键帽的部分：macOS 是 ⌃ ⌥ ⇧ ⌘ 和主键，其他平台是 Ctrl、Alt、Shift、Win / Super 和主键。
 * 修饰键的顺序和 shared/accelerator.ts 的 formatAccelerator 一致；写法不合法时整串作为一个键帽。
 */
export function shortcutTokens(value: string, field: ShortcutField, platform: string): string[] {
  const parsed = parseAccelerator(value, shortcutScope(field))
  if (!parsed.ok) return value.trim() === '' ? [] : [value.trim()]
  const has = (modifier: AcceleratorModifier): boolean => parsed.modifiers.includes(modifier)
  const tokens: string[] = []
  if (platform === 'darwin') {
    if (has('Control')) tokens.push('⌃')
    if (has('Alt')) tokens.push('⌥')
    if (has('Shift')) tokens.push('⇧')
    if (has('CommandOrControl') || has('Command') || has('Super')) tokens.push('⌘')
    tokens.push(MAC_KEY_SYMBOLS[parsed.key] ?? parsed.key)
    return tokens
  }
  if (has('CommandOrControl') || has('Control')) tokens.push('Ctrl')
  if (has('Alt')) tokens.push('Alt')
  if (has('Shift')) tokens.push('Shift')
  if (has('Command') || has('Super')) tokens.push(platform === 'win32' ? 'Win' : 'Super')
  tokens.push(parsed.key === 'Escape' ? 'Esc' : parsed.key)
  return tokens
}

/**
 * 提交前本地能查出的问题：写法不合法，或和另一个动作、「复制并隐藏」用同一组键。
 * 其余规则（库目录位置）只有 Host 知道，提交后由它返回。和 Host 用同一个 conflictingShortcutFields。
 */
export function localShortcutError(field: ShortcutField, value: string, config: PromptxConfig, platform: string): ConfigFieldError | null {
  if (value === '') return null
  if (!parseAccelerator(value, shortcutScope(field)).ok) return field === 'globalShortcut' ? 'shortcut-invalid' : 'window-shortcut-invalid'
  return conflictingShortcutFields({ [field]: value }, config, platform).includes(field) ? 'shortcut-conflict' : null
}

export function fieldErrorText(locale: Locale, error: ConfigFieldError): string {
  switch (error) {
    case 'library-dir-relative':
    case 'library-dir-reserved':
    case 'library-dir-skills':
      return translate(locale, `detail.${error}`)
    case 'shortcut-invalid':
    case 'window-shortcut-invalid':
    case 'shortcut-conflict':
    case 'value-invalid':
      return translate(locale, `settings.error.${error}`)
  }
}

export type StatusTone = 'done' | 'warning' | 'error' | 'idle' | 'ongoing'

/**
 * 全局快捷键的登记状态，规则照 dsh 配置页（src/client/ConfigPage.tsx 的 describeShortcut）：
 * 小程序报的 accelerator 是实际登记着的组合，可能和配置不同——带着错误说明时是新组合失败、退回了旧组合；
 * 什么都没带时是新组合还没处理完，写「正在登记」，不能说成已生效或失败。
 */
export function describeGlobalShortcut(
  locale: Locale, configured: string, status: ShortcutStatus | null, platform: string,
): { tone: StatusTone; text: string } {
  const wanted = canonicalShortcut(configured, 'globalShortcut')
  if (wanted === '') return { tone: 'idle', text: translate(locale, 'settings.shortcutStatus.off') }
  if (status === null) return { tone: 'ongoing', text: translate(locale, 'settings.shortcutStatus.pending') }
  const current = canonicalShortcut(status.accelerator, 'globalShortcut')
  const caution = status.registered ? status.warning ?? status.error : status.error
  if (current !== wanted) {
    if (!status.registered || caution === undefined || caution.code === 'promptx/shortcut/system-conflict') {
      return { tone: 'ongoing', text: translate(locale, 'settings.shortcutStatus.pending') }
    }
    return {
      tone: 'warning',
      text: translate(locale, 'settings.shortcutStatus.fallback', {
        shortcut: displayShortcut(wanted, 'globalShortcut', platform),
        active: displayShortcut(current, 'globalShortcut', platform),
        reason: cautionReason(locale, caution, wanted),
      }),
    }
  }
  if (!status.registered) {
    const reason = caution === undefined ? errorReason(locale, { code: 'promptx/internal' }) : errorReason(locale, caution)
    return { tone: 'error', text: translate(locale, 'settings.shortcutStatus.failed', { reason }) }
  }
  if (caution !== undefined) return { tone: 'warning', text: translate(locale, 'settings.shortcutStatus.warning', { reason: errorReason(locale, caution) }) }
  return { tone: 'done', text: translate(locale, 'settings.shortcutStatus.active') }
}

/** 退回旧组合时，detail 写的是没登记上的新组合，文案里已经有了，只写原因本身。 */
function cautionReason(locale: Locale, caution: ErrorInfo, wanted: string): string {
  const detail = caution.detail?.trim() ?? ''
  if (detail !== '' && canonicalShortcut(detail, 'globalShortcut') === wanted) return errorReason(locale, { code: caution.code })
  return errorReason(locale, caution)
}

/** 提交成功、Host 新配置还没到时显示的值。until 之后丢弃，免得 Host 那边被改成别的值时一直盖着。 */
export interface PendingValue {
  value: string | boolean
  until: number
}

export type PendingValues = Partial<Record<ConfigField, PendingValue>>

/** 去掉若干字段，返回新对象（不改原对象）。 */
export function omitFields<V>(record: Partial<Record<ConfigField, V>>, fields: readonly ConfigField[]): Partial<Record<ConfigField, V>> {
  const next: Partial<Record<ConfigField, V>> = {}
  for (const [field, value] of Object.entries(record) as [ConfigField, V][]) {
    if (!fields.includes(field)) next[field] = value
  }
  return next
}

/** 新配置到达：已经等于提交值的、过期的覆盖值去掉。没有变化时返回原对象。 */
export function settlePending(pending: PendingValues, config: PromptxConfig, now: number): PendingValues {
  const settled = (Object.keys(pending) as ConfigField[]).filter((field) => {
    const item = pending[field]
    return item !== undefined && (config[field] === item.value || now > item.until)
  })
  return settled.length === 0 ? pending : omitFields(pending, settled)
}

/** 页面上显示的配置：Host 的配置盖上还在等待的提交值。 */
export function effectiveConfig(config: PromptxConfig, pending: PendingValues, now: number): PromptxConfig {
  const result: Record<string, unknown> = { ...config }
  for (const field of Object.keys(pending) as ConfigField[]) {
    const item = pending[field]
    if (item !== undefined && now <= item.until) result[field] = item.value
  }
  return result as unknown as PromptxConfig
}
