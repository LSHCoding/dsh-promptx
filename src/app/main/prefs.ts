// 小窗偏好 `<dsh>/promptx/prefs.json`（需求 6.1，design-spec 7.6）：窗口位置大小、栏宽、侧栏开合、所选文件夹和筛选。
//
// - 读：文件不存在、不是 JSON、版本不认识时整份用默认值；单个分段写坏了只把那一段换成默认值，数值超出 5.7 的范围时夹到范围内。
// - 写：渲染进程的修改先合并进内存，500 ms 内没有新的修改再落盘（拖动分隔线、拖动窗口时每秒几十次）。
//   先写同目录的临时文件再改名，读到的永远是完整的旧文件或新文件；退出前 flushSync 把没落盘的改动写掉。
// - 所有 profile 共用这个文件，两个小程序各自整份写入，后写的生效。

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { DEFAULT_PREFS, type Prefs } from '../../shared/bridge.ts'
import { libraryWidth, PANE_LIMITS, type Rect } from '../../shared/layout.ts'
import type { FolderSel, LibraryScope } from '../../shared/types.ts'
import { errorCode, type CompanionLogger } from './logger.ts'

export const PREFS_WRITE_DELAY_MS = 500

/** 偏好里的窗口坐标和大小的合理范围：超出的值多半是写坏了。 */
const COORDINATE_LIMIT = 100_000
const PANE_WIDTH_LIMIT = 10_000

type Fields = Record<string, unknown>

function isObject(value: unknown): value is Fields {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

function defaults(): Prefs {
  return structuredClone(DEFAULT_PREFS)
}

/** 窗口位置大小：四个有限数，宽高为正；否则 null（下次显示时用默认位置）。 */
export function parseWindowBounds(value: unknown): Rect | null {
  if (!isObject(value)) return null
  const { x, y, width, height } = value
  if (!finite(x) || !finite(y) || !finite(width) || !finite(height)) return null
  if (width < 1 || height < 1 || width > COORDINATE_LIMIT || height > COORDINATE_LIMIT) return null
  if (Math.abs(x) > COORDINATE_LIMIT || Math.abs(y) > COORDINATE_LIMIT) return null
  return { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) }
}

/** 栏位：逐个字段校验，坏的字段取 base 里的值，数值夹到需求 5.7 的范围。 */
export function parsePanes(value: unknown, base: Prefs['panes'] = DEFAULT_PREFS.panes): Prefs['panes'] {
  const panes = { ...base }
  if (!isObject(value)) return panes
  const number = (field: unknown, min: number, max: number, fallback: number): number =>
    (finite(field) ? Math.round(clamp(field, min, max)) : fallback)
  if (typeof value.library === 'boolean') panes.library = value.library
  panes.folderWidth = number(value.folderWidth, PANE_LIMITS.folder.min, PANE_LIMITS.folder.max, panes.folderWidth)
  panes.listWidth = number(value.listWidth, PANE_LIMITS.list.min, PANE_WIDTH_LIMIT, panes.listWidth)
  panes.previewHeight = number(value.previewHeight, PANE_LIMITS.preview.min, PANE_WIDTH_LIMIT, panes.previewHeight)
  panes.sessionWidth = number(value.sessionWidth, PANE_LIMITS.session.min, PANE_LIMITS.session.max, panes.sessionWidth)
  return panes
}

function parseFolder(value: unknown): FolderSel | null {
  if (!isObject(value)) return null
  if (value.kind === 'all') return { kind: 'all' }
  if (value.kind === 'root') return { kind: 'root' }
  if (value.kind === 'folder' && typeof value.path === 'string' && value.path !== '') return { kind: 'folder', path: value.path }
  return null
}

const SCOPES: readonly LibraryScope[] = ['all', 'recent', 'favorites']

function parseScope(value: unknown): LibraryScope | null {
  return SCOPES.find(scope => scope === value) ?? null
}

/** 库侧栏的选择：逐个字段校验，坏的字段取 base 里的值。 */
export function parseLibrary(value: unknown, base: Prefs['library'] = DEFAULT_PREFS.library): Prefs['library'] {
  const library = { ...base }
  if (!isObject(value)) return library
  library.folder = parseFolder(value.folder) ?? library.folder
  library.scope = parseScope(value.scope) ?? library.scope
  if (value.tag === null || typeof value.tag === 'string') library.tag = value.tag
  return library
}

/** 整份偏好的校验。版本不是 1 时按读不出来处理（以后的版本由那时的代码迁移）。 */
export function parsePrefs(raw: unknown): Prefs {
  const prefs = defaults()
  if (!isObject(raw) || raw.version !== 1) return prefs
  prefs.window = parseWindowBounds(raw.window)
  prefs.editorWidth = parseEditorWidth(raw.editorWidth)
  prefs.panes = parsePanes(raw.panes)
  prefs.library = parseLibrary(raw.library)
  return prefs
}

