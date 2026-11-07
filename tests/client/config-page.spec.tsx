// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ActionResult } from '../../src/client/api.ts'
import { ConfigPage, type ConfigPageApi } from '../../src/client/ConfigPage.tsx'
import type { PromptxTranslate } from '../../src/client/locale.ts'
import { DEFAULT_INSTRUCTION } from '../../src/shared/instructions.ts'
import type { ConfigUpdateResult, ErrorInfo, PanelStatus } from '../../src/shared/types.ts'
import { createFakeStore, deferred, installRejectionTraps, makeStatus, tEn, tZh, type FakeStore } from './fixtures.ts'

installRejectionTraps()

afterEach(() => {
  cleanup()
})

const MB = 1024 * 1024

interface FakeApi extends ConfigPageApi {
  saveConfig: ReturnType<typeof vi.fn<ConfigPageApi['saveConfig']>>
  companion: ReturnType<typeof vi.fn<ConfigPageApi['companion']>>
  runtime: ReturnType<typeof vi.fn<ConfigPageApi['runtime']>>
}

function fakeApi(): FakeApi {
  return {
    saveConfig: vi.fn<ConfigPageApi['saveConfig']>(() => Promise.resolve({ ok: true })),
    companion: vi.fn<ConfigPageApi['companion']>(() => Promise.resolve({ ok: true })),
    runtime: vi.fn<ConfigPageApi['runtime']>(() => Promise.resolve({ ok: true })),
  }
}

function renderPage(status: PanelStatus | null, options: {
  error?: ErrorInfo | null
  t?: PromptxTranslate
  language?: 'zh' | 'en'
  api?: FakeApi
} = {}): { store: FakeStore; api: FakeApi; unmount: () => void; container: HTMLElement } {
  const store = createFakeStore({ status, error: options.error ?? null })
  const api = options.api ?? fakeApi()
  const view = render(<ConfigPage t={options.t ?? tZh} store={store} api={api} language={options.language ?? 'zh'} />)
  return { store, api, unmount: view.unmount, container: view.container }
}

function withoutPid(status: PanelStatus): PanelStatus {
  const { companionPid: _pid, ...rest } = status
  return rest
}

const saveButton = (name = '保存'): HTMLButtonElement => screen.getByRole<HTMLButtonElement>('button', { name })
const input = (label: string): HTMLInputElement => screen.getByLabelText<HTMLInputElement>(label)
const switchOf = (label: string): HTMLButtonElement => screen.getByRole<HTMLButtonElement>('switch', { name: label })
const statusLine = (container: HTMLElement): string => container.querySelector('[data-promptx-status]')?.textContent ?? ''
const runtimeLine = (container: HTMLElement): string => container.querySelector('[data-promptx-runtime]')?.textContent ?? ''

/** 让已经结算的 Promise 回调和随之而来的 React 更新都执行完。 */
async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
  })
}

