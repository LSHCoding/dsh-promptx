import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  mergePrefsPatch,
  parseLibrary,
  parsePanes,
  parsePrefs,
  parseWindowBounds,
  PREFS_WRITE_DELAY_MS,
  PrefsStore,
} from '../../../src/app/main/prefs.ts'
import { DEFAULT_PREFS, type Prefs } from '../../../src/shared/bridge.ts'
import { PANE_LIMITS } from '../../../src/shared/layout.ts'
import { MemoryLogger, trapProcessErrors, useTempDir } from './helpers.ts'

trapProcessErrors()
const tempDir = useTempDir('prefs')

afterEach(() => {
  vi.useRealTimers()
})

describe('parseWindowBounds', () => {
  it('accepts four finite numbers and rounds them', () => {
    expect(parseWindowBounds({ x: -1200.4, y: 30.6, width: 980, height: 600.2 })).toEqual({ x: -1200, y: 31, width: 980, height: 600 })
  })

  it('rejects missing, non-finite, non-positive and absurd values', () => {
    expect(parseWindowBounds(null)).toBeNull()
    expect(parseWindowBounds({ x: 0, y: 0, width: 980 })).toBeNull()
    expect(parseWindowBounds({ x: Number.NaN, y: 0, width: 980, height: 600 })).toBeNull()
    expect(parseWindowBounds({ x: 0, y: 0, width: 0, height: 600 })).toBeNull()
    expect(parseWindowBounds({ x: 0, y: 0, width: '980', height: 600 })).toBeNull()
    expect(parseWindowBounds({ x: 1e9, y: 0, width: 980, height: 600 })).toBeNull()
    expect(parseWindowBounds({ x: 0, y: 0, width: 1e9, height: 600 })).toBeNull()
  })
})

describe('parsePanes', () => {
  it('keeps valid fields and clamps widths to the 5.7 limits', () => {
    expect(parsePanes({ library: true, folderWidth: 9999, listWidth: 10, previewHeight: 50, sessionWidth: 100 })).toEqual({
      library: true,
      folderWidth: PANE_LIMITS.folder.max,
      listWidth: PANE_LIMITS.list.min,
      previewHeight: PANE_LIMITS.preview.min,
      sessionWidth: PANE_LIMITS.session.min,
    })
  })

  it('replaces only the broken fields with the base values', () => {
    const base = { ...DEFAULT_PREFS.panes, listWidth: 333 }
    expect(parsePanes({ library: 'yes', folderWidth: Number.POSITIVE_INFINITY, listWidth: null, sessionWidth: 450.6 }, base)).toEqual({
      ...base,
      sessionWidth: 451,
    })
    expect(parsePanes('broken', base)).toEqual(base)
  })
})

describe('parseLibrary', () => {
  it('accepts the three folder kinds, the scopes and a tag', () => {
    expect(parseLibrary({ folder: { kind: 'folder', path: '写作/评审' }, scope: 'favorites', tag: '示例' })).toEqual({
      folder: { kind: 'folder', path: '写作/评审' },
      scope: 'favorites',
      tag: '示例',
    })
    expect(parseLibrary({ folder: { kind: 'root' }, scope: 'recent', tag: null }).folder).toEqual({ kind: 'root' })
  })

  it('falls back field by field', () => {
    expect(parseLibrary({ folder: { kind: 'folder', path: '' }, scope: 'everything', tag: 3 })).toEqual(DEFAULT_PREFS.library)
    expect(parseLibrary({ folder: { kind: 'nope' } }, { folder: { kind: 'root' }, scope: 'recent', tag: 'x' })).toEqual({
      folder: { kind: 'root' },
      scope: 'recent',
      tag: 'x',
    })
  })
})

describe('parsePrefs', () => {
  it('returns defaults for anything that is not a version 1 object', () => {
    expect(parsePrefs(null)).toEqual(DEFAULT_PREFS)
    expect(parsePrefs([])).toEqual(DEFAULT_PREFS)
    expect(parsePrefs({ version: 2, window: { x: 0, y: 0, width: 980, height: 600 } })).toEqual(DEFAULT_PREFS)
  })

  it('reads every section of a valid file', () => {
    const prefs: Prefs = {
      version: 1,
      window: { x: 10, y: 20, width: 1000, height: 700 },
      editorWidth: 500,
      panes: { library: true, folderWidth: 160, listWidth: 320, previewHeight: 240, sessionWidth: 400 },
      library: { folder: { kind: 'folder', path: 'a' }, scope: 'recent', tag: 't' },
    }
    expect(parsePrefs(JSON.parse(JSON.stringify(prefs)))).toEqual(prefs)
  })

  it('does not share the default objects with callers', () => {
    const prefs = parsePrefs(null)
    prefs.panes.library = false
    expect(DEFAULT_PREFS.panes.library).toBe(true)
  })
})

