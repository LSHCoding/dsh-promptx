import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest'
import type { BridgeResult } from '../../../src/shared/bridge.ts'
import type { DraftRecord } from '../../../src/shared/types.ts'
import { AppController } from '../../../src/app/renderer/controller/app.ts'
import { AUTOSAVE_MS, METRICS_MS, saveStatus } from '../../../src/app/renderer/controller/draft.ts'
import {
  binding,
  config,
  deferred,
  draftRecord,
  fail,
  FakeBridge,
  LIBRARY_DIR,
  ok,
  settle,
  startController,
  trapUnhandled,
  type,
  type Deferred,
} from './helpers.ts'

type LoadResult = BridgeResult<{ record: DraftRecord | null }>
type SaveResult = BridgeResult<{ updatedAt: string }>

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

function savedTexts(bridge: FakeBridge): string[] {
  return bridge.callsTo('draft.save').map(params => params.text)
}

describe('saveStatus（E-03 的三种状态）', () => {
  it('空白、未保存、已保存', () => {
    expect(saveStatus('', null)).toBe('blank')
    expect(saveStatus(' \n\t　', binding('a.md', 'x'))).toBe('blank')
    expect(saveStatus('hello', null)).toBe('unsaved')
    expect(saveStatus('hello', binding('a.md', 'hello'))).toBe('saved')
    expect(saveStatus('hello!', binding('a.md', 'hello'))).toBe('unsaved')
  })
})

describe('读回草稿之前（F-01、技术方案 4.5）', () => {
  it('载入中不可编辑；隐藏、复制、flush 都不发 draft.save', async () => {
    const bridge = new FakeBridge()
    const load: Deferred<LoadResult> = deferred()
    bridge.handle('draft.load', () => load.promise)
    const controller = new AppController({ bridge, locale: 'zh' })
    controllers.push(controller)
    const started = controller.start()
    await settle()
    expect(controller.store.getState().draft.load).toBe('loading')

    await controller.hide()
    const copied = await controller.copyAndHide()
    bridge.emit('flush', { id: 3 })
    await vi.advanceTimersByTimeAsync(5000)
    expect(copied.ok).toBe(false)
    expect(bridge.window.copyAndHide).not.toHaveBeenCalled()
    expect(bridge.callsTo('draft.save')).toEqual([])
    // 还没读回时也要回应 flush，主进程不用干等到超时。
    expect(bridge.flushed).toHaveBeenCalledWith(3)

    load.resolve(ok({ record: draftRecord('上次的草稿') }))
    await started
    expect(controller.editor.getText()).toBe('上次的草稿')
    expect(controller.store.getState().draft.load).toBe('ready')
    await vi.advanceTimersByTimeAsync(5000)
    // 读回的内容就是插件里存着的，不需要再存一遍。
    expect(bridge.callsTo('draft.save')).toEqual([])
  })

  it('读取失败：显示原因、不可编辑、不给出可以保存的空白草稿；重试成功后才开始保存', async () => {
    const bridge = new FakeBridge()
    let attempts = 0
    bridge.handle('draft.load', () => {
      attempts++
      return attempts === 1 ? fail('promptx/draft/unreadable', 'invalid-record') : ok({ record: draftRecord('恢复了') })
    })
    const controller = await start(bridge)
    const draft = controller.store.getState().draft
    expect(draft.load).toBe('error')
    expect(draft.loadError).toEqual({ code: 'promptx/draft/unreadable', detail: 'invalid-record' })

    // 模拟有程序改动了编辑区：读回之前一律不存，否则空草稿会覆盖插件里的原记录（红线 1）。
    type(controller, '不该被保存')
    controller.clear()
    await controller.hide()
    await vi.advanceTimersByTimeAsync(3000)
    expect(bridge.callsTo('draft.save')).toEqual([])

    await controller.retryLoad()
    expect(controller.store.getState().draft.load).toBe('ready')
    expect(controller.editor.getText()).toBe('恢复了')
    type(controller, '！')
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS)
    expect(savedTexts(bridge)).toEqual(['恢复了！'])
  })

  it('第一次使用光标在文末；记下过选区时恢复它', async () => {
    const first = new FakeBridge()
    first.handle('draft.load', () => ok({ record: draftRecord('abc') }))
    expect((await start(first)).editor.getSelection()).toEqual({ anchor: 3, head: 3 })

    const second = new FakeBridge()
    second.handle('draft.load', () => ok({ record: draftRecord('abcdef', { selection: { anchor: 1, head: 4 } }) }))
    expect((await start(second)).editor.getSelection()).toEqual({ anchor: 1, head: 4 })

    // 记录里的选区超出正文长度时收紧到文末，不让整份草稿读不出来。
    const third = new FakeBridge()
    third.handle('draft.load', () => ok({ record: draftRecord('ab', { selection: { anchor: 10, head: 99 } }) }))
    expect((await start(third)).editor.getSelection()).toEqual({ anchor: 2, head: 2 })
  })

  it('读回绑定后底栏显示已保存', async () => {
    const bridge = new FakeBridge()
    bridge.handle('draft.load', () => ok({ record: draftRecord('正文', { binding: binding('a.md', '正文') }) }))
    const controller = await start(bridge)
    expect(controller.store.getState().draft.binding?.relPath).toBe('a.md')
    expect(controller.store.getState().editor).toEqual({ chars: 2, status: 'saved' })
  })

  it('绑定的库目录和当前库目录不同（配置改过）：读回后解除绑定，正文不动（L-01）', async () => {
    const bridge = new FakeBridge()
    bridge.configValue = config({ libraryDir: '/new/library' })
    bridge.handle('draft.load', () => ok({ record: draftRecord('正文', { binding: binding('a.md', '正文') }) }))
    const controller = await start(bridge)
    expect(controller.store.getState().draft.binding).toBeNull()
    expect(controller.editor.getText()).toBe('正文')
    await settle()
    const saves = bridge.callsTo('draft.save')
    expect(saves.at(-1)?.binding).toBeNull()
  })
})