describe('暂存与保存（design-spec 4.4，独立审查 COV-02）', () => {
  it('改动先暂存，一次保存只发一个请求，只带改过的字段', async () => {
    const { api } = renderPage(makeStatus())
    expect(saveButton().disabled).toBe(true)

    fireEvent.change(input('库目录'), { target: { value: '/Users/me/Prompts' } })
    fireEvent.click(switchOf('失焦时隐藏'))
    fireEvent.change(input('下载源'), { target: { value: 'mirror' } })
    // 改了又改回去的字段不算改动。
    fireEvent.click(switchOf('删除前确认'))
    fireEvent.click(switchOf('删除前确认'))
    expect(api.saveConfig).not.toHaveBeenCalled()
    expect(saveButton().disabled).toBe(false)

    fireEvent.click(saveButton())
    expect(api.saveConfig).toHaveBeenCalledTimes(1)
    expect(api.saveConfig).toHaveBeenCalledWith({ libraryDir: '/Users/me/Prompts', hideOnBlur: true, runtimeSource: 'mirror' })
    await flush()
  })

  it('没有改动时「保存」不可用；没有「取消」按钮', () => {
    renderPage(makeStatus())
    expect(saveButton().disabled).toBe(true)
    expect(screen.queryByRole('button', { name: '取消' })).toBeNull()
  })

  it('保存中显示「保存中…」，按钮和字段都不可用；完成后 Host 的新配置到达，暂存项落定', async () => {
    const reply = deferred<ConfigUpdateResult>()
    const api = fakeApi()
    api.saveConfig.mockImplementation(() => reply.promise)
    const { store } = renderPage(makeStatus(), { api })
    fireEvent.change(input('库目录'), { target: { value: ' /Users/me/Prompts ' } })
    fireEvent.click(saveButton())

    const saving = saveButton('保存中…')
    expect(saving.disabled).toBe(true)
    expect(input('库目录').disabled).toBe(true)
    expect(switchOf('失焦时隐藏').disabled).toBe(true)
    // 提交规范化后的值，输入框也换成它。
    expect(api.saveConfig).toHaveBeenCalledWith({ libraryDir: '/Users/me/Prompts' })
    expect(input('库目录').value).toBe('/Users/me/Prompts')

    await act(async () => {
      reply.resolve({ ok: true })
      await reply.promise
    })
    expect(input('库目录').disabled).toBe(false)
    expect(screen.queryByRole('status')).toBeNull()

    act(() => {
      const next = makeStatus({ seq: 2 })
      store.set({ status: { ...next, config: { ...next.config, libraryDir: '/Users/me/Prompts' } }, error: null })
    })
    expect(input('库目录').value).toBe('/Users/me/Prompts')
    expect(saveButton().disabled).toBe(true)
  })

  it('Host 返回字段错误：错误显示在字段下面，暂存的值保留，给出提示；改了这个字段后错误消失', async () => {
    const api = fakeApi()
    api.saveConfig.mockResolvedValue({ ok: false, errors: { libraryDir: 'library-dir-reserved' } })
    renderPage(makeStatus(), { api })
    fireEvent.change(input('库目录'), { target: { value: '/Users/me/.dsh/sessions' } })
    fireEvent.click(switchOf('失焦时隐藏'))
    fireEvent.click(saveButton())
    await flush()

    const field = input('库目录')
    expect(field.value).toBe('/Users/me/.dsh/sessions')
    expect(field.getAttribute('aria-invalid')).toBe('true')
    const message = document.getElementById(field.getAttribute('aria-describedby') ?? '')
    expect(message?.textContent).toBe('库目录不能放在 dsh 的数据目录里（默认的 promptx/library 除外）。')
    expect(switchOf('失焦时隐藏').getAttribute('aria-checked')).toBe('true')
    expect(screen.getByRole('status').textContent).toBe('有设置没有通过检查，改动已保留，改好后再保存。')
    expect(saveButton().disabled).toBe(true)

    fireEvent.change(input('库目录'), { target: { value: '/Users/me/Prompts' } })
    expect(input('库目录').getAttribute('aria-invalid')).toBeNull()
    expect(screen.queryByRole('status')).toBeNull()
    expect(saveButton().disabled).toBe(false)
  })

  it('Host 的其他字段错误也显示在各自下面', async () => {
    const api = fakeApi()
    api.saveConfig.mockResolvedValue({ ok: false, errors: { hideOnBlur: 'value-invalid', globalShortcut: 'shortcut-invalid' } })
    renderPage(makeStatus(), { api })
    fireEvent.click(switchOf('失焦时隐藏'))
    fireEvent.change(input('全局快捷键'), { target: { value: 'Control+Alt+K' } })
    fireEvent.click(saveButton())
    await flush()
    expect(screen.getByText('这个值不能用。')).toBeTruthy()
    expect(input('全局快捷键').getAttribute('aria-invalid')).toBe('true')
  })

  it('保存失败（不是字段错误）：提示原因，暂存的值保留，可以再保存一次', async () => {
    const api = fakeApi()
    api.saveConfig
      .mockResolvedValueOnce({ ok: false, errors: {}, error: { code: 'promptx/settings/unavailable' } })
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce({ ok: false, errors: {} })
    renderPage(makeStatus(), { api })
    fireEvent.change(input('优化指令'), { target: { value: '请把 Prompt 改得更短。' } })

    fireEvent.click(saveButton())
    await flush()
    expect(screen.getByRole('status').textContent).toBe('没有保存成功：dsh 的设置服务暂时不可用。改动已保留，可以再试一次。')
    expect(input('优化指令').value).toBe('请把 Prompt 改得更短。')
    expect(saveButton().disabled).toBe(false)

    fireEvent.click(saveButton())
    await flush()
    expect(screen.getByRole('status').textContent).toContain('内部错误（Failed to fetch）')

    fireEvent.click(saveButton())
    await flush()
    expect(screen.getByRole('status').textContent).toBe('没有保存成功：内部错误。改动已保留，可以再试一次。')
    expect(api.saveConfig).toHaveBeenCalledTimes(3)
  })

  it('页面自己能查出的错误：相对路径的库目录、不合法的快捷键，「保存」不可用', () => {
    renderPage(makeStatus())
    fireEvent.change(input('库目录'), { target: { value: 'Prompts' } })
    expect(input('库目录').getAttribute('aria-invalid')).toBe('true')
    expect(screen.getByText('库目录要写绝对路径，或以 ~ 开头。')).toBeTruthy()
    expect(saveButton().disabled).toBe(true)
    fireEvent.change(input('库目录'), { target: { value: '~/Prompts' } })
    expect(saveButton().disabled).toBe(false)

    fireEvent.change(input('全局快捷键'), { target: { value: 'Shift+P' } })
    expect(input('全局快捷键').getAttribute('aria-invalid')).toBe('true')
    expect(saveButton().disabled).toBe(true)
  })

  it('Windows 上的库目录按盘符判断（按运行 dsh 的电脑的平台）', () => {
    renderPage(makeStatus({ platform: 'win32' }))
    fireEvent.change(input('库目录'), { target: { value: 'D:\\Prompts' } })
    expect(input('库目录').getAttribute('aria-invalid')).toBeNull()
    expect(saveButton().disabled).toBe(false)
  })

  it('快捷键按规范写法提交，输入框也换成规范写法', async () => {
    const { api } = renderPage(makeStatus())
    fireEvent.change(input('全局快捷键'), { target: { value: 'alt+ctrl+k' } })
    expect(screen.getByText('⌃⌥K')).toBeTruthy()
    fireEvent.click(saveButton())
    expect(api.saveConfig).toHaveBeenCalledWith({ globalShortcut: 'Control+Alt+K' })
    expect(input('全局快捷键').value).toBe('Control+Alt+K')
    await flush()
  })

  it('清空全局快捷键可以保存（只能从菜单栏图标打开小窗）', async () => {
    const { api } = renderPage(makeStatus())
    fireEvent.change(input('全局快捷键'), { target: { value: '' } })
    fireEvent.click(saveButton())
    expect(api.saveConfig).toHaveBeenCalledWith({ globalShortcut: '' })
    await flush()
  })

  it('「恢复默认指令」只把指令框暂存为空，占位文字是默认指令', async () => {
    const status = makeStatus()
    const { api } = renderPage({ ...status, config: { ...status.config, optimizeInstruction: '自定义指令' } })
    const textarea = input('优化指令')
    expect(textarea.value).toBe('自定义指令')
    expect(textarea.placeholder).toBe(DEFAULT_INSTRUCTION.zh)

    const restore = screen.getByRole<HTMLButtonElement>('button', { name: '恢复默认指令' })
    fireEvent.click(restore)
    expect(input('优化指令').value).toBe('')
    expect(restore.disabled).toBe(true)
    expect(api.saveConfig).not.toHaveBeenCalled()

    fireEvent.click(saveButton())
    expect(api.saveConfig).toHaveBeenCalledWith({ optimizeInstruction: '' })
    await flush()
  })

  it('默认指令的占位文字跟着界面语言', () => {
    renderPage(makeStatus(), { t: tEn, language: 'en' })
    expect(input('Optimization instruction').placeholder).toBe(DEFAULT_INSTRUCTION.en)
  })

  it('库目录的占位文字是当前生效的库目录', () => {
    renderPage(makeStatus())
    expect(input('库目录').placeholder).toBe('/Users/me/.dsh/promptx/library')
  })

  it('别处改了配置：没暂存的字段显示新值，暂存着的字段保持用户的值', () => {
    const { store } = renderPage(makeStatus())
    fireEvent.change(input('全局快捷键'), { target: { value: 'Control+Alt+K' } })
    act(() => {
      const next = makeStatus({ seq: 5 })
      store.set({ status: { ...next, config: { ...next.config, libraryDir: '/Shared/Prompts', globalShortcut: 'Control+Alt+J' } }, error: null })
    })
    expect(input('库目录').value).toBe('/Shared/Prompts')
    expect(input('全局快捷键').value).toBe('Control+Alt+K')
  })

  it('保存成功后、Host 的新配置还没到：字段显示刚保存的值，「保存」不可用，不会把同样的改动再提交一遍', async () => {
    const { api, store } = renderPage(makeStatus())
    fireEvent.change(input('库目录'), { target: { value: '/Users/me/Prompts' } })
    fireEvent.click(switchOf('失焦时隐藏'))
    fireEvent.click(saveButton())
    await flush()
    expect(api.saveConfig).toHaveBeenCalledTimes(1)
    expect(input('库目录').value).toBe('/Users/me/Prompts')
    expect(switchOf('失焦时隐藏').getAttribute('aria-checked')).toBe('true')
    expect(saveButton().disabled).toBe(true)

    // 期间来了一次配置没变的状态（例如下载进度）：仍按刚保存的值显示。
    act(() => {
      store.set({ status: makeStatus({ seq: 2, companionPid: 4243 }), error: null })
    })
    expect(input('库目录').value).toBe('/Users/me/Prompts')
    expect(saveButton().disabled).toBe(true)

    // 新配置到了：和刚保存的一样，页面不跳动。
    act(() => {
      const next = makeStatus({ seq: 3 })
      store.set({ status: { ...next, config: { ...next.config, libraryDir: '/Users/me/Prompts', hideOnBlur: true } }, error: null })
    })
    expect(input('库目录').value).toBe('/Users/me/Prompts')
    expect(switchOf('失焦时隐藏').getAttribute('aria-checked')).toBe('true')
    expect(saveButton().disabled).toBe(true)

    // 之后配置又被改回保存前的样子（别的页面改的）：照 Host 显示，刚才那次保存的值不会又冒出来。
    act(() => {
      store.set({ status: makeStatus({ seq: 4 }), error: null })
    })
    expect(input('库目录').value).toBe('')
    expect(switchOf('失焦时隐藏').getAttribute('aria-checked')).toBe('false')
    expect(saveButton().disabled).toBe(true)
  })

  it('保存成功后 Host 报来的值和提交的不同（别处同时改了）：以 Host 为准', async () => {
    const { store } = renderPage(makeStatus())
    fireEvent.change(input('库目录'), { target: { value: '/Users/me/Prompts' } })
    fireEvent.click(saveButton())
    await flush()
    act(() => {
      const next = makeStatus({ seq: 2 })
      store.set({ status: { ...next, config: { ...next.config, libraryDir: '/Shared/Prompts' } }, error: null })
    })
    expect(input('库目录').value).toBe('/Shared/Prompts')
    expect(saveButton().disabled).toBe(true)
  })

  it('保存成功、新配置还没到时又改回原值：算改动，提交原值', async () => {
    const { api } = renderPage(makeStatus())
    fireEvent.click(switchOf('失焦时隐藏'))
    fireEvent.click(saveButton())
    await flush()
    fireEvent.click(switchOf('失焦时隐藏'))
    expect(switchOf('失焦时隐藏').getAttribute('aria-checked')).toBe('false')
    expect(saveButton().disabled).toBe(false)
    fireEvent.click(saveButton())
    expect(api.saveConfig).toHaveBeenLastCalledWith({ hideOnBlur: false })
    await flush()
  })

  it('长轮询比保存的回复先带回新配置：不留覆盖，照 Host 显示', async () => {
    const reply = deferred<ConfigUpdateResult>()
    const api = fakeApi()
    api.saveConfig.mockImplementation(() => reply.promise)
    const { store } = renderPage(makeStatus(), { api })
    fireEvent.change(input('全局快捷键'), { target: { value: 'Control+Alt+K' } })
    fireEvent.click(saveButton())
    act(() => {
      const next = makeStatus({ seq: 2 })
      store.set({ status: { ...next, config: { ...next.config, globalShortcut: 'Control+Alt+K' } }, error: null })
    })
    await act(async () => {
      reply.resolve({ ok: true })
      await reply.promise
    })
    expect(input('全局快捷键').value).toBe('Control+Alt+K')
    expect(saveButton().disabled).toBe(true)
    act(() => {
      const next = makeStatus({ seq: 3 })
      store.set({ status: { ...next, config: { ...next.config, globalShortcut: 'Control+Alt+J' } }, error: null })
    })
    expect(input('全局快捷键').value).toBe('Control+Alt+J')
  })

  it('只有空白的优化指令和 Host 一样按「用默认指令」处理，提交空串', async () => {
    const status = makeStatus()
    const { api } = renderPage({ ...status, config: { ...status.config, optimizeInstruction: '自定义指令' } })
    fireEvent.change(input('优化指令'), { target: { value: '  \n ' } })
    fireEvent.click(saveButton())
    expect(api.saveConfig).toHaveBeenCalledWith({ optimizeInstruction: '' })
    await flush()
    expect(input('优化指令').value).toBe('')
    expect(saveButton().disabled).toBe(true)
  })

  it('指令本来就是默认（空）时只输入空白不算改动', () => {
    renderPage(makeStatus())
    fireEvent.change(input('优化指令'), { target: { value: '   ' } })
    expect(saveButton().disabled).toBe(true)
  })

  it('有内容的指令原样提交，不去掉首尾空白', async () => {
    const { api } = renderPage(makeStatus())
    fireEvent.change(input('优化指令'), { target: { value: '  只改错字。\n' } })
    fireEvent.click(saveButton())
    expect(api.saveConfig).toHaveBeenCalledWith({ optimizeInstruction: '  只改错字。\n' })
    await flush()
  })

  it('保存进行中离开页面：回复回来后不再更新已卸载的组件', async () => {
    const reply = deferred<ConfigUpdateResult>()
    const api = fakeApi()
    api.saveConfig.mockImplementation(() => reply.promise)
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const { unmount } = renderPage(makeStatus(), { api })
      fireEvent.click(switchOf('失焦时隐藏'))
      fireEvent.click(saveButton())
      unmount()
      await act(async () => {
        reply.resolve({ ok: false, errors: { hideOnBlur: 'value-invalid' } })
        await reply.promise
      })
      expect(errors).not.toHaveBeenCalled()
    } finally {
      errors.mockRestore()
    }
  })

  it('离开页面丢弃没保存的改动', () => {
    const { store, unmount } = renderPage(makeStatus())
    fireEvent.change(input('库目录'), { target: { value: '/tmp/unsaved' } })
    unmount()
    render(<ConfigPage t={tZh} store={store} api={fakeApi()} language="zh" />)
    expect(input('库目录').value).toBe('')
  })
})

