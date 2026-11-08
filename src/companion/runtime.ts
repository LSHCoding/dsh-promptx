// Electron 运行时的下载、校验、解压、清理和删除（需求 F-06、6.8、7.8；design-spec 5.1、5.6、7.7、D2、D3、D4、D23）。
//
// 思路参照 jusong/dsh-codex-pets（MIT，Copyright (c) 2026 jusong）的 lib/electron-runtime.js：校验值和文件大小写在源码里
// （electron-release.ts），下载源只当传输通道；先解压到同一磁盘上的临时目录，确认可执行文件在，再改名成版本目录。
// 相对原实现补上了 design-spec 5.1 和独立审查（S03、S08、S09、TC-10、COV-07、COV-10）要求的几处：
// - 续传：请求前先拿 .part 的大小和预期比；206 必须带对得上的 Content-Range；416 先校验；收到的字节超过预期立即中止；
// - 跨进程锁：持有者每 30 秒刷新锁目录的修改时间，只有持有者已不在、或 5 分钟没刷新才接管。原实现按 30 分钟过期，
//   慢网下（镜像不通、改走 GitHub 时一个多小时很常见）会被第二个进程抢走，两个进程往同一个 .part 里追加。
//   被接管的一方（例如电脑睡眠后醒来）停下自己的下载，回去等接管的进程装好；
// - 租约：运行时目录被所有 profile 共用，各 profile 装的插件版本可能不同，清理和删除不能动别的 profile 正在用的版本；
// - 删除运行时后暂停自动下载；崩溃留下的、没有 .ready 的版本目录先挪开再装；
// - 解压和辅助工具只拿到最小的环境变量，解压结果按清单核对齐了才改名、写 .ready（审查 SEC-04）。

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { accessSync, constants, createReadStream, existsSync, readFileSync, rmSync, statSync } from 'node:fs'
import { access, lstat, mkdir, open, readdir, readFile, rename, rm, stat, statfs, utimes, writeFile, type FileHandle } from 'node:fs/promises'
import { basename, join, win32 } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

import { background } from '../background.ts'
import type { HostLogger, RuntimeApi, RuntimeInstall, RuntimeManagerOptions } from '../services.ts'
import { PromptxError, toErrorInfo, type ErrorCode } from '../shared/errors.ts'
import type { ErrorInfo, RuntimeSource, RuntimeState, RuntimeStatus } from '../shared/types.ts'
import { ELECTRON_ASSETS, ELECTRON_VERSION, type RuntimeTarget } from './electron-release.ts'
import { errnoCode, errorDetail, parsePid, pidAlive } from './process-utils.ts'

/** 国内镜像（Q18：`auto` 先用它）。 */
export const MIRROR_BASE_URL = 'https://cdn.npmmirror.com/binaries/electron'
/** GitHub Releases。 */
export const OFFICIAL_BASE_URL = 'https://github.com/electron/electron/releases/download'

const MB = 1024 * 1024
/** 下载约 130 MB、解压后约 250 MB，再留些余量（design-spec 5.1「磁盘空间」）。 */
const DEFAULT_REQUIRED_FREE_BYTES = 600 * MB
const DEFAULT_CONNECT_MS = 15_000
const DEFAULT_STALL_MS = 30_000
/** 下载进度最多每 250 ms 推一次（配置页长轮询，推得再密也看不出来）。 */
const PROGRESS_INTERVAL_MS = 250
const LOCK_HEARTBEAT_MS = 30_000
const LOCK_STALE_MS = 5 * 60_000
const LOCK_POLL_MS = 500
/** 删除运行时要等正在下载的另一个进程放开锁，最多等这么久，之后报 promptx/runtime/locked。 */
const REMOVE_LOCK_WAIT_MS = 10_000
/** 接管锁时的认领文件放了这么久还在，说明认领者中途退出了。 */
const CLAIM_STALE_MS = 60_000
/** 暂停状态下 ensure() 抛出的 detail，配置页据此显示「下载」而不是「失败」。 */
const PAUSED = 'paused'

/** `<版本>-<平台>-<架构>`：版本目录的名字。 */
const VERSION_DIR = /^(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)-(?:darwin|linux|win32)-(?:x64|arm64)$/

type Source = 'mirror' | 'official'

export interface RuntimeRelease {
  version: string
  file: string
  sha256: string
  size: number
}

/** services.ts 契约之外的选项，只给测试用：缩短锁的时序、模拟另一个进程的 pid。 */
export interface RuntimeManagerTestOptions {
  lockTimings?: { heartbeatMs?: number; staleMs?: number; pollMs?: number; removeWaitMs?: number }
  pid?: number
}

type Extract = (zipFile: string, destDir: string, signal: AbortSignal) => Promise<void>

interface Task {
  readonly controller: AbortController
  readonly promise: Promise<RuntimeInstall>
  /** 带着中止信号在等结果的调用方数量。 */
  consumers: number
  /** 有不带中止信号的调用方：只有 dispose() 和 remove() 能停掉它。 */
  pinned: boolean
}

interface HeldLock {
  ino: number
  heartbeat: NodeJS.Timeout
  /** 锁被别的进程接管时中止：只停下这一轮下载和解压，任务回去等接管的进程装好。 */
  lost: AbortController
}

interface Lease {
  file: string
  /** 租约文件名去掉 `.json`，即 profile 哈希。 */
  hash: string
  version: string
  pid: number
  profile: string
  alive: boolean
}

/** 各平台 Electron 可执行文件在版本目录里的位置（design-spec 5.6）。 */
export function executableSegments(platform: string): readonly string[] {
  switch (platform) {
    case 'darwin':
      return ['Electron.app', 'Contents', 'MacOS', 'Electron']
    case 'win32':
      return ['electron.exe']
    default:
      return ['electron']
  }
}

/**
 * 解压后除可执行文件外必须在的文件，相对版本目录、用 `/` 分隔（审查 SEC-04）。按 Electron 44 发布包的文件清单
 * （electron 仓库 script/zip_manifests/dist_zip.*.manifest，各平台、各架构）和本机解压出的 macOS 运行时核对过。
 * 只挑启动必需、又最能看出解压出了问题的几个：
 * - default_app.asar：Electron 靠它加载命令行里给的小程序目录（launch.ts 把 lib/app 作为第一个参数）；
 * - icudtl.dat、v8_context_snapshot.bin：Chromium 启动必读。macOS 上快照的文件名带架构（`.arm64.bin`），改查框架本体；
 * - locales/en-US.pak：Linux、Windows 的默认语言包。Info-ZIP unzip 被 `UNZIP=-LL` 改成小写、被 `-j` 拍平目录时，
 *   它和 default_app.asar 最先对不上；
 * - macOS 的框架本体和 icudtl.dat 都经过框架里的符号链接（`Versions/Current`）去查，符号链接没保留下来也算缺。
 */
export function requiredRuntimeFiles(platform: string): readonly string[] {
  if (platform === 'darwin') {
    const framework = 'Electron.app/Contents/Frameworks/Electron Framework.framework'
    return ['Electron.app/Contents/Resources/default_app.asar', `${framework}/Electron Framework`, `${framework}/Resources/icudtl.dat`]
  }
  return ['resources/default_app.asar', 'locales/en-US.pak', 'icudtl.dat', 'v8_context_snapshot.bin']
}

