// 配套小程序的主进程入口（构建为 lib/app/main.cjs，Electron 以「可执行文件 <lib/app 目录>」启动时加载）。
// 顺序有讲究（design-spec 5.3、5.4）：
// 1. 第一件事把 console 改到 stderr，stdout 只留给协议帧；
// 2. 读 Host 设置的环境变量，设应用名和 Electron 数据目录（必须在 app ready 之前）；
// 3. 开始读 stdin 并立即发 hello，然后才等 app ready、建窗口。
// 这里不 await 任何东西：Electron 要等主模块执行完才发 ready，顶层 await 会一直等下去。

import { app } from 'electron'
import { CompanionApp } from './app.ts'
import { redirectConsoleToStderr } from './console.ts'
import { createElectronPlatform } from './electron-platform.ts'
import { companionPaths, readCompanionEnv, type CompanionEnv } from './env.ts'
import { errorCode, FileLogger } from './logger.ts'
import { installStdioGuard, isBrokenPipe } from './stdio-guard.ts'

// 最先挂上 stdout、stderr 的 error 监听：Host 不在之后再写管道不能变成未捕获异常（见 stdio-guard.ts）。
const stdio = installStdioGuard()
redirectConsoleToStderr((text) => {
  stdio.writeStderr(text)
})

const envResult = readCompanionEnv(process.env, process.ppid)
if (envResult.ok) {
  main(envResult.env)
} else {
  // 不是由 Host 启动的（例如有人直接运行 Electron）：不在未知位置写任何文件，直接退出。
  stdio.writeStderr(`[promptx] ${envResult.problem}\n`)
  app.exit(2)
}

function main(env: CompanionEnv): void {
  const paths = companionPaths(env)
  app.setName('PromptX')
  // 按 profile 分开 Chromium 的数据目录：两个 profile 的小程序同时运行时不争用同一份缓存和锁。
  app.setPath('userData', paths.userData)

  const logger = new FileLogger({
    dir: paths.logDir,
    echo: (line) => {
      stdio.writeStderr(`[promptx] ${line}`)
    },
  })

  // 没有 Dock 图标、也没有主窗口以外的窗口：Electron 默认在最后一个窗口关闭时退出，这里改成什么都不做，
  // 窗口的关闭由 app.ts 拦成隐藏（审查 TC-11）。
  app.on('window-all-closed', () => {})

  let companion: CompanionApp | null = null

  // 主进程的未捕获异常默认会弹出 Electron 的错误对话框，对一个后台小程序来说比崩溃还糟。
  // 记下错误码和调用栈后退出，交给 Host 重启。调用栈只留「at …」那些行：message 可能有好几行，
  // 里面可能引用了内容（例如 JSON.parse 报错会带上输入的一段），不能跟着 stack 一起写出去。
  // 管道断开说明 Host 已经不在：直接退出（草稿也没处写了）。只处理一次，并设一个兜底的强制退出。
  let exiting = false
  const exitForGood = (code: number) => {
    if (exiting) return
    exiting = true
    setTimeout(() => {
      process.exit(code)
    }, 3_000).unref()
    try {
      if (companion === null) app.exit(code)
      else companion.crash(code)
    } catch {
      app.exit(code)
    }
  }
  stdio.onBroken((stream, code) => {
    logger.warn('stdio.broken', { stream, code })
    exitForGood(0)
  })
  process.on('uncaughtException', (error) => {
    if (isBrokenPipe(error)) {
      exitForGood(0)
      return
    }
    logger.error('main.uncaught-exception', { error: errorCode(error) })
    const frames = (error.stack ?? '').split('\n').filter(line => /^\s+at /.test(line)).join('\n')
    stdio.writeStderr(`[promptx] uncaught ${errorCode(error)}\n${frames}\n`)
    exitForGood(1)
  })
  // 未处理的拒绝只记日志：所有异步任务都经过 runTask，走到这个处理函数的是漏网的，不值得为它退出。
  process.on('unhandledRejection', (reason) => {
    logger.warn('main.unhandled-rejection', { error: errorCode(reason) })
  })

  companion = new CompanionApp({
    platform: createElectronPlatform({ appDir: __dirname, logger }),
    env,
    paths,
    logger,
    input: process.stdin,
    output: process.stdout,
  })
  // hello 在 start() 里同步写出；写日志（第一次要建目录）放到它后面，不耽误握手。
  companion.start()
  logger.info('start', { pid: process.pid, electron: process.versions.electron, platform: process.platform })
}
