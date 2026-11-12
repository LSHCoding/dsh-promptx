// 库侧栏和会话栏的开合与窗口宽度（需求 5.7、F-02，技术方案 5.4、5.5，审查 COV-13）。
// 用编辑区实际宽度切换库侧栏；会话栏继续用 shared/layout.ts 的空间分配。

import { DIVIDER_WIDTH, libraryWidth, MIN_WINDOW, PANE_LIMITS, planPaneClose, planPaneOpen, type OptionalPane } from '../../../shared/layout.ts'
import type { WindowBounds } from '../../../shared/bridge.ts'
import type { AppState, PaneSizes } from '../state/state.ts'
import type { Context } from './context.ts'

type Grown = { left: number; right: number }

const NO_GROWTH: Grown = { left: 0, right: 0 }

/** 会话栏打开时占的总宽度：会话栏 + 一条分隔线。 */
export function sessionWidth(panes: PaneSizes): number {
  return panes.sessionWidth + DIVIDER_WIDTH
}

/**
 * 打开的栏位最小宽度之和（编辑区 330、文件夹栏 130 + 列表栏 200、会话栏 300，加上分隔线），不小于小窗的最小宽度 520。
 * 主进程再按屏幕可用区域收紧（审查 COV-13）：栏位都打开时用户也不能把编辑区和底栏挤坏（E-03）。
 */
export function minimumWindowWidth(libraryOpen: boolean, sessionOpen: boolean): number {
  let sum = PANE_LIMITS.editor.min
  if (libraryOpen) sum += PANE_LIMITS.folder.min + PANE_LIMITS.list.min + 2 * DIVIDER_WIDTH
  if (sessionOpen) sum += PANE_LIMITS.session.min + DIVIDER_WIDTH
  return Math.max(MIN_WINDOW.width, sum)
}

export function isPaneOpen(state: AppState, pane: OptionalPane): boolean {
  return pane === 'library' ? state.library.open : state.optimize.paneOpen
}

export class PaneLayout {
  /** 会话栏关闭时收回它打开时加的宽度。库侧栏关闭时用编辑区当前宽度计算。 */
  private sessionGrowth = NO_GROWTH
  /** 靠近屏幕左边时，展开库会借用右边的空间，收起时先归还这部分。 */
  private libraryGrowthRight = 0
  private editorElement: Pick<HTMLElement, 'offsetWidth'> | null = null
  private savedEditorWidth: number | null = null
  /** 保留切换前的编辑区宽度，供连续切换和窗口受限时恢复。手动调整窗口或栏宽后改用实际宽度。 */
  private libraryEditor: { width: number; windowWidth: number; panes: PaneSizes; sessionOpen: boolean } | null = null
  /** 开合要先问主进程窗口位置，连续点击时按顺序一个个做，避免两次计算用到同一个旧位置。 */
  private queue: Promise<void> = Promise.resolve()

  constructor(private readonly ctx: Context) {}

  setEditorElement(element: Pick<HTMLElement, 'offsetWidth'> | null): void {
    this.editorElement = element
  }

  /** 聊天栏展开时记录真正的编辑区宽度，包括屏幕受限时的收缩和手动调节。 */
  persistEditorWidth(): void {
    const sessionOpen = this.ctx.store.getState().optimize.paneOpen
    const editorWidth = sessionOpen ? this.editorElement?.offsetWidth : null
    if (editorWidth === undefined || editorWidth === 0 || editorWidth === this.savedEditorWidth) return
    this.savedEditorWidth = editorWidth
    this.ctx.bridge.prefs.set({ editorWidth })
  }

  open(pane: OptionalPane): Promise<void> {
    return this.enqueue(() => this.openPane(pane))
  }

  close(pane: OptionalPane): Promise<void> {
    return this.enqueue(() => this.closePane(pane))
  }

  toggleLibrary(onClose: () => void): Promise<boolean> {
    return this.enqueue(async () => {
      if (this.ctx.store.getState().library.open) {
        onClose()
        await this.closePane('library')
        return false
      }
      await this.openPane('library')
      return true
    })
  }

  toggleSession(): Promise<void> {
    return this.enqueue(() => (this.ctx.store.getState().optimize.paneOpen ? this.closePane('session') : this.openPane('session')))
  }

  /** 启动时按偏好直接显示库侧栏：窗口大小是上次关窗时记下的，已经包含侧栏，不再加宽。 */
  restoreOpen(pane: OptionalPane): void {
    this.setOpen(pane, true)
    this.syncMinWidth()
  }

  /** 窗口最小宽度跟随打开的栏位（审查 COV-13），主进程再按屏幕可用区域收紧。 */
  syncMinWidth(): void {
    const state = this.ctx.store.getState()
    this.ctx.bridge.window.setMinWidth(minimumWindowWidth(state.library.open, state.optimize.paneOpen))
  }

  /** 等排队的开合都做完（测试和需要先等布局的操作用）。 */
  settled(): Promise<void> {
    return this.queue
  }

