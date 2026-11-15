import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { pidAlive } from '../../src/companion/process-utils.ts'
import { CompanionSupervisor, MAX_PENDING_WRITE_BYTES, STDERR_LINE_LIMIT } from '../../src/companion/supervisor.ts'
import type { HostLogger, HostPeer, LaunchSpec, SupervisorOptions } from '../../src/services.ts'
import { PromptxError } from '../../src/shared/errors.ts'
import { PROTOCOL_VERSION } from '../../src/shared/protocol.ts'
import type { CompanionConfig, CompanionState, ErrorInfo } from '../../src/shared/types.ts'
import { DEFAULT_TOOLBAR_SHORTCUTS } from '../../src/shared/window-shortcuts.ts'
import { failOnProcessProblems } from './process-traps.ts'

// 仍启动真实进程，只记录 spawn 的结果，供通道关闭测试取得父端的流。
vi.mock('node:child_process', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:child_process')>()
  return { ...original, spawn: vi.fn(original.spawn) }
})

const MOCK = fileURLToPath(new URL('../fixtures/mock-companion.mjs', import.meta.url))

const CONFIG: CompanionConfig = {
  globalShortcut: '',
  windowShortcuts: DEFAULT_TOOLBAR_SHORTCUTS,
  hideOnBlur: false,
  confirmDelete: true,
  convertMiddleDot: true,
  convertYen: true,
  locale: null,
  theme: 'system',
  libraryDir: '/tmp/library',
  profile: 'test',
}

/** 测试用的短时序：真实的 15 秒握手、5 秒心跳在单测里太慢。 */
const FAST: NonNullable<SupervisorOptions['timings']> = {
  handshakeMs: 3_000,
  heartbeatMs: 60,
  heartbeatTimeoutMs: 60,
  heartbeatMissLimit: 3,
  restartWindowMs: 20_000,
  restartLimit: 3,
  backoffMs: [20, 40, 80],
  shutdownGraceMs: 600,
  exitWaitMs: 300,
  killWaitMs: 300,
}

failOnProcessProblems()

interface LogEntry {
  level: keyof HostLogger
  args: unknown[]
}

interface Harness {
  supervisor: CompanionSupervisor
  states: Array<{ state: CompanionState; error: ErrorInfo | undefined }>
  spawned: number[]
  exited: number[]
  attached: HostPeer[]
  ready: HostPeer[]
  logs: LogEntry[]
  launches: number
  /** 下一次启动用的模拟小程序参数。 */
  args: string[]
}

const harnesses: Harness[] = []

function childEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !key.startsWith('PROMPTX_')) env[key] = value
  }
  return env
}

function mockSpec(args: string[]): LaunchSpec {
  // 默认按当前协议版本握手；要模拟别的版本时测试自己传 --protocol。
  const protocol = args.some(arg => arg.startsWith('--protocol=')) ? [] : [`--protocol=${PROTOCOL_VERSION}`]
  return { executable: process.execPath, args: [MOCK, ...protocol, ...args], env: childEnv() }
}

function createHarness(args: string[], overrides: Partial<SupervisorOptions> = {}): Harness {
  const logs: LogEntry[] = []
  const logger: HostLogger = {
    debug: (...rest: unknown[]) => {
      logs.push({ level: 'debug', args: rest })
    },
    info: (...rest: unknown[]) => {
      logs.push({ level: 'info', args: rest })
    },
    warn: (...rest: unknown[]) => {
      logs.push({ level: 'warn', args: rest })
    },
    error: (...rest: unknown[]) => {
      logs.push({ level: 'error', args: rest })
    },
  }
  const h = { states: [], spawned: [], exited: [], attached: [], ready: [], logs, launches: 0, args } as unknown as Harness
  h.supervisor = new CompanionSupervisor({
    prepareLaunch: async () => {
      h.launches += 1
      return mockSpec(h.args)
    },
    attach: (peer) => {
      h.attached.push(peer)
    },
    helloResult: () => ({
      hostVersion: '0.1.0-test',
      config: CONFIG,
      mode: 'normal',
    }),
    onReady: (peer) => {
      h.ready.push(peer)
    },
    onStateChange: (state, error) => {
      h.states.push({ state, error })
    },
    onProcess: (event) => {
      if (event.type === 'spawned') h.spawned.push(event.pid)
      else h.exited.push(event.pid)
    },
    logger,
    timings: FAST,
    ...overrides,
  })
  harnesses.push(h)
  return h
}

