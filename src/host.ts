// PromptX 的 Host 组装：按 src/services.ts 的接口创建各服务，把小程序的协议请求分发给它们，
// 把 dsh 的服务（存储、模型、设置、路由）接进来。只做组装和转发，业务逻辑都在各功能域目录里。
//
// 生命周期（design-spec 4.1）：apply 顶层同步注册所有监听和 effect；主 effect 的 setup 只创建对象，
// 取锁、下载运行时、启动小程序都在后台任务里，清理时按「中止后台任务 → 停小程序 → 释放租约 → 关草稿 → 释放实例锁」进行。
// 实例锁拿不到时每隔几秒重试，拿到后靠心跳续着；没拿到锁时配置页上的启动、下载、删除操作一律拒绝（审查 H1、F2）。

import type { Context } from '@deepseek-ai/cordis'
import { createAssistantMessage } from '@deepseek-ai/dsh-llm'
// 只为类型合并：ctx.storageDomain（存储）和 settings/document-updated 事件（设置）。
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-storage-domain'
import { realpathSync } from 'node:fs'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { setTimeout as delay } from 'node:timers/promises'
import pkg from '../package.json' with { type: 'json' }
import { background } from './background.ts'
import { acquireInstanceLock, HEARTBEAT_MS, type HeldInstanceLock } from './companion/instance-lock.ts'
import { buildLaunchSpec, resolveAppDir } from './companion/launch.ts'
import { ELECTRON_VERSION } from './companion/electron-release.ts'
import { RuntimeManager } from './companion/runtime.ts'
import { CompanionSupervisor } from './companion/supervisor.ts'
import { type ConfigRefs, DEFAULT_SHORTCUT, readConfig, resolveLibraryDir } from './config.ts'
import { createDraftService } from './draft/service.ts'
import { LibraryService } from './library/service.ts'
import { suggestPromptMetadata } from './library/suggest-metadata.ts'
import { OptimizeService } from './optimize/service.ts'
import { profileHash, promptxPaths, resolveDshHome } from './paths.ts'
import type { HostPeer, LlmLike, ModelSelection } from './services.ts'
import { PromptxError, toErrorInfo } from './shared/errors.ts'
import { translate } from './shared/i18n/index.ts'
import { DEFAULT_INSTRUCTION } from './shared/instructions.ts'
import type { CompanionMode, E2eCommand, E2eResult } from './shared/protocol.ts'
import type { CompanionConfig, CompanionState, ErrorInfo, PanelStatus, PromptxConfig, SettingsData } from './shared/types.ts'
import { readToolbarShortcuts } from './shared/window-shortcuts.ts'
import { type Appearance, type AppearanceLocale, mapLocaleTag, resolveAppearance, resolveInstructionLocale } from './web/appearance.ts'
import { checkLibraryRoot, createConfigUpdater, type LocationContext } from './web/config-update.ts'
import { attachCompanionHandlers } from './host-handlers.ts'
import { planOpenSettings } from './web/open-settings.ts'
import { isE2eEnabled, registerRoutes, type FetchRegistry } from './web/routes.ts'
import { StatusStore } from './web/status-store.ts'

/** 用到的 dsh 服务里没有官方类型包可引的几个（或依赖太重的），按用到的方法写最小接口。 */
interface WebAppLike {
  getAdvertisedUrl(): string
}
interface ConnectionLike extends FetchRegistry {
  authenticatedUrl(baseUrl: string): string
}
interface SettingsLike {
  configure(presentation: { auto?: boolean }, owner?: unknown): () => void
  describe(): ReadonlyArray<{ ns: string; value: unknown }>
  update(ns: string, patch: object, expectedRevision?: number): Promise<void>
}
interface ConfigEditorLike {
  entries?: () => Iterable<{ options?: { name?: string }; fiber?: { effectiveConfig?: unknown } | undefined }>
}

