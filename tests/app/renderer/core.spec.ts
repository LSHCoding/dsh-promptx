import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest'
import { undo } from '@codemirror/commands'
import type { AppController } from '../../../src/app/renderer/controller/app.ts'
import { SUCCESS_TOAST_MS } from '../../../src/app/renderer/controller/toasts.ts'
import { DEFAULT_TOOLBAR_SHORTCUTS } from '../../../src/shared/window-shortcuts.ts'
import {
  binding,
  chooseDialog,
  confirmSaveForm,
  config,
  draftRecord,
  entry,
  fail,
  FakeBridge,
  keyEvent,
  listResult,
  ok,
  openDialog,
  round,
  saveAndConfirm,
  session,
  settle,
  startController,
  toastText,
  trapUnhandled,
  type,
} from './helpers.ts'

let checkUnhandled: () => void
const controllers: AppController[] = []

beforeEach(() => {
  vi.useFakeTimers()
  checkUnhandled = trapUnhandled()
})

afterEach(() => {
  for (const controller of controllers.splice(0)) controller.dispose()
  vi.useRealTimers()
  checkUnhandled()
})

async function start(bridge: FakeBridge): Promise<AppController> {
  const controller = await startController(bridge)
  controllers.push(controller)
  return controller
}

describe('复制并隐藏（F-03）', () => {
  it('草稿为空或只有空白：不复制、不隐藏，提示「没有可复制的内容。」', async () => {
    const bridge = new FakeBridge()
    const controller = await start(bridge)
    type(controller, ' \n\t ')
    const outcome = await controller.copyAndHide()
    expect(outcome.ok).toBe(false)
    expect(bridge.window.copyAndHide).not.toHaveBeenCalled()
    expect(bridge.window.hide).not.toHaveBeenCalled()
    expect(controller.store.getState().toast).toMatchObject({ kind: 'error', text: '没有可复制的内容。' })
  })

  it('复制全文原样（首尾空白和换行都不动），提示「已复制。」', async () => {
    const bridge = new FakeBridge()
    const controller = await start(bridge)
    const text = '\n  # 标题\n\n- 第一项\n    - 子项\n\n'
    type(controller, text)
    const outcome = await controller.copyAndHide()
    expect(outcome.ok).toBe(true)
    expect(bridge.window.copyAndHide).toHaveBeenCalledWith(text)
    expect(toastText(controller)).toBe('已复制。')
    // 复制后草稿留在编辑区（F-03）。
    expect(controller.editor.getText()).toBe(text)
  })

  it('写剪贴板失败：提示「复制失败：{原因}」，草稿不变（隐藏由主进程在写入成功后才做）', async () => {
    const bridge = new FakeBridge()
    bridge.window.copyAndHide.mockResolvedValueOnce(fail('promptx/clipboard/write-failed'))
    const controller = await start(bridge)
    type(controller, '内容')
    const outcome = await controller.copyAndHide()
    expect(outcome).toEqual({ ok: false, error: { code: 'promptx/clipboard/write-failed' } })
    expect(controller.store.getState().toast).toMatchObject({ kind: 'error', text: '复制失败：写入剪贴板失败' })
    expect(controller.editor.getText()).toBe('内容')
    expect(bridge.window.hide).not.toHaveBeenCalled()
  })

  it('剪贴板读回不一致：提示自己的原因，不露出 read-back mismatch（审查 CR-04）', async () => {
    const bridge = new FakeBridge()
    bridge.window.copyAndHide.mockResolvedValueOnce(fail('promptx/clipboard/write-failed', 'read-back mismatch'))
    const controller = await start(bridge)
    type(controller, '内容')
    expect((await controller.copyAndHide()).ok).toBe(false)
    // 修复前：「复制失败：写入剪贴板失败（read-back mismatch）」。
    expect(toastText(controller)).toBe('复制失败：剪贴板里读回的内容和要复制的不一致，可能被剪贴板工具改写了')
  })

  it('⌘↩ 触发复制并隐藏；Windows 上是 Ctrl+Enter', async () => {
    const mac = new FakeBridge('darwin')
    const controller = await start(mac)
    type(controller, '正文')
    const event = keyEvent({ key: 'Enter', metaKey: true })
    controller.handleKeydown(event)
    await settle()
    expect(event.defaultPrevented).toBe(true)
    expect(mac.window.copyAndHide).toHaveBeenCalledWith('正文')

    const win = new FakeBridge('win32')
    const other = await start(win)
    type(other, '正文')
    other.handleKeydown(keyEvent({ key: 'Enter', ctrlKey: true }))
    await settle()
    expect(win.window.copyAndHide).toHaveBeenCalledWith('正文')
  })

  it('有会话时 ⌘↩ 复制的也是编辑区内容，不会发起新一轮（F-03，审查 COV-04）', async () => {
    const bridge = new FakeBridge()
    bridge.handle('optimize.state', () => ok({ session: session('s1', [round('r1', { status: 'done', reply: 'r', input: '编辑区' })]) }))
    const controller = await start(bridge)
    type(controller, '编辑区')
    controller.optimize.setFollowup('再精简一些')
    controller.handleKeydown(keyEvent({ key: 'Enter', metaKey: true }))
    await settle()
    expect(bridge.window.copyAndHide).toHaveBeenCalledWith('编辑区')
    expect(bridge.callsTo('optimize.followup')).toEqual([])
    expect(controller.store.getState().optimize.followup).toBe('再精简一些')
  })

  it('输入法组字中的按键一律交给输入法（keyCode 229 或 isComposing）', async () => {
    const bridge = new FakeBridge()
    const controller = await start(bridge)
    type(controller, '正文')
    for (const event of [keyEvent({ key: 'Enter', metaKey: true, keyCode: 229 }), keyEvent({ key: 'Escape', isComposing: true })]) {
      controller.handleKeydown(event)
      expect(event.defaultPrevented).toBe(false)
    }
    await settle()
    expect(bridge.window.copyAndHide).not.toHaveBeenCalled()
    expect(bridge.window.hide).not.toHaveBeenCalled()
  })
})