async function waitFor(condition: () => boolean, label: string, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms))
}

/** 模拟小程序写到 stderr、被监管器记进 debug 日志的行。 */
function stderrLines(h: Harness): string[] {
  return logged(h, 'debug', 'companion stderr: %s').map(args => String(args[0]))
}

function logged(h: Harness, level: keyof HostLogger, format: string): unknown[][] {
  return h.logs.filter(entry => entry.level === level && entry.args[0] === format).map(entry => entry.args.slice(1))
}

afterEach(async () => {
  const all = harnesses.splice(0)
  await Promise.all(all.map(h => h.supervisor.stop('test cleanup')))
  // 每个测试结束时不能留下任何模拟小程序进程。
  for (const h of all) {
    for (const pid of h.spawned) expect(pidAlive(pid), `pid ${pid} is still running`).toBe(false)
  }
  vi.clearAllMocks()
})

describe('CompanionSupervisor', () => {
  it('attaches the peer before the first frame, answers hello and reports running', async () => {
    const h = createHarness(['--mode=normal', '--notify-first', '--garbage'])
    const statusSeen: unknown[] = []
    h.supervisor = new CompanionSupervisor({
      prepareLaunch: async () => mockSpec(h.args),
      attach: (peer) => {
        h.attached.push(peer)
        peer.on('status', (status) => {
          statusSeen.push(status)
        })
      },
      helloResult: () => ({
        hostVersion: '0.1.0-test',
        config: CONFIG,
        mode: 'normal',
      }),
      onReady: (peer) => {
        h.ready.push(peer)
      },
      onStateChange: (state, error) => {
        h.states.push({ state, error })
      },
      onProcess: (event) => {
        if (event.type === 'spawned') h.spawned.push(event.pid)
        else h.exited.push(event.pid)
      },
      logger: { debug: (...args: unknown[]) => h.logs.push({ level: 'debug', args }), info: () => {}, warn: () => {}, error: () => {} },
      timings: FAST,
    })
    h.supervisor.start()
    await waitFor(() => h.supervisor.state() === 'running', 'running')
    expect(h.states.map(s => s.state)).toEqual(['waiting-runtime', 'starting', 'running'])
    expect(h.attached).toHaveLength(1)
    expect(h.ready).toEqual(h.attached)
    expect(h.supervisor.peer()).toBe(h.attached[0])
    expect(h.supervisor.error()).toBeUndefined()
    expect(h.supervisor.pid()).toBe(h.spawned[0])
    // 小程序在 hello 之前发的通知也被 attach 注册的监听收到了。
    await waitFor(() => statusSeen.length === 1, 'status notification')
    // 坏帧只计数、记日志，不断开连接。
    expect(logged(h, 'debug', 'companion sent a bad frame: %s').length).toBeGreaterThanOrEqual(2)
    // 心跳在跑，连接保持 running。
    await sleep(300)
    expect(h.supervisor.state()).toBe('running')
    await h.supervisor.stop('test')
    expect(h.supervisor.state()).toBe('stopped')
    expect(h.supervisor.peer()).toBeNull()
    expect(h.exited).toEqual(h.spawned)
  })

  it.each([2, 3])('rejects the previous protocol %s', async (protocol) => {
    const h = createHarness([`--protocol=${protocol}`])
    h.supervisor.start()
    await waitFor(() => h.supervisor.state() === 'failed', 'old protocol rejected')
    expect(h.supervisor.error()).toEqual({ code: 'promptx/companion/protocol-mismatch', detail: `host ${PROTOCOL_VERSION}, companion ${protocol}` })
    expect(h.ready).toHaveLength(0)
    await waitFor(() => h.exited.length === 1, 'old companion exit')
    expect(h.launches).toBe(1)
  })

  it('rejects a protocol mismatch with -32001 and fails without restarting', async () => {
    const h = createHarness(['--mode=wrong-protocol'])
    h.supervisor.start()
    await waitFor(() => h.supervisor.state() === 'failed', 'failed')
    expect(h.supervisor.error()).toEqual({ code: 'promptx/companion/protocol-mismatch', detail: `host ${PROTOCOL_VERSION}, companion 999` })
    expect(h.supervisor.restartsExhausted()).toBe(false)
    expect(h.ready).toHaveLength(0)
    // 小程序收到的错误码是 -32001，业务码是 protocol-mismatch。
    await waitFor(() => logged(h, 'debug', 'companion stderr: %s').some(args => args[0] === 'hello rejected: -32001 promptx/companion/protocol-mismatch'), 'stderr line')
    // 协议不匹配的进程被结束，不重启。
    await waitFor(() => h.exited.length === 1, 'process exit')
    await sleep(200)
    expect(h.launches).toBe(1)
    expect(h.spawned).toHaveLength(1)
    expect(h.supervisor.state()).toBe('failed')
  })

  it('restarts after handshake timeouts and stops after three failures inside the window', async () => {
    const h = createHarness(['--mode=no-handshake'], { timings: { ...FAST, handshakeMs: 150 } })
    h.supervisor.start()
    await waitFor(() => h.supervisor.state() === 'failed', 'failed')
    expect(h.supervisor.restartsExhausted()).toBe(true)
    expect(h.supervisor.error()).toEqual({ code: 'promptx/companion/handshake-timeout' })
    expect(h.spawned).toHaveLength(3)
    expect(h.states.filter(s => s.state === 'restarting')).toHaveLength(2)
    await waitFor(() => h.exited.length === 3, 'all exits')
    // 失败之后不再自动重启。
    await sleep(200)
    expect(h.spawned).toHaveLength(3)
  })

  it('kills and restarts a companion that stops answering heartbeats', async () => {
    const h = createHarness(['--mode=ignore-ping'])
    h.supervisor.start()
    await waitFor(() => h.states.some(s => s.state === 'restarting'), 'restarting')
    const lost = h.states.find(s => s.state === 'restarting')
    expect(lost?.error).toEqual({ code: 'promptx/companion/heartbeat-lost', detail: '3 heartbeats missed' })
    h.args = ['--mode=normal']
    await waitFor(() => h.spawned.length === 2 && h.supervisor.state() === 'running', 'second run')
    // 旧进程先确认结束，才启动新的。
    expect(pidAlive(h.spawned[0]!)).toBe(false)
    expect(h.exited[0]).toBe(h.spawned[0])
  })

  it('restarts after a crash, reporting the exit code, and runs again', async () => {
    const h = createHarness(['--mode=crash-after-ready'])
    h.supervisor.start()
    await waitFor(() => h.states.some(s => s.state === 'restarting'), 'restarting')
    h.args = ['--mode=normal']
    expect(h.states.find(s => s.state === 'restarting')?.error).toEqual({ code: 'promptx/companion/exited', detail: 'code 1' })
    await waitFor(() => h.supervisor.state() === 'running' && h.spawned.length === 2, 'running again')
    expect(h.ready).toHaveLength(2)
    expect(h.ready[1]).not.toBe(h.ready[0])
    expect(h.supervisor.peer()).toBe(h.ready[1])
    // 一次崩溃只触发一次重启（退出事件和管道关闭都到了）。
    await sleep(200)
    expect(h.spawned).toHaveLength(2)
    expect(h.supervisor.restartsExhausted()).toBe(false)
  })

  it('resets the failure budget on a manual restart', async () => {
    const h = createHarness(['--mode=exit-early'])
    h.supervisor.start()
    await waitFor(() => h.supervisor.state() === 'failed', 'failed')
    expect(h.supervisor.restartsExhausted()).toBe(true)
    // exit-early 以 3 退出，正是小程序界面反复崩溃时用的退出码，配置页据此显示「小窗界面反复崩溃」（审查 CR-03）。
    expect(h.supervisor.error()).toEqual({ code: 'promptx/companion/renderer-gone', detail: 'code 3' })
    h.args = ['--mode=normal']
    await h.supervisor.restart()
    await waitFor(() => h.supervisor.state() === 'running', 'running after restart')
    expect(h.supervisor.restartsExhausted()).toBe(false)
    expect(h.supervisor.error()).toBeUndefined()
  })

  it('stops with a shutdown request and lets the companion exit by itself', async () => {
    const h = createHarness(['--mode=normal'])
    h.supervisor.start()
    await waitFor(() => h.supervisor.state() === 'running', 'running')
    const started = Date.now()
    await h.supervisor.stop('plugin disposed')
    // 小程序回复 shutdown 后自己退出，不需要信号。
    expect(Date.now() - started).toBeLessThan(FAST.exitWaitMs!)
    expect(h.exited).toEqual(h.spawned)
    expect(logged(h, 'debug', 'companion did not answer shutdown: %s')).toHaveLength(0)
    expect(h.states.at(-1)).toEqual({ state: 'stopped', error: undefined })
  })

  it('escalates to SIGKILL when the companion ignores shutdown and SIGTERM', async () => {
    const h = createHarness(['--mode=ignore-sigterm'])
    h.supervisor.start()
    await waitFor(() => h.supervisor.state() === 'running', 'running')
    const started = Date.now()
    await h.supervisor.stop('plugin disposed')
    const elapsed = Date.now() - started
    const budget = FAST.shutdownGraceMs! + FAST.exitWaitMs! + 2 * FAST.killWaitMs!
    expect(elapsed).toBeLessThan(budget + 500)
    expect(elapsed).toBeGreaterThanOrEqual(FAST.shutdownGraceMs! - 50)
    expect(logged(h, 'debug', 'companion did not answer shutdown: %s')).toHaveLength(1)
    expect(pidAlive(h.spawned[0]!)).toBe(false)
    expect(h.supervisor.state()).toBe('stopped')
  })

  it('keeps serving the companion while it writes the draft back during shutdown', async () => {
    const h = createHarness(['--mode=draft-on-shutdown'])
    const seen: string[] = []
    h.supervisor = new CompanionSupervisor({
      prepareLaunch: async () => mockSpec(h.args),
      attach: (peer) => {
        peer.on('status', () => {
          seen.push('status')
        })
        peer.handle('draft.save', ({ text }) => {
          seen.push(`draft.save:${text.length}`)
          return { updatedAt: '2026-11-08T00:00:00Z' }
        })
      },
      helloResult: () => ({
        hostVersion: '0.1.0-test',
        config: CONFIG,
        mode: 'normal',
      }),
      onProcess: (event) => {
        if (event.type === 'spawned') h.spawned.push(event.pid)
        else h.exited.push(event.pid)
      },
      timings: FAST,
    })
    h.supervisor.start()
    await waitFor(() => h.supervisor.state() === 'running', 'running')
    await h.supervisor.stop('plugin disposed')
    expect(seen).toEqual(['status', `draft.save:${'draft written on shutdown'.length}`])
    expect(h.exited).toEqual(h.spawned)
  })

  // Windows 保留标准输出的系统句柄，夹具的 end() 无法让父端收到 EOF。
  it.skipIf(process.platform === 'win32')('kills a companion whose stdout ended while it is still alive, then restarts it', async () => {
    // 这个用例检查 EOF 的处理，慢速 CI 上不让心跳超时先决定重启原因。
    const h = createHarness(['--mode=close-stdout'], { timings: { ...FAST, heartbeatMs: 60_000 } })
    h.supervisor.start()
    await waitFor(() => h.states.some(s => s.state === 'restarting'), 'restarting')
    h.args = ['--mode=normal']
    expect(h.states.find(s => s.state === 'restarting')?.error?.code).toBe('promptx/channel/closed')
    await waitFor(() => h.supervisor.state() === 'running' && h.spawned.length === 2, 'second run')
    // 管道关了但进程还活着：被杀掉之后才启动新的。
    expect(pidAlive(h.spawned[0]!)).toBe(false)
    expect(h.exited[0]).toBe(h.spawned[0])
  })

  it('kills a live companion after its stdout transport closes, then restarts it', async () => {
    const h = createHarness(['--mode=normal'], { timings: { ...FAST, heartbeatMs: 60_000 } })
    h.supervisor.start()
    await waitFor(() => h.supervisor.state() === 'running', 'running')
    const child = vi.mocked(spawn).mock.results.at(-1)!.value as ChildProcessWithoutNullStreams
    expect(child.pid).toBe(h.spawned[0])
    expect(pidAlive(child.pid!)).toBe(true)
    // 所有平台都从父端关闭真实的读取流，覆盖 close 事件和「先结束旧进程再重启」的恢复链。
    child.stdout.destroy()
    await waitFor(() => h.states.some(s => s.state === 'restarting'), 'restarting')
    expect(h.states.find(s => s.state === 'restarting')?.error?.code).toBe('promptx/channel/closed')
    await waitFor(() => h.supervisor.state() === 'running' && h.spawned.length === 2, 'second run')
    expect(pidAlive(h.spawned[0]!)).toBe(false)
    expect(h.exited[0]).toBe(h.spawned[0])
  })

  it('treats a write buffer above 8 MiB as a channel failure', async () => {
    // 心跳放慢：小程序不读 stdin 也就不回 ping，不能让心跳先判定失败。
    const h = createHarness(['--mode=stop-reading'], { timings: { ...FAST, heartbeatMs: 60_000 } })
    h.supervisor.start()
    await waitFor(() => h.supervisor.state() === 'running', 'running')
    await sleep(100) // 等小程序停止读 stdin
    const peer = h.supervisor.peer()!
    h.args = ['--mode=normal']
    const big = 'x'.repeat(1024 * 1024)
    const config: CompanionConfig = { ...CONFIG, libraryDir: big }
    for (let i = 0; i < Math.ceil(MAX_PENDING_WRITE_BYTES / big.length) + 4; i++) peer.notify('config', config)
    await waitFor(() => h.states.some(s => s.state === 'restarting'), 'restarting')
    expect(h.states.find(s => s.state === 'restarting')?.error).toEqual({ code: 'promptx/channel/closed', detail: 'write buffer full' })
    await waitFor(() => h.supervisor.state() === 'running' && h.spawned.length === 2, 'second run')
    expect(pidAlive(h.spawned[0]!)).toBe(false)
  })

  it('survives a missing executable without an uncaught exception', async () => {
    const h = createHarness([])
    h.supervisor = new CompanionSupervisor({
      prepareLaunch: async () => {
        h.launches += 1
        return { executable: '/nonexistent/promptx/Electron', args: ['app'], env: {} }
      },
      attach: () => {},
      helloResult: () => ({
        hostVersion: '0.1.0-test',
        config: CONFIG,
        mode: 'normal',
      }),
      onStateChange: (state, error) => {
        h.states.push({ state, error })
      },
      onProcess: (event) => {
        if (event.type === 'spawned') h.spawned.push(event.pid)
      },
      timings: FAST,
    })
    h.supervisor.start()
    await waitFor(() => h.supervisor.state() === 'failed', 'failed')
    expect(h.supervisor.error()?.code).toBe('promptx/companion/spawn-failed')
    expect(h.supervisor.restartsExhausted()).toBe(true)
    expect(h.launches).toBe(3)
    expect(h.spawned).toHaveLength(0)
  })

  it.runIf(process.platform !== 'win32')('survives an Electron that is not executable (EACCES)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'promptx-supervisor-'))
    try {
      const executable = join(dir, 'Electron')
      await writeFile(executable, '#!/bin/sh\nexit 0\n', { mode: 0o644 })
      const h = createHarness([], {
        prepareLaunch: async () => {
          h.launches += 1
          return { executable, args: ['app'], env: {} }
        },
      })
      h.supervisor.start()
      await waitFor(() => h.supervisor.state() === 'failed', 'failed')
      expect(h.supervisor.error()?.code).toBe('promptx/companion/spawn-failed')
      expect(h.supervisor.error()?.detail).toContain('EACCES')
      expect(h.spawned).toHaveLength(0)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('logs only the first 200 stderr lines', async () => {
    const h = createHarness(['--mode=normal', '--stderr-lines=300'])
    h.supervisor.start()
    await waitFor(() => h.supervisor.state() === 'running', 'running')
    await waitFor(() => logged(h, 'debug', 'companion stderr reached %d lines; dropping the rest').length === 1, 'stderr limit')
    await sleep(100)
    const lines = logged(h, 'debug', 'companion stderr: %s')
    expect(lines).toHaveLength(STDERR_LINE_LIMIT)
    expect(lines[0]).toEqual(['mock stderr line 1'])
    expect(lines.at(-1)).toEqual([`mock stderr line ${STDERR_LINE_LIMIT}`])
  })

  it('fails without retrying when the runtime cannot be prepared', async () => {
    const h = createHarness([], {
      prepareLaunch: async () => {
        h.launches += 1
        throw new PromptxError('promptx/runtime/download-failed', 'HTTP 404')
      },
    })
    h.supervisor.start()
    await waitFor(() => h.supervisor.state() === 'failed', 'failed')
    expect(h.supervisor.error()).toEqual({ code: 'promptx/runtime/download-failed', detail: 'HTTP 404' })
    expect(h.supervisor.restartsExhausted()).toBe(false)
    await sleep(200)
    expect(h.launches).toBe(1)
    expect(h.spawned).toHaveLength(0)
  })

  it('aborts a launch that is still waiting for the runtime when stopped', async () => {
    let signal: AbortSignal | undefined
    let release: (() => void) | undefined
    const h = createHarness([], {
      prepareLaunch: (s) => {
        signal = s
        return new Promise<LaunchSpec>((resolve) => {
          // 故意不理会中止信号：stop() 之后才拿到的启动命令也必须被丢弃。
          release = () => {
            resolve(mockSpec(['--mode=normal']))
          }
        })
      },
    })
    h.supervisor.start()
    await waitFor(() => signal !== undefined, 'prepareLaunch called')
    expect(h.supervisor.state()).toBe('waiting-runtime')
    await h.supervisor.stop('plugin disposed')
    expect(signal?.aborted).toBe(true)
    expect(h.supervisor.state()).toBe('stopped')
    release?.()
    await sleep(200)
    expect(h.spawned).toHaveLength(0)
    expect(h.supervisor.state()).toBe('stopped')
  })

  it('ignores start() while running and starts again after a pending stop', async () => {
    const h = createHarness(['--mode=normal'])
    h.supervisor.start()
    h.supervisor.start()
    await waitFor(() => h.supervisor.state() === 'running', 'running')
    h.supervisor.start()
    await sleep(100)
    expect(h.spawned).toHaveLength(1)
    const stopping = h.supervisor.stop('restart from the settings page')
    h.supervisor.start()
    await stopping
    await waitFor(() => h.supervisor.state() === 'running' && h.spawned.length === 2, 'started after stop')
    expect(pidAlive(h.spawned[0]!)).toBe(false)
  })

  it('cancels a pending automatic restart when stopped during the backoff', async () => {
    const h = createHarness(['--mode=crash-after-ready'], { timings: { ...FAST, backoffMs: [5_000] } })
    h.supervisor.start()
    await waitFor(() => h.supervisor.state() === 'restarting', 'restarting')
    await waitFor(() => h.exited.length === 1, 'first exit')
    await h.supervisor.stop('plugin disposed')
    expect(h.supervisor.state()).toBe('stopped')
    await sleep(200)
    expect(h.spawned).toHaveLength(1)
  })

  it('replies to hello itself with the protocol version and the Host configuration', async () => {
    const h = createHarness(['--mode=normal'])
    h.supervisor.start()
    await waitFor(() => h.supervisor.state() === 'running', 'running')
    // 模拟小程序把收到的 hello 回复写到 stderr：协议版本由监管器补上，其余来自 helloResult()。
    await waitFor(() => stderrLines(h).includes(`hello ok: protocol=${PROTOCOL_VERSION} mode=normal host=0.1.0-test`), 'hello reply echo')
    // hello 不经过 attach 注册的处理函数。
    expect(h.attached[0]!.handledMethods()).toEqual([])
  })

  it('fails requests that attach sends before the process exists instead of throwing', async () => {
    const early: Array<Promise<unknown>> = []
    const h = createHarness(['--mode=normal'], {
      attach: (peer) => {
        h.attached.push(peer)
        peer.notify('config', CONFIG)
        early.push(peer.request('ping', {}).catch((error: unknown) => error))
      },
    })
    h.supervisor.start()
    await waitFor(() => h.supervisor.state() === 'running', 'running')
    const [outcome] = await Promise.all(early)
    expect(outcome).toMatchObject({ info: { code: 'promptx/channel/closed' } })
    // 这次失败不影响之后的连接。
    await expect(h.supervisor.peer()!.request('ping', {})).resolves.toEqual({})
  })

  it('restarts a companion that was killed from outside, reporting how it ended', async () => {
    const h = createHarness(['--mode=normal'])
    h.supervisor.start()
    await waitFor(() => h.supervisor.state() === 'running', 'running')
    const pid = h.supervisor.pid()!
    expect(pid).toBe(h.spawned[0])
    // 手工验收里的 pkill -f -- '--promptx-companion='（F-06）。
    process.kill(pid, 'SIGKILL')
    await waitFor(() => h.states.some(s => s.state === 'restarting'), 'restarting')
    const lost = h.states.find(s => s.state === 'restarting')!
    expect(lost.error?.code).toBe('promptx/companion/exited')
    // Windows 上没有信号，结束进程后只有退出码。
    expect(lost.error?.detail).toMatch(process.platform === 'win32' ? /^code \d+$/ : /^signal SIGKILL$/)
    await waitFor(() => h.supervisor.state() === 'running' && h.spawned.length === 2, 'running again')
    expect(h.exited).toEqual([pid])
    expect(h.supervisor.pid()).toBe(h.spawned[1])
  })

  it('keeps one heartbeat in flight and accepts slow answers inside the timeout', async () => {
    const h = createHarness(['--mode=normal', '--ping-delay=150'], { timings: { ...FAST, heartbeatMs: 40, heartbeatTimeoutMs: 600 } })
    h.supervisor.start()
    await waitFor(() => h.supervisor.state() === 'running', 'running')
    await waitFor(() => stderrLines(h).filter(line => line === 'ping received').length >= 4, 'several heartbeats')
    // 每 40 ms 一次心跳，但上一个 ping 还没回时不发新的；回得慢（150 ms）不算丢失。
    expect(stderrLines(h)).not.toContain('ping overlap')
    expect(h.states.map(s => s.state)).toEqual(['waiting-runtime', 'starting', 'running'])
  })

  it('finishes the whole stop chain within four seconds with the default timings', async () => {
    // 默认时序：shutdown 等 2 秒 → 等退出 1 秒 → SIGTERM → 0.5 秒 → SIGKILL，在 dsh 退出给的 5 秒以内。
    const h = createHarness(['--mode=ignore-sigterm'], { timings: {} })
    h.supervisor.start()
    await waitFor(() => h.supervisor.state() === 'running', 'running')
    const started = Date.now()
    await h.supervisor.stop('dsh is exiting')
    const elapsed = Date.now() - started
    // shutdown 没有回复、等退出也没等到，才会走到信号；Windows 上 SIGTERM 就是 TerminateProcess，不会再等 SIGKILL。
    expect(elapsed).toBeGreaterThanOrEqual(2_900)
    expect(elapsed).toBeLessThan(4_000)
    expect(pidAlive(h.spawned[0]!)).toBe(false)
    expect(h.exited).toEqual(h.spawned)
  })

  it('does not count a stop as a failure and can start again afterwards', async () => {
    const h = createHarness(['--mode=normal'])
    h.supervisor.start()
    await waitFor(() => h.supervisor.state() === 'running', 'running')
    await h.supervisor.stop('plugin disabled')
    expect(h.states.some(s => s.state === 'restarting' || s.state === 'failed')).toBe(false)
    h.supervisor.start()
    await waitFor(() => h.supervisor.state() === 'running' && h.spawned.length === 2, 'started again')
    expect(h.supervisor.restartsExhausted()).toBe(false)
  })

  // 审查 H2：配置页的「重启」和插件卸载撞在一起时，重启不能在卸载之后又拉起一个进程。
  it('does not relaunch after close() when a restart was waiting for the same stop', async () => {
    const h = createHarness(['--mode=normal'])
    h.supervisor.start()
    await waitFor(() => h.supervisor.state() === 'running', 'running')
    const restarting = h.supervisor.restart()
    const closing = h.supervisor.close('host-closing')
    await Promise.all([restarting, closing])
    await sleep(300)
    expect(h.launches).toBe(1)
    expect(h.supervisor.state()).toBe('stopped')
    expect(h.spawned.every(pid => !pidAlive(pid))).toBe(true)
    h.supervisor.start()
    await h.supervisor.restart()
    await sleep(200)
    expect(h.launches).toBe(1)
  })

  it('lets a later stop() win over a restart that is still stopping', async () => {
    const h = createHarness(['--mode=normal'])
    h.supervisor.start()
    await waitFor(() => h.supervisor.state() === 'running', 'running')
    const restarting = h.supervisor.restart()
    const stopping = h.supervisor.stop('runtime-delete')
    await Promise.all([restarting, stopping])
    await sleep(300)
    expect(h.launches).toBe(1)
    expect(h.supervisor.state()).toBe('stopped')
    // 不是 close：之后照常可以再启动。
    h.supervisor.start()
    await waitFor(() => h.supervisor.state() === 'running' && h.launches === 2, 'started again')
  })

  it('still restarts when nothing else asked to stop', async () => {
    const h = createHarness(['--mode=normal'])
    h.supervisor.start()
    await waitFor(() => h.supervisor.state() === 'running', 'running')
    await h.supervisor.restart()
    await waitFor(() => h.supervisor.state() === 'running' && h.launches === 2, 'running after restart')
  })
})
