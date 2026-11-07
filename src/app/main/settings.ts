// 「设置…」和小窗的「设置」按钮（需求 F-05，design-spec 4.8）。Host 记下一次「打开配置页」请求，
// 返回要用系统打开的地址（桌面版是 dsh://open，dsh web 没有页面在线时是带口令的网页地址）和是否已有页面会切过去。
//
// - 有地址：交给 shell.openExternal，dsh 的窗口或浏览器来到前台，小窗立即隐藏。
// - 没有地址但已有页面切到了插件页（dsh web，浏览器窗口没法由插件带到前台）：从小窗发起时，渲染进程显示提示
//   「已在 dsh 页面打开 PromptX 设置」，小窗约 2 秒后再隐藏；从菜单栏发起时没有提示可看，立即隐藏。
// - 两样都没有（dsh web 没有页面在线、也拿不到网页地址）：照 design-spec 4.8 第 4 步同样隐藏。
//   Host 已经记下了请求，60 秒内打开 dsh 页面仍会切到配置页。
// 带口令的地址只经过这里交给系统打开，不写日志。

import type { ErrorInfo } from '../../shared/types.ts'

export interface SettingsPlan {
  openUrl: string | null
  hide: 'now' | 'delayed' | 'none'
  error: ErrorInfo | null
}

/** 只允许打开 dsh:// 和 http(s):// 地址：openExternal 打开 file:// 之类的地址可能直接运行本机程序。 */
export function isOpenableUrl(url: string): boolean {
  try {
    const protocol = new URL(url).protocol
    return protocol === 'dsh:' || protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}

export function planSettingsOpen(result: { open: string | null; navigated: boolean }, source: 'window' | 'tray'): SettingsPlan {
  if (result.open !== null) {
    if (!isOpenableUrl(result.open)) return { openUrl: null, hide: 'none', error: { code: 'promptx/settings/unavailable', detail: 'unsupported url' } }
    return { openUrl: result.open, hide: 'now', error: null }
  }
  if (result.navigated && source === 'window') return { openUrl: null, hide: 'delayed', error: null }
  return { openUrl: null, hide: 'now', error: null }
}
