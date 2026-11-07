import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { buildLaunchSpec, companionEnv, LINUX_ENV_KEYS, POSIX_ENV_KEYS, resolveAppDir, WINDOWS_ENV_KEYS, type LaunchInput } from '../../src/companion/launch.ts'
import { COMPANION_ENV, COMPANION_MARKER_ARG } from '../../src/shared/protocol.ts'
import { failOnProcessProblems } from './process-traps.ts'

failOnProcessProblems()

/** Host 进程可能继承到的环境：白名单里的、凭据、项目 .env 写进来的 PROMPTX_*、dsh 桌面版带的 ELECTRON_RUN_AS_NODE。 */
const HOST_ENV: NodeJS.ProcessEnv = {
  PATH: '/usr/bin:/bin',
  HOME: '/home/me',
  USER: 'me',
  LOGNAME: 'me',
  TMPDIR: '/tmp',
  LANG: 'zh_CN.UTF-8',
  LANGUAGE: 'zh_CN:en',
  LC_ALL: 'zh_CN.UTF-8',
  LC_CTYPE: 'zh_CN.UTF-8',
  DISPLAY: ':0',
  WAYLAND_DISPLAY: 'wayland-0',
  XAUTHORITY: '/home/me/.Xauthority',
  XDG_RUNTIME_DIR: '/run/user/1000',
  XDG_SESSION_TYPE: 'x11',
  XDG_CURRENT_DESKTOP: 'GNOME',
  XDG_DATA_DIRS: '/usr/share',
  XDG_CONFIG_DIRS: '/etc/xdg',
  DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
  GTK_IM_MODULE: 'fcitx',
  QT_IM_MODULE: 'fcitx',
  XMODIFIERS: '@im=fcitx',
  SDL_IM_MODULE: 'fcitx',
  ELECTRON_RUN_AS_NODE: '1',
  NODE_OPTIONS: '--require /tmp/evil.js',
  DEEPSEEK_API_KEY: 'sk-secret',
  HTTPS_PROXY: 'http://proxy:8080',
  PROMPTX_DATA_DIR: '/tmp/attacker',
  PROMPTX_PROFILE: 'attacker',
  PROMPTX_PROFILE_HASH: 'ffff',
  PROMPTX_PARENT_PID: '1',
  PROMPTX_E2E: '1',
  PROMPTX_MODE: 'e2e',
  DSH_HOME: '/home/me/.dsh',
}

function input(platform: string, overrides: Partial<LaunchInput> = {}): LaunchInput {
  return {
    executable: '/runtime/44.10.2-linux-x64/electron',
    appDir: '/plugin/lib/app',
    profile: { name: '工作', hash: '0123456789abcdef' },
    dataDir: '/home/me/.dsh/promptx',
    parentPid: 4321,
    env: HOST_ENV,
    platform,
    // 默认：沙箱配置正常，不需要 --no-sandbox。
    stat: async () => ({ uid: 0, mode: 0o104755 }),
    readFile: async () => '1\n',
    ...overrides,
  }
}

const COMPUTED = {
  [COMPANION_ENV.dataDir]: '/home/me/.dsh/promptx',
  [COMPANION_ENV.profile]: '工作',
  [COMPANION_ENV.profileHash]: '0123456789abcdef',
  [COMPANION_ENV.parentPid]: '4321',
}

