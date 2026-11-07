// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, it, expect } from 'vitest'
import { redo, undo } from '@codemirror/commands'
import { runScopeHandlers, type EditorView } from '@codemirror/view'
import { createEditorController, type EditorController } from '../../../src/app/renderer/editor/controller.ts'
import { insertSnippet } from '../../../src/app/renderer/editor/commands.ts'
import { installLayoutStubs, trapUnhandled } from './helpers.ts'

let checkUnhandled: () => void
const mounted: EditorController[] = []

beforeAll(() => {
  installLayoutStubs()
})

beforeEach(() => {
  checkUnhandled = trapUnhandled()
})

afterEach(() => {
  for (const editor of mounted.splice(0)) editor.unmount()
  document.body.innerHTML = ''
  checkUnhandled()
})

/** 挂到页面上的编辑区。marked 里的 `|` 是光标位置。 */
function editorWith(marked: string, platform = 'darwin'): { editor: EditorController; view: EditorView } {
  const caret = marked.indexOf('|')
  const text = caret === -1 ? marked : marked.slice(0, caret) + marked.slice(caret + 1)
  const editor = createEditorController({ platform, placeholder: '输入 Prompt，支持 Markdown。', ariaLabel: 'Prompt 编辑区' })
  const position = caret === -1 ? text.length : caret
  editor.load(text, { anchor: position, head: position })
  editor.setEditable(true)
  const host = document.createElement('div')
  document.body.appendChild(host)
  editor.mount(host)
  mounted.push(editor)
  if (editor.view === null) throw new Error('editor did not mount')
  return { editor, view: editor.view }
}

interface KeyInit {
  key: string
  shiftKey?: boolean
  metaKey?: boolean
  ctrlKey?: boolean
  altKey?: boolean
  keyCode?: number
  isComposing?: boolean
}

/** 按编辑区的按键绑定跑一次按键，返回有没有绑定处理了它。 */
function press(view: EditorView, init: KeyInit): boolean {
  return runScopeHandlers(view, new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }), 'editor')
}

/** 像真实输入那样把按键事件派发到编辑区（会经过 CodeMirror 的事件观察者，测输入法组字的判断）。 */
function dispatchKey(view: EditorView, init: KeyInit): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
  view.contentDOM.dispatchEvent(event)
  return event
}

function marked(editor: EditorController): string {
  const text = editor.getText()
  const { anchor, head } = editor.getSelection()
  if (anchor === head) return `${text.slice(0, head)}|${text.slice(head)}`
  const from = Math.min(anchor, head)
  const to = Math.max(anchor, head)
  return `${text.slice(0, from)}«${text.slice(from, to)}»${text.slice(to)}`
}

describe('Enter（E-01、E-05）', () => {
  it('列表项行尾按 Enter 续行，一次撤销回到按 Enter 之前', () => {
    const { editor, view } = editorWith('- 第一项|')
    expect(press(view, { key: 'Enter' })).toBe(true)
    expect(marked(editor)).toBe('- 第一项\n- |')
    expect(editor.runCommand(undo)).toBe(true)
    expect(marked(editor)).toBe('- 第一项|')
  })

  it('有序列表编号加一，缩进保持', () => {
    const { editor, view } = editorWith('  3. 第三项|')
    press(view, { key: 'Enter' })
    expect(editor.getText()).toBe('  3. 第三项\n  4. ')
  })

  it('空项上按 Enter 结束列表，这一行变成空行', () => {
    const { editor, view } = editorWith('- 第一项\n- |')
    press(view, { key: 'Enter' })
    expect(marked(editor)).toBe('- 第一项\n|')
  })

  it('列表项中间和普通文字里按 Enter 只换行，不带缩进和符号', () => {
    const middle = editorWith('- 第一|项')
    press(middle.view, { key: 'Enter' })
    expect(marked(middle.editor)).toBe('- 第一\n|项')
    const plain = editorWith('    缩进的文字|')
    press(plain.view, { key: 'Enter' })
    expect(marked(plain.editor)).toBe('    缩进的文字\n|')
  })

  it('Shift+Enter 普通换行，不续行', () => {
    const { editor, view } = editorWith('- 第一项|')
    expect(press(view, { key: 'Enter', shiftKey: true })).toBe(true)
    expect(marked(editor)).toBe('- 第一项\n|')
  })

  it('续行之后接着打的字是新的一步，撤销一次只撤掉它们', () => {
    const { editor, view } = editorWith('- a|')
    press(view, { key: 'Enter' })
    editor.dispatch({ changes: { from: editor.getText().length, insert: 'b' }, selection: { anchor: editor.getText().length + 1 }, userEvent: 'input.type' })
    expect(editor.getText()).toBe('- a\n- b')
    editor.runCommand(undo)
    expect(editor.getText()).toBe('- a\n- ')
    editor.runCommand(undo)
    expect(editor.getText()).toBe('- a')
  })
})

