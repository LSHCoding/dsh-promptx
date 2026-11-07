// 小程序日志：`<dsh>/promptx/logs/companion.log`，超过 1 MiB 轮换，连同当前文件共保留 3 份（design-spec 7.7）。
//
// 需求 N-02：日志里不能有 Prompt 正文、草稿、模型回复和文件内容。这里不靠调用方自觉：
// 字段值只接受数字、布尔和「像标识符」的短字符串（方法名、错误码、加速键、版本号），
// 其余字符串一律写成 [redacted]；异常只记错误码或异常类名，从不记 message
// （V8 的 JSON.parse 报错会引用输入的一段，message 本身就可能带着内容）。

import { appendFileSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { PromptxError } from '../../shared/errors.ts'
import { RpcError } from '../../shared/rpc.ts'

export type LogFields = Readonly<Record<string, unknown>>

export interface CompanionLogger {
  info(event: string, fields?: LogFields): void
  warn(event: string, fields?: LogFields): void
  error(event: string, fields?: LogFields): void
}

export const LOG_FILE_NAME = 'companion.log'
export const LOG_MAX_BYTES = 1024 * 1024
/** 当前文件加上轮换出来的 .1、.2，一共 3 份。 */
export const LOG_KEEP_FILES = 3

/** 可以原样写进日志的字符串：不含空白和非 ASCII，最多 80 个字符。 */
const SAFE_TOKEN = /^[A-Za-z0-9_.:/@+-]{1,80}$/

/** 一个字段值在日志里的写法。 */
export function formatLogValue(value: unknown): string {
  if (value === null || value === undefined) return String(value)
  if (typeof value === 'number') return Number.isFinite(value) ? String(Math.round(value * 100) / 100) : 'NaN'
  if (typeof value === 'boolean') return String(value)
  if (typeof value === 'string') {
    if (value === '') return '""'
    return SAFE_TOKEN.test(value) ? value : '[redacted]'
  }
  if (value instanceof Error) return errorCode(value)
  return '[object]'
}

/**
 * 异常在日志里的写法：业务错误取错误码，系统错误取「类名:错误码」（如 `Error:EACCES`），
 * 其他只取类名。message 一律不要。
 */
export function errorCode(error: unknown): string {
  if (error instanceof PromptxError) return error.code
  if (error instanceof RpcError) return SAFE_TOKEN.test(error.info.code) ? error.info.code : 'RpcError'
  if (error instanceof Error) {
    const name = SAFE_TOKEN.test(error.name) ? error.name : 'Error'
    const code = (error as NodeJS.ErrnoException).code
    return typeof code === 'string' && SAFE_TOKEN.test(code) ? `${name}:${code}` : name
  }
  return 'non-error'
}

/**
 * 一行日志：时间、进程号、级别、事件名，然后是 key=value。键名不合规的字段直接丢掉。
 * 所有 profile 的小程序写同一个 companion.log，靠进程号分开各自的行。
 */
export function formatLogLine(time: Date, pid: number, level: 'INFO' | 'WARN' | 'ERROR', event: string, fields?: LogFields): string {
  let line = `${time.toISOString()} ${pid} ${level} ${SAFE_TOKEN.test(event) ? event : '[redacted]'}`
  if (fields !== undefined) {
    for (const [key, value] of Object.entries(fields)) {
      if (!SAFE_TOKEN.test(key)) continue
      line += ` ${key}=${formatLogValue(value)}`
    }
  }
  return `${line}\n`
}

export interface FileLoggerOptions {
  dir: string
  maxBytes?: number
  keepFiles?: number
  now?: () => Date
  pid?: number
  /** WARN 和 ERROR 另抄一份给它（入口传 stderr），Host 会把小程序 stderr 的前 200 行记进自己的日志。 */
  echo?: (line: string) => void
}

/**
 * 同步追加写。小程序日志量很小（状态变化、方法名和耗时），同步写最简单，也保证退出前最后一行已落盘。
 * 任何文件错误都吞掉：日志写不进去不能影响小窗本身。
 */
export class FileLogger implements CompanionLogger {
  readonly #dir: string
  readonly #file: string
  readonly #maxBytes: number
  readonly #keepFiles: number
  readonly #now: () => Date
  readonly #pid: number
  readonly #echo: (line: string) => void
  /** 当前文件的字节数；null 表示还没确认目录和文件（第一次写时、写失败后重新确认）。 */
  #size: number | null = null

  constructor(options: FileLoggerOptions) {
    this.#dir = options.dir
    this.#file = join(options.dir, LOG_FILE_NAME)
    this.#maxBytes = options.maxBytes ?? LOG_MAX_BYTES
    this.#keepFiles = Math.max(1, options.keepFiles ?? LOG_KEEP_FILES)
    this.#now = options.now ?? (() => new Date())
    this.#pid = options.pid ?? process.pid
    this.#echo = options.echo ?? (() => {})
  }

  get file(): string {
    return this.#file
  }

  info(event: string, fields?: LogFields): void {
    this.#write('INFO', event, fields)
  }

  warn(event: string, fields?: LogFields): void {
    this.#write('WARN', event, fields)
  }

  error(event: string, fields?: LogFields): void {
    this.#write('ERROR', event, fields)
  }

  #write(level: 'INFO' | 'WARN' | 'ERROR', event: string, fields: LogFields | undefined): void {
    const line = formatLogLine(this.#now(), this.#pid, level, event, fields)
    if (level !== 'INFO') {
      try {
        this.#echo(line)
      } catch {
        // stderr 断了也不影响写文件。
      }
    }
    try {
      if (this.#size === null) {
        mkdirSync(this.#dir, { recursive: true })
        this.#size = currentSize(this.#file)
      }
      const bytes = Buffer.byteLength(line)
      if (this.#size > 0 && this.#size + bytes > this.#maxBytes) {
        this.#rotate()
        this.#size = 0
      }
      appendFileSync(this.#file, line, { mode: 0o600 })
      this.#size += bytes
    } catch {
      // 磁盘满、目录没有权限：下一次写时重新确认。
      this.#size = null
    }
  }

  /** companion.log → .1 → .2 …，最老的一份删掉。 */
  #rotate(): void {
    const name = (index: number): string => (index === 0 ? this.#file : `${this.#file}.${index}`)
    rmSync(name(this.#keepFiles - 1), { force: true })
    for (let index = this.#keepFiles - 2; index >= 0; index--) {
      try {
        renameSync(name(index), name(index + 1))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
  }
}

function currentSize(file: string): number {
  try {
    return statSync(file).size
  } catch {
    return 0
  }
}

/** 测试和入口出错时用的空日志。 */
export const NULL_LOGGER: CompanionLogger = {
  info() {},
  warn() {},
  error() {},
}