function isSupportedTarget(target: string): target is RuntimeTarget {
  return Object.hasOwn(ELECTRON_ASSETS, target)
}

/**
 * Electron 运行时。同一时间只有一个下载任务，重复调用 ensure() 共享结果；跨进程用 `<root>/.lock/` 目录锁互斥。
 * 运行时目录在所有 profile 间共享，用 `<root>/leases/<profile 哈希>.json` 租约记下哪个 profile 的小程序在用哪个版本。
 */
export class RuntimeManager implements RuntimeApi {
  readonly #root: string
  readonly #platform: string
  readonly #target: string
  readonly #release: RuntimeRelease | null
  readonly #version: string
  readonly #installName: string
  readonly #installDir: string
  readonly #segments: readonly string[]
  readonly #executable: string
  readonly #readyFile: string
  readonly #lockDir: string
  readonly #downloadsDir: string
  readonly #leasesDir: string
  readonly #leaseHash: string
  readonly #getSource: () => RuntimeSource
  readonly #profileName: string
  readonly #baseUrls: { mirror: string; official: string }
  readonly #fetch: typeof fetch
  readonly #extract: Extract
  readonly #logger: HostLogger
  readonly #connectMs: number
  readonly #stallMs: number
  readonly #requiredFreeBytes: number
  readonly #pid: number
  readonly #lockTimings: { heartbeatMs: number; staleMs: number; pollMs: number; removeWaitMs: number }
  readonly #listeners = new Set<(status: RuntimeStatus) => void>()

  #state: RuntimeState
  #error: ErrorInfo | undefined
  #source: Source | undefined
  #received: number | undefined
  #total: number | undefined
  #paused = false
  #inUseBy: Array<{ profile: string; version: string }> = []
  #lastProgressAt = 0
  #task: Task | null = null
  #lock: HeldLock | null = null
  #disposed = false
  /** dispose() 时中止：remove() 等锁时用它，卸载后不再继续等。 */
  readonly #disposal = new AbortController()

