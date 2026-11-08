import { chmod, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { LibraryService } from '../../src/library/service.ts'
import { PromptxError } from '../../src/shared/errors.ts'
import { parsePromptFile } from '../../src/shared/frontmatter.ts'
import type { Binding, SaveResult } from '../../src/shared/types.ts'
import {
  NOW_STAMP,
  bindingFor,
  canTestPermissions,
  exists,
  installCrashTraps,
  listAll,
  makeService,
  readText,
  sha256Of,
  trySymlink,
  useTempDirs,
  writeTree,
} from './helpers.ts'

installCrashTraps()
const temp = useTempDirs()

const ID_PATTERN = /^prompt_20261108_120000_[0-9a-f]{8}$/

function saved(result: SaveResult): Extract<SaveResult, { kind: 'saved' }> {
  if (result.kind !== 'saved') throw new Error(`expected saved, got ${result.conflict}`)
  return result
}

async function saveNew(service: LibraryService, text: string, folder: string | null = null, requestId = ''): Promise<SaveResult> {
  return await service.save({ text, binding: null, folder, mode: 'normal', requestId })
}

describe('saving a new prompt (L-08)', () => {
  it('creates a file at the root with complete front matter and binds to it', async () => {
    const root = await temp.make()
    const service = makeService(root)
    const text = '# 代码审查\n\n检查边界条件。'
    const result = saved(await saveNew(service, text))
    expect(result.created).toBe(true)
    const { binding, entry } = result
    expect(binding.id).toMatch(ID_PATTERN)
    expect(binding).toMatchObject({ libraryDir: root, relPath: '代码审查.md', title: '代码审查', savedBody: text })
    const content = await readText(root, '代码审查.md')
    expect(content).toBe([
      '---',
      `id: ${binding.id ?? ''}`,
      'title: 代码审查',
      'tags: []',
      'favorite: false',
      `created: ${NOW_STAMP}`,
      `updated: ${NOW_STAMP}`,
      '---',
      text,
    ].join('\n'))
    expect(binding.sha256).toBe(sha256Of(content))
    expect(binding.size).toBe(Buffer.byteLength(content))
    expect(entry).toMatchObject({ relPath: '代码审查.md', folder: '', id: binding.id, title: '代码审查', tags: [], favorite: false, status: 'ok' })
  })

  it('uses the untitled placeholder when the draft has no text line', async () => {
    const root = await temp.make()
    const result = saved(await saveNew(makeService(root), '#\n\n#'))
    expect(result.binding).toMatchObject({ relPath: '未命名 Prompt.md', title: '未命名 Prompt' })
  })

  it('round-trips titles that need quoting, such as `Fix bug #123` (S11)', async () => {
    const root = await temp.make()
    const service = makeService(root)
    for (const title of ['Fix bug #123', '"Hello" world', '- 第一项', '{{task}}', 'Note:', '[draft] x', 'yes']) {
      const result = saved(await saveNew(service, `# ${title}\n\nbody`))
      expect(result.binding.title).toBe(title)
      const parsed = parsePromptFile(await readText(root, result.binding.relPath))
      expect(parsed.frontMatter?.state).toBe('ok')
      expect(parsed.frontMatter?.fields.title).toBe(title)
    }
    expect(await readText(root, 'Fix bug #123.md')).toContain('title: "Fix bug #123"\n')
    const titles = (await listAll(service)).entries.map(entry => entry.title)
    expect(titles).toContain('Fix bug #123')
  })

  it('saves into the selected folder and creates missing folders', async () => {
    const root = await temp.make()
    const service = makeService(root)
    const result = saved(await saveNew(service, '# 模板\n', '写作/新建/更深'))
    expect(result.binding.relPath).toBe('写作/新建/更深/模板.md')
    expect(result.entry.folder).toBe('写作/新建/更深')
    expect(await exists(join(root, '写作', '新建', '更深', '模板.md'))).toBe(true)
    const listed = await listAll(service, { refresh: false })
    expect(listed.folders).toEqual(['写作', '写作/新建', '写作/新建/更深'])
  })

  it('creates the library directory, with missing parents, on the first save', async () => {
    const parent = await temp.make()
    const root = join(parent, 'a', 'b', 'library')
    const service = makeService(root)
    expect((await listAll(service)).state).toBe('missing')
    const result = saved(await saveNew(service, '# First\n'))
    expect(result.binding).toMatchObject({ libraryDir: root, relPath: 'First.md' })
    expect((await listAll(service)).total).toBe(1)
  })

  it('adds the id suffix and then a number when the name is taken, ignoring case', async () => {
    const root = await temp.make()
    await writeTree(root, { 'title.md': 'existing' })
    const service = makeService(root, { randomBytes: () => Uint8Array.from([1, 2, 3, 4]) })
    const first = saved(await saveNew(service, '# Title\n'))
    const second = saved(await saveNew(service, '# Title\n'))
    expect(first.binding.relPath).toBe('Title-01020304.md')
    expect(second.binding.relPath).toBe('Title-01020304-2.md')
    expect(await readText(root, 'title.md')).toBe('existing')
  })

  it('always saves "save as new" at the library root (L-12)', async () => {
    const root = await temp.make()
    const service = makeService(root)
    const bound = saved(await saveNew(service, '# Bound\n', '写作'))
    const copy = saved(await service.save({ text: '# Copy\n', binding: bound.binding, folder: '写作', mode: 'saveAsNew', requestId: '' }))
    expect(copy.binding.relPath).toBe('Copy.md')
    expect(copy.created).toBe(true)
    expect(await readText(root, '写作/Bound.md')).toContain('# Bound\n')
  })

  it('returns the already created file when the same requestId is sent again', async () => {
    const root = await temp.make()
    const service = makeService(root)
    const first = await saveNew(service, '# Once\n', null, 'request-1')
    const again = await saveNew(service, '# Once\n', null, 'request-1')
    expect(again).toEqual(first)
    expect((await readdir(root)).filter(name => name.endsWith('.md'))).toEqual(['Once.md'])
    saved(await saveNew(service, '# Once\n', null, 'request-2'))
    expect((await readdir(root)).filter(name => name.endsWith('.md')).sort()).toHaveLength(2)
  })

  it('remembers only the latest 100 request ids', async () => {
    const root = await temp.make()
    const service = makeService(root)
    const first = saved(await saveNew(service, '# Remembered\n', null, 'r-0'))
    for (let index = 1; index <= 100; index++) await saveNew(service, `# N${index}\n`, null, `r-${index}`)
    const again = saved(await saveNew(service, '# Remembered\n', null, 'r-0'))
    expect(again.binding.relPath).not.toBe(first.binding.relPath)
  })

  it.each(['', '   ', '\n\t\n'])('refuses blank drafts %j', async (text) => {
    const root = await temp.make()
    await expect(saveNew(makeService(root), text)).rejects.toMatchObject({ code: 'promptx/library/empty' })
    expect(await readdir(root)).toEqual([])
  })

  it.each(['../outside', '_trash', '.hidden', '/abs'])('refuses the folder %j', async (folder) => {
    const root = await temp.make()
    await expect(saveNew(makeService(root), '# X\n', folder)).rejects.toMatchObject({ code: 'promptx/library/invalid-path' })
    expect(await readdir(root)).toEqual([])
  })

  it('refuses to save through a symbolic link to a folder outside the library', async (ctx) => {
    const root = await temp.make()
    const outside = await temp.make()
    if (!(await trySymlink(outside, join(root, 'linked'), 'dir'))) ctx.skip()
    await expect(saveNew(makeService(root), '# X\n', 'linked')).rejects.toMatchObject({ code: 'promptx/library/invalid-path' })
    expect(await readdir(outside)).toEqual([])
  })

  it('makes the new entry visible to a query-only list right away', async () => {
    const root = await temp.make()
    await writeTree(root, { 'a.md': '# A\n' })
    const service = makeService(root)
    expect((await listAll(service)).total).toBe(1)
    saved(await saveNew(service, '# Brand new\n'))
    const listed = await listAll(service, { refresh: false, query: 'brand' })
    expect(listed.entries.map(entry => entry.relPath)).toEqual(['Brand new.md'])
    expect(listed.total).toBe(2)
  })
})

describe('save request checks (design-spec 9)', () => {
  it.each([
    ['a non-string text', { text: 5, binding: null, folder: null, mode: 'normal', requestId: '' }],
    ['an unknown mode', { text: 'x', binding: null, folder: null, mode: 'overwrite', requestId: '' }],
    ['a folder that is not a string', { text: 'x', binding: null, folder: 3, mode: 'normal', requestId: '' }],
    ['a missing request id', { text: 'x', binding: null, folder: null, mode: 'normal' }],
    ['a binding that is not an object', { text: 'x', binding: 'a.md', folder: null, mode: 'normal', requestId: '' }],
  ])('rejects %s without touching the library', async (_label, params) => {
    const root = await temp.make()
    const service = makeService(root)
    await expect(service.save(params as unknown as Parameters<LibraryService['save']>[0]))
      .rejects.toMatchObject({ code: 'promptx/internal', detail: 'invalid-params' })
    expect(await readdir(root)).toEqual([])
  })

  it('rejects a bound save whose binding lacks fields', async () => {
    const root = await temp.make()
    await writeTree(root, { 'a.md': '---\ntitle: T\n---\nbody' })
    const binding = { libraryDir: root, relPath: 'a.md' } as unknown as Binding
    await expect(makeService(root).save({ text: 'new', binding, folder: null, mode: 'normal', requestId: '' }))
      .rejects.toMatchObject({ code: 'promptx/internal', detail: 'invalid-binding' })
    expect(await readText(root, 'a.md')).toBe('---\ntitle: T\n---\nbody')
  })

  it('ignores the folder (even an invalid one) when saving as a new prompt', async () => {
    const root = await temp.make()
    const result = saved(await makeService(root).save({ text: '# Copy\n', binding: null, folder: '../elsewhere', mode: 'saveAsNew', requestId: '' }))
    expect(result.binding.relPath).toBe('Copy.md')
  })
})

describe('saving a bound prompt (L-08, L-12)', () => {
  it('only replaces the body and updated; custom fields, comments, order and quotes stay (L-08 acceptance)', async () => {
    const root = await temp.make()
    const head = [
      '---',
      '# 这是注释',
      "title: 'Quoted title'   # 行尾注释",
      'source: web',
      'id: prompt_20261101_000000_abcdef01',
      'tags:',
      '  - a',
      'favorite: true',
      'updated: "2026-01-01T00:00:00Z"',
      'created: 2026-01-01',
      '---',
    ]
    await writeTree(root, { 'a.md': [...head, 'old body', ''].join('\n') })
    const service = makeService(root)
    const binding = await bindingFor(service, root, 'a.md')
    const result = saved(await service.save({ text: 'new body\n', binding, folder: null, mode: 'normal', requestId: '' }))
    const expected = [...head.slice(0, 8), `updated: "${NOW_STAMP}"`, ...head.slice(9), 'new body', ''].join('\n')
    expect(await readText(root, 'a.md')).toBe(expected)
    expect(result.created).toBe(false)
    expect(result.binding).toMatchObject({
      libraryDir: root,
      relPath: 'a.md',
      id: 'prompt_20261101_000000_abcdef01',
      title: 'Quoted title',
      sha256: sha256Of(expected),
      size: Buffer.byteLength(expected),
      savedBody: 'new body\n',
    })
  })

  it('adds only id and updated when the id is missing', async () => {
    const root = await temp.make()
    await writeTree(root, { 'a.md': '---\ntitle: T\nupdated: 2026-01-01T00:00:00Z\n---\nbody' })
    const service = makeService(root)
    const result = saved(await service.save({ text: 'new', binding: await bindingFor(service, root, 'a.md'), folder: null, mode: 'normal', requestId: '' }))
    expect(result.binding.id).toMatch(ID_PATTERN)
    expect(await readText(root, 'a.md')).toBe(`---\ntitle: T\nupdated: ${NOW_STAMP}\nid: ${result.binding.id ?? ''}\n---\nnew`)
  })

  it('keeps CRLF line breaks and the BOM', async () => {
    const root = await temp.make()
    await writeTree(root, { 'a.md': '﻿---\r\nid: prompt_20261101_000000_abcdef01\r\ntitle: T\r\nupdated: 2026-01-01T00:00:00Z\r\n---\r\nold\r\n' })
    const service = makeService(root)
    saved(await service.save({ text: 'new\nlines\n', binding: await bindingFor(service, root, 'a.md'), folder: null, mode: 'normal', requestId: '' }))
    const bytes = await readFile(join(root, 'a.md'))
    expect(bytes.subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]))
    expect(bytes.toString('utf8')).toBe(`﻿---\r\nid: prompt_20261101_000000_abcdef01\r\ntitle: T\r\nupdated: ${NOW_STAMP}\r\n---\r\nnew\r\nlines\r\n`)
  })

  it('keeps the permission bits of the file (POSIX)', async (ctx) => {
    if (!canTestPermissions) ctx.skip()
    const root = await temp.make()
    await writeTree(root, { 'private.md': '---\nid: prompt_20261101_000000_abcdef01\n---\nold', 'shared.md': '---\nid: prompt_20261101_000000_abcdef02\n---\nold' })
    await chmod(join(root, 'private.md'), 0o600)
    await chmod(join(root, 'shared.md'), 0o664)
    const service = makeService(root)
    for (const name of ['private.md', 'shared.md']) {
      saved(await service.save({ text: 'new', binding: await bindingFor(service, root, name), folder: null, mode: 'normal', requestId: '' }))
    }
    expect((await stat(join(root, 'private.md'))).mode & 0o777).toBe(0o600)
    expect((await stat(join(root, 'shared.md'))).mode & 0o777).toBe(0o664)
  })

  it('does not overwrite a file changed by another program (L-12 acceptance)', async () => {
    const root = await temp.make()
    await writeTree(root, { 'a.md': '---\ntitle: T\n---\nloaded' })
    const service = makeService(root)
    const binding = await bindingFor(service, root, 'a.md')
    await writeFile(join(root, 'a.md'), '---\ntitle: T\n---\nedited elsewhere')
    const result = await service.save({ text: 'mine', binding, folder: null, mode: 'normal', requestId: '' })
    expect(result).toEqual({ kind: 'conflict', conflict: 'modified' })
    expect(await readText(root, 'a.md')).toBe('---\ntitle: T\n---\nedited elsewhere')
  })

  it('reports a deleted or moved file, or a changed library directory, as missing', async () => {
    const root = await temp.make()
    await writeTree(root, { 'a.md': '---\ntitle: T\n---\nbody', 'b.md': '---\ntitle: B\n---\nbody' })
    const service = makeService(root)
    const bindingA = await bindingFor(service, root, 'a.md')
    await rm(join(root, 'a.md'))
    expect(await service.save({ text: 'x', binding: bindingA, folder: null, mode: 'normal', requestId: '' })).toEqual({ kind: 'conflict', conflict: 'missing' })
    const bindingB = { ...(await bindingFor(service, root, 'b.md')), libraryDir: join(root, 'old-library') }
    expect(await service.save({ text: 'x', binding: bindingB, folder: null, mode: 'normal', requestId: '' })).toEqual({ kind: 'conflict', conflict: 'missing' })
    expect(await readText(root, 'b.md')).toBe('---\ntitle: B\n---\nbody')
  })

  it('asks before adding front matter, then adds id, title, created and updated (L-08)', async () => {
    const root = await temp.make()
    await writeTree(root, { 'plain.md': 'plain body\n' })
    const service = makeService(root)
    const binding = await bindingFor(service, root, 'plain.md')
    expect(await service.save({ text: 'new text', binding, folder: null, mode: 'normal', requestId: '' })).toEqual({ kind: 'conflict', conflict: 'noFrontMatter' })
    expect(await readText(root, 'plain.md')).toBe('plain body\n')
    const result = saved(await service.save({ text: 'new text', binding, folder: null, mode: 'addFrontMatter', requestId: '' }))
    expect(await readText(root, 'plain.md')).toBe([
      '---',
      `id: ${result.binding.id ?? ''}`,
      'title: plain body',
      `created: ${NOW_STAMP}`,
      `updated: ${NOW_STAMP}`,
      '---',
      'new text',
    ].join('\n'))
    expect(result.entry.hasFrontMatter).toBe(true)
  })

  it.each([
    ['unterminated', '---\ntitle: T\nbody without end'],
    ['duplicate key', '---\ntitle: a\ntitle: b\n---\nbody'],
    ['flow mapping', '---\n{title: a}\n---\nbody'],
    ['prose at column 0', '---\ntitle: a\nsome prose\n---\nbody'],
  ])('refuses to rewrite broken front matter (%s)', async (_label, content) => {
    const root = await temp.make()
    await writeTree(root, { 'a.md': content })
    const service = makeService(root)
    const binding = await bindingFor(service, root, 'a.md')
    for (const mode of ['normal', 'addFrontMatter'] as const) {
      expect(await service.save({ text: 'new', binding, folder: null, mode, requestId: '' })).toEqual({ kind: 'conflict', conflict: 'invalidFrontMatter' })
    }
    expect(await readText(root, 'a.md')).toBe(content)
  })

  // 审查 F1：写坏了的文件载入编辑区的是全文。原样或改过之后保存都不能写回去（既不改写，也不会在原来的分隔行后面再接一份全文），
  // 另存为新 Prompt 时全文都是新文件的正文
  it('never writes the whole-text body back into a closed but broken front matter, and saves it as a new prompt', async () => {
    const root = await temp.make()
    const content = '---\nYou are a helpful assistant.\n---\nUser: hi\n'
    await writeTree(root, { 'chat.md': content })
    const service = makeService(root)
    const binding = await bindingFor(service, root, 'chat.md')
    expect(binding.savedBody).toBe(content)
    for (const text of [binding.savedBody, `${binding.savedBody}User: more\n`]) {
      for (const mode of ['normal', 'addFrontMatter'] as const) {
        expect(await service.save({ text, binding, folder: null, mode, requestId: '' })).toEqual({ kind: 'conflict', conflict: 'invalidFrontMatter' })
      }
    }
    expect(await readText(root, 'chat.md')).toBe(content)
    const copy = saved(await service.save({ text: binding.savedBody, binding, folder: null, mode: 'saveAsNew', requestId: '' }))
    expect(copy.binding.relPath).not.toBe('chat.md')
    expect(copy.entry.title).toBe('You are a helpful assistant.')
    const parsed = parsePromptFile(await readText(root, copy.binding.relPath))
    expect(parsed.frontMatter?.state).toBe('ok')
    expect(parsed.body).toBe(content)
    expect(await readText(root, 'chat.md')).toBe(content)
  })

  it('reports write failures with the errno only, leaves the file and no temp file behind (N-02)', async (ctx) => {
    if (!canTestPermissions) ctx.skip()
    const root = await temp.make()
    await writeTree(root, { '机密/标题.md': '---\ntitle: 机密\n---\nold' })
    const service = makeService(root)
    const binding = await bindingFor(service, root, '机密/标题.md')
    await chmod(join(root, '机密'), 0o555)
    let caught: unknown
    try {
      await service.save({ text: 'new', binding, folder: null, mode: 'normal', requestId: '' })
    } catch (error) {
      caught = error
    }
    await chmod(join(root, '机密'), 0o755)
    expect(caught).toBeInstanceOf(PromptxError)
    expect((caught as PromptxError).toInfo()).toEqual({ code: 'promptx/library/write-failed', detail: 'EACCES: permission denied' })
    expect((caught as PromptxError).message).not.toContain('机密')
    expect(await readdir(join(root, '机密'))).toEqual(['标题.md'])
    expect(await readText(root, '机密/标题.md')).toBe('---\ntitle: 机密\n---\nold')
  })

  it('removes its temp file and keeps the original when the final rename fails (N-02)', async () => {
    const root = await temp.make()
    await writeTree(root, { 'a.md': '---\ntitle: T\n---\nold' })
    const failing = async (): Promise<void> => {
      throw Object.assign(new Error("EIO: i/o error, rename '/库/a.md'"), { code: 'EIO' })
    }
    const service = makeService(root, {}, { ops: { rename: failing } })
    const binding = await bindingFor(service, root, 'a.md')
    await expect(service.save({ text: 'new', binding, folder: null, mode: 'normal', requestId: '' }))
      .rejects.toMatchObject({ code: 'promptx/library/write-failed', detail: 'EIO: i/o error' })
    expect(await readdir(root)).toEqual(['a.md'])
    expect(await readText(root, 'a.md')).toBe('---\ntitle: T\n---\nold')
  })

  it('refuses to replace a file the user made read-only (POSIX)', async (ctx) => {
    if (!canTestPermissions) ctx.skip()
    const root = await temp.make()
    const content = '---\nid: prompt_20261101_000000_abcdef01\ntitle: T\n---\nold'
    await writeTree(root, { 'locked.md': content })
    await chmod(join(root, 'locked.md'), 0o444)
    const service = makeService(root)
    const binding = await bindingFor(service, root, 'locked.md')
    await expect(service.save({ text: 'new', binding, folder: null, mode: 'normal', requestId: '' }))
      .rejects.toMatchObject({ code: 'promptx/library/write-failed', detail: 'EACCES: permission denied' })
    await expect(service.updateMeta({ relPath: 'locked.md', patch: { favorite: true }, addFrontMatter: false }))
      .rejects.toMatchObject({ code: 'promptx/library/write-failed', detail: 'EACCES: permission denied' })
    expect(await readText(root, 'locked.md')).toBe(content)
    expect((await stat(join(root, 'locked.md'))).mode & 0o777).toBe(0o444)
  })

  it('adds front matter to a CRLF file with a BOM in its own line style', async () => {
    const root = await temp.make()
    await writeTree(root, { 'plain.md': '\ufeff# Plain\r\n\r\nold\r\n' })
    const service = makeService(root)
    const binding = await bindingFor(service, root, 'plain.md')
    const result = saved(await service.save({ text: '# Plain\n\nnew\n', binding, folder: null, mode: 'addFrontMatter', requestId: '' }))
    expect(await readText(root, 'plain.md')).toBe([
      '\ufeff---',
      `id: ${result.binding.id ?? ''}`,
      'title: Plain',
      `created: ${NOW_STAMP}`,
      `updated: ${NOW_STAMP}`,
      '---',
      '# Plain',
      '',
      'new',
      '',
    ].join('\r\n'))
    expect(result.binding).toMatchObject({ title: 'Plain', savedBody: '# Plain\n\nnew\n' })
  })

  it.each(['../outside.md', '_trash/x.md', 'a.txt'])('refuses a binding with the path %j', async (relPath) => {
    const root = await temp.make()
    const binding: Binding = { libraryDir: root, relPath, id: null, title: 'x', sha256: sha256Of('x'), size: 1, savedBody: 'x' }
    await expect(makeService(root).save({ text: 'new', binding, folder: null, mode: 'normal', requestId: '' }))
      .rejects.toMatchObject({ code: 'promptx/library/invalid-path' })
  })

  it('refuses a binding that points through a symbolic link', async (ctx) => {
    const root = await temp.make()
    const outside = await temp.make()
    await writeFile(join(outside, 'x.md'), 'x')
    if (!(await trySymlink(outside, join(root, 'linked'), 'dir'))) ctx.skip()
    const binding: Binding = { libraryDir: root, relPath: 'linked/x.md', id: null, title: 'x', sha256: sha256Of('x'), size: 1, savedBody: 'x' }
    await expect(makeService(root).save({ text: 'new', binding, folder: null, mode: 'addFrontMatter', requestId: '' }))
      .rejects.toMatchObject({ code: 'promptx/library/invalid-path' })
    expect(await readFile(join(outside, 'x.md'), 'utf8')).toBe('x')
  })

  it('chains saves with the binding each save returns', async () => {
    const root = await temp.make()
    const service = makeService(root)
    const first = saved(await saveNew(service, '# Draft\n\nv1'))
    const second = saved(await service.save({ text: '# Draft\n\nv2', binding: first.binding, folder: null, mode: 'normal', requestId: '' }))
    const third = saved(await service.save({ text: '# Draft\n\nv3', binding: second.binding, folder: null, mode: 'normal', requestId: '' }))
    expect(third.binding.relPath).toBe(first.binding.relPath)
    expect((await service.read(first.binding.relPath)).body).toBe('# Draft\n\nv3')
  })
})
