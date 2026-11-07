// 同一个 profile 只允许一个 PromptX 实例（design-spec 4.1、D21）。两个 dsh 进程用同一个 profile 时
// （例如桌面版和 `dsh --profile desktop` 同时开着），dsh 的 JSON 存储没有跨进程锁，两边都写草稿会互相覆盖（产品红线 1），
// 所以后启动的那个不打开草稿、不启动小程序。
//
// 锁文件是 `<dsh>/promptx/locks/instance-<profile 哈希>.lock`，用 `wx` 独占创建并写入 pid。已存在时读出 pid：
// 进程已不在（`process.kill(pid, 0)` 抛 ESRCH）才接管；存活（包括 EPERM：进程在但属于别的用户）就视为被占用。
// 接管的做法照 @deepseek-ai/dsh-atomic-write 的 withFileLock：读到同一份记录的接管者先抢一个以记录命名的认领文件，
// 拿到认领后再核对一次锁还是那份记录、持有者仍然不在，才删。这样两个接管者不会把对方刚建好的新锁当成旧锁删掉。
//
// 记录里正好是本进程自己的 pid 时，「pid 还活着」说明不了被谁占用：可能是本进程里另一个实例持有（插件重载时旧实例还在收尾），
// 也可能是上一个恰好用过同一个 pid 的 dsh 进程崩溃后留下的（重启电脑后登录项拿到相同 pid 并不罕见）。后一种按存活处理的话，
// 这个 profile 的 PromptX 会一直报「另一个 dsh 进程已在运行」。所以本进程持有的锁另外记在进程级的登记表里：
// 记录是本进程的 pid、登记表里却没有，就是上一个进程留下的，按持有者已不在接管。

