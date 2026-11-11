// Prompt 文件的 front matter：文本层面的读取，以及只动被改字段那几行的写回（需求 6.2，技术方案 7.1）。
// 不引入 YAML 库。只解释 id、title、tags、favorite、created、updated 六个字段，其余内容只记位置、不解释，
// 写回时逐字节保留，用户手写的注释、自定义字段、顺序、缩进和引号都不会被插件改掉。
// 遇到解释不了的写法一律从严：要么整份标成写坏了（插件不改写这个文件），要么只拒绝写标签。

export type EolStyle = 'lf' | 'crlf'

/** front matter 里插件认识的字段。字段不存在或是空值（什么都不写、`~`、`null`）时不出现。 */
export interface FrontMatterFields {
  id?: string
  title?: string
  tags?: string[]
  favorite?: boolean
  /** 原样保留的时间字符串，排序时再解析（library-rules 的 parseTimestamp）。 */
  created?: string
  updated?: string
}

/**
 * tags 的写法。
 * - block：块列表（`- a`，缩进或与 `tags:` 同缩进）
 * - flow：单行的行内列表 `[a, b]`
 * - empty：`tags:` 后面什么都没有，或 `tags: []`、`tags: ~`
 * - absent：没有 tags 字段
 * - unsupported：其他写法（多行行内列表、锚点、`|` 块、普通字符串等）。读成空列表，写标签时拒绝
 */
export type TagsLayout = 'block' | 'flow' | 'empty' | 'absent' | 'unsupported'

export interface ParsedFrontMatter {
  /** invalid：写坏了或找不到结尾。按没有 front matter 显示（全文都是正文），插件不改写这个文件（L-01）。 */
  state: 'ok' | 'invalid'
  /** state 为 invalid 时是空对象。 */
  fields: FrontMatterFields
  tagsLayout: TagsLayout
}

export interface ParsedPromptFile {
  bom: boolean
  /** 以第一个换行为准；没有换行、或第一个换行是单独的 CR 时为 lf。 */
  eol: EolStyle
  /** null：文件没有 front matter。 */
  frontMatter: ParsedFrontMatter | null
  /**
   * 结尾分隔行之后的原文，换行不转换。没有 front matter、或 front matter 写坏了（包括找不到结尾）时，
   * 是去掉 BOM 后的全文（编辑区、预览、插入都要看到全部内容）。
   */
  body: string
}

export type FrontMatterPatch = FrontMatterFields

export type PatchFailure = 'no-front-matter' | 'invalid' | 'unsupported-layout'

export type PatchResult =
  | { ok: true; text: string }
  | { ok: false; reason: PatchFailure }

export interface NewFrontMatterFields {
  id: string
  title: string
  tags?: string[]
  created: string
  updated: string
}

export type YamlQuoteStyle = 'plain' | 'single' | 'double'

// ───────────────────────────── 字符与小工具 ─────────────────────────────

const TAB = 0x09
const LF = 0x0a
const CR = 0x0d
const SPACE = 0x20
const DQUOTE = 0x22
const HASH = 0x23
const SQUOTE = 0x27
const COMMA = 0x2c
const DASH = 0x2d
const COLON = 0x3a
const QUESTION = 0x3f
const LBRACKET = 0x5b
const BACKSLASH = 0x5c
const RBRACKET = 0x5d
const LBRACE = 0x7b
const RBRACE = 0x7d

/** 普通（不带引号的）标量不能以这些字符开头：YAML 会把它们当成集合、锚点、别名、标签、块标量、注释或保留字符。 */
const PLAIN_FORBIDDEN_FIRST = new Set(Array.from(',[]{}#&*!|>\'"%@`', ch => ch.charCodeAt(0)))

/** 行内集合里，引号只在这些字符之后才开始一个带引号的值；`it's` 里的单引号只是普通字符。 */
const BEFORE_FLOW_TOKEN = new Set([SPACE, TAB, LBRACKET, LBRACE, COMMA, COLON])

/** 普通标量写成这些值时 YAML 读成 null。 */
const NULL_WORDS = new Set(['~', 'null', 'Null', 'NULL'])

const SIMPLE_ESCAPES = new Map([
  ['0', '\0'], ['a', '\x07'], ['b', '\b'], ['t', '\t'], ['\t', '\t'], ['n', '\n'], ['v', '\v'], ['f', '\f'],
  ['r', '\r'], ['e', '\x1b'], [' ', ' '], ['"', '"'], ['/', '/'], ['\\', '\\'], ['N', '\u0085'], ['_', '\u00a0'],
  ['L', '\u2028'], ['P', '\u2029'],
])

const HEX_ESCAPE_DIGITS = new Map([['x', 2], ['u', 4], ['U', 8]])

function isBlank(code: number): boolean {
  return code === SPACE || code === TAB
}

function skipBlanks(text: string, from: number, end: number): number {
  let i = from
  while (i < end && isBlank(text.charCodeAt(i))) i++
  return i
}

function trimBlanksEnd(text: string, start: number, end: number): number {
  let i = end
  while (i > start && isBlank(text.charCodeAt(i - 1))) i--
  return i
}

function eolText(eol: EolStyle): string {
  return eol === 'crlf' ? '\r\n' : '\n'
}