/** cordis 的 ctx.get 对没有类型声明的服务返回 any；统一经这里转成 unknown，由调用处按用到的方法收窄，避免 any 扩散。 */
function optional(ctx: Context, name: string): unknown {
  return (ctx.get as (name: string) => unknown)(name)
}

/** 插件条目在 cordis.patch.yml 里的 id，也是 dsh 设置的命名空间。 */
const SETTINGS_NAMESPACE = 'promptx'

/** 实例锁被别的进程持有时，隔这么久再试一次。 */
const LOCK_RETRY_MS = 3_000

/**
 * Host 自己推断的系统语言：小程序还没上报过语言时才用（之后以小程序报的为准，它能读到系统的语言列表）。
 * Node 的默认语言来自 LANG 等环境变量，从访达启动的桌面版里可能没有，所以只是兜底。
 */
function hostSystemLocale(): AppearanceLocale {
  try {
    return mapLocaleTag(Intl.DateTimeFormat().resolvedOptions().locale) ?? 'en'
  } catch {
    return 'en'
  }
}

export function startPromptxHost(ctx: Context, config: ConfigRefs): void {
  const logger = ctx.logger('promptx')
  const dshHome = resolveDshHome(optional(ctx, 'dshHomePath') as ((...segments: string[]) => string) | undefined)
  const paths = promptxPaths(dshHome)
  const profileName = (optional(ctx, 'profileContext') as { name: string } | undefined)?.name ?? ''
  const profile = { name: profileName === '' ? 'default' : profileName, hash: profileHash(profileName === '' ? undefined : profileName) }
  // 桌面版的 Host 进程以 ELECTRON_RUN_AS_NODE=1 运行（dsh 官方 apps/desktop 的约定）。
  const desktop = process.env.ELECTRON_RUN_AS_NODE === '1'
  const e2e = isE2eEnabled(process.env)
  const mode: CompanionMode = e2e ? 'e2e' : 'normal'

  let settings: SettingsLike | undefined
  let connection: ConnectionLike | undefined
  let reportedLocale: string | null = null
  let appearance: Appearance = { locale: null, theme: 'system' }
  /** 小程序上报的界面语言（dsh 没有语言偏好时它跟随系统语言）。 */
  let companionLocale: AppearanceLocale | null = null
  /** 小程序上报的界面崩溃状态：运行中但界面正在重新加载时显示在配置页。 */
  let rendererError: ErrorInfo | null = null
  /** 本实例是否持有实例锁。没有时不启动小程序，配置页的启动、下载、删除操作都拒绝。 */
  let lockHeld = false
  /** 本实例最近启动的小程序进程号：卸载时只释放它的运行时租约。 */
  let lastSpawnedPid: number | undefined

  // ─────────── 配置、外观、库目录位置 ───────────

  const effectiveLibraryDir = () => resolveLibraryDir(config.libraryDir.get(), { dshHome, defaultLibrary: paths.defaultLibrary })
  // 优化默认指令、「未命名 Prompt」的语言和小窗界面一致（需求 O-08，design-spec 4.7，审查 F5）。
  const instructionLocale = () => resolveInstructionLocale(appearance, companionLocale ?? hostSystemLocale())

  const skillSettings = (): { dirs: string[]; agentsHome: string | undefined } => {
    const result = { dirs: [] as string[], agentsHome: undefined as string | undefined }
    try {
      const editor = (optional(ctx, 'configEditor') as ConfigEditorLike | undefined)
      for (const entry of editor?.entries?.() ?? []) {
        if (entry.options?.name !== '@deepseek-ai/dsh-skill-filesystem') continue
        const effective = entry.fiber?.effectiveConfig
        if (typeof effective !== 'object' || effective === null) continue
        const dirs = (effective as { customSkillDirs?: unknown }).customSkillDirs
        if (Array.isArray(dirs)) result.dirs.push(...dirs.filter((d): d is string => typeof d === 'string'))
        const agentsHome = (effective as { agentsHome?: unknown }).agentsHome
        if (typeof agentsHome === 'string' && agentsHome !== '') result.agentsHome = agentsHome
      }
    } catch {
      // configEditor 的结构不是公开契约，读不到时不检查用户另配的技能目录（design-spec 7.4、已知限制 6）。
    }
    return result
  }
  const locationContext = (): LocationContext => {
    const skills = skillSettings()
    return { dshHome, defaultLibrary: paths.defaultLibrary, extraSkillDirs: skills.dirs, agentsHome: skills.agentsHome }
  }

  const companionConfig = (): CompanionConfig => ({
    globalShortcut: config.globalShortcut.get(),
    windowShortcuts: readToolbarShortcuts(field => config[field].get()),
    hideOnBlur: config.hideOnBlur.get(),
    confirmDelete: config.confirmDelete.get(),
    convertMiddleDot: config.convertMiddleDot.get(),
    convertYen: config.convertYen.get(),
    locale: appearance.locale,
    theme: appearance.theme,
    libraryDir: effectiveLibraryDir(),
    profile: profile.name,
  })

  // ─────────── 服务 ───────────

  const runtime = new RuntimeManager({ root: paths.runtime, getSource: () => config.runtimeSource.get(), profile, logger })
  const store = new StatusStore({
    config: readConfig(config),
    effectiveLibraryDir: effectiveLibraryDir(),
    defaultShortcut: DEFAULT_SHORTCUT,
    defaultInstruction: { zh: DEFAULT_INSTRUCTION.zh, en: DEFAULT_INSTRUCTION.en },
    runtime: runtime.status(),
    companion: { state: 'stopped' },
    shortcut: null,
    platform: process.platform,
    instance: 'active',
  })
  const library = new LibraryService({
    getRoot: effectiveLibraryDir,
    untitledTitle: () => translate(instructionLocale(), 'library.untitled'),
    checkRoot: root => checkLibraryRoot(root, locationContext()),
    // 扫描跳过的目录要比较 realpath：dsh 数据目录、PromptX 自己的目录、dsh 的技能目录（design-spec 7.4）。
    skipRealpaths: () => {
      const skills = skillSettings()
      const candidates = [dshHome, paths.root, join(dshHome, 'skills'), ...skills.dirs]
      if (skills.agentsHome !== undefined) candidates.push(join(skills.agentsHome, 'skills'))
      return candidates.flatMap((dir) => {
        try {
          return [realpathSync(dir)]
        } catch {
          return []
        }
      })
    },
    lockDir: join(paths.root, 'locks'),
  })
  const draft = createDraftService({ facility: ctx.storageDomain, profile })
  const entryDraft = createDraftService({ facility: ctx.storageDomain, profile, scope: 'entry' })
  const getLlm = () => optional(ctx, 'llm') as LlmLike | undefined
  const getModel = () => (optional(ctx, 'agentDefaultModel') as { currentSelection(): ModelSelection } | undefined)?.currentSelection()
  const metadataAbort = new AbortController()
  // supervisor 在下面才创建；这些闭包只在它创建之后才会被调用。
  const peer = (): HostPeer | null => supervisor.peer()
  const optimize = new OptimizeService({
    getLlm,
    getModel,
    getInstruction: () => config.optimizeInstruction.get(),
    getLocale: instructionLocale,
    emit: (event) => {
      peer()?.notify('optimize.event', event)
    },
    createAssistantMessage: (text, source) => createAssistantMessage({ content: [{ type: 'text', text }], source }),
    logger,
  })

  const pushConfig = () => {
    peer()?.notify('config', companionConfig())
  }
  /** 配置页上的小程序状态。运行中时显示界面崩溃后正在重新加载的情况（design-spec 5.4，审查 CR-03）。 */
  const companionView = (state: CompanionState, error: ErrorInfo | undefined, exhausted: boolean): PanelStatus['companion'] => {
    const shown = state === 'running' ? (rendererError ?? undefined) : error
    return { state, ...(shown === undefined ? {} : { error: shown }), restartsExhausted: exhausted }
  }
  /** 配置页的操作只在持有实例锁时可用：重复的实例启动小程序会和另一个进程同时写同一份草稿（产品红线 1，审查 H1）。 */
  const requireActive = (): void => {
    if (!lockHeld) throw new PromptxError('promptx/instance/duplicate')
  }
  const refreshAppearance = () => {
    appearance = resolveAppearance({ describe: () => settings?.describe() ?? [], reportedLocale })
    pushConfig()
  }

  const openSettings = () => planOpenSettings(store, {
    desktop,
    webUrl: () => {
      const webApp = (optional(ctx, 'webApp') as WebAppLike | undefined)
      if (webApp === undefined || connection === undefined) return null
      // 带口令的地址只交给小程序用系统打开，不写日志、不落盘（design-spec 4.8）。
      return connection.authenticatedUrl(webApp.getAdvertisedUrl())
    },
  })

  // dsh 配置页的「保存」和设置窗口的改动共用这一个更新函数：同一套校验，按调用顺序串行写入。
  const updateConfig = createConfigUpdater({
    locationContext,
    currentConfig: () => readConfig(config),
    platform: process.platform,
    apply: async (patch: Partial<PromptxConfig>) => {
      if (settings === undefined) throw new PromptxError('promptx/settings/unavailable')
      await settings.update(SETTINGS_NAMESPACE, patch)
    },
  })

  /** 设置窗口要显示的内容（V0.1.6 design-spec 4）。 */
  const settingsData = (): SettingsData => {
    const status = runtime.status()
    return {
      config: readConfig(config),
      effectiveLibraryDir: effectiveLibraryDir(),
      defaultLibraryDir: paths.defaultLibrary,
      defaultShortcut: DEFAULT_SHORTCUT,
      defaultInstruction: { zh: DEFAULT_INSTRUCTION.zh, en: DEFAULT_INSTRUCTION.en },
      platform: process.platform,
      hostVersion: pkg.version,
      profile: profile.name,
      runtime: { version: status.version, ...(status.source === undefined ? {} : { source: status.source }) },
    }
  }

  const supervisor: CompanionSupervisor = new CompanionSupervisor({
    prepareLaunch: async (signal) => {
      const install = await runtime.ensure(signal)
      return buildLaunchSpec({
        executable: install.executable,
        appDir: resolveAppDir(),
        profile,
        dataDir: paths.root,
        parentPid: process.pid,
        env: process.env,
        platform: process.platform,
      })
    },
    attach: (channel) => {
      attachCompanionHandlers(channel, {
        draft,
        entryDraft,
        library,
        optimize,
        // 隔离端到端测试走手填路径，避免调用维护者配置的模型。
        suggestMetadata: text => e2e ? Promise.resolve(null) : suggestPromptMetadata(text, {
          getLlm, getModel, hasTitle: title => library.hasTitle(title), signal: metadataAbort.signal,
        }),
        openSettings,
        getSettings: settingsData,
        updateSettings: patch => updateConfig(patch),
        onStatus: (status) => {
          companionLocale = status.locale
          rendererError = status.rendererError
          const companion = companionView(supervisor.state(), supervisor.error(), supervisor.restartsExhausted())
          store.patch({ shortcut: status.shortcut, companion })
        },
        onRestartRequest: () => {
          background(logger, 'restart companion', () => supervisor.restart())
        },
      })
    },
    helloResult: () => ({ hostVersion: pkg.version, config: companionConfig(), mode }),
    onStateChange: (state, error) => {
      // 新进程会重新上报；旧进程的界面状态不再有意义。
      if (state !== 'running') rendererError = null
      store.patch({ companion: companionView(state, error, supervisor.restartsExhausted()) })
    },
    onProcess: (event) => {
      if (event.type === 'spawned') {
        lastSpawnedPid = event.pid
        store.patch({ companionPid: event.pid })
        background(logger, 'acquire runtime lease', runtime.acquireLease(ELECTRON_VERSION, event.pid))
      } else {
        store.patch({ companionPid: undefined })
        background(logger, 'release runtime lease', runtime.releaseLease(event.pid))
      }
    },
    logger,
  })

  const runE2e = async (command: E2eCommand): Promise<E2eResult> => {
    if (command.action === 'host-read') {
      const started = performance.now()
      await library.read(command.relPath)
      return { ok: true, data: { ms: Math.round(performance.now() - started) } }
    }
    const channel = peer()
    if (channel === null) return { ok: false, data: {}, error: { code: 'promptx/channel/closed' } }
    return channel.request('e2e.run', command, { timeoutMs: 60_000 })
  }

  // ─────────── 配置变化（必须在 apply 顶层的 ctx 上监听，Loader 只投递给插件自己的 fiber） ───────────

  let lastLibraryDir = effectiveLibraryDir()
  const onVolatileUpdate = () => {
    const libraryDir = effectiveLibraryDir()
    if (libraryDir !== lastLibraryDir) {
      lastLibraryDir = libraryDir
      library.reset()
      peer()?.notify('library.changed', { libraryDir })
    }
    store.patch({ config: readConfig(config), effectiveLibraryDir: libraryDir })
    pushConfig()
  }
  ;(ctx.on as unknown as (name: string, listener: (paths: string[][]) => void) => () => boolean).call(ctx, 'loader/volatile-update', onVolatileUpdate)

  // ─────────── dsh 设置：自带配置页、读语言和明暗、写配置 ───────────

  ctx.inject(['settings'], (child) => {
    const service = (optional(child, 'settings') as SettingsLike | undefined)
    if (service === undefined) return
    settings = service
    child.effect(() => service.configure({ auto: false }, ctx.fiber), 'promptx: own config page')
    child.on('settings/document-updated', (ns: string) => {
      if (ns === 'locale' || ns === 'ui-theme') refreshAppearance()
    })
    child.effect(() => () => {
      settings = undefined
    }, 'promptx: settings handle')
    refreshAppearance()
  })

  // ─────────── 给配置页的 /api 路由 ───────────

  ctx.inject(['connection'], (child) => {
    const service = (optional(child, 'connection') as ConnectionLike | undefined)
    if (service === undefined) return
    connection = service
    const disposers = registerRoutes(service, {
      store,
      updateConfig,
      companion: {
        restart: () => {
          requireActive()
          return supervisor.restart()
        },
        show: () => {
          requireActive()
          const channel = peer()
          if (channel === null) throw new PromptxError('promptx/channel/closed')
          channel.notify('window.command', { command: 'show' })
        },
        // 插件页只留小窗和运行时（V0.1.6 追加 3），其他设置由这里打开小程序的设置窗口。
        settings: () => {
          requireActive()
          const channel = peer()
          if (channel === null) throw new PromptxError('promptx/channel/closed')
          channel.notify('window.command', { command: 'settings' })
        },
      },
      runtime: {
        download: async () => {
          requireActive()
          runtime.resume()
          if (supervisor.state() !== 'running') await supervisor.restart()
        },
        remove: async () => {
          // 重复的实例和正在运行的小程序同属一个 profile，租约保护不了它：删运行时只能由持锁的实例做。
          requireActive()
          await supervisor.stop('runtime-delete')
          const result = await runtime.remove()
          store.patch({ runtime: runtime.status() })
          return result
        },
      },
      reportClientState: (state) => {
        if (state.locale !== reportedLocale) {
          reportedLocale = state.locale
          refreshAppearance()
        }
      },
      e2e: e2e ? runE2e : undefined,
      logger,
    })
    child.effect(() => async () => {
      connection = undefined
      await Promise.allSettled(disposers.map(dispose => dispose()))
    }, 'promptx: routes')
  })

  // ─────────── 主 effect：实例锁、运行时、小程序 ───────────

  ctx.effect(() => {
    const abort = new AbortController()
    let lock: HeldInstanceLock | null = null
    let heartbeat: NodeJS.Timeout | undefined
    const offRuntime = runtime.onChange((status) => {
      store.patch({ runtime: status })
    })
    const lockPath = join(paths.root, 'locks', `instance-${profile.hash}.lock`)

    /**
     * 取实例锁，拿不到就隔几秒再试：另一个 dsh 进程退出后这里自动接手；锁文件里的 pid 被无关进程复用时，
     * 等心跳确认过期后接手（审查 F2）；锁目录暂时写不进去时在配置页显示原因，并继续重试（审查 H1）。
     */
    // 写成函数：await 之后状态可能已经变了，直接读属性会被类型收窄成「一定没中止」。
    const closing = () => abort.signal.aborted
    const acquire = async (): Promise<void> => {
      let warned = false
      while (!closing()) {
        try {
          const result = await acquireInstanceLock(lockPath)
          if (result.acquired) {
            if (closing()) await result.release()
            else hold(result)
            return
          }
          if (!warned) {
            warned = true
            logger.warn('another dsh process already runs PromptX for this profile (pid %d); retrying', result.holderPid)
          }
          store.patch({ instance: 'duplicate' })
        } catch (error) {
          const info = toErrorInfo(error)
          logger.warn('instance lock failed: %s%s', info.code, info.detail === undefined ? '' : ` (${info.detail})`)
          store.patch({ instance: 'active', companion: { state: 'failed', error: info, restartsExhausted: false } })
        }
        try {
          await delay(LOCK_RETRY_MS, undefined, { signal: abort.signal })
        } catch {
          // 插件卸载：不再重试。
          return
        }
      }
    }

    const hold = (held: HeldInstanceLock): void => {
      lock = held
      lockHeld = true
      store.patch({ instance: 'active' })
      heartbeat = setInterval(() => {
        background(logger, 'instance lock heartbeat', beat())
      }, HEARTBEAT_MS)
      heartbeat.unref()
      supervisor.start()
    }

    /**
     * 心跳。锁被接管了，说明另一个 dsh 进程认定本进程已经不在（本进程卡住了约两分钟）：
     * 让出，停掉小程序，回到重试，免得两个进程同时写同一份草稿。
     */
    const beat = async (): Promise<void> => {
      const held = lock
      if (held === null || (await held.refresh()) || lock !== held) return
      logger.error('the instance lock was taken over by another dsh process; stopping the companion')
      clearInterval(heartbeat)
      heartbeat = undefined
      lock = null
      lockHeld = false
      store.patch({ instance: 'duplicate' })
      // release 不会删别人的锁文件，只是把本进程的登记清掉，之后才能重新去抢。
      await held.release().catch(() => {})
      await supervisor.stop('instance-lock-lost')
      if (!closing()) background(logger, 'instance lock', acquire())
    }

    background(logger, 'instance lock', acquire())
    return async () => {
      abort.abort()
      metadataAbort.abort()
      clearInterval(heartbeat)
      offRuntime()
      await supervisor.close('host-closing').catch(() => {})
      optimize.dispose()
      // 只释放本实例启动过的小程序的租约：同一个 profile 的另一个实例的租约文件同名，不带 pid 会把它删掉（审查 H3）。
      if (lastSpawnedPid !== undefined) await runtime.releaseLease(lastSpawnedPid).catch(() => {})
      runtime.dispose()
      await draft.close().catch(() => {})
      await entryDraft.close().catch(() => {})
      const held = lock
      lock = null
      lockHeld = false
      await held?.release().catch(() => {})
      store.close()
    }
  }, 'promptx: companion lifecycle')
}
