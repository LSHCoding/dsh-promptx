// 小窗的尺寸、位置和空间分配（需求 F-02、5.7，技术方案 5.4、5.5）。
// 这里只做计算：输入当前的窗口、屏幕和栏宽，输出要设置的位置和大小，调用窗口接口的事留给主进程和渲染进程。
// 单位都是逻辑像素。

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/** 只关心水平方向时的位置和宽度。 */
export interface HorizontalSpan {
  x: number
  width: number
}

export type OptionalPane = 'library' | 'session'

export const DEFAULT_WINDOW = { width: 980, height: 600 } as const
export const MIN_WINDOW = { width: 520, height: 360 } as const

/** 第一次显示时屏幕放不下默认大小，四周各留的边距。 */
export const WINDOW_MARGIN = 24

/** 垂直方向「居中略偏上」：窗口上方留出的空间占剩余高度的比例。 */
export const WINDOW_VERTICAL_RATIO = 0.4

/**
 * 判断窗口还能不能被拖到的那条带：窗口顶部 40 像素高（工具栏），至少有 64×24 落在某个屏幕的可用区域里。
 * 小于这个面积时鼠标很难抓住工具栏，等于窗口丢了。
 */
export const TOOLBAR_STRIP = { height: 40, minVisibleWidth: 64, minVisibleHeight: 24 } as const

/** 需求 5.7 的栏宽和高度限制。库侧栏打开时占 folder + list 两栏的宽度。 */
export const PANE_LIMITS = {
  folder: { min: 130, max: 460, default: 150 },
  list: { min: 200, default: 300 },
  editor: { min: 330 },
  session: { min: 300, max: 560, default: 420 },
  /** 列表栏下半部分的选中预览。 */
  preview: { min: 128, default: 232 },
  /** 列表栏上半部分的列表，预览拖高时至少给它留这么多。 */
  listPart: { min: 96 },
} as const

export interface PaneState {
  open: boolean
  /** 这块栏打开时占的总宽度（含分隔线）。库侧栏是文件夹栏和列表栏的宽度之和。 */
  width: number
}

export interface PaneOpenInput {
  /** 打开前小窗的位置和宽度。 */
  window: HorizontalSpan
  /** 小窗所在屏幕的可用区域。 */
  workArea: HorizontalSpan
  panes: Record<OptionalPane, PaneState>
  opening: OptionalPane
  editorMin: number
}

export interface PaneOpenPlan {
  /** 打开后小窗的位置和宽度。 */
  window: HorizontalSpan
  /** 为了腾出空间暂时收起的另一侧可选栏；它的内容不丢，用户用工具栏按钮重新打开。 */
  collapse: OptionalPane | null
  /** 打开后编辑区的宽度。屏幕本身比「可选栏 + 编辑区最小宽度」还窄时会小于 editorMin。 */
  editorWidth: number
  /** 打开前的小窗宽度和位置（规则 4：关闭这块栏后复原成这个值）。 */
  restoreWidth: number
  restoreX: number
  /** 这次打开时小窗向左、向右各加宽了多少。关闭时交给 planPaneClose 收回。 */
  grown: { left: number; right: number }
}

/**
 * 打开库侧栏或会话栏时的空间分配（需求 5.7）：
 * 1. 小窗先向有空余的一侧加宽：库侧栏在左边，先往左；会话栏在右边，先往右；那一侧不够再用另一侧。
 *    不超出屏幕的可用区域。
 * 2. 仍然不够时，把编辑区压窄，最窄到 editorMin（本来就比 editorMin 窄时不再压）。
 * 3. 打开库侧栏时还不够，可以暂时收起会话栏。打开会话栏不改变库的显示状态。
 */
export function planPaneOpen(input: PaneOpenInput): PaneOpenPlan {
  const { window: before, workArea, panes, opening, editorMin } = input
  const other: OptionalPane = opening === 'library' ? 'session' : 'library'
  const paneWidth = Math.max(0, panes[opening].width)
  const otherWidth = panes[other].open ? Math.max(0, panes[other].width) : 0
  const restore = { restoreWidth: before.width, restoreX: before.x }

  if (panes[opening].open) {
    const editorWidth = Math.max(0, before.width - paneWidth - otherWidth)
    return { window: { ...before }, collapse: null, editorWidth, ...restore, grown: { left: 0, right: 0 } }
  }

  // 窗口已经有一部分在可用区域外时，那一侧没有空余，不能再往外长。
  const roomLeft = Math.max(0, before.x - workArea.x)
  const roomRight = Math.max(0, workArea.x + workArea.width - (before.x + before.width))
  const preferLeft = opening === 'library'
  const first = Math.min(paneWidth, preferLeft ? roomLeft : roomRight)
  const second = Math.min(paneWidth - first, preferLeft ? roomRight : roomLeft)
  const left = preferLeft ? first : second
  const right = preferLeft ? second : first
  const window = { x: before.x - left, width: before.width + left + right }

  const editorBefore = before.width - otherWidth
  let editorWidth = window.width - otherWidth - paneWidth
  let collapse: OptionalPane | null = null
  if (other === 'session' && editorWidth < Math.min(editorBefore, editorMin) && otherWidth > 0) {
    collapse = other
    editorWidth += otherWidth
  }
  return { window, collapse, editorWidth: Math.max(0, editorWidth), ...restore, grown: { left, right } }
}

