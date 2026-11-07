import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { acquireInstanceLock } from '../../src/companion/instance-lock.ts'
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
