// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, within } from '@testing-library/react'
import { redo, undo } from '@codemirror/commands'
import { EditorSelection, type Transaction } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { App } from '../../../src/app/renderer/components/App.tsx'
import { AppController } from '../../../src/app/renderer/controller/app.ts'
import type { TextSelection } from '../../../src/shared/types.ts'
import { draftRecord, FakeBridge, installLayoutStubs, ok, settle, trapUnhandled } from './helpers.ts'

let checkUnhandled: () => void
const controllers: AppController[] = []

beforeAll(installLayoutStubs)

beforeEach(() => {
  checkUnhandled = trapUnhandled()
})

afterEach(() => {
  cleanup()
  for (const controller of controllers.splice(0)) controller.dispose()
  checkUnhandled()
})

async function mount(text = '', selection: TextSelection | null = null) {
  const bridge = new FakeBridge()
  bridge.handle('draft.load', () => ok({ record: draftRecord(text, { selection }) }))
  const controller = new AppController({ bridge, locale: 'zh' })
  controllers.push(controller)
  render(<App controller={controller} />)
  await act(async () => {
    await controller.start()
    await controller.layout.settled()
    await settle()
  })
  const view = controller.editor.view
  if (view === null) throw new Error('editor is not mounted')
  act(() => { view.focus() })
  return { editor: controller.editor, view, bridge }
}

/** jsdom 不执行浏览器的原生文本输入，走 CodeMirror 给 DOM 输入提供的处理器和默认事务。 */
function type(view: EditorView, text: string): void {
  act(() => {
    for (const char of text) {
      const { from, to } = view.state.selection.main
      let transaction: Transaction | undefined
      const insert = (): Transaction => {
        transaction ??= view.state.update({
          changes: { from, to, insert: char },
          selection: EditorSelection.single(from + char.length),
          userEvent: view.compositionStarted ? 'input.type.compose' : 'input.type',
        })
        return transaction
      }
      if (!view.state.facet(EditorView.inputHandler).some(handler => handler(view, from, to, char, insert))) {
        view.dispatch(insert())
      }
    }
  })
}

function popup(): HTMLElement | null {
  return document.querySelector('.px-slash-menu')
}

function aliases(): Array<string | null> {
  return Array.from(popup()?.querySelectorAll('.px-slash-option .px-slash-alias') ?? [], option => option.textContent)
}

function tagInput(): HTMLInputElement {
  const input = popup()?.querySelector('input')
  if (input === undefined || input === null) throw new Error('tag name input is not mounted')
  return input
}

