// 读取 Host 启动小程序时设置的环境变量（protocol.ts 的 COMPANION_ENV），推出小程序自己的文件位置。
// 这些值都由 Host 计算后传入；运行模式不走环境变量，只看 hello 的回复（design-spec 9）。

import { isAbsolute, join } from 'node:path'
import { COMPANION_ENV } from '../../shared/protocol.ts'

export interface CompanionEnv {
  /** `<dsh 数据目录>/promptx` */
  dataDir: string
  /** profile 名，只用于显示（快捷键锁文件里的持有者）。 */
  profile: string
  /** profile 名的哈希，用作 Electron 数据目录名。 */
  profileHash: string
  /** Host 进程号；拿不到时为 null，不做父进程检查。 */
  parentPid: number | null
}

export type CompanionEnvResult = { ok: true; env: CompanionEnv } | { ok: false; problem: string }

/** 哈希会拼进路径，只接受这些字符，防止 `../` 之类的值把 Electron 数据目录指到别处。 */
const PROFILE_HASH = /^[A-Za-z0-9_-]{1,64}$/

/**
 * fallbackParentPid 一般传 process.ppid：Host 没给进程号时，直接启动小程序的进程就是 Host。
 * 数据目录缺失或不是绝对路径时返回 problem，入口据此直接退出，不在未知位置写文件。
 */
export function readCompanionEnv(env: Readonly<Record<string, string | undefined>>, fallbackParentPid: number): CompanionEnvResult {
  const dataDir = env[COMPANION_ENV.dataDir]?.trim() ?? ''
  if (dataDir === '' || !isAbsolute(dataDir)) return { ok: false, problem: `${COMPANION_ENV.dataDir} is missing or not an absolute path` }
  const hash = env[COMPANION_ENV.profileHash]?.trim() ?? ''
  const parent = Number(env[COMPANION_ENV.parentPid] ?? '')
  let parentPid: number | null = null
  if (Number.isSafeInteger(parent) && parent > 1) parentPid = parent
  else if (Number.isSafeInteger(fallbackParentPid) && fallbackParentPid > 1) parentPid = fallbackParentPid
  return {
    ok: true,
    env: {
      dataDir,
      profile: env[COMPANION_ENV.profile] ?? '',
      profileHash: PROFILE_HASH.test(hash) ? hash : 'none',
      parentPid,
    },
  }
}

export interface CompanionPaths {
  /** 小窗偏好，所有 profile 共用（design-spec 7.6）。 */
  prefs: string
  /** 小程序日志目录。 */
  logDir: string
  /** 全局快捷键锁文件所在目录（与 Host 的实例锁同一个目录）。 */
  locksDir: string
  /** Electron 用户数据目录，按 profile 分开，避免两个小程序争用 Chromium 缓存。 */
  userData: string
}

export function companionPaths(env: CompanionEnv): CompanionPaths {
  return {
    prefs: join(env.dataDir, 'prefs.json'),
    logDir: join(env.dataDir, 'logs'),
    locksDir: join(env.dataDir, 'locks'),
    userData: join(env.dataDir, 'electron', env.profileHash),
  }
}
