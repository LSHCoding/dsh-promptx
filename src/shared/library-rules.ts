// Prompt 库的命名与整理规则：标题提取、文件名、id、标签、相对路径、时间格式
// （需求 L-08、L-09、6.2、6.3，技术方案 6.1、7.1）。Host 和小窗共用，纯逻辑。

/** 新建 Prompt 时自动提取的标题最多多少个字符（L-08）。 */
export const TITLE_MAX_CHARS = 40

/**
 * 列表里从正文提取的标题最多多少个字符。正常的标题行远到不了这个长度；不设上限时，一个第一行就有 2 MiB 的文件
 * 会变成 2 MiB 的列表标题，每次列表、搜索、排序都要带着它（审查 SEC-01）。front matter 里写的标题不受限制。
 */
export const DISPLAY_TITLE_MAX_CHARS = 200

/** 由标题生成的文件名最多多少个字符（6.2）。 */
export const FILE_STEM_MAX_CHARS = 60

// 文件系统对单个文件名的限制按字节算（APFS、ext4 都是 255 字节）。60 个 emoji 组合字符可以远超这个长度，
// 再加上 `-<id 末 8 位>-<序号>.md` 的后缀，所以文件名主体另外限制在 200 字节以内。
const FILE_STEM_MAX_BYTES = 200

/** 每条 Prompt 最多几个标签（L-09）。 */
export const MAX_TAGS = 5

let graphemeSegmenter: Intl.Segmenter | undefined

/** 按用户看到的字符（字素簇）切分，emoji 和带附加符号的字母不会被截成两半。 */
function graphemes(text: string): Iterable<Intl.SegmentData> {
  graphemeSegmenter ??= new Intl.Segmenter(undefined, { granularity: 'grapheme' })
  return graphemeSegmenter.segment(text)
}

/** 截到 max 个字符；截断后去掉末尾空白。 */
function truncateGraphemes(text: string, max: number): string {
  // UTF-16 长度不超过上限时，字符数一定不超过上限，省掉切分
  if (text.length <= max) return text
  let count = 0
  for (const { index } of graphemes(text)) {
    if (count === max) return text.slice(0, index).trimEnd()
    count++
  }
  return text
}

// ───────────────────────────── 标题 ─────────────────────────────
//
// 标题和围栏的判断对库里每个文件的每一行都要跑一遍，而且在 Host 主线程上同步执行。这里的正则只匹配有界的行首，
// 其余部分用线性的循环处理：原来的 `(.*?)[ \t]*$`、`(?:^|[ \t]+)#+$`、`(.*)$` 遇到一长串空格（或反引号）后面跟
// 别的字符时是平方级回溯，一个第一行有几十万个空格的共享文件就能让整个 dsh 卡住几分钟（审查 SEC-01）。

const SPACE = 0x20
const TAB = 0x09
const HASH = 0x23

/** CommonMark 的 ATX 标题开头：最多 3 个空格缩进，1 到 6 个 `#`，后面是空白或行尾。 */
const ATX_OPENING = /^ {0,3}#{1,6}(?=[ \t]|$)/

