import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { folderRelPath, promptRelPath } from '../../src/library/rel-path.ts'
import { installCrashTraps, listAll, makeService, readText, sha256Of, snapshotTree, useTempDirs, writeTree } from './helpers.ts'

installCrashTraps()
const temp = useTempDirs()

// 审查 H6：macOS、Linux 上反斜杠是文件名里的普通字符。原来所有平台都把小窗传来的路径里的反斜杠换成 `/`，
// 扫描列出的 `x\y.md`（库根目录下的一个文件）一读、一收藏、一删除，动的都是另一个文件 `x/y.md`（红线 2）。

const NESTED = '---\nid: prompt_20261101_000000_00000001\ntitle: Nested\nfavorite: false\n---\nnested body\n'
const FLAT = '---\nid: prompt_20261101_000000_00000002\ntitle: Flat\nfavorite: false\n---\nflat body\n'

describe('backslashes in library paths (review H6)', () => {
  it('rejects backslashes outside Windows and still treats them as separators on Windows', () => {
    for (const platform of ['darwin', 'linux'] as const) {
      expect(promptRelPath('x\\y.md', platform)).toBeNull()
      expect(promptRelPath('a/b\\c.md', platform)).toBeNull()
      expect(folderRelPath('x\\y', platform)).toBeNull()
      expect(promptRelPath('x/y.md', platform)).toBe('x/y.md')
      expect(folderRelPath('x/y', platform)).toBe('x/y')
    }
    expect(promptRelPath('x\\y.md', 'win32')).toBe('x/y.md')
    expect(folderRelPath('x\\y', 'win32')).toBe('x/y')
  })

  it('never lets an operation on x\\y.md touch x/y.md, or the other way round (POSIX)', async (ctx) => {
    if (process.platform === 'win32') ctx.skip()
    const root = await temp.make()
    await writeTree(root, { 'x/y.md': NESTED })
    await writeFile(join(root, 'x\\y.md'), FLAT)
    await mkdir(join(root, 'dir\\name'))
    await writeFile(join(root, 'dir\\name', 'z.md'), '# Z\n')
    const service = makeService(root)

    // 扫描跳过名字里带反斜杠的文件和文件夹：列出来也没法安全地读写
    const listed = await listAll(service)
    expect(listed.entries.map(entry => entry.relPath)).toEqual(['x/y.md'])
    expect(listed.folders).toEqual(['x'])

    // 对 x\y.md 的每个操作都被拒绝，两个文件一个字节都不变
    const before = await snapshotTree(root)
    const invalid = { code: 'promptx/library/invalid-path' }
    await expect(service.read('x\\y.md')).rejects.toMatchObject(invalid)
    await expect(service.updateMeta({ relPath: 'x\\y.md', patch: { favorite: true }, addFrontMatter: false })).rejects.toMatchObject(invalid)
    await expect(service.delete('x\\y.md')).rejects.toMatchObject(invalid)
    const binding = { libraryDir: root, relPath: 'x\\y.md', id: 'prompt_20261101_000000_00000002', title: 'Flat', sha256: sha256Of(FLAT), size: Buffer.byteLength(FLAT), savedBody: 'flat body\n' }
    await expect(service.save({ text: 'overwritten\n', binding, folder: null, mode: 'normal', requestId: '' })).rejects.toMatchObject(invalid)
    await expect(service.save({ text: '# New\n', binding: null, folder: 'x\\sub', mode: 'normal', requestId: '' })).rejects.toMatchObject(invalid)
    await expect(service.read('dir\\name/z.md')).rejects.toMatchObject(invalid)
    expect(await snapshotTree(root)).toEqual(before)

    // 对 x/y.md 的收藏、删除、恢复都不碰 x\y.md
    expect((await service.updateMeta({ relPath: 'x/y.md', patch: { favorite: true }, addFrontMatter: false })).kind).toBe('saved')
    expect(await service.delete('x/y.md')).toEqual({ trashFile: 'y.md' })
    await expect(service.trashRestore({ file: 'y.md', target: 'alternative', alternative: 'x\\y.md', acceptModified: false }))
      .rejects.toMatchObject(invalid)
    expect(await service.trashRestore({ file: 'y.md', target: 'original', alternative: null, acceptModified: false }))
      .toEqual({ kind: 'restored', relPath: 'x/y.md' })
    expect(await readText(root, 'x/y.md')).toBe(NESTED.replace('favorite: false', 'favorite: true'))
    expect(await readFile(join(root, 'x\\y.md'), 'utf8')).toBe(FLAT)
  })

  it('keeps reading a backslash path as nested folders on Windows', async () => {
    const root = await temp.make()
    await writeTree(root, { 'x/y.md': NESTED })
    const result = await makeService(root, {}, { platform: 'win32' }).read('x\\y.md')
    expect(result.entry).toMatchObject({ relPath: 'x/y.md', title: 'Nested' })
  })
})
