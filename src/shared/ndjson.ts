// Host 与小程序之间的帧格式：NDJSON，每行一个 UTF-8 JSON 值，以 \n 结尾（容忍 \r\n）。
// 设计参照 Azetus/dsh-quorfloat（MIT，Copyright (c) 2026 Azetus）的 src/protocol.ts 与 frame.rs，
// 并补上它 TS 一侧的一个缺口：超长帧丢弃后要一直丢到下一个换行，不能把这一行的剩余部分当成新帧解析。
// 只用 Uint8Array 和 TextDecoder，两端（Node 与 Electron 主进程）共用。

/** 坏帧的原因。坏帧只计数和记日志，不断开连接。 */
export type FrameRejection = 'invalid-json' | 'invalid-utf8' | 'oversized' | 'empty'

export interface FrameDecoderOptions {
  maxFrameBytes: number
  onFrame: (value: unknown) => void
  onReject?: (reason: FrameRejection) => void
}

const NEWLINE = 0x0a

export class FrameDecoder {
  readonly #maxFrameBytes: number
  readonly #onFrame: (value: unknown) => void
  readonly #onReject: (reason: FrameRejection) => void
  readonly #decoder = new TextDecoder('utf-8', { fatal: true })
  #parts: Uint8Array[] = []
  #length = 0
  /** 当前这一行已经超长：丢弃到下一个换行为止。 */
  #discarding = false
  #rejected = 0

  constructor(options: FrameDecoderOptions) {
    this.#maxFrameBytes = options.maxFrameBytes
    this.#onFrame = options.onFrame
    this.#onReject = options.onReject ?? (() => {})
  }

  /** 已丢弃的坏帧数。 */
  get rejected(): number {
    return this.#rejected
  }

  push(chunk: Uint8Array): void {
    let start = 0
    while (start < chunk.length) {
      const newline = chunk.indexOf(NEWLINE, start)
      if (newline === -1) {
        this.#append(chunk.subarray(start))
        return
      }
      this.#append(chunk.subarray(start, newline))
      this.#finishLine()
      start = newline + 1
    }
  }

  /** 输入结束。没有换行结尾的残余数据不是完整的帧，直接丢弃。 */
  end(): void {
    this.#parts = []
    this.#length = 0
    this.#discarding = false
  }

  #append(part: Uint8Array): void {
    if (this.#discarding || part.length === 0) return
    if (this.#length + part.length > this.#maxFrameBytes) {
      this.#discarding = true
      this.#parts = []
      this.#length = 0
      return
    }
    // 复制一份：调用方可能复用传进来的缓冲区。
    this.#parts.push(part.slice())
    this.#length += part.length
  }

  #finishLine(): void {
    if (this.#discarding) {
      this.#discarding = false
      this.#reject('oversized')
      return
    }
    const bytes = concat(this.#parts, this.#length)
    this.#parts = []
    this.#length = 0
    let text: string
    try {
      text = this.#decoder.decode(bytes)
    } catch {
      this.#reject('invalid-utf8')
      return
    }
    if (text.endsWith('\r')) text = text.slice(0, -1)
    if (text.trim() === '') {
      this.#reject('empty')
      return
    }
    let value: unknown
    try {
      value = JSON.parse(text)
    } catch {
      this.#reject('invalid-json')
      return
    }
    this.#onFrame(value)
  }

  #reject(reason: FrameRejection): void {
    this.#rejected += 1
    this.#onReject(reason)
  }
}

function concat(parts: Uint8Array[], length: number): Uint8Array {
  if (parts.length === 1 && parts[0] !== undefined) return parts[0]
  const out = new Uint8Array(length)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

/** 编码一帧。JSON.stringify 会把字符串里的换行转义成 \n，所以一帧总是一行。 */
export function encodeFrame(value: unknown): string {
  return `${JSON.stringify(value)}\n`
}
