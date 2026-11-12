// @vitest-environment jsdom
import { afterEach, beforeEach, describe, it, expect } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { OptimizeRound, OptimizeSession } from '../../../src/shared/types.ts'
import type { AppController } from '../../../src/app/renderer/controller/app.ts'
import { replyView, SessionPane, STICK_TO_BOTTOM_PX } from '../../../src/app/renderer/components/SessionPane.tsx'
import { ControllerContext } from '../../../src/app/renderer/components/hooks.ts'
import { draftRecord, FakeBridge, ok, round, session, settle, startController, trapUnhandled } from './helpers.ts'

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

async function mount(
  initial: OptimizeSession | null,
  bridge = new FakeBridge(),
): Promise<{ bridge: FakeBridge; controller: AppController; container: HTMLElement }> {
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
  it('第一轮标「待优化的 Prompt · 字符数」，回复标模型名称；改写稿卡片头部有「复制」「应用」「⋯」，⋯ 里是「复制整段回复」', async () => {
    const { bridge, controller } = await mount(session('s1', [round('r1', { input: '我的草稿', status: 'done', reply: '说明', candidate: '改写稿' })]))
    expect(screen.getByText('待优化的 Prompt · 4 字符')).toBeTruthy()
    expect(screen.getByText('我的草稿')).toBeTruthy()
    expect(screen.getByText('DeepSeek-V4', { selector: '.px-reply-model' })).toBeTruthy()
    const card = document.querySelector<HTMLElement>('.px-candidate')
    if (card === null) throw new Error('no candidate card')
    expect(card.querySelector('.px-candidate-body')?.textContent).toBe('改写稿')
    expect(card.querySelector('.px-candidate-head')?.textContent).toContain('改写稿· 3 字符')
    expect(within(card).getAllByRole('button').map(button => button.getAttribute('aria-label') ?? button.textContent)).toEqual(['复制', '应用', '更多'])
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
    expect(document.querySelector('.px-candidate')).toBeNull()
    expect(document.querySelector('.px-reply-text')?.textContent).toBe('只有说明')
  })

  it('说明和改写稿分开显示：改写稿进卡片，不再显示 prompt 围栏', async () => {
    const reply = '把要求拆成两步。\n\n````prompt\n# 复述后再执行\n\n先复述，再执行。\n````\n\n变量原样保留。'
    await mount(session('s1', [round('r1', { status: 'done', reply, candidate: '# 复述后再执行\n\n先复述，再执行。' })]))
    expect([...document.querySelectorAll('.px-reply-text')].map(element => element.textContent)).toEqual(['把要求拆成两步。', '变量原样保留。'])
    expect(document.querySelector('.px-candidate-body')?.textContent).toBe('# 复述后再执行\n\n先复述，再执行。')
    expect(document.querySelector('.px-session-messages')?.textContent).not.toContain('```')
  })

  it('生成中：没收尾的改写稿已经进卡片，显示「正在生成…」，没有操作按钮', async () => {
    await mount(session('s1', [round('r1', { status: 'running', reply: '改写如下：\n````prompt\n写到一半' })]))
    const card = document.querySelector<HTMLElement>('.px-candidate')
    if (card === null) throw new Error('no candidate card')
    expect(card.querySelector('.px-candidate-body')?.textContent).toBe('写到一半')
    expect(card.textContent).toContain('正在生成…')
    expect(within(card).queryAllByRole('button')).toEqual([])
    expect(document.querySelector('.px-reply-text')?.textContent).toBe('改写如下：')
  })

  it('追加的要求不再显示「你」标签，读屏文字仍有', async () => {
    await mount(session('s1', [
      round('r1', { status: 'done', reply: '说明', candidate: null }),
      round('r2', { kind: 'followup', input: '再精简一些', status: 'running' }),
    ]))
    const bubble = screen.getByText('再精简一些').closest('.px-user-msg')
    expect(bubble?.querySelector('.px-visually-hidden')?.textContent).toBe('你')
    expect(bubble?.querySelector('.px-user-msg-label')).toBeNull()
  })

  it('第一轮的 Prompt 超过四行时可以展开和收起', async () => {
    // jsdom 不排版：在 HTMLElement 上盖一层固定的高度，用完删掉，露出 Element 上原来的定义。
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', { configurable: true, get: () => 200 })
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 80 })
    try {
      await mount(session('s1', [round('r1', { input: '一\n二\n三\n四\n五\n六', status: 'done', reply: '说明', candidate: null })]))
      const toggle = screen.getByRole('button', { name: '展开' })
      expect(toggle.getAttribute('aria-expanded')).toBe('false')
      fireEvent.click(toggle)
      expect(screen.getByRole('button', { name: '收起' }).getAttribute('aria-expanded')).toBe('true')
      expect(toggle.closest('.px-user-msg')?.getAttribute('data-expanded')).toBe('true')
      fireEvent.click(screen.getByRole('button', { name: '收起' }))
      expect(screen.getByRole('button', { name: '展开' })).toBeTruthy()
    } finally {
      Reflect.deleteProperty(HTMLElement.prototype, 'scrollHeight')
      Reflect.deleteProperty(HTMLElement.prototype, 'clientHeight')
    }
  })

  it('没超过四行时不显示「展开」', async () => {
    await mount(session('s1', [round('r1', { input: '短草稿', status: 'done', reply: '说明', candidate: null })]))
    expect(screen.queryByRole('button', { name: '展开' })).toBeNull()
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
  it('空会话直接发送第一轮，结果只在点击「应用」后写进主编辑区', async () => {
    const { bridge, controller } = await mount(null)
    controller.editor.replaceAll('主编辑区草稿')
    bridge.handle('optimize.start', ({ text }) => ok({ session: session('s1', [
      round('r1', { input: text, status: 'done', reply: '改写稿', candidate: '改写稿' }),
    ]) }))
    const input = screen.getByRole<HTMLTextAreaElement>('textbox', { name: '输入要优化的 Prompt…' })
    const send = screen.getByRole<HTMLButtonElement>('button', { name: '发送' })
    expect(send.disabled).toBe(true)
    fireEvent.change(input, { target: { value: '聊天栏的 Prompt' } })
    expect(send.disabled).toBe(false)
    await act(async () => {
      fireEvent.click(send)
      await settle()
    })
    expect(bridge.callsTo('optimize.start')).toEqual([{ text: '聊天栏的 Prompt' }])
    expect(bridge.callsTo('optimize.followup')).toEqual([])
    expect(screen.getByRole('textbox', { name: '追加要求…' })).toBe(input)
    expect(input.value).toBe('')
    expect(controller.editor.getText()).toBe('主编辑区草稿')
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '应用' }))
      await settle()
    })
    expect(controller.editor.getText()).toBe('改写稿')
  })

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

