import { describe, expect, it, vi } from 'vitest'
import { NAVIGATE_TTL_MS, StatusStore } from '../../src/web/status-store.ts'
import type { PanelStatus } from '../../src/shared/types.ts'
import { manualClock as clock, statusPieces as pieces, trapUnexpectedErrors } from './fixtures.ts'

trapUnexpectedErrors({ fakeTimers: true })

/** 配置页的规则（design-spec 4.4）：序号比处理过的大、且请求不超过 60 秒才切页。 */
function shouldNavigate(status: PanelStatus, handled: number): boolean {
  return status.navigate !== null && status.navigate.seq > handled && status.navigate.ageMs < NAVIGATE_TTL_MS
}

describe('StatusStore: snapshot and patch', () => {
  it('starts the sequence at the current millisecond time and has no navigate request', () => {
    const time = clock(1_731_000_000_000)
    const store = new StatusStore(pieces(), { now: time.now })
    const status = store.snapshot()
    expect(status.seq).toBe(1_731_000_000_000)
    expect(status.navigate).toBeNull()
    expect(status).toMatchObject(pieces())
  })

  it('bumps the sequence only when a patched value really changes', () => {
    const store = new StatusStore(pieces(), { now: clock().now })
    const seq = store.seq
    expect(store.patch({ runtime: { state: 'missing', version: '44.10.2', dir: '/home/me/.dsh/promptx/runtime' } })).toBe(false)
    expect(store.patch({})).toBe(false)
    expect(store.seq).toBe(seq)
    expect(store.patch({ runtime: { state: 'downloading', version: '44.10.2', dir: '/x', received: 1, total: 10 } })).toBe(true)
    expect(store.seq).toBe(seq + 1)
    expect(store.snapshot().runtime).toMatchObject({ state: 'downloading', received: 1 })
    expect(store.patch({ companion: { state: 'running' }, platform: 'darwin' })).toBe(true)
    expect(store.seq).toBe(seq + 2)
  })

  it('sets and clears the companion pid', () => {
    const store = new StatusStore(pieces(), { now: clock().now })
    expect(store.patch({ companionPid: 4321 })).toBe(true)
    expect(store.snapshot().companionPid).toBe(4321)
    expect(store.patch({ companionPid: 4321 })).toBe(false)
    expect(store.patch({ companionPid: undefined })).toBe(true)
    expect(Object.hasOwn(store.snapshot(), 'companionPid')).toBe(false)
    expect(store.patch({ companionPid: undefined })).toBe(false)
  })

  it('isolates snapshots from internal state and from the patched objects', () => {
    const store = new StatusStore(pieces(), { now: clock().now })
    const config = { ...pieces().config, hideOnBlur: true }
    store.patch({ config })
    config.hideOnBlur = false
    const snapshot = store.snapshot()
    snapshot.config.confirmDelete = false
    expect(store.snapshot().config).toMatchObject({ hideOnBlur: true, confirmDelete: true })
  })
})

