// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, it, expect } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { undo } from '@codemirror/commands'
import { DEFAULT_PREFS, type BridgeResult } from '../../../src/shared/bridge.ts'
import type { DraftRecord } from '../../../src/shared/types.ts'
import { DEFAULT_TOOLBAR_SHORTCUTS } from '../../../src/shared/window-shortcuts.ts'
import { tagColorIndex } from '../../../src/shared/tag-colors.ts'
import { AppController } from '../../../src/app/renderer/controller/app.ts'
import { App } from '../../../src/app/renderer/components/App.tsx'
import {
  config,
  deferred,
  draftRecord,
  entry,
  fail,
  FakeBridge,
  installLayoutStubs,
  listResult,
  ok,
  readResult,
  round,
  session,
  settle,
  trapUnhandled,
  type Deferred,
} from './helpers.ts'

let checkUnhandled: () => void
const controllers: AppController[] = []

beforeAll(() => {
  installLayoutStubs()
})

beforeEach(() => {
  checkUnhandled = trapUnhandled()
})

afterEach(() => {
  cleanup()
  for (const controller of controllers.splice(0)) controller.dispose()
  document.body.removeAttribute('data-ds-dark-theme')
  checkUnhandled()
})

/** 和 index.tsx 一样：先挂界面，再启动总控。 */
async function mountApp(bridge: FakeBridge): Promise<AppController> {
  const controller = new AppController({ bridge, locale: 'zh' })
  controllers.push(controller)
  render(<App controller={controller} />)
  await act(async () => {
    await controller.start()
    await controller.layout.settled()
    await settle()
  })
  return controller
}

async function flush(): Promise<void> {
  await act(async () => {
    await settle()
  })
}

function editorContent(): HTMLElement {
  const content = document.querySelector<HTMLElement>('.cm-content')
  if (content === null) throw new Error('editor is not mounted')
  return content
}

function toolbar(): HTMLElement {
  return screen.getByRole('toolbar')
}

/** 列表栏里的条目（标签下拉的 option 不算）。 */
function rows(): HTMLElement[] {
  return within(screen.getByRole('listbox')).getAllByRole('option')
}

describe('草稿载入（F-01）', () => {
  it('读回之前显示「正在载入草稿…」且不可编辑；读回后开放编辑并报告就绪', async () => {
    const bridge = new FakeBridge()
    const load: Deferred<BridgeResult<{ record: DraftRecord | null }>> = deferred()
    bridge.handle('draft.load', () => load.promise)
    const controller = new AppController({ bridge, locale: 'zh' })
    controllers.push(controller)
    render(<App controller={controller} />)
    let started!: Promise<void>
    act(() => {
      started = controller.start()
    })
    await flush()
    expect(screen.getByText('正在载入草稿…')).toBeTruthy()
    expect(editorContent().getAttribute('contenteditable')).toBe('false')
    expect(bridge.ready).not.toHaveBeenCalled()

    await act(async () => {
      load.resolve(ok({ record: draftRecord('上次的草稿') }))
      await started
    })
    expect(screen.queryByText('正在载入草稿…')).toBeNull()
    expect(editorContent().getAttribute('contenteditable')).toBe('true')
    expect(editorContent().textContent).toBe('上次的草稿')
    expect(bridge.ready).toHaveBeenCalledWith({ editorMounted: true, draftLoaded: true })
  })

  it('读取失败：显示原因和「重试」，编辑区保持不可编辑', async () => {
    const bridge = new FakeBridge()
    let attempts = 0
    bridge.handle('draft.load', () => (++attempts === 1 ? fail('promptx/draft/unreadable') : ok({ record: draftRecord('恢复了') })))
    await mountApp(bridge)
    expect(screen.getByRole('alert').textContent).toContain('草稿读取失败：草稿记录无法读取')
    expect(editorContent().getAttribute('contenteditable')).toBe('false')
    // 存储层的错误代码说成原因（审查 CR-04）：修复前是「草稿记录无法读取（malformed-medium）」。
    bridge.handle('draft.load', () => fail('promptx/draft/unreadable', 'malformed-medium'))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '重试' }))
      await settle()
    })
    expect(screen.getByRole('alert').textContent).toContain('草稿读取失败：草稿文件已损坏')
    expect(screen.getByRole('alert').textContent).not.toContain('malformed-medium')
    bridge.handle('draft.load', () => ok({ record: draftRecord('恢复了') }))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '重试' }))
      await settle()
    })
    expect(editorContent().getAttribute('contenteditable')).toBe('true')
    expect(editorContent().textContent).toBe('恢复了')
  })
})