describe('开关', () => {
  it('role="switch" 和 aria-checked 跟着切换；点标签文字也能切换', () => {
    renderPage(makeStatus())
    const hide = switchOf('失焦时隐藏')
    expect(hide.getAttribute('aria-checked')).toBe('false')
    fireEvent.click(hide)
    expect(switchOf('失焦时隐藏').getAttribute('aria-checked')).toBe('true')
    fireEvent.click(screen.getByText('失焦时隐藏'))
    expect(switchOf('失焦时隐藏').getAttribute('aria-checked')).toBe('false')

    const confirm = switchOf('删除前确认')
    expect(confirm.getAttribute('aria-checked')).toBe('true')
    fireEvent.click(confirm)
    expect(switchOf('删除前确认').getAttribute('aria-checked')).toBe('false')
  })

  it('每个控件都有可见的名字，可以用键盘到达', () => {
    renderPage(makeStatus())
    for (const label of ['库目录', '全局快捷键', '优化指令', '下载源']) expect(input(label).tabIndex).toBe(0)
    for (const label of ['失焦时隐藏', '删除前确认']) expect(switchOf(label).tagName).toBe('BUTTON')
    for (const name of ['录制', '重启小窗', '显示小窗', '删除运行时', '恢复默认指令', '保存']) {
      expect(screen.getByRole('button', { name }).tagName).toBe('BUTTON')
    }
  })
})