describe('Tab 与 Shift+Tab（E-06）', () => {
  it('列表项上按 Tab 整行缩进 4 个空格，光标跟着走；Shift+Tab 还原', () => {
    const { editor, view } = editorWith('- 子|项')
    expect(press(view, { key: 'Tab' })).toBe(true)
    expect(marked(editor)).toBe('    - 子|项')
    expect(press(view, { key: 'Tab', shiftKey: true })).toBe(true)
    expect(marked(editor)).toBe('- 子|项')
  })

  it('普通文字里插入 4 个空格', () => {
    const { editor, view } = editorWith('ab|c')
    press(view, { key: 'Tab' })
    expect(marked(editor)).toBe('ab    |c')
  })

  it('选中三行按 Tab：每行多 4 个空格且仍然选中，一次撤销整步', () => {
    const { editor, view } = editorWith('a\nb\nc')
    editor.dispatch({ selection: { anchor: 0, head: 5 } })
    press(view, { key: 'Tab' })
    expect(marked(editor)).toBe('    «a\n    b\n    c»')
    editor.runCommand(undo)
    expect(editor.getText()).toBe('a\nb\nc')
  })

  it('没有可去的缩进时 Shift+Tab 什么都不改，但仍然吞掉按键（焦点不离开编辑区）', () => {
    const { editor, view } = editorWith('abc|')
    expect(press(view, { key: 'Tab', shiftKey: true })).toBe(true)
    expect(editor.getText()).toBe('abc')
  })

  it('不可编辑（草稿载入中）时 Tab 也吞掉，Enter 不处理', () => {
    const { editor, view } = editorWith('- a|')
    editor.setEditable(false)
    expect(press(view, { key: 'Tab' })).toBe(true)
    expect(press(view, { key: 'Enter' })).toBe(false)
    expect(editor.getText()).toBe('- a')
  })
})

describe('输入法组字（E-01）', () => {
  it('keyCode 229 的 Enter 是选词，不续行也不换行', () => {
    const { editor, view } = editorWith('- 第一项|')
    dispatchKey(view, { key: 'Enter', keyCode: 229 })
    expect(editor.getText()).toBe('- 第一项')
  })

  it('isComposing 的 Tab 交给输入法', () => {
    const { editor, view } = editorWith('- 第一项|')
    dispatchKey(view, { key: 'Tab', isComposing: true })
    expect(editor.getText()).toBe('- 第一项')
  })

  it('组字结束后的普通 Enter 照常续行', () => {
    const { editor, view } = editorWith('- 第一项|')
    dispatchKey(view, { key: 'Enter', keyCode: 229 })
    dispatchKey(view, { key: 'Enter', keyCode: 13 })
    expect(editor.getText()).toBe('- 第一项\n- ')
  })
})

describe('撤销与重做（E-01）', () => {
  it('⌘Z 撤销、⇧⌘Z 重做（Mod 由 CodeMirror 按运行环境判断，jsdom 里不是 Mac，Mod 是 Ctrl）', () => {
    const mod = /Mac/.test(navigator.platform) ? { metaKey: true } : { ctrlKey: true }
    const { editor, view } = editorWith('|')
    editor.dispatch({ changes: { from: 0, insert: 'abc' }, userEvent: 'input.type' })
    expect(press(view, { key: 'z', ...mod })).toBe(true)
    expect(editor.getText()).toBe('')
    expect(press(view, { key: 'z', shiftKey: true, ...mod })).toBe(true)
    expect(editor.getText()).toBe('abc')
  })

  it('Windows、Linux 上另支持 Ctrl+Y 重做；macOS 上 ⌃Y 不是重做', () => {
    const win = editorWith('|', 'win32')
    win.editor.dispatch({ changes: { from: 0, insert: 'abc' }, userEvent: 'input.type' })
    press(win.view, { key: 'z', ctrlKey: true })
    expect(win.editor.getText()).toBe('')
    expect(press(win.view, { key: 'y', ctrlKey: true })).toBe(true)
    expect(win.editor.getText()).toBe('abc')

    const mac = editorWith('|', 'darwin')
    mac.editor.dispatch({ changes: { from: 0, insert: 'abc' }, userEvent: 'input.type' })
    mac.editor.runCommand(undo)
    press(mac.view, { key: 'y', ctrlKey: true })
    expect(mac.editor.getText()).toBe('')
  })

  it('清空、插入库条目、应用候选各是一步：一次撤销回到操作之前', () => {
    const { editor } = editorWith('原文|')
    editor.dispatch({ changes: { from: 2, insert: '，继续' }, selection: { anchor: 5 }, userEvent: 'input.type' })
    editor.replaceAll('')
    expect(editor.runCommand(undo)).toBe(true)
    expect(editor.getText()).toBe('原文，继续')

    const edit = insertSnippet(editor.getText(), { from: 2, to: 2 }, '片段')
    if (edit === null) throw new Error('no edit')
    editor.apply(edit)
    expect(editor.getText()).toBe('原文\n\n片段\n\n，继续')
    editor.runCommand(undo)
    expect(editor.getText()).toBe('原文，继续')

    editor.replaceAll('候选')
    editor.runCommand(undo)
    expect(editor.getText()).toBe('原文，继续')
    editor.runCommand(redo)
    expect(editor.getText()).toBe('候选')
  })

  it('整篇替换（在编辑器中打开、重新载入）清空撤销记录', () => {
    const { editor } = editorWith('旧|')
    editor.dispatch({ changes: { from: 1, insert: '的' }, userEvent: 'input.type' })
    editor.load('新的正文', null)
    expect(editor.runCommand(undo)).toBe(false)
    expect(editor.getText()).toBe('新的正文')
    expect(editor.getSelection()).toEqual({ anchor: 4, head: 4 })
  })
})

