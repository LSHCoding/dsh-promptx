import { isolateHistory } from '@codemirror/commands'
import { syntaxTree } from '@codemirror/language'
import { Prec, StateEffect, StateField, Text, type EditorState, type Extension, type Transaction } from '@codemirror/state'
import { EditorView, ViewPlugin, keymap, showTooltip, tooltips, type TooltipView, type ViewUpdate } from '@codemirror/view'
import { translate, type Locale, type MessageKey } from '../../../shared/i18n/index.ts'
import { isComposingKey } from '../appearance.ts'
import { isComposing } from './keymap.ts'

const FENCE = '```'
// 16 × 16 线条图标的路径，画法与工具栏 icons.tsx 相同（笔画 1.3、圆头）。菜单直接用 DOM 搭建，路径单独放在这里。
const HEADING_ICON = 'M2.75 4v8M7.25 4v8M2.75 8h4.5'
const TAG_ICON = 'M5.25 4.75 2.5 8l2.75 3.25M10.75 4.75 13.5 8l-2.75 3.25M9.1 3.5 6.9 12.5'
const COMMANDS = [
  { alias: 'h1', label: 'slash.heading1', icon: HEADING_ICON + 'M10.25 5.75 12 4.25V12', before: '# ', after: '' },
  { alias: 'h2', label: 'slash.heading2', icon: HEADING_ICON + 'M10.1 5.6a1.75 1.75 0 0 1 3.5.35c0 .55-.25 1-.75 1.55L10 12h3.75', before: '## ', after: '' },
  { alias: 'h3', label: 'slash.heading3', icon: HEADING_ICON + 'M10.25 4.25h3.25L11.6 6.9c1.25-.1 2.15.75 2.15 2.3 0 1.6-1.05 2.8-2.4 2.8-.6 0-1.1-.2-1.5-.55', before: '### ', after: '' },
  { alias: 'tag', label: 'slash.tag', icon: TAG_ICON, before: '', after: '' },
  { alias: 'code', label: 'slash.code', icon: 'M5.75 3.25c-1 0-1.6.5-1.6 1.4v1.7c0 .8-.45 1.4-1.4 1.65.95.25 1.4.85 1.4 1.65v1.7c0 .9.6 1.4 1.6 1.4M10.25 3.25c1 0 1.6.5 1.6 1.4v1.7c0 .8.45 1.4 1.4 1.65-.95.25-1.4.85-1.4 1.65v1.7c0 .9-.6 1.4-1.6 1.4', before: FENCE + '\n', after: '\n' + FENCE },
  { alias: 'quote', label: 'slash.quote', icon: 'M3.25 3.75v8.5M6.25 5.25h6.5M6.25 8h6.5M6.25 10.75h4.5', before: '> ', after: '' },
] as const
type SlashCommand = typeof COMMANDS[number]
const TAG_NAME = /^[A-Za-z][A-Za-z0-9_.:-]*$/
const SVG_NS = 'http://www.w3.org/2000/svg'

interface Menu {
  from: number
  to: number
  matches: readonly SlashCommand[]
  selected: SlashCommand | null
  namingTag: boolean
}

const MAX_ALIAS_LENGTH = Math.max(...COMMANDS.map(command => command.alias.length))
const OPTION_ID = 'px-slash-option-'
const LIST_ID = 'px-slash-options'
const setMenu = StateEffect.define<Menu | null>()

function isTrigger(text: string): boolean {
  return text === '/' || text === '、'
}

function isEditable(state: EditorState): boolean {
  return !state.readOnly && state.facet(EditorView.editable)
}

function canStart(state: EditorState): boolean {
  const { main, ranges } = state.selection
  if (!main.empty || ranges.length !== 1 || main.from !== state.doc.lineAt(main.from).from || !isEditable(state)) return false
  // 用当前位置之前的节点判断未闭合围栏最后一行，也保留其后的普通行。
  const cursor = syntaxTree(state).cursorAt(main.from, -1)
  do {
    if (cursor.name === 'FencedCode' || cursor.name === 'CodeBlock') return false
  } while (cursor.parent())
  return true
}

function filterMenu(state: EditorState, from: number): Menu | null {
  const { main, ranges } = state.selection
  const to = main.head
  if (!main.empty || ranges.length !== 1 || to <= from || to - from > MAX_ALIAS_LENGTH + 1) return null
  const text = state.sliceDoc(from, to)
  if (!isTrigger(text.charAt(0))) return null
  const prefix = text.slice(1).toLowerCase()
  const matches = COMMANDS.filter(command => command.alias.startsWith(prefix))
  return matches.length === 0 ? null : { from, to, matches, selected: matches.length === 1 ? matches[0] ?? null : null, namingTag: false }
}

