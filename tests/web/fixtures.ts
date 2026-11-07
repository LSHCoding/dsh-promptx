// tests/web 下各测试共用的数据和钩子（不是测试文件本身，vitest 只收 *.spec.ts）。

import { afterEach, beforeEach, expect, vi } from 'vitest'
import type { StatusPieces } from '../../src/web/status-store.ts'

/**
 * Host 进程里任何未处理的拒绝或异常都会让整个 dsh 退出，测试里一旦出现就判失败。
 * fakeTimers 为 true 时每个测试都用假计时器。在测试文件顶层调用。
 */
export function trapUnexpectedErrors(options: { fakeTimers?: boolean } = {}): void {
  const unexpected: unknown[] = []
  const trap = (error: unknown) => {
    unexpected.push(error)
  }
  beforeEach(() => {
    unexpected.length = 0
    process.on('unhandledRejection', trap)
    process.on('uncaughtException', trap)
    if (options.fakeTimers === true) vi.useFakeTimers()
  })
  afterEach(async () => {
    vi.useRealTimers()
    // 给迟到的拒绝一个机会冒出来。
    await new Promise(resolve => setImmediate(resolve))
    process.off('unhandledRejection', trap)
    process.off('uncaughtException', trap)
    expect(unexpected).toEqual([])
  })
}

export function statusPieces(): StatusPieces {
  return {
    config: {
      libraryDir: '',
      confirmDelete: true,
      optimizeInstruction: '',
      globalShortcut: 'Control+P',
      hideOnBlur: false,
      runtimeSource: 'auto',
    },
    effectiveLibraryDir: '/home/me/.dsh/promptx/library',
    defaultShortcut: 'Control+P',
    defaultInstruction: { zh: '中文指令', en: 'English instruction' },
    runtime: { state: 'missing', version: '44.10.2', dir: '/home/me/.dsh/promptx/runtime' },
    companion: { state: 'waiting-runtime' },
    shortcut: null,
    platform: 'darwin',
    instance: 'active',
  }
}

/** 可以手动拨动的毫秒时钟。 */
export function manualClock(start = 1_000_000): { now: () => number; set: (value: number) => void; advance: (ms: number) => void } {
  let now = start
  return {
    now: () => now,
    set: (value: number) => {
      now = value
    },
    advance: (ms: number) => {
      now += ms
    },
  }
}
