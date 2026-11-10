import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { IPC_CHANNELS } from '../../../src/app/main/channels.ts'
import { BRIDGE_KEY, type PromptxBridge } from '../../../src/shared/bridge.ts'
import { trapProcessErrors } from './helpers.ts'

trapProcessErrors()

type EventListener = (event: unknown, ...args: unknown[]) => void

/** 假的 electron 模块：只有预加载脚本用到的 contextBridge 和 ipcRenderer。 */
const electron = vi.hoisted(() => {
  const state = {
    exposed: new Map<string, unknown>(),
    listeners: new Map<string, ((event: unknown, ...args: unknown[]) => void)[]>(),
    invoke: null as unknown as (channel: string, ...args: unknown[]) => Promise<unknown>,
    sent: [] as unknown[][],
  }
  return {
    state,
    module: {
      contextBridge: {
        exposeInMainWorld: (key: string, api: unknown) => {
          state.exposed.set(key, api)
        },
      },
      ipcRenderer: {
        invoke: (channel: string, ...args: unknown[]) => state.invoke(channel, ...args),
        send: (channel: string, ...args: unknown[]) => {
          state.sent.push([channel, ...args])
        },
        on: (channel: string, listener: (event: unknown, ...args: unknown[]) => void) => {
          const list = state.listeners.get(channel) ?? []
          list.push(listener)
          state.listeners.set(channel, list)
        },
      },
    },
  }
})

vi.mock('electron', () => electron.module)

const invoke = vi.fn<(channel: string, ...args: unknown[]) => Promise<unknown>>()

async function loadPreload(): Promise<PromptxBridge> {
  vi.resetModules()
  electron.state.exposed.clear()
  electron.state.listeners.clear()
  electron.state.sent.length = 0
  invoke.mockReset()
  electron.state.invoke = invoke
  await import('../../../src/app/preload/index.ts')
  const bridge = electron.state.exposed.get(BRIDGE_KEY)
  if (bridge === undefined) throw new Error('preload did not expose the bridge')
  return bridge as PromptxBridge
}

/** 主进程经 webContents.send('promptx:event', 名称, 载荷) 推来的事件。 */
function pushEvent(name: unknown, payload: unknown): void {
  const listeners: EventListener[] = electron.state.listeners.get(IPC_CHANNELS.event) ?? []
  for (const listener of listeners) listener({ sender: 'ipc event object' }, name, payload)
}

let bridge: PromptxBridge

beforeEach(async () => {
  bridge = await loadPreload()
})

