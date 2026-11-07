// Client 测试共用的数据和工具：一份合法的 PanelStatus、按字典替换占位符的翻译函数、可手动推送的状态 store，
// 以及把未处理的 Promise 拒绝和异常记成测试失败的钩子。

import { afterEach, beforeEach, expect } from 'vitest'
import type { StatusSnapshot, StatusStore } from '../../src/client/api.ts'
import { en, zh, type PromptxLocaleKey, type PromptxTranslate } from '../../src/client/locale.ts'
import { DEFAULT_INSTRUCTION } from '../../src/shared/instructions.ts'
import type { PanelStatus } from '../../src/shared/types.ts'

export function makeStatus(overrides: Partial<PanelStatus> = {}): PanelStatus {
  return {
    seq: 1,
    config: {
      libraryDir: '',
      confirmDelete: true,
      optimizeInstruction: '',
      globalShortcut: 'Control+P',
      hideOnBlur: false,
      runtimeSource: 'auto',
    },
    effectiveLibraryDir: '/Users/me/.dsh/promptx/library',
    defaultShortcut: 'Control+P',
    defaultInstruction: { zh: DEFAULT_INSTRUCTION.zh, en: DEFAULT_INSTRUCTION.en },
    runtime: { state: 'ready', version: '44.10.2', dir: '/Users/me/.dsh/promptx/runtime' },
    companion: { state: 'running' },
    shortcut: { accelerator: 'Control+P', registered: true },
    navigate: null,
    platform: 'darwin',
    instance: 'active',
    companionPid: 4242,
    ...overrides,
  }
}

/** 和 dsh 的 `t` 一样按 `{name}` 替换占位符；缺参数时保留原样，测试里一眼能看出漏传了什么。 */
export function createTranslator(dict: Record<PromptxLocaleKey, string>): PromptxTranslate {
  return (key, params) => dict[key].replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = params?.[name]
    return typeof value === 'string' || typeof value === 'number' ? String(value) : match
  })
}

export const tZh = createTranslator(zh)
export const tEn = createTranslator(en)

export interface FakeStore extends StatusStore {
  set: (next: StatusSnapshot) => void
}

export function createFakeStore(initial: StatusSnapshot): FakeStore {
  let snapshot = initial
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    set: (next) => {
      snapshot = next
      for (const listener of [...listeners]) listener()
    },
  }
}

/** 可以从外面决定结果的 Promise。 */
export interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

/** 每个测试期间出现的未处理拒绝和异常都记下来，测试结束时断言为空（AGENTS.md：不能有悬空的 Promise）。 */
export function installRejectionTraps(): void {
  const unexpected: unknown[] = []
  const trap = (error: unknown): void => {
    unexpected.push(error)
  }
  beforeEach(() => {
    unexpected.length = 0
    process.on('unhandledRejection', trap)
    process.on('uncaughtException', trap)
  })
  afterEach(() => {
    process.off('unhandledRejection', trap)
    process.off('uncaughtException', trap)
    expect(unexpected).toEqual([])
  })
}
