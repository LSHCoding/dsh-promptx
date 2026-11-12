// 配置页的暂存表单（design-spec 4.4、D12，独立审查 COV-02）。纯函数，不碰 React 和 DOM。
//
// 模型照 dsh 设置表单（dsh-client-ui-primitives 的 form-model）：页面上的改动先暂存成 draft，只有「保存」才写；
// 保存时只提交和 Host 当前值不同的字段，Host 一次校验、一次 settings.update()。
// 逐字段即改即存不行：库目录输入到一半时失焦就会切库，小窗按 L-01 解除绑定，切回来也恢复不了绑定。

import { parseAccelerator } from '../shared/accelerator.ts'
import type { ConfigFieldError, PromptxConfig } from '../shared/types.ts'
import { conflictingShortcutFields, TOOLBAR_SHORTCUT_FIELDS } from '../shared/window-shortcuts.ts'
import { CONFIG_FIELDS } from './api.ts'

export type ConfigField = keyof PromptxConfig

/** 暂存的改动：只含用户动过的字段。 */
export type Draft = Partial<PromptxConfig>

export type FieldErrors = Partial<Record<ConfigField, ConfigFieldError>>

/** 返回改了一个字段的新 draft，不修改原对象。 */
export function withField<K extends ConfigField>(draft: Draft, field: K, value: PromptxConfig[K]): Draft {
  const next: Draft = { ...draft }
  next[field] = value
  return next
}

/** 去掉一个字段的错误；没有这个字段时原样返回，React 不会因此重新渲染。 */
export function withoutError(errors: FieldErrors, field: ConfigField): FieldErrors {
  if (errors[field] === undefined) return errors
  const { [field]: _removed, ...rest } = errors
  return rest
}

/** 页面上显示的值：暂存的改动盖在 Host 的当前值上。 */
export function effectiveConfig(config: PromptxConfig, draft: Draft): PromptxConfig {
  return { ...config, ...draft }
}

/** 两份配置的每个字段都相同。 */
export function sameConfig(a: PromptxConfig, b: PromptxConfig): boolean {
  return CONFIG_FIELDS.every(field => a[field] === b[field])
}

/** 全局快捷键的规范写法：合法时用 shared/accelerator 的 canonical（和 Host、小程序同一套规则），不合法时只去掉首尾空白。 */
export function normalizeShortcut(value: string, scope: 'global' | 'window' = 'global'): string {
  const trimmed = value.trim()
  if (trimmed === '') return ''
  const parsed = parseAccelerator(trimmed, scope)
  return parsed.ok ? parsed.canonical : trimmed
}

/**
 * 提交前的规范化，和 Host 写入前的规范化（src/web/config-update.ts）保持一致：库目录去掉首尾空白，快捷键换成规范写法，
 * 只有空白的优化指令算「用默认指令」，存成空串。两边不一致的话，Host 存下的值和页面以为存下的值对不上，
 * 暂存项永远落不了定，「保存」会一直可用。正文有内容的指令原样提交，不去掉首尾空白（那是用户写的内容）。
 */
export function normalizeDraft(draft: Draft): Draft {
  const next: Draft = { ...draft }
  if (next.libraryDir !== undefined) next.libraryDir = next.libraryDir.trim()
  if (next.globalShortcut !== undefined) next.globalShortcut = normalizeShortcut(next.globalShortcut)
  for (const field of TOOLBAR_SHORTCUT_FIELDS) {
    const value = next[field]
    if (value !== undefined) next[field] = normalizeShortcut(value, 'window')
  }
  if (next.optimizeInstruction !== undefined && !/\S/.test(next.optimizeInstruction)) next.optimizeInstruction = ''
  return next
}

/** 要提交的改动：规范化后和基准值不同的字段。为空表示没有改动。 */
export function changedPatch(base: PromptxConfig, draft: Draft): Draft {
  const normalized = normalizeDraft(draft)
  let patch: Draft = {}
  for (const field of CONFIG_FIELDS) {
    const value = normalized[field]
    if (value !== undefined && value !== base[field]) patch = withField(patch, field, value)
  }
  return patch
}

