import { describe, expect, it, vi } from 'vitest'
import { BRIDGE_EVENT_NAMES, IPC_CHANNELS } from '../../../src/app/main/channels.ts'
import {
  isForwardedMethod,
  registerIpcHandlers,
  UntrustedSenderError,
  type IpcEventLike,
  type IpcHandlers,
  type IpcMainLike,
} from '../../../src/app/main/ipc.ts'
import { DEFAULT_PREFS, type BridgeEventName, type BridgeEvents } from '../../../src/shared/bridge.ts'
import { COMPANION_REQUEST_METHODS, RENDERER_FORWARDED_METHODS } from '../../../src/shared/protocol.ts'
import { trapProcessErrors } from './helpers.ts'

trapProcessErrors()

type Listener = (event: IpcEventLike, ...args: unknown[]) => unknown

/** 假的 ipcMain：记下注册的处理函数，测试以某个来源调用它们。 */
class FakeIpc implements IpcMainLike {
  readonly handlers = new Map<string, Listener>()
  readonly listeners = new Map<string, Listener>()

  handle(channel: string, listener: Listener): void {
    if (this.handlers.has(channel)) throw new Error(`duplicate handle ${channel}`)
    this.handlers.set(channel, listener)
  }

  on(channel: string, listener: Listener): void {
    if (this.listeners.has(channel)) throw new Error(`duplicate on ${channel}`)
    this.listeners.set(channel, listener)
  }

  invoke(channel: string, sender: unknown, ...args: unknown[]): unknown {
    const handler = this.handlers.get(channel)
    if (handler === undefined) throw new Error(`no handler for ${channel}`)
    return handler({ sender }, ...args)
  }

  send(channel: string, sender: unknown, ...args: unknown[]): void {
    const listener = this.listeners.get(channel)
    if (listener === undefined) throw new Error(`no listener for ${channel}`)
    listener({ sender }, ...args)
  }
}

const OWN = { id: 'own webContents' }
const OTHER = { id: 'some other webContents' }
const BOUNDS = { x: 0, y: 0, width: 980, height: 600, workArea: { x: 0, y: 0, width: 1440, height: 900 } }

function createMocks() {
  return {
    call: vi.fn((_method: string, _params: Record<string, unknown>) => Promise.resolve({ ok: true as const, value: { record: null } })),
    getConfig: vi.fn(() => null),
    hide: vi.fn(),
    copyAndHide: vi.fn((_text: string) => Promise.resolve({ ok: true as const, value: null })),
    copyText: vi.fn((_text: string) => Promise.resolve({ ok: true as const, value: null })),
    getBounds: vi.fn(() => BOUNDS),
    setWidth: vi.fn((_width: number, _anchor: 'left' | 'right') => BOUNDS),
    openSettings: vi.fn(() => Promise.resolve({ ok: true as const, value: { navigated: false } })),
    getPrefs: vi.fn(() => DEFAULT_PREFS),
    ready: vi.fn((_info: { editorMounted: boolean; draftLoaded: boolean }) => {}),
    flushed: vi.fn((_id: number) => {}),
    e2eDone: vi.fn((_id: number, _result: { ok: boolean; data: Record<string, unknown> }) => {}),
    setModalOpen: vi.fn((_open: boolean) => {}),
    setMinWidth: vi.fn((_width: number) => {}),
    setPrefs: vi.fn((_patch: Record<string, unknown>) => {}),
  }
}

type Mocks = ReturnType<typeof createMocks>

function setup(): { ipc: FakeIpc; handlers: Mocks; rejected: [string, string][] } {
  const ipc = new FakeIpc()
  const handlers = createMocks()
  const table: IpcHandlers = handlers
  const rejected: [string, string][] = []
  registerIpcHandlers(ipc, {
    isTrusted: sender => sender === OWN,
    handlers: table,
    onRejected: (channel, why) => {
      rejected.push([channel, why])
    },
  })
  return { ipc, handlers, rejected }
}

describe('IPC channels', () => {
  it('names every channel promptx:<name> without duplicates', () => {
    const names = Object.values(IPC_CHANNELS)
    for (const name of names) expect(name).toMatch(/^promptx:[A-Za-z0-9.]+$/)
    expect(new Set(names).size).toBe(names.length)
  })

  it('lists exactly the bridge events', () => {
    const expected: Record<BridgeEventName, true> = {
      'entryEditor.state': true,
      'config': true,
      'optimize.event': true,
      'library.changed': true,
      'library.entriesChanged': true,
      'window.shown': true,
      'window.hidden': true,
      'flush': true,
      'e2e': true,
    }
    expect([...BRIDGE_EVENT_NAMES].sort()).toEqual(Object.keys(expected).sort())
  })

  it('registers a handler for every channel the preload uses', () => {
    const { ipc } = setup()
    const registered = [...ipc.handlers.keys(), ...ipc.listeners.keys()].sort()
    const expected = Object.values(IPC_CHANNELS).filter(channel => channel !== IPC_CHANNELS.event && !channel.startsWith('promptx:entryEditor.')).sort()
    expect(registered).toEqual(expected)
  })
})

