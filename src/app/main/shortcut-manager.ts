// 全局快捷键的登记与状态（需求 F-01、S-02，design-spec 5.4）。
//
// - 登记前按组合拿锁文件（shortcut-lock.ts），另一个存活的 PromptX 持有时不登记，报 held-by-profile。
// - register() 返回 false（Windows、Linux 上组合已被占用）报 taken；写法不合法报 invalid。
// - 改组合：先注销旧的、释放旧锁，再登记新的；新的失败时重新登记旧的，状态写「新组合 X 登记失败，仍使用 Y」。
// - macOS 上登记成功后再查系统快捷键，相同时状态带 system-conflict 警告（不影响登记）。
// - app.ts 定期调用 heartbeat()：刷新自己持有的锁（心跳，审查 F2），锁被别的 PromptX 接管时注销快捷键、报 held-by-profile；
//   被另一个 profile 占着时看对方是否已经退出（retryIfHeld），退出后接手，不用等下一次配置推送。
//
// 状态（ShortcutStatus）的约定：
// - 没有配置快捷键：null。
// - 登记成功：{ accelerator: 配置的写法, registered: true }，可能带 system-conflict 警告。
// - 新组合失败、退回旧组合：{ accelerator: 旧组合, registered: true, error: { code: 新组合失败的原因, detail: 新组合 } }。
//   accelerator 和配置值不同，配置页据此知道仍在用旧组合；error 按类型的约定说明「配置的组合为什么没登记上」，
//   warning 只留给系统快捷键冲突。
// - 登记失败且没有可退回的：{ accelerator: 配置的写法, registered: false, error }。

import { parseAccelerator } from '../../shared/accelerator.ts'
import type { ErrorInfo, ShortcutStatus } from '../../shared/types.ts'
import type { Locale } from './appearance.ts'
import { errorCode, type CompanionLogger } from './logger.ts'
import { physicalShortcutKey, type LockHolder, type LockResult, type LostLock } from './shortcut-lock.ts'
import { systemHotkeyName } from './strings.ts'
import { systemConflictFromXml } from './symbolic-hotkeys.ts'

/** Electron globalShortcut 的子集。 */
export interface ShortcutBackend {
  register(accelerator: string, callback: () => void): boolean
  unregister(accelerator: string): void
}

export interface ShortcutLockStore {
  acquire(key: string): LockResult
  release(key: string): void
  releaseAll(): void
  /** 这个组合是否正被另一个存活的 PromptX 持有（只读，不抢锁）。 */
  heldByOther(key: string): boolean
  /** 心跳：刷新自己持有的锁，返回已经被另一个存活的 PromptX 接管的那些。 */
  refresh(): LostLock[]
}

export interface ShortcutManagerOptions {
  platform: string
  backend: ShortcutBackend
  locks: ShortcutLockStore
  /** macOS 上读 `defaults export com.apple.symbolichotkeys -` 的输出；其他平台不传。读不到时返回 null。 */
  readSystemHotkeys?: () => Promise<string | null>
  /** 当前界面语言，决定系统快捷键名称用哪种语言。 */
  locale: () => Locale
  onTrigger: () => void
  onStatus: (status: ShortcutStatus | null) => void
  logger: CompanionLogger
  now?: () => number
}

interface Active {
  /** 用户配置的写法（去掉首尾空白）。状态里原样报给 Host。 */
  accelerator: string
  /** 交给 Electron 登记的规范写法。 */
  electron: string
  /** 锁文件的键（按物理按键规范化）。 */
  key: string
}

type Attempt = { ok: true; active: Active } | { ok: false; error: ErrorInfo }

const HELD_BY_PROFILE = 'promptx/shortcut/held-by-profile'

/**
 * Windows 的 RegisterHotKey 按住不放时会连续触发；两次触发间隔太短就当成同一次，
 * 否则按住快捷键时小窗会反复显示、隐藏。
 */
const TRIGGER_GUARD_MS = 150

export class ShortcutManager {
  readonly #platform: string
  readonly #backend: ShortcutBackend
  readonly #locks: ShortcutLockStore
  readonly #readSystemHotkeys: (() => Promise<string | null>) | undefined
  readonly #locale: () => Locale
  readonly #onTrigger: () => void
  readonly #onStatus: (status: ShortcutStatus | null) => void
  readonly #logger: CompanionLogger
  readonly #now: () => number

