import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WindowController, type ControlledApp, type ControlledWindow, type WorkspaceOptions } from '../../../src/app/main/window-controller.ts'
import { MemoryLogger, trapProcessErrors } from './helpers.ts'

trapProcessErrors()

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

/**
 * 假窗口：记录调用顺序。show() 在窗口原本隐藏时同步发 show 事件（Electron 的行为），
 * emitShow 为 false 时模拟 show 事件迟迟不来。
 */
class FakeWindow implements ControlledWindow {
  visible = false
  focused = false
  emitShow = true
  readonly calls: string[] = []
  #showListeners: (() => void)[] = []

  isVisible(): boolean {
    return this.visible
  }

  isFocused(): boolean {
    return this.focused
  }

  show(): void {
    this.calls.push('win.show')
    const wasVisible = this.visible
    this.visible = true
    if (!wasVisible && this.emitShow) this.fireShow()
  }

  hide(): void {
    this.calls.push('win.hide')
    this.visible = false
    this.focused = false
  }

  focus(): void {
    this.calls.push('win.focus')
    if (this.visible) this.focused = true
  }

  setVisibleOnAllWorkspaces(visible: boolean, options: WorkspaceOptions): void {
    this.calls.push(`workspaces(${visible}, visibleOnFullScreen=${options.visibleOnFullScreen}, skip=${options.skipTransformProcessType})`)
  }

  onceShow(listener: () => void): void {
    this.#showListeners.push(listener)
  }

  fireShow(): void {
    const listeners = this.#showListeners
    this.#showListeners = []
    for (const listener of listeners) listener()
  }
}

interface Setup {
  controller: WindowController
  win: FakeWindow
  calls: string[]
  shown: string[]
  hidden: string[]
  logger: MemoryLogger
  clock: { now: number }
}

function setup(platform = 'darwin', options: { beforeShow?: () => void } = {}): Setup {
  const win = new FakeWindow()
  const calls = win.calls
  const app: ControlledApp = {
    show: () => calls.push('app.show'),
    hide: () => calls.push('app.hide'),
    focusSteal: () => calls.push('app.focus(steal)'),
  }
  const shown: string[] = []
  const hidden: string[] = []
  const logger = new MemoryLogger()
  const clock = { now: 10_000 }
  const controller = new WindowController({
    platform,
    window: win,
    app,
    beforeShow: options.beforeShow ?? (() => calls.push('place')),
    onShown: reason => shown.push(reason),
    onHidden: reason => hidden.push(reason),
    logger,
    now: () => clock.now,
  })
  return { controller, win, calls, shown, hidden, logger, clock }
}

const ALL_SPACES = 'workspaces(true, visibleOnFullScreen=true, skip=true)'
const THIS_SPACE = 'workspaces(false, visibleOnFullScreen=true, skip=true)'