describe('自动保存的节奏（E-02，技术方案 5.5，审查 S07）', () => {
  it('停止输入后 600 ms 内保存一次', async () => {
    const bridge = new FakeBridge()
    const controller = await start(bridge)
    type(controller, 'abc')
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS - 1)
    expect(savedTexts(bridge)).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(savedTexts(bridge)).toEqual(['abc'])
    const [params] = bridge.callsTo('draft.save')
    expect(params).toEqual({ text: 'abc', selection: { anchor: 3, head: 3 }, binding: null })
  })

  it('连续打字也至少每 600 ms 存一次：每个按键最迟 600 ms 后进入一次保存', async () => {
    const bridge = new FakeBridge()
    const saves: Array<{ at: number; length: number }> = []
    bridge.handle('draft.save', (params) => {
      saves.push({ at: Date.now(), length: params.text.length })
      return ok({ updatedAt: '' })
    })
    const controller = await start(bridge)
    const strokes: Array<{ at: number; length: number }> = []
    // 5 秒内每 100 ms 打一个字，中间从不停顿 600 ms。
    for (let i = 0; i < 50; i++) {
      type(controller, 'x')
      strokes.push({ at: Date.now(), length: controller.editor.getText().length })
      await vi.advanceTimersByTimeAsync(100)
    }
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS)
    expect(saves.length).toBeGreaterThanOrEqual(7)
    for (const stroke of strokes) {
      const save = saves.find(item => item.length >= stroke.length)
      expect(save, `keystroke at ${stroke.at}`).toBeDefined()
      expect((save?.at ?? Infinity) - stroke.at).toBeLessThanOrEqual(AUTOSAVE_MS)
    }
    expect(saves.at(-1)?.length).toBe(50)
  })

  it('同一时间只有一个 draft.save 在途；回来后立即用最新内容再发一次', async () => {
    const bridge = new FakeBridge()
    const pending: Array<Deferred<SaveResult>> = []
    bridge.handle('draft.save', () => {
      const result = deferred<SaveResult>()
      pending.push(result)
      return result.promise
    })
    const controller = await start(bridge)
    type(controller, 'a')
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS)
    expect(savedTexts(bridge)).toEqual(['a'])

    type(controller, 'b')
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS * 4)
    type(controller, 'c')
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS * 4)
    expect(savedTexts(bridge)).toEqual(['a'])

    pending[0]?.resolve(ok({ updatedAt: '' }))
    await settle()
    // 在途期间只记最新内容：中间的「ab」不单独发。
    expect(savedTexts(bridge)).toEqual(['a', 'abc'])
    pending[1]?.resolve(ok({ updatedAt: '' }))
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS * 2)
    expect(savedTexts(bridge)).toEqual(['a', 'abc'])
  })

  it('只移动光标不触发保存；之后有改动时连同选区一起存', async () => {
    const bridge = new FakeBridge()
    const controller = await start(bridge)
    type(controller, 'hello')
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS)
    controller.editor.dispatch({ selection: { anchor: 1 } })
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS * 2)
    expect(bridge.callsTo('draft.save')).toHaveLength(1)
    // 隐藏时立即保存：光标位置变了，也要存下来（下次呼出光标回到原处，F-01）。
    await controller.hide()
    await settle()
    expect(bridge.callsTo('draft.save').at(-1)?.selection).toEqual({ anchor: 1, head: 1 })
  })

  it('隐藏、复制并隐藏、清空时立即保存，而且不等保存结果', async () => {
    for (const action of ['hide', 'copy', 'clear'] as const) {
      const bridge = new FakeBridge()
      bridge.handle('draft.load', () => ok({ record: draftRecord('已有') }))
      // 保存一直不回来：隐藏和复制也不能等它。
      bridge.handle('draft.save', () => new Promise<SaveResult>(() => {}))
      const controller = await start(bridge)
      type(controller, '内容')
      if (action === 'hide') await controller.hide()
      if (action === 'copy') await controller.copyAndHide()
      if (action === 'clear') controller.clear()
      await settle()
      // 没等 600 ms 的防抖就发出了。
      expect(savedTexts(bridge), action).toEqual([action === 'clear' ? '' : '已有内容'])
      if (action === 'hide') expect(bridge.window.hide).toHaveBeenCalledTimes(1)
      if (action === 'copy') expect(bridge.window.copyAndHide).toHaveBeenCalledWith('已有内容')
    }
  })

  it('保存失败：底栏显示原因，下次输入后重试，成功前一直显示', async () => {
    const bridge = new FakeBridge()
    let attempts = 0
    bridge.handle('draft.save', () => {
      attempts++
      return attempts === 1 ? fail('promptx/draft/write-failed', 'ENOSPC: no space left on device') : ok({ updatedAt: '' })
    })
    const controller = await start(bridge)
    type(controller, 'a')
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS)
    expect(controller.store.getState().draft.saveError).toEqual({ code: 'promptx/draft/write-failed', detail: 'ENOSPC: no space left on device' })

    // 没有新的输入就不自动重试；其他操作的提示也不会把它盖掉。
    await vi.advanceTimersByTimeAsync(10_000)
    expect(attempts).toBe(1)
    controller.toasts.success('别的提示')
    await vi.advanceTimersByTimeAsync(3000)
    expect(controller.store.getState().draft.saveError).not.toBeNull()

    type(controller, 'b')
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS)
    expect(attempts).toBe(2)
    expect(controller.store.getState().draft.saveError).toBeNull()
  })

  it('主进程的 flush：立即写回，写完后回复同一个序号', async () => {
    const bridge = new FakeBridge()
    const result = deferred<SaveResult>()
    bridge.handle('draft.save', () => result.promise)
    const controller = await start(bridge)
    type(controller, '退出前的输入')
    bridge.emit('flush', { id: 42 })
    await settle()
    expect(savedTexts(bridge)).toEqual(['退出前的输入'])
    expect(bridge.flushed).not.toHaveBeenCalled()
    result.resolve(ok({ updatedAt: '' }))
    await settle()
    expect(bridge.flushed).toHaveBeenCalledWith(42)
  })

  it('flush 时没有改动：不发请求，直接回复', async () => {
    const bridge = new FakeBridge()
    await start(bridge)
    bridge.emit('flush', { id: 1 })
    await settle()
    expect(bridge.callsTo('draft.save')).toEqual([])
    expect(bridge.flushed).toHaveBeenCalledWith(1)
  })
})

