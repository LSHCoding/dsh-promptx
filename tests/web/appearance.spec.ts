import { describe, expect, it } from 'vitest'
import { mapLocaleTag, resolveAppearance, resolveInstructionLocale } from '../../src/web/appearance.ts'

/** settings.describe() 的一行：只填用到的字段。 */
function row(ns: string, value: unknown) {
  return { ns, value }
}

describe('mapLocaleTag', () => {
  it('maps zh* to Chinese, any other tag to English and blanks to null', () => {
    expect(mapLocaleTag('zh')).toBe('zh')
    expect(mapLocaleTag('zh-CN')).toBe('zh')
    expect(mapLocaleTag('ZH-Hant-TW')).toBe('zh')
    expect(mapLocaleTag(' zh ')).toBe('zh')
    expect(mapLocaleTag('en')).toBe('en')
    expect(mapLocaleTag('en-US')).toBe('en')
    expect(mapLocaleTag('fr')).toBe('en')
    expect(mapLocaleTag('ja-JP')).toBe('en')
    expect(mapLocaleTag('')).toBeNull()
    expect(mapLocaleTag('   ')).toBeNull()
    expect(mapLocaleTag(null)).toBeNull()
    expect(mapLocaleTag(undefined)).toBeNull()
  })
})

describe('resolveAppearance (S-03, design-spec 4.7)', () => {
  it('follows the dsh language preference before anything a page reported', () => {
    expect(resolveAppearance({ describe: () => [row('locale', { preference: 'zh-CN' })], reportedLocale: 'en-US' }).locale).toBe('zh')
    expect(resolveAppearance({ describe: () => [row('locale', { preference: 'en' })], reportedLocale: 'zh-CN' }).locale).toBe('en')
    expect(resolveAppearance({ describe: () => [row('locale', { preference: 'de' })], reportedLocale: null }).locale).toBe('en')
  })

  it('uses the language a dsh page reported when dsh has no preference (review COV-11)', () => {
    expect(resolveAppearance({ describe: () => [row('locale', {})], reportedLocale: 'zh-Hans' }).locale).toBe('zh')
    expect(resolveAppearance({ describe: () => [row('locale', { preference: '' })], reportedLocale: 'en-GB' }).locale).toBe('en')
    expect(resolveAppearance({ describe: () => [], reportedLocale: 'zh' }).locale).toBe('zh')
  })

  it('returns null so the companion follows the system language when nobody knows better', () => {
    expect(resolveAppearance({ describe: () => [row('locale', {})], reportedLocale: null }).locale).toBeNull()
    expect(resolveAppearance({ describe: () => [], reportedLocale: '  ' }).locale).toBeNull()
  })

  it('reads the theme preference and defaults to system', () => {
    expect(resolveAppearance({ describe: () => [row('ui-theme', { preference: 'dark', fontSize: 14 })], reportedLocale: null }).theme).toBe('dark')
    expect(resolveAppearance({ describe: () => [row('ui-theme', { preference: 'light' })], reportedLocale: null }).theme).toBe('light')
    expect(resolveAppearance({ describe: () => [row('ui-theme', { preference: 'system' })], reportedLocale: null }).theme).toBe('system')
    expect(resolveAppearance({ describe: () => [row('ui-theme', { preference: 'sepia' })], reportedLocale: null }).theme).toBe('system')
    expect(resolveAppearance({ describe: () => [row('ui-theme', { fontSize: 14 })], reportedLocale: null }).theme).toBe('system')
    expect(resolveAppearance({ describe: () => [], reportedLocale: null }).theme).toBe('system')
  })

  it('ignores other namespaces, malformed values and a settings service that throws', () => {
    const rows = [
      row('promptx', { preference: 'zh' }),
      row('locale', 'zh'),
      row('ui-theme', null),
      row('ui-theme', ['dark']),
      row('locale', { preference: 42 }),
    ]
    expect(resolveAppearance({ describe: () => rows, reportedLocale: 'en' })).toEqual({ locale: 'en', theme: 'system' })
    expect(resolveAppearance({
      describe: () => {
        throw new Error('settings service is unloading')
      },
      reportedLocale: 'zh-TW',
    })).toEqual({ locale: 'zh', theme: 'system' })
  })

  it('resolves both at once from a realistic describe() result', () => {
    const rows = [
      row('agent-default-model', { provider: 'deepseek-official', model: 'deepseek-chat' }),
      row('locale', { preference: 'en' }),
      row('ui-theme', { preference: 'dark', fontSize: 14, codeFontSize: 11 }),
    ]
    expect(resolveAppearance({ describe: () => rows, reportedLocale: 'zh-CN' })).toEqual({ locale: 'en', theme: 'dark' })
  })
})

describe('resolveInstructionLocale (O-08)', () => {
  it('uses the resolved UI language and falls back when there is none', () => {
    expect(resolveInstructionLocale({ locale: 'zh' }, 'en')).toBe('zh')
    expect(resolveInstructionLocale({ locale: 'en' }, 'zh')).toBe('en')
    expect(resolveInstructionLocale({ locale: null }, 'zh')).toBe('zh')
    expect(resolveInstructionLocale({ locale: null }, 'en')).toBe('en')
  })
})
