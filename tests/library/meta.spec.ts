import { readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MAX_PROMPT_BYTES } from '../../src/library/fs-safe.ts'
import type { LibraryService } from '../../src/library/service.ts'
import type { MetaResult } from '../../src/shared/types.ts'
import { NOW_STAMP, bindingFor, installCrashTraps, listAll, makeService, readText, sha256Of, useTempDirs, writeTree } from './helpers.ts'

installCrashTraps()
const temp = useTempDirs()

function savedMeta(result: MetaResult): Extract<MetaResult, { kind: 'saved' }> {
  if (result.kind !== 'saved') throw new Error(`expected saved, got ${result.conflict}`)
  return result
}

const BASE = [
  '---',
  'id: prompt_20261101_000000_abcdef01',
  'title: 旧标题   # 注释',
  'source: web',
  'tags:',
  '  - 旧',
  'favorite: false',
  'updated: 2026-01-01T00:00:00Z',
  '---',
  'body stays',
  '',
].join('\n')

describe('rename and tags (L-09)', () => {
  it('changes only title, tags and updated, keeping everything else byte for byte', async () => {
    const root = await temp.make()
    await writeTree(root, { 'a.md': BASE })
    const service = makeService(root)
    const result = savedMeta(await service.updateMeta({ relPath: 'a.md', patch: { title: '  新标题 ', tags: ['写作，示例; 写作 #评审'] }, addFrontMatter: false }))
    expect(await readText(root, 'a.md')).toBe([
      '---',
      'id: prompt_20261101_000000_abcdef01',
      'title: 新标题   # 注释',
      'source: web',
      'tags:',
      '  - 写作',
      '  - 示例',
      '  - 评审',
      'favorite: false',
      `updated: ${NOW_STAMP}`,
      '---',
      'body stays',
      '',
    ].join('\n'))
    expect(result.entry).toMatchObject({ title: '新标题', tags: ['写作', '示例', '评审'], updatedAt: Date.parse(NOW_STAMP) })
    expect(result.before).toEqual({ sha256: sha256Of(BASE), size: Buffer.byteLength(BASE) })
    const after = await readText(root, 'a.md')
    expect(result.after).toEqual({ sha256: sha256Of(after), size: Buffer.byteLength(after) })
  })

  it('keeps at most five tags and rewrites flow and same-indent block lists in place', async () => {
    const root = await temp.make()
    await writeTree(root, {
      'flow.md': '---\ntitle: F\ntags: [a, b]\n---\n',
      'block.md': '---\ntitle: B\ntags:\n- a\n- b\n---\n',
    })
    const service = makeService(root)
    savedMeta(await service.updateMeta({ relPath: 'flow.md', patch: { tags: ['k1,k2,k3,k4,k5,k6'] }, addFrontMatter: false }))
    expect(await readText(root, 'flow.md')).toBe(`---\ntitle: F\ntags: [k1, k2, k3, k4, k5]\nupdated: ${NOW_STAMP}\n---\n`)
    savedMeta(await service.updateMeta({ relPath: 'block.md', patch: { tags: ['c'] }, addFrontMatter: false }))
    expect(await readText(root, 'block.md')).toBe(`---\ntitle: B\ntags:\n- c\nupdated: ${NOW_STAMP}\n---\n`)
  })

  it('round-trips titles that need quoting', async () => {
    const root = await temp.make()
    await writeTree(root, { 'a.md': BASE })
    const service = makeService(root)
    savedMeta(await service.updateMeta({ relPath: 'a.md', patch: { title: 'Fix bug #123' }, addFrontMatter: false }))
    expect(await readText(root, 'a.md')).toContain('title: "Fix bug #123"   # 注释\n')
    expect((await listAll(service)).entries[0]?.title).toBe('Fix bug #123')
  })

  it.each(['', '   ', '\n'])('refuses a blank title %j', async (title) => {
    const root = await temp.make()
    await writeTree(root, { 'a.md': BASE })
    await expect(makeService(root).updateMeta({ relPath: 'a.md', patch: { title }, addFrontMatter: false }))
      .rejects.toMatchObject({ code: 'promptx/library/invalid-title' })
    expect(await readText(root, 'a.md')).toBe(BASE)
  })

  it('refuses to rewrite a tag list it cannot read safely, but still toggles favorite', async () => {
    const root = await temp.make()
    const content = '---\ntitle: T\ntags: a, b\n---\nbody'
    await writeTree(root, { 'a.md': content })
    const service = makeService(root)
    expect(await service.updateMeta({ relPath: 'a.md', patch: { tags: ['x'] }, addFrontMatter: false })).toEqual({ kind: 'conflict', conflict: 'unsupportedLayout' })
    expect(await readText(root, 'a.md')).toBe(content)
    savedMeta(await service.updateMeta({ relPath: 'a.md', patch: { favorite: true }, addFrontMatter: false }))
    expect(await readText(root, 'a.md')).toBe('---\ntitle: T\ntags: a, b\nfavorite: true\n---\nbody')
  })

  it('does not touch the file when nothing changes', async () => {
    const root = await temp.make()
    await writeTree(root, { 'a.md': BASE })
    const old = new Date('2026-10-01T00:00:00Z')
    await utimes(join(root, 'a.md'), old, old)
    const result = savedMeta(await makeService(root).updateMeta({ relPath: 'a.md', patch: { title: '旧标题', tags: ['旧'], favorite: false }, addFrontMatter: false }))
    expect(result.after).toEqual(result.before)
    expect((await stat(join(root, 'a.md'))).mtimeMs).toBe(old.getTime())
  })
})

