// 编辑区的文本变换：列表续行（E-05）、缩进与反缩进（E-06）、插入库条目（L-06）。
// 规则写成不依赖 CodeMirror 的纯函数，CodeMirror 命令只负责读出文档和主选区、把结果放进一个事务派发，
// 所以每个操作都是一步撤销。
//
// 约定：位置是 UTF-16 偏移（和 CodeMirror 一致），文档只含 LF 换行。返回的 changes 按原文档的位置写，
// 从前往后排、互不重叠，可以直接作为一个事务的 changes；selection 是修改之后的文档里的位置。

import { isBlank } from '../../../shared/text-metrics.ts'
import type { TextSelection } from '../../../shared/types.ts'

export interface TextChange {
  from: number
  to: number
  insert: string
}

export interface EditResult {
  changes: TextChange[]
  selection: TextSelection
}

/** 主选区。from 可以大于 to，按两端处理。 */
export interface SelectionRange {
  from: number
  to: number
}

/** 一级缩进固定是 4 个空格（E-06），不跟随制表符宽度，也不做制表符和空格的互转。 */
export const INDENT = '    '

/**
 * 列表行：缩进、列表符号（`-` `*` `+`，或 `1.` `1)`），然后是空白和内容；只有符号（后面可以有空白）的是空项。
 * 编号最多 9 位，和 CommonMark 一致，更长的数字后面跟点不算列表。
 */
const LIST_LINE = /^([ \t]*)([-*+]|(\d{1,9})([.)]))(?:([ \t]+)(.*))?$/

interface ListItem {
  indent: string
  /** 原样的列表符号，例如 `-`、`3.`、`10)`。 */
  marker: string
  /** 有序列表的编号和分隔符；无序列表时为 undefined。 */
  ordered: { number: string; delimiter: string } | undefined
  /** 符号后面的空白，续行时原样带上；空项可能没有。 */
  spacing: string
  content: string
}

function parseListLine(line: string): ListItem | null {
  const match = LIST_LINE.exec(line)
  if (match === null) return null
  const [, leading = '', marker = '', number, delimiter, spacing = '', content = ''] = match
  return {
    indent: leading,
    marker,
    ordered: number !== undefined && delimiter !== undefined ? { number, delimiter } : undefined,
    spacing,
    content,
  }
}

function nextMarker(item: ListItem): string {
  if (item.ordered === undefined) return item.marker
  const { number, delimiter } = item.ordered
  const next = String(Number(number) + 1)
  // `01.` 这样带前导零的编号保持原来的位数。
  return (number.startsWith('0') ? next.padStart(number.length, '0') : next) + delimiter
}

function lineStartAt(doc: string, pos: number): number {
  // pos 为 0 时 lastIndexOf 的起点会被当成 0，文档以换行开头时会找错行，单独处理。
  return pos === 0 ? 0 : doc.lastIndexOf('\n', pos - 1) + 1
}

function lineEndAt(doc: string, pos: number): number {
  const end = doc.indexOf('\n', pos)
  return end === -1 ? doc.length : end
}

function normalize(doc: string, sel: SelectionRange): { from: number; to: number } {
  const a = Math.min(Math.max(sel.from, 0), doc.length)
  const b = Math.min(Math.max(sel.to, 0), doc.length)
  return { from: Math.min(a, b), to: Math.max(a, b) }
}

function cursor(pos: number): TextSelection {
  return { anchor: pos, head: pos }
}

/**
 * 选区涉及的各行的行首位置。选区非空且结束点正好在某一行行首时，那一行不算（E-06）。
 * 空选区就是光标所在的那一行。
 */
function touchedLineStarts(doc: string, from: number, to: number): number[] {
  const last = to > from && doc[to - 1] === '\n' ? to - 1 : to
  const starts = [lineStartAt(doc, from)]
  for (let newline = doc.indexOf('\n', from); newline !== -1 && newline < last; newline = doc.indexOf('\n', newline + 1)) {
    starts.push(newline + 1)
  }
  return starts
}

/**
 * Enter 的列表续行（E-05）。只在空选区、光标在列表行的行尾时生效：
 * - 有内容的项：换行，新行带上同样的缩进和列表符号（有序列表编号加 1，分隔符不变）。
 * - 空项（只有列表符号）：去掉这一行的缩进和符号，结束列表，不换行。
 * 光标在列表项中间、有选区或不是列表行时返回 null，由调用方做普通换行。
 */