describe('快捷键录制', () => {
  it('按「录制」后按下组合键，换算成加速键写法填进输入框（暂存）', async () => {
    const { api } = renderPage(makeStatus({ platform: 'linux' }))
    const record = screen.getByRole<HTMLButtonElement>('button', { name: '录制' })
    fireEvent.click(record)
    expect(record.getAttribute('aria-pressed')).toBe('true')
    expect(record.textContent).toBe('正在录制…')
    expect(screen.getByText('请按下新的组合键，按 Esc 取消。')).toBeTruthy()

    // 只按了修饰键：继续等。
    expect(fireEvent.keyDown(record, { key: 'Control', code: 'ControlLeft', ctrlKey: true })).toBe(false)
    expect(record.getAttribute('aria-pressed')).toBe('true')
    // 没有修饰键的组合不合法：继续等。
    fireEvent.keyDown(record, { key: 'k', code: 'KeyK' })
    expect(record.getAttribute('aria-pressed')).toBe('true')

    expect(fireEvent.keyDown(record, { key: 'k', code: 'KeyK', ctrlKey: true, altKey: true })).toBe(false)
    expect(input('全局快捷键').value).toBe('Control+Alt+K')
    expect(record.getAttribute('aria-pressed')).toBe('false')
    expect(screen.getByText('Ctrl+Alt+K')).toBeTruthy()
    expect(api.saveConfig).not.toHaveBeenCalled()

    fireEvent.click(saveButton())
    expect(api.saveConfig).toHaveBeenCalledWith({ globalShortcut: 'Control+Alt+K' })
    await flush()
  })

  it('开始录制时按钮拿到焦点（Safari 点按钮不给焦点，按键会到不了录制按钮）', () => {
    renderPage(makeStatus())
    const record = screen.getByRole('button', { name: '录制' })
    expect(document.activeElement).not.toBe(record)
    fireEvent.click(record)
    expect(document.activeElement).toBe(record)
    // 再点一次结束录制。
    fireEvent.click(record)
    expect(record.getAttribute('aria-pressed')).toBe('false')
  })

  it('保存中不能录制', async () => {
    const reply = deferred<ConfigUpdateResult>()
    const api = fakeApi()
    api.saveConfig.mockImplementation(() => reply.promise)
    renderPage(makeStatus(), { api })
    fireEvent.click(switchOf('失焦时隐藏'))
    fireEvent.click(saveButton())
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '录制' }).disabled).toBe(true)
    await act(async () => {
      reply.resolve({ ok: true })
      await reply.promise
    })
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '录制' }).disabled).toBe(false)
  })

  it('macOS 上 ⌘ 录成 Command，显示成符号', () => {
    renderPage(makeStatus({ platform: 'darwin' }))
    const record = screen.getByRole('button', { name: '录制' })
    fireEvent.click(record)
    fireEvent.keyDown(record, { key: 'π', code: 'KeyP', metaKey: true, altKey: true })
    expect(input('全局快捷键').value).toBe('Command+Alt+P')
    expect(screen.getByText('⌥⌘P')).toBeTruthy()
  })

  it('Esc 取消录制，失焦也结束录制，输入框不变', () => {
    renderPage(makeStatus())
    const record = screen.getByRole('button', { name: '录制' })
    fireEvent.click(record)
    fireEvent.keyDown(record, { key: 'Escape', code: 'Escape' })
    expect(record.getAttribute('aria-pressed')).toBe('false')
    expect(input('全局快捷键').value).toBe('Control+P')

    fireEvent.click(record)
    fireEvent.blur(record)
    expect(record.getAttribute('aria-pressed')).toBe('false')
    fireEvent.keyDown(record, { key: 'k', code: 'KeyK', ctrlKey: true })
    expect(input('全局快捷键').value).toBe('Control+P')
  })

  it('Tab 不拦，焦点可以照常移走', () => {
    renderPage(makeStatus())
    const record = screen.getByRole('button', { name: '录制' })
    fireEvent.click(record)
    expect(fireEvent.keyDown(record, { key: 'Tab', code: 'Tab' })).toBe(true)
    expect(fireEvent.keyDown(record, { key: 'Tab', code: 'Tab', shiftKey: true })).toBe(true)
  })

  it('组字中的按键不处理', () => {
    renderPage(makeStatus())
    const record = screen.getByRole('button', { name: '录制' })
    fireEvent.click(record)
    fireEvent.keyDown(record, { key: 'Process', code: 'KeyK', ctrlKey: true, isComposing: true })
    expect(input('全局快捷键').value).toBe('Control+P')
    expect(record.getAttribute('aria-pressed')).toBe('true')
  })
})

