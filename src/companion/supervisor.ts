// 小程序进程的监管：启动、握手、心跳、自动重启、停止（需求 F-06、N-02；design-spec 4.1、5.2、5.3）。
//
// 改编自 Azetus/dsh-quorfloat（MIT，Copyright (c) 2026 Azetus）的 src/host/supervisor.ts 和 src/bridge/channel.ts。
// 沿用的做法：一次只管一个子进程，每次启动有代号，旧代号的回调一律忽略；只有收到 hello 并回复后才算 running；
// 退出事件、管道关闭、心跳失败可能同时到达，只有第一个触发重启；停止时先发 shutdown 请求，再依次升级到 SIGTERM、SIGKILL，
// 以进程真正退出为准。相对原实现补上了：
// - 每次启动前由 prepareLaunch 准备运行时（还在下载就等着），失败直接 failed，不进重启循环；
// - ChildProcess 和三个管道一创建就挂 error 监听（原实现到 channel.start() 才挂，中间可执行文件不存在就是未捕获的异常）；
// - 管道关了但进程还在时先杀掉它，确认退出后再启动新的；写缓冲超过 8 MiB 按通道失效处理；
// - stderr 只记前 200 行；hello 的协议版本不对时用 -32001 回复并停在 failed，不重试；
// - 帧格式和请求配对用两端共用的 shared/ndjson.ts、shared/rpc.ts。

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { homedir } from 'node:os'
import { StringDecoder } from 'node:string_decoder'

import { background } from '../background.ts'
import type { HostLogger, HostPeer, LaunchSpec, SupervisorApi, SupervisorOptions } from '../services.ts'
import { PromptxError, toErrorInfo } from '../shared/errors.ts'
import { encodeFrame, FrameDecoder, type FrameRejection } from '../shared/ndjson.ts'
import {
  DEFAULT_REQUEST_TIMEOUT_MS,
  MAX_FRAME_BYTES,
  PROTOCOL_VERSION,
  RPC_ERROR,
  type CompanionNotifications,
  type CompanionRequests,
  type HelloResult,
  type HostNotifications,
  type HostRequests,
} from '../shared/protocol.ts'
import { RpcPeer } from '../shared/rpc.ts'
import type { CompanionState, ErrorInfo } from '../shared/types.ts'
import { errnoCode, errorDetail } from './process-utils.ts'

/** 写给小程序、它还没读走的数据超过这么多，就按通道失效处理：它卡住了，再写只会让 Host 的内存一直涨。 */
export const MAX_PENDING_WRITE_BYTES = 8 * 1024 * 1024
/** stderr 只记前 200 行到 Host 日志（debug），之后丢弃；小程序自己的日志写文件（design-spec 5.2）。 */
export const STDERR_LINE_LIMIT = 200
/** 一行 stderr 最多记这么多字；没有换行的超长输出也只留这么多，不让它在内存里越积越多。 */
const STDERR_LINE_CHARS = 1_000
/** 坏帧只计数，前 20 个记日志。 */
const REJECTED_FRAME_LOG_LIMIT = 20

type Timings = Required<NonNullable<SupervisorOptions['timings']>>

/** design-spec 5.2 的时序。停止链 2 + 1 + 0.5 + 0.5 = 4 秒，在 dsh 退出给的 5 秒以内。 */
export const DEFAULT_TIMINGS: Readonly<Timings> = {
  handshakeMs: 15_000,
  heartbeatMs: 5_000,
  heartbeatTimeoutMs: 3_000,
  heartbeatMissLimit: 3,
  restartWindowMs: 30_000,
  restartLimit: 3,
  backoffMs: [500, 1_000, 2_000],
  shutdownGraceMs: 2_000,
  exitWaitMs: 1_000,
  killWaitMs: 500,
}

/** 一次启动的进程和它的连接。 */
interface Run {
  readonly generation: number
  readonly child: ChildProcessWithoutNullStreams
  readonly peer: HostPeer
  readonly pid: number | undefined
  readonly decoder: FrameDecoder
  readonly exitWaiters: Set<() => void>
  readonly stderr: { lines: number; partial: string; decoder: StringDecoder }
  handshaken: boolean
  /** 这次连接已经按失去处理过（或协议不匹配）：之后到达的退出、管道关闭、心跳失败都不再触发重启。 */
  lost: boolean
  /** stdout 或 stdin 已经关闭或出错。 */
  transportDown: boolean
  /** 进程已经退出（或者根本没起来）。 */
  exited: boolean
  handshakeTimer: NodeJS.Timeout | undefined
  heartbeatTimer: NodeJS.Timeout | undefined
  transportTimer: NodeJS.Timeout | undefined
  pingInFlight: boolean
  misses: number
  rejectedFrames: number
}

