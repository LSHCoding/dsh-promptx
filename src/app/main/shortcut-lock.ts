// 全局快捷键锁文件（design-spec 5.4、D22）：多个 profile 各自运行 PromptX 时，由小程序之间协调同一个组合归谁。
//
// 为什么需要：macOS 上 Electron 经 Chromium 调用 Carbon 的 RegisterEventHotKey 时没有要求独占，
// 同一组合可以被多个应用同时登记，按下时大家都收到，两个小窗会同时切换、互相抢焦点；
// register() 的返回值说明不了冲突。Windows、Linux 的登记本身是独占的，但锁文件能给出更准确的原因
// （「已被 profile X 的 PromptX 使用」而不是「已被其他应用占用」），所以各平台都用。
//
// 锁文件：`<dsh>/promptx/locks/shortcut-<组合的 SHA-256 前 16 位>.json`，内容是 pid 和 profile 名。
// 不同 DSH_HOME 之间不协调（已知限制）。
//
// 什么时候接管（审查 F2）。只看 pid 不够：断电、强制退出、崩溃之后 pid 可能已被不相干的进程复用（或者是别的用户的进程，
// kill(pid, 0) 报 EPERM），旧锁文件会让快捷键永远登记不上、一直报「已被 profile X 的 PromptX 使用」。所以加心跳：
// - 持有者每隔几秒（app.ts 的计时器，最长 LOCK_REFRESH_MS）把自己持有的锁文件的 mtime 改成现在；
// - 持有者进程已不在：立即接管（原来的规则）；
// - 持有者进程还在：某次看到 mtime 已经超过 LOCK_STALE_MS 没变，先记下；按本进程的单调时钟至少再过 LOCK_CONFIRM_MS、
//   mtime 和内容都还一模一样，才算死锁接管。单调时钟在系统睡眠时不走，睡醒后持有者有机会先刷新，不会刚醒就被抢；
// - 持有者刷新时发现锁已经不在自己名下（自己被当成了已退出），交给 ShortcutManager 注销快捷键、按被别的 profile 占用上报。
// Host 的实例锁（src/companion/instance-lock.ts）用同一套规则。

import { createHash } from 'node:crypto'
import { linkSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseAccelerator, type AcceleratorModifier } from '../../shared/accelerator.ts'

export interface LockHolder {
  pid: number
  profile: string
}

/**
 * ok 且 locked：拿到了锁。ok 但没有 locked：锁目录写不进去，退化成不协调（照常登记，不能因为锁文件坏了让快捷键失效）。
 * 不 ok：另一个存活的 PromptX 持有这个组合。
 */
export type LockResult = { ok: true; locked: boolean } | { ok: false; holder: LockHolder }

/** 心跳时发现已经不在自己名下的锁：键和现在的持有者。 */
export interface LostLock {
  key: string
  holder: LockHolder
}

/** 持有者刷新锁文件 mtime 的最长间隔（app.ts 按 min(heldRetryMs, 这个值) 调用 ShortcutManager.heartbeat）。 */
export const LOCK_REFRESH_MS = 15_000

/** mtime 超过这么久没变，才开始怀疑持有者已经不在（pid 被别的进程复用）。远大于刷新间隔，偶尔晚一两次不会误判。 */
export const LOCK_STALE_MS = 60_000

/** 起疑之后按本进程的单调时钟至少再等这么久，mtime 仍然没变才接管。 */
export const LOCK_CONFIRM_MS = 45_000

/** 锁文件的 mtime 读写，测试换成假的。 */
export interface LockFileTimes {
  /** 锁文件的 mtime（毫秒）。文件不在时抛出。 */
  mtimeMs(path: string): number
  /** 把锁文件的 mtime 改成现在（心跳）。 */
  touch(path: string): void
}

const NODE_FILE_TIMES: LockFileTimes = {
  mtimeMs: path => statSync(path).mtimeMs,
  touch: (path) => {
    const now = new Date()
    utimesSync(path, now, now)
  },
}

const PHYSICAL_ORDER: readonly AcceleratorModifier[] = ['Command', 'Control', 'Alt', 'Shift', 'Super']

