// 渲染进程崩溃和卡死的处理（design-spec 5.4，审查 S14）。Host 的心跳只能证明主进程活着：
// 渲染进程崩了（大段粘贴导致内存不足、GPU 进程出错），主进程照样回 ping，小窗却是一片空白，
// 所以由主进程自己处理：
// - render-process-gone 且原因不是 clean-exit：重新加载界面，草稿重新读回之前编辑区不可编辑；
// - 30 秒内第二次崩溃，或界面 unresponsive 超过 10 秒：以非零退出码退出，交给 Host 的重启策略（30 秒内 3 次失败就停）。

export type GoneDecision = 'ignore' | 'reload' | 'fatal'

export type FatalReason = 'second-crash' | 'unresponsive'

export interface RendererHealthOptions {
  onFatal: (reason: FatalReason) => void
  now?: () => number
  crashWindowMs?: number
  unresponsiveLimitMs?: number
}

export const RENDERER_CRASH_WINDOW_MS = 30_000
export const RENDERER_UNRESPONSIVE_LIMIT_MS = 10_000

/** 退出码：渲染进程反复崩溃或卡死。Host 据此报「小窗界面崩溃」，再按重启策略处理。值在协议里定义，两端共用。 */
export { RENDERER_FATAL_EXIT_CODE } from '../../shared/protocol.ts'

export class RendererHealth {
  readonly #onFatal: (reason: FatalReason) => void
  readonly #now: () => number
  readonly #crashWindowMs: number
  readonly #unresponsiveLimitMs: number
  #lastCrashAt: number | null = null
  #unresponsiveTimer: ReturnType<typeof setTimeout> | null = null
  #fatal = false
  #healthy = true

  constructor(options: RendererHealthOptions) {
    this.#onFatal = options.onFatal
    this.#now = options.now ?? (() => performance.now())
    this.#crashWindowMs = options.crashWindowMs ?? RENDERER_CRASH_WINDOW_MS
    this.#unresponsiveLimitMs = options.unresponsiveLimitMs ?? RENDERER_UNRESPONSIVE_LIMIT_MS
  }

  /** 界面正常（没有在崩溃后重载中、也没有卡死）。菜单栏图标据此显示出错状态。 */
  get healthy(): boolean {
    return this.#healthy && !this.#fatal
  }

  /** render-process-gone。返回 reload 时调用方重新加载界面；fatal 时 onFatal 已经调用过。 */
  gone(reason: string): GoneDecision {
    if (this.#fatal) return 'fatal'
    // clean-exit：渲染进程正常结束（窗口在销毁），不是崩溃。
    if (reason === 'clean-exit') return 'ignore'
    this.#clearUnresponsive()
    const now = this.#now()
    if (this.#lastCrashAt !== null && now - this.#lastCrashAt <= this.#crashWindowMs) {
      this.#fail('second-crash')
      return 'fatal'
    }
    this.#lastCrashAt = now
    this.#healthy = false
    return 'reload'
  }

  /** 界面重新报告就绪（ready）。 */
  recovered(): void {
    this.#healthy = true
  }

  unresponsive(): void {
    if (this.#fatal || this.#unresponsiveTimer !== null) return
    this.#unresponsiveTimer = setTimeout(() => {
      this.#unresponsiveTimer = null
      this.#fail('unresponsive')
    }, this.#unresponsiveLimitMs)
  }

  responsive(): void {
    this.#clearUnresponsive()
  }

  dispose(): void {
    this.#clearUnresponsive()
  }

  #fail(reason: FatalReason): void {
    if (this.#fatal) return
    this.#fatal = true
    this.#onFatal(reason)
  }

  #clearUnresponsive(): void {
    if (this.#unresponsiveTimer !== null) clearTimeout(this.#unresponsiveTimer)
    this.#unresponsiveTimer = null
  }
}
