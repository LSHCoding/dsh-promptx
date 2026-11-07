// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, it, expect } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { BridgeResult } from '../../../src/shared/bridge.ts'
import type { DraftRecord } from '../../../src/shared/types.ts'
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
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '重试' }))
      await settle()
    })
    expect(editorContent().getAttribute('contenteditable')).toBe('true')
    expect(editorContent().textContent).toBe('恢复了')
  })
})

describe('工具栏（需求 5.3、S-02）', () => {
  it('左组 库、保存、优化、清空；右组 设置、关闭；悬停提示带当前快捷键', async () => {
    const bridge = new FakeBridge()
    bridge.handle('draft.load', () => ok({ record: draftRecord('有内容') }))
    await mountApp(bridge)
    const bar = within(toolbar())
    const tip = (name: string) => bar.getByRole('button', { name }).getAttribute('data-tip')
    expect(tip('库')).toBe('库（⌘L）')
    expect(tip('保存')).toBe('保存（⌘S）')
    expect(tip('优化')).toBe('优化（⇧⌘O）')
    expect(tip('清空')).toBe('清空')
    expect(tip('设置')).toBe('设置')
    expect(tip('关闭')).toBe('关闭（Esc）')
    expect(bar.queryByRole('button', { name: '会话' })).toBeNull()
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

  it('有会话时出现「会话」；进行中「优化」变成「停止」', async () => {
    const bridge = new FakeBridge()
    bridge.handle('optimize.state', () => ok({ session: session('s1', [round('r1')]) }))
    await mountApp(bridge)
    const bar = within(toolbar())
    expect(bar.getByRole('button', { name: '会话' }).getAttribute('aria-pressed')).toBe('false')
    expect(bar.getByRole('button', { name: '停止' })).toBeTruthy()
    expect(bar.queryByRole('button', { name: '优化' })).toBeNull()
  })

  it('点「关闭」隐藏小窗；点按钮不抢编辑区的焦点', async () => {
    const bridge = new FakeBridge()
    await mountApp(bridge)
    const close = within(toolbar()).getByRole('button', { name: '关闭' })
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

  it('⌘L：编辑区里按展开侧栏、焦点进搜索框；侧栏里再按收起、焦点回到编辑区', async () => {
    const bridge = new FakeBridge()
    bridge.handle('library.list', () => ok(listResult([entry('a.md')])))
    await mountApp(bridge)
    editorContent().focus()
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
    expect(screen.getByText('选择一个 Prompt 查看内容')).toBeTruthy()
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

  it('库目录不可用：说明原因和「打开插件配置」，编辑照常可用（L-01）', async () => {
    const bridge = new FakeBridge()
    bridge.handle('library.list', () => ok(listResult([], { state: 'unavailable', error: { code: 'promptx/library/unavailable', detail: 'EACCES: permission denied' } })))
    const controller = await mountApp(bridge)
    await act(async () => {
      await controller.library.open()
    })
    expect(screen.getByText('库目录不可用：没有权限')).toBeTruthy()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '打开插件配置' }))
      await settle()
    })
    expect(bridge.window.openSettings).toHaveBeenCalledTimes(1)
    expect(editorContent().getAttribute('contenteditable')).toBe('true')
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

  it('选中一条：预览显示完整正文，「插入到光标」插进编辑区', async () => {
    const bridge = new FakeBridge()
    const meta = entry('a.md', { title: '模板' })
    bridge.handle('library.list', () => ok(listResult([meta])))
    bridge.handle('library.read', () => ok(readResult(meta, '# 写作助手\n\n要求')))
    const controller = await mountApp(bridge)
    await act(async () => {
      await controller.library.open()
    })
    await act(async () => {
      fireEvent.click(rows()[0] as HTMLElement)
      await settle()
    })
    expect(document.querySelector('.px-preview-text')?.textContent).toBe('# 写作助手\n\n要求')
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '插入到光标' }))
      await settle()
    })
    expect(controller.editor.getText()).toBe('# 写作助手\n\n要求')
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
