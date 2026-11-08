import { execFileSync } from 'node:child_process'
import { constants } from 'node:fs'
import { lstat, mkdir, open, readdir, readFile, readlink, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { RECORD_FILE, recordLockTarget } from '../../src/library/trash.ts'
import {
  bindingFor,
  exists,
  installCrashTraps,
  makeService,
  readText,
  sha256Of,
  snapshotTree,
  testLockDir,
  trySymlink,
  useTempDirs,
  writeTree,
} from './helpers.ts'

installCrashTraps()
const temp = useTempDirs()

// 审查 SEC-03：回收站记录锁原来是库里的 `_trash/.promptx-trash.json.lock`，withFileLock 信任那里已有的任何东西。
// 共享仓库里提交上来一个写着存活 pid 的锁文件，每次删除、恢复都要等满 10 秒再失败；锁是指向命名管道的符号链接时，
// 读锁文件会永远卡住，同一个库的修改队列跟着卡死，之后的保存也全部卡住。锁现在放在 lockDir（`<dsh>/promptx/locks`）里。

const PROMPT = '---\nid: prompt_20261101_000000_abcdef01\ntitle: A\n---\n# A\n'
const LEGACY_LOCK = `${RECORD_FILE}.lock`

/** promise 在 ms 内没有结果就判失败：原来的实现会等满 10 秒或者永远卡住。结束后清掉计时器。 */
async function within<T>(promise: Promise<T>, ms = 5000): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`still pending after ${ms} ms`))
    }, ms)
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    clearTimeout(timer)
  }
}

async function lockFileOf(lockDir: string, root: string): Promise<string> {
  return `${recordLockTarget(lockDir, await realpath(join(root, '_trash')))}.lock`
}