  /** 最近一次 apply 的配置值；null 表示还没收到过配置。 */
  #requested: string | null = null
  #active: Active | null = null
  /** 新组合失败、退回了旧组合时，记下新组合和失败原因。 */
  #fallbackFrom: { accelerator: string; key: string | null; error: ErrorInfo } | null = null
  /** 登记失败且没有可退回的组合时的原因。 */
  #failure: { accelerator: string; key: string | null; error: ErrorInfo } | null = null
  #conflictId: number | null = null
  /** 每次 apply 加一；异步的系统快捷键检查回来时代号变了就丢弃结果。 */
  #generation = 0
  #pending: Promise<void> = Promise.resolve()
  #lastTrigger = Number.NEGATIVE_INFINITY
  #disposed = false

  constructor(options: ShortcutManagerOptions) {
    this.#platform = options.platform
    this.#backend = options.backend
    this.#locks = options.locks
    this.#readSystemHotkeys = options.readSystemHotkeys
    this.#locale = options.locale
    this.#onTrigger = options.onTrigger
    this.#onStatus = options.onStatus
    this.#logger = options.logger
    this.#now = options.now ?? (() => performance.now())
  }

  status(): ShortcutStatus | null {
    if (this.#requested === null || this.#requested === '') return null
    const active = this.#active
    if (active === null) {
      const failure = this.#failure
      if (failure === null) return null
      return { accelerator: failure.accelerator, registered: false, error: failure.error }
    }
    if (this.#fallbackFrom !== null) {
      return {
        accelerator: active.accelerator,
        registered: true,
        error: { code: this.#fallbackFrom.error.code, detail: this.#fallbackFrom.accelerator },
      }
    }
    if (this.#conflictId !== null) {
      return {
        accelerator: active.accelerator,
        registered: true,
        warning: { code: 'promptx/shortcut/system-conflict', detail: systemHotkeyName(this.#conflictId, this.#locale()) },
      }
    }
    return { accelerator: active.accelerator, registered: true }
  }

  /**
   * 按配置值登记（空串表示不登记）。同一个值重复推来时，只要上次已经按它生效就什么都不做；
   * 上次失败或退回了旧组合时再试一次（另一个 profile 可能已经退出、释放了这个组合）。
   */
  apply(value: string): void {
    if (this.#disposed) return
    const requested = value.trim()
    if (requested === this.#requested && this.#failure === null && this.#fallbackFrom === null) return
    this.#requested = requested
    this.#generation++
    this.#conflictId = null
    this.#failure = null
    this.#fallbackFrom = null
    const previous = this.#active

    // 物理按键相同（写法不同，或者退回后又改回了旧组合）：不必注销再登记，只更新状态。
    const nextKey = requested === '' ? null : physicalShortcutKey(requested, this.#platform)
    if (previous !== null && nextKey !== null && previous.key === nextKey) {
      this.#active = { ...previous, accelerator: requested }
      this.#emit()
      this.#checkSystem()
      return
    }

    if (previous !== null) {
      this.#unregister(previous)
      this.#active = null
    }
    if (requested === '') {
      this.#logger.info('shortcut.cleared')
      this.#emit()
      return
    }

    const attempt = this.#tryRegister(requested)
    if (attempt.ok) {
      this.#active = attempt.active
      this.#logger.info('shortcut.registered', { accelerator: attempt.active.electron })
      this.#emit()
      this.#checkSystem()
      return
    }
    if (previous !== null) {
      const back = this.#tryRegister(previous.accelerator)
      if (back.ok) {
        this.#active = back.active
        this.#fallbackFrom = { accelerator: requested, key: nextKey, error: attempt.error }
        this.#logger.warn('shortcut.fallback', { code: attempt.error.code, accelerator: back.active.electron })
        this.#emit()
        return
      }
    }
    this.#failure = { accelerator: requested, key: nextKey, error: attempt.error }
    this.#logger.warn('shortcut.failed', { code: attempt.error.code })
    this.#emit()
  }

  /**
   * app.ts 每隔几秒调用一次（不超过 LOCK_REFRESH_MS）。先刷新自己持有的锁，证明自己还在（审查 F2）；
   * 发现锁已经被另一个 PromptX 接管（自己被当成了已退出）就注销快捷键、按被那个 profile 占用上报，
   * 然后和登记时被占一样，由 retryIfHeld 等对方退出后接手。
   */
  heartbeat(): void {
    if (this.#disposed) return
    for (const lost of this.#locks.refresh()) this.#lockLost(lost.key, lost.holder)
    this.retryIfHeld()
  }

  /**
   * 配置的组合正被另一个 profile 的 PromptX 持有时，看看对方是否已经不在（正常退出会删锁，崩溃留下的锁按进程和心跳判断），
   * 不在了就重新登记。只读一下锁文件，平时什么都不做。
   */
  retryIfHeld(): void {
    if (this.#disposed || this.#requested === null) return
    const blocked = this.#failure ?? this.#fallbackFrom
    if (blocked?.error.code !== HELD_BY_PROFILE || blocked.key === null) return
    if (this.#locks.heldByOther(blocked.key)) return
    this.#logger.info('shortcut.holder-gone')
    this.apply(this.#requested)
  }

  /** 最近一次 apply 的异步检查（系统快捷键）完成后 resolve。冒烟测试等它再上报快捷键状态。 */
  settled(): Promise<void> {
    return this.#pending
  }

  /** 语言变了：系统快捷键的名称要换语言，重新上报一次状态。 */
  refreshLocale(): void {
    if (this.#conflictId !== null) this.#emit()
  }

  /** 退出前注销并释放所有锁。之后不再登记。 */
  dispose(): void {
    this.#disposed = true
    this.#generation++
    if (this.#active !== null) this.#unregister(this.#active)
    this.#active = null
    this.#locks.releaseAll()
  }

  #tryRegister(accelerator: string): Attempt {
    const parsed = parseAccelerator(accelerator)
    const key = physicalShortcutKey(accelerator, this.#platform)
    if (!parsed.ok || key === null) {
      return { ok: false, error: { code: 'promptx/shortcut/invalid', detail: parsed.ok ? 'syntax' : parsed.reason } }
    }
    const lock = this.#locks.acquire(key)
    if (!lock.ok) return { ok: false, error: { code: HELD_BY_PROFILE, detail: lock.holder.profile } }
    let registered = false
    try {
      registered = this.#backend.register(parsed.canonical, () => {
        this.#trigger()
      })
    } catch (error) {
      this.#logger.warn('shortcut.register-threw', { error: errorCode(error) })
      registered = false
    }
    if (!registered) {
      this.#locks.release(key)
      return { ok: false, error: { code: 'promptx/shortcut/taken' } }
    }
    return { ok: true, active: { accelerator, electron: parsed.canonical, key } }
  }

  /**
   * 正在用的组合的锁被另一个存活的 PromptX 接管了（审查 F2）：macOS 的登记不独占，两边都登记着会同时切换、互相抢焦点，
   * 所以这边注销。锁已经不在自己名下，#unregister 里的释放什么都不做，不会删掉对方的锁。
   * 状态和登记时就被占一样报 held-by-profile；正在用的是退回的旧组合时，配置的新组合仍按它自己失败的原因上报。
   */
  #lockLost(key: string, holder: LockHolder): void {
    const active = this.#active
    if (active?.key !== key) return
    this.#unregister(active)
    this.#active = null
    this.#generation++
    this.#conflictId = null
    const fallback = this.#fallbackFrom
    this.#fallbackFrom = null
    this.#failure = fallback ?? { accelerator: active.accelerator, key, error: { code: HELD_BY_PROFILE, detail: holder.profile } }
    // 不记 profile 名：日志里只放状态和错误码（N-02）。
    this.#logger.warn('shortcut.lock-lost')
    this.#emit()
  }

  #unregister(active: Active): void {
    try {
      this.#backend.unregister(active.electron)
    } catch (error) {
      this.#logger.warn('shortcut.unregister-threw', { error: errorCode(error) })
    }
    this.#locks.release(active.key)
  }

  #checkSystem(): void {
    const read = this.#readSystemHotkeys
    const active = this.#active
    if (read === undefined || active === null) return
    const generation = this.#generation
    this.#pending = this.#pending
      .then(async () => {
        const xml = await read().catch(() => null)
        if (generation !== this.#generation) return
        const id = systemConflictFromXml(active.key, xml)
        if (id === null) return
        this.#conflictId = id
        this.#logger.warn('shortcut.system-conflict', { id })
        this.#emit()
      })
      .catch((error: unknown) => {
        this.#logger.warn('shortcut.system-check-failed', { error: errorCode(error) })
      })
  }

  #trigger(): void {
    const now = this.#now()
    if (now - this.#lastTrigger < TRIGGER_GUARD_MS) return
    this.#lastTrigger = now
    try {
      this.#onTrigger()
    } catch (error) {
      this.#logger.warn('shortcut.trigger-failed', { error: errorCode(error) })
    }
  }

  #emit(): void {
    try {
      this.#onStatus(this.status())
    } catch (error) {
      this.#logger.warn('shortcut.status-listener-failed', { error: errorCode(error) })
    }
  }
}