describe('isForwardedMethod', () => {
  it('accepts only the renderer allow-list', () => {
    for (const method of RENDERER_FORWARDED_METHODS) expect(isForwardedMethod(method)).toBe(true)
    // hello 由主进程自己发；Host 发来的请求和其他名字都不能经渲染进程转发。
    for (const method of ['hello', 'entryDraft.load', 'entryDraft.save', 'host.openSettings', 'ping', 'shutdown', 'e2e.run', 'status', 'constructor', '__proto__', 42, null]) {
      expect(isForwardedMethod(method)).toBe(false)
    }
  })

  it('is a subset of the companion request table', () => {
    for (const method of RENDERER_FORWARDED_METHODS) expect(COMPANION_REQUEST_METHODS).toContain(method)
  })
})

describe('registerIpcHandlers: sender check', () => {
  it('rejects invoke calls from any other webContents and never reaches the handler', () => {
    const { ipc, handlers, rejected } = setup()
    for (const channel of ipc.handlers.keys()) {
      expect(() => ipc.invoke(channel, OTHER, 'draft.load', {})).toThrow(UntrustedSenderError)
    }
    expect(handlers.call).not.toHaveBeenCalled()
    expect(handlers.copyAndHide).not.toHaveBeenCalled()
    expect(handlers.getPrefs).not.toHaveBeenCalled()
    expect(rejected.every(([, why]) => why === 'sender')).toBe(true)
    expect(rejected).toHaveLength(ipc.handlers.size)
  })

  it('ignores send messages from any other webContents', () => {
    const { ipc, handlers, rejected } = setup()
    ipc.send(IPC_CHANNELS.ready, OTHER, { editorMounted: true, draftLoaded: true })
    ipc.send(IPC_CHANNELS.flushed, OTHER, 1)
    ipc.send(IPC_CHANNELS.prefsSet, OTHER, { panes: {} })
    ipc.send(IPC_CHANNELS.windowSetModalOpen, null, true)
    expect(handlers.ready).not.toHaveBeenCalled()
    expect(handlers.flushed).not.toHaveBeenCalled()
    expect(handlers.setPrefs).not.toHaveBeenCalled()
    expect(handlers.setModalOpen).not.toHaveBeenCalled()
    expect(rejected).toEqual([
      [IPC_CHANNELS.ready, 'sender'],
      [IPC_CHANNELS.flushed, 'sender'],
      [IPC_CHANNELS.prefsSet, 'sender'],
      [IPC_CHANNELS.windowSetModalOpen, 'sender'],
    ])
  })
})

describe('registerIpcHandlers: call', () => {
  it('forwards allowed methods with their params', async () => {
    const { ipc, handlers } = setup()
    await expect(ipc.invoke(IPC_CHANNELS.call, OWN, 'draft.load', {})).resolves.toEqual({ ok: true, value: { record: null } })
    expect(handlers.call).toHaveBeenCalledWith('draft.load', {})
    await ipc.invoke(IPC_CHANNELS.call, OWN, 'optimize.state')
    expect(handlers.call).toHaveBeenLastCalledWith('optimize.state', {})
  })

  it('refuses methods outside the allow-list without reaching the Host', async () => {
    const { ipc, handlers, rejected } = setup()
    for (const method of ['hello', 'host.openSettings', 'shutdown', 'e2e.run']) {
      await expect(ipc.invoke(IPC_CHANNELS.call, OWN, method, {})).resolves.toEqual({
        ok: false,
        error: { code: 'promptx/internal', detail: 'invalid arguments' },
      })
    }
    expect(handlers.call).not.toHaveBeenCalled()
    expect(rejected.every(([channel, why]) => channel === IPC_CHANNELS.call && why === 'arguments')).toBe(true)
  })

  it('refuses params that are not plain objects', async () => {
    const { ipc, handlers } = setup()
    for (const params of [null, 'x', [1], new Date(0)]) {
      await expect(ipc.invoke(IPC_CHANNELS.call, OWN, 'draft.save', params)).resolves.toMatchObject({ ok: false })
    }
    expect(handlers.call).not.toHaveBeenCalled()
  })
})

