// @vitest-environment jsdom
import { afterEach, beforeEach, describe, it, expect } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { OptimizeRound, OptimizeSession } from '../../../src/shared/types.ts'
import type { AppController } from '../../../src/app/renderer/controller/app.ts'
import { SessionPane, STICK_TO_BOTTOM_PX } from '../../../src/app/renderer/components/SessionPane.tsx'
import { ControllerContext } from '../../../src/app/renderer/components/hooks.ts'
import { FakeBridge, ok, round, session, settle, startController, trapUnhandled } from './helpers.ts'

let checkUnhandled: () => void
const controllers: AppController[] = []

beforeEach(() => {
  checkUnhandled = trapUnhandled()
})

afterEach(() => {
  cleanup()
  for (const controller of controllers.splice(0)) controller.dispose()
  checkUnhandled()
})

async function mount(initial: OptimizeSession): Promise<{ bridge: FakeBridge; controller: AppController; container: HTMLElement }> {
  const bridge = new FakeBridge()
  bridge.handle('optimize.state', () => ok({ session: initial }))
  const controller = await startController(bridge)
  controllers.push(controller)
  const { container } = render(
    <ControllerContext.Provider value={controller}>
      <SessionPane />
    </ControllerContext.Provider>,
  )
  return { bridge, controller, container }
}

/** jsdom 不排版：给消息区装上可控的滚动尺寸，记下组件写进去的 scrollTop。 */
function scrollModel(element: HTMLElement, clientHeight: number) {
  const model = { scrollHeight: 0, scrollTop: 0 }
  Object.defineProperty(element, 'clientHeight', { configurable: true, get: () => clientHeight })
  Object.defineProperty(element, 'scrollHeight', { configurable: true, get: () => model.scrollHeight })
  Object.defineProperty(element, 'scrollTop', {
    configurable: true,
    get: () => model.scrollTop,
    set: (value: number) => {
      model.scrollTop = value
    },
  })
  return model
}

function delta(bridge: FakeBridge, current: OptimizeSession, text: string): void {
  const active = current.rounds.at(-1) as OptimizeRound
  act(() => {
    bridge.emit('optimize.event', { type: 'delta', sessionId: current.id, roundId: active.id, text })
  })
}

describe('会话栏的滚动（O-02）', () => {
  it('用户没有往上翻时，新内容到来自动滚到底；往上翻了就不强行拉到底；翻回底部后恢复跟随', async () => {
    const current = session('s1', [round('r1', { input: '草稿' })])
    const { bridge, container } = await mount(current)
    const messages = container.querySelector<HTMLElement>('.px-session-messages')
    if (messages === null) throw new Error('no message list')
    const model = scrollModel(messages, 100)

    model.scrollHeight = 500
    delta(bridge, current, '第一段')
    expect(model.scrollTop).toBe(500)

    // 用户往上翻看早先的消息。
    model.scrollTop = 120
    fireEvent.scroll(messages)
    model.scrollHeight = 800
    delta(bridge, current, '第二段')
    expect(model.scrollTop).toBe(120)

    // 翻回底部附近（在 24 像素以内）后，新内容又跟着滚到底。
    model.scrollTop = 800 - 100 - STICK_TO_BOTTOM_PX
    fireEvent.scroll(messages)
    model.scrollHeight = 900
    delta(bridge, current, '第三段')
    expect(model.scrollTop).toBe(900)
  })

  it('标题「优化会话」，旁边是模型名称和「清空会话」', async () => {
    await mount(session('s1', [round('r1')], 'DeepSeek-V4'))
    expect(screen.getByText('优化会话')).toBeTruthy()
    expect(screen.getAllByText('DeepSeek-V4').length).toBeGreaterThanOrEqual(1)
    expect(screen.getByRole('button', { name: '清空会话' })).toBeTruthy()
  })
})

