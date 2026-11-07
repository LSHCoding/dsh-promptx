// PromptX 的 Client 半边（design-spec 2、4.3、4.4、4.7、4.8）：
// - 在 dsh 插件页 PromptX 的详情里挂配置页：keyed slot `plugins.bundle.config`，键是 npm 包名 `dsh-promptx`，
//   页面只会以 `{ view: 'page' }` 渲染它（0.2.2-rc.1 不按 Config 自动生成表单，Host 用 settings.configure({ auto: false }) 声明自带页面）；
// - 每个打开的 dsh 页面常驻一个长轮询循环：配置页的状态从这里来；小窗的「设置」、菜单栏的「设置…」由 Host 记成 navigate 请求，
//   页面在这里切到插件页（dsh 网页没有 URL 路由，只能由页面里的 Client 切过去）；
// - 把页面当前生效的界面语言和可见性报给 Host：dsh 没有语言偏好时界面跟随浏览器，Host 看不到（独立审查 COV-11）；
//   Host 也靠可见性决定只切最近一个可见的页面。
//
// 产物由 tsdown 包成 window.__ModuleLoader__ 格式，React 取 dsh 页面模块表里那一份，其余代码（包括 shared）都打包进来。
// 运行时不 import 任何 @deepseek-ai 包（AGENTS.md：不把 dsh 的 Client 包当模块 require），dsh 的类型只用 import type 取，
// 并按官方的类型合并方式声明本插件的文案命名空间（独立审查 TC-13）。

import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { Context } from '@deepseek-ai/cordis'
import type { PluginConfigViewProps } from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type { SlotCore, SlotMap } from '@deepseek-ai/dsh-client-ui-slots'
import type { ReactNode } from 'react'
import {
  createApi,
  createClientId,
  createClientStateReporter,
  createNavigationHandler,
  createStatusLoop,
  type PromptxApi,
  type StatusStore,
} from './api.ts'
import { ConfigPage } from './ConfigPage.tsx'
import { en, LOCALE_NS, zh, type PromptxTranslate } from './locale.ts'

/** npm 包名：配置页 slot 的键，也是 pluginNavigation.openBundle() 的参数。 */
const BUNDLE_NAME = 'dsh-promptx'

/** 插件页给每个 bundle 自己的配置留的 keyed slot（dsh-client-ui-plugin-manager 的 slot-contract）。 */
const CONFIG_SLOT = 'plugins.bundle.config'

/**
 * dsh 的 slot 服务（`@deepseek-ai/dsh-client-ui-renderer/client` 的 SlotRegistry）里本插件用到的两个方法。
 * 那个包不是本仓库的开发依赖（不随意加依赖），签名按本机安装的 dsh 0.2.2-rc.1 的 `lib/types/client/registry.d.ts` 写：
 * register 直接沿用 ui-slots 的官方类型；inject 在 slot 每次被声明时运行回调，回调返回的清理函数在 slot 收起或插件卸载时执行。
 * 两个都必须以 `ctx.slots.xxx()` 的方式调用：SlotRegistry 靠调用时的 this 把注册记到调用方插件的生命周期上。
 */
export interface SlotsService {
  readonly register: SlotCore['register']
  readonly inject: (key: Extract<keyof SlotMap, string>, callback: () => () => void) => () => void
}

/** dsh 传给 apply 的 Context：locale 与 pluginNavigation 的类型来自官方 `./client` 类型入口，slots 见上。 */
export type ClientContext = Context & { readonly slots: SlotsService }

/** 依赖的服务：slot 注册和 locale。插件页的导航服务是可选的，用到时再取。 */
export const inject = ['slots', 'locale']

export function apply(ctx: ClientContext): void {
  // 先注册文案再挂页面：页面第一次渲染时 `t` 就能取到真实文案，不会先闪一下键名。
  ctx.effect(() => ctx.locale.register(LOCALE_NS, { zh, en }), 'promptx: dictionaries')

  const api = createApi()
  const clientId = createClientId()
  const navigation = createNavigationHandler(() => {
    // 导航服务由 dsh 的插件管理页提供，要等 Host 确认这个页面有管理插件的权限之后才有（dsh-client-ui-plugin-manager
    // 的 apply 里 remoteAccess.whenAccess 之后才 provide）。还不在时不算处理过，等它出现（见下面的 inject）再切。
    const pluginNavigation = ctx.get('pluginNavigation')
    if (pluginNavigation === undefined) return false
    pluginNavigation.openBundle(BUNDLE_NAME)
    return true
  })
  const loop = createStatusLoop({ api, clientId, onStatus: navigation.handle })
  ctx.effect(() => {
    loop.start()
    return loop.dispose
  }, 'promptx: status loop')
  // 导航服务每次出现时补切一次待切的请求。cordis 在服务可用时运行这个子插件，随本插件卸载。
  ctx.inject(['pluginNavigation'], () => {
    try {
      navigation.retry()
    } catch {
      // 切页出错（例如插件页正在重新加载）不能让这个子插件加载失败；这个请求已记为处理过，不再重试。
    }
  })

  const reporter = createClientStateReporter({
    api,
    read: () => ({
      clientId,
      locale: ctx.locale.getLocale().active,
      visible: document.visibilityState === 'visible',
    }),
  })
  ctx.effect(() => {
    const onVisibilityChange = (): void => {
      reporter.report()
    }
    document.addEventListener('visibilitychange', onVisibilityChange)
    reporter.report()
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange)
      reporter.dispose()
    }
  }, 'promptx: client state')
  ctx.effect(() => ctx.on('locale/change', () => {
    reporter.report()
  }), 'promptx: locale change')

  const ConfigEntry = createConfigEntry({
    store: loop,
    api,
    language: () => resolveLanguage(ctx.locale.getLocale().active),
  })
  ctx.effect(() => ctx.slots.inject(CONFIG_SLOT, () => ctx.slots.register({
    name: CONFIG_SLOT,
    key: BUNDLE_NAME,
    locale: LOCALE_NS,
  }, ConfigEntry)), 'promptx: config page')
}

/** design-spec 4.7：以 zh 开头的界面语言用中文，其余用英文。 */
function resolveLanguage(locale: string): 'zh' | 'en' {
  return locale.toLowerCase().startsWith('zh') ? 'zh' : 'en'
}

/** slot 渲染配置页时给的 props：插件页的 owner props（view）加上 dsh 按 `locale: 'promptx'` 注入的 `t`。 */
interface ConfigEntryProps {
  readonly view: PluginConfigViewProps['view']
  readonly t: PromptxTranslate
}

function createConfigEntry(deps: { store: StatusStore; api: PromptxApi; language: () => 'zh' | 'en' }): (props: ConfigEntryProps) => ReactNode {
  return function PromptxConfigEntry({ view, t }: ConfigEntryProps): ReactNode {
    // bundle 的配置只以 page 渲染；summary 是 slot 契约里的一句话概述，这里也给出，换到别的位置时不至于空着。
    if (view === 'summary') return t('summary')
    // 切换界面语言时 dsh 会换一个新的 t 重新渲染这里，所以在渲染时读当前语言就能跟上。
    return <ConfigPage t={t} store={deps.store} api={deps.api} language={deps.language()} />
  }
}
