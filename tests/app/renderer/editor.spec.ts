// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, it, expect } from 'vitest'
import { redo, undo } from '@codemirror/commands'
import { runScopeHandlers, type EditorView } from '@codemirror/view'
import type { AppController } from '../../../src/app/renderer/controller/app.ts'
import { createEditorController, type EditorController } from '../../../src/app/renderer/editor/controller.ts'
import { insertSnippet } from '../../../src/app/renderer/editor/commands.ts'
import { draftRecord, FakeBridge, installLayoutStubs, ok, startController, trapUnhandled } from './helpers.ts'

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

function mountEditor(editor: EditorController): EditorView {
  editor.mount(document.body.appendChild(document.createElement('div')))
  mounted.push(editor)
  if (editor.view === null) throw new Error('editor did not mount')
  return editor.view
}

/** 挂到页面上的编辑区。marked 里的 `|` 是光标位置。 */
function editorWith(marked: string, platform = 'darwin'): { editor: EditorController; view: EditorView } {
  const caret = marked.indexOf('|')
  const text = caret === -1 ? marked : marked.slice(0, caret) + marked.slice(caret + 1)
  const editor = createEditorController({ platform, placeholder: '输入 Prompt，支持 Markdown。', ariaLabel: 'Prompt 编辑区' })
  const position = caret === -1 ? text.length : caret
  editor.load(text, { anchor: position, head: position })
  editor.setEditable(true)
  return { editor, view: mountEditor(editor) }
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

/** 选择器命中的所有元素的文字按文档顺序拼起来。语法符号单独成段，同一段粗体会分在几个元素里。 */
function joinedText(view: EditorView, selector: string): string {
  return Array.from(view.contentDOM.querySelectorAll(selector), node => node.textContent).join('')
}

/** 带指定类名的行在编辑区里的序号（从 0 开始）。 */
function linesWith(view: EditorView, className: string): number[] {
  return Array.from(view.contentDOM.querySelectorAll('.cm-line'), (line, index) => line.classList.contains(className) ? index : -1)
    .filter(index => index >= 0)
}

function marked(editor: EditorController): string {
  const text = editor.getText()
  const { anchor, head } = editor.getSelection()
  if (anchor === head) return `${text.slice(0, head)}|${text.slice(head)}`
  const from = Math.min(anchor, head)
  const to = Math.max(anchor, head)
  return `${text.slice(0, from)}«${text.slice(from, to)}»${text.slice(to)}`
}

describe('Markdown 源文高亮', () => {
  it('主编辑区给 Markdown 源文着色，复制、撤销和重新载入时保留文本和选区', async () => {
    const source = [
      '# 项目简报',
      '',
      '1. **省成本**和*提上限*，记录 order_id。',
      '- 环境：`ScienceWorld`',
      '',
      '[实验记录](./runs.md)',
      '',
      '> 对同一组任务重复评测。',
      '',
      '```text',
      '**代码块里的字符**',
      '```',
    ].join('\n')
    const selection = { anchor: 2, head: 6 }
    const bridge = new FakeBridge()
    bridge.handle('draft.load', () => ok({ record: draftRecord(source, { selection }) }))
    const app = await startController(bridge)
    try {
      const { editor } = app
      const view = mountEditor(editor)
      const textOf = (selector: string) => Array.from(view.contentDOM.querySelectorAll(selector), node => node.textContent).join('')

      expect(textOf('.px-md-heading')).toBe('# 项目简报')
      expect(textOf('.px-md-strong')).toBe('**省成本**')
      expect(textOf('.px-md-emphasis')).toBe('*提上限*')
      expect(textOf('.px-md-list')).toBe('1.-')
      expect(textOf('.px-md-link')).toBe('[实验记录](./runs.md)')
      expect(textOf('.px-md-link:not(.px-md-link-syntax)')).toBe('实验记录')
      expect(textOf('.px-md-quote')).toBe('> 对同一组任务重复评测。')
      expect(textOf('.px-md-code')).toBe('ScienceWorld')
      expect(textOf('.px-md-code-block')).toBe('**代码块里的字符**')
      expect(textOf('.px-md-code-fence')).toBe('```text```')
      // 标题的 #、强调的星号、行内代码的反引号、引用的 > 统一按语法符号着色；链接和围栏符号有自己的类名。
      expect(textOf('.px-md-mark')).toBe('#******``>')
      // 行内代码底色是一个包住反引号和代码的整体元素，圆角不会被语法高亮拆开。
      expect(Array.from(view.contentDOM.querySelectorAll('.px-md-code-span'), node => node.textContent)).toEqual(['`ScienceWorld`'])
      expect(linesWith(view, 'px-md-quote-line')).toEqual([7])
      expect(linesWith(view, 'px-md-code-line')).toEqual([9, 10, 11])
      expect(linesWith(view, 'px-md-code-start')).toEqual([9])
      expect(linesWith(view, 'px-md-code-end')).toEqual([11])
      expect(view.contentDOM.querySelector('a')).toBeNull()
      expect(Array.from(view.contentDOM.querySelectorAll('.cm-line'), node => node.textContent).join('\n')).toBe(source)
      expect(editor.getSelection()).toEqual(selection)

      expect(await app.copyAndHide()).toEqual({ ok: true })
      expect(bridge.window.copyAndHide).toHaveBeenCalledWith(source)
      expect(editor.getText()).toBe(source)
      expect(editor.getSelection()).toEqual(selection)

      editor.dispatch({ changes: { from: 0, to: 2 }, userEvent: 'input.type' })
      expect(textOf('.px-md-heading')).toBe('')
      expect(editor.runCommand(undo)).toBe(true)
      expect(textOf('.px-md-heading')).toBe('# 项目简报')
      expect(editor.getSelection()).toEqual(selection)

      editor.load('## 重新载入', null)
      expect(textOf('.px-md-heading')).toBe('## 重新载入')
      expect(editor.getText()).toBe('## 重新载入')
      expect(editor.getSelection()).toEqual({ anchor: 7, head: 7 })
    } finally {
      app.dispose()
    }
  })

  it('自定义标签显示成标签块，代码、链接地址和注释里的尖括号保持原样', async () => {
    const source = [
      '<context>',
      '',
      '# 角色 <role>',
      '',
      '正文里有 <b>行内</b> 标签、`<code>` 和 [链接](<a:b>)。',
      '',
      '</context>',
      '',
      '<Answer_Format-v2:Block>',
      '',
      '<https://example.com/a> <name@example.com>',
      '',
      '<!-- <note> -->',
      '',
      '```',
      '<tag>',
      '```',
      '',
      '    <indented>',
    ].join('\n')
    const bridge = new FakeBridge()
    bridge.handle('draft.load', () => ok({ record: draftRecord(source) }))
    const app = await startController(bridge)
    try {
      const view = mountEditor(app.editor)
      const texts = (selector: string) => Array.from(view.contentDOM.querySelectorAll(selector), node => node.textContent)

      // 每个标签块是一个整体元素；带 . 或 : 的名字（CommonMark 不当成 HTML，或当成自动链接）也算标签。
      expect(texts('.px-md-tag')).toEqual(['<context>', '<role>', '<b>', '</b>', '</context>', '<Answer_Format-v2:Block>'])
      expect(texts('.px-md-tag-name')).toEqual(['context', 'role', 'b', 'b', 'context', 'Answer_Format-v2:Block'])
      expect(joinedText(view, '.px-md-tag-bracket')).toBe('<><><></></><>')
      expect(texts('.px-md-code-span')).toEqual(['`<code>`'])
      expect(texts('.cm-line').join('\n')).toBe(source)
    } finally {
      app.dispose()
    }
  })

  it('未启用高亮的编辑框保留纯文本', () => {
    const source = '# 标题\n\n- **加粗**'
    const { editor, view } = editorWith(source)
    expect(view.contentDOM.querySelector('.px-md-heading, .px-md-list, .px-md-strong')).toBeNull()
    expect(editor.getText()).toBe(source)
  })
})

describe('主编辑区 Markdown 加粗快捷键', () => {
  const apps: AppController[] = []
  const macBold = { key: 'b', metaKey: true }

  afterEach(() => {
    for (const app of apps.splice(0)) app.dispose()
  })

  async function mainEditor(platform = 'darwin'): Promise<{ editor: EditorController; view: EditorView }> {
    const app = await startController(new FakeBridge(platform))
    apps.push(app)
    return { editor: app.editor, view: mountEditor(app.editor) }
  }

  it.each([
    ['darwin', macBold],
    ['win32', { key: 'b', ctrlKey: true }],
    ['linux', { key: 'b', ctrlKey: true }],
  ])('用平台快捷键加粗和取消加粗，保留反向选区（%s）', async (platform, shortcut) => {
    const { editor, view } = await mainEditor(platform)
    const selection = { anchor: 4, head: 0 }
    editor.load('选中这段', selection)

    expect(dispatchKey(view, shortcut).defaultPrevented).toBe(true)
    expect(editor.getText()).toBe('**选中这段**')
    expect(editor.getSelection()).toEqual({ anchor: 6, head: 2 })
    expect(joinedText(view, '.px-md-strong')).toBe('**选中这段**')

    expect(dispatchKey(view, shortcut).defaultPrevented).toBe(true)
    expect(editor.getText()).toBe('选中这段')
    expect(editor.getSelection()).toEqual(selection)
    expect(editor.runCommand(undo)).toBe(true)
    expect(editor.getText()).toBe('**选中这段**')
    expect(editor.getSelection()).toEqual({ anchor: 6, head: 2 })
  })

  it('保留选区两端的空白，选中整段加粗源码也能取消加粗', async () => {
    const { editor, view } = await mainEditor()
    const source = '  重要  '
    editor.load(source, { anchor: 0, head: source.length })
    expect(press(view, macBold)).toBe(true)
    expect(editor.getText()).toBe('  **重要**  ')
    expect(joinedText(view, '.px-md-strong')).toBe('**重要**')

    editor.dispatch({ selection: { anchor: 0, head: editor.getText().length } })
    expect(press(view, macBold)).toBe(true)
    expect(editor.getText()).toBe(source)
  })

  it('没有选区时插入两个加粗标记，光标留在中间，重按移除标记', async () => {
    const { editor, view } = await mainEditor()
    editor.load('甲乙', { anchor: 1, head: 1 })
    expect(press(view, macBold)).toBe(true)
    expect(marked(editor)).toBe('甲**|**乙')
    expect(press(view, macBold)).toBe(true)
    expect(marked(editor)).toBe('甲|乙')
  })

  it('选区跨越两段加粗时保留原有的两组标记', async () => {
    const { editor, view } = await mainEditor()
    const source = '**甲** 和 **乙**'
    editor.load(source, { anchor: 0, head: source.length })
    expect(press(view, macBold)).toBe(true)
    expect(editor.getText()).toBe(`**${source}**`)
  })

  it('输入法组字、只读状态和通用编辑框不执行加粗快捷键', async () => {
    const { editor, view } = await mainEditor()
    editor.load('选中', { anchor: 0, head: 2 })
    dispatchKey(view, { ...macBold, isComposing: true, keyCode: 229 })
    expect(editor.getText()).toBe('选中')
    editor.setEditable(false)
    dispatchKey(view, macBold)
    expect(editor.getText()).toBe('选中')

    const plain = editorWith('正文|')
    dispatchKey(plain.view, macBold)
    expect(marked(plain.editor)).toBe('正文|')
  })
})

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

  it('只有列表符号、后面没有空格的行按 Enter 只换行，不清掉这一行（E-01、E-05，审查 CR-05）', () => {
    for (const line of ['-', '  *', '2.', '2024.']) {
      const { editor, view } = editorWith(`${line}|`)
      expect(press(view, { key: 'Enter' })).toBe(true)
      expect(marked(editor)).toBe(`${line}\n|`)
    }
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

  it('只有列表符号、后面没有空格的行按 Tab 在光标处插入空格，不缩进整行（审查 CR-05）', () => {
    const { editor, view } = editorWith('2024.|')
    press(view, { key: 'Tab' })
    expect(marked(editor)).toBe('2024.    |')
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
