// @vitest-environment jsdom
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { translate, type MessageKey, type MessageParams } from '../../../src/shared/i18n/index.ts'
import type { AppController } from '../../../src/app/renderer/controller/app.ts'
import { COMPACT_STATUS_WIDTH, StatusBar, StatusBarContainer, type StatusBarProps } from '../../../src/app/renderer/components/StatusBar.tsx'
import { ControllerContext } from '../../../src/app/renderer/components/hooks.ts'
import { binding, draftRecord, FakeBridge, ok, round, session, startController, trapUnhandled } from './helpers.ts'

const t = (key: MessageKey, params?: MessageParams) => translate('zh', key, params)

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

function props(overrides: Partial<StatusBarProps> = {}): StatusBarProps {
  return {
    width: 800,
    status: 'unsaved',
    chars: 309,
    boundTitle: null,
    message: null,
    optimizing: false,
    copyShortcut: '⌘↩',
    t,
    onCopy: vi.fn(),
    onDismiss: vi.fn(),
    ...overrides,
  }
}

describe('底栏（E-03）', () => {
  it('左侧「未保存 · 309 字符」，右侧主按钮「复制并隐藏」和快捷键', () => {
    const { container } = render(<StatusBar {...props()} />)
    expect(container.querySelector('.px-status')?.textContent).toBe('未保存· 309 字符')
    expect(screen.getByText('未保存')).toBeTruthy()
    expect(screen.getByText('· 309 字符')).toBeTruthy()
    expect(screen.getByRole('button', { name: '复制并隐藏' })).toBeTruthy()
    expect(container.querySelector('kbd')?.textContent).toBe('⌘↩')
  })

  it('绑定库条目时在状态前显示标题，过长截断，悬停显示全称', () => {
    const title = '一个非常非常非常长的库条目标题，底栏放不下'
    const { container } = render(<StatusBar {...props({ boundTitle: title, status: 'saved' })} />)
    const element = container.querySelector('.px-status-title')
    expect(element?.textContent).toBe(title)
    expect(element?.getAttribute('title')).toBe(title)
    expect(container.querySelector('.px-status')?.firstElementChild).toBe(element)
  })

  it('变窄时字符数收进悬停提示；保存状态和「复制并隐藏」始终可见', () => {
    const { container } = render(<StatusBar {...props({ width: COMPACT_STATUS_WIDTH - 1 })} />)
    expect(container.querySelector('.px-status-chars')).toBeNull()
    expect(container.querySelector('.px-status')?.getAttribute('title')).toBe('未保存 · 309 字符')
    expect(screen.getByText('未保存')).toBeTruthy()
    expect(screen.getByRole('button', { name: '复制并隐藏' })).toBeTruthy()
    expect(container.querySelector('.px-statusbar')?.hasAttribute('data-compact')).toBe(true)
  })

  it('宽度还没量到（0）时按宽的布局显示', () => {
    const { container } = render(<StatusBar {...props({ width: 0 })} />)
    expect(container.querySelector('.px-status-chars')).not.toBeNull()
  })

  it('提示文字截断时悬停显示全文；错误提示可以关掉', () => {
    const onDismiss = vi.fn()
    const text = '保存失败：一个很长很长的原因'
    render(<StatusBar {...props({ message: { kind: 'error', text, toastId: 7 }, onDismiss })} />)
    expect(screen.getByText(text).getAttribute('title')).toBe(text)
    fireEvent.click(screen.getByRole('button', { name: '关闭提示' }))
    expect(onDismiss).toHaveBeenCalledWith(7)
  })

  it('成功提示和草稿保存失败没有关闭按钮', () => {
    render(<StatusBar {...props({ message: { kind: 'success', text: '已复制。', toastId: 1 } })} />)
    expect(screen.queryByRole('button', { name: '关闭提示' })).toBeNull()
    cleanup()
    render(<StatusBar {...props({ message: { kind: 'error', text: '草稿保存失败：没有权限' } })} />)
    expect(screen.queryByRole('button', { name: '关闭提示' })).toBeNull()
  })

  it('优化进行中显示指示；没有快捷键时按钮旁不显示', () => {
    const { container } = render(<StatusBar {...props({ optimizing: true, copyShortcut: '' })} />)
    expect(screen.getByRole('img', { name: '正在优化' })).toBeTruthy()
    expect(container.querySelector('kbd')).toBeNull()
  })

  it('点主按钮复制并隐藏；按下时不抢编辑区的焦点', () => {
    const onCopy = vi.fn()
    render(<StatusBar {...props({ onCopy })} />)
    const button = screen.getByRole('button', { name: '复制并隐藏' })
    expect(fireEvent.mouseDown(button)).toBe(false)
    fireEvent.click(button)
    expect(onCopy).toHaveBeenCalledTimes(1)
  })
})

