import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import type { Locale } from '../../../src/app/main/appearance.ts'
import { ShortcutLocks, type LockResult } from '../../../src/app/main/shortcut-lock.ts'
import { ShortcutManager, type ShortcutLockStore } from '../../../src/app/main/shortcut-manager.ts'
import type { ShortcutStatus } from '../../../src/shared/types.ts'
import { MemoryLogger, trapProcessErrors, useTempDir } from './helpers.ts'

trapProcessErrors()
const tempDir = useTempDir('shortcut')

const FIXTURE = readFileSync(fileURLToPath(new URL('./fixtures/symbolichotkeys.xml', import.meta.url)), 'utf8')

/** 假的 globalShortcut：记录调用顺序；taken 里的组合登记失败，throws 里的组合登记时抛错。 */
class FakeBackend {
  readonly calls: string[] = []
  readonly registered = new Map<string, () => void>()
  readonly taken = new Set<string>()
  readonly throws = new Set<string>()

  register(accelerator: string, callback: () => void): boolean {
    this.calls.push(`register ${accelerator}`)
    if (this.throws.has(accelerator)) throw new TypeError('conversion failure')
    if (this.taken.has(accelerator)) return false
    this.registered.set(accelerator, callback)
    return true
  }

  unregister(accelerator: string): void {
    this.calls.push(`unregister ${accelerator}`)
    this.registered.delete(accelerator)
  }

  press(accelerator: string): void {
    const callback = this.registered.get(accelerator)
    if (callback === undefined) throw new Error(`${accelerator} is not registered`)
    callback()
  }
}

/** 假的锁：heldByOthers 里的键被别的 profile 持有。 */
class FakeLocks implements ShortcutLockStore {
  readonly held = new Set<string>()
  readonly heldByOthers = new Map<string, string>()
  readonly calls: string[] = []

  acquire(key: string): LockResult {
    this.calls.push(`acquire ${key}`)
    const profile = this.heldByOthers.get(key)
    if (profile !== undefined) return { ok: false, holder: { pid: 999, profile } }
    this.held.add(key)
    return { ok: true, locked: true }
  }

  release(key: string): void {
    this.calls.push(`release ${key}`)
    this.held.delete(key)
  }

  releaseAll(): void {
    this.calls.push('releaseAll')
    this.held.clear()
  }

  heldByOther(key: string): boolean {
    this.calls.push(`peek ${key}`)
    return this.heldByOthers.has(key)
  }
}

interface Setup {
  manager: ShortcutManager
  backend: FakeBackend
  locks: FakeLocks
  statuses: (ShortcutStatus | null)[]
  triggers: { count: number }
  logger: MemoryLogger
  clock: { now: number }
  locale: { value: Locale }
}

function setup(options: { platform?: string; readSystemHotkeys?: () => Promise<string | null> } = {}): Setup {
  const backend = new FakeBackend()
  const locks = new FakeLocks()
  const statuses: (ShortcutStatus | null)[] = []
  const triggers = { count: 0 }
  const logger = new MemoryLogger()
  const clock = { now: 1000 }
  const locale = { value: 'zh' as Locale }
  const manager = new ShortcutManager({
    platform: options.platform ?? 'darwin',
    backend,
    locks,
    ...(options.readSystemHotkeys === undefined ? {} : { readSystemHotkeys: options.readSystemHotkeys }),
    locale: () => locale.value,
    onTrigger: () => {
      triggers.count++
    },
    onStatus: (status) => {
      statuses.push(status)
    },
    logger,
    now: () => clock.now,
  })
  return { manager, backend, locks, statuses, triggers, logger, clock, locale }
}