export interface PaneCloseInput {
  /** 关闭时小窗的位置和宽度（用户可能在栏打开期间移动或缩放过）。 */
  window: HorizontalSpan
  /** 这块栏打开时 planPaneOpen 返回的 grown。 */
  grown: { left: number; right: number }
  /** 默认是小窗最小宽度 520。 */
  minWidth?: number
}

/**
 * 关闭可选栏后小窗的位置和宽度（需求 5.7 规则 4）。
 *
 * 不直接跳回 restoreX / restoreWidth，而是从当前位置收回打开时加宽的那部分：
 * 窗口没动过时结果和 restoreX / restoreWidth 完全相同；用户在栏打开期间拖动过窗口时，
 * 窗口留在用户拖到的地方；两块栏先后打开、以任意顺序关闭时，各自只收回自己加的宽度。
 * 用户把窗口缩得比加宽量还窄时，最多收到 minWidth。打开时被收起的另一侧栏不会自动重新打开。
 */
export function planPaneClose(input: PaneCloseInput): HorizontalSpan {
  const { window: current, grown } = input
  const minWidth = input.minWidth ?? MIN_WINDOW.width
  const allowed = Math.max(0, current.width - minWidth)
  const left = Math.min(Math.max(0, grown.left), allowed)
  const right = Math.min(Math.max(0, grown.right), allowed - left)
  return { x: current.x + left, width: current.width - left - right }
}

/** 默认长度连同两侧边距放不下时，取可用长度减去两侧边距，但不小于最小尺寸；屏幕比最小尺寸还小时铺满。 */
function fitLength(preferred: number, min: number, available: number): number {
  return Math.max(Math.min(preferred, available - 2 * WINDOW_MARGIN), Math.min(min, available))
}

/** 水平居中，垂直方向上方留出剩余高度的 40%。 */
function placeIn(workArea: Rect, width: number, height: number): Rect {
  return {
    x: workArea.x + Math.round((workArea.width - width) / 2),
    y: workArea.y + Math.round((workArea.height - height) * WINDOW_VERTICAL_RATIO),
    width,
    height,
  }
}

/**
 * 第一次显示时的位置和大小（需求 F-02）：980×600，屏幕放不下时取可用区域减去四周各 24 的边距，
 * 出现在鼠标所在屏幕上，水平居中，垂直方向居中略偏上。
 */
export function initialWindowBounds(cursorDisplayWorkArea: Rect): Rect {
  const width = fitLength(DEFAULT_WINDOW.width, MIN_WINDOW.width, cursorDisplayWorkArea.width)
  const height = fitLength(DEFAULT_WINDOW.height, MIN_WINDOW.height, cursorDisplayWorkArea.height)
  return placeIn(cursorDisplayWorkArea, width, height)
}

function overlap(a: Rect, b: Rect): { width: number; height: number } {
  return {
    width: Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)),
    height: Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)),
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

/**
 * 显示前把记下的位置挪回可见范围（需求 F-02 边界情况）。
 *
 * - 工具栏那条带和任何屏幕的可用区域都重叠不到 64×24（例如外接显示器拔掉了、窗口跑到了菜单栏底下）：
 *   移到 fallbackWorkArea（鼠标所在屏幕）的默认位置；原来的大小放得下就保留，放不下用默认大小。
 * - 还能拖到时位置不动；只有窗口比所在屏幕的可用区域还大时才缩到可用区域以内，
 *   并把这个方向上的位置挪进可用区域。尺寸不小于 520×360，屏幕比这还小时铺满可用区域。
 */
export function ensureVisible(bounds: Rect, displays: readonly { workArea: Rect }[], fallbackWorkArea: Rect): Rect {
  const strip: Rect = { x: bounds.x, y: bounds.y, width: bounds.width, height: TOOLBAR_STRIP.height }
  let target: Rect | null = null
  let bestArea = 0
  for (const { workArea } of displays) {
    const area = overlap(strip, workArea)
    if (area.width < TOOLBAR_STRIP.minVisibleWidth || area.height < TOOLBAR_STRIP.minVisibleHeight) continue
    if (area.width * area.height > bestArea) {
      target = workArea
      bestArea = area.width * area.height
    }
  }

  if (target === null) {
    const area = fallbackWorkArea
    // 记下的数字坏了（NaN 等）时比较都不成立，走默认大小。
    if (!(bounds.width <= area.width && bounds.height <= area.height)) return initialWindowBounds(area)
    const width = Math.max(bounds.width, Math.min(MIN_WINDOW.width, area.width))
    const height = Math.max(bounds.height, Math.min(MIN_WINDOW.height, area.height))
    return placeIn(area, width, height)
  }

  const width = clamp(bounds.width, Math.min(MIN_WINDOW.width, target.width), target.width)
  const height = clamp(bounds.height, Math.min(MIN_WINDOW.height, target.height), target.height)
  const x = width === bounds.width ? bounds.x : clamp(bounds.x, target.x, target.x + target.width - width)
  const y = height === bounds.height ? bounds.y : clamp(bounds.y, target.y, target.y + target.height - height)
  return { x, y, width, height }
}