/**
 * 去掉和基准值逐字相等的暂存项：它们已经落定，之后别处的修改才能显示出来，不会被这里的旧暂存值盖住。
 * 用原值比较、不先规范化：用户正在输入的「/a/b 」不会因为去掉空格后等于 Host 的值就被吞掉结尾的空格。
 * 没有可去掉的项时返回原对象，React 不会因此重新渲染。
 */
export function pruneSettled(draft: Draft, base: PromptxConfig): Draft {
  let next = draft
  for (const field of CONFIG_FIELDS) {
    if (next[field] === undefined || next[field] !== base[field]) continue
    const { [field]: _settled, ...rest } = next
    next = rest
  }
  return next
}

/**
 * 上一次保存成功提交的值，以及保存时页面看到的 Host 配置。
 *
 * Host 回复「保存成功」和长轮询带回新配置是两条路，后者可能晚到。这段时间里页面按刚保存的值显示、比较改动，
 * 不然字段会先跳回旧值再变成新值，「保存」也会在这一下变回可用（再点一次就把同样的改动又提交一遍）。
 */
export interface AcceptedSave {
  readonly values: Draft
  readonly base: PromptxConfig
}

/**
 * 判断改动和显示用的基准：平时就是 Host 的配置；刚保存成功、Host 报来的配置还和保存时一样（新配置还没到）时，
 * 盖上刚保存的值。Host 报来的配置一变（保存已经反映进来，或者又被别处改了），以 Host 为准。
 */
export function baseConfig(config: PromptxConfig, accepted: AcceptedSave | null): PromptxConfig {
  if (accepted === null || !sameConfig(accepted.base, config)) return config
  return { ...config, ...accepted.values }
}

/**
 * 页面自己能判断的不合法值（只检查要提交的字段）。其余规则（dsh 数据目录、技能目录）只有 Host 知道，保存时由 Host 返回。
 * 用户手改补丁文件写进的不合法值，只要这次不提交就不拦保存：Host 照常加载，按注册失败处理（design-spec 4.2）。
 */
export function validatePatch(patch: Draft, platform: string, base?: PromptxConfig): FieldErrors {
  const errors: FieldErrors = {}
  if (patch.libraryDir !== undefined && patch.libraryDir !== '' && !isLibraryDirAccepted(patch.libraryDir, platform)) {
    errors.libraryDir = 'library-dir-relative'
  }
  if (patch.globalShortcut !== undefined && patch.globalShortcut !== '' && !parseAccelerator(patch.globalShortcut).ok) {
    errors.globalShortcut = 'shortcut-invalid'
  }
  for (const field of TOOLBAR_SHORTCUT_FIELDS) {
    const value = patch[field]
    if (value !== undefined && value !== '' && !parseAccelerator(value, 'window').ok) {
      errors[field] = 'window-shortcut-invalid'
    }
  }
  if (base !== undefined) {
    for (const field of conflictingShortcutFields(patch, base, platform)) errors[field] = 'shortcut-conflict'
  }
  return errors
}

/**
 * 与 Host 的 checkLibraryDir（src/config.ts）同一条规则：绝对路径，或 `~`、`~/`、`~\` 开头。
 * 判断按运行 dsh 的电脑的平台（PanelStatus.platform），不按浏览器所在的电脑：Windows 认盘符和反斜杠，其他平台认 `/`。
 */
export function isLibraryDirAccepted(value: string, platform: string): boolean {
  const trimmed = value.trim()
  if (trimmed === '~' || trimmed.startsWith('~/') || trimmed.startsWith('~\\')) return true
  if (platform === 'win32') return /^(?:[A-Za-z]:)?[\\/]/.test(trimmed)
  return trimmed.startsWith('/')
}