/** 把任意换行统一成 LF。 */
export function toLf(text: string): string {
  return text.replace(/\r\n?/g, '\n')
}

/** 把 LF 文本转成指定换行风格；输入里混进的 CRLF、CR 先统一成 LF，避免写出 `\r\r\n`。 */
export function fromLf(text: string, eol: EolStyle): string {
  const lf = toLf(text)
  return eol === 'crlf' ? lf.replaceAll('\n', '\r\n') : lf
}

// ───────────────────────────── 行 ─────────────────────────────

interface Line {
  start: number
  /** 行内容结束的位置（换行符之前）。 */
  end: number
  /** 下一行开始的位置；最后一行没有换行符时等于 end。 */
  next: number
}

// LF、CRLF 和单独的 CR 都算换行，与读进编辑区时的换行统一（editorBody）保持一致。
function readLine(text: string, start: number): Line {
  let end = start
  while (end < text.length) {
    const code = text.charCodeAt(end)
    if (code === LF || code === CR) break
    end++
  }
  if (end === text.length) return { start, end, next: end }
  const crlf = text.charCodeAt(end) === CR && text.charCodeAt(end + 1) === LF
  return { start, end, next: end + (crlf ? 2 : 1) }
}

function detectEol(text: string, from: number): EolStyle {
  for (let i = from; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code === LF) return 'lf'
    if (code === CR) return text.charCodeAt(i + 1) === LF ? 'crlf' : 'lf'
  }
  return 'lf'
}

function isOpeningLine(text: string, line: Line): boolean {
  return /^---[ \t]*$/.test(text.slice(line.start, line.end))
}

function isClosingLine(text: string, line: Line): boolean {
  return /^(?:---|\.\.\.)[ \t]*$/.test(text.slice(line.start, line.end))
}

function isBlankOrComment(text: string, line: Line): boolean {
  const pos = skipBlanks(text, line.start, line.end)
  return pos === line.end || text.charCodeAt(pos) === HASH
}

/** 有没有空行和注释以外的内容。 */
function hasContent(text: string, lines: readonly Line[]): boolean {
  return lines.some(line => !isBlankOrComment(text, line))
}

/** pos 处是不是块列表项的 `-`（后面跟空白或行尾）。 */
function isSequenceDash(text: string, pos: number, end: number): boolean {
  return pos < end && text.charCodeAt(pos) === DASH && (pos + 1 === end || isBlank(text.charCodeAt(pos + 1)))
}

// ───────────────────────────── 标量 ─────────────────────────────

type TokenStyle = YamlQuoteStyle | 'empty'

/** 一个行内标量在原文里的位置。empty 表示冒号或 `-` 之后没有值，此时 start、end 都指向冒号或 `-` 之后。 */
interface ValueToken {
  style: TokenStyle
  /** 解码后的值；没写值或写的是 `~`、`null` 时为 null。 */
  value: string | null
  start: number
  end: number
}

interface Quoted {
  value: string
  /** 结尾引号之后的位置。 */
  end: number
}

function decodeEscape(text: string, pos: number, end: number): { text: string; next: number } | null {
  // 反斜杠在行尾是跨行的转义，按不支持处理
  if (pos >= end) return null
  const ch = text.charAt(pos)
  const simple = SIMPLE_ESCAPES.get(ch)
  if (simple !== undefined) return { text: simple, next: pos + 1 }
  const digits = HEX_ESCAPE_DIGITS.get(ch)
  if (digits === undefined || pos + 1 + digits > end) return null
  const hex = text.slice(pos + 1, pos + 1 + digits)
  if (!/^[\da-fA-F]+$/.test(hex)) return null
  const code = Number.parseInt(hex, 16)
  if (code > 0x10ffff) return null
  return { text: String.fromCodePoint(code), next: pos + 1 + digits }
}

/** 双引号值，只在本行内找结尾。不支持的转义或没有闭合返回 null。 */
function readDoubleQuoted(text: string, start: number, end: number): Quoted | null {
  let value = ''
  let chunk = start + 1
  let i = chunk
  while (i < end) {
    const code = text.charCodeAt(i)
    if (code === DQUOTE) return { value: value + text.slice(chunk, i), end: i + 1 }
    if (code !== BACKSLASH) {
      i++
      continue
    }
    const escaped = decodeEscape(text, i + 1, end)
    if (escaped === null) return null
    value += text.slice(chunk, i) + escaped.text
    i = escaped.next
    chunk = i
  }
  return null
}

/** 单引号值（`''` 表示一个单引号），只在本行内找结尾。 */
function readSingleQuoted(text: string, start: number, end: number): Quoted | null {
  let value = ''
  let chunk = start + 1
  let i = chunk
  while (i < end) {
    if (text.charCodeAt(i) !== SQUOTE) {
      i++
      continue
    }
    if (i + 1 < end && text.charCodeAt(i + 1) === SQUOTE) {
      value += text.slice(chunk, i + 1)
      i += 2
      chunk = i
      continue
    }
    return { value: value + text.slice(chunk, i), end: i + 1 }
  }
  return null
}

