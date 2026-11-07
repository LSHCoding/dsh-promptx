// 主进程测试的公共工具：未处理异常的陷阱、内存日志、临时目录。

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach } from 'vitest'
import type { CompanionLogger, LogFields } from '../../../src/app/main/logger.ts'

/**
 * 测试期间出现未处理的 Promise 拒绝或异常就让当前测试失败。主进程里这类错误不会让进程退出，
 * 只会让某一步悄悄消失，所以测试里必须抓出来。
 */
export function trapProcessErrors(): void {
  const problems: unknown[] = []
  const onRejection = (reason: unknown): void => {
    problems.push(reason)
  }
  const onException = (error: unknown): void => {
    problems.push(error)
  }
  beforeEach(() => {
    problems.length = 0
    process.on('unhandledRejection', onRejection)
    process.on('uncaughtException', onException)
  })
  afterEach(() => {
    process.off('unhandledRejection', onRejection)
    process.off('uncaughtException', onException)
    if (problems.length > 0) {
      const list = problems.map(problem => (problem instanceof Error ? `${problem.name}: ${problem.message}` : String(problem)))
      throw new Error(`unhandled errors during test: ${list.join('; ')}`)
    }
  })
}

export interface LogEntry {
  level: 'info' | 'warn' | 'error'
  event: string
  fields: LogFields | undefined
}

export class MemoryLogger implements CompanionLogger {
  readonly entries: LogEntry[] = []

  info(event: string, fields?: LogFields): void {
    this.entries.push({ level: 'info', event, fields })
  }

  warn(event: string, fields?: LogFields): void {
    this.entries.push({ level: 'warn', event, fields })
  }

  error(event: string, fields?: LogFields): void {
    this.entries.push({ level: 'error', event, fields })
  }

  events(level?: LogEntry['level']): string[] {
    return this.entries.filter(entry => level === undefined || entry.level === level).map(entry => entry.event)
  }

  find(event: string): LogEntry | undefined {
    return this.entries.find(entry => entry.event === event)
  }

  /** 所有日志序列化成一段文本，用来检查有没有混进内容。 */
  dump(): string {
    return JSON.stringify(this.entries)
  }
}

/** 每个测试一个临时目录，测试结束后删掉。返回取当前目录的函数。 */
export function useTempDir(prefix: string): () => string {
  let dir = ''
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), `promptx-${prefix}-`))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })
  return () => dir
}
