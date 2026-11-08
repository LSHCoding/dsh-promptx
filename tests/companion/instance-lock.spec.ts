import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { acquireInstanceLock, CONFIRM_MS, STALE_MS, type LockClock } from '../../src/companion/instance-lock.ts'
import { pidAlive } from '../../src/companion/process-utils.ts'
import { failOnProcessProblems } from './process-traps.ts'

const roots: string[] = []
const sleepers: ChildProcess[] = []

async function lockPath(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'promptx-instance-'))
  roots.push(root)
  return join(root, 'locks', 'instance-0123456789abcdef.lock')
}

function liveProcess(): number {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  child.on('error', () => {})
  sleepers.push(child)
  return child.pid!
}

async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' })
  child.on('error', () => {})
  const pid = child.pid!
  await new Promise<void>((resolve) => {
    child.on('exit', () => {
      resolve()
    })
  })
  while (pidAlive(pid)) await new Promise(resolve => setTimeout(resolve, 10))
  return pid
}

failOnProcessProblems()

afterEach(async () => {
  vi.restoreAllMocks()
  for (const child of sleepers.splice(0)) child.kill('SIGKILL')
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('acquireInstanceLock', () => {
  it('creates the lock with the pid and releases it', async () => {
    const path = await lockPath()
    const lock = await acquireInstanceLock(path)
    expect(lock.acquired).toBe(true)
    expect(await readFile(path, 'utf8')).toBe(`${process.pid}\n`)
    if (!lock.acquired) return
    await lock.release()
    expect(await readdir(join(path, '..'))).toEqual([])
    // 释放可以重复调用。
    await lock.release()
    const again = await acquireInstanceLock(path)
    expect(again.acquired).toBe(true)
  })

  it('refuses while another live process holds the lock', async () => {
    const path = await lockPath()
    const other = liveProcess()
    const first = await acquireInstanceLock(path, other)
    expect(first.acquired).toBe(true)
    expect(await acquireInstanceLock(path)).toEqual({ acquired: false, holderPid: other })
    // 被拒绝的一方没有动锁文件。
    expect(await readFile(path, 'utf8')).toBe(`${other}\n`)
  })

  it('reports the same pid when this process already holds the lock', async () => {
    const path = await lockPath()
    const first = await acquireInstanceLock(path)
    expect(first.acquired).toBe(true)
    expect(await acquireInstanceLock(path)).toEqual({ acquired: false, holderPid: process.pid })
    // 另一个进程（这里用别的 pid 模拟）看到的持有者也是本进程。
    expect(await acquireInstanceLock(path, liveProcess())).toEqual({ acquired: false, holderPid: process.pid })
    if (first.acquired) await first.release()
    expect((await acquireInstanceLock(path)).acquired).toBe(true)
  })

  it('takes over a stale lock that carries this process\'s own pid', async () => {
    // 上一个 dsh 进程崩溃后留下锁，这一个进程恰好拿到了同一个 pid（重启后登录项拿到相同 pid）：本进程里并没有实例持有它。
    const path = await lockPath()
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, `${process.pid}\n`)
    const lock = await acquireInstanceLock(path)
    expect(lock.acquired).toBe(true)
    expect(await readFile(path, 'utf8')).toBe(`${process.pid}\n`)
    expect(await readdir(dirname(path))).toEqual(['instance-0123456789abcdef.lock'])
    // 接管之后本进程里的第二个实例照样被拒绝。
    expect(await acquireInstanceLock(path)).toEqual({ acquired: false, holderPid: process.pid })
    if (lock.acquired) await lock.release()
  })

  it('takes over a lock whose holder exited', async () => {
    const path = await lockPath()
    const dead = await deadPid()
    const stale = await acquireInstanceLock(path, dead)
    expect(stale.acquired).toBe(true)
    const lock = await acquireInstanceLock(path)
    expect(lock.acquired).toBe(true)
    expect(await readFile(path, 'utf8')).toBe(`${process.pid}\n`)
    // 接管时的认领文件不留下。
    expect(await readdir(join(path, '..'))).toEqual(['instance-0123456789abcdef.lock'])
    if (lock.acquired) await lock.release()
  })

  it('treats a holder that exists under another user (EPERM) as alive', async () => {
    const path = await lockPath()
    await acquireInstanceLock(path, 424_242)
    const realKill = process.kill.bind(process)
    vi.spyOn(process, 'kill').mockImplementation((pid: number, signal?: string | number) => {
      if (pid === 424_242) throw Object.assign(new Error('kill EPERM'), { code: 'EPERM' })
      return realKill(pid, signal)
    })
    expect(await acquireInstanceLock(path)).toEqual({ acquired: false, holderPid: 424_242 })
  })

  it('takes over an incomplete record left by a holder that crashed while writing it', async () => {
    const path = await lockPath()
    await acquireInstanceLock(path, 1)
    await writeFile(path, '')
    const lock = await acquireInstanceLock(path)
    expect(lock.acquired).toBe(true)
    expect(await readFile(path, 'utf8')).toBe(`${process.pid}\n`)
    if (lock.acquired) await lock.release()
  })

  it('clears a takeover claim abandoned by a crashed contender', async () => {
    const path = await lockPath()
    const dead = await deadPid()
    await acquireInstanceLock(path, dead)
    const record = `${dead}\n`
    const claim = `${path}.takeover-${createHash('sha256').update(record).digest('hex').slice(0, 16)}`
    await writeFile(claim, '1\n')
    const old = new Date(Date.now() - 60_000)
    await utimes(claim, old, old)
    const lock = await acquireInstanceLock(path)
    expect(lock.acquired).toBe(true)
    if (lock.acquired) await lock.release()
  })

  it('only releases its own lock', async () => {
    const path = await lockPath()
    const lock = await acquireInstanceLock(path)
    if (!lock.acquired) throw new Error('expected the lock')
    await writeFile(path, '777\n')
    await lock.release()
    expect(await readFile(path, 'utf8')).toBe('777\n')
  })

  it('lets exactly one of several concurrent contenders win', async () => {
    const path = await lockPath()
    const results = await Promise.all(Array.from({ length: 6 }, () => acquireInstanceLock(path)))
    expect(results.filter(result => result.acquired)).toHaveLength(1)
    expect(results.filter(result => !result.acquired)).toHaveLength(5)
    for (const result of results) if (result.acquired) await result.release()
  })

  it('lets exactly one of several processes win when they race for a stale lock', async () => {
    // 几个「进程」（不同的 pid）同时发现持有者已经不在：只有一个能接管成功。
    const path = await lockPath()
    await acquireInstanceLock(path, await deadPid())
    const contenders = [liveProcess(), liveProcess(), liveProcess(), liveProcess()]
    const results = await Promise.all(contenders.map(pid => acquireInstanceLock(path, pid)))
    const winners = results.filter(result => result.acquired)
    expect(winners).toHaveLength(1)
    const owner = Number((await readFile(path, 'utf8')).trim())
    expect(contenders).toContain(owner)
    for (const result of results) {
      if (!result.acquired) expect(result.holderPid).toBe(owner)
    }
    // 认领文件都清掉了。
    expect(await readdir(dirname(path))).toEqual(['instance-0123456789abcdef.lock'])
  })
})

// 审查 F2：dsh 没走清理就退出后，锁文件里的 pid 可能被一个无关的活进程复用。只看 pid 会让这个 profile 一直起不来小程序。
describe('instance lock heartbeat', () => {
  /** 墙上时钟用真实时间（和文件的修改时间比较），单调时钟由测试拨动。 */
  function fakeClock(): LockClock & { advance(ms: number): void } {
    let mono = 0
    return {
      now: () => Date.now(),
      monotonic: () => mono,
      advance: (ms: number) => {
        mono += ms
      },
    }
  }

  async function plantLock(path: string, pid: number, ageMs: number): Promise<void> {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, `${pid}\n`)
    const when = new Date(Date.now() - ageMs)
    await utimes(path, when, when)
  }

  it('never takes a lock whose live holder keeps its heartbeat fresh', async () => {
    const path = await lockPath()
    const holder = liveProcess()
    const clock = fakeClock()
    await plantLock(path, holder, 1_000)
    for (let i = 0; i < 4; i++) {
      expect(await acquireInstanceLock(path, process.pid, clock)).toEqual({ acquired: false, holderPid: holder })
      clock.advance(CONFIRM_MS)
    }
  })

  it('takes a live-pid lock only after its heartbeat stayed stale through the confirmation window', async () => {
    const path = await lockPath()
    const reused = liveProcess()
    const clock = fakeClock()
    await plantLock(path, reused, STALE_MS + 60_000)
    expect(await acquireInstanceLock(path, process.pid, clock)).toEqual({ acquired: false, holderPid: reused })
    clock.advance(CONFIRM_MS - 1)
    expect(await acquireInstanceLock(path, process.pid, clock)).toEqual({ acquired: false, holderPid: reused })
    clock.advance(1)
    const lock = await acquireInstanceLock(path, process.pid, clock)
    expect(lock.acquired).toBe(true)
    expect((await readFile(path, 'utf8')).trim()).toBe(String(process.pid))
    if (lock.acquired) await lock.release()
  })

  it('drops the suspicion when the holder refreshes its heartbeat in between', async () => {
    const path = await lockPath()
    const holder = liveProcess()
    const clock = fakeClock()
    await plantLock(path, holder, STALE_MS + 60_000)
    expect((await acquireInstanceLock(path, process.pid, clock)).acquired).toBe(false)
    // 持有者醒来补上了心跳。
    const now = new Date()
    await utimes(path, now, now)
    clock.advance(CONFIRM_MS)
    expect((await acquireInstanceLock(path, process.pid, clock)).acquired).toBe(false)
    // 之后又停了：重新开始计时，不沿用上一次的怀疑。
    await plantLock(path, holder, STALE_MS + 60_000)
    clock.advance(CONFIRM_MS)
    expect((await acquireInstanceLock(path, process.pid, clock)).acquired).toBe(false)
    clock.advance(CONFIRM_MS)
    const lock = await acquireInstanceLock(path, process.pid, clock)
    expect(lock.acquired).toBe(true)
    if (lock.acquired) await lock.release()
  })

  it('refresh() renews the heartbeat while the lock is ours and reports a takeover', async () => {
    const path = await lockPath()
    const lock = await acquireInstanceLock(path)
    if (!lock.acquired) throw new Error('expected the lock')
    const old = new Date(Date.now() - 10 * 60_000)
    await utimes(path, old, old)
    expect(await lock.refresh()).toBe(true)
    expect(Date.now() - (await stat(path)).mtimeMs).toBeLessThan(5_000)
    // 别的进程接管了：心跳要报告丢锁，也不能动别人的锁文件。
    const other = liveProcess()
    await writeFile(path, `${other}\n`)
    expect(await lock.refresh()).toBe(false)
    await lock.release()
    expect((await readFile(path, 'utf8')).trim()).toBe(String(other))
    // release 清掉了本进程的登记：之后照常能去抢（这里对方还活着，所以抢不到）。
    expect(await acquireInstanceLock(path)).toEqual({ acquired: false, holderPid: other })
  })

  it('refresh() recreates a lock file that was deleted by hand', async () => {
    const path = await lockPath()
    const lock = await acquireInstanceLock(path)
    if (!lock.acquired) throw new Error('expected the lock')
    await rm(path)
    expect(await lock.refresh()).toBe(true)
    expect((await readFile(path, 'utf8')).trim()).toBe(String(process.pid))
    await lock.release()
  })
})