describe('buildLaunchSpec', () => {
  it('starts the app directory with the process marker argument', async () => {
    const spec = await buildLaunchSpec(input('darwin', { executable: '/runtime/Electron.app/Contents/MacOS/Electron' }))
    expect(spec.executable).toBe('/runtime/Electron.app/Contents/MacOS/Electron')
    expect(spec.args).toEqual(['/plugin/lib/app', `${COMPANION_MARKER_ARG}=0123456789abcdef`])
    expect(spec.args[1]).toBe('--promptx-companion=0123456789abcdef')
  })

  it('passes only the POSIX allowlist plus the values the Host computed on macOS', async () => {
    const spec = await buildLaunchSpec(input('darwin'))
    const expected: Record<string, string> = { ...COMPUTED }
    for (const key of POSIX_ENV_KEYS) expected[key] = HOST_ENV[key]!
    expect(spec.env).toEqual(expected)
  })

  it('adds the display, D-Bus and input method variables on Linux', async () => {
    const spec = await buildLaunchSpec(input('linux'))
    for (const key of ['GTK_IM_MODULE', 'QT_IM_MODULE', 'XMODIFIERS', 'SDL_IM_MODULE', 'XDG_DATA_DIRS', 'XDG_CONFIG_DIRS', 'LANGUAGE', 'DISPLAY', 'DBUS_SESSION_BUS_ADDRESS']) {
      expect(spec.env[key], key).toBe(HOST_ENV[key])
    }
    expect(Object.keys(spec.env).sort()).toEqual([...POSIX_ENV_KEYS, ...LINUX_ENV_KEYS, ...Object.keys(COMPUTED)].sort())
  })

  it('never passes inherited PROMPTX_* values, ELECTRON_RUN_AS_NODE, NODE_OPTIONS or credentials', async () => {
    for (const platform of ['darwin', 'linux', 'win32']) {
      const spec = await buildLaunchSpec(input(platform))
      expect(spec.env.ELECTRON_RUN_AS_NODE, platform).toBeUndefined()
      expect(spec.env.NODE_OPTIONS, platform).toBeUndefined()
      expect(spec.env.DEEPSEEK_API_KEY, platform).toBeUndefined()
      expect(spec.env.HTTPS_PROXY, platform).toBeUndefined()
      expect(spec.env.DSH_HOME, platform).toBeUndefined()
      expect(spec.env.PROMPTX_E2E, platform).toBeUndefined()
      expect(spec.env.PROMPTX_MODE, platform).toBeUndefined()
      const promptx = Object.fromEntries(Object.entries(spec.env).filter(([key]) => key.startsWith('PROMPTX_')))
      expect(promptx, platform).toEqual(COMPUTED)
    }
  })

  it('uses the Windows allowlist and finds variables regardless of case', async () => {
    const env: NodeJS.ProcessEnv = {
      Path: 'C:\\Windows\\System32',
      USERPROFILE: 'C:\\Users\\me',
      LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local',
      APPDATA: 'C:\\Users\\me\\AppData\\Roaming',
      TEMP: 'C:\\Temp',
      TMP: 'C:\\Temp',
      USERNAME: 'me',
      SYSTEMROOT: 'C:\\Windows',
      windir: 'C:\\Windows',
      PATHEXT: '.COM;.EXE',
      ComSpec: 'C:\\Windows\\System32\\cmd.exe',
      HOME: 'C:\\Users\\me',
      ELECTRON_RUN_AS_NODE: '1',
      PROMPTX_DATA_DIR: 'C:\\attacker',
    }
    const spec = await buildLaunchSpec(input('win32', { executable: 'C:\\runtime\\electron.exe', env }))
    expect(spec.env).toEqual({
      PATH: 'C:\\Windows\\System32',
      USERPROFILE: 'C:\\Users\\me',
      LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local',
      APPDATA: 'C:\\Users\\me\\AppData\\Roaming',
      TEMP: 'C:\\Temp',
      TMP: 'C:\\Temp',
      USERNAME: 'me',
      SystemRoot: 'C:\\Windows',
      windir: 'C:\\Windows',
      PATHEXT: '.COM;.EXE',
      ComSpec: 'C:\\Windows\\System32\\cmd.exe',
      ...COMPUTED,
    })
    expect(Object.keys(spec.env).filter(key => !key.startsWith('PROMPTX_')).sort()).toEqual([...WINDOWS_ENV_KEYS].sort())
    expect(spec.args).not.toContain('--no-sandbox')
  })

  it('leaves out allowlisted variables the Host does not have', () => {
    const env = companionEnv({ env: { PATH: '/bin' }, platform: 'linux', profile: { name: 'p', hash: 'h' }, dataDir: '/d', parentPid: 1 })
    expect(env).toEqual({ PATH: '/bin', PROMPTX_DATA_DIR: '/d', PROMPTX_PROFILE: 'p', PROMPTX_PROFILE_HASH: 'h', PROMPTX_PARENT_PID: '1' })
  })

  it('adds --no-sandbox on Linux only when the sandbox cannot work', async () => {
    // Ubuntu 24.04 的默认情况：chrome-sandbox 不是 setuid root，AppArmor 限制非特权用户命名空间。
    const switches: Record<string, string> = {
      '/proc/sys/kernel/unprivileged_userns_clone': '1\n',
      '/proc/sys/kernel/apparmor_restrict_unprivileged_userns': '1\n',
    }
    const restricted = input('linux', {
      stat: async () => ({ uid: 1000, mode: 0o100755 }),
      readFile: async path => switches[path] ?? '',
    })
    expect((await buildLaunchSpec(restricted)).args).toEqual(['/plugin/lib/app', '--promptx-companion=0123456789abcdef', '--no-sandbox'])
    // 同样的条件在 macOS、Windows 上不加。
    expect((await buildLaunchSpec({ ...restricted, platform: 'darwin' })).args).not.toContain('--no-sandbox')
    expect((await buildLaunchSpec({ ...restricted, platform: 'win32' })).args).not.toContain('--no-sandbox')
    expect((await buildLaunchSpec(input('linux'))).args).not.toContain('--no-sandbox')
  })
})

describe('resolveAppDir', () => {
  it('finds lib/app next to the built Host bundle', () => {
    const bundle = pathToFileURL(resolve('/plugin/lib/index.js')).href
    expect(resolveAppDir(undefined, bundle)).toBe(resolve('/plugin/lib/app'))
  })

  it('finds lib/app at the package root when running from source', () => {
    const source = pathToFileURL(resolve('/repo/src/companion/launch.ts')).href
    expect(resolveAppDir(undefined, source)).toBe(resolve('/repo/lib/app'))
    expect(resolveAppDir()).toBe(resolve(import.meta.dirname, '../../lib/app'))
  })

  it('honours an explicit override', () => {
    expect(resolveAppDir('/custom/app')).toBe(resolve('/custom/app'))
    expect(resolveAppDir('  ', pathToFileURL(resolve('/plugin/lib/index.js')).href)).toBe(join(resolve('/plugin/lib'), 'app'))
  })
})
