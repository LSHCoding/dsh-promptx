// tests/host/*.spec.ts 共用的 Host 测试台：真实的 cordis Context + dsh 存储栈加载 src/index.ts，
// 运行时目录里放一个假的「Electron」——一段 shell 脚本，用 Node 跑 tests/fixtures/host-companion.mjs。
// 假的可执行文件是 shell 脚本，Windows 上跑不了，用到它的用例在 Windows 上跳过。

import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as PromptX from '../../src/index.ts'
import { executableSegments } from '../../src/companion/runtime.ts'
import { ELECTRON_VERSION } from '../../src/companion/electron-release.ts'
import { PROTOCOL_VERSION } from '../../src/shared/protocol.ts'
import type { ErrorInfo, PanelStatus } from '../../src/shared/types.ts'

const MOCK = fileURLToPath(new URL('../fixtures/host-companion.mjs', import.meta.url))

export interface Script {
  protocol: number
  typed: string | null
  flush: string | null
  locale: 'zh' | 'en'
  rendererError: ErrorInfo | null
  saveText: string | null
  /** 不为 null 时按顺序走一遍库、回收站、优化的各个请求，用它作为内容（tests/host/no-content-logs.spec.ts）。 */
  sweep: string | null
}

export interface Route {
  path: string
  fetch: (request: Request) => Promise<Response>
}

export interface Fiber {
  dispose(): Promise<unknown>
}

export interface Harness {
  home: string
  ctx: Context
  routes: Map<string, Route>
  start(config?: Record<string, unknown>): Fiber
  status(): Promise<PanelStatus>
  post(path: string, body: unknown): Promise<{ status: number; body: { ok: boolean; error?: ErrorInfo } }>
  events(): Promise<string[]>
  starts(): Promise<number[]>
}

const homes: string[] = []
const contexts: Context[] = []
const pids = new Set<number>()

/** 在 afterEach 里调用：卸载所有 Context、结束模拟小程序、删掉临时目录。 */
export async function cleanupHarnesses(): Promise<void> {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // 已经退出。
    }
  }
  pids.clear()
  await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true })))
}

/** 另建一个随测试清理的临时目录（例如 dsh 数据目录之外的库目录）。 */
export async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  homes.push(dir)
  return dir
}

/** extra 用来在加载 PromptX 之前往 Context 里放别的服务（例如模拟的 llm）。 */
export async function setup(script: Partial<Script> = {}, extra?: (ctx: Context) => void): Promise<Harness> {
  const home = await mkdtemp(join(tmpdir(), 'promptx-host-'))
  homes.push(home)
  const dataDir = join(home, 'promptx')
  // 已经装好的运行时：版本目录 + .ready + 可执行文件（转给模拟小程序的 shell 脚本）。
  const installDir = join(dataDir, 'runtime', `${ELECTRON_VERSION}-${process.platform}-${process.arch}`)
  const segments = executableSegments(process.platform)
  const executable = join(installDir, ...segments)
  await mkdir(join(installDir, ...segments.slice(0, -1)), { recursive: true })
  await writeFile(join(installDir, '.ready'), '{}')
  await writeFile(executable, `#!/bin/sh\nexec "${process.execPath}" "${MOCK}" "$@"\n`)
  await chmod(executable, 0o755)
  const full: Script = {
    protocol: PROTOCOL_VERSION,
    typed: 'typed after load',
    flush: 'flushed on shutdown',
    locale: 'en',
    rendererError: null,
    saveText: null,
    sweep: null,
    ...script,
  }
  await writeFile(join(dataDir, 'mock-script.json'), JSON.stringify(full))

  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root: join(home, 'storages') })
  await ctx.plugin(StorageDomain, { backend: 'json' })
  ctx.provide('dshHomePath', (...parts: string[]) => join(home, ...parts))
  ctx.provide('profileContext', { name: 'host-test' })
  const routes = new Map<string, Route>()
  ctx.provide('connection', {
    fetch: {
      register(route: Route) {
        routes.set(route.path, route)
        return () => {
          if (routes.get(route.path) === route) routes.delete(route.path)
          return Promise.resolve()
        }
      },
    },
    authenticatedUrl: (url: string) => url,
  })
  extra?.(ctx)

  const call = async (path: string, init?: RequestInit): Promise<Response> => {
    const route = routes.get(path)
    if (route === undefined) throw new Error(`no route ${path}`)
    return route.fetch(new Request(`http://dsh.test${path}`, init))
  }
  const events = async (): Promise<string[]> => {
    try {
      const lines = (await readFile(join(dataDir, 'mock-events.txt'), 'utf8')).trim().split('\n').filter(line => line !== '')
      for (const line of lines) pids.add(Number(line.split(' ')[0]))
      return lines
    } catch {
      return []
    }
  }
  return {
    home,
    ctx,
    routes,
    start: config => (ctx.plugin as unknown as (plugin: unknown, config: unknown) => Fiber)(PromptX, config ?? {}),
    status: async () => (await (await call('/api/dsh-promptx/status')).json()) as PanelStatus,
    post: async (path, body) => {
      const response = await call(path, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })
      return { status: response.status, body: (await response.json()) as { ok: boolean; error?: ErrorInfo } }
    },
    events,
    starts: async () => (await events()).filter(line => line.endsWith(' start')).map(line => Number(line.split(' ')[0])),
  }
}

/** 条件里的异常（例如路由还没注册）按「还没满足」处理。 */
export async function waitFor(condition: () => Promise<boolean>, label: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const ok = await condition().catch(() => false)
    if (ok) return
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`)
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}

export async function sleep(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms))
}

export async function storedDraft(home: string): Promise<string | null> {
  const dir = join(home, 'storages')
  const name = (await readdir(dir)).find(file => file.startsWith('promptx_draft_'))
  if (name === undefined) return null
  const unit = JSON.parse(await readFile(join(dir, name), 'utf8')) as { tables?: { draft?: { current?: { text?: string } } } }
  return unit.tables?.draft?.current?.text ?? null
}

export async function leases(home: string): Promise<string[]> {
  try {
    return await readdir(join(home, 'promptx', 'runtime', 'leases'))
  } catch {
    return []
  }
}
