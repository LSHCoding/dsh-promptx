// 全局快捷键（Electron 加速键写法）的校验、规范化和显示（需求 S-02、F-01，技术方案 5.4）。
// 配置页校验、Host 写配置、小程序注册快捷键、界面显示都用这里的同一套规则，避免某一处放过了另一处不认的写法。

export type AcceleratorModifier = 'CommandOrControl' | 'Command' | 'Control' | 'Alt' | 'Shift' | 'Super'

export type AcceleratorError =
  /** 空串或只有空白。 */
  | 'empty'
  /** 写法不对：多余的 `+`、修饰键重复或互相重叠、没有主键或主键不止一个。 */
  | 'syntax'
  /** 没有修饰键。全局快捷键没有修饰键会吞掉所有应用里的这个键。 */
  | 'no-modifier'
  /** 修饰键只有 Shift：Shift+字母就是打大写字母，同样会吞掉正常输入。 */
  | 'shift-only'
  /** 有不认识或不支持的键名。 */
  | 'bad-key'

export type ParsedAccelerator =
  | { ok: true; modifiers: AcceleratorModifier[]; key: string; canonical: string }
  | { ok: false; reason: AcceleratorError }

/** 规范写法里修饰键的顺序。 */
const MODIFIER_ORDER: readonly AcceleratorModifier[] = ['CommandOrControl', 'Command', 'Control', 'Alt', 'Shift', 'Super']

/** 修饰键别名（小写）→ 规范名。Option 在 Electron 里就是 Alt，Meta 就是 Super。 */
const MODIFIER_ALIASES: ReadonlyMap<string, AcceleratorModifier> = new Map([
  ['commandorcontrol', 'CommandOrControl'],
  ['cmdorctrl', 'CommandOrControl'],
  ['command', 'Command'],
  ['cmd', 'Command'],
  ['control', 'Control'],
  ['ctrl', 'Control'],
  ['alt', 'Alt'],
  ['option', 'Alt'],
  ['shift', 'Shift'],
  ['super', 'Super'],
  ['meta', 'Super'],
])

/**
 * 在某个平台上会落到同一个物理键的修饰键组合。Electron 把 Command 和 Super 都映射成同一个键
 * （macOS 的 ⌘、Windows 的 Win 键）；CommandOrControl 在 macOS 上是 ⌘、在其他平台上是 Ctrl。
 * 这些组合在某个平台上等于把同一个修饰键写了两遍，注册结果和用户看到的写法对不上，一律判为写法不对。
 */
const OVERLAPPING: readonly (readonly [AcceleratorModifier, AcceleratorModifier])[] = [
  ['Command', 'Super'],
  ['CommandOrControl', 'Command'],
  ['CommandOrControl', 'Control'],
  ['CommandOrControl', 'Super'],
]

const PUNCTUATION = ['`', '-', '=', '[', ']', '\\', ';', '\'', ',', '.', '/'] as const

/** 支持的主键：小写写法 → 规范名。只收常见、各平台键盘上都有的键（技术方案 5.4）。 */
const KEY_NAMES: ReadonlyMap<string, string> = new Map([
  ...Array.from({ length: 26 }, (_, i): [string, string] => {
    const letter = String.fromCharCode(65 + i)
    return [letter.toLowerCase(), letter]
  }),
  ...Array.from({ length: 10 }, (_, i): [string, string] => [String(i), String(i)]),
  ...Array.from({ length: 24 }, (_, i): [string, string] => [`f${i + 1}`, `F${i + 1}`]),
  ['space', 'Space'],
  ['up', 'Up'],
  ['down', 'Down'],
  ['left', 'Left'],
  ['right', 'Right'],
  ['plus', 'Plus'],
  ...PUNCTUATION.map((mark): [string, string] => [mark, mark]),
])

/**
 * 解析 Electron 加速键写法。键名不区分大小写，`+` 两侧的空白忽略（与 Electron 一致）；
 * 成功时给出规范写法：修饰键按 CommandOrControl、Command、Control、Alt、Shift、Super 排序，字母大写。
 */
export function parseAccelerator(s: string): ParsedAccelerator {
  const trimmed = s.trim()
  if (trimmed === '') return { ok: false, reason: 'empty' }
  const tokens = trimmed.split('+').map(token => token.trim())
  if (tokens.includes('')) return { ok: false, reason: 'syntax' }

  const modifiers = new Set<AcceleratorModifier>()
  const keys: string[] = []
  let duplicate = false
  for (const token of tokens) {
    const lower = token.toLowerCase()
    const modifier = MODIFIER_ALIASES.get(lower)
    if (modifier !== undefined) {
      if (modifiers.has(modifier)) duplicate = true
      modifiers.add(modifier)
      continue
    }
    const key = KEY_NAMES.get(lower)
    if (key === undefined) return { ok: false, reason: 'bad-key' }
    keys.push(key)
  }

  if (duplicate || OVERLAPPING.some(([a, b]) => modifiers.has(a) && modifiers.has(b))) return { ok: false, reason: 'syntax' }
  const [key, ...extraKeys] = keys
  if (key === undefined || extraKeys.length > 0) return { ok: false, reason: 'syntax' }
  if (modifiers.size === 0) return { ok: false, reason: 'no-modifier' }
  if (modifiers.size === 1 && modifiers.has('Shift')) return { ok: false, reason: 'shift-only' }

  const ordered = MODIFIER_ORDER.filter(modifier => modifiers.has(modifier))
  return { ok: true, modifiers: ordered, key, canonical: [...ordered, key].join('+') }
}

