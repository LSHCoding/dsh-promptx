// @vitest-environment jsdom
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { BridgeResult } from '../../../src/shared/bridge.ts'
import type { SaveResult } from '../../../src/shared/types.ts'
import type { AppController } from '../../../src/app/renderer/controller/app.ts'
import { DialogHost } from '../../../src/app/renderer/components/Dialog.tsx'
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
  render(<ControllerContext.Provider value={controller}><Toolbar /><DialogHost /></ControllerContext.Provider>)
  return controller
}

describe('主窗口确认标题和标签后新建', () => {
  it('空草稿不能保存；有内容后点击保存发送独立新建，保存后按钮仍为保存', async () => {
    const bridge = new FakeBridge()
    bridge.handle('library.folders', () => ok({ folders: ['写作/评审'] }))
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
    expect(bridge.callsTo('library.save')).toEqual([])
    const title = screen.getByRole('textbox', { name: '标题' }) as HTMLInputElement
    const tags = screen.getByRole('textbox', { name: /标签/ }) as HTMLInputElement
    const dialog = within(screen.getByRole('dialog', { name: '保存 Prompt' }))
    const folder = dialog.getByRole('combobox', { name: '文件夹' }) as HTMLSelectElement
    const confirm = dialog.getByRole('button', { name: '保存' })
    // 模型生成的标题和标签第一次出现时注明来源（V0.1.5）。
    expect(dialog.getByText('标题和标签由模型生成，可以修改。')).toBeTruthy()
    expect(title.value).toBe('建议标题')
    expect(tags.value).toBe('Writing Guide, 示例')
    expect(folder.selectedOptions[0]?.textContent).toBe('未分类')
    expect(document.activeElement).toBe(confirm)
    await act(async () => {
      fireEvent.change(title, { target: { value: '新标题' } })
      fireEvent.change(tags, { target: { value: 'Custom Label，复盘' } })
      fireEvent.change(folder, { target: { value: '写作/评审' } })
      fireEvent.keyDown(tags, { key: 'Enter' })
      await settle()
    })
    expect(bridge.callsTo('library.save')).toHaveLength(1)
    expect(bridge.callsTo('library.save')[0]).toMatchObject({
      mode: 'normal',
      binding: null,
      folder: '写作/评审',
      folderMustExist: true,
      text: '新内容',
      metadata: { title: '新标题', tags: ['Custom Label', '复盘'] },
    })
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
    await act(async () => {
      fireEvent.click(saveAsNew)
      await settle()
    })
    expect(saveAsNew.disabled).toBe(true)
    fireEvent.click(saveAsNew)
    await act(async () => {
      fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '保存' }))
      await settle()
    })
    expect(bridge.callsTo('library.save')).toHaveLength(1)
    await act(async () => {
      pending.resolve(ok({ kind: 'saved', binding: binding('新.md', '原正文'), entry: entry('新.md'), created: true }))
      await settle()
    })
    expect(saveAsNew.disabled).toBe(false)
    expect(controller.draft.binding).toBeNull()
  })

  it('手填时聚焦标题，标题为空无法确认', async () => {
    const bridge = new FakeBridge()
    bridge.handle('library.suggestMetadata', () => ok({ metadata: null }))
    bridge.handle('draft.load', () => ok({ record: draftRecord('待保存正文') }))
    await mount(bridge)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '保存' }))
      await settle()
    })
    const title = screen.getByRole('textbox', { name: '标题' })
    const dialog = within(screen.getByRole('dialog'))
    const confirm = dialog.getByRole('button', { name: '保存' }) as HTMLButtonElement
    expect(dialog.getByText('未能生成标题和标签，可以手动填写后保存。')).toBeTruthy()
    expect(dialog.queryByText('标题和标签由模型生成，可以修改。')).toBeNull()
    expect(document.activeElement).toBe(title)
    expect(confirm.disabled).toBe(true)
    fireEvent.change(title, { target: { value: '   ' } })
    expect(confirm.disabled).toBe(true)
    fireEvent.change(title, { target: { value: '手填标题' } })
    expect(confirm.disabled).toBe(false)
    expect(bridge.callsTo('library.save')).toEqual([])
  })
})