describe('ShortcutManager: registration', () => {
  it('reports null before any configuration', () => {
    expect(setup().manager.status()).toBeNull()
  })

  it('registers the canonical accelerator, takes the lock and reports the configured spelling', () => {
    const { manager, backend, locks, statuses } = setup()
    manager.apply(' ctrl+p ')
    expect(backend.calls).toEqual(['register Control+P'])
    expect(locks.held).toEqual(new Set(['Control+P']))
    expect(manager.status()).toEqual({ accelerator: 'ctrl+p', registered: true })
    expect(statuses).toEqual([{ accelerator: 'ctrl+p', registered: true }])
  })

  it('does nothing when the same value is applied again', () => {
    const { manager, backend, statuses } = setup()
    manager.apply('Control+P')
    manager.apply('Control+P')
    expect(backend.calls).toEqual(['register Control+P'])
    expect(statuses).toHaveLength(1)
  })

  it('unregisters and releases the lock when the shortcut is cleared', () => {
    const { manager, backend, locks } = setup()
    manager.apply('Control+P')
    manager.apply('')
    expect(backend.calls).toEqual(['register Control+P', 'unregister Control+P'])
    expect(locks.held.size).toBe(0)
    expect(manager.status()).toBeNull()
  })

  it('reports invalid combinations without touching the system', () => {
    const { manager, backend, locks } = setup()
    manager.apply('P')
    expect(backend.calls).toEqual([])
    expect(locks.calls).toEqual([])
    expect(manager.status()).toEqual({ accelerator: 'P', registered: false, error: { code: 'promptx/shortcut/invalid', detail: 'no-modifier' } })
  })

  it('reports taken when the system refuses the combination and gives the lock back', () => {
    const { manager, backend, locks } = setup({ platform: 'win32' })
    backend.taken.add('Control+Alt+P')
    manager.apply('Control+Alt+P')
    expect(manager.status()).toEqual({ accelerator: 'Control+Alt+P', registered: false, error: { code: 'promptx/shortcut/taken' } })
    expect(locks.held.size).toBe(0)
  })

  it('treats a throwing register() as taken', () => {
    const { manager, backend, logger } = setup()
    backend.throws.add('Control+P')
    manager.apply('Control+P')
    expect(manager.status()?.error?.code).toBe('promptx/shortcut/taken')
    expect(logger.events()).toContain('shortcut.register-threw')
  })

  it('does not register a combination held by another profile and names that profile', () => {
    const { manager, backend, locks } = setup()
    locks.heldByOthers.set('Control+P', 'work')
    manager.apply('Control+P')
    expect(backend.calls).toEqual([])
    expect(manager.status()).toEqual({
      accelerator: 'Control+P',
      registered: false,
      error: { code: 'promptx/shortcut/held-by-profile', detail: 'work' },
    })
  })

  it('retries a failed combination when the same value is pushed again', () => {
    const { manager, locks } = setup()
    locks.heldByOthers.set('Control+P', 'work')
    manager.apply('Control+P')
    expect(manager.status()?.registered).toBe(false)
    locks.heldByOthers.clear()
    manager.apply('Control+P')
    expect(manager.status()).toEqual({ accelerator: 'Control+P', registered: true })
  })
})

describe('ShortcutManager: changing the combination', () => {
  it('releases the old combination before registering the new one', () => {
    const { manager, backend, locks } = setup()
    manager.apply('Control+P')
    manager.apply('Control+Alt+P')
    expect(backend.calls).toEqual(['register Control+P', 'unregister Control+P', 'register Control+Alt+P'])
    expect(locks.calls).toEqual(['acquire Control+P', 'release Control+P', 'acquire Control+Alt+P'])
    expect(manager.status()).toEqual({ accelerator: 'Control+Alt+P', registered: true })
  })

  it('falls back to the old combination when the new one fails', () => {
    const { manager, backend, logger } = setup()
    manager.apply('Control+P')
    backend.taken.add('Control+Alt+P')
    manager.apply('Control+Alt+P')
    expect(backend.calls).toEqual(['register Control+P', 'unregister Control+P', 'register Control+Alt+P', 'register Control+P'])
    // 仍在用旧组合：error 说明配置的新组合为什么没登记上，detail 是新组合；warning 只留给系统快捷键冲突。
    expect(manager.status()).toEqual({
      accelerator: 'Control+P',
      registered: true,
      error: { code: 'promptx/shortcut/taken', detail: 'Control+Alt+P' },
    })
    expect(logger.events('warn')).toContain('shortcut.fallback')
  })

  it('falls back when the new combination is held by another profile', () => {
    const { manager, locks } = setup()
    manager.apply('Control+P')
    locks.heldByOthers.set('Control+Alt+P', 'work')
    manager.apply('Control+Alt+P')
    expect(manager.status()).toEqual({
      accelerator: 'Control+P',
      registered: true,
      error: { code: 'promptx/shortcut/held-by-profile', detail: 'Control+Alt+P' },
    })
    expect(locks.held).toEqual(new Set(['Control+P']))
  })

  it('reports the failure of the new combination when the old one cannot come back either', () => {
    const { manager, backend } = setup()
    manager.apply('Control+P')
    backend.taken.add('Control+Alt+P')
    backend.taken.add('Control+P')
    manager.apply('Control+Alt+P')
    expect(manager.status()).toEqual({ accelerator: 'Control+Alt+P', registered: false, error: { code: 'promptx/shortcut/taken' } })
    expect(backend.registered.size).toBe(0)
  })

  it('keeps the registration when the new spelling is the same physical keys', () => {
    const { manager, backend } = setup({ platform: 'darwin' })
    manager.apply('CommandOrControl+P')
    manager.apply('Command+P')
    expect(backend.calls).toEqual(['register CommandOrControl+P'])
    expect(manager.status()).toEqual({ accelerator: 'Command+P', registered: true })
  })

  it('clears the fallback warning when the configuration goes back to the combination in use', () => {
    const { manager, backend } = setup()
    manager.apply('Control+P')
    backend.taken.add('Control+Alt+P')
    manager.apply('Control+Alt+P')
    manager.apply('Control+P')
    expect(manager.status()).toEqual({ accelerator: 'Control+P', registered: true })
    expect(backend.calls.filter(call => call === 'register Control+P')).toHaveLength(2)
  })
})

