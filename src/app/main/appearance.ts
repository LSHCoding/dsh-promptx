// 小窗的语言和明暗（需求 S-03，design-spec 4.7）。Host 推来的配置里 locale 为 null、theme 为 system
// 表示「跟随系统」；小程序和 dsh 在同一台电脑上，按小程序看到的系统设置解析成具体值再交给渲染进程。

import type { ResolvedConfig } from '../../shared/bridge.ts'
import type { CompanionConfig } from '../../shared/types.ts'

export type Locale = ResolvedConfig['resolvedLocale']
export type Theme = ResolvedConfig['resolvedTheme']

/** 有偏好就用偏好；没有时看系统首选语言，以 zh 开头（含 zh-Hant）为中文，其他都是英文。 */
export function resolveLocale(preference: CompanionConfig['locale'], systemLanguages: readonly string[]): Locale {
  if (preference !== null) return preference
  const first = systemLanguages[0]?.trim().toLowerCase() ?? ''
  return first.startsWith('zh') ? 'zh' : 'en'
}

export function resolveTheme(preference: CompanionConfig['theme'], systemDark: boolean): Theme {
  if (preference === 'system') return systemDark ? 'dark' : 'light'
  return preference
}

export interface SystemAppearance {
  /** app.getPreferredSystemLanguages() */
  languages: readonly string[]
  /** nativeTheme.shouldUseDarkColors */
  dark: boolean
}

export function resolveConfig(config: CompanionConfig, system: SystemAppearance): ResolvedConfig {
  return {
    ...config,
    resolvedLocale: resolveLocale(config.locale, system.languages),
    resolvedTheme: resolveTheme(config.theme, system.dark),
  }
}

/** Host 还没推过配置、推来的字段又坏了时用的值：不登记快捷键，外观跟随系统。 */
export const FALLBACK_COMPANION_CONFIG: CompanionConfig = {
  globalShortcut: '',
  hideOnBlur: false,
  confirmDelete: true,
  convertMiddleDot: true,
  convertYen: true,
  locale: null,
  theme: 'system',
  libraryDir: '',
  profile: '',
}

/**
 * 协议消息在运行时没有类型保证：逐个字段核对 Host 推来的配置。不是对象时返回 null（整条忽略）；
 * 单个字段坏了沿用上一次的值（没有上一次时用 FALLBACK_COMPANION_CONFIG），一个字段写错不至于让快捷键被注销。
 * 语言写成 `zh-CN` 这类标签时按「以 zh 开头为中文」归一，和 Host 的 mapLocaleTag 一致。
 */
export function parseCompanionConfig(raw: unknown, previous: CompanionConfig | null): CompanionConfig | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const value = raw as Record<string, unknown>
  const base = previous ?? FALLBACK_COMPANION_CONFIG
  const string = (field: unknown, fallback: string): string => (typeof field === 'string' ? field : fallback)
  const boolean = (field: unknown, fallback: boolean): boolean => (typeof field === 'boolean' ? field : fallback)
  return {
    globalShortcut: string(value.globalShortcut, base.globalShortcut),
    hideOnBlur: boolean(value.hideOnBlur, base.hideOnBlur),
    confirmDelete: boolean(value.confirmDelete, base.confirmDelete),
    convertMiddleDot: boolean(value.convertMiddleDot, base.convertMiddleDot),
    convertYen: boolean(value.convertYen, base.convertYen),
    locale: parseLocalePreference(value.locale, base.locale),
    theme: value.theme === 'light' || value.theme === 'dark' || value.theme === 'system' ? value.theme : base.theme,
    libraryDir: string(value.libraryDir, base.libraryDir),
    profile: string(value.profile, base.profile),
  }
}

function parseLocalePreference(value: unknown, fallback: CompanionConfig['locale']): CompanionConfig['locale'] {
  if (value === null) return null
  if (typeof value !== 'string') return fallback
  const tag = value.trim().toLowerCase()
  if (tag === '') return null
  return tag.startsWith('zh') ? 'zh' : 'en'
}

/**
 * 窗口底色：dsh 主题 token 里 `--dsw-alias-bg-base` 的浅色和深色值（styles/dsh-theme.css）。
 * 窗口在界面第一次绘制前就用这个颜色，显示时不会先闪一下白底。
 */
export const WINDOW_BACKGROUND: Readonly<Record<Theme, string>> = {
  light: '#ffffff',
  dark: '#151517',
}
