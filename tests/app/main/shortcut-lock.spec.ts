import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isProcessAlive, physicalShortcutKey, ShortcutLocks, shortcutLockPath } from '../../../src/app/main/shortcut-lock.ts'
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
