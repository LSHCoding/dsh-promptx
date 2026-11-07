// 库和草稿测试共用的工具：未处理异常陷阱、临时目录、写文件、目录快照、服务工厂。

import { createHash } from 'node:crypto'
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, afterEach, beforeAll } from 'vitest'
import { LibraryService } from '../../src/library/service.ts'
import type { LibraryInternals } from '../../src/library/service.ts'
import type { LibraryServiceOptions } from '../../src/services.ts'
import type { Binding, LibraryListParams, LibraryListResult } from '../../src/shared/types.ts'

/** 测试里固定的「现在」：2026-11-08 12:00:00 UTC。 */
export const NOW = new Date('2026-11-08T12:00:00.000Z')
export const NOW_STAMP = '2026-11-08T12:00:00Z'

/**
 * Host 进程里任何未处理的 Promise 拒绝或异常都会让整个 dsh 退出（design-spec 4.1），
 * 所以测试期间出现一个就判当前测试失败。
 */
export function installCrashTraps(): void {
  const problems: unknown[] = []
  const onRejection = (reason: unknown): void => {
    problems.push(reason)
  }
  const onException = (error: unknown): void => {
    problems.push(error)
  }
  beforeAll(() => {
    process.on('unhandledRejection', onRejection)
    process.on('uncaughtException', onException)
  })
  afterEach(async () => {
    // 让已经排队的拒绝事件先派发出来
    await new Promise(resolve => setImmediate(resolve))
    if (problems.length > 0) {
      const found = problems.splice(0)
      throw new Error(`unhandled rejection or exception: ${found.map(item => String(item)).join('; ')}`)
    }
  })
  afterAll(() => {
    process.off('unhandledRejection', onRejection)
    process.off('uncaughtException', onException)
  })
}

async function restoreModes(path: string): Promise<void> {
  try {
    const stats = await lstat(path)
    if (stats.isSymbolicLink()) return
    if (stats.isDirectory()) {
      await chmod(path, 0o755)
      for (const name of await readdir(path)) await restoreModes(join(path, name))
    } else {
      await chmod(path, 0o644)
    }
  } catch {
    // 已经删掉了
  }
}

/** 每个测试用新的临时目录，测试后删除。删除前恢复权限：chmod 000 的目录和文件删不掉。 */
export function useTempDirs(): { make: (prefix?: string) => Promise<string> } {
  const dirs: string[] = []
  afterEach(async () => {
    for (const dir of dirs.splice(0)) {
      if (process.platform !== 'win32') await restoreModes(dir)
      await rm(dir, { recursive: true, force: true })
    }
  })
  return {
    async make(prefix = 'promptx-lib-') {
      const dir = await mkdtemp(join(tmpdir(), prefix))
      dirs.push(dir)
      return dir
    },
  }
}

/** 在 root 下写文件，缺少的上级目录一起建。值为 Buffer 时原样写入字节。 */
export async function writeTree(root: string, files: Record<string, string | Buffer>): Promise<void> {
  for (const [relPath, content] of Object.entries(files)) {
    const abs = join(root, ...relPath.split('/'))
    await mkdir(dirname(abs), { recursive: true })
    await writeFile(abs, content)
  }
}

export async function readText(root: string, relPath: string): Promise<string> {
  return await readFile(join(root, ...relPath.split('/')), 'utf8')
}

export async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch {
    return false
  }
}

export interface FileSnapshot {
  kind: 'file' | 'dir' | 'link' | 'other'
  sha256?: string
  mtimeMs?: number
  mode?: number
}

/** 递归记下 root 下每一项的类型、内容摘要、修改时间和权限，用来证明一组操作没有动过任何文件。 */
export async function snapshotTree(root: string): Promise<Map<string, FileSnapshot>> {
  const result = new Map<string, FileSnapshot>()
  async function walk(abs: string, rel: string): Promise<void> {
    for (const name of await readdir(abs)) {
      const childAbs = join(abs, name)
      const childRel = rel === '' ? name : `${rel}/${name}`
      const stats = await lstat(childAbs)
      if (stats.isSymbolicLink()) {
        result.set(childRel, { kind: 'link' })
      } else if (stats.isDirectory()) {
        result.set(childRel, { kind: 'dir', mtimeMs: stats.mtimeMs })
        await walk(childAbs, childRel)
      } else if (stats.isFile()) {
        const sha256 = createHash('sha256').update(await readFile(childAbs)).digest('hex')
        result.set(childRel, { kind: 'file', sha256, mtimeMs: stats.mtimeMs, mode: stats.mode })
      } else {
        result.set(childRel, { kind: 'other' })
      }
    }
  }
  await walk(root, '')
  return result
}

/** 建符号链接；Windows 上没有权限时返回 false，调用方跳过测试。目录用 junction，不需要权限。 */
export async function trySymlink(target: string, path: string, type: 'file' | 'dir'): Promise<boolean> {
  try {
    await symlink(target, path, process.platform === 'win32' && type === 'dir' ? 'junction' : type)
    return true
  } catch (error) {
    if (process.platform === 'win32') return false
    throw error
  }
}

/** chmod 的效果只在 POSIX 上、不是 root 运行时可靠。 */
export const canTestPermissions = process.platform !== 'win32' && process.getuid?.() !== 0

/** 一个带 front matter 的 Prompt 文件全文。 */
export function promptFile(fields: Record<string, string>, body: string): string {
  const lines = Object.entries(fields).map(([key, value]) => `${key}: ${value}`)
  return ['---', ...lines, '---', body].join('\n')
}

export function makeService(
  root: string,
  overrides: Partial<LibraryServiceOptions> = {},
  internals: LibraryInternals = {},
): LibraryService {
  let counter = 0
  return new LibraryService({
    getRoot: () => root,
    untitledTitle: () => '未命名 Prompt',
    now: () => NOW,
    // 每次给不同的字节，同一秒里新建的多个文件 id 也不同
    randomBytes: (size: number) => {
      counter++
      return Uint8Array.from({ length: size }, (_, index) => (counter * 31 + index * 7) % 256)
    },
    ...overrides,
  }, internals)
}

/** 像小窗「在编辑器中打开」那样读一条并建立绑定。 */
export async function bindingFor(service: LibraryService, root: string, relPath: string): Promise<Binding> {
  const read = await service.read(relPath)
  return {
    libraryDir: root,
    relPath,
    id: read.entry.id,
    title: read.entry.title,
    sha256: read.version.sha256,
    size: read.version.size,
    savedBody: read.body,
  }
}

export function listParams(overrides: Partial<LibraryListParams> = {}): LibraryListParams {
  return { folder: { kind: 'all' }, scope: 'all', tag: null, query: '', refresh: true, ...overrides }
}

export async function listAll(service: LibraryService, overrides: Partial<LibraryListParams> = {}): Promise<LibraryListResult> {
  return await service.list(listParams(overrides))
}

export function sha256Of(text: string | Buffer): string {
  return createHash('sha256').update(text).digest('hex')
}
