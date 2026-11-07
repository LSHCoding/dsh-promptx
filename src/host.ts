// PromptX 的 Host 组装：按 src/services.ts 的接口创建各服务，把小程序的协议请求分发给它们，
// 把 dsh 的服务（存储、模型、设置、路由）接进来。只做组装和转发，业务逻辑都在各功能域目录里。
//
// 生命周期（design-spec 4.1）：apply 顶层同步注册所有监听和 effect；主 effect 的 setup 只创建对象，
// 取锁、下载运行时、启动小程序都在后台任务里，清理时按「中止后台任务 → 停小程序 → 释放租约 → 关草稿 → 释放实例锁」进行。

import type { Context } from '@deepseek-ai/cordis'
import { createAssistantMessage } from '@deepseek-ai/dsh-llm'
// 只为类型合并：ctx.storageDomain（存储）和 settings/document-updated 事件（设置）。
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-storage-domain'
import { realpathSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import pkg from '../package.json' with { type: 'json' }
import { background } from './background.ts'
import { acquireInstanceLock } from './companion/instance-lock.ts'
import { buildLaunchSpec, resolveAppDir } from './companion/launch.ts'
import { ELECTRON_VERSION } from './companion/electron-release.ts'
import { RuntimeManager } from './companion/runtime.ts'
import { CompanionSupervisor } from './companion/supervisor.ts'
import { type ConfigRefs, DEFAULT_SHORTCUT, readConfig, resolveLibraryDir } from './config.ts'
import { createDraftService } from './draft/service.ts'
import { LibraryService } from './library/service.ts'
import { OptimizeService } from './optimize/service.ts'
import { profileHash, promptxPaths, resolveDshHome } from './paths.ts'
import type { HostPeer, LlmLike, ModelSelection } from './services.ts'
import { PromptxError } from './shared/errors.ts'
import { translate } from './shared/i18n/index.ts'
import { DEFAULT_INSTRUCTION } from './shared/instructions.ts'
import type { CompanionMode, E2eCommand, E2eResult } from './shared/protocol.ts'
import type { CompanionConfig, PromptxConfig } from './shared/types.ts'
import { type Appearance, resolveAppearance, resolveInstructionLocale } from './web/appearance.ts'
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

  // ─────────── 配置、外观、库目录位置 ───────────

  const effectiveLibraryDir = () => resolveLibraryDir(config.libraryDir.get(), { dshHome, defaultLibrary: paths.defaultLibrary })
  const instructionLocale = () => resolveInstructionLocale(appearance, 'zh')

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
    hideOnBlur: config.hideOnBlur.get(),
    confirmDelete: config.confirmDelete.get(),
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
  })
  const draft = createDraftService({ facility: ctx.storageDomain, profile })
  // supervisor 在下面才创建；这些闭包只在它创建之后才会被调用。
  const peer = (): HostPeer | null => supervisor.peer()
  const optimize = new OptimizeService({
    getLlm: () => (optional(ctx, 'llm') as LlmLike | undefined),
    getModel: () => (optional(ctx, 'agentDefaultModel') as { currentSelection(): ModelSelection } | undefined)?.currentSelection(),
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
        library,
        optimize,
        openSettings,
        onStatus: (status) => {
          store.patch({ shortcut: status.shortcut })
        },
        onRestartRequest: () => {
          background(logger, 'restart companion', () => supervisor.restart())
        },
      })
    },
    helloResult: () => ({ hostVersion: pkg.version, config: companionConfig(), mode }),
    onStateChange: (state, error) => {
      const restartsExhausted = supervisor.restartsExhausted()
      store.patch({ companion: { state, ...(error === undefined ? {} : { error }), restartsExhausted } })
    },
    onProcess: (event) => {
      if (event.type === 'spawned') {
        store.patch({ companionPid: event.pid })
        background(logger, 'acquire runtime lease', runtime.acquireLease(ELECTRON_VERSION, event.pid))
      } else {
        store.patch({ companionPid: undefined })
        background(logger, 'release runtime lease', runtime.releaseLease(event.pid))
      }
    },
    logger,
  })

  const updateConfig = createConfigUpdater({
    locationContext,
    apply: async (patch: Partial<PromptxConfig>) => {
      if (settings === undefined) throw new PromptxError('promptx/settings/unavailable')
      await settings.update(SETTINGS_NAMESPACE, patch)
    },
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
        restart: () => supervisor.restart(),
        show: () => {
          const channel = peer()
          if (channel === null) throw new PromptxError('promptx/channel/closed')
          channel.notify('window.command', { command: 'show' })
        },
      },
      runtime: {
        download: async () => {
          runtime.resume()
          if (supervisor.state() !== 'running') await supervisor.restart()
        },
        remove: async () => {
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
    let releaseLock: (() => Promise<void>) | null = null
    const offRuntime = runtime.onChange((status) => {
      store.patch({ runtime: status })
    })
    background(logger, 'startup', (async () => {
      const lockPath = join(paths.root, 'locks', `instance-${profile.hash}.lock`)
      await mkdir(join(paths.root, 'locks'), { recursive: true })
      const lock = await acquireInstanceLock(lockPath)
      if (!lock.acquired) {
        store.patch({ instance: 'duplicate' })
        logger.warn('another dsh process already runs PromptX for this profile (pid %d)', lock.holderPid)
        return
      }
      if (abort.signal.aborted) {
        await lock.release()
        return
      }
      releaseLock = () => lock.release()
      supervisor.start()
    })())
    return async () => {
      abort.abort()
      offRuntime()
      await supervisor.stop('host-closing').catch(() => {})
      optimize.dispose()
      await runtime.releaseLease().catch(() => {})
      runtime.dispose()
      await draft.close().catch(() => {})
      await releaseLock?.().catch(() => {})
      store.close()
    }
  }, 'promptx: companion lifecycle')
}