function readQuoted(text: string, start: number, end: number): Quoted | null {
  return text.charCodeAt(start) === DQUOTE ? readDoubleQuoted(text, start, end) : readSingleQuoted(text, start, end)
}

function canStartPlain(text: string, pos: number, end: number): boolean {
  const code = text.charCodeAt(pos)
  if (pos >= end || PLAIN_FORBIDDEN_FIRST.has(code)) return false
  // `-`、`?`、`:` 后面跟空白时是列表项、复杂键或映射的标记
  if (code === DASH || code === QUESTION || code === COLON) return pos + 1 < end && !isBlank(text.charCodeAt(pos + 1))
  return true
}

/** 值后面只剩空白，或空白加注释。注释的 `#` 前面必须有空白，`"a"#b` 在 YAML 里是错的。 */
function onlyCommentAfter(text: string, from: number, end: number): boolean {
  const pos = skipBlanks(text, from, end)
  return pos === end || (pos > from && text.charCodeAt(pos) === HASH)
}

/** 普通标量里行内注释的位置（前面有空白的 `#`），没有时返回 end。 */
function findComment(text: string, from: number, end: number): number {
  for (let i = from + 1; i < end; i++) {
    if (text.charCodeAt(i) === HASH && isBlank(text.charCodeAt(i - 1))) return i
  }
  return end
}

/**
 * 读冒号（或列表项的 `-`）之后的行内标量。读不了的写法返回 null：
 * 行内集合、锚点、别名、标签、块标量、本行没闭合的引号、引号后面还有别的内容、普通值里出现 `: ` 或以冒号结尾。
 */
function readInlineValue(text: string, from: number, end: number): ValueToken | null {
  const pos = skipBlanks(text, from, end)
  if (pos === end || text.charCodeAt(pos) === HASH) return { style: 'empty', value: null, start: from, end: from }
  const code = text.charCodeAt(pos)
  if (code === DQUOTE || code === SQUOTE) {
    const quoted = readQuoted(text, pos, end)
    if (quoted === null || !onlyCommentAfter(text, quoted.end, end)) return null
    return { style: code === DQUOTE ? 'double' : 'single', value: quoted.value, start: pos, end: quoted.end }
  }
  if (!canStartPlain(text, pos, end)) return null
  const tokenEnd = trimBlanksEnd(text, pos, findComment(text, pos, end))
  const raw = text.slice(pos, tokenEnd)
  // 普通值里有 `: ` 或以冒号结尾时，YAML 会报「这里不能出现映射」
  if (/:(?:[ \t]|$)/.test(raw)) return null
  return { style: 'plain', value: NULL_WORDS.has(raw) ? null : raw, start: pos, end: tokenEnd }
}

// ───────────────────────────── 顶层键 ─────────────────────────────

interface Entry {
  key: string
  line: Line
  /** 冒号之后的位置。 */
  keyEnd: number
  /** 行内的引号值或行内集合没在本行闭合，延续到了后面的行。 */
  multiline: boolean
  /** 属于这个键的后续行：缩进行、第 0 列的 `- ` 行、空行、注释行，以及跨行值占的行。 */
  children: Line[]
}

function findKeyColon(text: string, start: number, end: number): number {
  for (let i = start; i < end; i++) {
    const code = text.charCodeAt(i)
    // 键里出现前面有空白的 `#`：后半截是注释，这一行没有冒号
    if (code === HASH && i > start && isBlank(text.charCodeAt(i - 1))) return -1
    if (code === COLON && (i + 1 === end || isBlank(text.charCodeAt(i + 1)))) return i
  }
  return -1
}

/** 解析第 0 列的 `key: value` 行，返回解码后的键和冒号之后的位置；不是这种行时返回 null。 */
function readKey(text: string, line: Line): { key: string; keyEnd: number } | null {
  const { start, end } = line
  const first = text.charCodeAt(start)
  let key: string
  let colon: number
  if (first === DQUOTE || first === SQUOTE) {
    // 带引号的键（`"title": x`）在 YAML 里和不带引号的是同一个键，要认出来，否则补字段时会写出重复的键
    const quoted = readQuoted(text, start, end)
    if (quoted === null) return null
    key = quoted.value
    colon = skipBlanks(text, quoted.end, end)
    if (colon >= end || text.charCodeAt(colon) !== COLON) return null
  } else {
    if (!canStartPlain(text, start, end)) return null
    colon = findKeyColon(text, start, end)
    if (colon < 0) return null
    key = text.slice(start, trimBlanksEnd(text, start, colon))
  }
  if (colon + 1 < end && !isBlank(text.charCodeAt(colon + 1))) return null
  return { key, keyEnd: colon + 1 }
}

/**
 * 行内值以引号、`[` 或 `{` 开头时，找它闭合的那一行，返回该行在 lines 里的下标；到 front matter 结尾都没闭合返回 -1。
 * 这些值在 YAML 里可以合法地跨行。跨出去的行属于这个键，不能再当成新的键解析，
 * 否则引号值里恰好写着 `title: x` 的一行会被误认成标题。
 */
