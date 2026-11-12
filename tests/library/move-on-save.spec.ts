import { chmod, mkdir, readdir, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { CompanionRequests } from '../../src/shared/protocol.ts'
import type { Binding } from '../../src/shared/types.ts'
import { bindingFor, canTestPermissions, exists, listAll, makeService, readText, trySymlink, useTempDirs, writeTree } from './helpers.ts'

const temp = useTempDirs()

const ORIGINAL = [
  '---',
  'id: existing',
  'title: Old title',
  'tags: [Original Tag]',
  'favorite: true',
  'created: 2024-01-01T00:00:00Z',
  'custom: keep me # comment',
  '---',
  '# Original body',
  '',
].join('\n')

function move(binding: Binding, folder = 'target'): CompanionRequests['library.save']['params'] {
  return {
    binding, folder: null, moveToFolder: folder, mode: 'normal',
    libraryDir: binding.libraryDir, text: binding.savedBody, requestId: 'move-1',
  }
}

describe('moving a saved prompt while saving changes', () => {
  it('moves the same file with its edits, updates the index and binding, and deduplicates a retry', async () => {
    const root = await temp.make()
    await writeTree(root, { 'original/a.md': ORIGINAL, 'target/keep.md': '# Unrelated\n' })
    const service = makeService(root)
    await listAll(service)
    const binding = await bindingFor(service, root, 'original/a.md')
    const params = { ...move(binding), text: '# Edited body\n', metadata: { title: 'New title', tags: ['Code Review'] } }
    const result = await service.save(params)
    expect(result).toMatchObject({
      kind: 'saved', created: false,
      binding: { id: 'existing', relPath: 'target/a.md', savedBody: params.text },
      entry: { id: 'existing', relPath: 'target/a.md', title: 'New title', tags: ['Code Review'], favorite: true },
    })
    expect(await service.save(params)).toEqual(result)
    expect(await exists(join(root, 'original', 'a.md'))).toBe(false)
    const moved = await readText(root, 'target/a.md')
    expect(moved).toContain('created: 2024-01-01T00:00:00Z\n')
    expect(moved).toContain('custom: keep me # comment\n')
    expect(moved.endsWith(params.text)).toBe(true)
    expect(await readText(root, 'target/keep.md')).toBe('# Unrelated\n')
    expect((await listAll(service, { refresh: false })).entries.map(entry => entry.relPath).sort())
      .toEqual(['target/a.md', 'target/keep.md'])
  })

  it.each([ORIGINAL, '\ufeff# Legacy\r\n\r\nunchanged\r\n', ''])('preserves bytes when only the folder changes (%j)', async (content) => {
    const root = await temp.make()
    await writeTree(root, { 'original/a.md': content })
    const service = makeService(root)
    const binding = await bindingFor(service, root, 'original/a.md')
    const result = await service.save(move(binding, ''))
    expect(result).toMatchObject({ kind: 'saved', created: false, binding: { id: binding.id, relPath: 'a.md', sha256: binding.sha256 } })
    expect(await exists(join(root, 'original', 'a.md'))).toBe(false)
    expect(await readText(root, 'a.md')).toBe(content)
  })

  it('leaves both files intact when the destination is occupied, including case-only differences', async () => {
    const root = await temp.make()
    await writeTree(root, { 'a.md': ORIGINAL, 'target/A.md': 'occupied\n' })
    const service = makeService(root)
    const binding = await bindingFor(service, root, 'a.md')
    expect(await service.save({ ...move(binding), text: 'edit' })).toEqual({ kind: 'conflict', conflict: 'destinationOccupied' })
    expect(await readText(root, 'a.md')).toBe(ORIGINAL)
    expect(await readdir(join(root, 'target'))).toEqual(['A.md'])
    expect(await readText(root, 'target/A.md')).toBe('occupied\n')
  })

  it('checks the selected library and requires a real existing destination folder', async (ctx) => {
    const root = await temp.make()
    const outside = await temp.make()
    await writeTree(root, { 'a.md': ORIGINAL })
    const service = makeService(root)
    const binding = await bindingFor(service, root, 'a.md')
    await expect(service.save({ ...move(binding), libraryDir: outside })).rejects.toMatchObject({ code: 'promptx/library/unavailable' })
    await expect(service.save(move(binding))).rejects.toMatchObject({ code: 'promptx/library/folder-not-found' })
    await expect(service.save(move(binding, '../outside'))).rejects.toMatchObject({ code: 'promptx/library/invalid-path' })
    expect(await readdir(root)).toEqual(['a.md'])
    if (!(await trySymlink(outside, join(root, 'linked'), 'dir'))) ctx.skip()
    await expect(service.save(move(binding, 'linked'))).rejects.toMatchObject({ code: 'promptx/library/invalid-path' })
    expect(await readdir(outside)).toEqual([])
    expect(await readText(root, 'a.md')).toBe(ORIGINAL)
  })

  it('rolls back the target when an external edit changes the source before the move commits', async () => {
    const root = await temp.make()
    await writeTree(root, { 'a.md': ORIGINAL })
    await mkdir(join(root, 'target'))
    const service = makeService(root, {}, { hooks: { beforeVerify: path => writeFile(path, '# External edit\n') } })
    const binding = await bindingFor(service, root, 'a.md')
    expect(await service.save(move(binding))).toEqual({ kind: 'conflict', conflict: 'modified' })
    expect(await readText(root, 'a.md')).toBe('# External edit\n')
    expect(await readdir(join(root, 'target'))).toEqual([])
  })

  it('keeps the source and external content when the destination is edited before commit', async () => {
    const root = await temp.make()
    await writeTree(root, { 'a.md': ORIGINAL })
    await mkdir(join(root, 'target'))
    const service = makeService(root, {}, { hooks: { beforeVerify: () => writeFile(join(root, 'target', 'a.md'), '# External edit\n') } })
    const binding = await bindingFor(service, root, 'a.md')
    expect(await service.save(move(binding))).toEqual({ kind: 'conflict', conflict: 'destinationOccupied' })
    expect(await readText(root, 'a.md')).toBe(ORIGINAL)
    expect(await readText(root, 'target/a.md')).toBe('# External edit\n')
  })

  it('restores the source if the destination disappears while the source is being staged', async () => {
    const root = await temp.make()
    await writeTree(root, { 'a.md': ORIGINAL })
    await mkdir(join(root, 'target'))
    const service = makeService(root, {}, { ops: { rename: async (from, to) => {
      await rename(from, to)
      await unlink(join(root, 'target', 'a.md'))
    } } })
    const binding = await bindingFor(service, root, 'a.md')
    expect(await service.save({ ...move(binding), text: '# Edited body\n' })).toEqual({ kind: 'conflict', conflict: 'destinationOccupied' })
    expect(await readText(root, 'a.md')).toBe(ORIGINAL)
    expect(await readdir(root)).toEqual(['a.md', 'target'])
    expect(await readdir(join(root, 'target'))).toEqual([])
  })

  it('removes the staged destination if the source cannot be deleted (POSIX)', async (ctx) => {
    if (!canTestPermissions) ctx.skip()
    const root = await temp.make()
    const original = join(root, 'original')
    await writeTree(root, { 'original/a.md': ORIGINAL })
    await mkdir(join(root, 'target'))
    const service = makeService(root, {}, { hooks: { beforeVerify: () => chmod(original, 0o555) } })
    const binding = await bindingFor(service, root, 'original/a.md')
    try {
      await expect(service.save(move(binding))).rejects.toMatchObject({ code: 'promptx/library/write-failed' })
      expect(await readText(root, 'original/a.md')).toBe(ORIGINAL)
      expect(await readdir(join(root, 'target'))).toEqual([])
    } finally {
      await chmod(original, 0o755)
    }
  })
})
