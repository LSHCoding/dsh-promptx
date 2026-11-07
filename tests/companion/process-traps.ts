// Host 进程里任何未处理的 Promise 拒绝或未捕获的异常都会让整个 dsh 退出（design-spec 4.1；审查 S03）：
// 测试期间出现一个就算失败。在 spec 文件顶层、其他钩子之前调用一次。vitest 的 after 钩子按注册的相反顺序执行，
// 所以这里的检查排在文件自己的清理（结束进程、关服务器）之后，清理过程中冒出来的问题也会被抓到。

import { afterAll, afterEach, beforeAll, expect } from 'vitest'

export function failOnProcessProblems(): void {
  const problems: unknown[] = []
  const trap = (error: unknown): void => {
    problems.push(error)
  }
  beforeAll(() => {
    process.on('unhandledRejection', trap)
    process.on('uncaughtException', trap)
  })
  afterAll(() => {
    process.off('unhandledRejection', trap)
    process.off('uncaughtException', trap)
  })
  afterEach(() => {
    expect(problems.splice(0)).toEqual([])
  })
}
