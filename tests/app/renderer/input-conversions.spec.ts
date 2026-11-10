// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { redo, undo } from '@codemirror/commands'
import { EditorSelection, type Transaction } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { createEditorController, type EditorController } from '../../../src/app/renderer/editor/controller.ts'
import { installLayoutStubs } from './helpers.ts'

const editors: EditorController[] = []

beforeAll(installLayoutStubs)

afterEach(() => {
  for (const editor of editors.splice(0)) editor.unmount()
  document.body.innerHTML = ''
})

function mount(marked = '|'): { editor: EditorController; view: EditorView } {
  const caret = marked.indexOf('|')
  const text = marked.replace('|', '')
  const editor = createEditorController({ platform: 'darwin', placeholder: '', ariaLabel: 'editor' })
  editor.load(text, { anchor: caret, head: caret })
  editor.setEditable(true)
  const parent = document.createElement('div')
  document.body.appendChild(parent)
  editor.mount(parent)
  editors.push(editor)
  if (editor.view === null) throw new Error('editor not mounted')
  return { editor, view: editor.view }
}

/** 走 CodeMirror 的公开 inputHandler，再应用它为 DOM 输入准备的默认事务。jsdom 没有原生输入法。 */
function input(view: EditorView, text: string): void {
  const selection = view.state.selection.main
  let transaction: Transaction | undefined
  const insert = (): Transaction => {
    transaction ??= view.state.update({
      changes: { from: selection.from, to: selection.to, insert: text },
      selection: EditorSelection.single(selection.from + text.length),
      userEvent: view.compositionStarted ? 'input.type.compose' : 'input.type',
    })
    return transaction
  }
  if (!view.state.facet(EditorView.inputHandler).some(handler => handler(view, selection.from, selection.to, text, insert))) {
    view.dispatch(insert())
  }
}

function marked(editor: EditorController): string {
  const text = editor.getText()
  const { head } = editor.getSelection()
  return text.slice(0, head) + '|' + text.slice(head)
}

function compose(view: EditorView, type: 'compositionstart' | 'compositionend', data: string): void {
  view.contentDOM.dispatchEvent(new CompositionEvent(type, { bubbles: true, data }))
}

async function ended(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 5))
}

describe('中文输入转换（E-12）', () => {
  it('两个间隔号转反引号，第三个补成代码块，第四个在块内保留字面', () => {
    const { editor, view } = mount()
    input(view, '·')
    expect(marked(editor)).toBe('·|')
    input(view, '·')
    expect(marked(editor)).toBe('``|')
    input(view, '·')
    expect(marked(editor)).toBe('```\n|\n\n```')
    input(view, '·')
    expect(marked(editor)).toBe('```\n·|\n\n```')
  })

  it.each(['¥', '￥'])('连续三个 %s 转成行间公式，光标在空行', (symbol) => {
    const { editor, view } = mount()
    input(view, symbol)
    expect(marked(editor)).toBe(`${symbol}|`)
    input(view, symbol)
    expect(marked(editor)).toBe('$$|')
    input(view, symbol)
    expect(marked(editor)).toBe('$$\n|\n$$')
  })

  it('半全角币符允许混合，行中 emoji 后的光标按 UTF-16 偏移', () => {
    const { editor, view } = mount('🙂前|后')
    input(view, '¥')
    input(view, '￥')
    expect(marked(editor)).toBe('🙂前$$|后')
    input(view, '¥')
    expect(marked(editor)).toBe('🙂前$$\n|\n$$后')
  })

  it.each([['```|', '·'], ['$$$$|', '¥'], ['$$$|', '￥']])('已有较长标记 %s 后不续接', (before, symbol) => {
    const { editor, view } = mount(before)
    input(view, symbol)
    expect(marked(editor)).toBe(before.replace('|', symbol + '|'))
  })

  it('每次转换单独撤销到字面输入，重做不会再触发转换', () => {
    const { editor, view } = mount()
    input(view, '·')
    input(view, '·')
    expect(editor.runCommand(undo)).toBe(true)
    expect(marked(editor)).toBe('··|')
    expect(editor.runCommand(redo)).toBe(true)
    expect(marked(editor)).toBe('``|')
    input(view, '·')
    expect(editor.runCommand(undo)).toBe(true)
    expect(marked(editor)).toBe('``·|')
    expect(editor.runCommand(redo)).toBe(true)
    expect(marked(editor)).toBe('```\n|\n\n```')
  })

  it('开关独立，load 之后仍保留，并能即时重新开启', () => {
    const { editor, view } = mount()
    editor.setInputConversions({ middleDot: false, yen: true })
    input(view, '·')
    input(view, '·')
    expect(editor.getText()).toBe('··')
    editor.load('', null)
    input(view, '·')
    input(view, '·')
    expect(editor.getText()).toBe('··')
    input(view, '¥')
    input(view, '￥')
    expect(editor.getText()).toBe('··$$')
    editor.setInputConversions({ middleDot: true, yen: false })
    editor.load('', null)
    input(view, '¥')
    input(view, '￥')
    expect(editor.getText()).toBe('¥￥')
    input(view, '·')
    input(view, '·')
    expect(editor.getText()).toBe('¥￥``')
  })

  it('粘贴、程序替换、程序插入和多字符落字都保持原样', () => {
    const { editor, view } = mount()
    editor.load('··¥￥', null)
    expect(editor.getText()).toBe('··¥￥')
    editor.replaceAll('··')
    expect(editor.getText()).toBe('··')
    editor.apply({ changes: [{ from: 2, to: 2, insert: '¥¥' }], selection: { anchor: 4, head: 4 } })
    expect(editor.getText()).toBe('··¥¥')
    editor.load('', null)
    input(view, '··')
    expect(editor.getText()).toBe('··')
    editor.load('', null)
    const paste = new Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(paste, 'clipboardData', { value: { getData: () => '··¥￥' } })
    view.contentDOM.dispatchEvent(paste)
    expect(editor.getText()).toBe('··¥￥')
  })

  it('只读时输入处理器不接管转换', () => {
    const { editor, view } = mount('·|')
    editor.setEditable(false)
    const handled = view.state.facet(EditorView.inputHandler).some(handler => handler(view, 1, 1, '·', () => {
      throw new Error('must not create a transaction while read-only')
    }))
    expect(handled).toBe(false)
    expect(editor.getText()).toBe('·')
  })

  it('输入替换选区，转换只替换触发片段', () => {
    const { editor, view } = mount('前·选中文本后|')
    editor.dispatch({ selection: { anchor: 2, head: 6 } })
    input(view, '·')
    expect(marked(editor)).toBe('前``|后')
  })
})

