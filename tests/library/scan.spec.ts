import { chmod, lstat, mkdir, realpath, rm, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { compareFolderPaths, indexedFromText, indexPath } from '../../src/library/scan.ts'
import type { EntryMeta, LibraryListParams } from '../../src/shared/types.ts'
import { canTestPermissions, exists, installCrashTraps, listAll, makeService, promptFile, trySymlink, useTempDirs, writeTree } from './helpers.ts'

installCrashTraps()
const temp = useTempDirs()

const TIME = new Date('2026-11-01T08:00:00Z')

function byPath(entries: readonly EntryMeta[]): Map<string, EntryMeta> {
  return new Map(entries.map(entry => [entry.relPath, entry]))
}

async function sampleLibrary(): Promise<string> {
  const root = await temp.make()
  await writeTree(root, {
    '代码审查清单.md': promptFile({
      id: 'prompt_20261107_120000_1a2b3c4d',
      title: '代码审查清单',
      tags: '[代码, 审查]',
      favorite: 'false',
      created: '2026-11-07T12:00:00Z',
      updated: '2026-11-07T12:00:00Z',
    }, '# 代码审查\n\n检查边界条件。\n'),
    '写作/结构化写作模板.md': promptFile({ id: 'prompt_20261101_000000_00000001', title: '结构化写作模板', tags: '[示例]', favorite: 'true', updated: '2026-11-05T00:00:00Z' }, '正文\n'),
    '写作/评审/评审意见.md': '# 评审意见\n\n没有 front matter。\n',
    '_trash/deleted.md': '# deleted\n',
    '.hidden/x.md': '# hidden\n',
    '.dotfile.md': '# dot\n',
    'notes.txt': 'not a prompt',
    'UPPER.MD': '# Upper case extension\n',
    'nested/_trash/kept.md': '# nested trash is a normal folder\n',
  })
  await mkdir(join(root, '写作', '空'))
  return root
}

describe('library scan (L-01, L-03, design-spec 7.2)', () => {
  it('finds .md files recursively and skips dot names, the root _trash and other files', async () => {
    const root = await sampleLibrary()
    const result = await listAll(makeService(root))
    expect(result.state).toBe('ok')
    expect(result.entries.map(entry => entry.relPath).sort()).toEqual([
      'UPPER.MD',
      'nested/_trash/kept.md',
      '代码审查清单.md',
      '写作/结构化写作模板.md',
      '写作/评审/评审意见.md',
    ].sort())
    expect(result.total).toBe(5)
    expect(result.folders).toEqual(['nested', 'nested/_trash', '写作', '写作/空', '写作/评审'])
  })

  it('reads the recognised fields and falls back to the body and mtime without front matter', async () => {
    const root = await sampleLibrary()
    const stamp = new Date('2026-10-01T00:00:00Z')
    await utimes(join(root, '写作', '评审', '评审意见.md'), stamp, stamp)
    const entries = byPath((await listAll(makeService(root))).entries)
    expect(entries.get('代码审查清单.md')).toMatchObject({
      id: 'prompt_20261107_120000_1a2b3c4d',
      title: '代码审查清单',
      folder: '',
      tags: ['代码', '审查'],
      favorite: false,
      status: 'ok',
      hasFrontMatter: true,
      updatedAt: Date.parse('2026-11-07T12:00:00Z'),
      createdAt: Date.parse('2026-11-07T12:00:00Z'),
    })
    expect(entries.get('写作/结构化写作模板.md')).toMatchObject({ folder: '写作', favorite: true, tags: ['示例'], createdAt: null })
    expect(entries.get('写作/评审/评审意见.md')).toMatchObject({
      id: null,
      title: '评审意见',
      folder: '写作/评审',
      tags: [],
      favorite: false,
      hasFrontMatter: false,
      status: 'ok',
      updatedAt: stamp.getTime(),
    })
  })

  it('marks oversized and non-UTF-8 files unreadable; oversized files are not decoded at all', async () => {
    const root = await temp.make()
    const big = Buffer.alloc(2 * 1024 * 1024 + 1, 0x61)
    big[0] = 0xff
    await writeTree(root, { 'big.md': big, 'latin1.md': Buffer.from([0x23, 0x20, 0xe9, 0x74, 0xe9, 0x0a]), 'ok.md': '# fine\n' })
    const entries = byPath((await listAll(makeService(root))).entries)
    expect(entries.get('big.md')).toMatchObject({ status: 'unreadable', unreadableReason: 'too-large', title: 'big', hasFrontMatter: false })
    expect(entries.get('latin1.md')).toMatchObject({ status: 'unreadable', unreadableReason: 'not-utf8', title: 'latin1' })
    expect(entries.get('ok.md')?.status).toBe('ok')
  })

  it('marks broken front matter as invalid-meta and takes the title from the body', async () => {
    const root = await temp.make()
    await writeTree(root, {
      'dup-key.md': '---\ntitle: a\ntitle: b\n---\n# From body\n',
      'unterminated.md': '---\ntitle: never closed\n\n# Heading\n',
    })
    const entries = byPath((await listAll(makeService(root))).entries)
    expect(entries.get('dup-key.md')).toMatchObject({ status: 'invalid-meta', title: 'From body', hasFrontMatter: true, id: null })
    expect(entries.get('unterminated.md')).toMatchObject({ status: 'invalid-meta', title: 'Heading' })
  })

  it('treats a closed but broken front matter as content: title from the whole text, searchable (review F1)', async () => {
    const root = await temp.make()
    await writeTree(root, { 'chat.md': '---\nYou are a helpful assistant.\n---\nUser: hi\n', 'other.md': '# Other\n' })
    const service = makeService(root)
    const entries = byPath((await listAll(service)).entries)
    expect(entries.get('chat.md')).toMatchObject({ status: 'invalid-meta', title: 'You are a helpful assistant.', hasFrontMatter: true, tags: [] })
    // 两个 `---` 之间的文字是正文的一部分，搜得到
    expect((await listAll(service, { query: 'assistant', refresh: false })).entries.map(entry => entry.relPath)).toEqual(['chat.md'])
  })

  it('shows both files when two share an id', async () => {
    const root = await temp.make()
    const id = 'prompt_20261107_120000_aaaaaaaa'
    await writeTree(root, { 'a.md': promptFile({ id, title: 'A' }, 'a'), 'b.md': promptFile({ id, title: 'B' }, 'b') })
    const result = await listAll(makeService(root))
    expect(result.entries.map(entry => [entry.relPath, entry.id])).toEqual(expect.arrayContaining([['a.md', id], ['b.md', id]]))
    expect(result.total).toBe(2)
  })

  it('reports read failures without caching them (POSIX permissions)', async (ctx) => {
    if (!canTestPermissions) ctx.skip()
    const root = await temp.make()
    await writeTree(root, { 'locked.md': '# Locked\n' })
    await chmod(join(root, 'locked.md'), 0o000)
    const service = makeService(root)
    expect((await listAll(service)).entries[0]).toMatchObject({ status: 'unreadable', unreadableReason: 'read-failed' })
    // 修好权限不会改变修改时间和大小，结果不能被缓存住
    await chmod(join(root, 'locked.md'), 0o644)
    expect((await listAll(service)).entries[0]).toMatchObject({ status: 'ok', title: 'Locked' })
  })

  it('skips an unreadable subfolder but keeps the rest of the library', async (ctx) => {
    if (!canTestPermissions) ctx.skip()
    const root = await temp.make()
    await writeTree(root, { 'a.md': '# A\n', 'closed/b.md': '# B\n' })
    await chmod(join(root, 'closed'), 0o000)
    const result = await listAll(makeService(root))
    await chmod(join(root, 'closed'), 0o755)
    expect(result.state).toBe('ok')
    expect(result.entries.map(entry => entry.relPath)).toEqual(['a.md'])
    expect(result.folders).toEqual(['closed'])
  })

  it('skips symbolic links to files and folders', async (ctx) => {
    const root = await temp.make()
    const outside = await temp.make()
    await writeTree(outside, { 'outside.md': '# Outside\n', 'dir/inner.md': '# Inner\n' })
    await writeTree(root, { 'real.md': '# Real\n' })
    if (!(await trySymlink(join(outside, 'dir'), join(root, 'linked-dir'), 'dir'))) ctx.skip()
    if (!(await trySymlink(join(outside, 'outside.md'), join(root, 'linked.md'), 'file'))) ctx.skip()
    const result = await listAll(makeService(root))
    expect(result.entries.map(entry => entry.relPath)).toEqual(['real.md'])
    expect(result.folders).toEqual([])
  })

  it('skips folders whose realpath is on the skip list (dsh data dir, skills dirs, <dsh>/promptx)', async () => {
    const root = await temp.make()
    await writeTree(root, { 'a.md': '# A\n', 'dsh-home/skills/s/SKILL.md': '# skill\n', 'dsh-home/x.md': '# x\n', 'other/b.md': '# B\n' })
    const skip = [join(await realpath(root), 'dsh-home')]
    const result = await listAll(makeService(root, { skipRealpaths: () => skip }))
    expect(result.entries.map(entry => entry.relPath).sort()).toEqual(['a.md', 'other/b.md'])
    expect(result.folders).toEqual(['other'])
  })

  it('treats `_Trash` as the trash only where the file system ignores case', async () => {
    const root = await temp.make()
    await writeTree(root, { '_Trash/x.md': '# x\n', 'a.md': '# a\n' })
    const linux = await listAll(makeService(root, {}, { platform: 'linux' }))
    expect(linux.entries.map(entry => entry.relPath).sort()).toEqual(['_Trash/x.md', 'a.md'])
    const mac = await listAll(makeService(root, {}, { platform: 'darwin' }))
    expect(mac.entries.map(entry => entry.relPath)).toEqual(['a.md'])
  })

  it('cleans up promptx temp files older than an hour and keeps fresh ones', async () => {
    const root = await temp.make()
    await writeTree(root, {
      'a.md': '# A\n',
      '.a.md.promptx-0123456789ab.tmp': 'stale',
      'sub/.b.md.promptx-abcdef012345.tmp': 'stale too',
      '.c.md.promptx-111111111111.tmp': 'fresh',
      '.other-tool.tmp': 'not ours',
    })
    const old = new Date(Date.now() - 2 * 3600_000)
    await utimes(join(root, '.a.md.promptx-0123456789ab.tmp'), old, old)
    await utimes(join(root, 'sub', '.b.md.promptx-abcdef012345.tmp'), old, old)
    await utimes(join(root, '.other-tool.tmp'), old, old)
    await listAll(makeService(root))
    expect(await exists(join(root, '.a.md.promptx-0123456789ab.tmp'))).toBe(false)
    expect(await exists(join(root, 'sub', '.b.md.promptx-abcdef012345.tmp'))).toBe(false)
    expect(await exists(join(root, '.c.md.promptx-111111111111.tmp'))).toBe(true)
    expect(await exists(join(root, '.other-tool.tmp'))).toBe(true)
  })
})

describe('library index cache (N-01)', () => {
  it('refreshes Windows entries when every stat cache key is unchanged', async () => {
    const root = await temp.make()
    const path = join(root, 'a.md')
    await writeFile(path, '# CCCC\n')
    const stats = await lstat(path)
    const previous = new Map([['a.md', indexedFromText('a.md', '# AAAA\n', stats)]])
    const entry = await indexPath(path, 'a.md', previous, 'win32')
    expect(entry?.doc.meta.title).toBe('CCCC')
  })

  it('rereads an edited file even when the editor preserves mtime and size', async () => {
    const root = await temp.make()
    await writeTree(root, { 'a.md': '# AAAA\n', 'b.md': '# BBBB\n' })
    await utimes(join(root, 'a.md'), TIME, TIME)
    const service = makeService(root)
    expect(byPath((await listAll(service)).entries).get('a.md')?.title).toBe('AAAA')
    // 外部编辑器保持 mtime 和文件大小时，ctime 仍能反映写入。
    await writeFile(join(root, 'a.md'), '# CCCC\n')
    await utimes(join(root, 'a.md'), TIME, TIME)
    expect(byPath((await listAll(service)).entries).get('a.md')?.title).toBe('CCCC')
    // 大小变了：重读
    await writeFile(join(root, 'a.md'), '# DDDDDD\n')
    expect(byPath((await listAll(service)).entries).get('a.md')?.title).toBe('DDDDDD')
  })

  it('answers queries from the cache without refreshing, and scans once when there is no cache yet', async () => {
    const root = await temp.make()
    await writeTree(root, { 'a.md': '# A\n' })
    const service = makeService(root)
    expect((await listAll(service, { refresh: false })).total).toBe(1)
    await writeTree(root, { 'b.md': '# B\n' })
    expect((await listAll(service, { refresh: false })).total).toBe(1)
    expect((await listAll(service, { refresh: true })).total).toBe(2)
    await rm(join(root, 'a.md'))
    expect((await listAll(service, { refresh: false })).total).toBe(2)
    expect((await listAll(service, { refresh: true })).total).toBe(1)
  })

  it('reset() drops the cache when the library directory changes', async () => {
    const first = await temp.make()
    const second = await temp.make()
    await writeTree(first, { 'a.md': '# A\n' })
    await writeTree(second, { 'b.md': '# B\n', 'c.md': '# C\n' })
    let root = first
    const service = makeService(first, { getRoot: () => root })
    expect((await listAll(service)).total).toBe(1)
    root = second
    service.reset()
    const result = await listAll(service, { refresh: false })
    expect(result.root).toBe(second)
    expect(result.total).toBe(2)
  })
})

describe('library root states (L-01, design-spec 7.4)', () => {
  it('reports a missing root as an empty library', async () => {
    const parent = await temp.make()
    const result = await listAll(makeService(join(parent, 'not', 'yet')))
    expect(result).toMatchObject({ state: 'missing', folders: [], tags: [], entries: [], total: 0, root: join(parent, 'not', 'yet') })
  })

  it('reports a root that is a file as unavailable', async () => {
    const parent = await temp.make()
    await writeFile(join(parent, 'file'), 'x')
    const result = await listAll(makeService(join(parent, 'file')))
    expect(result.state).toBe('unavailable')
    expect(result.error).toEqual({ code: 'promptx/library/unavailable', detail: 'ENOTDIR: not a directory' })
  })

  it('rechecks the location on every call and passes the configured root to checkRoot', async () => {
    const root = await temp.make()
    await writeTree(root, { 'a.md': '# A\n' })
    const seen: string[] = []
    let verdict: { code: string; detail?: string } | null = { code: 'promptx/library/unavailable', detail: 'library-dir-skills' }
    const service = makeService(root, {
      checkRoot: async (path) => {
        seen.push(path)
        return verdict
      },
    })
    const refused = await listAll(service)
    expect(refused).toMatchObject({ state: 'unavailable', error: { code: 'promptx/library/unavailable', detail: 'library-dir-skills' }, entries: [] })
    await expect(service.read('a.md')).rejects.toMatchObject({ code: 'promptx/library/unavailable', detail: 'library-dir-skills' })
    verdict = null
    expect((await listAll(service)).state).toBe('ok')
    expect(seen).toEqual([root, root, root])
  })

  it('refuses a relative library path instead of scanning the working directory', async () => {
    const result = await listAll(makeService('relative/library'))
    expect(result).toMatchObject({ state: 'unavailable', error: { detail: 'library-dir-relative' } })
  })

  it('accepts a root that is itself a symbolic link and reports the configured path', async (ctx) => {
    const real = await temp.make()
    const parent = await temp.make()
    await writeTree(real, { 'a.md': '# A\n' })
    const link = join(parent, 'library-link')
    if (!(await trySymlink(real, link, 'dir'))) ctx.skip()
    const result = await listAll(makeService(link))
    expect(result).toMatchObject({ state: 'ok', root: link, total: 1 })
  })
})

describe('list request checks (design-spec 9)', () => {
  it.each([
    ['a missing folder', { scope: 'all', tag: null, query: '', refresh: true }],
    ['an unknown folder kind', { folder: { kind: 'trash' }, scope: 'all', tag: null, query: '', refresh: true }],
    ['a folder without a path', { folder: { kind: 'folder' }, scope: 'all', tag: null, query: '', refresh: true }],
    ['an unknown scope', { folder: { kind: 'all' }, scope: 'starred', tag: null, query: '', refresh: true }],
    ['a tag that is not a string', { folder: { kind: 'all' }, scope: 'all', tag: 3, query: '', refresh: true }],
    ['a query that is not a string', { folder: { kind: 'all' }, scope: 'all', tag: null, query: null, refresh: true }],
    ['a refresh flag that is not a boolean', { folder: { kind: 'all' }, scope: 'all', tag: null, query: '', refresh: 'yes' }],
  ])('rejects %s', async (_label, params) => {
    const root = await temp.make()
    await expect(makeService(root).list(params as unknown as LibraryListParams))
      .rejects.toMatchObject({ code: 'promptx/internal', detail: 'invalid-params' })
  })

  it('lists nothing for a folder that does not exist (the companion falls back to all, L-03)', async () => {
    const root = await temp.make()
    await writeTree(root, { 'a.md': '# A\n' })
    const result = await listAll(makeService(root), { folder: { kind: 'folder', path: 'gone' } })
    expect(result).toMatchObject({ state: 'ok', entries: [], total: 1, folders: [] })
  })
})

describe('list filters and facets (L-03, L-04)', () => {
  async function filterLibrary(): Promise<string> {
    const root = await temp.make()
    await writeTree(root, {
      'a.md': promptFile({ title: '代码审查清单', tags: '[示例]', updated: '2026-11-01T00:00:00Z' }, '正文'),
      'b.md': promptFile({ title: '随手记', tags: '[杂项]', updated: '2026-11-07T00:00:00Z' }, '这里提到代码，也提到审查'),
      '写作/c.md': promptFile({ title: '写作模板', tags: '[示例, 写作]', favorite: 'true', updated: '2026-11-02T00:00:00Z' }, '代码'),
      '写作/评审/d.md': promptFile({ title: '评审意见', tags: '[示例]', favorite: 'true', updated: '2026-08-01T00:00:00Z' }, '旧的'),
      '写作素材/e.md': promptFile({ title: '素材', tags: '[示例]', favorite: 'true', updated: '2026-11-03T00:00:00Z' }, ''),
    })
    return root
  }

  it('lists all tags and the total regardless of the filters', async () => {
    const service = makeService(await filterLibrary())
    const result = await listAll(service, { folder: { kind: 'folder', path: '写作素材' } })
    expect(result.entries.map(entry => entry.relPath)).toEqual(['写作素材/e.md'])
    const collator = new Intl.Collator(undefined, { numeric: true })
    expect(result.tags).toEqual(['写作', '杂项', '示例'].sort((a, b) => collator.compare(a, b)))
    expect(result.total).toBe(5)
  })

  it('sorts by update time without a query and by match tier with one (L-04 acceptance 1)', async () => {
    const service = makeService(await filterLibrary())
    const plain = await listAll(service)
    expect(plain.entries.map(entry => entry.relPath)).toEqual(['b.md', '写作素材/e.md', '写作/c.md', 'a.md', '写作/评审/d.md'])
    const searched = await listAll(service, { query: '代码 审查', refresh: false })
    expect(searched.entries.map(entry => entry.relPath)).toEqual(['a.md', 'b.md'])
  })

  it('intersects folder, scope, tag and query (L-04 acceptance 2)', async () => {
    const service = makeService(await filterLibrary())
    const result = await listAll(service, { folder: { kind: 'folder', path: '写作' }, scope: 'favorites', tag: '示例' })
    expect(result.entries.map(entry => entry.relPath)).toEqual(['写作/c.md', '写作/评审/d.md'])
    const recent = await listAll(service, { folder: { kind: 'folder', path: '写作' }, scope: 'recent', refresh: false })
    expect(recent.entries.map(entry => entry.relPath)).toEqual(['写作/c.md'])
    const uncategorised = await listAll(service, { folder: { kind: 'root' }, refresh: false })
    expect(uncategorised.entries.map(entry => entry.relPath)).toEqual(['b.md', 'a.md'])
  })

  it('sorts folders parent first and siblings by name with numbers in order', () => {
    const folders = ['写作素材', '写作/评审', 'b10', '写作', 'b2', 'a/z', 'a']
    expect(folders.sort(compareFolderPaths)).toEqual(['a', 'a/z', 'b2', 'b10', '写作', '写作/评审', '写作素材'])
  })
})