describe('WindowController on macOS (design-spec 5.4, D10, TC-03)', () => {
  it('shows with the exact sequence and keeps visibleOnFullScreen on both workspace calls', () => {
    const { controller, calls, shown } = setup()
    controller.show('shortcut')
    expect(calls).toEqual(['place', ALL_SPACES, 'app.show', 'win.show', 'win.focus', 'app.focus(steal)'])
    expect(shown).toEqual(['shortcut'])
    // show 事件之后约 50 ms 才把「所有空间可见」关掉，第二次调用同样带 visibleOnFullScreen: true。
    vi.advanceTimersByTime(49)
    expect(calls).not.toContain(THIS_SPACE)
    vi.advanceTimersByTime(1)
    expect(calls.at(-1)).toBe(THIS_SPACE)
    expect(calls.filter(call => call.startsWith('workspaces')).every(call => call.includes('visibleOnFullScreen=true'))).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('waits for the show event before the 50 ms countdown', () => {
    const { controller, win, calls } = setup()
    win.emitShow = false
    controller.show('shortcut')
    vi.advanceTimersByTime(500)
    expect(calls).not.toContain(THIS_SPACE)
    win.fireShow()
    vi.advanceTimersByTime(50)
    expect(calls.filter(call => call === THIS_SPACE)).toHaveLength(1)
    vi.advanceTimersByTime(2000)
    expect(calls.filter(call => call === THIS_SPACE)).toHaveLength(1)
  })

  it('still leaves all spaces when the show event never comes', () => {
    const { controller, win, calls } = setup()
    win.emitShow = false
    controller.show('shortcut')
    vi.advanceTimersByTime(1000 + 50)
    expect(calls.filter(call => call === THIS_SPACE)).toHaveLength(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('hides the window and then the app so the previous app gets focus back', () => {
    const { controller, calls, hidden } = setup()
    controller.show('shortcut')
    vi.advanceTimersByTime(100)
    calls.length = 0
    controller.hide('copy')
    expect(calls).toEqual(['win.hide', 'app.hide'])
    expect(hidden).toEqual(['copy'])
  })

  it('leaves all spaces at once when hidden within the 50 ms (fast copy-and-hide)', () => {
    const { controller, calls } = setup()
    controller.show('shortcut')
    vi.advanceTimersByTime(20)
    calls.length = 0
    controller.hide('copy')
    expect(calls).toEqual(['win.hide', THIS_SPACE, 'app.hide'])
    vi.advanceTimersByTime(2000)
    expect(calls.filter(call => call === THIS_SPACE)).toHaveLength(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does nothing when hiding a hidden window', () => {
    const { controller, calls, hidden } = setup()
    controller.hide('esc')
    expect(calls).toEqual([])
    expect(hidden).toEqual([])
  })

  it('brings a visible but unfocused window to the current space without moving it', () => {
    const { controller, win, calls, shown } = setup()
    controller.show('shortcut')
    vi.advanceTimersByTime(100)
    win.focused = false
    calls.length = 0
    expect(controller.toggle('shortcut')).toBe('focused')
    // 已经可见：不重新摆放位置，也不会再收到 show 事件，直接排上第二次 workspace 调用。
    expect(calls).toEqual([ALL_SPACES, 'app.show', 'win.show', 'win.focus', 'app.focus(steal)'])
    vi.advanceTimersByTime(50)
    expect(calls.at(-1)).toBe(THIS_SPACE)
    expect(shown).toEqual(['shortcut', 'shortcut'])
  })

  it('ignores a show event left over from an earlier sequence', () => {
    const { controller, win, calls } = setup()
    win.emitShow = false
    controller.show('first')
    // 隐藏时补上第一次显示还没做的那一步。
    controller.hide('esc')
    expect(calls.filter(call => call === THIS_SPACE)).toHaveLength(1)
    win.emitShow = true
    controller.show('second')
    vi.advanceTimersByTime(50)
    // 第一次显示留下的监听在第二次 show 时也被触发，但它的代号已经过期，第二次显示只排了一次。
    expect(calls.filter(call => call === THIS_SPACE)).toHaveLength(2)
    vi.advanceTimersByTime(2000)
    expect(calls.filter(call => call === THIS_SPACE)).toHaveLength(2)
  })
})

describe('WindowController toggle (F-01)', () => {
  it('shows when hidden, hides when visible and focused, focuses when visible but unfocused', () => {
    const { controller, win } = setup()
    expect(controller.toggle('shortcut')).toBe('shown')
    expect(win.visible && win.focused).toBe(true)
    expect(controller.toggle('shortcut')).toBe('hidden')
    expect(win.visible).toBe(false)
    controller.toggle('shortcut')
    win.focused = false
    expect(controller.toggle('shortcut')).toBe('focused')
    expect(win.visible && win.focused).toBe(true)
  })

  it('exposes the visible and focused state of the window', () => {
    const { controller, win } = setup()
    expect([controller.visible, controller.focused]).toEqual([false, false])
    win.visible = true
    win.focused = true
    expect([controller.visible, controller.focused]).toEqual([true, true])
  })
})

describe('WindowController on Windows and Linux', () => {
  for (const platform of ['win32', 'linux']) {
    it(`only shows, focuses and hides the window on ${platform}`, () => {
      const { controller, calls } = setup(platform)
      controller.show('tray')
      expect(calls).toEqual(['place', 'win.show', 'win.focus'])
      controller.hide('tray')
      expect(calls).toEqual(['place', 'win.show', 'win.focus', 'win.hide'])
      expect(vi.getTimerCount()).toBe(0)
    })
  }
})

describe('WindowController placement', () => {
  it('places the window only when it goes from hidden to visible', () => {
    const { controller, win, calls } = setup('win32')
    controller.show('a')
    win.focused = false
    controller.show('b')
    expect(calls.filter(call => call === 'place')).toHaveLength(1)
  })

  it('still shows the window when placing it throws', () => {
    const { controller, win, logger } = setup('win32', {
      beforeShow: () => {
        throw new RangeError('no display')
      },
    })
    controller.show('shortcut')
    expect(win.visible).toBe(true)
    expect(logger.find('window.place-failed')?.fields).toEqual({ error: 'RangeError' })
  })
})

describe('WindowController hide on blur (Q20)', () => {
  function shownWithHideOnBlur(): Setup {
    const context = setup()
    context.controller.setHideOnBlur(true)
    context.controller.show('shortcut')
    vi.advanceTimersByTime(100)
    return context
  }

  it('hides shortly after the window loses focus', () => {
    const { controller, win, hidden } = shownWithHideOnBlur()
    win.focused = false
    controller.handleBlur()
    vi.advanceTimersByTime(99)
    expect(hidden).toEqual([])
    vi.advanceTimersByTime(1)
    expect(hidden).toEqual(['blur'])
  })

  it('does not hide when the option is off (default)', () => {
    const { controller, win, hidden } = setup()
    controller.show('shortcut')
    win.focused = false
    controller.handleBlur()
    vi.advanceTimersByTime(1000)
    expect(hidden).toEqual([])
  })

  it('does not hide while a dialog is open', () => {
    const { controller, win, hidden } = shownWithHideOnBlur()
    controller.setModalOpen(true)
    win.focused = false
    controller.handleBlur()
    vi.advanceTimersByTime(1000)
    expect(hidden).toEqual([])
    controller.setModalOpen(false)
    controller.handleBlur()
    vi.advanceTimersByTime(100)
    expect(hidden).toEqual(['blur'])
  })

  it('does not hide within 500 ms of a move or resize (dragging also blurs)', () => {
    const { controller, win, hidden, clock } = shownWithHideOnBlur()
    controller.noteMoveOrResize()
    win.focused = false
    clock.now += 400
    controller.handleBlur()
    vi.advanceTimersByTime(100)
    expect(hidden).toEqual([])
    clock.now += 500
    controller.handleBlur()
    vi.advanceTimersByTime(100)
    expect(hidden).toEqual(['blur'])
  })

  it('does not hide when focus came back before the check', () => {
    const { controller, win, hidden } = shownWithHideOnBlur()
    win.focused = false
    controller.handleBlur()
    win.focused = true
    controller.handleFocus()
    vi.advanceTimersByTime(1000)
    expect(hidden).toEqual([])
  })

  it('cancels a pending check when the option is turned off', () => {
    const { controller, win, hidden } = shownWithHideOnBlur()
    win.focused = false
    controller.handleBlur()
    controller.setHideOnBlur(false)
    vi.advanceTimersByTime(1000)
    expect(hidden).toEqual([])
  })
})

describe('WindowController dispose', () => {
  it('cancels every timer and ignores later calls', () => {
    const { controller, win, calls } = setup()
    controller.setHideOnBlur(true)
    controller.show('shortcut')
    win.focused = false
    controller.handleBlur()
    controller.dispose()
    expect(vi.getTimerCount()).toBe(0)
    calls.length = 0
    controller.show('late')
    controller.hide('late')
    expect(calls).toEqual([])
  })
})