const MAC_KEY_SYMBOLS: ReadonlyMap<string, string> = new Map([
  ['Up', '↑'],
  ['Down', '↓'],
  ['Left', '←'],
  ['Right', '→'],
  ['Plus', '+'],
])

/**
 * 按平台显示加速键。macOS 用 ⌃⌥⇧⌘ 符号（系统菜单的顺序），CommandOrControl 显示为 ⌘；
 * 其他平台写成 `Ctrl+Alt+Shift+Win+P`，CommandOrControl 显示为 Ctrl，Command / Super 在 Windows 上是 Win、
 * 在 Linux 上是 Super。写法不合法时原样返回（去掉首尾空白），界面上至少能看到用户写了什么。
 */
export function formatAccelerator(s: string, platform: string): string {
  const parsed = parseAccelerator(s)
  if (!parsed.ok) return s.trim()
  const has = (modifier: AcceleratorModifier): boolean => parsed.modifiers.includes(modifier)

  if (platform === 'darwin') {
    let symbols = ''
    if (has('Control')) symbols += '⌃'
    if (has('Alt')) symbols += '⌥'
    if (has('Shift')) symbols += '⇧'
    if (has('CommandOrControl') || has('Command') || has('Super')) symbols += '⌘'
    return symbols + (MAC_KEY_SYMBOLS.get(parsed.key) ?? parsed.key)
  }

  const parts: string[] = []
  if (has('CommandOrControl') || has('Control')) parts.push('Ctrl')
  if (has('Alt')) parts.push('Alt')
  if (has('Shift')) parts.push('Shift')
  if (has('Command') || has('Super')) parts.push(platform === 'win32' ? 'Win' : 'Super')
  parts.push(parsed.key)
  return parts.join('+')
}

/** 录制快捷键时用到的键盘事件字段（DOM KeyboardEvent 的子集，shared 不依赖 DOM 类型）。 */
export interface AcceleratorKeyEvent {
  key: string
  code: string
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
  metaKey: boolean
}

const MODIFIER_KEY_VALUES: ReadonlySet<string> = new Set(['Control', 'Alt', 'AltGraph', 'Shift', 'Meta', 'OS', 'Super', 'Hyper', 'Fn', 'FnLock'])

const CODE_KEYS: ReadonlyMap<string, string> = new Map([
  ['Space', 'Space'],
  ['ArrowUp', 'Up'],
  ['ArrowDown', 'Down'],
  ['ArrowLeft', 'Left'],
  ['ArrowRight', 'Right'],
  ['Backquote', '`'],
  ['Minus', '-'],
  ['Equal', '='],
  ['BracketLeft', '['],
  ['BracketRight', ']'],
  ['Backslash', '\\'],
  ['Semicolon', ';'],
  ['Quote', '\''],
  ['Comma', ','],
  ['Period', '.'],
  ['Slash', '/'],
])

/** e.code 是物理键位：Option、Shift 会改变 e.key（⌥P 是「π」，⇧1 是「!」），只有 e.code 能稳定对应到加速键的键名。 */
function keyFromCode(code: string): string | null {
  const letter = /^Key([A-Z])$/.exec(code)
  if (letter?.[1] !== undefined) return letter[1]
  const digit = /^Digit([0-9])$/.exec(code)
  if (digit?.[1] !== undefined) return digit[1]
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code
  return CODE_KEYS.get(code) ?? null
}

/**
 * 快捷键录制：把一次 keydown 换算成规范的加速键写法。只按下修饰键时、主键不支持时、
 * 或组合不合法（没有修饰键、只有 Shift）时返回 null，录制框继续等待。
 * metaKey 在 macOS 上是 ⌘（Command），在其他平台上是 Win / Super 键。
 */
export function acceleratorFromKeyEvent(e: AcceleratorKeyEvent, platform: string): string | null {
  if (MODIFIER_KEY_VALUES.has(e.key)) return null
  const key = keyFromCode(e.code)
  if (key === null) return null
  const parts: string[] = []
  if (e.ctrlKey) parts.push('Control')
  if (e.altKey) parts.push('Alt')
  if (e.shiftKey) parts.push('Shift')
  if (e.metaKey) parts.push(platform === 'darwin' ? 'Command' : 'Super')
  parts.push(key)
  const parsed = parseAccelerator(parts.join('+'))
  return parsed.ok ? parsed.canonical : null
}

const OTHER_PLATFORM_SHORTCUT = 'Control+Alt+P'

/** 默认全局快捷键（需求 Q7）：macOS ⌃P，Windows、Linux Ctrl+Alt+P。 */
export const DEFAULT_SHORTCUT_BY_PLATFORM = {
  darwin: 'Control+P',
  win32: OTHER_PLATFORM_SHORTCUT,
  linux: OTHER_PLATFORM_SHORTCUT,
} as const

/** 按 `process.platform` 取默认全局快捷键；不认识的平台按 Windows、Linux 的默认值。 */
export function defaultShortcut(platform: string): string {
  return platform === 'darwin' ? DEFAULT_SHORTCUT_BY_PLATFORM.darwin : OTHER_PLATFORM_SHORTCUT
}
