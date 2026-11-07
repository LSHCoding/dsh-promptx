// 退出前让渲染进程把草稿写回 Host（审查 S07；design-spec 5.2「停止」、5.4「before-quit」）。
//
// 主进程发 flush 事件（带序号），渲染进程立即发出 draft.save，写完后调用 flushed(序号)。
// 渲染进程保存的总是当时的最新内容，所以收到序号 N 的回应时，所有不大于 N 的请求都算完成。
// 每个请求都有上限（shutdown 时 1.5 秒，Host 最多等 2 秒回复）：渲染进程卡住、Host 已经断开时不能把退出拖住。

export type FlushResult = 'flushed' | 'timeout' | 'skipped'

export interface FlushCoordinatorOptions {
  /** 把 flush 事件发给渲染进程。渲染进程还没就绪（草稿没读回，本来也不会保存）时返回 false，这次 flush 直接跳过。 */
  send: (id: number) => boolean
}

interface PendingFlush {
  id: number
  resolve: (result: FlushResult) => void
  timer: ReturnType<typeof setTimeout>
}

export class FlushCoordinator {
  readonly #send: (id: number) => boolean
  readonly #pending: PendingFlush[] = []
  #nextId = 1

  constructor(options: FlushCoordinatorOptions) {
    this.#send = options.send
  }

  flush(timeoutMs: number): Promise<FlushResult> {
    const id = this.#nextId++
    let sent = false
    try {
      sent = this.#send(id)
    } catch {
      sent = false
    }
    if (!sent) return Promise.resolve('skipped')
    return new Promise<FlushResult>((resolve) => {
      const timer = setTimeout(() => {
        this.#remove(id)
        resolve('timeout')
      }, timeoutMs)
      this.#pending.push({ id, resolve, timer })
    })
  }

  /** 渲染进程的回应。序号不认识（已超时、伪造）时忽略。 */
  flushed(id: number): void {
    for (const pending of [...this.#pending]) {
      if (pending.id > id) continue
      clearTimeout(pending.timer)
      this.#remove(pending.id)
      pending.resolve('flushed')
    }
  }

  /** 还在等的请求全部按跳过结束。 */
  dispose(): void {
    for (const pending of this.#pending.splice(0)) {
      clearTimeout(pending.timer)
      pending.resolve('skipped')
    }
  }

  #remove(id: number): void {
    const index = this.#pending.findIndex(pending => pending.id === id)
    if (index !== -1) this.#pending.splice(index, 1)
  }
}