function triggerInput(transaction: Transaction): boolean {
  const from = transaction.startState.selection.main.from
  return transaction.newSelection.main.head === from + 1
    && transaction.newDoc.length === transaction.startState.doc.length + 1
    && isTrigger(transaction.newDoc.sliceString(from, from + 1))
    && canStart(transaction.startState)
    && transaction.newDoc.replace(from, from + 1, Text.empty).eq(transaction.startState.doc)
}

const menuState = StateField.define<Menu | null>({
  create: () => null,
  update(menu, transaction) {
    if (!isEditable(transaction.state)) return null
    for (const effect of transaction.effects) {
      if (effect.is(setMenu)) return effect.value
    }
    // 候选文字上屏前保持原菜单，compositionend 后只用正式提交的文本更新。
    if (transaction.isUserEvent('input.type.compose')) return menu
    if (!transaction.docChanged) {
      if (menu === null || !transaction.selection) return menu
      const selection = transaction.newSelection.main
      return selection.empty && selection.head === menu.to ? menu : null
    }
    if (menu === null) {
      return transaction.isUserEvent('input.type') && triggerInput(transaction)
        ? filterMenu(transaction.state, transaction.startState.selection.main.from)
        : null
    }
    if (menu.namingTag || (!transaction.isUserEvent('input.type') && !transaction.isUserEvent('delete'))) return null
    const affected: Array<{ from: number; to: number }> = []
    transaction.changes.iterChangedRanges((from, to) => {
      affected.push({ from, to })
    })
    return affected.every(range => range.from >= menu.from && range.to <= menu.to)
      ? filterMenu(transaction.state, menu.from)
      : null
  },
})

/** 窗口的 Esc 先收起菜单，内容修改交给明确的插入操作。 */
export function dismissSlashMenu(view: EditorView | null, restoreFocus = true): boolean {
  if (view === null) return false
  const menu = view.state.field(menuState, false)
  if (menu == null) return false
  view.dispatch({ effects: setMenu.of(null) })
  if (restoreFocus && menu.namingTag) view.focus()
  return true
}

const compositionPlugin = ViewPlugin.fromClass(class {
  private startState: EditorState | null = null
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly view: EditorView) {
    view.dom.addEventListener('focusout', this.focusout)
  }

  start(): void {
    this.cancel()
    const { state } = this.view
    if (state.field(menuState) !== null || canStart(state)) this.startState = state
  }

  end(text: string): void {
    const start = this.startState
    if (start === null) return
    // 和文字转换一样，等 Chromium 把落字刷新进 EditorState，再读取正式文本和光标。
    this.timer = setTimeout(() => {
      this.cancel()
      const { state } = this.view
      if (this.view.compositionStarted || !isEditable(state)) return
      const menu = start.field(menuState)
      const at = start.selection.main.head
      const caret = state.selection.main
      const committed = caret.empty && caret.head === at + text.length
        && state.doc.eq(start.doc.replace(at, at, state.toText(text)))
      const from = menu?.from ?? at
      const next = committed && (menu !== null || isTrigger(text)) ? filterMenu(state, from) : null
      if (state.field(menuState) !== next) this.view.dispatch({ effects: setMenu.of(next) })
    }, 0)
  }

  update(update: ViewUpdate): void {
    if (this.startState !== null && update.transactions.some(transaction =>
      transaction.effects.some(effect => effect.is(setMenu))
      || (transaction.docChanged && !transaction.isUserEvent('input.type')))) this.cancel()
  }

  private cancel(): void {
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
    this.startState = null
  }

  private readonly focusout = (event: FocusEvent): void => {
    if (event.relatedTarget instanceof Node && this.view.dom.contains(event.relatedTarget)) return
    this.cancel()
    // 编辑器重新配置时也可能移除输入框，此时不能在 view.update 内再派发事务。
    queueMicrotask(() => {
      if (this.view.dom.isConnected && !this.view.dom.contains(this.view.root.activeElement)) dismissSlashMenu(this.view, false)
    })
  }

  destroy(): void {
    this.cancel()
    this.view.dom.removeEventListener('focusout', this.focusout)
  }
}, {
  eventObservers: {
    compositionstart() {
      this.start()
    },
    compositionend(event) {
      this.end(event.data)
    },
  },
})

