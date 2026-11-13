// 窗口位置和大小的计算（需求 F-02、5.7，design-spec 5.4）。算法本身在 shared/layout.ts，
// 这里把它和主进程的几个入口对上：显示前的位置、「重置窗口位置」、渲染进程请求的宽度和最小宽度。

import type { Prefs } from '../../shared/bridge.ts'
import { ensureVisible, initialWindowBounds, libraryWidth, MIN_WINDOW, PANE_LIMITS, type HorizontalSpan, type Rect } from '../../shared/layout.ts'

export interface DisplayArea {
  workArea: Rect
}

/**
 * 显示前的位置和大小：没有记录时按鼠标所在屏幕的默认位置；有记录时挪回可见范围
 * （工具栏那条带至少有 64×24 在某个屏幕上，否则移回鼠标所在屏幕）。
 */
export function boundsForShow(saved: Rect | null, displays: readonly DisplayArea[], cursorWorkArea: Rect, toolbar?: HorizontalSpan): Rect {
  if (saved === null) return initialWindowBounds(cursorWorkArea)
  return ensureVisible(saved, displays, cursorWorkArea, toolbar)
}

/** 工具栏在编辑区上方，窗口左侧露出库栏时也得检查是否抓得到工具栏。 */
export function toolbarSpan(prefs: Prefs): HorizontalSpan | undefined {
  const { window, panes, editorWidth } = prefs
  if (window === null) return undefined
  const width = Math.min(window.width, editorWidth ?? PANE_LIMITS.editor.min)
  const x = panes.library ? Math.min(libraryWidth(panes), window.width - width) : 0
  return { x, width: editorWidth === null ? window.width - x : width }
}

/** 「重置窗口位置」：主屏幕上的默认位置和默认大小。 */
export function boundsForReset(primaryWorkArea: Rect): Rect {
  return initialWindowBounds(primaryWorkArea)
}

/**
 * 窗口的最小尺寸：渲染进程按打开的栏位请求的最小宽度（不小于 520），不超过屏幕可用区域；
 * 屏幕比 520×360 还小时降到可用区域，小窗可以铺满屏幕（F-02）。
 */
export function minimumSize(requestedWidth: number, workArea: Rect): { width: number; height: number } {
  const wanted = Number.isFinite(requestedWidth) ? Math.max(Math.round(requestedWidth), MIN_WINDOW.width) : MIN_WINDOW.width
  return {
    width: Math.max(1, Math.min(wanted, Math.floor(workArea.width))),
    height: Math.max(1, Math.min(MIN_WINDOW.height, Math.floor(workArea.height))),
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

/** 把窗口放大到不小于最小尺寸，放大后仍在可用区域里（只在这个方向上需要时才挪位置）。 */
export function growToMinimum(bounds: Rect, minimum: { width: number; height: number }, workArea: Rect): Rect {
  const width = Math.max(bounds.width, minimum.width)
  const height = Math.max(bounds.height, minimum.height)
  const x = width === bounds.width ? bounds.x : clamp(bounds.x, workArea.x, workArea.x + workArea.width - width)
  const y = height === bounds.height ? bounds.y : clamp(bounds.y, workArea.y, workArea.y + workArea.height - height)
  return { x, y, width, height }
}

/**
 * 调整宽度（5.7 的空间分配由渲染进程算好，主进程只负责落到屏幕上）：
 * anchor 为 left 时左边不动、向右伸缩，为 right 时右边不动、向左伸缩；
 * 宽度夹在 [最小宽度, 可用区域宽度] 之间，伸出可用区域时整体挪回来，等于「那一侧不够再用另一侧」。
 */
export function resizeWidth(current: Rect, width: number, anchor: 'left' | 'right', workArea: Rect, minWidth: number): Rect {
  const max = Math.max(1, Math.floor(workArea.width))
  const target = Number.isFinite(width) ? Math.round(width) : current.width
  const nextWidth = clamp(target, Math.min(minWidth, max), max)
  const x = anchor === 'left' ? current.x : current.x + current.width - nextWidth
  return {
    x: clamp(x, workArea.x, workArea.x + workArea.width - nextWidth),
    y: current.y,
    width: nextWidth,
    height: current.height,
  }
}

/**
 * 子窗口（设置窗口）第一次出现的位置：中心对齐父窗口的中心，大小不超过可用区域，整体收回可用区域以内。
 * 父窗口比子窗口小、或者靠近屏幕边缘时，子窗口不会有一部分跑到屏幕外。
 */
export function centerOver(parent: Rect, size: { width: number; height: number }, workArea: Rect): Rect {
  const width = Math.max(1, Math.min(Math.round(size.width), Math.floor(workArea.width)))
  const height = Math.max(1, Math.min(Math.round(size.height), Math.floor(workArea.height)))
  const x = Math.round(parent.x + (parent.width - width) / 2)
  const y = Math.round(parent.y + (parent.height - height) / 2)
  return {
    x: clamp(x, workArea.x, workArea.x + workArea.width - width),
    y: clamp(y, workArea.y, workArea.y + workArea.height - height),
    width,
    height,
  }
}

export function sameRect(a: Rect, b: Rect): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height
}
