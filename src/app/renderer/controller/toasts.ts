// 底栏中间的操作提示（需求 E-03，技术方案 5.5）：成功类约 2 秒后消失；错误类一直显示，
// 直到下一次操作或用户关掉。新提示总是替换旧提示。

import type { AppState, Toast } from '../state/state.ts'
import type { Store } from '../state/store.ts'

export const SUCCESS_TOAST_MS = 2000

export class Toasts {
  private seq = 0
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly store: Store<AppState>) {}

  success(text: string): void {
    this.show('success', text)
  }

  error(text: string): void {
    this.show('error', text)
  }

  /** 用户发起了一次新操作：错误提示到此为止。成功提示照常等它自己消失。 */
  beginAction(): void {
    if (this.store.getState().toast?.kind === 'error') this.clear()
  }

  dismiss(id: number): void {
    if (this.store.getState().toast?.id === id) this.clear()
  }

  dispose(): void {
    this.cancelTimer()
  }

  private show(kind: Toast['kind'], text: string): void {
    this.cancelTimer()
    const toast: Toast = { id: ++this.seq, kind, text }
    this.store.update(state => ({ ...state, toast }))
    if (kind === 'success') {
      this.timer = setTimeout(() => {
        this.timer = null
        this.dismiss(toast.id)
      }, SUCCESS_TOAST_MS)
    }
  }

  private clear(): void {
    this.cancelTimer()
    this.store.update(state => (state.toast === null ? state : { ...state, toast: null }))
  }

  private cancelTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
  }
}
