// 小程序请求的分发（src/host-handlers.ts，审查 F7）：参数检查、每个连接「读回草稿之后才能保存」、status 通知的检查。

import { describe, expect, it } from 'vitest'
import { attachCompanionHandlers, companionStatus, type CompanionHandlerDeps } from '../../src/host-handlers.ts'
import type { DraftApi, HostPeer, LibraryApi, OptimizeApi } from '../../src/services.ts'
import type { CompanionStatus } from '../../src/shared/types.ts'

type Handler = (params: unknown) => unknown

/** 只记下注册的处理函数，测试直接调用它们。 */
interface FakePeer {
  peer: HostPeer
  call(method: string, params?: unknown): Promise<unknown>
  emit(method: string, params: unknown): void
}

function fakePeer(): FakePeer {
  const handlers = new Map<string, Handler>()
  const listeners = new Map<string, Handler>()
  const peer = {
    handle: (method: string, handler: Handler) => {
      handlers.set(method, handler)
    },
    on: (method: string, listener: Handler) => {
      listeners.set(method, listener)
    },
  } as unknown as HostPeer
  return {
    peer,
    call: async (method, params = {}) => {
      const handler = handlers.get(method)
      if (handler === undefined) throw new Error(`no handler for ${method}`)
      return await handler(params)
    },
    emit: (method, params) => {
      listeners.get(method)?.(params)
    },
  }
}

function deps(overrides: Partial<CompanionHandlerDeps> = {}): CompanionHandlerDeps & { saved: string[]; statuses: CompanionStatus[] } {
  const saved: string[] = []
  const statuses: CompanionStatus[] = []
  const draft: DraftApi = {
    load: () => Promise.resolve(null),
    save: (input) => {
      saved.push(input.text)
      return Promise.resolve({ updatedAt: '2026-11-08T00:00:00.000Z' })
    },
    close: () => Promise.resolve(),
  }
  return {
    draft,
    library: {} as LibraryApi,
    optimize: {} as OptimizeApi,
    openSettings: () => ({ open: null, navigated: true }),
    onStatus: (status) => {
      statuses.push(status)
    },
    onRestartRequest: () => {},
    ...overrides,
    saved,
    statuses,
  }
}

const STATUS: CompanionStatus = { shortcut: null, tray: true, visible: false, locale: 'en', rendererError: null }

describe('attachCompanionHandlers', () => {
  it('refuses draft.save on a connection that has not read the draft back yet', async () => {
    const d = deps()
    const first = fakePeer()
    attachCompanionHandlers(first.peer, d)
    await expect(first.call('draft.save', { text: 'x', selection: null, binding: null })).rejects.toMatchObject({ code: 'promptx/draft/unreadable' })
    await first.call('draft.load')
    await first.call('draft.save', { text: 'after load', selection: null, binding: null })
    // 新连接（小程序重启后）要重新读回，不能沿用上一个连接的状态。
    const second = fakePeer()
    attachCompanionHandlers(second.peer, d)
    await expect(second.call('draft.save', { text: 'y', selection: null, binding: null })).rejects.toMatchObject({ code: 'promptx/draft/unreadable' })
    expect(d.saved).toEqual(['after load'])
  })

  it('does not mark the draft as loaded when loading fails', async () => {
    const d = deps({
      draft: {
        load: () => Promise.reject(new Error('broken')),
        save: () => Promise.resolve({ updatedAt: '' }),
        close: () => Promise.resolve(),
      },
    })
    const p = fakePeer()
    attachCompanionHandlers(p.peer, d)
    await expect(p.call('draft.load')).rejects.toThrow('broken')
    await expect(p.call('draft.save', { text: 'x', selection: null, binding: null })).rejects.toMatchObject({ code: 'promptx/draft/unreadable' })
  })

  it('rejects malformed parameters with the field name only', async () => {
    const p = fakePeer()
    attachCompanionHandlers(p.peer, deps())
    await p.call('draft.load')
    await expect(p.call('draft.save', { text: 42, selection: null, binding: null })).rejects.toMatchObject({ code: 'promptx/internal', detail: 'invalid parameter: text' })
    await expect(p.call('draft.save', { text: 'secret words', selection: { anchor: -1, head: 0 }, binding: null }))
      .rejects.toMatchObject({ detail: 'invalid parameter: selection.anchor' })
  })

  it('passes valid status notifications on and drops malformed ones', () => {
    const d = deps()
    const p = fakePeer()
    attachCompanionHandlers(p.peer, d)
    p.emit('status', STATUS)
    p.emit('status', { ...STATUS, locale: 'fr' })
    p.emit('status', { ...STATUS, rendererError: 'crashed' })
    p.emit('status', 'nonsense')
    expect(d.statuses).toEqual([STATUS])
  })
})

describe('companionStatus', () => {
  it('accepts the documented shape', () => {
    const crashed = { ...STATUS, locale: 'zh', rendererError: { code: 'promptx/companion/renderer-gone', detail: 'oom' } }
    expect(companionStatus(crashed)).toEqual(crashed)
    const shortcut = { ...STATUS, shortcut: { accelerator: 'Control+P', registered: true } }
    expect(companionStatus(shortcut)).toEqual(shortcut)
  })

  it('rejects missing or wrongly typed fields', () => {
    expect(companionStatus(null)).toBeNull()
    expect(companionStatus({ ...STATUS, tray: 'yes' })).toBeNull()
    expect(companionStatus({ ...STATUS, shortcut: 'Control+P' })).toBeNull()
    expect(companionStatus({ shortcut: null, tray: true, visible: false })).toBeNull()
    expect(companionStatus({ ...STATUS, rendererError: { detail: 'no code' } })).toBeNull()
    expect(companionStatus({ ...STATUS, rendererError: { code: 'x', detail: 3 } })).toBeNull()
  })

  it('caps a long error detail', () => {
    const parsed = companionStatus({ ...STATUS, rendererError: { code: 'promptx/companion/renderer-gone', detail: 'x'.repeat(1_000) } })
    expect(parsed?.rendererError?.detail).toHaveLength(300)
  })
})