describe('favorite (L-10)', () => {
  it('changes only the favorite line and never updated (L-10 acceptance)', async () => {
    const root = await temp.make()
    await writeTree(root, { 'a.md': BASE })
    const service = makeService(root)
    const result = savedMeta(await service.updateMeta({ relPath: 'a.md', patch: { favorite: true }, addFrontMatter: false }))
    expect(await readText(root, 'a.md')).toBe(BASE.replace('favorite: false', 'favorite: true'))
    expect(result.entry).toMatchObject({ favorite: true, updatedAt: Date.parse('2026-01-01T00:00:00Z') })
    const favorites = await listAll(service, { scope: 'favorites', refresh: false })
    expect(favorites.entries.map(entry => entry.relPath)).toEqual(['a.md'])
  })

  it('adds the favorite field before the closing line when it is missing', async () => {
    const root = await temp.make()
    await writeTree(root, { 'a.md': '---\ntitle: T\nupdated: 2026-01-01T00:00:00Z\n...\nbody' })
    savedMeta(await makeService(root).updateMeta({ relPath: 'a.md', patch: { favorite: true }, addFrontMatter: false }))
    expect(await readText(root, 'a.md')).toBe('---\ntitle: T\nupdated: 2026-01-01T00:00:00Z\nfavorite: true\n...\nbody')
  })
})

