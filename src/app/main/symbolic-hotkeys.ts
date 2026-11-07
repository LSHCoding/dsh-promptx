// macOS 系统快捷键的冲突提示（design-spec 5.4、D22）。Carbon 的热键登记不检查 Spotlight 的 ⌘Space、
// 输入法切换的 ⌃Space 这类系统快捷键，登记成功也可能按不出来。这里读
// `defaults export com.apple.symbolichotkeys -` 的输出（plist XML），找出已启用的系统快捷键，
// 和要登记的组合相同时，状态里带上「可能与系统快捷键冲突：{名称}」。尽力而为：读不到或解析失败就不提示。
//
// plist 里只有用户改过的条目：从没改过的系统快捷键不出现，按 macOS 的默认值生效。
// 所以常见的几项另外写了默认组合（DEFAULT_SYMBOLIC_HOTKEYS），文件里没有它们时按默认值算。

import { physicalShortcutKey } from './shortcut-lock.ts'

// ───────────────────────────── plist XML ─────────────────────────────

export type PlistValue = string | number | boolean | PlistValue[] | { [key: string]: PlistValue }

type Token =
  | { type: 'open'; name: string }
  | { type: 'close'; name: string }
  | { type: 'empty'; name: string }
  | { type: 'text'; value: string }

// 声明、DOCTYPE、注释匹配后不产生记号；标签可以带属性（<plist version="1.0">）。
// 不认识的 `<` 会被跳过，结构因此对不上时由 PlistReader 报错，整份按读不出来处理。
const TOKEN = /<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<!--[\s\S]*?-->|<(\/?)([A-Za-z]+)(?:\s[^>]*?)?\s*(\/?)>|([^<]+)/g

function tokenize(xml: string): Token[] {
  const tokens: Token[] = []
  for (const match of xml.matchAll(TOKEN)) {
    const [, slash, name, selfClosing, text] = match
    if (name !== undefined) {
      if (slash === '/') tokens.push({ type: 'close', name })
      else if (selfClosing === '/') tokens.push({ type: 'empty', name })
      else tokens.push({ type: 'open', name })
    } else if (text !== undefined) {
      tokens.push({ type: 'text', value: text })
    }
  }
  return tokens
}

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|lt|gt|amp|quot|apos);/g, (_match, entity: string) => {
    switch (entity) {
      case 'lt': return '<'
      case 'gt': return '>'
      case 'amp': return '&'
      case 'quot': return '"'
      case 'apos': return '\''
      default: {
        const code = entity.startsWith('#x') ? Number.parseInt(entity.slice(2), 16) : Number.parseInt(entity.slice(1), 10)
        return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : ''
      }
    }
  })
}

class PlistReader {
  readonly #tokens: Token[]
  #index = 0

  constructor(tokens: Token[]) {
    this.#tokens = tokens
  }

