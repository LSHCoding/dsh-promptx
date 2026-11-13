import { describe, expect, it } from 'vitest'
import { isSettingsSection, sanitizeSettingsPatch, SETTINGS_FIELD_KINDS, SETTINGS_SECTIONS } from '../../src/shared/settings.ts'

describe('settings sections', () => {
  it('lists the five sections in navigation order and recognises only them', () => {
    expect(SETTINGS_SECTIONS).toEqual(['shortcuts', 'editor', 'library', 'optimize', 'about'])
    for (const section of SETTINGS_SECTIONS) expect(isSettingsSection(section)).toBe(true)
    for (const value of ['', 'Shortcuts', 'constructor', '__proto__', 1, null, undefined]) expect(isSettingsSection(value)).toBe(false)
  })
})

describe('sanitizeSettingsPatch', () => {
  it('passes a well-typed patch through unchanged', () => {
    const patch = { convertYen: false, globalShortcut: 'Control+Alt+P', libraryDir: '', runtimeSource: 'mirror' }
    expect(sanitizeSettingsPatch(patch)).toEqual(patch)
  })

  it('covers every config field with a value type', () => {
    expect(Object.keys(SETTINGS_FIELD_KINDS).sort()).toEqual([
      'confirmDelete', 'convertMiddleDot', 'convertYen', 'globalShortcut', 'hideOnBlur', 'libraryDir', 'optimizeInstruction', 'runtimeSource',
      'shortcutChat', 'shortcutClear', 'shortcutClose', 'shortcutLibrary', 'shortcutOptimize', 'shortcutSave', 'shortcutSettings',
    ])
  })

  it('refuses anything that is not a non-empty plain object of known, well-typed fields', () => {
    class Patch { convertYen = true }
    for (const bad of [
      null, undefined, 'x', 3, [], {}, new Patch(), Object.create({ convertYen: true }) as unknown,
      { convertYen: 'false' }, { libraryDir: 42 }, { unknownField: '' }, { constructor: 'x' }, { optimizeInstruction: 'x'.repeat(200_001) },
    ]) {
      expect(sanitizeSettingsPatch(bad), JSON.stringify(bad)?.slice(0, 40)).toBeNull()
    }
  })
})
