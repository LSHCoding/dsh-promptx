import { describe, it, expect } from 'vitest'
import { EditorSelection, EditorState, type Transaction } from '@codemirror/state'
import { history, undo } from '@codemirror/commands'
import {
  continueList,
  indent,
  insertSnippet,
  outdent,
  type EditResult,
  type SelectionRange,
  type TextChange,
} from '../../src/app/renderer/editor/commands.ts'
import type { TextSelection } from '../../src/shared/types.ts'

// 测试里的文档写法：`|` 是光标，`«` `»` 是选区的两端（« 在前）。

function parse(marked: string): { doc: string; sel: SelectionRange } {
  const caret = marked.indexOf('|')
  if (caret !== -1) return { doc: marked.slice(0, caret) + marked.slice(caret + 1), sel: { from: caret, to: caret } }
  const start = marked.indexOf('«')
  const end = marked.indexOf('»')
  if (start === -1 || end < start) throw new Error(`bad test document: ${marked}`)
  return { doc: marked.replace('«', '').replace('»', ''), sel: { from: start, to: end - 1 } }
}

function render(doc: string, { anchor, head }: TextSelection): string {
  if (anchor === head) return `${doc.slice(0, anchor)}|${doc.slice(anchor)}`
  const from = Math.min(anchor, head)
  const to = Math.max(anchor, head)
  return `${doc.slice(0, from)}«${doc.slice(from, to)}»${doc.slice(to)}`
}

/** 按原文档的位置应用 changes，同时检查它们从前往后排、互不重叠、都在文档范围内。 */
function applyChanges(doc: string, changes: readonly TextChange[]): string {
  let previousEnd = 0
  for (const change of changes) {
    expect(change.from).toBeGreaterThanOrEqual(previousEnd)
    expect(change.to).toBeGreaterThanOrEqual(change.from)
    expect(change.to).toBeLessThanOrEqual(doc.length)
    previousEnd = change.to
  }
  let out = doc
  for (const change of [...changes].reverse()) out = out.slice(0, change.from) + change.insert + out.slice(change.to)
  return out
}

function show(doc: string, result: EditResult | null): string | null {
  if (result === null) return null
  const next = applyChanges(doc, result.changes)
  expect(result.selection.anchor).toBeGreaterThanOrEqual(0)
  expect(result.selection.head).toBeLessThanOrEqual(next.length)
  return render(next, result.selection)
}

type Command = (doc: string, sel: SelectionRange) => EditResult | null

function run(command: Command, marked: string): string | null {
  const { doc, sel } = parse(marked)
  return show(doc, command(doc, sel))
}

const insert = (snippet: string): Command => (doc, sel) => insertSnippet(doc, sel, snippet)

