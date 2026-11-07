// 两种「等一个回应」的小工具：按序号等渲染进程的回应（e2eDone），按名字等窗口事件（show、hide、focus）。
// 都带超时，dispose 时把还在等的一律结束，退出时不留悬空的计时器。

/** 按序号等一次回应。超时、dispose 时得到 null。 */
export class ReplyWaiters<T> {
  readonly #pending = new Map<number, { resolve: (value: T | null) => void; timer: ReturnType<typeof setTimeout> }>()
  #nextId = 1

  nextId(): number {
    return this.#nextId++
  }

  /** 先 wait 再把请求发出去：回应可能在同一轮事件循环里就到。 */
  wait(id: number, timeoutMs: number): Promise<T | null> {
    return new Promise<T | null>((resolve) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id)
        resolve(null)
      }, timeoutMs)
      this.#pending.set(id, { resolve, timer })
    })
  }

  /** 序号不认识（已超时、伪造）时返回 false。 */
  resolve(id: number, value: T): boolean {
    const pending = this.#pending.get(id)
    if (pending === undefined) return false
    this.#pending.delete(id)
    clearTimeout(pending.timer)
    pending.resolve(value)
    return true
  }

  dispose(): void {
    for (const [id, pending] of this.#pending) {
      clearTimeout(pending.timer)
      this.#pending.delete(id)
      pending.resolve(null)
    }
  }
}

/** 等某个具名事件下一次发生：发生时得到 true，超时、dispose 时得到 false。 */
export class EventWaiters<E extends string> {
  readonly #waiters = new Map<E, Set<(happened: boolean) => void>>()

  wait(event: E, timeoutMs: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      let set = this.#waiters.get(event)
      if (set === undefined) {
        set = new Set()
        this.#waiters.set(event, set)
      }
      const waiters = set
      const timer = setTimeout(() => {
        waiters.delete(finish)
        resolve(false)
      }, timeoutMs)
      function finish(happened: boolean): void {
        clearTimeout(timer)
        resolve(happened)
      }
      waiters.add(finish)
    })
  }

  emit(event: E): void {
    const set = this.#waiters.get(event)
    if (set === undefined) return
    this.#waiters.delete(event)
    for (const finish of set) finish(true)
  }

  dispose(): void {
    for (const set of this.#waiters.values()) {
      for (const finish of set) finish(false)
    }
    this.#waiters.clear()
  }
}
