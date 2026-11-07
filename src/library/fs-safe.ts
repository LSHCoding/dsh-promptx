// 库目录里的底层文件操作（design-spec 7.1、7.3、9，审查意见 S02、S15）。写库目录的代码都经过这里：
// - 相对路径逐级 lstat，路径上出现符号链接就拒绝，写入不会经过链接落到库目录之外；
// - 改写已有文件：同目录临时文件 + fsync → 替换前再核对一次版本 → rename → fsync 目录，读者只会看到旧内容或新内容；
// - 新建文件和回收站的移动用 link 实现「不覆盖」：rename 会静默覆盖已存在的目标（D24）。
// 错误说明只留错误码和系统描述，去掉 Node 附带的路径：文件名由标题生成，属于用户内容（N-02）。

import { createHash, randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import type { Stats } from 'node:fs'
import { copyFile, link, lstat, mkdir, open, readdir, rename, rm, unlink } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { PromptxError } from '../shared/errors.ts'
import type { FileVersion } from '../shared/types.ts'

/** 单个 Prompt 文件的上限（需求 6.2）。 */
export const MAX_PROMPT_BYTES = 2 * 1024 * 1024

// 读文件时最后一段不跟随符号链接：lstat 核对之后文件被换成链接，open 会失败而不是读到库外的内容。
// O_NONBLOCK 防止同样的竞争把文件换成命名管道时 open 一直卡住；对普通文件没有影响。Windows 没有这两个标志。
const READ_FLAGS = process.platform === 'win32'
  ? constants.O_RDONLY
  : constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK

/** 可替换的底层操作。只有测试会替换：模拟不支持硬链接的文件系统、Windows 上被占用的文件。 */
export interface FsOps {
  link: (existingPath: string, newPath: string) => Promise<void>
  rename: (oldPath: string, newPath: string) => Promise<void>
  copyFile: (src: string, dest: string, mode: number) => Promise<void>
}

const REAL_OPS: FsOps = { link, rename, copyFile }

/** 测试用的插入点：在竞争窗口里模拟外部程序的写入。 */
export interface FsHooks {
  /** 新内容已经写进临时文件、替换前最后一次核对版本之前。 */
  beforeVerify?: (target: string) => Promise<void>
  /** 不覆盖的新建或移动在 link（或复制）到目标之前。 */
  beforeLink?: (target: string) => Promise<void>
}

export interface FsOptions {
  ops?: Partial<FsOps>
  hooks?: FsHooks
  platform?: NodeJS.Platform
}

function opsOf(options: FsOptions): FsOps {
  return { ...REAL_OPS, ...options.ops }
}

// ───────────────────────────── 错误 ─────────────────────────────

export function errnoCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined
  return typeof error.code === 'string' ? error.code : undefined
}

/**
 * 系统错误的说明，例如 `EACCES: permission denied`。Node 的原始信息形如
 * `EACCES: permission denied, open '/库/代码审查清单.md'`，后半截的路径含由标题生成的文件名，必须去掉。
 * 不是系统错误时只给错误码或 unknown，不把任意异常信息带出去。
 */
export function systemErrorDetail(error: unknown): string {
  const message = error instanceof Error ? error.message : ''
  const match = /^([A-Z][A-Z0-9_]*): ([^,\n]*)/.exec(message)
  if (match !== null) return `${match[1] ?? ''}: ${(match[2] ?? '').trim()}`
  return errnoCode(error) ?? 'unknown'
}

// ───────────────────────────── 版本与名字 ─────────────────────────────

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

export function versionOf(bytes: Uint8Array): FileVersion {
  return { sha256: sha256Hex(bytes), size: bytes.length }
}

export function sameVersion(a: FileVersion, b: FileVersion): boolean {
  return a.sha256 === b.sha256 && a.size === b.size
}

/**
 * 比较文件名用的键：统一 Unicode 组合形式再转小写。macOS、Windows 默认的文件系统不区分大小写，
 * Linux 上也不让插件建出只差大小写的两个文件，否则库目录同步到 macOS 时会撞名（design-spec 7.1）。
 */
export function nameKey(name: string): string {
  return name.normalize('NFC').toLowerCase()
}

// Windows 把这些名字当成设备，不分大小写，后面带什么扩展名都一样（`CON.md`、`nul.tar.md`），名字和第一个点之间的空格也忽略。
// 往 `CON.md` 写会写到控制台，读它会一直等控制台输入，所以 Windows 上这类名字既不新建，也不接受小窗传来的路径。
const WINDOWS_DEVICE_NAME = /^(?:con|prn|aux|nul|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³])$/i