function insert(view: EditorView, menu: Menu, before: string, after: string): void {
  const line = view.state.doc.lineAt(menu.to)
  const suffix = after !== '' && menu.to < line.to ? '\n' : ''
  view.dispatch({
    changes: { from: menu.from, to: menu.to, insert: before + after + suffix },
    selection: { anchor: menu.from + before.length },
    effects: setMenu.of(null),
    annotations: isolateHistory.of('full'),
    userEvent: 'input',
    scrollIntoView: true,
  })
  // CodeMirror 默认重做把光标映射到替换末尾，显式记录选区让重做回到块内。
  view.dispatch({ selection: view.state.selection, userEvent: 'select' })
  view.focus()
}

function pick(view: EditorView, command: SlashCommand): void {
  const menu = view.state.field(menuState)
  // 键盘入口已检查当前按键。点击只看活动组字，避免上一个组字按键阻止菜单点击。
  if (menu === null || menu.namingTag || view.compositionStarted || !isEditable(view.state)) return
  if (command.alias === 'tag') view.dispatch({ effects: setMenu.of({ ...menu, namingTag: true }) })
  else insert(view, menu, command.before, command.after)
}

function move(view: EditorView, direction: number): boolean {
  const menu = view.state.field(menuState)
  if (menu === null || menu.namingTag || isComposing(view)) return false
  const current = menu.selected === null ? (direction > 0 ? -1 : 0) : menu.matches.indexOf(menu.selected)
  const selected = menu.matches[(current + direction + menu.matches.length) % menu.matches.length]
  view.dispatch({ effects: setMenu.of({ ...menu, selected: selected ?? null }) })
  return true
}

/** 悬停即选中：菜单里只有一种选中态，Enter 和点击都作用在它上面。 */
function hover(view: EditorView, command: SlashCommand): void {
  const menu = view.state.field(menuState)
  if (menu === null || menu.namingTag || menu.selected === command || view.compositionStarted) return
  view.dispatch({ effects: setMenu.of({ ...menu, selected: command }) })
}

function sameCommands(a: readonly SlashCommand[], b: readonly SlashCommand[]): boolean {
  return a.length === b.length && a.every((command, index) => command === b[index])
}

const menuKeymap = Prec.high(keymap.of([
  { key: 'ArrowDown', run: view => move(view, 1) },
  { key: 'ArrowUp', run: view => move(view, -1) },
  { key: 'Enter', run: (view) => {
    const menu = view.state.field(menuState)
    if (menu === null || menu.namingTag || isComposing(view)) return false
    if (menu.selected !== null) pick(view, menu.selected)
    return true
  } },
  { key: 'Escape', run: view => !isComposing(view) && dismissSlashMenu(view) },
]))