describe('mergePrefsPatch', () => {
  it('merges panes and library and ignores the window and unknown fields', () => {
    const base = parsePrefs({ version: 1, window: { x: 1, y: 2, width: 900, height: 500 } })
    const merged = mergePrefsPatch(base, {
      panes: { library: true, listWidth: 280 },
      library: { scope: 'favorites' },
      window: { x: 999, y: 999, width: 999, height: 999 },
      version: 7,
    })
    expect(merged.window).toEqual({ x: 1, y: 2, width: 900, height: 500 })
    expect(merged.version).toBe(1)
    expect(merged.panes).toEqual({ ...DEFAULT_PREFS.panes, library: true, listWidth: 280 })
    expect(merged.library).toEqual({ ...DEFAULT_PREFS.library, scope: 'favorites' })
  })

  it('ignores patches that are not objects', () => {
    const base = parsePrefs(null)
    expect(mergePrefsPatch(base, null)).toBe(base)
    expect(mergePrefsPatch(base, 'panes')).toBe(base)
  })
})

describe('PrefsStore', () => {
  const file = (): string => join(tempDir(), 'promptx', 'prefs.json')
  const store = (logger = new MemoryLogger()): PrefsStore => new PrefsStore({ file: file(), logger, pid: 77 })

  it('uses defaults when the file does not exist, without logging a problem', () => {
    const logger = new MemoryLogger()
    expect(store(logger).load()).toEqual(DEFAULT_PREFS)
    expect(logger.entries).toEqual([])
  })

  it('uses defaults for an invalid file and logs only the problem', () => {
    mkdirSync(join(tempDir(), 'promptx'), { recursive: true })
    writeFileSync(file(), '{"version": 1, "window": ')
    const logger = new MemoryLogger()
    expect(store(logger).load()).toEqual(DEFAULT_PREFS)
    expect(logger.events('warn')).toEqual(['prefs.invalid-json'])
  })

  it('debounces writes by 500 ms and writes the merged result atomically', () => {
    vi.useFakeTimers()
    const prefs = store()
    prefs.load()
    prefs.set({ panes: { library: false } })
    prefs.set({ library: { tag: 'x' } })
    prefs.setWindow({ x: 5, y: 6, width: 700, height: 500 })
    vi.advanceTimersByTime(PREFS_WRITE_DELAY_MS - 1)
    expect(existsSync(file())).toBe(false)
    vi.advanceTimersByTime(1)
    const written = JSON.parse(readFileSync(file(), 'utf8')) as Prefs
    expect(written).toEqual({
      ...DEFAULT_PREFS,
      window: { x: 5, y: 6, width: 700, height: 500 },
      panes: { ...DEFAULT_PREFS.panes, library: false },
      library: { ...DEFAULT_PREFS.library, tag: 'x' },
    })
    // 临时文件改名成正式文件，目录里不留 .tmp。
    expect(readdirSync(join(tempDir(), 'promptx'))).toEqual(['prefs.json'])
    expect(store().load()).toEqual(written)
  })

  it('restarts the debounce on every change (dragging the window)', () => {
    vi.useFakeTimers()
    const prefs = store()
    for (let i = 0; i < 5; i++) {
      prefs.setWindow({ x: i, y: 0, width: 700, height: 500 })
      vi.advanceTimersByTime(300)
    }
    expect(existsSync(file())).toBe(false)
    vi.advanceTimersByTime(200)
    expect((JSON.parse(readFileSync(file(), 'utf8')) as Prefs).window?.x).toBe(4)
  })

  it('does not schedule a write when nothing changed', () => {
    vi.useFakeTimers()
    const prefs = store()
    prefs.set({ panes: DEFAULT_PREFS.panes })
    prefs.setWindow(null)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('flushSync writes pending changes immediately and cancels the timer', () => {
    vi.useFakeTimers()
    const prefs = store()
    prefs.set({ library: { scope: 'recent' } })
    prefs.flushSync()
    expect(vi.getTimerCount()).toBe(0)
    expect((JSON.parse(readFileSync(file(), 'utf8')) as Prefs).library.scope).toBe('recent')
  })

  it('flushSync does nothing when there is nothing to write', () => {
    store().flushSync()
    expect(existsSync(file())).toBe(false)
  })

  it('returns copies that callers cannot use to change the store', () => {
    const prefs = store()
    const copy = prefs.get()
    copy.panes.library = false
    expect(prefs.get().panes.library).toBe(true)
  })

  it('logs a write failure by error code and keeps running', () => {
    vi.useFakeTimers()
    const blocker = join(tempDir(), 'promptx')
    writeFileSync(blocker, 'not a directory')
    const logger = new MemoryLogger()
    const prefs = new PrefsStore({ file: join(blocker, 'prefs.json'), logger, pid: 77 })
    prefs.set({ panes: { library: false } })
    vi.advanceTimersByTime(PREFS_WRITE_DELAY_MS)
    expect(logger.find('prefs.write-failed')?.fields).toEqual({ error: expect.stringMatching(/^Error:E[A-Z]+$/) as unknown })
  })

  it('dispose stops the timer without writing', () => {
    vi.useFakeTimers()
    const prefs = store()
    prefs.set({ panes: { library: false } })
    prefs.dispose()
    expect(vi.getTimerCount()).toBe(0)
    expect(existsSync(file())).toBe(false)
  })
})