describe('metadata conflicts', () => {
  it('asks before adding front matter, then adds it with the file time for a favorite-only change', async () => {
    const root = await temp.make()
    await writeTree(root, { 'plain.md': '# Plain\n\nbody\n' })
    const stamp = new Date('2026-10-01T08:30:00Z')
    await utimes(join(root, 'plain.md'), stamp, stamp)
    const service = makeService(root)
    expect(await service.updateMeta({ relPath: 'plain.md', patch: { favorite: true }, addFrontMatter: false }))
      .toEqual({ kind: 'conflict', conflict: 'noFrontMatter' })
    expect(await readText(root, 'plain.md')).toBe('# Plain\n\nbody\n')
    const result = savedMeta(await service.updateMeta({ relPath: 'plain.md', patch: { favorite: true }, addFrontMatter: true }))
    expect(await readText(root, 'plain.md')).toBe([
      '---',
      `id: ${result.entry.id ?? ''}`,
      'title: Plain',
      'created: 2026-10-01T08:30:00Z',
      'updated: 2026-10-01T08:30:00Z',
      'favorite: true',
      '---',
      '# Plain',
      '',
      'body',
      '',
    ].join('\n'))
    expect(result.entry).toMatchObject({ favorite: true, hasFrontMatter: true, updatedAt: stamp.getTime() })
  })

  it('uses the current time when adding front matter for a rename', async () => {
    const root = await temp.make()
    await writeTree(root, { 'plain.md': 'body\n' })
    const result = savedMeta(await makeService(root).updateMeta({ relPath: 'plain.md', patch: { title: 'Named', tags: ['t'] }, addFrontMatter: true }))
    expect(await readText(root, 'plain.md')).toBe([
      '---',
      `id: ${result.entry.id ?? ''}`,
      'title: Named',
      `created: ${NOW_STAMP}`,
      `updated: ${NOW_STAMP}`,
      'tags:',
      '  - t',
      '---',
      'body',
      '',
    ].join('\n'))
  })

  it('refuses broken front matter and reports missing files', async () => {
    const root = await temp.make()
    const broken = '---\ntitle: a\ntitle: b\n---\nbody'
    await writeTree(root, { 'broken.md': broken })
    const service = makeService(root)
    expect(await service.updateMeta({ relPath: 'broken.md', patch: { favorite: true }, addFrontMatter: true }))
      .toEqual({ kind: 'conflict', conflict: 'invalidFrontMatter' })
    expect(await readText(root, 'broken.md')).toBe(broken)
    expect(await service.updateMeta({ relPath: 'gone.md', patch: { favorite: true }, addFrontMatter: false }))
      .toEqual({ kind: 'conflict', conflict: 'missing' })
    await expect(service.updateMeta({ relPath: '../x.md', patch: { favorite: true }, addFrontMatter: false }))
      .rejects.toMatchObject({ code: 'promptx/library/invalid-path' })
  })

  it('does not write when the file changes at the moment of writing (L-09)', async () => {
    const root = await temp.make()
    await writeTree(root, { 'a.md': BASE })
    const target = join(root, 'a.md')
    const service = makeService(root, {}, {
      hooks: { beforeVerify: async () => { await writeFile(target, BASE.replace('body stays', 'edited elsewhere')) } },
    })
    expect(await service.updateMeta({ relPath: 'a.md', patch: { favorite: true }, addFrontMatter: false }))
      .toEqual({ kind: 'conflict', conflict: 'modified' })
    expect(await readText(root, 'a.md')).toBe(BASE.replace('body stays', 'edited elsewhere'))
  })

  it('works on the latest disk content, not on what was read before the dialog opened', async () => {
    const root = await temp.make()
    await writeTree(root, { 'a.md': BASE })
    const service = makeService(root)
    await service.read('a.md')
    await writeFile(join(root, 'a.md'), BASE.replace('body stays', 'newer body'))
    savedMeta(await service.updateMeta({ relPath: 'a.md', patch: { title: '新' }, addFrontMatter: false }))
    const text = await readText(root, 'a.md')
    expect(text).toContain('newer body')
    expect(text).toContain('title: 新   # 注释')
  })
})

// 外部审查第 5 条：保存会检查单个文件 2 MiB 的上限，改元数据原来不查。贴着上限的文件补上 front matter 或加一行 favorite
// 之后超过上限，插件之后读它报 too-large，再也打不开、也改不回来。
describe('file size limit for metadata changes (external review 5)', () => {
  const HEAD = ['---', 'id: prompt_20261101_000000_abcdef01', 'title: 大文件', '---', ''].join('\n')

  it('refuses to add front matter that would push a file past 2 MiB and leaves it byte for byte', async () => {
    const root = await temp.make()
    const body = 'x'.repeat(MAX_PROMPT_BYTES)
    await writeTree(root, { 'big.md': body })
    const service = makeService(root)
    expect(await service.updateMeta({ relPath: 'big.md', patch: { favorite: true }, addFrontMatter: false })).toEqual({ kind: 'conflict', conflict: 'noFrontMatter' })
    await expect(service.updateMeta({ relPath: 'big.md', patch: { favorite: true }, addFrontMatter: true }))
      .rejects.toMatchObject({ code: 'promptx/library/write-failed', detail: 'EFBIG: file too large' })
    expect(sha256Of(await readFile(join(root, 'big.md')))).toBe(sha256Of(body))
  })

  it('refuses a favorite or rename that would push a file with front matter past the limit', async () => {
    const root = await temp.make()
    const text = HEAD + 'x'.repeat(MAX_PROMPT_BYTES - Buffer.byteLength(HEAD))
    await writeTree(root, { 'big.md': text })
    const service = makeService(root)
    await expect(service.updateMeta({ relPath: 'big.md', patch: { favorite: true }, addFrontMatter: false }))
      .rejects.toMatchObject({ code: 'promptx/library/write-failed', detail: 'EFBIG: file too large' })
    await expect(service.updateMeta({ relPath: 'big.md', patch: { title: '更长的标题' }, addFrontMatter: false }))
      .rejects.toMatchObject({ code: 'promptx/library/write-failed', detail: 'EFBIG: file too large' })
    expect(sha256Of(await readFile(join(root, 'big.md')))).toBe(sha256Of(text))
    expect((await service.read('big.md')).entry.favorite).toBe(false)
  })

  it('still writes a change that stays within the limit', async () => {
    const root = await temp.make()
    const text = HEAD + 'x'.repeat(MAX_PROMPT_BYTES - Buffer.byteLength(HEAD) - 100)
    await writeTree(root, { 'big.md': text })
    const service = makeService(root)
    savedMeta(await service.updateMeta({ relPath: 'big.md', patch: { favorite: true }, addFrontMatter: false }))
    const after = await readFile(join(root, 'big.md'))
    expect(after.length).toBeLessThanOrEqual(MAX_PROMPT_BYTES)
    expect((await service.read('big.md')).entry.favorite).toBe(true)
  })
})

