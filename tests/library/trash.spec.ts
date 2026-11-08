import { execFileSync } from 'node:child_process'
import { chmod, lstat, mkdir, readdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  MAX_RECORD_BYTES,
  MAX_RECORD_PATH_CHARS,
  RECORD_FILE,
  RECORD_FULL,
  numberedNames,
  readTrashRecord,
  trashNameCandidates,
  writeTrashRecord,
  WINDOWS_MAX_RECORD_PATH_CHARS,
  type TrashItem,
} from '../../src/library/trash.ts'
import {
  NOW_STAMP,
  canTestPermissions,
  exists,
  installCrashTraps,
  listAll,
  makeService,
  promptFile,
  readText,
  sha256Of,
  trySymlink,
  useTempDirs,
  writeTree,
} from './helpers.ts'

installCrashTraps()
const temp = useTempDirs()

const PROMPT = promptFile({ id: 'prompt_20261101_000000_abcdef01', title: '代码审查清单', tags: '[代码]', favorite: 'true' }, '# 代码审查\n\n检查边界条件。\n')

interface RecordShape {
  version: number
  items: Array<{ file: string; originalPath: string; deletedAt: string; sha256: string; size: number }>
}

async function readRecord(root: string): Promise<RecordShape> {
  return JSON.parse(await readFile(join(root, '_trash', RECORD_FILE), 'utf8')) as RecordShape
}

async function trashFiles(root: string): Promise<string[]> {
  return (await readdir(join(root, '_trash'))).sort()
}

/** 一条格式合格的记录项（摘要对不对不影响这里的测试）。 */
function item(file: string, originalPath: string): TrashItem {
  return { file, originalPath, deletedAt: '2026-11-01T00:00:00Z', sha256: '0'.repeat(64), size: 1 }
}

