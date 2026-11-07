// 主进程自己显示的文案：菜单栏菜单和系统快捷键的名称。小窗界面的文案在 shared/i18n，这里只放主进程用到的几条。
// 中英文两份，键名一致（测试检查）。

import type { Locale } from './appearance.ts'

export interface MainStrings {
  /** 菜单第一行：运行状态。 */
  running: string
  shortcutActive: string
  shortcutNone: string
  /** {reason} */
  shortcutFailed: string
  /** {name} */
  shortcutConflict: string
  /** {requested} {active} */
  shortcutFallback: string
  reasonInvalid: string
  reasonTaken: string
  /** {profile} */
  reasonHeld: string
  reasonUnknown: string
  rendererProblem: string
  /** {version} */
  runtime: string
  show: string
  hide: string
  resetPosition: string
  settings: string
  restart: string
  tooltip: string
  /** 认不出名字的系统快捷键。 */
  systemShortcut: string
  /** {n} */
  switchToDesktop: string
}

export const MAIN_STRINGS: Readonly<Record<Locale, MainStrings>> = {
  zh: {
    running: '运行中',
    shortcutActive: '全局快捷键已生效',
    shortcutNone: '未设置全局快捷键',
    shortcutFailed: '全局快捷键未生效：{reason}',
    shortcutConflict: '可能与系统快捷键冲突：{name}',
    shortcutFallback: '新组合 {requested} 登记失败，仍使用 {active}',
    reasonInvalid: '组合不合法',
    reasonTaken: '已被其他应用占用',
    reasonHeld: '已被 profile {profile} 的 PromptX 使用',
    reasonUnknown: '登记失败',
    rendererProblem: '小窗界面出错，正在重新载入',
    runtime: '运行时 {version}',
    show: '显示 PromptX',
    hide: '隐藏 PromptX',
    resetPosition: '重置窗口位置',
    settings: '设置…',
    restart: '重启小窗',
    tooltip: 'PromptX',
    systemShortcut: '系统快捷键',
    switchToDesktop: '切换到桌面 {n}',
  },
  en: {
    running: 'Running',
    shortcutActive: 'Global shortcut active',
    shortcutNone: 'No global shortcut',
    shortcutFailed: 'Global shortcut not active: {reason}',
    shortcutConflict: 'May conflict with a system shortcut: {name}',
    shortcutFallback: 'Could not register {requested}; still using {active}',
    reasonInvalid: 'invalid combination',
    reasonTaken: 'already used by another app',
    reasonHeld: 'used by PromptX in profile {profile}',
    reasonUnknown: 'registration failed',
    rendererProblem: 'The window crashed and is reloading',
    runtime: 'Runtime {version}',
    show: 'Show PromptX',
    hide: 'Hide PromptX',
    resetPosition: 'Reset Window Position',
    settings: 'Settings…',
    restart: 'Restart Window',
    tooltip: 'PromptX',
    systemShortcut: 'system shortcut',
    switchToDesktop: 'Switch to Desktop {n}',
  },
}

/**
 * macOS 系统快捷键（com.apple.symbolichotkeys 的编号）的显示名，取「系统设置 › 键盘快捷键」里的叫法。
 * 只收常用的几项；不认识的编号显示为「系统快捷键」。
 */
const SYSTEM_HOTKEY_NAMES: ReadonlyMap<number, Readonly<Record<Locale, string>>> = new Map([
  [7, { zh: '将焦点移到菜单栏', en: 'Move focus to the menu bar' }],
  [8, { zh: '将焦点移到程序坞', en: 'Move focus to the Dock' }],
  [9, { zh: '将焦点移到活跃窗口或下一个窗口', en: 'Move focus to active or next window' }],
  [10, { zh: '将焦点移到窗口工具栏', en: 'Move focus to window toolbar' }],
  [11, { zh: '将焦点移到浮动窗口', en: 'Move focus to floating window' }],
  [12, { zh: '打开或关闭键盘访问', en: 'Turn keyboard access on or off' }],
  [13, { zh: '更改 Tab 键移动焦点的方式', en: 'Change the way Tab moves focus' }],
  [27, { zh: '将焦点移到下一个窗口', en: 'Move focus to next window' }],
  [28, { zh: '将屏幕快照存储为文件', en: 'Save picture of screen as a file' }],
  [29, { zh: '将屏幕快照拷贝到剪贴板', en: 'Copy picture of screen to the clipboard' }],
  [30, { zh: '将所选区域的快照存储为文件', en: 'Save picture of selected area as a file' }],
  [31, { zh: '将所选区域的快照拷贝到剪贴板', en: 'Copy picture of selected area to the clipboard' }],
  [32, { zh: '调度中心', en: 'Mission Control' }],
  [33, { zh: '应用程序窗口', en: 'Application windows' }],
  [36, { zh: '显示桌面', en: 'Show Desktop' }],
  [52, { zh: '打开或关闭程序坞隐藏', en: 'Turn Dock hiding on/off' }],
  [57, { zh: '将焦点移到状态菜单', en: 'Move focus to status menus' }],
  [59, { zh: '打开或关闭旁白', en: 'Turn VoiceOver on or off' }],
  [60, { zh: '选择上一个输入法', en: 'Select the previous input source' }],
  [61, { zh: '选择“输入法”菜单中的下一个输入法', en: 'Select next source in Input menu' }],
  [64, { zh: '显示“聚焦”搜索', en: 'Show Spotlight search' }],
  [65, { zh: '显示“访达”搜索窗口', en: 'Show Finder search window' }],
  [79, { zh: '向左移动一个空间', en: 'Move left a space' }],
  [81, { zh: '向右移动一个空间', en: 'Move right a space' }],
  [98, { zh: '显示帮助菜单', en: 'Show Help menu' }],
  [160, { zh: '显示启动台', en: 'Show Launchpad' }],
  [162, { zh: '显示辅助功能控制', en: 'Show Accessibility controls' }],
  [175, { zh: '打开或关闭勿扰模式', en: 'Turn Do Not Disturb on/off' }],
  [184, { zh: '截屏和录制选项', en: 'Screenshot and recording options' }],
])

/** 118–133 是「切换到桌面 1」到「切换到桌面 16」。 */
const DESKTOP_FIRST_ID = 118
const DESKTOP_LAST_ID = 133

export function systemHotkeyName(id: number, locale: Locale): string {
  const strings = MAIN_STRINGS[locale]
  const known = SYSTEM_HOTKEY_NAMES.get(id)
  if (known !== undefined) return known[locale]
  if (id >= DESKTOP_FIRST_ID && id <= DESKTOP_LAST_ID) return fill(strings.switchToDesktop, { n: String(id - DESKTOP_FIRST_ID + 1) })
  return strings.systemShortcut
}

/** 把 `{name}` 换成对应的值；没给值的占位符原样保留，界面上能看出漏了什么。 */
export function fill(template: string, values: Readonly<Record<string, string>>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => values[key] ?? match)
}
