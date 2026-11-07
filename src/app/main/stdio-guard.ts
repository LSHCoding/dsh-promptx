// stdout、stderr 都是连到 Host 的管道。Host 退出或被杀之后，再往里写会在流上触发异步的 EPIPE 错误；
// 流上没有 error 监听时它会变成未捕获异常。如果异常处理函数又往 stderr 写一行，就会再触发一次 EPIPE，
// 进程陷进「写 → EPIPE → 记日志写 stderr → EPIPE」的循环，既不退出也不干活（2026-11-08 本机端到端测试复现）。
// 所以入口最先挂上 error 监听：管道坏了就不再写，并通知调用方（Host 已经不在，应当退出）。

export interface StdioGuard {
  /** 写 stderr；管道坏了之后静默丢弃。 */
  writeStderr(text: string): void
  /** stderr 是否还能写。 */
  stderrAlive(): boolean
  /** 注册管道损坏时的回调（只会调用一次）。 */
  onBroken(listener: (stream: 'stdout' | 'stderr', code: string) => void): void
}

export function installStdioGuard(streams: { stdout: NodeJS.WritableStream; stderr: NodeJS.WritableStream } = process): StdioGuard {
  let stderrOk = true
  let notified = false
  const listeners: Array<(stream: 'stdout' | 'stderr', code: string) => void> = []
  const broken = (stream: 'stdout' | 'stderr', error: unknown) => {
    if (stream === 'stderr') stderrOk = false
    if (notified) return
    notified = true
    const code = typeof error === 'object' && error !== null && 'code' in error ? String((error).code) : 'unknown'
    for (const listener of listeners) {
      try {
        listener(stream, code)
      } catch {
        // 回调出错也不能再抛。
      }
    }
  }
  streams.stdout.on('error', (error: unknown) => {
    broken('stdout', error)
  })
  streams.stderr.on('error', (error: unknown) => {
    broken('stderr', error)
  })
  return {
    writeStderr: (text) => {
      if (!stderrOk) return
      try {
        streams.stderr.write(text)
      } catch (error) {
        broken('stderr', error)
      }
    },
    stderrAlive: () => stderrOk,
    onBroken: (listener) => {
      listeners.push(listener)
    },
  }
}

/** 管道已经断开时的错误（写到已关闭的管道、流已销毁）。 */
export function isBrokenPipe(error: unknown): boolean {
  const code = typeof error === 'object' && error !== null && 'code' in error ? (error).code : undefined
  return code === 'EPIPE' || code === 'ERR_STREAM_DESTROYED' || code === 'ERR_STREAM_WRITE_AFTER_END' || code === 'ECONNRESET'
}
