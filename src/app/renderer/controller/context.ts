// 各个界面逻辑模块共用的依赖：状态、预加载桥、编辑区，以及文案和异步任务的小工具。

import type { PromptxBridge } from '../../../shared/bridge.ts'
import { describeError, errorReason, translate, type Locale, type MessageKey, type MessageParams } from '../../../shared/i18n/index.ts'
import type { ErrorInfo } from '../../../shared/types.ts'
import type { EditorController } from '../editor/controller.ts'
import type { AppState, DialogButton } from '../state/state.ts'
import type { Store } from '../state/store.ts'

export interface Context {
  store: Store<AppState>
  bridge: PromptxBridge
  editor: EditorController
}

export function text(ctx: Context, key: MessageKey, params?: MessageParams): string {
  return translate(ctx.store.getState().locale, key, params)
}

/** 放进「保存失败：{reason}」这类提示里的原因。 */
export function reason(ctx: Context, error: ErrorInfo): string {
  return errorReason(ctx.store.getState().locale, error)
}

export function describe(ctx: Context, error: ErrorInfo): string {
  return describeError(ctx.store.getState().locale, error)
}

const UNREADABLE_DETAILS = new Set(['too-large', 'not-utf8', 'read-failed'])

/**
 * 读取库文件失败的原因。插件对「无法打开」的文件报 promptx/library/unreadable，detail 是 too-large、not-utf8
 * 或 read-failed 这样的机器写法，直接附在文案后面用户看不懂，换成列表里同样的说法（L-01、L-05）。
 */
export function readFailure(locale: Locale, error: ErrorInfo): string {
  const detail = error.detail ?? ''
  if (error.code === 'promptx/library/unreadable' && UNREADABLE_DETAILS.has(detail)) {
    return translate(locale, `library.unreadable.${detail as 'too-large' | 'not-utf8' | 'read-failed'}`)
  }
  return errorReason(locale, error)
}

export function readReason(ctx: Context, error: ErrorInfo): string {
  return readFailure(ctx.store.getState().locale, error)
}

export function dialogButton(ctx: Context, id: string, label: MessageKey, tone?: DialogButton['tone']): DialogButton {
  return tone === undefined ? { id, label: text(ctx, label) } : { id, label: text(ctx, label), tone }
}

/** 预加载桥的请求失败时也不抛异常；这个函数只兜底界面代码自己的异常，避免出现没人处理的 Promise 拒绝。 */
export function runTask(task: Promise<unknown>, onError: (error: unknown) => void = logError): void {
  task.catch(onError)
}

function logError(error: unknown): void {
  console.error('[promptx] renderer task failed', error instanceof Error ? error.message : String(error))
}

/** 新建文件请求的去重 id（library.save 的 requestId）。不用 crypto.randomUUID：lint 规则禁止（非安全上下文里不可用）。 */
export function randomId(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
}
