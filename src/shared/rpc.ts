// JSON-RPC 2.0 的一端，Host 和小程序主进程共用。只管消息的收发、配对和超时，不管传输：
// 收到的帧由调用方喂给 receive()，要发的帧交给构造时传入的 send()。
// 设计参照 Azetus/dsh-quorfloat（MIT，Copyright (c) 2026 Azetus）的 src/bridge/channel.ts：
// 请求 id 每个方向各自递增；超时不代表对方没执行；通道关闭时所有在途请求立即失败。

import { PromptxError, toErrorInfo } from './errors.ts'
import { RPC_ERROR } from './protocol.ts'
import type { ErrorInfo } from './types.ts'

/**
 * 一组方法：方法名 → { params, result }。写成映射类型而不是 Record<string, …>，
 * 这样用 interface 声明的方法表（没有隐式索引签名）也满足约束。
 */
export type RequestMapOf<T> = { [K in keyof T]: { params: unknown; result: unknown } }

/** 请求失败。rpcCode 是 JSON-RPC 错误码，info 是业务错误（错误码 + 系统错误信息）。 */
export class RpcError extends Error {
  readonly rpcCode: number
  readonly info: ErrorInfo

  constructor(rpcCode: number, info: ErrorInfo) {
    super(info.detail === undefined ? info.code : `${info.code}: ${info.detail}`)
    this.name = 'RpcError'
    this.rpcCode = rpcCode
    this.info = info
  }
}

export interface RpcPeerOptions {
  /** 发出一帧。传输已关闭时应抛出异常。 */
  send: (message: unknown) => void
  defaultTimeoutMs: number
  /** 处理函数抛出非业务异常、收到无法识别的消息时调用，用于记日志（不含用户内容）。 */
  onProblem?: (problem: string) => void
}

type Handler = (params: unknown) => unknown
type Listener = (params: unknown) => void

interface Pending {
  resolve: (value: unknown) => void
  reject: (error: RpcError) => void
  timer: ReturnType<typeof setTimeout>
}

/**
 * Out：本端可以发出的请求和通知；In：本端处理的请求和通知。
 * 处理函数返回值作为结果；抛出 PromptxError 时以业务错误回复，其他异常一律回复 promptx/internal。
 */
export class RpcPeer<
  OutReq extends RequestMapOf<OutReq>,
  OutNote extends object,
  InReq extends RequestMapOf<InReq>,
  InNote extends object,