export class CompanionSupervisor implements SupervisorApi {
  readonly #options: SupervisorOptions
  readonly #timings: Timings
  readonly #logger: HostLogger
  readonly #runs = new Set<Run>()
  #state: CompanionState = 'stopped'
  #error: ErrorInfo | undefined
  #exhausted = false
  #generation = 0
  /** 重启窗口内的失败时刻。 */
  #failures: number[] = []
  #current: Run | null = null
  #peer: HostPeer | null = null
  #launchAbort: AbortController | null = null
  #restartTimer: NodeJS.Timeout | undefined
  #stopping: Promise<void> | null = null
  #startAfterStop = false

  constructor(options: SupervisorOptions) {
    this.#options = options
    this.#logger = options.logger ?? silentLogger
    const timings: Timings = { ...DEFAULT_TIMINGS, ...options.timings }
    if (timings.backoffMs.length === 0) timings.backoffMs = [...DEFAULT_TIMINGS.backoffMs]
    this.#timings = timings
  }

  state(): CompanionState {
    return this.#state
  }

  error(): ErrorInfo | undefined {
    return this.#error === undefined ? undefined : { ...this.#error }
  }

  restartsExhausted(): boolean {
    return this.#exhausted
  }

  peer(): HostPeer | null {
    return this.#peer
  }

  /** 当前小程序进程的 pid（配置页显示，手工验收时用来结束进程）；没有在运行的进程时为 undefined。 */
  pid(): number | undefined {
    const run = this.#current
    return run !== null && !run.exited ? run.pid : undefined
  }

  start(): void {
    if (this.#stopping !== null) {
      // 正在停止：等停完再启动，避免新旧两个进程同时在跑。
      this.#startAfterStop = true
      return
    }
    if (this.#state !== 'stopped' && this.#state !== 'failed') return
    this.#freshStart()
  }

  stop(reason: string): Promise<void> {
    // 以最后一次调用为准：停止之前排队的 start() 作废。
    this.#startAfterStop = false
    if (this.#stopping !== null) return this.#stopping
    const stopping = this.#shutdown(reason).finally(() => {
      this.#stopping = null
      if (this.#startAfterStop) {
        this.#startAfterStop = false
        this.#freshStart()
      }
    })
    this.#stopping = stopping
    return stopping
  }

  async restart(): Promise<void> {
    await this.stop('restart')
    this.start()
  }

  // ───────────────────────────── 启动 ─────────────────────────────