describe('留给窗口级快捷键的键（技术方案 5.5）', () => {
  it('⌘↩、Esc、⌘L 不被编辑区吃掉', () => {
    const { view } = editorWith('- a|')
    expect(press(view, { key: 'Enter', metaKey: true })).toBe(false)
    expect(press(view, { key: 'Escape' })).toBe(false)
  })
})

describe('粘贴只取纯文本（E-01）', () => {
  function paste(view: EditorView, data: Record<string, string>): void {
    const event = new Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'clipboardData', { value: { getData: (type: string) => data[type] ?? '' } })
    view.contentDOM.dispatchEvent(event)
  }

  it('带格式的内容只插入纯文本', () => {
    const { editor, view } = editorWith('前|后')
    paste(view, { 'text/plain': '粗体文字', 'text/html': '<b>粗体文字</b>' })
    expect(marked(editor)).toBe('前粗体文字|后')
  })

  it('剪贴板里只有 HTML 或图片时什么都不插入；不可编辑时也不插入', () => {
    const { editor, view } = editorWith('前|后')
    paste(view, { 'text/html': '<img src="x">' })
    expect(editor.getText()).toBe('前后')
    editor.setEditable(false)
    paste(view, { 'text/plain': '文字' })
    expect(editor.getText()).toBe('前后')
  })
})

describe('编辑区的基本设置', () => {
  it('占位文字、无障碍名称跟随界面语言，挂载后不可编辑状态生效', () => {
    const { editor, view } = editorWith('')
    expect(view.dom.querySelector('.cm-placeholder')?.textContent).toBe('输入 Prompt，支持 Markdown。')
    editor.setLabels({ placeholder: 'Write a prompt. Markdown is supported.', ariaLabel: 'Prompt editor' })
    expect(view.dom.querySelector('.cm-placeholder')?.textContent).toBe('Write a prompt. Markdown is supported.')
    expect(view.contentDOM.getAttribute('aria-label')).toBe('Prompt editor')
    expect(view.contentDOM.getAttribute('contenteditable')).toBe('true')
    editor.setEditable(false)
    expect(view.contentDOM.getAttribute('contenteditable')).toBe('false')
    expect(view.state.tabSize).toBe(4)
    expect(view.contentDOM.getAttribute('spellcheck')).toBe('false')
  })

  it('没挂载时读写照样可用，挂载后接着用同一份状态（含撤销记录）', () => {
    const editor = createEditorController({ platform: 'darwin', placeholder: '', ariaLabel: '' })
    editor.load('', null)
    editor.setEditable(true)
    editor.dispatch({ changes: { from: 0, insert: 'abc' }, userEvent: 'input.type' })
    const host = document.createElement('div')
    document.body.appendChild(host)
    editor.mount(host)
    mounted.push(editor)
    expect(editor.mounted).toBe(true)
    expect(editor.getText()).toBe('abc')
    expect(editor.runCommand(undo)).toBe(true)
    expect(editor.getText()).toBe('')
    editor.unmount()
    expect(editor.mounted).toBe(false)
    expect(editor.runCommand(redo)).toBe(true)
    expect(editor.getText()).toBe('abc')
  })

  it('改动和选区变化都通知订阅者', () => {
    const { editor } = editorWith('a|')
    const updates: Array<{ docChanged: boolean; selectionSet: boolean }> = []
    const off = editor.onUpdate((update) => {
      updates.push(update)
    })
    editor.dispatch({ changes: { from: 1, insert: 'b' } })
    editor.dispatch({ selection: { anchor: 0 } })
    editor.load('x', null)
    off()
    editor.dispatch({ changes: { from: 0, insert: 'y' } })
    expect(updates).toEqual([
      { docChanged: true, selectionSet: false },
      { docChanged: false, selectionSet: true },
      { docChanged: true, selectionSet: true },
    ])
  })
})