describe('continueList（E-05）', () => {
  it('无序列表项行尾按 Enter，新行带上同样的符号', () => {
    expect(run(continueList, '- 第一项|')).toBe('- 第一项\n- |')
    expect(run(continueList, '* item|')).toBe('* item\n* |')
    expect(run(continueList, '+ item|')).toBe('+ item\n+ |')
  })

  it('有序列表编号加 1，保持缩进和分隔符', () => {
    expect(run(continueList, '  3. 第三项|')).toBe('  3. 第三项\n  4. |')
    expect(run(continueList, '1) 第一|')).toBe('1) 第一\n2) |')
    expect(run(continueList, '9. 九|')).toBe('9. 九\n10. |')
    expect(run(continueList, '999999999. x|')).toBe('999999999. x\n1000000000. |')
  })

  it('带前导零的编号保持位数', () => {
    expect(run(continueList, '01. 一|')).toBe('01. 一\n02. |')
    expect(run(continueList, '09) 九|')).toBe('09) 九\n10) |')
  })

  it('保持制表符缩进和符号后面的空白', () => {
    expect(run(continueList, '\t- 项|')).toBe('\t- 项\n\t- |')
    expect(run(continueList, '-   对齐|')).toBe('-   对齐\n-   |')
    expect(run(continueList, '1.\t项|')).toBe('1.\t项\n2.\t|')
  })

  it('内容后面有空白、光标在行尾时照常续行', () => {
    expect(run(continueList, '- 项  |')).toBe('- 项  \n- |')
  })

  it('在文档中间的列表项续行', () => {
    expect(run(continueList, '前言\n- a|\n- b')).toBe('前言\n- a\n- |\n- b')
  })

  it('空项按 Enter 去掉符号，这一行变成空行', () => {
    expect(run(continueList, '- |')).toBe('|')
    expect(run(continueList, '- 第一项\n- |')).toBe('- 第一项\n|')
    expect(run(continueList, '  3. |')).toBe('|')
    expect(run(continueList, '1) |')).toBe('|')
    expect(run(continueList, '-   |')).toBe('|')
  })

  it('只有符号、后面没有空格的也是空项', () => {
    expect(run(continueList, '-|')).toBe('|')
    expect(run(continueList, '  *|')).toBe('|')
    expect(run(continueList, '2.|')).toBe('|')
  })

  it('空项在文档中间时只清空那一行', () => {
    expect(run(continueList, 'a\n- |\nb')).toBe('a\n|\nb')
  })

  it('光标在列表项中间时返回 null（普通换行）', () => {
    expect(run(continueList, '- 第|一项')).toBeNull()
    expect(run(continueList, '|- 项')).toBeNull()
    expect(run(continueList, '-| 项')).toBeNull()
    expect(run(continueList, '- a\n|- b')).toBeNull()
  })

  it('有选区时返回 null', () => {
    expect(run(continueList, '- «项»')).toBeNull()
  })

  it('不是列表行时返回 null', () => {
    expect(run(continueList, '普通文字|')).toBeNull()
    expect(run(continueList, '|')).toBeNull()
    expect(run(continueList, '-项|')).toBeNull()
    expect(run(continueList, '1.5 个|')).toBeNull()
    expect(run(continueList, '**粗体**|')).toBeNull()
    expect(run(continueList, '---|')).toBeNull()
    expect(run(continueList, '+1|')).toBeNull()
    expect(run(continueList, '> - 引用里的列表|')).toBeNull()
    expect(run(continueList, '1234567890. 太长的编号|')).toBeNull()
  })
})

describe('indent（E-06）', () => {
  it('光标在列表项中间，整行右移 4 格，光标跟着移动', () => {
    expect(run(indent, '- 子|项')).toBe('    - 子|项')
    expect(run(indent, '  - 子项|')).toBe('      - 子项|')
    expect(run(indent, '|- 项')).toBe('    |- 项')
    expect(run(indent, '1. a|')).toBe('    1. a|')
    expect(run(indent, '- |')).toBe('    - |')
  })

  it('列表项在文档中间时只缩进那一行', () => {
    expect(run(indent, '- a\n- b|\n- c')).toBe('- a\n    - b|\n- c')
  })

  it('其他行在光标处插入 4 个空格', () => {
    expect(run(indent, 'ab|cd')).toBe('ab    |cd')
    expect(run(indent, '|')).toBe('    |')
    expect(run(indent, '普通|')).toBe('普通    |')
    expect(run(indent, '-项|')).toBe('-项    |')
  })

  it('单行内的非空选区用 4 个空格替换', () => {
    expect(run(indent, 'a«bc»d')).toBe('a    |d')
    expect(run(indent, '«整行»')).toBe('    |')
    expect(run(indent, '- «项»')).toBe('-     |')
  })

  it('选中三行，每行行首加 4 个空格，仍然选中原来的内容', () => {
    expect(run(indent, '«a\nb\nc»')).toBe('    «a\n    b\n    c»')
  })

  it('选区从行中间开始、在行中间结束', () => {
    expect(run(indent, 'x«yz\nab\nc»d')).toBe('    x«yz\n    ab\n    c»d')
  })

  it('选区结束点恰好在下一行行首时，那一行不算', () => {
    expect(run(indent, '«a\nb\n»c')).toBe('    «a\n    b\n»c')
    expect(run(indent, '«ab\n»cd')).toBe('    «ab\n»cd')
  })

  it('选区从行尾开始时，那一行也算', () => {
    expect(run(indent, 'ab«\nc»d')).toBe('    ab«\n    c»d')
  })

  it('选区里的空行也加缩进，制表符不转换', () => {
    expect(run(indent, '«a\n\nb»')).toBe('    «a\n    \n    b»')
    expect(run(indent, '«\ta\n\tb»')).toBe('    «\ta\n    \tb»')
  })

  it('反向选区按两端处理', () => {
    const { doc } = parse('«a\nb»')
    expect(show(doc, indent(doc, { from: doc.length, to: 0 }))).toBe('    «a\n    b»')
  })

  it('超出文档范围的位置收紧到文档里', () => {
    expect(show('ab', indent('ab', { from: 5, to: 5 }))).toBe('ab    |')
  })
})

