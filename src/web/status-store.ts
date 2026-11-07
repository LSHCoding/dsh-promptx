// 配置页长轮询用的状态仓库（design-spec 4.3、4.8）。Host 各处把状态片段 patch 进来，有变化时序号加一，
// 唤醒所有在等的长轮询；还记下「打开配置页」请求和在线的 dsh 页面，供 host.openSettings 判断怎么把页面带到前台。
//
// 序号的起点取当前的毫秒时间，而不是从 1 开始：dsh 重启后页面不刷新，长轮询带着上一个 Host 实例的序号继续来问，
// 从 1 重新数的话，新序号会比页面手里的小，页面要么白等一个超时，要么把新的「打开配置页」请求当成处理过的旧请求。
// 以毫秒时间为起点，新实例的序号几乎总比旧实例大；时钟回拨这类极端情况下，序号不相等也会立即返回（见 waitForChange）。

import type { PanelStatus } from '../shared/types.ts'

/** 仓库保存的状态片段：PanelStatus 去掉由仓库自己维护的 seq 和 navigate。 */
export type StatusPieces = Omit<PanelStatus, 'seq' | 'navigate'>

/**
 * patch 的参数：出现的键才更新。companionPid 是可选字段，显式传 undefined 表示清掉（小程序退出后）；
 * 其他字段传 undefined 视为没有出现。
 */
export type StatusPatch = Partial<Omit<StatusPieces, 'companionPid'>> & { companionPid?: number | undefined }

export interface StatusStoreOptions {
  /** 毫秒时钟，测试时替换。 */
  now?: (() => number) | undefined
  /**
   * 页面最后一次轮询或上报之后，多久之内仍算在线（用于挑选「打开配置页」的目标页面）。
   * 默认 40 秒：长轮询 25 秒返回一次，留出页面重新发起请求的余量。
   */
  onlineWindowMs?: number | undefined
}

/** 长轮询默认等待时长（design-spec 4.3）。 */
export const DEFAULT_POLL_TIMEOUT_MS = 25_000

/** 「打开配置页」请求的有效期：页面看到 ageMs 小于它才切页（design-spec 4.4、4.8）。 */
export const NAVIGATE_TTL_MS = 60_000

const DEFAULT_ONLINE_WINDOW_MS = 40_000

/** 很久没出现的页面记录要清掉，避免一直打开的 dsh 里积累上千条。 */
const CLIENT_FORGET_MS = 10 * 60_000
const MAX_CLIENTS = 64

interface ClientRecord {
  /** 最近一次上报的页面可见性。 */
  visible: boolean
  /** 最近一次上报「可见」的时间，挑选目标页面时取最大者；从没上报过可见时为负无穷。 */
  visibleAt: number
  /** 最近一次轮询结束或上报的时间。 */
  seenAt: number
  /** 正在等待中的长轮询个数。 */
  polling: number
}

interface NavigateRecord {
  seq: number
  at: number
  /** 只让这个页面切换；null 表示所有在线页面都切（没有可见页面时）。 */
  target: string | null
}

interface Waiter {
  settle: () => void
}

export class StatusStore {
  readonly #now: () => number
  readonly #onlineWindowMs: number
  #pieces: StatusPieces
  #seq: number
  #navigate: NavigateRecord | null = null
  readonly #waiters = new Set<Waiter>()
  readonly #clients = new Map<string, ClientRecord>()
  /** 没带 clientId 的长轮询：只用来判断「有没有页面在线」。 */
  #anonymousPolling = 0
  #anonymousSeenAt = Number.NEGATIVE_INFINITY
  #closed = false

  constructor(initial: StatusPieces, options: StatusStoreOptions = {}) {
    this.#now = options.now ?? Date.now
    this.#onlineWindowMs = options.onlineWindowMs ?? DEFAULT_ONLINE_WINDOW_MS
    this.#pieces = structuredClone(initial)
    this.#seq = Math.max(1, Math.trunc(this.#now()))
  }