describe('隐藏（F-01）', () => {
  it('Esc 先关打开的菜单，没有菜单时才隐藏小窗', async () => {
    const bridge = new FakeBridge()
    const controller = await start(bridge)
    controller.openMenu('entry:a.md', { left: 0, top: 0, right: 10, bottom: 10 })
    controller.handleKeydown(keyEvent({ key: 'Escape' }))
    await settle()
    expect(controller.store.getState().menu).toBeNull()
    expect(bridge.window.hide).not.toHaveBeenCalled()
    controller.handleKeydown(keyEvent({ key: 'Escape' }))
    await settle()
    expect(bridge.window.hide).toHaveBeenCalledTimes(1)
  })

  it('对话框打开时 Esc 等于对话框的取消，不隐藏小窗', async () => {
    const bridge = new FakeBridge()
    const controller = await start(bridge)
    const choice = controller.dialogs.open({
      title: 't',
      buttons: [{ id: 'cancel', label: '取消' }, { id: 'ok', label: '确定' }],
      defaultButton: 'ok',
      escapeButton: 'cancel',
    })
    controller.handleKeydown(keyEvent({ key: 'Escape' }))
    expect(await choice).toEqual({ button: 'cancel' })
    expect(bridge.window.hide).not.toHaveBeenCalled()
  })

  it('对话框打开时其他快捷键都不生效', async () => {
    const bridge = new FakeBridge()
    const controller = await start(bridge)
    type(controller, '正文')
    const pending = controller.dialogs.open({ title: 't', buttons: [{ id: 'cancel', label: '取消' }], defaultButton: 'cancel', escapeButton: 'cancel' })
    controller.handleKeydown(keyEvent({ key: 'Enter', metaKey: true }))
    controller.handleKeydown(keyEvent({ key: 's', code: 'KeyS', metaKey: true }))
    await settle()
    expect(bridge.window.copyAndHide).not.toHaveBeenCalled()
    expect(bridge.callsTo('library.save')).toEqual([])
    controller.escapeDialog()
    await pending
  })

  it('隐藏不清空草稿、撤销记录，不改变侧栏和会话栏的开合，不打断进行中的优化', async () => {
    const bridge = new FakeBridge()
    bridge.handle('optimize.state', () => ok({ session: session('s1', [round('r1')]) }))
    const controller = await start(bridge)
    await controller.library.open()
    type(controller, 'abc')
    await controller.hide()
    bridge.emit('window.hidden', {})
    await settle()
    expect(controller.editor.getText()).toBe('abc')
    expect(controller.store.getState().library.open).toBe(true)
    expect(controller.store.getState().optimize.session?.rounds[0]?.status).toBe('running')
    expect(bridge.callsTo('optimize.cancel')).toEqual([])
    expect(controller.editor.runCommand(undo)).toBe(true)
    expect(controller.editor.getText()).toBe('')
  })

  it('呼出时焦点给编辑区；对话框还开着时留在对话框里', async () => {
    const bridge = new FakeBridge()
    const controller = await start(bridge)
    const focus = vi.spyOn(controller.editor, 'focus')
    bridge.emit('window.shown', {})
    expect(focus).toHaveBeenCalledTimes(1)
    const pending = controller.dialogs.open({ title: 't', buttons: [{ id: 'cancel', label: '取消' }], defaultButton: 'cancel', escapeButton: 'cancel' })
    bridge.emit('window.shown', {})
    expect(focus).toHaveBeenCalledTimes(1)
    controller.escapeDialog()
    await pending
  })
})