describe('小窗状态行（需求 5.9、5.11、F-05）', () => {
  it('运行中：状态、全局快捷键、运行时版本、进程号', () => {
    const { container } = renderPage(makeStatus())
    expect(statusLine(container)).toBe('运行中 · 全局快捷键 ⌃P 已生效 · 运行时 44.10.2')
    expect(screen.getByText('小窗进程号：4242')).toBeTruthy()
    expect(container.querySelector('[data-promptx-status] .promptx-dot')?.getAttribute('data-state')).toBe('done')
  })

  it('全局快捷键没有生效：写明原因', () => {
    const { container } = renderPage(makeStatus({
      shortcut: { accelerator: 'Control+P', registered: false, error: { code: 'promptx/shortcut/held-by-profile', detail: 'work' } },
    }))
    expect(statusLine(container)).toBe('运行中 · 全局快捷键 ⌃P 没有生效：已被另一个 profile 的 PromptX 使用（work） · 运行时 44.10.2')
    expect(container.querySelector('[data-promptx-status] .promptx-dot')?.getAttribute('data-state')).toBe('warning')
  })

  it('全局快捷键可能和系统快捷键冲突：写明提醒', () => {
    const status = makeStatus({
      shortcut: { accelerator: 'Control+Space', registered: true, warning: { code: 'promptx/shortcut/system-conflict', detail: '输入法切换' } },
    })
    const { container } = renderPage({ ...status, config: { ...status.config, globalShortcut: 'Control+Space' } })
    expect(statusLine(container)).toBe('运行中 · 全局快捷键 ⌃Space 已登记，可能与系统快捷键冲突（输入法切换） · 运行时 44.10.2')
    expect(container.querySelector('[data-promptx-status] .promptx-dot')?.getAttribute('data-state')).toBe('warning')
  })

  it('新组合登记失败、退回旧组合：写明「新组合 X 登记失败，仍使用 Y」（design-spec 5.4）', () => {
    const status = makeStatus({
      shortcut: { accelerator: 'Control+P', registered: true, warning: { code: 'promptx/shortcut/taken', detail: 'Control+Alt+K' } },
    })
    const { container } = renderPage({ ...status, config: { ...status.config, globalShortcut: 'Control+Alt+K' } })
    expect(statusLine(container)).toBe('运行中 · 新组合 ⌃⌥K 登记失败（这个组合已被别的应用占用），仍使用 ⌃P · 运行时 44.10.2')
    expect(container.querySelector('[data-promptx-status] .promptx-dot')?.getAttribute('data-state')).toBe('warning')
  })

  it('退回旧组合时 detail 不是新组合（例如 profile 名）就照常带上', () => {
    const status = makeStatus({
      platform: 'linux',
      shortcut: { accelerator: 'Control+Alt+P', registered: true, error: { code: 'promptx/shortcut/held-by-profile', detail: 'work' } },
    })
    const { container } = renderPage({ ...status, config: { ...status.config, globalShortcut: 'Control+Alt+K' } })
    expect(statusLine(container)).toBe(
      '运行中 · 新组合 Ctrl+Alt+K 登记失败（已被另一个 profile 的 PromptX 使用（work）），仍使用 Ctrl+Alt+P · 运行时 44.10.2',
    )
  })

  it('刚保存了新组合、小程序还没重新登记（上报的仍是旧组合，没有错误）：写「还没有登记」，不说成已生效', () => {
    const status = makeStatus({ shortcut: { accelerator: 'Control+P', registered: true } })
    const { container } = renderPage({ ...status, config: { ...status.config, globalShortcut: 'Control+Alt+K' } })
    expect(statusLine(container)).toBe('运行中 · 全局快捷键 ⌃⌥K 还没有登记 · 运行时 44.10.2')
    expect(container.querySelector('[data-promptx-status] .promptx-dot')?.getAttribute('data-state')).toBe('done')
  })

  it('配置里的写法不规范（手改补丁文件）也按规范写法和上报的组合比较', () => {
    const status = makeStatus({ shortcut: { accelerator: 'Control+Alt+K', registered: true } })
    const { container } = renderPage({ ...status, config: { ...status.config, globalShortcut: ' alt+ctrl+k ' } })
    expect(statusLine(container)).toBe('运行中 · 全局快捷键 ⌃⌥K 已生效 · 运行时 44.10.2')
  })

  it('配置里的组合不合法：小程序报登记失败，原因照写', () => {
    const status = makeStatus({
      shortcut: { accelerator: 'P', registered: false, error: { code: 'promptx/shortcut/invalid', detail: 'no-modifier' } },
    })
    const { container } = renderPage({ ...status, config: { ...status.config, globalShortcut: 'P' } })
    expect(statusLine(container)).toBe('运行中 · 全局快捷键 P 没有生效：快捷键写法不对（no-modifier） · 运行时 44.10.2')
  })

  it('没有设置全局快捷键、还没登记', () => {
    const status = makeStatus({ shortcut: null })
    const first = renderPage({ ...status, config: { ...status.config, globalShortcut: '' } })
    expect(statusLine(first.container)).toBe('运行中 · 没有设置全局快捷键 · 运行时 44.10.2')
    first.unmount()
    const second = renderPage(makeStatus({ shortcut: null, platform: 'win32', config: { ...status.config, globalShortcut: 'Control+Alt+P' } }))
    expect(statusLine(second.container)).toBe('运行中 · 全局快捷键 Ctrl+Alt+P 还没有登记 · 运行时 44.10.2')
  })

  it('运行时没准备好时显示「小窗正在准备」', () => {
    const { container } = renderPage(withoutPid(makeStatus({ companion: { state: 'waiting-runtime' }, shortcut: null })))
    expect(statusLine(container)).toBe('小窗正在准备 · 运行时 44.10.2')
    expect(container.querySelector('[data-promptx-status] .promptx-dot')?.getAttribute('data-state')).toBe('ongoing')
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '显示小窗' }).disabled).toBe(true)
  })

  it('小程序失败（30 秒内连续 3 次）：显示原因，可以手动「重启小窗」', async () => {
    const { container, api } = renderPage(withoutPid(makeStatus({
      companion: { state: 'failed', error: { code: 'promptx/companion/exited', detail: 'code 1' }, restartsExhausted: true },
      shortcut: null,
    })))
    expect(statusLine(container)).toBe('没能启动 · 运行时 44.10.2')
    const alert = screen.getByRole('alert')
    expect(alert.textContent).toContain('小窗没能启动：进程意外退出（code 1）')
    expect(alert.textContent).toContain('30 秒内连续失败了 3 次，已停止自动重启。')
    expect(screen.queryByText(/小窗进程号/)).toBeNull()
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '显示小窗' }).disabled).toBe(true)

    const restart = screen.getByRole<HTMLButtonElement>('button', { name: '重启小窗' })
    expect(restart.disabled).toBe(false)
    fireEvent.click(restart)
    expect(api.companion).toHaveBeenCalledWith('restart')
    await flush()
  })

  it('自动重启期间写上次退出的原因', () => {
    const { container } = renderPage(withoutPid(makeStatus({
      companion: { state: 'restarting', error: { code: 'promptx/companion/heartbeat-lost' } },
      shortcut: null,
    })))
    expect(statusLine(container)).toBe('正在重启 · 运行时 44.10.2')
    expect(screen.getByText('上次退出的原因：进程没有响应')).toBeTruthy()
    expect(container.querySelector('[data-promptx-status] .promptx-dot')?.getAttribute('data-state')).toBe('ongoing')
  })

  it('已停止（例如运行时被删除）：状态点为空闲，不写快捷键', () => {
    const { container } = renderPage(withoutPid(makeStatus({ companion: { state: 'stopped' }, shortcut: null })))
    expect(statusLine(container)).toBe('已停止 · 运行时 44.10.2')
    expect(container.querySelector('[data-promptx-status] .promptx-dot')?.getAttribute('data-state')).toBe('idle')
  })

  it('「重启小窗」立即执行（运行中也可以）', async () => {
    const { api } = renderPage(makeStatus())
    fireEvent.click(screen.getByRole('button', { name: '重启小窗' }))
    expect(api.companion).toHaveBeenCalledWith('restart')
    await flush()
  })

  it('「显示小窗」立即执行；动作进行中其他动作按钮不可用；失败时写原因', async () => {
    const reply = deferred<ActionResult>()
    const api = fakeApi()
    api.companion.mockImplementation(() => reply.promise)
    renderPage(makeStatus(), { api })
    fireEvent.click(screen.getByRole('button', { name: '显示小窗' }))
    expect(api.companion).toHaveBeenCalledWith('show')
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '重启小窗' }).disabled).toBe(true)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '删除运行时' }).disabled).toBe(true)
    await act(async () => {
      reply.resolve({ ok: false, error: { code: 'promptx/internal' } })
      await reply.promise
    })
    expect(screen.getByText('操作没有完成：内部错误')).toBeTruthy()
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '重启小窗' }).disabled).toBe(false)
  })
})