describe('空会话（V0.1.5 界面方案第 12 条）', () => {
  it('说明聊天栏的用途；编辑区为空时「优化编辑区内容」不可用', async () => {
    await mount(null)
    expect(screen.getByText('优化编辑区里的 Prompt')).toBeTruthy()
    expect(screen.getByText('也可以在下方直接输入一段 Prompt 发送。')).toBeTruthy()
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '优化编辑区内容' }).disabled).toBe(true)
    expect(screen.getByRole('button', { name: '隐藏小窗' })).toBeTruthy()
  })

  it('「优化编辑区内容」等同工具栏的优化：用编辑区全文发起第一轮，按钮里显示优化的快捷键', async () => {
    const bridge = new FakeBridge()
    bridge.handle('draft.load', () => ok({ record: draftRecord('编辑区的 Prompt') }))
    bridge.handle('optimize.start', ({ text }) => ok({ session: session('s1', [round('r1', { input: text })]) }))
    const { controller } = await mount(null, bridge)
    // 字符数和保存状态平时在输入停顿 150 ms 后才重算，这里直接算一次。
    act(() => {
      controller.draft.refreshMetrics()
    })
    const button = screen.getByRole<HTMLButtonElement>('button', { name: '优化编辑区内容' })
    expect(button.querySelector('kbd')?.textContent).toBe('⇧⌘O')
    expect(button.disabled).toBe(false)
    await act(async () => {
      fireEvent.click(button)
      await settle()
    })
    expect(bridge.callsTo('optimize.start')).toEqual([{ text: '编辑区的 Prompt' }])
    expect(screen.queryByText('优化编辑区里的 Prompt')).toBeNull()
  })
})

describe('replyView：一轮回复的显示', () => {
  it('Host 给了候选但前端定位不到时，整段回复按说明显示，卡片里放候选', () => {
    expect(replyView(round('r1', { status: 'done', reply: '\n只有说明\n', candidate: '候选' }))).toEqual({
      before: '只有说明',
      card: { text: '候选', mode: 'actions' },
      after: '',
    })
  })

  it('取消的一轮里已经收尾的改写稿放进卡片，但不给操作按钮', () => {
    expect(replyView(round('r1', { status: 'cancelled', reply: '```prompt\n内容\n```\n后面' }))).toEqual({
      before: '',
      card: { text: '内容', mode: 'plain' },
      after: '后面',
    })
  })
})