describe('preload: exposure', () => {
  it('forwards isolated entry actions and the document generation without exposing ipcRenderer', async () => {
    invoke.mockResolvedValue({ ok: true, value: null })
    await bridge.entryEditor.open('a.md')
    expect(invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.entryEditorOpen, 'a.md')
    bridge.entryEditor.update('正文', { anchor: 2, head: 2 }, 7)
    expect(electron.state.sent.at(-1)).toEqual([IPC_CHANNELS.entryEditorUpdate, '正文', { anchor: 2, head: 2 }, 7])
    bridge.entryEditor.prepared(11, 7, '最后文字', { anchor: 4, head: 4 })
    expect(electron.state.sent.at(-1)).toEqual([IPC_CHANNELS.entryEditorPrepared, 11, 7, '最后文字', { anchor: 4, head: 4 }])
    await bridge.entryEditor.save(7)
    expect(invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.entryEditorSave, 7)
    await bridge.entryEditor.reload(7)
    expect(invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.entryEditorReload, 7)
    await bridge.entryEditor.close(7)
    expect(invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.entryEditorClose, 7)
  })

  it('exposes window.promptx with the platform and nothing from Electron itself', () => {
    expect([...electron.state.exposed.keys()]).toEqual(['promptx'])
    expect(bridge.platform).toBe(process.platform)
    expect(Object.keys(bridge).sort()).toEqual(['call', 'e2eDone', 'entryEditor', 'flushed', 'getConfig', 'on', 'platform', 'prefs', 'ready', 'window'])
    expect(JSON.stringify(Object.keys(bridge.window).sort())).toBe(JSON.stringify(
      ['copyAndHide', 'copyText', 'getBounds', 'hide', 'openSettings', 'setMinWidth', 'setModalOpen', 'setWidth'],
    ))
  })

  it('imports nothing at runtime except electron (sandboxed preloads cannot require anything else)', () => {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../src/app/preload/index.ts')
    const seen = new Set<string>()
    const bare = new Set<string>()
    const visit = (file: string): void => {
      if (seen.has(file)) return
      seen.add(file)
      const source = readFileSync(file, 'utf8')
      // 只看值导入：`import type` 和花括号里全是 `type X` 的导入在构建时整个消失。
      for (const match of source.matchAll(/^import\s+(type\s+)?([^'"]*?)\s*from\s+'([^']+)'/gm)) {
        const [, typeOnly, clause = '', specifier = ''] = match
        if (typeOnly !== undefined) continue
        const names = clause.replace(/[{}]/g, '').split(',').map(name => name.trim()).filter(name => name !== '')
        if (names.length > 0 && names.every(name => name.startsWith('type '))) continue
        if (specifier.startsWith('.')) visit(resolve(dirname(file), specifier))
        else bare.add(specifier)
      }
    }
    visit(root)
    expect([...bare]).toEqual(['electron'])
    expect(seen.size).toBeGreaterThan(1)
  })
})

describe('preload: call', () => {
  it('forwards allowed methods through promptx:call and returns the BridgeResult', async () => {
    invoke.mockResolvedValue({ ok: true, value: { record: null } })
    await expect(bridge.call('draft.load', {})).resolves.toEqual({ ok: true, value: { record: null } })
    expect(invoke).toHaveBeenCalledWith(IPC_CHANNELS.call, 'draft.load', {})
  })

  it('refuses methods outside the allow-list without touching IPC', async () => {
    // 页面可以传任何字符串，绕开类型声明去调用。
    const loose = bridge as unknown as { call(method: string, params: unknown): Promise<unknown> }
    for (const method of ['hello', 'host.openSettings', 'shutdown', 'toString']) {
      await expect(loose.call(method, {})).resolves.toEqual({ ok: false, error: { code: 'promptx/internal', detail: 'method not allowed' } })
    }
    expect(invoke).not.toHaveBeenCalled()
  })

  it('turns an IPC failure into a channel-closed result instead of throwing into the page', async () => {
    invoke.mockRejectedValue(new Error('untrusted sender'))
    await expect(bridge.call('optimize.state', {})).resolves.toEqual({ ok: false, error: { code: 'promptx/channel/closed' } })
  })
})

describe('preload: events', () => {
  it('delivers whitelisted events to their subscribers until they unsubscribe', () => {
    const received: unknown[] = []
    const off = bridge.on('window.shown', (payload) => {
      received.push(payload)
    })
    pushEvent('window.shown', {})
    pushEvent('window.hidden', {})
    off()
    pushEvent('window.shown', {})
    expect(received).toEqual([{}])
  })

  it('never passes the Electron event object to the page', () => {
    const received: unknown[][] = []
    bridge.on('flush', (...args: unknown[]) => {
      received.push(args)
    })
    pushEvent('flush', { id: 3 })
    expect(received).toEqual([[{ id: 3 }]])
  })

  it('ignores unknown event names from either side', () => {
    const received: unknown[] = []
    const loose = bridge as unknown as { on(event: string, listener: (payload: unknown) => void): () => void }
    const off = loose.on('ipc-internal', (payload) => {
      received.push(payload)
    })
    pushEvent('ipc-internal', 'x')
    pushEvent(42, 'x')
    expect(received).toEqual([])
    expect(() => {
      off()
    }).not.toThrow()
  })

  it('keeps delivering to other subscribers when one throws', () => {
    const received: unknown[] = []
    bridge.on('config', () => {
      throw new Error('page bug')
    })
    bridge.on('config', (payload) => {
      received.push(payload)
    })
    pushEvent('config', { resolvedLocale: 'zh' })
    expect(received).toEqual([{ resolvedLocale: 'zh' }])
  })
})

describe('preload: one-way messages', () => {
  it('sends ready, flushed, e2eDone, modal, min width and prefs on their channels', () => {
    bridge.ready({ editorMounted: true, draftLoaded: false })
    bridge.flushed(4)
    bridge.e2eDone(5, { ok: true, data: { ms: 1 } })
    bridge.window.setModalOpen(true)
    bridge.window.setMinWidth(660)
    bridge.prefs.set({ panes: { library: true, folderWidth: 150, listWidth: 300, previewHeight: 232, sessionWidth: 420 } })
    expect(electron.state.sent).toEqual([
      [IPC_CHANNELS.ready, { editorMounted: true, draftLoaded: false }],
      [IPC_CHANNELS.flushed, 4],
      [IPC_CHANNELS.e2eDone, 5, { ok: true, data: { ms: 1 } }],
      [IPC_CHANNELS.windowSetModalOpen, true],
      [IPC_CHANNELS.windowSetMinWidth, 660],
      [IPC_CHANNELS.prefsSet, { panes: { library: true, folderWidth: 150, listWidth: 300, previewHeight: 232, sessionWidth: 420 } }],
    ])
  })
})

describe('preload: window and prefs requests', () => {
  it('copies through the main process and reports failures as results', async () => {
    invoke.mockResolvedValueOnce({ ok: true, value: null })
    await expect(bridge.window.copyAndHide('全文')).resolves.toEqual({ ok: true, value: null })
    expect(invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.windowCopyAndHide, '全文')
    invoke.mockRejectedValueOnce(new Error('gone'))
    await expect(bridge.window.copyText('x')).resolves.toEqual({ ok: false, error: { code: 'promptx/clipboard/write-failed' } })
    expect(invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.windowCopyText, 'x')
  })

  it('opens settings and falls back to settings/unavailable', async () => {
    invoke.mockResolvedValueOnce({ ok: true, value: { navigated: true } })
    await expect(bridge.window.openSettings()).resolves.toEqual({ ok: true, value: { navigated: true } })
    invoke.mockRejectedValueOnce(new Error('gone'))
    await expect(bridge.window.openSettings()).resolves.toEqual({ ok: false, error: { code: 'promptx/settings/unavailable' } })
  })

  it('hides without throwing even when the main process refuses', async () => {
    invoke.mockRejectedValueOnce(new Error('gone'))
    await expect(bridge.window.hide()).resolves.toBeUndefined()
    expect(invoke).toHaveBeenCalledWith(IPC_CHANNELS.windowHide)
  })

  it('reads bounds, sets the width, reads config and prefs', async () => {
    const bounds = { x: 1, y: 2, width: 3, height: 4, workArea: { x: 0, y: 0, width: 10, height: 10 } }
    invoke.mockResolvedValue(bounds)
    await expect(bridge.window.getBounds()).resolves.toEqual(bounds)
    await expect(bridge.window.setWidth(900, 'right')).resolves.toEqual(bounds)
    expect(invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.windowSetWidth, 900, 'right')
    invoke.mockResolvedValueOnce({ version: 1 })
    await expect(bridge.prefs.get()).resolves.toEqual({ version: 1 })
    invoke.mockResolvedValueOnce(null)
    await expect(bridge.getConfig()).resolves.toBeNull()
    invoke.mockRejectedValueOnce(new Error('gone'))
    await expect(bridge.getConfig()).resolves.toBeNull()
  })
})
