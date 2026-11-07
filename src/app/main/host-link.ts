// 和 Host 的连接：stdin 收帧、stdout 发帧（NDJSON + JSON-RPC 2.0，design-spec 5.3）。
// 只管传输和连接的生死；方法的处理在 app.ts 注册。
//
// - stdin 结束或出错：Host 退出了或者被杀了，交给 onClose 退出（防孤儿，design-spec 5.2）。
//   stdin 结束时不立即关掉 RpcPeer：stdout 可能还通着，退出前写回草稿的请求还有机会送到。
// - stdout 出错（EPIPE）：再也发不出去了，关掉 RpcPeer，让在途请求立即失败。
// - whenWritten：回复 shutdown 之后要等这一帧真的写进管道再退出，macOS 上写管道是异步的，直接 exit 会丢掉回复。

import { encodeFrame, FrameDecoder } from '../../shared/ndjson.ts'
import {
  DEFAULT_REQUEST_TIMEOUT_MS,
  MAX_FRAME_BYTES,
  type CompanionNotifications,
  type CompanionRequests,
  type HostNotifications,
  type HostRequests,
} from '../../shared/protocol.ts'
import { RpcPeer } from '../../shared/rpc.ts'
import { errorCode, type CompanionLogger } from './logger.ts'

/** 小程序一侧的协议端：发小程序的请求和通知，处理 Host 的请求和通知。 */
export type CompanionPeer = RpcPeer<CompanionRequests, CompanionNotifications, HostRequests, HostNotifications>

export interface InputStream {
  on(event: 'data', listener: (chunk: Uint8Array) => void): unknown
  on(event: 'end', listener: () => void): unknown
  on(event: 'error', listener: (error: Error) => void): unknown
  resume(): unknown
}

export interface OutputStream {
  write(chunk: string, callback: (error?: Error | null) => void): boolean
  on(event: 'error', listener: (error: Error) => void): unknown
}

export type HostLinkClose = 'stdin-end' | 'stdin-error' | 'stdout-error'

export interface HostLinkOptions {
  input: InputStream
  output: OutputStream
  logger: CompanionLogger
  /** 连接断了（只调用一次）。 */
  onClose: (why: HostLinkClose) => void
  defaultTimeoutMs?: number
}

export class HostLink {
  readonly peer: CompanionPeer
  readonly #input: InputStream
  readonly #output: OutputStream
  readonly #logger: CompanionLogger
  readonly #onClose: (why: HostLinkClose) => void
  readonly #decoder: FrameDecoder
  #pendingWrites = 0
  #outputClosed = false
  #closed = false
  #started = false
  readonly #idleWaiters: (() => void)[] = []

  constructor(options: HostLinkOptions) {
    this.#input = options.input
    this.#output = options.output
    this.#logger = options.logger
    this.#onClose = options.onClose
    this.peer = new RpcPeer({
      send: (message) => {
        this.#write(message)
      },
      defaultTimeoutMs: options.defaultTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      onProblem: (problem) => {
        // problem 是方法名和固定的原因，不含参数。
        this.#logger.warn('rpc.problem', { problem: problem.replace(/[^A-Za-z0-9_.:/@+-]/g, '_') })
      },
    })
    this.#decoder = new FrameDecoder({
      maxFrameBytes: MAX_FRAME_BYTES,
      onFrame: (value) => {
        this.peer.receive(value)
      },
      onReject: (reason) => {
        this.#logger.warn('frame.rejected', { reason })
      },
    })
  }

  get closed(): boolean {
    return this.#closed
  }

  start(): void {
    if (this.#started) return
    this.#started = true
    this.#output.on('error', (error) => {
      this.#outputClosed = true
      this.peer.close({ code: 'promptx/channel/closed', detail: 'stdout' })
      this.#flushIdleWaiters()
      this.#close('stdout-error', error)
    })
    this.#input.on('data', (chunk) => {
      this.#decoder.push(chunk)
    })
    this.#input.on('end', () => {
      this.#decoder.end()
      this.#close('stdin-end', null)
    })
    this.#input.on('error', (error) => {
      this.#close('stdin-error', error)
    })
    this.#input.resume()
  }

  /** 已交给 stdout 的帧都写完（或 stdout 已断开）后 resolve；最多等 maxMs。 */
  whenWritten(maxMs: number): Promise<void> {
    if (this.#pendingWrites === 0 || this.#outputClosed) return Promise.resolve()
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        resolve()
      }, maxMs)
      this.#idleWaiters.push(() => {
        clearTimeout(timer)
        resolve()
      })
    })
  }

  #write(message: unknown): void {
    // RpcPeer 约定：传输已关闭时抛出，请求随即以 channel/closed 失败。
    if (this.#outputClosed) throw new Error('stdout closed')
    this.#pendingWrites++
    this.#output.write(encodeFrame(message), (error) => {
      this.#pendingWrites--
      if (error !== undefined && error !== null) this.#outputClosed = true
      if (this.#pendingWrites === 0 || this.#outputClosed) this.#flushIdleWaiters()
    })
  }

  #flushIdleWaiters(): void {
    for (const waiter of this.#idleWaiters.splice(0)) waiter()
  }

  #close(why: HostLinkClose, error: Error | null): void {
    if (this.#closed) return
    this.#closed = true
    // 只记错误码：EPIPE 这类系统错误的 message 里没有内容，但日志接口一律不收原始异常。
    this.#logger.warn('host.link-closed', { why, error: error === null ? null : errorCode(error) })
    try {
      this.#onClose(why)
    } catch {
      // 退出流程自己记日志。
    }
  }
}