export function isWindowsDeviceName(name: string): boolean {
  return WINDOWS_DEVICE_NAME.test((name.split('.', 1)[0] ?? '').replace(/ +$/, ''))
}

// 临时文件名 = `.` + 原文件名 + `.promptx-` + 12 位十六进制 + `.tmp`。文件名上限 255 字节，
// 原文件名本身可能已经接近上限，所以临时文件名里的原名按字节截短，只用来认出是哪个文件留下的。
const TEMP_BASE_MAX_BYTES = 180
const TEMP_NAME = /^\..+\.promptx-[0-9a-f]{12}\.tmp$/

function truncateUtf8(text: string, maxBytes: number): string {
  let bytes = 0
  let out = ''
  for (const ch of text) {
    const size = Buffer.byteLength(ch, 'utf8')
    if (bytes + size > maxBytes) break
    out += ch
    bytes += size
  }
  return out
}

export function tempNameFor(fileName: string): string {
  return `.${truncateUtf8(fileName, TEMP_BASE_MAX_BYTES)}.promptx-${randomBytes(6).toString('hex')}.tmp`
}

/** 插件自己的临时文件（崩溃时可能留下）。扫描时清理超过 1 小时的（design-spec 7.1）。 */
export function isPromptxTempName(name: string): boolean {
  return TEMP_NAME.test(name)
}

/** 删除给定的临时文件里超过 maxAgeMs 的。只是清理，失败不影响调用方。 */
export async function removeStaleTemps(paths: readonly string[], maxAgeMs: number, nowMs: number = Date.now()): Promise<void> {
  for (const path of paths) {
    try {
      const stats = await lstat(path)
      if (stats.isFile() && nowMs - stats.mtimeMs > maxAgeMs) await rm(path, { force: true })
    } catch {
      // 别的进程刚好删掉了，或者没有权限：留给下一次扫描
    }
  }
}

// ───────────────────────────── 路径 ─────────────────────────────

export type Location =
  | { kind: 'file'; abs: string; stats: Stats }
  | { kind: 'missing'; abs: string }
  | { kind: 'other'; abs: string }

/**
 * 解析库内相对路径（调用方已经规范化，用 `/` 分隔）。逐级 lstat：路径上任何一段是符号链接都抛
 * promptx/library/invalid-path（库根目录之下一律不跟随链接，design-spec 6.1）；某一级不存在或不是目录时返回 missing。
 */
export async function locate(rootReal: string, relPath: string): Promise<Location> {
  const segments = relPath.split('/')
  const target = join(rootReal, ...segments)
  let abs = rootReal
  for (const [index, segment] of segments.entries()) {
    abs = join(abs, segment)
    let stats: Stats
    try {
      stats = await lstat(abs)
    } catch (error) {
      const code = errnoCode(error)
      if (code === 'ENOENT' || code === 'ENOTDIR') return { kind: 'missing', abs: target }
      throw error
    }
    if (stats.isSymbolicLink()) throw new PromptxError('promptx/library/invalid-path')
    if (index === segments.length - 1) return stats.isFile() ? { kind: 'file', abs, stats } : { kind: 'other', abs }
    if (!stats.isDirectory()) return { kind: 'missing', abs: target }
  }
  return { kind: 'missing', abs: target }
}

/** 库内文件夹的绝对路径；空串是库根目录。 */
export function folderAbs(rootReal: string, folder: string): string {
  return folder === '' ? rootReal : join(rootReal, ...folder.split('/'))
}

/**
 * 确保库内文件夹存在，缺少的逐级建立。已经存在的每一级都必须是真正的目录：
 * 是符号链接或文件时抛 promptx/library/invalid-path，不经过链接在库外建目录。
 */
export async function ensureFolder(rootReal: string, folder: string): Promise<void> {
  if (folder === '') return
  let abs = rootReal
  for (const segment of folder.split('/')) {
    abs = join(abs, segment)
    let stats: Stats | null = null
    try {
      stats = await lstat(abs)
    } catch (error) {
      if (errnoCode(error) !== 'ENOENT') throw error
    }
    if (stats === null) {
      try {
        await mkdir(abs)
      } catch (error) {
        // 另一个进程同时建了同一个目录
        if (errnoCode(error) !== 'EEXIST') throw error
      }
      stats = await lstat(abs)
    }
    if (stats.isSymbolicLink() || !stats.isDirectory()) throw new PromptxError('promptx/library/invalid-path')
  }
}

