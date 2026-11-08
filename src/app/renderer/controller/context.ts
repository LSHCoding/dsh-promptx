// 各个界面逻辑模块共用的依赖：状态、预加载桥、编辑区，以及文案和异步任务的小工具。

import type { PromptxBridge } from '../../../shared/bridge.ts'
import {
  describeError,
  errorReason,
  failureMessage,
  translate,
  type Locale,
  type MessageKey,
  type MessageParams,
} from '../../../shared/i18n/index.ts'
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

/**
 * 放进「保存失败：{reason}」这类提示里的原因。插件写在 detail 里的原因代码（例如「无法打开」的 too-large、not-utf8，
 * 库目录的 library-dir-skills）由 errorReason 换成说法，不会原样出现在界面上（L-01、L-05，审查 CR-04）。
 */
export function reason(ctx: Context, error: ErrorInfo): string {
  return errorReason(ctx.store.getState().locale, error)
}

export function describe(ctx: Context, error: ErrorInfo): string {
  return describeError(ctx.store.getState().locale, error)
}

/** 前缀和错误码自己的文案是同一句话的整句提示（「无法打开插件配置：{原因}」），见 failureMessage。 */
export function failure(ctx: Context, key: MessageKey, ownCode: string, error: ErrorInfo): string {
  return failureMessage(ctx.store.getState().locale, key, ownCode, error)
}

const LIBRARY_UNAVAILABLE = 'promptx/library/unavailable'

/** 库目录不可用的说明（L-01）：「库目录不可用：{原因}」；认不出原因时只显示错误本身，不把「库目录不可用」说两遍（审查 CR-04）。 */
export function unavailableMessage(locale: Locale, error: ErrorInfo): string {
  return failureMessage(locale, 'library.unavailable', LIBRARY_UNAVAILABLE, error)
}

/** 侧栏列表区显示的错误（库列表、回收站列表）：库目录不可用时同上，其余按完整说明。 */
export function listErrorMessage(locale: Locale, error: ErrorInfo): string {
  return error.code === LIBRARY_UNAVAILABLE ? unavailableMessage(locale, error) : describeError(locale, error)
}

/** 预览区显示的错误（库和回收站）：库目录不可用时同上，其余只说原因（「文件超过 2 MiB，无法打开」「没有权限」）。 */
export function previewErrorMessage(locale: Locale, error: ErrorInfo): string {
  return error.code === LIBRARY_UNAVAILABLE ? unavailableMessage(locale, error) : errorReason(locale, error)
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
