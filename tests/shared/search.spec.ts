import { describe, expect, it } from 'vitest'
import { collectTags, filterEntries, normalizeSearchText, RECENT_WINDOW_MS, splitQuery } from '../../src/shared/search.ts'
import type { SearchDoc, SearchParams } from '../../src/shared/search.ts'
import type { EntryMeta } from '../../src/shared/types.ts'

const NOW = Date.UTC(2026, 10, 8, 12, 0, 0)
const DAY = 24 * 60 * 60 * 1000

function meta(relPath: string, overrides: Partial<EntryMeta> = {}): EntryMeta {
  const slash = relPath.lastIndexOf('/')
  return {
    relPath,
    folder: slash < 0 ? '' : relPath.slice(0, slash),
    id: null,
    title: relPath.slice(slash + 1).replace(/\.md$/, ''),
    tags: [],
    favorite: false,
    updatedAt: NOW - DAY,
    createdAt: null,
    status: 'ok',
    hasFrontMatter: true,
    ...overrides,
  }
}

function doc(relPath: string, overrides: Partial<EntryMeta> = {}, body = ''): SearchDoc {
  return { meta: meta(relPath, overrides), body }
}

function search(docs: SearchDoc[], params: Partial<SearchParams> = {}): string[] {
  const full: SearchParams = { folder: { kind: 'all' }, scope: 'all', tag: null, query: '', ...params }
  return filterEntries(docs, full, NOW).map(entry => entry.relPath)
}

describe('normalizeSearchText', () => {
  it('lowercases text', () => {
    expect(normalizeSearchText('Hello WORLD')).toBe('hello world')
  })

  it('turns full-width ASCII and the full-width space into half-width', () => {
    expect(normalizeSearchText('ＡＢＣ１２３！～')).toBe('abc123!~')
    expect(normalizeSearchText('a\u3000b')).toBe('a b')
  })

  it('removes accents in composed and decomposed form', () => {
    expect(normalizeSearchText('Café Crème naïve')).toBe('cafe creme naive')
    expect(normalizeSearchText('cafe\u0301')).toBe('cafe')
    expect(normalizeSearchText('İstanbul')).toBe('istanbul')
  })

  it('folds compatibility characters', () => {
    expect(normalizeSearchText('\ufb01le \u2460')).toBe('file 1')
  })

  it('leaves Chinese text alone', () => {
    expect(normalizeSearchText('代码审查，Ｃｏｄｅ')).toBe('代码审查,code')
  })
})

describe('splitQuery', () => {
  it('splits normalized text on whitespace', () => {
    expect(splitQuery('  代码   审查 ')).toEqual(['代码', '审查'])
    expect(splitQuery('代码\u3000审查\tＡＢＣ Déf')).toEqual(['代码', '审查', 'abc', 'def'])
  })

  it('returns no words for blank input', () => {
    expect(splitQuery('')).toEqual([])
    expect(splitQuery(' \u3000\t\n')).toEqual([])
  })
})

describe('filterEntries without a query', () => {
  it('sorts by update time, newest first, then by title with numeric order', () => {
    const docs = [
      doc('old.md', { updatedAt: NOW - 3 * DAY }),
      doc('item-10.md', { title: 'item 10', updatedAt: NOW - DAY }),
      doc('item-2.md', { title: 'item 2', updatedAt: NOW - DAY }),
      doc('new.md', { updatedAt: NOW }),
    ]
    expect(search(docs)).toEqual(['new.md', 'item-2.md', 'item-10.md', 'old.md'])
  })

  it('breaks full ties by relative path', () => {
    const docs = [doc('b/x.md', { title: 'Same' }), doc('a/x.md', { title: 'Same' })]
    expect(search(docs)).toEqual(['a/x.md', 'b/x.md'])
  })

  it('treats a blank query as no query', () => {
    const docs = [doc('a.md', { updatedAt: NOW - 2 * DAY }), doc('b.md', { updatedAt: NOW })]
    expect(search(docs, { query: ' \u3000 ' })).toEqual(['b.md', 'a.md'])
  })
})

