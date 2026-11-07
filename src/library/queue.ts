// 库的修改操作串行执行（design-spec 6.1、D24，审查意见 S05）。保存、改元数据、删除、恢复按库根目录排队，
// 每个操作的「读取 → 核对 → 写入」在自己的队列位置里完成：否则收藏读到旧版本、保存写入新版本、
// 收藏再把带旧正文的内容写回去，用户看到「已保存」的修改被静默撤销。

export class KeyedQueue {
  readonly #tails = new Map<string, Promise<void>>()

  /** 等同一个 key 前面的操作都结束（无论成败）后执行 operation。 */
  run<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#tails.get(key) ?? Promise.resolve()
    let release = (): void => undefined
    const done = new Promise<void>((resolve) => {
      release = resolve
    })
    this.#tails.set(key, done)
    return (async () => {
      // previous 是只会兑现、不会拒绝的 done，等它不会抛错
      await previous
      try {
        return await operation()
      } finally {
        release()
        if (this.#tails.get(key) === done) this.#tails.delete(key)
      }
    })()
  }

  /** 正在排队或执行的 key 的个数（测试用）。 */
  get size(): number {
    return this.#tails.size
  }
}