describe('registerIpcHandlers: window and prefs', () => {
  it('passes the text of copyAndHide and copyText through and refuses non-strings', async () => {
    const { ipc, handlers } = setup()
    await ipc.invoke(IPC_CHANNELS.windowCopyAndHide, OWN, '  第一行\n\n  ')
    expect(handlers.copyAndHide).toHaveBeenCalledWith('  第一行\n\n  ')
    await ipc.invoke(IPC_CHANNELS.windowCopyText, OWN, '')
    expect(handlers.copyText).toHaveBeenCalledWith('')
    await expect(ipc.invoke(IPC_CHANNELS.windowCopyAndHide, OWN, 42)).resolves.toEqual({
      ok: false,
      error: { code: 'promptx/clipboard/write-failed', detail: 'invalid arguments' },
    })
    await expect(ipc.invoke(IPC_CHANNELS.windowCopyText, OWN, undefined)).resolves.toMatchObject({ ok: false })
    expect(handlers.copyAndHide).toHaveBeenCalledTimes(1)
    expect(handlers.copyText).toHaveBeenCalledTimes(1)
  })

  it('validates setWidth arguments', () => {
    const { ipc, handlers } = setup()
    expect(ipc.invoke(IPC_CHANNELS.windowSetWidth, OWN, 1200, 'right')).toEqual(BOUNDS)
    expect(handlers.setWidth).toHaveBeenCalledWith(1200, 'right')
    expect(() => ipc.invoke(IPC_CHANNELS.windowSetWidth, OWN, 1200, 'middle')).toThrow('invalid arguments')
    expect(() => ipc.invoke(IPC_CHANNELS.windowSetWidth, OWN, Number.NaN, 'left')).toThrow('invalid arguments')
    expect(() => ipc.invoke(IPC_CHANNELS.windowSetWidth, OWN, -5, 'left')).toThrow('invalid arguments')
    expect(handlers.setWidth).toHaveBeenCalledTimes(1)
  })

  it('routes the argument-free invoke channels', async () => {
    const { ipc, handlers } = setup()
    ipc.invoke(IPC_CHANNELS.windowHide, OWN)
    expect(handlers.hide).toHaveBeenCalledTimes(1)
    expect(ipc.invoke(IPC_CHANNELS.windowGetBounds, OWN)).toEqual(BOUNDS)
    expect(ipc.invoke(IPC_CHANNELS.prefsGet, OWN)).toEqual(DEFAULT_PREFS)
    expect(ipc.invoke(IPC_CHANNELS.getConfig, OWN)).toBeNull()
    await expect(ipc.invoke(IPC_CHANNELS.windowOpenSettings, OWN)).resolves.toEqual({ ok: true, value: { navigated: false } })
  })

  it('validates the send channels and drops malformed messages', () => {
    const { ipc, handlers, rejected } = setup()
    ipc.send(IPC_CHANNELS.ready, OWN, { editorMounted: true, draftLoaded: 'yes' })
    expect(handlers.ready).toHaveBeenCalledWith({ editorMounted: true, draftLoaded: false })
    ipc.send(IPC_CHANNELS.ready, OWN, 'ready')
    ipc.send(IPC_CHANNELS.flushed, OWN, 3)
    ipc.send(IPC_CHANNELS.flushed, OWN, 0)
    ipc.send(IPC_CHANNELS.flushed, OWN, 1.5)
    expect(handlers.flushed).toHaveBeenCalledTimes(1)
    expect(handlers.flushed).toHaveBeenCalledWith(3)
    ipc.send(IPC_CHANNELS.e2eDone, OWN, 4, { ok: true, data: { ms: 3 } })
    ipc.send(IPC_CHANNELS.e2eDone, OWN, 5, { ok: false, data: 'oops' })
    ipc.send(IPC_CHANNELS.e2eDone, OWN, 6, { data: {} })
    expect(handlers.e2eDone).toHaveBeenNthCalledWith(1, 4, { ok: true, data: { ms: 3 } })
    expect(handlers.e2eDone).toHaveBeenNthCalledWith(2, 5, { ok: false, data: {} })
    expect(handlers.e2eDone).toHaveBeenCalledTimes(2)
    ipc.send(IPC_CHANNELS.windowSetModalOpen, OWN, true)
    ipc.send(IPC_CHANNELS.windowSetModalOpen, OWN, 1)
    expect(handlers.setModalOpen).toHaveBeenCalledTimes(1)
    ipc.send(IPC_CHANNELS.windowSetMinWidth, OWN, 850)
    ipc.send(IPC_CHANNELS.windowSetMinWidth, OWN, Number.POSITIVE_INFINITY)
    expect(handlers.setMinWidth).toHaveBeenCalledTimes(1)
    ipc.send(IPC_CHANNELS.prefsSet, OWN, { panes: { library: true } })
    ipc.send(IPC_CHANNELS.prefsSet, OWN, ['panes'])
    expect(handlers.setPrefs).toHaveBeenCalledTimes(1)
    expect(rejected.map(([, why]) => why).every(why => why === 'arguments')).toBe(true)
    expect(rejected).toHaveLength(7)
  })
})

describe('bridge event payload types', () => {
  it('keeps the flush and e2e payloads small and id-based', () => {
    const flush: BridgeEvents['flush'] = { id: 1 }
    const e2e: BridgeEvents['e2e'] = { id: 2, action: 'state' }
    expect(flush.id + e2e.id).toBe(3)
  })
})
