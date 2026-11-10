// 冒烟测试（testing-plan 第 4 节，三平台 CI 必须通过）：用构建好的 lib/app 和真实的 Electron 运行时，
// 测试代码扮演 Host：下载并校验运行时 → 启动小程序 → 握手 → 窗口、界面、编辑器、草稿读取都就绪 →
// 系统关闭窗口只隐藏 → 正常停止；再启动一次，直接关闭 stdin，小程序要自己退出。
// 运行：pnpm smoke（先构建）。运行时缓存在 PROMPTX_SMOKE_RUNTIME_DIR（默认 <仓库>/.smoke-runtime）。

import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildLaunchSpec } from '../../src/companion/launch.ts'
import { RuntimeManager } from '../../src/companion/runtime.ts'
import { CompanionSupervisor } from '../../src/companion/supervisor.ts'
import type { LaunchSpec, RuntimeInstall } from '../../src/services.ts'
import type { SmokeReport } from '../../src/shared/protocol.ts'
import type { CompanionStatus, RuntimeSource } from '../../src/shared/types.ts'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const runtimeRoot = process.env.PROMPTX_SMOKE_RUNTIME_DIR ?? join(repoRoot, '.smoke-runtime')
const source = (process.env.PROMPTX_SMOKE_RUNTIME_SOURCE ?? 'auto') as RuntimeSource
const profile = { name: 'smoke', hash: '5a0b3e5a0b3e5a0b' }
const appDir = join(repoRoot, 'lib', 'app')

let install: RuntimeInstall
const dataDirs: string[] = []

function tempDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'promptx-smoke-'))
  dataDirs.push(dir)
  return dir
}

async function launchSpec(dataDir: string): Promise<LaunchSpec> {
  return buildLaunchSpec({
    executable: install.executable,
    appDir,
    profile,
    dataDir,
    parentPid: process.pid,
    // 故意带上会被项目 .env 设置的变量，检查 Host 不把它们传给小程序（审查 S10）。
    env: { ...process.env, PROMPTX_E2E: '1', PROMPTX_DATA_DIR: '/should/not/pass' },
    platform: process.platform,
  })
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      setTimeout(() => {
        reject(new Error(`${what} 超过 ${ms} ms`))
      }, ms).unref()
    }),
  ])
}

function alive(pid: number | undefined): boolean {
  if (pid === undefined) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

beforeAll(async () => {
  const runtime = new RuntimeManager({ root: runtimeRoot, getSource: () => source, profile })
  try {
    install = await runtime.ensure()
  } finally {
    runtime.dispose()
  }
}, 20 * 60_000)

afterAll(() => {
  for (const dir of dataDirs) rmSync(dir, { recursive: true, force: true })
})

describe('companion smoke', () => {
  it('starts, handshakes, renders, hides on close and stops cleanly', async () => {
    const dataDir = tempDataDir()
    const spec = await launchSpec(dataDir)
    expect(spec.env.PROMPTX_E2E).toBeUndefined()
    expect(spec.env.PROMPTX_DATA_DIR).toBe(dataDir)
    expect(spec.env.ELECTRON_RUN_AS_NODE).toBeUndefined()
    expect(spec.args.some(arg => arg.startsWith('--promptx-companion='))).toBe(true)

    const report = deferred<SmokeReport>()
    const statuses: CompanionStatus[] = []
    let pid: number | undefined
    const supervisor = new CompanionSupervisor({
      prepareLaunch: () => Promise.resolve(spec),
      attach: (peer) => {
        peer.handle('draft.load', () => ({ record: null }))
        peer.handle('draft.save', () => ({ updatedAt: new Date().toISOString() }))
        peer.handle('entryDraft.load', () => ({ record: null }))
        peer.handle('entryDraft.save', () => ({ updatedAt: new Date().toISOString() }))
        peer.handle('optimize.state', () => ({ session: null }))
        peer.handle('library.list', () => ({ state: 'missing', root: dataDir, folders: [], tags: [], entries: [], total: 0 }))
        peer.on('status', (status) => {
          statuses.push(status)
        })
        peer.on('smoke.report', (r) => {
          report.resolve(r)
        })
      },
      helloResult: () => ({
        hostVersion: '0.0.0-smoke',
        mode: 'smoke',
        config: {
          // 冒烟测试用一个不会和测试机上的组合冲突的快捷键。
          globalShortcut: 'Control+Alt+Shift+F8',
          hideOnBlur: false,
          confirmDelete: true,
          convertMiddleDot: true,
          convertYen: true,
          locale: 'en',
          theme: 'system',
          libraryDir: join(dataDir, 'library'),
          profile: profile.name,
        },
      }),
      onProcess: (event) => {
        if (event.type === 'spawned') pid = event.pid
      },
      timings: { handshakeMs: 120_000 },
    })
    supervisor.start()
    const result = await within(report.promise, 180_000, 'smoke report')
    console.log(`smoke report on ${process.platform}-${process.arch}: ${JSON.stringify(result)}`)
    expect(result.windowCreated).toBe(true)
    expect(result.rendererReady).toBe(true)
    expect(result.editorMounted).toBe(true)
    expect(result.draftLoaded).toBe(true)
    expect(result.windowShown).toBe(true)
    expect(result.closeHides).toBe(true)
    expect(supervisor.state()).toBe('running')
    expect(statuses.length).toBeGreaterThan(0)

    const started = Date.now()
    await supervisor.stop('smoke-done')
    expect(Date.now() - started).toBeLessThan(4_000)
    await new Promise(r => setTimeout(r, 500))
    expect(alive(pid)).toBe(false)
  }, 5 * 60_000)

  it('exits on its own when stdin closes', async () => {
    const dataDir = tempDataDir()
    const spec = await launchSpec(dataDir)
    const child = spawn(spec.executable, spec.args, { env: spec.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    child.once('error', () => {})
    child.stdin.on('error', () => {})
    child.stderr.resume()
    // 等小程序发出 hello，确认它已经起来，再关掉 stdin。
    await within(new Promise<void>((resolve) => {
      let buffer = ''
      child.stdout.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf8')
        if (buffer.includes('"method":"hello"')) resolve()
      })
    }), 120_000, 'hello from companion')
    const exited = new Promise<number | null>((resolve) => {
      child.once('exit', (code) => {
        resolve(code)
      })
    })
    child.stdin.end()
    const code = await within(exited, 10_000, 'exit after stdin closed').catch((error: unknown) => {
      child.kill('SIGKILL')
      throw error
    })
    expect(code).not.toBeNull()
  }, 5 * 60_000)
})