function findFlowEnd(text: string, lines: readonly Line[], index: number, from: number): number {
  let depth = 0
  let quote = 0
  for (let k = index; k < lines.length; k++) {
    const line = lines[k]
    if (line === undefined) break
    const lineStart = k === index ? from : line.start
    for (let i = lineStart; i < line.end; i++) {
      const code = text.charCodeAt(i)
      if (quote === DQUOTE) {
        if (code === BACKSLASH) {
          i++
        } else if (code === DQUOTE) {
          quote = 0
          if (depth === 0) return k
        }
        continue
      }
      if (quote === SQUOTE) {
        if (code !== SQUOTE) continue
        if (i + 1 < line.end && text.charCodeAt(i + 1) === SQUOTE) {
          i++
          continue
        }
        quote = 0
        if (depth === 0) return k
        continue
      }
      const tokenStart = i === lineStart || BEFORE_FLOW_TOKEN.has(text.charCodeAt(i - 1))
      if ((code === DQUOTE || code === SQUOTE) && tokenStart) {
        quote = code
      } else if (code === HASH && (i === line.start || isBlank(text.charCodeAt(i - 1)))) {
        break
      } else if (code === LBRACKET || code === LBRACE) {
        depth++
      } else if (code === RBRACKET || code === RBRACE) {
        depth--
        if (depth <= 0) return k
      }
    }
  }
  return -1
}

/**
 * 把 front matter 的行分到各个顶层键下。结构解释不了时返回 null（整份按写坏了处理）：
 * 第一个键之前出现缩进内容或列表项（整体缩进的映射、顶层列表），第 0 列出现不是 `key: value` 的内容，
 * 跨行的引号值或行内集合一直没闭合。这些情况下往里插字段会破坏结构，所以不碰。
 */
function splitEntries(text: string, lines: readonly Line[]): Entry[] | null {
  const entries: Entry[] = []
  let current: Entry | null = null
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]
    if (line === undefined) break
    const first = text.charCodeAt(line.start)
    const neutral = isBlankOrComment(text, line)
    if (neutral || isBlank(first) || isSequenceDash(text, line.start, line.end)) {
      if (current !== null) current.children.push(line)
      else if (!neutral) return null
      continue
    }
    const key = readKey(text, line)
    if (key === null) return null
    const entry: Entry = { key: key.key, line, keyEnd: key.keyEnd, multiline: false, children: [] }
    const valueStart = skipBlanks(text, key.keyEnd, line.end)
    const opener = text.charCodeAt(valueStart)
    if (valueStart < line.end && (opener === DQUOTE || opener === SQUOTE || opener === LBRACKET || opener === LBRACE)) {
      const last = findFlowEnd(text, lines, index, valueStart)
      if (last < 0) return null
      for (let k = index + 1; k <= last; k++) {
        const continued = lines[k]
        if (continued !== undefined) entry.children.push(continued)
      }
      entry.multiline = last > index
      index = last
    }
    entries.push(entry)
    current = entry
  }
  return entries
}

// ───────────────────────────── 认识的字段 ─────────────────────────────

type ScalarKey = 'id' | 'title' | 'favorite' | 'created' | 'updated'

function isScalarKey(key: string): key is ScalarKey {
  return key === 'id' || key === 'title' || key === 'favorite' || key === 'created' || key === 'updated'
}

interface ScalarField {
  entry: Entry
  token: ValueToken
}

interface TagItem {
  line: Line
  token: ValueToken
}

interface TagsInfo {
  layout: TagsLayout
  tags: string[]
  entry: Entry | null
  /** 行内值（`[a, b]`、`[]`、`~`）的位置；没有行内值时 start、end 都是冒号之后。 */
  inline: { start: number; end: number } | null
  /** block 布局的列表项，按出现顺序。 */
  items: TagItem[]
}

interface FrontMatterInfo {
  fields: FrontMatterFields
  scalars: Partial<Record<ScalarKey, ScalarField>>
  tags: TagsInfo
}

const ABSENT_TAGS: TagsInfo = { layout: 'absent', tags: [], entry: null, inline: null, items: [] }

function unsupportedTags(entry: Entry): TagsInfo {
  return { layout: 'unsupported', tags: [], entry, inline: null, items: [] }
}

