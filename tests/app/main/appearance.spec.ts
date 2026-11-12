import { describe, expect, it } from 'vitest'
import {
  FALLBACK_COMPANION_CONFIG,
  parseCompanionConfig,
  resolveConfig,
  resolveLocale,
  resolveTheme,
  WINDOW_BACKGROUND,
} from '../../../src/app/main/appearance.ts'
import type { CompanionConfig } from '../../../src/shared/types.ts'
import { DEFAULT_TOOLBAR_SHORTCUTS } from '../../../src/shared/window-shortcuts.ts'
import { trapProcessErrors } from './helpers.ts'

trapProcessErrors()

const config: CompanionConfig = {
  globalShortcut: 'Control+P',
  windowShortcuts: DEFAULT_TOOLBAR_SHORTCUTS,
  hideOnBlur: false,
  confirmDelete: true,
  convertMiddleDot: true,
  convertYen: true,
  locale: null,
  theme: 'system',
  libraryDir: '/Users/me/.dsh/promptx/library',
  profile: 'web',
}

describe('resolveLocale', () => {
  it('uses the dsh preference when there is one', () => {
    expect(resolveLocale('zh', ['en-US'])).toBe('zh')
    expect(resolveLocale('en', ['zh-Hans-CN'])).toBe('en')
  })

  it('follows the first system language when dsh has no preference', () => {
    expect(resolveLocale(null, ['zh-Hans-CN', 'en-US'])).toBe('zh')
    expect(resolveLocale(null, ['zh-TW'])).toBe('zh')
    expect(resolveLocale(null, ['ZH-hk'])).toBe('zh')
    expect(resolveLocale(null, ['en-US', 'zh-Hans-CN'])).toBe('en')
    expect(resolveLocale(null, ['fr-FR'])).toBe('en')
  })

  it('falls back to English without any system language', () => {
    expect(resolveLocale(null, [])).toBe('en')
    expect(resolveLocale(null, [''])).toBe('en')
  })
})

describe('resolveTheme', () => {
  it('keeps an explicit light or dark choice regardless of the system', () => {
    expect(resolveTheme('light', true)).toBe('light')
    expect(resolveTheme('dark', false)).toBe('dark')
  })

  it('follows the system for system', () => {
    expect(resolveTheme('system', true)).toBe('dark')
    expect(resolveTheme('system', false)).toBe('light')
  })
})

describe('resolveConfig', () => {
  it('keeps every Host field and adds the resolved locale and theme', () => {
    expect(resolveConfig(config, { languages: ['zh-CN'], dark: true })).toEqual({
      ...config,
      resolvedLocale: 'zh',
      resolvedTheme: 'dark',
    })
  })

  it('does not let the system override explicit preferences', () => {
    const resolved = resolveConfig({ ...config, locale: 'en', theme: 'light' }, { languages: ['zh-CN'], dark: true })
    expect(resolved.resolvedLocale).toBe('en')
    expect(resolved.resolvedTheme).toBe('light')
  })
})

describe('WINDOW_BACKGROUND', () => {
  it('matches the dsh base background tokens', () => {
    expect(WINDOW_BACKGROUND).toEqual({ light: '#ffffff', dark: '#151517' })
  })
})

describe('parseCompanionConfig', () => {
  it('keeps a valid configuration as it is and drops unknown fields', () => {
    expect(parseCompanionConfig({ ...config, extra: 'x' }, null)).toEqual(config)
  })

  it('ignores payloads that are not objects', () => {
    expect(parseCompanionConfig(null, config)).toBeNull()
    expect(parseCompanionConfig('config', config)).toBeNull()
    expect(parseCompanionConfig([config], config)).toBeNull()
  })

  it('keeps the previous value of a broken field instead of unregistering the shortcut', () => {
    const previous = { ...config, globalShortcut: 'Control+Alt+P', theme: 'dark' as const }
    expect(parseCompanionConfig({ ...config, globalShortcut: 42, theme: 'blue', hideOnBlur: 'yes' }, previous)).toEqual({
      ...config,
      globalShortcut: 'Control+Alt+P',
      theme: 'dark',
      hideOnBlur: false,
    })
  })

  it('uses safe fallbacks without a previous configuration', () => {
    expect(parseCompanionConfig({}, null)).toEqual(FALLBACK_COMPANION_CONFIG)
    expect(FALLBACK_COMPANION_CONFIG.globalShortcut).toBe('')
    expect(FALLBACK_COMPANION_CONFIG.theme).toBe('system')
  })

  it('defaults both input conversions on and preserves each previous value on malformed updates', () => {
    expect(parseCompanionConfig({}, null)).toMatchObject({ convertMiddleDot: true, convertYen: true })
    expect(parseCompanionConfig({ convertMiddleDot: false, convertYen: true }, config))
      .toMatchObject({ convertMiddleDot: false, convertYen: true })
    const previous = { ...config, convertMiddleDot: false, convertYen: false }
    expect(parseCompanionConfig({ convertMiddleDot: 'true', convertYen: 1 }, previous))
      .toMatchObject({ convertMiddleDot: false, convertYen: false })
  })

  it('maps locale tags the way the Host does (zh* is Chinese, anything else English)', () => {
    expect(parseCompanionConfig({ ...config, locale: 'zh-CN' }, null)?.locale).toBe('zh')
    expect(parseCompanionConfig({ ...config, locale: 'ZH_tw' }, null)?.locale).toBe('zh')
    expect(parseCompanionConfig({ ...config, locale: 'fr' }, null)?.locale).toBe('en')
    expect(parseCompanionConfig({ ...config, locale: ' ' }, null)?.locale).toBeNull()
    expect(parseCompanionConfig({ ...config, locale: null }, { ...config, locale: 'zh' })?.locale).toBeNull()
    expect(parseCompanionConfig({ ...config, locale: 5 }, { ...config, locale: 'zh' })?.locale).toBe('zh')
  })
})