function menuTooltip(view: EditorView, t: (key: MessageKey) => string): TooltipView {
  const document = view.dom.ownerDocument
  const dom = document.createElement('div')
  // 筛选或切到标签名浮层时，CodeMirror 先建好新浮层、再移除旧的。编辑区里已经有菜单就是重建，不再播放打开动画。
  dom.className = view.dom.querySelector('.px-slash-menu') === null ? 'px-slash-menu px-slash-enter' : 'px-slash-menu'

  function text<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, content: string): HTMLElementTagNameMap[K] {
    const element = document.createElement(tag)
    element.className = className
    element.textContent = content
    return element
  }

  function icon(path: string): HTMLSpanElement {
    const tile = text('span', 'px-slash-icon', '')
    tile.setAttribute('aria-hidden', 'true')
    const svg = document.createElementNS(SVG_NS, 'svg')
    svg.setAttribute('class', 'px-icon')
    svg.setAttribute('viewBox', '0 0 16 16')
    svg.setAttribute('width', '16')
    svg.setAttribute('height', '16')
    svg.setAttribute('focusable', 'false')
    const shape = document.createElementNS(SVG_NS, 'path')
    shape.setAttribute('d', path)
    shape.setAttribute('fill', 'none')
    shape.setAttribute('stroke', 'currentColor')
    shape.setAttribute('stroke-width', '1.3')
    shape.setAttribute('stroke-linecap', 'round')
    shape.setAttribute('stroke-linejoin', 'round')
    svg.append(shape)
    tile.append(svg)
    return tile
  }

  function hint(keys: readonly string[], label: string): HTMLSpanElement {
    const element = document.createElement('span')
    for (const key of keys) element.append(text('kbd', 'px-slash-key', key))
    element.append(label)
    return element
  }

  let options = new Map<SlashCommand, HTMLButtonElement>()
  // 指针真的移动过才跟随悬停：菜单刚好弹在静止的指针下面时，不替用户预选，免得 Enter 插入没选过的命令。
  let pointer: { x: number; y: number } | null = null

  function renderList(menu: Menu): void {
    const list = document.createElement('div')
    list.className = 'px-slash-options'
    list.id = LIST_ID
    list.setAttribute('role', 'listbox')
    list.setAttribute('aria-label', t('slash.title'))
    options = new Map()
    for (const command of menu.matches) {
      const option = document.createElement('button')
      option.type = 'button'
      option.tabIndex = -1
      option.className = 'px-slash-option'
      option.id = OPTION_ID + command.alias
      option.setAttribute('role', 'option')
      option.setAttribute('aria-selected', String(menu.selected === command))
      option.append(icon(command.icon), text('span', 'px-slash-label', t(command.label)), text('kbd', 'px-slash-alias', command.alias))
      option.addEventListener('mousedown', (event) => { event.preventDefault() })
      option.addEventListener('mousemove', (event) => {
        const moved = pointer !== null && (pointer.x !== event.clientX || pointer.y !== event.clientY)
        pointer = { x: event.clientX, y: event.clientY }
        if (moved) hover(view, command)
      })
      option.addEventListener('click', () => { pick(view, command) })
      options.set(command, option)
      list.append(option)
    }
    const keys = document.createElement('div')
    keys.className = 'px-slash-keys'
    keys.append(hint(['↑', '↓'], t('slash.navigate')), hint(['↵'], t('slash.insert')), hint(['esc'], t('slash.close')))
    dom.replaceChildren(text('div', 'px-slash-header', t('slash.title')), list, keys)
  }

  function button(label: string, key: string, primary: boolean): HTMLButtonElement {
    const element = text('button', primary ? 'px-slash-button px-slash-button-primary' : 'px-slash-button', label)
    element.type = 'button'
    // 键帽只是提示，按钮的无障碍名称保持「取消」「插入」。
    const keycap = text('kbd', 'px-slash-key', key)
    keycap.setAttribute('aria-hidden', 'true')
    element.append(keycap)
    return element
  }

  function tagChip(open: string, name: string): HTMLSpanElement {
    const chip = text('span', 'px-md-tag', '')
    chip.append(text('span', 'px-md-tag-bracket', open), text('span', 'px-md-tag-name', name), text('span', 'px-md-tag-bracket', '>'))
    return chip
  }

  function renderTag(): void {
    const form = document.createElement('form')
    form.className = 'px-slash-form'
    const title = text('div', 'px-slash-form-title', '')
    title.append(icon(TAG_ICON), text('span', '', t('slash.tag')))
    // 整个输入框是 label：点两侧的尖括号也能把焦点放进输入框。
    const field = text('label', 'px-slash-field', '')
    const input = document.createElement('input')
    input.type = 'text'
    input.className = 'px-slash-input'
    input.id = 'px-slash-tag-name'
    input.placeholder = t('slash.tagHint')
    input.autocomplete = 'off'
    input.autocapitalize = 'off'
    input.spellcheck = false
    input.setAttribute('aria-label', t('slash.tagName'))
    input.setAttribute('aria-describedby', 'px-slash-tag-error')
    const open = text('span', '', '<')
    const close = text('span', '', '>')
    open.setAttribute('aria-hidden', 'true')
    close.setAttribute('aria-hidden', 'true')
    field.append(open, input, close)
    const preview = text('div', 'px-slash-preview', '')
    preview.setAttribute('aria-hidden', 'true')
    const error = text('div', 'px-slash-error', '')
    error.id = 'px-slash-tag-error'
    error.setAttribute('role', 'alert')
    error.hidden = true
    input.addEventListener('input', () => {
      input.removeAttribute('aria-invalid')
      error.hidden = true
      preview.hidden = false
      // 预览和编辑框里的标签块一个样子。名称还不合法时留空，确认时再报错。
      const name = input.value.trim()
      preview.replaceChildren(...(TAG_NAME.test(name) ? [tagChip('<', name), ' … ', tagChip('</', name)] : []))
    })
    const actions = text('div', 'px-slash-actions', '')
    const cancel = button(t('common.cancel'), 'esc', false)
    cancel.addEventListener('click', () => dismissSlashMenu(view))
    const submit = button(t('slash.insert'), '↵', true)
    let composing = false
    input.addEventListener('compositionstart', () => { composing = true })
    input.addEventListener('compositionend', () => { composing = false })
    function confirm(): void {
      const menu = view.state.field(menuState)
      if (menu === null || !menu.namingTag || composing || !isEditable(view.state)) return
      const name = input.value.trim()
      if (!TAG_NAME.test(name)) {
        input.setAttribute('aria-invalid', 'true')
        preview.hidden = true
        error.hidden = false
        error.textContent = t('slash.invalidTag')
        input.focus()
        return
      }
      const line = view.state.doc.lineAt(menu.to)
      const followedByText = menu.to < line.to
        || (line.number < view.state.doc.lines && view.state.doc.line(line.number + 1).text.trim() !== '')
      // 空行让 CommonMark 在标签内部和后续段落继续识别 Markdown。
      insert(view, menu, '<' + name + '>\n\n', '\n\n</' + name + '>' + (followedByText ? '\n' : ''))
    }
    form.addEventListener('submit', (event) => { event.preventDefault() })
    input.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' || isComposingKey(event) || composing) return
      event.preventDefault()
      confirm()
    })
    submit.addEventListener('click', confirm)
    actions.append(cancel, submit)
    form.append(title, field, preview, error, actions)
    dom.replaceChildren(form)
    queueMicrotask(() => { if (input.isConnected) input.focus() })
  }

  let shown: Menu | null = null
  function render(menu: Menu | null): void {
    if (shown === menu || menu === null) return
    if (menu.namingTag) {
      if (!shown?.namingTag) renderTag()
    } else if (shown !== null && !shown.namingTag && sameCommands(shown.matches, menu.matches)) {
      // 只换了选中项：原地改 aria-selected，不重建按钮，指针下面不会冒出新元素再触发悬停。
      for (const [command, option] of options) option.setAttribute('aria-selected', String(menu.selected === command))
    } else {
      renderList(menu)
    }
    shown = menu
  }
  render(view.state.field(menuState))
  return {
    dom,
    // 和当前行留一点间距，菜单不贴着正在输入的那一行。
    offset: { x: 0, y: 4 },
    update: (update) => { render(update.state.field(menuState)) },
    positioned() {
      // CodeMirror 会根据光标两边的空间限制浮层高度。方向键只滚动菜单本身。
      if (dom.scrollHeight <= dom.clientHeight) return
      const active = dom.querySelector('[aria-selected="true"]')
      if (active === null) return
      const top = dom.getBoundingClientRect().top + dom.clientTop
      const bottom = top + dom.clientHeight
      const row = active.getBoundingClientRect()
      if (row.top < top) dom.scrollTop += row.top - top
      else if (row.bottom > bottom) dom.scrollTop += row.bottom - bottom
    },
  }
}

