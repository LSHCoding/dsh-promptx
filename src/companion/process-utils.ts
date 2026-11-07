// companion 目录里几个模块共用的小工具：进程是否存活、系统错误码、错误信息的第一行。

/** pid 的合法范围（Linux 的 pid_max 上限是 2^22，各平台都不超过 int32）。 */
const MAX_PID = 0x7fffffff

/**
 * pid 对应的进程是否还在。只有 ESRCH（没有这个进程）算不在；EPERM（进程在、但属于别的用户）和其他错误都按存活处理：
 * 锁的接管宁可多等，也不能删掉一个活着的持有者的锁（design-spec 4.1、5.1）。
 * pid 不合法（0、负数、超范围）时返回 false：process.kill(0, …) 会发给整个进程组，绝不能调用。
 */
export function pidAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid > MAX_PID) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return errnoCode(error) !== 'ESRCH'
  }
}

/** Node 系统错误的 code（ENOENT、EEXIST 等）；没有时为 undefined。 */
export function errnoCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined
  const code: unknown = error.code
  return typeof code === 'string' ? code : undefined
}

/** 错误信息的第一行，截断到 300 字。只用于 ErrorInfo.detail 和日志：这里只会是系统错误信息，不含用户内容。 */
export function errorDetail(error: unknown): string {
  let message: string
  if (error instanceof Error) message = error.message
  else if (typeof error === 'string') message = error
  else message = 'unknown error'
  return (message.split('\n', 1)[0] ?? '').slice(0, 300)
}

/** 解析锁文件里的 pid（`<pid>\n`）；内容不完整或不是正整数时返回 null。 */
export function parsePid(text: string): number | null {
  const match = /^\s*(\d{1,10})\s*$/.exec(text)
  if (match === null) return null
  const pid = Number(match[1])
  return pid > 0 && pid <= MAX_PID ? pid : null
}