  /** 跳过标签之间的空白文本。 */
  #next(): Token | undefined {
    while (this.#index < this.#tokens.length) {
      const token = this.#tokens[this.#index++]
      if (token?.type === 'text' && token.value.trim() === '') continue
      return token
    }
    return undefined
  }

  #peek(): Token | undefined {
    const saved = this.#index
    const token = this.#next()
    this.#index = saved
    return token
  }

  /** 读 <name>文本</name> 里的文本（标签之间没有文本时是空串）。 */
  #text(name: string): string {
    let value = ''
    for (;;) {
      const token = this.#tokens[this.#index++]
      if (token === undefined) throw new Error(`unterminated <${name}>`)
      if (token.type === 'text') value += token.value
      else if (token.type === 'close' && token.name === name) return decodeEntities(value)
      else throw new Error(`unexpected tag in <${name}>`)
    }
  }

  value(): PlistValue {
    const token = this.#next()
    if (token === undefined) throw new Error('unexpected end')
    if (token.type === 'empty') {
      switch (token.name) {
        case 'true': return true
        case 'false': return false
        case 'dict': return {}
        case 'array': return []
        default: return ''
      }
    }
    if (token.type !== 'open') throw new Error('expected a value')
    switch (token.name) {
      case 'dict': return this.#dict()
      case 'array': return this.#array()
      case 'integer':
      case 'real': {
        const text = this.#text(token.name).trim()
        const number = Number(text)
        if (text === '' || !Number.isFinite(number)) throw new Error('bad number')
        return number
      }
      case 'true':
      case 'false': {
        this.#text(token.name)
        return token.name === 'true'
      }
      // string、date、data 都按字符串保留，用不到它们的值。
      default: return this.#text(token.name)
    }
  }

  #dict(): { [key: string]: PlistValue } {
    const result: { [key: string]: PlistValue } = {}
    for (;;) {
      const token = this.#next()
      if (token === undefined) throw new Error('unterminated <dict>')
      if (token.type === 'close' && token.name === 'dict') return result
      if (token.type !== 'open' || token.name !== 'key') throw new Error('expected <key>')
      const key = this.#text('key')
      const value = this.value()
      // 往普通对象上赋 __proto__ 会改掉它的原型；这个键在 symbolichotkeys 里不会出现，直接跳过。
      if (key !== '__proto__') result[key] = value
    }
  }

  #array(): PlistValue[] {
    const result: PlistValue[] = []
    for (;;) {
      const token = this.#peek()
      if (token === undefined) throw new Error('unterminated <array>')
      if (token.type === 'close' && token.name === 'array') {
        this.#next()
        return result
      }
      result.push(this.value())
    }
  }

  /** 根元素 <plist> 里的那一个值。 */
  document(): PlistValue {
    const first = this.#next()
    if (first?.type !== 'open' || first.name !== 'plist') throw new Error('expected <plist>')
    const value = this.value()
    const last = this.#next()
    if (last?.type !== 'close' || last.name !== 'plist') throw new Error('expected </plist>')
    return value
  }
}

/** 解析 plist XML。写法不认识时返回 null。 */
export function parsePlistXml(xml: string): PlistValue | null {
  try {
    return new PlistReader(tokenize(xml)).document()
  } catch {
    return null
  }
}

// ───────────────────────────── 系统快捷键 ─────────────────────────────

export interface SymbolicHotkeyEntry {
  id: number
  enabled: boolean
  /** [字符码, 虚拟键码, 修饰键掩码]；条目里没有 value 时为 null（按默认值）。 */
  parameters: number[] | null
  /** standard 是普通组合；modifier 是只按修饰键的那类（例如连按两次），不会和加速键冲突。 */
  type: string | null
}

function isDict(value: PlistValue | undefined): value is { [key: string]: PlistValue } {
  return typeof value === 'object' && !Array.isArray(value)
}

/**
 * 从 plist 里取出 AppleSymbolicHotKeys 的所有条目。读不懂（不是 plist、根不是字典、这一项不是字典）时返回 null。
 * 用户从没改过系统快捷键时，`defaults export` 输出的是空字典 `<dict/>`（域不存在也一样，退出码仍是 0）：
 * 这时所有系统快捷键都按默认值生效，返回空表，由 DEFAULT_SYMBOLIC_HOTKEYS 补上，不能当成「什么都没有」。
 */
export function readSymbolicEntries(xml: string): Map<number, SymbolicHotkeyEntry> | null {
  const root = parsePlistXml(xml)
  if (root === null || !isDict(root)) return null
  const entries = new Map<number, SymbolicHotkeyEntry>()
  if (!('AppleSymbolicHotKeys' in root)) return entries
  const hotkeys = root.AppleSymbolicHotKeys
  if (!isDict(hotkeys)) return null
  for (const [key, raw] of Object.entries(hotkeys)) {
    const id = Number(key)
    if (!Number.isSafeInteger(id) || !isDict(raw)) continue
    const value = raw.value
    let parameters: number[] | null = null
    let type: string | null = null
    if (isDict(value)) {
      const list = value.parameters
      if (Array.isArray(list) && list.every(item => typeof item === 'number')) parameters = list
      if (typeof value.type === 'string') type = value.type
    }
    entries.set(id, { id, enabled: raw.enabled === true, parameters, type })
  }
  return entries
}

