// 设置窗口（V0.1.6）用到的纯逻辑：分区表，以及主进程转发改动前对补丁的类型检查。
// Host 收到后还会用 web/config-update.ts 完整校验一遍，这里只挡住类型不对和不认识的字段。

import type { PromptxConfig, SettingsSection } from './types.ts'

export const SETTINGS_SECTIONS: readonly SettingsSection[] = ['shortcuts', 'editor', 'library', 'optimize', 'about']

export function isSettingsSection(value: unknown): value is SettingsSection {
  return typeof value === 'string' && (SETTINGS_SECTIONS as readonly string[]).includes(value)
}

/** 每个配置字段的值类型。用 Record 写：PromptxConfig 加了字段而这里漏写时编译失败。 */
export const SETTINGS_FIELD_KINDS: Readonly<Record<keyof PromptxConfig, 'string' | 'boolean'>> = {
  libraryDir: 'string',
  confirmDelete: 'boolean',
  convertMiddleDot: 'boolean',
  convertYen: 'boolean',
  optimizeInstruction: 'string',
  globalShortcut: 'string',
  shortcutLibrary: 'string',
  shortcutSave: 'string',
  shortcutOptimize: 'string',
  shortcutClear: 'string',
  shortcutChat: 'string',
  shortcutSettings: 'string',
  shortcutClose: 'string',
  hideOnBlur: 'boolean',
  runtimeSource: 'string',
}

/**
 * 设置窗口传来的补丁：普通对象，只含认识的字段，值的类型对，至少一个字段。不合格时返回 null。
 * 字符串长度只做粗略限制（优化指令的上限由 Host 检查），挡住把超大字符串塞进 IPC 的情况。
 */
export function sanitizeSettingsPatch(value: unknown): Partial<PromptxConfig> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const proto: unknown = Object.getPrototypeOf(value)
  if (proto !== Object.prototype && proto !== null) return null
  const entries = Object.entries(value as Record<string, unknown>)
  if (entries.length === 0) return null
  const patch: Record<string, string | boolean> = {}
  for (const [key, field] of entries) {
    if (!Object.hasOwn(SETTINGS_FIELD_KINDS, key)) return null
    if (SETTINGS_FIELD_KINDS[key as keyof PromptxConfig] === 'boolean') {
      if (typeof field !== 'boolean') return null
      patch[key] = field
    } else {
      if (typeof field !== 'string' || field.length > MAX_SETTINGS_STRING) return null
      patch[key] = field
    }
  }
  return patch
}

/** 补丁里单个字符串的上限：比 Host 的优化指令上限（10 万字）宽一些，只防止异常大的消息。 */
const MAX_SETTINGS_STRING = 200_000
