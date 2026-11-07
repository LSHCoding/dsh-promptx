// 渲染进程只通过这里拿预加载脚本暴露的 window.promptx（shared/bridge.ts）。测试在 window 上放一个假的实现即可。

import { BRIDGE_KEY, type PromptxBridge } from '../../shared/bridge.ts'

function looksLikeBridge(value: unknown): value is PromptxBridge {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Partial<Record<keyof PromptxBridge, unknown>>
  return typeof candidate.call === 'function' && typeof candidate.on === 'function' && typeof candidate.window === 'object'
}

/** 没有预加载脚本（例如直接用浏览器打开了 index.html）时返回 null。 */
export function getBridge(): PromptxBridge | null {
  const value: unknown = Reflect.get(window, BRIDGE_KEY)
  return looksLikeBridge(value) ? value : null
}