/**
 * macOS 默认启用的常见系统快捷键（编号 → [字符码, 虚拟键码, 修饰键掩码]），按美式键盘布局。
 * plist 里没有这一项、或者这一项只有 enabled 没有 value 时用这里的组合。
 */
export const DEFAULT_SYMBOLIC_HOTKEYS: ReadonlyMap<number, readonly [number, number, number]> = new Map([
  [7, [65535, 120, 8650752]], // ⌃F2 将焦点移到菜单栏
  [8, [65535, 99, 8650752]], // ⌃F3 将焦点移到程序坞
  [9, [65535, 118, 8650752]], // ⌃F4 将焦点移到活跃窗口或下一个窗口
  [10, [65535, 96, 8650752]], // ⌃F5 将焦点移到窗口工具栏
  [11, [65535, 97, 8650752]], // ⌃F6 将焦点移到浮动窗口
  [12, [65535, 122, 8650752]], // ⌃F1 打开或关闭键盘访问
  [13, [65535, 98, 8650752]], // ⌃F7 更改 Tab 键移动焦点的方式
  [27, [96, 50, 1048576]], // ⌘` 将焦点移到下一个窗口
  [28, [51, 20, 1179648]], // ⇧⌘3
  [29, [51, 20, 1441792]], // ⌃⇧⌘3
  [30, [52, 21, 1179648]], // ⇧⌘4
  [31, [52, 21, 1441792]], // ⌃⇧⌘4
  [32, [65535, 126, 8650752]], // ⌃↑ 调度中心
  [33, [65535, 125, 8650752]], // ⌃↓ 应用程序窗口
  [52, [100, 2, 1572864]], // ⌥⌘D 程序坞隐藏
  [57, [65535, 100, 8650752]], // ⌃F8 将焦点移到状态菜单
  [59, [65535, 96, 9437184]], // ⌘F5 旁白
  [60, [32, 49, 262144]], // ⌃Space 上一个输入法
  [61, [32, 49, 786432]], // ⌃⌥Space 下一个输入法
  [64, [32, 49, 1048576]], // ⌘Space 聚焦搜索
  [65, [32, 49, 1572864]], // ⌥⌘Space 访达搜索
  [79, [65535, 123, 8650752]], // ⌃← 向左移动一个空间
  [81, [65535, 124, 8650752]], // ⌃→ 向右移动一个空间
  [98, [47, 44, 1179648]], // ⇧⌘/ 帮助菜单
  [162, [65535, 96, 9961472]], // ⌥⌘F5 辅助功能控制
  [184, [53, 23, 1179648]], // ⇧⌘5 截屏和录制选项
])

/** macOS 虚拟键码（kVK_*，美式布局）→ 加速键的键名。 */
const KEY_CODES: ReadonlyMap<number, string> = new Map([
  [0, 'A'], [1, 'S'], [2, 'D'], [3, 'F'], [4, 'H'], [5, 'G'], [6, 'Z'], [7, 'X'], [8, 'C'], [9, 'V'],
  [11, 'B'], [12, 'Q'], [13, 'W'], [14, 'E'], [15, 'R'], [16, 'Y'], [17, 'T'],
  [18, '1'], [19, '2'], [20, '3'], [21, '4'], [22, '6'], [23, '5'], [24, '='], [25, '9'], [26, '7'], [27, '-'],
  [28, '8'], [29, '0'], [30, ']'], [31, 'O'], [32, 'U'], [33, '['], [34, 'I'], [35, 'P'], [37, 'L'], [38, 'J'],
  [39, '\''], [40, 'K'], [41, ';'], [42, '\\'], [43, ','], [44, '/'], [45, 'N'], [46, 'M'], [47, '.'],
  [49, 'Space'], [50, '`'],
  [122, 'F1'], [120, 'F2'], [99, 'F3'], [118, 'F4'], [96, 'F5'], [97, 'F6'], [98, 'F7'], [100, 'F8'],
  [101, 'F9'], [109, 'F10'], [103, 'F11'], [111, 'F12'], [105, 'F13'], [107, 'F14'], [113, 'F15'],
  [106, 'F16'], [64, 'F17'], [79, 'F18'], [80, 'F19'], [90, 'F20'],
  [123, 'Left'], [124, 'Right'], [125, 'Down'], [126, 'Up'],
])