describe('运行时（需求 F-06、6.8、7.8）', () => {
  it('下载中：进度条、已下载 / 总大小、下载源', () => {
    const { container } = renderPage(withoutPid(makeStatus({
      companion: { state: 'waiting-runtime' },
      shortcut: null,
      runtime: { state: 'downloading', version: '44.10.2', dir: '/r', received: 50 * MB, total: 100 * MB, source: 'mirror' },
    })))
    expect(runtimeLine(container)).toBe('正在下载 Electron 44.10.2')
    const bar = screen.getByRole('progressbar', { name: '运行时下载进度' })
    expect(bar.getAttribute('aria-valuenow')).toBe('50')
    expect(screen.getByText('50.0 MB / 100.0 MB（50%） · 国内镜像')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '删除运行时' })).toBeNull()
    expect(screen.queryByRole('button', { name: '下载' })).toBeNull()
  })

  it('下载中但总大小未知：进度条不报数值', () => {
    renderPage(makeStatus({
      runtime: { state: 'downloading', version: '44.10.2', dir: '/r', received: 12 * MB, source: 'official', error: { code: 'promptx/runtime/locked' } },
    }))
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBeNull()
    expect(screen.getByText('已下载 12.0 MB · 官方源')).toBeTruthy()
    expect(screen.getByText('另一个 dsh 进程正在下载运行时')).toBeTruthy()
  })

  it('下载失败：写明原因，「重试」立即执行', async () => {
    const { container, api } = renderPage(makeStatus({
      companion: { state: 'waiting-runtime' },
      runtime: { state: 'failed', version: '44.10.2', dir: '/r', error: { code: 'promptx/runtime/download-failed', detail: 'ECONNRESET' } },
    }))
    expect(runtimeLine(container)).toBe('运行时下载没有完成：下载失败，请检查网络（ECONNRESET）')
    // 运行时失败时「正在准备」不会自己好起来，状态点用提醒色。
    expect(container.querySelector('[data-promptx-status] .promptx-dot')?.getAttribute('data-state')).toBe('warning')
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    expect(api.runtime).toHaveBeenCalledWith('download')
    await flush()
  })

  it('删除后暂停：说明暂停，「下载」立即执行', async () => {
    const { container, api } = renderPage(makeStatus({
      companion: { state: 'stopped' },
      runtime: { state: 'missing', paused: true, version: '44.10.2', dir: '/r' },
    }))
    expect(runtimeLine(container)).toBe('已删除运行时，自动下载已暂停；点「下载」可以重新下载。')
    expect(screen.queryByRole('button', { name: '删除运行时' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '下载' }))
    expect(api.runtime).toHaveBeenCalledWith('download')
    await flush()
  })

  it('还没下载（没有暂停）也给出「下载」', () => {
    const { container } = renderPage(makeStatus({ runtime: { state: 'missing', version: '44.10.2', dir: '/r' } }))
    expect(runtimeLine(container)).toBe('还没有下载 Electron 44.10.2')
    expect(screen.getByRole('button', { name: '下载' })).toBeTruthy()
  })

  it('解压中、已就绪、平台不支持', () => {
    const first = renderPage(makeStatus({ runtime: { state: 'extracting', version: '44.10.2', dir: '/r' } }))
    expect(runtimeLine(first.container)).toBe('正在解压 Electron 44.10.2')
    first.unmount()
    const second = renderPage(makeStatus())
    expect(runtimeLine(second.container)).toBe('已下载 · Electron 44.10.2')
    expect(screen.getByText('运行时目录：/Users/me/.dsh/promptx/runtime')).toBeTruthy()
    second.unmount()
    const third = renderPage(withoutPid(makeStatus({
      companion: { state: 'stopped' }, shortcut: null, runtime: { state: 'unsupported', version: '44.10.2', dir: '/r' },
    })))
    expect(runtimeLine(third.container)).toBe('这台电脑的系统或处理器不在支持范围内，小窗不能使用。')
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '重启小窗' }).disabled).toBe(true)
  })

  it('「删除运行时」先在页面里确认：取消不删，焦点回到按钮；Esc 也是取消', () => {
    const { api } = renderPage(makeStatus())
    const remove = screen.getByRole('button', { name: '删除运行时' })
    fireEvent.click(remove)
    const group = screen.getByRole('group')
    expect(group.textContent).toContain('删除后小窗会停止，也不再自动下载')
    expect(document.activeElement).toBe(within(group).getByRole('button', { name: '取消' }))

    fireEvent.click(within(group).getByRole('button', { name: '取消' }))
    expect(screen.queryByRole('group')).toBeNull()
    expect(document.activeElement).toBe(remove)

    fireEvent.click(remove)
    fireEvent.keyDown(screen.getByRole('group'), { key: 'Escape' })
    expect(screen.queryByRole('group')).toBeNull()
    expect(api.runtime).not.toHaveBeenCalled()
  })

  it('确认期间运行时变成不能删除的状态：确认收起，之后不会自己再冒出来', () => {
    const { store } = renderPage(makeStatus())
    fireEvent.click(screen.getByRole('button', { name: '删除运行时' }))
    expect(screen.getByRole('group')).toBeTruthy()
    act(() => {
      store.set({ status: makeStatus({ seq: 2, runtime: { state: 'downloading', version: '44.10.2', dir: '/r' } }), error: null })
    })
    expect(screen.queryByRole('group')).toBeNull()
    act(() => {
      store.set({ status: makeStatus({ seq: 3 }), error: null })
    })
    expect(screen.queryByRole('group')).toBeNull()
  })

  it('确认后删除；被其他 profile 使用的版本写在页面上', async () => {
    const api = fakeApi()
    api.runtime.mockResolvedValue({ ok: true, inUseBy: [{ profile: 'work', version: '44.10.2' }] })
    renderPage(makeStatus(), { api })
    fireEvent.click(screen.getByRole('button', { name: '删除运行时' }))
    fireEvent.click(within(screen.getByRole('group')).getByRole('button', { name: '删除' }))
    expect(api.runtime).toHaveBeenCalledWith('delete')
    await flush()
    expect(screen.getByText('下面的版本正被其他 profile 使用，没有删除：44.10.2（profile work）')).toBeTruthy()
  })

  it('状态里带着 inUseBy 时直接显示', () => {
    renderPage(makeStatus({
      runtime: {
        state: 'ready', version: '44.10.2', dir: '/r',
        inUseBy: [{ profile: 'work', version: '44.9.0' }, { profile: '生活', version: '44.8.1' }],
      },
    }))
    expect(screen.getByText('下面的版本正被其他 profile 使用，没有删除：44.9.0（profile work）、44.8.1（profile 生活）')).toBeTruthy()
  })

  it('删除失败时写原因', async () => {
    const api = fakeApi()
    api.runtime.mockResolvedValue({ ok: false, error: { code: 'promptx/runtime/in-use', detail: 'EBUSY' } })
    renderPage(makeStatus(), { api })
    fireEvent.click(screen.getByRole('button', { name: '删除运行时' }))
    fireEvent.click(within(screen.getByRole('group')).getByRole('button', { name: '删除' }))
    await flush()
    expect(screen.getByText('操作没有完成：运行时的文件正在使用，没能全部删除（EBUSY）')).toBeTruthy()
  })

  it('等另一个 dsh 进程下载（下载中但没有字节数）：不确定进度的条，写明在等别的进程', () => {
    const { container } = renderPage(withoutPid(makeStatus({
      companion: { state: 'waiting-runtime' },
      shortcut: null,
      runtime: { state: 'downloading', version: '44.10.2', dir: '/r', source: 'mirror' },
    })))
    expect(runtimeLine(container)).toBe('正在下载 Electron 44.10.2')
    const bar = screen.getByRole('progressbar', { name: '运行时下载进度' })
    expect(bar.getAttribute('aria-valuenow')).toBeNull()
    expect(bar.hasAttribute('data-indeterminate')).toBe(true)
    expect(screen.getByText('另一个 dsh 进程正在下载运行时，下载完成后这里直接使用。')).toBeTruthy()
    expect(screen.queryByText(/MB/)).toBeNull()
    // 运行时没就绪时状态行不写运行时版本，免得像是已经装好了。
    expect(statusLine(container)).toBe('小窗正在准备')
  })

  it('删除后暂停时不再显示之前的错误', () => {
    renderPage(makeStatus({
      companion: { state: 'stopped' },
      runtime: { state: 'missing', paused: true, version: '44.10.2', dir: '/r', error: { code: 'promptx/runtime/download-failed', detail: 'paused' } },
    }))
    expect(screen.queryByText(/下载失败/)).toBeNull()
  })

  it('删除运行时之后：确认收起，状态变成已删除、暂停，「下载」可用（审查 COV-10）', async () => {
    const api = fakeApi()
    const { store, container } = renderPage(makeStatus(), { api })
    fireEvent.click(screen.getByRole('button', { name: '删除运行时' }))
    fireEvent.click(within(screen.getByRole('group')).getByRole('button', { name: '删除' }))
    await flush()
    act(() => {
      store.set({
        status: withoutPid(makeStatus({
          seq: 2,
          companion: { state: 'stopped' },
          shortcut: null,
          runtime: { state: 'missing', paused: true, version: '44.10.2', dir: '/r' },
        })),
        error: null,
      })
    })
    expect(screen.queryByRole('group')).toBeNull()
    expect(runtimeLine(container)).toBe('已删除运行时，自动下载已暂停；点「下载」可以重新下载。')
    expect(statusLine(container)).toBe('已停止')
    expect(screen.queryByRole('button', { name: '删除运行时' })).toBeNull()
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '下载' }).disabled).toBe(false)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '显示小窗' }).disabled).toBe(true)
    // 运行时删掉了、自动下载暂停：重启起不来，先「下载」。
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '重启小窗' }).disabled).toBe(true)
  })
})