/** 目录里已有名字的比较键；目录不存在时为空集。 */
export async function nameKeysOf(dir: string): Promise<Set<string>> {
  try {
    return new Set((await readdir(dir)).map(nameKey))
  } catch (error) {
    if (errnoCode(error) === 'ENOENT') return new Set()
    throw error
  }
}

// ───────────────────────────── 读 ─────────────────────────────

export type FileRead =
  | { kind: 'ok'; bytes: Buffer; stats: Stats }
  | { kind: 'missing' }
  | { kind: 'too-large'; stats: Stats }
  | { kind: 'not-file' }

/** 读一个普通文件的全部字节；超过 maxBytes 时不读，返回 too-large。 */
export async function readRegularFile(abs: string, maxBytes: number): Promise<FileRead> {
  let handle: FileHandle
  try {
    handle = await open(abs, READ_FLAGS)
  } catch (error) {
    const code = errnoCode(error)
    if (code === 'ENOENT' || code === 'ENOTDIR') return { kind: 'missing' }
    // O_NOFOLLOW 遇到符号链接报 ELOOP（BSD 上是 EMLINK）
    if (code === 'ELOOP' || code === 'EMLINK') return { kind: 'not-file' }
    throw error
  }
  try {
    const stats = await handle.stat()
    if (!stats.isFile()) return { kind: 'not-file' }
    if (stats.size > maxBytes) return { kind: 'too-large', stats }
    const bytes = await handle.readFile()
    // stat 之后文件又被写大了
    if (bytes.length > maxBytes) return { kind: 'too-large', stats }
    return { kind: 'ok', bytes, stats }
  } finally {
    await handle.close()
  }
}

/** 流式计算文件的版本，不把整个文件读进内存（回收站里的文件可能很大）。 */
export async function hashFile(abs: string): Promise<FileVersion> {
  const handle = await open(abs, READ_FLAGS)
  try {
    const hash = createHash('sha256')
    const buffer = Buffer.allocUnsafe(64 * 1024)
    let size = 0
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null)
      if (bytesRead === 0) break
      hash.update(buffer.subarray(0, bytesRead))
      size += bytesRead
    }
    return { sha256: hash.digest('hex'), size }
  } finally {
    await handle.close()
  }
}

type VersionCheck = 'match' | 'modified' | 'missing'

async function checkVersion(target: string, expected: FileVersion): Promise<VersionCheck> {
  let stats: Stats
  try {
    stats = await lstat(target)
  } catch (error) {
    if (errnoCode(error) === 'ENOENT') return 'missing'
    throw error
  }
  // 原文件被换成了符号链接或目录：同样算被外部改过，不覆盖
  if (!stats.isFile()) return 'modified'
  if (stats.size !== expected.size) return 'modified'
  const read = await readRegularFile(target, expected.size)
  if (read.kind === 'missing') return 'missing'
  if (read.kind !== 'ok') return 'modified'
  return sha256Hex(read.bytes) === expected.sha256 ? 'match' : 'modified'
}

// ───────────────────────────── 写 ─────────────────────────────

/**
 * 独占创建文件并写入、fsync，返回写完后这个 inode 的 stat。mode 为 undefined 时用 0o666 去掉 umask（新文件的默认权限）。
 * 这个 inode 之后经 rename 或 link 成为目标文件，修改时间和大小都不再变，索引直接拿它做缓存键：
 * 替换之后再去 lstat 目标，那一刻外部程序可能刚换掉文件，缓存就会把我们的内容记在别人的版本下；
 * lstat 本身失败时，已经写成功的保存还会被报成失败。
 */
async function writeNewFile(path: string, data: Uint8Array, mode: number | undefined): Promise<Stats> {
  const handle = await open(path, 'wx', mode ?? 0o666)
  try {
    // open 的 mode 会被 umask 过滤；原文件是 0o666 这类宽权限时要再 chmod 一次才能和原来一致（审查意见 S15）
    if (mode !== undefined && process.platform !== 'win32') await handle.chmod(mode)
    await handle.writeFile(data)
    await handle.sync()
    return await handle.stat()
  } finally {
    await handle.close()
  }
}

