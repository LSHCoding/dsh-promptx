// 小窗的预加载脚本（构建为 lib/app/preload.cjs）：用 contextBridge 把 window.promptx 交给渲染进程。
//
// - 运行时只 require 'electron'：沙箱预加载在 Electron 45 起只能 require 它（44 还能 require events 等，但不依赖）。
//   这里 import 的 shared 和 channels 都只有常量，构建时内联进来。
// - 只暴露白名单：call() 只转发 RENDERER_FORWARDED_METHODS，on() 只接收 BridgeEvents 里的事件；
//   主进程那边还会核对来源和参数，这里的检查只是第一道。
// - 不把 ipcRenderer 或 Electron 的事件对象交给页面：页面拿到 event.sender 就能给任意通道发消息。

import { contextBridge, ipcRenderer } from 'electron'
import {
  BRIDGE_KEY,
  type BridgeEventName,
  type BridgeEvents,
  type BridgeResult,
  type Prefs,
  type PromptxBridge,
  type ResolvedConfig,
  type WindowBounds,
} from '../../shared/bridge.ts'
import { RENDERER_FORWARDED_METHODS, type CompanionRequests, type RendererForwardedMethod } from '../../shared/protocol.ts'
import type { ErrorInfo } from '../../shared/types.ts'
import { BRIDGE_EVENT_NAMES, IPC_CHANNELS } from '../main/channels.ts'

type Listener = (payload: unknown) => void

const METHODS: ReadonlySet<string> = new Set(RENDERER_FORWARDED_METHODS)
const EVENTS: ReadonlySet<string> = new Set(BRIDGE_EVENT_NAMES)
const listeners = new Map<string, Set<Listener>>()

ipcRenderer.on(IPC_CHANNELS.event, (_event, name: unknown, payload: unknown) => {
  if (typeof name !== 'string' || !EVENTS.has(name)) return
  const set = listeners.get(name)
  if (set === undefined) return
  for (const listener of [...set]) {
    try {
      listener(payload)
    } catch {
      // 一个订阅者出错不影响其他订阅者；错误本身由页面自己的错误处理负责。
    }
  }
})

function failure<T>(code: string, detail?: string): BridgeResult<T> {
  const error: ErrorInfo = detail === undefined ? { code } : { code, detail }
  return { ok: false, error }
}

/** invoke 失败（主进程拒绝了来源、处理函数抛错、窗口正在关闭）时按 fallback 结束，不把异常抛给页面。 */
async function invokeResult<T>(channel: string, fallback: BridgeResult<T>, ...args: unknown[]): Promise<BridgeResult<T>> {
  try {
    const result: unknown = await ipcRenderer.invoke(channel, ...args)
    return result as BridgeResult<T>
  } catch {
    return fallback
  }
}

function call<M extends RendererForwardedMethod>(
  method: M,
  params: CompanionRequests[M]['params'],
): Promise<BridgeResult<CompanionRequests[M]['result']>> {
  if (!METHODS.has(method)) return Promise.resolve(failure('promptx/internal', 'method not allowed'))
  return invokeResult<CompanionRequests[M]['result']>(IPC_CHANNELS.call, failure('promptx/channel/closed'), method, params)
}

function on<E extends BridgeEventName>(event: E, listener: (payload: BridgeEvents[E]) => void): () => void {
  if (!EVENTS.has(event)) return () => {}
  let set = listeners.get(event)
  if (set === undefined) {
    set = new Set()
    listeners.set(event, set)
  }
  const subscribers = set
  const wrapped: Listener = (payload) => {
    listener(payload as BridgeEvents[E])
  }
  subscribers.add(wrapped)
  return () => {
    subscribers.delete(wrapped)
  }
}

async function invokeValue<T>(channel: string, ...args: unknown[]): Promise<T> {
  const result: unknown = await ipcRenderer.invoke(channel, ...args)
  return result as T
}

const bridge: PromptxBridge = {
  entryEditor: {
    open(relPath) {
      return invokeResult(IPC_CHANNELS.entryEditorOpen, failure('promptx/channel/closed'), relPath)
    },
    getState() {
      return invokeResult(IPC_CHANNELS.entryEditorGetState, failure('promptx/channel/closed'))
    },
    update(text, selection, generation) {
      ipcRenderer.send(IPC_CHANNELS.entryEditorUpdate, text, selection, generation)
    },
    prepared(id, generation, text, selection) {
      ipcRenderer.send(IPC_CHANNELS.entryEditorPrepared, id, generation, text, selection)
    },
    save(generation) {
      return invokeResult(IPC_CHANNELS.entryEditorSave, failure('promptx/channel/closed'), generation)
    },
    reload(generation) {
      return invokeResult(IPC_CHANNELS.entryEditorReload, failure('promptx/channel/closed'), generation)
    },
    async close(generation) {
      try {
        await ipcRenderer.invoke(IPC_CHANNELS.entryEditorClose, generation)
      } catch {
        // 窗口关闭过程中来源失效时无需继续处理。
      }
    },
  },
  platform: process.platform,
  call,
  on,
  ready(info) {
    ipcRenderer.send(IPC_CHANNELS.ready, { editorMounted: info.editorMounted, draftLoaded: info.draftLoaded })
  },
  flushed(id) {
    ipcRenderer.send(IPC_CHANNELS.flushed, id)
  },
  e2eDone(id, result) {
    ipcRenderer.send(IPC_CHANNELS.e2eDone, id, result)
  },
  async getConfig() {
    try {
      return await invokeValue<ResolvedConfig | null>(IPC_CHANNELS.getConfig)
    } catch {
      return null
    }
  },
  window: {
    async hide() {
      try {
        await ipcRenderer.invoke(IPC_CHANNELS.windowHide)
      } catch {
        // 主进程拒绝或窗口正在关闭：隐藏本来就是尽力而为。
      }
    },
    copyAndHide(text) {
      return invokeResult<null>(IPC_CHANNELS.windowCopyAndHide, failure('promptx/clipboard/write-failed'), text)
    },
    copyText(text) {
      return invokeResult<null>(IPC_CHANNELS.windowCopyText, failure('promptx/clipboard/write-failed'), text)
    },
    getBounds() {
      return invokeValue<WindowBounds>(IPC_CHANNELS.windowGetBounds)
    },
    setWidth(width, anchor) {
      return invokeValue<WindowBounds>(IPC_CHANNELS.windowSetWidth, width, anchor)
    },
    openSettings() {
      return invokeResult<{ navigated: boolean }>(IPC_CHANNELS.windowOpenSettings, failure('promptx/settings/unavailable'))
    },
    setModalOpen(open) {
      ipcRenderer.send(IPC_CHANNELS.windowSetModalOpen, open)
    },
    setMinWidth(width) {
      ipcRenderer.send(IPC_CHANNELS.windowSetMinWidth, width)
    },
  },
  prefs: {
    get() {
      return invokeValue<Prefs>(IPC_CHANNELS.prefsGet)
    },
    set(patch) {
      ipcRenderer.send(IPC_CHANNELS.prefsSet, patch)
    },
  },
}

contextBridge.exposeInMainWorld(BRIDGE_KEY, bridge)