describe('清空（E-04）', () => {
  it('一步可以撤销；撤销恢复内容但不恢复绑定；库文件不受影响', async () => {
    const bridge = new FakeBridge()
    bridge.handle('draft.load', () => ok({ record: draftRecord('库里的正文', { binding: binding('代码审查.md', '库里的正文', { title: '代码审查' }) }) }))
    const controller = await start(bridge)
    type(controller, '，加一句')
    controller.clear()
    expect(controller.editor.getText()).toBe('')
    expect(controller.store.getState().draft.binding).toBeNull()
    expect(toastText(controller)).toBe('已清空编辑器。')
    expect(bridge.callsTo('library.save')).toEqual([])

    expect(controller.editor.runCommand(undo)).toBe(true)
    expect(controller.editor.getText()).toBe('库里的正文，加一句')
    expect(controller.store.getState().draft.binding).toBeNull()
    await vi.advanceTimersByTimeAsync(200)
    expect(controller.store.getState().editor.status).toBe('unsaved')
  })

  it('没有绑定时提示「已清空编辑器。」；草稿已经为空时什么都不做', async () => {
    const bridge = new FakeBridge()
    const controller = await start(bridge)
    controller.clear()
    expect(controller.store.getState().toast).toBeNull()
    type(controller, 'abc')
    controller.clear()
    expect(toastText(controller)).toBe('已清空编辑器。')
  })

  it('清空后保存会新建文件，原条目不变（E-04 验收）', async () => {
    const bridge = new FakeBridge()
    bridge.handle('draft.load', () => ok({ record: draftRecord('旧', { binding: binding('old.md', '旧') }) }))
    bridge.handle('library.save', params => ok({
      kind: 'saved',
      binding: binding('new.md', params.text),
      entry: entry('new.md'),
      created: true,
    }))
    const controller = await start(bridge)
    controller.clear()
    type(controller, '新内容')
    await saveAndConfirm(controller)
    const [params] = bridge.callsTo('library.save')
    expect(params?.binding).toBeNull()
    expect(params?.text).toBe('新内容')
    expect(controller.store.getState().draft.binding).toBeNull()
  })
})

