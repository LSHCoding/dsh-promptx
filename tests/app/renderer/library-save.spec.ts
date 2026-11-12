import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest'
import type { BridgeResult } from '../../../src/shared/bridge.ts'
import type { LibraryListResult, PromptMetadata, SaveResult } from '../../../src/shared/types.ts'
import type { AppController } from '../../../src/app/renderer/controller/app.ts'
import {
  binding,
  confirmSaveForm,
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
  saveAndConfirm,
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

/** 插件按请求建好新文件：绑定的正文就是请求里的文本。 */
function created(relPath: string, text: string): BridgeResult<SaveResult> {
  return ok({ kind: 'saved', binding: binding(relPath, text, { sha256: `sha-${text}` }), entry: entry(relPath), created: true })
}

describe('主窗口保存始终新建', () => {
  it('先生成并预填标题和标签，取消确认时保留正文与选区', async () => {
    const bridge = new FakeBridge()
    const suggestion = deferred<BridgeResult<{ metadata: PromptMetadata | null }>>()
    bridge.handle('library.suggestMetadata', () => suggestion.promise)
    const controller = await start(bridge)
    type(controller, '待保存的正文')
    const selection = controller.editor.getSelection()
    const saving = controller.save()
    expect(controller.store.getState().draft.librarySuggesting).toBe(true)
    expect(bridge.callsTo('library.suggestMetadata')).toEqual([{ text: '待保存的正文' }])
    expect(bridge.callsTo('library.save')).toEqual([])
    expect(await controller.copyAndHide()).toEqual({ ok: true })
    expect(bridge.window.copyAndHide).toHaveBeenCalledWith('待保存的正文')

    suggestion.resolve(ok({ metadata: { title: '写作方案', tags: ['Writing Guide', '复盘'] } }))
    await settle()
    const dialog = openDialog(controller)
    expect(dialog.form).toEqual({ title: '写作方案', tags: 'Writing Guide, 复盘' })
    expect(controller.store.getState().draft.librarySuggesting).toBe(false)
    expect(bridge.callsTo('library.save')).toEqual([])
    controller.escapeDialog()
    expect(await saving).toBe('cancelled')
    expect(controller.editor.getText()).toBe('待保存的正文')
    expect(controller.editor.getSelection()).toEqual(selection)
    expect(bridge.callsTo('library.save')).toEqual([])
  })

  it.each(['no-result', 'timeout'] as const)('生成失败（%s）可手填保存，重名时保留输入供修正', async (outcome) => {
    const bridge = new FakeBridge()
    bridge.handle('library.suggestMetadata', () => outcome === 'no-result' ? ok({ metadata: null }) : fail('promptx/channel/timeout'))
    bridge.handle('library.save', params => params.metadata?.title === '重名'
      ? fail('promptx/library/duplicate-title')
      : created('新的标题.md', params.text))
    const controller = await start(bridge)
    type(controller, '原始草稿')
    const saving = controller.save()
    await settle()
    const first = openDialog(controller)
    expect(first.form).toEqual({ title: '', tags: '' })
    expect(first.message).toBeTruthy()
    controller.resolveDialog(first.id, { button: first.defaultButton, form: { title: '重名', tags: ' Writing Guide，复盘 ' } })
    await settle()
    const correction = openDialog(controller)
    expect(correction.error).toBeTruthy()
    expect(correction.form).toEqual({ title: '重名', tags: ' Writing Guide，复盘 ' })
    controller.resolveDialog(correction.id, { button: correction.defaultButton, form: { title: ' 新的标题 ', tags: ' Writing Guide，复盘 ' } })
    expect(await saving).toBe('saved')
    expect(bridge.callsTo('library.save')[1]).toMatchObject({
      text: '原始草稿',
      libraryDir: config().libraryDir,
      metadata: { title: '新的标题', tags: ['Writing Guide', '复盘'] },
    })
    expect(bridge.callsTo('library.suggestMetadata')).toHaveLength(1)
  })

  it.each(['new-library', 'dispose'] as const)('生成中%s，结束后不显示过时的确认界面', async (action) => {
    const bridge = new FakeBridge()
    const suggestion = deferred<BridgeResult<{ metadata: PromptMetadata | null }>>()
    bridge.handle('library.suggestMetadata', () => suggestion.promise)
    const controller = await start(bridge)
    type(controller, '待保存')
    const saving = controller.save()
    if (action === 'dispose') controller.dispose()
    else bridge.emit('config', config({ libraryDir: '/new-library' }))
    suggestion.resolve(ok({ metadata: null }))
    expect(await saving).toBe('cancelled')
    expect(controller.store.getState().dialog).toBeNull()
    expect(bridge.callsTo('library.save')).toEqual([])
  })

  it('新建后保持无绑定，保留正文选区，底栏标记已保存', async () => {
    const bridge = new FakeBridge()
    bridge.handle('library.save', params => created('写作助手.md', params.text))
    const controller = await start(bridge)
    type(controller, '# 写作助手\n\n正文')
    const selection = controller.editor.getSelection()
    expect(await saveAndConfirm(controller)).toBe('saved')
    expect(bridge.callsTo('library.save')[0]).toMatchObject({ text: '# 写作助手\n\n正文', binding: null, folder: null, mode: 'normal' })
    expect(bridge.callsTo('library.save')[0]?.requestId).toMatch(/^[0-9a-f]{32}$/)
    expect(controller.draft.binding).toBeNull()
    expect(controller.editor.getSelection()).toEqual(selection)
    expect(controller.store.getState().editor.status).toBe('saved')
    expect(toastText(controller)).toBe('Prompt 已保存。')
    expect(bridge.callsTo('draft.save').at(-1)?.binding).toBeNull()
  })

  it('从旧绑定草稿恢复后连续保存 A、B、C，所有请求均不携带更新目标', async () => {
    const bridge = new FakeBridge()
    bridge.handle('draft.load', () => ok({ record: draftRecord('A', { binding: binding('旧.md', 'A') }) }))
    let count = 0
    bridge.handle('library.save', params => created(`${++count}.md`, params.text))
    const controller = await start(bridge)
    await saveAndConfirm(controller)
    type(controller, 'B')
    await saveAndConfirm(controller)
    type(controller, 'C')
    await saveAndConfirm(controller)
    const calls = bridge.callsTo('library.save')
    expect(calls.map(call => call.text)).toEqual(['A', 'AB', 'ABC'])
    expect(calls.every(call => call.binding === null && call.mode === 'normal')).toBe(true)
    expect(new Set(calls.map(call => call.requestId)).size).toBe(3)
    expect(controller.draft.binding).toBeNull()
    expect(controller.saver.lastSavedRelPath).toBe('3.md')
  })

  it('相同正文再次明确保存也创建新条目', async () => {
    const bridge = new FakeBridge()
    bridge.handle('library.save', params => created('同名.md', params.text))
    const controller = await start(bridge)
    type(controller, '内容')
    await saveAndConfirm(controller)
    await saveAndConfirm(controller)
    expect(bridge.callsTo('library.save')).toHaveLength(2)
    expect(bridge.callsTo('library.save')[0]?.requestId).not.toBe(bridge.callsTo('library.save')[1]?.requestId)
  })

  it('空白不发送保存请求', async () => {
    for (const body of ['', ' \n\t']) {
      const bridge = new FakeBridge()
      const controller = await start(bridge)
      type(controller, body)
      expect(await saveAndConfirm(controller)).toBe('blank')
      expect(bridge.callsTo('library.save')).toEqual([])
      expect(toastText(controller)).toBe('没有可保存的内容。')
    }
  })

  it('草稿未载入不允许保存', async () => {
    const bridge = new FakeBridge()
    bridge.handle('draft.load', () => fail('promptx/draft/unreadable'))
    const controller = await start(bridge)
    type(controller, '不应保存')
    expect(await saveAndConfirm(controller)).toBe('failed')
    expect(bridge.callsTo('library.save')).toEqual([])
  })

  it('保存期间继续输入，只存点击时内容，最新文本仍标记未保存', async () => {
    const bridge = new FakeBridge()
    const result = deferred<BridgeResult<SaveResult>>()
    bridge.handle('library.save', () => result.promise)
    const controller = await start(bridge)
    type(controller, 'A')
    const saving = controller.save()
    type(controller, 'B')
    await confirmSaveForm(controller)
    result.resolve(created('A.md', 'A'))
    await saving
    expect(bridge.callsTo('library.save')[0]?.text).toBe('A')
    expect(controller.editor.getText()).toBe('AB')
    expect(controller.store.getState().editor.status).toBe('unsaved')
    expect(controller.draft.binding).toBeNull()
    expect(toastText(controller)).toBe('已保存提交时的内容，后续输入尚未保存。')
  })

  it('保存失败保留正文和选区，不建立绑定，重试使用新 requestId', async () => {
    const bridge = new FakeBridge()
    bridge.handle('library.save', () => fail('promptx/library/write-failed', 'ENOSPC'))
    const controller = await start(bridge)
    type(controller, '正文')
    controller.editor.dispatch({ selection: { anchor: 1 } })
    expect(await saveAndConfirm(controller)).toBe('failed')
    const selection = controller.editor.getSelection()
    expect(controller.editor.getText()).toBe('正文')
    expect(controller.draft.binding).toBeNull()
    expect(toastText(controller)).toMatch(/^保存失败/)
    await saveAndConfirm(controller)
    expect(controller.editor.getSelection()).toEqual(selection)
    expect(bridge.callsTo('library.save')[0]?.requestId).not.toBe(bridge.callsTo('library.save')[1]?.requestId)
  })

  it('在途连按保存和兼容另存接口只复用一次请求，不在返回后追加新建', async () => {
    const bridge = new FakeBridge()
    const result = deferred<BridgeResult<SaveResult>>()
    bridge.handle('library.save', () => result.promise)
    const controller = await start(bridge)
    type(controller, 'A')
    const first = controller.save()
    type(controller, 'B')
    expect(controller.save()).toBe(first)
    expect(controller.saveAsNew()).toBe(first)
    expect(controller.store.getState().draft.librarySaving).toBe(true)
    await confirmSaveForm(controller)
    result.resolve(created('A.md', 'A'))
    expect(await first).toBe('saved')
    await settle()
    expect(bridge.callsTo('library.save')).toHaveLength(1)
    expect(controller.editor.getText()).toBe('AB')
    expect(controller.store.getState().draft.librarySaving).toBe(false)
  })

  it.each(['clear', 'library'] as const)('在途时%s换代，旧完成结果不标记新草稿已保存', async (action) => {
    const bridge = new FakeBridge()
    const result = deferred<BridgeResult<SaveResult>>()
    bridge.handle('library.save', () => result.promise)
    const controller = await start(bridge)
    type(controller, '旧')
    const saving = controller.save()
    await confirmSaveForm(controller)
    if (action === 'clear') controller.clear()
    else bridge.emit('library.changed', { libraryDir: '/other' })
    type(controller, '新')
    result.resolve(created('旧.md', '旧'))
    await saving
    await vi.advanceTimersByTimeAsync(200)
    expect(controller.store.getState().editor.status).toBe('unsaved')
    expect(controller.draft.binding).toBeNull()
    expect(bridge.callsTo('library.save')).toHaveLength(1)
  })
})

describe('新建的目标文件夹', () => {
  it('生成期间切换库筛选，按保存对话框中确认的目录写入', async () => {
    const bridge = new FakeBridge()
    const suggestion = deferred<BridgeResult<{ metadata: PromptMetadata | null }>>()
    bridge.handle('library.list', () => ok(listResult([], { folders: ['写作', '编程'] })))
    bridge.handle('library.folders', () => ok({ folders: ['写作', '编程'] }))
    bridge.handle('library.suggestMetadata', () => suggestion.promise)
    bridge.handle('library.save', params => created('写作/标题.md', params.text))
    const controller = await start(bridge)
    type(controller, '正文')
    await controller.library.open()
    await controller.library.chooseFolder({ kind: 'folder', path: '写作' })
    const saving = controller.save()
    await controller.library.chooseFolder({ kind: 'folder', path: '编程' })
    suggestion.resolve(ok({ metadata: { title: '标题', tags: [] } }))
    await confirmSaveForm(controller, '写作')
    expect(await saving).toBe('saved')
    expect(bridge.callsTo('library.save')[0]?.folder).toBe('写作')
    expect(bridge.callsTo('library.save')[0]?.folderMustExist).toBe(true)
  })

  it('默认保存到未分类，库收起时仍可选择真实文件夹', async () => {
    const bridge = new FakeBridge()
    bridge.handle('library.list', () => ok(listResult([], { folders: ['写作'] })))
    bridge.handle('library.folders', () => ok({ folders: ['写作'] }))
    bridge.handle('trash.list', () => ok({ recordState: 'ok', entries: [] }))
    bridge.handle('library.save', params => created('x.md', params.text))
    const controller = await start(bridge)
    type(controller, '正文')
    await controller.library.open()
    await controller.library.chooseFolder({ kind: 'folder', path: '写作' })
    await saveAndConfirm(controller)
    expect(bridge.callsTo('library.save').at(-1)?.folder).toBeNull()
    await controller.library.close()
    await saveAndConfirm(controller, '写作')
    expect(bridge.callsTo('library.save').at(-1)?.folder).toBe('写作')
  })

  it('确认后目标文件夹消失，保留标题和标签并重新询问目标', async () => {
    const bridge = new FakeBridge()
    let folders = ['写作', '编程']
    bridge.handle('library.folders', () => ok({ folders }))
    bridge.handle('library.save', params => params.folder === '写作'
      ? fail('promptx/library/not-found')
      : created('编程/标题.md', params.text))
    const controller = await start(bridge)
    type(controller, '正文')
    const saving = controller.save()
    await settle()
    folders = ['编程']
    await confirmSaveForm(controller, '写作')
    await settle()
    expect(openDialog(controller)).toMatchObject({
      form: { title: '建议标题', tags: 'Writing Guide, 示例', folder: '' },
      folderOptions: ['编程'],
    })
    await confirmSaveForm(controller, '编程')
    expect(await saving).toBe('saved')
    expect(bridge.callsTo('library.save').map(request => request.folder)).toEqual(['写作', '编程'])
  })

  it('换库后列表未返回，或旧文件夹已消失时不创建旧目录', async () => {
    const bridge = new FakeBridge()
    bridge.handle('library.list', () => ok(listResult([], { folders: ['旧目录'] })))
    bridge.handle('library.save', params => created('x.md', params.text))
    const controller = await start(bridge)
    type(controller, '正文')
    await controller.library.open()
    await controller.library.chooseFolder({ kind: 'folder', path: '旧目录' })
    const pending: Deferred<BridgeResult<LibraryListResult>> = deferred()
    bridge.handle('library.list', () => pending.promise)
    bridge.emit('library.changed', { libraryDir: '/new' })
    await settle()
    await saveAndConfirm(controller)
    expect(bridge.callsTo('library.save').at(-1)?.folder).toBeNull()
    pending.resolve(ok(listResult([], { root: '/new', state: 'missing' })))
    await settle()
  })
})

describe('新建超时重试', () => {
  it('超时后切换库筛选，继续重试原来确认的目录和请求 id', async () => {
    const bridge = new FakeBridge()
    bridge.handle('library.list', () => ok(listResult([], { folders: ['写作', '编程'] })))
    bridge.handle('library.folders', () => ok({ folders: ['写作', '编程'] }))
    bridge.handle('library.save', () => fail('promptx/channel/timeout'))
    const controller = await start(bridge)
    type(controller, '正文')
    await controller.library.open()
    await controller.library.chooseFolder({ kind: 'folder', path: '写作' })
    await saveAndConfirm(controller, '写作')
    await controller.library.chooseFolder({ kind: 'folder', path: '编程' })
    await saveAndConfirm(controller)
    const [first, second] = bridge.callsTo('library.save')
    expect(first?.folder).toBe('写作')
    expect(second).toEqual(first)
    expect(bridge.callsTo('library.suggestMetadata')).toHaveLength(1)
  })

  it('结果未知时沿用同一 requestId，确认成功后下一次明确保存使用新 id', async () => {
    const bridge = new FakeBridge()
    let attempt = 0
    bridge.handle('library.save', params => ++attempt === 1 ? fail('promptx/channel/timeout') : created('A.md', params.text))
    const controller = await start(bridge)
    type(controller, 'A')
    expect(await saveAndConfirm(controller)).toBe('failed')
    expect(controller.draft.binding).toBeNull()
    expect(toastText(controller)).toMatch(/保存超时/)
    expect(await saveAndConfirm(controller)).toBe('saved')
    expect(bridge.callsTo('library.save')[0]?.requestId).toBe(bridge.callsTo('library.save')[1]?.requestId)
    await saveAndConfirm(controller)
    expect(bridge.callsTo('library.save')[2]?.requestId).not.toBe(bridge.callsTo('library.save')[1]?.requestId)
  })

  it('超时后继续输入，重试返回旧快照时保留当前全文并提示未保存', async () => {
    const bridge = new FakeBridge()
    let attempt = 0
    bridge.handle('library.save', () => ++attempt === 1 ? fail('promptx/channel/timeout') : created('A.md', 'A'))
    const controller = await start(bridge)
    type(controller, 'A')
    await saveAndConfirm(controller)
    type(controller, 'B')
    await saveAndConfirm(controller)
    expect(bridge.callsTo('library.save')[1]).toEqual(bridge.callsTo('library.save')[0])
    expect(bridge.callsTo('library.suggestMetadata')).toHaveLength(1)
    expect(controller.editor.getText()).toBe('AB')
    expect(controller.store.getState().editor.status).toBe('unsaved')
    expect(controller.draft.binding).toBeNull()
  })

  it('配置先切换库目录时立即丢弃旧超时 requestId，不必等待 library.changed', async () => {
    const bridge = new FakeBridge()
    bridge.handle('library.save', () => fail('promptx/channel/timeout'))
    const controller = await start(bridge)
    type(controller, '正文')
    await saveAndConfirm(controller)
    bridge.emit('config', config({ libraryDir: '/new-library' }))
    await saveAndConfirm(controller)
    expect(bridge.callsTo('library.save')[0]?.requestId).not.toBe(bridge.callsTo('library.save')[1]?.requestId)
    expect(controller.editor.getText()).toBe('正文')
  })

  it('超时后清空或换库，不沿用旧请求 id', async () => {
    const bridge = new FakeBridge()
    bridge.handle('library.save', () => fail('promptx/channel/timeout'))
    const controller = await start(bridge)
    type(controller, 'A')
    await saveAndConfirm(controller)
    controller.clear()
    type(controller, 'B')
    await saveAndConfirm(controller)
    expect(bridge.callsTo('library.save')[0]?.requestId).not.toBe(bridge.callsTo('library.save')[1]?.requestId)
    bridge.emit('library.changed', { libraryDir: '/new' })
    await saveAndConfirm(controller)
    expect(bridge.callsTo('library.save')[1]?.requestId).not.toBe(bridge.callsTo('library.save')[2]?.requestId)
  })
})


describe('独立条目编辑完成的内容通知', () => {
  it('同库内容变化刷新列表和选中预览，主草稿正文、选区与已保存状态保持', async () => {
    const bridge = new FakeBridge()
    const meta = entry('模板.md')
    let body = '原模板'
    bridge.handle('library.list', () => ok(listResult([meta])))
    bridge.handle('library.read', () => ok(readResult(meta, body)))
    bridge.handle('library.save', params => created('主草稿.md', params.text))
    const controller = await start(bridge)
    type(controller, '主草稿')
    await saveAndConfirm(controller)
    controller.editor.dispatch({ selection: { anchor: 1, head: 2 } })
    await controller.library.open()
    await controller.library.select(meta.relPath)
    const generation = controller.draft.generation
    const listsBefore = bridge.callsTo('library.list').length
    body = '子窗保存后的模板'
    bridge.emit('library.entriesChanged', { libraryDir: config().libraryDir })
    await settle()
    expect(bridge.callsTo('library.list')).toHaveLength(listsBefore + 1)
    expect(bridge.callsTo('library.list').at(-1)?.refresh).toBe(true)
    expect(controller.store.getState().library.preview?.body).toBe(body)
    expect(controller.store.getState().library.selected).toBe(meta.relPath)
    expect(controller.editor.getText()).toBe('主草稿')
    expect(controller.editor.getSelection()).toEqual({ anchor: 1, head: 2 })
    expect(controller.store.getState().editor.status).toBe('saved')
    expect(controller.draft.generation).toBe(generation)
    expect(controller.draft.binding).toBeNull()
    expect(bridge.callsTo('library.save')).toHaveLength(1)
  })

  it('主窗口新建超时后收到同库内容变化，重试仍沿用原 requestId', async () => {
    const bridge = new FakeBridge()
    bridge.handle('library.list', () => ok(listResult([])))
    let attempt = 0
    bridge.handle('library.save', params => ++attempt === 1 ? fail('promptx/channel/timeout') : created('草稿.md', params.text))
    const controller = await start(bridge)
    type(controller, '草稿')
    await controller.library.open()
    expect(await saveAndConfirm(controller)).toBe('failed')
    const generation = controller.draft.generation
    bridge.emit('library.entriesChanged', { libraryDir: config().libraryDir })
    await settle()
    expect(controller.draft.generation).toBe(generation)
    expect(await saveAndConfirm(controller)).toBe('saved')
    const requests = bridge.callsTo('library.save')
    expect(requests[0]?.requestId).toBe(requests[1]?.requestId)
    expect(controller.draft.binding).toBeNull()
  })

  it('来自其他库的内容通知不刷新列表或预览，也不改变主草稿状态', async () => {
    const bridge = new FakeBridge()
    const meta = entry('模板.md')
    bridge.handle('library.list', () => ok(listResult([meta])))
    bridge.handle('library.read', () => ok(readResult(meta, '原模板')))
    bridge.handle('library.save', params => created('主草稿.md', params.text))
    const controller = await start(bridge)
    type(controller, '主草稿')
    await saveAndConfirm(controller)
    await controller.library.open()
    await controller.library.select(meta.relPath)
    const generation = controller.draft.generation
    const preview = controller.store.getState().library.preview
    const listCount = bridge.callsTo('library.list').length
    const readCount = bridge.callsTo('library.read').length
    bridge.emit('library.entriesChanged', { libraryDir: '/different/library' })
    await settle()
    expect(bridge.callsTo('library.list')).toHaveLength(listCount)
    expect(bridge.callsTo('library.read')).toHaveLength(readCount)
    expect(controller.store.getState().library.preview).toBe(preview)
    expect(controller.store.getState().editor.status).toBe('saved')
    expect(controller.draft.generation).toBe(generation)
    expect(controller.editor.getText()).toBe('主草稿')
  })
})
