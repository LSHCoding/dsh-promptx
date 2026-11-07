import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SYMBOLIC_HOTKEYS,
  enabledSystemHotkeys,
  findSystemConflict,
  parsePlistXml,
  readSymbolicEntries,
  symbolicHotkeyKey,
  systemConflictFromXml,
} from '../../../src/app/main/symbolic-hotkeys.ts'
import { trapProcessErrors } from './helpers.ts'

trapProcessErrors()

const FIXTURE = readFileSync(fileURLToPath(new URL('./fixtures/symbolichotkeys.xml', import.meta.url)), 'utf8')

describe('parsePlistXml', () => {
  it('reads dicts, arrays, numbers, strings and booleans', () => {
    const xml = `<?xml version="1.0"?><plist version="1.0"><dict>
      <key>a</key><integer>-3</integer>
      <key>b</key><real>1.5</real>
      <key>c</key><string>x &lt; y</string>
      <key>d</key><true/>
      <key>e</key><false/>
      <key>f</key><array><integer>1</integer><string/></array>
      <key>g</key><dict/>
      <key>h</key><date>2026-11-08T00:00:00Z</date>
    </dict></plist>`
    expect(parsePlistXml(xml)).toEqual({ a: -3, b: 1.5, c: 'x < y', d: true, e: false, f: [1, ''], g: {}, h: '2026-11-08T00:00:00Z' })
  })

  it('decodes entities and skips comments and the DOCTYPE', () => {
    const root = parsePlistXml(FIXTURE) as Record<string, unknown>
    expect(root.Note).toBe('Tom & Jerry <3 中文')
  })

  it('returns null for documents it cannot read', () => {
    expect(parsePlistXml('')).toBeNull()
    expect(parsePlistXml('not xml at all')).toBeNull()
    expect(parsePlistXml('<plist><dict><key>a</key>')).toBeNull()
    expect(parsePlistXml('<plist><dict><integer>1</integer></dict></plist>')).toBeNull()
    expect(parsePlistXml('<plist><integer>abc</integer></plist>')).toBeNull()
    expect(parsePlistXml('<dict></dict>')).toBeNull()
  })
})

describe('readSymbolicEntries', () => {
  it('reads every entry with its enabled flag, parameters and type', () => {
    const entries = readSymbolicEntries(FIXTURE)
    expect(entries).not.toBeNull()
    expect(entries?.get(15)).toEqual({ id: 15, enabled: false, parameters: null, type: null })
    expect(entries?.get(64)).toEqual({ id: 64, enabled: true, parameters: [32, 49, 1048576], type: 'standard' })
    expect(entries?.get(164)?.type).toBe('modifier')
    expect(entries?.get(65)).toEqual({ id: 65, enabled: true, parameters: null, type: null })
  })

  it('returns an empty table when the user never changed a system shortcut (empty domain)', () => {
    // `defaults export` 对不存在的域也输出 `<dict/>`，退出码为 0。
    expect(readSymbolicEntries('<?xml version="1.0"?><plist version="1.0"><dict/></plist>')).toEqual(new Map())
    expect(readSymbolicEntries('<plist><dict><key>Other</key><dict/></dict></plist>')).toEqual(new Map())
  })

  it('returns null for documents it cannot understand', () => {
    expect(readSymbolicEntries('<plist><dict><key>AppleSymbolicHotKeys</key><array/></dict></plist>')).toBeNull()
    expect(readSymbolicEntries('<plist><array/></plist>')).toBeNull()
    expect(readSymbolicEntries('garbage')).toBeNull()
  })

  it('ignores a __proto__ key instead of changing the prototype', () => {
    const xml = '<plist><dict><key>__proto__</key><dict><key>polluted</key><true/></dict><key>AppleSymbolicHotKeys</key><dict/></dict></plist>'
    const root = parsePlistXml(xml) as Record<string, unknown>
    expect(Object.getPrototypeOf(root)).toBe(Object.prototype)
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    expect(readSymbolicEntries(xml)).toEqual(new Map())
  })
})

