// 库扫描与索引（需求 L-01、L-03、N-01，design-spec 7.2）。
// 索引按「相对路径 + 修改时间 + 大小」缓存每个文件的解析结果和规范化后的正文：
// 再次展开侧栏只重读变了的文件，搜索输入时只剩字符串查找。

import type { Dirent, Stats } from 'node:fs'
import { lstat, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { displayTitle, folderOf, isMarkdownFileName, parseTimestamp } from '../shared/library-rules.ts'
import { editorBody, parsePromptFile } from '../shared/frontmatter.ts'
import type { ParsedPromptFile } from '../shared/frontmatter.ts'
import { normalizeSearchText } from '../shared/search.ts'
import type { SearchDoc } from '../shared/search.ts'
import type { EntryMeta } from '../shared/types.ts'
import { MAX_PROMPT_BYTES, isPromptxTempName, readRegularFile, removeStaleTemps } from './fs-safe.ts'
import type { FileRead } from './fs-safe.ts'
import { isTrashName } from './rel-path.ts'

/** 同时读多少个文件。libuv 线程池默认只有 4 个线程，再多只是排队，32 足够让磁盘一直有活干。 */
export const READ_CONCURRENCY = 32

/** 崩溃留下的临时文件多久之后清理（design-spec 7.1）。 */
export const STALE_TEMP_MS = 60 * 60 * 1000

export interface IndexedFile {
  doc: SearchDoc
  mtimeMs: number
  size: number
  /** 读取失败（权限等）的结果不缓存：修好权限不会改变修改时间和大小，下次扫描要重读。 */
  cacheable: boolean
}

export interface ScanResult {
  files: Map<string, IndexedFile>
  /** 所有子文件夹（含空文件夹）的相对路径。 */
  folders: Set<string>
}

export interface ScanOptions {
  rootReal: string
  /** 上一次的索引，按修改时间和大小复用。 */
  previous: ReadonlyMap<string, IndexedFile> | undefined
  /** 要跳过的目录（realpath）：dsh 数据目录、技能目录、`<dsh>/promptx`（design-spec 7.4）。 */
  skipRealpaths: readonly string[]
  platform?: NodeJS.Platform
}

// ───────────────────────────── 单个文件 ─────────────────────────────

const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

/**
 * 严格按 UTF-8 解码，失败返回 null。ignoreBOM: true 让 BOM 留在结果里：
 * parsePromptFile 要靠它记下文件有没有 BOM，写回时原样保留（需求 6.2）。
 */
export function decodeUtf8(bytes: Uint8Array): string | null {
  try {
    return decoder.decode(bytes)
  } catch {
    return null
  }
}

function blankToNull(value: string | undefined): string | null {
  return value === undefined || value.trim() === '' ? null : value
}

export interface ParsedEntry {
  meta: EntryMeta
  /** 正文，换行已统一成 LF。 */
  body: string
  parsed: ParsedPromptFile
}

/**
 * 由文件全文得到列表元数据（L-01）。front matter 写坏了按没有 front matter 显示（标题取自正文），
 * 状态标 invalid-meta；更新时间取 `updated`，解析不了时用文件修改时间。
 */
export function entryFromText(relPath: string, text: string, mtimeMs: number): ParsedEntry {
  const parsed = parsePromptFile(text)
  const body = editorBody(parsed)
  const frontMatter = parsed.frontMatter
  const fields = frontMatter?.state === 'ok' ? frontMatter.fields : {}
  const updated = fields.updated === undefined ? null : parseTimestamp(fields.updated)
  const meta: EntryMeta = {
    relPath,
    folder: folderOf(relPath),
    id: blankToNull(fields.id),
    title: displayTitle(fields.title, body, relPath),
    tags: fields.tags ?? [],
    favorite: fields.favorite ?? false,
    updatedAt: updated ?? mtimeMs,
    createdAt: fields.created === undefined ? null : parseTimestamp(fields.created),
    status: frontMatter?.state === 'invalid' ? 'invalid-meta' : 'ok',
    hasFrontMatter: frontMatter !== null,
  }
  return { meta, body, parsed }
}

export function indexedFromText(relPath: string, text: string, stats: Pick<Stats, 'mtimeMs' | 'size'>): IndexedFile {
  const { meta, body } = entryFromText(relPath, text, stats.mtimeMs)
  return { doc: { meta, body, searchBody: normalizeSearchText(body) }, mtimeMs: stats.mtimeMs, size: stats.size, cacheable: true }
}

type UnreadableReason = NonNullable<EntryMeta['unreadableReason']>

/** 不能打开的文件（L-01：大于 2 MiB、不是 UTF-8、读取失败）：列表里显示文件名，不能打开、插入、复制。 */
export function unreadableEntry(relPath: string, stats: Pick<Stats, 'mtimeMs' | 'size'>, reason: UnreadableReason): IndexedFile {
  const meta: EntryMeta = {
    relPath,
    folder: folderOf(relPath),
    id: null,
    title: displayTitle(null, '', relPath),
    tags: [],
    favorite: false,
    updatedAt: stats.mtimeMs,
    createdAt: null,
    status: 'unreadable',
    unreadableReason: reason,
    hasFrontMatter: false,
  }
  return { doc: { meta, body: '', searchBody: '' }, mtimeMs: stats.mtimeMs, size: stats.size, cacheable: reason !== 'read-failed' }
}

/** 读一个文件并建索引项。文件不在了或不是普通文件时返回 null。 */
export async function indexFile(abs: string, relPath: string, stats: Pick<Stats, 'mtimeMs' | 'size'>): Promise<IndexedFile | null> {
  // 超过上限的文件不读（design-spec 7.2）
  if (stats.size > MAX_PROMPT_BYTES) return unreadableEntry(relPath, stats, 'too-large')
  let read: FileRead
  try {
    read = await readRegularFile(abs, MAX_PROMPT_BYTES)
  } catch {
    return unreadableEntry(relPath, stats, 'read-failed')
  }
  switch (read.kind) {
    case 'missing':
    case 'not-file':
      return null
    case 'too-large':
      return unreadableEntry(relPath, read.stats, 'too-large')
    case 'ok': {
      const text = decodeUtf8(read.bytes)
      if (text === null) return unreadableEntry(relPath, read.stats, 'not-utf8')
      // 缓存键用读取时 fstat 的结果，和读到的字节对应
      return indexedFromText(relPath, text, read.stats)
    }
  }
}

/** lstat 后再建索引；缓存里有同样修改时间和大小的结果时直接复用。 */
export async function indexPath(
  abs: string,
  relPath: string,
  previous: ReadonlyMap<string, IndexedFile> | undefined,
): Promise<IndexedFile | null> {
  let stats: Stats
  try {
    stats = await lstat(abs)
  } catch {
    // 读目录之后被删掉或移走了
    return null
  }
  if (!stats.isFile()) return null
  const cached = previous?.get(relPath)
  if (cached !== undefined && cached.cacheable && cached.mtimeMs === stats.mtimeMs && cached.size === stats.size) return cached
  return await indexFile(abs, relPath, stats)
}

// ───────────────────────────── 扫描 ─────────────────────────────

/** 并发执行，最多 limit 个同时进行；结果按输入顺序返回。 */
export async function mapPool<T, R>(items: readonly T[], limit: number, task: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = []
  let next = 0
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next++
      if (index >= items.length) return
      results[index] = await task(items[index] as T)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

/** 比较路径用：macOS、Windows 默认不区分大小写，统一 Unicode 组合形式后转小写。 */
export function foldPath(path: string, platform: NodeJS.Platform): string {
  const normalized = resolve(path)
  return platform === 'darwin' || platform === 'win32' ? normalized.normalize('NFC').toLowerCase() : normalized
}

interface DirTask {
  abs: string
  rel: string
}

interface FileTask {
  abs: string
  rel: string
}

/**
 * 递归扫描库目录（L-01、design-spec 7.2）：只认扩展名为 `.md`（不区分大小写）的普通文件。
 * 跳过名字以 `.` 开头的文件和目录、库根目录下的 `_trash/`、符号链接、其他特殊文件，以及 realpath 在跳过名单里的目录。
 * 根目录读不出来时抛错（调用方报「库目录不可用」）；子目录读不出来只跳过那一个。顺带清理超过 1 小时的临时文件。
 */
export async function scanLibrary(options: ScanOptions): Promise<ScanResult> {
  const platform = options.platform ?? process.platform
  const skip = new Set(options.skipRealpaths.map(path => foldPath(path, platform)))
  const folders = new Set<string>()
  const fileTasks: FileTask[] = []
  const staleTemps: string[] = []
  const stack: DirTask[] = [{ abs: options.rootReal, rel: '' }]
  for (let dir = stack.pop(); dir !== undefined; dir = stack.pop()) {
    let dirents: Dirent[]
    try {
      dirents = await readdir(dir.abs, { withFileTypes: true })
    } catch (error) {
      if (dir.rel === '') throw error
      continue
    }
    for (const dirent of dirents) {
      const name = dirent.name
      const abs = join(dir.abs, name)
      const rel = dir.rel === '' ? name : `${dir.rel}/${name}`
      if (name.startsWith('.')) {
        if (dirent.isFile() && isPromptxTempName(name)) staleTemps.push(abs)
        continue
      }
      // 不跟随符号链接：链接可能指向库目录之外，也可能绕回来造成循环
      if (dirent.isSymbolicLink()) continue
      if (dirent.isDirectory()) {
        if (dir.rel === '' && isTrashName(name, platform)) continue
        if (skip.has(foldPath(abs, platform))) continue
        folders.add(rel)
        stack.push({ abs, rel })
        continue
      }
      if (dirent.isFile() && isMarkdownFileName(name)) fileTasks.push({ abs, rel })
    }
  }
  await removeStaleTemps(staleTemps, STALE_TEMP_MS)
  const indexed = await mapPool(fileTasks, READ_CONCURRENCY, task => indexPath(task.abs, task.rel, options.previous))
  const files = new Map<string, IndexedFile>()
  fileTasks.forEach((task, index) => {
    const entry = indexed[index]
    if (entry !== undefined && entry !== null) files.set(task.rel, entry)
  })
  return { files, folders }
}

/** 把相对路径的所有上级文件夹加进集合（新建、恢复的文件可能带出新文件夹）。 */
export function addAncestorFolders(folders: Set<string>, relPath: string): void {
  let folder = folderOf(relPath)
  while (folder !== '') {
    folders.add(folder)
    folder = folderOf(folder)
  }
}

let folderCollator: Intl.Collator | undefined

/**
 * 文件夹排序（design-spec 7.2：按名称、数字感知）。逐段比较，父文件夹总在子文件夹前面，
 * 同一层按名称排：直接比较整条路径时 `写作/评审` 和 `写作素材` 的先后取决于 `/` 的排序规则，树会被打乱。
 */
export function compareFolderPaths(a: string, b: string): number {
  folderCollator ??= new Intl.Collator(undefined, { numeric: true })
  const left = a.split('/')
  const right = b.split('/')
  const length = Math.min(left.length, right.length)
  for (let i = 0; i < length; i++) {
    const order = folderCollator.compare(left[i] ?? '', right[i] ?? '')
    if (order !== 0) return order
  }
  if (left.length !== right.length) return left.length - right.length
  return a < b ? -1 : a > b ? 1 : 0
}
