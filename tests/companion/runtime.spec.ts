import { spawn, type ChildProcess } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { access, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { pidAlive } from '../../src/companion/process-utils.ts'
import { defaultExtractor, executableSegments, RuntimeManager, runTool, type RuntimeManagerTestOptions } from '../../src/companion/runtime.ts'
import { ELECTRON_VERSION } from '../../src/companion/electron-release.ts'
import type { HostLogger, RuntimeManagerOptions } from '../../src/services.ts'
import { PromptxError } from '../../src/shared/errors.ts'
import type { RuntimeStatus } from '../../src/shared/types.ts'
import { failOnProcessProblems } from './process-traps.ts'

type Source = 'mirror' | 'official'

const VERSION = '1.2.3'
const FILE = `electron-v${VERSION}-linux-x64.zip`
const PAYLOAD = randomBytes(256 * 1024 + 123)
const SHA256 = sha256(PAYLOAD)
const RELEASE = { version: VERSION, file: FILE, sha256: SHA256, size: PAYLOAD.length }
const INSTALL = `${VERSION}-linux-x64`

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

async function sleep(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms))
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function waitFor(condition: () => boolean | Promise<boolean>, label: string, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`)
    await sleep(10)
  }
}

// ───────────────────────────── 本地 HTTP 服务器 ─────────────────────────────

interface Hit {
  source: Source
  range: string | null
}

type Behavior = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
type SyncBehavior = (req: IncomingMessage, res: ServerResponse) => void

interface TestServer {
  baseUrls: { mirror: string; official: string }
  hits: Hit[]
  behaviors: Partial<Record<Source, Behavior>>
  close(): Promise<void>
}

const servers: TestServer[] = []

async function startServer(behaviors: Partial<Record<Source, Behavior>>): Promise<TestServer> {
  const hits: Hit[] = []
  const state: TestServer = { baseUrls: { mirror: '', official: '' }, hits, behaviors, close: async () => {} }
  const server = createServer((req, res) => {
    const match = /^\/(mirror|official)\/v1\.2\.3\/(.+)$/.exec(req.url ?? '')
    if (match === null || match[2] !== FILE) {
      res.statusCode = 404
      res.end()
      return
    }
    const source = match[1] as Source
    hits.push({ source, range: req.headers.range ?? null })
    const behavior = state.behaviors[source] ?? notFound
    Promise.resolve(behavior(req, res)).catch(() => {
      res.destroy()
    })
  })
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve)
  })
  const { port } = server.address() as AddressInfo
  state.baseUrls = { mirror: `http://127.0.0.1:${port}/mirror`, official: `http://127.0.0.1:${port}/official` }
  state.close = async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve()
      })
    })
  }
  servers.push(state)
  return state
}

const notFound: Behavior = (_req, res) => {
  res.statusCode = 404
  res.end('not found')
}

/** 正常的下载源：按 Range 回 206，越界回 416。 */
function serve(payload: Uint8Array = PAYLOAD, options: { honorRange?: boolean } = {}): SyncBehavior {
  return (req, res) => {
    const range = /^bytes=(\d+)-$/.exec(req.headers.range ?? '')
    if (range !== null && options.honorRange !== false) {
      const start = Number(range[1])
      if (start >= payload.length) {
        res.writeHead(416, { 'content-range': `bytes */${payload.length}` })
        res.end()
        return
      }
      res.writeHead(206, { 'content-range': `bytes ${start}-${payload.length - 1}/${payload.length}`, 'content-length': String(payload.length - start) })
      res.end(payload.subarray(start))
      return
    }
    res.writeHead(200, { 'content-length': String(payload.length) })
    res.end(payload)
  }
}

/** 慢速下载源：分块发送，块与块之间停一会儿。 */
function serveSlowly(chunks: number, gapMs: number): Behavior {
  return async (_req, res) => {
    res.writeHead(200, { 'content-length': String(PAYLOAD.length) })
    const size = Math.ceil(PAYLOAD.length / chunks)
    for (let offset = 0; offset < PAYLOAD.length; offset += size) {
      if (res.destroyed) return
      res.write(PAYLOAD.subarray(offset, offset + size))
      await sleep(gapMs)
    }
    res.end()
  }
}

/** 先发一部分，然后再也不发（卡住）。 */
const stall: Behavior = (_req, res) => {
  res.writeHead(200, { 'content-length': String(PAYLOAD.length) })
  res.write(PAYLOAD.subarray(0, 1000))
}

/** 连响应头都不发。 */
const hang: Behavior = () => {}

function corrupt(): Uint8Array {
  const copy = Buffer.from(PAYLOAD)
  copy[copy.length - 1] = (copy[copy.length - 1]! + 1) % 256
  return copy
}

// ───────────────────────────── 运行时管理器 ─────────────────────────────

const roots: string[] = []
const managers: RuntimeManager[] = []
const sleepers: ChildProcess[] = []

async function newRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'promptx-runtime-'))
  roots.push(root)
  return root
}

interface Logged {
  logger: HostLogger
  lines: string[]
}

function captureLogs(): Logged {
  const lines: string[] = []
  const push = (level: string) => (format: unknown, ...args: unknown[]) => {
    lines.push(`${level} ${String(format)} ${args.map(String).join(' ')}`)
  }
  return { lines, logger: { debug: push('debug'), info: push('info'), warn: push('warn'), error: push('error') } }
}

/** 假的解压：核对压缩包内容，然后在目标目录里放一个可执行文件。 */
async function fakeExtract(zip: string, dest: string): Promise<void> {
  const bytes = await readFile(zip)
  if (sha256(bytes) !== SHA256) throw new Error('not the expected archive')
  await writeFile(join(dest, 'electron'), '#!/bin/sh\n', { mode: 0o755 })
}

type ManagerOptions = Partial<RuntimeManagerOptions & RuntimeManagerTestOptions>