describe('outdent（E-06）', () => {
  it('光标所在行去掉最多 4 个空格', () => {
    expect(run(outdent, '    - 子|项')).toBe('- 子|项')
    expect(run(outdent, '  a|')).toBe('a|')
    expect(run(outdent, '      a|')).toBe('  a|')
  })

  it('去掉 1 个制表符', () => {
    expect(run(outdent, '\ta|')).toBe('a|')
    expect(run(outdent, '\t\ta|')).toBe('\ta|')
    expect(run(outdent, '\t  a|')).toBe('  a|')
  })

  it('行首是空格再制表符时只去掉空格', () => {
    expect(run(outdent, '  \ta|')).toBe('\ta|')
  })

  it('光标落在被删掉的缩进里时移到行首', () => {
    expect(run(outdent, '  |  a')).toBe('|a')
    expect(run(outdent, 'x\n    |y')).toBe('x\n|y')
  })

  it('没有可去的缩进时返回 null', () => {
    expect(run(outdent, 'a|')).toBeNull()
    expect(run(outdent, '|')).toBeNull()
    expect(run(outdent, '«a\nb»')).toBeNull()
    expect(run(outdent, 'a «b» c')).toBeNull()
  })

  it('多行选区每行各自去掉缩进，没有缩进的行不变', () => {
    expect(run(outdent, '    «a\n\tb\nc\n  d»')).toBe('«a\nb\nc\nd»')
  })

  it('选区端点在行中间时跟着内容移动', () => {
    expect(run(outdent, '    a«b\n    c»d')).toBe('a«b\nc»d')
  })

  it('选区结束点恰好在下一行行首时，那一行不动', () => {
    expect(run(outdent, '    «a\n»    b')).toBe('«a\n»    b')
  })

  it('单行内的非空选区去掉那一行的缩进', () => {
    expect(run(outdent, '    «ab»')).toBe('«ab»')
  })

  it('Tab 后 Shift+Tab 还原内容和选区', () => {
    const original = '«第一行\n- 第二行\n  第三行»'
    const indented = run(indent, original)
    expect(indented).toBe('    «第一行\n    - 第二行\n      第三行»')
    expect(run(outdent, indented ?? '')).toBe(original)
  })
})

