// dsh 数据目录和 PromptX 自己的目录。插件自己的文件只放在 `<dsh 数据目录>/promptx/` 下（需求 7.10）。

import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

export interface PromptxPaths {
  /** dsh 数据目录，默认 ~/.dsh，设置了 DSH_HOME 时以它为准。 */
  dshHome: string
  /** `<dsh>/promptx` */
  root: string
  /** 默认库目录 `<dsh>/promptx/library` */
  defaultLibrary: string
  /** 运行时目录 `<dsh>/promptx/runtime` */
  runtime: string
  /** 小程序偏好 `<dsh>/promptx/prefs.json` */
  prefs: string
  /** 小程序日志目录 `<dsh>/promptx/logs` */
  logs: string
  /** Electron 用户数据目录的上一级 `<dsh>/promptx/electron`，按 profile 分子目录 */
  electronData: string
}

/**
 * 解析 dsh 数据目录。优先用 dsh 根上下文提供的 dshHomePath（和 dsh 自己的判断一致），
 * 拿不到时按 dsh-home-paths 的规则：DSH_HOME（空白视为没设置），否则 ~/.dsh。
 */
export function resolveDshHome(dshHomePath: ((...segments: string[]) => string) | undefined, env: NodeJS.ProcessEnv = process.env): string {
  if (dshHomePath !== undefined) return resolve(dshHomePath())
  const fromEnv = env.DSH_HOME?.trim()
  if (fromEnv !== undefined && fromEnv !== '') return resolve(expandHome(fromEnv))
  return join(homedir(), '.dsh')
}

export function promptxPaths(dshHome: string): PromptxPaths {
  const root = join(dshHome, 'promptx')
  return {
    dshHome,
    root,
    defaultLibrary: join(root, 'library'),
    runtime: join(root, 'runtime'),
    prefs: join(root, 'prefs.json'),
    logs: join(root, 'logs'),
    electronData: join(root, 'electron'),
  }
}

/** `~` 和 `~/…`（Windows 上也认 `~\…`）展开成用户主目录。 */
export function expandHome(value: string, home: string = homedir()): string {
  if (value === '~') return home
  if (value.startsWith('~/') || value.startsWith('~\\')) return join(home, value.slice(2))
  return value
}

/**
 * profile 名 → 文件名和存储单元名里用的哈希：UTF-8 的 SHA-256 前 16 位小写十六进制。
 * 不用「替换非法字符」：dsh 的 profile 名可以是中文和任意标点，替换会让「工作」「生活」撞成同一个键（审查意见 TC-05）。
 * 没有 profile（dsh 不经 profile 启动）时用保留值 none，它不可能是 16 位十六进制。
 */
export function profileHash(profile: string | undefined): string {
  if (profile === undefined || profile === '') return 'none'
  return createHash('sha256').update(profile, 'utf8').digest('hex').slice(0, 16)
}