function createManager(root: string, server: TestServer | null, overrides: ManagerOptions = {}): RuntimeManager {
  const manager = new RuntimeManager({
    root,
    getSource: () => 'auto',
    profile: { name: 'Test profile', hash: 'aaaa1111' },
    platform: 'linux',
    arch: 'x64',
    baseUrls: server?.baseUrls ?? { mirror: 'http://127.0.0.1:9/mirror', official: 'http://127.0.0.1:9/official' },
    release: RELEASE,
    extract: fakeExtract,
    timeouts: { connectMs: 1_500, stallMs: 400 },
    requiredFreeBytes: 1,
    lockTimings: { pollMs: 40 },
    ...overrides,
  })
  managers.push(manager)
  return manager
}

function record(manager: RuntimeManager): RuntimeStatus[] {
  const seen: RuntimeStatus[] = []
  manager.onChange((status) => {
    seen.push(status)
  })
  return seen
}

/** 一个一直活着的进程（模拟另一个 dsh），测试结束时结束它。 */
function liveProcess(): number {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  child.on('error', () => {})
  sleepers.push(child)
  return child.pid!
}

/** 一个已经退出的进程的 pid。 */
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' })
  child.on('error', () => {})
  const pid = child.pid!
  await new Promise<void>((resolve) => {
    child.on('exit', () => {
      resolve()
    })
  })
  await waitFor(() => !pidAlive(pid), 'dead pid')
  return pid
}

/** 模拟一个已经装好的版本目录。 */
async function fakeInstall(root: string, name: string): Promise<void> {
  await mkdir(join(root, name), { recursive: true })
  await writeFile(join(root, name, 'electron'), '#!/bin/sh\n', { mode: 0o755 })
  await writeFile(join(root, name, '.ready'), '{}\n')
}

async function writeLease(root: string, hash: string, lease: { version: string; pid: number; profile: string }): Promise<void> {
  await mkdir(join(root, 'leases'), { recursive: true })
  await writeFile(join(root, 'leases', `${hash}.json`), JSON.stringify(lease))
}

async function writeLock(root: string, pid: number, ageMs: number): Promise<void> {
  await mkdir(join(root, '.lock'), { recursive: true })
  await writeFile(join(root, '.lock', 'pid'), `${pid}\n`)
  const when = new Date(Date.now() - ageMs)
  await utimes(join(root, '.lock'), when, when)
}

failOnProcessProblems()