function parseEditorWidth(value: unknown, fallback: number | null = null): number | null {
  if (value === null) return null
  return finite(value) && value >= 1 && value <= COORDINATE_LIMIT ? Math.round(value) : fallback
}

/** 合并渲染进程发来的修改，原生窗口位置和尺寸由主进程记。 */
export function mergePrefsPatch(prefs: Prefs, patch: unknown): Prefs {
  if (!isObject(patch)) return prefs
  return {
    ...prefs,
    editorWidth: parseEditorWidth(patch.editorWidth, prefs.editorWidth),
    panes: 'panes' in patch ? parsePanes(patch.panes, prefs.panes) : prefs.panes,
    library: 'library' in patch ? parseLibrary(patch.library, prefs.library) : prefs.library,
  }
}

export interface PrefsStoreOptions {
  file: string
  logger: CompanionLogger
  pid?: number
  writeDelayMs?: number
}

export class PrefsStore {
  readonly #file: string
  readonly #logger: CompanionLogger
  readonly #pid: number
  readonly #writeDelayMs: number
  #prefs: Prefs = defaults()
  #timer: ReturnType<typeof setTimeout> | null = null
  #dirty = false

  constructor(options: PrefsStoreOptions) {
    this.#file = options.file
    this.#logger = options.logger
    this.#pid = options.pid ?? process.pid
    this.#writeDelayMs = options.writeDelayMs ?? PREFS_WRITE_DELAY_MS
  }

  /** 同步读入（启动时一次）。读不出来时用默认值，并记下原因的错误码。 */
  load(): Prefs {
    let text: string
    try {
      text = readFileSync(this.#file, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.#logger.warn('prefs.read-failed', { error: errorCode(error) })
      this.#prefs = defaults()
      return this.get()
    }
    let raw: unknown
    try {
      raw = JSON.parse(text)
    } catch {
      this.#logger.warn('prefs.invalid-json')
      raw = null
    }
    this.#prefs = parsePrefs(raw)
    return this.get()
  }

  /** 当前偏好的副本：调用方（IPC 回复）拿去改也影响不到存着的那份。 */
  get(): Prefs {
    return structuredClone(this.#prefs)
  }

  /** 冷启动时聊天栏收起，按退出前实际的编辑区宽度和库宽重建小窗。旧偏好直接沿用原尺寸。 */
  restoreWithoutSession(): void {
    const { window, editorWidth, panes } = this.#prefs
    if (editorWidth === null) return
    if (window !== null) this.setWindow({ ...window, width: editorWidth + (panes.library ? libraryWidth(panes) : 0) })
    this.set({ editorWidth: null })
  }

  set(patch: unknown): void {
    const next = mergePrefsPatch(this.#prefs, patch)
    if (JSON.stringify(next) === JSON.stringify(this.#prefs)) return
    this.#prefs = next
    this.#schedule()
  }

  setWindow(bounds: Rect | null): void {
    const window = bounds === null ? null : parseWindowBounds(bounds)
    if (JSON.stringify(window) === JSON.stringify(this.#prefs.window)) return
    this.#prefs = { ...this.#prefs, window }
    this.#schedule()
  }

  /** 把没落盘的修改立即写掉（退出前调用）。 */
  flushSync(): void {
    if (this.#timer !== null) {
      clearTimeout(this.#timer)
      this.#timer = null
    }
    if (this.#dirty) this.#write()
  }

  /** 停止计时器但不写盘（测试用）。 */
  dispose(): void {
    if (this.#timer !== null) clearTimeout(this.#timer)
    this.#timer = null
  }

  #schedule(): void {
    this.#dirty = true
    if (this.#timer !== null) clearTimeout(this.#timer)
    this.#timer = setTimeout(() => {
      this.#timer = null
      this.#write()
    }, this.#writeDelayMs)
  }

  #write(): void {
    this.#dirty = false
    const tmp = `${this.#file}.${this.#pid}.tmp`
    try {
      mkdirSync(dirname(this.#file), { recursive: true })
      writeFileSync(tmp, `${JSON.stringify(this.#prefs, null, 2)}\n`)
      renameSync(tmp, this.#file)
    } catch (error) {
      this.#logger.warn('prefs.write-failed', { error: errorCode(error) })
      try {
        rmSync(tmp, { force: true })
      } catch {
        // 临时文件删不掉不影响下一次写：同名覆盖。
      }
    }
  }
}
