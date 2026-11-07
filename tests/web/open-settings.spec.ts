import { describe, expect, it, vi } from 'vitest'
import { DESKTOP_OPEN_URL, planOpenSettings } from '../../src/web/open-settings.ts'
import { StatusStore } from '../../src/web/status-store.ts'
import { manualClock, statusPieces, trapUnexpectedErrors } from './fixtures.ts'

trapUnexpectedErrors()

function storeWithClock() {
  const time = manualClock(10_000_000)
  return { time, store: new StatusStore(statusPieces(), { now: time.now }) }
}

describe('planOpenSettings (F-05, design-spec 4.8)', () => {
  it('opens dsh://open in the desktop app and records the navigate request', () => {
    const { store } = storeWithClock()
    const webUrl = vi.fn(() => 'http://127.0.0.1:1234/?token=secret')
    const before = store.seq
    expect(planOpenSettings(store, { desktop: true, webUrl })).toEqual({ open: DESKTOP_OPEN_URL, navigated: false })
    expect(store.seq).toBe(before + 1)
    expect(store.snapshot().navigate).toMatchObject({ ageMs: 0 })
    expect(webUrl).not.toHaveBeenCalled()

    store.touchClient('desktop-page', true)
    expect(planOpenSettings(store, { desktop: true, webUrl })).toEqual({ open: DESKTOP_OPEN_URL, navigated: true })
  })

  it('lets an online page switch by itself in dsh web, without opening a browser tab', async () => {
    const { store } = storeWithClock()
    const webUrl = vi.fn(() => 'http://127.0.0.1:1234/?token=secret')
    const controller = new AbortController()
    const poll = store.waitForChange(store.seq, controller.signal, 25_000, 'page')
    const result = planOpenSettings(store, { desktop: false, webUrl })
    expect(result).toEqual({ open: null, navigated: true })
    expect(webUrl).not.toHaveBeenCalled()
    // 等着的长轮询立刻拿到切页请求。
    await expect(poll).resolves.toMatchObject({ navigate: { ageMs: 0 } })
    controller.abort()
  })

  it('opens the authenticated dsh web address when no page is online', () => {
    const { store, time } = storeWithClock()
    store.touchClient('closed-long-ago', true)
    time.advance(60_000)
    expect(planOpenSettings(store, { desktop: false, webUrl: () => 'http://127.0.0.1:1234/?token=secret' })).toEqual({
      open: 'http://127.0.0.1:1234/?token=secret',
      navigated: false,
    })
    // 新打开的页面第一次轮询就能看到这个请求。
    time.advance(3_000)
    expect(store.snapshot().navigate).toMatchObject({ ageMs: 3_000 })
  })

  it('returns no address when the web address cannot be built', () => {
    const { store } = storeWithClock()
    expect(planOpenSettings(store, { desktop: false, webUrl: () => null })).toEqual({ open: null, navigated: false })
    expect(planOpenSettings(store, {
      desktop: false,
      webUrl: () => {
        throw new Error('webApp is reloading')
      },
    })).toEqual({ open: null, navigated: false })
  })

  it('honours a custom online window', () => {
    const { store, time } = storeWithClock()
    store.touchClient('page', false)
    time.advance(5_000)
    expect(planOpenSettings(store, { desktop: false, webUrl: () => 'u', onlineWithinMs: 4_000 })).toEqual({ open: 'u', navigated: false })
    expect(planOpenSettings(store, { desktop: false, webUrl: () => 'u', onlineWithinMs: 6_000 })).toEqual({ open: null, navigated: true })
  })
})
