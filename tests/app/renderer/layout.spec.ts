import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest'
import type { AppController } from '../../../src/app/renderer/controller/app.ts'
import { clampPaneSizes } from '../../../src/app/renderer/controller/app.ts'
import { libraryWidth, minimumWindowWidth, sessionWidth } from '../../../src/app/renderer/controller/layout.ts'
import { FakeBridge, ok, round, session, startController, trapUnhandled } from './helpers.ts'

let checkUnhandled: () => void
const controllers: AppController[] = []

beforeEach(() => {
  checkUnhandled = trapUnhandled()
})

afterEach(() => {
  for (const controller of controllers.splice(0)) controller.dispose()
  checkUnhandled()
})

async function start(bridge: FakeBridge): Promise<AppController> {
  const controller = await startController(bridge)
  controllers.push(controller)
  return controller
}

function withSession(bridge: FakeBridge): FakeBridge {
  bridge.handle('optimize.state', () => ok({ session: session('s1', [round('r1', { status: 'done' })]) }))
  return bridge
}

describe('窗口最小宽度跟随打开的栏位（5.7，审查 COV-13）', () => {
  it('打开的栏位最小宽度之和，不小于 520', () => {
    expect(minimumWindowWidth(false, false)).toBe(520)
    // 编辑区 330 + 文件夹栏 130 + 列表栏 200 + 两条分隔线
    expect(minimumWindowWidth(true, false)).toBe(662)
    // 编辑区 330 + 会话栏 300 + 一条分隔线
    expect(minimumWindowWidth(false, true)).toBe(631)
    expect(minimumWindowWidth(true, true)).toBe(963)
  })

  it('启动和每次开合都把最小宽度告诉主进程', async () => {
    const bridge = withSession(new FakeBridge())
    const controller = await start(bridge)
    expect(bridge.window.setMinWidth).toHaveBeenLastCalledWith(520)
    await controller.layout.open('library')
    expect(bridge.window.setMinWidth).toHaveBeenLastCalledWith(662)
    await controller.layout.open('session')
    expect(bridge.window.setMinWidth).toHaveBeenLastCalledWith(963)
    await controller.layout.close('library')
    expect(bridge.window.setMinWidth).toHaveBeenLastCalledWith(631)
    await controller.layout.close('session')
    expect(bridge.window.setMinWidth).toHaveBeenLastCalledWith(520)
  })

  it('偏好里的栏宽被手改过时收紧到需求 5.7 的范围', () => {
    expect(clampPaneSizes({ folderWidth: 10, listWidth: 50, previewHeight: 5, sessionWidth: 9999 }))
      .toEqual({ folderWidth: 130, listWidth: 200, previewHeight: 128, sessionWidth: 560 })
    expect(clampPaneSizes({ folderWidth: Number.NaN, listWidth: 300, previewHeight: 232, sessionWidth: 420 }).folderWidth).toBe(130)
  })

  it('栏宽包含分隔线', () => {
    const panes = { folderWidth: 150, listWidth: 300, previewHeight: 232, sessionWidth: 420 }
    expect(libraryWidth(panes)).toBe(452)
    expect(sessionWidth(panes)).toBe(421)
  })
})

describe('打开和关闭可选栏时的窗口宽度（5.7 规则 1–4）', () => {
  it('库侧栏先向左加宽，关闭后回到打开之前的位置和宽度', async () => {
    const bridge = new FakeBridge()
    bridge.bounds = { x: 600, y: 100, width: 980, height: 600, workArea: { x: 0, y: 0, width: 1920, height: 1080 } }
    const controller = await start(bridge)
    await controller.layout.open('library')
    expect(bridge.window.setWidth).toHaveBeenLastCalledWith(980 + 452, 'right')
    expect(bridge.bounds).toMatchObject({ x: 600 - 452, width: 1432 })
    await controller.layout.close('library')
    expect(bridge.bounds).toMatchObject({ x: 600, width: 980 })
  })

  it('会话栏先向右加宽；右边不够时由主进程挤回屏幕内，等于再向左借', async () => {
    const bridge = withSession(new FakeBridge())
    bridge.bounds = { x: 800, y: 0, width: 980, height: 600, workArea: { x: 0, y: 0, width: 1920, height: 1080 } }
    const controller = await start(bridge)
    await controller.layout.open('session')
    expect(bridge.window.setWidth).toHaveBeenLastCalledWith(980 + 421, 'left')
    // 右边只剩 140：窗口被推回可用区域，向左借了 281。
    expect(bridge.bounds).toMatchObject({ x: 519, width: 1401 })
    await controller.layout.close('session')
    expect(bridge.bounds).toMatchObject({ x: 800, width: 980 })
  })

  it('屏幕放不下时压编辑区，还不够就暂时收起另一侧的栏；收起的会话内容不丢', async () => {
    const bridge = withSession(new FakeBridge())
    bridge.bounds = { x: 0, y: 0, width: 1000, height: 600, workArea: { x: 0, y: 0, width: 1000, height: 800 } }
    const controller = await start(bridge)
    await controller.layout.open('session')
    expect(controller.store.getState().optimize.paneOpen).toBe(true)
    await controller.layout.open('library')
    const state = controller.store.getState()
    expect(state.library.open).toBe(true)
    expect(state.optimize.paneOpen).toBe(false)
    expect(state.optimize.session?.id).toBe('s1')
    expect(bridge.window.setMinWidth).toHaveBeenLastCalledWith(662)
  })

  it('已经打开的栏再打开不动窗口', async () => {
    const bridge = new FakeBridge()
    const controller = await start(bridge)
    await controller.layout.open('library')
    const calls = bridge.window.setWidth.mock.calls.length
    await controller.layout.open('library')
    expect(bridge.window.setWidth.mock.calls.length).toBe(calls)
  })

  it('连续点击按顺序执行，不会两次都基于同一个旧位置计算', async () => {
    const bridge = new FakeBridge()
    const controller = await start(bridge)
    const first = controller.layout.toggle('library')
    const second = controller.layout.toggle('library')
    await Promise.all([first, second])
    expect(controller.store.getState().library.open).toBe(true)
    await controller.layout.toggle('library')
    expect(bridge.bounds).toMatchObject({ x: 400, width: 980 })
  })

  it('问不到窗口位置时也照常打开，由编辑区让出空间', async () => {
    const bridge = new FakeBridge()
    const controller = await start(bridge)
    bridge.window.getBounds.mockRejectedValueOnce(new Error('window not ready'))
    const errors = vi.fn()
    await controller.layout.open('library').catch(errors)
    expect(errors).toHaveBeenCalledTimes(1)
    expect(controller.store.getState().library.open).toBe(true)
    // 一次失败不卡住后面的开合。
    await controller.layout.close('library')
    expect(controller.store.getState().library.open).toBe(false)
  })
})