describe('底栏提示的时长（E-03）', () => {
  it('成功类约 2 秒后消失', async () => {
    const bridge = new FakeBridge()
    const controller = await start(bridge)
    controller.toasts.success('好了')
    await vi.advanceTimersByTimeAsync(SUCCESS_TOAST_MS - 1)
    expect(toastText(controller)).toBe('好了')
    await vi.advanceTimersByTimeAsync(1)
    expect(controller.store.getState().toast).toBeNull()
  })

  it('错误类一直显示，直到下一次操作或用户关掉', async () => {
    const bridge = new FakeBridge()
    const controller = await start(bridge)
    controller.toasts.error('出错了')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(toastText(controller)).toBe('出错了')

    // 下一次操作：打开侧栏
    await controller.library.toggle()
    expect(controller.store.getState().toast).toBeNull()

    controller.toasts.error('又出错了')
    const id = controller.store.getState().toast?.id ?? -1
    controller.dismissToast(id + 1)
    expect(toastText(controller)).toBe('又出错了')
    controller.dismissToast(id)
    expect(controller.store.getState().toast).toBeNull()
  })

  it('新提示替换旧提示；旧的成功提示的计时不会关掉新的', async () => {
    const bridge = new FakeBridge()
    const controller = await start(bridge)
    controller.toasts.success('第一条')
    await vi.advanceTimersByTimeAsync(1500)
    controller.toasts.success('第二条')
    await vi.advanceTimersByTimeAsync(1000)
    expect(toastText(controller)).toBe('第二条')
    await vi.advanceTimersByTimeAsync(1000)
    expect(controller.store.getState().toast).toBeNull()
  })
})

describe('其他窗口级快捷键（技术方案 5.5）', () => {
  it('运行中更新设置后，快捷键触发清空、聊天、设置及关闭工具栏动作', async () => {
    const bridge = new FakeBridge()
    const controller = await start(bridge)
    bridge.emit('config', config({
      windowShortcuts: {
        ...DEFAULT_TOOLBAR_SHORTCUTS,
        shortcutClear: 'Command+K',
        shortcutChat: 'Command+J',
        shortcutSettings: 'Command+,',
        shortcutClose: 'Command+W',
      },
    }))
    type(controller, '正文')
    controller.handleKeydown(keyEvent({ key: 'k', code: 'KeyK', metaKey: true }))
    expect(controller.editor.getText()).toBe('')
    controller.handleKeydown(keyEvent({ key: 'j', code: 'KeyJ', metaKey: true }))
    await controller.layout.settled()
    expect(controller.store.getState().optimize.paneOpen).toBe(true)
    controller.handleKeydown(keyEvent({ key: ',', code: 'Comma', metaKey: true }))
    await settle()
    expect(bridge.window.openSettings).toHaveBeenCalledOnce()
    controller.handleKeydown(keyEvent({ key: 'Escape' }))
    expect(bridge.window.hide).not.toHaveBeenCalled()
    controller.handleKeydown(keyEvent({ key: 'w', code: 'KeyW', metaKey: true }))
    await settle()
    expect(bridge.window.hide).toHaveBeenCalledOnce()
  })

  it('⌘S 保存到库', async () => {
    const bridge = new FakeBridge()
    bridge.handle('library.save', params => ok({ kind: 'saved', binding: binding('a.md', params.text), entry: entry('a.md'), created: true }))
    const controller = await start(bridge)
    type(controller, '正文')
    controller.handleKeydown(keyEvent({ key: 's', code: 'KeyS', metaKey: true }))
    await confirmSaveForm(controller)
    await settle()
    expect(bridge.callsTo('library.save')).toHaveLength(1)
  })

  it('⌘L 展开侧栏并请求把焦点放进搜索框', async () => {
    const bridge = new FakeBridge()
    bridge.handle('library.list', () => ok(listResult([entry('a.md')])))
    const controller = await start(bridge)
    controller.handleKeydown(keyEvent({ key: 'l', code: 'KeyL', metaKey: true }))
    await settle()
    await controller.layout.settled()
    await settle()
    const state = controller.store.getState()
    expect(state.library.open).toBe(true)
    expect(state.focus?.target).toBe('search')
    expect(bridge.callsTo('library.list').at(-1)?.refresh).toBe(true)
  })

  it('⇧⌘O 发起优化，进行中再按一次是取消', async () => {
    const bridge = new FakeBridge()
    bridge.handle('optimize.start', params => ok({ session: session('s1', [round('r1', { input: params.text })]) }))
    bridge.handle('optimize.cancel', () => ok({ session: session('s1', [round('r1', { status: 'cancelled' })]) }))
    const controller = await start(bridge)
    type(controller, '草稿')
    controller.handleKeydown(keyEvent({ key: 'O', code: 'KeyO', metaKey: true, shiftKey: true }))
    await settle()
    await controller.layout.settled()
    expect(bridge.callsTo('optimize.start')).toEqual([{ text: '草稿' }])
    controller.handleKeydown(keyEvent({ key: 'O', code: 'KeyO', metaKey: true, shiftKey: true }))
    await settle()
    expect(bridge.callsTo('optimize.cancel')).toHaveLength(1)
    expect(toastText(controller)).toBe('已取消优化。')
  })
})

