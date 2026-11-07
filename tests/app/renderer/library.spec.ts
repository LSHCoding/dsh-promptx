import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest'
import { undo } from '@codemirror/commands'
import { DEFAULT_PREFS, type BridgeResult } from '../../../src/shared/bridge.ts'
import type { LibraryReadResult, MetaResult } from '../../../src/shared/types.ts'
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

describe('在编辑器中打开（L-07）', () => {
  it('当前草稿没有未保存内容：直接载入，进入绑定状态，撤销记录清空', async () => {
    const bridge = libraryBridge()
    const controller = await start(bridge)
    await controller.library.open()
    await controller.library.openEntry(REVIEW.relPath)
    expect(controller.store.getState().dialog).toBeNull()
    expect(controller.editor.getText()).toBe('检查边界条件。')
    expect(controller.store.getState().draft.binding).toMatchObject({ relPath: REVIEW.relPath, title: '代码审查清单', savedBody: '检查边界条件。' })
    expect(controller.editor.runCommand(undo)).toBe(false)
    expect(toastText(controller)).toBe('正在编辑库中 Prompt：代码审查清单')
    await vi.advanceTimersByTimeAsync(200)
    expect(controller.store.getState().editor.status).toBe('saved')
  })

  it('选中的就是当前绑定的条目：不弹确认，不重新载入', async () => {
    const bridge = libraryBridge()
    bridge.handle('draft.load', () => ok({ record: draftRecord('改过的正文', { binding: binding(REVIEW.relPath, '检查边界条件。', { title: '代码审查清单' }) }) }))
    const controller = await start(bridge)
    await controller.library.open()
    await controller.library.openEntry(REVIEW.relPath)
    expect(controller.store.getState().dialog).toBeNull()
    expect(bridge.callsTo('library.read')).toEqual([])
    expect(controller.editor.getText()).toBe('改过的正文')
  })

  it('有未保存内容：弹出确认，按钮依次为取消、放弃、保存，默认「保存」', async () => {
    const bridge = libraryBridge()
    const controller = await start(bridge)
    await controller.library.open()
    type(controller, '还没保存的草稿')
    const opening = controller.library.openEntry(REVIEW.relPath)
    await settle()
    const dialog = openDialog(controller)
    expect(dialog.title).toBe('当前编辑器有未保存的内容')
    expect(dialog.message).toBe('载入「代码审查清单」会替换当前编辑器内容，要先怎么处理？')
    expect(dialog.buttons.map(button => button.label)).toEqual(['取消', '放弃', '保存'])
    expect(dialog.defaultButton).toBe('save')
    expect(dialog.escapeButton).toBe('cancel')
    chooseDialog(controller, 'cancel')
    await opening
    expect(controller.editor.getText()).toBe('还没保存的草稿')
    expect(bridge.callsTo('library.read')).toEqual([])
  })

  it('放弃：直接载入', async () => {
    const bridge = libraryBridge()
    const controller = await start(bridge)
    type(controller, '草稿')
    const opening = controller.library.openEntry(REVIEW.relPath)
    await settle()
    chooseDialog(controller, 'discard')
    await opening
    expect(controller.editor.getText()).toBe('检查边界条件。')
  })

  it('保存：先按 L-08 保存当前草稿，成功后再载入；保存失败就停下，什么都不替换', async () => {
    const bridge = libraryBridge()
    let saves = 0
    bridge.handle('library.save', (params) => {
      saves++
      return saves === 1
        ? ok({ kind: 'saved', binding: binding('草稿.md', params.text), entry: entry('草稿.md'), created: true })
        : fail('promptx/library/write-failed', 'ENOSPC')
    })
    const controller = await start(bridge)
    type(controller, '草稿')
    const opening = controller.library.openEntry(REVIEW.relPath)
    await settle()
    chooseDialog(controller, 'save')
    await opening
    expect(bridge.callsTo('library.save')).toHaveLength(1)
    expect(controller.editor.getText()).toBe('检查边界条件。')

    type(controller, '再改')
    const second = controller.library.openEntry(WRITING.relPath)
    await settle()
    chooseDialog(controller, 'save')
    await second
    // 打开后光标在开头，「再改」打在了最前面；保存失败时这段内容原样留在编辑区。
    expect(controller.editor.getText()).toBe('再改检查边界条件。')
    expect(controller.store.getState().draft.binding?.relPath).toBe(REVIEW.relPath)
    expect(controller.store.getState().toast?.text).toBe('保存失败：磁盘空间不足')
  })

  it('读取失败：提示原因，草稿和绑定都不变', async () => {
    const bridge = libraryBridge()
    bridge.handle('library.read', () => fail('promptx/library/not-found'))
    const controller = await start(bridge)
    await controller.library.openEntry(REVIEW.relPath)
    expect(controller.store.getState().toast).toMatchObject({ kind: 'error', text: '读取失败：找不到这个文件' })
    expect(controller.store.getState().draft.binding).toBeNull()
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

  it('改的是绑定的条目、且插件修改前读到的就是绑定的版本：绑定换成新版本和新标题，立即保存草稿，之后 ⌘S 不报外部修改', async () => {
    const bridge = libraryBridge()
    bridge.handle('draft.load', () => ok({ record: draftRecord('检查边界条件。', { binding: binding(REVIEW.relPath, '检查边界条件。', { sha256: 'v0', size: 10, title: '代码审查清单' }) }) }))
    bridge.handle('library.updateMeta', () => metaResult('v0', 'v1', '改过的标题'))
    const controller = await start(bridge)
    await controller.library.open()
    await controller.library.toggleFavorite(REVIEW.relPath)
    expect(bridge.callsTo('library.updateMeta')[0]?.patch).toEqual({ favorite: true })
    const bound = controller.store.getState().draft.binding
    expect(bound).toMatchObject({ sha256: 'v1', size: 12, title: '改过的标题', savedBody: '检查边界条件。' })
    await settle()
    expect(bridge.callsTo('draft.save').at(-1)?.binding?.sha256).toBe('v1')

    bridge.handle('library.save', params => (params.binding?.sha256 === 'v1'
      ? ok({ kind: 'saved', binding: { ...params.binding, savedBody: params.text, sha256: 'v2' }, entry: REVIEW, created: false })
      : ok({ kind: 'conflict', conflict: 'modified' })))
    type(controller, '再改正文')
    expect(await controller.save()).toBe('saved')
  })

  it('之前就有外部修改（before 和绑定的版本不同）：绑定不动，下次保存照常报外部修改', async () => {
    const bridge = libraryBridge()
    bridge.handle('draft.load', () => ok({ record: draftRecord('检查边界条件。', { binding: binding(REVIEW.relPath, '检查边界条件。', { sha256: 'v0', size: 10 }) }) }))
    bridge.handle('library.updateMeta', () => metaResult('external', 'v2'))
    bridge.handle('library.save', () => ok({ kind: 'conflict', conflict: 'modified' }))
    const controller = await start(bridge)
    await controller.library.open()
    await controller.library.toggleFavorite(REVIEW.relPath)
    expect(controller.store.getState().draft.binding?.sha256).toBe('v0')
    const saving = controller.save()
    await settle()
    expect(openDialog(controller).title).toBe('文件已被外部修改')
    controller.escapeDialog()
    await saving
  })

  it('改的不是绑定的条目：绑定不动', async () => {
    const bridge = libraryBridge()
    bridge.handle('draft.load', () => ok({ record: draftRecord('x', { binding: binding(WRITING.relPath, 'x', { sha256: 'v0' }) }) }))
    bridge.handle('library.updateMeta', () => metaResult('v0', 'v1'))
    const controller = await start(bridge)
    await controller.library.open()
    await controller.library.toggleFavorite(REVIEW.relPath)
    expect(controller.store.getState().draft.binding?.sha256).toBe('v0')
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

  it('删除正绑定在编辑区的条目：编辑区内容不变，解除绑定，底栏变「未保存」', async () => {
    const bridge = libraryBridge()
    bridge.configValue = config({ confirmDelete: false })
    bridge.handle('draft.load', () => ok({ record: draftRecord('正文', { binding: binding(REVIEW.relPath, '正文') }) }))
    bridge.handle('library.delete', () => ok({ trashFile: 'x.md' }))
    const controller = await start(bridge)
    await controller.library.remove(REVIEW.relPath)
    expect(controller.editor.getText()).toBe('正文')
    expect(controller.store.getState().draft.binding).toBeNull()
    await vi.advanceTimersByTimeAsync(200)
    expect(controller.store.getState().editor.status).toBe('unsaved')
  })

  it('移动失败：提示原因，绑定和列表不变', async () => {
    const bridge = libraryBridge()
    bridge.configValue = config({ confirmDelete: false })
    bridge.handle('draft.load', () => ok({ record: draftRecord('正文', { binding: binding(REVIEW.relPath, '正文') }) }))
    bridge.handle('library.delete', () => fail('promptx/library/move-failed', 'EPERM: operation not permitted'))
    const controller = await start(bridge)
    await controller.library.remove(REVIEW.relPath)
    expect(toastText(controller)).toBe('删除失败：没有权限')
    expect(controller.store.getState().draft.binding).not.toBeNull()
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
})
