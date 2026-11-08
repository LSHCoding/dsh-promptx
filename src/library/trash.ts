// 回收站记录（需求 L-11、6.4，design-spec 7.3，审查意见 S02、S05）：`_trash/.promptx-trash.json`。
// 记录随库目录一起移动，换机器或改库目录后仍能按原位置恢复。记录来自库目录里的文件，可能被同步工具、
// 共享仓库或手工改过，读出来的每一项都重新校验，不合格或重复的项按「原位置未知」处理。
// 读改写由调用方在库的修改队列里、持 withFileLock 跨进程锁完成，这里只管格式和锁的位置。

import type { Stats } from 'node:fs'
import { lstat, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { PromptxError } from '../shared/errors.ts'
import { formatIsoUtc, truncateUtf8 } from '../shared/library-rules.ts'
import { errnoCode, moveNoClobber, nameKey, readRegularFile, replaceFile, sha256Hex } from './fs-safe.ts'
import type { FileRead, FsOptions } from './fs-safe.ts'
import { isTrashFileName, promptRelPath } from './rel-path.ts'

export const RECORD_FILE = '.promptx-trash.json'
export const RECORD_VERSION = 1

/**
 * 记录文件的大小上限。每项约 300 字节，4 MiB 能记一万多项；更大的按读不出来处理，
 * 不把整个文件读进内存再在 Host 主线程上解析（审查 SEC-02）。
 */
export const MAX_RECORD_BYTES = 4 * 1024 * 1024

/**
 * 记录项里 file、originalPath 的长度上限（UTF-16 码元）。超长的值在任何校验之前就丢掉，校验的代价不随攻击者写进记录的长度增长
 * （审查 SEC-02；逐项的校验都是线性的）。取 Linux 的 PATH_MAX 4096：macOS、Linux 上相对路径的码元数不超过它的字节数，
 * 插件能打开的文件，删除时写进记录的原路径读回来都还在。原来的 1024 在 Linux 上会让文件夹很深的文件删除后变成「原位置未知」，
 * 写的时候照常写、读的时候整项丢掉（外部审查复核）。
 */
export const MAX_RECORD_PATH_CHARS = 4096

/**
 * Windows 上的同一个上限。Node 在 Windows 上用 `\\?\` 长路径，相对路径最长能到 32,767 个码元，插件能列出、能删除的文件
 * 都在这个范围里；按 4096 读，文件夹极深的文件删除后同样会变成「原位置未知」。整份记录仍受 MAX_RECORD_BYTES 限制，
 * 逐项校验是线性的（外部审查第二轮复核）。
 */
export const WINDOWS_MAX_RECORD_PATH_CHARS = 32_767

/** 记录再写就超过 MAX_RECORD_BYTES 时报的原因代码（promptx/trash/record-failed 的 detail）。 */
export const RECORD_FULL = 'trash-record-full'

/**
 * 单个文件名的长度上限。Linux（ext4 等）按 UTF-8 字节算 255；macOS、Windows 按 UTF-16 码元算 255。
 * 同一个名字的 UTF-8 字节数不会少于 UTF-16 码元数，按字节算在三个平台上都放得下。
 */
const NAME_MAX_BYTES = 255

/**
 * 回收站记录锁的目标路径（withFileLock 会再加上 `.lock`）：`<lockDir>/trash-<回收站目录 realpath 的 SHA-256 前 16 位>`。
 * 锁不放进库里（审查 SEC-03）：库目录可能来自共享仓库或同步工具，预先放好的 `_trash/.promptx-trash.json.lock`
 * （写着一个存活的 pid，或者是指向命名管道的符号链接）会让每次删除、恢复等满 10 秒后失败，或者永远卡在读锁文件上，
 * 连带同一个库后面排队的保存全部卡住。需求 6.3 也只允许插件在库里创建 Prompt 文件、文件夹、`_trash/` 和回收站记录。
 * 用 realpath 命名：不同 profile 用不同写法（大小写、符号链接）配置同一个库时，拿到的是同一把锁。
 */
export function recordLockTarget(lockDir: string, trashDirReal: string): string {
  return join(lockDir, `trash-${sha256Hex(Buffer.from(trashDirReal, 'utf8')).slice(0, 16)}`)
}

export interface TrashItem {
  /** `_trash/` 下的文件名。 */
  file: string
  /** 删除前的相对路径。 */
  originalPath: string
  /** ISO 8601 UTC。 */
  deletedAt: string
  /** 删除时文件内容的 SHA-256 和字节数，恢复时据此判断文件在回收站里有没有被改过（需求 6.4）。 */
  sha256: string
  size: number
}

export interface TrashRecord {
  /** missing：还没有记录文件；unreadable：损坏或版本不认识，所有文件按「原位置未知」处理。 */
  state: 'ok' | 'missing' | 'unreadable'
  /** 合格、不重复、且文件确实在 `_trash/` 里的记录项，键是文件名的比较键。 */
  items: Map<string, TrashItem>
  /** 记录里提到过的文件名（比较键），包括不合格的项：恢复时据此判断要不要改写记录。 */
  mentioned: Set<string>
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isArray(value: unknown): value is unknown[] {
  return Array.isArray(value)
}

function emptyRecord(state: 'missing' | 'unreadable'): TrashRecord {
  return { state, items: new Map(), mentioned: new Set() }
}

const SHA256_HEX = /^[0-9a-f]{64}$/

function parseItem(value: unknown, platform: NodeJS.Platform): TrashItem | null {
  if (!isObject(value)) return null
  const { file, originalPath, deletedAt, sha256, size } = value
  if (typeof file !== 'string' || typeof originalPath !== 'string') return null
  const maxChars = platform === 'win32' ? WINDOWS_MAX_RECORD_PATH_CHARS : MAX_RECORD_PATH_CHARS
  if (file.length > maxChars || originalPath.length > maxChars) return null
  if (!isTrashFileName(file, platform)) return null
  // 原路径和小程序传来的路径同样校验：`../` 之类的值不能把恢复的文件带到库目录之外
  const original = promptRelPath(originalPath, platform)
  if (original === null) return null
  if (typeof deletedAt !== 'string' || Number.isNaN(Date.parse(deletedAt))) return null
  if (typeof sha256 !== 'string' || !SHA256_HEX.test(sha256)) return null
  if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0) return null
  return { file, originalPath: original, deletedAt, sha256, size }
}

async function isRegularFile(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isFile()
  } catch {
    return false
  }
}

