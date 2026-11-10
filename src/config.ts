// PromptX 的 Config。字段全部 volatile：修改时插件不重启，值原地更新（design-spec 4.2）。
// 配置写在 profile 的 cordis.patch.yml 里 `id: promptx` 这一行，由 dsh 的 settings.update() 写入。

import Schema from '@deepseek-ai/schemastery'
import type { Volatile } from '@deepseek-ai/cordis'
import { homedir } from 'node:os'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { defaultShortcut, parseAccelerator } from './shared/accelerator.ts'
import type { ConfigFieldError, PromptxConfig, RuntimeSource } from './shared/types.ts'
import { expandHome } from './paths.ts'

/** 默认全局快捷键：macOS ⌃P，其他平台 Ctrl+Alt+P（需求 Q7）。Host 和小程序在同一台电脑上，按 Host 的平台决定。 */
export const DEFAULT_SHORTCUT = defaultShortcut(process.platform)

export const RUNTIME_SOURCES: readonly RuntimeSource[] = ['auto', 'mirror', 'official']

/** dsh 传给 apply 的配置：每个字段都是可原地更新的引用。 */
export interface ConfigRefs {
  libraryDir: Volatile<string>
  confirmDelete: Volatile<boolean>
  convertMiddleDot: Volatile<boolean>
  convertYen: Volatile<boolean>
  optimizeInstruction: Volatile<string>
  globalShortcut: Volatile<string>
  hideOnBlur: Volatile<boolean>
  runtimeSource: Volatile<RuntimeSource>
}

export const Config: Schema<unknown, ConfigRefs> = Schema.object({
  libraryDir: Schema.string().default('').volatile()
    .description('Prompt library directory. Empty means <dsh home>/promptx/library. Absolute path or starting with ~.'),
  confirmDelete: Schema.boolean().default(true).volatile()
    .description('Ask before moving a prompt to the trash.'),
  convertMiddleDot: Schema.boolean().default(true).volatile()
    .description('Convert repeated middle dots to backticks or a code block.'),
  convertYen: Schema.boolean().default(true).volatile()
    .description('Convert repeated yen signs to dollar signs or a display math block.'),
  optimizeInstruction: Schema.string().role('textarea').default('').volatile()
    .description('Instruction sent to the model when optimizing. Empty means the built-in default.'),
  globalShortcut: Schema.string().default(DEFAULT_SHORTCUT).volatile()
    .description('Global shortcut (Electron accelerator) that shows or hides the PromptX window. Empty disables it.'),
  hideOnBlur: Schema.boolean().default(false).volatile()
    .description('Hide the PromptX window when it loses focus.'),
  runtimeSource: Schema.union(['auto', 'mirror', 'official'] as const).default('auto').volatile()
    .description('Where to download the Electron runtime: auto (mirror first, then official), mirror only, or official only.'),
}) as unknown as Schema<unknown, ConfigRefs>

/** 读出当前值。 */
export function readConfig(refs: ConfigRefs): PromptxConfig {
  return {
    libraryDir: refs.libraryDir.get(),
    confirmDelete: refs.confirmDelete.get(),
    convertMiddleDot: refs.convertMiddleDot.get(),
    convertYen: refs.convertYen.get(),
    optimizeInstruction: refs.optimizeInstruction.get(),
    globalShortcut: refs.globalShortcut.get(),
    hideOnBlur: refs.hideOnBlur.get(),
    runtimeSource: refs.runtimeSource.get(),
  }
}

export interface LibraryLocationContext {
  dshHome: string
  defaultLibrary: string
  home?: string
  platform?: string
}

/** 绝对路径，或以 `~`、`~/`、`~\` 开头（配置页和 Host 认同一条规则）。 */
function isAbsoluteOrHome(trimmed: string): boolean {
  return trimmed === '~' || trimmed.startsWith('~/') || trimmed.startsWith('~\\') || isAbsolute(trimmed)
}

/**
 * 配置值 → 库目录的绝对路径。空串用默认目录。
 * 既不是绝对路径、也不以 `~` 开头的值（只能是手改补丁文件写进去的）原样返回、不解析：按 dsh 进程的当前目录解析，
 * 库服务就看不出它是相对路径，会在启动 dsh 的那个目录（项目仓库里，或桌面版的 `/`）扫描、建库。
 * 原样交给库服务，由它报 library-dir-relative（审查 H5）。
 */
export function resolveLibraryDir(value: string, ctx: LibraryLocationContext): string {
  const trimmed = value.trim()
  if (trimmed === '') return ctx.defaultLibrary
  if (!isAbsoluteOrHome(trimmed)) return trimmed
  return resolve(expandHome(trimmed, ctx.home ?? homedir()))
}

/**
 * 库目录的位置限制（需求 L-01、S-01、7.10；design-spec 7.4）。返回 null 表示可以用。
 * - 必须是绝对路径或以 ~ 开头；
 * - 不能是 dsh 数据目录本身，也不能落在 dsh 数据目录里除 promptx/library 以外的位置；
 * - 路径中不能出现 .dsh/skills、.agents/skills（dsh 会把这些目录里带 front matter 的 .md 当作技能）。
 */
export function checkLibraryDir(value: string, ctx: LibraryLocationContext): ConfigFieldError | null {
  const trimmed = value.trim()
  if (trimmed === '') return null
  if (!isAbsoluteOrHome(trimmed)) return 'library-dir-relative'
  const target = resolveLibraryDir(trimmed, ctx)
  const platform = ctx.platform ?? process.platform
  // macOS、Windows 默认的文件系统不区分大小写，比较时统一小写。
  const fold = (p: string) => (platform === 'darwin' || platform === 'win32' ? p.toLowerCase() : p)
  const segments = fold(target).split(/[\\/]+/)
  for (let i = 0; i + 1 < segments.length; i++) {
    if ((segments[i] === '.dsh' || segments[i] === '.agents') && segments[i + 1] === 'skills') return 'library-dir-skills'
  }
  const dshHome = resolve(ctx.dshHome)
  if (isInsideOrEqual(fold(target), fold(dshHome))) {
    if (!isInsideOrEqual(fold(target), fold(resolve(ctx.defaultLibrary)))) return 'library-dir-reserved'
  }
  return null
}

/** 全局快捷键：空串表示不注册；否则必须是合法的加速键。 */
export function checkShortcut(value: string): ConfigFieldError | null {
  if (value.trim() === '') return null
  return parseAccelerator(value).ok ? null : 'shortcut-invalid'
}

function isInsideOrEqual(child: string, parent: string): boolean {
  const rel = relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel) && !rel.startsWith(`..${sep}`))
}
