// 配置页「保存」：校验整份改动，全部合法才一次写入（需求 S-01、F-01、7.10；design-spec 4.2、7.4、D6、D12）。
//
// 配置页把所有改动的字段一次提交。任何一个字段不合法就一个也不写，返回字段级错误，页面保留暂存的值；
// 全部合法时调用 apply（index.ts 里是 settings.update('promptx', patch)）。apply 失败时同样什么都没写成，
// 返回 promptx/settings/unavailable。
//
// 库目录的位置检查（7.4）在 config.ts 的 checkLibraryDir 之外补上需要读文件系统的部分：
// 写下的路径和「它最近一个已存在的上级目录的 realpath + 其余各段」都要检查，否则一个指向 dsh 数据目录或技能目录的
// 符号链接就能绕过字面上的检查；macOS、Windows 上比较时不区分大小写。

import { realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { checkLibraryDir, resolveLibraryDir, RUNTIME_SOURCES } from '../config.ts'
import type { LibraryLocationContext } from '../config.ts'
import { expandHome } from '../paths.ts'
import { parseAccelerator } from '../shared/accelerator.ts'
import { toErrorInfo } from '../shared/errors.ts'
import type { ConfigFieldError, ConfigUpdateResult, ErrorInfo, PromptxConfig } from '../shared/types.ts'
import { conflictingShortcutFields, SHORTCUT_CONFIG_FIELDS } from '../shared/window-shortcuts.ts'

/** 库目录位置检查需要的上下文：在 config.ts 的基础上加上 dsh 另配的技能目录和 agents 目录。 */
export interface LocationContext extends LibraryLocationContext {
  /** dsh-skill-filesystem 生效配置里的 customSkillDirs（经 configEditor 读到；读不到时不传）。 */
  extraSkillDirs?: readonly string[] | undefined
  /** dsh-skill-filesystem 生效配置里的 agentsHome。 */
  agentsHome?: string | undefined
  /** 读 DSH_AGENTS_HOME 用，默认 process.env；测试时替换。 */
  env?: Readonly<Record<string, string | undefined>> | undefined
}

export interface ConfigUpdaterDeps {
  locationContext: () => LocationContext
  currentConfig: () => PromptxConfig
  platform: string
  /** 写入已校验、已规范化的改动。 */
  apply: (patch: Partial<PromptxConfig>) => Promise<void>
}

/**
 * 优化指令的长度上限。指令写进 profile 的 cordis.patch.yml，并随每次优化请求发给模型；
 * 远超这个长度的值只会让文件膨胀、请求失败，按不合法处理。
 */
export const MAX_INSTRUCTION_LENGTH = 100_000

/** 编译期保证列全了 PromptxConfig 的字段：少一个、多一个都过不了类型检查。 */
const CONFIG_FIELDS: Record<keyof PromptxConfig, true> = {
  libraryDir: true,
  confirmDelete: true,
  convertMiddleDot: true,
  convertYen: true,
  optimizeInstruction: true,
  globalShortcut: true,
  shortcutLibrary: true,
  shortcutSave: true,
  shortcutOptimize: true,
  shortcutClear: true,
  shortcutChat: true,
  shortcutSettings: true,
  shortcutClose: true,
  hideOnBlur: true,
  runtimeSource: true,
}

type FieldErrors = Partial<Record<keyof PromptxConfig, ConfigFieldError>>

export function createConfigUpdater(deps: ConfigUpdaterDeps): (patch: unknown) => Promise<ConfigUpdateResult> {
  const update = async (patch: unknown): Promise<ConfigUpdateResult> => {
    let validated: { ok: true; patch: Partial<PromptxConfig> } | { ok: false; result: ConfigUpdateResult }
    try {
      validated = await validatePatch(patch, deps)
    } catch (error) {
      return { ok: false, errors: {}, error: unavailable(error) }
    }
    if (!validated.ok) return validated.result
    // 页面在没有改动时不提交；万一提交了空改动，也不去碰 profile 文件。
    if (Object.keys(validated.patch).length === 0) return { ok: true }
    try {
      await deps.apply(validated.patch)
    } catch (error) {
      return { ok: false, errors: {}, error: unavailable(error) }
    }
    return { ok: true }
  }
  // 多个 dsh 页面同时保存时，后一份改动要用前一份已经写入的配置检查冲突。
  let tail = Promise.resolve()
  return (patch) => {
    const result = tail.then(() => update(patch))
    tail = result.then(() => undefined, () => undefined)
    return result
  }
}

/**
 * 库目录的位置限制，含 realpath 部分（design-spec 7.4）。value 是配置里的写法（可以为空、以 ~ 开头）。
 * 返回 null 表示可以用。
 */
export async function checkLibraryLocation(value: string, ctx: LocationContext): Promise<ConfigFieldError | null> {
  const literal = checkLibraryDir(value, ctx)
  if (literal !== null) return literal
  // 空值是默认目录 <dsh>/promptx/library，总是允许。
  if (value.trim() === '') return null

  const platform = ctx.platform ?? process.platform
  // macOS、Windows 默认的文件系统不区分大小写（和 config.ts 的规则一致）。
  const fold = (path: string) => (platform === 'darwin' || platform === 'win32' ? path.toLowerCase() : path)
  const home = ctx.home ?? homedir()
  const target = resolveLibraryDir(value, ctx)
  const dshHome = resolve(ctx.dshHome)
  const defaultLibrary = resolve(ctx.defaultLibrary)
  const skillRoots = skillRootsOf(ctx, home)

  const [realTarget, realDshHome, realDefaultLibrary] = await Promise.all([
    realpathOfNearest(target),
    realpathOfNearest(dshHome),
    realpathOfNearest(defaultLibrary),
  ])
  const realSkillRoots = await Promise.all(skillRoots.map(realpathOfNearest))

  // 写下的路径和真实路径、参照目录的写法和真实路径两两比较：任何一种拼写落进去都算落进去。
  const targets = unique([target, realTarget].map(fold))
  const homes = unique([dshHome, realDshHome].map(fold))
  const libraries = unique([defaultLibrary, realDefaultLibrary].map(fold))
  const skills = unique([...skillRoots, ...realSkillRoots].map(fold))

  for (const candidate of targets) {
    if (hasSkillSegments(candidate)) return 'library-dir-skills'
    if (skills.some(root => isInsideOrEqual(candidate, root))) return 'library-dir-skills'
  }
  for (const candidate of targets) {
    for (const dsh of homes) {
      // dsh 数据目录本身和它里面除 promptx/library 以外的位置（sessions、storages、skills、promptx/runtime……）。
      if (isInsideOrEqual(candidate, dsh) && !libraries.some(library => isInsideOrEqual(candidate, library))) return 'library-dir-reserved'
      // 库目录包含 dsh 数据目录：扫描会走进 dsh 自己的文件。中间经过以 . 开头的段时扫描会跳过（例如库设成 ~，数据目录是 ~/.dsh）。
      if (dsh !== candidate && isInsideOrEqual(dsh, candidate) && !passesDotSegment(candidate, dsh)) return 'library-dir-reserved'
    }
  }
  return null
}

/**
 * LibraryServiceOptions.checkRoot 用：每次使用库目录前重新检查位置限制（配置可能被手改）。
 * 不合格时返回 promptx/library/unavailable，detail 是字段错误码（如 library-dir-skills），小窗据此显示原因。
 */
export async function checkLibraryRoot(root: string, ctx: LocationContext): Promise<ErrorInfo | null> {
  const reason = await checkLibraryLocation(root, ctx)
  return reason === null ? null : { code: 'promptx/library/unavailable', detail: reason }
}

async function validatePatch(
  patch: unknown,
  deps: ConfigUpdaterDeps,
): Promise<{ ok: true; patch: Partial<PromptxConfig> } | { ok: false; result: ConfigUpdateResult }> {
  if (!isPlainObject(patch)) return badRequest('patch must be an object')
  for (const key of Object.keys(patch)) {
    if (!Object.hasOwn(CONFIG_FIELDS, key)) return badRequest(`unknown field: ${key.slice(0, 64)}`)
  }

  const errors: FieldErrors = {}
  const out: Partial<PromptxConfig> = {}

  if (Object.hasOwn(patch, 'libraryDir')) {
    const value = patch.libraryDir
    if (typeof value !== 'string' || value.includes('\0')) {
      errors.libraryDir = 'value-invalid'
    } else {
      const reason = await checkLibraryLocation(value, deps.locationContext())
      if (reason === null) out.libraryDir = value.trim()
      else errors.libraryDir = reason
    }
  }
  if (Object.hasOwn(patch, 'confirmDelete')) {
    const value = patch.confirmDelete
    if (typeof value === 'boolean') out.confirmDelete = value
    else errors.confirmDelete = 'value-invalid'
  }
  for (const field of ['convertMiddleDot', 'convertYen'] as const) {
    if (!Object.hasOwn(patch, field)) continue
    const value = patch[field]
    if (typeof value === 'boolean') out[field] = value
    else errors[field] = 'value-invalid'
  }
  if (Object.hasOwn(patch, 'hideOnBlur')) {
    const value = patch.hideOnBlur
    if (typeof value === 'boolean') out.hideOnBlur = value
    else errors.hideOnBlur = 'value-invalid'
  }
  if (Object.hasOwn(patch, 'optimizeInstruction')) {
    const value = patch.optimizeInstruction
    if (typeof value !== 'string' || value.length > MAX_INSTRUCTION_LENGTH) {
      errors.optimizeInstruction = 'value-invalid'
    } else {
      // 只有空白等于「用默认指令」，统一存成空串（和「恢复默认指令」的结果一样）。
      out.optimizeInstruction = /\S/.test(value) ? value : ''
    }
  }
  for (const field of SHORTCUT_CONFIG_FIELDS) {
    if (!Object.hasOwn(patch, field)) continue
    const value = patch[field]
    if (typeof value !== 'string') {
      errors[field] = 'value-invalid'
    } else if (value.trim() === '') {
      out[field] = ''
    } else {
      const global = field === 'globalShortcut'
      const parsed = parseAccelerator(value, global ? 'global' : 'window')
      if (parsed.ok) out[field] = parsed.canonical
      else errors[field] = global ? 'shortcut-invalid' : 'window-shortcut-invalid'
    }
  }
  if (SHORTCUT_CONFIG_FIELDS.some(field => out[field] !== undefined)) {
    for (const field of conflictingShortcutFields(out, deps.currentConfig(), deps.platform)) {
      errors[field] = 'shortcut-conflict'
    }
  }
  if (Object.hasOwn(patch, 'runtimeSource')) {
    const value = patch.runtimeSource
    const source = RUNTIME_SOURCES.find(item => item === value)
    if (source === undefined) errors.runtimeSource = 'value-invalid'
    else out.runtimeSource = source
  }

  if (Object.keys(errors).length > 0) return { ok: false, result: { ok: false, errors } }
  return { ok: true, patch: out }
}

function badRequest(detail: string): { ok: false; result: ConfigUpdateResult } {
  return { ok: false, result: { ok: false, errors: {}, error: { code: 'promptx/internal', detail } } }
}

function unavailable(error: unknown): ErrorInfo {
  const info = toErrorInfo(error, 'promptx/settings/unavailable')
  // PromptxError 自带的错误码（例如 promptx/internal）不代表「设置写不进去」，统一归到 settings/unavailable，保留系统信息。
  return info.detail === undefined ? { code: 'promptx/settings/unavailable' } : { code: 'promptx/settings/unavailable', detail: info.detail }
}

/** dsh 会扫描的技能目录里，需要按路径比较的那些（.dsh/skills、.agents/skills 两段另有逐段检查）。 */
function skillRootsOf(ctx: LocationContext, home: string): string[] {
  const env = ctx.env ?? process.env
  const roots: string[] = []
  // dsh-skill-filesystem 对 customSkillDirs 只做 resolve(dir)；这里多做一次 ~ 展开，宁可多拦也不漏拦。
  for (const dir of ctx.extraSkillDirs ?? []) {
    const trimmed = dir.trim()
    if (trimmed !== '') roots.push(resolve(expandHome(trimmed, home)))
  }
  // agents 目录的 skills：配置的 agentsHome、DSH_AGENTS_HOME、默认 ~/.agents 都拦（别的 agent 工具也读 ~/.agents/skills）。
  for (const agentsHome of [ctx.agentsHome, env.DSH_AGENTS_HOME, join(home, '.agents')]) {
    const trimmed = agentsHome?.trim() ?? ''
    if (trimmed !== '') roots.push(join(resolve(expandHome(trimmed, home)), 'skills'))
  }
  return unique(roots)
}

/**
 * 最近一个已存在的上级目录的 realpath，再接上其余各段。库目录可以还不存在（第一次保存时才创建），
 * 所以不能直接 realpath；中途任何一级读不了（不存在、没有权限、符号链接成环）都继续往上找。
 */
async function realpathOfNearest(path: string): Promise<string> {
  let current = path
  const missing: string[] = []
  for (;;) {
    try {
      const real = await realpath(current)
      return missing.length === 0 ? real : join(real, ...missing.reverse())
    } catch {
      const parent = dirname(current)
      if (parent === current) return path
      missing.push(basename(current))
      current = parent
    }
  }
}

function hasSkillSegments(path: string): boolean {
  const segments = path.split(/[\\/]+/)
  for (let i = 0; i + 1 < segments.length; i++) {
    if ((segments[i] === '.dsh' || segments[i] === '.agents') && segments[i + 1] === 'skills') return true
  }
  return false
}

function isInsideOrEqual(child: string, parent: string): boolean {
  const rel = relative(parent, child)
  if (rel === '') return true
  // Windows 上不同盘符时 relative 返回绝对路径。
  if (isAbsolute(rel)) return false
  return rel !== '..' && !rel.startsWith(`..${sep}`)
}

/** 从 outer 走到 inner 的路径上有没有以 . 开头的段（库扫描会跳过这些目录）。 */
function passesDotSegment(outer: string, inner: string): boolean {
  return relative(outer, inner).split(/[\\/]+/).some(segment => segment.startsWith('.'))
}

function unique(values: string[]): string[] {
  return [...new Set(values)]
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value) as unknown
  return proto === Object.prototype || proto === null
}
