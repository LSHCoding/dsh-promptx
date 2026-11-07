// 菜单栏图标和菜单的内容（需求 F-05、5.11，design-spec 5.4）。这里只算「显示什么」，
// 由主进程的适配层转成 Electron 的 Menu；状态、语言、可见性变化时重新计算并整份替换菜单。
//
// 菜单（需求 5.11 的线框图）：状态说明（不可点）、分隔线、显示 / 隐藏 PromptX（带快捷键）、重置窗口位置、
// 分隔线、设置…、重启小窗。不放「退出」（Q21）：不想用时在 dsh 里停用插件。

import { formatAccelerator, parseAccelerator } from '../../shared/accelerator.ts'
import type { ShortcutStatus } from '../../shared/types.ts'
import type { Locale } from './appearance.ts'
import { fill, MAIN_STRINGS, type MainStrings } from './strings.ts'

/** 三种图标：正常、提醒（快捷键没登记或可能冲突）、出错（小窗界面崩溃后正在重载）。 */
export type TrayIconState = 'normal' | 'warn' | 'error'

export type TrayAction = 'toggle' | 'reset-position' | 'settings' | 'restart'

export type TrayItem =
  | { kind: 'status'; label: string }
  | { kind: 'separator' }
  | {
    kind: 'action'
    action: TrayAction
    label: string
    /** 菜单项右侧显示的快捷键（Electron 加速键写法，只显示不登记）；没有时为 null。 */
    accelerator: string | null
  }

export interface TrayModel {
  icon: TrayIconState
  tooltip: string
  items: TrayItem[]
}

export interface TrayModelInput {
  locale: Locale
  platform: string
  visible: boolean
  /** null：没有配置全局快捷键。 */
  shortcut: ShortcutStatus | null
  /** Electron 运行时版本（process.versions.electron）。 */
  runtimeVersion: string
  /** 渲染进程崩溃后正在重载时为 false。 */
  rendererHealthy: boolean
}

export interface ShortcutSummary {
  text: string
  /** 需要提醒：没登记上、可能和系统快捷键冲突，或新组合失败后退回了旧组合。 */
  problem: boolean
}

/** 快捷键状态的一句话说明，菜单第一行用。 */
export function describeShortcut(shortcut: ShortcutStatus | null, locale: Locale, platform: string): ShortcutSummary {
  const strings = MAIN_STRINGS[locale]
  if (shortcut === null) return { text: strings.shortcutNone, problem: false }
  if (!shortcut.registered) {
    const reason = failureReason(shortcut.error?.code, shortcut.error?.detail, strings)
    return { text: fill(strings.shortcutFailed, { reason }), problem: true }
  }
  // 登记着、却带 error：配置的新组合没登记上，退回了旧组合（shortcut-manager.ts 的约定），detail 是新组合。
  if (shortcut.error !== undefined) {
    return {
      text: fill(strings.shortcutFallback, {
        requested: formatAccelerator(shortcut.error.detail ?? '', platform),
        active: formatAccelerator(shortcut.accelerator, platform),
      }),
      problem: true,
    }
  }
  const warning = shortcut.warning
  if (warning === undefined) return { text: strings.shortcutActive, problem: false }
  // 目前唯一的警告是可能与 macOS 系统快捷键冲突；detail 是系统快捷键的名称。
  return { text: fill(strings.shortcutConflict, { name: warning.detail ?? strings.systemShortcut }), problem: true }
}

function failureReason(code: string | undefined, detail: string | undefined, strings: MainStrings): string {
  switch (code) {
    case 'promptx/shortcut/invalid':
      return strings.reasonInvalid
    case 'promptx/shortcut/taken':
      return strings.reasonTaken
    case 'promptx/shortcut/held-by-profile':
      return fill(strings.reasonHeld, { profile: detail ?? '' })
    default:
      return strings.reasonUnknown
  }
}

export function buildTrayModel(input: TrayModelInput): TrayModel {
  const strings = MAIN_STRINGS[input.locale]
  const shortcut = describeShortcut(input.shortcut, input.locale, input.platform)
  const runtime = fill(strings.runtime, { version: input.runtimeVersion })

  let icon: TrayIconState = 'normal'
  let detail: string
  if (!input.rendererHealthy) {
    icon = 'error'
    detail = `${strings.rendererProblem} · ${runtime}`
  } else if (shortcut.problem) {
    icon = 'warn'
    detail = `${shortcut.text} · ${runtime}`
  } else {
    detail = `${strings.running} · ${shortcut.text} · ${runtime}`
  }
  const status = `${icon === 'normal' ? '●' : '⚠'} ${detail}`

  // 只有真正登记上的组合才显示在「显示 / 隐藏」旁边；退回旧组合时显示的是仍在生效的旧组合。
  let accelerator: string | null = null
  if (input.shortcut?.registered === true) {
    const parsed = parseAccelerator(input.shortcut.accelerator)
    if (parsed.ok) accelerator = parsed.canonical
  }

  return {
    icon,
    tooltip: icon === 'normal' ? strings.tooltip : `${strings.tooltip} · ${detail}`,
    items: [
      { kind: 'status', label: status },
      { kind: 'separator' },
      { kind: 'action', action: 'toggle', label: input.visible ? strings.hide : strings.show, accelerator },
      { kind: 'action', action: 'reset-position', label: strings.resetPosition, accelerator: null },
      { kind: 'separator' },
      { kind: 'action', action: 'settings', label: strings.settings, accelerator: null },
      { kind: 'action', action: 'restart', label: strings.restart, accelerator: null },
    ],
  }
}
