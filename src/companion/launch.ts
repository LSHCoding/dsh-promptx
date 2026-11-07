// 小程序的启动命令：参数、环境变量、Linux 上是否关掉 Chromium 沙箱（design-spec 5.2、5.6、D16；需求 F-06、N-05）。
// 这里只计算，不启动进程；启动和监管在 supervisor.ts。

import { execFile } from 'node:child_process'
import { readFile as fsReadFile, stat as fsStat } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { LaunchSpec } from '../services.ts'
import { COMPANION_ENV, COMPANION_MARKER_ARG } from '../shared/protocol.ts'

/** macOS、Linux 都传的变量。 */
export const POSIX_ENV_KEYS: readonly string[] = ['PATH', 'HOME', 'USER', 'LOGNAME', 'TMPDIR', 'LANG', 'LANGUAGE', 'LC_ALL', 'LC_CTYPE']

/**
 * Linux 另传：图形会话、D-Bus 和输入法。输入法变量（GTK_IM_MODULE、QT_IM_MODULE、XMODIFIERS、SDL_IM_MODULE）
 * 和 XDG_DATA_DIRS、XDG_CONFIG_DIRS 缺了时，X11 下 Chromium 的 GTK 输入法上下文接不上 fcitx、ibus，中文输入不可用（审查 S17）。
 */
export const LINUX_ENV_KEYS: readonly string[] = [
  'DISPLAY', 'WAYLAND_DISPLAY', 'XAUTHORITY', 'XDG_RUNTIME_DIR', 'XDG_SESSION_TYPE', 'XDG_CURRENT_DESKTOP',
  'XDG_DATA_DIRS', 'XDG_CONFIG_DIRS', 'DBUS_SESSION_BUS_ADDRESS',
  'GTK_IM_MODULE', 'QT_IM_MODULE', 'XMODIFIERS', 'SDL_IM_MODULE',
]

/**
 * Windows 传的变量。design-spec 5.2 的 Windows 清单里有 PATHEXT 却没有 PATH，PATHEXT 只在按 PATH 查找程序时才有意义，
 * 这里把 PATH 一起传下去（它不含凭据）。SystemRoot 缺了时 Winsock 等系统组件初始化会失败。
 */
export const WINDOWS_ENV_KEYS: readonly string[] = [
  'PATH', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'TEMP', 'TMP', 'USERNAME', 'SystemRoot', 'windir', 'PATHEXT', 'ComSpec',
]

export interface LaunchInput {
  /** Electron 可执行文件的绝对路径。 */
  executable: string
  /** 小程序代码目录（lib/app）。 */
  appDir: string
  profile: { name: string; hash: string }
  /** `<dsh 数据目录>/promptx` */
  dataDir: string
  parentPid: number
  /** Host 自己的环境变量；只从里面按白名单挑。 */
  env: NodeJS.ProcessEnv
  platform: string
  /** 测试时替换：读 /proc 下的内核开关。 */
  readFile?: (path: string) => Promise<string>
  /** 测试时替换：查看 chrome-sandbox 的所有者和权限位。 */
  stat?: (path: string) => Promise<{ uid: number; mode: number }>
  /** 测试时替换：试建用户命名空间（true 能建、false 被拒绝、undefined 没法试）。 */
  probeUserns?: () => Promise<boolean | undefined>
}

/**
 * 生成启动命令。参数是 `[<lib/app 目录>, --promptx-companion=<profile 哈希>]`，Linux 上需要时再加 `--no-sandbox`。
 * 进程标记只用来在进程列表里认出小程序（`pkill -f -- '--promptx-companion='`，审查 TC-12）：Electron 的默认应用跳过
 * 以 `-` 开头的参数，Chromium 忽略不认识的开关。
 */
export async function buildLaunchSpec(input: LaunchInput): Promise<LaunchSpec> {
  const args = [input.appDir, `${COMPANION_MARKER_ARG}=${input.profile.hash}`]
  if (input.platform === 'linux' && (await needsNoSandbox(input))) args.push('--no-sandbox')
  return { executable: input.executable, args, env: companionEnv(input) }
}

/**
 * 小程序的环境变量：严格白名单，值都由 Host 决定（design-spec 5.2、9；审查 S10）。
 * - 继承来的 `PROMPTX_*` 一律不传：dsh 会把启动目录里 `.env` 的值写进 process.env，克隆下来的仓库就能借此改写小程序的行为。
 *   这里的 `PROMPTX_*` 是 Host 自己算出来的。
 * - 一定不传 `ELECTRON_RUN_AS_NODE`：dsh 桌面版的 Host 进程带着它，传下去 Electron 就按 Node 运行，不开窗口。
 * - 不传 NODE_OPTIONS 等：它们能往 Electron 的 Node 环境里注入代码。
 */
