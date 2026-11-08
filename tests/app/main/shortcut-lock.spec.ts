import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  isProcessAlive,
  LOCK_CONFIRM_MS,
  LOCK_STALE_MS,
  physicalShortcutKey,
  ShortcutLocks,
  shortcutLockPath,
  type LockFileTimes,
} from '../../../src/app/main/shortcut-lock.ts'
import { trapProcessErrors, useTempDir } from './helpers.ts'

trapProcessErrors()
const tempDir = useTempDir('locks')

describe('physicalShortcutKey', () => {
  it('folds CommandOrControl and Super into Command on macOS', () => {
    expect(physicalShortcutKey('CommandOrControl+P', 'darwin')).toBe('Command+P')
    expect(physicalShortcutKey('Super+P', 'darwin')).toBe('Command+P')
    expect(physicalShortcutKey('cmd+shift+p', 'darwin')).toBe('Command+Shift+P')
    expect(physicalShortcutKey('Control+P', 'darwin')).toBe('Control+P')
  })

  it('folds CommandOrControl into Control and Command into Super elsewhere', () => {
    expect(physicalShortcutKey('CommandOrControl+Alt+P', 'win32')).toBe('Control+Alt+P')
    expect(physicalShortcutKey('Control+Alt+P', 'linux')).toBe('Control+Alt+P')
    expect(physicalShortcutKey('Command+P', 'linux')).toBe('Super+P')
  })

  it('orders modifiers the same way whatever the spelling', () => {
    expect(physicalShortcutKey('Shift+Alt+Control+K', 'darwin')).toBe(physicalShortcutKey('Control+Alt+Shift+K', 'darwin'))
  })

  it('returns null for invalid accelerators', () => {
    expect(physicalShortcutKey('P', 'darwin')).toBeNull()
    expect(physicalShortcutKey('Control+Nope', 'darwin')).toBeNull()
    expect(physicalShortcutKey('', 'win32')).toBeNull()
  })
})

describe('shortcutLockPath', () => {
  it('names the file after the first 16 hex digits of the SHA-256 of the key', () => {
    const digest = createHash('sha256').update('Control+P', 'utf8').digest('hex').slice(0, 16)
    expect(shortcutLockPath('/tmp/locks', 'Control+P')).toBe(join('/tmp/locks', `shortcut-${digest}.json`))
    expect(shortcutLockPath('/tmp/locks', 'Control+P')).not.toBe(shortcutLockPath('/tmp/locks', 'Control+Alt+P'))
  })
})

describe('isProcessAlive', () => {
  it('reports this process as alive', () => {
    expect(isProcessAlive(process.pid)).toBe(true)
  })

  it('reports invalid and absent pids as dead', () => {
    expect(isProcessAlive(0)).toBe(false)
    expect(isProcessAlive(-1)).toBe(false)
    expect(isProcessAlive(Number.NaN)).toBe(false)
    expect(isProcessAlive(2 ** 30 + 12345)).toBe(false)
  })
})

