// 小窗和菜单栏的文案：按语言取字典、替换占位符、相对时间、错误码转成给人看的原因（需求 S-03，技术方案 8.1）。
// 这里只用 Intl 和字符串，Host、小程序主进程、渲染进程都能直接引用。

import type { ErrorInfo } from '../types.ts'
import { en } from './en.ts'
import { zh } from './zh.ts'

export type Locale = 'zh' | 'en'

export type MessageKey = keyof typeof zh

export type MessageParams = Readonly<Record<string, string | number>>

const DICTIONARIES: Readonly<Record<Locale, Readonly<Record<MessageKey, string>>>> = { zh, en }

export const MESSAGE_KEYS = Object.keys(zh) as MessageKey[]

/** 语言标签（`zh-CN`、`en-US`、dsh 的 `zh`）→ 小窗用的语言：以 zh 开头的是中文，其余都用英文（技术方案 4.7）。 */
export function resolveLocale(tag: string | null | undefined): Locale {
  return tag?.trim().toLowerCase().startsWith('zh') === true ? 'zh' : 'en'
}

export function isMessageKey(key: string): key is MessageKey {
  return Object.hasOwn(zh, key)
}

/** 替换 `{名字}` 占位符；没给的参数保持原样，界面上能直接看出漏传了什么。 */
export function format(template: string, params?: MessageParams): string {
  if (params === undefined) return template
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => {
    const value = params[name]
    return value === undefined ? whole : String(value)
  })
}

export function translate(locale: Locale, key: MessageKey, params?: MessageParams): string {
  return format(DICTIONARIES[locale][key], params)
}

/** 模板里出现的占位符名字（去重后排序），测试用它核对两份字典。 */
export function placeholdersOf(template: string): string[] {
  const names = new Set<string>()
  for (const match of template.matchAll(/\{(\w+)\}/g)) {
    if (match[1] !== undefined) names.add(match[1])
  }
  return [...names].sort()
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/**
 * 相对时间（需求 L-04「3 小时前」「1 天前」）：不到 1 分钟是「刚刚」，之后依次按分钟、小时、天。
 * 时间在将来（两台机器的时钟不一致、文件时间写错）时也显示「刚刚」，不出现负数。
 */
export function relativeTime(ms: number, now: number, locale: Locale): string {
  const elapsed = Math.max(0, now - ms)
  if (!Number.isFinite(elapsed) || elapsed < MINUTE) return translate(locale, 'time.justNow')
  if (elapsed < HOUR) {
    const n = Math.floor(elapsed / MINUTE)
    return translate(locale, n === 1 ? 'time.minuteAgo' : 'time.minutesAgo', { n })
  }
  if (elapsed < DAY) {
    const n = Math.floor(elapsed / HOUR)
    return translate(locale, n === 1 ? 'time.hourAgo' : 'time.hoursAgo', { n })
  }
  const n = Math.floor(elapsed / DAY)
  return translate(locale, n === 1 ? 'time.dayAgo' : 'time.daysAgo', { n })
}

/** detail 开头的系统错误名，例如 `EACCES: permission denied, open '…'` 里的 EACCES。 */
function errnoOf(detail: string): string | null {
  const match = /^(E[A-Z0-9]+)(?=$|[:\s,])/.exec(detail.trim())
  return match?.[1] ?? null
}

/** 认识的系统错误转成一句原因（「没有权限」「磁盘空间不足」）；不认识时返回 null。 */
export function errnoMessage(locale: Locale, detail: string): string | null {
  const errno = errnoOf(detail)
  if (errno === null) return null
  const key = `errno.${errno}`
  return isMessageKey(key) ? translate(locale, key) : null
}

/** 错误码对应的文案；不认识的错误码按内部错误显示。 */
export function errorMessage(locale: Locale, code: string): string {
  const key = `error.${code}`
  return translate(locale, isMessageKey(key) ? key : 'error.promptx/internal')
}

function withDetail(locale: Locale, message: string, detail: string): string {
  return locale === 'zh' ? `${message}（${detail}）` : `${message} (${detail})`
}

/**
 * 完整的错误说明：错误码的文案，后面附上系统错误信息。detail 是认识的系统错误时换成对应的说法，
 * 否则原样附上（例如模型服务返回的英文错误）。
 */
export function describeError(locale: Locale, info: ErrorInfo): string {
  const message = errorMessage(locale, info.code)
  const detail = info.detail?.trim() ?? ''
  if (detail === '') return message
  return withDetail(locale, message, errnoMessage(locale, detail) ?? detail)
}

/**
 * 放进「保存失败：{原因}」这类提示里的原因。认识的系统错误直接说原因本身（「保存失败：没有权限」），
 * 不再重复「写入文件失败」这种和外层提示意思相同的话；其余情况同 describeError。
 */
export function errorReason(locale: Locale, info: ErrorInfo): string {
  const detail = info.detail?.trim() ?? ''
  if (detail !== '') {
    const errno = errnoMessage(locale, detail)
    if (errno !== null) return errno
  }
  return describeError(locale, info)
}