describe('symbolicHotkeyKey', () => {
  it('maps virtual key codes and modifier masks to accelerators', () => {
    expect(symbolicHotkeyKey([32, 49, 1048576])).toBe('Command+Space')
    expect(symbolicHotkeyKey([32, 49, 262144])).toBe('Control+Space')
    expect(symbolicHotkeyKey([32, 49, 786432])).toBe('Control+Alt+Space')
    expect(symbolicHotkeyKey([51, 20, 1441792])).toBe('Command+Control+Shift+3')
    expect(symbolicHotkeyKey([96, 50, 1048576])).toBe('Command+`')
    expect(symbolicHotkeyKey([47, 44, 1179648])).toBe('Command+Shift+/')
  })

  it('ignores the function and numeric pad bits on arrows and F keys', () => {
    expect(symbolicHotkeyKey([65535, 123, 8650752])).toBe('Control+Left')
    expect(symbolicHotkeyKey([65535, 126, 10747904])).toBe('Control+Up')
    expect(symbolicHotkeyKey([65535, 96, 9437184])).toBe('Command+F5')
    expect(symbolicHotkeyKey([65535, 120, 8650752])).toBe('Control+F2')
  })

  it('skips shortcuts that need fn on ordinary keys, unknown bits, unknown keys or no modifier', () => {
    expect(symbolicHotkeyKey([113, 12, 8388608])).toBeNull()
    expect(symbolicHotkeyKey([52, 21, 1245184])).toBeNull()
    expect(symbolicHotkeyKey([65535, 160, 8388608])).toBeNull()
    expect(symbolicHotkeyKey([65535, 103, 8388608])).toBeNull()
    expect(symbolicHotkeyKey([32, 49, 0])).toBeNull()
    expect(symbolicHotkeyKey([32, 49, -1])).toBeNull()
    expect(symbolicHotkeyKey([32, 49, 2 ** 40])).toBeNull()
    expect(symbolicHotkeyKey([32])).toBeNull()
  })

  it('maps every default entry to an accelerator', () => {
    for (const [id, parameters] of DEFAULT_SYMBOLIC_HOTKEYS) {
      expect(symbolicHotkeyKey(parameters), String(id)).not.toBeNull()
    }
  })
})

describe('enabledSystemHotkeys', () => {
  const hotkeys = enabledSystemHotkeys(readSymbolicEntries(FIXTURE))
  const ids = hotkeys.map(hotkey => hotkey.id)

  it('includes enabled standard entries from the file', () => {
    expect(hotkeys).toContainEqual({ id: 64, key: 'Command+Space' })
    expect(hotkeys).toContainEqual({ id: 61, key: 'Control+Alt+Space' })
    expect(hotkeys).toContainEqual({ id: 79, key: 'Control+Left' })
    expect(hotkeys).toContainEqual({ id: 118, key: 'Control+1' })
    expect(hotkeys).toContainEqual({ id: 200, key: 'Command+Shift+K' })
    expect(hotkeys).toContainEqual({ id: 201, key: 'Control+Up' })
  })

  it('uses the default combination for enabled entries without a value', () => {
    expect(hotkeys).toContainEqual({ id: 65, key: 'Command+Alt+Space' })
  })

  it('assumes macOS defaults for well-known entries missing from the file', () => {
    expect(hotkeys).toContainEqual({ id: 28, key: 'Command+Shift+3' })
    expect(hotkeys).toContainEqual({ id: 32, key: 'Control+Up' })
    expect(hotkeys).toContainEqual({ id: 184, key: 'Command+Shift+5' })
  })

  it('leaves out disabled, modifier-only and unusable entries, even when a default exists', () => {
    expect(ids).not.toContain(15)
    expect(ids).not.toContain(27)
    expect(ids).not.toContain(30)
    expect(ids).not.toContain(60)
    expect(ids).not.toContain(164)
    expect(ids).not.toContain(190)
  })

  it('is sorted by id', () => {
    expect(ids).toEqual([...ids].sort((a, b) => a - b))
  })

  it('knows nothing when the plist could not be read', () => {
    expect(enabledSystemHotkeys(null)).toEqual([])
  })
})

describe('findSystemConflict', () => {
  const hotkeys = enabledSystemHotkeys(readSymbolicEntries(FIXTURE))

  it('finds the system shortcut using the same combination', () => {
    expect(findSystemConflict('Command+Space', hotkeys)).toBe(64)
    expect(findSystemConflict('Control+Alt+Space', hotkeys)).toBe(61)
    expect(findSystemConflict('Control+Up', hotkeys)).toBe(32)
  })

  it('finds nothing for free or disabled combinations', () => {
    expect(findSystemConflict('Control+P', hotkeys)).toBeNull()
    expect(findSystemConflict('Control+Space', hotkeys)).toBeNull()
    expect(findSystemConflict('Command+`', hotkeys)).toBeNull()
  })
})

describe('systemConflictFromXml', () => {
  it('reads, merges defaults and compares in one step', () => {
    expect(systemConflictFromXml('Command+Space', FIXTURE)).toBe(64)
    expect(systemConflictFromXml('Control+P', FIXTURE)).toBeNull()
  })

  it('reports no conflict when the plist is missing or unreadable', () => {
    expect(systemConflictFromXml('Command+Space', null)).toBeNull()
    expect(systemConflictFromXml('Command+Space', '<html></html>')).toBeNull()
  })

  it('assumes the macOS defaults when the user never changed any system shortcut', () => {
    const empty = '<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0">\n<dict/>\n</plist>\n'
    expect(systemConflictFromXml('Command+Space', empty)).toBe(64)
    expect(systemConflictFromXml('Control+Space', empty)).toBe(60)
    expect(systemConflictFromXml('Control+Alt+Space', empty)).toBe(61)
    expect(systemConflictFromXml('Control+P', empty)).toBeNull()
  })
})
