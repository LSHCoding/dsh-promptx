import { chmod, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { PromptxError } from '../../src/shared/errors.ts'
import { canTestPermissions, installCrashTraps, makeService, sha256Of, trySymlink, useTempDirs, writeTree } from './helpers.ts'

installCrashTraps()
const temp = useTempDirs()

async function errorOf(promise: Promise<unknown>): Promise<PromptxError> {
  try {
    await promise
  } catch (error) {
    if (error instanceof PromptxError) return error
    throw error
  }
  throw new Error('expected a rejection')
}

describe('library.read (L-05, L-07)', () => {
  it('returns the entry, the body with LF line breaks and the version of the raw bytes', async () => {
    const root = await temp.make()
    const raw = '\ufeff---\r\nid: prompt_20261107_120000_1a2b3c4d\r\ntitle: 标题\r\n---\r\n第一行\r\n第二行\r\n'
    await writeTree(root, { '写作/a.md': raw })
    const result = await makeService(root).read('写作/a.md')
    expect(result.body).toBe('第一行\n第二行\n')
    expect(result.version).toEqual({ sha256: sha256Of(Buffer.from(raw, 'utf8')), size: Buffer.byteLength(raw) })
    expect(result.entry).toMatchObject({ relPath: '写作/a.md', folder: '写作', title: '标题', id: 'prompt_20261107_120000_1a2b3c4d', status: 'ok' })
  })

  it('accepts backslashes from Windows paths on Windows and returns the full text of files with broken front matter', async () => {
    const root = await temp.make()
    await writeTree(root, { 'a/b.md': '---\ntitle: never closed\n# Heading\n' })
    const result = await makeService(root, {}, { platform: 'win32' }).read('a\\b.md')
    expect(result.entry.status).toBe('invalid-meta')
    expect(result.body).toBe('---\ntitle: never closed\n# Heading\n')
  })

  it('reports missing files and a missing library as not-found', async () => {
    const root = await temp.make()
    await mkdir(join(root, 'dir.md'))
    const service = makeService(root)
    await expect(service.read('none.md')).rejects.toMatchObject({ code: 'promptx/library/not-found' })
    await expect(service.read('dir.md')).rejects.toMatchObject({ code: 'promptx/library/not-found' })
    await expect(makeService(join(root, 'missing')).read('a.md')).rejects.toMatchObject({ code: 'promptx/library/not-found' })
  })

  it('refuses files that cannot be opened (L-01)', async () => {
    const root = await temp.make()
    await writeTree(root, { 'big.md': Buffer.alloc(2 * 1024 * 1024 + 1, 0x61), 'bad.md': Buffer.from([0xc3, 0x28]) })
    const service = makeService(root)
    await expect(service.read('big.md')).rejects.toMatchObject({ code: 'promptx/library/unreadable', detail: 'too-large' })
    await expect(service.read('bad.md')).rejects.toMatchObject({ code: 'promptx/library/unreadable', detail: 'not-utf8' })
  })

  it('reports read errors without the file name (N-02)', async (ctx) => {
    if (!canTestPermissions) ctx.skip()
    const root = await temp.make()
    await writeTree(root, { '机密标题.md': '# 机密\n' })
    await chmod(join(root, '机密标题.md'), 0o000)
    const error = await errorOf(makeService(root).read('机密标题.md'))
    expect(error.toInfo()).toEqual({ code: 'promptx/library/unreadable', detail: 'read-failed' })
    expect(error.message).not.toContain('机密')
  })

  it.each([
    '../outside.md', '/abs.md', 'C:/x.md', 'a/../b.md', 'a//b.md', './a.md', '.hidden/x.md', '_trash/x.md',
    'notes.txt', '.md', '', 'a/.md',
  ])('rejects the path %j', async (relPath) => {
    const root = await temp.make()
    await expect(makeService(root).read(relPath)).rejects.toMatchObject({ code: 'promptx/library/invalid-path' })
  })

  it('rejects `_TRASH` only where the file system ignores case', async () => {
    const root = await temp.make()
    await writeTree(root, { '_TRASH/x.md': '# x\n' })
    await expect(makeService(root, {}, { platform: 'darwin' }).read('_TRASH/x.md')).rejects.toMatchObject({ code: 'promptx/library/invalid-path' })
    expect((await makeService(root, {}, { platform: 'linux' }).read('_TRASH/x.md')).entry.title).toBe('x')
  })

  it('rejects names Windows would treat as alternate data streams or devices', async () => {
    const root = await temp.make()
    const windows = makeService(root, {}, { platform: 'win32' })
    for (const relPath of ['a:b.md', 'CON.md', 'aux.md', 'nul/x.md', 'dir./x.md', 'dir /x.md']) {
      await expect(windows.read(relPath)).rejects.toMatchObject({ code: 'promptx/library/invalid-path' })
    }
    // 其他平台上这些名字都是普通文件名
    await writeTree(root, { 'CON.md': '# con\n' })
    expect((await makeService(root, {}, { platform: 'linux' }).read('CON.md')).entry.title).toBe('con')
  })

  it('rejects symbolic links to files and paths through linked folders', async (ctx) => {
    const root = await temp.make()
    const outside = await temp.make()
    await writeFile(join(outside, 'secret.md'), '# secret\n')
    if (!(await trySymlink(join(outside, 'secret.md'), join(root, 'link.md'), 'file'))) ctx.skip()
    if (!(await trySymlink(outside, join(root, 'linked'), 'dir'))) ctx.skip()
    const service = makeService(root)
    await expect(service.read('link.md')).rejects.toMatchObject({ code: 'promptx/library/invalid-path' })
    await expect(service.read('linked/secret.md')).rejects.toMatchObject({ code: 'promptx/library/invalid-path' })
  })
})
