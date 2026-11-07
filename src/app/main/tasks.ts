// 主进程里「发出去不等结果」的异步任务一律经过这里：总是挂上 catch，只记错误码。
// 主进程的 Promise 拒绝没人处理时不会弹窗，但出错的那一步会悄悄消失，日志里必须留下痕迹。
// lint 连 `void promise` 都不放过（design-spec D20），所以不能用 void 打发。

import { errorCode, type CompanionLogger } from './logger.ts'

export function runTask(logger: Pick<CompanionLogger, 'warn'>, label: string, task: Promise<unknown> | (() => Promise<unknown>)): void {
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

function report(logger: Pick<CompanionLogger, 'warn'>, label: string, error: unknown): void {
  try {
    logger.warn('task.failed', { task: label, error: errorCode(error) })
  } catch {
    // 日志本身出错时也不能抛出。
  }
}

/** 等一个 Promise，最多等 ms 毫秒；超时返回 fallback。原 Promise 的拒绝也按 fallback 处理。 */
export function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    const timer = setTimeout(() => {
      resolve(fallback)
    }, ms)
    promise.then((value) => {
      clearTimeout(timer)
      resolve(value)
    }, () => {
      clearTimeout(timer)
      resolve(fallback)
    })
  })
}
