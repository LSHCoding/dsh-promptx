// 文件夹和其全部内容一起移动，回收站记录独立于 Markdown 文件记录。
import { lstat, mkdtemp, readdir, rename, rmdir, unlink } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type { TrashEntry } from '../shared/types.ts'
import { createNoClobber, fsyncDir, readRegularFile } from './fs-safe.ts'
import { isObject } from './params.ts'
import { folderRelPath } from './rel-path.ts'

const PREFIX = '.promptx-folder-'
const RECORD = '.original.json'
const MAX_FOLDER_RECORD_BYTES = 256 * 1024

export function isFolderTrashId(file: unknown): file is string {
  return typeof file === 'string' && file.startsWith(PREFIX) && /^[A-Za-z0-9]{6}$/.test(file.slice(PREFIX.length))
}

export interface TrashedFolder {
  entry: TrashEntry
  source: string
  container: string
}

export async function readTrashedFolder(trashDir: string, file: string, platform: NodeJS.Platform): Promise<TrashedFolder | null> {
  const container = join(trashDir, file)
  if (!(await lstat(container).catch(() => null))?.isDirectory()) return null
  const folders = (await readdir(container, { withFileTypes: true }).catch(() => [])).filter(item => item.isDirectory())
  const title = folders.length === 1 ? folders[0]?.name : undefined
  if (title === undefined || folderRelPath(`parent/${title}`, platform) !== `parent/${title}`) return null
  let originalPath: string | null = null
  let deletedAt: number | null = null
  try {
    const record = await readRegularFile(join(container, RECORD), MAX_FOLDER_RECORD_BYTES)
    if (record.kind === 'ok') {
      const value: unknown = JSON.parse(record.bytes.toString('utf8'))
      if (isObject(value)) {
        const folder = folderRelPath(value.originalPath, platform)
        if (folder !== null && folder.split('/').at(-1)?.normalize() === title.normalize()) originalPath = folder
        if (typeof value.deletedAt === 'number' && Number.isFinite(value.deletedAt)) deletedAt = value.deletedAt
      }
    }
  } catch {
    // 原位置记录损坏时仍允许把文件夹恢复到库根目录。
  }
  return { entry: { file, kind: 'folder', title, originalPath, deletedAt }, source: join(container, title), container }
}

export async function moveFolderToTrash(trashDir: string, source: string, originalPath: string, deletedAt: number): Promise<string> {
  const container = await mkdtemp(join(trashDir, PREFIX))
  try {
    const record = Buffer.from(JSON.stringify({ originalPath, deletedAt }), 'utf8')
    await createNoClobber(container, [RECORD], record)
    // 记录先落盘，移动失败只清理空容器。整个目录只做一次 rename，文件字节和目录结构保持原样。
    await fsyncDir(trashDir)
    await rename(source, join(container, basename(source)))
  } catch (error) {
    await cleanFolderTrash(container)
    throw error
  }
  await Promise.all([fsyncDir(container), fsyncDir(dirname(source))])
  return basename(container)
}

export async function cleanFolderTrash(container: string): Promise<void> {
  await unlink(join(container, RECORD)).catch(() => undefined)
  // 目录非空就留在原地，清理过程不递归删除任何内容。
  await rmdir(container).catch(() => undefined)
}
