// 编辑区的按键绑定（需求 E-01、E-05、E-06，技术方案 5.5）：Enter 续行、Shift+Enter 普通换行、Tab / Shift+Tab 缩进，
// 撤销重做，以及 CodeMirror 的默认编辑键。规则本身在 commands.ts，这里只负责把结果作为一个事务派发。

import { EditorSelection } from '@codemirror/state'
import { EditorView, keymap, type Command, type KeyBinding } from '@codemirror/view'
import { defaultKeymap, isolateHistory, redo, undo } from '@codemirror/commands'
import type { Extension } from '@codemirror/state'
import { isComposingKey } from '../appearance.ts'
import { continueList, indent, outdent, type EditResult } from './commands.ts'

/**
 * 最近一次 keydown 是不是输入法组字中的按键。CodeMirror 只在组字已经产生改动后才忽略按键，
 * 组字刚开始的那一下（Chromium 报 keyCode 229）和 Safari 先报 compositionend 再报 Enter 的情况还会跑到按键绑定里，
 * 所以由事件观察者先记下来，命令里再判断一次。
 */
const composingKey = new WeakMap<EditorView, boolean>()

const composingObserver = EditorView.domEventObservers({
  keydown(event, view) {
    composingKey.set(view, isComposingKey(event))
  },
})

/** 组字期间所有自动行为（续行、缩进）都不触发（E-01），按键交还给输入法。 */
export function isComposing(view: EditorView): boolean {
  return view.composing || view.compositionStarted || composingKey.get(view) === true
}

function dispatchEdit(view: EditorView, result: EditResult): void {
  view.dispatch({
    changes: result.changes,
    selection: EditorSelection.single(result.selection.anchor, result.selection.head),
    userEvent: 'input',
    scrollIntoView: true,
    // 和前后连续打的字都分开：按一次撤销正好回到按键之前，之后打的字也不会和这一步合并（E-05、E-06）。
    annotations: isolateHistory.of('full'),
  })
}

function mainSelection(view: EditorView): { from: number; to: number } {
  const { anchor, head } = view.state.selection.main
  return { from: anchor, to: head }
}

/** 普通换行：只插入一个换行，不带缩进和列表符号。 */
export const insertPlainNewline: Command = (view) => {
  if (isComposing(view) || view.state.readOnly) return false
  view.dispatch(view.state.replaceSelection('\n'), {
    userEvent: 'input',
    scrollIntoView: true,
    annotations: isolateHistory.of('full'),
  })
  return true
}

/** Enter：在列表项行尾续行或结束列表（E-05），其余情况普通换行。任何情况下都不发送、不提交。 */
export const enterCommand: Command = (view) => {
  if (isComposing(view) || view.state.readOnly) return false
  const result = continueList(view.state.doc.toString(), mainSelection(view))
  if (result === null) return insertPlainNewline(view)
  dispatchEdit(view, result)
  return true
}

/** Tab：缩进（E-06）。焦点不离开编辑区。 */
export const indentCommand: Command = (view) => {
  if (isComposing(view)) return false
  // 只读（草稿载入中）时也吞掉 Tab，否则浏览器会把焦点移出编辑区。
  if (view.state.readOnly) return true
  dispatchEdit(view, indent(view.state.doc.toString(), mainSelection(view)))
  return true
}

/** Shift+Tab：反缩进（E-06）。没有可去的缩进时什么都不改，但仍然吞掉按键，焦点留在编辑区。 */
export const outdentCommand: Command = (view) => {
  if (isComposing(view)) return false
  if (view.state.readOnly) return true
  const result = outdent(view.state.doc.toString(), mainSelection(view))
  if (result !== null) dispatchEdit(view, result)
  return true
}

/**
 * 不用 CodeMirror 默认按键表里的这些键：Enter 由上面的命令处理（默认的 Enter 会带上缩进）；
 * Mod-Enter 是「复制并隐藏」，Escape 是隐藏小窗，都在窗口级处理；Mod-[ / Mod-] 默认按 2 个空格缩进，换成和 Tab 相同。
 */
const OVERRIDDEN_KEYS = new Set(['Enter', 'Mod-Enter', 'Escape', 'Mod-[', 'Mod-]'])

export function editorKeymap(platform: string): Extension {
  const own: KeyBinding[] = [
    { key: 'Enter', run: enterCommand },
    { key: 'Shift-Enter', run: insertPlainNewline },
    { key: 'Tab', run: indentCommand, shift: outdentCommand },
    // ⌘] / ⌘[ 是 P1 的写法（E-06），行为与 Tab、Shift+Tab 相同。
    { key: 'Mod-]', run: indentCommand },
    { key: 'Mod-[', run: outdentCommand },
    { key: 'Mod-z', run: undo, preventDefault: true },
    { key: 'Mod-Shift-z', run: redo, preventDefault: true },
  ]
  // Windows、Linux 上另支持 Ctrl+Y 重做（E-01）；macOS 上 ⌃Y 不是重做。
  if (platform !== 'darwin') own.push({ key: 'Ctrl-y', run: redo, preventDefault: true })
  const defaults = defaultKeymap.filter(binding => binding.key === undefined || !OVERRIDDEN_KEYS.has(binding.key))
  return [composingObserver, keymap.of([...own, ...defaults])]
}

/**
 * 粘贴只取纯文本（E-01）。CodeMirror 自己也读 text/plain，这里显式接管是为了只读时（草稿载入中）连粘贴一起拦下，
 * 以及剪贴板里只有图片或 HTML 时什么都不插入。
 */
export const plainTextPaste = EditorView.domEventHandlers({
  paste(event, view) {
    if (view.state.readOnly) return true
    const text = event.clipboardData?.getData('text/plain') ?? ''
    if (text !== '') {
      view.dispatch(view.state.replaceSelection(text), { userEvent: 'input.paste', scrollIntoView: true })
    }
    return true
  },
})
