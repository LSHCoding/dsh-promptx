// 小窗的语言和明暗跟随 dsh（需求 S-03，design-spec 4.7）。
//
// Host 读 settings.describe() 里两个命名空间的偏好：`locale`（dsh-client-locale，字段 preference，
// 没有时表示跟随浏览器）和 `ui-theme`（dsh-client-ui-theme，字段 preference：light、dark、system）。
// dsh 没有设语言偏好时，界面跟随浏览器的语言列表，Host 看不到，只能用页面经 /client-state 上报的生效语言；
// 从没有页面上报过时返回 null，由小程序按系统语言决定（审查 COV-11）。

export type AppearanceLocale = 'zh' | 'en'
export type AppearanceTheme = 'light' | 'dark' | 'system'

export interface Appearance {
  /** null 表示 dsh 没有偏好、也没有页面上报过，由小程序跟随系统语言。 */
  locale: AppearanceLocale | null
  theme: AppearanceTheme
}

export interface AppearanceInput {
  /** settings.describe()；读不到（服务不在、抛异常）时按没有偏好处理。 */
  describe: () => ReadonlyArray<{ ns: string; value: unknown }>
  /** 最近一次由 dsh 页面上报的生效语言（如 `zh-CN`、`en`）；没有页面上报过时为 null。 */
  reportedLocale: string | null
}

/** dsh-client-locale 的命名空间和字段（0.2.2-rc.1 的 LOCALE_SETTINGS_NAMESPACE、LOCALE_PREFERENCE_FIELD）。 */
const LOCALE_NAMESPACE = 'locale'
/** dsh-client-ui-theme 的命名空间（THEME_SETTINGS_NAMESPACE）。 */
const THEME_NAMESPACE = 'ui-theme'
const PREFERENCE_FIELD = 'preference'

const THEMES: readonly AppearanceTheme[] = ['light', 'dark', 'system']

/** 语言标签 → 小窗的语言：以 zh 开头（不区分大小写）是中文，其他非空值是英文，空值为 null。 */
export function mapLocaleTag(tag: string | null | undefined): AppearanceLocale | null {
  const trimmed = tag?.trim() ?? ''
  if (trimmed === '') return null
  return trimmed.toLowerCase().startsWith('zh') ? 'zh' : 'en'
}

export function resolveAppearance(input: AppearanceInput): Appearance {
  const preferences = readPreferences(input.describe)
  const localePreference = preferences.get(LOCALE_NAMESPACE)
  const locale = mapLocaleTag(typeof localePreference === 'string' ? localePreference : null) ?? mapLocaleTag(input.reportedLocale)
  const themePreference = preferences.get(THEME_NAMESPACE)
  const theme = THEMES.find(item => item === themePreference) ?? 'system'
  return { locale, theme }
}

/**
 * 优化默认指令用的语言（需求 O-08：默认指令随界面语言）。Host 和小程序按同一个结果取语言；
 * 都没有时用 fallback（Host 这边推断的系统语言）。
 */
export function resolveInstructionLocale(appearance: Pick<Appearance, 'locale'>, fallback: AppearanceLocale): AppearanceLocale {
  return appearance.locale ?? fallback
}

/** 命名空间 → preference 字段的值。describe() 抛异常时（例如 settings 服务正在卸载）当成没有偏好。 */
function readPreferences(describe: AppearanceInput['describe']): Map<string, unknown> {
  const result = new Map<string, unknown>()
  let rows: ReadonlyArray<{ ns: string; value: unknown }>
  try {
    rows = describe()
  } catch {
    return result
  }
  for (const row of rows) {
    if (row.ns !== LOCALE_NAMESPACE && row.ns !== THEME_NAMESPACE) continue
    const value = row.value
    if (typeof value !== 'object' || value === null || Array.isArray(value)) continue
    if (Object.hasOwn(value, PREFERENCE_FIELD)) result.set(row.ns, (value as Record<string, unknown>)[PREFERENCE_FIELD])
  }
  return result
}