describe('metadata request checks (design-spec 9)', () => {
  it.each([
    ['tags that are not a list', { relPath: 'a.md', patch: { tags: 'a, b' }, addFrontMatter: false }],
    ['a title that is not a string', { relPath: 'a.md', patch: { title: 5 }, addFrontMatter: false }],
    ['a favorite that is not a boolean', { relPath: 'a.md', patch: { favorite: 'yes' }, addFrontMatter: false }],
    ['a patch that is not an object', { relPath: 'a.md', patch: null, addFrontMatter: false }],
    ['addFrontMatter that is not a boolean', { relPath: 'a.md', patch: { favorite: true }, addFrontMatter: 'yes' }],
  ])('rejects %s and leaves the file alone', async (_label, params) => {
    const root = await temp.make()
    await writeTree(root, { 'a.md': BASE })
    await expect(makeService(root).updateMeta(params as unknown as Parameters<LibraryService['updateMeta']>[0]))
      .rejects.toMatchObject({ code: 'promptx/internal', detail: 'invalid-params' })
    expect(await readText(root, 'a.md')).toBe(BASE)
  })
})

describe('binding versions after a metadata change (S04, COV-03)', () => {
  it('reports before equal to the binding version for the bound file, so the next save does not conflict', async () => {
    const root = await temp.make()
    await writeTree(root, { 'a.md': BASE })
    const service = makeService(root)
    const binding = await bindingFor(service, root, 'a.md')
    const result = savedMeta(await service.updateMeta({ relPath: 'a.md', patch: { favorite: true }, addFrontMatter: false }))
    expect(result.before).toEqual({ sha256: binding.sha256, size: binding.size })
    // 小窗的规则：before 等于绑定的版本时把绑定换成 after
    const next = { ...binding, sha256: result.after.sha256, size: result.after.size }
    const saved = await service.save({ text: 'edited', binding: next, folder: null, mode: 'normal', requestId: '' })
    expect(saved.kind).toBe('saved')
    expect(await readText(root, 'a.md')).toContain('favorite: true')
    expect(await readText(root, 'a.md')).toContain('\n---\nedited')
  })

  it('reports a different before after an external edit, so the next save still raises the conflict', async () => {
    const root = await temp.make()
    await writeTree(root, { 'a.md': BASE })
    const service = makeService(root)
    const binding = await bindingFor(service, root, 'a.md')
    const external = BASE.replace('body stays', 'external body')
    await writeFile(join(root, 'a.md'), external)
    const result = savedMeta(await service.updateMeta({ relPath: 'a.md', patch: { favorite: true }, addFrontMatter: false }))
    expect(result.before).toEqual({ sha256: sha256Of(external), size: Buffer.byteLength(external) })
    expect(result.before.sha256).not.toBe(binding.sha256)
    // before 和绑定不同：小窗不动绑定，保存照常报外部修改，外部写入的正文不会被覆盖
    expect(await service.save({ text: 'mine', binding, folder: null, mode: 'normal', requestId: '' })).toEqual({ kind: 'conflict', conflict: 'modified' })
    expect(await readText(root, 'a.md')).toContain('external body')
  })

  it('reports missing when the file is deleted between the dialog and the write', async () => {
    const root = await temp.make()
    await writeTree(root, { 'a.md': BASE })
    const target = join(root, 'a.md')
    const service = makeService(root, {}, { hooks: { beforeVerify: async () => { await rm(target) } } })
    expect(await service.updateMeta({ relPath: 'a.md', patch: { favorite: true }, addFrontMatter: false }))
      .toEqual({ kind: 'conflict', conflict: 'missing' })
  })
})