export function companionEnv(input: Pick<LaunchInput, 'env' | 'platform' | 'profile' | 'dataDir' | 'parentPid'>): Record<string, string> {
  const windows = input.platform === 'win32'
  let keys: readonly string[]
  if (windows) keys = WINDOWS_ENV_KEYS
  else if (input.platform === 'linux') keys = [...POSIX_ENV_KEYS, ...LINUX_ENV_KEYS]
  else keys = POSIX_ENV_KEYS
  const env: Record<string, string> = {}
  for (const key of keys) {
    const value = lookup(input.env, key, windows)
    if (value !== undefined) env[key] = value
  }
  env[COMPANION_ENV.dataDir] = input.dataDir
  env[COMPANION_ENV.profile] = input.profile.name
  env[COMPANION_ENV.profileHash] = input.profile.hash
  env[COMPANION_ENV.parentPid] = String(input.parentPid)
  return env
}

/**
 * Windows 的环境变量名不区分大小写（`Path` 和 `PATH` 是同一个）。Node 的 process.env 在 Windows 上已经按这个规则查找，
 * 但调用方传进来的也可能是普通对象，所以这里自己再按不区分大小写找一遍。
 */
function lookup(env: NodeJS.ProcessEnv, key: string, caseInsensitive: boolean): string | undefined {
  const direct = env[key]
  if (direct !== undefined || !caseInsensitive) return direct
  const wanted = key.toLowerCase()
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined && name.toLowerCase() === wanted) return value
  }
  return undefined
}

/**
 * Linux 上是否要加 `--no-sandbox`（design-spec 5.2、D16）。运行时目录里的 chrome-sandbox 归 root 所有且带 setuid 位时，
 * Chromium 用它做沙箱，不用加；否则 Chromium 要靠非特权用户命名空间，系统禁止它时（`unprivileged_userns_clone` 为 0，
 * 或 `apparmor_restrict_unprivileged_userns` 为 1，Ubuntu 24.04 默认如此）Electron 起不来，只能关掉沙箱。
 * 小窗只加载包内的本地文件、不加载网页，关掉沙箱的风险可以接受（已知限制）。
 */
export async function needsNoSandbox(input: Pick<LaunchInput, 'executable' | 'readFile' | 'stat' | 'probeUserns'>): Promise<boolean> {
  const statFile = input.stat ?? fsStat
  const read = input.readFile ?? ((path: string) => fsReadFile(path, 'utf8'))
  try {
    const info = await statFile(join(dirname(input.executable), 'chrome-sandbox'))
    if (info.uid === 0 && (info.mode & 0o4000) !== 0) return false
  } catch {
    // 没有 chrome-sandbox 或读不了：只能靠用户命名空间，接着看内核开关。
  }
  const userns = await readSwitch(read, '/proc/sys/kernel/unprivileged_userns_clone')
  const apparmor = await readSwitch(read, '/proc/sys/kernel/apparmor_restrict_unprivileged_userns')
  if (userns === '0' || apparmor === '1') return true
  // 内核开关允许，不代表真的能建用户命名空间：容器的 seccomp 等策略也会拦。拦住时 Chromium 退回 setuid 沙箱，
  // 而 chrome-sandbox 没配好就直接中止（"The SUID sandbox helper binary was found, but is not configured correctly"）。
  // 所以实际试一次：建不了就加 --no-sandbox；试不了（没有 unshare）时按内核开关的结论走。
  const probe = input.probeUserns ?? (process.platform === 'linux' ? probeUserNamespace : undefined)
  if (probe === undefined) return false
  const usable = await probe()
  return usable === false
}

/** 试着建一个非特权用户命名空间：能建返回 true，被拒绝返回 false，没有 unshare 命令时返回 undefined。 */
function probeUserNamespace(): Promise<boolean | undefined> {
  return new Promise((resolve) => {
    const child = execFile('unshare', ['--user', '--map-root-user', 'true'], { timeout: 3_000, windowsHide: true }, (error) => {
      if (error === null) {
        resolve(true)
        return
      }
      resolve((error as NodeJS.ErrnoException).code === 'ENOENT' ? undefined : false)
    })
    child.once('error', () => {})
  })
}

/** 读一个内核开关；文件不存在（这个内核没有这个开关）时返回 undefined。 */
async function readSwitch(read: (path: string) => Promise<string>, path: string): Promise<string | undefined> {
  try {
    return (await read(path)).trim()
  } catch {
    return undefined
  }
}

/**
 * 小程序代码目录 lib/app。构建后本模块被打包进 lib/index.js，lib/app 就在同一目录下；
 * 从源码运行时（单测、冒烟测试）本文件在 src/companion/，要回到包根目录再找 lib/app。
 * override 给测试或特殊布局用。
 */
export function resolveAppDir(override?: string, moduleUrl: string = import.meta.url): string {
  if (override !== undefined && override.trim() !== '') return resolve(override)
  const here = dirname(fileURLToPath(moduleUrl))
  if (basename(here) === 'companion' && basename(dirname(here)) === 'src') return join(dirname(dirname(here)), 'lib', 'app')
  return join(here, 'app')
}