/** 读回收站记录并逐项校验（design-spec 7.3「记录项校验」）。 */
export async function readTrashRecord(trashDir: string, platform: NodeJS.Platform = process.platform): Promise<TrashRecord> {
  const path = join(trashDir, RECORD_FILE)
  let read: FileRead
  try {
    // 先 lstat：Windows 上 open 没有 O_NOFOLLOW，记录位置上的符号链接只能在这里挡住
    const stats = await lstat(path)
    if (!stats.isFile()) return emptyRecord('unreadable')
    // 再和读 Prompt 文件一样用 readRegularFile：POSIX 上不跟随 lstat 之后换上的符号链接，换成命名管道也不会卡住，
    // 超过上限不读（审查 SEC-02）。符号链接、目录、管道和超大的记录都按读不出来处理，下一次删除时由 setAsideBrokenRecord 改名留着
    read = await readRegularFile(path, MAX_RECORD_BYTES)
  } catch (error) {
    return emptyRecord(errnoCode(error) === 'ENOENT' ? 'missing' : 'unreadable')
  }
  if (read.kind === 'missing') return emptyRecord('missing')
  if (read.kind !== 'ok') return emptyRecord('unreadable')
  let raw: unknown
  try {
    raw = JSON.parse(read.bytes.toString('utf8'))
  } catch {
    return emptyRecord('unreadable')
  }
  if (!isObject(raw) || raw.version !== RECORD_VERSION || !isArray(raw.items)) return emptyRecord('unreadable')
  const mentioned = new Set<string>()
  const counts = new Map<string, number>()
  const parsed: TrashItem[] = []
  for (const value of raw.items) {
    if (isObject(value) && typeof value.file === 'string') {
      const key = nameKey(value.file)
      mentioned.add(key)
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
    const item = parseItem(value, platform)
    if (item !== null) parsed.push(item)
  }
  const items = new Map<string, TrashItem>()
  for (const item of parsed) {
    const key = nameKey(item.file)
    // 同一个文件有两条记录：分不清哪条是对的，都按原位置未知处理
    if ((counts.get(key) ?? 0) > 1) continue
    // 记录项的文件必须是 `_trash/` 里的普通文件；不在了的是陈旧的记录项
    if (!(await isRegularFile(join(trashDir, item.file)))) continue
    items.set(key, item)
  }
  return { state: 'ok', items, mentioned }
}

/**
 * 原子写入整份记录（临时文件 + fsync + rename）。只写合格的项：不合格、陈旧的项借这次写入清掉。
 * 写出来超过 MAX_RECORD_BYTES 时不写，抛 promptx/trash/record-failed（RECORD_FULL），原来的记录不动（外部审查第 4 条）：
 * 超过上限的记录下次读取时整份按读不出来处理，所有项都变成「原位置未知」，下一次删除还会把它改名移开。
 */
export async function writeTrashRecord(trashDir: string, items: Iterable<TrashItem>, options: FsOptions = {}): Promise<void> {
  const list = [...items].map(item => ({
    file: item.file,
    originalPath: item.originalPath,
    deletedAt: item.deletedAt,
    sha256: item.sha256,
    size: item.size,
  }))
  const bytes = Buffer.from(`${JSON.stringify({ version: RECORD_VERSION, items: list }, null, 2)}\n`, 'utf8')
  if (bytes.length > MAX_RECORD_BYTES) throw new PromptxError('promptx/trash/record-failed', RECORD_FULL)
  const ops = options.ops === undefined ? {} : { ops: options.ops }
  await replaceFile(join(trashDir, RECORD_FILE), bytes, { ...ops, expected: null, mode: undefined })
}

function* brokenRecordNames(stamp: string): Generator<string, never, unknown> {
  yield `.promptx-trash.broken-${stamp}.json`
  for (let n = 2; ; n++) yield `.promptx-trash.broken-${stamp}-${n}.json`
}

/**
 * 读不出来的记录不改写，下一次删除前先把它改名为 `.promptx-trash.broken-<时间>.json` 留着（design-spec 7.3），
 * 再写新记录。普通文件用不覆盖的移动；记录位置上是目录或符号链接这类异常情况只能 rename，先找一个空着的名字。
 */
export async function setAsideBrokenRecord(trashDir: string, now: Date, options: FsOptions = {}): Promise<void> {
  const path = join(trashDir, RECORD_FILE)
  const stamp = formatIsoUtc(now).replace(/[-:]/g, '')
  let stats: Stats
  try {
    stats = await lstat(path)
  } catch (error) {
    if (errnoCode(error) === 'ENOENT') return
    throw error
  }
  const ops = options.ops === undefined ? {} : { ops: options.ops }
  if (stats.isFile()) {
    const moved = await moveNoClobber(path, trashDir, brokenRecordNames(stamp), ops)
    if (moved === null) throw Object.assign(new Error('EEXIST: no free name for the broken record'), { code: 'EEXIST' })
    return
  }
  let attempts = 0
  for (const name of brokenRecordNames(stamp)) {
    if (++attempts > 1000) break
    const target = join(trashDir, name)
    try {
      await lstat(target)
      continue
    } catch (error) {
      if (errnoCode(error) !== 'ENOENT') throw error
    }
    await rename(path, target)
    return
  }
  throw Object.assign(new Error('EEXIST: no free name for the broken record'), { code: 'EEXIST' })
}

/** `_trash/` 里重名时文件名后加序号（需求 6.4）：`x.md`、`x-2.md`、`x-3.md`……扩展名的大小写保持原样。 */
export function* trashNameCandidates(name: string): Generator<string, void, unknown> {
  yield name
  yield* numberedNames(name)
}

/**
 * 原路径被占用时的替代名字（L-11）：原文件名后加 `-2`、`-3`……，不含原名本身。
 * 加上序号会超过 NAME_MAX_BYTES 时先截短原名的主体（按字素簇切）：用户在别处建的接近上限的长文件名，
 * 直接加序号会让占用检查和移动报 ENAMETOOLONG，恢复时给不出替代路径，回收站里有同名文件时也删不掉（外部审查第 6 条）。
 */
export function* numberedNames(name: string): Generator<string, never, unknown> {
  const stem = name.slice(0, -3)
  const extension = name.slice(-3)
  for (let n = 2; ; n++) {
    const suffix = `-${n}${extension}`
    yield `${truncateUtf8(stem, NAME_MAX_BYTES - Buffer.byteLength(suffix, 'utf8'))}${suffix}`
  }
}