  /** 当前序号。 */
  get seq(): number {
    return this.#seq
  }

  /** 更新状态片段。内容真的变了才加序号、唤醒长轮询；返回是否有变化。 */
  patch(partial: StatusPatch): boolean {
    let changed = false
    const next: StatusPieces = { ...this.#pieces }
    for (const key of Object.keys(partial) as (keyof StatusPatch)[]) {
      const value = partial[key]
      if (key === 'companionPid') {
        if (value === undefined) {
          if (next.companionPid !== undefined) {
            delete next.companionPid
            changed = true
          }
        } else if (next.companionPid !== value) {
          next.companionPid = value as number
          changed = true
        }
        continue
      }
      if (value === undefined) continue
      // 下载进度每 250 ms 推一次、配置变化时整份配置重推，内容没变就不该唤醒所有页面。
      if (JSON.stringify(next[key]) === JSON.stringify(value)) continue
      ;(next as Record<string, unknown>)[key] = structuredClone(value)
      changed = true
    }
    if (!changed) return false
    this.#pieces = next
    this.#bump()
    return true
  }

  /**
   * 当前完整状态。navigate.ageMs 按 now 计算。传 clientId 时按这个页面裁剪：
   * 「打开配置页」请求指定了别的目标页面时，这个页面看到的 navigate 为 null。
   */
  snapshot(now: number = this.#now(), clientId?: string): PanelStatus {
    const status: PanelStatus = { ...structuredClone(this.#pieces), seq: this.#seq, navigate: null }
    const navigate = this.#navigate
    if (navigate !== null && (navigate.target === null || clientId === undefined || navigate.target === clientId)) {
      status.navigate = { seq: navigate.seq, ageMs: Math.max(0, now - navigate.at) }
    }
    return status
  }

  /**
   * 长轮询：序号和 since 不同时立即返回；相同时等到有变化、超时或请求被中止，都以当时的状态返回（不抛异常）。
   * since 为 null（第一次轮询）时立即返回。序号「不同」而不只是「更大」也立即返回：since 比当前序号还大，
   * 说明页面拿的是重启前那个 Host 实例的序号（或时钟被回拨），这时让它等下去只会白等一个超时。
   * 带 clientId 的轮询期间这个页面算在线。
   */
  waitForChange(
    since: number | null,
    signal?: AbortSignal,
    timeoutMs: number = DEFAULT_POLL_TIMEOUT_MS,
    clientId?: string,
  ): Promise<PanelStatus> {
    this.#beginPoll(clientId)
    if (this.#closed || since === null || since !== this.#seq || signal?.aborted === true) {
      this.#endPoll(clientId)
      return Promise.resolve(this.snapshot(this.#now(), clientId))
    }
    return new Promise<PanelStatus>((resolve) => {
      let settled = false
      const settle = () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal?.removeEventListener('abort', settle)
        this.#waiters.delete(waiter)
        this.#endPoll(clientId)
        resolve(this.snapshot(this.#now(), clientId))
      }
      const waiter: Waiter = { settle }
      const timer = setTimeout(settle, timeoutMs)
      // 长轮询不应该拖住进程退出。
      ;(timer as { unref?: () => void }).unref?.()
      signal?.addEventListener('abort', settle, { once: true })
      this.#waiters.add(waiter)
    })
  }

  /**
   * 记下一次「打开配置页」请求（小程序的 host.openSettings）。目标是最近一次报告「可见」且仍在线的页面；
   * 没有这样的页面时所有在线页面都切（design-spec 4.8 第 2 步）。返回这次请求的序号。
   */
  requestNavigate(): number {
    const now = this.#now()
    const previous = this.#navigate?.seq ?? 0
    // 和状态序号一样以毫秒时间为下限：页面跨过 dsh 重启记着的「处理过的序号」不会挡住新请求。
    const seq = Math.max(previous + 1, Math.trunc(now))
    this.#navigate = { seq, at: now, target: this.#pickTarget(now) }
    this.#bump()
    return seq
  }

  /**
   * 页面的活动：client-state 上报时带 visible；长轮询只刷新在线时间（不传 visible）。
   */
  touchClient(clientId: string, visible?: boolean): void {
    const now = this.#now()
    const record = this.#client(clientId, now)
    record.seenAt = now
    if (visible !== undefined) {
      record.visible = visible
      if (visible) record.visibleAt = now
    }
    this.#prune(now)
  }

  /** withinMs 之内有没有报告可见、仍在线的页面（正在长轮询的算在线）。 */
  hasVisibleClient(withinMs: number): boolean {
    const now = this.#now()
    for (const record of this.#clients.values()) {
      if (record.visible && isOnline(record, now, withinMs)) return true
    }
    return false
  }

  /** withinMs 之内有没有任何在线的 dsh 页面（包括没带 clientId 的长轮询）。 */
  hasAnyClient(withinMs: number): boolean {
    const now = this.#now()
    if (this.#anonymousPolling > 0 || now - this.#anonymousSeenAt <= withinMs) return true
    for (const record of this.#clients.values()) {
      if (isOnline(record, now, withinMs)) return true
    }
    return false
  }

  /** 插件卸载：所有在等的长轮询立即返回，之后的轮询也不再等待。 */
  close(): void {
    this.#closed = true
    for (const waiter of [...this.#waiters]) waiter.settle()
  }

  #bump(): void {
    this.#seq += 1
    for (const waiter of [...this.#waiters]) waiter.settle()
  }

  #beginPoll(clientId: string | undefined): void {
    if (clientId === undefined) {
      this.#anonymousPolling += 1
      return
    }
    const now = this.#now()
    const record = this.#client(clientId, now)
    record.polling += 1
    record.seenAt = now
    this.#prune(now)
  }

  #endPoll(clientId: string | undefined): void {
    const now = this.#now()
    if (clientId === undefined) {
      this.#anonymousPolling = Math.max(0, this.#anonymousPolling - 1)
      this.#anonymousSeenAt = now
      return
    }
    const record = this.#clients.get(clientId)
    if (record === undefined) return
    record.polling = Math.max(0, record.polling - 1)
    record.seenAt = now
  }

  #client(clientId: string, now: number): ClientRecord {
    let record = this.#clients.get(clientId)
    if (record === undefined) {
      record = { visible: false, visibleAt: Number.NEGATIVE_INFINITY, seenAt: now, polling: 0 }
      this.#clients.set(clientId, record)
    }
    return record
  }

  #pickTarget(now: number): string | null {
    let best: string | null = null
    let bestAt = Number.NEGATIVE_INFINITY
    for (const [id, record] of this.#clients) {
      if (!record.visible || !isOnline(record, now, this.#onlineWindowMs)) continue
      if (record.visibleAt > bestAt) {
        best = id
        bestAt = record.visibleAt
      }
    }
    return best
  }

  #prune(now: number): void {
    for (const [id, record] of this.#clients) {
      if (record.polling === 0 && now - record.seenAt > CLIENT_FORGET_MS) this.#clients.delete(id)
    }
    if (this.#clients.size <= MAX_CLIENTS) return
    // 超出上限时丢掉最久没出现、且没有在等的记录（Map 按插入顺序遍历，先按时间排一次）。
    const idle = [...this.#clients].filter(([, record]) => record.polling === 0).sort((a, b) => a[1].seenAt - b[1].seenAt)
    for (const [id] of idle) {
      if (this.#clients.size <= MAX_CLIENTS) break
      this.#clients.delete(id)
    }
  }
}

function isOnline(record: ClientRecord, now: number, withinMs: number): boolean {
  return record.polling > 0 || now - record.seenAt <= withinMs
}
