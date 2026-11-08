// 库列表的搜索、筛选和排序（需求 L-04，技术方案 7.2、D9）。在 Host 上执行，P1 的 Agent 工具复用同一套规则。

import { tagKey } from './library-rules.ts'
import type { EntryMeta, FolderSel, LibraryScope } from './types.ts'

/** 「最近」的范围：30 天。 */
export const RECENT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000

/**
 * 搜索比较用的文本：NFKD 分解，去掉组合附加符号（重音等），转小写，
 * 全角 ASCII（U+FF01–U+FF5E）转半角，全角空格转半角空格。搜索词和被搜的文本都要先过一遍。
 */
export function normalizeSearchText(text: string): string {
  // 纯 ASCII 文本只需要转小写；正文可能很长，跳过 Unicode 规范化能省不少时间
  if (/^[\x00-\x7f]*$/.test(text)) return text.toLowerCase()
  return text
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[\uff01-\uff5e]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replaceAll('\u3000', ' ')
}

/** 把搜索框里的文字规范化后按空白切成词。 */
export function splitQuery(query: string): string[] {
  return normalizeSearchText(query).split(/\s+/).filter(word => word !== '')
}

export interface SearchDoc {
  meta: EntryMeta
  /** 正文（LF）。status 为 unreadable 的条目不参与正文匹配。 */
  body: string
  /**
   * 可选：normalizeSearchText(body) 的结果。规范化正文是搜索里最慢的一步（1,000 条各 5 KB 的中文正文约 90 ms），
   * 索引按文件版本缓存这个值后，每次输入只剩字符串查找。不给时搜索时现算。
   */
  searchBody?: string
}

export interface SearchParams {
  folder: FolderSel
  scope: LibraryScope
  /** null 表示全部标签。 */
  tag: string | null
  query: string
}

let titleCollator: Intl.Collator | undefined

/** 标题排序：按界面语言比较，数字按数值比较（「第 2 条」排在「第 10 条」前面）。 */
function compareTitles(a: string, b: string): number {
  titleCollator ??= new Intl.Collator(undefined, { numeric: true })
  return titleCollator.compare(a, b)
}

/** 更新时间从新到旧，相同时按标题；标题也相同时按相对路径，保证顺序稳定。 */
function compareByUpdatedThenTitle(a: EntryMeta, b: EntryMeta): number {
  if (a.updatedAt !== b.updatedAt) return b.updatedAt - a.updatedAt
  const byTitle = compareTitles(a.title, b.title)
  if (byTitle !== 0) return byTitle
  return a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0
}

/**
 * 去掉结尾的 `/`。路径来自小窗的请求参数，不用 `/\/+$/`：它遇到一长串 `/` 后面跟别的字符时是平方级回溯，
 * 会在 Host 主线程上卡住（审查 SEC-02）。
 */
function trimTrailingSlashes(path: string): string {
  let end = path.length
  while (end > 0 && path.charCodeAt(end - 1) === 0x2f) end--
  return path.slice(0, end)
}

function inFolder(meta: EntryMeta, folder: FolderSel): boolean {
  switch (folder.kind) {
    case 'all':
      return true
    case 'root':
      return meta.folder === ''
    case 'folder': {
      // 选中文件夹时包含所有子文件夹；`写作` 不能匹配到同级的 `写作素材`
      const path = trimTrailingSlashes(folder.path)
      return path === '' || meta.folder === path || meta.folder.startsWith(`${path}/`)
    }
  }
}

function inScope(meta: EntryMeta, scope: LibraryScope, now: number): boolean {
  switch (scope) {
    case 'all':
      return true
    case 'recent':
      return now - meta.updatedAt <= RECENT_WINDOW_MS
    case 'favorites':
      return meta.favorite
  }
}

/**
 * 匹配程度，数字越小越靠前；不匹配（有词在标题、标签、正文里都找不到）时返回 null。
 * 0：标题以整个搜索词开头；1：所有词都在标题里；2：所有词都在标签里；3：标题和正文都有命中；4：其他（基本只在正文里）。
 */
function rank(doc: SearchDoc, words: readonly string[], phrase: string): number | null {
  const title = normalizeSearchText(doc.meta.title)
  const tags = doc.meta.tags.map(normalizeSearchText)
  const inTitle = words.map(word => title.includes(word))
  const inTags = words.map(word => tags.some(tag => tag.includes(word)))
  // 正文可能很长，用到时才规范化
  let body: string | undefined
  const bodyText = (): string => (body ??= doc.meta.status === 'unreadable' ? '' : doc.searchBody ?? normalizeSearchText(doc.body))
  const matched = words.every((word, index) => inTitle[index] === true || inTags[index] === true || bodyText().includes(word))
  if (!matched) return null
  if (title.replace(/\s+/g, ' ').trim().startsWith(phrase)) return 0
  if (inTitle.every(hit => hit)) return 1
  if (inTags.every(hit => hit)) return 2
  if (inTitle.some(hit => hit) && words.some(word => bodyText().includes(word))) return 3
  return 4
}

/**
 * 按文件夹范围、分段筛选、标签、搜索词取交集，排好序返回（L-04）。
 * 没有搜索词时按更新时间从新到旧，相同时按标题；有搜索词时先按匹配程度，同一档再按更新时间和标题。
 * now 用于「最近」：更新时间在 now 之前 30 天以内（含未来时间）。
 */
export function filterEntries(docs: readonly SearchDoc[], params: SearchParams, now: number): EntryMeta[] {
  const tag = params.tag === null ? null : tagKey(params.tag)
  const scoped = docs.filter(({ meta }) =>
    inFolder(meta, params.folder)
    && inScope(meta, params.scope, now)
    && (tag === null || meta.tags.some(own => tagKey(own) === tag)))
  const words = splitQuery(params.query)
  if (words.length === 0) return scoped.map(doc => doc.meta).sort(compareByUpdatedThenTitle)
  const phrase = words.join(' ')
  const ranked: { meta: EntryMeta; tier: number }[] = []
  for (const doc of scoped) {
    const tier = rank(doc, words, phrase)
    if (tier !== null) ranked.push({ meta: doc.meta, tier })
  }
  ranked.sort((a, b) => a.tier - b.tier || compareByUpdatedThenTitle(a.meta, b.meta))
  return ranked.map(item => item.meta)
}

/** 库里出现过的所有标签：忽略大小写去重（保留第一次出现的写法），按名称排序。 */
export function collectTags(metas: readonly EntryMeta[]): string[] {
  const byKey = new Map<string, string>()
  for (const meta of metas) {
    for (const tag of meta.tags) {
      if (tag.trim() === '') continue
      const key = tagKey(tag)
      if (!byKey.has(key)) byKey.set(key, tag)
    }
  }
  return [...byKey.values()].sort(compareTitles)
}