describe('设置', () => {
  it('打开设置窗口（V0.1.6）：可以带分区，不提示也不隐藏小窗；失败时说明原因', async () => {
    const bridge = new FakeBridge()
    const controller = await start(bridge)
    await controller.openSettings()
    expect(bridge.window.openSettings).toHaveBeenLastCalledWith(undefined)
    expect(toastText(controller)).toBeNull()
    await controller.openSettings('library')
    expect(bridge.window.openSettings).toHaveBeenLastCalledWith('library')
    expect(bridge.window.hide).not.toHaveBeenCalled()

    // 认不出原因时只说一遍，不再是「无法打开设置：设置暂时不可用」之外再重复（审查 CR-04）。
    bridge.window.openSettings.mockResolvedValueOnce(fail('promptx/settings/unavailable'))
    await controller.openSettings()
    expect(controller.store.getState().toast).toMatchObject({ kind: 'error', text: '设置暂时不可用' })
    // 别的错误码照常填进原因。
    bridge.window.openSettings.mockResolvedValueOnce(fail('promptx/channel/closed'))
    await controller.openSettings()
    expect(toastText(controller)).toBe('无法打开设置：与插件的连接已断开')
  })
})

describe('端到端测试命令', () => {
  it('core-path：写入编辑区，走真实的复制并隐藏，回复里不带正文', async () => {
    const bridge = new FakeBridge()
    await start(bridge)
    bridge.emit('e2e', { id: 5, action: 'core-path', text: '# 标题\n\n- 项\n' })
    await vi.advanceTimersByTimeAsync(10)
    expect(bridge.window.copyAndHide).toHaveBeenCalledWith('# 标题\n\n- 项\n')
    expect(bridge.callsTo('draft.save').at(-1)?.text).toBe('# 标题\n\n- 项\n')
    const [id, result] = bridge.e2eDone.mock.calls[0] ?? []
    expect(id).toBe(5)
    expect(result?.ok).toBe(true)
    expect(JSON.stringify(result?.data)).not.toContain('标题')
  })

  it('save-to-library：走真实的保存，回复耗时和相对路径', async () => {
    const bridge = new FakeBridge()
    bridge.handle('library.suggestMetadata', () => ok({ metadata: null }))
    bridge.handle('library.save', params => ok({ kind: 'saved', binding: binding('e2e.md', params.text), entry: entry('e2e.md'), created: true }))
    const controller = await start(bridge)
    type(controller, '要保存的内容')
    bridge.emit('e2e', { id: 6, action: 'save-to-library' })
    await settle()
    const [, result] = bridge.e2eDone.mock.calls[0] ?? []
    expect(result?.ok).toBe(true)
    expect(result?.data.relPath).toBe('e2e.md')
    expect(result?.data.metadataFallback).toBe(true)
    expect(bridge.callsTo('library.save')[0]?.metadata).toEqual({ title: 'E2E Prompt 6', tags: ['E2E Save'] })
    expect(typeof result?.data.ms).toBe('number')
  })

  it('typing-latency：在指定长度的草稿末尾输入一个字并计时，量完换回原来的草稿', async () => {
    const bridge = new FakeBridge()
    const controller = await start(bridge)
    type(controller, '原来的草稿')
    bridge.emit('e2e', { id: 7, action: 'typing-latency', size: 100_000 })
    await vi.advanceTimersByTimeAsync(10)
    const [id, result] = bridge.e2eDone.mock.calls[0] ?? []
    expect(id).toBe(7)
    expect(result?.ok).toBe(true)
    expect(result?.data.size).toBe(100_000)
    expect(typeof result?.data.ms).toBe('number')
    expect(controller.editor.getText()).toBe('原来的草稿')
  })

  it('state 和不认识的命令', async () => {
    const bridge = new FakeBridge()
    await start(bridge)
    bridge.emit('e2e', { id: 8, action: 'state' })
    bridge.emit('e2e', { id: 9, action: 'nope' })
    await settle()
    expect(bridge.e2eDone).toHaveBeenCalledWith(8, expect.objectContaining({ ok: true }))
    expect(bridge.e2eDone).toHaveBeenCalledWith(9, { ok: false, data: { error: 'unknown-action' } })
  })
})

