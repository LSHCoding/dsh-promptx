import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { exists, makeService, NOW, trySymlink, useTempDirs, writeTree } from './helpers.ts'

const dirs = useTempDirs()

describe('库文件夹管理', () => {
  it('在新库建空文件夹，保存明确选择的目录并阻止重名', async () => {
    const root = join(await dirs.make(), 'new-library')
    const library = makeService(root)
    expect(await library.folders(root)).toEqual({ folders: [] })
    expect(await library.createFolder('写作', root)).toEqual({ folder: '写作' })
    expect(await library.folders(root)).toEqual({ folders: ['写作'] })
    await expect(library.createFolder('写作', root)).rejects.toMatchObject({ code: 'promptx/library/folder-exists' })
    const save = {
      text: '正文', binding: null, folder: '写作', mode: 'normal' as const, requestId: 'new',
      folderMustExist: true, libraryDir: root, metadata: { title: '标题', tags: [] },
    }
    const result = await library.save(save)
    expect(result).toMatchObject({ kind: 'saved', entry: { relPath: '写作/标题.md' } })
    await expect(library.save({
      ...save, folder: '已删除', requestId: 'missing', metadata: { title: '另一个标题', tags: [] },
    })).rejects.toMatchObject({ code: 'promptx/library/not-found' })
    expect(await exists(join(root, '已删除'))).toBe(false)
  })

  it('删除和恢复整个目录，保留非 Markdown 文件、隐藏文件和空目录', async () => {
    const root = await dirs.make()
    const original = '主题/_trash'
    const payload = Buffer.from([0, 255, 10, 13])
    await writeTree(root, { [`${original}/原稿.md`]: '原文\r\n', [`${original}/.保留`]: payload })
    await mkdir(join(root, original, '空目录'))
    const library = makeService(root)
    expect((await library.folders(root)).folders).toContain(original)
    const { trashFile } = await library.deleteFolder(original, root)
    expect((await library.folders(root)).folders).toEqual(['主题'])
    expect(await exists(join(root, original))).toBe(false)
    const restarted = makeService(root)
    expect((await restarted.trashList('主题')).entries).toEqual([
      { file: trashFile, title: '_trash', kind: 'folder', originalPath: original, deletedAt: NOW.getTime() },
    ])
    const restore = { file: trashFile, target: 'original', alternative: null, acceptModified: false, libraryDir: root } as const
    expect(await restarted.trashRestore(restore)).toEqual({ kind: 'restored', relPath: original })
    expect(await readFile(join(root, original, '原稿.md'), 'utf8')).toBe('原文\r\n')
    expect(await readFile(join(root, original, '.保留'))).toEqual(payload)
    expect(await exists(join(root, original, '空目录'))).toBe(true)
    expect((await restarted.trashList('')).entries).toEqual([])
  })

  it('原目录被重新占用时提示改名恢复，并保留两份内容', async () => {
    const root = await dirs.make()
    await writeTree(root, { '主题/旧稿.md': '原文' })
    const library = makeService(root)
    const { trashFile } = await library.deleteFolder('主题', root)
    await writeTree(root, { '主题/新稿.md': '新文' })
    const restore = { file: trashFile, target: 'original', alternative: null, acceptModified: false, libraryDir: root } as const
    expect(await library.trashRestore(restore)).toEqual({ kind: 'occupied', alternative: '主题-2' })
    expect(await library.trashRestore({ ...restore, target: 'alternative', alternative: '主题-2' }))
      .toEqual({ kind: 'restored', relPath: '主题-2' })
    expect(await readFile(join(root, '主题', '新稿.md'), 'utf8')).toBe('新文')
    expect(await readFile(join(root, '主题-2', '旧稿.md'), 'utf8')).toBe('原文')
  })

  it('原父目录已被普通文件占用时仍能在库根目录恢复', async () => {
    const root = await dirs.make()
    await writeTree(root, { '父目录/主题/旧稿.md': '原文' })
    const library = makeService(root)
    const { trashFile } = await library.deleteFolder('父目录/主题', root)
    await library.deleteFolder('父目录', root)
    await writeFile(join(root, '父目录'), '保留')
    const restore = { file: trashFile, target: 'original', alternative: null, acceptModified: false } as const
    expect(await library.trashRestore(restore)).toEqual({ kind: 'occupied', alternative: '主题-2' })
    expect(await library.trashRestore({ ...restore, target: 'alternative', alternative: '主题-2' }))
      .toEqual({ kind: 'restored', relPath: '主题-2' })
    expect(await readFile(join(root, '父目录'), 'utf8')).toBe('保留')
    expect(await readFile(join(root, '主题-2', '旧稿.md'), 'utf8')).toBe('原文')
  })

  it('拒绝越界、回收站本身、符号链接和包含受保护目录的父文件夹', async () => {
    const root = await dirs.make()
    const other = await dirs.make()
    const protectedDir = join(root, '容器', '受保护')
    await mkdir(protectedDir, { recursive: true })
    const protectedReal = await realpath(protectedDir)
    const library = makeService(root, { skipRealpaths: () => [protectedReal] })
    for (const path of ['../越界', '_trash', '']) {
      await expect(library.createFolder(path, root)).rejects.toMatchObject({ code: 'promptx/library/invalid-path' })
      await expect(library.deleteFolder(path, root)).rejects.toMatchObject({ code: 'promptx/library/invalid-path' })
    }
    await expect(library.deleteFolder('容器', root)).rejects.toMatchObject({ code: 'promptx/library/invalid-path' })
    await expect(library.createFolder('目标', other)).rejects.toMatchObject({ code: 'promptx/library/unavailable' })
    if (await trySymlink(other, join(root, '链接'), 'dir')) {
      await expect(library.deleteFolder('链接', root)).rejects.toMatchObject({ code: 'promptx/library/invalid-path' })
    }
    expect(await exists(protectedDir)).toBe(true)
  })
})
