// 全局快捷键锁文件（design-spec 5.4、D22）：多个 profile 各自运行 PromptX 时，由小程序之间协调同一个组合归谁。
//
// 为什么需要：macOS 上 Electron 经 Chromium 调用 Carbon 的 RegisterEventHotKey 时没有要求独占，
// 同一组合可以被多个应用同时登记，按下时大家都收到，两个小窗会同时切换、互相抢焦点；
// register() 的返回值说明不了冲突。Windows、Linux 的登记本身是独占的，但锁文件能给出更准确的原因
// （「已被 profile X 的 PromptX 使用」而不是「已被其他应用占用」），所以各平台都用。
//
// 锁文件：`<dsh>/promptx/locks/shortcut-<组合的 SHA-256 前 16 位>.json`，内容是 pid 和 profile 名。
// 持有者进程已不在才接管。不同 DSH_HOME 之间不协调（已知限制）。

import { createHash } from 'node:crypto'
import { linkSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
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
}

/** 链接不支持时（某些网络盘、FAT 卷）退回独占创建。 */
const LINK_UNSUPPORTED = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EXDEV', 'EMLINK'])

export class ShortcutLocks {
  readonly #dir: string
  readonly #pid: number
  readonly #profile: string
  readonly #isAlive: (pid: number) => boolean
  readonly #onProblem: (code: string) => void
  readonly #held = new Set<string>()

  constructor(options: ShortcutLocksOptions) {
    this.#dir = options.dir
    this.#pid = options.pid
    this.#profile = options.profile
    this.#isAlive = options.isAlive ?? isProcessAlive
    this.#onProblem = options.onProblem ?? (() => {})
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
      if (holder !== null && this.#isAlive(holder.pid)) return { ok: false, holder }
      // 持有者已不在（崩溃后留下的锁），或者文件坏了：挪走重来。
      if (!this.#removeStale(path, raw)) return { ok: true, locked: false }
    }
    return { ok: true, locked: false }
  }

  /**
   * 删掉一个死锁。不能直接 rm：两个小程序同时接管同一个死锁时，慢的那个读到的还是旧内容，
   * 等它 rm 的时候文件可能已经是快的那个刚建好的新锁，结果两边都以为自己拿到了。
   * 所以先 rename 到自己名下（只有一个进程能挪走同一个文件），挪走的内容和刚才读到的不同，
   * 说明挪走的是别人的新锁，用 link 放回去（目标又被建了时放不回，留给下一轮判断）。
   * 返回 false 表示锁目录出了问题，调用方退化成不协调。
   */
  #removeStale(path: string, raw: string): boolean {
    const aside = `${path}.${this.#pid}.stale`
    try {
      renameSync(path, aside)
    } catch (error) {
      if (codeOf(error) === 'ENOENT') return true
      this.#onProblem(codeOf(error))
      return false
    }
    try {
      if (readRaw(aside) !== raw) {
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

  /** 只读地看一眼：锁文件在、内容可读、持有者不是自己且还活着。读不出来按没人持有算（acquire 时会接管坏文件）。 */
  heldByOther(key: string): boolean {
    const holder = readHolder(shortcutLockPath(this.#dir, key))
    return holder !== null && holder.pid !== this.#pid && this.#isAlive(holder.pid)
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
