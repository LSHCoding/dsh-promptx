import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest'
import { undo } from '@codemirror/commands'
import type { BridgeResult } from '../../../src/shared/bridge.ts'
import type { LibraryListResult, LibraryReadResult, SaveResult } from '../../../src/shared/types.ts'
import type { AppController } from '../../../src/app/renderer/controller/app.ts'
import {
  binding,
  chooseDialog,
  deferred,
  draftRecord,
  entry,
  fail,
  FakeBridge,
  LIBRARY_DIR,
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

/** 插件按请求建好新文件：绑定的正文就是请求里的文本。 */
function created(relPath: string, text: string): BridgeResult<SaveResult> {
  return ok({ kind: 'saved', binding: binding(relPath, text, { sha256: `sha-${text}` }), entry: entry(relPath), created: true })
}

function boundBridge(relPath = '代码审查.md', body = '库里的正文'): FakeBridge {
  const bridge = new FakeBridge()
  bridge.handle('draft.load', () => ok({ record: draftRecord(body, { binding: binding(relPath, body, { title: '代码审查' }) }) }))
  return bridge
}

describe('未绑定时新建文件（L-08）', () => {
  it('存库根目录，绑定到新文件，底栏「已保存」，提示「Prompt 已保存。」', async () => {
    const bridge = new FakeBridge()
    bridge.handle('library.save', params => created('写作助手.md', params.text))
    const controller = await start(bridge)
    type(controller, '# 写作助手\n\n正文')
    expect(await controller.save()).toBe('saved')
    const [params] = bridge.callsTo('library.save')
    expect(params).toMatchObject({ text: '# 写作助手\n\n正文', binding: null, folder: null, mode: 'normal' })
    expect(params?.requestId).toMatch(/^[0-9a-f]{32}$/)
    expect(controller.store.getState().draft.binding?.relPath).toBe('写作助手.md')
    expect(toastText(controller)).toBe('Prompt 已保存。')
    await vi.advanceTimersByTimeAsync(200)
    expect(controller.store.getState().editor.status).toBe('saved')
    // 绑定立即写进草稿记录（E-02：重启后仍是同样的绑定）。
    expect(bridge.callsTo('draft.save').at(-1)?.binding?.relPath).toBe('写作助手.md')
  })

  it('库侧栏展开且选中真实文件夹时存进那个文件夹；「全部」「未分类」、回收站视图、侧栏收起时存根目录', async () => {
    const bridge = new FakeBridge()
    bridge.handle('library.list', () => ok(listResult([], { folders: ['写作'] })))
    bridge.handle('trash.list', () => ok({ recordState: 'ok', entries: [] }))
    bridge.handle('library.save', params => created(`${params.folder ?? ''}/x.md`, params.text))
    const controller = await start(bridge)
    const folders: Array<string | null> = []
    const saveOnce = async () => {
      controller.clear()
      type(controller, '内容')
      await controller.save()
      const last = bridge.callsTo('library.save').at(-1)
      folders.push(last === undefined ? 'missing' : last.folder)
    }
    await controller.library.open()
    await controller.library.chooseFolder({ kind: 'folder', path: '写作' })
    await saveOnce()
    await controller.library.chooseFolder({ kind: 'root' })
    await saveOnce()
    await controller.library.chooseFolder({ kind: 'folder', path: '写作' })
    await controller.library.chooseFolder({ kind: 'trash' })
    await saveOnce()
    await controller.library.chooseFolder({ kind: 'folder', path: '写作' })
    await controller.library.close()
    await saveOnce()
    expect(folders).toEqual(['写作', null, null, null])
  })

  // 外部审查第二轮复核：换库后记下的文件夹是旧库的，文件夹栏里没有高亮，照它保存的话插件会在新库里把它建出来。
  it('换库后新库的列表还没回来、或者新库不存在：新建存库根目录，记下的文件夹不动', async () => {
    const bridge = new FakeBridge()
    bridge.handle('library.list', () => ok(listResult([], { folders: ['写作'] })))
    bridge.handle('library.save', params => created(`${params.folder ?? ''}/x.md`, params.text))
    const controller = await start(bridge)
    await controller.library.open()
    await controller.library.chooseFolder({ kind: 'folder', path: '写作' })
    const pending: Deferred<BridgeResult<LibraryListResult>> = deferred()
    bridge.handle('library.list', () => pending.promise)
    bridge.emit('library.changed', { libraryDir: '/library-B' })
    await settle()
    type(controller, '内容')
    await controller.save()
    pending.resolve(ok(listResult([], { state: 'missing', folders: [] })))
    await settle()
    controller.clear()
    type(controller, '又一条')
    await controller.save()
    expect(bridge.callsTo('library.save').map(params => params.folder)).toEqual([null, null])
    expect(controller.store.getState().library.folder).toEqual({ kind: 'folder', path: '写作' })
  })

  it('草稿为空或只有空白：提示「没有可保存的内容。」，不发请求', async () => {
    const bridge = new FakeBridge()
    const controller = await start(bridge)
    type(controller, '   \n')
    expect(await controller.save()).toBe('blank')
    expect(bridge.callsTo('library.save')).toEqual([])
    expect(controller.store.getState().toast).toMatchObject({ kind: 'error', text: '没有可保存的内容。' })
  })

  it('保存期间继续输入：写入的是按下保存那一刻的内容，完成后底栏「未保存」并说明', async () => {
    const bridge = new FakeBridge()
    const result: Deferred<BridgeResult<SaveResult>> = deferred()
    bridge.handle('library.save', () => result.promise)
    const controller = await start(bridge)
    type(controller, '按下保存时')
    const saving = controller.save()
    type(controller, '，之后又打的字')
    result.resolve(created('a.md', '按下保存时'))
    expect(await saving).toBe('saved')
    expect(bridge.callsTo('library.save')[0]?.text).toBe('按下保存时')
    expect(toastText(controller)).toBe('已保存提交时的内容，后续输入尚未保存。')
    await vi.advanceTimersByTimeAsync(200)
    expect(controller.store.getState().editor.status).toBe('unsaved')
  })

  it('写入失败：提示「保存失败：{原因}」，草稿和绑定不变', async () => {
    const bridge = boundBridge()
    bridge.handle('library.save', () => fail('promptx/library/write-failed', 'EACCES: permission denied'))
    const controller = await start(bridge)
    type(controller, '改')
    const before = controller.store.getState().draft.binding
    expect(await controller.save()).toBe('failed')
    expect(controller.store.getState().toast).toMatchObject({ kind: 'error', text: '保存失败：没有权限' })
    expect(controller.store.getState().draft.binding).toBe(before)
    expect(controller.editor.getText()).toBe('库里的正文改')
  })

  it('保存完成时编辑区已经换了内容来源（被清空）：不改动当前的绑定', async () => {
    const bridge = new FakeBridge()
    const result: Deferred<BridgeResult<SaveResult>> = deferred()
    bridge.handle('library.save', () => result.promise)
    const controller = await start(bridge)
    type(controller, '内容')
    const saving = controller.save()
    controller.clear()
    result.resolve(created('a.md', '内容'))
    expect(await saving).toBe('saved')
    expect(controller.store.getState().draft.binding).toBeNull()
  })
})

describe('已绑定时写回原文件（L-08、L-12）', () => {
  it('带上绑定发请求；成功后绑定换成新版本', async () => {
    const bridge = boundBridge()
    bridge.handle('library.save', params => ok({
      kind: 'saved',
      binding: { ...binding('代码审查.md', params.text, { title: '代码审查' }), sha256: 'new-sha' },
      entry: entry('代码审查.md'),
      created: false,
    }))
    const controller = await start(bridge)
    type(controller, '，补充')
    expect(await controller.save()).toBe('saved')
    const [params] = bridge.callsTo('library.save')
    expect(params?.binding).toMatchObject({ relPath: '代码审查.md', sha256: 'sha-代码审查.md', libraryDir: LIBRARY_DIR })
    expect(params?.mode).toBe('normal')
    expect(controller.store.getState().draft.binding?.sha256).toBe('new-sha')
    expect(toastText(controller)).toBe('Prompt 已保存。')
  })

  it('文件已被外部修改：默认「取消」，什么都不改', async () => {
    const bridge = boundBridge()
    bridge.handle('library.save', () => ok({ kind: 'conflict', conflict: 'modified' }))
    const controller = await start(bridge)
    type(controller, '改')
    const saving = controller.save()
    await settle()
    const dialog = openDialog(controller)
    expect(dialog.title).toBe('文件已被外部修改')
    expect(dialog.message).toBe('磁盘上的新内容没有被覆盖。可以重新载入磁盘版本（当前编辑内容会被替换），或把当前编辑内容另存为新 Prompt。')
    expect(dialog.buttons.map(button => button.label)).toEqual(['取消', '另存为新 Prompt', '重新载入'])
    expect(dialog.defaultButton).toBe('cancel')
    expect(dialog.escapeButton).toBe('cancel')
    controller.escapeDialog()
    expect(await saving).toBe('cancelled')
    expect(bridge.callsTo('library.save')).toHaveLength(1)
    expect(controller.editor.getText()).toBe('库里的正文改')
  })

  it('外部修改 → 重新载入：编辑区换成磁盘版本、清空撤销记录，绑定到磁盘上的新版本', async () => {
    const bridge = boundBridge()
    bridge.handle('library.save', () => ok({ kind: 'conflict', conflict: 'modified' }))
    bridge.handle('library.read', () => ok(readResult(entry('代码审查.md', { title: '代码审查' }), '磁盘上的新内容', 'disk-sha')))
    const controller = await start(bridge)
    type(controller, '改')
    const saving = controller.save()
    await settle()
    chooseDialog(controller, 'reload')
    await saving
    expect(controller.editor.getText()).toBe('磁盘上的新内容')
    expect(controller.editor.runCommand(undo)).toBe(false)
    expect(controller.store.getState().draft.binding).toMatchObject({ sha256: 'disk-sha', savedBody: '磁盘上的新内容' })
    expect(toastText(controller)).toBe('已载入磁盘上的版本。')
  })

  it('外部修改 → 重新载入，读取期间又有输入：不替换，提示原因，绑定不动（红线 1，外部审查第 1 条同类问题）', async () => {
    const bridge = boundBridge()
    bridge.handle('library.save', () => ok({ kind: 'conflict', conflict: 'modified' }))
    const read: Deferred<BridgeResult<LibraryReadResult>> = deferred()
    bridge.handle('library.read', () => read.promise)
    const controller = await start(bridge)
    type(controller, '改')
    const saving = controller.save()
    await settle()
    chooseDialog(controller, 'reload')
    await settle()
    type(controller, '又改')
    read.resolve(ok(readResult(entry('代码审查.md', { title: '代码审查' }), '磁盘上的新内容', 'disk-sha')))
    await saving
    expect(controller.editor.getText()).toBe('库里的正文改又改')
    expect(controller.store.getState().draft.binding?.sha256).toBe('sha-代码审查.md')
    expect(controller.store.getState().toast).toMatchObject({ kind: 'error', text: '载入期间编辑器的内容有改动，没有替换。' })
    expect(controller.editor.runCommand(undo)).toBe(true)
  })

  it('外部修改 → 另存为新 Prompt：新建到库根目录，编辑区绑定到新文件', async () => {
    const bridge = boundBridge()
    bridge.handle('library.save', params => (params.mode === 'saveAsNew' ? created('另存.md', params.text) : ok({ kind: 'conflict', conflict: 'modified' })))
    const controller = await start(bridge)
    await controller.library.open()
    await controller.library.chooseFolder({ kind: 'folder', path: '写作' })
    type(controller, '改')
    const saving = controller.save()
    await settle()
    chooseDialog(controller, 'saveAsNew')
    expect(await saving).toBe('saved')
    const second = bridge.callsTo('library.save')[1]
    expect(second).toMatchObject({ mode: 'saveAsNew', binding: null, folder: null, text: '库里的正文改' })
    expect(controller.store.getState().draft.binding?.relPath).toBe('另存.md')
  })

  it('原文件已不存在：取消 / 另存为新 Prompt，说明里带标题', async () => {
    const bridge = boundBridge()
    bridge.handle('library.save', params => (params.mode === 'saveAsNew' ? created('新.md', params.text) : ok({ kind: 'conflict', conflict: 'missing' })))
    const controller = await start(bridge)
    const saving = controller.save()
    await settle()
    const dialog = openDialog(controller)
    expect(dialog.title).toBe('原文件已不存在')
    expect(dialog.message).toBe('「代码审查」的文件已被删除或移走。')
    expect(dialog.buttons.map(button => button.id)).toEqual(['cancel', 'saveAsNew'])
    expect(dialog.defaultButton).toBe('cancel')
    chooseDialog(controller, 'saveAsNew')
    expect(await saving).toBe('saved')
    expect(controller.store.getState().draft.binding?.relPath).toBe('新.md')
  })

  it('文件没有 front matter：确认后带 addFrontMatter 重发；默认按钮是「补上并保存」', async () => {
    const bridge = boundBridge()
    bridge.handle('library.save', params => (params.mode === 'addFrontMatter'
      ? ok({ kind: 'saved', binding: binding('代码审查.md', params.text), entry: entry('代码审查.md'), created: false })
      : ok({ kind: 'conflict', conflict: 'noFrontMatter' })))
    const controller = await start(bridge)
    type(controller, '改')
    const saving = controller.save()
    await settle()
    const dialog = openDialog(controller)
    expect(dialog.title).toBe('为这个 Markdown 文件补上 Prompt 信息？')
    expect(dialog.buttons.map(button => button.label)).toEqual(['取消', '另存为新 Prompt', '补上并保存'])
    expect(dialog.defaultButton).toBe('addFrontMatter')
    expect(dialog.escapeButton).toBe('cancel')
    chooseDialog(controller, 'addFrontMatter')
    expect(await saving).toBe('saved')
    expect(bridge.callsTo('library.save')[1]).toMatchObject({ mode: 'addFrontMatter', binding: { relPath: '代码审查.md' } })
  })

  it('front matter 写坏了：不改写，提示先修好或另存为新 Prompt', async () => {
    const bridge = boundBridge()
    bridge.handle('library.save', () => ok({ kind: 'conflict', conflict: 'invalidFrontMatter' }))
    const controller = await start(bridge)
    const saving = controller.save()
    await settle()
    const dialog = openDialog(controller)
    expect(dialog.title).toBe('这个文件的 Prompt 信息无法识别')
    expect(dialog.buttons.map(button => button.id)).toEqual(['cancel', 'saveAsNew'])
    controller.escapeDialog()
    expect(await saving).toBe('cancelled')
  })

  it('冲突结果回来时编辑区已经换了内容来源：不再弹对话框', async () => {
    const bridge = boundBridge()
    const result: Deferred<BridgeResult<SaveResult>> = deferred()
    bridge.handle('library.save', () => result.promise)
    const controller = await start(bridge)
    const saving = controller.save()
    controller.clear()
    result.resolve(ok({ kind: 'conflict', conflict: 'modified' }))
    expect(await saving).toBe('conflict')
    expect(controller.store.getState().dialog).toBeNull()
  })
})

describe('两次 ⌘S 合并（技术方案 5.5，审查 S05）', () => {
  it('在途时再按 ⌘S 不另发请求，等结果回来后用返回的新绑定再发一次', async () => {
    const bridge = boundBridge()
    const results: Array<Deferred<BridgeResult<SaveResult>>> = []
    bridge.handle('library.save', () => {
      const result = deferred<BridgeResult<SaveResult>>()
      results.push(result)
      return result.promise
    })
    const controller = await start(bridge)
    type(controller, 'A')
    const first = controller.save()
    type(controller, 'B')
    const second = controller.save()
    const third = controller.save()
    await settle()
    expect(bridge.callsTo('library.save')).toHaveLength(1)
    expect(second).toBe(third)
    expect(controller.store.getState().draft.librarySaving).toBe(true)

    results[0]?.resolve(ok({ kind: 'saved', binding: binding('代码审查.md', '库里的正文A', { sha256: 'v1' }), entry: entry('代码审查.md'), created: false }))
    expect(await first).toBe('saved')
    await settle()
    const calls = bridge.callsTo('library.save')
    expect(calls).toHaveLength(2)
    // 第二次带上第一次返回的新版本，不会把自己的写入当成外部修改。
    expect(calls[1]).toMatchObject({ text: '库里的正文AB', binding: { sha256: 'v1' } })
    results[1]?.resolve(ok({ kind: 'saved', binding: binding('代码审查.md', '库里的正文AB', { sha256: 'v2' }), entry: entry('代码审查.md'), created: false }))
    expect(await second).toBe('saved')
    expect(controller.store.getState().draft.binding?.sha256).toBe('v2')
    expect(controller.store.getState().draft.librarySaving).toBe(false)
  })

  // 外部审查第二轮复核：合并的那次等在途的保存回来才发，读的是那时的编辑区和绑定；中途换了内容来源就不能再发，
  // 否则会把刚打开、没改过的文件重写一遍（补 updated），或者把草稿建进刚换的库里。

  function heldSaves(bridge: FakeBridge): Array<Deferred<BridgeResult<SaveResult>>> {
    const results: Array<Deferred<BridgeResult<SaveResult>>> = []
    bridge.handle('library.save', () => {
      const result = deferred<BridgeResult<SaveResult>>()
      results.push(result)
      return result.promise
    })
    bridge.handle('library.read', () => ok(readResult(entry('写作/模板.md', { title: '模板' }), '模板正文', 'tpl-v1')))
    return results
  }

  it('合并的那次排队期间打开了别的条目：不再发，返回 cancelled', async () => {
    const bridge = boundBridge()
    const results = heldSaves(bridge)
    const controller = await start(bridge)
    const first = controller.save()
    const second = controller.save()
    await settle()
    // 编辑区和绑定的正文一致，没有未保存的内容，打开不弹确认
    await controller.library.openEntry('写作/模板.md')
    expect(controller.store.getState().draft.binding?.relPath).toBe('写作/模板.md')
    results[0]?.resolve(ok({ kind: 'saved', binding: binding('代码审查.md', '库里的正文', { sha256: 'v1' }), entry: entry('代码审查.md'), created: false }))
    expect(await first).toBe('saved')
    expect(await second).toBe('cancelled')
    expect(bridge.callsTo('library.save')).toHaveLength(1)
    expect(controller.store.getState().draft.binding?.relPath).toBe('写作/模板.md')
  })

  it('打开别的条目之后再按 ⌘S：另排一次，存的是新打开的条目', async () => {
    const bridge = boundBridge()
    const results = heldSaves(bridge)
    const controller = await start(bridge)
    const first = controller.save()
    const stale = controller.save()
    await settle()
    await controller.library.openEntry('写作/模板.md')
    const fresh = controller.save()
    results[0]?.resolve(ok({ kind: 'saved', binding: binding('代码审查.md', '库里的正文', { sha256: 'v1' }), entry: entry('代码审查.md'), created: false }))
    expect(await first).toBe('saved')
    expect(await stale).toBe('cancelled')
    await settle()
    expect(bridge.callsTo('library.save')).toHaveLength(2)
    expect(bridge.callsTo('library.save')[1]).toMatchObject({ text: '模板正文', binding: { relPath: '写作/模板.md', sha256: 'tpl-v1' } })
    results[1]?.resolve(ok({ kind: 'saved', binding: binding('写作/模板.md', '模板正文', { sha256: 'tpl-v2' }), entry: entry('写作/模板.md'), created: false }))
    expect(await fresh).toBe('saved')
    expect(controller.store.getState().draft.binding?.sha256).toBe('tpl-v2')
  })

  it('新建在途时「在编辑器中打开」选了「保存」，随后换了库：合并的那次不再发，不读取，提示库目录已更换', async () => {
    const bridge = new FakeBridge()
    const results = heldSaves(bridge)
    const controller = await start(bridge)
    type(controller, '草稿')
    const first = controller.save()
    const opening = controller.library.openEntry('写作/模板.md')
    await settle()
    chooseDialog(controller, 'save')
    await settle()
    bridge.emit('library.changed', { libraryDir: '/library-B' })
    await settle()
    results[0]?.resolve(created('草稿.md', '草稿'))
    expect(await first).toBe('saved')
    await opening
    expect(bridge.callsTo('library.save')).toHaveLength(1)
    expect(bridge.callsTo('library.read')).toEqual([])
    expect(controller.store.getState().draft.binding).toBeNull()
    expect(toastText(controller)).toBe('库目录已更换，操作已取消。')
  })

  it('第一次没有存成（冲突后取消）：合并的那次也不再发', async () => {
    const bridge = boundBridge()
    bridge.handle('library.save', () => ok({ kind: 'conflict', conflict: 'modified' }))
    const controller = await start(bridge)
    const first = controller.save()
    const second = controller.save()
    await settle()
    controller.escapeDialog()
    expect(await first).toBe('cancelled')
    expect(await second).toBe('cancelled')
    expect(bridge.callsTo('library.save')).toHaveLength(1)
  })
})

describe('超时与 requestId（技术方案 5.5，审查 S05）', () => {
  it('新建请求超时：提示后保留 requestId，重试时沿用，插件返回已经建好的文件', async () => {
    const bridge = new FakeBridge()
    bridge.handle('library.list', () => ok(listResult([])))
    let attempt = 0
    bridge.handle('library.save', (params) => {
      attempt++
      return attempt === 1 ? fail('promptx/channel/timeout', 'library.save') : created('a.md', params.text)
    })
    const controller = await start(bridge)
    await controller.library.open()
    const listsBefore = bridge.callsTo('library.list').length
    type(controller, '内容')
    expect(await controller.save()).toBe('failed')
    expect(controller.store.getState().toast).toMatchObject({ kind: 'error', text: '保存超时，已重新核对文件，可以再保存一次。' })
    // 结果未知：先刷新列表，用户能看到文件是不是已经建好了。
    expect(bridge.callsTo('library.list').length).toBeGreaterThan(listsBefore)

    expect(await controller.save()).toBe('saved')
    const [first, second] = bridge.callsTo('library.save')
    expect(second?.requestId).toBe(first?.requestId)
  })

  // 审查复核 c5：草稿没有绑定时，换库原来不换代。超时后沿用的 requestId 让插件返回旧库里建好的文件，草稿被绑定到旧库，
  // 提示「已保存」，新库的列表里却没有它。
  it('新建超时后换了库目录：重试换一个 requestId，在新库里新建并绑定', async () => {
    const bridge = new FakeBridge()
    let attempt = 0
    bridge.handle('library.save', (params) => {
      attempt++
      if (attempt === 1) return fail('promptx/channel/timeout', 'library.save')
      return ok({ kind: 'saved', binding: binding('a.md', params.text, { libraryDir: '/library-B' }), entry: entry('a.md'), created: true })
    })
    const controller = await start(bridge)
    type(controller, '内容')
    expect(await controller.save()).toBe('failed')
    bridge.emit('library.changed', { libraryDir: '/library-B' })
    await settle()
    expect(await controller.save()).toBe('saved')
    const [first, second] = bridge.callsTo('library.save')
    expect(second?.requestId).not.toBe(first?.requestId)
    expect(controller.store.getState().draft.binding?.libraryDir).toBe('/library-B')
  })

  it('新建请求在途时换了库目录：结果回来后只提示已保存，不绑定到旧库', async () => {
    const bridge = new FakeBridge()
    const save: Deferred<BridgeResult<SaveResult>> = deferred()
    bridge.handle('library.save', () => save.promise)
    const controller = await start(bridge)
    type(controller, '内容')
    const saving = controller.save()
    await settle()
    bridge.emit('library.changed', { libraryDir: '/library-B' })
    await settle()
    save.resolve(created('a.md', '内容'))
    expect(await saving).toBe('saved')
    expect(controller.store.getState().draft.binding).toBeNull()
    expect(toastText(controller)).toBe('Prompt 已保存。')
  })

  it('建好之后，下一次新建换一个 requestId；不是超时的失败也换', async () => {
    const bridge = new FakeBridge()
    let attempt = 0
    bridge.handle('library.save', (params) => {
      attempt++
      return attempt === 2 ? fail('promptx/library/write-failed', 'EIO') : created(`${attempt}.md`, params.text)
    })
    const controller = await start(bridge)
    type(controller, '一')
    await controller.save()
    controller.clear()
    type(controller, '二')
    await controller.save()
    await controller.save()
    const ids = bridge.callsTo('library.save').map(params => params.requestId)
    expect(new Set(ids).size).toBe(3)
  })

  it('已绑定的保存超时：先重新读取这一条；磁盘上已经是这次的内容就当作保存成功', async () => {
    const bridge = boundBridge()
    bridge.handle('library.save', () => fail('promptx/channel/timeout', 'library.save'))
    bridge.handle('library.read', () => ok(readResult(entry('代码审查.md', { title: '代码审查' }), '库里的正文改', 'after-timeout')))
    const controller = await start(bridge)
    type(controller, '改')
    expect(await controller.save()).toBe('saved')
    expect(bridge.callsTo('library.read')).toEqual([{ relPath: '代码审查.md' }])
    expect(controller.store.getState().draft.binding?.sha256).toBe('after-timeout')
  })

  it('已绑定的保存超时、磁盘上不是这次的内容：提示可以再保存一次，绑定不动', async () => {
    const bridge = boundBridge()
    bridge.handle('library.save', () => fail('promptx/channel/timeout', 'library.save'))
    bridge.handle('library.read', () => ok(readResult(entry('代码审查.md'), '库里的正文', 'unchanged')))
    const controller = await start(bridge)
    type(controller, '改')
    expect(await controller.save()).toBe('failed')
    expect(controller.store.getState().draft.binding?.sha256).toBe('sha-代码审查.md')
    expect(toastText(controller)).toBe('保存超时，已重新核对文件，可以再保存一次。')
  })
})