describe('工具栏（需求 5.3、S-02）', () => {
  it('左端库，分隔线后保存、优化、清空；右端设置、聊天、隐藏小窗；悬停提示带当前快捷键', async () => {
    const bridge = new FakeBridge()
    bridge.handle('draft.load', () => ok({ record: draftRecord('有内容') }))
    await mountApp(bridge)
    const bar = within(toolbar())
    expect(bar.getAllByRole('button').map(button => button.getAttribute('aria-label'))).toEqual(['库', '保存', '优化', '清空', '设置', '聊天', '隐藏小窗'])
    expect(toolbar().querySelectorAll('.px-toolbar-sep')).toHaveLength(2)
    const tip = (name: string) => bar.getByRole('button', { name }).getAttribute('data-tip')
    expect(tip('库')).toBe('库（⌘L）')
    expect(tip('保存')).toBe('保存（⌘S）')
    expect(tip('优化')).toBe('优化（⇧⌘O）')
    expect(tip('清空')).toBe('清空')
    expect(tip('聊天')).toBe('聊天')
    expect(tip('设置')).toBe('设置')
    expect(tip('隐藏小窗')).toBe('隐藏小窗（Esc）')
  })

  it('小窗收到更新后，同一个快捷键出现在工具栏提示并触发动作', async () => {
    const bridge = new FakeBridge()
    await mountApp(bridge)
    const chat = within(toolbar()).getByRole('button', { name: '聊天' })
    const close = within(toolbar()).getByRole('button', { name: '隐藏小窗' })
    act(() => {
      bridge.emit('config', config({
        windowShortcuts: { ...DEFAULT_TOOLBAR_SHORTCUTS, shortcutChat: 'Command+J', shortcutClose: '' },
      }))
    })
    expect(chat.getAttribute('data-tip')).toBe('聊天（⌘J）')
    expect(close.getAttribute('data-tip')).toBe('隐藏小窗')
    await act(async () => {
      fireEvent.keyDown(editorContent(), { key: 'j', code: 'KeyJ', metaKey: true })
      await settle()
    })
    expect(chat.getAttribute('aria-pressed')).toBe('true')
  })

  it('工具栏只在编辑区内，首次启动聊天收起，打开后可以收起空白聊天栏', async () => {
    const bridge = new FakeBridge()
    bridge.storedPrefs = structuredClone(DEFAULT_PREFS)
    await mountApp(bridge)
    const bar = toolbar()
    const chat = within(bar).getByRole('button', { name: '聊天' })
    expect(bar.parentElement?.classList.contains('px-editor-column')).toBe(true)
    expect(bar.parentElement?.firstElementChild).toBe(bar)
    expect(screen.getByRole('navigation', { name: '文件夹' }).contains(bar)).toBe(false)
    expect(chat.getAttribute('aria-pressed')).toBe('false')
    expect(screen.queryByRole('complementary', { name: '优化会话' })).toBeNull()

    await act(async () => {
      fireEvent.click(chat)
      await settle()
    })
    const panel = screen.getByRole('complementary', { name: '优化会话' })
    expect(panel.contains(bar)).toBe(false)
    expect(panel.querySelectorAll('.px-round')).toHaveLength(0)
    expect(within(panel).getByText('优化编辑区里的 Prompt')).toBeTruthy()
    expect(within(panel).getByRole('textbox', { name: '输入要优化的 Prompt…' })).toBeTruthy()
    expect(within(panel).getByRole<HTMLButtonElement>('button', { name: '发送' }).disabled).toBe(true)
    expect(chat.getAttribute('aria-pressed')).toBe('true')
    // 隐藏小窗的按钮始终在窗口最右侧那一栏：聊天栏打开时在聊天栏头，工具栏里不再有。
    expect(within(bar).queryByRole('button', { name: '隐藏小窗' })).toBeNull()
    expect(within(panel).getByRole('button', { name: '隐藏小窗' }).getAttribute('data-tip')).toBe('隐藏小窗（Esc）')

    await act(async () => {
      fireEvent.click(chat)
      await settle()
    })
    expect(screen.queryByRole('complementary', { name: '优化会话' })).toBeNull()
    expect(chat.getAttribute('aria-pressed')).toBe('false')
    expect(within(bar).getByRole('button', { name: '隐藏小窗' })).toBeTruthy()
  })

  it('Windows 上悬停提示写成 Ctrl+…', async () => {
    const bridge = new FakeBridge('win32')
    await mountApp(bridge)
    expect(within(toolbar()).getByRole('button', { name: '优化' }).getAttribute('data-tip')).toBe('优化（Ctrl+Shift+O）')
  })

  it('草稿为空时「清空」不可用；「库」在侧栏展开时显示为按下', async () => {
    const bridge = new FakeBridge()
    await mountApp(bridge)
    const bar = within(toolbar())
    expect(bar.getByRole<HTMLButtonElement>('button', { name: '清空' }).disabled).toBe(true)
    const library = bar.getByRole('button', { name: '库' })
    expect(library.getAttribute('aria-pressed')).toBe('false')
    await act(async () => {
      fireEvent.click(library)
      await settle()
    })
    expect(library.getAttribute('aria-pressed')).toBe('true')
  })

  it('点「库」展开侧栏时焦点进搜索框，再点收起时焦点回到编辑区（需求 4.3 第 1 步，审查 CR-06）', async () => {
    const bridge = new FakeBridge()
    bridge.handle('library.list', () => ok(listResult([entry('a.md')])))
    await mountApp(bridge)
    editorContent().focus()
    const library = within(toolbar()).getByRole('button', { name: '库' })
    // 和真实点击一样先按下：工具栏按钮按下时不抢编辑区的焦点（keepFocus）。
    fireEvent.mouseDown(library)
    await act(async () => {
      fireEvent.click(library)
      await settle()
    })
    const search = screen.getByRole('searchbox', { name: '搜索 Prompt' })
    expect(document.activeElement).toBe(search)

    fireEvent.mouseDown(library)
    await act(async () => {
      fireEvent.click(library)
      await settle()
    })
    expect(screen.queryByRole('searchbox')).toBeNull()
    expect(document.activeElement).toBe(editorContent())
  })

  it('恢复已有会话时聊天栏仍收起，进行中「优化」变成「停止」', async () => {
    const bridge = new FakeBridge()
    bridge.handle('optimize.state', () => ok({ session: session('s1', [round('r1')]) }))
    await mountApp(bridge)
    const bar = within(toolbar())
    expect(bar.getByRole('button', { name: '聊天' }).getAttribute('aria-pressed')).toBe('false')
    expect(bar.getByRole('button', { name: '停止' })).toBeTruthy()
    expect(bar.queryByRole('button', { name: '优化' })).toBeNull()
  })

  it('清空对话后聊天按钮和空面板仍然可见', async () => {
    const bridge = new FakeBridge()
    bridge.handle('optimize.state', () => ok({ session: session('s1', [round('r1')]) }))
    bridge.handle('optimize.clear', () => {
      bridge.emit('optimize.event', { type: 'session', session: null })
      return ok({})
    })
    await mountApp(bridge)
    const chat = within(toolbar()).getByRole('button', { name: '聊天' })
    await act(async () => {
      fireEvent.click(chat)
      await settle()
    })
    const panel = screen.getByRole('complementary', { name: '优化会话' })
    expect(panel.querySelectorAll('.px-round')).toHaveLength(1)
    await act(async () => {
      fireEvent.click(within(panel).getByRole('button', { name: '清空会话' }))
      await settle()
    })
    expect(within(toolbar()).getByRole('button', { name: '聊天' })).toBe(chat)
    expect(chat.getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('complementary', { name: '优化会话' })).toBe(panel)
    expect(panel.querySelectorAll('.px-round')).toHaveLength(0)
    expect(within(panel).getByText('优化编辑区里的 Prompt')).toBeTruthy()
    expect(within(panel).getByRole('textbox', { name: '输入要优化的 Prompt…' })).toBeTruthy()
  })

  it('点「隐藏小窗」隐藏小窗；点按钮不抢编辑区的焦点', async () => {
    const bridge = new FakeBridge()
    await mountApp(bridge)
    const close = within(toolbar()).getByRole('button', { name: '隐藏小窗' })
    expect(fireEvent.mouseDown(close)).toBe(false)
    await act(async () => {
      fireEvent.click(close)
      await settle()
    })
    expect(bridge.window.hide).toHaveBeenCalledTimes(1)
  })
})