describe('trash record lock outside the library (review SEC-03)', () => {
  it('names the lock after the first 16 hex digits of the SHA-256 of the trash realpath', () => {
    const trash = join('/', 'Users', 'me', 'Prompts', '_trash')
    expect(recordLockTarget(join('/', 'locks'), trash)).toBe(join('/', 'locks', `trash-${sha256Of(trash).slice(0, 16)}`))
  })

  it('holds the lock in lockDir (created on demand) while deleting and restoring, and adds nothing else to the library', async () => {
    const root = await temp.make()
    const lockDir = join(await temp.make(), 'not', 'yet')
    await writeTree(root, { 'a.md': PROMPT, 'b.md': '# B\n' })
    const observed: Array<{ locked: boolean; holder: string; trash: string[] }> = []
    const observe = async (): Promise<void> => {
      const lockFile = await lockFileOf(lockDir, root)
      const locked = await exists(lockFile)
      observed.push({ locked, holder: locked ? await readFile(lockFile, 'utf8') : '', trash: (await readdir(join(root, '_trash'))).sort() })
    }
    const service = makeService(root, { lockDir }, { hooks: { beforeRecordWrite: observe, beforeLink: observe } })
    expect(await service.delete('a.md')).toEqual({ trashFile: 'a.md' })
    expect(await service.trashRestore({ file: 'a.md', target: 'original', alternative: null, acceptModified: false }))
      .toEqual({ kind: 'restored', relPath: 'a.md' })
    // 删除：移进回收站之前、写记录之前；恢复：移回库里之前。每一步锁都在 lockDir 里，回收站里没有锁文件
    expect(observed).toEqual([
      { locked: true, holder: `${process.pid}\n`, trash: [] },
      { locked: true, holder: `${process.pid}\n`, trash: ['a.md'] },
      { locked: true, holder: `${process.pid}\n`, trash: [RECORD_FILE, 'a.md'].sort() },
    ])
    expect(await readdir(lockDir)).toEqual([])
    expect([...(await snapshotTree(root)).keys()].sort()).toEqual(['_trash', `_trash/${RECORD_FILE}`, 'a.md', 'b.md'].sort())
    expect(await readText(root, 'a.md')).toBe(PROMPT)
  })

  it('ignores a lock file with a live pid planted in _trash: delete, restore and later saves go through', async () => {
    const root = await temp.make()
    await writeTree(root, { 'a.md': PROMPT, [`_trash/${LEGACY_LOCK}`]: `${process.pid}\n` })
    const service = makeService(root)
    const started = performance.now()
    expect(await within(service.delete('a.md'))).toEqual({ trashFile: 'a.md' })
    expect(await within(service.trashRestore({ file: 'a.md', target: 'original', alternative: null, acceptModified: false })))
      .toEqual({ kind: 'restored', relPath: 'a.md' })
    const binding = await bindingFor(service, root, 'a.md')
    expect((await within(service.save({ text: '# A\nedited\n', binding, folder: null, mode: 'normal', requestId: '' }))).kind).toBe('saved')
    console.log(`[SEC-03] delete, restore and save next to a planted lock: ${(performance.now() - started).toFixed(0)} ms`)
    // 用户放在回收站里的东西原样留着，也不出现在回收站列表里
    expect(await readText(root, `_trash/${LEGACY_LOCK}`)).toBe(`${process.pid}\n`)
    expect((await service.trashList('')).entries).toEqual([])
  })

  it('ignores a planted lock that is a symbolic link to a named pipe (POSIX)', async (ctx) => {
    if (process.platform === 'win32') ctx.skip()
    const root = await temp.make()
    const outside = await temp.make()
    const fifo = join(outside, 'pipe')
    execFileSync('mkfifo', [fifo])
    await writeTree(root, { 'a.md': PROMPT, 'b.md': '# B\n' })
    await mkdir(join(root, '_trash'))
    const planted = join(root, '_trash', LEGACY_LOCK)
    await symlink(fifo, planted)
    ctx.onTestFinished(async () => {
      // 万一实现退回去读这把锁：先拿掉链接，再以非阻塞方式打开管道的写端，放开卡在 open 上的读者，不留卡住的线程
      await rm(planted, { force: true })
      try {
        const writer = await open(fifo, constants.O_WRONLY | constants.O_NONBLOCK)
        await writer.close()
      } catch {
        // 没有读者（ENXIO）：什么都没卡住
      }
    })
    const service = makeService(root)
    expect(await within(service.delete('a.md'))).toEqual({ trashFile: 'a.md' })
    expect(await within(service.trashRestore({ file: 'a.md', target: 'original', alternative: null, acceptModified: false })))
      .toEqual({ kind: 'restored', relPath: 'a.md' })
    // 同一个库后面排队的修改不会被卡住
    expect(await within(service.delete('b.md'))).toEqual({ trashFile: 'b.md' })
    const binding = await bindingFor(service, root, 'a.md')
    expect((await within(service.save({ text: '# A\nedited\n', binding, folder: null, mode: 'normal', requestId: '' }))).kind).toBe('saved')
    expect((await lstat(planted)).isSymbolicLink()).toBe(true)
    expect(await readlink(planted)).toBe(fifo)
  })

  it('maps a lock held by a live process to record-failed lock-timeout and changes nothing', async () => {
    const root = await temp.make()
    await writeTree(root, { 'a.md': PROMPT })
    await mkdir(join(root, '_trash'))
    const lockDir = testLockDir()
    await mkdir(lockDir, { recursive: true })
    const lockFile = await lockFileOf(lockDir, root)
    await writeFile(lockFile, `${process.pid}\n`)
    const service = makeService(root, {}, { recordLockWaitMs: 100 })
    await expect(service.delete('a.md')).rejects.toMatchObject({ code: 'promptx/trash/record-failed', detail: 'lock-timeout' })
    expect(await readText(root, 'a.md')).toBe(PROMPT)
    expect(await readdir(join(root, '_trash'))).toEqual([])
    expect(await readFile(lockFile, 'utf8')).toBe(`${process.pid}\n`)
  })

  it('reports a lock directory that cannot be created as record-failed with the system error, and changes nothing', async () => {
    const root = await temp.make()
    const elsewhere = await temp.make()
    await writeTree(root, { 'a.md': PROMPT })
    await writeFile(join(elsewhere, 'file'), 'not a directory')
    const service = makeService(root, { lockDir: join(elsewhere, 'file', 'locks') })
    await expect(service.delete('a.md')).rejects.toMatchObject({ code: 'promptx/trash/record-failed', detail: expect.stringMatching(/^E[A-Z]+: /) as string })
    expect(await readText(root, 'a.md')).toBe(PROMPT)
    expect(await readdir(join(root, '_trash'))).toEqual([])
  })

  it('uses the same lock for the same library configured through a symbolic link', async (ctx) => {
    const root = await temp.make()
    const parent = await temp.make()
    await writeTree(root, { 'a.md': PROMPT })
    await mkdir(join(root, '_trash'))
    const link = join(parent, 'library-link')
    if (!(await trySymlink(root, link, 'dir'))) ctx.skip()
    const lockDir = testLockDir()
    await mkdir(lockDir, { recursive: true })
    // 另一个 profile 按真实路径拿着锁：经过链接配置的库也要等它
    await writeFile(await lockFileOf(lockDir, root), `${process.pid}\n`)
    await expect(makeService(link, {}, { recordLockWaitMs: 100 }).delete('a.md'))
      .rejects.toMatchObject({ code: 'promptx/trash/record-failed', detail: 'lock-timeout' })
    expect(await exists(join(root, 'a.md'))).toBe(true)
  })
})
