// 库侧栏和会话栏的开合与窗口宽度（需求 5.7、F-02，技术方案 5.4、5.5，审查 COV-13）。
// 计算交给 shared/layout.ts 的纯函数，这里只负责问主进程要窗口位置、请它加宽或收回，以及更新窗口的最小宽度。

import { MIN_WINDOW, PANE_LIMITS, planPaneClose, planPaneOpen, type OptionalPane } from '../../../shared/layout.ts'
import type { WindowBounds } from '../../../shared/bridge.ts'
import type { AppState, PaneSizes } from '../state/state.ts'
import type { Context } from './context.ts'

type Grown = { left: number; right: number }

const NO_GROWTH: Grown = { left: 0, right: 0 }

/** 分隔线的宽度（app.css 的 .px-divider-vertical）。库侧栏带两条（文件夹栏|列表栏、列表栏|编辑区），会话栏带一条。 */
export const DIVIDER_WIDTH = 1

/** 库侧栏打开时占的总宽度：文件夹栏 + 列表栏 + 两条分隔线。 */
export function libraryWidth(panes: PaneSizes): number {
  return panes.folderWidth + panes.listWidth + 2 * DIVIDER_WIDTH
}

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
  /** 每块栏打开时让窗口向左、向右各加宽了多少；关闭时只收回自己加的那部分（规则 4）。 */
  private readonly grown: Record<OptionalPane, Grown> = { library: NO_GROWTH, session: NO_GROWTH }
  /** 开合要先问主进程窗口位置，连续点击时按顺序一个个做，避免两次计算用到同一个旧位置。 */
  private queue: Promise<void> = Promise.resolve()

  constructor(private readonly ctx: Context) {}

  /** 打开一块栏（规则 1–3）。收起另一侧的栏时只改界面，它占的宽度留给编辑区和新打开的栏。 */
  open(pane: OptionalPane): Promise<void> {
    return this.enqueue(async () => {
      if (isPaneOpen(this.ctx.store.getState(), pane)) return
      try {
        this.grown[pane] = await this.makeRoom(pane)
      } finally {
        // 调整窗口失败（主进程没回应）也照常打开，栏宽不够时由编辑区让出空间。
        this.setOpen(pane, true)
        this.syncMinWidth()
      }
    })
  }

  /** 关闭一块栏：先降低最小宽度，再收回它打开时加的宽度（规则 4）。 */
  close(pane: OptionalPane): Promise<void> {
    return this.enqueue(async () => {
      if (!isPaneOpen(this.ctx.store.getState(), pane)) return
      this.setOpen(pane, false)
      this.syncMinWidth()
      const grown = this.grown[pane]
      this.grown[pane] = NO_GROWTH
      if (grown.left === 0 && grown.right === 0) return
      const bounds = await this.ctx.bridge.window.getBounds()
      const target = planPaneClose({ window: { x: bounds.x, width: bounds.width }, grown })
      // 主进程的接口一次只能固定一条边：先固定右边沿收回左边加宽的部分，再固定左边沿收回右边的。
      let current = bounds
      if (target.x !== current.x) current = await this.ctx.bridge.window.setWidth(current.x + current.width - target.x, 'right')
      if (target.width !== current.width) await this.ctx.bridge.window.setWidth(target.width, 'left')
    })
  }

  toggle(pane: OptionalPane): Promise<void> {
    return isPaneOpen(this.ctx.store.getState(), pane) ? this.close(pane) : this.open(pane)
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

  /** 按规则 1–3 加宽窗口或收起另一侧的栏，返回窗口实际向两侧加宽了多少。 */
  private async makeRoom(pane: OptionalPane): Promise<Grown> {
    const bounds = await this.ctx.bridge.window.getBounds()
    const state = this.ctx.store.getState()
    const plan = planPaneOpen({
      window: { x: bounds.x, width: bounds.width },
      workArea: { x: bounds.workArea.x, width: bounds.workArea.width },
      panes: {
        library: { open: state.library.open, width: libraryWidth(state.panes) },
        session: { open: state.optimize.paneOpen, width: sessionWidth(state.panes) },
      },
      opening: pane,
      editorMin: PANE_LIMITS.editor.min,
    })
    if (plan.collapse !== null) {
      // 收起的栏只改界面，它占的宽度留给编辑区和新打开的栏，所以它当初加宽的部分不再由它收回。
      this.grown[plan.collapse] = NO_GROWTH
      this.setOpen(plan.collapse, false)
    }
    if (plan.window.width === bounds.width && plan.window.x === bounds.x) return NO_GROWTH
    // 库侧栏在左边，固定右边沿向左长；会话栏在右边，固定左边沿向右长。这一侧没空间时主进程把窗口推回屏幕内，
    // 结果和 planPaneOpen「先向这一侧、不够再向另一侧」一致。
    const after = await this.ctx.bridge.window.setWidth(plan.window.width, pane === 'library' ? 'right' : 'left')
    return growthBetween(bounds, after)
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

  private enqueue(task: () => Promise<void>): Promise<void> {
    const run = this.queue.then(task)
    // 一次失败不能卡住后面的开合；失败本身由调用方的 runTask 记录。
    this.queue = run.catch(() => undefined)
    return run
  }
}

function growthBetween(before: WindowBounds, after: WindowBounds): Grown {
  return {
    left: Math.max(0, before.x - after.x),
    right: Math.max(0, after.x + after.width - (before.x + before.width)),
  }
}