describe('ShortcutLocks', () => {
  const locks = (pid: number, profile: string, alive: Set<number>): ShortcutLocks => new ShortcutLocks({
    dir: join(tempDir(), 'locks'),
    pid,
    profile,
    isAlive: candidate => alive.has(candidate),
  })

  it('creates the lock file with pid and profile and leaves no temporary files', () => {
    const alive = new Set([100])
    const result = locks(100, 'web', alive).acquire('Control+P')
    expect(result).toEqual({ ok: true, locked: true })
    const path = shortcutLockPath(join(tempDir(), 'locks'), 'Control+P')
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ pid: 100, profile: 'web' })
    expect(readdirSync(join(tempDir(), 'locks'))).toEqual([path.split(/[\\/]/).pop()])
  })

  it('refuses a combination held by another live PromptX and names its profile', () => {
    const alive = new Set([100, 200])
    expect(locks(100, 'web', alive).acquire('Control+P')).toEqual({ ok: true, locked: true })
    expect(locks(200, 'work', alive).acquire('Control+P')).toEqual({ ok: false, holder: { pid: 100, profile: 'web' } })
  })

  it('lets two profiles hold different combinations', () => {
    const alive = new Set([100, 200])
    expect(locks(100, 'web', alive).acquire('Control+P').ok).toBe(true)
    expect(locks(200, 'work', alive).acquire('Control+Alt+P').ok).toBe(true)
  })

  it('takes over a lock whose holder is gone', () => {
    const alive = new Set([200])
    expect(locks(100, 'web', new Set([100])).acquire('Control+P').ok).toBe(true)
    expect(locks(200, 'work', alive).acquire('Control+P')).toEqual({ ok: true, locked: true })
    const path = shortcutLockPath(join(tempDir(), 'locks'), 'Control+P')
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ pid: 200, profile: 'work' })
  })

  it('takes over a corrupt lock file', () => {
    const dir = join(tempDir(), 'locks')
    const owner = locks(100, 'web', new Set([100]))
    expect(owner.acquire('Control+P').ok).toBe(true)
    writeFileSync(shortcutLockPath(dir, 'Control+P'), 'not json')
    expect(locks(200, 'work', new Set([200])).acquire('Control+P')).toEqual({ ok: true, locked: true })
  })

  it('treats its own existing lock as held (re-acquire after a rebind)', () => {
    const own = locks(100, 'web', new Set([100]))
    expect(own.acquire('Control+P').ok).toBe(true)
    expect(own.acquire('Control+P')).toEqual({ ok: true, locked: true })
  })

  it('releases only its own lock', () => {
    const dir = join(tempDir(), 'locks')
    const path = shortcutLockPath(dir, 'Control+P')
    const first = locks(100, 'web', new Set([200]))
    expect(first.acquire('Control+P').ok).toBe(true)
    // 100 被当成已退出，200 接管了锁；100 释放时不能删掉 200 的锁。
    expect(locks(200, 'work', new Set([200])).acquire('Control+P').ok).toBe(true)
    first.release('Control+P')
    expect(existsSync(path)).toBe(true)
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ pid: 200 })
  })

  it('removes its lock on release and releaseAll', () => {
    const dir = join(tempDir(), 'locks')
    const own = locks(100, 'web', new Set([100]))
    own.acquire('Control+P')
    own.acquire('Control+Alt+P')
    own.release('Control+P')
    expect(existsSync(shortcutLockPath(dir, 'Control+P'))).toBe(false)
    expect(existsSync(shortcutLockPath(dir, 'Control+Alt+P'))).toBe(true)
    own.releaseAll()
    expect(readdirSync(dir)).toEqual([])
  })

  it('tells whether another live PromptX holds a combination without taking the lock', () => {
    const dir = join(tempDir(), 'locks')
    const alive = new Set([100, 200])
    const owner = locks(100, 'web', alive)
    const other = locks(200, 'work', alive)
    expect(other.heldByOther('Control+P')).toBe(false)
    owner.acquire('Control+P')
    expect(other.heldByOther('Control+P')).toBe(true)
    expect(owner.heldByOther('Control+P')).toBe(false)
    alive.delete(100)
    expect(other.heldByOther('Control+P')).toBe(false)
    // 只读：看过之后锁文件仍是原来的持有者。
    expect(JSON.parse(readFileSync(shortcutLockPath(dir, 'Control+P'), 'utf8'))).toMatchObject({ pid: 100 })
    writeFileSync(shortcutLockPath(dir, 'Control+P'), '{')
    expect(other.heldByOther('Control+P')).toBe(false)
  })

  it('leaves no stale or temporary files after taking over a dead lock', () => {
    const dir = join(tempDir(), 'locks')
    locks(100, 'web', new Set([100])).acquire('Control+P')
    expect(locks(200, 'work', new Set([200])).acquire('Control+P')).toEqual({ ok: true, locked: true })
    expect(readdirSync(dir)).toEqual([shortcutLockPath(dir, 'Control+P').split(/[\\/]/).pop()])
  })

  it('does not delete a fresh lock that replaced the dead one while it was being taken over', () => {
    const dir = join(tempDir(), 'locks')
    const path = shortcutLockPath(dir, 'Control+P')
    locks(100, 'web', new Set([100])).acquire('Control+P')
    // 300 判断 100 已死的那一刻，200 抢先接管并写下新锁：300 挪走的不是它读到的那份，必须原样放回。
    let swapped = false
    const slow = new ShortcutLocks({
      dir,
      pid: 300,
      profile: 'late',
      isAlive: (pid) => {
        if (pid === 100 && !swapped) {
          swapped = true
          writeFileSync(path, `${JSON.stringify({ pid: 200, profile: 'work' })}\n`)
          return false
        }
        return pid === 200 || pid === 300
      },
    })
    expect(slow.acquire('Control+P')).toEqual({ ok: false, holder: { pid: 200, profile: 'work' } })
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ pid: 200, profile: 'work' })
    expect(readdirSync(dir)).toEqual([path.split(/[\\/]/).pop()])
  })

  it('degrades to no coordination when the lock directory cannot be created', () => {
    const blocker = join(tempDir(), 'file')
    writeFileSync(blocker, 'x')
    const problems: string[] = []
    const result = new ShortcutLocks({ dir: join(blocker, 'locks'), pid: 1, profile: 'web', onProblem: code => problems.push(code) })
      .acquire('Control+P')
    expect(result).toEqual({ ok: true, locked: false })
    expect(problems.length).toBeGreaterThan(0)
  })
})