describe('整页状态', () => {
  it('还没拿到状态时显示读取中；连不上时写原因', () => {
    const first = renderPage(null)
    expect(screen.getByRole('status').textContent).toBe('正在读取 PromptX 的状态…')
    expect(screen.queryByRole('button', { name: '保存' })).toBeNull()
    first.unmount()
    renderPage(null, { error: { code: 'promptx/channel/closed', detail: 'Failed to fetch' } })
    expect(screen.getByRole('status').textContent).toBe('连不上 PromptX 插件（连接断开了（Failed to fetch）），正在重试…')
  })

  it('另一个 dsh 进程在为这个 profile 运行 PromptX：整页只显示说明', () => {
    renderPage(makeStatus({ instance: 'duplicate' }))
    expect(screen.getByRole('status').textContent).toContain('另一个 dsh 进程已在为这个 profile 运行 PromptX')
    expect(screen.queryByRole('button')).toBeNull()
    expect(screen.queryByRole('switch')).toBeNull()
    expect(screen.queryByRole('textbox')).toBeNull()
  })

  it('连接中断时保留上次的状态，并提示正在重连', () => {
    renderPage(makeStatus(), { error: { code: 'promptx/channel/timeout' } })
    expect(screen.getByText('和 PromptX 插件的连接断了，正在重连；下面显示的可能不是最新状态。')).toBeTruthy()
    expect(input('库目录')).toBeTruthy()
  })

  it('样式随组件渲染，类名都带 promptx- 前缀，只用 dsh 的主题变量上色', () => {
    const { container } = renderPage(makeStatus())
    const css = container.querySelector('style')?.textContent ?? ''
    expect(css).toContain('.promptx-config')
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/)
    const classes = [...container.querySelectorAll('[class]')].flatMap(element => [...element.classList])
    expect(classes.length).toBeGreaterThan(0)
    expect(classes.every(name => name.startsWith('promptx-'))).toBe(true)
  })

  it('英文界面（需求 S-03）', () => {
    const { container } = renderPage(makeStatus(), { t: tEn, language: 'en' })
    expect(statusLine(container)).toBe('Running · Global shortcut ⌃P is active · Runtime 44.10.2')
    expect(screen.getByRole('button', { name: 'Save' })).toBeTruthy()
    expect(switchOf('Hide when inactive').getAttribute('aria-checked')).toBe('false')
    expect(screen.getByRole('heading', { name: 'Prompt library' })).toBeTruthy()
  })
})