/** fsync 复制出来的文件，返回它的 stat（用途同 writeNewFile 的返回值）。 */
async function syncFile(path: string): Promise<Stats> {
  // Windows 上 FlushFileBuffers 要求可写的句柄，所以用 r+ 打开
  const handle = await open(path, 'r+')
  try {
    await handle.sync()
    return await handle.stat()
  } finally {
    await handle.close()
  }
}

/** 持久化目录项的变化。只是加固：Windows 不能这样打开目录，有些网络盘、FUSE 不支持，失败都不影响结果。 */
export async function fsyncDir(dir: string): Promise<void> {
  if (process.platform === 'win32') return
  try {
    const handle = await open(dir, 'r')
    try {
      await handle.sync()
    } finally {
      await handle.close()
    }
  } catch {
    // 见上
  }
}

const WINDOWS_TRANSIENT = new Set(['EPERM', 'EBUSY', 'EACCES'])
const RENAME_RETRY_BUDGET_MS = 1000

/**
 * rename 覆盖目标。Windows 上杀毒软件、索引服务、同步客户端会短暂占住文件，替换时报 EPERM、EBUSY、EACCES，
 * 稍等重试通常就能成功；总共最多等约 1 秒（与 dsh-atomic-write 的 writeFileAtomic 做法一致）。
 */
export async function renameWithRetry(from: string, to: string, options: FsOptions & { budgetMs?: number } = {}): Promise<void> {
  const ops = opsOf(options)
  const platform = options.platform ?? process.platform
  const deadline = Date.now() + (options.budgetMs ?? RENAME_RETRY_BUDGET_MS)
  let wait = 20
  for (;;) {
    try {
      await ops.rename(from, to)
      return
    } catch (error) {
      if (platform !== 'win32' || !WINDOWS_TRANSIENT.has(errnoCode(error) ?? '') || Date.now() + wait > deadline) throw error
    }
    await delay(wait)
    wait = Math.min(wait * 2, 200)
  }
}

export interface ReplaceOptions extends FsOptions {
  /** 替换前磁盘上必须还是这个版本；null 表示不核对（回收站记录：调用方已持有记录锁）。 */
  expected: FileVersion | null
  /** 写入后的权限位：原文件的 `mode & 0o777`；undefined 表示新文件的默认权限。 */
  mode: number | undefined
}

/** replaced 带上写入的 inode 的 stat（见 writeNewFile）；modified、missing 时目标没有被动过。 */
export type ReplaceOutcome =
  | { kind: 'replaced'; stats: Stats }
  | { kind: 'modified' }
  | { kind: 'missing' }

/**
 * 原子替换（design-spec 7.1）：同目录临时文件 `.<文件名>.promptx-<随机>.tmp` 独占创建 → 写入并 fsync →
 * 替换前再读一次目标核对版本（L-12）→ rename（Windows 上有限次重试）→ fsync 所在目录。任何一步失败都删除临时文件。
 * 已知限制（design-spec 13 第 7 条）：「核对版本」和「rename」之间外部程序的写入无法排除；替换后是新的 inode，
 * 扩展属性（Finder 标签）、ACL、创建时间、硬链接都不保留，只保留权限位。
 */
export async function replaceFile(target: string, data: Uint8Array, options: ReplaceOptions): Promise<ReplaceOutcome> {
  const dir = dirname(target)
  const temp = join(dir, tempNameFor(basename(target)))
  let committed = false
  let stats: Stats
  try {
    stats = await writeNewFile(temp, data, options.mode)
    await options.hooks?.beforeVerify?.(target)
    if (options.expected !== null) {
      const check = await checkVersion(target, options.expected)
      if (check !== 'match') return { kind: check }
    }
    await renameWithRetry(temp, target, options)
    committed = true
  } finally {
    if (!committed) await rm(temp, { force: true }).catch(() => undefined)
  }
  await fsyncDir(dir)
  return { kind: 'replaced', stats }
}

// ───────────────────────────── 不覆盖的新建与移动 ─────────────────────────────

/** 依次尝试的名字最多试这么多个，防止目录被占满时无限循环。 */
const MAX_NAME_ATTEMPTS = 10_000

interface Placed {
  name: string
  /** 复制出来的新 inode 的 stat；link 时为 undefined（目标和源是同一个 inode）。 */
  copied?: Stats
}

