import { spawnSync } from 'node:child_process'
import { mkdir, readdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { IndexCache, deriveIndex } from '../../src/library/index-cache.ts'
import { KeyedQueue } from '../../src/library/queue.ts'
import { indexedFromText } from '../../src/library/scan.ts'
import { RECORD_FILE, recordLockTarget } from '../../src/library/trash.ts'
import { bindingFor, installCrashTraps, listAll, makeService, promptFile, readText, testLockDir, useTempDirs, writeTree } from './helpers.ts'

installCrashTraps()
const temp = useTempDirs()

const BASE = promptFile({ id: 'prompt_20261101_000000_abcdef01', title: 'T', favorite: 'false', updated: '2026-01-01T00:00:00Z' }, 'v0\n')

describe('KeyedQueue', () => {
  it('runs operations of one key one at a time, in order, and keeps going after a failure', async () => {
    const queue = new KeyedQueue()
    const log: string[] = []
    let running = 0
    const op = (name: string, fail = false) => async (): Promise<string> => {
      running++
      expect(running).toBe(1)
      log.push(`start ${name}`)
      await new Promise(resolve => setTimeout(resolve, 5))
      log.push(`end ${name}`)
      running--
      if (fail) throw new Error(`failed ${name}`)
      return name
    }
    const results = await Promise.allSettled([queue.run('k', op('a')), queue.run('k', op('b', true)), queue.run('k', op('c'))])
    expect(results.map(result => result.status)).toEqual(['fulfilled', 'rejected', 'fulfilled'])
    expect(log).toEqual(['start a', 'end a', 'start b', 'end b', 'start c', 'end c'])
    expect(queue.size).toBe(0)
  })

  it('runs different keys independently', async () => {
    const queue = new KeyedQueue()
    let release = (): void => undefined
    const blocker = new Promise<void>((resolve) => {
      release = resolve
    })
    const slow = queue.run('a', async () => {
      await blocker
      return 'a'
    })
    expect(await queue.run('b', async () => 'b')).toBe('b')
    release()
    expect(await slow).toBe('a')
  })
})

describe('serialized mutations (S05)', () => {
  it('serializes title checks across profiles saving to different folders of the same library', async () => {
    const root = await temp.make()
    const first = makeService(root)
    const second = makeService(root)
    const params = { text: 'body', binding: null, mode: 'normal', requestId: '' } as const
    const attempts = await Promise.allSettled([
      first.save({ ...params, folder: 'first', metadata: { title: 'Same Title', tags: [] } }),
      second.save({ ...params, folder: 'second', metadata: { title: 'same title', tags: [] } }),
    ])
    const failed = attempts.find(result => result.status === 'rejected')
    expect(failed?.reason).toMatchObject({ code: 'promptx/library/duplicate-title' })
    expect((await listAll(first)).entries).toHaveLength(1)
  })

  it('a favorite toggled while a save is in flight does not revert the save', async () => {
    const root = await temp.make()
    await writeTree(root, { 'a.md': BASE })
    const service = makeService(root)
    const binding = await bindingFor(service, root, 'a.md')
    const [save, meta] = await Promise.all([
      service.save({ text: 'v1\n', binding, folder: null, mode: 'normal', requestId: '' }),
      service.updateMeta({ relPath: 'a.md', patch: { favorite: true }, addFrontMatter: false }),
    ])
    expect(save.kind).toBe('saved')
    expect(meta.kind).toBe('saved')
    const text = await readText(root, 'a.md')
    expect(text).toContain('favorite: true')
    expect(text.endsWith('---\nv1\n')).toBe(true)
  })

  it('a save queued after a favorite reports the change instead of overwriting it', async () => {
    const root = await temp.make()
    await writeTree(root, { 'a.md': BASE })
    const service = makeService(root)
    const binding = await bindingFor(service, root, 'a.md')
    const [meta, save] = await Promise.all([
      service.updateMeta({ relPath: 'a.md', patch: { favorite: true }, addFrontMatter: false }),
      service.save({ text: 'v1\n', binding, folder: null, mode: 'normal', requestId: '' }),
    ])
    expect(meta.kind).toBe('saved')
    expect(save).toEqual({ kind: 'conflict', conflict: 'modified' })
    const text = await readText(root, 'a.md')
    expect(text).toContain('favorite: true')
    expect(text.endsWith('---\nv0\n')).toBe(true)
  })

  it('a second save with the stale binding is reported, not written over the first one', async () => {
    const root = await temp.make()
    await writeTree(root, { 'a.md': BASE })
    const service = makeService(root)
    const binding = await bindingFor(service, root, 'a.md')
    const [first, second] = await Promise.all([
      service.save({ text: 'first\n', binding, folder: null, mode: 'normal', requestId: '' }),
      service.save({ text: 'second\n', binding, folder: null, mode: 'normal', requestId: '' }),
    ])
    expect(first.kind).toBe('saved')
    expect(second).toEqual({ kind: 'conflict', conflict: 'modified' })
    expect((await readText(root, 'a.md')).endsWith('---\nfirst\n')).toBe(true)
    if (first.kind !== 'saved') return
    const third = await service.save({ text: 'third\n', binding: first.binding, folder: null, mode: 'normal', requestId: '' })
    expect(third.kind).toBe('saved')
  })

  it('concurrent deletes of files with the same name from two processes keep both recoverable', async () => {
    const root = await temp.make()
    await writeTree(root, {
      '写作/未命名 Prompt.md': 'from 写作',
      '评审/未命名 Prompt.md': 'from 评审',
      '其他/未命名 Prompt.md': 'from 其他',
    })
    // 两个服务实例各有自己的修改队列，相当于两个 profile 的 Host；只靠回收站记录的跨进程锁和不覆盖的移动协调
    const first = makeService(root)
    const second = makeService(root)
    const results = await Promise.all([
      first.delete('写作/未命名 Prompt.md'),
      second.delete('评审/未命名 Prompt.md'),
      first.delete('其他/未命名 Prompt.md'),
    ])
    const names = results.map(result => result.trashFile)
    expect(new Set(names).size).toBe(3)
    const record = JSON.parse(await readFile(join(root, '_trash', RECORD_FILE), 'utf8')) as { items: Array<{ file: string; originalPath: string }> }
    expect(record.items.map(item => item.originalPath).sort()).toEqual(['其他/未命名 Prompt.md', '写作/未命名 Prompt.md', '评审/未命名 Prompt.md'].sort())
    for (const item of record.items) {
      expect(await readText(root, `_trash/${item.file}`)).toBe(`from ${item.originalPath.split('/')[0] ?? ''}`)
    }
    for (const name of names) {
      const restored = await second.trashRestore({ file: name, target: 'original', alternative: null, acceptModified: false })
      expect(restored.kind).toBe('restored')
    }
    expect(await readText(root, '写作/未命名 Prompt.md')).toBe('from 写作')
    expect(await readText(root, '评审/未命名 Prompt.md')).toBe('from 评审')
    expect(await readText(root, '其他/未命名 Prompt.md')).toBe('from 其他')
  })

  it('takes over a record lock left behind by a process that no longer exists', async () => {
    const root = await temp.make()
    await writeTree(root, { 'a.md': 'payload' })
    const dead = spawnSync(process.execPath, ['-e', '']).pid
    expect(typeof dead).toBe('number')
    await mkdir(join(root, '_trash'))
    // 锁在 lockDir 里、按回收站目录的 realpath 命名，不在库里（审查 SEC-03）
    const lockDir = testLockDir()
    await mkdir(lockDir, { recursive: true })
    const lockFile = `${recordLockTarget(lockDir, await realpath(join(root, '_trash')))}.lock`
    await writeFile(lockFile, `${String(dead)}\n`)
    expect(await makeService(root).delete('a.md')).toEqual({ trashFile: 'a.md' })
    expect(await readdir(lockDir)).toEqual([])
  })
})

describe('index updates racing with a refresh', () => {
  async function bigLibrary(count: number): Promise<string> {
    const root = await temp.make()
    const files: Record<string, string> = {}
    for (let index = 0; index < count; index++) files[`dir${index % 10}/p${index}.md`] = promptFile({ title: `P${index}` }, 'x'.repeat(500))
    await writeTree(root, files)
    return root
  }

  it('does not lose a file saved while a refresh is running', async () => {
    const root = await bigLibrary(300)
    const service = makeService(root)
    const refreshing = listAll(service)
    const saved = await service.save({ text: '# Saved during scan\n', binding: null, folder: null, mode: 'normal', requestId: '' })
    await refreshing
    expect(saved.kind).toBe('saved')
    const listed = await listAll(service, { refresh: false, query: 'saved during' })
    expect(listed.entries.map(entry => entry.relPath)).toEqual(['Saved during scan.md'])
    expect(listed.total).toBe(301)
  })

  it('does not bring back a file deleted while a refresh is running', async () => {
    const root = await bigLibrary(300)
    const service = makeService(root)
    const refreshing = listAll(service)
    await service.delete('dir3/p3.md')
    await refreshing
    const listed = await listAll(service, { refresh: false })
    expect(listed.total).toBe(299)
    expect(listed.entries.some(entry => entry.relPath === 'dir3/p3.md')).toBe(false)
  })

  it('applies changes recorded during a scan before committing it', async () => {
    const root = await bigLibrary(100)
    const rootReal = await realpath(root)
    const cache = new IndexCache()
    const scanning = cache.refresh(rootReal, { skipRealpaths: [], platform: process.platform })
    cache.record(rootReal, 'new/x.md', indexedFromText('new/x.md', '# X\n', { mtimeMs: 0, ctimeMs: 0, ino: 0, size: 4 }))
    cache.record(rootReal, 'dir1/p1.md', null)
    const index = await scanning
    expect(index.files.has('new/x.md')).toBe(true)
    expect(index.files.has('dir1/p1.md')).toBe(false)
    expect(index.folders.has('new')).toBe(true)
    expect(cache.current(rootReal)).toBe(index)
    expect(deriveIndex(index).docs).toHaveLength(100)
  })

  it('does not commit a scan that started before reset()', async () => {
    const root = await bigLibrary(50)
    const rootReal = await realpath(root)
    const cache = new IndexCache()
    const scanning = cache.refresh(rootReal, { skipRealpaths: [], platform: process.platform })
    cache.reset()
    expect((await scanning).files.size).toBe(50)
    expect(cache.current(rootReal)).toBeNull()
  })

  it('keeps the newest of two overlapping refreshes', async () => {
    const root = await bigLibrary(50)
    const service = makeService(root)
    const first = listAll(service)
    await writeTree(root, { 'late.md': '# Late\n' })
    const second = listAll(service)
    await Promise.all([first, second])
    expect((await listAll(service, { refresh: false })).total).toBe(51)
  })
})