describe('字符数与保存状态（E-03，技术方案 5.5）', () => {
  it('输入停顿 150 ms 后才重算，按用户看到的字符计', async () => {
    const bridge = new FakeBridge()
    const controller = await start(bridge)
    type(controller, '汉字😀é')
    expect(controller.store.getState().editor).toEqual({ chars: 0, status: 'blank' })
    await vi.advanceTimersByTimeAsync(METRICS_MS - 1)
    expect(controller.store.getState().editor.chars).toBe(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(controller.store.getState().editor).toEqual({ chars: 4, status: 'unsaved' })
  })

  it('连续输入时一直往后推，不在每个按键上扫全文', async () => {
    const bridge = new FakeBridge()
    const controller = await start(bridge)
    for (let i = 0; i < 10; i++) {
      type(controller, 'x')
      await vi.advanceTimersByTimeAsync(100)
    }
    expect(controller.store.getState().editor.chars).toBe(0)
    await vi.advanceTimersByTimeAsync(METRICS_MS)
    expect(controller.store.getState().editor.chars).toBe(10)
  })
})

describe('界面就绪（冒烟测试用）', () => {
  it('编辑区挂载并且草稿读回后报一次；读取失败后重试成功再报一次', async () => {
    const bridge = new FakeBridge()
    let attempts = 0
    bridge.handle('draft.load', () => {
      attempts++
      return attempts === 1 ? fail('promptx/draft/unreadable') : ok({ record: null })
    })
    const controller = await start(bridge)
    expect(bridge.ready).not.toHaveBeenCalled()
    controller.editorMounted()
    expect(bridge.ready).toHaveBeenLastCalledWith({ editorMounted: true, draftLoaded: false })
    await controller.retryLoad()
    expect(bridge.ready).toHaveBeenLastCalledWith({ editorMounted: true, draftLoaded: true })
    expect(bridge.ready).toHaveBeenCalledTimes(2)
    controller.editorMounted()
    expect(bridge.ready).toHaveBeenCalledTimes(2)
  })
})

describe('库目录变了', () => {
  it('library.changed：绑定的库目录不同就解除绑定，正文不动', async () => {
    const bridge = new FakeBridge()
    bridge.handle('draft.load', () => ok({ record: draftRecord('正文', { binding: binding('a.md', '正文') }) }))
    const controller = await start(bridge)
    bridge.emit('library.changed', { libraryDir: LIBRARY_DIR })
    await settle()
    expect(controller.store.getState().draft.binding).not.toBeNull()

    bridge.emit('library.changed', { libraryDir: '/somewhere/else' })
    await settle()
    expect(controller.store.getState().draft.binding).toBeNull()
    expect(controller.editor.getText()).toBe('正文')
    await vi.advanceTimersByTimeAsync(METRICS_MS)
    expect(controller.store.getState().editor.status).toBe('unsaved')
    expect(bridge.callsTo('draft.save').at(-1)?.binding).toBeNull()
  })

  it('config 推来新的库目录时同样解除绑定', async () => {
    const bridge = new FakeBridge()
    bridge.handle('draft.load', () => ok({ record: draftRecord('正文', { binding: binding('a.md', '正文') }) }))
    const controller = await start(bridge)
    bridge.emit('config', config({ libraryDir: '/moved' }))
    expect(controller.store.getState().draft.binding).toBeNull()
  })
})