describe('读取失败的原因', () => {
  it('「无法打开」的文件说明是太大还是不是 UTF-8，不把机器写法直接给用户看', async () => {
    const bridge = new FakeBridge()
    bridge.handle('library.list', () => ok(listResult([entry('big.md')])))
    bridge.handle('library.read', () => fail('promptx/library/unreadable', 'too-large'))
    const controller = await start(bridge)
    await controller.library.open()
    bridge.entryEditor.open.mockResolvedValueOnce(fail('promptx/library/unreadable', 'too-large'))
    await controller.library.openEntry('big.md')
    expect(toastText(controller)).toBe('读取失败：文件超过 2 MiB，无法打开')
    bridge.handle('library.read', () => fail('promptx/library/unreadable', 'not-utf8'))
    await controller.library.copyBody('big.md')
    expect(toastText(controller)).toBe('读取失败：文件不是 UTF-8 编码，无法打开')
    bridge.handle('library.read', () => fail('promptx/library/unreadable', 'EIO: i/o error'))
    await controller.library.copyBody('big.md')
    expect(toastText(controller)).toBe('读取失败：磁盘读写出错')
    // 库目录在列出之后变得不可用（配置被手改）：说明位置限制，不露出 library-dir-skills（审查 CR-04）。
    bridge.handle('library.read', () => fail('promptx/library/unavailable', 'library-dir-skills'))
    await controller.library.copyBody('big.md')
    expect(toastText(controller)).toBe('读取失败：库目录不能放在 dsh 的技能目录里，否则里面的 Prompt 会被当成技能读取')
  })
})

describe('对话框的排队', () => {
  it('同一时间只显示一个，后来的排队', async () => {
    const bridge = new FakeBridge()
    const controller = await start(bridge)
    const first = controller.dialogs.open({ title: '一', buttons: [{ id: 'a', label: 'A' }], defaultButton: 'a', escapeButton: 'a' })
    const second = controller.dialogs.open({ title: '二', buttons: [{ id: 'b', label: 'B' }], defaultButton: 'b', escapeButton: 'b' })
    expect(openDialog(controller).title).toBe('一')
    chooseDialog(controller, 'a')
    expect(await first).toEqual({ button: 'a' })
    expect(openDialog(controller).title).toBe('二')
    chooseDialog(controller, 'b')
    expect(await second).toEqual({ button: 'b' })
    expect(controller.store.getState().dialog).toBeNull()
  })

  it('id 对不上当前对话框的点击（重复点击）被忽略', async () => {
    const bridge = new FakeBridge()
    const controller = await start(bridge)
    const choice = controller.dialogs.open({ title: '一', buttons: [{ id: 'a', label: 'A' }], defaultButton: 'a', escapeButton: 'a' })
    const { id } = openDialog(controller)
    controller.resolveDialog(id + 1, { button: 'a' })
    expect(controller.store.getState().dialog).not.toBeNull()
    controller.resolveDialog(id, { button: 'a' })
    expect(await choice).toEqual({ button: 'a' })
  })
})