afterEach(async () => {
  for (const manager of managers.splice(0)) manager.dispose()
  for (const child of sleepers.splice(0)) child.kill('SIGKILL')
  await Promise.all(servers.splice(0).map(server => server.close()))
  await sleep(20)
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

// ───────────────────────────── 测试 ─────────────────────────────

describe('RuntimeManager download and install', () => {
  it('downloads from the mirror, verifies, extracts and marks the version ready', async () => {
    const root = await newRoot()
    const server = await startServer({ mirror: serve() })
    const manager = createManager(root, server)
    const seen = record(manager)
    expect(manager.status()).toEqual({ state: 'missing', version: VERSION, dir: root })
    const install = await manager.ensure()
    expect(install).toEqual({ executable: join(root, INSTALL, 'electron'), dir: join(root, INSTALL) })
    expect(server.hits).toEqual([{ source: 'mirror', range: null }])
    const ready = JSON.parse(await readFile(join(root, INSTALL, '.ready'), 'utf8')) as Record<string, unknown>
    expect(ready).toMatchObject({ version: VERSION, sha256: SHA256 })
    expect(typeof ready.installedAt).toBe('string')
    // 装好之后压缩包删掉，锁放开，临时目录不留。
    expect(await readdir(join(root, 'downloads'))).toEqual([])
    expect(await exists(join(root, '.lock'))).toBe(false)
    expect(await exists(join(root, `staging-${process.pid}`))).toBe(false)
    expect(manager.status()).toEqual({ state: 'ready', version: VERSION, dir: root, source: 'mirror' })
    const states = seen.map(s => s.state)
    expect(states).toContain('downloading')
    expect(states).toContain('extracting')
    expect(states.at(-1)).toBe('ready')
    const progress = seen.filter(s => s.state === 'downloading')
    expect(progress.every(s => s.total === PAYLOAD.length && typeof s.received === 'number' && s.source === 'mirror')).toBe(true)
    // 再调一次：已装好，不发请求。
    await manager.ensure()
    expect(server.hits).toHaveLength(1)
  })

  it('reports ready on construction when the version is already installed', async () => {
    const root = await newRoot()
    await fakeInstall(root, INSTALL)
    const manager = createManager(root, null)
    expect(manager.status().state).toBe('ready')
    await expect(manager.ensure()).resolves.toEqual({ executable: join(root, INSTALL, 'electron'), dir: join(root, INSTALL) })
  })

  it('falls back to the official source when the mirror fails the checksum', async () => {
    const root = await newRoot()
    const server = await startServer({ mirror: serve(corrupt()), official: serve() })
    const logs = captureLogs()
    const manager = createManager(root, server, { logger: logs.logger })
    await manager.ensure()
    expect(server.hits.map(h => h.source)).toEqual(['mirror', 'official'])
    expect(manager.status().source).toBe('official')
    expect(logs.lines.some(line => line.includes('promptx/runtime/checksum-mismatch'))).toBe(true)
  })

  it('falls back when the mirror answers 404', async () => {
    const root = await newRoot()
    const server = await startServer({ mirror: notFound, official: serve() })
    const manager = createManager(root, server)
    await manager.ensure()
    expect(server.hits.map(h => h.source)).toEqual(['mirror', 'official'])
  })

  it('falls back when the mirror stalls after sending a few bytes, keeping them for resume', async () => {
    const root = await newRoot()
    const server = await startServer({ mirror: stall, official: serve() })
    const logs = captureLogs()
    const manager = createManager(root, server, { logger: logs.logger })
    await manager.ensure()
    // 官方源从镜像留下的 1000 字节之后续传。
    expect(server.hits).toEqual([{ source: 'mirror', range: null }, { source: 'official', range: 'bytes=1000-' }])
    expect(logs.lines.some(line => line.includes('(stalled)'))).toBe(true)
  })

  it('falls back when the mirror does not answer within the connect timeout', async () => {
    const root = await newRoot()
    const server = await startServer({ mirror: hang, official: serve() })
    const logs = captureLogs()
    const manager = createManager(root, server, { logger: logs.logger, timeouts: { connectMs: 300, stallMs: 400 } })
    await manager.ensure()
    expect(server.hits.map(h => h.source)).toEqual(['mirror', 'official'])
    expect(logs.lines.some(line => line.includes('(connect timeout)'))).toBe(true)
  })

  it('uses only the configured source', async () => {
    const root = await newRoot()
    const server = await startServer({ mirror: notFound, official: serve() })
    const mirrorOnly = createManager(root, server, { getSource: () => 'mirror' })
    await expect(mirrorOnly.ensure()).rejects.toMatchObject({ code: 'promptx/runtime/download-failed', detail: 'HTTP 404' })
    expect(server.hits.map(h => h.source)).toEqual(['mirror'])
    expect(mirrorOnly.status()).toMatchObject({ state: 'failed', error: { code: 'promptx/runtime/download-failed', detail: 'HTTP 404' } })
    const officialOnly = createManager(root, server, { getSource: () => 'official' })
    await officialOnly.ensure()
    expect(server.hits.map(h => h.source)).toEqual(['mirror', 'official'])
  })

  it('fails with the last error when every source fails, and retries on the next call', async () => {
    const root = await newRoot()
    const server = await startServer({ mirror: notFound, official: notFound })
    const manager = createManager(root, server)
    const error = await manager.ensure().catch((e: unknown) => e)
    expect(error).toBeInstanceOf(PromptxError)
    expect((error as PromptxError).code).toBe('promptx/runtime/download-failed')
    expect(manager.status()).toMatchObject({ state: 'failed', error: { code: 'promptx/runtime/download-failed' } })
    expect(await exists(join(root, '.lock'))).toBe(false)
    // 「重试」：失败不是粘住的状态。
    server.behaviors.official = serve()
    await manager.ensure()
    expect(manager.status().state).toBe('ready')
  })

  it('shares one download between concurrent callers', async () => {
    const root = await newRoot()
    const server = await startServer({ mirror: serveSlowly(4, 30) })
    const manager = createManager(root, server)
    const [a, b] = await Promise.all([manager.ensure(), manager.ensure()])
    expect(a).toEqual(b)
    expect(server.hits).toHaveLength(1)
  })

  it('throttles progress notifications to one per 250 ms', async () => {
    const root = await newRoot()
    const server = await startServer({ mirror: serveSlowly(32, 25) })
    const manager = createManager(root, server)
    const seen = record(manager)
    const started = Date.now()
    await manager.ensure()
    const elapsed = Date.now() - started
    const progress = seen.filter(s => s.state === 'downloading' && typeof s.received === 'number')
    // 每 250 ms 最多一次，再加开始和结束各一次。
    expect(progress.length).toBeLessThanOrEqual(Math.ceil(elapsed / 250) + 3)
    expect(progress.length).toBeGreaterThanOrEqual(2)
    expect(progress.at(-1)?.received).toBe(PAYLOAD.length)
  })

  it('fails when the disk does not have enough free space, without downloading', async () => {
    const root = await newRoot()
    const server = await startServer({ mirror: serve() })
    const manager = createManager(root, server, { requiredFreeBytes: Number.MAX_SAFE_INTEGER })
    await expect(manager.ensure()).rejects.toMatchObject({ code: 'promptx/runtime/disk-space' })
    expect(manager.status()).toMatchObject({ state: 'failed', dir: root, error: { code: 'promptx/runtime/disk-space' } })
    expect(manager.status().error?.detail).toMatch(/^need \d+ MB, \d+ MB free$/)
    expect(server.hits).toHaveLength(0)
    expect(await exists(join(root, '.lock'))).toBe(false)
  })

  it('reports an unsupported platform', async () => {
    const root = await newRoot()
    const manager = createManager(root, null, { platform: 'freebsd', arch: 'x64' })
    // 不支持的平台没有对应的压缩包，测试替换的 release 也不用：版本报源码里固定的 Electron 版本。
    expect(manager.status()).toEqual({
      state: 'unsupported',
      version: ELECTRON_VERSION,
      dir: root,
      error: { code: 'promptx/runtime/unsupported', detail: 'freebsd-x64' },
    })
    await expect(manager.ensure()).rejects.toMatchObject({ code: 'promptx/runtime/unsupported' })
    const arch = createManager(root, null, { platform: 'darwin', arch: 'ia32' })
    expect(arch.status().state).toBe('unsupported')
  })

  it('uses the pinned release and platform layout by default', () => {
    const manager = createManager('/tmp/promptx-root', null, { platform: 'darwin', arch: 'arm64', release: undefined as never })
    expect(manager.status()).toEqual({ state: 'missing', version: ELECTRON_VERSION, dir: '/tmp/promptx-root' })
    expect(executableSegments('darwin')).toEqual(['Electron.app', 'Contents', 'MacOS', 'Electron'])
    expect(executableSegments('win32')).toEqual(['electron.exe'])
    expect(executableSegments('linux')).toEqual(['electron'])
  })
})

describe('RuntimeManager resume rules', () => {
  async function writePart(root: string, bytes: Uint8Array): Promise<string> {
    await mkdir(join(root, 'downloads'), { recursive: true })
    const part = join(root, 'downloads', `${FILE}.part`)
    await writeFile(part, bytes)
    return part
  }

  it('resumes a partial download with Range when the 206 Content-Range matches', async () => {
    const root = await newRoot()
    const half = 100_000
    await writePart(root, PAYLOAD.subarray(0, half))
    const server = await startServer({ mirror: serve() })
    const manager = createManager(root, server)
    const seen = record(manager)
    await manager.ensure()
    expect(server.hits).toEqual([{ source: 'mirror', range: `bytes=${half}-` }])
    expect(seen.find(s => s.state === 'downloading')?.received).toBe(half)
  })

  it('starts over when the server ignores Range and answers 200', async () => {
    const root = await newRoot()
    await writePart(root, PAYLOAD.subarray(0, 50_000))
    const server = await startServer({ mirror: serve(PAYLOAD, { honorRange: false }) })
    const manager = createManager(root, server)
    await manager.ensure()
    expect(server.hits).toEqual([{ source: 'mirror', range: 'bytes=50000-' }])
    expect(manager.status().state).toBe('ready')
  })

  it('truncates and downloads from the start when the Content-Range does not match', async () => {
    const root = await newRoot()
    await writePart(root, PAYLOAD.subarray(0, 50_000))
    const wrongRange: Behavior = (req, res) => {
      if (req.headers.range !== undefined) {
        res.writeHead(206, { 'content-range': `bytes 0-${PAYLOAD.length - 1}/${PAYLOAD.length}`, 'content-length': String(PAYLOAD.length) })
        res.end(PAYLOAD)
        return
      }
      serve()(req, res)
    }
    const server = await startServer({ mirror: wrongRange })
    const manager = createManager(root, server)
    await manager.ensure()
    expect(server.hits).toEqual([{ source: 'mirror', range: 'bytes=50000-' }, { source: 'mirror', range: null }])
    expect(manager.status().state).toBe('ready')
  })

  it('verifies a complete .part instead of asking for a range the server would answer with 416', async () => {
    const root = await newRoot()
    await writePart(root, PAYLOAD)
    // serve() 对越界的 Range 回 416；已经完整的 .part 不发请求，直接校验后安装（审查 S09a）。
    const server = await startServer({ mirror: serve() })
    const manager = createManager(root, server)
    await manager.ensure()
    expect(server.hits).toEqual([])
    expect(manager.status().state).toBe('ready')
  })

  it('deletes a complete but corrupt .part and downloads it again', async () => {
    const root = await newRoot()
    await writePart(root, corrupt())
    const server = await startServer({ mirror: serve() })
    const manager = createManager(root, server)
    await manager.ensure()
    expect(server.hits).toEqual([{ source: 'mirror', range: null }])
    expect(manager.status()).toMatchObject({ state: 'ready', source: 'mirror' })
  })

  it('deletes a .part larger than expected and downloads from the start', async () => {
    const root = await newRoot()
    await writePart(root, Buffer.concat([PAYLOAD, Buffer.from('extra')]))
    const server = await startServer({ mirror: serve() })
    const manager = createManager(root, server)
    await manager.ensure()
    expect(server.hits).toEqual([{ source: 'mirror', range: null }])
  })

  it('verifies the .part on 416 and starts over when it does not match', async () => {
    const root = await newRoot()
    await writePart(root, PAYLOAD.subarray(0, 70_000))
    const rangeNotSatisfiable: Behavior = (req, res) => {
      if (req.headers.range !== undefined) {
        res.writeHead(416, { 'content-range': `bytes */${PAYLOAD.length}` })
        res.end()
        return
      }
      serve()(req, res)
    }
    const server = await startServer({ mirror: rangeNotSatisfiable })
    const manager = createManager(root, server)
    await manager.ensure()
    expect(server.hits).toEqual([{ source: 'mirror', range: 'bytes=70000-' }, { source: 'mirror', range: null }])
  })

  it('re-downloads once from scratch on the same source when a resumed file fails verification', async () => {
    const root = await newRoot()
    // 留下的前半段是坏的：续传接得上，但整体校验不通过。
    await writePart(root, randomBytes(60_000))
    const server = await startServer({ mirror: serve(), official: serve() })
    const manager = createManager(root, server)
    await manager.ensure()
    expect(server.hits).toEqual([{ source: 'mirror', range: 'bytes=60000-' }, { source: 'mirror', range: null }])
    expect(manager.status()).toMatchObject({ state: 'ready', source: 'mirror' })
  })

  it('aborts a stream that sends more bytes than expected and never writes past the expected size', async () => {
    const root = await newRoot()
    const oversize: Behavior = (_req, res) => {
      // 分块传输（没有 Content-Length），发的比预期多。
      res.writeHead(200, { 'transfer-encoding': 'chunked' })
      res.write(PAYLOAD)
      res.end(randomBytes(4_096))
    }
    const server = await startServer({ mirror: oversize, official: oversize })
    const manager = createManager(root, server)
    await expect(manager.ensure()).rejects.toMatchObject({ code: 'promptx/runtime/size-mismatch' })
    expect(server.hits.map(h => h.source)).toEqual(['mirror', 'official'])
    // 不可信的字节连同 .part 一起删掉。
    expect(await exists(join(root, 'downloads', `${FILE}.part`))).toBe(false)
    server.behaviors.official = serve()
    await manager.ensure()
    expect(manager.status()).toMatchObject({ state: 'ready', source: 'official' })
  })

  it('keeps the existing .part when a source announces the wrong length, and resumes from the next source', async () => {
    const root = await newRoot()
    await writePart(root, PAYLOAD.subarray(0, 40_000))
    const wrongLength: Behavior = (_req, res) => {
      res.writeHead(206, { 'content-range': `bytes 40000-${PAYLOAD.length - 1}/${PAYLOAD.length}`, 'content-length': '5' })
      res.end('12345')
    }
    const server = await startServer({ mirror: wrongLength, official: serve() })
    const manager = createManager(root, server)
    await manager.ensure()
    // 长度不对时还没写任何字节，镜像之前留下的 40000 字节照样给官方源续传。
    expect(server.hits).toEqual([{ source: 'mirror', range: 'bytes=40000-' }, { source: 'official', range: 'bytes=40000-' }])
    expect(manager.status()).toMatchObject({ state: 'ready', source: 'official' })
  })

  it('rejects a Content-Length that does not match the expected size', async () => {
    const root = await newRoot()
    const wrongLength: Behavior = (_req, res) => {
      res.writeHead(200, { 'content-length': String(PAYLOAD.length + 10) })
      res.end(Buffer.concat([PAYLOAD, Buffer.alloc(10)]))
    }
    const server = await startServer({ mirror: wrongLength, official: serve() })
    const logs = captureLogs()
    const manager = createManager(root, server, { logger: logs.logger })
    await manager.ensure()
    expect(server.hits.map(h => h.source)).toEqual(['mirror', 'official'])
    expect(logs.lines.some(line => line.includes('promptx/runtime/size-mismatch'))).toBe(true)
  })
})

describe('RuntimeManager installation state', () => {
  it('moves a crash-left version directory without .ready out of the way', async () => {
    const root = await newRoot()
    await mkdir(join(root, INSTALL, 'half-extracted'), { recursive: true })
    await writeFile(join(root, INSTALL, 'half-extracted', 'file'), 'x')
    const server = await startServer({ mirror: serve() })
    const manager = createManager(root, server)
    await manager.ensure()
    expect((await readdir(join(root, INSTALL))).sort()).toEqual(['.ready', 'electron'])
    expect((await readdir(root)).filter(name => name.startsWith('trash-') || name.startsWith('staging-'))).toEqual([])
  })

  it('downloads again when the executable disappeared after .ready was written', async () => {
    const root = await newRoot()
    await fakeInstall(root, INSTALL)
    await rm(join(root, INSTALL, 'electron'))
    const server = await startServer({ mirror: serve() })
    const manager = createManager(root, server)
    expect(manager.status().state).toBe('missing')
    await manager.ensure()
    expect(server.hits).toHaveLength(1)
    expect(await exists(join(root, INSTALL, 'electron'))).toBe(true)
    expect(await exists(join(root, INSTALL, '.ready'))).toBe(true)
  })

  it.runIf(process.platform !== 'win32')('downloads again when the executable is no longer executable', async () => {
    const root = await newRoot()
    await fakeInstall(root, INSTALL)
    await writeFile(join(root, INSTALL, 'electron'), '#!/bin/sh\n', { mode: 0o644 })
    const { chmod } = await import('node:fs/promises')
    await chmod(join(root, INSTALL, 'electron'), 0o644)
    const server = await startServer({ mirror: serve() })
    const manager = createManager(root, server)
    await manager.ensure()
    expect(server.hits).toHaveLength(1)
  })

  it('fails with extract-failed and removes the staging directory when extraction fails', async () => {
    const root = await newRoot()
    const server = await startServer({ mirror: serve() })
    const manager = createManager(root, server, {
      extract: async () => {
        throw new Error('ditto: Couldn\'t read PKZip signature')
      },
    })
    await expect(manager.ensure()).rejects.toMatchObject({ code: 'promptx/runtime/extract-failed' })
    expect(manager.status().error).toEqual({ code: 'promptx/runtime/extract-failed', detail: 'ditto: Couldn\'t read PKZip signature' })
    expect(await exists(join(root, `staging-${process.pid}`))).toBe(false)
    expect(await exists(join(root, INSTALL))).toBe(false)
    // 下载下来的压缩包没问题，留着：重试时不用再下。
    expect(await exists(join(root, 'downloads', `${FILE}.part`))).toBe(true)
  })

  it('fails when the archive has no Electron executable', async () => {
    const root = await newRoot()
    const server = await startServer({ mirror: serve() })
    const manager = createManager(root, server, { extract: async () => {} })
    await expect(manager.ensure()).rejects.toMatchObject({ code: 'promptx/runtime/extract-failed', detail: 'the archive has no Electron executable' })
  })
})

describe('RuntimeManager cross-process lock', () => {
  it('waits for a live holder with a fresh heartbeat, even when it has held the lock for over 30 minutes', async () => {
    const root = await newRoot()
    const holder = liveProcess()
    await writeLock(root, holder, 0)
    // 锁是 31 分钟前建的（pid 文件很旧），但持有者一直在刷新心跳：不能被抢（审查 S08）。
    const old = new Date(Date.now() - 31 * 60_000)
    await utimes(join(root, '.lock', 'pid'), old, old)
    const server = await startServer({ mirror: serve() })
    const manager = createManager(root, server)
    const seen = record(manager)
    const pending = manager.ensure()
    await waitFor(() => manager.status().state === 'downloading', 'waiting state')
    // 等锁时：downloading，没有进度数字，也没有错误。
    expect(manager.status()).toEqual({ state: 'downloading', version: VERSION, dir: root })
    for (let i = 0; i < 5; i++) {
      await sleep(60)
      const now = new Date()
      await utimes(join(root, '.lock'), now, now)
    }
    expect(await readFile(join(root, '.lock', 'pid'), 'utf8')).toBe(`${holder}\n`)
    // 持有者装好了，放开锁：等待的一方直接用，不再下载。
    await fakeInstall(root, INSTALL)
    await rm(join(root, '.lock'), { recursive: true, force: true })
    await expect(pending).resolves.toEqual({ executable: join(root, INSTALL, 'electron'), dir: join(root, INSTALL) })
    expect(server.hits).toHaveLength(0)
    expect(seen.at(-1)?.state).toBe('ready')
  })

  it('takes over a lock whose heartbeat is older than five minutes even if the pid is alive', async () => {
    const root = await newRoot()
    await writeLock(root, liveProcess(), 6 * 60_000)
    const server = await startServer({ mirror: serve() })
    const manager = createManager(root, server)
    await manager.ensure()
    expect(server.hits).toHaveLength(1)
    expect(await exists(join(root, '.lock'))).toBe(false)
  })

  it('takes over a lock whose holder exited', async () => {
    const root = await newRoot()
    await writeLock(root, await deadPid(), 0)
    const server = await startServer({ mirror: serve() })
    const manager = createManager(root, server)
    await manager.ensure()
    expect(server.hits).toHaveLength(1)
  })

  it('refreshes the lock heartbeat while downloading and releases the lock afterwards', async () => {
    const root = await newRoot()
    const server = await startServer({ mirror: serveSlowly(10, 60) })
    const manager = createManager(root, server, { lockTimings: { heartbeatMs: 50, pollMs: 40 } })
    const pending = manager.ensure()
    await waitFor(() => exists(join(root, '.lock', 'pid')), 'lock')
    expect(await readFile(join(root, '.lock', 'pid'), 'utf8')).toBe(`${process.pid}\n`)
    const old = new Date(Date.now() - 60_000)
    await utimes(join(root, '.lock'), old, old)
    await waitFor(async () => (await stat(join(root, '.lock'))).mtimeMs > Date.now() - 10_000, 'heartbeat refresh')
    await pending
    expect(await exists(join(root, '.lock'))).toBe(false)
  })

  /** 下载到一半时锁被另一个进程接管（本进程停住超过 5 分钟，例如电脑睡眠）：本进程停下，回去等它装好。 */
  async function expectWaitForNewHolder(takeOver: (root: string, holder: number) => Promise<void>): Promise<void> {
    const root = await newRoot()
    const server = await startServer({ mirror: serveSlowly(20, 60) })
    const manager = createManager(root, server, { lockTimings: { heartbeatMs: 50, pollMs: 40 } })
    const seen = record(manager)
    const pending = manager.ensure()
    await waitFor(() => (manager.status().received ?? 0) > 0, 'download started')
    const holder = liveProcess()
    await takeOver(root, holder)
    await waitFor(() => manager.status().state === 'downloading' && manager.status().received === undefined, 'waiting for the new holder')
    expect(manager.status().error).toBeUndefined()
    // 别人的锁不能删，也不能再往 .part 里写。
    expect(await readFile(join(root, '.lock', 'pid'), 'utf8')).toBe(`${holder}\n`)
    const requests = server.hits.length
    await sleep(200)
    expect(server.hits).toHaveLength(requests)
    // 接管的进程装好、放开锁：本进程直接用它装好的版本，不算失败。
    await fakeInstall(root, INSTALL)
    await rm(join(root, '.lock'), { recursive: true, force: true })
    await expect(pending).resolves.toEqual({ executable: join(root, INSTALL, 'electron'), dir: join(root, INSTALL) })
    expect(server.hits).toHaveLength(requests)
    expect(seen.some(status => status.state === 'failed')).toBe(false)
    expect(manager.status().state).toBe('ready')
  }

  it('goes back to waiting when another process replaced the lock directory', async () => {
    await expectWaitForNewHolder(async (root, holder) => {
      // 先在旁边建好新锁再换上去，删和改名之间只隔两个系统调用。
      const next = join(root, 'next-lock')
      await mkdir(next)
      await writeFile(join(next, 'pid'), `${holder}\n`)
      await rm(join(root, '.lock'), { recursive: true, force: true })
      await rename(next, join(root, '.lock'))
    })
  })

  it('notices a takeover that reused the lock directory (pid rewritten in place)', async () => {
    // 有的文件系统会立刻复用刚释放的 inode：新锁目录和旧的 inode 相同，只有 pid 文件能看出换了持有者。
    await expectWaitForNewHolder(async (root, holder) => {
      await writeFile(join(root, '.lock', 'pid'), `${holder}\n`)
    })
  })
})

describe('RuntimeManager leases, cleanup and removal', () => {
  it('writes and releases this profile\'s lease', async () => {
    const root = await newRoot()
    const manager = createManager(root, null)
    await manager.acquireLease(VERSION, 4242)
    expect(JSON.parse(await readFile(join(root, 'leases', 'aaaa1111.json'), 'utf8'))).toEqual({ version: VERSION, pid: 4242, profile: 'Test profile' })
    expect((await readdir(join(root, 'leases'))).filter(name => name.endsWith('.tmp'))).toEqual([])
    await manager.releaseLease()
    expect(await readdir(join(root, 'leases'))).toEqual([])
    await manager.releaseLease()
  })

  it('only releases the lease of the process that exited when given its pid', async () => {
    const root = await newRoot()
    const manager = createManager(root, null)
    await manager.acquireLease(VERSION, 5151)
    // 旧进程 4242 很晚才退出：新进程 5151 的租约不能被它删掉。
    await manager.releaseLease(4242)
    expect(JSON.parse(await readFile(join(root, 'leases', 'aaaa1111.json'), 'utf8'))).toMatchObject({ pid: 5151 })
    await manager.releaseLease(5151)
    expect(await readdir(join(root, 'leases'))).toEqual([])
    // 没有租约时也不报错。
    await manager.releaseLease(5151)
  })

  it('cleans up unused versions after installing but keeps versions with a live lease', async () => {
    const root = await newRoot()
    const live = liveProcess()
    const dead = await deadPid()
    await fakeInstall(root, '0.9.0-linux-x64')
    await fakeInstall(root, '0.8.0-linux-x64')
    await fakeInstall(root, '0.7.0-linux-x64')
    await writeLease(root, 'bbbb2222', { version: '0.9.0', pid: live, profile: 'Work' })
    await writeLease(root, 'cccc3333', { version: '0.8.0', pid: dead, profile: 'Old' })
    await mkdir(join(root, 'trash-99999'), { recursive: true })
    await mkdir(join(root, `staging-${dead}`), { recursive: true })
    await mkdir(join(root, `staging-${live}`), { recursive: true })
    await mkdir(join(root, 'downloads'), { recursive: true })
    await writeFile(join(root, 'downloads', 'electron-v0.9.0-linux-x64.zip.part'), 'old')
    await mkdir(join(root, 'unrelated'), { recursive: true })
    const server = await startServer({ mirror: serve() })
    const manager = createManager(root, server)
    await manager.ensure()
    expect((await readdir(root)).sort()).toEqual([INSTALL, '0.9.0-linux-x64', 'downloads', 'leases', `staging-${live}`, 'unrelated'].sort())
    expect(await readdir(join(root, 'downloads'))).toEqual([])
    // 已退出进程的租约也清掉。
    expect(await readdir(join(root, 'leases'))).toEqual(['bbbb2222.json'])
  })

  it('does not clean up when the runtime was already installed', async () => {
    const root = await newRoot()
    await fakeInstall(root, INSTALL)
    await fakeInstall(root, '0.9.0-linux-x64')
    const manager = createManager(root, null)
    await manager.ensure()
    expect(await exists(join(root, '0.9.0-linux-x64'))).toBe(true)
  })

  it('removes versions not used by other profiles, reports the rest and pauses downloading', async () => {
    const root = await newRoot()
    const live = liveProcess()
    await fakeInstall(root, INSTALL)
    await fakeInstall(root, '0.9.0-linux-x64')
    await fakeInstall(root, '0.8.0-linux-x64')
    await writeLease(root, 'bbbb2222', { version: '0.9.0', pid: live, profile: 'Work' })
    // 本 profile 自己的租约不保护版本（调用方已经停掉了本 profile 的小程序）。
    await writeLease(root, 'aaaa1111', { version: VERSION, pid: live, profile: 'Test profile' })
    await mkdir(join(root, 'downloads'), { recursive: true })
    await writeFile(join(root, 'downloads', `${FILE}.part`), 'partial')
    const server = await startServer({ mirror: serve() })
    const manager = createManager(root, server)
    await manager.ensure()
    const seen = record(manager)
    const result = await manager.remove()
    expect(result.removed.sort()).toEqual(['0.8.0', VERSION].sort())
    expect(result.inUseBy).toEqual([{ profile: 'Work', version: '0.9.0' }])
    expect((await readdir(root)).sort()).toEqual(['0.9.0-linux-x64', 'leases'])
    expect(manager.status()).toEqual({ state: 'missing', version: VERSION, dir: root, paused: true, inUseBy: [{ profile: 'Work', version: '0.9.0' }] })
    expect(seen.at(-1)?.paused).toBe(true)
    // 暂停期间不自动下载。
    await expect(manager.ensure()).rejects.toMatchObject({ code: 'promptx/runtime/download-failed', detail: 'paused' })
    expect(manager.status()).toMatchObject({ state: 'missing', paused: true })
    expect(server.hits).toHaveLength(0)
    // 用户点「下载」：解除暂停，重新下载。
    manager.resume()
    expect(manager.status().paused).toBeUndefined()
    expect(manager.status().inUseBy).toBeUndefined()
    await manager.ensure()
    expect(server.hits).toHaveLength(1)
    expect(manager.status().state).toBe('ready')
  })

  it('stops an in-flight download before removing', async () => {
    const root = await newRoot()
    const server = await startServer({ mirror: serveSlowly(50, 40) })
    const manager = createManager(root, server)
    const pending = manager.ensure().catch((e: unknown) => e)
    await waitFor(() => manager.status().received !== undefined && manager.status().received! > 0, 'download started')
    const result = await manager.remove()
    expect(result).toEqual({ removed: [], inUseBy: [] })
    expect(await pending).toBeInstanceOf(Error)
    expect(await exists(join(root, 'downloads'))).toBe(false)
    expect(await exists(join(root, '.lock'))).toBe(false)
    expect(manager.status()).toMatchObject({ state: 'missing', paused: true })
  })

  it('refuses to remove while another process holds the download lock', async () => {
    const root = await newRoot()
    await writeLock(root, liveProcess(), 0)
    const manager = createManager(root, null, { lockTimings: { pollMs: 20, removeWaitMs: 200 } })
    await expect(manager.remove()).rejects.toMatchObject({ code: 'promptx/runtime/locked' })
    expect(await exists(join(root, '.lock', 'pid'))).toBe(true)
  })

  it('stops waiting for the lock when disposed during remove(), and refuses later calls', async () => {
    const root = await newRoot()
    await writeLock(root, liveProcess(), 0)
    const manager = createManager(root, null, { lockTimings: { pollMs: 20, removeWaitMs: 10_000 } })
    const removing = manager.remove()
    await sleep(60)
    const started = Date.now()
    manager.dispose()
    await expect(removing).rejects.toBeInstanceOf(Error)
    expect(Date.now() - started).toBeLessThan(1_000)
    await expect(manager.remove()).rejects.toMatchObject({ code: 'promptx/runtime/download-failed', detail: 'disposed' })
    // 别人的锁原样留着。
    expect(await exists(join(root, '.lock', 'pid'))).toBe(true)
  })
})

describe('RuntimeManager cancellation', () => {
  it('stops the download when the only caller aborts, and resumes later', async () => {
    const root = await newRoot()
    const server = await startServer({ mirror: serveSlowly(40, 40) })
    const manager = createManager(root, server)
    const controller = new AbortController()
    const pending = manager.ensure(controller.signal)
    await waitFor(() => manager.status().received !== undefined && manager.status().received! > 0, 'download started')
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    await waitFor(() => manager.status().state === 'missing', 'missing')
    await waitFor(async () => !(await exists(join(root, '.lock'))), 'lock released')
    const part = await stat(join(root, 'downloads', `${FILE}.part`))
    expect(part.size).toBeGreaterThan(0)
    server.behaviors.mirror = serve()
    await manager.ensure()
    expect(server.hits.at(-1)?.range).toBe(`bytes=${part.size}-`)
  })

  it('starts a fresh task for a caller that arrives while an aborted one is still winding down', async () => {
    const root = await newRoot()
    const server = await startServer({ mirror: serveSlowly(40, 40) })
    const manager = createManager(root, server)
    const controller = new AbortController()
    const first = manager.ensure(controller.signal)
    await waitFor(() => (manager.status().received ?? 0) > 0, 'download started')
    controller.abort()
    // 第一个任务还在收尾（关 .part、放锁）时来了新的调用方：它不能收到别人的中止，而是排在后面重新开始。
    server.behaviors.mirror = serve()
    const second = manager.ensure()
    await expect(first).rejects.toMatchObject({ name: 'AbortError' })
    await expect(second).resolves.toEqual({ executable: join(root, INSTALL, 'electron'), dir: join(root, INSTALL) })
    expect(manager.status().state).toBe('ready')
    // 第二次从第一次留下的字节续传。
    expect(server.hits.at(-1)?.range).toMatch(/^bytes=\d+-$/)
  })

  it('keeps downloading for other callers when one caller aborts', async () => {
    const root = await newRoot()
    const server = await startServer({ mirror: serveSlowly(10, 30) })
    const manager = createManager(root, server)
    const controller = new AbortController()
    const first = manager.ensure(controller.signal)
    const second = manager.ensure()
    controller.abort()
    await expect(first).rejects.toMatchObject({ name: 'AbortError' })
    await expect(second).resolves.toMatchObject({ dir: join(root, INSTALL) })
    expect(server.hits).toHaveLength(1)
  })

  it('rejects immediately for an already aborted signal', async () => {
    const root = await newRoot()
    const manager = createManager(root, null)
    await expect(manager.ensure(AbortSignal.abort())).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('aborts in-flight work and releases the lock on dispose', async () => {
    const root = await newRoot()
    const server = await startServer({ mirror: serveSlowly(50, 40) })
    const manager = createManager(root, server)
    const pending = manager.ensure()
    await waitFor(() => manager.status().received !== undefined && manager.status().received! > 0, 'download started')
    manager.dispose()
    expect(await exists(join(root, '.lock'))).toBe(false)
    await expect(pending).rejects.toBeInstanceOf(Error)
    await expect(manager.ensure()).rejects.toMatchObject({ code: 'promptx/runtime/download-failed', detail: 'disposed' })
  })

  it('cleans up when disposed during extraction', async () => {
    const root = await newRoot()
    const server = await startServer({ mirror: serve() })
    let extracting = false
    const manager = createManager(root, server, {
      extract: async (zip, dest) => {
        extracting = true
        await sleep(300)
        await fakeExtract(zip, dest)
      },
    })
    const pending = manager.ensure()
    await waitFor(() => extracting, 'extracting')
    expect(manager.status().state).toBe('extracting')
    manager.dispose()
    expect(await exists(join(root, '.lock'))).toBe(false)
    await expect(pending).rejects.toBeInstanceOf(Error)
    // 解压被放弃：临时目录删掉，版本目录不出现，也就不会被当成装好了。
    expect(await exists(join(root, `staging-${process.pid}`))).toBe(false)
    expect(await exists(join(root, INSTALL))).toBe(false)
  })

  it('aborts while waiting for another process\'s lock', async () => {
    const root = await newRoot()
    await writeLock(root, liveProcess(), 0)
    const manager = createManager(root, null)
    const controller = new AbortController()
    const pending = manager.ensure(controller.signal)
    await waitFor(() => manager.status().state === 'downloading', 'waiting')
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    await waitFor(() => manager.status().state === 'missing', 'missing')
  })
})

describe('runtime extraction tools', () => {
  it('reports a missing unzip on Linux', async () => {
    const root = await newRoot()
    const extract = defaultExtractor('linux', { PATH: join(root, 'empty-bin') })
    await expect(extract(join(root, 'a.zip'), root)).rejects.toMatchObject({ code: 'promptx/runtime/unzip-missing' })
  })

  it('reports a failing tool with its exit status and never throws synchronously', async () => {
    await expect(runTool(process.execPath, ['-e', 'process.stderr.write("boom\\nmore"); process.exit(4)'])).rejects.toThrow(/exited with code 4: boom/)
    await expect(runTool('/nonexistent/tool', [])).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(runTool(process.execPath, ['-e', ''])).resolves.toBeUndefined()
  })

  it('kills the tool when aborted', async () => {
    const controller = new AbortController()
    const pending = runTool(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { signal: controller.signal })
    setTimeout(() => {
      controller.abort()
    }, 50)
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  })

  it.runIf(process.platform === 'darwin')('extracts a real zip with ditto on macOS, keeping symlinks', async () => {
    const root = await newRoot()
    const source = join(root, 'src')
    const app = join(source, 'Electron.app', 'Contents', 'MacOS')
    await mkdir(app, { recursive: true })
    await writeFile(join(app, 'Electron'), '#!/bin/sh\n', { mode: 0o755 })
    const { symlink, lstat } = await import('node:fs/promises')
    await symlink('Contents', join(source, 'Electron.app', 'Current'))
    const zip = join(root, 'electron.zip')
    await runTool('/usr/bin/ditto', ['-c', '-k', source, zip])
    const dest = join(root, 'dest')
    await mkdir(dest)
    await defaultExtractor('darwin')(zip, dest)
    expect((await lstat(join(dest, 'Electron.app', 'Current'))).isSymbolicLink()).toBe(true)
    await access(join(dest, 'Electron.app', 'Contents', 'MacOS', 'Electron'))
  })
})
