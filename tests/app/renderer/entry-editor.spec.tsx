// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { redo, undo } from '@codemirror/commands'
import { EditorSelection, type Transaction } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import type { BridgeResult, EntryEditorSnapshot } from '../../../src/shared/bridge.ts'
import { EntryEditorApp } from '../../../src/app/renderer/entry-editor/App.tsx'
import { EntryEditorController } from '../../../src/app/renderer/entry-editor/controller.ts'
import { binding, config, deferred, fail, FakeBridge, installLayoutStubs, ok, settle } from './helpers.ts'

const controllers: EntryEditorController[] = []

beforeAll(installLayoutStubs)

afterEach(() => {
  cleanup()
  for (const controller of controllers.splice(0)) controller.dispose()
  document.body.removeAttribute('data-ds-dark-theme')
})

function snapshot(overrides: Partial<EntryEditorSnapshot> = {}): EntryEditorSnapshot {
  const entryBinding = overrides.binding ?? binding('写作/评审.md', '原正文', { title: '评审助手' })
  return {
    generation: 1,
    freezeId: null,
    binding: entryBinding,
    text: '原正文',
    selection: { anchor: 3, head: 3 },
    metadata: { title: entryBinding.title, tags: '', savedTags: [] },
    folders: ['写作', '代码'],
    config: config(),
    saving: false,
    error: null,
    conflict: null,
    recovered: false,
    ...overrides,
  }
}

async function mount(bridge = new FakeBridge(), initial = snapshot()): Promise<{ controller: EntryEditorController; bridge: FakeBridge }> {
  bridge.entryEditor.getState.mockResolvedValue(ok(initial))
  const controller = new EntryEditorController(bridge, 'zh')
  controllers.push(controller)
  render(<EntryEditorApp controller={controller} />)
  await act(async () => { await controller.start() })
  return { controller, bridge }
}

function type(controller: EntryEditorController, text: string): void {
  const selection = controller.editor.getSelection()
  const from = Math.min(selection.anchor, selection.head)
  const to = Math.max(selection.anchor, selection.head)
  controller.editor.dispatch({ changes: { from, to, insert: text }, selection: { anchor: from + text.length }, userEvent: 'input.type' })
}

/** 按 CodeMirror 公开用户输入入口触发；普通 dispatch 不应触发中文转换。 */
function input(controller: EntryEditorController, text: string): void {
  const view = controller.editor.view
  if (view === null) throw new Error('editor not mounted')
  const selection = view.state.selection.main
  let transaction: Transaction | undefined
  const insert = () => {
    transaction ??= view.state.update({
      changes: { from: selection.from, to: selection.to, insert: text },
      selection: EditorSelection.single(selection.from + text.length),
      userEvent: 'input.type',
    })
    return transaction
  }
  const handled = view.state.facet(EditorView.inputHandler).some(handler => handler(view, selection.from, selection.to, text, insert))
  if (!handled) view.dispatch(insert())
}