/** 代码围栏开头：最多 3 个空格缩进，至少 3 个反引号或波浪号。后面的信息串另取，不放进正则。 */
const FENCE_OPENING = /^ {0,3}(`{3,}|~{3,})/

/**
 * 原来的正则用 `.` 匹配标题文字和信息串，`.` 不匹配这些行结束符：换行在切行时已经去掉，剩下 \u2028、\u2029。
 * 含这两个字符的行原来既不算标题也不算围栏，保持这个判定。
 */
const LINE_TERMINATOR = /[\n\r\u2028\u2029]/

function isBlankCode(code: number): boolean {
  return code === SPACE || code === TAB
}

/** 标题行的文字：去掉开头的 `#`、首尾空白和结尾的 `#` 序列（前面要有空白，`# C#` 的标题是 `C#`）。不是标题行时返回 null。 */
function atxHeadingText(line: string): string | null {
  const opening = ATX_OPENING.exec(line)
  if (opening === null || LINE_TERMINATOR.test(line)) return null
  let start = opening[0].length
  while (start < line.length && isBlankCode(line.charCodeAt(start))) start++
  let end = line.length
  while (end > start && isBlankCode(line.charCodeAt(end - 1))) end--
  // 从行尾往前找结尾的 `#` 序列：整段都是 `#` 时标题为空；前面是空白时连同这段空白一起去掉，否则是标题的一部分
  let closing = end
  while (closing > start && line.charCodeAt(closing - 1) === HASH) closing--
  if (closing === start) return ''
  if (closing < end && isBlankCode(line.charCodeAt(closing - 1))) {
    end = closing
    while (end > start && isBlankCode(line.charCodeAt(end - 1))) end--
  }
  return line.slice(start, end).trim()
}

interface Fence {
  marker: string
  length: number
}

/** 围栏行的标记、长度和信息串；不是围栏行时返回 null。 */
function fenceLine(line: string): (Fence & { info: string }) | null {
  const match = FENCE_OPENING.exec(line)
  const run = match?.[1]
  if (match === null || run === undefined || LINE_TERMINATOR.test(line)) return null
  return { marker: run.charAt(0), length: run.length, info: line.slice(match[0].length) }
}

/** 围栏的开始行；反引号围栏的信息串里不能再有反引号，否则这一行不是围栏。 */
function openingFence(line: string): Fence | null {
  const fence = fenceLine(line)
  if (fence === null || (fence.marker === '`' && fence.info.includes('`'))) return null
  return { marker: fence.marker, length: fence.length }
}

function closesFence(line: string, fence: Fence): boolean {
  const candidate = fenceLine(line)
  if (candidate === null) return false
  return candidate.marker === fence.marker && candidate.length >= fence.length && candidate.info.trim() === ''
}

/** 第一个有文字的 ATX 标题行。代码块里的 `# 注释` 不算标题。 */
function firstHeading(lines: readonly string[]): string | null {
  let fence: Fence | null = null
  for (const line of lines) {
    if (fence !== null) {
      if (closesFence(line, fence)) fence = null
      continue
    }
    fence = openingFence(line)
    if (fence !== null) continue
    const heading = atxHeadingText(line)
    if (heading !== null && heading !== '') return heading
  }
  return null
}

/**
 * 第一行非空文字（去掉首尾空白）。只有 `#` 的空标题行、只有 `---` 的分隔行跳过：front matter 写坏了时全文都是正文，
 * 第一行就是 `---`，分隔行不会是有用的标题（审查 F1）。
 */
function firstTextLine(lines: readonly string[]): string | null {
  for (const line of lines) {
    const text = line.trim()
    if (text !== '' && text !== '---' && atxHeadingText(line) !== '') return text
  }
  return null
}

/**
 * 从正文提取标题（L-01、L-08）：第一个 ATX 标题行去掉 `#`；没有标题行时取第一行非空文字。
 * 结果截到 maxChars 个用户看到的字符；正文里没有文字时返回 null。
 */
export function extractTitle(bodyLF: string, maxChars: number = TITLE_MAX_CHARS): string | null {
  const lines = bodyLF.split(/\r\n?|\n/)
  const title = firstHeading(lines) ?? firstTextLine(lines)
  if (title === null) return null
  const truncated = truncateGraphemes(title, maxChars)
  return truncated === '' ? null : truncated
}

/** 新建 Prompt 的标题（L-08）：从草稿提取，最多 40 个字符；提取不到时用 untitled（「未命名 Prompt」，按界面语言传入）。 */
export function newPromptTitle(bodyLF: string, untitled: string): string {
  return extractTitle(bodyLF) ?? untitled
}

function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

function stripMarkdownExtension(name: string): string {
  const stem = name.replace(/\.md$/i, '')
  return stem === '' ? name : stem
}

/**
 * 列表里显示的标题：front matter 的 title 不为空时用它；否则从正文提取（最多 200 个字符）；正文也没有文字时用不带 `.md` 的文件名。
 * fileName 可以带文件夹，只取最后一段。
 */
export function displayTitle(title: string | null | undefined, bodyLF: string, fileName: string): string {
  const own = title?.trim() ?? ''
  if (own !== '') return own
  return extractTitle(bodyLF, DISPLAY_TITLE_MAX_CHARS) ?? stripMarkdownExtension(baseName(fileName))
}

// ───────────────────────────── 文件名与 id ─────────────────────────────

function utf8Length(text: string): number {
  let bytes = 0
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4
  }
  return bytes
}

/**
 * 由标题生成文件名主体（不含 `.md`，6.2）：`/ \ : * ? " < > |`、换行、制表符等控制字符换成 `-`，
 * 去掉首尾空白和开头的 `.`（否则文件会被当成隐藏文件跳过），最长 60 个字符，结果为空时用 `prompt`。
 */