describe('外观（S-03）', () => {
  it('按配置切换明暗和平台，语言跟着 dsh 变', async () => {
    const bridge = new FakeBridge()
    bridge.configValue = config({ resolvedTheme: 'dark', resolvedLocale: 'en', locale: 'en' })
    await mountApp(bridge)
    expect(document.body.hasAttribute('data-ds-dark-theme')).toBe(true)
    expect(document.documentElement.getAttribute('data-platform')).toBe('darwin')
    expect(document.documentElement.lang).toBe('en')
    expect(within(toolbar()).getByRole('button', { name: 'Library' })).toBeTruthy()
    expect(document.querySelector('.cm-placeholder')?.textContent).toBe('Write a prompt. Markdown is supported.')

    act(() => {
      bridge.emit('config', config({ resolvedTheme: 'light', resolvedLocale: 'zh' }))
    })
    expect(document.body.hasAttribute('data-ds-dark-theme')).toBe(false)
    expect(within(toolbar()).getByRole('button', { name: '库' })).toBeTruthy()
    expect(document.querySelector('.cm-placeholder')?.textContent).toBe('输入 Prompt，支持 Markdown。')
  })
})

describe('窗口级快捷键在真实的界面里', () => {
  it('焦点在追加输入框里按 ⌘↩：复制的是编辑区内容，小窗隐藏，不发起新一轮（F-03，审查 COV-04）', async () => {
    const bridge = new FakeBridge()
    bridge.handle('draft.load', () => ok({ record: draftRecord('编辑区的全文') }))
    bridge.handle('optimize.state', () => ok({ session: session('s1', [round('r1', { status: 'done', reply: 'r', candidate: 'c' })]) }))
    const controller = await mountApp(bridge)
    await act(async () => {
      await controller.optimize.togglePane()
    })
    const textarea = screen.getByRole('textbox', { name: '追加要求…' }) as HTMLTextAreaElement
    fireEvent.change(textarea, { target: { value: '再精简一些' } })
    textarea.focus()
    await act(async () => {
      fireEvent.keyDown(textarea, { key: 'Enter', metaKey: true })
      await settle()
    })
    expect(bridge.window.copyAndHide).toHaveBeenCalledWith('编辑区的全文')
    expect(bridge.callsTo('optimize.followup')).toEqual([])
    expect(textarea.value).toBe('再精简一些')
  })

  it('首次启动显示库的两列，⌘L 在编辑区也能收起库，展开时焦点进搜索框', async () => {
    const bridge = new FakeBridge()
    bridge.storedPrefs = structuredClone(DEFAULT_PREFS)
    bridge.handle('library.list', () => ok(listResult([entry('a.md')])))
    await mountApp(bridge)
    expect(document.querySelector('.px-folders')).not.toBeNull()
    expect(document.querySelector('.px-list-column')).not.toBeNull()
    editorContent().focus()
    await act(async () => {
      fireEvent.keyDown(editorContent(), { key: 'l', code: 'KeyL', metaKey: true })
      await settle()
    })
    expect(document.querySelector('.px-folders')).toBeNull()
    expect(document.querySelector('.px-list-column')).toBeNull()
    await act(async () => {
      fireEvent.keyDown(editorContent(), { key: 'l', code: 'KeyL', metaKey: true })
      await settle()
    })
    const search = screen.getByRole('searchbox', { name: '搜索 Prompt' })
    expect(document.activeElement).toBe(search)
    await act(async () => {
      fireEvent.keyDown(search, { key: 'l', code: 'KeyL', metaKey: true })
      await settle()
    })
    expect(screen.queryByRole('searchbox')).toBeNull()
    expect(document.activeElement).toBe(editorContent())
  })

  it('Esc 隐藏小窗；呼出时焦点回到编辑区', async () => {
    const bridge = new FakeBridge()
    await mountApp(bridge)
    await act(async () => {
      fireEvent.keyDown(document.body, { key: 'Escape' })
      await settle()
    })
    expect(bridge.window.hide).toHaveBeenCalledTimes(1)
    act(() => {
      bridge.emit('window.shown', {})
    })
    expect(document.activeElement).toBe(editorContent())
  })
})