// NSEvent 的修饰键位。
const SHIFT = 0x20000
const CONTROL = 0x40000
const OPTION = 0x80000
const COMMAND = 0x100000
const NUMERIC_PAD = 0x200000
const FUNCTION = 0x800000
const KNOWN_BITS = SHIFT | CONTROL | OPTION | COMMAND | NUMERIC_PAD | FUNCTION

/**
 * 把一组参数换成按物理按键规范化的组合（同 physicalShortcutKey 的 macOS 写法）。换不了时返回 null：
 * 键码不认识、带了 Caps Lock 之类的位、没有修饰键，或者要按住 fn 才能触发的普通键（加速键表达不了 fn，不会冲突）。
 * 方向键和 F 键在系统里总是带着 function 位（以及可能的 numeric pad 位），这两个位对它们不算修饰键。
 */
export function symbolicHotkeyKey(parameters: readonly number[]): string | null {
  const keyCode = parameters[1]
  const mask = parameters[2]
  if (keyCode === undefined || mask === undefined || !Number.isInteger(mask) || mask < 0 || mask > 0xffffff) return null
  if ((mask & ~KNOWN_BITS) !== 0) return null
  const key = KEY_CODES.get(keyCode)
  if (key === undefined) return null
  const functionKey = /^F\d+$/.test(key) || key === 'Left' || key === 'Right' || key === 'Up' || key === 'Down'
  if ((mask & FUNCTION) !== 0 && !functionKey) return null
  const parts: string[] = []
  if ((mask & CONTROL) !== 0) parts.push('Control')
  if ((mask & OPTION) !== 0) parts.push('Alt')
  if ((mask & SHIFT) !== 0) parts.push('Shift')
  if ((mask & COMMAND) !== 0) parts.push('Command')
  parts.push(key)
  return physicalShortcutKey(parts.join('+'), 'darwin')
}

export interface SystemHotkey {
  id: number
  /** physicalShortcutKey 的 macOS 写法，例如 `Command+Space`。 */
  key: string
}

/**
 * 已启用的系统快捷键。entries 为 null（读不到 plist）时返回空：不知道用户关掉了哪些，宁可不提示也不乱提示。
 */
export function enabledSystemHotkeys(entries: ReadonlyMap<number, SymbolicHotkeyEntry> | null): SystemHotkey[] {
  if (entries === null) return []
  const result: SystemHotkey[] = []
  const push = (id: number, parameters: readonly number[] | null): void => {
    if (parameters === null) return
    const key = symbolicHotkeyKey(parameters)
    if (key !== null) result.push({ id, key })
  }
  for (const [id, parameters] of DEFAULT_SYMBOLIC_HOTKEYS) {
    if (!entries.has(id)) push(id, parameters)
  }
  for (const entry of entries.values()) {
    if (!entry.enabled) continue
    if (entry.type !== null && entry.type !== 'standard') continue
    push(entry.id, entry.parameters ?? DEFAULT_SYMBOLIC_HOTKEYS.get(entry.id) ?? null)
  }
  return result.sort((a, b) => a.id - b.id)
}

/** 与 key（physicalShortcutKey 的 macOS 写法）相同的已启用系统快捷键的编号；没有时为 null。 */
export function findSystemConflict(key: string, hotkeys: readonly SystemHotkey[]): number | null {
  return hotkeys.find(hotkey => hotkey.key === key)?.id ?? null
}

/** 一步到位：plist XML → 冲突的系统快捷键编号。xml 为 null（读取失败）时没有冲突。 */
export function systemConflictFromXml(key: string, xml: string | null): number | null {
  if (xml === null) return null
  return findSystemConflict(key, enabledSystemHotkeys(readSymbolicEntries(xml)))
}