describe('ShortcutManager: waiting for another profile', () => {
  it('takes the combination over once the other profile is gone', () => {
    const { manager, backend, locks, statuses } = setup()
    locks.heldByOthers.set('Control+P', 'work')
    manager.apply('Control+P')
    expect(manager.status()?.error?.code).toBe('promptx/shortcut/held-by-profile')
    // 对方还在：只看一眼锁，不登记、不重复上报。
    manager.retryIfHeld()
    expect(backend.calls).toEqual([])
    expect(statuses).toHaveLength(1)
    locks.heldByOthers.clear()
    manager.retryIfHeld()
    expect(backend.calls).toEqual(['register Control+P'])
    expect(manager.status()).toEqual({ accelerator: 'Control+P', registered: true })
  })

  it('switches from the fallback to the new combination once it is free', () => {
    const { manager, backend, locks } = setup()
    manager.apply('Control+P')
    locks.heldByOthers.set('Control+Alt+P', 'work')
    manager.apply('Control+Alt+P')
    expect(manager.status()?.accelerator).toBe('Control+P')
    locks.heldByOthers.clear()
    manager.retryIfHeld()
    expect(manager.status()).toEqual({ accelerator: 'Control+Alt+P', registered: true })
    expect(backend.registered.has('Control+Alt+P')).toBe(true)
    expect(backend.registered.has('Control+P')).toBe(false)
  })

  it('does nothing for other failures, without configuration or after dispose', () => {
    const empty = setup()
    empty.manager.retryIfHeld()
    expect(empty.locks.calls).toEqual([])

    const taken = setup({ platform: 'win32' })
    taken.backend.taken.add('Control+Alt+P')
    taken.manager.apply('Control+Alt+P')
    taken.manager.retryIfHeld()
    expect(taken.locks.calls.filter(call => call.startsWith('peek'))).toEqual([])

    const disposed = setup()
    disposed.locks.heldByOthers.set('Control+P', 'work')
    disposed.manager.apply('Control+P')
    disposed.manager.dispose()
    disposed.locks.heldByOthers.clear()
    disposed.manager.retryIfHeld()
    disposed.manager.apply('Control+Alt+P')
    expect(disposed.backend.calls).toEqual([])
  })
})