describe('主 Prompt 编辑区的行首插入菜单', () => {
  it.each(['/', '、'])('行首输入 %s 后用唯一缩写选择代码块，一次撤销复原命令', async (trigger) => {
    const { editor, view } = await mount('任务\n')
    type(view, trigger)
    expect(aliases()).toEqual(['h1', 'h2', 'h3', 'tag', 'code', 'quote'])

    type(view, 'co')
    expect(aliases()).toEqual(['code'])
    expect(editor.getText()).toBe(`任务\n${trigger}co`)
    fireEvent.keyDown(view.contentDOM, { key: 'Enter' })
    expect(editor.getText()).toBe('任务\n```\n\n```')
    expect(editor.getSelection()).toEqual({ anchor: 7, head: 7 })
    expect(popup()).toBeNull()

    act(() => { expect(editor.runCommand(undo)).toBe(true) })
    expect(editor.getText()).toBe(`任务\n${trigger}co`)
    expect(popup()).toBeNull()
    act(() => { expect(editor.runCommand(redo)).toBe(true) })
    expect(editor.getText()).toBe('任务\n```\n\n```')
    expect(editor.getSelection()).toEqual({ anchor: 7, head: 7 })
    expect(popup()).toBeNull()
  })

  it.each([
    { text: '前文', selection: { anchor: 2, head: 2 }, result: '前文/' },
    { text: ' ', selection: { anchor: 1, head: 1 }, result: ' /' },
    { text: '原文', selection: { anchor: 0, head: 2 }, result: '/' },
  ])('普通输入按原规则处理（$text，选区 $selection）', async ({ text, selection, result }) => {
    const { editor, view } = await mount(text, selection)
    type(view, '/')
    expect(editor.getText()).toBe(result)
    expect(popup()).toBeNull()
  })

  it('草稿载入、粘贴和无法匹配的路径都保留原文', async () => {
    const { editor, view } = await mount('/code\n')
    expect(popup()).toBeNull()
    fireEvent.paste(view.contentDOM, { clipboardData: { getData: () => '/tag\n' } })
    expect(editor.getText()).toBe('/code\n/tag\n')
    expect(popup()).toBeNull()

    type(view, '/Users')
    expect(editor.getText()).toBe('/code\n/tag\n/Users')
    expect(popup()).toBeNull()
  })

  it('在已有文字的行首插入语法块时保留光标后的正文', async () => {
    const { editor, view } = await mount('原来的正文\n下一行', { anchor: 0, head: 0 })
    type(view, '/co')
    fireEvent.keyDown(view.contentDOM, { key: 'Enter' })
    expect(editor.getText()).toMatch(/^```\n\n```\n+原来的正文\n下一行$/)
    expect(editor.getSelection()).toEqual({ anchor: 4, head: 4 })
  })

  it.each([1, 2, 3])('输入 h%s 插入对应级别的标题并将光标放在空格后', async (level) => {
    const { editor, view } = await mount()
    type(view, `/h${level}`)
    expect(aliases()).toEqual([`h${level}`])
    fireEvent.keyDown(view.contentDOM, { key: 'Enter' })
    expect(editor.getText()).toBe('#'.repeat(level) + ' ')
    expect(editor.getSelection()).toEqual({ anchor: level + 1, head: level + 1 })
    expect(popup()).toBeNull()
  })

  it('标题前缀匹配多项时保留命令，方向键可按菜单顺序选择', async () => {
    const { editor, view } = await mount()
    type(view, '/h')
    expect(aliases()).toEqual(['h1', 'h2', 'h3'])
    fireEvent.keyDown(view.contentDOM, { key: 'Enter' })
    expect(editor.getText()).toBe('/h')

    fireEvent.keyDown(view.contentDOM, { key: 'ArrowDown' })
    fireEvent.keyDown(view.contentDOM, { key: 'Enter' })
    expect(editor.getText()).toBe('# ')

    act(() => { editor.load('', null) })
    type(view, '/')
    fireEvent.keyDown(view.contentDOM, { key: 'ArrowUp' })
    fireEvent.keyDown(view.contentDOM, { key: 'Enter' })
    expect(editor.getText()).toBe('> ')
  })

  it('依次用 Esc 关闭插入菜单和小窗，原命令保留', async () => {
    const { editor, view, bridge } = await mount()
    type(view, '/co')
    expect(popup()).not.toBeNull()
    fireEvent.keyDown(view.contentDOM, { key: 'Escape' })
    expect(popup()).toBeNull()
    expect(editor.getText()).toBe('/co')
    expect(bridge.window.hide).not.toHaveBeenCalled()

    await act(async () => {
      fireEvent.keyDown(view.contentDOM, { key: 'Escape' })
      await settle()
    })
    expect(bridge.window.hide).toHaveBeenCalledOnce()
  })

  it('自定义标签等名称确认后才写入，保留大小写并将光标放在两者之间', async () => {
    const { editor, view, bridge } = await mount()
    type(view, '/tag')
    fireEvent.keyDown(view.contentDOM, { key: 'Enter' })
    expect(editor.getText()).toBe('/tag')
    fireEvent.input(tagInput(), { target: { value: '2 invalid' } })
    fireEvent.keyDown(tagInput(), { key: 'Enter' })
    expect(editor.getText()).toBe('/tag')
    fireEvent.keyDown(tagInput(), { key: 'Escape' })
    expect(popup()).toBeNull()
    expect(bridge.window.hide).not.toHaveBeenCalled()

    act(() => { editor.load('', null) })
    type(view, '/tag')
    fireEvent.keyDown(view.contentDOM, { key: 'Enter' })
    const name = 'Answer_Format-v2:Block'
    fireEvent.input(tagInput(), { target: { value: name } })
    fireEvent.keyDown(tagInput(), { key: 'Enter', isComposing: true, keyCode: 229 })
    expect(editor.getText()).toBe('/tag')
    fireEvent.keyDown(tagInput(), { key: 'Enter' })

    const source = editor.getText()
    const { anchor, head } = editor.getSelection()
    expect(source).toBe(`<${name}>\n\n\n\n</${name}>`)
    expect(anchor).toBe(`<${name}>\n\n`.length)
    expect(head).toBe(anchor)
    expect(popup()).toBeNull()
    act(() => { expect(editor.runCommand(undo)).toBe(true) })
    expect(editor.getText()).toBe('/tag')
    expect(popup()).toBeNull()
  })

  it('每项显示图标、名称和缩写，底部用键帽提示按键', async () => {
    const { view } = await mount()
    type(view, '/')
    const options = Array.from(popup()?.querySelectorAll('.px-slash-option') ?? [])
    expect(options.map(option => option.querySelector('.px-slash-label')?.textContent)).toEqual(['一级标题', '二级标题', '三级标题', '自定义标签', '代码块', '引用'])
    expect(options.every(option => option.querySelector('.px-slash-icon[aria-hidden="true"] svg path') !== null)).toBe(true)
    expect(Array.from(popup()?.querySelectorAll('.px-slash-keys .px-slash-key') ?? [], key => key.textContent)).toEqual(['↑', '↓', '↵', 'esc'])
  })

  it('指针移动到菜单项上就选中它，键盘和悬停共用一个选中项', async () => {
    const { editor, view } = await mount()
    type(view, '/')
    const option = (alias: string) => popup()?.querySelector(`#px-slash-option-${alias}`)
    const quote = option('quote')
    if (quote === null || quote === undefined) throw new Error('quote option is not mounted')

    // 菜单弹在静止的指针下面时第一次 mousemove 只记录位置，不替用户预选。
    fireEvent.mouseMove(quote, { clientX: 40, clientY: 200 })
    expect(quote.getAttribute('aria-selected')).toBe('false')
    fireEvent.mouseMove(quote, { clientX: 42, clientY: 200 })
    expect(quote.getAttribute('aria-selected')).toBe('true')
    expect(view.contentDOM.getAttribute('aria-activedescendant')).toBe('px-slash-option-quote')

    // 只换选中项时原地更新，按钮不重建。
    fireEvent.keyDown(view.contentDOM, { key: 'ArrowUp' })
    expect(option('quote')).toBe(quote)
    expect(option('code')?.getAttribute('aria-selected')).toBe('true')
    expect(quote.getAttribute('aria-selected')).toBe('false')
    fireEvent.mouseMove(quote, { clientX: 42, clientY: 200 })
    expect(option('code')?.getAttribute('aria-selected')).toBe('true')

    fireEvent.mouseMove(quote, { clientX: 44, clientY: 201 })
    fireEvent.keyDown(view.contentDOM, { key: 'Enter' })
    expect(editor.getText()).toBe('> ')
  })

  it('只在打开菜单时播放出现动画，筛选后重建的浮层不再播放', async () => {
    const { view } = await mount()
    type(view, '/')
    expect(popup()?.classList.contains('px-slash-enter')).toBe(true)
    type(view, 'c')
    expect(aliases()).toEqual(['code'])
    expect(popup()?.classList.contains('px-slash-enter')).toBe(false)

    fireEvent.keyDown(view.contentDOM, { key: 'Escape' })
    expect(popup()).toBeNull()
    type(view, '\n/')
    expect(popup()?.classList.contains('px-slash-enter')).toBe(true)
  })

  it('标签名浮层实时预览插入结果，名称不合法时换成提示，按钮名称不含键帽', async () => {
    const { editor, view } = await mount()
    type(view, '/tag')
    fireEvent.keyDown(view.contentDOM, { key: 'Enter' })
    const form = popup()
    if (form === null) throw new Error('tag form is not mounted')
    const preview = form.querySelector<HTMLElement>('.px-slash-preview')
    const error = form.querySelector<HTMLElement>('.px-slash-error')
    expect(preview?.textContent).toBe('')

    fireEvent.input(tagInput(), { target: { value: ' context ' } })
    expect(preview?.textContent).toBe('<context> … </context>')
    expect(Array.from(preview?.querySelectorAll('.px-md-tag-name') ?? [], name => name.textContent)).toEqual(['context', 'context'])
    fireEvent.input(tagInput(), { target: { value: '1context' } })
    expect(preview?.textContent).toBe('')
    fireEvent.keyDown(tagInput(), { key: 'Enter' })
    expect(tagInput().getAttribute('aria-invalid')).toBe('true')
    expect(error?.hidden).toBe(false)
    expect(preview?.hidden).toBe(true)

    fireEvent.input(tagInput(), { target: { value: 'context' } })
    expect(error?.hidden).toBe(true)
    expect(preview?.hidden).toBe(false)
    expect(within(form).getByRole('textbox', { name: '标签名' })).toBe(tagInput())
    within(form).getByRole('button', { name: '取消' })
    fireEvent.click(within(form).getByRole('button', { name: '插入' }))
    expect(editor.getText()).toBe('<context>\n\n\n\n</context>')
    expect(popup()).toBeNull()
  })

  it('顿号完成组字后打开菜单，组字回车不会确认命令', async () => {
    const { editor, view } = await mount()
    act(() => { fireEvent.compositionStart(view.contentDOM) })
    type(view, '、')
    fireEvent.keyDown(view.contentDOM, { key: 'Enter', isComposing: true, keyCode: 229 })
    expect(popup()).toBeNull()
    expect(editor.getText()).toBe('、')
    await act(async () => {
      fireEvent.compositionEnd(view.contentDOM, { data: '、' })
      await new Promise(resolve => setTimeout(resolve, 5))
    })
    expect(aliases()).toHaveLength(6)
  })
})
