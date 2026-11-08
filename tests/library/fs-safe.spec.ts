import { chmod, mkdir, readdir, readFile, stat, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { PromptxError } from '../../src/shared/errors.ts'
import {
  MAX_PROMPT_BYTES,
  createNoClobber,
  ensureFolder,
  hashFile,
  isPromptxTempName,
  isWindowsDeviceName,
  locate,
  moveNoClobber,
  nameKey,
  readRegularFile,
  removeStaleTemps,
  renameWithRetry,
  replaceFile,
  sha256Hex,
  systemErrorDetail,
  tempNameFor,
  versionOf,
} from '../../src/library/fs-safe.ts'
import { canTestPermissions, exists, installCrashTraps, sha256Of, trySymlink, useTempDirs } from './helpers.ts'

installCrashTraps()
const temp = useTempDirs()

function errno(code: string, message = `${code}: something went wrong, open '/库/秘密标题.md'`): Error {
  return Object.assign(new Error(message), { code })
}

async function onlyFiles(dir: string): Promise<string[]> {
  return (await readdir(dir)).sort()
}

describe('systemErrorDetail', () => {
  it('keeps the errno code and description but drops the path (N-02)', () => {
    expect(systemErrorDetail(errno('EACCES', "EACCES: permission denied, open '/库/秘密标题.md'"))).toBe('EACCES: permission denied')
    expect(systemErrorDetail(errno('ENOSPC', 'ENOSPC: no space left on device, write'))).toBe('ENOSPC: no space left on device')
  })

  it('never forwards arbitrary messages', () => {
    expect(systemErrorDetail(new Error('the prompt says hello'))).toBe('unknown')
    expect(systemErrorDetail(Object.assign(new Error('odd message with content'), { code: 'EIO' }))).toBe('EIO')
    expect(systemErrorDetail('just a string')).toBe('unknown')
  })
})

describe('temp names', () => {
  it('are recognised and stay within the 255-byte file name limit', () => {
    const name = tempNameFor('代码审查清单.md')
    expect(isPromptxTempName(name)).toBe(true)
    expect(name.startsWith('.代码审查清单.md.promptx-')).toBe(true)
    const long = tempNameFor(`${'长'.repeat(84)}.md`)
    expect(Buffer.byteLength(long)).toBeLessThanOrEqual(255)
    expect(isPromptxTempName(long)).toBe(true)
    expect(isPromptxTempName('.a.md.promptx-123.tmp')).toBe(false)
    expect(isPromptxTempName('a.md')).toBe(false)
  })

  it('removeStaleTemps deletes only files older than the limit', async () => {
    const dir = await temp.make()
    const old = join(dir, '.a.md.promptx-0123456789ab.tmp')
    const fresh = join(dir, '.b.md.promptx-0123456789ab.tmp')
    await writeFile(old, 'x')
    await writeFile(fresh, 'y')
    const twoHoursAgo = new Date(Date.now() - 2 * 3600_000)
    await utimes(old, twoHoursAgo, twoHoursAgo)
    await removeStaleTemps([old, fresh, join(dir, '.gone.promptx-0123456789ab.tmp')], 3600_000)
    expect(await exists(old)).toBe(false)
    expect(await exists(fresh)).toBe(true)
  })
})

describe('locate and ensureFolder', () => {
  it('finds files, reports missing paths and non-files', async () => {
    const root = await temp.make()
    await mkdir(join(root, 'a', 'b'), { recursive: true })
    await writeFile(join(root, 'a', 'b', 'x.md'), 'x')
    await writeFile(join(root, 'file.md'), 'f')
    expect((await locate(root, 'a/b/x.md')).kind).toBe('file')
    expect((await locate(root, 'a/b/none.md')).kind).toBe('missing')
    expect((await locate(root, 'none/x.md')).kind).toBe('missing')
    expect((await locate(root, 'a/b')).kind).toBe('other')
    // 中间一级是文件
    expect((await locate(root, 'file.md/x.md')).kind).toBe('missing')
  })

  it('rejects any symbolic link on the way', async (ctx) => {
    const root = await temp.make()
    const outside = await temp.make()
    await writeFile(join(outside, 'secret.md'), 'secret')
    if (!(await trySymlink(outside, join(root, 'linked'), 'dir'))) ctx.skip()
    await expect(locate(root, 'linked/secret.md')).rejects.toMatchObject({ code: 'promptx/library/invalid-path' })
    await expect(ensureFolder(root, 'linked/new')).rejects.toBeInstanceOf(PromptxError)
    expect(await exists(join(outside, 'new'))).toBe(false)
  })

  it('rejects a symbolic link as the last segment', async (ctx) => {
    const root = await temp.make()
    await writeFile(join(root, 'real.md'), 'real')
    if (!(await trySymlink(join(root, 'real.md'), join(root, 'link.md'), 'file'))) ctx.skip()
    await expect(locate(root, 'link.md')).rejects.toMatchObject({ code: 'promptx/library/invalid-path' })
  })

  it('creates nested folders and refuses to treat a file as a folder', async () => {
    const root = await temp.make()
    await ensureFolder(root, 'a/b/c')
    expect((await stat(join(root, 'a', 'b', 'c'))).isDirectory()).toBe(true)
    await ensureFolder(root, 'a/b/c')
    await writeFile(join(root, 'plain'), 'x')
    await expect(ensureFolder(root, 'plain/sub')).rejects.toMatchObject({ code: 'promptx/library/invalid-path' })
  })
})

describe('readRegularFile and hashFile', () => {
  it('reads bytes, reports too-large without reading, and missing files', async () => {
    const dir = await temp.make()
    await writeFile(join(dir, 'a.md'), 'hello')
    const read = await readRegularFile(join(dir, 'a.md'), MAX_PROMPT_BYTES)
    expect(read.kind).toBe('ok')
    if (read.kind === 'ok') expect(read.bytes.toString()).toBe('hello')
    expect((await readRegularFile(join(dir, 'a.md'), 3)).kind).toBe('too-large')
    expect((await readRegularFile(join(dir, 'none.md'), 10)).kind).toBe('missing')
    expect((await readRegularFile(dir, 10)).kind).toBe('not-file')
  })

  it('does not follow a symbolic link at the last segment', async (ctx) => {
    if (process.platform === 'win32') ctx.skip()
    const dir = await temp.make()
    await writeFile(join(dir, 'real.md'), 'real')
    if (!(await trySymlink(join(dir, 'real.md'), join(dir, 'link.md'), 'file'))) ctx.skip()
    expect((await readRegularFile(join(dir, 'link.md'), 100)).kind).toBe('not-file')
  })

  it('hashes files in chunks', async () => {
    const dir = await temp.make()
    const data = Buffer.alloc(200_000, 7)
    await writeFile(join(dir, 'big.md'), data)
    expect(await hashFile(join(dir, 'big.md'))).toEqual({ sha256: sha256Of(data), size: data.length })
    expect(versionOf(data)).toEqual({ sha256: sha256Hex(data), size: data.length })
  })
})

describe('replaceFile', () => {
  it('replaces the content when the version still matches and leaves no temp file', async () => {
    const dir = await temp.make()
    const target = join(dir, 'a.md')
    await writeFile(target, 'old')
    const outcome = await replaceFile(target, Buffer.from('new'), { expected: versionOf(Buffer.from('old')), mode: undefined })
    expect(outcome.kind).toBe('replaced')
    expect(await readFile(target, 'utf8')).toBe('new')
    expect(await onlyFiles(dir)).toEqual(['a.md'])
    // 返回的 stat 属于写进去的那个 inode：修改时间和大小就是目标文件现在的，索引直接拿来做缓存键
    const final = await stat(target)
    if (outcome.kind === 'replaced') expect([outcome.stats.mtimeMs, outcome.stats.size, outcome.stats.ino]).toEqual([final.mtimeMs, final.size, final.ino])
  })

  it('keeps the original permission bits, including ones wider than the umask (POSIX)', async (ctx) => {
    if (!canTestPermissions) ctx.skip()
    const dir = await temp.make()
    for (const mode of [0o600, 0o640, 0o666]) {
      const target = join(dir, `m${mode.toString(8)}.md`)
      await writeFile(target, 'old')
      await chmod(target, mode)
      await replaceFile(target, Buffer.from('new'), { expected: versionOf(Buffer.from('old')), mode })
      expect((await stat(target)).mode & 0o777).toBe(mode)
    }
  })

  it('refuses when the file changed right before the rename (L-12)', async () => {
    const dir = await temp.make()
    const target = join(dir, 'a.md')
    await writeFile(target, 'old')
    const outcome = await replaceFile(target, Buffer.from('mine'), {
      expected: versionOf(Buffer.from('old')),
      mode: undefined,
      hooks: { beforeVerify: async () => { await writeFile(target, 'theirs') } },
    })
    expect(outcome).toEqual({ kind: 'modified' })
    expect(await readFile(target, 'utf8')).toBe('theirs')
    expect(await onlyFiles(dir)).toEqual(['a.md'])
  })

  it('reports missing when the file disappeared right before the rename', async () => {
    const dir = await temp.make()
    const target = join(dir, 'a.md')
    await writeFile(target, 'old')
    const { rm } = await import('node:fs/promises')
    const outcome = await replaceFile(target, Buffer.from('mine'), {
      expected: versionOf(Buffer.from('old')),
      mode: undefined,
      hooks: { beforeVerify: async () => { await rm(target) } },
    })
    expect(outcome).toEqual({ kind: 'missing' })
    expect(await onlyFiles(dir)).toEqual([])
  })

  it('removes the temp file and keeps the original when the rename fails (N-02)', async () => {
    const dir = await temp.make()
    const target = join(dir, 'a.md')
    await writeFile(target, 'old')
    await expect(replaceFile(target, Buffer.from('new'), {
      expected: versionOf(Buffer.from('old')),
      mode: undefined,
      ops: { rename: async () => { throw errno('EIO') } },
    })).rejects.toMatchObject({ code: 'EIO' })
    expect(await readFile(target, 'utf8')).toBe('old')
    expect(await onlyFiles(dir)).toEqual(['a.md'])
  })

  it('writes without a version check when expected is null', async () => {
    const dir = await temp.make()
    const target = join(dir, 'record.json')
    await writeFile(target, 'anything')
    expect((await replaceFile(target, Buffer.from('{}'), { expected: null, mode: undefined })).kind).toBe('replaced')
    expect(await readFile(target, 'utf8')).toBe('{}')
  })
})

describe('renameWithRetry', () => {
  it('retries transient Windows errors with a bounded budget', async () => {
    let calls = 0
    const rename = async (): Promise<void> => {
      calls++
      if (calls < 3) throw errno('EBUSY')
    }
    await renameWithRetry('a', 'b', { ops: { rename }, platform: 'win32' })
    expect(calls).toBe(3)
  })

  it('does not retry on other platforms or other errors', async () => {
    let calls = 0
    const failing = async (): Promise<void> => {
      calls++
      throw errno('EPERM')
    }
    await expect(renameWithRetry('a', 'b', { ops: { rename: failing }, platform: 'linux' })).rejects.toMatchObject({ code: 'EPERM' })
    expect(calls).toBe(1)
    calls = 0
    const enoent = async (): Promise<void> => {
      calls++
      throw errno('ENOENT')
    }
    await expect(renameWithRetry('a', 'b', { ops: { rename: enoent }, platform: 'win32' })).rejects.toMatchObject({ code: 'ENOENT' })
    expect(calls).toBe(1)
  })

  it('gives up once the budget is spent', async () => {
    let calls = 0
    const failing = async (): Promise<void> => {
      calls++
      throw errno('EACCES')
    }
    const started = Date.now()
    await expect(renameWithRetry('a', 'b', { ops: { rename: failing }, platform: 'win32', budgetMs: 100 })).rejects.toMatchObject({ code: 'EACCES' })
    expect(calls).toBeGreaterThan(1)
    expect(Date.now() - started).toBeLessThan(1000)
  })
})

describe('createNoClobber', () => {
  it('takes the first free name, never overwrites, and removes its temp file', async () => {
    const dir = await temp.make()
    await writeFile(join(dir, 'a.md'), 'existing')
    const created = await createNoClobber(dir, ['a.md', 'a-1.md', 'a-2.md'], Buffer.from('new'))
    expect(created.name).toBe('a-1.md')
    const final = await stat(join(dir, 'a-1.md'))
    expect([created.stats.mtimeMs, created.stats.size, created.stats.ino]).toEqual([final.mtimeMs, final.size, final.ino])
    expect(await readFile(join(dir, 'a.md'), 'utf8')).toBe('existing')
    expect(await readFile(join(dir, 'a-1.md'), 'utf8')).toBe('new')
    expect(await onlyFiles(dir)).toEqual(['a-1.md', 'a.md'])
  })

  it('skips names that differ only by case from an existing file', async () => {
    const dir = await temp.make()
    await writeFile(join(dir, 'Fix.md'), 'existing')
    const { name } = await createNoClobber(dir, ['fix.md', 'fix-2.md'], Buffer.from('new'))
    expect(name).toBe('fix-2.md')
    expect(await readFile(join(dir, 'Fix.md'), 'utf8')).toBe('existing')
    expect(nameKey('Fix.md')).toBe(nameKey('fix.md'))
  })

  it('moves on when the destination appears between the check and the link', async () => {
    const dir = await temp.make()
    let intruded = false
    const { name } = await createNoClobber(dir, ['a.md', 'a-2.md'], Buffer.from('mine'), {
      hooks: {
        beforeLink: async (target) => {
          if (intruded) return
          intruded = true
          await writeFile(target, 'intruder')
        },
      },
    })
    expect(name).toBe('a-2.md')
    expect(await readFile(join(dir, 'a.md'), 'utf8')).toBe('intruder')
    expect(await readFile(join(dir, 'a-2.md'), 'utf8')).toBe('mine')
  })

  it('falls back to an exclusive copy when hard links are not supported', async () => {
    const dir = await temp.make()
    await writeFile(join(dir, 'a.md'), 'existing')
    const created = await createNoClobber(dir, ['a.md', 'b.md'], Buffer.from('copied'), {
      ops: { link: async () => { throw errno('EPERM') } },
    })
    expect(created.name).toBe('b.md')
    // 复制出来的是新的 inode，返回的 stat 是它的，不是已经删掉的临时文件的
    const final = await stat(join(dir, 'b.md'))
    expect([created.stats.size, created.stats.ino]).toEqual([final.size, final.ino])
    expect(await readFile(join(dir, 'b.md'), 'utf8')).toBe('copied')
    expect(await readFile(join(dir, 'a.md'), 'utf8')).toBe('existing')
    expect(await onlyFiles(dir)).toEqual(['a.md', 'b.md'])
  })
})

describe('Windows device names', () => {
  it('recognises reserved names with any extension, any case and spaces before the dot', () => {
    for (const name of ['CON.md', 'con.md', 'Nul.tar.md', 'aux', 'COM1.md', 'lpt9.MD', 'CON .md', 'com¹.md', 'CONIN$.md']) {
      expect(isWindowsDeviceName(name)).toBe(true)
    }
    for (const name of ['CONSOLE.md', 'con-2.md', 'Aux armes.md', 'com10.md', 'xcon.md', 'nul_.md', '.con.md']) {
      expect(isWindowsDeviceName(name)).toBe(false)
    }
  })

  // 审查 SEC-02：原来用 `/ +$/` 去掉结尾的空格，一长串空格后面跟别的字符时是平方级回溯；Windows 上回收站记录里的
  // 每个路径都逐段经过这里。约 20 万个字符的对抗输入，阈值按 CI 机器放宽到 200 ms，实测时间打印出来
  it('handles a long run of spaces in linear time (review SEC-02)', () => {
    const spaces = ' '.repeat(200_000)
    const started = performance.now()
    expect(isWindowsDeviceName(`a${spaces}b.md`)).toBe(false)
    expect(isWindowsDeviceName(`con${spaces}.md`)).toBe(true)
    expect(isWindowsDeviceName(`con${spaces}x.md`)).toBe(false)
    const ms = performance.now() - started
    console.log(`[SEC-02] device name check with 200k spaces: ${ms.toFixed(1)} ms`)
    expect(ms).toBeLessThan(200)
  })

  it('never creates a device name on Windows and takes the next candidate instead', async () => {
    const dir = await temp.make()
    const { name } = await createNoClobber(dir, ['CON.md', 'CON-01020304.md'], Buffer.from('x'), { platform: 'win32' })
    expect(name).toBe('CON-01020304.md')
    expect(await onlyFiles(dir)).toEqual(['CON-01020304.md'])
  })
})

describe('moveNoClobber', () => {
  it('moves to the first free name and removes the source', async () => {
    const dir = await temp.make()
    await mkdir(join(dir, 'trash'))
    await writeFile(join(dir, 'trash', 'x.md'), 'older')
    await writeFile(join(dir, 'x.md'), 'newer')
    const moved = await moveNoClobber(join(dir, 'x.md'), join(dir, 'trash'), ['x.md', 'x-2.md'])
    expect(moved).toBe('x-2.md')
    expect(await exists(join(dir, 'x.md'))).toBe(false)
    expect(await readFile(join(dir, 'trash', 'x.md'), 'utf8')).toBe('older')
    expect(await readFile(join(dir, 'trash', 'x-2.md'), 'utf8')).toBe('newer')
  })

  it('returns null and leaves both files alone when every candidate is taken', async () => {
    const dir = await temp.make()
    await mkdir(join(dir, 'dest'))
    await writeFile(join(dir, 'dest', 'x.md'), 'occupant')
    await writeFile(join(dir, 'x.md'), 'mover')
    expect(await moveNoClobber(join(dir, 'x.md'), join(dir, 'dest'), ['x.md'])).toBeNull()
    expect(await readFile(join(dir, 'x.md'), 'utf8')).toBe('mover')
    expect(await readFile(join(dir, 'dest', 'x.md'), 'utf8')).toBe('occupant')
  })

  it('never overwrites a destination that appears between the check and the move', async () => {
    const dir = await temp.make()
    await mkdir(join(dir, 'dest'))
    await writeFile(join(dir, 'x.md'), 'mover')
    const moved = await moveNoClobber(join(dir, 'x.md'), join(dir, 'dest'), ['x.md'], {
      hooks: { beforeLink: async (target) => { await writeFile(target, 'intruder') } },
    })
    expect(moved).toBeNull()
    expect(await readFile(join(dir, 'x.md'), 'utf8')).toBe('mover')
    expect(await readFile(join(dir, 'dest', 'x.md'), 'utf8')).toBe('intruder')
  })

  it('falls back to copy, verify and unlink when linking fails (EXDEV)', async () => {
    const dir = await temp.make()
    await mkdir(join(dir, 'dest'))
    await writeFile(join(dir, 'x.md'), 'payload')
    const moved = await moveNoClobber(join(dir, 'x.md'), join(dir, 'dest'), ['x.md'], {
      ops: { link: async () => { throw errno('EXDEV') } },
    })
    expect(moved).toBe('x.md')
    expect(await exists(join(dir, 'x.md'))).toBe(false)
    expect(await readFile(join(dir, 'dest', 'x.md'), 'utf8')).toBe('payload')
  })

  it('undoes the new link when the source cannot be removed, so the file is never in two places', async (ctx) => {
    if (!canTestPermissions) ctx.skip()
    const dir = await temp.make()
    await mkdir(join(dir, 'src'))
    await mkdir(join(dir, 'dest'))
    await writeFile(join(dir, 'src', 'x.md'), 'payload')
    await chmod(join(dir, 'src'), 0o555)
    await expect(moveNoClobber(join(dir, 'src', 'x.md'), join(dir, 'dest'), ['x.md'])).rejects.toMatchObject({ code: 'EACCES' })
    await chmod(join(dir, 'src'), 0o755)
    expect(await readFile(join(dir, 'src', 'x.md'), 'utf8')).toBe('payload')
    expect(await onlyFiles(join(dir, 'dest'))).toEqual([])
  })
})
