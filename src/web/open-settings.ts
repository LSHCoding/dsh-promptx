// 小程序的「设置…」：打开 dsh 插件页里 PromptX 的配置页，并把 dsh 的窗口带到前台（需求 F-05，design-spec 4.8、D13）。
//
// dsh 网页没有 URL 路由，插件页只能由页面里的 Client 切过去：Host 记下一次 navigate 请求，在线的页面从长轮询拿到后
// 调用 pluginNavigation.openBundle()。窗口怎么到前台由小程序用 shell.openExternal() 打开这里返回的地址：
// - dsh 桌面版（Host 进程带 ELECTRON_RUN_AS_NODE=1）：`dsh://open`，macOS 上桌面版只认这个完整地址，不能带路由；
// - 其他情况（dsh web 等）：没有页面在线时打开带口令的 dsh 网页地址，页面加载后从长轮询拿到 navigate（60 秒内有效）；
//   有页面在线时浏览器窗口带不到前台，返回 null，小程序先提示「已在 dsh 页面打开 PromptX 设置」再隐藏。
// 带口令的地址只经标准输入输出交给小程序，这里不记日志。

import type { StatusStore } from './status-store.ts'

/** 桌面版主窗口的唤起地址。 */
export const DESKTOP_OPEN_URL = 'dsh://open'

/**
 * 页面最后一次长轮询结束后多久之内仍算在线。在线页面几乎总有一个长轮询挂着，
 * 这里只需要盖住两次轮询之间的空档和页面出错后的短暂退避。
 */
export const PAGE_ONLINE_WITHIN_MS = 10_000

export interface OpenSettingsInput {
  /** 是否运行在 dsh 桌面版里（Host 进程的 `process.env.ELECTRON_RUN_AS_NODE === '1'`）。 */
  desktop: boolean
  /** 带口令的 dsh 网页地址（`connection.authenticatedUrl(webApp.getAdvertisedUrl())`）；取不到时返回 null。只在需要时调用。 */
  webUrl: () => string | null
  onlineWithinMs?: number | undefined
}

/** host.openSettings 的结果：open 是要用系统打开的地址；navigated 表示有在线页面会切到配置页。 */
export function planOpenSettings(store: StatusStore, input: OpenSettingsInput): { open: string | null; navigated: boolean } {
  const withinMs = input.onlineWithinMs ?? PAGE_ONLINE_WITHIN_MS
  // 先判断在线再记请求：记请求会唤醒长轮询，页面随即重新发起轮询，判断结果不受影响，但顺序固定更好推理。
  const navigated = store.hasAnyClient(withinMs)
  store.requestNavigate()
  if (input.desktop) return { open: DESKTOP_OPEN_URL, navigated }
  if (navigated) return { open: null, navigated }
  let open: string | null
  try {
    open = input.webUrl()
  } catch {
    // webApp 或 connection 服务正在重载时可能抛异常；没有地址可开时小程序只隐藏，不应让整个请求失败。
    open = null
  }
  return { open, navigated }
}