describe('insertSnippet（L-06）', () => {
  it('在一段文字中间插入，前后各隔一个空行，光标在插入内容末尾', () => {
    expect(run(insert('库条目'), '前文|后文')).toBe('前文\n\n库条目|\n\n后文')
  })

  it('正文首尾的空白去掉', () => {
    expect(run(insert('\n\n  库条目\n第二行  \n\n'), '|')).toBe('库条目\n第二行|')
  })

  it('空文档里直接插入', () => {
    expect(run(insert('S'), '|')).toBe('S|')
  })

  it('文档开头、结尾不补换行', () => {
    expect(run(insert('S'), '|abc')).toBe('S|\n\nabc')
    expect(run(insert('S'), 'abc|')).toBe('abc\n\nS|')
  })

  it('在行首插入时，上一行有内容只补一个换行', () => {
    expect(run(insert('S'), 'a\n|b')).toBe('a\n\nS|\n\nb')
    expect(run(insert('S'), 'a\n|')).toBe('a\n\nS|')
  })

  it('在行尾插入时，下一行有内容只补一个换行', () => {
    expect(run(insert('S'), 'a|\nb')).toBe('a\n\nS|\n\nb')
  })

  it('两段之间的空行上插入', () => {
    expect(run(insert('S'), 'a\n|\nb')).toBe('a\n\nS|\n\nb')
  })

  it('前后已经有空行时不再加', () => {
    expect(run(insert('S'), 'a\n\n|')).toBe('a\n\nS|')
    expect(run(insert('S'), '|\n\nb')).toBe('S|\n\nb')
    expect(run(insert('S'), 'a\n\n|\n\nb')).toBe('a\n\nS|\n\nb')
    expect(run(insert('S'), '\n|')).toBe('\nS|')
  })

  it('只含空白的相邻行也算空行', () => {
    expect(run(insert('S'), 'a\n   \n|b')).toBe('a\n   \nS|\n\nb')
    expect(run(insert('S'), 'a|\n\t\nb')).toBe('a\n\nS|\n\t\nb')
  })

  it('有选区时替换选区', () => {
    expect(run(insert('新'), 'a «旧» b')).toBe('a \n\n新|\n\n b')
    expect(run(insert('新'), '«x\ny»')).toBe('新|')
    expect(run(insert('新'), 'a\n\n«旧»\n\nb')).toBe('a\n\n新|\n\nb')
  })

  it('多行正文原样插入，内部的空行保留', () => {
    expect(run(insert('# 标题\n\n- 一\n- 二'), '前文|')).toBe('前文\n\n# 标题\n\n- 一\n- 二|')
  })

  it('正文里的 CRLF 和 CR 换成 LF', () => {
    expect(run(insert('x\r\ny\rz'), '|')).toBe('x\ny\nz|')
  })

  it('正文去掉空白后为空时返回 null', () => {
    expect(run(insert(''), 'a|')).toBeNull()
    expect(run(insert('  \n\t '), 'a|')).toBeNull()
    expect(run(insert('　'), 'a|')).toBeNull()
  })
})

describe('在 CodeMirror 里作为一个事务应用：一次撤销回到操作前', () => {
  function roundTrip(marked: string, command: Command): void {
    const { doc, sel } = parse(marked)
    const result = command(doc, sel)
    expect(result).not.toBeNull()
    if (result === null) return
    const start = EditorState.create({ doc, selection: EditorSelection.single(sel.from, sel.to), extensions: [history()] })
    const applied = start.update({
      changes: result.changes,
      selection: EditorSelection.single(result.selection.anchor, result.selection.head),
      userEvent: 'input',
    }).state
    expect(applied.doc.toString()).toBe(applyChanges(doc, result.changes))
    expect(applied.selection.main.anchor).toBe(result.selection.anchor)
    expect(applied.selection.main.head).toBe(result.selection.head)

    const dispatched: EditorState[] = []
    const handled = undo({ state: applied, dispatch: (tr: Transaction) => { dispatched.push(tr.state) } })
    expect(handled).toBe(true)
    expect(dispatched).toHaveLength(1)
    const restored = dispatched[0]!
    expect(restored.doc.toString()).toBe(doc)
    expect(restored.selection.main.from).toBe(sel.from)
    expect(restored.selection.main.to).toBe(sel.to)
  }

  it('列表续行', () => {
    roundTrip('- 第一项|', continueList)
    roundTrip('- 第一项\n- |', continueList)
  })

  it('多行缩进与反缩进', () => {
    roundTrip('«a\nb\nc»', indent)
    roundTrip('    «a\n\tb\nc\n  d»', outdent)
    roundTrip('- 子|项', indent)
  })

  it('插入库条目', () => {
    roundTrip('前文|后文', insert('库条目'))
    roundTrip('a «旧» b', insert('新'))
  })
})