describe('组字提交顺序', () => {
  it('组字期间保持字面，文档先提交再 compositionend 时结束后转换', async () => {
    const { editor, view } = mount('·|')
    compose(view, 'compositionstart', '')
    input(view, '·')
    expect(editor.getText()).toBe('··')
    compose(view, 'compositionend', '·')
    expect(editor.getText()).toBe('··')
    await ended()
    expect(marked(editor)).toBe('``|')
    editor.runCommand(undo)
    expect(marked(editor)).toBe('··|')
  })

  it('compositionend 先到，随后单字符落字也转换一次', async () => {
    const { editor, view } = mount('¥|')
    compose(view, 'compositionstart', '')
    compose(view, 'compositionend', '￥')
    input(view, '￥')
    expect(marked(editor)).toBe('$$|')
    await ended()
    expect(marked(editor)).toBe('$$|')
    editor.runCommand(undo)
    expect(marked(editor)).toBe('¥￥|')
  })

  it('组字中间字符、取消、多字提交都不误转换', async () => {
    const { editor, view } = mount('·|')
    compose(view, 'compositionstart', '')
    input(view, '·')
    editor.dispatch({ selection: { anchor: 1, head: 2 } })
    input(view, '词语')
    compose(view, 'compositionend', '词语')
    await ended()
    expect(editor.getText()).toBe('·词语')
    editor.load('·', null)
    compose(view, 'compositionstart', '')
    input(view, '·')
    compose(view, 'compositionend', '')
    await ended()
    expect(editor.getText()).toBe('··')
  })

  it('等待提交处理时换草稿、改光标、关闭开关都不改新状态', async () => {
    for (const action of ['load', 'selection', 'disable'] as const) {
      const { editor, view } = mount('·|')
      compose(view, 'compositionstart', '')
      input(view, '·')
      compose(view, 'compositionend', '·')
      if (action === 'load') editor.load('新草稿', null)
      if (action === 'selection') editor.dispatch({ selection: { anchor: 0 } })
      if (action === 'disable') editor.setInputConversions({ middleDot: false, yen: true })
      await ended()
      expect(editor.getText()).toBe(action === 'load' ? '新草稿' : '··')
    }
  })

  it('卸载编辑器会取消等待中的转换', async () => {
    const { editor, view } = mount('·|')
    compose(view, 'compositionstart', '')
    input(view, '·')
    compose(view, 'compositionend', '·')
    editor.unmount()
    await ended()
    expect(editor.getText()).toBe('··')
  })
})