describe('filterEntries: folder, scope and tag', () => {
  const docs = [
    doc('root.md', { updatedAt: NOW - 1 }),
    doc('写作/a.md', { updatedAt: NOW - 2 }),
    doc('写作/评审/b.md', { updatedAt: NOW - 3 }),
    doc('写作素材/c.md', { updatedAt: NOW - 4 }),
  ]

  it('returns everything for all', () => {
    expect(search(docs, { folder: { kind: 'all' } })).toEqual(['root.md', '写作/a.md', '写作/评审/b.md', '写作素材/c.md'])
  })

  it('returns only files at the library root for root', () => {
    expect(search(docs, { folder: { kind: 'root' } })).toEqual(['root.md'])
  })

  it('includes subfolders but not sibling folders that share a prefix', () => {
    expect(search(docs, { folder: { kind: 'folder', path: '写作' } })).toEqual(['写作/a.md', '写作/评审/b.md'])
    expect(search(docs, { folder: { kind: 'folder', path: '写作/' } })).toEqual(['写作/a.md', '写作/评审/b.md'])
    expect(search(docs, { folder: { kind: 'folder', path: '写作/评审' } })).toEqual(['写作/评审/b.md'])
    expect(search(docs, { folder: { kind: 'folder', path: '不存在' } })).toEqual([])
  })

  it('treats the empty folder path as the whole library', () => {
    expect(search(docs, { folder: { kind: 'folder', path: '' } })).toHaveLength(4)
  })

  it('keeps entries updated within the last 30 days for recent', () => {
    expect(RECENT_WINDOW_MS).toBe(30 * DAY)
    const scoped = [
      doc('edge.md', { updatedAt: NOW - 30 * DAY }),
      doc('older.md', { updatedAt: NOW - 30 * DAY - 1 }),
      doc('future.md', { updatedAt: NOW + DAY }),
      doc('today.md', { updatedAt: NOW }),
    ]
    expect(search(scoped, { scope: 'recent' })).toEqual(['future.md', 'today.md', 'edge.md'])
  })

  it('keeps favorites for favorites', () => {
    const scoped = [doc('a.md', { favorite: true }), doc('b.md'), doc('c.md', { favorite: true })]
    expect(search(scoped, { scope: 'favorites' })).toEqual(['a.md', 'c.md'])
  })

  it('matches the tag case-insensitively', () => {
    const tagged = [doc('a.md', { tags: ['ai'] }), doc('b.md', { tags: ['x', 'Ai'] }), doc('c.md', { tags: ['aide'] }), doc('d.md')]
    expect(search(tagged, { tag: 'AI' })).toEqual(['a.md', 'b.md'])
    expect(search(tagged, { tag: 'missing' })).toEqual([])
    expect(search(tagged, { tag: null })).toHaveLength(4)
  })

  it('intersects folder, favorites and tag (acceptance example)', () => {
    const library = [
      doc('写作/a.md', { favorite: true, tags: ['示例'], updatedAt: NOW - 1 }),
      doc('写作/评审/b.md', { favorite: true, tags: ['x', '示例'], updatedAt: NOW - 2 }),
      doc('写作/c.md', { favorite: false, tags: ['示例'], updatedAt: NOW - 3 }),
      doc('写作/d.md', { favorite: true, tags: ['其他'], updatedAt: NOW - 4 }),
      doc('e.md', { favorite: true, tags: ['示例'], updatedAt: NOW - 5 }),
      doc('写作素材/f.md', { favorite: true, tags: ['示例'], updatedAt: NOW - 6 }),
    ]
    expect(search(library, { folder: { kind: 'folder', path: '写作' }, scope: 'favorites', tag: '示例' }))
      .toEqual(['写作/a.md', '写作/评审/b.md'])
  })

  it('applies the filters together with the query', () => {
    const library = [
      doc('写作/a.md', { title: '代码', favorite: true }),
      doc('写作/b.md', { title: '代码' }),
      doc('c.md', { title: '代码', favorite: true }),
    ]
    expect(search(library, { folder: { kind: 'folder', path: '写作' }, scope: 'favorites', query: '代码' })).toEqual(['写作/a.md'])
  })
})

