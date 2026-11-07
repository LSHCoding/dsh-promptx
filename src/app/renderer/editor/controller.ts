// 编辑区（CodeMirror 6）的控制接口。界面逻辑只经过这个接口读写编辑区，不直接碰 EditorView：
// 界面挂载前（以及单测里）编辑区只是一个 EditorState，挂载后由 EditorView 持有同一个状态，读写方式不变。

import { Compartment, EditorSelection, EditorState, type Extension, type StateCommand, type Transaction, type TransactionSpec } from '@codemirror/state'
import { EditorView, drawSelection, placeholder } from '@codemirror/view'
import { history, isolateHistory } from '@codemirror/commands'
import type { TextSelection } from '../../../shared/types.ts'
import type { EditResult } from './commands.ts'
import { editorKeymap, plainTextPaste } from './keymap.ts'

export interface EditorUpdate {
  docChanged: boolean
  selectionSet: boolean
}

export interface EditorController {
  readonly mounted: boolean
  getText(): string
  getSelection(): TextSelection
  /**
   * 整篇替换并清空撤销记录：载入草稿、在编辑器中打开、重新载入磁盘版本（E-01，技术方案 5.5）。
   * 选区按文档长度收紧；为 null 时光标放在文末（第一次使用时光标在文末，F-01）。
   */
  load(text: string, selection: TextSelection | null): void
  /** 一步可以撤销的整篇替换：清空、应用候选。 */
  replaceAll(text: string): void
  /** 一步可以撤销的编辑：插入到光标。 */
  apply(result: EditResult): void
  dispatch(spec: TransactionSpec): void
  /** 对当前状态执行一个 CodeMirror 命令（撤销、重做等）。 */
  runCommand(command: StateCommand): boolean
  setEditable(editable: boolean): void
  /** 跟随界面语言更新占位文字和无障碍名称。 */
  setLabels(labels: { placeholder: string; ariaLabel: string }): void
  focus(): void
  hasFocus(): boolean
  /** 内容或选区变了：用户输入和程序修改都会通知；整篇替换（load）也会通知。 */
  onUpdate(listener: (update: EditorUpdate) => void): () => void
  mount(parent: HTMLElement): void
  unmount(): void
  /** 挂载后的 EditorView（端到端计时用）；没挂载时为 null。 */
  readonly view: EditorView | null
}

export interface EditorOptions {
  platform: string
  placeholder: string
  ariaLabel: string
}

function clampSelection(selection: TextSelection | null, length: number): EditorSelection {
  if (selection === null) return EditorSelection.single(length)
  const clamp = (pos: number) => Math.min(Math.max(0, pos), length)
  return EditorSelection.single(clamp(selection.anchor), clamp(selection.head))
}

function editableExtension(editable: boolean): Extension {
  return [EditorView.editable.of(editable), EditorState.readOnly.of(!editable)]
}

function labelExtension(labels: { placeholder: string; ariaLabel: string }): Extension {
  return [placeholder(labels.placeholder), EditorView.contentAttributes.of({ 'aria-label': labels.ariaLabel })]
}

/** 让光标所在的位置出现在可见范围里：载入长草稿后视图停在开头，光标却在文末，用户看不到自己在哪。 */
function revealCursor(view: EditorView): void {
  view.dispatch({ effects: EditorView.scrollIntoView(view.state.selection.main.head, { y: 'center' }) })
}

export function createEditorController(options: EditorOptions): EditorController {
  const editableSlot = new Compartment()
  const labelSlot = new Compartment()
  // Markdown 高亮是 P1（E-07）。先留一个空的位置，以后在这里 reconfigure，不用改动其他扩展的顺序（技术方案 5.5）。
  const highlightSlot = new Compartment()
  const listeners = new Set<(update: EditorUpdate) => void>()
  let editable = false
  let labels = { placeholder: options.placeholder, ariaLabel: options.ariaLabel }
  let view: EditorView | null = null

  function notify(update: EditorUpdate): void {
    for (const listener of [...listeners]) listener(update)
  }

  // 每次新建 EditorState 都用当前的可编辑状态和文案重新组装，整篇替换后这两项不会回到默认值。
  function extensions(): Extension[] {
    return [
      history(),
      drawSelection(),
      EditorView.lineWrapping,
      EditorState.tabSize.of(4),
      labelSlot.of(labelExtension(labels)),
      editableSlot.of(editableExtension(editable)),
      highlightSlot.of([]),
      editorKeymap(options.platform),
      plainTextPaste,
      EditorView.contentAttributes.of({ spellcheck: 'false', autocorrect: 'off', autocapitalize: 'off' }),
      EditorView.updateListener.of((update) => {
        if (update.docChanged || update.selectionSet) notify({ docChanged: update.docChanged, selectionSet: update.selectionSet })
      }),
    ]
  }

  let state = EditorState.create({ doc: '', extensions: extensions() })

  function current(): EditorState {
    return view === null ? state : view.state
  }

  /** 没挂载时自己推进状态并通知；挂载后交给 EditorView，由 updateListener 通知。 */
  function dispatchTransaction(tr: Transaction): void {
    if (view !== null) {
      view.dispatch(tr)
      return
    }
    state = tr.state
    if (tr.docChanged || tr.selection !== undefined) notify({ docChanged: tr.docChanged, selectionSet: tr.selection !== undefined })
  }

  return {
    get mounted() {
      return view !== null
    },
    get view() {
      return view
    },
    getText: () => current().doc.toString(),
    getSelection() {
      const { anchor, head } = current().selection.main
      return { anchor, head }
    },
    load(text, selection) {
      const next = EditorState.create({ doc: text, selection: clampSelection(selection, text.length), extensions: extensions() })
      if (view === null) {
        state = next
      } else {
        view.setState(next)
        revealCursor(view)
      }
      // setState 不经过 updateListener，手动通知一次。
      notify({ docChanged: true, selectionSet: true })
    },
    replaceAll(text) {
      const doc = current().doc
      dispatchTransaction(current().update({
        changes: { from: 0, to: doc.length, insert: text },
        selection: EditorSelection.single(text.length),
        userEvent: 'input',
        scrollIntoView: true,
        // 和前后的输入都分开，一次撤销正好回到操作之前（E-01）。
        annotations: isolateHistory.of('full'),
      }))
    },
    apply(result) {
      dispatchTransaction(current().update({
        changes: result.changes,
        selection: EditorSelection.single(result.selection.anchor, result.selection.head),
        userEvent: 'input',
        scrollIntoView: true,
        annotations: isolateHistory.of('full'),
      }))
    },
    dispatch(spec) {
      dispatchTransaction(current().update(spec))
    },
    runCommand(command) {
      return command({ state: current(), dispatch: dispatchTransaction })
    },
    setEditable(next) {
      if (editable === next) return
      editable = next
      dispatchTransaction(current().update({ effects: editableSlot.reconfigure(editableExtension(next)) }))
    },
    setLabels(next) {
      if (next.placeholder === labels.placeholder && next.ariaLabel === labels.ariaLabel) return
      labels = next
      dispatchTransaction(current().update({ effects: labelSlot.reconfigure(labelExtension(next)) }))
    },
    focus() {
      view?.focus()
    },
    hasFocus: () => view?.hasFocus ?? false,
    onUpdate(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    mount(parent) {
      if (view !== null) return
      view = new EditorView({ state, parent })
      // 挂载前就载入好的草稿（光标可能在文末）同样滚到光标处。
      revealCursor(view)
    },
    unmount() {
      if (view === null) return
      state = view.state
      view.destroy()
      view = null
    },
  }
}