/**
 * 把 src 放到 dir 里第一个空着的候选名字上，不覆盖任何已有文件：先 link，目标已存在（EEXIST）就换下一个名字；
 * 和已有文件只差大小写的名字、Windows 上的设备名直接跳过。link 因为其他原因失败时（FAT、exFAT、部分网络盘和 FUSE
 * 不支持硬链接，各平台报的错码不一样，不逐个认）改用独占复制 copyFile(COPYFILE_EXCL)，复制后 fsync 并核对 SHA-256。
 * 真正的权限、空间问题复制时会再报一次。候选名都被占用时返回 null。
 */
async function placeFirstFree(src: string, dir: string, candidates: Iterable<string>, options: FsOptions): Promise<Placed | null> {
  const ops = opsOf(options)
  const windows = (options.platform ?? process.platform) === 'win32'
  const taken = await nameKeysOf(dir)
  let useCopy = false
  let attempts = 0
  for (const name of candidates) {
    if (++attempts > MAX_NAME_ATTEMPTS) break
    if (taken.has(nameKey(name)) || (windows && isWindowsDeviceName(name))) continue
    const target = join(dir, name)
    await options.hooks?.beforeLink?.(target)
    if (!useCopy) {
      try {
        await ops.link(src, target)
        return { name }
      } catch (error) {
        if (errnoCode(error) === 'EEXIST') {
          taken.add(nameKey(name))
          continue
        }
        useCopy = true
      }
    }
    try {
      await ops.copyFile(src, target, constants.COPYFILE_EXCL)
    } catch (error) {
      if (errnoCode(error) === 'EEXIST') {
        taken.add(nameKey(name))
        continue
      }
      throw error
    }
    let copied: Stats
    try {
      copied = await syncFile(target)
      const [copy, source] = await Promise.all([hashFile(target), hashFile(src)])
      if (!sameVersion(copy, source)) throw Object.assign(new Error('EIO: copy verification failed'), { code: 'EIO' })
    } catch (error) {
      await rm(target, { force: true }).catch(() => undefined)
      throw error
    }
    return { name, copied }
  }
  return null
}

export interface Created {
  name: string
  /** 新文件的 stat，给索引做缓存键（见 writeNewFile）。 */
  stats: Stats
}

/**
 * 新建文件，不覆盖已有文件（design-spec 7.1「新文件」）：先在 dir 里写好临时文件并 fsync，
 * 再 link 到第一个空着的候选名字上，最后删掉临时文件。返回最终的文件名和 stat；候选名都被占用时抛错。
 */
export async function createNoClobber(
  dir: string,
  candidates: Iterable<string>,
  data: Uint8Array,
  options: FsOptions = {},
): Promise<Created> {
  const names = candidates[Symbol.iterator]()
  const first = names.next()
  if (first.done === true) throw new Error('createNoClobber: no candidate names')
  const temp = join(dir, tempNameFor(first.value))
  let written: Stats
  let placed: Placed | null
  try {
    written = await writeNewFile(temp, data, undefined)
    placed = await placeFirstFree(temp, dir, prepend(first.value, names), options)
  } finally {
    await rm(temp, { force: true }).catch(() => undefined)
  }
  if (placed === null) throw Object.assign(new Error('EEXIST: no free file name'), { code: 'EEXIST' })
  await fsyncDir(dir)
  return { name: placed.name, stats: placed.copied ?? written }
}

function* prepend<T>(head: T, rest: Iterator<T>): Generator<T, void, unknown> {
  yield head
  for (;;) {
    const next = rest.next()
    if (next.done === true) return
    yield next.value
  }
}

/**
 * 不覆盖的移动（design-spec 7.3）：删除、恢复、失败回滚都用它。放到 dir 里第一个空着的候选名字上，
 * 成功后删除源文件并 fsync 两个目录。候选名都被占用时返回 null，源文件不动。
 */
export async function moveNoClobber(
  src: string,
  dir: string,
  candidates: Iterable<string>,
  options: FsOptions = {},
): Promise<string | null> {
  const placed = await placeFirstFree(src, dir, candidates, options)
  if (placed === null) return null
  const target = join(dir, placed.name)
  try {
    await unlink(src)
  } catch (error) {
    // 源文件已经不在（别的进程刚移走或删掉）：目标那份就是唯一的一份，算移动成功，绝不能再删它
    if (errnoCode(error) !== 'ENOENT') {
      // 源文件删不掉：撤回刚放好的那份，文件只留在原处，不会两边各有一份
      await rm(target, { force: true }).catch(() => undefined)
      throw error
    }
  }
  await fsyncDir(dir)
  await fsyncDir(dirname(src))
  return placed.name
}