/**
 * 按物理按键规范化的组合，用作锁的键。CommandOrControl 在 macOS 上就是 Command、在其他平台上就是 Control，
 * Super 在 macOS 上也落到 ⌘：两个 profile 分别写了 `CommandOrControl+P` 和 `Command+P` 时按的是同一组键，必须算同一把锁。
 * 写法不合法时返回 null。
 */
export function physicalShortcutKey(accelerator: string, platform: string): string | null {
  const parsed = parseAccelerator(accelerator)
  if (!parsed.ok) return null
  const modifiers = new Set<AcceleratorModifier>()
  for (const modifier of parsed.modifiers) {
    if (platform === 'darwin') modifiers.add(modifier === 'CommandOrControl' || modifier === 'Super' ? 'Command' : modifier)
    else if (modifier === 'CommandOrControl') modifiers.add('Control')
    else modifiers.add(modifier === 'Command' ? 'Super' : modifier)
  }
  return [...PHYSICAL_ORDER.filter(modifier => modifiers.has(modifier)), parsed.key].join('+')
}

export function shortcutLockPath(dir: string, key: string): string {
  const digest = createHash('sha256').update(key, 'utf8').digest('hex').slice(0, 16)
  return join(dir, `shortcut-${digest}.json`)
}

/** `process.kill(pid, 0)`：成功或 EPERM（别的用户的进程）都算存活，只有 ESRCH 算已不在。 */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export interface ShortcutLocksOptions {
  dir: string
  pid: number
  profile: string
  isAlive?: (pid: number) => boolean
  /** 锁目录不可用时调用（只传错误码），用于记日志。 */
  onProblem?: (code: string) => void
  /** 单调时钟（毫秒，主进程传 platform.now，即 performance.now）：确认「一直没刷新」的等待按它算，系统睡眠时不走。 */
  now?: () => number
  /** 墙上时钟（毫秒），和锁文件的 mtime 比较用。 */
  wallNow?: () => number
  files?: LockFileTimes
}

/** 链接不支持时（某些网络盘、FAT 卷）退回独占创建。 */
const LINK_UNSUPPORTED = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EXDEV', 'EMLINK'])

/** 起疑时看到的锁：原文、mtime，和起疑那一刻的单调时钟。 */
interface Suspect {
  raw: string
  mtimeMs: number
  since: number
}

export class ShortcutLocks {
  readonly #dir: string
  readonly #pid: number
  readonly #profile: string
  readonly #isAlive: (pid: number) => boolean
  readonly #onProblem: (code: string) => void
  readonly #now: () => number
  readonly #wallNow: () => number
  readonly #files: LockFileTimes
  readonly #held = new Set<string>()
  /** 按锁文件路径记下的「持有者还活着、mtime 却久未刷新」的锁。 */
  readonly #suspects = new Map<string, Suspect>()

  constructor(options: ShortcutLocksOptions) {
    this.#dir = options.dir
    this.#pid = options.pid
    this.#profile = options.profile
    this.#isAlive = options.isAlive ?? isProcessAlive
    this.#onProblem = options.onProblem ?? (() => {})
    this.#now = options.now ?? (() => performance.now())
    this.#wallNow = options.wallNow ?? Date.now
    this.#files = options.files ?? NODE_FILE_TIMES
  }