describe('StatusStore: long poll', () => {
  it('answers immediately for the first poll, a different sequence or an aborted request', async () => {
    const store = new StatusStore(pieces(), { now: clock().now })
    await expect(store.waitForChange(null)).resolves.toMatchObject({ seq: store.seq })
    await expect(store.waitForChange(store.seq - 1)).resolves.toMatchObject({ seq: store.seq })
    // since 比当前序号还大：页面拿的是重启前那个 Host 实例的序号，不能让它白等。
    await expect(store.waitForChange(store.seq + 50)).resolves.toMatchObject({ seq: store.seq })
    const aborted = AbortSignal.abort()
    await expect(store.waitForChange(store.seq, aborted)).resolves.toMatchObject({ seq: store.seq })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('waits until something changes and answers with the new state', async () => {
    const store = new StatusStore(pieces(), { now: clock().now })
    const since = store.seq
    let answered: PanelStatus | undefined
    const waiting = store.waitForChange(since).then((status) => {
      answered = status
    })
    await vi.advanceTimersByTimeAsync(10_000)
    expect(answered).toBeUndefined()
    store.patch({ companion: { state: 'running' } })
    await waiting
    expect(answered).toMatchObject({ seq: since + 1, companion: { state: 'running' } })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('wakes every waiting poll on one change', async () => {
    const store = new StatusStore(pieces(), { now: clock().now })
    const since = store.seq
    const polls = [store.waitForChange(since), store.waitForChange(since, undefined, 25_000, 'page-a'), store.waitForChange(since)]
    store.patch({ instance: 'duplicate' })
    const results = await Promise.all(polls)
    expect(results.map(status => status.instance)).toEqual(['duplicate', 'duplicate', 'duplicate'])
  })

  it('answers with the unchanged state after the timeout and leaves no timer behind', async () => {
    const store = new StatusStore(pieces(), { now: clock().now })
    const since = store.seq
    let answered: PanelStatus | undefined
    const waiting = store.waitForChange(since, undefined, 25_000).then((status) => {
      answered = status
    })
    await vi.advanceTimersByTimeAsync(24_999)
    expect(answered).toBeUndefined()
    await vi.advanceTimersByTimeAsync(1)
    await waiting
    expect(answered?.seq).toBe(since)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('answers right away when the request is aborted, removing the timer and the listener', async () => {
    const store = new StatusStore(pieces(), { now: clock().now })
    const controller = new AbortController()
    const removeSpy = vi.spyOn(controller.signal, 'removeEventListener')
    const waiting = store.waitForChange(store.seq, controller.signal)
    expect(vi.getTimerCount()).toBe(1)
    controller.abort()
    await expect(waiting).resolves.toMatchObject({ seq: store.seq })
    expect(vi.getTimerCount()).toBe(0)
    expect(removeSpy).toHaveBeenCalledWith('abort', expect.any(Function))
    // 之后的变化不会再碰到已经结束的等待。
    expect(store.patch({ companion: { state: 'running' } })).toBe(true)
  })

  it('releases every waiter on close and no longer waits afterwards', async () => {
    const store = new StatusStore(pieces(), { now: clock().now })
    const waiting = store.waitForChange(store.seq)
    store.close()
    await expect(waiting).resolves.toMatchObject({ seq: store.seq })
    await expect(store.waitForChange(store.seq)).resolves.toMatchObject({ seq: store.seq })
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('StatusStore: navigate requests (F-05, review TC-06)', () => {
  it('reports the age of the request so a freshly loaded page navigates within 60 seconds only', () => {
    const time = clock(5_000_000)
    const store = new StatusStore(pieces(), { now: time.now })
    const before = store.seq
    const seq = store.requestNavigate()
    expect(store.seq).toBe(before + 1)

    // 新打开的页面：没有处理过任何请求。
    const at59 = store.snapshot(time.now() + 59_000)
    expect(at59.navigate).toEqual({ seq, ageMs: 59_000 })
    expect(shouldNavigate(at59, 0)).toBe(true)

    const at61 = store.snapshot(time.now() + 61_000)
    expect(at61.navigate).toEqual({ seq, ageMs: 61_000 })
    expect(shouldNavigate(at61, 0)).toBe(false)
  })

  it('does not navigate twice for the same request', () => {
    const time = clock(5_000_000)
    const store = new StatusStore(pieces(), { now: time.now })
    store.requestNavigate()
    let handled = 0
    const first = store.snapshot()
    expect(shouldNavigate(first, handled)).toBe(true)
    handled = first.navigate!.seq
    time.advance(1_000)
    store.patch({ companion: { state: 'running' } })
    expect(shouldNavigate(store.snapshot(), handled)).toBe(false)

    time.advance(1_000)
    store.requestNavigate()
    const second = store.snapshot()
    expect(second.navigate!.seq).toBeGreaterThan(handled)
    expect(shouldNavigate(second, handled)).toBe(true)
  })

  it('keeps navigate sequence numbers increasing within one millisecond and above the clock', () => {
    const time = clock(7_000_000)
    const store = new StatusStore(pieces(), { now: time.now })
    const a = store.requestNavigate()
    const b = store.requestNavigate()
    expect(a).toBe(7_000_000)
    expect(b).toBe(7_000_001)
    // 重启后的新实例：序号以时间为下限，比页面记着的旧序号大。
    time.advance(5_000)
    const restarted = new StatusStore(pieces(), { now: time.now })
    expect(restarted.requestNavigate()).toBeGreaterThan(b)
    expect(restarted.seq).toBeGreaterThan(store.seq)
  })

  it('wakes a waiting poll with the navigate request', async () => {
    const store = new StatusStore(pieces(), { now: clock().now })
    const waiting = store.waitForChange(store.seq)
    const seq = store.requestNavigate()
    await expect(waiting).resolves.toMatchObject({ navigate: { seq, ageMs: 0 } })
  })

  it('targets the most recently visible online page and hides the request from the others', async () => {
    const time = clock(9_000_000)
    const store = new StatusStore(pieces(), { now: time.now })
    store.touchClient('older', true)
    time.advance(1_000)
    store.touchClient('newer', true)
    time.advance(1_000)
    store.touchClient('hidden', false)
    const polls = {
      older: store.waitForChange(store.seq, undefined, 25_000, 'older'),
      newer: store.waitForChange(store.seq, undefined, 25_000, 'newer'),
      hidden: store.waitForChange(store.seq, undefined, 25_000, 'hidden'),
      anonymous: store.waitForChange(store.seq),
    }
    const seq = store.requestNavigate()
    expect((await polls.newer).navigate).toEqual({ seq, ageMs: 0 })
    expect((await polls.older).navigate).toBeNull()
    expect((await polls.hidden).navigate).toBeNull()
    // 没带 clientId 的轮询分不清是哪个页面，照常看到请求。
    expect((await polls.anonymous).navigate).toEqual({ seq, ageMs: 0 })
  })

  it('lets every page navigate when no visible page is online', () => {
    const time = clock(9_000_000)
    const store = new StatusStore(pieces(), { now: time.now })
    store.touchClient('hidden', false)
    store.touchClient('gone', true)
    // gone 早已不在线（超过 40 秒没有轮询或上报）。
    time.advance(60_000)
    store.touchClient('hidden', false)
    const seq = store.requestNavigate()
    expect(store.snapshot(time.now(), 'hidden').navigate).toEqual({ seq, ageMs: 0 })
    expect(store.snapshot(time.now(), 'gone').navigate).toEqual({ seq, ageMs: 0 })
  })

  it('stops treating a page as visible after it reports hidden', () => {
    const time = clock(9_000_000)
    const store = new StatusStore(pieces(), { now: time.now })
    store.touchClient('a', true)
    store.touchClient('b', true)
    time.advance(100)
    store.touchClient('b', false)
    store.requestNavigate()
    expect(store.snapshot(time.now(), 'a').navigate).not.toBeNull()
    expect(store.snapshot(time.now(), 'b').navigate).toBeNull()
  })
})

describe('StatusStore: online pages (design-spec 4.8)', () => {
  it('counts pending polls as online and remembers the last poll for a while', async () => {
    const time = clock(1_000)
    const store = new StatusStore(pieces(), { now: time.now })
    expect(store.hasAnyClient(10_000)).toBe(false)
    expect(store.hasVisibleClient(10_000)).toBe(false)

    const controller = new AbortController()
    const anonymous = store.waitForChange(store.seq, controller.signal)
    time.advance(60_000)
    expect(store.hasAnyClient(10_000)).toBe(true)
    controller.abort()
    await anonymous
    expect(store.hasAnyClient(10_000)).toBe(true)
    time.advance(10_001)
    expect(store.hasAnyClient(10_000)).toBe(false)
  })

  it('tracks visibility per page and expires pages that stopped polling', async () => {
    const time = clock(1_000)
    const store = new StatusStore(pieces(), { now: time.now })
    store.touchClient('page', true)
    expect(store.hasVisibleClient(10_000)).toBe(true)
    time.advance(20_000)
    expect(store.hasVisibleClient(10_000)).toBe(false)
    expect(store.hasAnyClient(10_000)).toBe(false)

    // 正在长轮询的页面一直算在线。
    const controller = new AbortController()
    const poll = store.waitForChange(store.seq, controller.signal, 25_000, 'page')
    time.advance(20_000)
    expect(store.hasVisibleClient(10_000)).toBe(true)
    controller.abort()
    await poll
    store.touchClient('page', false)
    expect(store.hasVisibleClient(10_000)).toBe(false)
    expect(store.hasAnyClient(10_000)).toBe(true)
  })

  it('forgets pages that have been gone for a long time', () => {
    const time = clock(1_000)
    const store = new StatusStore(pieces(), { now: time.now })
    for (let i = 0; i < 100; i++) store.touchClient(`page-${i}`, true)
    time.advance(11 * 60_000)
    store.touchClient('fresh', false)
    expect(store.hasVisibleClient(24 * 60 * 60_000)).toBe(false)
    expect(store.hasAnyClient(1_000)).toBe(true)
  })
})