export function makeFileStem(title: string): string {
  const cleaned = title
    // 控制字符在 Windows 上不能出现在文件名里，NUL 在所有系统上都不行
    .replace(/[/\\:*?"<>|\x00-\x1f\x7f]/g, '-')
    // 去掉 `.` 之后可能又露出空白，空白之后可能又是 `.`，所以一起反复去掉
    .replace(/^[\s.]+/, '')
    .trimEnd()
  let stem = ''
  let count = 0
  let bytes = 0
  for (const { segment } of graphemes(cleaned)) {
    const size = utf8Length(segment)
    if (count === FILE_STEM_MAX_CHARS || bytes + size > FILE_STEM_MAX_BYTES) break
    stem += segment
    count++
    bytes += size
  }
  stem = stem.trimEnd()
  return stem === '' ? 'prompt' : stem
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, '0')
}

/** 新 Prompt 的 id（6.2）：`prompt_` + UTC `YYYYMMDD_HHMMSS` + `_` + 8 位小写十六进制。random 至少 4 个字节。 */
export function generatePromptId(now: Date, random: Uint8Array): string {
  if (random.length < 4) throw new RangeError('generatePromptId: random must have at least 4 bytes')
  const date = `${pad(now.getUTCFullYear(), 4)}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}`
  const time = `${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`
  const hex = Array.from(random.subarray(0, 4), byte => byte.toString(16).padStart(2, '0')).join('')
  return `prompt_${date}_${time}_${hex}`
}

/**
 * 新文件依次尝试的文件名（6.2）：`<名字>.md`、`<名字>-<id 末 8 位>.md`、`<名字>-<id 末 8 位>-2.md`、`-3`……
 * 惰性生成、没有上限，由调用方逐个尝试独占创建。
 */
export function* fileNameCandidates(stem: string, id: string): Generator<string, never, unknown> {
  yield `${stem}.md`
  const suffix = id.slice(-8)
  const base = suffix === '' ? stem : `${stem}-${suffix}`
  if (suffix !== '') yield `${base}.md`
  for (let n = 2; ; n++) yield `${base}-${n}.md`
}

// ───────────────────────────── 标签 ─────────────────────────────

/** 比较标签是否相同用的键：忽略大小写（L-09），统一 Unicode 组合形式。 */
export function tagKey(tag: string): string {
  return tag.normalize('NFC').toLowerCase()
}

const TAG_SEPARATORS = /[,，;；\s]+/

/** 标签两端要去掉的字符（都是单个 UTF-16 码元，逐个比较不会切开代理对）。 */
const TAG_EDGE_CHARS = new Set(['#', '＃', ',', '，', ';', '；'])

/**
 * 去掉两端的 TAG_EDGE_CHARS。用循环而不是 `/[#＃,，;；]+$/`：后者遇到一长串 `#` 后面跟别的字符时是平方级回溯，
 * 小窗传来的标签会在 Host 主线程上卡住（审查 SEC-02）。
 */
function trimTagEdges(tag: string): string {
  let start = 0
  let end = tag.length
  while (start < end && TAG_EDGE_CHARS.has(tag.charAt(start))) start++
  while (end > start && TAG_EDGE_CHARS.has(tag.charAt(end - 1))) end--
  return tag.slice(start, end)
}

/**
 * 整理标签（L-09）：按中英文逗号、分号、换行和空白切分，去掉每个标签首尾空白和两端的 `#`、`,`、`;`（含全角），
 * 丢掉空的，忽略大小写去重（保留第一次出现的写法），最多 5 个。传入数组时每一项也照样切分。
 */
export function normalizeTags(input: string | readonly string[]): string[] {
  const parts = typeof input === 'string' ? [input] : input
  const seen = new Set<string>()
  const tags: string[] = []
  for (const piece of parts.flatMap(part => part.split(TAG_SEPARATORS))) {
    const tag = trimTagEdges(piece.trim()).trim()
    if (tag === '') continue
    const key = tagKey(tag)
    if (seen.has(key)) continue
    seen.add(key)
    tags.push(tag)
    if (tags.length === MAX_TAGS) break
  }
  return tags
}

// ───────────────────────────── 相对路径 ─────────────────────────────

/**
 * 规范化来自小窗或 Agent 的库内相对路径（技术方案 6.1）：反斜杠换成正斜杠；
 * 拒绝绝对路径（`/` 开头、`C:` 这样的盘符）、空段、`.` 和 `..`、以 `.` 开头的段、含 NUL 的路径。
 * 合法时返回用 `/` 连接的路径，否则返回 null。
 * 反斜杠只在 Windows 上是分隔符；macOS、Linux 上它是文件名里的普通字符，Host 的校验（library/rel-path.ts）
 * 在调用这里之前就拒绝含反斜杠的路径（审查 H6）。
 */
export function normalizeRelPath(input: string): string | null {
  const path = input.replaceAll('\\', '/')
  if (path === '' || path.startsWith('/') || /^[A-Za-z]:/.test(path) || path.includes('\0')) return null
  const segments = path.split('/')
  // `.`、`..` 也以 `.` 开头，一并拒绝
  if (segments.some(segment => segment === '' || segment.startsWith('.'))) return null
  return segments.join('/')
}

/** 扩展名是不是 `.md`（不区分大小写），且 `.md` 前面还有名字。 */
export function isMarkdownFileName(name: string): boolean {
  return name.length > 3 && name.slice(-3).toLowerCase() === '.md'
}

/** 把相对路径拆成所在文件夹（库根目录是空串）和文件名。 */
export function splitRelPath(relPath: string): { folder: string; name: string } {
  const slash = relPath.lastIndexOf('/')
  return slash < 0 ? { folder: '', name: relPath } : { folder: relPath.slice(0, slash), name: relPath.slice(slash + 1) }
}

/** 相对路径所在的文件夹；库根目录是空串。 */
export function folderOf(relPath: string): string {
  return splitRelPath(relPath).folder
}

// ───────────────────────────── 时间 ─────────────────────────────

/** 写进 front matter 的时间：UTC 的 `YYYY-MM-DDTHH:MM:SSZ`，不带毫秒。 */
export function formatIsoUtc(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z')
}

// 日期，可选的时间（`T` 或空白分隔，秒和小数秒可省），时间后面可选的时区（`Z`、`+08:00`、`+0800`、`+08`）
const DATE_PART = /(\d{4})-(\d{1,2})-(\d{1,2})/.source
const TIME_PART = /(?:[Tt]|[ \t]+)(\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?/.source
const ZONE_PART = /(?:[ \t]*(Z|z|[+-]\d{1,2}(?::?\d{2})?))?/.source
const TIMESTAMP = new RegExp(`^${DATE_PART}(?:${TIME_PART}${ZONE_PART})?$`)

function daysInMonth(year: number, month: number): number {
  if (month === 2) return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31
}

/** 时区偏移（分钟），`Z` 为 0；没写时区时为 undefined；偏移不合理时为 null。 */
function offsetMinutes(zone: string | undefined): number | null | undefined {
  if (zone === undefined) return undefined
  if (zone === 'Z' || zone === 'z') return 0
  const sign = zone.startsWith('-') ? -1 : 1
  const digits = zone.slice(1).replace(':', '')
  const hours = Number(digits.length <= 2 ? digits : digits.slice(0, -2))
  const minutes = digits.length <= 2 ? 0 : Number(digits.slice(-2))
  if (hours > 23 || minutes > 59) return null
  return sign * (hours * 60 + minutes)
}

/**
 * 解析 front matter 里的时间（毫秒），认不出时返回 null。认：带时区或不带时区的 ISO 8601（`T` 或空格分隔，
 * 秒和小数秒可省）、只有日期的 `YYYY-MM-DD`、`YYYY-MM-DD HH:MM:SS`。
 * 不带时区的按本机时区理解：用户手写的时间通常是自己所在地的时间。
 */
export function parseTimestamp(value: string): number | null {
  const match = TIMESTAMP.exec(value.trim())
  if (match === null) return null
  const [, y = '', mo = '', d = '', h = '0', mi = '0', s = '0', fraction = '', zone] = match
  const year = Number(y)
  const month = Number(mo)
  const day = Number(d)
  const hour = Number(h)
  const minute = Number(mi)
  const second = Number(s)
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return null
  if (hour > 23 || minute > 59 || second > 59) return null
  const millisecond = Number(fraction.slice(0, 3).padEnd(3, '0'))
  const offset = offsetMinutes(zone)
  if (offset === null) return null
  // Date 的构造函数和 Date.UTC 会把 0 到 99 年当成 19xx 年，所以先建再用 setFullYear 设年份
  if (offset === undefined) {
    const local = new Date(2000, 0, 1, hour, minute, second, millisecond)
    local.setFullYear(year, month - 1, day)
    return local.getTime()
  }
  const utc = new Date(Date.UTC(2000, 0, 1, hour, minute, second, millisecond))
  utc.setUTCFullYear(year, month - 1, day)
  return utc.getTime() - offset * 60_000
}
