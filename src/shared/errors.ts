// 业务错误码。Host 抛出 PromptxError，经协议传到小程序，小窗按错误码取文案（shared/i18n 的 `error.<code>`）。
// 新增错误码时同时在两份文案字典里加上文案；测试会检查每个错误码都有文案。

import type { ErrorInfo } from './types.ts'

export const ERROR_CODES = [
  // 草稿
  'promptx/draft/unreadable',
  'promptx/draft/write-failed',
  'promptx/draft/unavailable',
  // 库
  'promptx/library/unavailable',
  'promptx/library/invalid-path',
  'promptx/library/not-found',
  'promptx/library/unreadable',
  'promptx/library/empty',
  'promptx/library/write-failed',
  'promptx/library/move-failed',
  'promptx/library/move-recovery',
  'promptx/library/invalid-title',
  'promptx/library/duplicate-title',
  'promptx/library/folder-exists',
  'promptx/library/folder-not-found',
  // 回收站
  'promptx/trash/record-failed',
  'promptx/trash/not-found',
  // 优化
  'promptx/optimize/empty',
  'promptx/optimize/busy',
  'promptx/optimize/no-model',
  'promptx/optimize/auth',
  'promptx/optimize/rate-limit',
  'promptx/optimize/network',
  'promptx/optimize/timeout',
  'promptx/optimize/empty-response',
  'promptx/optimize/failed',
  'promptx/optimize/no-session',
  'promptx/optimize/stale',
  // 小窗与系统
  'promptx/clipboard/write-failed',
  'promptx/shortcut/invalid',
  'promptx/shortcut/taken',
  'promptx/shortcut/held-by-profile',
  'promptx/shortcut/system-conflict',
  'promptx/settings/unavailable',
  // 运行时与小程序
  'promptx/runtime/unsupported',
  'promptx/runtime/download-failed',
  'promptx/runtime/checksum-mismatch',
  'promptx/runtime/disk-space',
  'promptx/runtime/extract-failed',
  'promptx/runtime/unzip-missing',
  'promptx/runtime/locked',
  'promptx/runtime/in-use',
  'promptx/runtime/size-mismatch',
  'promptx/companion/spawn-failed',
  'promptx/companion/handshake-timeout',
  'promptx/companion/protocol-mismatch',
  'promptx/companion/exited',
  'promptx/companion/heartbeat-lost',
  'promptx/companion/renderer-gone',
  'promptx/instance/duplicate',
  // 通用
  'promptx/internal',
  'promptx/channel/closed',
  'promptx/channel/timeout',
] as const

export type ErrorCode = typeof ERROR_CODES[number]

/** Host 和小程序内部用的业务错误。只带错误码和系统错误信息，不带用户内容。 */
export class PromptxError extends Error {
  readonly code: ErrorCode
  readonly detail: string | undefined

  constructor(code: ErrorCode, detail?: string) {
    super(detail === undefined ? code : `${code}: ${detail}`)
    this.name = 'PromptxError'
    this.code = code
    this.detail = detail
  }

  toInfo(): ErrorInfo {
    return this.detail === undefined ? { code: this.code } : { code: this.code, detail: this.detail }
  }
}

/** 把任意异常转成 ErrorInfo。非 PromptxError 一律归为 internal，detail 只取 message 的第一行。 */
export function toErrorInfo(error: unknown, fallback: ErrorCode = 'promptx/internal'): ErrorInfo {
  if (error instanceof PromptxError) return error.toInfo()
  const message = error instanceof Error ? error.message : String(error)
  const firstLine = message.split('\n', 1)[0] ?? ''
  return firstLine === '' ? { code: fallback } : { code: fallback, detail: firstLine.slice(0, 300) }
}