describe('filterEntries with a query', () => {
  it('requires every word to appear in the title, a tag or the body', () => {
    const docs = [
      doc('split.md', { title: 'alpha', tags: ['beta'] }, 'gamma'),
      doc('missing.md', { title: 'alpha', tags: ['beta'] }, 'nothing'),
      doc('body.md', { title: 'x' }, 'alpha beta gamma'),
    ]
    expect(search(docs, { query: 'alpha beta gamma' })).toEqual(['split.md', 'body.md'])
  })

  it('matches substrings, ignoring case, width and accents', () => {
    const docs = [
      doc('cafe.md', { title: 'Café Notes' }),
      doc('width.md', { title: 'x' }, 'ABC def'),
      doc('tag.md', { title: 'y', tags: ['Ｒｅｖｉｅｗ'] }),
    ]
    expect(search(docs, { query: 'CAFE' })).toEqual(['cafe.md'])
    expect(search(docs, { query: 'ａｂｃ\u3000ＤＥＦ' })).toEqual(['width.md'])
    expect(search(docs, { query: 'review' })).toEqual(['tag.md'])
  })

  it('does not match the body of unreadable entries', () => {
    const docs = [
      doc('broken.md', { title: 'Broken', status: 'unreadable', unreadableReason: 'not-utf8' }, 'secret words'),
      doc('ok.md', { title: 'Fine' }, 'secret words'),
    ]
    expect(search(docs, { query: 'secret' })).toEqual(['ok.md'])
    expect(search(docs, { query: 'broken' })).toEqual(['broken.md'])
  })

  it('ranks the five match tiers in order regardless of update time', () => {
    const docs = [
      doc('t4-body-only.md', { title: 'Notes', updatedAt: NOW }, '这里讲代码和审查'),
      doc('t3-title-and-body.md', { title: '代码规范', updatedAt: NOW - 1 }, '需要审查'),
      doc('t2-tags.md', { title: 'Review', tags: ['代码', '审查'], updatedAt: NOW - 2 }),
      doc('t1-title.md', { title: '审查代码的要点', updatedAt: NOW - 3 }),
      doc('t0-prefix.md', { title: '代码 审查清单', updatedAt: NOW - 4 }),
    ]
    expect(search(docs, { query: '代码 审查' })).toEqual([
      't0-prefix.md',
      't1-title.md',
      't2-tags.md',
      't3-title-and-body.md',
      't4-body-only.md',
    ])
  })

  it('ranks titles containing both words above body-only matches (acceptance example)', () => {
    const docs = [
      doc('body-new.md', { title: '每周例会', updatedAt: NOW }, '记得做代码审查'),
      doc('title.md', { title: '团队的代码审查流程', updatedAt: NOW - 10 * DAY }, '流程说明'),
      doc('body-old.md', { title: '杂项', updatedAt: NOW - DAY }, '审查 代码 风格'),
    ]
    expect(search(docs, { query: '代码 审查' })).toEqual(['title.md', 'body-new.md', 'body-old.md'])
  })

  it('compares the title prefix with collapsed whitespace', () => {
    const docs = [
      doc('spaced.md', { title: '  代码   审查 指南', updatedAt: NOW - 1 }),
      doc('other.md', { title: '审查 代码', updatedAt: NOW }),
    ]
    expect(search(docs, { query: '代码    审查' })).toEqual(['spaced.md', 'other.md'])
  })

  it('puts a single word at the start of the title above one elsewhere in the title', () => {
    const docs = [
      doc('middle.md', { title: 'Team prompt', updatedAt: NOW }),
      doc('start.md', { title: 'Prompt basics', updatedAt: NOW - 1 }),
    ]
    expect(search(docs, { query: 'prompt' })).toEqual(['start.md', 'middle.md'])
  })

  it('prefers all words in the title over all words in the tags', () => {
    const docs = [
      doc('tags.md', { title: 'x', tags: ['alpha', 'beta'], updatedAt: NOW }),
      doc('title.md', { title: 'beta alpha', tags: ['alpha', 'beta'], updatedAt: NOW - 1 }),
    ]
    expect(search(docs, { query: 'alpha beta' })).toEqual(['title.md', 'tags.md'])
  })

  it('places tag-and-body matches without a title hit in the last tier', () => {
    const docs = [
      doc('tag-body.md', { title: 'x', tags: ['alpha'], updatedAt: NOW }, 'beta'),
      doc('title-body.md', { title: 'alpha', updatedAt: NOW - 1 }, 'beta'),
    ]
    expect(search(docs, { query: 'alpha beta' })).toEqual(['title-body.md', 'tag-body.md'])
  })

  it('sorts within a tier by update time and then by title', () => {
    const docs = [
      doc('b.md', { title: 'Beta guide', updatedAt: NOW - DAY }),
      doc('a.md', { title: 'Alpha guide', updatedAt: NOW - DAY }),
      doc('c.md', { title: 'Gamma guide', updatedAt: NOW }),
    ]
    expect(search(docs, { query: 'guide' })).toEqual(['c.md', 'a.md', 'b.md'])
  })

  it('uses the cached normalized body when one is given', () => {
    const cached: SearchDoc = { meta: meta('cached.md', { title: 'x' }), body: 'raw text', searchBody: 'normalized words' }
    expect(search([cached], { query: 'normalized' })).toEqual(['cached.md'])
    expect(search([cached], { query: 'raw' })).toEqual([])
    const unreadable: SearchDoc = { meta: meta('u.md', { title: 'x', status: 'unreadable' }), body: '', searchBody: 'normalized' }
    expect(search([unreadable], { query: 'normalized' })).toEqual([])
  })

  it('returns nothing when no entry matches', () => {
    expect(search([doc('a.md', { title: 'x' }, 'y')], { query: 'zzz' })).toEqual([])
  })
})

describe('collectTags', () => {
  it('deduplicates case-insensitively, keeps the first spelling and sorts', () => {
    const metas = [
      meta('a.md', { tags: ['Writing', 'b'] }),
      meta('b.md', { tags: ['writing', 'A', ' '] }),
      meta('c.md', { tags: ['v10', 'v2', 'B'] }),
    ]
    expect(collectTags(metas)).toEqual(['A', 'b', 'v2', 'v10', 'Writing'])
  })

  it('returns an empty list for an empty library', () => {
    expect(collectTags([])).toEqual([])
  })
})
