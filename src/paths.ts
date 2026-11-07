// dsh 数据目录和 PromptX 自己的目录。插件自己的文件只放在 `<dsh 数据目录>/promptx/` 下（需求 7.10）。

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

/** 存储单元的记录键要符合 [a-zA-Z0-9_-]+：profile 名里的其他字符换成下划线；没有 profile 时用 default。 */
export function profileKey(profile: string | undefined): string {
  const name = profile?.trim() ?? ''
  if (name === '') return 'default'
  return name.replace(/[^a-zA-Z0-9_-]/g, '_')
}
