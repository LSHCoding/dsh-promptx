import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest'
import { undo } from '@codemirror/commands'
import { DEFAULT_PREFS, type BridgeResult } from '../../../src/shared/bridge.ts'
import type {
  LibraryListResult,
  LibraryReadResult,
  MetaResult,
  RestoreResult,
  TrashEntry,
  TrashListResult,
} from '../../../src/shared/types.ts'
import type { AppController } from '../../../src/app/renderer/controller/app.ts'
import {
  binding,
  chooseDialog,
  config,
  deferred,
  draftRecord,
  entry,
  fail,
  FakeBridge,
  listResult,
  ok,
  openDialog,
  readResult,
  settle,
  startController,
  toastText,
  trapUnhandled,
  type,
  type Deferred,
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

const REVIEW = entry('代码审查.md', { title: '代码审查清单', tags: ['代码'] })
const WRITING = entry('写作/模板.md', { title: '结构化写作模板', favorite: true })

function libraryBridge(): FakeBridge {
  const bridge = new FakeBridge()
  bridge.handle('library.list', () => ok(listResult([REVIEW, WRITING], { folders: ['写作'], tags: ['代码'] })))
  bridge.handle('library.read', ({ relPath }) => {
    if (relPath === REVIEW.relPath) return ok(readResult(REVIEW, '检查边界条件。'))
    if (relPath === WRITING.relPath) return ok(readResult(WRITING, '# 写作助手\n\n要求'))
    return fail('promptx/library/not-found')
  })
  return bridge
}

describe('展开与收起（L-01、L-02）', () => {
  it('每次展开都重读一次磁盘，开合状态记进偏好', async () => {
    const bridge = libraryBridge()
    const controller = await start(bridge)
    await controller.library.toggle()
    expect(controller.store.getState().library.open).toBe(true)
    expect(bridge.callsTo('library.list').at(-1)).toMatchObject({ refresh: true, folder: { kind: 'all' }, scope: 'all', tag: null, query: '' })
    expect(bridge.storedPrefs.panes.library).toBe(true)
    await controller.library.toggle()
    expect(controller.store.getState().library.open).toBe(false)
    expect(bridge.storedPrefs.panes.library).toBe(false)
    await controller.library.toggle()
    expect(bridge.callsTo('library.list').filter(params => params.refresh)).toHaveLength(2)
  })

  it('工具栏「库」展开时和 ⌘L 一样请求把焦点放进搜索框，收起时不再请求（需求 4.3 第 1 步，审查 CR-06）', async () => {
    const bridge = libraryBridge()
    const list: Deferred<BridgeResult<LibraryListResult>> = deferred()
    bridge.handle('library.list', () => list.promise)
    const controller = await start(bridge)
    expect(controller.store.getState().focus).toBeNull()
    const opening = controller.library.toggle()
    await settle()
    // 侧栏一出现就交焦点，不等列表重读完。
    expect(controller.store.getState().library.open).toBe(true)
    expect(controller.store.getState().focus?.target).toBe('search')
    list.resolve(ok(listResult([REVIEW])))
    await opening
    const request = controller.store.getState().focus
    await controller.library.toggle()
    expect(controller.store.getState().library.open).toBe(false)
    expect(controller.store.getState().focus).toBe(request)
  })

  it('启动时按偏好恢复侧栏、文件夹、筛选和标签', async () => {
    const bridge = libraryBridge()
    bridge.storedPrefs = {
      ...DEFAULT_PREFS,
      panes: { ...DEFAULT_PREFS.panes, library: true, folderWidth: 200 },
      library: { folder: { kind: 'folder', path: '写作' }, scope: 'favorites', tag: '代码' },
    }
    const controller = await start(bridge)
    const state = controller.store.getState()
    expect(state.library.open).toBe(true)
    expect(state.panes.folderWidth).toBe(200)
    expect(bridge.callsTo('library.list')[0]).toMatchObject({ folder: { kind: 'folder', path: '写作' }, scope: 'favorites', tag: '代码', refresh: true })
    // 窗口大小是上次记下的，已经包含侧栏，不再加宽。
    expect(bridge.window.setWidth).not.toHaveBeenCalled()
  })

  it('记下的文件夹或标签已经不存在：回到「全部」「全部标签」再查一次（L-03、L-04）', async () => {
    const bridge = libraryBridge()
    bridge.storedPrefs = {
      ...DEFAULT_PREFS,
      panes: { ...DEFAULT_PREFS.panes, library: true },
      library: { folder: { kind: 'folder', path: '已删除的文件夹' }, scope: 'recent', tag: '没有的标签' },
    }
    const controller = await start(bridge)
    await settle()
    const state = controller.store.getState().library
    expect(state.folder).toEqual({ kind: 'all' })
    expect(state.tag).toBeNull()
    expect(state.scope).toBe('recent')
    expect(bridge.callsTo('library.list').at(-1)).toMatchObject({ folder: { kind: 'all' }, tag: null, refresh: false })
    expect(bridge.storedPrefs.library).toEqual({ folder: { kind: 'all' }, scope: 'recent', tag: null })
  })

  it('标签按忽略大小写比较，还在就不回退', async () => {
    const bridge = new FakeBridge()
    bridge.handle('library.list', () => ok(listResult([], { tags: ['Review'] })))
    bridge.storedPrefs = { ...DEFAULT_PREFS, panes: { ...DEFAULT_PREFS.panes, library: true }, library: { ...DEFAULT_PREFS.library, tag: 'review' } }
    const controller = await start(bridge)
    expect(controller.store.getState().library.tag).toBe('review')
  })

  it('库目录不可用或不存在时不动记下的选择', async () => {
    const bridge = new FakeBridge()
    bridge.handle('library.list', () => ok(listResult([], { state: 'unavailable', error: { code: 'promptx/library/unavailable', detail: 'EACCES' } })))
    bridge.storedPrefs = { ...DEFAULT_PREFS, panes: { ...DEFAULT_PREFS.panes, library: true }, library: { folder: { kind: 'folder', path: '写作' }, scope: 'all', tag: 'x' } }
    const controller = await start(bridge)
    expect(controller.store.getState().library.folder).toEqual({ kind: 'folder', path: '写作' })
    expect(controller.store.getState().library.list?.state).toBe('unavailable')
  })

  it('筛选、标签、文件夹的变化只查询不重读，并记进偏好；搜索边输入边查', async () => {
    const bridge = libraryBridge()
    const controller = await start(bridge)
    await controller.library.open()
    await controller.library.setScope('favorites')
    await controller.library.setTag('代码')
    await controller.library.chooseFolder({ kind: 'root' })
    controller.library.setQuery('代码 审查')
    await vi.advanceTimersByTimeAsync(100)
    const last = bridge.callsTo('library.list').at(-1)
    expect(last).toEqual({ folder: { kind: 'root' }, scope: 'favorites', tag: '代码', query: '代码 审查', refresh: false })
    expect(bridge.storedPrefs.library).toEqual({ folder: { kind: 'root' }, scope: 'favorites', tag: '代码' })
  })
})

describe('选中预览（L-05）', () => {
  it('读取中预览留空，读完显示全文', async () => {
    const bridge = libraryBridge()
    const read: Deferred<BridgeResult<LibraryReadResult>> = deferred()
    const controller = await start(bridge)
    await controller.library.open()
    bridge.handle('library.read', () => read.promise)
    const selecting = controller.library.select(REVIEW.relPath)
    await settle()
    expect(controller.store.getState().library.preview).toMatchObject({ status: 'loading', body: '' })
    read.resolve(ok(readResult(REVIEW, '完整正文'.repeat(1000))))
    await selecting
    expect(controller.store.getState().library.preview).toMatchObject({ status: 'ready', body: '完整正文'.repeat(1000) })
  })

  it('换了选中项后，旧的读取结果不覆盖新的预览', async () => {
    const bridge = libraryBridge()
    const slow: Deferred<BridgeResult<LibraryReadResult>> = deferred()
    const controller = await start(bridge)
    await controller.library.open()
    bridge.handle('library.read', ({ relPath }) => (relPath === REVIEW.relPath ? slow.promise : ok(readResult(WRITING, '写作'))))
    const first = controller.library.select(REVIEW.relPath)
    await controller.library.select(WRITING.relPath)
    slow.resolve(ok(readResult(REVIEW, '旧的')))
    await first
    expect(controller.store.getState().library.preview).toMatchObject({ relPath: WRITING.relPath, body: '写作' })
  })

  it('「无法打开」的条目不读取，直接说明原因', async () => {
    const bridge = new FakeBridge()
    const big = entry('big.md', { status: 'unreadable', unreadableReason: 'too-large' })
    bridge.handle('library.list', () => ok(listResult([big])))
    const controller = await start(bridge)
    await controller.library.open()
    await controller.library.select('big.md')
    expect(bridge.callsTo('library.read')).toEqual([])
    expect(controller.store.getState().library.preview).toMatchObject({ status: 'error', error: { code: 'promptx/library/unreadable', detail: 'too-large' } })
  })
})

describe('插入到光标（L-06）', () => {
  async function ready(): Promise<{ bridge: FakeBridge; controller: AppController }> {
    const bridge = libraryBridge()
    const controller = await start(bridge)
    await controller.library.open()
    await controller.library.select(REVIEW.relPath)
    return { bridge, controller }
  }

  it('在文字中间插入：前后各隔一个空行，一步可以撤销，绑定不变', async () => {
    const { controller } = await ready()
    type(controller, '前文后文')
    controller.editor.dispatch({ selection: { anchor: 2 } })
    await controller.library.insertSelected()
    expect(controller.editor.getText()).toBe('前文\n\n检查边界条件。\n\n后文')
    expect(controller.editor.getSelection().head).toBe('前文\n\n检查边界条件。'.length)
    expect(toastText(controller)).toBe('已插入：代码审查清单')
    expect(controller.store.getState().draft.binding).toBeNull()
    expect(controller.editor.runCommand(undo)).toBe(true)
    expect(controller.editor.getText()).toBe('前文后文')
  })

  it('有选区时替换选区', async () => {
    const { controller } = await ready()
    type(controller, 'AXXB')
    controller.editor.dispatch({ selection: { anchor: 1, head: 3 } })
    await controller.library.insertSelected()
    expect(controller.editor.getText()).toBe('A\n\n检查边界条件。\n\nB')
  })

  it('正文为空：不插入，提示「《标题》没有正文可插入。」', async () => {
    const { bridge, controller } = await ready()
    bridge.handle('library.read', () => ok(readResult(REVIEW, '  \n ')))
    type(controller, '原文')
    await controller.library.insertSelected()
    expect(controller.editor.getText()).toBe('原文')
    expect(controller.store.getState().toast).toMatchObject({ kind: 'error', text: '《代码审查清单》没有正文可插入。' })
  })

  it.each([
    ['换了选中项', async (controller: AppController) => { await controller.library.select(WRITING.relPath) }],
    ['收起了侧栏', async (controller: AppController) => { await controller.library.close() }],
    ['隐藏了小窗', async (_controller: AppController, bridge: FakeBridge) => { bridge.emit('window.hidden', {}) }],
  ] as const)('正文读取完成前%s：这次插入作废，编辑区不变', async (_name, interrupt) => {
    const { bridge, controller } = await ready()
    const read: Deferred<BridgeResult<LibraryReadResult>> = deferred()
    bridge.handle('library.read', ({ relPath }) => (relPath === REVIEW.relPath ? read.promise : ok(readResult(WRITING, '写作'))))
    type(controller, '原文')
    const inserting = controller.library.insertSelected()
    await settle()
    await interrupt(controller, bridge)
    read.resolve(ok(readResult(REVIEW, '迟到的正文')))
    await inserting
    expect(controller.editor.getText()).toBe('原文')
  })

  it('为会话栏腾地方收起了侧栏：插入同样作废', async () => {
    const { bridge, controller } = await ready()
    bridge.bounds = { x: 0, y: 0, width: 980, height: 600, workArea: { x: 0, y: 0, width: 980, height: 800 } }
    const read: Deferred<BridgeResult<LibraryReadResult>> = deferred()
    bridge.handle('library.read', () => read.promise)
    const inserting = controller.library.insertSelected()
    await settle()
    await controller.layout.open('session')
    expect(controller.store.getState().library.open).toBe(false)
    read.resolve(ok(readResult(REVIEW, '迟到的正文')))
    await inserting
    expect(controller.editor.getText()).toBe('')
  })
})

describe('在独立编辑窗口中打开（v0.1.1）', () => {
  it('打开库条目不替换主草稿，保留选区与撤销历史，也不发主窗口保存', async () => {
    const bridge = libraryBridge()
    const controller = await start(bridge)
    type(controller, '主窗口草稿')
    controller.editor.dispatch({ selection: { anchor: 1, head: 3 } })
    const selection = controller.editor.getSelection()
    await controller.library.openEntry(REVIEW.relPath)
    expect(bridge.entryEditor.open).toHaveBeenCalledWith(REVIEW.relPath)
    expect(controller.store.getState().dialog).toBeNull()
    expect(controller.editor.getText()).toBe('主窗口草稿')
    expect(controller.editor.getSelection()).toEqual(selection)
    expect(controller.draft.binding).toBeNull()
    expect(bridge.callsTo('library.save')).toEqual([])
    expect(bridge.callsTo('library.read')).toEqual([])
    expect(controller.editor.runCommand(undo)).toBe(true)
    expect(controller.editor.getText()).toBe('')
  })

  it('打开请求在途时主窗口继续输入，返回后不覆盖新内容', async () => {
    const bridge = libraryBridge()
    const pending = deferred<BridgeResult<null>>()
    bridge.entryEditor.open.mockReturnValueOnce(pending.promise)
    const controller = await start(bridge)
    type(controller, 'A')
    const opening = controller.library.openEntry(REVIEW.relPath)
    type(controller, 'B')
    pending.resolve(ok(null))
    await opening
    expect(controller.editor.getText()).toBe('AB')
    expect(controller.draft.binding).toBeNull()
    expect(bridge.callsTo('library.save')).toEqual([])
  })

  it('独立窗口打开失败时主草稿仍在，显示可读原因', async () => {
    const bridge = libraryBridge()
    bridge.entryEditor.open.mockResolvedValueOnce(fail('promptx/library/unreadable', 'not-utf8'))
    const controller = await start(bridge)
    type(controller, '草稿')
    await controller.library.openEntry(REVIEW.relPath)
    expect(controller.editor.getText()).toBe('草稿')
    expect(toastText(controller)).toBe('读取失败：文件不是 UTF-8 编码，无法打开')
  })

  it('已知不可读条目不调用窗口打开', async () => {
    const bridge = libraryBridge()
    bridge.handle('library.list', () => ok(listResult([entry('bad.md', { status: 'unreadable' })])))
    const controller = await start(bridge)
    await controller.library.open()
    await controller.library.openEntry('bad.md')
    expect(bridge.entryEditor.open).not.toHaveBeenCalled()
  })
})

describe('重命名、标签与收藏（L-09、L-10）', () => {
  function metaResult(before: string, after: string, title = REVIEW.title): BridgeResult<MetaResult> {
    return ok({ kind: 'saved', entry: { ...REVIEW, title }, before: { sha256: before, size: 10 }, after: { sha256: after, size: 12 } })
  }

  it('对话框带当前标题和标签；保存时整理标签，只改元数据', async () => {
    const bridge = libraryBridge()
    bridge.handle('library.updateMeta', () => metaResult('x', 'y', '新标题'))
    const controller = await start(bridge)
    await controller.library.open()
    const renaming = controller.library.rename(REVIEW.relPath)
    await settle()
    const dialog = openDialog(controller)
    expect(dialog.title).toBe('重命名 / 标签')
    expect(dialog.form).toEqual({ title: '代码审查清单', tags: '代码' })
    expect(dialog.defaultButton).toBe('save')
    controller.resolveDialog(dialog.id, { button: 'save', form: { title: '  新标题  ', tags: '写作，示例; 写作 #评审' } })
    await renaming
    expect(bridge.callsTo('library.updateMeta')).toEqual([{ relPath: REVIEW.relPath, patch: { title: '新标题', tags: ['写作', '示例', '评审'] }, addFrontMatter: false }])
    expect(toastText(controller)).toBe('已更新标题和标签。')
  })

  it('标题为空时不保存', async () => {
    const bridge = libraryBridge()
    const controller = await start(bridge)
    await controller.library.open()
    const renaming = controller.library.rename(REVIEW.relPath)
    await settle()
    controller.resolveDialog(openDialog(controller).id, { button: 'save', form: { title: '   ', tags: '' } })
    await renaming
    expect(bridge.callsTo('library.updateMeta')).toEqual([])
  })

  it('修改库元数据不建立主窗口绑定，后续保存仍为新建', async () => {
    const bridge = libraryBridge()
    bridge.handle('draft.load', () => ok({ record: draftRecord('检查边界条件。', { binding: binding(REVIEW.relPath, '检查边界条件。', { sha256: 'v0' }) }) }))
    bridge.handle('library.updateMeta', () => metaResult('v0', 'v1', '改过的标题'))
    bridge.handle('library.save', params => ok({ kind: 'saved', binding: binding('新.md', params.text), entry: entry('新.md'), created: true }))
    const controller = await start(bridge)
    await controller.library.open()
    await controller.library.toggleFavorite(REVIEW.relPath)
    expect(bridge.callsTo('library.updateMeta')[0]?.patch).toEqual({ favorite: true })
    expect(controller.draft.binding).toBeNull()
    type(controller, '再改正文')
    expect(await controller.save()).toBe('saved')
    expect(bridge.callsTo('library.save')[0]?.binding).toBeNull()
    expect(controller.editor.getText()).toBe('检查边界条件。再改正文')
  })

  it('元数据操作读到其他外部版本，也不会把主草稿保存变成更新文件', async () => {
    const bridge = libraryBridge()
    bridge.handle('draft.load', () => ok({ record: draftRecord('草稿', { binding: binding(REVIEW.relPath, '草稿', { sha256: 'v0' }) }) }))
    bridge.handle('library.updateMeta', () => metaResult('external', 'v2'))
    bridge.handle('library.save', params => ok({ kind: 'saved', binding: binding('新.md', params.text), entry: entry('新.md'), created: true }))
    const controller = await start(bridge)
    await controller.library.open()
    await controller.library.toggleFavorite(REVIEW.relPath)
    expect(controller.draft.binding).toBeNull()
    expect(await controller.save()).toBe('saved')
    expect(controller.store.getState().dialog).toBeNull()
    expect(bridge.callsTo('library.save')[0]?.binding).toBeNull()
  })

  it('修改其他条目的元数据，主草稿正文和选区不动', async () => {
    const bridge = libraryBridge()
    bridge.handle('draft.load', () => ok({ record: draftRecord('x', { selection: { anchor: 0, head: 1 }, binding: binding(WRITING.relPath, 'x') }) }))
    bridge.handle('library.updateMeta', () => metaResult('v0', 'v1'))
    const controller = await start(bridge)
    await controller.library.open()
    await controller.library.toggleFavorite(REVIEW.relPath)
    expect(controller.editor.getText()).toBe('x')
    expect(controller.editor.getSelection()).toEqual({ anchor: 0, head: 1 })
    expect(controller.draft.binding).toBeNull()
  })

  it('没有 front matter：先确认补上，确认后带 addFrontMatter 重发', async () => {
    const bridge = libraryBridge()
    bridge.handle('library.updateMeta', params => (params.addFrontMatter ? metaResult('a', 'b') : ok({ kind: 'conflict', conflict: 'noFrontMatter' })))
    const controller = await start(bridge)
    await controller.library.open()
    const favoriting = controller.library.toggleFavorite(REVIEW.relPath)
    await settle()
    const dialog = openDialog(controller)
    expect(dialog.title).toBe('为这个 Markdown 文件补上 Prompt 信息？')
    expect(dialog.defaultButton).toBe('addFrontMatter')
    chooseDialog(controller, 'addFrontMatter')
    await favoriting
    expect(bridge.callsTo('library.updateMeta').map(params => params.addFrontMatter)).toEqual([false, true])
    expect(toastText(controller)).toBe('已收藏。')
  })

  it('写入那一刻文件又变了：提示「文件已被外部修改，刷新后可以重新操作。」，按钮取消、刷新', async () => {
    const bridge = libraryBridge()
    bridge.handle('library.updateMeta', () => ok({ kind: 'conflict', conflict: 'modified' }))
    const controller = await start(bridge)
    await controller.library.open()
    const lists = bridge.callsTo('library.list').length
    const favoriting = controller.library.toggleFavorite(REVIEW.relPath)
    await settle()
    const dialog = openDialog(controller)
    expect(dialog.title).toBe('文件已被外部修改，刷新后可以重新操作。')
    expect(dialog.buttons.map(button => button.label)).toEqual(['取消', '刷新'])
    chooseDialog(controller, 'refresh')
    await favoriting
    expect(bridge.callsTo('library.list').length).toBe(lists + 1)
    expect(bridge.callsTo('library.list').at(-1)?.refresh).toBe(true)
  })

  it('元数据无法识别、标签写法认不出：提示原因，不改写', async () => {
    const bridge = libraryBridge()
    bridge.handle('library.updateMeta', () => ok({ kind: 'conflict', conflict: 'invalidFrontMatter' }))
    const controller = await start(bridge)
    await controller.library.open()
    await controller.library.toggleFavorite(REVIEW.relPath)
    expect(toastText(controller)).toBe('这个文件的 Prompt 信息无法识别，插件不会改写它，请先用其他编辑器修好。')
    bridge.handle('library.updateMeta', () => ok({ kind: 'conflict', conflict: 'unsupportedLayout' }))
    await controller.library.toggleFavorite(REVIEW.relPath)
    expect(toastText(controller)).toBe('这个文件的标签写法无法安全修改，请先用其他编辑器调整。')
  })

  it('复制正文：只写剪贴板，小窗不隐藏，草稿不变；失败时说明原因', async () => {
    const bridge = libraryBridge()
    const controller = await start(bridge)
    type(controller, '草稿')
    await controller.library.copyBody(REVIEW.relPath)
    expect(bridge.window.copyText).toHaveBeenCalledWith('检查边界条件。')
    expect(bridge.window.copyAndHide).not.toHaveBeenCalled()
    expect(bridge.window.hide).not.toHaveBeenCalled()
    expect(toastText(controller)).toBe('已复制正文。')
    expect(controller.editor.getText()).toBe('草稿')

    bridge.window.copyText.mockResolvedValueOnce(fail('promptx/clipboard/write-failed'))
    await controller.library.copyBody(REVIEW.relPath)
    expect(toastText(controller)).toBe('复制失败：写入剪贴板失败')
  })
})

describe('删除与回收站（L-11）', () => {
  it('删除前确认：默认「删除」；删除后提示并刷新列表', async () => {
    const bridge = libraryBridge()
    bridge.handle('library.delete', () => ok({ trashFile: '代码审查.md' }))
    const controller = await start(bridge)
    await controller.library.open()
    const removing = controller.library.remove(REVIEW.relPath)
    await settle()
    const dialog = openDialog(controller)
    expect(dialog.title).toBe('删除 Prompt？')
    expect(dialog.message).toBe('删除后移入回收站，可以在回收站恢复。编辑器里的内容不会改变。')
    expect(dialog.buttons.map(button => button.label)).toEqual(['取消', '删除'])
    expect(dialog.defaultButton).toBe('delete')
    chooseDialog(controller, 'delete')
    await removing
    expect(bridge.callsTo('library.delete')).toEqual([{ relPath: REVIEW.relPath }])
    expect(toastText(controller)).toBe('Prompt 已移入回收站。')
  })

  it('取消就不删；关闭「删除前确认」后不弹确认', async () => {
    const bridge = libraryBridge()
    bridge.handle('library.delete', () => ok({ trashFile: 'x.md' }))
    const controller = await start(bridge)
    const removing = controller.library.remove(REVIEW.relPath)
    await settle()
    controller.escapeDialog()
    await removing
    expect(bridge.callsTo('library.delete')).toEqual([])

    bridge.emit('config', config({ confirmDelete: false }))
    await controller.library.remove(REVIEW.relPath)
    expect(controller.store.getState().dialog).toBeNull()
    expect(bridge.callsTo('library.delete')).toHaveLength(1)
  })

  it('删除库条目不改主草稿，主窗口始终无更新绑定', async () => {
    const bridge = libraryBridge()
    bridge.configValue = config({ confirmDelete: false })
    bridge.handle('draft.load', () => ok({ record: draftRecord('正文', { binding: binding(REVIEW.relPath, '正文') }) }))
    bridge.handle('library.delete', () => ok({ trashFile: 'x.md' }))
    const controller = await start(bridge)
    await controller.library.remove(REVIEW.relPath)
    expect(controller.editor.getText()).toBe('正文')
    expect(controller.store.getState().draft.binding).toBeNull()
    await vi.advanceTimersByTimeAsync(200)
    expect(controller.store.getState().editor.status).toBe('saved')
  })

  it('移动失败：提示原因，绑定和列表不变', async () => {
    const bridge = libraryBridge()
    bridge.configValue = config({ confirmDelete: false })
    bridge.handle('draft.load', () => ok({ record: draftRecord('正文', { binding: binding(REVIEW.relPath, '正文') }) }))
    bridge.handle('library.delete', () => fail('promptx/library/move-failed', 'EPERM: operation not permitted'))
    const controller = await start(bridge)
    await controller.library.remove(REVIEW.relPath)
    expect(toastText(controller)).toBe('删除失败：没有权限')
    expect(controller.store.getState().draft.binding).toBeNull()
  })

  it('回收站：列表、预览、恢复到原位置', async () => {
    const bridge = libraryBridge()
    bridge.handle('trash.list', () => ok({ recordState: 'ok', entries: [{ file: '旧版.md', title: '旧版翻译模板', deletedAt: 1, originalPath: '写作/旧版.md' }] }))
    bridge.handle('trash.read', () => ok({ entry: { file: '旧版.md', title: '旧版翻译模板', deletedAt: 1, originalPath: '写作/旧版.md' }, body: '# 翻译' }))
    bridge.handle('trash.restore', () => ok({ kind: 'restored', relPath: '写作/旧版.md' }))
    const controller = await start(bridge)
    await controller.library.open()
    await controller.library.chooseFolder({ kind: 'trash' })
    expect(controller.store.getState().library.view).toBe('trash')
    await controller.library.selectTrash('旧版.md')
    expect(controller.store.getState().library.trashPreview).toMatchObject({ status: 'ready', body: '# 翻译' })
    await controller.library.restore('旧版.md')
    expect(bridge.callsTo('trash.restore')).toEqual([{ file: '旧版.md', target: 'original', alternative: null, acceptModified: false }])
    expect(toastText(controller)).toBe('已恢复到：写作/旧版.md')
    expect(controller.store.getState().library.trashPreview).toBeNull()
  })

  it('原位置已被占用：确认后把对话框里显示的替代路径原样带回去', async () => {
    const bridge = libraryBridge()
    bridge.handle('trash.list', () => ok({ recordState: 'ok', entries: [] }))
    bridge.handle('trash.restore', params => (params.target === 'alternative'
      ? ok({ kind: 'restored', relPath: params.alternative ?? '' })
      : ok({ kind: 'occupied', alternative: '写作/旧版-2.md' })))
    const controller = await start(bridge)
    const restoring = controller.library.restore('旧版.md')
    await settle()
    const dialog = openDialog(controller)
    expect(dialog.title).toBe('原路径已被占用')
    expect(dialog.message).toBe('将恢复到：写作/旧版-2.md。原位置的文件不会被覆盖。')
    expect(dialog.buttons.map(button => button.label)).toEqual(['取消', '恢复到替代路径'])
    chooseDialog(controller, 'alternative')
    await restoring
    expect(bridge.callsTo('trash.restore')[1]).toEqual({ file: '旧版.md', target: 'alternative', alternative: '写作/旧版-2.md', acceptModified: false })
    expect(toastText(controller)).toBe('已恢复到：写作/旧版-2.md')
  })

  it('回收站里的文件删除后被改过：刷新列表并提示，确认后仍可恢复', async () => {
    const bridge = libraryBridge()
    bridge.handle('trash.list', () => ok({ recordState: 'ok', entries: [] }))
    bridge.handle('trash.restore', params => (params.acceptModified ? ok({ kind: 'restored', relPath: 'a.md' }) : ok({ kind: 'modified' })))
    const controller = await start(bridge)
    const restoring = controller.library.restore('a.md')
    await settle()
    expect(bridge.callsTo('trash.list')).toHaveLength(1)
    expect(openDialog(controller).title).toBe('回收站里的文件在删除后被修改过')
    chooseDialog(controller, 'restore')
    await restoring
    expect(bridge.callsTo('trash.restore')[1]?.acceptModified).toBe(true)
  })

  it('回收站里的文件已经不在：提示并刷新列表', async () => {
    const bridge = libraryBridge()
    bridge.handle('trash.list', () => ok({ recordState: 'ok', entries: [] }))
    bridge.handle('trash.restore', () => ok({ kind: 'missing' }))
    const controller = await start(bridge)
    await controller.library.restore('a.md')
    expect(toastText(controller)).toBe('回收站里已经没有这个文件，列表已刷新。')
    expect(bridge.callsTo('trash.list')).toHaveLength(1)
  })

  it('回收站里的搜索查回收站', async () => {
    const bridge = libraryBridge()
    bridge.handle('trash.list', () => ok({ recordState: 'unreadable', entries: [] }))
    const controller = await start(bridge)
    await controller.library.open()
    await controller.library.chooseFolder({ kind: 'trash' })
    controller.library.setQuery('翻译')
    await vi.advanceTimersByTimeAsync(100)
    expect(bridge.callsTo('trash.list').at(-1)).toEqual({ query: '翻译' })
    expect(controller.store.getState().library.trash?.recordState).toBe('unreadable')
  })
})

describe('库目录变了（library.changed）', () => {
  it('侧栏开着时重读，清掉旧的选中和预览', async () => {
    const bridge = libraryBridge()
    const controller = await start(bridge)
    await controller.library.open()
    await controller.library.select(REVIEW.relPath)
    const lists = bridge.callsTo('library.list').length
    bridge.emit('library.changed', { libraryDir: '/new' })
    await settle()
    expect(controller.store.getState().library.selected).toBeNull()
    expect(bridge.callsTo('library.list').length).toBe(lists + 1)
    expect(bridge.callsTo('library.list').at(-1)?.refresh).toBe(true)
  })

  // 外部审查第 2 条：请求只带相对路径，插件按新的库目录解释，确认框开着时换了库，确认就会作用到另一个库里同路径的文件。

  function switchLibrary(bridge: FakeBridge): Promise<void> {
    bridge.emit('library.changed', { libraryDir: '/library-B' })
    return settle()
  }

  it('删除确认框开着时换了库目录：确认后不发删除请求，提示操作已取消', async () => {
    const bridge = libraryBridge()
    bridge.handle('library.delete', () => ok({ trashFile: '代码审查.md' }))
    const controller = await start(bridge)
    await controller.library.open()
    const removing = controller.library.remove(REVIEW.relPath)
    await settle()
    await switchLibrary(bridge)
    chooseDialog(controller, 'delete')
    await removing
    expect(bridge.callsTo('library.delete')).toEqual([])
    expect(controller.store.getState().toast).toMatchObject({ kind: 'error', text: '库目录已更换，操作已取消。' })
  })

  it('换了库目录后点「取消」：照常什么都不做，也不提示', async () => {
    const bridge = libraryBridge()
    const controller = await start(bridge)
    const removing = controller.library.remove(REVIEW.relPath)
    await settle()
    await switchLibrary(bridge)
    chooseDialog(controller, 'cancel')
    await removing
    expect(bridge.callsTo('library.delete')).toEqual([])
    expect(controller.store.getState().toast).toBeNull()
  })

  it('重命名对话框开着时换了库目录：保存后不发请求', async () => {
    const bridge = libraryBridge()
    const controller = await start(bridge)
    await controller.library.open()
    const renaming = controller.library.rename(REVIEW.relPath)
    await settle()
    await switchLibrary(bridge)
    controller.resolveDialog(openDialog(controller).id, { button: 'save', form: { title: '新标题', tags: '' } })
    await renaming
    expect(bridge.callsTo('library.updateMeta')).toEqual([])
    expect(toastText(controller)).toBe('库目录已更换，操作已取消。')
  })

  it('补 front matter 的确认框开着时换了库目录：确认后不带 addFrontMatter 重发', async () => {
    const bridge = libraryBridge()
    bridge.handle('library.updateMeta', () => ok({ kind: 'conflict', conflict: 'noFrontMatter' }))
    const controller = await start(bridge)
    await controller.library.open()
    const favoriting = controller.library.toggleFavorite(REVIEW.relPath)
    await settle()
    await switchLibrary(bridge)
    chooseDialog(controller, 'addFrontMatter')
    await favoriting
    expect(bridge.callsTo('library.updateMeta').map(params => params.addFrontMatter)).toEqual([false])
    expect(toastText(controller)).toBe('库目录已更换，操作已取消。')
  })

  it('恢复时原位置被占用、确认框开着时换了库目录：确认后不恢复到替代路径', async () => {
    const bridge = libraryBridge()
    bridge.handle('trash.list', () => ok({ recordState: 'ok', entries: [] }))
    bridge.handle('trash.restore', () => ok({ kind: 'occupied', alternative: '写作/旧版-2.md' }))
    const controller = await start(bridge)
    const restoring = controller.library.restore('旧版.md')
    await settle()
    await switchLibrary(bridge)
    chooseDialog(controller, 'alternative')
    await restoring
    expect(bridge.callsTo('trash.restore')).toHaveLength(1)
    expect(toastText(controller)).toBe('库目录已更换，操作已取消。')
  })

  it('回收站文件改过、确认框开着时换了库目录：确认后不恢复', async () => {
    const bridge = libraryBridge()
    bridge.handle('trash.list', () => ok({ recordState: 'ok', entries: [] }))
    bridge.handle('trash.restore', () => ok({ kind: 'modified' }))
    const controller = await start(bridge)
    const restoring = controller.library.restore('a.md')
    await settle()
    await switchLibrary(bridge)
    chooseDialog(controller, 'restore')
    await restoring
    expect(bridge.callsTo('trash.restore')).toHaveLength(1)
    expect(toastText(controller)).toBe('库目录已更换，操作已取消。')
  })

  it('独立窗口打开在途时换库，主草稿不动并取消旧操作提示', async () => {
    const bridge = libraryBridge()
    const pending = deferred<BridgeResult<null>>()
    bridge.entryEditor.open.mockReturnValueOnce(pending.promise)
    const controller = await start(bridge)
    type(controller, '草稿')
    const opening = controller.library.openEntry(REVIEW.relPath)
    await switchLibrary(bridge)
    pending.resolve(ok(null))
    await opening
    expect(controller.editor.getText()).toBe('草稿')
    expect(controller.draft.binding).toBeNull()
    expect(bridge.callsTo('library.save')).toEqual([])
    expect(bridge.callsTo('library.read')).toEqual([])
    expect(toastText(controller)).toBe('库目录已更换，操作已取消。')
  })

  it('库目录没换过：删除、恢复照常进行（代次只在 library.changed 时变）', async () => {
    const bridge = libraryBridge()
    bridge.handle('library.delete', () => ok({ trashFile: '代码审查.md' }))
    bridge.handle('trash.list', () => ok({ recordState: 'ok', entries: [] }))
    bridge.handle('trash.restore', params => (params.target === 'alternative'
      ? ok({ kind: 'restored', relPath: params.alternative ?? '' })
      : ok({ kind: 'occupied', alternative: '写作/旧版-2.md' })))
    const controller = await start(bridge)
    // 上一次换库之后发起的操作不受那次换库影响
    await switchLibrary(bridge)
    const removing = controller.library.remove(REVIEW.relPath)
    await settle()
    chooseDialog(controller, 'delete')
    await removing
    expect(bridge.callsTo('library.delete')).toEqual([{ relPath: REVIEW.relPath }])
    const restoring = controller.library.restore('旧版.md')
    await settle()
    chooseDialog(controller, 'alternative')
    await restoring
    expect(bridge.callsTo('trash.restore')).toHaveLength(2)
    expect(toastText(controller)).toBe('已恢复到：写作/旧版-2.md')
  })

  // 审查复核 c0、c2、c7、c8：只在确认后核对代次还不够。换库后旧库的行要是还在，从旧行发起的操作记下的已经是新代次，
  // 照样落到新库里同路径的文件上；新库第一次列出是全量扫描，慢盘上这段时间可以有几秒。

  it('换库时旧库的列表、回收站列表、选中和菜单当场清掉；新库列表回来之前，旧路径上的操作什么都不发', async () => {
    const bridge = libraryBridge()
    const controller = await start(bridge)
    await controller.library.open()
    await controller.library.select(REVIEW.relPath)
    controller.openMenu(`entry:${REVIEW.relPath}`, { left: 0, top: 0, right: 10, bottom: 10 })
    const list: Deferred<BridgeResult<LibraryListResult>> = deferred()
    bridge.handle('library.list', () => list.promise)
    bridge.emit('library.changed', { libraryDir: '/library-B' })
    await settle()
    const state = controller.store.getState()
    expect(state.library.list).toBeNull()
    expect(state.library.trash).toBeNull()
    expect(state.library.selected).toBeNull()
    expect(state.menu).toBeNull()
    await controller.library.toggleFavorite(WRITING.relPath)
    await controller.library.rename(REVIEW.relPath)
    expect(controller.store.getState().dialog).toBeNull()
    expect(bridge.callsTo('library.updateMeta')).toEqual([])
    list.resolve(ok(listResult([entry('新库.md')])))
    await settle()
    expect(controller.store.getState().library.list?.entries.map(item => item.relPath)).toEqual(['新库.md'])
  })

  it('侧栏开着、新库列表还没回来时确认删除：不发请求（代次在收到 library.changed 的那一刻就加一）', async () => {
    const bridge = libraryBridge()
    bridge.handle('library.delete', () => ok({ trashFile: '代码审查.md' }))
    const controller = await start(bridge)
    await controller.library.open()
    const removing = controller.library.remove(REVIEW.relPath)
    await settle()
    const list: Deferred<BridgeResult<LibraryListResult>> = deferred()
    bridge.handle('library.list', () => list.promise)
    bridge.emit('library.changed', { libraryDir: '/library-B' })
    await settle()
    chooseDialog(controller, 'delete')
    await settle()
    expect(bridge.callsTo('library.delete')).toEqual([])
    expect(toastText(controller)).toBe('库目录已更换，操作已取消。')
    // 先断言、再放行列表：修复退化时删除成功后要刷新列表，等的正是这个挂起的请求，先 await 会一直等到超时
    list.resolve(ok(listResult([])))
    await removing
  })

  it('侧栏收起时，换库前发出的列表查询在换库后才回来：不把旧库的列表放回去', async () => {
    const bridge = libraryBridge()
    const controller = await start(bridge)
    const old: Deferred<BridgeResult<LibraryListResult>> = deferred()
    bridge.handle('library.list', () => old.promise)
    const refreshing = controller.library.refresh(false)
    await settle()
    bridge.emit('library.changed', { libraryDir: '/library-B' })
    await settle()
    old.resolve(ok(listResult([REVIEW, WRITING])))
    await refreshing
    expect(controller.store.getState().library.list).toBeNull()
  })

  it('回收站视图里换库：旧的回收站列表清掉，点旧文件不读取', async () => {
    const bridge = libraryBridge()
    const old = { file: '旧版.md', title: '旧版', deletedAt: 1, originalPath: '旧版.md' }
    bridge.handle('trash.list', () => ok({ recordState: 'ok', entries: [old] }))
    bridge.handle('trash.read', () => ok({ entry: old, body: '# 旧' }))
    const controller = await start(bridge)
    await controller.library.open()
    await controller.library.chooseFolder({ kind: 'trash' })
    expect(controller.store.getState().library.trash?.entries).toHaveLength(1)
    const trash: Deferred<BridgeResult<TrashListResult>> = deferred()
    bridge.handle('trash.list', () => trash.promise)
    bridge.emit('library.changed', { libraryDir: '/library-B' })
    await settle()
    expect(controller.store.getState().library.trash).toBeNull()
    await controller.library.selectTrash('旧版.md')
    expect(bridge.callsTo('trash.read')).toEqual([])
    trash.resolve(ok({ recordState: 'ok', entries: [] }))
    await settle()
    expect(controller.store.getState().library.trash?.entries).toEqual([])
  })

  // 外部审查第二轮复核：换库时清掉的每一项都要有测试守着，晚到的旧结果不能放回来，也不能改新库的状态。

  const OLD_TRASH: TrashEntry = { file: '旧版.md', title: '旧版', deletedAt: 1, originalPath: '旧版.md' }

  it('回收站视图里换库：文件夹栏要用的列表一起读回来（侧栏开着、收起后再展开都一样）', async () => {
    const bridge = libraryBridge()
    bridge.handle('trash.list', () => ok({ recordState: 'ok', entries: [] }))
    const controller = await start(bridge)
    await controller.library.open()
    await controller.library.chooseFolder({ kind: 'trash' })
    bridge.handle('library.list', () => ok(listResult([], { folders: ['B文件夹'] })))
    bridge.emit('library.changed', { libraryDir: '/library-B' })
    await settle()
    expect(controller.store.getState().library.list?.folders).toEqual(['B文件夹'])
    expect(bridge.callsTo('library.list').at(-1)?.refresh).toBe(true)
    await controller.library.close()
    bridge.handle('library.list', () => ok(listResult([], { folders: ['C文件夹'] })))
    bridge.emit('library.changed', { libraryDir: '/library-C' })
    await settle()
    expect(controller.store.getState().library.list).toBeNull()
    await controller.library.toggle()
    expect(controller.store.getState().library.view).toBe('trash')
    expect(controller.store.getState().library.list?.folders).toEqual(['C文件夹'])
  })

  it('回收站视图里搜索的查询还在途、侧栏收起后换库：查询晚到也不把旧库的回收站放回去', async () => {
    const bridge = libraryBridge()
    bridge.handle('trash.list', () => ok({ recordState: 'ok', entries: [] }))
    const controller = await start(bridge)
    await controller.library.open()
    await controller.library.chooseFolder({ kind: 'trash' })
    const pending: Deferred<BridgeResult<TrashListResult>> = deferred()
    bridge.handle('trash.list', () => pending.promise)
    controller.library.setQuery('旧')
    await vi.advanceTimersByTimeAsync(100)
    await controller.library.close()
    bridge.emit('library.changed', { libraryDir: '/library-B' })
    await settle()
    pending.resolve(ok({ recordState: 'ok', entries: [OLD_TRASH] }))
    await settle()
    expect(controller.store.getState().library.trash).toBeNull()
  })

  it('预览的读取还在途时换库：读回来也不显示旧库的预览', async () => {
    const bridge = libraryBridge()
    const controller = await start(bridge)
    await controller.library.open()
    const read: Deferred<BridgeResult<LibraryReadResult>> = deferred()
    bridge.handle('library.read', () => read.promise)
    const selecting = controller.library.select(REVIEW.relPath)
    await settle()
    bridge.emit('library.changed', { libraryDir: '/library-B' })
    await settle()
    read.resolve(ok(readResult(REVIEW, '旧库正文')))
    await selecting
    expect(controller.store.getState().library.preview).toBeNull()
  })

  it('回收站预览的读取还在途时换库：选中和预览清掉，旧的读取晚到、新库里有同名文件也不恢复', async () => {
    const bridge = libraryBridge()
    bridge.handle('trash.list', () => ok({ recordState: 'ok', entries: [OLD_TRASH] }))
    const controller = await start(bridge)
    await controller.library.open()
    await controller.library.chooseFolder({ kind: 'trash' })
    const read: Deferred<BridgeResult<{ entry: TrashEntry; body: string }>> = deferred()
    bridge.handle('trash.read', () => read.promise)
    const selecting = controller.library.selectTrash(OLD_TRASH.file)
    await settle()
    expect(controller.store.getState().library.trashSelected).toBe(OLD_TRASH.file)
    const list: Deferred<BridgeResult<TrashListResult>> = deferred()
    bridge.handle('trash.list', () => list.promise)
    bridge.emit('library.changed', { libraryDir: '/library-B' })
    await settle()
    expect(controller.store.getState().library.trashSelected).toBeNull()
    expect(controller.store.getState().library.trashPreview).toBeNull()
    read.resolve(ok({ entry: OLD_TRASH, body: '# 旧' }))
    await selecting
    expect(controller.store.getState().library.trashPreview).toBeNull()
    list.resolve(ok({ recordState: 'ok', entries: [OLD_TRASH] }))
    await settle()
    expect(controller.store.getState().library.trashSelected).toBeNull()
    expect(controller.store.getState().library.trashPreview).toBeNull()
  })

  it('换库时旧库列表和回收站的错误一起清掉', async () => {
    const bridge = libraryBridge()
    bridge.handle('library.list', () => fail('promptx/library/unavailable', 'EACCES'))
    bridge.handle('trash.list', () => fail('promptx/library/unavailable', 'EACCES'))
    const controller = await start(bridge)
    await controller.library.open()
    await controller.library.chooseFolder({ kind: 'trash' })
    expect(controller.store.getState().library.listError).not.toBeNull()
    expect(controller.store.getState().library.trashError).not.toBeNull()
    await controller.library.close()
    bridge.emit('library.changed', { libraryDir: '/library-B' })
    await settle()
    expect(controller.store.getState().library.listError).toBeNull()
    expect(controller.store.getState().library.trashError).toBeNull()
  })

  it('删除的结果在换库之后才回来：新库里同路径、刚打开的条目，绑定和选中都不动；删除确实做了，照常提示', async () => {
    const bridge = libraryBridge()
    const deleting: Deferred<BridgeResult<{ trashFile: string }>> = deferred()
    bridge.handle('library.delete', () => deleting.promise)
    const controller = await start(bridge)
    bridge.emit('config', config({ confirmDelete: false }))
    await controller.library.open()
    const removing = controller.library.remove(REVIEW.relPath)
    await settle()
    expect(bridge.callsTo('library.delete')).toHaveLength(1)
    bridge.emit('library.changed', { libraryDir: '/library-B' })
    await settle()
    await controller.library.select(REVIEW.relPath)
    await controller.library.openEntry(REVIEW.relPath)
    expect(controller.store.getState().draft.binding).toBeNull()
    deleting.resolve(ok({ trashFile: '代码审查.md' }))
    await removing
    expect(controller.store.getState().draft.binding).toBeNull()
    expect(controller.store.getState().library.selected).toBe(REVIEW.relPath)
    expect(toastText(controller)).toBe('Prompt 已移入回收站。')
  })

  it('改元数据的冲突在换库之后才回来：不再弹补 front matter 的确认，按已取消处理', async () => {
    const bridge = libraryBridge()
    const pending: Deferred<BridgeResult<MetaResult>> = deferred()
    bridge.handle('library.updateMeta', () => pending.promise)
    const controller = await start(bridge)
    await controller.library.open()
    const favoriting = controller.library.toggleFavorite(REVIEW.relPath)
    await settle()
    bridge.emit('library.changed', { libraryDir: '/library-B' })
    await settle()
    pending.resolve(ok({ kind: 'conflict', conflict: 'noFrontMatter' }))
    await favoriting
    expect(controller.store.getState().dialog).toBeNull()
    expect(bridge.callsTo('library.updateMeta')).toHaveLength(1)
    expect(toastText(controller)).toBe('库目录已更换，操作已取消。')
  })

  it('改元数据成功的结果在换库之后才回来：不拿旧库文件的新版本去改新库里同路径条目的绑定', async () => {
    const bridge = libraryBridge()
    const pending: Deferred<BridgeResult<MetaResult>> = deferred()
    bridge.handle('library.updateMeta', () => pending.promise)
    const controller = await start(bridge)
    await controller.library.open()
    const favoriting = controller.library.toggleFavorite(REVIEW.relPath)
    await settle()
    bridge.emit('library.changed', { libraryDir: '/library-B' })
    await settle()
    // 新库里同路径的文件和旧库的一模一样（摘要相同），刚被打开
    await controller.library.openEntry(REVIEW.relPath)
    const bound = controller.store.getState().draft.binding
    expect(bound).toBeNull()
    pending.resolve(ok({
      kind: 'saved',
      entry: { ...REVIEW, favorite: true },
      before: { sha256: `sha-${REVIEW.relPath}`, size: bound?.size ?? 0 },
      after: { sha256: 'old-library-after', size: 99 },
    }))
    await favoriting
    expect(controller.store.getState().draft.binding).toBeNull()
    expect(toastText(controller)).toBe('已收藏。')
  })

  it('恢复的结果在换库之后才回来：占用不再弹确认；恢复成功照常提示，新库回收站里同名文件的选中不动', async () => {
    const bridge = libraryBridge()
    bridge.handle('trash.list', () => ok({ recordState: 'ok', entries: [OLD_TRASH] }))
    bridge.handle('trash.read', () => ok({ entry: OLD_TRASH, body: '# 旧' }))
    let pending: Deferred<BridgeResult<RestoreResult>> = deferred()
    bridge.handle('trash.restore', () => pending.promise)
    const controller = await start(bridge)
    await controller.library.open()
    await controller.library.chooseFolder({ kind: 'trash' })
    const occupied = controller.library.restore(OLD_TRASH.file)
    await settle()
    bridge.emit('library.changed', { libraryDir: '/library-B' })
    await settle()
    pending.resolve(ok({ kind: 'occupied', alternative: '旧版-2.md' }))
    await occupied
    expect(controller.store.getState().dialog).toBeNull()
    expect(bridge.callsTo('trash.restore')).toHaveLength(1)
    expect(toastText(controller)).toBe('库目录已更换，操作已取消。')

    pending = deferred()
    const restored = controller.library.restore(OLD_TRASH.file)
    await settle()
    bridge.emit('library.changed', { libraryDir: '/library-C' })
    await settle()
    await controller.library.selectTrash(OLD_TRASH.file)
    expect(controller.store.getState().library.trashSelected).toBe(OLD_TRASH.file)
    pending.resolve(ok({ kind: 'restored', relPath: '旧版.md' }))
    await restored
    expect(controller.store.getState().library.trashSelected).toBe(OLD_TRASH.file)
    expect(toastText(controller)).toBe('已恢复到：旧版.md')
  })
})
