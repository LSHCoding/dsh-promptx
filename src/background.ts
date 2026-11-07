// 后台任务的统一入口。Host 进程里任何未处理的 Promise 拒绝都会让整个 dsh 退出（dsh-app-boot 的 fail-loud 处理），
// 所以「发出去不等结果」的异步任务一律经过这里：总是挂上 catch，只把错误码和系统错误信息写日志，不写用户内容。

import { toErrorInfo } from './shared/errors.ts'
import type { HostLogger } from './services.ts'

export function background(logger: Pick<HostLogger, 'warn'>, label: string, task: Promise<unknown> | (() => Promise<unknown>)): void {
  let promise: Promise<unknown>
  try {
    promise = typeof task === 'function' ? task() : task
  } catch (error) {
    report(logger, label, error)
    return
  }
  promise.catch((error: unknown) => {
    report(logger, label, error)
  })
}

function report(logger: Pick<HostLogger, 'warn'>, label: string, error: unknown): void {
  const info = toErrorInfo(error)
  try {
    logger.warn('%s failed: %s%s', label, info.code, info.detail === undefined ? '' : ` (${info.detail})`)
  } catch {
    // 日志本身出错时也不能抛出。
  }
}
