// 对话框（需求 5.8，技术方案 5.5）：同一时间只显示一个，后来的排队。

import type { AppState, DialogResult, DialogSpec } from '../state/state.ts'
import type { Store } from '../state/store.ts'

interface Pending {
  id: number
  spec: DialogSpec
  resolve: (result: DialogResult) => void
}

export class Dialogs {
  private seq = 0
  private current: Pending | null = null
  private readonly queue: Pending[] = []

  constructor(private readonly store: Store<AppState>) {}

  open(spec: DialogSpec): Promise<DialogResult> {
    return new Promise((resolve) => {
      this.queue.push({ id: ++this.seq, spec, resolve })
      if (this.current === null) this.showNext()
    })
  }

  isOpen(): boolean {
    return this.current !== null
  }

  /** 用户点了某个按钮（或按 Esc，等于 escapeButton）。id 对不上当前对话框时忽略，防止重复点击。 */
  resolve(id: number, result: DialogResult): void {
    const pending = this.current
    if (pending?.id !== id) return
    this.current = null
    this.store.update(state => ({ ...state, dialog: null }))
    pending.resolve(result)
    this.showNext()
  }

  /** Esc：等于对话框指定的按钮（O-04 是「保持当前内容」，其余是「取消」）。 */
  escape(): void {
    const pending = this.current
    if (pending !== null) this.resolve(pending.id, { button: pending.spec.escapeButton })
  }

  /** 卸载时把还开着的对话框都按 Esc 处理，等待它们的流程能走完。 */
  dispose(): void {
    while (this.current !== null) this.escape()
  }

  private showNext(): void {
    const next = this.queue.shift()
    if (next === undefined) return
    this.current = next
    this.store.update(state => ({ ...state, dialog: { ...next.spec, id: next.id }, menu: null }))
  }
}