/** 单行的行内列表 `[a, "b", c]`。嵌套、注释、映射、跨行都返回 null。count 是项数（含空值项）。 */
function readFlowList(text: string, open: number, end: number): { tags: string[]; count: number; end: number } | null {
  const tags: string[] = []
  let count = 0
  let i = skipBlanks(text, open + 1, end)
  if (i < end && text.charCodeAt(i) === RBRACKET) return { tags, count, end: i + 1 }
  while (i < end) {
    let value: string | null
    const code = text.charCodeAt(i)
    if (code === DQUOTE || code === SQUOTE) {
      const quoted = readQuoted(text, i, end)
      if (quoted === null) return null
      value = quoted.value
      i = quoted.end
    } else {
      if (!canStartPlain(text, i, end)) return null
      let stop = i
      while (stop < end && text.charCodeAt(stop) !== COMMA && text.charCodeAt(stop) !== RBRACKET) stop++
      const raw = text.slice(i, trimBlanksEnd(text, i, stop))
      if (/[[\]{}]|:(?:[ \t]|$)|[ \t]#/.test(raw)) return null
      value = NULL_WORDS.has(raw) ? null : raw
      i = stop
    }
    count++
    if (value !== null && value !== '') tags.push(value)
    i = skipBlanks(text, i, end)
    if (i >= end) return null
    if (text.charCodeAt(i) === RBRACKET) return { tags, count, end: i + 1 }
    if (text.charCodeAt(i) !== COMMA) return null
    // YAML 允许结尾多一个逗号：`[a, b, ]`
    i = skipBlanks(text, i + 1, end)
    if (i < end && text.charCodeAt(i) === RBRACKET) return { tags, count, end: i + 1 }
  }
  return null
}

function readBlockTags(text: string, entry: Entry): TagsInfo {
  const items: TagItem[] = []
  let indent = -1
  for (const line of entry.children) {
    if (isBlankOrComment(text, line)) continue
    let dash = line.start
    while (dash < line.end && text.charCodeAt(dash) === SPACE) dash++
    // 列表项必须同一缩进；用 tab 缩进、续行、嵌套列表、映射项都不认
    if (!isSequenceDash(text, dash, line.end) || (indent >= 0 && dash - line.start !== indent)) return unsupportedTags(entry)
    indent = dash - line.start
    const token = readInlineValue(text, dash + 1, line.end)
    if (token === null) return unsupportedTags(entry)
    items.push({ line, token })
  }
  return {
    layout: items.length === 0 ? 'empty' : 'block',
    tags: items.flatMap(({ token }) => (token.value === null || token.value === '' ? [] : [token.value])),
    entry,
    inline: { start: entry.keyEnd, end: entry.keyEnd },
    items,
  }
}

function readTags(text: string, entry: Entry): TagsInfo {
  if (entry.multiline) return unsupportedTags(entry)
  const { keyEnd, line } = entry
  const pos = skipBlanks(text, keyEnd, line.end)
  if (pos === line.end || text.charCodeAt(pos) === HASH) return readBlockTags(text, entry)
  if (hasContent(text, entry.children)) return unsupportedTags(entry)
  if (text.charCodeAt(pos) === LBRACKET) {
    const flow = readFlowList(text, pos, line.end)
    if (flow === null || !onlyCommentAfter(text, flow.end, line.end)) return unsupportedTags(entry)
    return {
      layout: flow.count === 0 ? 'empty' : 'flow',
      tags: flow.tags,
      entry,
      inline: { start: pos, end: flow.end },
      items: [],
    }
  }
  // `tags: ~`、`tags: null` 是空值，和 `tags:` 一样当空列表；其他标量（如 `tags: a, b`）不认
  const token = readInlineValue(text, keyEnd, line.end)
  if (token !== null && token.style === 'plain' && token.value === null) {
    return { layout: 'empty', tags: [], entry, inline: { start: token.start, end: token.end }, items: [] }
  }
  return unsupportedTags(entry)
}

/** 解释认识的字段。字段解析失败、同一个认识的字段出现两次时返回 null（整份按写坏了处理）。 */
function interpret(text: string, lines: readonly Line[]): FrontMatterInfo | null {
  const entries = splitEntries(text, lines)
  if (entries === null) return null
  const fields: FrontMatterFields = {}
  const scalars: Partial<Record<ScalarKey, ScalarField>> = {}
  let tags = ABSENT_TAGS
  for (const entry of entries) {
    const key = entry.key
    if (key === 'tags') {
      if (tags.entry !== null) return null
      tags = readTags(text, entry)
      fields.tags = tags.tags
      continue
    }
    if (!isScalarKey(key)) continue
    if (scalars[key] !== undefined) return null
    // 值跨行（多行引号值、续行的普通值、下面跟着列表或映射）都不支持
    if (entry.multiline || hasContent(text, entry.children)) return null
    const token = readInlineValue(text, entry.keyEnd, entry.line.end)
    if (token === null) return null
    scalars[key] = { entry, token }
    if (token.value === null) continue
    if (key === 'favorite') {
      const lower = token.value.toLowerCase()
      if (lower !== 'true' && lower !== 'false') return null
      fields.favorite = lower === 'true'
    } else {
      fields[key] = token.value
    }
  }
  return { fields, scalars, tags }
}

// ───────────────────────────── 整个文件 ─────────────────────────────

interface FileScan {
  bom: boolean
  eol: EolStyle
  /** BOM 之后的位置。 */
  contentStart: number
  /** null：没有 front matter。close 为 null：找不到结尾。info 为 null：写坏了。 */
  frontMatter: { close: Line | null; info: FrontMatterInfo | null } | null
}

function scanFile(text: string): FileScan {
  const bom = text.charCodeAt(0) === 0xfeff
  const contentStart = bom ? 1 : 0
  const eol = detectEol(text, contentStart)
  const open = readLine(text, contentStart)
  if (!isOpeningLine(text, open)) return { bom, eol, contentStart, frontMatter: null }
  const lines: Line[] = []
  let line = open
  while (line.next > line.end) {
    line = readLine(text, line.next)
    if (isClosingLine(text, line)) return { bom, eol, contentStart, frontMatter: { close: line, info: interpret(text, lines) } }
    lines.push(line)
  }
  return { bom, eol, contentStart, frontMatter: { close: null, info: null } }
}

/** 解析 Prompt 文件的文本（已按 UTF-8 解码，开头可以有 BOM）。 */
export function parsePromptFile(text: string): ParsedPromptFile {
  const { bom, eol, contentStart, frontMatter } = scanFile(text)
  if (frontMatter === null) return { bom, eol, frontMatter: null, body: text.slice(contentStart) }
  const { close, info } = frontMatter
  // 写坏了（包括找不到结尾）：按没有 front matter 处理，全文都是正文（L-01）。只取结尾行之后的部分时，
  // 两个 `---` 之间的文字在预览、插入到光标、复制正文、在编辑器中打开里都会悄悄消失（审查 F1）。
  // 写入不受影响：state 是 invalid，保存、改元数据一律拒绝
  if (close === null || info === null) {
    return { bom, eol, frontMatter: { state: 'invalid', fields: {}, tagsLayout: 'absent' }, body: text.slice(contentStart) }
  }
  return { bom, eol, frontMatter: { state: 'ok', fields: info.fields, tagsLayout: info.tags.layout }, body: text.slice(close.next) }
}

/** 读进编辑区的正文：CRLF、CR 统一成 LF。 */
export function editorBody(parsed: ParsedPromptFile): string {
  return toLf(parsed.body)
}

// ───────────────────────────── 写值 ─────────────────────────────

// YAML 不能直接写进单行普通值或单引号值的字符：控制字符、换行、C1 控制字符、行分隔符、BOM 和非字符。
// 这些值只能用双引号加转义写。
const NEEDS_ESCAPE = /[\x00-\x08\x0a-\x1f\x7f-\x9f\u2028\u2029\ufeff\ufffe\uffff]/

const SPECIAL_WORDS = /^(?:~|null|true|false|yes|no|on|off|y|n)$/i

const NUMBER_LIKE = [
  /^[-+]?(?:\d[\d_]*(?:\.[\d_]*)?|\.\d[\d_]*)(?:[eE][-+]?\d+)?$/,
  /^[-+]?0[xX][\da-fA-F_]+$/,
  /^[-+]?0[oO][0-7_]+$/,
  /^[-+]?0[bB][01_]+$/,
  /^[-+]?\.(?:inf|Inf|INF)$/,
  /^\.(?:nan|NaN|NAN)$/,
  // YAML 1.1 的六十进制数，例如 `12:30` 会被读成 750
  /^[-+]?\d[\d_]*(?::[0-5]?\d)+(?:\.[\d_]*)?$/,
]

/** 看起来像日期或时间戳的值。很多工具（js-yaml、PyYAML）按 YAML 1.1 把它读成日期对象，标题要加引号。 */
const TIMESTAMP_LIKE = /^\d{4}-\d{1,2}-\d{1,2}(?:$|[Tt\s])/

interface PlainOptions {
  /** 行内列表里的项：逗号、方括号、花括号、冒号、`#` 都要加引号。 */
  flow?: boolean
  /** created、updated 本来就是时间，像时间戳的值可以不加引号。 */
  timestamp?: boolean
}

function isPlainSafe(value: string, options: PlainOptions): boolean {
  if (value === '' || /^\s|\s$/.test(value) || NEEDS_ESCAPE.test(value)) return false
  if (PLAIN_FORBIDDEN_FIRST.has(value.charCodeAt(0)) || /^[-?:]/.test(value)) return false
  if (/:(?:[ \t]|$)|[ \t]#/.test(value)) return false
  if (options.flow === true && /[,[\]{}:#]/.test(value)) return false
  if (SPECIAL_WORDS.test(value) || NUMBER_LIKE.some(pattern => pattern.test(value))) return false
  return options.timestamp === true || !TIMESTAMP_LIKE.test(value)
}

function escapeDoubleQuoted(value: string): string {
  let out = ''
  for (const ch of value) {
    if (ch === '\\') out += '\\\\'
    else if (ch === '"') out += '\\"'
    else if (ch === '\n') out += '\\n'
    else if (ch === '\t') out += '\\t'
    else if (ch === '\r') out += '\\r'
    else if (NEEDS_ESCAPE.test(ch)) out += `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`
    else out += ch
  }
  return `"${out}"`
}

function formatScalar(value: string, style: YamlQuoteStyle, options: PlainOptions): string {
  if (style === 'double' || NEEDS_ESCAPE.test(value)) return escapeDoubleQuoted(value)
  if (style === 'single') return `'${value.replaceAll('\'', '\'\'')}'`
  return isPlainSafe(value, options) ? value : escapeDoubleQuoted(value)
}

/**
 * 把字符串写成 YAML 单行标量。plain：能不加引号就不加，需要时改用双引号；single：单引号（`''` 转义），
 * 含换行等控制字符时改用双引号；double：双引号加转义。
 * plain 在这些情况下加引号：首尾有空白、含 `: ` 或 ` #`、以 YAML 特殊字符开头、
 * 看起来像布尔值、空值、数字或日期、空串。
 */
export function formatYamlString(value: string, style: YamlQuoteStyle = 'plain'): string {
  return formatScalar(value, style, {})
}

function formatTimestamp(value: string, style: YamlQuoteStyle = 'plain'): string {
  return formatScalar(value, style, { timestamp: true })
}

function formatFlowItem(value: string): string {
  return formatScalar(value, 'plain', { flow: true })
}

// ───────────────────────────── 写回 ─────────────────────────────

interface Edit {
  start: number
  end: number
  text: string
}

/** 按位置从前往后应用修改。同一位置的插入按加入顺序排列。修改之间不能重叠。 */
function applyEdits(text: string, edits: readonly Edit[]): string {
  const sorted = edits
    .map((edit, order) => ({ edit, order }))
    .sort((a, b) => a.edit.start - b.edit.start || a.order - b.order)
  let out = ''
  let pos = 0
  for (const { edit } of sorted) {
    out += text.slice(pos, edit.start) + edit.text
    pos = edit.end
  }
  return out + text.slice(pos)
}

interface PatchContext {
  text: string
  eol: string
  info: FrontMatterInfo
  edits: Edit[]
  /** 缺少的字段，按 id、title、tags、favorite、created、updated 的顺序插在结尾分隔行之前。 */
  missing: string[]
}

/** 替换一个行内值。原来没写值时在冒号（或 `-`）后面补一个空格再写。 */
function replaceToken(ctx: PatchContext, token: ValueToken, formatted: string): void {
  ctx.edits.push({ start: token.start, end: token.end, text: token.style === 'empty' ? ` ${formatted}` : formatted })
}

function patchScalar(ctx: PatchContext, key: 'id' | 'title' | 'created' | 'updated', value: string): void {
  const format = key === 'created' || key === 'updated' ? formatTimestamp : formatYamlString
  const field = ctx.info.scalars[key]
  if (field === undefined) {
    ctx.missing.push(`${key}: ${format(value)}${ctx.eol}`)
    return
  }
  const { token } = field
  if (token.value === value) return
  // 沿用原来的引号写法；原来没写值时按不加引号处理
  replaceToken(ctx, token, format(value, token.style === 'empty' ? 'plain' : token.style))
}

function patchFavorite(ctx: PatchContext, value: boolean): void {
  const field = ctx.info.scalars.favorite
  if (field === undefined) {
    ctx.missing.push(`favorite: ${value}${ctx.eol}`)
    return
  }
  const { token } = field
  if (ctx.info.fields.favorite === value) return
  const literal = String(value)
  const formatted = token.style === 'single' ? `'${literal}'` : token.style === 'double' ? `"${literal}"` : literal
  replaceToken(ctx, token, formatted)
}

function sameTags(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((tag, index) => tag === b[index])
}

function blockItems(tags: readonly string[], eol: string): string {
  return tags.map(tag => `  - ${formatYamlString(tag)}`).join(eol)
}

/**
 * 块列表按位置改写：第 k 项换成新的第 k 个标签（值没变的行不动，行尾注释保留），
 * 多出来的旧项整行删掉，新增的项接在最后一项后面，沿用第一项的缩进和 `- ` 写法。
 * 列表项之间的注释行和空行原样留在原处。
 */
function patchBlockTags(ctx: PatchContext, tagsInfo: TagsInfo, entry: Entry, tags: readonly string[]): void {
  const { text, eol, edits } = ctx
  const { items } = tagsInfo
  if (tags.length === 0) {
    // 块列表写不出空列表，改成 `tags: []`（D11）
    edits.push({ start: entry.keyEnd, end: entry.keyEnd, text: ' []' })
    for (const item of items) edits.push({ start: item.line.start, end: item.line.next, text: '' })
    return
  }
  const first = items[0]
  if (first === undefined) return
  const prefix = text.slice(first.line.start, first.token.start) + (first.token.style === 'empty' ? ' ' : '')
  items.forEach((item, index) => {
    const tag = tags[index]
    if (tag === undefined) edits.push({ start: item.line.start, end: item.line.next, text: '' })
    else if (item.token.value !== tag) replaceToken(ctx, item.token, formatYamlString(tag))
  })
  const last = items[items.length - 1]
  if (last === undefined || tags.length <= items.length) return
  const added = tags.slice(items.length).map(tag => `${prefix}${formatYamlString(tag)}${eol}`).join('')
  edits.push({ start: last.line.next, end: last.line.next, text: added })
}

function patchTags(ctx: PatchContext, tags: readonly string[]): void {
  const { text, eol, edits, info } = ctx
  const tagsInfo = info.tags
  const { entry, inline } = tagsInfo
  if (entry === null || inline === null) {
    // 没有 tags 字段：新加的用块列表；空列表写 `tags: []`（D11）
    ctx.missing.push(tags.length === 0 ? `tags: []${eol}` : `tags:${eol}${blockItems(tags, eol)}${eol}`)
    return
  }
  if (sameTags(tagsInfo.tags, tags)) return
  switch (tagsInfo.layout) {
    case 'empty': {
      // `tags:`、`tags: []` 第一次加标签时改写成两格缩进的块列表，行尾注释留在 `tags:` 后面
      const rest = text.slice(inline.end, entry.line.end)
      const keyLine = text.slice(entry.line.start, entry.keyEnd) + (/^[ \t]*$/.test(rest) ? '' : rest)
      edits.push({ start: entry.line.start, end: entry.line.end, text: `${keyLine}${eol}${blockItems(tags, eol)}` })
      return
    }
    case 'flow':
      edits.push({ start: inline.start, end: inline.end, text: `[${tags.map(formatFlowItem).join(', ')}]` })
      return
    case 'block':
      patchBlockTags(ctx, tagsInfo, entry, tags)
      return
    case 'absent':
    case 'unsupported':
      return
  }
}

/**
 * 只改 patch 里给出的字段，其他字节一律不动。已有的字段原地替换值（沿用原来的引号写法），
 * 缺少的字段按 id、title、tags、favorite、created、updated 的顺序插在结尾分隔行之前，换行沿用文件原来的风格。
 * 没有 front matter、front matter 写坏了、tags 写法无法识别却要写标签时拒绝，不做任何修改。
 */
export function patchFrontMatter(text: string, patch: FrontMatterPatch): PatchResult {
  const { eol, frontMatter } = scanFile(text)
  if (frontMatter === null) return { ok: false, reason: 'no-front-matter' }
  const { close, info } = frontMatter
  if (close === null || info === null) return { ok: false, reason: 'invalid' }
  if (patch.tags !== undefined && info.tags.layout === 'unsupported') return { ok: false, reason: 'unsupported-layout' }
  const ctx: PatchContext = { text, eol: eolText(eol), info, edits: [], missing: [] }
  if (patch.id !== undefined) patchScalar(ctx, 'id', patch.id)
  if (patch.title !== undefined) patchScalar(ctx, 'title', patch.title)
  if (patch.tags !== undefined) patchTags(ctx, patch.tags)
  if (patch.favorite !== undefined) patchFavorite(ctx, patch.favorite)
  if (patch.created !== undefined) patchScalar(ctx, 'created', patch.created)
  if (patch.updated !== undefined) patchScalar(ctx, 'updated', patch.updated)
  if (ctx.missing.length > 0) ctx.edits.push({ start: close.start, end: close.start, text: ctx.missing.join('') })
  return { ok: true, text: applyEdits(text, ctx.edits) }
}

/**
 * 替换正文：BOM 和 front matter（到结尾分隔行的换行符为止）逐字节保留，正文里的 LF 按文件原来的换行风格写。
 * 正文的范围和 parsePromptFile 的 body 一致：没有 front matter、或 front matter 写坏了（包括找不到结尾）时，
 * BOM 之后的全部内容都是正文。库服务对写坏了的文件一律拒绝写入，不会走到这里；万一传进来的是编辑区里的全文，
 * 也不会在原来的分隔行后面再接一份（审查 F1）。
 */
export function replaceBody(text: string, bodyLF: string): string {
  const { eol, contentStart, frontMatter } = scanFile(text)
  const body = fromLf(bodyLF, eol)
  const close = frontMatter !== null && frontMatter.info !== null ? frontMatter.close : null
  if (close === null) return text.slice(0, contentStart) + body
  const head = text.slice(0, close.next)
  // 结尾分隔行是文件最后一行、后面没有换行符时，要先补一个换行，否则正文会接在 `---` 后面
  return close.next === close.end && body !== '' ? head + eolText(eol) + body : head + body
}

function renderFrontMatter(lines: readonly string[], eol: string): string {
  return ['---', ...lines, '---', ''].join(eol)
}

function renderTags(tags: readonly string[], eol: string): string {
  return tags.length === 0 ? 'tags: []' : `tags:${eol}${blockItems(tags, eol)}`
}

/**
 * 给没有 front matter 的文件补上 id、title、可选的 tags、created、updated（L-08「补上并保存」）。
 * 换行沿用文件原来的风格，BOM 留在最前面，原来的内容逐字节接在后面。文件已经有完整的 front matter 时抛错。
 */
export function addFrontMatter(text: string, fields: NewFrontMatterFields): string {
  const { bom, eol, contentStart, frontMatter } = scanFile(text)
  if ((frontMatter?.close ?? null) !== null) throw new Error('addFrontMatter: the text already starts with a front matter block')
  const newline = eolText(eol)
  const block = renderFrontMatter([
    `id: ${formatYamlString(fields.id)}`,
    `title: ${formatYamlString(fields.title)}`,
    ...(fields.tags === undefined ? [] : [renderTags(fields.tags, newline)]),
    `created: ${formatTimestamp(fields.created)}`,
    `updated: ${formatTimestamp(fields.updated)}`,
  ], newline)
  return (bom ? '\ufeff' : '') + block + text.slice(contentStart)
}

/** 新建 Prompt 文件的全文：LF 换行、不加 BOM，空标签写 `tags: []`（D11），正文原样接在后面。 */
export function renderNewPromptFile(fields: NewFrontMatterFields, bodyLF: string): string {
  return renderFrontMatter([
    `id: ${formatYamlString(fields.id)}`,
    `title: ${formatYamlString(fields.title)}`,
    renderTags(fields.tags ?? [], '\n'),
    'favorite: false',
    `created: ${formatTimestamp(fields.created)}`,
    `updated: ${formatTimestamp(fields.updated)}`,
  ], '\n') + bodyLF
}