export function slashMenu(getLocale: () => Locale): Extension {
  // CodeMirror 会缓存同一 TooltipView 的完整高度。筛选改变行数时重新测量，方向键移动时复用。
  const createByRowCount = Array.from({ length: COMMANDS.length + 1 }, () =>
    (view: EditorView) => menuTooltip(view, key => translate(getLocale(), key)))
  return [
    menuState,
    compositionPlugin,
    menuKeymap,
    tooltips({
      tooltipSpace(view) {
        const rect = view.scrollDOM.getBoundingClientRect()
        const viewport = view.dom.ownerDocument.defaultView
        return {
          top: Math.max(0, rect.top),
          bottom: Math.min(viewport?.innerHeight ?? rect.bottom, rect.bottom),
          left: Math.max(0, rect.left),
          right: Math.min(viewport?.innerWidth ?? rect.right, rect.right),
        }
      },
    }),
    showTooltip.compute([menuState], (state) => {
      const menu = state.field(menuState)
      if (menu === null) return null
      const create = createByRowCount[menu.namingTag ? 0 : menu.matches.length]
      return create === undefined ? null : { pos: menu.from, create }
    }),
    EditorView.contentAttributes.compute([menuState], (state) => {
      const menu = state.field(menuState)
      if (menu === null || menu.namingTag) return {}
      return menu.selected === null
        ? { 'aria-controls': LIST_ID }
        : { 'aria-controls': LIST_ID, 'aria-activedescendant': OPTION_ID + menu.selected.alias }
    }),
  ]
}