  /** 手动启动（含重启）：重置失败计数（F-06「手动重启」）。 */
  #freshStart(): void {
    this.#failures = []
    this.#exhausted = false
    this.#launch()
  }

  #launch(): void {
    this.#generation += 1
    const generation = this.#generation
    const controller = new AbortController()
    this.#launchAbort = controller
    this.#setState('waiting-runtime', undefined)
    background(this.#logger, 'companion launch', this.#prepareAndSpawn(generation, controller.signal))
  }

  async #prepareAndSpawn(generation: number, signal: AbortSignal): Promise<void> {
    let spec: LaunchSpec
    try {
      spec = await this.#options.prepareLaunch(signal)
    } catch (error) {
      if (generation !== this.#generation) return
      this.#launchAbort = null
      // 运行时没准备好（下载失败、平台不支持、删除后暂停）：重启解决不了，停在 failed，等用户在配置页处理。
      const info = toErrorInfo(error)
      this.#logger.warn('companion cannot start: %s%s', info.code, detailSuffix(info))
      this.#exhausted = false
      this.#setState('failed', info)
      return
    }
    if (generation !== this.#generation) return
    // 管道关了不等于进程退了：之前的进程都确认结束了，再启动新的。
    await Promise.all([...this.#runs].map(run => this.#terminate(run)))
    if (generation !== this.#generation) return
    this.#launchAbort = null
    this.#spawn(generation, spec)
  }

  #spawn(generation: number, spec: LaunchSpec): void {
    // peer 发出的消息写到这次启动的进程。进程还没起来时（attach 里就同步发了请求或通知）按通道未连通处理：
    // RpcPeer 会让请求以 channel/closed 失败、通知静默丢弃，不会写到上一个进程，也不会抛到调用方。
    let target: Run | null = null
    // 先建好 peer、让调用方注册处理函数，再启动进程：小程序的第一帧到达时处理函数一定已经就位。
    const peer = new RpcPeer<HostRequests, HostNotifications, CompanionRequests, CompanionNotifications>({
      defaultTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
      send: (message) => {
        if (target === null) throw new PromptxError('promptx/channel/closed', 'not connected yet')
        this.#write(target, message)
      },
      onProblem: (problem) => {
        this.#logger.debug('companion channel: %s', problem)
      },
    })
    try {
      this.#options.attach(peer)
    } catch (error) {
      peer.close()
      // attach 是 Host 自己的代码，抛错是程序问题，重启也一样：直接 failed。
      this.#setState('failed', toErrorInfo(error))
      return
    }
    let child: ChildProcessWithoutNullStreams
    try {
      child = spawn(spec.executable, spec.args, {
        cwd: homedir(),
        env: spec.env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        shell: false,
      })
    } catch (error) {
      // 参数非法等同步错误。
      peer.close()
      this.#recordLoss(generation, { code: 'promptx/companion/spawn-failed', detail: errorDetail(error) }, null)
      return
    }
    const run = this.#newRun(generation, child, peer)
    // 第一件事：给进程和三个管道挂 error 监听，排在所有其他监听之前。可执行文件不存在或没有执行权限（ENOENT、EACCES）时
    // 进程发 error，小程序退出后再写 stdin 会发 EPIPE；没人接的 error 事件是未捕获的异常，会让整个 dsh 退出（审查 S03）。
    // 这些事件都在下一轮事件循环才发出，spawn() 返回后同一段同步代码里挂上就来得及。
    // 用 on 而不是 once：kill() 失败时 ChildProcess 还可能再发一次 error，once 只接得住第一次。
    child.on('error', (error) => {
      this.#onProcessError(run, error)
    })
    child.stdin.on('error', (error) => {
      this.#onPipeError(run, 'stdin', error)
    })
    child.stdout.on('error', (error) => {
      this.#onPipeError(run, 'stdout', error)
    })
    child.stderr.on('error', (error) => {
      this.#onPipeError(run, 'stderr', error)
    })
    target = run
    this.#runs.add(run)
    this.#current = run
    child.stdout.on('data', (chunk: Buffer) => {
      this.#guard('stdout', () => {
        run.decoder.push(chunk)
      })
    })
    child.stdout.on('end', () => {
      run.decoder.end()
      this.#onTransportClosed(run, 'stdout ended')
    })
    child.stdout.on('close', () => {
      this.#onTransportClosed(run, 'stdout closed')
    })
    child.stdin.on('close', () => {
      this.#onTransportClosed(run, 'stdin closed')
    })
    // stderr 一直要读：不读的话管道写满，小程序会卡在写日志上。
    child.stderr.on('data', (chunk: Buffer) => {
      this.#onStderr(run, chunk)
    })
    child.stderr.on('end', () => {
      this.#flushStderr(run)
    })
    child.on('exit', (code, signal) => {
      this.#onExit(run, code, signal)
    })
    if (run.pid !== undefined) {
      this.#logger.info('companion started (pid %d)', run.pid)
      this.#notifyProcess({ type: 'spawned', pid: run.pid })
    }
    this.#setState('starting', undefined)
    // 第一次启动 Electron 较慢，握手给 15 秒。
    run.handshakeTimer = setTimeout(() => {
      this.#lose(run, { code: 'promptx/companion/handshake-timeout' })
    }, this.#timings.handshakeMs)
    run.handshakeTimer.unref()
  }

  #newRun(generation: number, child: ChildProcessWithoutNullStreams, peer: HostPeer): Run {
    const run: Run = {
      generation,
      child,
      peer,
      pid: child.pid,
      decoder: new FrameDecoder({
        maxFrameBytes: MAX_FRAME_BYTES,
        onFrame: (message) => {
          this.#onFrame(run, message)
        },
        onReject: (reason) => {
          this.#onRejectedFrame(run, reason)
        },
      }),
      exitWaiters: new Set(),
      stderr: { lines: 0, partial: '', decoder: new StringDecoder('utf8') },
      handshaken: false,
      lost: false,
      transportDown: false,
      exited: false,
      handshakeTimer: undefined,
      heartbeatTimer: undefined,
      transportTimer: undefined,
      pingInFlight: false,
      misses: 0,
      rejectedFrames: 0,
    }
    return run
  }

  // ───────────────────────────── 通信 ─────────────────────────────

  #onFrame(run: Run, message: unknown): void {
    // hello 由监管器自己处理，不交给 peer：协议版本不对时要回 -32001（RpcPeer 的处理函数只能回业务错误 -32010），
    // 而且回复写出去之后才能标记 running、通知 onReady，这个顺序要由这里控制。
    if (isRecord(message) && message.jsonrpc === '2.0' && message.method === 'hello' && (typeof message.id === 'number' || typeof message.id === 'string')) {
      this.#onHello(run, message.id, message.params)
      return
    }
    run.peer.receive(message)
  }

  #onHello(run: Run, id: number | string, params: unknown): void {
    if (run.generation !== this.#generation || run.lost || this.#stopping !== null) {
      this.#reply(run, rpcFailure(id, RPC_ERROR.channelClosed, { code: 'promptx/channel/closed' }))
      return
    }
    if (run.handshaken) {
      this.#reply(run, rpcFailure(id, RPC_ERROR.invalidRequest, { code: 'promptx/internal', detail: 'duplicate hello' }))
      return
    }
    const protocol = isRecord(params) ? params.protocol : undefined
    if (protocol !== PROTOCOL_VERSION) {
      const info: ErrorInfo = {
        code: 'promptx/companion/protocol-mismatch',
        detail: `host ${PROTOCOL_VERSION}, companion ${typeof protocol === 'number' ? protocol : 'unknown'}`,
      }
      this.#reply(run, rpcFailure(id, RPC_ERROR.protocolMismatch, info))
      // 协议版本对不上：重启还是同一个程序，不进重启循环，直接 failed，进程随后结束。
      this.#abandon(run, info)
      return
    }
    let result: HelloResult
    try {
      result = { ...this.#options.helloResult(), protocol: PROTOCOL_VERSION }
    } catch (error) {
      const info = toErrorInfo(error)
      this.#reply(run, rpcFailure(id, RPC_ERROR.business, info))
      this.#lose(run, info)
      return
    }
    this.#reply(run, { jsonrpc: '2.0', id, result })
    run.handshaken = true
    clearTimeout(run.handshakeTimer)
    run.handshakeTimer = undefined
    this.#peer = run.peer
    this.#setState('running', undefined)
    this.#logger.info('companion ready (app %s, electron %s, %s)', field(params, 'appVersion'), field(params, 'electron'), field(params, 'platform'))
    this.#startHeartbeat(run)
    try {
      this.#options.onReady?.(run.peer)
    } catch (error) {
      this.#logger.warn('companion onReady failed: %s', errorDetail(error))
    }
  }

  #reply(run: Run, message: unknown): void {
    try {
      this.#write(run, message)
    } catch (error) {
      this.#logger.debug('companion: cannot reply: %s', errorDetail(error))
    }
  }

  #write(run: Run, message: unknown): void {
    const stdin = run.child.stdin
    if (run.transportDown || run.exited || !stdin.writable) throw new PromptxError('promptx/channel/closed')
    if (stdin.writableLength > MAX_PENDING_WRITE_BYTES) {
      // 小程序没在读（卡死、停在断点上）。按通道失效处理：杀掉、重启。
      // 放到微任务里做：这里在 RpcPeer 的 request / notify 调用栈里，直接关闭 peer 会重入。
      queueMicrotask(() => {
        this.#guard('overflow', () => {
          this.#lose(run, { code: 'promptx/channel/closed', detail: 'write buffer full' })
        })
      })
      throw new PromptxError('promptx/channel/closed', 'write buffer full')
    }
    stdin.write(encodeFrame(message))
  }

  #onRejectedFrame(run: Run, reason: FrameRejection): void {
    // 坏帧只计数、记日志，不断开连接（design-spec 5.3）。
    run.rejectedFrames += 1
    if (run.rejectedFrames <= REJECTED_FRAME_LOG_LIMIT) this.#logger.debug('companion sent a bad frame: %s', reason)
  }

  // ───────────────────────────── 心跳 ─────────────────────────────

  #startHeartbeat(run: Run): void {
    run.heartbeatTimer = setInterval(() => {
      // 同一时间只有一个心跳在途。
      if (run.pingInFlight || run.lost || run.transportDown) return
      run.pingInFlight = true
      background(this.#logger, 'companion heartbeat', this.#ping(run))
    }, this.#timings.heartbeatMs)
    run.heartbeatTimer.unref()
  }

  async #ping(run: Run): Promise<void> {
    try {
      await run.peer.request('ping', {}, { timeoutMs: this.#timings.heartbeatTimeoutMs })
      run.misses = 0
    } catch {
      // 通道已经断了：交给关闭、退出的处理流程，这里不算心跳失败。
      if (run.lost || run.transportDown) return
      run.misses += 1
      this.#logger.debug('companion missed heartbeat %d/%d', run.misses, this.#timings.heartbeatMissLimit)
      if (run.misses >= this.#timings.heartbeatMissLimit) {
        this.#lose(run, { code: 'promptx/companion/heartbeat-lost', detail: `${run.misses} heartbeats missed` })
      }
    } finally {
      run.pingInFlight = false
    }
  }

  // ───────────────────────────── 失去连接与重启 ─────────────────────────────

  #onProcessError(run: Run, error: Error): void {
    if (run.pid === undefined && !run.exited) {
      // 进程根本没起来（ENOENT、EACCES 等）：不会有 exit 事件，在这里按退出处理。
      this.#markExited(run)
      this.#lose(run, { code: 'promptx/companion/spawn-failed', detail: errorDetail(error) })
      return
    }
    // 进程运行中的 error（例如 kill 失败）：只记日志，进程的结束仍由 exit 事件处理。
    this.#logger.warn('companion process error: %s', errorDetail(error))
  }

  #onPipeError(run: Run, pipe: 'stdin' | 'stdout' | 'stderr', error: Error): void {
    const code = errnoCode(error) ?? 'error'
    this.#logger.debug('companion %s error: %s', pipe, code)
    if (pipe !== 'stderr') this.#onTransportClosed(run, `${pipe} ${code}`)
  }

  #onTransportClosed(run: Run, why: string): void {
    if (run.transportDown) return
    run.transportDown = true
    run.peer.close({ code: 'promptx/channel/closed', detail: why })
    if (this.#peer === run.peer) this.#peer = null
    if (run.exited || run.lost) return
    // 管道关了不等于进程退了。先等一会儿：它自己退出了就按退出处理（能拿到退出码）；还在就按通道失效处理，
    // 由 #lose 杀掉再重启（design-spec 5.2「一次失去连接只处理一次」）。
    run.transportTimer = setTimeout(() => {
      this.#lose(run, { code: 'promptx/channel/closed', detail: why })
    }, this.#timings.killWaitMs)
    run.transportTimer.unref()
  }

  #onExit(run: Run, code: number | null, signal: NodeJS.Signals | null): void {
    if (run.exited) return
    this.#markExited(run)
    const detail = signal === null ? `code ${code ?? 'unknown'}` : `signal ${signal}`
    if (run.pid !== undefined) {
      this.#logger.info('companion exited (pid %d, %s)', run.pid, detail)
      this.#notifyProcess({ type: 'exited', pid: run.pid })
    }
    this.#lose(run, { code: 'promptx/companion/exited', detail })
  }

  #markExited(run: Run): void {
    run.exited = true
    this.#runs.delete(run)
    clearTimeout(run.transportTimer)
    run.transportTimer = undefined
    for (const waiter of [...run.exitWaiters]) waiter()
    run.exitWaiters.clear()
  }

  /** 失去这次连接。只有第一个信号生效；停止过程中或已被新的启动取代时不计失败（由 stop() 收尾）。 */
  #lose(run: Run, info: ErrorInfo): void {
    if (run.lost) return
    run.lost = true
    this.#clearRunTimers(run)
    run.peer.close({ code: 'promptx/channel/closed', detail: info.code })
    if (this.#peer === run.peer) this.#peer = null
    if (run.generation !== this.#generation || this.#stopping !== null) return
    this.#recordLoss(run.generation, info, run)
  }

  /** 计入重启预算：30 秒内第 3 次失败后停止重试（F-06）；否则按退避时间重启。 */
  #recordLoss(generation: number, info: ErrorInfo, run: Run | null): void {
    const now = Date.now()
    this.#failures = this.#failures.filter(at => now - at < this.#timings.restartWindowMs)
    this.#failures.push(now)
    const exhausted = this.#failures.length >= this.#timings.restartLimit
    this.#logger.warn('companion lost: %s%s', info.code, detailSuffix(info))
    if (exhausted) {
      this.#exhausted = true
      this.#logger.error('companion failed %d times within %d ms; automatic restart stopped', this.#failures.length, this.#timings.restartWindowMs)
      this.#setState('failed', info)
    } else {
      this.#setState('restarting', info)
    }
    const backoff = this.#timings.backoffMs
    const delay = exhausted ? null : (backoff[Math.min(this.#failures.length - 1, backoff.length - 1)] ?? 0)
    background(this.#logger, 'companion recovery', this.#recover(generation, run, delay))
  }

  async #recover(generation: number, run: Run | null, delay: number | null): Promise<void> {
    // 先确认旧进程已经结束（管道关了、心跳丢了的进程可能还活着），再按退避时间启动新的。
    if (run !== null) await this.#terminate(run)
    if (delay === null || generation !== this.#generation || this.#stopping !== null) return
    this.#restartTimer = setTimeout(() => {
      this.#restartTimer = undefined
      if (generation !== this.#generation || this.#stopping !== null) return
      this.#launch()
    }, delay)
    this.#restartTimer.unref()
  }

  /** 协议不匹配：停在 failed、不重启。给进程一点时间自己退出，然后确认它结束。 */
  #abandon(run: Run, info: ErrorInfo): void {
    run.lost = true
    this.#clearRunTimers(run)
    run.peer.close({ code: 'promptx/channel/closed', detail: info.code })
    if (this.#peer === run.peer) this.#peer = null
    this.#logger.error('companion protocol mismatch: %s', info.detail ?? '')
    this.#exhausted = false
    this.#setState('failed', info)
    background(this.#logger, 'companion stop after protocol mismatch', this.#finish(run))
  }

  async #finish(run: Run): Promise<void> {
    if (await this.#waitExit(run, this.#timings.exitWaitMs)) return
    await this.#terminate(run)
  }

  // ───────────────────────────── 停止 ─────────────────────────────

  async #shutdown(reason: string): Promise<void> {
    this.#generation += 1
    this.#launchAbort?.abort(new PromptxError('promptx/channel/closed', 'stopping'))
    this.#launchAbort = null
    clearTimeout(this.#restartTimer)
    this.#restartTimer = undefined
    const current = this.#current
    this.#current = null
    this.#peer = null
    const runs = [...this.#runs]
    try {
      await Promise.all(runs.map(run => this.#stopRun(run, run === current ? reason : null)))
    } catch (error) {
      this.#logger.warn('companion stop failed: %s', errorDetail(error))
    }
    for (const run of runs) {
      this.#clearRunTimers(run)
      run.peer.close()
    }
    this.#failures = []
    this.#exhausted = false
    this.#setState('stopped', undefined)
  }

  /**
   * 停止一个进程：shutdown 请求（最多 2 秒）→ 等退出 1 秒 → SIGTERM → 0.5 秒 → SIGKILL（design-spec 5.2「停止」）。
   * 只有完成握手、通道完好的进程才发 shutdown：它要先把草稿写回 Host 再回复（F-01「先把草稿写入本机，再让小程序退出」），
   * 所以等待期间 peer 仍然处理它发来的请求。还没握手的进程没读过草稿，直接结束。
   */
  async #stopRun(run: Run, reason: string | null): Promise<void> {
    clearInterval(run.heartbeatTimer)
    run.heartbeatTimer = undefined
    clearTimeout(run.handshakeTimer)
    run.handshakeTimer = undefined
    if (run.exited) return
    if (reason !== null && run.handshaken && !run.lost && !run.transportDown) {
      try {
        await run.peer.request('shutdown', { reason }, { timeoutMs: this.#timings.shutdownGraceMs })
      } catch (error) {
        this.#logger.debug('companion did not answer shutdown: %s', errorDetail(error))
      }
      if (await this.#waitExit(run, this.#timings.exitWaitMs)) return
    }
    await this.#terminate(run)
  }

  /** SIGTERM → 等 0.5 秒 → SIGKILL → 再等 0.5 秒。Windows 上两个信号都是 TerminateProcess。 */
  async #terminate(run: Run): Promise<void> {
    if (run.exited) return
    this.#kill(run, 'SIGTERM')
    if (await this.#waitExit(run, this.#timings.killWaitMs)) return
    this.#kill(run, 'SIGKILL')
    if (await this.#waitExit(run, this.#timings.killWaitMs)) return
    this.#logger.warn('companion pid %s did not exit after SIGKILL', run.pid === undefined ? 'unknown' : String(run.pid))
  }

  #kill(run: Run, signal: NodeJS.Signals): void {
    try {
      run.child.kill(signal)
    } catch (error) {
      // 平台不支持这个信号时 kill() 会同步抛错；进程已经不在时什么也不做。
      this.#logger.debug('companion kill(%s) failed: %s', signal, errorDetail(error))
    }
  }

  #waitExit(run: Run, ms: number): Promise<boolean> {
    if (run.exited) return Promise.resolve(true)
    return new Promise<boolean>((resolve) => {
      const done = (): void => {
        clearTimeout(timer)
        resolve(true)
      }
      const timer = setTimeout(() => {
        run.exitWaiters.delete(done)
        resolve(false)
      }, ms)
      timer.unref()
      run.exitWaiters.add(done)
    })
  }

  #clearRunTimers(run: Run): void {
    clearTimeout(run.handshakeTimer)
    run.handshakeTimer = undefined
    clearInterval(run.heartbeatTimer)
    run.heartbeatTimer = undefined
    clearTimeout(run.transportTimer)
    run.transportTimer = undefined
  }

  // ───────────────────────────── stderr ─────────────────────────────

  #onStderr(run: Run, chunk: Buffer): void {
    const state = run.stderr
    if (state.lines >= STDERR_LINE_LIMIT) return
    const parts = (state.partial + state.decoder.write(chunk)).split('\n')
    state.partial = (parts.pop() ?? '').slice(0, STDERR_LINE_CHARS)
    for (const line of parts) this.#stderrLine(run, line)
  }

  #flushStderr(run: Run): void {
    const state = run.stderr
    if (state.lines >= STDERR_LINE_LIMIT) return
    const rest = state.partial + state.decoder.end()
    state.partial = ''
    if (rest !== '') this.#stderrLine(run, rest)
  }

  #stderrLine(run: Run, line: string): void {
    const state = run.stderr
    if (state.lines >= STDERR_LINE_LIMIT) return
    state.lines += 1
    this.#logger.debug('companion stderr: %s', line.replace(/\r$/, '').slice(0, STDERR_LINE_CHARS))
    if (state.lines === STDERR_LINE_LIMIT) this.#logger.debug('companion stderr reached %d lines; dropping the rest', STDERR_LINE_LIMIT)
  }

  // ───────────────────────────── 通知 ─────────────────────────────

  #setState(state: CompanionState, error: ErrorInfo | undefined): void {
    if (this.#state === state && sameError(this.#error, error)) return
    this.#state = state
    this.#error = error
    try {
      this.#options.onStateChange?.(state, error === undefined ? undefined : { ...error })
    } catch (failure) {
      this.#logger.warn('companion state listener failed: %s', errorDetail(failure))
    }
  }

  #notifyProcess(event: { type: 'spawned'; pid: number } | { type: 'exited'; pid: number }): void {
    try {
      this.#options.onProcess?.(event)
    } catch (error) {
      this.#logger.warn('companion process listener failed: %s', errorDetail(error))
    }
  }

  /** 事件监听里调用别的代码时兜底：Host 里任何未捕获的异常都会让整个 dsh 退出。 */
  #guard(label: string, body: () => void): void {
    try {
      body()
    } catch (error) {
      this.#logger.warn('companion %s handler failed: %s', label, errorDetail(error))
    }
  }
}

const silentLogger: HostLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
}

function rpcFailure(id: number | string, rpcCode: number, info: ErrorInfo): unknown {
  return { jsonrpc: '2.0', id, error: { code: rpcCode, message: info.code, data: info } }
}

function sameError(a: ErrorInfo | undefined, b: ErrorInfo | undefined): boolean {
  return a?.code === b?.code && a?.detail === b?.detail
}

function detailSuffix(info: ErrorInfo): string {
  return info.detail === undefined ? '' : ` (${info.detail})`
}

/** hello 参数里的一个字符串字段（版本号、平台），只用于日志。 */
function field(params: unknown, key: string): string {
  const value = isRecord(params) ? params[key] : undefined
  return typeof value === 'string' ? value.slice(0, 40) : 'unknown'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