  acquire(key: string): LockResult {
    const path = shortcutLockPath(this.#dir, key)
    try {
      mkdirSync(this.#dir, { recursive: true })
    } catch (error) {
      this.#onProblem(codeOf(error))
      return { ok: true, locked: false }
    }
    // 有限次重试：每一轮要么建成、要么确认被占、要么挪走一个死锁再来。并发接管同一个死锁时最多多转几圈。
    for (let attempt = 0; attempt < 4; attempt++) {
      const created = this.#create(path)
      if (created === 'created') {
        this.#held.add(key)
        this.#suspects.delete(path)
        return { ok: true, locked: true }
      }
      if (created === 'failed') return { ok: true, locked: false }
      const raw = readRaw(path)
      // 刚被别人删掉（对方正好在接管或释放）：再试一次创建。
      if (raw === null) continue
      const holder = parseHolder(raw)
      if (holder !== null && holder.pid === this.#pid) {
        this.#held.add(key)
        return { ok: true, locked: true }
      }
      let confirmedMtime: number | undefined
      if (holder !== null && this.#isAlive(holder.pid)) {
        const stale = this.#staleSince(path, raw)
        if (stale === null) return { ok: false, holder }
        confirmedMtime = stale
      }
      // 持有者已不在（崩溃后留下的锁）、锁久未刷新且已确认，或者文件坏了：挪走重来。
      this.#suspects.delete(path)
      if (!this.#removeStale(path, raw, confirmedMtime)) return { ok: true, locked: false }
    }
    return { ok: true, locked: false }
  }

  /**
   * 持有者进程还活着时，这把锁是不是已经没人维护（审查 F2）。mtime 超过 LOCK_STALE_MS 没变时先记下；
   * 之后的检查里原文和 mtime 都一模一样、离起疑已经过了至少 LOCK_CONFIRM_MS（单调时钟）才算死锁，返回那个 mtime，
   * 交给 #removeStale 在挪走时再核对一次。其余情况返回 null，中间看到任何变化都重新起算。
   */
  #staleSince(path: string, raw: string): number | null {
    let mtimeMs: number
    try {
      mtimeMs = this.#files.mtimeMs(path)
    } catch {
      // 读不到 mtime（刚被删掉或换掉）：这一轮不下结论，下一轮重新看。
      this.#suspects.delete(path)
      return null
    }
    if (this.#wallNow() - mtimeMs <= LOCK_STALE_MS) {
      this.#suspects.delete(path)
      return null
    }
    const now = this.#now()
    const suspect = this.#suspects.get(path)
    if (suspect?.raw !== raw || suspect.mtimeMs !== mtimeMs) {
      this.#suspects.set(path, { raw, mtimeMs, since: now })
      return null
    }
    return now - suspect.since >= LOCK_CONFIRM_MS ? mtimeMs : null
  }

  /**
   * 删掉一个死锁。不能直接 rm：两个小程序同时接管同一个死锁时，慢的那个读到的还是旧内容，
   * 等它 rm 的时候文件可能已经是快的那个刚建好的新锁，结果两边都以为自己拿到了。
   * 所以先 rename 到自己名下（只有一个进程能挪走同一个文件），挪走的内容和刚才读到的不同，
   * 说明挪走的是别人的新锁，用 link 放回去（目标又被建了时放不回，留给下一轮判断）。
   * 按心跳判定的死锁（confirmedMtime 有值）还要核对 mtime：确认之后、挪走之前持有者刚好刷新过，说明它还活着，同样放回去。
   * 返回 false 表示锁目录出了问题，调用方退化成不协调。
   */
  #removeStale(path: string, raw: string, confirmedMtime?: number): boolean {
    const aside = `${path}.${this.#pid}.stale`
    try {
      renameSync(path, aside)
    } catch (error) {
      if (codeOf(error) === 'ENOENT') return true
      this.#onProblem(codeOf(error))
      return false
    }
    try {
      if (readRaw(aside) !== raw || (confirmedMtime !== undefined && this.#mtimeOr(aside, Number.NaN) !== confirmedMtime)) {
        try {
          linkSync(aside, path)
        } catch {
          // 又有人建了新锁：下一轮会读到它。
        }
      }
    } finally {
      try {
        rmSync(aside, { force: true })
      } catch {
        // 挪到旁边的文件删不掉不影响锁本身；下次同名时会被覆盖。
      }
    }
    return true
  }

  #mtimeOr(path: string, fallback: number): number {
    try {
      return this.#files.mtimeMs(path)
    } catch {
      return fallback
    }
  }

  /**
   * 只读地看一眼：锁文件在、内容可读、持有者不是自己且还活着，并且没有被确认为久未刷新的死锁（审查 F2）。
   * 读不出来按没人持有算（acquire 时会接管坏文件）。不改动任何文件，只在内存里记下起疑的时间。
   */
  heldByOther(key: string): boolean {
    const path = shortcutLockPath(this.#dir, key)
    const raw = readRaw(path)
    const holder = raw === null ? null : parseHolder(raw)
    if (raw === null || holder === null || holder.pid === this.#pid || !this.#isAlive(holder.pid)) return false
    return this.#staleSince(path, raw) === null
  }

  /**
   * 心跳（审查 F2）：把自己持有的每把锁的 mtime 改成现在，证明持有者还活着。锁文件已经不在自己名下时
   * （自己被当成已退出、被别的 PromptX 接管，或者文件被删、被写坏），按 acquire 的规则重新判断一次：
   * 还能拿回来就照常持有；另一个存活的 PromptX 持有着就从持有集合里去掉，返回给调用方注销快捷键。
   * 锁目录出了问题（拿不回来、也说不出谁持有）时退化成不协调，不再刷新它，快捷键照常保留，和登记时的退化一致。
   */
  refresh(): LostLock[] {
    const lost: LostLock[] = []
    for (const key of [...this.#held]) {
      const path = shortcutLockPath(this.#dir, key)
      if (readHolder(path)?.pid === this.#pid) {
        try {
          this.#files.touch(path)
        } catch (error) {
          // 刷新不了（锁目录变成只读之类）：锁还在自己名下，下一次心跳再试；一直刷新不了时别人等过确认期会接管。
          this.#onProblem(codeOf(error))
        }
        continue
      }
      this.#held.delete(key)
      const result = this.acquire(key)
      if (!result.ok) lost.push({ key, holder: result.holder })
    }
    return lost
  }

  /** 只删自己的锁：文件已被别人接管（我们被当成死进程）时不动它。 */
  release(key: string): void {
    if (!this.#held.delete(key)) return
    const path = shortcutLockPath(this.#dir, key)
    if (readHolder(path)?.pid !== this.#pid) return
    try {
      rmSync(path, { force: true })
    } catch (error) {
      this.#onProblem(codeOf(error))
    }
  }

  releaseAll(): void {
    for (const key of [...this.#held]) this.release(key)
  }

  /**
   * 先把完整内容写进临时文件，再用 link 原子地放到锁的位置（目标已存在时 link 失败）。
   * 直接 `open(path, 'wx')` 再写内容的话，别的进程可能读到还没写完的空文件，把它当成坏锁删掉。
   */
  #create(path: string): 'created' | 'exists' | 'failed' {
    const content = `${JSON.stringify({ pid: this.#pid, profile: this.#profile, createdAt: new Date().toISOString() })}\n`
    const tmp = `${path}.${this.#pid}.tmp`
    try {
      writeFileSync(tmp, content)
      try {
        linkSync(tmp, path)
        return 'created'
      } catch (error) {
        const code = codeOf(error)
        if (code === 'EEXIST') return 'exists'
        if (!LINK_UNSUPPORTED.has(code)) throw error
      }
      try {
        writeFileSync(path, content, { flag: 'wx' })
        return 'created'
      } catch (error) {
        if (codeOf(error) === 'EEXIST') return 'exists'
        throw error
      }
    } catch (error) {
      this.#onProblem(codeOf(error))
      return 'failed'
    } finally {
      try {
        rmSync(tmp, { force: true })
      } catch {
        // 临时文件删不掉不影响结果；下次用同一个名字时会被覆盖。
      }
    }
  }
}

/** 锁文件的原文；不存在或读不出来时为 null。 */
function readRaw(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

function parseHolder(text: string): LockHolder | null {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof raw !== 'object' || raw === null) return null
  const { pid, profile } = raw as { pid?: unknown; profile?: unknown }
  if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0) return null
  return { pid, profile: typeof profile === 'string' ? profile : '' }
}

function readHolder(path: string): LockHolder | null {
  const raw = readRaw(path)
  return raw === null ? null : parseHolder(raw)
}

function codeOf(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | null)?.code
  return typeof code === 'string' ? code : 'unknown'
}
