import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { needsNoSandbox } from '../../src/companion/launch.ts'
import { failOnProcessProblems } from './process-traps.ts'

failOnProcessProblems()

const EXECUTABLE = '/home/me/.dsh/promptx/runtime/44.10.2-linux-x64/electron'
const SANDBOX = join('/home/me/.dsh/promptx/runtime/44.10.2-linux-x64', 'chrome-sandbox')
const USERNS = '/proc/sys/kernel/unprivileged_userns_clone'
const APPARMOR = '/proc/sys/kernel/apparmor_restrict_unprivileged_userns'

type Sandbox = { uid: number; mode: number } | 'missing'

/** 用假的 stat、readFile 描述一台机器：chrome-sandbox 的所有者和权限位，两个内核开关（undefined 表示这个内核没有这个开关）。 */
function machine(sandbox: Sandbox, switches: { userns?: string; apparmor?: string }) {
  const stats: string[] = []
  const reads: string[] = []
  return {
    stats,
    reads,
    input: {
      executable: EXECUTABLE,
      stat: async (path: string) => {
        stats.push(path)
        if (sandbox === 'missing') throw Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' })
        return sandbox
      },
      readFile: async (path: string) => {
        reads.push(path)
        const value = path === USERNS ? switches.userns : path === APPARMOR ? switches.apparmor : undefined
        if (value === undefined) throw Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' })
        return value
      },
    },
  }
}

const SETUID_ROOT = { uid: 0, mode: 0o104755 }
const ROOT_NO_SETUID = { uid: 0, mode: 0o100755 }
const USER_SETUID = { uid: 1000, mode: 0o104755 }

describe('needsNoSandbox', () => {
  it('keeps the sandbox when chrome-sandbox is setuid root, whatever the kernel says', async () => {
    const m = machine(SETUID_ROOT, { userns: '0', apparmor: '1' })
    expect(await needsNoSandbox(m.input)).toBe(false)
    expect(m.stats).toEqual([SANDBOX])
    expect(m.reads).toEqual([])
  })

  it('disables the sandbox on Ubuntu 24.04 defaults (AppArmor restricts user namespaces)', async () => {
    expect(await needsNoSandbox(machine(ROOT_NO_SETUID, { userns: '1', apparmor: '1' }).input)).toBe(true)
    expect(await needsNoSandbox(machine('missing', { apparmor: '1\n' }).input)).toBe(true)
  })

  it('disables the sandbox when unprivileged user namespaces are turned off', async () => {
    expect(await needsNoSandbox(machine(USER_SETUID, { userns: '0' }).input)).toBe(true)
    expect(await needsNoSandbox(machine('missing', { userns: '0\n', apparmor: '0\n' }).input)).toBe(true)
  })

  it('keeps the sandbox when user namespaces are allowed', async () => {
    expect(await needsNoSandbox(machine(ROOT_NO_SETUID, { userns: '1', apparmor: '0' }).input)).toBe(false)
    expect(await needsNoSandbox(machine(USER_SETUID, { userns: '1' }).input)).toBe(false)
  })

  it('keeps the sandbox when the kernel has neither switch', async () => {
    const m = machine('missing', {})
    expect(await needsNoSandbox(m.input)).toBe(false)
    expect(m.reads.sort()).toEqual([APPARMOR, USERNS].sort())
  })

  it('does not count a setuid chrome-sandbox owned by another user as configured', async () => {
    expect(await needsNoSandbox(machine({ uid: 1000, mode: 0o4755 }, { userns: '0' }).input)).toBe(true)
  })
})