describe('一轮结束时的焦点（O-05）', () => {
  async function running(): Promise<{ bridge: FakeBridge; controller: AppController }> {
    const bridge = new FakeBridge()
    bridge.handle('optimize.state', () => ok({ session: session('s1', [round('r1')]) }))
    const controller = await mountApp(bridge)
    await act(async () => {
      await controller.optimize.togglePane()
    })
    return { bridge, controller }
  }

  function finish(bridge: FakeBridge): void {
    act(() => {
      bridge.emit('optimize.event', { type: 'session', session: session('s1', [round('r1', { status: 'done', reply: 'r', candidate: 'c' })]) })
    })
  }

  it('焦点在编辑区（例如正在组字）时不动', async () => {
    const { bridge } = await running()
    editorContent().focus()
    finish(bridge)
    expect(document.activeElement).toBe(editorContent())
  })

  it('焦点原本在会话栏里：放到追加输入框', async () => {
    const { bridge } = await running()
    screen.getByRole('button', { name: '清空会话' }).focus()
    finish(bridge)
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: '追加要求…' }))
  })
})

describe('库侧栏（L-02 至 L-11）', () => {
  it('文件夹栏从上到下：全部、未分类、真实文件夹（按层级缩进）、底部回收站', async () => {
    const bridge = new FakeBridge()
    bridge.handle('library.list', () => ok(listResult([], { folders: ['代码', '写作', '写作/评审'], total: 0 })))
    const controller = await mountApp(bridge)
    await act(async () => {
      await controller.library.open()
    })
    const nav = screen.getByRole('navigation', { name: '文件夹' })
    const labels = [...nav.querySelectorAll('.px-folder')].map(button => button.textContent)
    expect(labels).toEqual(['全部', '未分类', '代码', '写作', '评审', '回收站'])
    const nested = within(nav).getByRole('button', { name: '评审' })
    expect(nested.style.paddingLeft).toBe('24px')
    expect(within(nav).getByRole('button', { name: '全部' }).getAttribute('aria-current')).toBe('true')
    expect(screen.getByText('还没有保存的 Prompt')).toBeTruthy()
    // 没有选中条目时不留空白的预览区（V0.1.5）。
    expect(document.querySelector('.px-preview-area')).toBeNull()
    expect(screen.queryByRole('separator', { name: '调整预览高度' })).toBeNull()
  })

  it('有筛选但没有结果：「没有匹配的 Prompt」', async () => {
    const bridge = new FakeBridge()
    bridge.handle('library.list', () => ok(listResult([], { total: 3 })))
    const controller = await mountApp(bridge)
    await act(async () => {
      await controller.library.open()
    })
    expect(screen.getByText('没有匹配的 Prompt')).toBeTruthy()
  })

  it('库目录不可用：说明原因和「打开设置」，编辑照常可用（L-01）', async () => {
    const bridge = new FakeBridge()
    bridge.handle('library.list', () => ok(listResult([], { state: 'unavailable', error: { code: 'promptx/library/unavailable', detail: 'EACCES: permission denied' } })))
    const controller = await mountApp(bridge)
    await act(async () => {
      await controller.library.open()
    })
    expect(screen.getByText('库目录不可用：没有权限')).toBeTruthy()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '打开设置' }))
      await settle()
    })
    // 直接打开设置窗口的「Prompt 库」分区（V0.1.6）。
    expect(bridge.window.openSettings).toHaveBeenCalledWith('library')
    expect(editorContent().getAttribute('contenteditable')).toBe('true')
  })

  it('库目录不可用：位置限制说成可读的原因，「库目录不可用」只出现一次（审查 CR-04）', async () => {
    const bridge = new FakeBridge()
    let detail: string | undefined = 'library-dir-skills'
    bridge.handle('library.list', () => ok(listResult([], {
      state: 'unavailable',
      error: detail === undefined ? { code: 'promptx/library/unavailable' } : { code: 'promptx/library/unavailable', detail },
    })))
    const controller = await mountApp(bridge)
    await act(async () => {
      await controller.library.open()
    })
    const alert = (): string => screen.getByText(/^库目录不可用/).textContent ?? ''
    // 修复前：「库目录不可用：库目录不可用（library-dir-skills）」。
    expect(alert()).toBe('库目录不可用：库目录不能放在 dsh 的技能目录里，否则里面的 Prompt 会被当成技能读取')
    detail = 'library-dir-relative'
    await act(async () => {
      await controller.library.refresh(true)
    })
    expect(alert()).toBe('库目录不可用：库目录要写绝对路径，或以 ~ 开头')
    // 没有原因时只说一遍，不是「库目录不可用：库目录不可用」。
    detail = undefined
    await act(async () => {
      await controller.library.refresh(true)
    })
    expect(alert()).toBe('库目录不可用')
    expect(document.body.textContent).not.toContain('library-dir')
  })

  it('列表行：标题、星标（有无障碍文字）、相对时间和最多两个标签、标记；悬停时的三个操作', async () => {
    const now = Date.now()
    const bridge = new FakeBridge()
    bridge.handle('library.list', () => ok(listResult([
      entry('a.md', { title: '结构化写作模板', favorite: true, tags: ['写作', '示例', '第三个'], updatedAt: now - 3 * 3_600_000 }),
      entry('b.md', { title: '坏文件', status: 'unreadable', unreadableReason: 'not-utf8' }),
      entry('c.md', { title: '坏元数据', status: 'invalid-meta' }),
    ])))
    const controller = await mountApp(bridge)
    await act(async () => {
      await controller.library.open()
    })
    const [firstRow, secondRow, thirdRow] = rows()
    const first = within(firstRow as HTMLElement)
    expect(first.getByRole('img', { name: '已收藏' })).toBeTruthy()
    expect(first.getByText('3 小时前')).toBeTruthy()
    expect(first.getByText('写作')).toBeTruthy()
    // 标签按标签名上色（V0.1.5 追加），列表行只显示前两个标签。
    expect([...(firstRow as HTMLElement).querySelectorAll('.px-tag')].map(tag => [tag.textContent, tag.getAttribute('data-color')])).toEqual([
      ['写作', String(tagColorIndex('写作'))],
      ['示例', String(tagColorIndex('示例'))],
    ])
    expect(first.queryByText('第三个')).toBeNull()
    expect(first.getByRole('button', { name: '在编辑器中打开' })).toBeTruthy()
    expect(first.getByRole('button', { name: '删除' })).toBeTruthy()
    expect(first.getByRole('button', { name: '更多' })).toBeTruthy()
    expect(within(secondRow as HTMLElement).getByText('无法打开')).toBeTruthy()
    expect(within(secondRow as HTMLElement).getByRole<HTMLButtonElement>('button', { name: '在编辑器中打开' }).disabled).toBe(true)
    expect(within(thirdRow as HTMLElement).getByText('元数据无法识别')).toBeTruthy()
  })

  it('「更多」菜单：在编辑器中打开、重命名 / 标签…、复制正文、收藏 / 取消收藏、删除；Esc 先关菜单', async () => {
    const bridge = new FakeBridge()
    bridge.handle('library.list', () => ok(listResult([entry('a.md', { title: 'A', favorite: true })])))
    const controller = await mountApp(bridge)
    await act(async () => {
      await controller.library.open()
    })
    fireEvent.click(within(rows()[0] as HTMLElement).getByRole('button', { name: '更多' }))
    const menu = screen.getByRole('menu')
    expect(within(menu).getAllByRole('menuitem').map(item => item.textContent)).toEqual(['在编辑器中打开', '重命名 / 标签…', '复制正文', '取消收藏', '删除'])
    await act(async () => {
      fireEvent.keyDown(document.body, { key: 'Escape' })
      await settle()
    })
    expect(screen.queryByRole('menu')).toBeNull()
    expect(bridge.window.hide).not.toHaveBeenCalled()
  })

  it('「更多」里的「隐藏预览」收起预览：只出现在正在预览的条目上，行内和底部的「⋯」都有（V0.1.5 追加）', async () => {
    const bridge = new FakeBridge()
    const first = entry('a.md', { title: '第一条' })
    const second = entry('b.md', { title: '第二条' })
    bridge.handle('library.list', () => ok(listResult([first, second])))
    bridge.handle('library.read', ({ relPath }) => ok(readResult(relPath === 'a.md' ? first : second, '正文')))
    const controller = await mountApp(bridge)
    await act(async () => {
      await controller.library.open()
    })
    await act(async () => {
      fireEvent.click(rows()[0] as HTMLElement)
      await settle()
    })
    expect(document.querySelector('.px-preview-area')).not.toBeNull()

    // 没在预览的那一行，菜单里没有「隐藏预览」。
    fireEvent.click(within(rows()[1] as HTMLElement).getByRole('button', { name: '更多' }))
    expect(within(screen.getByRole('menu')).queryByRole('menuitem', { name: '隐藏预览' })).toBeNull()
    fireEvent.keyDown(document.body, { key: 'Escape' })

    // 正在预览的那一行：「隐藏预览」排在最上面，下面一条分隔线隔开对条目本身的操作。
    fireEvent.click(within(rows()[0] as HTMLElement).getByRole('button', { name: '更多' }))
    const rowMenu = screen.getByRole('menu')
    expect(within(rowMenu).getAllByRole('menuitem').map(item => item.textContent)).toEqual([
      '隐藏预览', '在编辑器中打开', '重命名 / 标签…', '复制正文', '收藏', '删除',
    ])
    expect(rowMenu.querySelectorAll('[role="separator"]')).toHaveLength(1)
    await act(async () => {
      fireEvent.click(within(rowMenu).getByRole('menuitem', { name: '隐藏预览' }))
      await settle()
    })
    expect(screen.queryByRole('menu')).toBeNull()
    expect(document.querySelector('.px-preview-area')).toBeNull()
    expect(rows()[0]?.getAttribute('aria-selected')).toBe('false')
    expect(controller.store.getState().library.selected).toBeNull()
    expect(document.querySelector('.px-list-footer')?.textContent).toBe('2 个 Prompt')

    // 底部那一行的「⋯」同样可以收起；按钮随预览消失后，焦点交回编辑区。
    await act(async () => {
      fireEvent.click(rows()[1] as HTMLElement)
      await settle()
    })
    const footer = document.querySelector<HTMLElement>('.px-list-footer')
    if (footer === null) throw new Error('no list footer')
    fireEvent.click(within(footer).getByRole('button', { name: '更多' }))
    await act(async () => {
      fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: '隐藏预览' }))
      await settle()
    })
    expect(document.querySelector('.px-preview-area')).toBeNull()
    expect(within(footer).queryByRole('button', { name: '更多' })).toBeNull()
    expect(document.activeElement?.closest('.cm-editor')).not.toBeNull()

    // 再点一行，重新选中并展开预览。
    await act(async () => {
      fireEvent.click(rows()[0] as HTMLElement)
      await settle()
    })
    expect(document.querySelector('.px-preview-area')).not.toBeNull()
  })

  it('预览标题行最右侧的 × 收起预览，和「更多」里的「隐藏预览」一样（V0.1.5 追加，方案 A）', async () => {
    const bridge = new FakeBridge()
    const first = entry('a.md', { title: '第一条', favorite: true })
    const second = entry('b.md', { title: '第二条' })
    bridge.handle('library.list', () => ok(listResult([first, second])))
    bridge.handle('library.read', ({ relPath }) => ok(readResult(relPath === 'a.md' ? first : second, '正文')))
    const controller = await mountApp(bridge)
    await act(async () => {
      await controller.library.open()
    })
    await act(async () => {
      fireEvent.click(rows()[0] as HTMLElement)
      await settle()
    })
    const titlebar = document.querySelector<HTMLElement>('.px-preview-titlebar')
    if (titlebar === null) throw new Error('no preview titlebar')
    // × 排在标题后面，不在会截断的标题元素里（否则悬停提示和聚焦框被裁掉）；悬停提示和读屏名称都是「隐藏预览」，提示向左展开。
    const hide = within(titlebar).getByRole('button', { name: '隐藏预览' })
    expect([...titlebar.children].map(child => child.className)).toEqual(['px-preview-title', 'px-icon-button px-icon-button-sm px-preview-hide'])
    expect(within(titlebar.children[0] as HTMLElement).getByRole('img', { name: '已收藏' })).toBeTruthy()
    expect(hide.getAttribute('data-tip')).toBe('隐藏预览')
    expect(hide.getAttribute('data-tip-align')).toBe('end')

    // 点击时按钮先拿到焦点（浏览器在按下鼠标时就把焦点给按钮）；收起后预览区、底部的操作和选中一起消失，焦点交回编辑区。
    // 点击不能包在外层 act 里：fireEvent 自带的 act 在返回前就渲染完，× 已经移除，和浏览器里 React 的提交排在
    // hidePreview 的微任务之前一致；包在外层 act 里要等整个回调结束才渲染，微任务检查时 × 还拿着焦点，顺序就反了。
    hide.focus()
    fireEvent.click(hide)
    await act(async () => {
      await settle()
    })
    expect(document.querySelector('.px-preview-area')).toBeNull()
    expect(controller.store.getState().library.selected).toBeNull()
    expect(rows()[0]?.getAttribute('aria-selected')).toBe('false')
    expect(document.querySelector('.px-list-footer')?.textContent).toBe('2 个 Prompt')
    expect(document.activeElement?.closest('.cm-editor')).not.toBeNull()

    // 再点一行，重新展开，× 也跟着回来。
    await act(async () => {
      fireEvent.click(rows()[1] as HTMLElement)
      await settle()
    })
    expect(document.querySelector('.px-preview-title')?.textContent).toBe('第二条')
    expect(screen.getByRole('button', { name: '隐藏预览' })).toBeTruthy()
  })

  it('选中一条：预览区这时才展开，显示完整正文；列表栏底部的「插入到光标」插进编辑区', async () => {
    const bridge = new FakeBridge()
    const meta = entry('a.md', { title: '模板' })
    bridge.handle('library.list', () => ok(listResult([meta])))
    bridge.handle('library.read', () => ok(readResult(meta, '# 写作助手\n\n要求')))
    const controller = await mountApp(bridge)
    await act(async () => {
      await controller.library.open()
    })
    const footer = document.querySelector<HTMLElement>('.px-list-footer')
    if (footer === null) throw new Error('no list footer')
    expect(footer.textContent).toBe('1 个 Prompt')
    expect(document.querySelector('.px-preview-area')).toBeNull()
    expect(within(footer).queryByRole('button', { name: '插入到光标' })).toBeNull()
    // 行内按钮的提示向左展开，隐藏的提示不会撑出横向滚动条（V0.1.5 界面方案第 19 条）。
    const actions = (rows()[0] as HTMLElement).querySelectorAll('.px-row-actions button')
    expect([...actions].map(button => button.getAttribute('data-tip-align'))).toEqual(['end', 'end', 'end'])
    await act(async () => {
      fireEvent.click(rows()[0] as HTMLElement)
      await settle()
    })
    expect(document.querySelector('.px-preview-area')).not.toBeNull()
    expect(screen.getByRole('separator', { name: '调整预览高度' })).toBeTruthy()
    expect(within(footer).getByRole('button', { name: '更多' })).toBeTruthy()
    expect(document.querySelector('.px-preview-text')?.textContent).toBe('# 写作助手\n\n要求')
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '插入到光标' }))
      await settle()
    })
    expect(controller.editor.getText()).toBe('# 写作助手\n\n要求')
  })

  it.each([
    { selection: { anchor: 2, head: 2 }, expected: '前文\n\n模板\n\n后文' },
    { selection: { anchor: 2, head: 4 }, expected: '前文\n\n模板' },
  ])('双击条目在失焦前的选区 $selection 插入一次，焦点回编辑器且一步可撤销', async ({ selection, expected }) => {
    const bridge = new FakeBridge()
    const meta = entry('a.md')
    bridge.handle('draft.load', () => ok({ record: draftRecord('前文后文', { selection }) }))
    bridge.handle('library.list', () => ok(listResult([meta])))
    bridge.handle('library.read', () => ok(readResult(meta, '模板')))
    const controller = await mountApp(bridge)
    await act(async () => {
      await controller.library.open()
    })
    const row = rows()[0] as HTMLElement
    await act(async () => {
      row.focus()
      fireEvent.click(row, { detail: 1 })
      fireEvent.click(row, { detail: 2 })
      fireEvent.doubleClick(row)
      await settle()
    })
    expect(controller.editor.getText()).toBe(expected)
    expect(controller.editor.hasFocus()).toBe(true)
    expect(controller.store.getState().draft.binding).toBeNull()
    act(() => {
      controller.editor.runCommand(undo)
    })
    expect(controller.editor.getText()).toBe('前文后文')
  })

  it('双击不等待预览，读取期间换条目时旧插入作废', async () => {
    const bridge = new FakeBridge()
    const first = entry('a.md')
    const second = entry('b.md')
    const pending = deferred<BridgeResult<ReturnType<typeof readResult>>>()
    bridge.handle('draft.load', () => ok({ record: draftRecord('原文') }))
    bridge.handle('library.list', () => ok(listResult([first, second])))
    bridge.handle('library.read', ({ relPath }) => relPath === first.relPath ? pending.promise : ok(readResult(second, '其他模板')))
    const controller = await mountApp(bridge)
    await act(async () => {
      await controller.library.open()
    })
    await act(async () => {
      fireEvent.click(rows()[0] as HTMLElement)
      fireEvent.doubleClick(rows()[0] as HTMLElement)
      await settle()
    })
    expect(bridge.calls.filter(call => call.method === 'library.read')).toHaveLength(2)
    await act(async () => {
      fireEvent.click(rows()[1] as HTMLElement)
      pending.resolve(ok(readResult(first, '旧模板')))
      await settle()
    })
    expect(controller.editor.getText()).toBe('原文')
  })

  it('双击行内操作或不可读条目不会插入正文', async () => {
    const bridge = new FakeBridge()
    const meta = entry('a.md')
    bridge.handle('draft.load', () => ok({ record: draftRecord('原文') }))
    bridge.handle('library.list', () => ok(listResult([
      meta,
      entry('bad.md', { status: 'unreadable', unreadableReason: 'not-utf8' }),
    ])))
    bridge.handle('library.read', () => ok(readResult(meta, '模板')))
    const controller = await mountApp(bridge)
    await act(async () => {
      await controller.library.open()
    })
    await act(async () => {
      fireEvent.click(rows()[0] as HTMLElement)
      await settle()
    })
    const readCount = bridge.calls.filter(call => call.method === 'library.read').length
    await act(async () => {
      const row = within(rows()[0] as HTMLElement)
      for (const name of ['在编辑器中打开', '删除', '更多']) {
        fireEvent.doubleClick(row.getByRole('button', { name }))
      }
      fireEvent.click(rows()[1] as HTMLElement)
      fireEvent.doubleClick(rows()[1] as HTMLElement)
      await settle()
    })
    expect(bridge.calls.filter(call => call.method === 'library.read')).toHaveLength(readCount)
    expect(controller.editor.getText()).toBe('原文')
  })

  it('窗口矮、预览区被压矮时，拖分隔线从实际显示的高度算起，往上拖不超过列表区的余量（审查 CR-07）', async () => {
    const bridge = new FakeBridge()
    bridge.handle('library.list', () => ok(listResult([entry('a.md')])))
    bridge.handle('library.read', () => ok(readResult(entry('a.md'), '正文')))
    const controller = await mountApp(bridge)
    await act(async () => {
      await controller.library.open()
    })
    await act(async () => {
      await controller.library.select('a.md')
    })
    expect(controller.store.getState().panes.previewHeight).toBe(232)
    // jsdom 不排版：假装窗口很矮，CSS 把预览区压到 150，列表区已经是最小的 96。
    const previewArea = document.querySelector('.px-preview-area')
    const listArea = document.querySelector('.px-list-area')
    if (!(previewArea instanceof HTMLElement) || !(listArea instanceof HTMLElement)) throw new Error('no list column')
    Object.defineProperty(previewArea, 'offsetHeight', { configurable: true, value: 150 })
    Object.defineProperty(listArea, 'clientHeight', { configurable: true, value: 96 })
    const divider = screen.getByRole('separator', { name: '调整预览高度' })
    // jsdom 没有指针捕获。
    divider.setPointerCapture = () => {}
    divider.releasePointerCapture = () => {}
    fireEvent.pointerDown(divider, { pointerId: 1, clientY: 300 })
    // 往下拖 10：从显示的 150 变成 140。从记下的 232 算起会是 222，比显示的还高，界面上没有任何变化。
    fireEvent.pointerMove(divider, { pointerId: 1, clientY: 310 })
    expect(controller.store.getState().panes.previewHeight).toBe(140)
    // 往上拖：列表区已经是最小，没有余量，停在显示的 150。
    fireEvent.pointerMove(divider, { pointerId: 1, clientY: 250 })
    expect(controller.store.getState().panes.previewHeight).toBe(150)
    fireEvent.pointerUp(divider, { pointerId: 1, clientY: 250 })
    // 松开时记进偏好。
    expect(bridge.storedPrefs.panes.previewHeight).toBe(150)
  })

  it('预览读取失败：文件过大说成原因；库目录变得不可用时说明位置限制，前缀只说一遍（审查 CR-04）', async () => {
    const bridge = new FakeBridge()
    bridge.handle('library.list', () => ok(listResult([entry('a.md'), entry('b.md')])))
    bridge.handle('library.read', params => (params.relPath === 'a.md'
      ? fail('promptx/library/unreadable', 'too-large')
      : fail('promptx/library/unavailable', 'library-dir-reserved')))
    const controller = await mountApp(bridge)
    await act(async () => {
      await controller.library.open()
    })
    const previewError = (): string | null | undefined => document.querySelector('.px-preview-error')?.textContent
    await act(async () => {
      fireEvent.click(rows()[0] as HTMLElement)
      await settle()
    })
    expect(previewError()).toBe('文件超过 2 MiB，无法打开')
    await act(async () => {
      fireEvent.click(rows()[1] as HTMLElement)
      await settle()
    })
    expect(previewError()).toBe('库目录不可用：库目录不能放在 dsh 的数据目录里（默认的 promptx/library 除外）')
  })

  it('回收站视图：隐藏分段筛选和标签下拉，搜索框照常可用；行显示「N 天前删除」和原来所在的文件夹', async () => {
    const bridge = new FakeBridge()
    bridge.handle('trash.list', () => ok({
      recordState: 'ok',
      entries: [
        { file: '旧版.md', title: '旧版翻译模板', deletedAt: Date.now() - 3 * 86_400_000, originalPath: '写作/旧版.md' },
        { file: '临时.md', title: '临时测试', deletedAt: null, originalPath: null },
      ],
    }))
    bridge.handle('trash.read', () => ok({ entry: { file: '旧版.md', title: '旧版翻译模板', deletedAt: 1, originalPath: '写作/旧版.md' }, body: '# 翻译' }))
    const controller = await mountApp(bridge)
    await act(async () => {
      await controller.library.open()
      await controller.library.chooseFolder({ kind: 'trash' })
    })
    expect(screen.queryByRole('radiogroup')).toBeNull()
    expect(screen.queryByRole('combobox', { name: '标签' })).toBeNull()
    expect(screen.getByRole('searchbox', { name: '搜索 Prompt' })).toBeTruthy()
    expect(screen.getByText('3 天前删除')).toBeTruthy()
    expect(screen.getByText('写作')).toBeTruthy()
    expect(screen.getByText('位置未知')).toBeTruthy()
    await act(async () => {
      fireEvent.click(screen.getByText('旧版翻译模板'))
      await settle()
    })
    expect(screen.getByText('原位置：写作/')).toBeTruthy()
    expect(screen.getByRole('button', { name: '恢复' })).toBeTruthy()
    // 预览标题行的 × 只加在库的预览上，回收站的预览没有「隐藏预览」（V0.1.5 追加二的范围）。
    expect(screen.queryByRole('button', { name: '隐藏预览' })).toBeNull()
  })

  it('标签下拉列出「全部标签」和库里的标签；分段筛选「全部 | 最近 | 收藏」', async () => {
    const bridge = new FakeBridge()
    bridge.handle('library.list', () => ok(listResult([], { tags: ['代码', '写作'] })))
    const controller = await mountApp(bridge)
    await act(async () => {
      await controller.library.open()
    })
    const select = screen.getByRole('combobox', { name: '标签' }) as HTMLSelectElement
    expect([...select.options].map(option => option.textContent)).toEqual(['全部标签', '代码', '写作'])
    const scopes = within(screen.getByRole('radiogroup', { name: '筛选' })).getAllByRole('radio')
    expect(scopes.map(scope => scope.textContent)).toEqual(['全部', '最近', '收藏'])
    await act(async () => {
      fireEvent.change(select, { target: { value: '写作' } })
      fireEvent.click(scopes[2] as HTMLElement)
      await settle()
    })
    expect(bridge.callsTo('library.list').at(-1)).toMatchObject({ tag: '写作', scope: 'favorites' })
  })
})
