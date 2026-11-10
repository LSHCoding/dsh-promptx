// @vitest-environment jsdom
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { BridgeResult } from '../../../src/shared/bridge.ts'
import type { SaveResult } from '../../../src/shared/types.ts'
import type { AppController } from '../../../src/app/renderer/controller/app.ts'
import { ControllerContext } from '../../../src/app/renderer/components/hooks.ts'
import { Toolbar } from '../../../src/app/renderer/components/Toolbar.tsx'
import { binding, deferred, draftRecord, entry, FakeBridge, ok, settle, startController, type } from './helpers.ts'

const controllers: AppController[] = []

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  cleanup()
  for (const controller of controllers.splice(0)) controller.dispose()
  vi.useRealTimers()
})

async function mount(bridge: FakeBridge): Promise<AppController> {
  const controller = await startController(bridge)
  controllers.push(controller)
  render(<ControllerContext.Provider value={controller}><Toolbar /></ControllerContext.Provider>)
  return controller
}

describe('主窗口保存始终新建（v0.1.1）', () => {
  it('空草稿不能保存；有内容后点击保存发送独立新建，保存后按钮仍为保存', async () => {
    const bridge = new FakeBridge()
    bridge.handle('library.save', params => ok({ kind: 'saved', binding: binding('新.md', params.text), entry: entry('新.md'), created: true }))
    const controller = await mount(bridge)
    const saveAsNew = screen.getByRole('button', { name: '保存' }) as HTMLButtonElement
    expect(saveAsNew.disabled).toBe(true)
    await act(async () => {
      type(controller, '新内容')
      await vi.advanceTimersByTimeAsync(200)
    })
    expect(saveAsNew.disabled).toBe(false)
    expect(fireEvent.mouseDown(saveAsNew)).toBe(false)
    await act(async () => {
      fireEvent.click(saveAsNew)
      await settle()
    })
    expect(bridge.callsTo('library.save')).toHaveLength(1)
    expect(bridge.callsTo('library.save')[0]).toMatchObject({ mode: 'normal', binding: null, text: '新内容' })
    expect(screen.getByRole('button', { name: '保存' }).getAttribute('data-tip')).toBe('保存（⌘S）')
    expect(screen.queryByRole('button', { name: '更新当前 Prompt' })).toBeNull()
    expect(screen.queryByRole('button', { name: '另存为新 Prompt' })).toBeNull()
    expect(controller.draft.binding).toBeNull()
    expect(saveAsNew.disabled).toBe(false)
  })

  it('旧绑定恢复后保存也新建；写入在途按钮禁用，重复点击不追加请求', async () => {
    const bridge = new FakeBridge()
    bridge.handle('draft.load', () => ok({ record: draftRecord('原正文', { binding: binding('原.md', '原正文') }) }))
    const pending = deferred<BridgeResult<SaveResult>>()
    bridge.handle('library.save', () => pending.promise)
    const controller = await mount(bridge)
    const saveAsNew = screen.getByRole('button', { name: '保存' }) as HTMLButtonElement
    expect(saveAsNew.disabled).toBe(false)
    act(() => {
      fireEvent.click(saveAsNew)
    })
    expect(saveAsNew.disabled).toBe(true)
    fireEvent.click(saveAsNew)
    expect(bridge.callsTo('library.save')).toHaveLength(1)
    await act(async () => {
      pending.resolve(ok({ kind: 'saved', binding: binding('新.md', '原正文'), entry: entry('新.md'), created: true }))
      await settle()
    })
    expect(saveAsNew.disabled).toBe(false)
    expect(controller.draft.binding).toBeNull()
  })
})