describe('底栏接上状态', () => {
  async function mount(bridge: FakeBridge): Promise<{ controller: AppController; container: HTMLElement }> {
    const controller = await startController(bridge)
    controllers.push(controller)
    const { container } = render(
      <ControllerContext.Provider value={controller}>
        <StatusBarContainer />
      </ControllerContext.Provider>,
    )
    return { controller, container }
  }

  function message(container: HTMLElement): string | null {
    return container.querySelector('.px-message')?.textContent ?? null
  }

  it('提示的优先级：错误提示 > 草稿保存失败 > 成功提示 > 优化进行中', async () => {
    const bridge = new FakeBridge()
    bridge.handle('optimize.state', () => ok({ session: session('s1', [round('r1')]) }))
    const { controller, container } = await mount(bridge)
    expect(message(container)).toBe('正在用 DeepSeek-V4 优化，可继续编辑。')

    act(() => {
      controller.toasts.success('已复制。')
    })
    expect(message(container)).toBe('已复制。')

    act(() => {
      controller.store.update(state => ({ ...state, draft: { ...state.draft, saveError: { code: 'promptx/draft/write-failed', detail: 'EACCES' } } }))
    })
    expect(message(container)).toBe('草稿保存失败：没有权限')

    act(() => {
      controller.toasts.error('复制失败：写入剪贴板失败')
    })
    expect(message(container)).toBe('复制失败：写入剪贴板失败')
  })

  it('草稿保存失败的原因是存储层的错误代码时说成原因，不露出代码（审查 CR-04）', async () => {
    const { controller, container } = await mount(new FakeBridge())
    act(() => {
      controller.store.update(state => ({ ...state, draft: { ...state.draft, saveError: { code: 'promptx/draft/write-failed', detail: 'unknown-state' } } }))
    })
    // 修复前：「草稿保存失败：草稿写入失败（unknown-state）」。
    expect(message(container)).toBe('草稿保存失败：草稿存储处于未知状态')
  })

  it('旧绑定草稿恢复后不显示更新目标；Windows 的复制快捷键仍是 Ctrl+Enter', async () => {
    const bridge = new FakeBridge('win32')
    bridge.handle('draft.load', () => ok({ record: draftRecord('正文', { binding: binding('a.md', '正文', { title: '代码审查' }) }) }))
    const { container } = await mount(bridge)
    expect(container.querySelector('.px-status-title')).toBeNull()
    expect(screen.getByText('已保存')).toBeTruthy()
    expect(container.querySelector('kbd')?.textContent).toBe('Ctrl+Enter')
  })

  it('点「复制并隐藏」走真实的复制流程', async () => {
    const bridge = new FakeBridge()
    bridge.handle('draft.load', () => ok({ record: draftRecord('要复制的') }))
    await mount(bridge)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '复制并隐藏' }))
      await Promise.resolve()
    })
    expect(bridge.window.copyAndHide).toHaveBeenCalledWith('要复制的')
  })
})
