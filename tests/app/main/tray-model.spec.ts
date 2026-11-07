import { describe, expect, it } from 'vitest'
import { buildTrayModel, describeShortcut, type TrayItem, type TrayModelInput } from '../../../src/app/main/tray-model.ts'
import { trapProcessErrors } from './helpers.ts'

trapProcessErrors()

const base: TrayModelInput = {
  locale: 'zh',
  platform: 'darwin',
  visible: false,
  shortcut: { accelerator: 'Control+P', registered: true },
  runtimeVersion: '44.10.2',
  rendererHealthy: true,
}

function actions(items: TrayItem[]): { action: string; label: string; accelerator: string | null }[] {
  return items.flatMap(item => (item.kind === 'action' ? [{ action: item.action, label: item.label, accelerator: item.accelerator }] : []))
}

function statusLine(items: TrayItem[]): string {
  const first = items[0]
  if (first?.kind !== 'status') throw new Error('first item is not the status line')
  return first.label
}

describe('buildTrayModel: menu structure', () => {
  it('lists status, show/hide, reset, separator, settings and restart, and never a quit item (F-05, Q21)', () => {
    const model = buildTrayModel(base)
    expect(model.items.map(item => item.kind)).toEqual(['status', 'separator', 'action', 'action', 'separator', 'action', 'action'])
    expect(actions(model.items).map(item => item.action)).toEqual(['toggle', 'reset-position', 'settings', 'restart'])
    expect(JSON.stringify(model).toLowerCase()).not.toContain('quit')
    expect(JSON.stringify(model)).not.toContain('退出')
  })

  it('shows the running state, the shortcut state and the runtime version', () => {
    const model = buildTrayModel(base)
    expect(model.icon).toBe('normal')
    expect(statusLine(model.items)).toBe('● 运行中 · 全局快捷键已生效 · 运行时 44.10.2')
    expect(model.tooltip).toBe('PromptX')
  })

  it('names the toggle by visibility and shows the registered accelerator next to it', () => {
    expect(actions(buildTrayModel(base).items)[0]).toEqual({ action: 'toggle', label: '显示 PromptX', accelerator: 'Control+P' })
    expect(actions(buildTrayModel({ ...base, visible: true }).items)[0]).toEqual({ action: 'toggle', label: '隐藏 PromptX', accelerator: 'Control+P' })
  })

  it('normalizes the accelerator for the menu (display only)', () => {
    const model = buildTrayModel({ ...base, shortcut: { accelerator: 'ctrl+alt+p', registered: true } })
    expect(actions(model.items)[0]?.accelerator).toBe('Control+Alt+P')
  })

  it('uses English labels for the English locale', () => {
    const model = buildTrayModel({ ...base, locale: 'en', visible: true })
    expect(statusLine(model.items)).toBe('● Running · Global shortcut active · Runtime 44.10.2')
    expect(actions(model.items).map(item => item.label)).toEqual(['Hide PromptX', 'Reset Window Position', 'Settings…', 'Restart Window'])
  })
})

describe('buildTrayModel: shortcut problems', () => {
  it('is normal without a configured shortcut and shows no accelerator', () => {
    const model = buildTrayModel({ ...base, shortcut: null })
    expect(model.icon).toBe('normal')
    expect(statusLine(model.items)).toBe('● 运行中 · 未设置全局快捷键 · 运行时 44.10.2')
    expect(actions(model.items)[0]?.accelerator).toBeNull()
  })

  it('warns and names the holder when another profile uses the combination', () => {
    const model = buildTrayModel({
      ...base,
      shortcut: { accelerator: 'Control+P', registered: false, error: { code: 'promptx/shortcut/held-by-profile', detail: 'work' } },
    })
    expect(model.icon).toBe('warn')
    expect(statusLine(model.items)).toBe('⚠ 全局快捷键未生效：已被 profile work 的 PromptX 使用 · 运行时 44.10.2')
    expect(actions(model.items)[0]?.accelerator).toBeNull()
    expect(model.tooltip).toContain('已被 profile work 的 PromptX 使用')
  })

  it('explains taken, invalid and unknown failures', () => {
    const failed = (code: string): string => statusLine(buildTrayModel({
      ...base,
      shortcut: { accelerator: 'Control+P', registered: false, error: { code } },
    }).items)
    expect(failed('promptx/shortcut/taken')).toContain('已被其他应用占用')
    expect(failed('promptx/shortcut/invalid')).toContain('组合不合法')
    expect(failed('promptx/internal')).toContain('登记失败')
  })

  it('warns about a possible system shortcut conflict but still shows the accelerator', () => {
    const model = buildTrayModel({
      ...base,
      shortcut: {
        accelerator: 'Command+Space',
        registered: true,
        warning: { code: 'promptx/shortcut/system-conflict', detail: '显示“聚焦”搜索' },
      },
    })
    expect(model.icon).toBe('warn')
    expect(statusLine(model.items)).toBe('⚠ 可能与系统快捷键冲突：显示“聚焦”搜索 · 运行时 44.10.2')
    expect(actions(model.items)[0]?.accelerator).toBe('Command+Space')
  })

  it('says the new combination failed and the old one is still in use', () => {
    const shortcut = {
      accelerator: 'Control+P',
      registered: true,
      error: { code: 'promptx/shortcut/held-by-profile', detail: 'Control+Alt+P' },
    }
    expect(statusLine(buildTrayModel({ ...base, shortcut }).items)).toBe('⚠ 新组合 ⌃⌥P 登记失败，仍使用 ⌃P · 运行时 44.10.2')
    const windows = buildTrayModel({ ...base, platform: 'win32', locale: 'en', shortcut })
    expect(statusLine(windows.items)).toBe('⚠ Could not register Ctrl+Alt+P; still using Ctrl+P · Runtime 44.10.2')
    expect(actions(windows.items)[0]?.accelerator).toBe('Control+P')
  })
})

describe('buildTrayModel: renderer problems', () => {
  it('shows the error icon while the window reloads after a crash', () => {
    const model = buildTrayModel({ ...base, rendererHealthy: false })
    expect(model.icon).toBe('error')
    expect(statusLine(model.items)).toBe('⚠ 小窗界面出错，正在重新载入 · 运行时 44.10.2')
  })
})

describe('describeShortcut', () => {
  it('falls back to a generic name when a conflict has no name', () => {
    const summary = describeShortcut({ accelerator: 'Control+Space', registered: true, warning: { code: 'promptx/shortcut/system-conflict' } }, 'en', 'darwin')
    expect(summary).toEqual({ text: 'May conflict with a system shortcut: system shortcut', problem: true })
  })
})