describe('ShortcutLocks heartbeat (F2)', () => {
  const MINUTE = 60_000

  /** 测试用的单调时钟：只在测试里手动往前拨。墙上时钟和文件的 mtime 用真的。 */
  interface Clock {
    now: number
  }

  function locksDir(): string {
    return join(tempDir(), 'locks')
  }

  function lockFile(): string {
    return shortcutLockPath(locksDir(), 'Control+P')
  }

  function locksOf(pid: number, profile: string, alive: (pid: number) => boolean, clock: Clock, files?: LockFileTimes): ShortcutLocks {
    return new ShortcutLocks({
      dir: locksDir(),
      pid,
      profile,
      isAlive: alive,
      now: () => clock.now,
      ...(files === undefined ? {} : { files }),
    })
  }

  /** 把锁文件的 mtime 改成 ageMs 之前，模拟持有者这么久没刷新。 */
  function age(ageMs: number): void {
    const then = new Date(Date.now() - ageMs)
    utimesSync(lockFile(), then, then)
  }

  function holderPid(): unknown {
    return (JSON.parse(readFileSync(lockFile(), 'utf8')) as { pid: unknown }).pid
  }

  it('never takes a live holder\'s fresh lock, however long the contender waits', () => {
    const alive = new Set([100, 200])
    const clock = { now: 0 }
    expect(locksOf(100, 'web', pid => alive.has(pid), clock).acquire('Control+P').ok).toBe(true)
    const other = locksOf(200, 'work', pid => alive.has(pid), clock)
    for (let check = 0; check < 6; check++) {
      expect(other.heldByOther('Control+P')).toBe(true)
      expect(other.acquire('Control+P')).toEqual({ ok: false, holder: { pid: 100, profile: 'web' } })
      clock.now += 10 * MINUTE
    }
    expect(holderPid()).toBe(100)
  })

  it('takes a dead holder\'s lock at once, without waiting for the heartbeat to age', () => {
    const clock = { now: 0 }
    expect(locksOf(100, 'web', () => true, clock).acquire('Control+P').ok).toBe(true)
    const other = locksOf(200, 'work', pid => pid === 200, clock)
    expect(other.heldByOther('Control+P')).toBe(false)
    expect(other.acquire('Control+P')).toEqual({ ok: true, locked: true })
    expect(holderPid()).toBe(200)
  })

  it('takes a live pid\'s lock that stopped being refreshed only after 45 more seconds with the mtime unchanged', () => {
    const alive = new Set([100, 200])
    const clock = { now: 0 }
    expect(locksOf(100, 'web', pid => alive.has(pid), clock).acquire('Control+P').ok).toBe(true)
    const other = locksOf(200, 'work', pid => alive.has(pid), clock)
    // 一分钟以内没刷新不算可疑。
    age(LOCK_STALE_MS - 5000)
    expect(other.acquire('Control+P').ok).toBe(false)
    clock.now += 10 * MINUTE
    expect(other.acquire('Control+P').ok).toBe(false)
    // 两分钟没刷新（pid 被不相干的进程复用了）：先起疑，按单调时钟再等 45 秒、mtime 仍然没变才接管。
    age(2 * MINUTE)
    expect(other.heldByOther('Control+P')).toBe(true)
    clock.now += LOCK_CONFIRM_MS - 1
    expect(other.heldByOther('Control+P')).toBe(true)
    expect(other.acquire('Control+P')).toEqual({ ok: false, holder: { pid: 100, profile: 'web' } })
    clock.now += 1
    expect(other.heldByOther('Control+P')).toBe(false)
    expect(other.acquire('Control+P')).toEqual({ ok: true, locked: true })
    expect(JSON.parse(readFileSync(lockFile(), 'utf8'))).toMatchObject({ pid: 200, profile: 'work' })
    expect(readdirSync(locksDir())).toEqual([basename(lockFile())])
  })

  it('starts the 45 seconds over when the mtime changes, even if it is still old', () => {
    const alive = new Set([100, 200])
    const clock = { now: 0 }
    expect(locksOf(100, 'web', pid => alive.has(pid), clock).acquire('Control+P').ok).toBe(true)
    const other = locksOf(200, 'work', pid => alive.has(pid), clock)
    age(2 * MINUTE)
    expect(other.acquire('Control+P').ok).toBe(false)
    clock.now += 30_000
    age(90_000)
    expect(other.acquire('Control+P').ok).toBe(false)
    clock.now += LOCK_CONFIRM_MS - 1
    expect(other.acquire('Control+P').ok).toBe(false)
    clock.now += 1
    expect(other.acquire('Control+P')).toEqual({ ok: true, locked: true })
  })

  it('a refresh by the holder in between cancels the takeover', () => {
    const alive = new Set([100, 200])
    const clock = { now: 0 }
    const holder = locksOf(100, 'web', pid => alive.has(pid), clock)
    expect(holder.acquire('Control+P').ok).toBe(true)
    const other = locksOf(200, 'work', pid => alive.has(pid), clock)
    age(2 * MINUTE)
    expect(other.acquire('Control+P').ok).toBe(false)
    expect(holder.refresh()).toEqual([])
    expect(Date.now() - statSync(lockFile()).mtimeMs).toBeLessThan(LOCK_STALE_MS)
    clock.now += 10 * MINUTE
    expect(other.heldByOther('Control+P')).toBe(true)
    expect(other.acquire('Control+P')).toEqual({ ok: false, holder: { pid: 100, profile: 'web' } })
    expect(holderPid()).toBe(100)
  })

  it('does not take the lock when the holder refreshes it between the confirmation and the removal', () => {
    const alive = new Set([100, 200])
    const clock = { now: 0 }
    const holder = locksOf(100, 'web', pid => alive.has(pid), clock)
    expect(holder.acquire('Control+P').ok).toBe(true)
    let refreshAfterRead = false
    const files: LockFileTimes = {
      mtimeMs: (path) => {
        const mtime = statSync(path).mtimeMs
        // 确认的那一刻读到的还是旧的 mtime，紧接着（挪走之前）持有者刷新了一次。
        if (refreshAfterRead && path === lockFile()) {
          refreshAfterRead = false
          expect(holder.refresh()).toEqual([])
        }
        return mtime
      },
      touch: (path) => {
        const now = new Date()
        utimesSync(path, now, now)
      },
    }
    const other = locksOf(200, 'work', pid => alive.has(pid), clock, files)
    age(2 * MINUTE)
    expect(other.acquire('Control+P').ok).toBe(false)
    clock.now += LOCK_CONFIRM_MS
    refreshAfterRead = true
    expect(other.acquire('Control+P')).toEqual({ ok: false, holder: { pid: 100, profile: 'web' } })
    expect(holderPid()).toBe(100)
    expect(readdirSync(locksDir())).toEqual([basename(lockFile())])
    expect(holder.refresh()).toEqual([])
  })

  it('refreshes the mtime of every lock it holds', () => {
    const holder = locksOf(100, 'web', () => true, { now: 0 })
    expect(holder.acquire('Control+P').ok).toBe(true)
    expect(holder.acquire('Control+Alt+P').ok).toBe(true)
    const old = new Date(Date.now() - 2 * MINUTE)
    for (const key of ['Control+P', 'Control+Alt+P']) utimesSync(shortcutLockPath(locksDir(), key), old, old)
    expect(holder.refresh()).toEqual([])
    for (const key of ['Control+P', 'Control+Alt+P']) {
      expect(Date.now() - statSync(shortcutLockPath(locksDir(), key)).mtimeMs).toBeLessThan(LOCK_STALE_MS)
    }
  })

  it('notices that its lock was taken over, reports the live holder and leaves that lock alone', () => {
    const clock = { now: 0 }
    const holder = locksOf(100, 'web', () => true, clock)
    expect(holder.acquire('Control+P').ok).toBe(true)
    // 200 把 100 当成了已退出（例如 kill(pid, 0) 误判），接管了锁。
    expect(locksOf(200, 'work', pid => pid === 200, clock).acquire('Control+P')).toEqual({ ok: true, locked: true })
    expect(holder.refresh()).toEqual([{ key: 'Control+P', holder: { pid: 200, profile: 'work' } }])
    // 不再算自己持有：之后的心跳不再管它，释放时也不删对方的锁。
    expect(holder.refresh()).toEqual([])
    holder.releaseAll()
    expect(JSON.parse(readFileSync(lockFile(), 'utf8'))).toMatchObject({ pid: 200, profile: 'work' })
  })

  it('takes its lock back when the file disappeared or the one who took it is gone too', () => {
    const clock = { now: 0 }
    const holder = locksOf(100, 'web', pid => pid === 100, clock)
    expect(holder.acquire('Control+P').ok).toBe(true)
    rmSync(lockFile())
    expect(holder.refresh()).toEqual([])
    expect(holderPid()).toBe(100)
    writeFileSync(lockFile(), `${JSON.stringify({ pid: 300, profile: 'gone' })}\n`)
    expect(holder.refresh()).toEqual([])
    expect(holderPid()).toBe(100)
    expect(readdirSync(locksDir())).toEqual([basename(lockFile())])
  })
})