export function continueList(doc: string, sel: SelectionRange): EditResult | null {
  const { from, to } = normalize(doc, sel)
  if (from !== to) return null
  const lineEnd = lineEndAt(doc, from)
  if (from !== lineEnd) return null
  const lineStart = lineStartAt(doc, from)
  const item = parseListLine(doc.slice(lineStart, lineEnd))
  if (item === null) return null
  if (isBlank(item.content)) {
    return { changes: [{ from: lineStart, to: lineEnd, insert: '' }], selection: cursor(lineStart) }
  }
  const insert = `\n${item.indent}${nextMarker(item)}${item.spacing}`
  return { changes: [{ from, to: from, insert }], selection: cursor(from + insert.length) }
}

/**
 * Tab 缩进（E-06）：
 * - 空选区、光标所在行是列表项：整行行首加 4 个空格，光标随之后移。
 * - 空选区、其他行：在光标处插入 4 个空格。
 * - 单行内的非空选区：用 4 个空格替换选区。
 * - 跨行的选区：涉及的每一行行首加 4 个空格，选区跟着扩展，仍然选中原来的内容。
 */
export function indent(doc: string, sel: SelectionRange): EditResult {
  const { from, to } = normalize(doc, sel)
  const newline = doc.indexOf('\n', from)
  if (newline === -1 || newline >= to) {
    if (from === to) {
      const lineStart = lineStartAt(doc, from)
      if (parseListLine(doc.slice(lineStart, lineEndAt(doc, from))) !== null) {
        return { changes: [{ from: lineStart, to: lineStart, insert: INDENT }], selection: cursor(from + INDENT.length) }
      }
    }
    return { changes: [{ from, to, insert: INDENT }], selection: cursor(from + INDENT.length) }
  }

  const starts = touchedLineStarts(doc, from, to)
  return {
    changes: starts.map(start => ({ from: start, to: start, insert: INDENT })),
    // 第一行的行首在选区起点之前（或正好在起点），起点跟着后移；其余各行的行首都在选区里面。
    selection: { anchor: from + INDENT.length, head: to + INDENT.length * starts.length },
  }
}

/**
 * Shift+Tab 反缩进（E-06）：涉及的每一行（空选区时是光标所在行）去掉行首最多 4 个空格或 1 个制表符。
 * 没有可去的缩进时返回 null；调用方这时仍要吞掉按键，否则浏览器会把焦点移出编辑区。
 * 选区端点落在被删掉的缩进里时移到行首。
 */
export function outdent(doc: string, sel: SelectionRange): EditResult | null {
  const { from, to } = normalize(doc, sel)
  const changes: TextChange[] = []
  for (const start of touchedLineStarts(doc, from, to)) {
    let width = 0
    if (doc[start] === '\t') {
      width = 1
    } else {
      while (width < INDENT.length && doc[start + width] === ' ') width++
    }
    if (width > 0) changes.push({ from: start, to: start + width, insert: '' })
  }
  if (changes.length === 0) return null

  const map = (pos: number): number => {
    let removed = 0
    for (const change of changes) {
      if (pos <= change.from) break
      if (pos < change.to) return change.from - removed
      removed += change.to - change.from
    }
    return pos - removed
  }
  return { changes, selection: { anchor: map(from), head: map(to) } }
}

/** 插入点前面要补的换行：文档开头不补；在行中间补两个；在行首时，上一行不是空行就补一个。 */
function leadingSeparator(doc: string, from: number): string {
  if (from === 0) return ''
  if (doc[from - 1] !== '\n') return '\n\n'
  const previousLine = doc.slice(lineStartAt(doc, from - 1), from - 1)
  return isBlank(previousLine) ? '' : '\n'
}

/** 插入点后面要补的换行：文档结尾不补；后面同一行还有字符就补两个；在行尾时，下一行不是空行就补一个。 */
function trailingSeparator(doc: string, to: number): string {
  if (to === doc.length) return ''
  if (doc[to] !== '\n') return '\n\n'
  const nextLine = doc.slice(to + 1, lineEndAt(doc, to + 1))
  return isBlank(nextLine) ? '' : '\n'
}

/**
 * 把库条目的正文插到光标处，有选区时替换选区（L-06）。正文去掉首尾空白后插入，
 * 和前后文各隔开一个空行；那一侧已经有空行（只含空白的行也算）或者是文档开头、结尾时不再补换行。
 * 插入后光标在插入内容的末尾。正文去掉空白后为空时返回 null。
 */
export function insertSnippet(doc: string, sel: SelectionRange, snippet: string): EditResult | null {
  // 编辑区只用 LF；正文里混进 CRLF 时，CodeMirror 会把它规范成一个换行，这里算出的光标位置就对不上了。
  const body = snippet.replace(/\r\n?/g, '\n').trim()
  if (body === '') return null
  const { from, to } = normalize(doc, sel)
  const prefix = leadingSeparator(doc, from)
  const insert = prefix + body + trailingSeparator(doc, to)
  return { changes: [{ from, to, insert }], selection: cursor(from + prefix.length + body.length) }
}