describe('独立库条目编辑窗口', () => {
  it('载入指定正文、标题与路径，保存目标明确，初始化不调用主窗口草稿或库API', async () => {
    const { controller, bridge } = await mount()
    expect(controller.editor.getText()).toBe('原正文')
    // V0.1.5：标题只在可编辑的大标题里出现一次，头部显示模式和相对路径。
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: '标题' }).value).toBe('评审助手')
    expect(screen.queryByRole('heading', { name: '评审助手' })).toBeNull()
    expect(screen.getByText('写作/评审.md')).toBeTruthy()
    expect(screen.getByText('编辑库中提示词')).toBeTruthy()
    expect(screen.getByRole('textbox', { name: '标签' }).getAttribute('placeholder')).toBe('添加标签，用逗号分隔，最多 5 个')
    expect(screen.getByRole('textbox', { name: '标签' }).getAttribute('aria-describedby')).toBe('entry-editor-tags-hint')
    expect(document.getElementById('entry-editor-tags-hint')?.textContent).toBe('用逗号分隔，最多 5 个')
    expect(screen.getByText('保存只更新当前库条目')).toBeTruthy()
    expect(screen.getByText('修改已保存').getAttribute('data-state')).toBe('saved')
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '保存修改' }).disabled).toBe(true)
    expect(screen.getByRole('button', { name: '关闭' })).toBeTruthy()
    expect(bridge.calls).toEqual([])
    expect(bridge.entryEditor.update).not.toHaveBeenCalled()
    expect(document.title).toBe('编辑 Prompt：评审助手')
  })

  it('读取前和读取失败时不可编辑，重试成功才开放', async () => {
    const bridge = new FakeBridge()
    const pending = deferred<BridgeResult<EntryEditorSnapshot>>()
    bridge.entryEditor.getState.mockReturnValueOnce(pending.promise)
    const controller = new EntryEditorController(bridge, 'zh')
    controllers.push(controller)
    render(<EntryEditorApp controller={controller} />)
    let starting!: Promise<void>
    act(() => { starting = controller.start() })
    expect(document.querySelector('.cm-content')?.getAttribute('contenteditable')).toBe('false')
    fireEvent.keyDown(window, { key: 's', metaKey: true })
    expect(bridge.entryEditor.save).not.toHaveBeenCalled()
    await act(async () => {
      pending.resolve(fail('promptx/draft/unreadable'))
      await starting
    })
    expect(screen.getByRole('alert').textContent).toContain('提示词读取失败')
    expect(document.querySelector('.cm-content')?.getAttribute('contenteditable')).toBe('false')
    bridge.entryEditor.getState.mockResolvedValue(ok(snapshot()))
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '重试' })); await settle() })
    expect(controller.editor.getText()).toBe('原正文')
    expect(document.querySelector('.cm-content')?.getAttribute('contenteditable')).toBe('true')
  })

  it('正文与光标只镜像到独立窗口通道，撤销重做照常工作', async () => {
    const { controller, bridge } = await mount()
    act(() => { type(controller, '修改') })
    expect(bridge.entryEditor.update).toHaveBeenLastCalledWith('原正文修改', { anchor: 5, head: 5 }, 1)
    expect(screen.getByText('有未保存的修改').getAttribute('data-state')).toBe('unsaved')
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '保存修改' }).disabled).toBe(false)
    act(() => { controller.editor.runCommand(undo) })
    expect(controller.editor.getText()).toBe('原正文')
    act(() => { controller.editor.runCommand(redo) })
    expect(controller.editor.getText()).toBe('原正文修改')
    expect(bridge.calls).toEqual([])
  })

  it('预填标题和多词标签，只编辑元数据也能保存，旧快照不会覆盖继续输入', async () => {
    const initial = snapshot({ metadata: { title: '评审助手', tags: 'Code Review', savedTags: ['Code Review'] } })
    const { controller, bridge } = await mount(new FakeBridge(), initial)
    const title = screen.getByRole<HTMLInputElement>('textbox', { name: '标题' })
    const tags = screen.getByRole<HTMLInputElement>('textbox', { name: /^标签/ })
    expect(title.value).toBe('评审助手')
    expect(tags.value).toBe('Code Review')
    fireEvent.change(title, { target: { value: '代码审查' } })
    fireEvent.change(tags, { target: { value: 'Code Review, 风格检查' } })
    expect(bridge.entryEditor.update).toHaveBeenLastCalledWith(
      '原正文', { anchor: 3, head: 3 }, 1, { title: '代码审查', tags: 'Code Review, 风格检查' },
    )
    expect(screen.getByText('有未保存的修改')).toBeTruthy()
    await act(async () => { await controller.save() })
    expect(bridge.entryEditor.save).toHaveBeenCalledWith(1)
    act(() => { bridge.emit('entryEditor.state', initial) })
    expect(title.value).toBe('代码审查')
    expect(tags.value).toBe('Code Review, 风格检查')
    act(() => { bridge.emit('entryEditor.state', { ...initial, freezeId: 7 }) })
    expect(title.readOnly).toBe(true)
    expect(tags.readOnly).toBe(true)
    expect(bridge.entryEditor.prepared).toHaveBeenLastCalledWith(
      7, 1, '原正文', { anchor: 3, head: 3 }, { title: '代码审查', tags: 'Code Review, 风格检查' },
    )
  })

  it('预选条目当前文件夹，只改为未分类即可保存并显示更新的路径', async () => {
    const { controller, bridge } = await mount()
    const folder = screen.getByRole<HTMLSelectElement>('combobox', { name: '文件夹' })
    const save = screen.getByRole<HTMLButtonElement>('button', { name: '保存修改' })
    expect(folder.value).toBe('写作')
    expect([...folder.options].map(option => option.textContent)).toEqual(['未分类', '写作', '代码'])
    fireEvent.change(folder, { target: { value: '' } })
    expect(save.disabled).toBe(false)
    expect(bridge.entryEditor.update).toHaveBeenLastCalledWith(
      '原正文', { anchor: 3, head: 3 }, 1, { title: '评审助手', tags: '', folder: '' },
    )
    const pending = deferred<BridgeResult<null>>()
    bridge.entryEditor.save.mockReturnValueOnce(pending.promise)
    fireEvent.click(save)
    expect(folder.disabled).toBe(true)
    expect(bridge.entryEditor.save).toHaveBeenCalledWith(1)
    await act(async () => {
      bridge.emit('entryEditor.state', snapshot({ binding: binding('评审.md', '原正文', { title: '评审助手' }) }))
      pending.resolve(ok(null))
      await settle()
    })
    expect(screen.getByText('评审.md')).toBeTruthy()
    expect(controller.editor.getText()).toBe('原正文')
    expect(folder.value).toBe('')
    expect(save.disabled).toBe(true)
  })

  it('恢复文件夹选择，目标冲突后可以换另一个目录', async () => {
    const metadata = { title: '评审助手', tags: '', savedTags: [], folder: '代码' }
    const initial = snapshot({ metadata, recovered: true, conflict: 'destinationOccupied' })
    const { bridge } = await mount(new FakeBridge(), initial)
    const folder = screen.getByRole<HTMLSelectElement>('combobox', { name: '文件夹' })
    expect(folder.value).toBe('代码')
    expect(screen.getByRole('alert').textContent).toContain('所选文件夹内已有同名文件或文件夹')
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '保存修改' }).disabled).toBe(false)
    fireEvent.change(folder, { target: { value: '写作' } })
    expect(screen.queryByRole('alert')).toBeNull()
    expect(bridge.entryEditor.update).toHaveBeenLastCalledWith('原正文', { anchor: 3, head: 3 }, 1, {
      title: '评审助手', tags: '', folder: '写作',
    })
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '保存修改' }).disabled).toBe(true)
  })

  it('正文保存后让未编辑的标题跟随旧文件的新推导标题', async () => {
    const { controller, bridge } = await mount()
    act(() => { type(controller, '修改') })
    act(() => { bridge.emit('entryEditor.state', snapshot({ saving: true })) })
    act(() => { bridge.emit('entryEditor.state', snapshot({
      binding: binding('写作/评审.md', '原正文修改', { title: '新推导标题' }),
      metadata: { title: '新推导标题', tags: '', savedTags: [] },
    })) })
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: '标题' }).value).toBe('新推导标题')
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '保存修改' }).disabled).toBe(true)
  })

  it('保存期间继续输入，旧正文的状态推送不覆盖新内容和撤销栈', async () => {
    const { controller, bridge } = await mount()
    const pending = deferred<BridgeResult<null>>()
    bridge.entryEditor.save.mockReturnValueOnce(pending.promise)
    act(() => { type(controller, 'A') })
    act(() => { fireEvent.click(screen.getByRole('button', { name: '保存修改' })) })
    expect(bridge.entryEditor.save).toHaveBeenCalledTimes(1)
    expect(bridge.entryEditor.save).toHaveBeenCalledWith(1)
    act(() => {
      bridge.emit('entryEditor.state', snapshot({ text: '原正文A', saving: true }))
      type(controller, 'B')
    })
    fireEvent.keyDown(window, { key: 's', metaKey: true })
    expect(bridge.entryEditor.save).toHaveBeenCalledTimes(1)
    expect(bridge.entryEditor.save).toHaveBeenCalledWith(1)
    await act(async () => {
      bridge.emit('entryEditor.state', snapshot({ text: '原正文A', binding: binding('写作/评审.md', '原正文A') }))
      pending.resolve(ok(null))
      await settle()
    })
    expect(controller.editor.getText()).toBe('原正文AB')
    expect(screen.getByText('有未保存的修改')).toBeTruthy()
    act(() => { controller.editor.runCommand(undo) })
    expect(controller.editor.getText()).not.toBe('')
    expect(bridge.calls).toEqual([])
  })

  it.each(['darwin', 'win32'])('保存快捷键只保存此条目，输入法组字中的快捷键放行（%s）', async (platform) => {
    const { controller, bridge } = await mount(new FakeBridge(platform))
    act(() => { type(controller, '修改') })
    const modifier = platform === 'darwin' ? { metaKey: true } : { ctrlKey: true }
    fireEvent.keyDown(window, { key: 's', ...modifier, isComposing: true })
    expect(bridge.entryEditor.save).not.toHaveBeenCalled()
    await act(async () => { fireEvent.keyDown(window, { key: 's', ...modifier }); await settle() })
    expect(bridge.entryEditor.save).toHaveBeenCalledTimes(1)
    expect(bridge.entryEditor.save).toHaveBeenCalledWith(1)
    expect(bridge.entryEditor.update).toHaveBeenLastCalledWith('原正文修改', { anchor: 5, head: 5 }, 1)
    expect(bridge.calls).toEqual([])
  })

  it('新文档代次才替换正文，晚到旧代次不回退到旧条目', async () => {
    const { controller, bridge } = await mount()
    act(() => { type(controller, '未保存') })
    act(() => {
      bridge.emit('entryEditor.state', snapshot({
        generation: 2,
        binding: binding('另一条.md', '另一条正文', { title: '另一条' }),
        text: '另一条正文',
        selection: { anchor: 0, head: 0 },
      }))
      bridge.emit('entryEditor.state', snapshot())
    })
    expect(controller.editor.getText()).toBe('另一条正文')
    expect(controller.editor.getSelection()).toEqual({ anchor: 0, head: 0 })
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: '标题' }).value).toBe('另一条')
    expect(controller.editor.runCommand(undo)).toBe(false)
  })

  it('初始化回复晚于新状态推送时，保持新文档', async () => {
    const bridge = new FakeBridge()
    const pending = deferred<BridgeResult<EntryEditorSnapshot>>()
    bridge.entryEditor.getState.mockReturnValueOnce(pending.promise)
    const controller = new EntryEditorController(bridge, 'zh')
    controllers.push(controller)
    render(<EntryEditorApp controller={controller} />)
    let starting!: Promise<void>
    act(() => { starting = controller.start() })
    await act(async () => {
      bridge.emit('entryEditor.state', snapshot({ generation: 2, text: '恢复内容', recovered: true }))
      pending.resolve(ok(snapshot()))
      await starting
    })
    expect(controller.editor.getText()).toBe('恢复内容')
    expect(screen.getByText('已恢复未完成的编辑')).toBeTruthy()
  })

  it('切换条目后操作携带新代次，旧保存回包不改变新会话', async () => {
    const { controller, bridge } = await mount()
    const pending = deferred<BridgeResult<null>>()
    bridge.entryEditor.save.mockReturnValueOnce(pending.promise)
    act(() => { type(controller, '旧改动') })
    let saving!: Promise<void>
    act(() => { saving = controller.save() })
    expect(bridge.entryEditor.save).toHaveBeenLastCalledWith(1)
    act(() => {
      bridge.emit('entryEditor.state', snapshot({
        generation: 2,
        binding: binding('新.md', '新正文', { title: '新条目' }),
        text: '新正文',
        selection: { anchor: 3, head: 3 },
      }))
      type(controller, '新改动')
    })
    expect(bridge.entryEditor.update).toHaveBeenLastCalledWith('新正文新改动', { anchor: 6, head: 6 }, 2)
    await act(async () => {
      pending.resolve(fail('promptx/channel/timeout'))
      await saving
    })
    expect(controller.editor.getText()).toBe('新正文新改动')
    expect(controller.store.getState().error).toBeNull()
    await act(async () => { await controller.save() })
    expect(bridge.entryEditor.save).toHaveBeenLastCalledWith(2)
    await act(async () => { await controller.close() })
    expect(bridge.entryEditor.close).toHaveBeenLastCalledWith(2)
  })

  it('关闭交给独立窗口确认流程，未保存正文先镜像，不隐藏主窗口', async () => {
    const { controller, bridge } = await mount()
    act(() => { type(controller, '修改') })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '关闭' })); await settle() })
    expect(bridge.entryEditor.update).toHaveBeenLastCalledWith('原正文修改', { anchor: 5, head: 5 }, 1)
    expect(bridge.entryEditor.close).toHaveBeenCalledTimes(1)
    expect(bridge.entryEditor.close).toHaveBeenCalledWith(1)
    expect(bridge.window.hide).not.toHaveBeenCalled()
    expect(controller.editor.getText()).toBe('原正文修改')
  })

  it('外部冲突显示重新载入入口，由主进程确认后的新代次替换正文', async () => {
    const { controller, bridge } = await mount()
    act(() => {
      type(controller, '修改')
      bridge.emit('entryEditor.state', snapshot({ conflict: 'modified' }))
    })
    expect(screen.getByRole('alert').textContent).toContain('文件已被外部修改')
    bridge.entryEditor.reload.mockImplementationOnce(async () => {
      bridge.emit('entryEditor.state', snapshot({ generation: 2, text: '磁盘新内容', binding: binding('写作/评审.md', '磁盘新内容') }))
      return ok(null)
    })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '重新载入' })); await settle() })
    expect(bridge.entryEditor.reload).toHaveBeenCalledTimes(1)
    expect(bridge.entryEditor.reload).toHaveBeenCalledWith(1)
    expect(controller.editor.getText()).toBe('磁盘新内容')
    expect(controller.editor.runCommand(undo)).toBe(false)
  })

  it.each(['missing', 'noFrontMatter', 'invalidFrontMatter'] as const)('冲突 %s 不提供强制覆盖，正文保持可复制', async (conflict) => {
    const { controller, bridge } = await mount()
    act(() => {
      type(controller, '修改')
      bridge.emit('entryEditor.state', snapshot({ conflict }))
    })
    expect(screen.getByRole('alert')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '重新载入' })).toBeNull()
    expect(controller.editor.getText()).toBe('原正文修改')
    expect(document.querySelector('.cm-content')?.getAttribute('contenteditable')).toBe('true')
    expect(bridge.calls).toEqual([])
  })

  it('配置热推更新语言、主题和两个转换开关，不重置正文', async () => {
    const { controller, bridge } = await mount(new FakeBridge(), snapshot({ text: '', binding: binding('a.md', '') }))
    act(() => {
      bridge.emit('config', config({ resolvedLocale: 'en', resolvedTheme: 'dark', convertMiddleDot: false, convertYen: true }))
      input(controller, '·')
      input(controller, '·')
      input(controller, '¥')
      input(controller, '￥')
    })
    expect(controller.editor.getText()).toBe('··$$')
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeTruthy()
    expect(document.body.hasAttribute('data-ds-dark-theme')).toBe(true)
    act(() => {
      bridge.emit('config', config({ convertMiddleDot: true, convertYen: false }))
      input(controller, '·')
      input(controller, '·')
      input(controller, '¥')
      input(controller, '￥')
    })
    expect(controller.editor.getText()).toBe('··$$``¥￥')
    expect(document.body.hasAttribute('data-ds-dark-theme')).toBe(false)
  })

  it('切换前冻结并回传实际最后输入，同一屏障只确认一次，冻结期间动作不可用', async () => {
    const { controller, bridge } = await mount()
    act(() => { type(controller, '最后输入') })
    act(() => { bridge.emit('entryEditor.state', snapshot({ freezeId: 7, conflict: 'modified' })) })
    expect(controller.editor.getText()).toBe('原正文最后输入')
    expect(document.querySelector('.cm-content')?.getAttribute('contenteditable')).toBe('false')
    expect(bridge.entryEditor.prepared).toHaveBeenCalledExactlyOnceWith(7, 1, '原正文最后输入', { anchor: 7, head: 7 }, { title: '评审助手', tags: '' })
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '保存修改' }).disabled).toBe(true)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '关闭' }).disabled).toBe(true)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '重新载入' }).disabled).toBe(true)
    await act(async () => {
      bridge.emit('entryEditor.state', snapshot({ freezeId: 7, saving: true }))
      await controller.save()
      await controller.reload()
      await controller.close()
    })
    expect(bridge.entryEditor.prepared).toHaveBeenCalledTimes(1)
    expect(bridge.entryEditor.save).not.toHaveBeenCalled()
    expect(bridge.entryEditor.reload).not.toHaveBeenCalled()
    expect(bridge.entryEditor.close).not.toHaveBeenCalled()
  })

  it('取消或失败解除冻结时保留原文和撤销记录，允许继续输入', async () => {
    const { controller, bridge } = await mount()
    act(() => {
      type(controller, '最后输入')
      bridge.emit('entryEditor.state', snapshot({ freezeId: 1 }))
      bridge.emit('entryEditor.state', snapshot({ freezeId: null, error: { code: 'promptx/channel/timeout' } }))
    })
    expect(controller.editor.getText()).toBe('原正文最后输入')
    expect(document.querySelector('.cm-content')?.getAttribute('contenteditable')).toBe('true')
    expect(controller.editor.hasFocus()).toBe(true)
    act(() => { controller.editor.runCommand(undo) })
    expect(controller.editor.getText()).toBe('原正文')
    act(() => { type(controller, '继续') })
    expect(bridge.entryEditor.update).toHaveBeenLastCalledWith('原正文继续', { anchor: 5, head: 5 }, 1)
  })

  it('冻结后切换成功，新代次载入并恢复编辑', async () => {
    const { controller, bridge } = await mount()
    act(() => {
      type(controller, '最后输入')
      bridge.emit('entryEditor.state', snapshot({ freezeId: 2 }))
      bridge.emit('entryEditor.state', snapshot({ generation: 2, text: 'B正文', binding: binding('B.md', 'B正文') }))
    })
    expect(bridge.entryEditor.prepared).toHaveBeenCalledExactlyOnceWith(2, 1, '原正文最后输入', { anchor: 7, head: 7 }, { title: '评审助手', tags: '' })
    expect(controller.editor.getText()).toBe('B正文')
    expect(document.querySelector('.cm-content')?.getAttribute('contenteditable')).toBe('true')
    expect(controller.editor.runCommand(undo)).toBe(false)
    act(() => { type(controller, '新修改') })
    expect(bridge.entryEditor.update).toHaveBeenLastCalledWith('B正文新修改', { anchor: 6, head: 6 }, 2)
  })

  it('初始状态带冻结屏障时确认，显式重新载入界面状态可再次确认', async () => {
    const { controller, bridge } = await mount(new FakeBridge(), snapshot({ freezeId: 9, text: '恢复中的修改' }))
    expect(document.querySelector('.cm-content')?.getAttribute('contenteditable')).toBe('false')
    expect(bridge.entryEditor.prepared).toHaveBeenCalledExactlyOnceWith(9, 1, '恢复中的修改', { anchor: 3, head: 3 }, { title: '评审助手', tags: '' })
    await act(async () => { await controller.load() })
    expect(bridge.entryEditor.prepared).toHaveBeenCalledTimes(2)
    expect(controller.editor.getText()).toBe('恢复中的修改')
  })

  it('端到端正文命令只接受指定动作，冻结时不改文档，镜像走正式通道', async () => {
    const { controller, bridge } = await mount()
    act(() => {
      bridge.emit('e2e', { id: 1, action: 'core-path', text: '不应进入子窗' })
      bridge.emit('e2e', { id: 2, action: 'entry-edit-text' })
    })
    expect(controller.editor.getText()).toBe('原正文')
    act(() => { bridge.emit('e2e', { id: 3, action: 'entry-edit-text', text: '测试编辑稿' }) })
    expect(controller.editor.getText()).toBe('测试编辑稿')
    expect(bridge.entryEditor.update).toHaveBeenLastCalledWith('测试编辑稿', { anchor: 5, head: 5 }, 1)
    act(() => {
      bridge.emit('entryEditor.state', snapshot({ freezeId: 10 }))
      bridge.emit('e2e', { id: 4, action: 'entry-edit-text', text: '冻结时不应改动' })
    })
    expect(controller.editor.getText()).toBe('测试编辑稿')
    expect(bridge.calls).toEqual([])
    expect(bridge.e2eDone).not.toHaveBeenCalled()
  })
})
