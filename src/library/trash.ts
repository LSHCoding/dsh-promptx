// 回收站记录（需求 L-11、6.4，design-spec 7.3，审查意见 S02、S05）：`_trash/.promptx-trash.json`。
// 记录随库目录一起移动，换机器或改库目录后仍能按原位置恢复。记录来自库目录里的文件，可能被同步工具、
// 共享仓库或手工改过，读出来的每一项都重新校验，不合格或重复的项按「原位置未知」处理。
// 读改写由调用方在库的修改队列里、持 withFileLock 跨进程锁完成，这里只管格式。

import type { Stats } from 'node:fs'
import { lstat, readFile, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { formatIsoUtc } from '../shared/library-rules.ts'
import { errnoCode, moveNoClobber, nameKey, replaceFile } from './fs-safe.ts'
import type { FsOptions } from './fs-safe.ts'
import { isTrashFileName, promptRelPath } from './rel-path.ts'

export const RECORD_FILE = '.promptx-trash.json'
export const RECORD_VERSION = 1

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
  let stats: Stats
  try {
    stats = await lstat(path)
  } catch (error) {
    return emptyRecord(errnoCode(error) === 'ENOENT' ? 'missing' : 'unreadable')
  }
  if (!stats.isFile()) return emptyRecord('unreadable')
  let raw: unknown
  try {
    raw = JSON.parse(await readFile(path, 'utf8'))
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

/** 原子写入整份记录（临时文件 + fsync + rename）。只写合格的项：不合格、陈旧的项借这次写入清掉。 */
export async function writeTrashRecord(trashDir: string, items: Iterable<TrashItem>, options: FsOptions = {}): Promise<void> {
  const list = [...items].map(item => ({
    file: item.file,
    originalPath: item.originalPath,
    deletedAt: item.deletedAt,
    sha256: item.sha256,
    size: item.size,
  }))
  const text = `${JSON.stringify({ version: RECORD_VERSION, items: list }, null, 2)}\n`
  const ops = options.ops === undefined ? {} : { ops: options.ops }
  await replaceFile(join(trashDir, RECORD_FILE), Buffer.from(text, 'utf8'), { ...ops, expected: null, mode: undefined })
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

/** 原路径被占用时的替代名字（L-11）：原文件名后加 `-2`、`-3`……，不含原名本身。 */
export function* numberedNames(name: string): Generator<string, never, unknown> {
  const stem = name.slice(0, -3)
  const extension = name.slice(-3)
  for (let n = 2; ; n++) yield `${stem}-${n}${extension}`
}
