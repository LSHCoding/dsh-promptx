// 主进程的 IPC 处理（design-spec 5.3 末段、9「渲染进程越权调用」）。
//
// - 每个处理函数先核对 event.sender 就是小窗自己的 webContents，其他来源一律拒绝；
// - call 只转发 RENDERER_FORWARDED_METHODS 里的方法给 Host（hello 由主进程自己发，ping/shutdown 是 Host 发来的）；
// - 参数先做类型检查再交给处理函数，Host 收到后还会再校验一遍。
// 预加载脚本那边也有一份同样的白名单，这里不依赖它：渲染进程被攻破时预加载的检查可以被绕过，主进程这一层不能。

import type { BridgeResult, Prefs, ResolvedConfig, WindowBounds } from '../../shared/bridge.ts'
import { RENDERER_FORWARDED_METHODS, type RendererForwardedMethod } from '../../shared/protocol.ts'
import { IPC_CHANNELS } from './channels.ts'

export interface IpcEventLike {
  sender: unknown
}

/** ipcMain 的子集。 */
export interface IpcMainLike {
  handle(channel: string, listener: (event: IpcEventLike, ...args: unknown[]) => unknown): void
  on(channel: string, listener: (event: IpcEventLike, ...args: unknown[]) => void): void
}

export interface ReadyInfo {
  editorMounted: boolean
  draftLoaded: boolean
}

export interface E2eRendererResult {
  ok: boolean
  data: Record<string, unknown>
}

export interface IpcHandlers {
  call(method: RendererForwardedMethod, params: Record<string, unknown>): Promise<BridgeResult<unknown>>
  getConfig(): ResolvedConfig | null
  hide(): void
  copyAndHide(text: string): Promise<BridgeResult<null>>
  copyText(text: string): Promise<BridgeResult<null>>
  getBounds(): WindowBounds
  setWidth(width: number, anchor: 'left' | 'right'): WindowBounds
  openSettings(): Promise<BridgeResult<{ navigated: boolean }>>
  getPrefs(): Prefs
  ready(info: ReadyInfo): void
  flushed(id: number): void
  e2eDone(id: number, result: E2eRendererResult): void
  setModalOpen(open: boolean): void
  setMinWidth(width: number): void
  setPrefs(patch: Record<string, unknown>): void
}

export type IpcRejection = 'sender' | 'arguments'

export interface RegisterIpcOptions {
  /** 消息是否来自小窗自己的 webContents。 */
  isTrusted: (sender: unknown) => boolean
  handlers: IpcHandlers
  /** 被拒绝时调用（只传通道名和原因），用于记日志。 */
  onRejected?: (channel: string, why: IpcRejection) => void
}

const FORWARDED: ReadonlySet<string> = new Set(RENDERER_FORWARDED_METHODS)

export function isForwardedMethod(value: unknown): value is RendererForwardedMethod {
  return typeof value === 'string' && FORWARDED.has(value)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const proto: unknown = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function isId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

const INVALID = { code: 'promptx/internal', detail: 'invalid arguments' } as const

/** 未受信任的来源调用 invoke 类通道时抛出的错误（渲染进程那边的 invoke 以失败结束）。 */
export class UntrustedSenderError extends Error {
  constructor(channel: string) {
    super(`untrusted sender on ${channel}`)
    this.name = 'UntrustedSenderError'
  }
}

export function registerIpcHandlers(ipc: IpcMainLike, options: RegisterIpcOptions): void {
  const { isTrusted, handlers } = options
  const rejected = options.onRejected ?? (() => {})

  /** invoke 类：来源不对时抛错，参数不对时由各通道自己决定返回什么。 */
  const handle = (channel: string, run: (args: unknown[]) => unknown): void => {
    ipc.handle(channel, (event, ...args) => {
      if (!isTrusted(event.sender)) {
        rejected(channel, 'sender')
        throw new UntrustedSenderError(channel)
      }
      return run(args)
    })
  }

  /** send 类：来源不对、参数不对都直接忽略。 */
  const listen = (channel: string, run: (args: unknown[]) => boolean): void => {
    ipc.on(channel, (event, ...args) => {
      if (!isTrusted(event.sender)) {
        rejected(channel, 'sender')
        return
      }
      if (!run(args)) rejected(channel, 'arguments')
    })
  }

  handle(IPC_CHANNELS.call, ([method, params]) => {
    if (!isForwardedMethod(method) || !(params === undefined || isPlainObject(params))) {
      rejected(IPC_CHANNELS.call, 'arguments')
      return Promise.resolve({ ok: false, error: INVALID })
    }
    return handlers.call(method, params ?? {})
  })

  handle(IPC_CHANNELS.getConfig, () => handlers.getConfig())

  handle(IPC_CHANNELS.windowHide, () => {
    handlers.hide()
  })

  handle(IPC_CHANNELS.windowCopyAndHide, ([text]) => {
    if (typeof text !== 'string') {
      rejected(IPC_CHANNELS.windowCopyAndHide, 'arguments')
      return Promise.resolve({ ok: false, error: { code: 'promptx/clipboard/write-failed', detail: 'invalid arguments' } })
    }
    return handlers.copyAndHide(text)
  })

  handle(IPC_CHANNELS.windowCopyText, ([text]) => {
    if (typeof text !== 'string') {
      rejected(IPC_CHANNELS.windowCopyText, 'arguments')
      return Promise.resolve({ ok: false, error: { code: 'promptx/clipboard/write-failed', detail: 'invalid arguments' } })
    }
    return handlers.copyText(text)
  })

  handle(IPC_CHANNELS.windowGetBounds, () => handlers.getBounds())

  handle(IPC_CHANNELS.windowSetWidth, ([width, anchor]) => {
    if (!isFiniteNumber(width) || width <= 0 || (anchor !== 'left' && anchor !== 'right')) {
      rejected(IPC_CHANNELS.windowSetWidth, 'arguments')
      throw new Error('invalid arguments')
    }
    return handlers.setWidth(width, anchor)
  })

  handle(IPC_CHANNELS.windowOpenSettings, () => handlers.openSettings())

  handle(IPC_CHANNELS.prefsGet, () => handlers.getPrefs())

  listen(IPC_CHANNELS.ready, ([info]) => {
    if (!isPlainObject(info)) return false
    handlers.ready({ editorMounted: info.editorMounted === true, draftLoaded: info.draftLoaded === true })
    return true
  })

  listen(IPC_CHANNELS.flushed, ([id]) => {
    if (!isId(id)) return false
    handlers.flushed(id)
    return true
  })

  listen(IPC_CHANNELS.e2eDone, ([id, result]) => {
    if (!isId(id) || !isPlainObject(result) || typeof result.ok !== 'boolean') return false
    handlers.e2eDone(id, { ok: result.ok, data: isPlainObject(result.data) ? result.data : {} })
    return true
  })

  listen(IPC_CHANNELS.windowSetModalOpen, ([open]) => {
    if (typeof open !== 'boolean') return false
    handlers.setModalOpen(open)
    return true
  })

  listen(IPC_CHANNELS.windowSetMinWidth, ([width]) => {
    if (!isFiniteNumber(width) || width < 0) return false
    handlers.setMinWidth(width)
    return true
  })

  listen(IPC_CHANNELS.prefsSet, ([patch]) => {
    if (!isPlainObject(patch)) return false
    handlers.setPrefs(patch)
    return true
  })
}