  private async openPane(pane: OptionalPane): Promise<void> {
    if (isPaneOpen(this.ctx.store.getState(), pane)) return
    if (pane === 'library') return this.resizeLibrary(true)
    try {
      const bounds = await this.ctx.bridge.window.getBounds()
      const plan = this.planOpen(bounds, this.ctx.store.getState(), pane)
      if (plan.window.width !== bounds.width) {
        const after = await this.ctx.bridge.window.setWidth(plan.window.width, 'left')
        this.sessionGrowth = growthBetween(bounds, after)
      }
    } finally {
      // 调整窗口失败也照常打开，栏宽不足时由布局分配现有空间。
      this.setOpen(pane, true)
      this.syncMinWidth()
    }
  }

  private async closePane(pane: OptionalPane): Promise<void> {
    if (!isPaneOpen(this.ctx.store.getState(), pane)) return
    if (pane === 'library') return this.resizeLibrary(false)
    this.setOpen(pane, false)
    this.syncMinWidth()
    const grown = this.sessionGrowth
    this.sessionGrowth = NO_GROWTH
    if (grown.left === 0 && grown.right === 0) return
    const bounds = await this.ctx.bridge.window.getBounds()
    const target = planPaneClose({ window: { x: bounds.x, width: bounds.width }, grown })
    // 先固定右边沿收回左边加宽的部分，再固定左边沿收回右边的。
    let current = bounds
    if (target.x !== current.x) current = await this.ctx.bridge.window.setWidth(current.x + current.width - target.x, 'right')
    if (target.width !== current.width) await this.ctx.bridge.window.setWidth(target.width, 'left')
  }

  private async resizeLibrary(open: boolean): Promise<void> {
    try {
      const bounds = await this.ctx.bridge.window.getBounds()
      const state = this.ctx.store.getState()
      const { panes } = state
      let sessionOpen = state.optimize.paneOpen
      const editor = this.libraryToggleEditorWidth(bounds, state)
      if (open && this.planOpen(bounds, state, 'library').collapse === 'session') {
        this.sessionGrowth = NO_GROWTH
        this.setOpen('session', false)
        sessionOpen = false
        this.syncMinWidth()
      }
      if (!open) {
        // 收窄前先降低原生窗口的最小宽度。
        this.setOpen('library', false)
        this.syncMinWidth()
      }
      const wanted = editor + (open ? libraryWidth(panes) : 0) + (sessionOpen ? sessionWidth(panes) : 0)
      const width = Math.min(bounds.workArea.width, Math.max(minimumWindowWidth(open, sessionOpen), wanted))
      const shrinkRight = open ? 0 : Math.min(this.libraryGrowthRight, Math.max(0, bounds.width - width))
      let after = bounds
      if (width + shrinkRight !== bounds.width) after = await this.ctx.bridge.window.setWidth(width + shrinkRight, 'right')
      if (shrinkRight > 0) after = await this.ctx.bridge.window.setWidth(width, 'left')
      this.libraryGrowthRight = open ? growthBetween(bounds, after).right : 0
      this.libraryEditor = { width: editor, windowWidth: after.width, panes, sessionOpen }
    } finally {
      if (this.ctx.store.getState().library.open !== open) {
        this.setOpen('library', open)
        this.syncMinWidth()
      }
    }
  }

  private libraryToggleEditorWidth(bounds: WindowBounds, state: AppState): number {
    const previous = this.libraryEditor
    if (previous?.windowWidth === bounds.width && previous.panes === state.panes && previous.sessionOpen === state.optimize.paneOpen) {
      return previous.width
    }
    const measured = this.editorElement?.offsetWidth ?? 0
    // 原生窗口改宽后，Chromium 的视口有时仍是旧尺寸。
    if (measured > 0 && (typeof window === 'undefined' || Math.abs(window.innerWidth - bounds.width) <= 1)) return measured
    const library = state.library.open ? libraryWidth(state.panes) : 0
    const session = state.optimize.paneOpen ? sessionWidth(state.panes) : 0
    return Math.max(PANE_LIMITS.editor.min, bounds.width - library - session)
  }

  private planOpen(bounds: WindowBounds, state: AppState, pane: OptionalPane) {
    return planPaneOpen({
      window: { x: bounds.x, width: bounds.width },
      workArea: { x: bounds.workArea.x, width: bounds.workArea.width },
      panes: {
        library: { open: state.library.open, width: libraryWidth(state.panes) },
        session: { open: state.optimize.paneOpen, width: sessionWidth(state.panes) },
      },
      opening: pane,
      editorMin: PANE_LIMITS.editor.min,
    })
  }

  private setOpen(pane: OptionalPane, open: boolean): void {
    this.ctx.store.update((state) => {
      if (isPaneOpen(state, pane) === open) return state
      return pane === 'library'
        ? { ...state, library: { ...state.library, open } }
        : { ...state, optimize: { ...state.optimize, paneOpen: open } }
    })
    if (pane === 'library') {
      const panes = this.ctx.store.getState().panes
      this.ctx.bridge.prefs.set({ panes: { library: open, ...panes } })
    }
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task)
    // 一次失败不能卡住后面的开合；失败本身由调用方的 runTask 记录。
    this.queue = run.then(() => undefined, () => undefined)
    return run
  }
}

function growthBetween(before: WindowBounds, after: WindowBounds): Grown {
  return {
    left: Math.max(0, before.x - after.x),
    right: Math.max(0, after.x + after.width - (before.x + before.width)),
  }
}