describe('气泡与候选按钮（O-03、O-04、O-06）', () => {
  it('用户消息标「你」，回复标模型名称；有候选时「应用」「复制」「⋯」，⋯ 里是「复制整段回复」', async () => {
    const { bridge, controller } = await mount(session('s1', [round('r1', { input: '我的草稿', status: 'done', reply: '说明', candidate: '改写稿' })]))
    expect(screen.getByText('你')).toBeTruthy()
    expect(screen.getByText('我的草稿')).toBeTruthy()
    expect(screen.getByRole('button', { name: '应用' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '复制' }))
    await act(async () => {
      await settle()
    })
    expect(bridge.window.copyText).toHaveBeenCalledWith('改写稿')
    fireEvent.click(screen.getByRole('button', { name: '更多' }))
    expect(controller.store.getState().menu?.id).toBe('reply:r1')
    fireEvent.click(screen.getByRole('menuitem', { name: '复制整段回复' }))
    await act(async () => {
      await settle()
    })
    expect(bridge.window.copyText).toHaveBeenLastCalledWith('说明')
  })

  it('提取不到候选时只有「复制回复」', async () => {
    await mount(session('s1', [round('r1', { status: 'done', reply: '只有说明', candidate: null })]))
    expect(screen.getByRole('button', { name: '复制回复' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: '应用' })).toBeNull()
  })

  it('失败的一轮标为失败并提供「重试」；取消的一轮同样可以重试', async () => {
    const { bridge } = await mount(session('s1', [
      round('r1', { status: 'failed', error: { code: 'promptx/optimize/network' } }),
      round('r2', { kind: 'followup', input: '再改', status: 'cancelled' }),
    ]))
    expect(screen.getByText('这一轮失败：网络不通，连不上模型服务')).toBeTruthy()
    expect(screen.getByText('这一轮已取消')).toBeTruthy()
    bridge.handle('optimize.retry', () => ok({ session: session('s1', [round('r3')]) }))
    fireEvent.click(screen.getAllByRole('button', { name: '重试' })[0] as HTMLElement)
    await act(async () => {
      await settle()
    })
    expect(bridge.callsTo('optimize.retry')).toEqual([{ roundId: 'r1' }])
  })
})

describe('追加输入框（O-05）', () => {
  async function box(running: boolean) {
    const current = session('s1', [round('r1', { status: running ? 'running' : 'done', candidate: 'x' })])
    const mounted = await mount(current)
    mounted.bridge.handle('optimize.followup', ({ text }) => ok({ session: session('s1', [...current.rounds, round('r2', { kind: 'followup', input: text })]) }))
    const textarea = screen.getByRole('textbox', { name: '追加要求…' }) as HTMLTextAreaElement
    fireEvent.change(textarea, { target: { value: '再精简一些' } })
    return { ...mounted, textarea }
  }

  it('不带修饰键的 Enter 发送，发送后清空输入框', async () => {
    const { bridge, controller, textarea } = await box(false)
    await act(async () => {
      fireEvent.keyDown(textarea, { key: 'Enter' })
      await settle()
    })
    expect(bridge.callsTo('optimize.followup')).toEqual([{ text: '再精简一些' }])
    expect(controller.store.getState().optimize.followup).toBe('')
  })

  it('Shift+Enter 换行，不发送；输入法组字时 Enter 用来选词', async () => {
    const { bridge, textarea } = await box(false)
    expect(fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: true })).toBe(true)
    expect(fireEvent.keyDown(textarea, { key: 'Enter', keyCode: 229 })).toBe(true)
    expect(fireEvent.keyDown(textarea, { key: 'Enter', isComposing: true })).toBe(true)
    await act(async () => {
      await settle()
    })
    expect(bridge.callsTo('optimize.followup')).toEqual([])
  })

  it('有一轮在进行时不能发送：Enter 不发，按钮变成「取消」', async () => {
    const { bridge, textarea } = await box(true)
    await act(async () => {
      fireEvent.keyDown(textarea, { key: 'Enter' })
      await settle()
    })
    expect(bridge.callsTo('optimize.followup')).toEqual([])
    expect(screen.queryByRole('button', { name: '发送' })).toBeNull()
    bridge.handle('optimize.cancel', () => ok({ session: null }))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '取消' }))
      await settle()
    })
    expect(bridge.callsTo('optimize.cancel')).toHaveLength(1)
  })

  it('只有空白时「发送」不可用', async () => {
    const { textarea } = await box(false)
    fireEvent.change(textarea, { target: { value: '   ' } })
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '发送' }).disabled).toBe(true)
  })
})
