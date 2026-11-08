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

/**
 * 插件和小程序写在 detail 里的原因代码（不是系统错误名）→ 文案键（审查 CR-04）。这些机器写法原样附在文案后面用户看不懂，
 * 还会出现「库目录不可用：库目录不可用（library-dir-skills）」这样的句子，换成一句说法。键是 detail 的原文：
 * - library-dir-*：库目录的位置限制（src/library/service.ts、src/web/config-update.ts），说法和配置页字段错误一致；
 * - read-back mismatch：剪贴板写完读回不一致（src/app/main/clipboard.ts）；
 * - lock-timeout：回收站记录的跨进程锁等不到（src/library/service.ts）；
 * - trash-record-full：回收站记录再写一项就超过读取上限，这次删除已回滚（src/library/trash.ts）；
 * - unsupported url：插件给的配置页地址不能交给系统打开（src/app/main/settings.ts）；
 * - too-large、not-utf8、read-failed：文件无法打开的三种原因，和列表、预览里的说法相同。
 */
const DETAIL_KEYS: Readonly<Record<string, MessageKey>> = {
  'library-dir-relative': 'detail.library-dir-relative',
  'library-dir-reserved': 'detail.library-dir-reserved',
  'library-dir-skills': 'detail.library-dir-skills',
  'read-back mismatch': 'detail.read-back-mismatch',
  'lock-timeout': 'detail.lock-timeout',
  'trash-record-full': 'detail.trash-record-full',
  'unsupported url': 'detail.unsupported-url',
  'too-large': 'library.unreadable.too-large',
  'not-utf8': 'library.unreadable.not-utf8',
  'read-failed': 'library.unreadable.read-failed',
}

/**
 * 草稿错误（promptx/draft/*）的 detail → 文案键（审查 CR-04）。草稿服务（src/draft/service.ts）把 dsh 存储层的错误代码
 * 原样放进 detail，读取失败、保存失败时出现在编辑区和底栏，例如「草稿读取失败：草稿记录无法读取（malformed-medium）」。
 * 只换用户碰得到的几种：文件坏了、版本不认识、记录格式不对、上一次还没关完、写入结果不明、插件正在停止、还没读回。
 * 存储没装好这类只有 dsh 本身出错才会有的代码（backend-not-found、facet-unsupported 等）照常附上原文，方便报告问题。
 * 只对草稿错误生效：closed、invalid-record 这样的词太普通，别的错误码的 detail 里出现时意思不一定一样。
 */
const DRAFT_DETAIL_KEYS: Readonly<Record<string, MessageKey>> = {
  'malformed-medium': 'detail.draft.malformed-medium',
  'version-mismatch': 'detail.draft.version-mismatch',
  'invalid-record': 'detail.draft.invalid-record',
  'already-open': 'detail.draft.already-open',
  'unknown-state': 'detail.draft.unknown-state',
  'closed': 'detail.draft.closed',
  'not-loaded': 'detail.draft.not-loaded',
  // src/host-handlers.ts：这条连接上还没读回草稿就要保存。
  'draft not loaded on this connection': 'detail.draft.not-loaded',
}

function lookup(table: Readonly<Record<string, MessageKey>>, detail: string): MessageKey | undefined {
  return Object.hasOwn(table, detail) ? table[detail] : undefined
}

/** detail 能说成一句原因时返回那句话（认识的原因代码，或者认识的系统错误）；没有 detail 或都不认识时返回 null。 */
export function detailReason(locale: Locale, info: ErrorInfo): string | null {
  const detail = info.detail?.trim() ?? ''
  if (detail === '') return null
  const key = lookup(DETAIL_KEYS, detail) ?? (info.code.startsWith('promptx/draft/') ? lookup(DRAFT_DETAIL_KEYS, detail) : undefined)
  return key === undefined ? errnoMessage(locale, detail) : translate(locale, key)
}

function withDetail(locale: Locale, message: string, detail: string): string {
  return locale === 'zh' ? `${message}（${detail}）` : `${message} (${detail})`
}

/**
 * 完整的错误说明：错误码的文案，后面附上原因。detail 是认识的原因代码或系统错误时换成对应的说法，
 * 否则原样附上（例如模型服务返回的英文错误）。
 */
export function describeError(locale: Locale, info: ErrorInfo): string {
  const message = errorMessage(locale, info.code)
  const detail = info.detail?.trim() ?? ''
  if (detail === '') return message
  return withDetail(locale, message, detailReason(locale, info) ?? detail)
}

/**
 * 放进「保存失败：{原因}」这类提示里的原因。认得出原因（原因代码、系统错误）时直接说原因本身（「保存失败：没有权限」），
 * 不再重复「写入文件失败」这种和外层提示意思相同的话；其余情况同 describeError。
 */
export function errorReason(locale: Locale, info: ErrorInfo): string {
  return detailReason(locale, info) ?? describeError(locale, info)
}

/**
 * 「{前缀}：{原因}」这类整句（key），而前缀就是错误码 ownCode 自己的文案时（「库目录不可用：{原因}」「无法打开插件配置：{原因}」）：
 * 认得出原因就只填原因；认不出时整句换成错误的完整说明，不把同一句话说两遍（审查 CR-04）。别的错误码照常按 errorReason 填原因。
 */
export function failureMessage(locale: Locale, key: MessageKey, ownCode: string, info: ErrorInfo): string {
  if (info.code !== ownCode) return translate(locale, key, { reason: errorReason(locale, info) })
  const reason = detailReason(locale, info)
  return reason === null ? describeError(locale, info) : translate(locale, key, { reason })
}
