// 焦点在哪里：几条规则要按焦点所在的区域决定怎么做（L-02 的 ⌘L、O-05 一轮结束时的焦点）。
// 界面逻辑在单测里也会跑在没有 DOM 的环境，所以先判断 document 在不在。

/** 焦点在库侧栏或会话栏里（这两块区域的根元素带 data-pane）。 */
export function focusWithin(pane: 'library' | 'session'): boolean {
  if (typeof document === 'undefined') return false
  const active = document.activeElement
  return active instanceof Element && active.closest(`[data-pane="${pane}"]`) !== null
}

/**
 * 小窗里没有哪个元素拿着焦点（焦点落在 body 上，例如刚关掉的对话框、刚收起的侧栏里的按钮）。
 * 不看 document.hasFocus()：用户切到别的应用时小窗仍然显示，页面里的焦点还停在编辑区，
 * 这时一轮优化结束不能把焦点挪去追加输入框，否则用户回来接着打字会打到别处（O-05）。
 */
export function nothingFocused(): boolean {
  if (typeof document === 'undefined') return true
  const active = document.activeElement
  return active === null || active === document.body
}
