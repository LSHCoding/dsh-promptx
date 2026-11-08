// Prompt 库服务（需求 L-01 至 L-12、6.1 至 6.5、7.2、7.3、N-01、N-02；design-spec 6.1、7.1 至 7.4、D24）。
// 小窗的库操作都经过这里，P1 的 Agent 工具也调用同一批方法（一个操作只实现一次）。
//
// 贯穿全文件的几条规则：
// - 每个操作开始时取一次库目录，之后排队、检查位置限制、realpath 都用这一个值：配置随时可能被改，包括手改补丁文件，
//   排在旧目录队列里的操作不能半路落到新目录上。
// - 修改操作（保存、改元数据、删除、恢复）按库根目录排队串行，「读取 → 核对 → 写入」在自己的队列位置里完成（审查意见 S05）。
// - 扫描跳过的目录（dsh 数据目录、技能目录、`<dsh>/promptx`）列表里看不到，读写也不碰（审查意见 S13）。
// - 每份要写出的新内容先用同一个解析器读回，读回的值和要写的值不同就拒绝写入（审查意见 S11）。
// - 抛给小程序的错误只带错误码和系统错误说明，不带正文、标题和文件名（N-02）。

import { randomBytes as cryptoRandomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import type { Stats } from 'node:fs'
import { access, lstat, mkdir, readdir, realpath, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { withFileLock } from '@deepseek-ai/dsh-atomic-write'
import { PromptxError } from '../shared/errors.ts'
import type { ErrorCode } from '../shared/errors.ts'
import {
  addFrontMatter,
  editorBody,
  parsePromptFile,
  patchFrontMatter,
  renderNewPromptFile,
  replaceBody,
  toLf,
} from '../shared/frontmatter.ts'
import type { FrontMatterFields, FrontMatterPatch, ParsedPromptFile, PatchFailure, TagsLayout } from '../shared/frontmatter.ts'
import {
  displayTitle,
  fileNameCandidates,
  folderOf,
  formatIsoUtc,
  generatePromptId,
  makeFileStem,
  newPromptTitle,
  splitRelPath,
} from '../shared/library-rules.ts'
import { filterEntries, normalizeSearchText, splitQuery } from '../shared/search.ts'
import type {
  Binding,
  ErrorInfo,
  LibraryListParams,
  LibraryListResult,
  LibraryReadResult,
  MetaConflict,
  MetaResult,
  RestoreResult,
  SaveConflict,
  SaveMode,
  SaveResult,
  TrashEntry,
  TrashListResult,
} from '../shared/types.ts'
import type { LibraryApi, LibraryServiceOptions } from '../services.ts'
import {
  MAX_PROMPT_BYTES,
  createNoClobber,
  ensureFolder,
  errnoCode,
  folderAbs,
  hashFile,
  isPromptxTempName,
  locate,
  moveNoClobber,
  nameKey,
  nameKeysOf,
  readRegularFile,
  removeStaleTemps,
  replaceFile,
  sameVersion,
  systemErrorDetail,
  versionOf,
} from './fs-safe.ts'
import type { FsHooks, FsOps, FsOptions } from './fs-safe.ts'
import { IndexCache, deriveIndex } from './index-cache.ts'
import type { LibraryIndex } from './index-cache.ts'
import { isObject, parseBinding, parseListParams, parseMetaUpdate, parseRestoreRequest, parseSaveRequest } from './params.ts'
import type { MetaRequest } from './params.ts'
import { KeyedQueue } from './queue.ts'
import { TRASH_DIR, folderRelPath, isTrashFileName, promptRelPath } from './rel-path.ts'
import { READ_CONCURRENCY, STALE_TEMP_MS, decodeUtf8, entryFromText, foldPath, indexFile, indexedFromText, mapPool } from './scan.ts'
import type { IndexedFile } from './scan.ts'
import { numberedNames, readTrashRecord, recordLockTarget, setAsideBrokenRecord, trashNameCandidates, writeTrashRecord } from './trash.ts'
import type { TrashItem } from './trash.ts'

/** 新建文件的 requestId 在 Host 进程里记住最近多少个（design-spec 6.1）。 */
const REMEMBERED_REQUESTS = 100

/**
 * 等回收站记录锁最多多久。默认的 2 秒按「只做文件操作」估算，删除在持锁期间还要移动文件、fsync，
 * 慢速的网络盘或同步盘上会超时；10 秒仍在小程序请求的超时（15 秒）以内。
 */
const RECORD_LOCK_WAIT_MS = 10_000

/** 替代名字最多试多少个。 */
const MAX_ALTERNATIVES = 10_000

/** 测试用的插入点：在竞争窗口里模拟外部程序或另一个进程的操作。 */
export interface LibraryHooks extends FsHooks {
  /** 回收站记录写入之前。 */
  beforeRecordWrite?: () => Promise<void>
}

/** 只给测试用的内部选项：替换底层文件操作、插入竞争、模拟平台、缩短等锁的时间。 */
export interface LibraryInternals {
  ops?: Partial<FsOps>
  hooks?: LibraryHooks
  platform?: NodeJS.Platform
  recordLockWaitMs?: number
}

interface OkRoot {
  kind: 'ok'
  configured: string
  real: string
  /** skipRealpaths() 的原样结果，交给扫描。 */
  skipList: readonly string[]
  /** 同一份名单按平台的大小写规则折叠后的集合，用来核对操作落在哪里。 */
  skip: ReadonlySet<string>
}

type RootState =
  | OkRoot
  | { kind: 'missing'; configured: string }
  | { kind: 'unavailable'; configured: string; error: ErrorInfo }

interface TrashFileInfo {
  indexed: IndexedFile
  searchTitle: string
  searchTags: string[]
}

type SaveParams = Parameters<LibraryApi['save']>[0]
type MetaParams = Parameters<LibraryApi['updateMeta']>[0]
type RestoreParams = Parameters<LibraryApi['trashRestore']>[0]

// ───────────────────────────── 小工具 ─────────────────────────────

/** 业务错误原样传出；其他异常归到 code，说明只取系统错误码和描述（不带路径）。 */
function asPromptxError(error: unknown, code: ErrorCode, detail?: string): PromptxError {
  if (error instanceof PromptxError) return error
  return new PromptxError(code, detail ?? systemErrorDetail(error))
}

/** 位置检查返回的错误放进 promptx/library/unavailable 的说明里。 */
function unavailableDetail(info: ErrorInfo): string | undefined {
  if (info.code === 'promptx/library/unavailable') return info.detail
  return info.detail === undefined ? info.code : `${info.code}: ${info.detail}`
}

function unavailableInfo(error: unknown): ErrorInfo {
  return { code: 'promptx/library/unavailable', detail: systemErrorDetail(error) }
}

function unavailableRoot(configured: string, detail: string): RootState {
  return { kind: 'unavailable', configured, error: { code: 'promptx/library/unavailable', detail } }
}

function saveConflict(conflict: SaveConflict): SaveResult {
  return { kind: 'conflict', conflict }
}

function metaConflict(conflict: MetaConflict): MetaResult {
  return { kind: 'conflict', conflict }
}

function patchConflict(reason: PatchFailure): MetaConflict {
  switch (reason) {
    case 'no-front-matter':
      return 'noFrontMatter'
    case 'invalid':
      return 'invalidFrontMatter'
    case 'unsupported-layout':
      return 'unsupportedLayout'
  }
}

function sameTags(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((tag, index) => tag === b[index])
}

function sameFields(a: FrontMatterFields, b: FrontMatterFields): boolean {
  if (a.id !== b.id || a.title !== b.title || a.favorite !== b.favorite || a.created !== b.created || a.updated !== b.updated) return false
  if (a.tags === undefined || b.tags === undefined) return a.tags === b.tags
  return sameTags(a.tags, b.tags)
}

/**
 * 写之前用同一个解析器读回新内容：front matter 能解析、认识的字段都等于要写的值、BOM 和换行风格不变。
 * 标题里有 `#`、引号、冒号时写法稍有差错就会把自己的文件读成别的标题，或者整份标成写坏了（审查意见 S11）。
 * 通过时返回解析结果，调用方再核对正文。
 */
function readBack(text: string, expected: FrontMatterFields, reference: Pick<ParsedPromptFile, 'bom' | 'eol'>): ParsedPromptFile | null {
  const parsed = parsePromptFile(text)
  if (parsed.frontMatter?.state !== 'ok') return null
  if (parsed.bom !== reference.bom || parsed.eol !== reference.eol) return null
  return sameFields(parsed.frontMatter.fields, expected) ? parsed : null
}

/**
 * 超过单个文件上限（需求 6.2）的内容不写：写出去之后扫描和读取都会把它当成「无法打开」，用户再也打不开自己存的东西。
 * 草稿上限是 10 万字（N-01），正常保存碰不到这个上限。
 */
function assertWritableSize(bytes: Uint8Array): void {
  if (bytes.length > MAX_PROMPT_BYTES) throw new PromptxError('promptx/library/write-failed', 'EFBIG: file too large')
}

/** 写回时保持原文件的权限位（审查意见 S15）。Windows 上只有只读位，按新文件处理。 */
function modeToKeep(stats: Stats): number | undefined {
  return process.platform === 'win32' ? undefined : stats.mode & 0o777
}

/**
 * 用户把文件设成了只读（chmod a-w、Windows 的只读属性）时不改写它。原子替换只要目录有写权限，
 * 不先查一下就会悄悄换掉只读文件；按「没有权限」报保存失败，和普通编辑器一致（红线 2：不越权改写）。
 */
async function assertWritable(abs: string): Promise<void> {
  await access(abs, constants.W_OK)
}

async function isRealDirectory(path: string): Promise<boolean> {
  try {
    const stats = await lstat(path)
    return stats.isDirectory() && !stats.isSymbolicLink()
  } catch {
    return false
  }
}

async function isRegularFileAt(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isFile()
  } catch {
    return false
  }
}

/** 确保库根目录下的 `_trash/` 存在。它是符号链接或文件时不往里移：移进去的文件会落到库目录之外。 */
async function ensureTrashDir(rootReal: string): Promise<string> {
  const trashDir = join(rootReal, TRASH_DIR)
  let stats: Stats | null = null
  try {
    stats = await lstat(trashDir)
  } catch (error) {
    if (errnoCode(error) !== 'ENOENT') throw error
  }
  if (stats === null) {
    try {
      await mkdir(trashDir)
    } catch (error) {
      if (errnoCode(error) !== 'EEXIST') throw error
    }
    stats = await lstat(trashDir)
  }
  if (stats.isSymbolicLink() || !stats.isDirectory()) throw new PromptxError('promptx/library/move-failed', 'ENOTDIR: _trash is not a directory')
  return trashDir
}

let trashCollator: Intl.Collator | undefined

/** 回收站按删除时间从新到旧，原位置未知（没有删除时间）的排在最后，同一时间按标题（L-11）。 */
function compareTrashEntries(a: TrashEntry, b: TrashEntry): number {
  if (a.deletedAt !== b.deletedAt) {
    if (a.deletedAt === null) return 1
    if (b.deletedAt === null) return -1
    return b.deletedAt - a.deletedAt
  }
  trashCollator ??= new Intl.Collator(undefined, { numeric: true })
  const byTitle = trashCollator.compare(a.title, b.title)
  if (byTitle !== 0) return byTitle
  return a.file < b.file ? -1 : a.file > b.file ? 1 : 0
}

function emptyList(state: 'missing' | 'unavailable', root: string): LibraryListResult {
  return { state, root, folders: [], tags: [], entries: [], total: 0 }
}

// ───────────────────────────── 服务 ─────────────────────────────

export class LibraryService implements LibraryApi {
  readonly #options: LibraryServiceOptions
  readonly #ops: Partial<FsOps> | undefined
  readonly #hooks: LibraryHooks
  readonly #platform: NodeJS.Platform
  readonly #recordLockWaitMs: number
  readonly #queue = new KeyedQueue()
  readonly #cache = new IndexCache()
  /** 新建文件的 requestId → 结果，最近 100 个。 */
  readonly #created = new Map<string, SaveResult>()
  /** 回收站文件的标题和规范化正文，按回收站目录分组、按修改时间和大小复用。 */
  readonly #trashInfo = new Map<string, Map<string, TrashFileInfo>>()

  constructor(options: LibraryServiceOptions, internals: LibraryInternals = {}) {
    this.#options = options
    this.#ops = internals.ops
    this.#hooks = internals.hooks ?? {}
    this.#platform = internals.platform ?? process.platform
    this.#recordLockWaitMs = internals.recordLockWaitMs ?? RECORD_LOCK_WAIT_MS
  }

  // ───────────── 读 ─────────────

  async list(params: LibraryListParams): Promise<LibraryListResult> {
    const request = parseListParams(params)
    const state = await this.#resolveRoot(this.#options.getRoot())
    if (state.kind === 'missing') return emptyList('missing', state.configured)
    if (state.kind === 'unavailable') return { ...emptyList('unavailable', state.configured), error: state.error }
    let index: LibraryIndex
    try {
      // 展开侧栏时刷新索引；搜索输入时只查询（design-spec 7.2），还没有索引时扫描一次
      const cached = request.refresh ? null : this.#cache.current(state.real)
      index = cached ?? await this.#cache.refresh(state.real, { skipRealpaths: state.skipList, platform: this.#platform })
    } catch (error) {
      return { ...emptyList('unavailable', state.configured), error: unavailableInfo(error) }
    }
    const derived = deriveIndex(index)
    return {
      state: 'ok',
      root: state.configured,
      folders: derived.folders,
      tags: derived.tags,
      entries: filterEntries(derived.docs, request, this.#now().getTime()),
      total: derived.docs.length,
    }
  }

  async read(relPath: string): Promise<LibraryReadResult> {
    const rel = promptRelPath(relPath, this.#platform)
    if (rel === null) throw new PromptxError('promptx/library/invalid-path')
    try {
      const root = this.#rootOrThrow(await this.#resolveRoot(this.#options.getRoot()))
      if (root === null) throw new PromptxError('promptx/library/not-found')
      this.#assertNotSkipped(root, folderOf(rel))
      const located = await locate(root.real, rel)
      if (located.kind !== 'file') throw new PromptxError('promptx/library/not-found')
      const file = await readRegularFile(located.abs, MAX_PROMPT_BYTES)
      if (file.kind === 'missing' || file.kind === 'not-file') throw new PromptxError('promptx/library/not-found')
      if (file.kind === 'too-large') throw new PromptxError('promptx/library/unreadable', 'too-large')
      const text = decodeUtf8(file.bytes)
      if (text === null) throw new PromptxError('promptx/library/unreadable', 'not-utf8')
      const { meta, body } = entryFromText(rel, text, file.stats.mtimeMs)
      return { entry: meta, body, version: versionOf(file.bytes) }
    } catch (error) {
      throw asPromptxError(error, 'promptx/library/unreadable', 'read-failed')
    }
  }

  // ───────────── 保存 ─────────────

  async save(params: SaveParams): Promise<SaveResult> {
    const request = parseSaveRequest(params)
    // 草稿为空或只有空白：「没有可保存的内容。」（L-08）
    if (request.text.trim() === '') throw new PromptxError('promptx/library/empty')
    // 另存为新 Prompt 一律存到库根目录（L-12），不看所选文件夹
    const asNew = request.binding === null || request.mode === 'saveAsNew'
    const folder = asNew && request.mode !== 'saveAsNew' ? folderRelPath(request.folder, this.#platform) : ''
    if (folder === null) throw new PromptxError('promptx/library/invalid-path')
    const configured = this.#options.getRoot()
    return await this.#mutate(configured, async () => {
      try {
        if (asNew) return await this.#saveNew(configured, request.text, folder, request.requestId)
        return await this.#saveBound(configured, request.text, request.binding, request.mode)
      } catch (error) {
        throw asPromptxError(error, 'promptx/library/write-failed')
      }
    })
  }

  async #saveNew(configured: string, text: string, folder: string, requestId: string): Promise<SaveResult> {
    // 保存请求超时后小窗会带同一个 requestId 重发：返回已经建好的文件，不建第二个（design-spec 6.1，审查意见 S05）
    const key = requestId === '' ? null : requestId
    const remembered = key === null ? undefined : this.#created.get(key)
    if (remembered !== undefined) return remembered
    let state = await this.#resolveRoot(configured)
    if (state.kind === 'missing') {
      // 库目录不存在：第一次保存时建立，包括缺少的上级目录（L-01）
      await mkdir(configured, { recursive: true })
      state = await this.#resolveRoot(configured)
    }
    const root = this.#rootOrThrow(state)
    if (root === null) throw new PromptxError('promptx/library/write-failed', 'ENOENT: library directory missing')
    this.#assertNotSkipped(root, folder)
    await ensureFolder(root.real, folder)
    const now = this.#now()
    const stamp = formatIsoUtc(now)
    const id = generatePromptId(now, this.#randomBytes(4))
    const title = newPromptTitle(text, this.#options.untitledTitle())
    const content = renderNewPromptFile({ id, title, created: stamp, updated: stamp }, text)
    const check = readBack(content, { id, title, tags: [], favorite: false, created: stamp, updated: stamp }, { bom: false, eol: 'lf' })
    if (check === null || check.body !== text) return saveConflict('invalidFrontMatter')
    const bytes = Buffer.from(content, 'utf8')
    assertWritableSize(bytes)
    const candidates = fileNameCandidates(makeFileStem(title), id)
    const created = await createNoClobber(folderAbs(root.real, folder), candidates, bytes, this.#fsOptions())
    const relPath = folder === '' ? created.name : `${folder}/${created.name}`
    const indexed = indexedFromText(relPath, content, created.stats)
    const version = versionOf(bytes)
    const result: SaveResult = {
      kind: 'saved',
      created: true,
      entry: indexed.doc.meta,
      binding: { libraryDir: configured, relPath, id, title, sha256: version.sha256, size: version.size, savedBody: text },
    }
    this.#remember(key, result)
    this.#cache.record(root.real, relPath, indexed)
    return result
  }

  async #saveBound(configured: string, text: string, bindingInput: unknown, mode: SaveMode): Promise<SaveResult> {
    const binding = parseBinding(bindingInput)
    if (binding === null) throw new PromptxError('promptx/internal', 'invalid-binding')
    const relPath = promptRelPath(binding.relPath, this.#platform)
    if (relPath === null) throw new PromptxError('promptx/library/invalid-path')
    const root = this.#rootOrThrow(await this.#resolveRoot(configured))
    // 插件按文件位置绑定：库目录变了，原来的文件就不在这个库里，按「原文件已不存在」处理（L-01、L-12）
    if (root === null || binding.libraryDir !== configured) return saveConflict('missing')
    this.#assertNotSkipped(root, folderOf(relPath))
    const located = await locate(root.real, relPath)
    if (located.kind !== 'file') return saveConflict('missing')
    const current = await readRegularFile(located.abs, MAX_PROMPT_BYTES)
    if (current.kind === 'missing' || current.kind === 'not-file') return saveConflict('missing')
    // 载入后被外部改得超过上限：版本肯定对不上
    if (current.kind === 'too-large') return saveConflict('modified')
    // 先核对磁盘上的文件是不是载入时的版本（L-12）
    const before = versionOf(current.bytes)
    if (!sameVersion(before, binding)) return saveConflict('modified')
    await assertWritable(located.abs)
    const original = decodeUtf8(current.bytes)
    if (original === null) throw new PromptxError('promptx/library/unreadable', 'not-utf8')
    const parsed = parsePromptFile(original)
    const now = this.#now()
    const stamp = formatIsoUtc(now)
    const frontMatter = parsed.frontMatter
    let next: string
    let expected: FrontMatterFields
    if (frontMatter === null) {
      // 没有 front matter 的文件，用户在对话框里选「补上并保存」之前一个字节都不改（L-08、7.3）
      if (mode !== 'addFrontMatter') return saveConflict('noFrontMatter')
      const fields = { id: generatePromptId(now, this.#randomBytes(4)), title: binding.title, created: stamp, updated: stamp }
      expected = fields
      next = replaceBody(addFrontMatter(original, fields), text)
    } else if (frontMatter.state !== 'ok') {
      // 写坏了、布局不认识或没有结尾行：不改写，提示先修好或另存为新 Prompt（L-01，审查意见 S12）
      return saveConflict('invalidFrontMatter')
    } else {
      // 只替换正文、改 updated；缺 id 时只补 id（L-08）。其他字段、注释、顺序、引号一个字节都不动
      const patch: FrontMatterPatch = { updated: stamp }
      if ((frontMatter.fields.id ?? '').trim() === '') patch.id = generatePromptId(now, this.#randomBytes(4))
      const patched = patchFrontMatter(original, patch)
      if (!patched.ok) return saveConflict(patched.reason === 'no-front-matter' ? 'noFrontMatter' : 'invalidFrontMatter')
      expected = { ...frontMatter.fields, ...patch }
      next = replaceBody(patched.text, text)
    }
    const check = readBack(next, expected, parsed)
    if (check === null || toLf(check.body) !== toLf(text)) return saveConflict('invalidFrontMatter')
    const bytes = Buffer.from(next, 'utf8')
    assertWritableSize(bytes)
    const outcome = await replaceFile(located.abs, bytes, { ...this.#fsOptions(), expected: before, mode: modeToKeep(current.stats) })
    if (outcome.kind !== 'replaced') return saveConflict(outcome.kind)
    const indexed = indexedFromText(relPath, next, outcome.stats)
    const after = versionOf(bytes)
    const meta = indexed.doc.meta
    this.#cache.record(root.real, relPath, indexed)
    const nextBinding: Binding = {
      libraryDir: binding.libraryDir,
      relPath,
      id: meta.id,
      title: meta.title,
      sha256: after.sha256,
      size: after.size,
      savedBody: text,
    }
    return { kind: 'saved', created: false, entry: meta, binding: nextBinding }
  }

  // ───────────── 改标题、标签、收藏 ─────────────

  async updateMeta(params: MetaParams): Promise<MetaResult> {
    const relPath = promptRelPath(isObject(params) ? params.relPath : undefined, this.#platform)
    if (relPath === null) throw new PromptxError('promptx/library/invalid-path')
    const update = parseMetaUpdate(params)
    const configured = this.#options.getRoot()
    return await this.#mutate(configured, async () => {
      try {
        return await this.#updateMeta(configured, relPath, update.patch, update.addFrontMatter)
      } catch (error) {
        throw asPromptxError(error, 'promptx/library/write-failed')
      }
    })
  }

  async #updateMeta(configured: string, relPath: string, request: MetaRequest, add: boolean): Promise<MetaResult> {
    const root = this.#rootOrThrow(await this.#resolveRoot(configured))
    if (root === null) return metaConflict('missing')
    this.#assertNotSkipped(root, folderOf(relPath))
    const located = await locate(root.real, relPath)
    if (located.kind !== 'file') return metaConflict('missing')
    const file = await readRegularFile(located.abs, MAX_PROMPT_BYTES)
    if (file.kind === 'missing' || file.kind === 'not-file') return metaConflict('missing')
    // 不能打开的文件插件不改写（L-01）
    if (file.kind === 'too-large') throw new PromptxError('promptx/library/unreadable', 'too-large')
    const original = decodeUtf8(file.bytes)
    if (original === null) throw new PromptxError('promptx/library/unreadable', 'not-utf8')
    await assertWritable(located.abs)
    // 基于磁盘上的最新内容修改，不把对话框打开前读到的旧正文写回去（L-09）。before 就是这一版，
    // 小窗据此判断能不能把绑定的版本换成 after（design-spec 6.1，审查意见 S04）
    const before = versionOf(file.bytes)
    const parsed = parsePromptFile(original)
    const now = this.#now()
    const stamp = formatIsoUtc(now)
    let base = original
    let baseParsed = parsed
    let added = false
    let fields: FrontMatterFields
    let tagsLayout: TagsLayout
    if (parsed.frontMatter === null) {
      if (!add) return metaConflict('noFrontMatter')
      // 用户确认补上 front matter（L-09、L-10 按 L-08 的方式确认）。只收藏时 created、updated 用文件修改时间：
      // 收藏不算内容修改，条目在「最近」和排序里的位置不该因此变化
      const touchesContent = request.title !== undefined || request.tags !== undefined
      const time = touchesContent ? stamp : formatIsoUtc(new Date(file.stats.mtimeMs))
      const title = request.title ?? displayTitle(undefined, editorBody(parsed), relPath)
      base = addFrontMatter(original, { id: generatePromptId(now, this.#randomBytes(4)), title, created: time, updated: time })
      baseParsed = parsePromptFile(base)
      if (baseParsed.frontMatter?.state !== 'ok') return metaConflict('unsupportedLayout')
      added = true
      fields = baseParsed.frontMatter.fields
      tagsLayout = baseParsed.frontMatter.tagsLayout
    } else if (parsed.frontMatter.state !== 'ok') {
      return metaConflict('invalidFrontMatter')
    } else {
      fields = parsed.frontMatter.fields
      tagsLayout = parsed.frontMatter.tagsLayout
    }
    // 标签列表的写法认不出来时不改写，免得留下改了一半的 front matter（需求 6.2）
    if (request.tags !== undefined && tagsLayout === 'unsupported') return metaConflict('unsupportedLayout')
    const patch: FrontMatterPatch = {}
    if (request.title !== undefined && fields.title !== request.title) patch.title = request.title
    if (request.tags !== undefined && !sameTags(fields.tags ?? [], request.tags)) patch.tags = request.tags
    if (request.favorite !== undefined && (fields.favorite ?? false) !== request.favorite) patch.favorite = request.favorite
    // 改标题、标签同时更新 updated；收藏只改 favorite 这一行，不改 updated（L-09、L-10）
    if (patch.title !== undefined || patch.tags !== undefined) patch.updated = stamp
    if (!added && Object.keys(patch).length === 0) {
      // 什么都没变：不写文件，before 和 after 相同
      const { meta } = entryFromText(relPath, original, file.stats.mtimeMs)
      return { kind: 'saved', entry: meta, before, after: before }
    }
    const patched = patchFrontMatter(base, patch)
    if (!patched.ok) return metaConflict(patchConflict(patched.reason))
    const check = readBack(patched.text, { ...fields, ...patch }, baseParsed)
    // 正文一个字节都不能变
    if (check === null || check.body !== baseParsed.body) return metaConflict('unsupportedLayout')
    const bytes = Buffer.from(patched.text, 'utf8')
    // 补 front matter、加一行 favorite 都会让文件变大；贴着上限的文件改完就超过上限，之后插件再也打不开它（外部审查第 5 条）
    assertWritableSize(bytes)
    // 写入那一刻文件又变了：不写入，返回 modified（L-09「刷新后可以重新操作」）
    const outcome = await replaceFile(located.abs, bytes, { ...this.#fsOptions(), expected: before, mode: modeToKeep(file.stats) })
    if (outcome.kind !== 'replaced') return metaConflict(outcome.kind)
    const indexed = indexedFromText(relPath, patched.text, outcome.stats)
    this.#cache.record(root.real, relPath, indexed)
    return { kind: 'saved', entry: indexed.doc.meta, before, after: versionOf(bytes) }
  }

  // ───────────── 删除与回收站 ─────────────

  async delete(relPath: string): Promise<{ trashFile: string }> {
    const rel = promptRelPath(relPath, this.#platform)
    if (rel === null) throw new PromptxError('promptx/library/invalid-path')
    const configured = this.#options.getRoot()
    return await this.#mutate(configured, async () => {
      try {
        return await this.#delete(configured, rel)
      } catch (error) {
        throw asPromptxError(error, 'promptx/library/move-failed')
      }
    })
  }

  async #delete(configured: string, relPath: string): Promise<{ trashFile: string }> {
    const root = this.#rootOrThrow(await this.#resolveRoot(configured))
    if (root === null) throw new PromptxError('promptx/library/not-found')
    this.#assertNotSkipped(root, folderOf(relPath))
    const located = await locate(root.real, relPath)
    if (located.kind !== 'file') throw new PromptxError('promptx/library/not-found')
    const trashDir = await ensureTrashDir(root.real)
    const { name } = splitRelPath(relPath)
    // 删除 = 在修改队列里、持回收站记录锁，先把文件不覆盖地移进 `_trash/`，再原子写记录（design-spec 7.3）
    const trashFile = await this.#withRecordLock(trashDir, async () => {
      const record = await readTrashRecord(trashDir, this.#platform)
      // 读不出来的记录不改写：先改名留着，再写一份新的
      if (record.state === 'unreadable') await setAsideBrokenRecord(trashDir, this.#now(), this.#fsOptions())
      const moved = await moveNoClobber(located.abs, trashDir, trashNameCandidates(name), this.#fsOptions())
      if (moved === null) throw new PromptxError('promptx/library/move-failed', 'EEXIST: no free name in the trash')
      const movedAbs = join(trashDir, moved)
      let writingRecord = false
      try {
        const version = await hashFile(movedAbs)
        const item: TrashItem = {
          file: moved,
          originalPath: relPath,
          deletedAt: formatIsoUtc(this.#now()),
          sha256: version.sha256,
          size: version.size,
        }
        // 这个名字刚刚独占放进回收站，记录里同名的旧项只可能是陈旧的；留着会和新项重复，让这个文件变成「原位置未知」
        const kept = [...record.items.values()].filter(other => nameKey(other.file) !== nameKey(moved))
        writingRecord = true
        await this.#hooks.beforeRecordWrite?.()
        await writeTrashRecord(trashDir, [...kept, item], this.#fsOptions())
      } catch (error) {
        // 记录没写成（或者文件读不出来、算不了摘要）：把文件移回原处，库和回收站都回到删除前的样子。
        // 移不回去（原位置刚被占用）时文件留在回收站里，显示为「原位置未知」，仍然可以恢复，不会丢
        await moveNoClobber(movedAbs, dirname(located.abs), [name], this.#fsOptions()).catch(() => null)
        throw new PromptxError(writingRecord ? 'promptx/trash/record-failed' : 'promptx/library/move-failed', systemErrorDetail(error))
      }
      return moved
    })
    this.#cache.record(root.real, relPath, null)
    return { trashFile }
  }

  async trashList(query: string): Promise<TrashListResult> {
    try {
      const root = this.#rootOrThrow(await this.#resolveRoot(this.#options.getRoot()))
      if (root === null) return { recordState: 'missing', entries: [] }
      const trashDir = join(root.real, TRASH_DIR)
      if (!(await isRealDirectory(trashDir))) return { recordState: 'missing', entries: [] }
      const dirents = await readdir(trashDir, { withFileTypes: true })
      // 回收站记录写到一半崩溃留下的临时文件，和库里其他地方一样超过 1 小时就清理（design-spec 7.1）
      await removeStaleTemps(dirents.filter(d => d.isFile() && isPromptxTempName(d.name)).map(d => join(trashDir, d.name)), STALE_TEMP_MS)
      const names = dirents.filter(d => d.isFile() && isTrashFileName(d.name, this.#platform)).map(d => d.name)
      const record = await readTrashRecord(trashDir, this.#platform)
      const previous = this.#trashInfo.get(trashDir)
      const infos = await mapPool(names, READ_CONCURRENCY, name => this.#trashFileInfo(trashDir, name, previous))
      const current = new Map<string, TrashFileInfo>()
      const words = splitQuery(typeof query === 'string' ? query : '')
      const entries: TrashEntry[] = []
      names.forEach((name, index) => {
        const info = infos[index]
        if (info === undefined || info === null) return
        current.set(name, info)
        // 搜索规则和库列表一样：每个词都要在标题、标签或正文里出现（L-11「搜索框在回收站里同样可用」）
        const body = info.indexed.doc.searchBody ?? ''
        const matched = words.every(word =>
          info.searchTitle.includes(word) || info.searchTags.some(tag => tag.includes(word)) || body.includes(word))
        if (!matched) return
        const item = record.items.get(nameKey(name))
        entries.push({
          file: name,
          title: info.indexed.doc.meta.title,
          deletedAt: item === undefined ? null : Date.parse(item.deletedAt),
          originalPath: item?.originalPath ?? null,
        })
      })
      // 只留这次还在的文件，已经恢复或被移走的名字不再占内存
      this.#trashInfo.set(trashDir, current)
      entries.sort(compareTrashEntries)
      return { recordState: record.state, entries }
    } catch (error) {
      throw asPromptxError(error, 'promptx/library/unavailable')
    }
  }

  async #trashFileInfo(trashDir: string, name: string, previous: Map<string, TrashFileInfo> | undefined): Promise<TrashFileInfo | null> {
    const abs = join(trashDir, name)
    let stats: Stats
    try {
      stats = await lstat(abs)
    } catch {
      return null
    }
    if (!stats.isFile()) return null
    const cached = previous?.get(name)
    const reusable = cached?.indexed.cacheable === true && cached.indexed.mtimeMs === stats.mtimeMs && cached.indexed.size === stats.size
    if (cached !== undefined && reusable) return cached
    const indexed = await indexFile(abs, name, stats)
    if (indexed === null) return null
    return {
      indexed,
      searchTitle: normalizeSearchText(indexed.doc.meta.title),
      searchTags: indexed.doc.meta.tags.map(normalizeSearchText),
    }
  }

  async trashRead(file: string): Promise<{ entry: TrashEntry; body: string }> {
    if (!isTrashFileName(file, this.#platform)) throw new PromptxError('promptx/library/invalid-path')
    try {
      const root = this.#rootOrThrow(await this.#resolveRoot(this.#options.getRoot()))
      if (root === null) throw new PromptxError('promptx/trash/not-found')
      const trashDir = join(root.real, TRASH_DIR)
      if (!(await isRealDirectory(trashDir))) throw new PromptxError('promptx/trash/not-found')
      const read = await readRegularFile(join(trashDir, file), MAX_PROMPT_BYTES)
      if (read.kind === 'missing' || read.kind === 'not-file') throw new PromptxError('promptx/trash/not-found')
      if (read.kind === 'too-large') throw new PromptxError('promptx/library/unreadable', 'too-large')
      const text = decodeUtf8(read.bytes)
      if (text === null) throw new PromptxError('promptx/library/unreadable', 'not-utf8')
      const { meta, body } = entryFromText(file, text, read.stats.mtimeMs)
      const item = (await readTrashRecord(trashDir, this.#platform)).items.get(nameKey(file))
      const entry: TrashEntry = {
        file,
        title: meta.title,
        deletedAt: item === undefined ? null : Date.parse(item.deletedAt),
        originalPath: item?.originalPath ?? null,
      }
      return { entry, body }
    } catch (error) {
      throw asPromptxError(error, 'promptx/library/unreadable', 'read-failed')
    }
  }

  async trashRestore(params: RestoreParams): Promise<RestoreResult> {
    const request = parseRestoreRequest(params)
    const file = request.file
    if (!isTrashFileName(file, this.#platform)) throw new PromptxError('promptx/library/invalid-path')
    let chosen: string | null = null
    // 用户在「原路径已被占用」对话框里确认的替代路径；没带路径时按原位置处理，占用时再给一个替代路径
    if (request.target === 'alternative' && request.alternative !== null) {
      chosen = promptRelPath(request.alternative, this.#platform)
      if (chosen === null) throw new PromptxError('promptx/library/invalid-path')
    }
    const configured = this.#options.getRoot()
    return await this.#mutate(configured, async () => {
      try {
        return await this.#restore(configured, file, chosen, request.acceptModified)
      } catch (error) {
        throw asPromptxError(error, 'promptx/library/move-failed')
      }
    })
  }

  /** chosen 为 null 时恢复到原位置；否则是用户确认的替代路径。 */
  async #restore(configured: string, file: string, chosen: string | null, acceptModified: boolean): Promise<RestoreResult> {
    const root = this.#rootOrThrow(await this.#resolveRoot(configured))
    if (root === null) return { kind: 'missing' }
    const trashDir = join(root.real, TRASH_DIR)
    if (!(await isRealDirectory(trashDir))) return { kind: 'missing' }
    return await this.#withRecordLock(trashDir, async (): Promise<RestoreResult> => {
      const trashAbs = join(trashDir, file)
      // 回收站里的文件已被外部删除：小窗提示并刷新回收站列表（L-11）
      if (!(await isRegularFileAt(trashAbs))) return { kind: 'missing' }
      const record = await readTrashRecord(trashDir, this.#platform)
      const key = nameKey(file)
      const item = record.items.get(key)
      // 文件在回收站里被改过：先提示，用户确认后带 acceptModified 重发仍可恢复（需求 6.4）
      if (item !== undefined && !acceptModified && !sameVersion(await hashFile(trashAbs), item)) return { kind: 'modified' }
      // 没有记录（原位置未知）的文件恢复到库根目录（L-11）；记录里的原位置落在扫描跳过的目录里时同样处理
      const original = item !== undefined && !this.#insideSkipped(root, folderOf(item.originalPath)) ? item.originalPath : file
      const destination = chosen ?? original
      this.#assertNotSkipped(root, folderOf(destination))
      // 原位置（或用户确认的替代路径）已被占用：不覆盖，给出新的替代路径（L-11）
      if (await this.#isOccupied(root.real, destination)) return { kind: 'occupied', alternative: await this.#alternativeFor(root, original) }
      const { folder, name } = splitRelPath(destination)
      // 缺少的文件夹重新建立
      await ensureFolder(root.real, folder)
      const moved = await moveNoClobber(trashAbs, folderAbs(root.real, folder), [name], this.#fsOptions())
      // 核对之后、移动之前目标位置刚好被占用：link 不会覆盖它，按占用处理
      if (moved === null) return { kind: 'occupied', alternative: await this.#alternativeFor(root, original) }
      if (record.state === 'ok' && record.mentioned.has(key)) {
        const rest = [...record.items.values()].filter(other => nameKey(other.file) !== key)
        // 恢复已经完成。记录没改成时残留的项指向不存在的文件，读记录时按陈旧项跳过，下次写记录时清掉
        await writeTrashRecord(trashDir, rest, this.#fsOptions()).catch(() => undefined)
      }
      this.#cache.record(root.real, destination, await this.#indexRel(root.real, destination))
      return { kind: 'restored', relPath: destination }
    })
  }

  /** 目标位置是否被占用：已有文件或目录，或者同一文件夹里有只差大小写的名字。 */
  async #isOccupied(rootReal: string, relPath: string): Promise<boolean> {
    const located = await locate(rootReal, relPath)
    if (located.kind !== 'missing') return true
    const { folder, name } = splitRelPath(relPath)
    return (await nameKeysOf(folderAbs(rootReal, folder))).has(nameKey(name))
  }

  /** 替代路径：原文件名后加 `-2`、`-3`……，在原来的文件夹里取第一个空着的（L-11）。 */
  async #alternativeFor(root: OkRoot, original: string): Promise<string> {
    const { folder, name } = splitRelPath(original)
    let attempts = 0
    for (const candidate of numberedNames(name)) {
      if (++attempts > MAX_ALTERNATIVES) break
      const relPath = folder === '' ? candidate : `${folder}/${candidate}`
      if (!(await this.#isOccupied(root.real, relPath))) return relPath
    }
    throw new PromptxError('promptx/library/move-failed', 'EEXIST: no free alternative name')
  }

  /**
   * 持回收站记录的跨进程锁执行（默认库目录被所有 profile 共用，D24）。锁没拿到时什么都还没动。
   * 锁文件在 lockDir 里、按回收站目录的 realpath 命名，不在库里（审查 SEC-03，见 recordLockTarget）；
   * 库里残留的旧锁 `_trash/.promptx-trash.json.lock` 不再读、不再删，原样留给用户。
   */
  async #withRecordLock<T>(trashDir: string, operation: () => Promise<T>): Promise<T> {
    const progress = { started: false }
    try {
      const lockDir = this.#options.lockDir
      await mkdir(lockDir, { recursive: true })
      const target = recordLockTarget(lockDir, await realpath(trashDir))
      return await withFileLock(target, async () => {
        progress.started = true
        return await operation()
      }, { waitMs: this.#recordLockWaitMs })
    } catch (error) {
      if (!progress.started) throw new PromptxError('promptx/trash/record-failed', errnoCode(error) === undefined ? 'lock-timeout' : systemErrorDetail(error))
      throw error
    }
  }

  reset(): void {
    this.#cache.reset()
    this.#trashInfo.clear()
  }

  // ───────────── 库目录 ─────────────

  /** 检查位置限制（design-spec 7.4）、realpath 一次。库根目录本身可以是符号链接。 */
  async #resolveRoot(configured: string): Promise<RootState> {
    // 相对路径会落到 dsh 进程的当前目录上，绝不扫描、写入那里
    if (!isAbsolute(configured)) return unavailableRoot(configured, 'library-dir-relative')
    const checkRoot = this.#options.checkRoot
    if (checkRoot !== undefined) {
      let problem: ErrorInfo | null
      try {
        problem = await checkRoot(configured)
      } catch (error) {
        problem = unavailableInfo(error)
      }
      if (problem !== null) return { kind: 'unavailable', configured, error: problem }
    }
    let real: string
    try {
      real = await realpath(resolve(configured))
    } catch (error) {
      if (errnoCode(error) === 'ENOENT') return { kind: 'missing', configured }
      return { kind: 'unavailable', configured, error: unavailableInfo(error) }
    }
    try {
      if (!(await stat(real)).isDirectory()) return unavailableRoot(configured, 'ENOTDIR: not a directory')
    } catch (error) {
      return { kind: 'unavailable', configured, error: unavailableInfo(error) }
    }
    let skipList: readonly string[]
    try {
      skipList = this.#options.skipRealpaths?.() ?? []
    } catch (error) {
      return { kind: 'unavailable', configured, error: unavailableInfo(error) }
    }
    const skip = new Set(skipList.map(path => foldPath(path, this.#platform)))
    // 位置检查之外再兜一层（审查意见 S13）：经过符号链接，库根目录本身可能就是 dsh 数据目录、技能目录或 `<dsh>/promptx`，
    // 扫描只会跳过这些目录的子目录，所以根目录正好是它们时整个库按不可用处理
    if (skip.has(foldPath(real, this.#platform))) return unavailableRoot(configured, 'library-dir-reserved')
    return { kind: 'ok', configured, real, skipList, skip }
  }

  /** 库目录不可用时抛 promptx/library/unavailable；不存在时返回 null。 */
  #rootOrThrow(state: RootState): OkRoot | null {
    if (state.kind === 'unavailable') throw new PromptxError('promptx/library/unavailable', unavailableDetail(state.error))
    return state.kind === 'ok' ? state : null
  }

  /**
   * 文件夹（库内相对路径，空串是库根目录）有没有落进扫描跳过的目录。locate 已经保证路径上没有符号链接，
   * 所以 `库根目录 realpath + 各段` 就是每一级的真实路径，直接和跳过名单比较。
   */
  #insideSkipped(root: OkRoot, folder: string): boolean {
    if (root.skip.size === 0 || folder === '') return false
    let abs = root.real
    for (const segment of folder.split('/')) {
      abs = join(abs, segment)
      if (root.skip.has(foldPath(abs, this.#platform))) return true
    }
    return false
  }

  /** 列表里看不到的目录也不让读写：否则伪造的路径能改动 dsh 自己的技能文件（需求 7.10）。 */
  #assertNotSkipped(root: OkRoot, folder: string): void {
    if (this.#insideSkipped(root, folder)) throw new PromptxError('promptx/library/invalid-path')
  }

  #mutate<T>(configured: string, operation: () => Promise<T>): Promise<T> {
    return this.#queue.run(resolve(configured), operation)
  }

  async #indexRel(rootReal: string, relPath: string): Promise<IndexedFile | null> {
    try {
      const located = await locate(rootReal, relPath)
      if (located.kind !== 'file') return null
      return await indexFile(located.abs, relPath, located.stats)
    } catch {
      return null
    }
  }

  #remember(key: string | null, result: SaveResult): void {
    if (key === null) return
    this.#created.set(key, result)
    for (const oldest of this.#created.keys()) {
      if (this.#created.size <= REMEMBERED_REQUESTS) break
      this.#created.delete(oldest)
    }
  }

  #now(): Date {
    return this.#options.now?.() ?? new Date()
  }

  #randomBytes(size: number): Uint8Array {
    return (this.#options.randomBytes ?? cryptoRandomBytes)(size)
  }

  #fsOptions(): FsOptions {
    const options: FsOptions = { hooks: this.#hooks, platform: this.#platform }
    if (this.#ops !== undefined) options.ops = this.#ops
    return options
  }
}
