// 中文输入法落字后的 Markdown 转换（E-12）。只接管单字符输入；粘贴、载入和撤销不经过输入处理器。

import { EditorSelection, type Extension, type Text, type Transaction } from '@codemirror/state'
import { isolateHistory } from '@codemirror/commands'
import { EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view'

export interface InputConversions {
  middleDot: boolean
  yen: boolean
}

interface PendingInput {
  doc: Text
  caret: number
  text: string
}

interface Conversion {
  from: number
  insert: string
  caret: number
}

function enabled(text: string, options: InputConversions): boolean {
  return (text === '·' && options.middleDot) || ((text === '¥' || text === '￥') && options.yen)
}

/** 只看光标左侧最多四个 UTF-16 单元，长草稿输入时不用扫描或复制全文。 */
function conversion(doc: Text, caret: number, text: string): Conversion | null {
  const prefix = doc.sliceString(Math.max(0, caret - 4), caret)
  const symbol = text === '·' ? '`' : '$'
  if (prefix.endsWith(symbol.repeat(2) + text) && !prefix.endsWith(symbol.repeat(3) + text)) {
    const from = caret - 3
    return text === '·'
      ? { from, insert: '```\n\n\n```', caret: from + 4 }
      : { from, insert: '$$\n\n$$', caret: from + 3 }
  }
  if ((text === '·' && prefix.endsWith('··')) || (text !== '·' && /[¥￥]{2}$/.test(prefix))) {
    return { from: caret - 2, insert: symbol.repeat(2), caret }
  }
  return null
}

export function inputConversions(options: () => InputConversions): Extension {
  const plugin = ViewPlugin.fromClass(class {
    pending: PendingInput | null = null
    timer: ReturnType<typeof setTimeout> | null = null

    constructor(readonly view: EditorView) {}

    update(update: ViewUpdate): void {
      if (this.pending !== null && (update.state.doc !== this.pending.doc ||
        update.state.selection.main.head !== this.pending.caret || !update.state.selection.main.empty)) {
        this.pending = null
      }
    }

    cancel(): void {
      if (this.timer !== null) clearTimeout(this.timer)
      this.timer = null
      this.pending = null
    }

    finish(text: string): void {
      if (this.timer !== null) clearTimeout(this.timer)
      // Chromium 可以先提交文档再报 compositionend，也可以先报结束再由微任务刷新 DOM。
      // 等一轮任务，让 CodeMirror 自己结束组字；组字期间绝不替换它管理的 DOM。
      this.timer = setTimeout(() => {
        this.timer = null
        const pending = this.pending
        this.pending = null
        if (pending !== null && pending.text === text) this.convert(pending)
      }, 0)
    }

    convert(input: PendingInput): void {
      const { view } = this
      const selection = view.state.selection.main
      if (view.compositionStarted || view.state.readOnly || !view.state.facet(EditorView.editable) ||
        !enabled(input.text, options()) || view.state.doc !== input.doc || !selection.empty || selection.head !== input.caret) return
      const edit = conversion(input.doc, input.caret, input.text)
      if (edit === null) return
      view.dispatch({
        changes: { from: edit.from, to: input.caret, insert: edit.insert },
        selection: EditorSelection.single(edit.caret),
        userEvent: 'input',
        scrollIntoView: true,
        // 撤销先回到刚落下的字面输入，重做也不会再次进入输入处理器。
        annotations: isolateHistory.of('full'),
      })
      // CodeMirror 的内容重做默认把光标映射到替换末尾；记录当前选区，重做代码块时仍回到块内。
      view.dispatch({ selection: view.state.selection, userEvent: 'select' })
    }

    input(from: number, text: string, insert: () => Transaction): boolean {
      const { view } = this
      if (view.state.readOnly || !view.state.facet(EditorView.editable) ||
        !enabled(text, options()) || view.state.selection.ranges.length !== 1) {
        this.pending = null
        return false
      }
      const transaction = insert()
      const selection = transaction.newSelection.main
      if (!selection.empty || selection.head !== from + 1) {
        this.pending = null
        return false
      }
      const input = { doc: transaction.newDoc, caret: selection.head, text }
      if (view.compositionStarted) {
        this.pending = input
        return false
      }
      this.pending = null
      if (conversion(input.doc, input.caret, text) === null) return false
      view.dispatch(transaction)
      this.convert(input)
      return true
    }

    destroy(): void {
      this.cancel()
    }
  }, {
    eventObservers: {
      compositionstart() {
        this.cancel()
      },
      compositionend(event) {
        this.finish(event.data)
      },
    },
  })

  return [
    plugin,
    EditorView.inputHandler.of((view, from, _to, text, insert) => view.plugin(plugin)?.input(from, text, insert) ?? false),
  ]
}