> {
  readonly #send: (message: unknown) => void
  readonly #defaultTimeoutMs: number
  readonly #onProblem: (problem: string) => void
  readonly #handlers = new Map<string, Handler>()
  readonly #listeners = new Map<string, Set<Listener>>()
  readonly #pending = new Map<number, Pending>()
  #nextId = 1
  #closed: ErrorInfo | null = null

  constructor(options: RpcPeerOptions) {
    this.#send = options.send
    this.#defaultTimeoutMs = options.defaultTimeoutMs
    this.#onProblem = options.onProblem ?? (() => {})
  }

  get closed(): boolean {
    return this.#closed !== null
  }

  /** 注册请求处理函数。同一个方法只能注册一次。 */
  handle<M extends keyof InReq & string>(method: M, handler: (params: InReq[M]['params']) => InReq[M]['result'] | Promise<InReq[M]['result']>): void {
    if (this.#handlers.has(method)) throw new Error(`duplicate handler: ${method}`)
    this.#handlers.set(method, handler)
  }

  /** 订阅通知，返回取消订阅的函数。 */
  on<M extends keyof InNote & string>(method: M, listener: (params: InNote[M]) => void): () => void {
    let set = this.#listeners.get(method)
    if (set === undefined) {
      set = new Set()
      this.#listeners.set(method, set)
    }
    set.add(listener as Listener)
    return () => set.delete(listener as Listener)
  }

  /** 已注册处理函数的方法名（测试用来核对方法表）。 */
  handledMethods(): string[] {
    return [...this.#handlers.keys()]
  }

  request<M extends keyof OutReq & string>(method: M, params: OutReq[M]['params'], options: { timeoutMs?: number } = {}): Promise<OutReq[M]['result']> {
    if (this.#closed !== null) return Promise.reject(new RpcError(RPC_ERROR.channelClosed, this.#closed))
    const id = this.#nextId++
    const timeoutMs = options.timeoutMs ?? this.#defaultTimeoutMs
    return new Promise<OutReq[M]['result']>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id)
        reject(new RpcError(RPC_ERROR.timeout, { code: 'promptx/channel/timeout', detail: method }))
      }, timeoutMs)
      // 计时器不应阻止进程退出。浏览器里 setTimeout 返回数字，没有 unref。
      ;(timer as { unref?: () => void }).unref?.()
      this.#pending.set(id, { resolve: resolve, reject, timer })
      try {
        this.#send({ jsonrpc: '2.0', id, method, params })
      } catch (error) {
        clearTimeout(timer)
        this.#pending.delete(id)
        reject(new RpcError(RPC_ERROR.channelClosed, toErrorInfo(error, 'promptx/channel/closed')))
      }
    })
  }

  /** 发通知。通道已关闭时静默丢弃（通知本来就不保证送达）。 */
  notify<M extends keyof OutNote & string>(method: M, params: OutNote[M]): void {
    if (this.#closed !== null) return
    try {
      this.#send({ jsonrpc: '2.0', method, params })
    } catch {
      // 传输已断开：由传输层的关闭事件统一处理。
    }
  }

  /** 喂入一条解码后的消息。 */
  receive(message: unknown): void {
    if (!isRecord(message) || message.jsonrpc !== '2.0') {
      this.#onProblem('invalid-message')
      return
    }
    if (typeof message.method === 'string') {
      const hasId = typeof message.id === 'number' || typeof message.id === 'string'
      if (hasId) {
        // #handleRequest 自己捕获处理函数的异常；这里的 catch 只兜底，防止任何拒绝变成未处理的 Promise。
        this.#handleRequest(message.id as number | string, message.method, message.params).catch(() => {
          this.#onProblem(`request-failed: ${String(message.method)}`)
        })
      } else {
        this.#handleNotification(message.method, message.params)
      }
      return
    }
    if (typeof message.id === 'number') {
      this.#handleResponse(message.id, message)
      return
    }
    this.#onProblem('invalid-message')
  }

  /** 关闭：所有在途请求以 channel/closed 失败，之后的请求立即失败。 */
  close(info: ErrorInfo = { code: 'promptx/channel/closed' }): void {
    if (this.#closed !== null) return
    this.#closed = info
    for (const [id, pending] of this.#pending) {
      clearTimeout(pending.timer)
      this.#pending.delete(id)
      pending.reject(new RpcError(RPC_ERROR.channelClosed, info))
    }
  }

  async #handleRequest(id: number | string, method: string, params: unknown): Promise<void> {
    const handler = this.#handlers.get(method)
    if (handler === undefined) {
      this.#reply({ jsonrpc: '2.0', id, error: { code: RPC_ERROR.methodNotFound, message: `method not found: ${method}` } })
      return
    }
    try {
      const result = await handler(params ?? {})
      this.#reply({ jsonrpc: '2.0', id, result: result ?? {} })
    } catch (error) {
      if (!(error instanceof PromptxError)) this.#onProblem(`handler-failed: ${method}`)
      const info = toErrorInfo(error)
      this.#reply({ jsonrpc: '2.0', id, error: { code: RPC_ERROR.business, message: info.code, data: info } })
    }
  }

  #handleNotification(method: string, params: unknown): void {
    const set = this.#listeners.get(method)
    if (set === undefined) return
    for (const listener of [...set]) {
      try {
        listener(params ?? {})
      } catch {
        this.#onProblem(`listener-failed: ${method}`)
      }
    }
  }

  #handleResponse(id: number, message: Record<string, unknown>): void {
    const pending = this.#pending.get(id)
    if (pending === undefined) return // 已超时或重复的回复
    this.#pending.delete(id)
    clearTimeout(pending.timer)
    if ('error' in message && isRecord(message.error)) {
      const error = message.error
      const rpcCode = typeof error.code === 'number' ? error.code : RPC_ERROR.internal
      const data = error.data
      const info: ErrorInfo = isRecord(data) && typeof data.code === 'string'
        ? (typeof data.detail === 'string' ? { code: data.code, detail: data.detail } : { code: data.code })
        : { code: 'promptx/internal', detail: typeof error.message === 'string' ? error.message : 'unknown error' }
      pending.reject(new RpcError(rpcCode, info))
      return
    }
    pending.resolve(message.result)
  }

  #reply(message: unknown): void {
    if (this.#closed !== null) return
    try {
      this.#send(message)
    } catch {
      // 对方已断开，回复不了。
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