  constructor(options: RuntimeManagerOptions & RuntimeManagerTestOptions) {
    this.#root = options.root
    this.#platform = options.platform ?? process.platform
    this.#target = `${this.#platform}-${options.arch ?? process.arch}`
    if (isSupportedTarget(this.#target)) {
      const asset = ELECTRON_ASSETS[this.#target]
      this.#release = options.release ?? { version: ELECTRON_VERSION, file: asset.file, sha256: asset.sha256, size: asset.size }
    } else {
      this.#release = null
    }
    this.#version = this.#release?.version ?? ELECTRON_VERSION
    this.#installName = `${this.#version}-${this.#target}`
    this.#installDir = join(this.#root, this.#installName)
    this.#segments = executableSegments(this.#platform)
    this.#executable = join(this.#installDir, ...this.#segments)
    this.#readyFile = join(this.#installDir, '.ready')
    this.#lockDir = join(this.#root, '.lock')
    this.#downloadsDir = join(this.#root, 'downloads')
    this.#leasesDir = join(this.#root, 'leases')
    this.#leaseHash = safeFileName(options.profile.hash)
    this.#getSource = options.getSource
    this.#profileName = options.profile.name
    this.#baseUrls = options.baseUrls ?? { mirror: MIRROR_BASE_URL, official: OFFICIAL_BASE_URL }
    // 没有指定时每次请求才取全局 fetch：dsh 按 HTTPS_PROXY 等环境变量配置的代理可能在本对象创建之后才装上。
    this.#fetch = options.fetch ?? (async (input, init) => await globalThis.fetch(input, init))
    const custom = options.extract
    this.#extract = custom === undefined ? defaultExtractor(this.#platform) : (zip, dest) => custom(zip, dest)
    this.#logger = options.logger ?? silentLogger
    this.#connectMs = options.timeouts?.connectMs ?? DEFAULT_CONNECT_MS
    this.#stallMs = options.timeouts?.stallMs ?? DEFAULT_STALL_MS
    this.#requiredFreeBytes = options.requiredFreeBytes ?? DEFAULT_REQUIRED_FREE_BYTES
    this.#pid = options.pid ?? process.pid
    this.#lockTimings = {
      heartbeatMs: options.lockTimings?.heartbeatMs ?? LOCK_HEARTBEAT_MS,
      staleMs: options.lockTimings?.staleMs ?? LOCK_STALE_MS,
      pollMs: options.lockTimings?.pollMs ?? LOCK_POLL_MS,
      removeWaitMs: options.lockTimings?.removeWaitMs ?? REMOVE_LOCK_WAIT_MS,
    }
    if (this.#release === null) {
      this.#state = 'unsupported'
      this.#error = { code: 'promptx/runtime/unsupported', detail: this.#target }
    } else {
      // 构造时只做两次同步的 stat，让配置页一打开就能看到「已就绪」；完整的检查（包括删掉失效的 .ready）在 ensure() 里。
      this.#state = this.#installedSync() ? 'ready' : 'missing'
    }
  }

  status(): RuntimeStatus {
    const status: RuntimeStatus = { state: this.#state, version: this.#version, dir: this.#root }
    if (this.#paused) status.paused = true
    if (this.#inUseBy.length > 0) status.inUseBy = this.#inUseBy.map(user => ({ ...user }))
    if (this.#source !== undefined) status.source = this.#source
    if (this.#received !== undefined) status.received = this.#received
    if (this.#total !== undefined) status.total = this.#total
    if (this.#error !== undefined) status.error = { ...this.#error }
    return status
  }

  onChange(listener: (status: RuntimeStatus) => void): () => void {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  ensure(signal?: AbortSignal): Promise<RuntimeInstall> {
    if (this.#disposed) return Promise.reject(new PromptxError('promptx/runtime/download-failed', 'disposed'))
    if (this.#release === null) return Promise.reject(new PromptxError('promptx/runtime/unsupported', this.#target))
    if (signal?.aborted === true) return Promise.reject(abortError(signal))
    // 已经中止、正在收尾的任务（调用方都放弃了，或被 remove() 停掉）不能再接新的调用方，否则新调用方会莫名收到别人的中止。
    // 新任务排在它后面：等它放开锁、关掉 .part 之后再开始。
    let task = this.#task
    if (task === null || task.controller.signal.aborted) task = this.#startTask(task)
    if (signal === undefined) {
      task.pinned = true
      return task.promise
    }
    task.consumers += 1
    return new Promise<RuntimeInstall>((resolve, reject) => {
      const onAbort = (): void => {
        task.consumers -= 1
        // 所有调用方都不要结果了：停掉下载。.part 留着，下次从断点续传。
        if (task.consumers === 0 && !task.pinned) task.controller.abort(abortError(signal))
        reject(abortError(signal))
      }
      signal.addEventListener('abort', onAbort, { once: true })
      task.promise.then(
        (install) => {
          signal.removeEventListener('abort', onAbort)
          resolve(install)
        },
        (error: unknown) => {
          signal.removeEventListener('abort', onAbort)
          reject(asError(error))
        },
      )
    })
  }

  resume(): void {
    if (!this.#paused && this.#inUseBy.length === 0) return
    this.#paused = false
    this.#inUseBy = []
    this.#emit()
  }

  async acquireLease(version: string, pid: number): Promise<void> {
    await mkdir(this.#leasesDir, { recursive: true })
    const file = this.#leaseFile()
    const temp = `${file}.${this.#pid}.tmp`
    await writeFile(temp, `${JSON.stringify({ version, pid, profile: this.#profileName })}\n`)
    try {
      await renameWithRetry(temp, file)
    } catch (error) {
      await rm(temp, { force: true })
      throw error
    }
  }

  /**
   * 释放本 profile 的租约。传 pid 时只在租约记的就是这个进程时才删：旧的小程序在新的已经起来、登记了租约之后
   * 才退出（SIGKILL 之后迟迟不退的极端情况）时，不能把新进程的租约删掉。
   */
  async releaseLease(pid?: number): Promise<void> {
    const file = this.#leaseFile()
    if (pid !== undefined) {
      let recorded: unknown
      try {
        const data: unknown = JSON.parse(await readFile(file, 'utf8'))
        recorded = isRecord(data) ? data.pid : undefined
      } catch {
        recorded = undefined // 没有租约，或者读不出来：照常删
      }
      if (typeof recorded === 'number' && recorded !== pid) return
    }
    await rm(file, { force: true })
  }

  async remove(): Promise<{ removed: string[]; inUseBy: Array<{ profile: string; version: string }> }> {
    if (this.#disposed) throw new PromptxError('promptx/runtime/download-failed', 'disposed')
    // 先暂停：删除期间和删除之后都不自动下载，直到用户点「下载」或下次插件启动（6.8、7.8；审查 COV-10）。
    this.#paused = true
    const task = this.#task
    if (task !== null) {
      task.controller.abort(abortReason('the runtime is being removed'))
      await task.promise.catch(() => undefined)
    }
    await mkdir(this.#root, { recursive: true })
    await this.#lockForRemove()
    const removed = new Set<string>()
    const inUse = new Map<string, { profile: string; version: string }>()
    const failures: string[] = []
    try {
      // 本 profile 的小程序已经由调用方停掉；只有其他 profile 的存活租约保护版本目录。
      const others = (await this.#readLeases()).filter(lease => lease.alive && lease.hash !== this.#leaseHash)
      for (const entry of await readdir(this.#root, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue
        const version = VERSION_DIR.exec(entry.name)?.[1]
        if (version === undefined) {
          if (this.#isLeftover(entry.name)) await this.#removeQuietly(join(this.#root, entry.name))
          continue
        }
        const users = others.filter(lease => lease.version === version || lease.version === entry.name)
        if (users.length > 0) {
          for (const user of users) inUse.set(`${user.profile}\n${version}`, { profile: user.profile, version })
          continue
        }
        try {
          await rm(join(this.#root, entry.name), { recursive: true, force: true })
          removed.add(version)
        } catch (error) {
          failures.push(errorDetail(error))
        }
      }
      await rm(this.#downloadsDir, { recursive: true, force: true })
    } finally {
      await this.#releaseLock()
    }
    this.#inUseBy = [...inUse.values()]
    if (this.#release === null) {
      this.#state = 'unsupported'
    } else {
      this.#state = 'missing'
      this.#error = undefined
    }
    this.#source = undefined
    this.#received = undefined
    this.#total = undefined
    this.#emit()
    this.#logger.info('runtime removed: %d version(s); %d kept for other profiles', removed.size, this.#inUseBy.length)
    // 有的版本目录删不掉（Windows 上文件被占用等）：其余的已经删了，状态也已更新，再把原因报给配置页。
    if (failures[0] !== undefined) throw new PromptxError('promptx/runtime/in-use', failures[0])
    return { removed: [...removed], inUseBy: this.#inUseBy.map(user => ({ ...user })) }
  }

  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    this.#disposal.abort(abortReason('disposed'))
    this.#task?.controller.abort(abortReason('disposed'))
    // 同步释放：插件卸载、dsh 退出时清理函数后面可能没有机会再跑异步代码。锁目录里只有一个 pid 文件，很快。
    this.#releaseLockSync()
    this.#listeners.clear()
  }

  // ───────────────────────────── 任务 ─────────────────────────────

  #startTask(previous: Task | null): Task {
    const controller = new AbortController()
    const { promise, resolve, reject } = Promise.withResolvers<RuntimeInstall>()
    const task: Task = { controller, promise, consumers: 0, pinned: false }
    // 先登记任务再开始跑：状态监听器里再调 ensure() 时拿到的是同一个任务，不会再起一个
    // （dsh-codex-pets 踩过这个坑：重复调用一直递归到栈溢出，溢出又被记成下载失败）。
    this.#task = task
    // 所有调用方都可能已经放弃（中止）：任务自己的结果总有人接住，不会变成未处理的拒绝。
    promise.catch(() => undefined)
    const run = async (): Promise<RuntimeInstall> => {
      // 前一个任务已中止但还没收尾：两个任务同时写 .part、抢同一把锁会互相踩，等它结束再开始。
      if (previous !== null) await previous.promise.catch(() => undefined)
      return await this.#run(controller.signal)
    }
    run().then(
      (install) => {
        if (this.#task === task) this.#task = null
        // 审查 H2：#obtain 里每个 await（检查是否已装好、清理、放锁）期间任务都可能被中止（dispose()、remove()、
        // 调用方都放弃了），它照样会把找到或刚装好的版本返回出来，卸载后的插件就会拿它启动 Electron，
        // remove() 也正要删掉它。所以在交出结果的这一处统一再看一次中止信号，覆盖 #obtain 的所有返回路径。
        // 状态不改回 missing：版本确实装好了，配置页照实显示。
        if (controller.signal.aborted) {
          reject(abortError(controller.signal))
          return
        }
        resolve(install)
      },
      (error: unknown) => {
        if (this.#task === task) this.#task = null
        reject(asError(error))
      },
    )
    return task
  }

  async #run(signal: AbortSignal): Promise<RuntimeInstall> {
    try {
      return await this.#obtain(signal)
    } catch (error) {
      if (signal.aborted) {
        // 调用方都放弃了、插件卸载或删除运行时：不算失败，回到 missing（.part 留着，下次从断点续传）。
        // 中止原因可能是调用方带来的 PromptxError（例如监管器停止时的 channel/closed），不能把它当成运行时的错误显示。
        if (!this.#disposed) this.#markMissing()
        throw abortError(signal)
      }
      if (error instanceof PromptxError && error.detail === PAUSED) throw error
      const failure = toPromptxError(error, 'promptx/runtime/download-failed')
      this.#fail(failure)
      throw failure
    }
  }

  async #obtain(signal: AbortSignal): Promise<RuntimeInstall> {
    for (;;) {
      signal.throwIfAborted()
      const installed = await this.#checkInstalled()
      if (installed !== null) {
        this.#markReady()
        return installed
      }
      if (this.#paused) {
        this.#markMissing()
        throw new PromptxError('promptx/runtime/download-failed', PAUSED)
      }
      await mkdir(this.#root, { recursive: true })
      const held = await this.#lockOrInstalled(signal)
      if (held === 'installed') continue
      // 这一轮的下载和解压既听任务的中止信号，也听「锁被接管」。
      const attempt = AbortSignal.any([signal, held.lost.signal])
      try {
        // 等锁期间另一个进程可能已经装好了。
        const raced = await this.#checkInstalled()
        if (raced !== null) {
          this.#markReady()
          return raced
        }
        await this.#checkDiskSpace()
        const zip = await this.#download(attempt)
        const install = await this.#unpack(zip, attempt)
        this.#markReady()
        this.#logger.info('runtime %s installed from %s', this.#version, this.#source ?? 'cache')
        // 清理要持锁做：卸载时 dispose() 已经同步放开了锁，锁被接管时也已经不在手里，这两种情况跳过，下次装新版本时再清。
        if (this.#lock === held) await this.#cleanup()
        return install
      } catch (error) {
        // 锁被接管：本进程停住太久没刷新心跳（例如电脑睡眠），另一个进程按 design-spec 5.1 接手了下载。
        // 这不是失败，回去等它装好（等待期间照样每 500 ms 看一次 .ready，它放弃了就由本进程重新抢锁）。
        if (!signal.aborted && held.lost.signal.aborted) {
          this.#logger.warn('runtime: the download lock was taken over; waiting for the other process')
          continue
        }
        throw error
      } finally {
        await this.#releaseLock()
      }
    }
  }

  /**
   * `.ready` 在、并且可执行文件能执行（Windows 上是存在）才算装好。`.ready` 在但可执行文件没了或不能执行
   * （安全软件隔离、用户手动删了文件）时删掉 `.ready`，当作没装，重新下载（design-spec 4.1「异常」）。
   */
  async #checkInstalled(): Promise<RuntimeInstall | null> {
    if (this.#release === null) return null
    try {
      await stat(this.#readyFile)
    } catch {
      return null
    }
    try {
      await access(this.#executable, this.#platform === 'win32' ? constants.F_OK : constants.X_OK)
      return { executable: this.#executable, dir: this.#installDir }
    } catch (error) {
      this.#logger.warn('runtime executable is not usable (%s); downloading it again', errnoCode(error) ?? 'unknown')
      await rm(this.#readyFile, { force: true })
      return null
    }
  }

  #installedSync(): boolean {
    try {
      if (!existsSync(this.#readyFile)) return false
      accessSync(this.#executable, this.#platform === 'win32' ? constants.F_OK : constants.X_OK)
      return true
    } catch {
      return false
    }
  }

  async #checkDiskSpace(): Promise<void> {
    let free: number
    try {
      const info = await statfs(this.#root)
      free = info.bavail * info.bsize
    } catch (error) {
      this.#logger.debug('runtime: cannot read free disk space, skipping the check: %s', errorDetail(error))
      return
    }
    if (free < this.#requiredFreeBytes) {
      throw new PromptxError('promptx/runtime/disk-space', `need ${Math.ceil(this.#requiredFreeBytes / MB)} MB, ${Math.floor(free / MB)} MB free`)
    }
  }

  // ───────────────────────────── 下载 ─────────────────────────────

  async #download(signal: AbortSignal): Promise<string> {
    const release = this.#requireRelease()
    await mkdir(this.#downloadsDir, { recursive: true })
    const part = join(this.#downloadsDir, `${release.file}.part`)
    let last = new PromptxError('promptx/runtime/download-failed')
    for (const source of sourceOrder(this.#getSource())) {
      this.#source = source
      // 连接最长要等 15 秒：先把状态切到「下载中」并带上已有的字节数，配置页不会还显示上一次的失败。
      this.#startProgress(Math.min(await fileSize(part), release.size), release.size)
      try {
        await this.#fromSource(source, part, signal)
        return part
      } catch (error) {
        if (signal.aborted) throw abortError(signal)
        last = toPromptxError(error, 'promptx/runtime/download-failed')
        this.#logger.warn('runtime download from %s failed: %s%s', source, last.code, last.detail === undefined ? '' : ` (${last.detail})`)
      }
    }
    throw last
  }

  /** 从一个源下载并校验。续传得到的文件没通过校验时，删掉在同一个源上从头再下一次；还不通过就换下一个源。 */
  async #fromSource(source: Source, part: string, signal: AbortSignal): Promise<void> {
    const release = this.#requireRelease()
    const url = `${this.#baseUrls[source].replace(/\/+$/, '')}/v${release.version}/${release.file}`
    let fromScratch = false
    for (;;) {
      const outcome = await this.#transfer(url, part, signal)
      if (outcome === 'verified' || (await this.#verify(part, signal))) return
      await rm(part, { force: true })
      if (outcome === 'resumed' && !fromScratch) {
        this.#logger.info('runtime: resumed download from %s failed verification; starting over', source)
        fromScratch = true
        continue
      }
      throw new PromptxError('promptx/runtime/checksum-mismatch', source)
    }
  }

  /**
   * 把 .part 补到预期大小（design-spec 5.1「下载与续传」）。返回 fresh（从头下的）、resumed（用到了之前留下的字节）
   * 或 verified（已经校验过）。
   */
  async #transfer(url: string, part: string, signal: AbortSignal): Promise<'fresh' | 'resumed' | 'verified'> {
    const { size } = this.#requireRelease()
    let local = await fileSize(part)
    if (local > size) {
      await rm(part, { force: true })
      local = 0
    }
    // 已经完整（上次在校验或解压时退出了）：不发请求，直接交给校验。
    if (local === size) return 'resumed'
    let restarted = false
    for (;;) {
      const controller = new AbortController()
      const forward = (): void => {
        controller.abort()
      }
      signal.addEventListener('abort', forward, { once: true })
      try {
        const response = await this.#request(url, local, controller, signal)
        const outcome = await this.#receive(response, part, local, controller, signal)
        if (outcome !== 'restart') return outcome
      } finally {
        signal.removeEventListener('abort', forward)
      }
      // 服务器的回应和本地已有的字节接不上：删掉 .part 从头下。同一个源只重来一次，再不行就换源。
      await rm(part, { force: true })
      local = 0
      if (restarted) throw new PromptxError('promptx/runtime/download-failed', 'the server keeps rejecting the byte range')
      restarted = true
    }
  }

  async #request(url: string, from: number, controller: AbortController, signal: AbortSignal): Promise<Response> {
    const timer = setTimeout(() => {
      controller.abort(new PromptxError('promptx/runtime/download-failed', 'connect timeout'))
    }, this.#connectMs)
    timer.unref()
    // identity：不要压缩。经过 gzip 的响应体长度和 Content-Length 对不上，大小核对就没法做。
    const headers: Record<string, string> = { 'accept-encoding': 'identity' }
    if (from > 0) headers.range = `bytes=${from}-`
    try {
      return await this.#fetch(url, { headers, redirect: 'follow', signal: controller.signal })
    } catch (error) {
      if (signal.aborted) throw abortError(signal)
      // 连接超时时用 PromptxError 中止，原因从中止信号上取。
      const reason: unknown = controller.signal.reason
      if (reason instanceof PromptxError) throw reason
      throw new PromptxError('promptx/runtime/download-failed', networkDetail(error))
    } finally {
      clearTimeout(timer)
    }
  }

  async #receive(
    response: Response, part: string, local: number, controller: AbortController, signal: AbortSignal,
  ): Promise<'fresh' | 'resumed' | 'verified' | 'restart'> {
    const { size } = this.#requireRelease()
    switch (response.status) {
      case 200:
        // 200 表示服务器不续传、从头发：从零开始写。
        await expectLength(response, size)
        await this.#stream(response, part, 0, controller, signal)
        return 'fresh'
      case 206:
        // 只有 Content-Range 正好接在本地已有的字节后面时才能追加，否则追加会把文件写坏。
        if (local === 0 || !rangeMatches(response.headers.get('content-range'), local, size)) {
          await discard(response)
          this.#logger.info('runtime: unexpected Content-Range; downloading from the start')
          return 'restart'
        }
        await expectLength(response, size - local)
        await this.#stream(response, part, local, controller, signal)
        return 'resumed'
      case 416:
        // 服务器认为范围越界：本地文件也许已经完整，先校验，不通过再从头下。
        await discard(response)
        if (local > 0 && (await this.#verify(part, signal))) return 'verified'
        return 'restart'
      default:
        await discard(response)
        throw new PromptxError('promptx/runtime/download-failed', `HTTP ${response.status}`)
    }
  }

  async #stream(response: Response, part: string, offset: number, controller: AbortController, signal: AbortSignal): Promise<void> {
    const { size } = this.#requireRelease()
    const body = response.body
    if (body === null) throw new PromptxError('promptx/runtime/download-failed', 'empty response body')
    const handle = await open(part, offset === 0 ? 'w' : 'a')
    const reader = body.getReader()
    let received = offset
    let oversize = false
    let stallTimer: NodeJS.Timeout | undefined
    const arm = (): void => {
      clearTimeout(stallTimer)
      stallTimer = setTimeout(() => {
        controller.abort(new PromptxError('promptx/runtime/download-failed', 'stalled'))
      }, this.#stallMs)
      stallTimer.unref()
    }
    this.#startProgress(received, size)
    try {
      arm()
      for (;;) {
        const chunk = await reader.read()
        if (chunk.done) break
        if (received + chunk.value.byteLength > size) {
          // 收到的字节已经超过预期：镜像出了问题或被篡改。立即中止，不让它把磁盘写满（审查 S09）。
          oversize = true
          throw new PromptxError('promptx/runtime/size-mismatch', `more than ${size} bytes`)
        }
        await writeAll(handle, chunk.value)
        received += chunk.value.byteLength
        arm()
        this.#progress(received)
      }
    } catch (error) {
      if (signal.aborted) throw abortError(signal)
      if (error instanceof PromptxError) throw error
      // 卡住时用 PromptxError 中止，原因从中止信号上取。
      const reason: unknown = controller.signal.reason
      if (reason instanceof PromptxError) throw reason
      throw new PromptxError('promptx/runtime/download-failed', networkDetail(error))
    } finally {
      clearTimeout(stallTimer)
      await reader.cancel().catch(() => undefined)
      await handle.close()
      // 超量的源发来的字节都不可信，连同 .part 一起删掉。要在关掉文件之后删：Windows 上删不掉打开着的文件。
      // 其他失败（卡住、断开）留着 .part，换源后从断点续传。
      if (oversize) await rm(part, { force: true })
    }
    this.#progress(received, true)
    if (received !== size) throw new PromptxError('promptx/runtime/download-failed', `connection closed after ${received} of ${size} bytes`)
  }

  /** 对整个文件流式计算 SHA-256，和源码里的值比对。 */
  async #verify(path: string, signal: AbortSignal): Promise<boolean> {
    const hash = createHash('sha256')
    try {
      for await (const chunk of createReadStream(path, { signal })) hash.update(chunk as Buffer)
    } catch (error) {
      if (signal.aborted) throw abortError(signal)
      if (errnoCode(error) === 'ENOENT') return false
      throw error
    }
    return hash.digest('hex') === this.#requireRelease().sha256
  }

  // ───────────────────────────── 解压与安装 ─────────────────────────────

  async #unpack(zip: string, signal: AbortSignal): Promise<RuntimeInstall> {
    const release = this.#requireRelease()
    this.#state = 'extracting'
    this.#emit()
    // 解压到同一磁盘上的 staging-<pid>，确认完整后再一次改名成版本目录：别的进程永远看不到解压到一半的目录。
    const staging = join(this.#root, `staging-${this.#pid}`)
    await rm(staging, { recursive: true, force: true })
    await mkdir(staging, { recursive: true })
    try {
      try {
        await this.#extract(zip, staging, signal)
      } catch (error) {
        if (signal.aborted) throw abortError(signal)
        throw toPromptxError(error, 'promptx/runtime/extract-failed')
      }
      if (signal.aborted) throw abortError(signal)
      if (!(await pathExists(join(staging, ...this.#segments)))) {
        throw new PromptxError('promptx/runtime/extract-failed', 'the archive has no Electron executable')
      }
      // 只看可执行文件不够（审查 SEC-04）：文件名被改成小写、目录被拍平时可执行文件往往还在。
      // 清单对不上按解压失败处理：删掉 staging，压缩包本身通过了校验，留着给重试。
      const missing = await firstMissing(staging, requiredRuntimeFiles(this.#platform))
      if (missing !== undefined) throw new PromptxError('promptx/runtime/extract-failed', `missing ${missing}`)
      await this.#clearStaleTarget()
      await renameWithRetry(staging, this.#installDir)
    } catch (error) {
      await rm(staging, { recursive: true, force: true }).catch(() => undefined)
      throw error
    }
    if (this.#platform === 'darwin') await this.#dropQuarantine()
    const ready = { version: release.version, sha256: release.sha256, installedAt: new Date().toISOString() }
    await writeFile(this.#readyFile, `${JSON.stringify(ready)}\n`)
    // 装好之后压缩包没用了，占着 130 MB。
    await rm(zip, { force: true }).catch(() => undefined)
    return { executable: this.#executable, dir: this.#installDir }
  }

  /**
   * 版本目录已存在但没有 .ready：上次在「改名」和「写 .ready」之间崩溃留下的，或者可执行文件丢了。
   * 直接改名会因为目标非空失败（ENOTEMPTY、EPERM），先挪到 trash-<pid> 再删（审查 S09）。
   */
  async #clearStaleTarget(): Promise<void> {
    if (!(await pathExists(this.#installDir))) return
    const trash = join(this.#root, `trash-${this.#pid}`)
    await rm(trash, { recursive: true, force: true })
    await renameWithRetry(this.#installDir, trash)
    await this.#removeQuietly(trash)
  }

  /** Node 写的文件本来就不带隔离标记，这一步只是保险（design-spec 5.1）；失败不影响使用。 */
  async #dropQuarantine(): Promise<void> {
    try {
      await runTool('/usr/bin/xattr', ['-dr', 'com.apple.quarantine', this.#installDir])
    } catch (error) {
      this.#logger.debug('runtime: xattr failed: %s', errorDetail(error))
    }
  }

  // ───────────────────────────── 清理与租约 ─────────────────────────────

  /**
   * 新版本就绪后（持锁）：删掉既不是当前版本、也没有存活租约的版本目录，残留的 trash-*、已退出进程的 staging-*，
   * 其他版本的 .part，以及已退出进程的租约。删除失败只记日志（design-spec 5.1「清理」）。
   */
  async #cleanup(): Promise<void> {
    try {
      const leases = await this.#readLeases()
      const live = leases.filter(lease => lease.alive)
      for (const entry of await readdir(this.#root, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue
        const version = VERSION_DIR.exec(entry.name)?.[1]
        const garbage = version === undefined
          ? this.#isLeftover(entry.name)
          : entry.name !== this.#installName && !live.some(lease => lease.version === version || lease.version === entry.name)
        if (garbage) await this.#removeQuietly(join(this.#root, entry.name))
      }
      const current = `${this.#requireRelease().file}.part`
      for (const name of await readdirOrEmpty(this.#downloadsDir)) {
        if (name !== current) await this.#removeQuietly(join(this.#downloadsDir, name))
      }
      for (const lease of leases) {
        if (!lease.alive) await this.#removeQuietly(lease.file)
      }
    } catch (error) {
      this.#logger.warn('runtime cleanup failed: %s', errorDetail(error))
    }
  }

  /** 持锁时才调用：trash-* 都是残留；staging-<pid> 只删已退出进程（或本进程自己）的。 */
  #isLeftover(name: string): boolean {
    if (/^trash-\d+$/.test(name)) return true
    const staging = /^staging-(\d+)$/.exec(name)?.[1]
    if (staging === undefined) return false
    const pid = Number(staging)
    return pid === this.#pid || !pidAlive(pid)
  }

  async #readLeases(): Promise<Lease[]> {
    const leases: Lease[] = []
    for (const name of await readdirOrEmpty(this.#leasesDir)) {
      if (!name.endsWith('.json')) continue
      const file = join(this.#leasesDir, name)
      try {
        const data: unknown = JSON.parse(await readFile(file, 'utf8'))
        if (!isRecord(data) || typeof data.version !== 'string' || typeof data.pid !== 'number') continue
        const hash = name.slice(0, -'.json'.length)
        const profile = typeof data.profile === 'string' ? data.profile : hash
        leases.push({ file, hash, version: data.version, pid: data.pid, profile, alive: pidAlive(data.pid) })
      } catch {
        // 读不出来的租约不算数（租约总是先写临时文件再改名，正常不会读到写了一半的内容）。
      }
    }
    return leases
  }

  #leaseFile(): string {
    return join(this.#leasesDir, `${this.#leaseHash}.json`)
  }

  async #removeQuietly(path: string): Promise<void> {
    try {
      await rm(path, { recursive: true, force: true })
    } catch (error) {
      this.#logger.warn('runtime: cannot remove %s: %s', basename(path), errorDetail(error))
    }
  }

  // ───────────────────────────── 跨进程锁 ─────────────────────────────

  /**
   * 取得下载锁，或者在等锁期间发现另一个进程已经装好。等待时状态是没有进度数字的 downloading，
   * 配置页据此显示「另一个 dsh 进程正在下载运行时」。
   */
  async #lockOrInstalled(signal: AbortSignal): Promise<HeldLock | 'installed'> {
    for (;;) {
      if (signal.aborted) throw abortError(signal)
      const held = await this.#tryLock()
      if (held !== null) return held
      if ((await this.#checkInstalled()) !== null) return 'installed'
      const stale = await this.#staleLock()
      if (stale !== null) {
        await this.#takeOver(stale)
        continue
      }
      this.#markWaiting()
      await sleep(this.#lockTimings.pollMs, signal)
    }
  }

  /** 删除前取得下载锁：另一个进程正在下载时最多等 removeWaitMs，之后报 promptx/runtime/locked。卸载时不再等。 */
  async #lockForRemove(): Promise<void> {
    const deadline = Date.now() + this.#lockTimings.removeWaitMs
    const signal = this.#disposal.signal
    for (;;) {
      if (signal.aborted) throw abortError(signal)
      if ((await this.#tryLock()) !== null) return
      const stale = await this.#staleLock()
      if (stale !== null) {
        await this.#takeOver(stale)
        continue
      }
      if (Date.now() >= deadline) throw new PromptxError('promptx/runtime/locked', 'another process is downloading the runtime')
      await sleep(this.#lockTimings.pollMs, signal)
    }
  }

  /** mkdir 是原子的：已存在时报 EEXIST，这一步就是「抢锁」。抢到后写入 pid，开始心跳。没抢到时返回 null。 */
  async #tryLock(): Promise<HeldLock | null> {
    // 本实例已经持有（例如两次 remove() 同时进行）：按被占用处理，等前一个放开。
    if (this.#lock !== null) return null
    try {
      await mkdir(this.#lockDir)
    } catch (error) {
      const code = errnoCode(error)
      if (code === 'EEXIST' || (code === 'EPERM' && (await pathExists(this.#lockDir)))) return null
      throw error
    }
    try {
      await writeFile(join(this.#lockDir, 'pid'), `${this.#pid}\n`)
      const info = await stat(this.#lockDir)
      const heartbeat = setInterval(() => {
        background(this.#logger, 'runtime lock heartbeat', this.#beat())
      }, this.#lockTimings.heartbeatMs)
      heartbeat.unref()
      const lock: HeldLock = { ino: info.ino, heartbeat, lost: new AbortController() }
      this.#lock = lock
      return lock
    } catch (error) {
      await rm(this.#lockDir, { recursive: true, force: true })
      throw error
    }
  }

  /**
   * 心跳：刷新锁目录的修改时间。锁目录没了或换成了别人的，说明锁被接管了：马上停下这一轮下载，
   * 不再往 .part 里写（两个进程同时写会把它写坏；万一已经写坏，校验也会拦下）。
   */
  async #beat(): Promise<void> {
    const lock = this.#lock
    if (lock === null) return
    const owned = await this.#ownsLock(lock)
    if (this.#lock !== lock) return
    if (!owned) {
      this.#logger.warn('runtime download lock was taken over by another process')
      clearInterval(lock.heartbeat)
      this.#lock = null
      lock.lost.abort(new PromptxError('promptx/runtime/locked', 'the download lock was taken over'))
      return
    }
    const now = new Date()
    await utimes(this.#lockDir, now, now)
  }

  /**
   * 锁目录还是自己建的那一个：inode 没变，pid 文件里也还是自己的 pid。只比 inode 不够：ext4 等文件系统会很快复用
   * 刚释放的 inode，别人删掉旧锁再建的新锁可能拿到同一个 inode。
   */
  async #ownsLock(lock: HeldLock): Promise<boolean> {
    try {
      if ((await stat(this.#lockDir)).ino !== lock.ino) return false
      return parsePid(await readFile(join(this.#lockDir, 'pid'), 'utf8')) === this.#pid
    } catch {
      return false
    }
  }

  /** 锁已失效时返回它的标识：持有者进程不在了（ESRCH），或心跳超过 staleMs 没刷新（防 pid 被复用）。 */
  async #staleLock(): Promise<{ ino: number; pid: number | null } | null> {
    let info
    try {
      info = await stat(this.#lockDir)
    } catch {
      return null // 锁刚被释放：下一轮去抢
    }
    let pid: number | null = null
    try {
      pid = parsePid(await readFile(join(this.#lockDir, 'pid'), 'utf8'))
    } catch {
      pid = null // 持有者刚建好目录、还没写 pid：只看心跳
    }
    const holderGone = pid !== null && pid !== this.#pid && !pidAlive(pid)
    const silent = Date.now() - info.mtimeMs > this.#lockTimings.staleMs
    return holderGone || silent ? { ino: info.ino, pid } : null
  }

  /**
   * 接管失效的锁。照 dsh-atomic-write 的做法：读到同一把锁的接管者先抢一个以它命名的认领文件，
   * 拿到认领后再核对一次锁还是那一把、仍然失效，才删。这样不会把别人刚建好的新锁当成旧锁删掉。
   */
  async #takeOver(stale: { ino: number; pid: number | null }): Promise<void> {
    const id = createHash('sha256').update(`${stale.ino}:${stale.pid ?? '-'}`).digest('hex').slice(0, 16)
    const claim = join(this.#root, `.lock.takeover-${id}`)
    try {
      await writeFile(claim, `${this.#pid}\n`, { flag: 'wx' })
    } catch (error) {
      const code = errnoCode(error)
      if (code !== 'EEXIST' && code !== 'EPERM') throw error
      await clearStaleClaim(claim)
      await sleep(this.#lockTimings.pollMs, new AbortController().signal)
      return
    }
    try {
      const again = await this.#staleLock()
      if (again !== null && again.ino === stale.ino && again.pid === stale.pid) {
        this.#logger.info('runtime: taking over a stale download lock (holder pid %s)', stale.pid === null ? 'unknown' : String(stale.pid))
        await rm(this.#lockDir, { recursive: true, force: true })
      }
    } finally {
      await rm(claim, { force: true }).catch(() => undefined)
    }
  }

  async #releaseLock(): Promise<void> {
    const lock = this.#lock
    if (lock === null) return
    this.#lock = null
    clearInterval(lock.heartbeat)
    // 只删自己的锁：已经被接管（inode 或 pid 对不上）就不能动别人的。
    if (!(await this.#ownsLock(lock))) return
    try {
      await rm(this.#lockDir, { recursive: true, force: true })
    } catch (error) {
      this.#logger.warn('runtime: cannot release the download lock: %s', errorDetail(error))
    }
  }

  #releaseLockSync(): void {
    const lock = this.#lock
    if (lock === null) return
    this.#lock = null
    clearInterval(lock.heartbeat)
    try {
      if (statSync(this.#lockDir).ino === lock.ino && parsePid(readFileSync(join(this.#lockDir, 'pid'), 'utf8')) === this.#pid) {
        rmSync(this.#lockDir, { recursive: true, force: true })
      }
    } catch {
      // 已经不在了，或删不掉：下一个进程会按「持有者已不在」接管。
    }
  }

  // ───────────────────────────── 状态 ─────────────────────────────

  #markReady(): void {
    this.#state = 'ready'
    this.#error = undefined
    this.#received = undefined
    this.#total = undefined
    this.#emit()
  }

  #markMissing(): void {
    this.#state = 'missing'
    this.#error = undefined
    this.#received = undefined
    this.#total = undefined
    this.#emit()
  }

  /** 另一个进程正在下载：状态是 downloading，但没有进度数字（配置页显示「另一个 dsh 进程正在下载运行时」）。 */
  #markWaiting(): void {
    if (this.#state === 'downloading' && this.#received === undefined && this.#error === undefined) return
    this.#logger.info('runtime: another process is downloading; waiting for it')
    this.#state = 'downloading'
    this.#error = undefined
    this.#received = undefined
    this.#total = undefined
    this.#emit()
  }

  #fail(error: PromptxError): void {
    this.#state = 'failed'
    this.#error = error.toInfo()
    this.#emit()
    this.#logger.warn('runtime install failed: %s%s', error.code, error.detail === undefined ? '' : ` (${error.detail})`)
  }

  #startProgress(received: number, total: number): void {
    this.#state = 'downloading'
    this.#error = undefined
    this.#received = received
    this.#total = total
    this.#lastProgressAt = Date.now()
    this.#emit()
  }

  #progress(received: number, force = false): void {
    this.#received = received
    const now = Date.now()
    if (!force && now - this.#lastProgressAt < PROGRESS_INTERVAL_MS) return
    this.#lastProgressAt = now
    this.#emit()
  }

  #emit(): void {
    for (const listener of [...this.#listeners]) {
      try {
        listener(this.status())
      } catch (error) {
        this.#logger.warn('runtime status listener failed: %s', errorDetail(error))
      }
    }
  }

  #requireRelease(): RuntimeRelease {
    if (this.#release === null) throw new PromptxError('promptx/runtime/unsupported', this.#target)
    return this.#release
  }
}

// ───────────────────────────── 解压工具 ─────────────────────────────

/** 运行系统工具的函数，和 runTool 同形。 */
export type ToolRunner = typeof runTool

/**
 * 各平台默认的解压方式（design-spec 5.1、5.6、D4）：
 * - macOS：`/usr/bin/ditto -x -k --noqtn`，保留 Electron Framework 里的符号链接，不加隔离标记；
 * - Windows：系统自带的 `%SystemRoot%\System32\tar.exe -xf`（bsdtar，能解 zip）；
 * - Linux：`unzip -q`，没装 unzip 时报 promptx/runtime/unzip-missing 并提示安装（Linux 为预览平台）。
 * 工具只拿到 toolEnv 挑出来的环境变量（审查 SEC-04）。env 是挑变量的来源，run 是运行工具的函数，
 * 两个参数都只给测试用（模拟没装 unzip、检查传给工具的环境变量）。
 */
export function defaultExtractor(
  platform: string,
  env: NodeJS.ProcessEnv = process.env,
  run: ToolRunner = runTool,
): (zip: string, dest: string, signal?: AbortSignal) => Promise<void> {
  const childEnv = toolEnv(platform, env)
  if (platform === 'darwin') {
    return (zip, dest, signal) => run('/usr/bin/ditto', ['-x', '-k', '--noqtn', zip, dest], { signal, env: childEnv })
  }
  if (platform === 'win32') {
    const systemRoot = envValue(env, 'SystemRoot', true) ?? 'C:\\Windows'
    return (zip, dest, signal) => run(win32.join(systemRoot, 'System32', 'tar.exe'), ['-xf', zip, '-C', dest], { signal, env: childEnv })
  }
  return async (zip, dest, signal) => {
    try {
      await run('unzip', ['-q', zip, '-d', dest], { signal, env: childEnv })
    } catch (error) {
      if (errnoCode(error) === 'ENOENT') throw new PromptxError('promptx/runtime/unzip-missing', 'unzip was not found in PATH')
      throw error
    }
  }
}

/**
 * 运行一个系统工具，退出码为 0 时成功。不经 shell，参数用数组（design-spec 9「子进程参数注入」）。
 * 不传 env 时只给 toolEnv(process.platform) 挑出的环境变量，不继承 Host 的（审查 SEC-04）：macOS 去隔离标记的 xattr 走的就是这里。
 * 创建 ChildProcess 后第一件事就是挂 error 监听：可执行文件不存在（ENOENT）、没有权限（EACCES）时 Node 发 error 事件，
 * 没人接就是未捕获的异常，会让整个 dsh 退出（审查 S03）。
 */
export function runTool(
  command: string,
  args: readonly string[],
  options: { signal?: AbortSignal | undefined; env?: NodeJS.ProcessEnv } = {},
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const { signal } = options
    if (signal?.aborted === true) {
      reject(abortError(signal))
      return
    }
    let child
    try {
      const env = options.env ?? toolEnv(process.platform)
      child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'], shell: false, windowsHide: true, env })
    } catch (error) {
      reject(asError(error))
      return
    }
    let settled = false
    let stderr = ''
    const finish = (error?: Error): void => {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', onAbort)
      if (error === undefined) resolve()
      else reject(error)
    }
    const onAbort = (): void => {
      try {
        child.kill()
      } catch {
        // 进程已经结束。
      }
      if (signal !== undefined) finish(abortError(signal))
    }
    child.on('error', (error) => {
      finish(error)
    })
    child.stderr.on('error', () => {
      // stderr 只用来拼错误信息，读不到不影响结果。
    })
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < 2_000) stderr += chunk.toString('utf8')
    })
    child.on('close', (code, closeSignal) => {
      if (code === 0) {
        finish()
        return
      }
      const status = code === null ? `signal ${closeSignal ?? 'unknown'}` : `code ${code}`
      const reason = errorDetail(stderr.trim())
      finish(new Error(`${basename(command)} exited with ${status}${reason === '' ? '' : `: ${reason}`}`))
    })
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * 解压和辅助工具（ditto、tar.exe、unzip、xattr）的环境变量：只有 PATH（Windows 上再加 SystemRoot、windir、TEMP、TMP、PATHEXT）
 * 和固定的 LANG=C、LC_ALL=C，其余一律不传（审查 SEC-04）。
 * 坑：dsh 命令行启动时把启动目录的 .env 合进 process.env，只拦 PATH 这类启动相关的变量名，UNZIP、UNZIPOPT 不在其中。
 * Info-ZIP unzip 从 UNZIP、UNZIPOPT 读默认选项，克隆来的仓库里一行 `UNZIP=-LL` 或 `UNZIP=-j` 就能把文件名改成小写、
 * 把目录拍平，可执行文件却还在，坏掉的目录会被标成就绪，所有 profile 共用；bsdtar 也读 TAR_READER_OPTIONS。
 * 所以不继承，按名字挑：PATH 用来找 unzip，dsh 不许 .env 设它；Windows 那几个系统总会设好，.env 不覆盖已有的值，
 * 少了 SystemRoot 等变量有的系统组件初始化不了。语言环境固定成 C，工具的行为和报错文字不随用户设置变化。
 */
function toolEnv(platform: string, source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const windows = platform === 'win32'
  const names = windows ? ['PATH', 'SystemRoot', 'windir', 'TEMP', 'TMP', 'PATHEXT'] : ['PATH']
  const env: NodeJS.ProcessEnv = {}
  for (const name of names) {
    const value = envValue(source, name, windows)
    if (value !== undefined) env[name] = value
  }
  env.LANG = 'C'
  env.LC_ALL = 'C'
  return env
}

/**
 * 取一个环境变量。Windows 的变量名不分大小写（PATH 实际常写成 Path）：真正的 process.env 自己会处理，
 * 测试传进来的普通对象不会，所以 ignoreCase 时按大小写不敏感再找一遍。
 */
function envValue(source: NodeJS.ProcessEnv, name: string, ignoreCase: boolean): string | undefined {
  const exact = source[name]
  if (exact !== undefined || !ignoreCase) return exact
  const upper = name.toUpperCase()
  const key = Object.keys(source).find(candidate => candidate.toUpperCase() === upper)
  return key === undefined ? undefined : source[key]
}

// ───────────────────────────── 小工具 ─────────────────────────────

const silentLogger: HostLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
}

function sourceOrder(source: RuntimeSource): Source[] {
  if (source === 'mirror') return ['mirror']
  if (source === 'official') return ['official']
  return ['mirror', 'official']
}

/** `Content-Range: bytes <start>-<size-1>/<size>`，start 必须正好是本地已有的字节数。 */
function rangeMatches(header: string | null, start: number, size: number): boolean {
  if (header === null) return false
  const match = /^bytes\s+(\d+)-(\d+)\/(\d+)$/i.exec(header.trim())
  if (match === null) return false
  return Number(match[1]) === start && Number(match[2]) === size - 1 && Number(match[3]) === size
}

/**
 * Content-Length 和剩余大小不符时立即中止（design-spec 5.1）：这时还没写任何字节，已有的 .part 留着给下一个源续传。
 * 没有 Content-Length（分块传输）时由 #stream 边收边核对。
 */
async function expectLength(response: Response, expected: number): Promise<void> {
  const header = response.headers.get('content-length')
  if (header === null || Number(header) === expected) return
  await discard(response)
  throw new PromptxError('promptx/runtime/size-mismatch', `Content-Length ${header}, expected ${expected}`)
}

async function discard(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined)
}

async function writeAll(handle: FileHandle, bytes: Uint8Array): Promise<void> {
  let offset = 0
  while (offset < bytes.byteLength) {
    const { bytesWritten } = await handle.write(bytes, offset, bytes.byteLength - offset)
    if (bytesWritten <= 0) throw new PromptxError('promptx/runtime/download-failed', 'cannot write the download')
    offset += bytesWritten
  }
}

async function fileSize(path: string): Promise<number> {
  try {
    return (await stat(path)).size
  } catch {
    return 0
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch {
    return false
  }
}

/**
 * files（相对 dir、用 `/` 分隔）里第一个不在的，都在时返回 undefined。用 stat 而不是 lstat：要跟着符号链接走，
 * macOS 框架里的链接断了也算缺（审查 SEC-04）。
 */
async function firstMissing(dir: string, files: readonly string[]): Promise<string | undefined> {
  for (const file of files) {
    try {
      await stat(join(dir, ...file.split('/')))
    } catch {
      return file
    }
  }
  return undefined
}

async function readdirOrEmpty(path: string): Promise<string[]> {
  try {
    return await readdir(path)
  } catch {
    return []
  }
}

async function clearStaleClaim(claim: string): Promise<void> {
  try {
    if (Date.now() - (await stat(claim)).mtimeMs > CLAIM_STALE_MS) await rm(claim, { force: true })
  } catch {
    // 认领文件已经不在了。
  }
}

/**
 * 改名。Windows 上刚解压出来的文件常被安全软件扫描，改名会短暂地报 EPERM、EBUSY、EACCES，有限次重试
 * （和 dsh-atomic-write 的做法一样）。
 */
async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(from, to)
      return
    } catch (error) {
      const code = errnoCode(error)
      const transient = code === 'EPERM' || code === 'EBUSY' || code === 'EACCES'
      if (process.platform !== 'win32' || !transient || attempt >= 10) throw error
      await delay(50 * (attempt + 1))
    }
  }
}

async function sleep(ms: number, signal: AbortSignal): Promise<void> {
  try {
    await delay(ms, undefined, { signal })
  } catch (error) {
    if (signal.aborted) throw abortError(signal)
    throw error
  }
}

function networkDetail(error: unknown): string {
  const cause: unknown = error instanceof Error ? error.cause : undefined
  return errnoCode(cause) ?? errnoCode(error) ?? errorDetail(cause ?? error)
}

function toPromptxError(error: unknown, fallback: ErrorCode): PromptxError {
  if (error instanceof PromptxError) return error
  const info = toErrorInfo(error, fallback)
  return new PromptxError(fallback, info.detail)
}

function abortReason(detail: string): Error {
  const error = new Error(detail)
  error.name = 'AbortError'
  return error
}

/** 中止信号的原因；原因不是 Error 时包成 AbortError，保证总是以 Error 拒绝。 */
function abortError(signal: AbortSignal): Error {
  const reason: unknown = signal.reason
  return reason instanceof Error ? reason : abortReason('aborted')
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(errorDetail(error))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 租约文件名：profile 哈希本来就是十六进制，这里只是防止意外的字符出现在文件名里。 */
function safeFileName(value: string): string {
  const cleaned = value.replace(/[^a-zA-Z0-9_-]/g, '_')
  return cleaned === '' ? 'default' : cleaned
}
