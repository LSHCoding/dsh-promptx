// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, it, expect } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { AppController } from '../../../src/app/renderer/controller/app.ts'
import type { DialogResult, DialogSpec } from '../../../src/app/renderer/state/state.ts'
import { App } from '../../../src/app/renderer/components/App.tsx'
import { FakeBridge, installLayoutStubs, settle, startController, trapUnhandled } from './helpers.ts'

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
  checkUnhandled()
})

async function mountApp(): Promise<{ bridge: FakeBridge; controller: AppController }> {
  const bridge = new FakeBridge()
  const controller = await startController(bridge)
  controllers.push(controller)
  render(<App controller={controller} />)
  return { bridge, controller }
}

function open(controller: AppController, spec: DialogSpec): Promise<DialogResult> {
  let result!: Promise<DialogResult>
  act(() => {
    result = controller.dialogs.open(spec)
  })
  return result
}

const UNSAVED: DialogSpec = {
  title: '当前编辑器有未保存的内容',
  message: '载入「代码审查清单」会替换当前编辑器内容，要先怎么处理？',
  buttons: [{ id: 'cancel', label: '取消' }, { id: 'discard', label: '放弃' }, { id: 'save', label: '保存', tone: 'primary' }],
  defaultButton: 'save',
  escapeButton: 'cancel',
}

const OPTIMIZE_MODIFIED: DialogSpec = {
  title: '草稿在优化期间已经修改',
  message: '应用候选会替换当前的手工编辑。',
  buttons: [{ id: 'copy', label: '复制候选' }, { id: 'keep', label: '保持当前内容' }, { id: 'apply', label: '仍然应用', tone: 'primary' }],
  defaultButton: 'keep',
  escapeButton: 'keep',
}

/** 对话框里的按钮（工具栏上也有同名的「保存」，查找时只看对话框）。 */
function dialogButton(name: string): HTMLButtonElement {
  return within(screen.getByRole('dialog')).getByRole('button', { name }) as HTMLButtonElement
}

function escape(): void {
  act(() => {
    fireEvent.keyDown(window, { key: 'Escape' })
  })
}

describe('对话框（需求 5.8，技术方案 5.5）', () => {
  it('在小窗内居中显示，打开时焦点在默认按钮上，并通知主进程（失焦时不自动隐藏）', async () => {
    const { bridge, controller } = await mountApp()
    const choice = open(controller, UNSAVED)
    const dialog = screen.getByRole('dialog', { name: '当前编辑器有未保存的内容' })
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    expect(screen.getByText('载入「代码审查清单」会替换当前编辑器内容，要先怎么处理？')).toBeTruthy()
    expect(document.activeElement).toBe(dialogButton('保存'))
    expect(bridge.window.setModalOpen).toHaveBeenLastCalledWith(true)
    // 按钮顺序跟随 dsh：取消在左，主要动作在右。
    expect([...dialog.querySelectorAll('.px-dialog-buttons button')].map(button => button.textContent)).toEqual(['取消', '放弃', '保存'])
    fireEvent.click(dialogButton('放弃'))
    expect(await choice).toEqual({ button: 'discard' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(bridge.window.setModalOpen).toHaveBeenLastCalledWith(false)
  })

  it('Esc 等于「取消」；O-04 的对话框没有「取消」，Esc 等于「保持当前内容」', async () => {
    const { controller } = await mountApp()
    const first = open(controller, UNSAVED)
    escape()
    expect(await first).toEqual({ button: 'cancel' })

    const second = open(controller, OPTIMIZE_MODIFIED)
    expect(document.activeElement).toBe(dialogButton('保持当前内容'))
    escape()
    expect(await second).toEqual({ button: 'keep' })
  })

  it('输入法组字中的 Esc 交给输入法，不关对话框', async () => {
    const { controller } = await mountApp()
    const choice = open(controller, UNSAVED)
    act(() => {
      fireEvent.keyDown(window, { key: 'Escape', keyCode: 229 })
    })
    expect(screen.getByRole('dialog')).toBeTruthy()
    escape()
    await choice
  })

  it('Tab 在对话框里循环，焦点出不去', async () => {
    const { controller } = await mountApp()
    const choice = open(controller, UNSAVED)
    const save = dialogButton('保存')
    const cancel = dialogButton('取消')
    expect(fireEvent.keyDown(save, { key: 'Tab' })).toBe(false)
    expect(document.activeElement).toBe(cancel)
    expect(fireEvent.keyDown(cancel, { key: 'Tab', shiftKey: true })).toBe(false)
    expect(document.activeElement).toBe(save)
    escape()
    await choice
  })

  it('点遮罩不让焦点离开对话框', async () => {
    const { controller } = await mountApp()
    const choice = open(controller, UNSAVED)
    const backdrop = document.querySelector('.px-dialog-backdrop') as HTMLElement
    expect(fireEvent.mouseDown(backdrop)).toBe(false)
    escape()
    await choice
  })

  it('关闭后焦点还给打开前的元素', async () => {
    const { controller } = await mountApp()
    const settings = screen.getByRole('button', { name: '设置' })
    settings.focus()
    const choice = open(controller, UNSAVED)
    expect(document.activeElement).not.toBe(settings)
    escape()
    await choice
    expect(document.activeElement).toBe(settings)
  })

  it('重命名 / 标签：焦点在第一个输入框；标题为空时「保存」不可用；输入框里按 Enter 等于「保存」', async () => {
    const { controller } = await mountApp()
    const choice = open(controller, {
      title: '重命名 / 标签',
      buttons: [{ id: 'cancel', label: '取消' }, { id: 'save', label: '保存', tone: 'primary' }],
      defaultButton: 'save',
      escapeButton: 'cancel',
      form: { title: '代码审查清单', tags: '代码, 审查' },
    })
    const title = screen.getByRole('textbox', { name: '标题' }) as HTMLInputElement
    const tags = screen.getByRole('textbox', { name: /标签/ }) as HTMLInputElement
    expect(document.activeElement).toBe(title)
    expect(screen.getByText('用逗号分隔，最多 5 个')).toBeTruthy()

    fireEvent.change(title, { target: { value: '   ' } })
    const save = dialogButton('保存')
    expect(save.disabled).toBe(true)
    fireEvent.keyDown(title, { key: 'Enter' })
    expect(screen.getByRole('dialog')).toBeTruthy()

    fireEvent.change(title, { target: { value: '新标题' } })
    fireEvent.change(tags, { target: { value: '写作，示例' } })
    expect(save.disabled).toBe(false)
    fireEvent.keyDown(tags, { key: 'Enter' })
    expect(await choice).toEqual({ button: 'save', form: { title: '新标题', tags: '写作，示例' } })
  })

  it('排队的下一个对话框接着显示，焦点和输入框都重新开始', async () => {
    const { controller } = await mountApp()
    const first = open(controller, UNSAVED)
    const second = open(controller, OPTIMIZE_MODIFIED)
    fireEvent.click(dialogButton('取消'))
    await first
    await act(async () => {
      await settle()
    })
    expect(screen.getByRole('dialog', { name: '草稿在优化期间已经修改' })).toBeTruthy()
    expect(document.activeElement).toBe(dialogButton('保持当前内容'))
    escape()
    await second
  })
})