describe('ShortcutManager: system shortcuts (macOS)', () => {
  it('warns with the localized name when the combination is an enabled system shortcut', async () => {
    const { manager, backend, locale } = setup({ readSystemHotkeys: () => Promise.resolve(FIXTURE) })
    manager.apply('Command+Space')
    expect(manager.status()).toEqual({ accelerator: 'Command+Space', registered: true })
    await manager.settled()
    expect(backend.registered.has('Command+Space')).toBe(true)
    expect(manager.status()).toEqual({
      accelerator: 'Command+Space',
      registered: true,
      warning: { code: 'promptx/shortcut/system-conflict', detail: '显示“聚焦”搜索' },
    })
    locale.value = 'en'
    manager.refreshLocale()
    expect(manager.status()?.warning?.detail).toBe('Show Spotlight search')
  })

  it('does not warn for free combinations or when the plist cannot be read', async () => {
    const free = setup({ readSystemHotkeys: () => Promise.resolve(FIXTURE) })
    free.manager.apply('Control+P')
    await free.manager.settled()
    expect(free.manager.status()).toEqual({ accelerator: 'Control+P', registered: true })

    const unreadable = setup({ readSystemHotkeys: () => Promise.reject(new Error('defaults failed')) })
    unreadable.manager.apply('Command+Space')
    await unreadable.manager.settled()
    expect(unreadable.manager.status()?.warning).toBeUndefined()
  })

  it('ignores a slow check that finishes after the combination changed', async () => {
    let release: (xml: string) => void = () => {}
    const slow = new Promise<string>((resolve) => {
      release = resolve
    })
    const reads = [slow, Promise.resolve(FIXTURE)]
    const { manager } = setup({ readSystemHotkeys: () => reads.shift() ?? Promise.resolve(null) })
    manager.apply('Command+Space')
    manager.apply('Control+P')
    release(FIXTURE)
    await manager.settled()
    expect(manager.status()).toEqual({ accelerator: 'Control+P', registered: true })
  })

  it('does not check system shortcuts where there is no reader (Windows, Linux)', async () => {
    const { manager } = setup({ platform: 'win32' })
    manager.apply('Control+Alt+P')
    await manager.settled()
    expect(manager.status()).toEqual({ accelerator: 'Control+Alt+P', registered: true })
  })
})

describe('ShortcutManager: triggering', () => {
  it('calls onTrigger when the shortcut is pressed, once per press', () => {
    const { manager, backend, triggers, clock } = setup()
    manager.apply('Control+P')
    backend.press('Control+P')
    clock.now += 50
    backend.press('Control+P')
    expect(triggers.count).toBe(1)
    clock.now += 200
    backend.press('Control+P')
    expect(triggers.count).toBe(2)
  })

  it('keeps the callback alive when onTrigger throws', () => {
    const logger = new MemoryLogger()
    const backend = new FakeBackend()
    const manager = new ShortcutManager({
      platform: 'darwin',
      backend,
      locks: new FakeLocks(),
      locale: () => 'zh',
      onTrigger: () => {
        throw new Error('boom')
      },
      onStatus: () => {},
      logger,
    })
    manager.apply('Control+P')
    expect(() => {
      backend.press('Control+P')
    }).not.toThrow()
    expect(logger.events()).toContain('shortcut.trigger-failed')
  })
})

describe('ShortcutManager: dispose', () => {
  it('unregisters and releases every lock', () => {
    const { manager, backend, locks } = setup()
    manager.apply('Control+P')
    manager.dispose()
    expect(backend.registered.size).toBe(0)
    expect(locks.calls).toContain('releaseAll')
  })
})

describe('ShortcutManager with real lock files', () => {
  it('lets only one of two profiles own a combination and names the owner', () => {
    const dir = join(tempDir(), 'locks')
    const alive = new Set([10, 20])
    const make = (pid: number, profile: string): ShortcutManager => new ShortcutManager({
      platform: 'darwin',
      backend: new FakeBackend(),
      locks: new ShortcutLocks({ dir, pid, profile, isAlive: candidate => alive.has(candidate) }),
      locale: () => 'en',
      onTrigger: () => {},
      onStatus: () => {},
      logger: new MemoryLogger(),
    })
    const first = make(10, 'web')
    const second = make(20, 'work')
    first.apply('Control+P')
    second.apply('Control+P')
    expect(first.status()).toEqual({ accelerator: 'Control+P', registered: true })
    expect(second.status()).toEqual({ accelerator: 'Control+P', registered: false, error: { code: 'promptx/shortcut/held-by-profile', detail: 'web' } })
    // 第一个退出后，第二个再收到配置时接手。
    first.dispose()
    second.apply('Control+P')
    expect(second.status()).toEqual({ accelerator: 'Control+P', registered: true })
    second.dispose()
  })

  it('does not swallow status listener errors', () => {
    const logger = new MemoryLogger()
    const manager = new ShortcutManager({
      platform: 'darwin',
      backend: new FakeBackend(),
      locks: new FakeLocks(),
      locale: () => 'en',
      onTrigger: () => {},
      onStatus: vi.fn(() => {
        throw new Error('listener')
      }),
      logger,
    })
    manager.apply('Control+P')
    expect(logger.events()).toContain('shortcut.status-listener-failed')
  })
})