describe('delete (L-11, 6.4)', () => {
  it('moves the file into _trash unchanged and records where it came from', async () => {
    const root = await temp.make()
    await writeTree(root, { '写作/代码审查清单.md': PROMPT, 'other.md': '# Other\n' })
    const service = makeService(root)
    expect((await listAll(service)).total).toBe(2)
    expect(await service.delete('写作/代码审查清单.md')).toEqual({ trashFile: '代码审查清单.md' })
    expect(await exists(join(root, '写作', '代码审查清单.md'))).toBe(false)
    expect(await readText(root, '_trash/代码审查清单.md')).toBe(PROMPT)
    expect(await readRecord(root)).toEqual({
      version: 1,
      items: [{ file: '代码审查清单.md', originalPath: '写作/代码审查清单.md', deletedAt: NOW_STAMP, sha256: sha256Of(PROMPT), size: Buffer.byteLength(PROMPT) }],
    })
    const listed = await listAll(service, { refresh: false })
    expect(listed.entries.map(entry => entry.relPath)).toEqual(['other.md'])
    expect((await listAll(service)).total).toBe(1)
    expect(await service.trashList('')).toEqual({
      recordState: 'ok',
      entries: [{ file: '代码审查清单.md', title: '代码审查清单', deletedAt: Date.parse(NOW_STAMP), originalPath: '写作/代码审查清单.md' }],
    })
  })

  it('adds a number when the name is already taken in _trash', async () => {
    const root = await temp.make()
    await writeTree(root, { 'a/x.md': 'first', 'b/x.md': 'second', 'c/X.md': 'third' })
    const service = makeService(root)
    expect(await service.delete('a/x.md')).toEqual({ trashFile: 'x.md' })
    expect(await service.delete('b/x.md')).toEqual({ trashFile: 'x-2.md' })
    expect(await service.delete('c/X.md')).toEqual({ trashFile: 'X-3.md' })
    const record = await readRecord(root)
    expect(record.items.map(item => [item.file, item.originalPath])).toEqual([['x.md', 'a/x.md'], ['x-2.md', 'b/x.md'], ['X-3.md', 'c/X.md']])
    expect(await readText(root, '_trash/x.md')).toBe('first')
    expect(await readText(root, '_trash/x-2.md')).toBe('second')
  })

  it('reports missing files, invalid paths and paths inside the trash', async () => {
    const root = await temp.make()
    await writeTree(root, { '_trash/x.md': 'x' })
    const service = makeService(root)
    await expect(service.delete('none.md')).rejects.toMatchObject({ code: 'promptx/library/not-found' })
    await expect(service.delete('../x.md')).rejects.toMatchObject({ code: 'promptx/library/invalid-path' })
    await expect(service.delete('_trash/x.md')).rejects.toMatchObject({ code: 'promptx/library/invalid-path' })
    await expect(makeService(join(root, 'missing')).delete('a.md')).rejects.toMatchObject({ code: 'promptx/library/not-found' })
  })

  it('moves the file back and reports the failure when the record cannot be written', async () => {
    const root = await temp.make()
    await writeTree(root, { '写作/a.md': PROMPT })
    const service = makeService(root, {}, { hooks: { beforeRecordWrite: async () => { throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' }) } } })
    await expect(service.delete('写作/a.md')).rejects.toMatchObject({ code: 'promptx/trash/record-failed', detail: 'ENOSPC: no space left on device' })
    expect(await readText(root, '写作/a.md')).toBe(PROMPT)
    expect(await trashFiles(root)).toEqual([])
  })

  it('moves the file back when it cannot be read to record its digest (POSIX)', async (ctx) => {
    if (!canTestPermissions) ctx.skip()
    const root = await temp.make()
    await writeTree(root, { '写作/locked.md': PROMPT })
    await chmod(join(root, '写作', 'locked.md'), 0o000)
    await expect(makeService(root).delete('写作/locked.md')).rejects.toMatchObject({ code: 'promptx/library/move-failed', detail: 'EACCES: permission denied' })
    await chmod(join(root, '写作', 'locked.md'), 0o644)
    expect(await readText(root, '写作/locked.md')).toBe(PROMPT)
    expect(await trashFiles(root)).toEqual([])
  })

  it('refuses to move files into a _trash that is a symbolic link', async (ctx) => {
    const root = await temp.make()
    const outside = await temp.make()
    await writeTree(root, { 'a.md': PROMPT })
    if (!(await trySymlink(outside, join(root, '_trash'), 'dir'))) ctx.skip()
    await expect(makeService(root).delete('a.md')).rejects.toMatchObject({ code: 'promptx/library/move-failed' })
    expect(await readText(root, 'a.md')).toBe(PROMPT)
    expect(await readdir(outside)).toEqual([])
  })
})

describe('restore (L-11, 6.4)', () => {
  it('restores to the original folder byte for byte, recreating missing folders (L-11 acceptance 1)', async () => {
    const root = await temp.make()
    await writeTree(root, { '写作/评审/a.md': PROMPT })
    const service = makeService(root)
    await service.delete('写作/评审/a.md')
    await rm(join(root, '写作'), { recursive: true })
    expect(await service.trashRestore({ file: 'a.md', target: 'original', alternative: null, acceptModified: false }))
      .toEqual({ kind: 'restored', relPath: '写作/评审/a.md' })
    expect(await readText(root, '写作/评审/a.md')).toBe(PROMPT)
    expect((await readRecord(root)).items).toEqual([])
    expect(await trashFiles(root)).toEqual([RECORD_FILE])
    const listed = await listAll(service, { refresh: false })
    expect(listed.entries.map(entry => entry.relPath)).toEqual(['写作/评审/a.md'])
    expect(listed.folders).toEqual(['写作', '写作/评审'])
  })

  it('offers an alternative path when the original is taken and never overwrites it (L-11 acceptance 2)', async () => {
    const root = await temp.make()
    await writeTree(root, { '写作/x.md': PROMPT })
    const service = makeService(root)
    await service.delete('写作/x.md')
    await writeTree(root, { '写作/x.md': 'new file at the old place' })
    expect(await service.trashRestore({ file: 'x.md', target: 'original', alternative: null, acceptModified: false }))
      .toEqual({ kind: 'occupied', alternative: '写作/x-2.md' })
    expect(await readText(root, '写作/x.md')).toBe('new file at the old place')
    expect(await service.trashRestore({ file: 'x.md', target: 'alternative', alternative: '写作/x-2.md', acceptModified: false }))
      .toEqual({ kind: 'restored', relPath: '写作/x-2.md' })
    expect(await readText(root, '写作/x-2.md')).toBe(PROMPT)
    expect(await readText(root, '写作/x.md')).toBe('new file at the old place')
  })

  it('treats a name that differs only by case as taken', async () => {
    const root = await temp.make()
    await writeTree(root, { 'note.md': PROMPT })
    const service = makeService(root)
    await service.delete('note.md')
    await writeTree(root, { 'Note.md': 'other' })
    expect(await service.trashRestore({ file: 'note.md', target: 'original', alternative: null, acceptModified: false }))
      .toEqual({ kind: 'occupied', alternative: 'note-2.md' })
  })

  it('returns a new alternative when the confirmed one was taken in the meantime', async () => {
    const root = await temp.make()
    await writeTree(root, { 'x.md': PROMPT })
    const service = makeService(root)
    await service.delete('x.md')
    await writeTree(root, { 'x.md': 'occupant', 'x-2.md': 'taken while the dialog was open' })
    expect(await service.trashRestore({ file: 'x.md', target: 'alternative', alternative: 'x-2.md', acceptModified: false }))
      .toEqual({ kind: 'occupied', alternative: 'x-3.md' })
    expect(await readText(root, 'x-2.md')).toBe('taken while the dialog was open')
    expect(await trashFiles(root)).toContain('x.md')
  })

  it('never overwrites a destination that appears between the check and the move', async () => {
    const root = await temp.make()
    await writeTree(root, { 'x.md': PROMPT })
    // 服务内部用库根目录的 realpath（macOS 的临时目录在 /var → /private/var 链接之下）
    const intruder = join(await realpath(root), 'x.md')
    let armed = false
    const service = makeService(root, {}, {
      hooks: {
        beforeLink: async (target) => {
          if (armed && target === intruder) await writeFile(target, 'intruder')
        },
      },
    })
    await service.delete('x.md')
    armed = true
    expect(await service.trashRestore({ file: 'x.md', target: 'original', alternative: null, acceptModified: false }))
      .toEqual({ kind: 'occupied', alternative: 'x-2.md' })
    expect(await readText(root, 'x.md')).toBe('intruder')
    expect(await readText(root, '_trash/x.md')).toBe(PROMPT)
    expect((await readRecord(root)).items.map(item => item.file)).toEqual(['x.md'])
  })

  it('warns when the trashed file was modified, and restores after confirmation', async () => {
    const root = await temp.make()
    await writeTree(root, { 'a.md': PROMPT })
    const service = makeService(root)
    await service.delete('a.md')
    await writeFile(join(root, '_trash', 'a.md'), `${PROMPT}edited in the trash\n`)
    expect(await service.trashRestore({ file: 'a.md', target: 'original', alternative: null, acceptModified: false })).toEqual({ kind: 'modified' })
    expect(await service.trashRestore({ file: 'a.md', target: 'original', alternative: null, acceptModified: true }))
      .toEqual({ kind: 'restored', relPath: 'a.md' })
    expect(await readText(root, 'a.md')).toBe(`${PROMPT}edited in the trash\n`)
  })

  it('reports a trashed file that was removed outside the plugin as missing', async () => {
    const root = await temp.make()
    await writeTree(root, { 'a.md': PROMPT })
    const service = makeService(root)
    await service.delete('a.md')
    await rm(join(root, '_trash', 'a.md'))
    expect(await service.trashRestore({ file: 'a.md', target: 'original', alternative: null, acceptModified: false })).toEqual({ kind: 'missing' })
    expect(await makeService(join(root, 'none')).trashRestore({ file: 'a.md', target: 'original', alternative: null, acceptModified: false }))
      .toEqual({ kind: 'missing' })
  })

  it('deletes and restores files without front matter byte for byte', async () => {
    const root = await temp.make()
    const plain = Buffer.from('﻿plain text\r\nno front matter\r\n', 'utf8')
    await writeTree(root, { 'notes/plain.md': plain })
    const service = makeService(root)
    await service.delete('notes/plain.md')
    await service.trashRestore({ file: 'plain.md', target: 'original', alternative: null, acceptModified: false })
    expect(await readFile(join(root, 'notes', 'plain.md'))).toEqual(plain)
  })

  it('keeps one record item when the same name is deleted, restored and deleted again', async () => {
    const root = await temp.make()
    await writeTree(root, { 'a.md': PROMPT })
    const service = makeService(root)
    await service.delete('a.md')
    await service.trashRestore({ file: 'a.md', target: 'original', alternative: null, acceptModified: false })
    await service.delete('a.md')
    expect((await readRecord(root)).items.map(item => item.file)).toEqual(['a.md'])
    expect((await service.trashList('')).entries[0]?.originalPath).toBe('a.md')
  })

  it('validates the requested file name and alternative', async () => {
    const root = await temp.make()
    const service = makeService(root)
    for (const file of ['../a.md', 'sub/a.md', '.promptx-trash.json', 'a.txt', '']) {
      await expect(service.trashRestore({ file, target: 'original', alternative: null, acceptModified: false }))
        .rejects.toMatchObject({ code: 'promptx/library/invalid-path' })
    }
    await expect(service.trashRestore({ file: 'a.md', target: 'alternative', alternative: '../a.md', acceptModified: false }))
      .rejects.toMatchObject({ code: 'promptx/library/invalid-path' })
    for (const params of [
      { file: 'a.md', target: 'elsewhere', alternative: null, acceptModified: false },
      { file: 'a.md', target: 'original', alternative: null, acceptModified: 'yes' },
      { file: 'a.md', target: 'alternative', alternative: 5, acceptModified: false },
    ]) {
      await expect(service.trashRestore(params as unknown as Parameters<typeof service.trashRestore>[0]))
        .rejects.toMatchObject({ code: 'promptx/internal', detail: 'invalid-params' })
    }
  })

  it('restores to the original place when the alternative target comes without a path', async () => {
    const root = await temp.make()
    await writeTree(root, { 'a.md': PROMPT })
    const service = makeService(root)
    await service.delete('a.md')
    expect(await service.trashRestore({ file: 'a.md', target: 'alternative', alternative: null, acceptModified: false }))
      .toEqual({ kind: 'restored', relPath: 'a.md' })
  })
})

describe('trash record problems (design-spec 7.3, S02)', () => {
  it('shows every file as original location unknown when the record is unreadable, and restores to the root', async () => {
    const root = await temp.make()
    await writeTree(root, { '_trash/a.md': '# A\n', [`_trash/${RECORD_FILE}`]: '{ not json' })
    const service = makeService(root)
    expect(await service.trashList('')).toEqual({ recordState: 'unreadable', entries: [{ file: 'a.md', title: 'A', deletedAt: null, originalPath: null }] })
    expect(await service.trashRestore({ file: 'a.md', target: 'original', alternative: null, acceptModified: false }))
      .toEqual({ kind: 'restored', relPath: 'a.md' })
    // 读不出来的记录不改写
    expect(await readText(root, `_trash/${RECORD_FILE}`)).toBe('{ not json')
  })

  it('sets an unreadable record aside on the next delete and starts a fresh one', async () => {
    const root = await temp.make()
    await writeTree(root, { 'b.md': '# B\n', [`_trash/${RECORD_FILE}`]: '{"version": 2, "items": []}' })
    const service = makeService(root)
    expect((await service.trashList('')).recordState).toBe('unreadable')
    await service.delete('b.md')
    const files = await trashFiles(root)
    expect(files).toContain('.promptx-trash.broken-20261108T120000Z.json')
    expect(await readText(root, '_trash/.promptx-trash.broken-20261108T120000Z.json')).toBe('{"version": 2, "items": []}')
    expect((await readRecord(root)).items.map(item => item.originalPath)).toEqual(['b.md'])
  })

  it('treats files without a record as original location unknown', async () => {
    const root = await temp.make()
    await writeTree(root, { '_trash/manual.md': '# Manual\n' })
    const service = makeService(root)
    expect(await service.trashList('')).toEqual({ recordState: 'missing', entries: [{ file: 'manual.md', title: 'Manual', deletedAt: null, originalPath: null }] })
    expect(await service.trashRestore({ file: 'manual.md', target: 'original', alternative: null, acceptModified: false }))
      .toEqual({ kind: 'restored', relPath: 'manual.md' })
  })

  it('ignores record items with unsafe or invalid paths and duplicate items', async () => {
    const root = await temp.make()
    const outside = await temp.make()
    const item = (file: string, originalPath: string): Record<string, unknown> =>
      ({ file, originalPath, deletedAt: '2026-11-01T00:00:00Z', sha256: sha256Of('# x\n'), size: 4 })
    const record = {
      version: 1,
      items: [
        item('escape.md', `../${outside.split('/').pop() ?? 'x'}/escape.md`),
        item('abs.md', '/etc/abs.md'),
        item('intrash.md', '_trash/intrash.md'),
        item('notmd.md', 'folder/notmd.txt'),
        item('dup.md', 'one/dup.md'),
        item('dup.md', 'two/dup.md'),
        item('../sneaky.md', 'ok/sneaky.md'),
        { file: 'bad-hash.md', originalPath: 'ok/bad-hash.md', deletedAt: '2026-11-01T00:00:00Z', sha256: 'nope', size: 4 },
        item('fine.md', 'ok/fine.md'),
      ],
    }
    const files: Record<string, string> = { [`_trash/${RECORD_FILE}`]: JSON.stringify(record) }
    for (const name of ['escape.md', 'abs.md', 'intrash.md', 'notmd.md', 'dup.md', 'bad-hash.md', 'fine.md']) files[`_trash/${name}`] = '# x\n'
    await writeTree(root, files)
    const service = makeService(root)
    const entries = new Map((await service.trashList('')).entries.map(entry => [entry.file, entry.originalPath]))
    expect(entries.get('fine.md')).toBe('ok/fine.md')
    for (const name of ['escape.md', 'abs.md', 'intrash.md', 'notmd.md', 'dup.md', 'bad-hash.md']) expect(entries.get(name)).toBeNull()
    expect(await service.trashRestore({ file: 'escape.md', target: 'original', alternative: null, acceptModified: false }))
      .toEqual({ kind: 'restored', relPath: 'escape.md' })
    expect(await exists(join(root, 'escape.md'))).toBe(true)
    expect(await readdir(outside)).toEqual([])
  })

  // 审查 SEC-02：记录来自库目录，可能是共享仓库或同步工具带来的。超过上限的记录不读进内存解析，按读不出来处理，
  // 下一次删除时照常改名留着
  it('treats a record over 4 MiB as unreadable without parsing it, and sets it aside on the next delete (review SEC-02)', async () => {
    const root = await temp.make()
    const huge = JSON.stringify({ version: 1, items: [], padding: 'x'.repeat(MAX_RECORD_BYTES) })
    await writeTree(root, { 'b.md': '# B\n', '_trash/a.md': '# A\n', [`_trash/${RECORD_FILE}`]: huge })
    const service = makeService(root)
    expect(await service.trashList('')).toEqual({ recordState: 'unreadable', entries: [{ file: 'a.md', title: 'A', deletedAt: null, originalPath: null }] })
    await service.delete('b.md')
    expect(await readText(root, '_trash/.promptx-trash.broken-20261108T120000Z.json')).toBe(huge)
    expect((await readRecord(root)).items.map(item => item.originalPath)).toEqual(['b.md'])
  })

  // 外部审查第 4 条：读的时候超过 4 MiB 按读不出来处理，写的时候原来不查，一次正常删除就能把合格的记录写成读不出来，
  // 所有项都变成「原位置未知」。现在写之前查，超过上限就不写，删除回滚。
  it('refuses to write a record past the read limit and keeps the old one (external review 4)', async () => {
    const root = await temp.make()
    await mkdir(join(root, '_trash'), { recursive: true })
    const before = [item('a.md', 'a.md')]
    await writeTrashRecord(join(root, '_trash'), before)
    const original = await readFile(join(root, '_trash', RECORD_FILE))
    const longPath = `${'很长的文件夹'.repeat(150)}/x.md`
    const tooMany = Array.from({ length: Math.ceil(MAX_RECORD_BYTES / longPath.length) }, (_, index) => item(`f${index}.md`, longPath))
    await expect(writeTrashRecord(join(root, '_trash'), tooMany)).rejects.toMatchObject({ code: 'promptx/trash/record-failed', detail: RECORD_FULL })
    expect(await readFile(join(root, '_trash', RECORD_FILE))).toEqual(original)
  })

  it('rolls a delete back when its record item would push the record past the limit (external review 4)', async () => {
    const root = await temp.make()
    const trashDir = join(root, '_trash')
    // 一份读得出来、离上限只差约 100 字节的记录，每项的文件都真的在 `_trash/` 里
    const segment = '很长的文件夹名'.repeat(11)
    const longFolder = Array.from({ length: 12 }, (_, index) => `${segment}${index}`).join('/')
    const items: TrashItem[] = []
    const files: Record<string, string> = {}
    const sizeOf = (list: TrashItem[]): number => Buffer.byteLength(`${JSON.stringify({ version: 1, items: list }, null, 2)}\n`)
    const add = (originalPath: string): void => {
      const file = `f${items.length}.md`
      files[`_trash/${file}`] = `${items.length}\n`
      items.push({ ...item(file, originalPath), sha256: sha256Of(`${items.length}\n`), size: `${items.length}\n`.length })
    }
    const perItem = sizeOf([item('f0.md', `${longFolder}/f0.md`)]) - sizeOf([])
    // 先按估算一次加够（序号变长后每项会多几个字节，少加 3 项留出余量），再逐项补到只差两项的位置；整份序列化只做几次
    const count = Math.floor(MAX_RECORD_BYTES / perItem) - 3
    for (let index = 0; index < count; index++) add(`${longFolder}/f${index}.md`)
    while (sizeOf(items) + 2 * perItem < MAX_RECORD_BYTES) add(`${longFolder}/f${items.length}.md`)
    // 再用 3 字节的汉字路径补齐，让记录停在上限之下 100 到 102 字节。每个路径都要远在 MAX_RECORD_PATH_CHARS 之下，否则读的时候整项被丢掉：
    // 剩余空间大于 3,000 字节时先补一项 500 个字的，剩下的用一项补完
    for (;;) {
      const room = MAX_RECORD_BYTES - 100 - sizeOf([...items, item(`f${items.length}.md`, 'p/.md')])
      if (room <= 3000) {
        add(`p/${'补'.repeat(Math.floor(room / 3))}.md`)
        break
      }
      add(`p/${'补'.repeat(500)}.md`)
    }
    expect(sizeOf(items)).toBeLessThanOrEqual(MAX_RECORD_BYTES - 100)
    expect(sizeOf(items)).toBeGreaterThan(MAX_RECORD_BYTES - 103)
    await writeTree(root, { ...files, 'new.md': PROMPT })
    await writeTrashRecord(trashDir, items)
    // 比较摘要：4 MiB 的 Buffer 直接 toEqual 是逐字节的深比较，要好几秒
    const record = sha256Of(await readFile(join(trashDir, RECORD_FILE)))
    const trashBefore = await trashFiles(root)
    await expect(makeService(root).delete('new.md')).rejects.toMatchObject({ code: 'promptx/trash/record-failed', detail: RECORD_FULL })
    expect(await readText(root, 'new.md')).toBe(PROMPT)
    expect(await trashFiles(root)).toEqual(trashBefore)
    expect(sha256Of(await readFile(join(trashDir, RECORD_FILE)))).toBe(record)
    const reread = await readTrashRecord(trashDir)
    expect(reread.state).toBe('ok')
    expect(reread.items.size).toBe(items.length)
  })

  it('treats a record that is a named pipe or a symbolic link as unreadable without blocking or following it (POSIX)', async (ctx) => {
    if (process.platform === 'win32') ctx.skip()
    const root = await temp.make()
    const outside = await temp.make()
    await writeTree(root, { 'b.md': '# B\n', 'c.md': '# C\n', '_trash/a.md': '# A\n' })
    await writeTree(outside, { 'record.json': JSON.stringify({ version: 1, items: [] }) })
    execFileSync('mkfifo', [join(root, '_trash', RECORD_FILE)])
    const service = makeService(root)
    expect((await service.trashList('')).recordState).toBe('unreadable')
    await service.delete('b.md')
    expect((await lstat(join(root, '_trash', '.promptx-trash.broken-20261108T120000Z.json'))).isFIFO()).toBe(true)
    expect((await readRecord(root)).items.map(item => item.originalPath)).toEqual(['b.md'])
    await rm(join(root, '_trash', RECORD_FILE))
    await symlink(join(outside, 'record.json'), join(root, '_trash', RECORD_FILE))
    expect((await service.trashList('')).recordState).toBe('unreadable')
    await service.delete('c.md')
    expect((await lstat(join(root, '_trash', '.promptx-trash.broken-20261108T120000Z-2.json'))).isSymbolicLink()).toBe(true)
    expect(await readFile(join(outside, 'record.json'), 'utf8')).toBe(JSON.stringify({ version: 1, items: [] }))
  })

  // 外部审查复核：读的时候丢掉超过上限的原路径，写的时候原来不查；上限原来是 1,024，Linux 上文件夹很深的文件删除后就成了「原位置未知」
  it('reads back an original path longer than 1,024 characters that it wrote', async () => {
    const root = await temp.make()
    const trashDir = join(root, '_trash')
    const deep = `${Array.from({ length: 6 }, (_, index) => `${'d'.repeat(180)}${index}`).join('/')}/note.md`
    expect(deep.length).toBeGreaterThan(1024)
    await writeTree(root, { '_trash/note.md': '# x\n' })
    await writeTrashRecord(trashDir, [item('note.md', deep)])
    expect((await readTrashRecord(trashDir)).items.get('note.md')?.originalPath).toBe(deep)
  })

  // 外部审查第二轮复核：Windows 上 Node 用 `\\?\` 长路径，插件能删的文件相对路径可以超过 4,096 个码元
  it('reads back a Windows original path longer than 4,096 characters, and still drops one past 32,767', async () => {
    const root = await temp.make()
    const trashDir = join(root, '_trash')
    const folders = (count: number): string => Array.from({ length: count }, (_, index) => `${'d'.repeat(250)}${index}`).join('/')
    const deep = `${folders(17)}/note.md`
    const tooDeep = `${folders(130)}/far.md`
    expect(deep.length).toBeGreaterThan(MAX_RECORD_PATH_CHARS)
    expect(tooDeep.length).toBeGreaterThan(WINDOWS_MAX_RECORD_PATH_CHARS)
    await writeTree(root, { '_trash/note.md': '# x\n', '_trash/far.md': '# x\n' })
    await writeTrashRecord(trashDir, [item('note.md', deep), item('far.md', tooDeep)])
    const onWindows = await readTrashRecord(trashDir, 'win32')
    expect(onWindows.items.get('note.md')?.originalPath).toBe(deep)
    expect(onWindows.items.has('far.md')).toBe(false)
    // macOS、Linux 上照旧按 4,096 算：本机打不开的外来路径恢复到库根目录
    expect((await readTrashRecord(trashDir, 'linux')).items.has('note.md')).toBe(false)
  })

  it('ignores record paths longer than 4,096 characters before validating them (review SEC-02)', async () => {
    const root = await temp.make()
    const item = (file: string, originalPath: string): Record<string, unknown> =>
      ({ file, originalPath, deletedAt: '2026-11-01T00:00:00Z', sha256: sha256Of('# x\n'), size: 4 })
    // 除了长度，这个路径完全合格
    const long = `${'a/'.repeat(2100)}long.md`
    expect(long.length).toBeGreaterThan(MAX_RECORD_PATH_CHARS)
    await writeTree(root, {
      [`_trash/${RECORD_FILE}`]: JSON.stringify({ version: 1, items: [item('long.md', long), item('fine.md', 'ok/fine.md')] }),
      '_trash/long.md': '# x\n',
      '_trash/fine.md': '# x\n',
    })
    // 固定按 linux 读：Windows 上的上限是 32,767，CI 的 Windows 任务按本机平台读会把这个路径当成合格的。
    // Windows 的上限由上一条测试按 win32 检查
    const service = makeService(root, {}, { platform: 'linux' })
    const entries = new Map((await service.trashList('')).entries.map(entry => [entry.file, entry.originalPath]))
    expect(entries.get('long.md')).toBeNull()
    expect(entries.get('fine.md')).toBe('ok/fine.md')
  })

  // 原来在 Windows 上，40 KB 的记录就要 2.3 秒（设备名检查里的 `/ +$/` 是平方级回溯）。约 20 万个字符的对抗输入，
  // 阈值按 CI 机器放宽到 200 ms，实测时间打印出来
  it('reads a record full of adversarial Windows paths in linear time (review SEC-02)', async () => {
    const root = await temp.make()
    const spaces = ' '.repeat(200_000)
    const item = (file: string, originalPath: string): Record<string, unknown> =>
      ({ file, originalPath, deletedAt: '2026-11-01T00:00:00Z', sha256: sha256Of('# x\n'), size: 4 })
    await writeTree(root, {
      [`_trash/${RECORD_FILE}`]: JSON.stringify({
        version: 1,
        items: [item(`a${spaces}b.md`, 'ok/a.md'), item('b.md', `x${spaces}y.md`), item('fine.md', `dir${' '.repeat(1000)}x/fine.md`)],
      }),
      '_trash/b.md': '# x\n',
      '_trash/fine.md': '# x\n',
    })
    const started = performance.now()
    const record = await readTrashRecord(join(root, '_trash'), 'win32')
    const ms = performance.now() - started
    console.log(`[SEC-02] trash record with 200k-space paths on win32: ${ms.toFixed(1)} ms`)
    expect(ms).toBeLessThan(200)
    expect([...record.items.values()].map(value => [value.file, value.originalPath])).toEqual([['fine.md', `dir${' '.repeat(1000)}x/fine.md`]])
  })
})

describe('trash list and preview', () => {
  it('sorts by deletion time, newest first, unknown last, and filters by title, tags and body', async () => {
    const root = await temp.make()
    let now = new Date('2026-11-01T00:00:00Z')
    const service = makeService(root, { now: () => now })
    await writeTree(root, {
      'older.md': promptFile({ title: '较早删除' }, '正文提到发布'),
      'newer.md': promptFile({ title: '较晚删除', tags: '[发布]' }, '正文'),
      '_trash/manual.md': '# 手动放进来\n',
    })
    await service.delete('older.md')
    now = new Date('2026-11-05T00:00:00Z')
    await service.delete('newer.md')
    const all = await service.trashList('')
    expect(all.entries.map(entry => entry.file)).toEqual(['newer.md', 'older.md', 'manual.md'])
    expect(all.entries[0]?.deletedAt).toBe(Date.parse('2026-11-05T00:00:00Z'))
    expect((await service.trashList('发布')).entries.map(entry => entry.file)).toEqual(['newer.md', 'older.md'])
    expect((await service.trashList('较晚')).entries.map(entry => entry.file)).toEqual(['newer.md'])
    expect((await service.trashList('ＭＡＮＵＡＬ 不存在')).entries).toEqual([])
  })

  it('previews a trashed file with its original location', async () => {
    const root = await temp.make()
    await writeTree(root, { '写作/a.md': '---\ntitle: 预览\r\n---\r\n第一行\r\n' })
    const service = makeService(root)
    await service.delete('写作/a.md')
    expect(await service.trashRead('a.md')).toEqual({
      entry: { file: 'a.md', title: '预览', deletedAt: Date.parse(NOW_STAMP), originalPath: '写作/a.md' },
      body: '第一行\n',
    })
    await expect(service.trashRead('none.md')).rejects.toMatchObject({ code: 'promptx/trash/not-found' })
    await expect(service.trashRead('../a.md')).rejects.toMatchObject({ code: 'promptx/library/invalid-path' })
    await expect(service.trashRead(RECORD_FILE)).rejects.toMatchObject({ code: 'promptx/library/invalid-path' })
  })

  it('previews a trashed file with a closed but broken front matter as a whole (review F1)', async () => {
    const root = await temp.make()
    const raw = '---\nYou are a helpful assistant.\n---\nUser: hi\n'
    await writeTree(root, { 'chat.md': raw })
    const service = makeService(root)
    await service.delete('chat.md')
    expect(await service.trashRead('chat.md')).toEqual({
      entry: { file: 'chat.md', title: 'You are a helpful assistant.', deletedAt: Date.parse(NOW_STAMP), originalPath: 'chat.md' },
      body: raw,
    })
    expect((await service.trashList('assistant')).entries.map(entry => entry.title)).toEqual(['You are a helpful assistant.'])
  })

  it('returns an empty list when there is no trash yet', async () => {
    const root = await temp.make()
    expect(await makeService(root).trashList('')).toEqual({ recordState: 'missing', entries: [] })
    expect(await makeService(join(root, 'none')).trashList('')).toEqual({ recordState: 'missing', entries: [] })
    await mkdir(join(root, '_trash'))
    expect(await makeService(root).trashList('x')).toEqual({ recordState: 'missing', entries: [] })
  })
})

// 外部审查第 6 条：替代名字和回收站里的重名名字原来直接在主体后面加 `-2`。用户在别处建的接近 255 字节的长文件名
// 加上序号就超过文件名上限，占用检查和移动报 ENAMETOOLONG：恢复时给不出替代路径，回收站里有同名文件时也删不掉。
describe('numbered names stay within 255 bytes (external review 6)', () => {
  function first(names: Iterable<string>, count: number): string[] {
    const result: string[] = []
    for (const name of names) {
      result.push(name)
      if (result.length === count) break
    }
    return result
  }

  const FAMILY = '\u{1F468}‍\u{1F469}‍\u{1F467}‍\u{1F466}'
  const LONG = `${'a'.repeat(252)}.md`

  it('adds the number as before when there is room, keeping the extension case', () => {
    expect(first(numberedNames('x.md'), 3)).toEqual(['x-2.md', 'x-3.md', 'x-4.md'])
    expect(first(numberedNames('写作模板.MD'), 1)).toEqual(['写作模板-2.MD'])
    expect(first(trashNameCandidates('x.md'), 2)).toEqual(['x.md', 'x-2.md'])
  })

  it('shortens a name close to the limit so that the numbered name fits', () => {
    const names = first(numberedNames(LONG), 9)
    expect(names[0]).toBe(`${'a'.repeat(250)}-2.md`)
    expect(names[8]).toBe(`${'a'.repeat(249)}-10.md`)
    for (const name of names) expect(Buffer.byteLength(name)).toBeLessThanOrEqual(255)
    expect(new Set(names).size).toBe(names.length)
    // Linux 按字节算上限：84 个汉字的名字正好 255 字节，同样要截短（macOS、Windows 按码元算，本来放得下，截短也无妨）
    expect(first(numberedNames(`${'长'.repeat(84)}.md`), 1)).toEqual([`${'长'.repeat(83)}-2.md`])
  })

  it('cuts whole graphemes and never leaves half an emoji behind', () => {
    const name = `${'a'.repeat(227)}${FAMILY}.md`
    expect(Buffer.byteLength(name)).toBe(255)
    expect(first(trashNameCandidates(name), 2)).toEqual([name, `${'a'.repeat(227)}-2.md`])
  })

  // Windows 上临时目录的路径加上 255 个字符的文件名会超过 MAX_PATH，这两条只在 POSIX 上跑；名字的生成规则由上面几条覆盖
  it.skipIf(process.platform === 'win32')('offers an alternative that can be restored when a 255-byte original name is taken', async () => {
    const root = await temp.make()
    await writeTree(root, { [LONG]: PROMPT })
    const service = makeService(root)
    const { trashFile } = await service.delete(LONG)
    await writeTree(root, { [LONG]: '# 占位\n' })
    const alternative = `${'a'.repeat(250)}-2.md`
    expect(await service.trashRestore({ file: trashFile, target: 'original', alternative: null, acceptModified: false }))
      .toEqual({ kind: 'occupied', alternative })
    expect(await service.trashRestore({ file: trashFile, target: 'alternative', alternative, acceptModified: false }))
      .toEqual({ kind: 'restored', relPath: alternative })
    expect(await readText(root, alternative)).toBe(PROMPT)
    expect(await readText(root, LONG)).toBe('# 占位\n')
  })

  it.skipIf(process.platform === 'win32')('trashes a second file of the same 255-byte name under a shortened numbered name', async () => {
    const root = await temp.make()
    await writeTree(root, { [LONG]: '# v1\n' })
    const service = makeService(root)
    await service.delete(LONG)
    await writeTree(root, { [LONG]: '# v2\n' })
    expect(await service.delete(LONG)).toEqual({ trashFile: `${'a'.repeat(250)}-2.md` })
    expect(await exists(join(root, LONG))).toBe(false)
    expect((await readRecord(root)).items.map(entry => [entry.file, entry.originalPath])).toEqual([[LONG, LONG], [`${'a'.repeat(250)}-2.md`, LONG]])
  })
})