import { createHash } from 'node:crypto'
import { lstat, mkdir, open, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

import { PromptxError } from '../shared/errors.ts'
import { errnoCode, parsePid, pidAlive } from './process-utils.ts'

export type InstanceLockResult =
  | { acquired: true; release(): Promise<void> }
  | { acquired: false; holderPid: number }

/** 抢锁的轮数上限：每一轮要么抢到、要么确认被占用、要么清掉一个不在了的持有者，正常两三轮就结束。 */
const MAX_ROUNDS = 50
/** 持有者用 `wx` 建好文件、还没写入 pid 的一瞬间会读到空内容：隔这么久再读。 */
const RECORD_RETRY_MS = 20
/** 连续读到这么多次不完整的记录，就当持有者写到一半退出了。 */
const RECORD_RETRY_LIMIT = 10
/** 认领文件放了这么久还在，说明认领者中途退出了，可以清掉。 */
const CLAIM_STALE_MS = 10_000

/**
 * 本进程持有（或正在取得）的实例锁路径。挂在 globalThis 上而不是模块变量：插件重载时模块可能被重新加载，
 * 模块变量看不到旧实例持有的锁。
 */
const HELD_KEY = Symbol.for('dsh-promptx.instance-locks')

function heldLocks(): Set<string> {
  const store = globalThis as unknown as Record<symbol, Set<string> | undefined>
  let held = store[HELD_KEY]
  if (held === undefined) {
    held = new Set()
    store[HELD_KEY] = held
  }
  return held
}

/**
 * 取得实例锁。pid 默认是本进程；测试可以传别的值模拟另一个进程。
 * 返回 `acquired: false` 时 holderPid 是持有者的 pid；它等于本进程的 pid 时，说明本进程里还有一个实例没释放
 * （例如插件重载时旧实例还在收尾），调用方可以稍后再试。
 */
export async function acquireInstanceLock(path: string, pid: number = process.pid): Promise<InstanceLockResult> {
  const own = pid === process.pid
  const key = resolve(path)
  const held = heldLocks()
  if (own) {
    // 同步占位：本进程里同时来的第二个调用直接看到「已被本进程持有」，不用去和自己抢文件。
    if (held.has(key)) return { acquired: false, holderPid: pid }
    held.add(key)
  }
  let result: InstanceLockResult
  try {
    result = await acquireFile(path, pid, own)
  } catch (error) {
    if (own) held.delete(key)
    throw error
  }
  if (!result.acquired) {
    if (own) held.delete(key)
    return result
  }
  const file = result
  return {
    acquired: true,
    release: async () => {
      try {
        await file.release()
      } finally {
        if (own) held.delete(key)
      }
    },
  }
}

async function acquireFile(path: string, pid: number, own: boolean): Promise<InstanceLockResult> {
  await mkdir(dirname(path), { recursive: true })
  let incomplete = 0
  for (let round = 0; round < MAX_ROUNDS; round++) {
    if (await tryCreate(path, pid)) return { acquired: true, release: releaser(path, pid) }
    const record = await readRecord(path)
    if (record === undefined) continue // 锁刚被释放：再抢一次
    const holder = parsePid(record)
    if (holder === null) {
      incomplete += 1
      if (incomplete < RECORD_RETRY_LIMIT) {
        await delay(RECORD_RETRY_MS)
        continue
      }
    } else if (!abandoned(holder, own)) {
      return { acquired: false, holderPid: holder }
    }
    await takeOver(path, record, own)
  }
  throw new PromptxError('promptx/internal', 'instance lock contention did not settle')
}

/**
 * 记录里的持有者是否已经不在。own 为 true 时调用方就是本进程、并且已经在登记表里占了位，
 * 所以记录里的 pid 等于本进程时，它只能是上一个同 pid 的进程留下的。
 */
function abandoned(holder: number, own: boolean): boolean {
  if (holder === process.pid) return own
  return !pidAlive(holder)
}

/** 用 `wx` 独占创建锁文件并写入 pid。已存在时返回 false。 */
async function tryCreate(path: string, pid: number): Promise<boolean> {
  let handle
  try {
    handle = await open(path, 'wx', 0o644)
  } catch (error) {
    const code = errnoCode(error)
    if (code === 'EEXIST') return false
    // Windows 上独占创建撞上已存在（或正在被删除）的文件时可能报 EPERM：文件确实在就按占用处理。
    if (code === 'EPERM' && (await exists(path))) return false
    throw error
  }
  try {
    await handle.writeFile(`${pid}\n`)
  } catch (error) {
    // 建好了却没写进 pid（例如磁盘满）：留着它会让别人一直读到不完整的记录，删掉再报错。
    await handle.close()
    await rm(path, { force: true })
    throw error
  }
  await handle.close()
  return true
}

async function readRecord(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return undefined
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch {
    return false
  }
}

/** 清掉一个持有者已不在的锁。拿不到认领（别人正在接管）时什么也不做，下一轮重新判断。 */
async function takeOver(path: string, record: string, own: boolean): Promise<void> {
  const claim = `${path}.takeover-${createHash('sha256').update(record).digest('hex').slice(0, 16)}`
  try {
    await writeFile(claim, `${process.pid}\n`, { flag: 'wx', mode: 0o644 })
  } catch (error) {
    const code = errnoCode(error)
    if (code !== 'EEXIST' && code !== 'EPERM') throw error
    await clearStaleClaim(claim)
    await delay(RECORD_RETRY_MS)
    return
  }
  try {
    // 拿到认领后再核对一次：还是那份记录，持有者仍然不在（写到一半的记录也算不在）。
    if ((await readRecord(path)) !== record) return
    const holder = parsePid(record)
    if (holder === null || abandoned(holder, own)) await rm(path, { force: true })
  } finally {
    await rm(claim, { force: true }).catch(() => undefined)
  }
}

async function clearStaleClaim(claim: string): Promise<void> {
  try {
    const info = await stat(claim)
    if (Date.now() - info.mtimeMs > CLAIM_STALE_MS) await rm(claim, { force: true })
  } catch {
    // 认领文件已经被删掉：正好，下一轮再试。
  }
}

function releaser(path: string, pid: number): () => Promise<void> {
  let released = false
  return async () => {
    if (released) return
    released = true
    // 只删自己的锁：里面已经不是自己的 pid（被人接管过）就不动。
    const record = await readRecord(path)
    if (record !== undefined && parsePid(record) === pid) await rm(path, { force: true })
  }
}
