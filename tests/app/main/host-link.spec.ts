import { PassThrough, Writable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { HostLink, type HostLinkClose, type OutputStream } from '../../../src/app/main/host-link.ts'
import { encodeFrame } from '../../../src/shared/ndjson.ts'
import { RPC_ERROR } from '../../../src/shared/protocol.ts'
import { RpcError } from '../../../src/shared/rpc.ts'
import { MemoryLogger, trapProcessErrors } from './helpers.ts'

trapProcessErrors()

interface Setup {
  link: HostLink
  input: PassThrough
  output: PassThrough
  written: unknown[]
  closes: HostLinkClose[]
  logger: MemoryLogger
}

function setup(output: PassThrough = new PassThrough()): Setup {
  const input = new PassThrough()
  const written: unknown[] = []
  let buffer = ''
  output.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8')
    let newline = buffer.indexOf('\n')
    while (newline !== -1) {
      written.push(JSON.parse(buffer.slice(0, newline)))
      buffer = buffer.slice(newline + 1)
      newline = buffer.indexOf('\n')
    }
  })
  const closes: HostLinkClose[] = []
  const logger = new MemoryLogger()
  const link = new HostLink({
    input,
    output,
    logger,
    onClose: (why) => {
      closes.push(why)
    },
    defaultTimeoutMs: 2000,
  })
  link.start()
  return { link, input, output, written, closes, logger }
}

function tick(ms = 0): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

describe('HostLink', () => {
  it('sends requests as NDJSON frames and resolves them with the Host reply', async () => {
    const { link, input, written } = setup()
    const reply = link.peer.request('draft.load', {})
    await tick()
    expect(written).toEqual([{ jsonrpc: '2.0', id: 1, method: 'draft.load', params: {} }])
    // 回复分两块到达，中间断在多字节字符里也能拼回来。
    const frame = Buffer.from(encodeFrame({ jsonrpc: '2.0', id: 1, result: { record: null, note: '草稿' } }), 'utf8')
    input.write(frame.subarray(0, 40))
    input.write(frame.subarray(40))
    await expect(reply).resolves.toEqual({ record: null, note: '草稿' })
  })

  it('dispatches Host requests to the handlers and writes the response', async () => {
    const { link, input, written } = setup()
    link.peer.handle('ping', () => ({}))
    input.write(encodeFrame({ jsonrpc: '2.0', id: 7, method: 'ping', params: {} }))
    await tick(5)
    expect(written).toEqual([{ jsonrpc: '2.0', id: 7, result: {} }])
  })

  it('logs bad frames by reason without content and keeps the connection', async () => {
    const { link, input, logger, closes } = setup()
    const received: unknown[] = []
    link.peer.on('config', (config) => {
      received.push(config)
    })
    input.write('{"secret prompt text\n')
    input.write(encodeFrame({ jsonrpc: '2.0', method: 'config', params: { ok: true } }))
    await tick(5)
    expect(received).toEqual([{ ok: true }])
    expect(logger.find('frame.rejected')?.fields).toEqual({ reason: 'invalid-json' })
    expect(logger.dump()).not.toContain('secret')
    expect(closes).toEqual([])
  })

  it('reports stdin end once and keeps stdout usable for the last draft save', async () => {
    const { link, input, written, closes } = setup()
    input.end()
    await tick(5)
    expect(closes).toEqual(['stdin-end'])
    expect(link.closed).toBe(true)
    // stdin 结束不等于 stdout 断了：退出前写回草稿的请求还能发出去。
    const pending = link.peer.request('draft.save', { text: 'x', selection: null, binding: null }, { timeoutMs: 50 })
    await tick(5)
    expect(written).toHaveLength(1)
    await expect(pending).rejects.toMatchObject({ rpcCode: RPC_ERROR.timeout })
  })

  it('reports a stdin error as a lost connection', async () => {
    const { input, closes } = setup()
    input.destroy(new Error('read ECONNRESET'))
    await tick(5)
    expect(closes).toEqual(['stdin-error'])
  })

  it('fails pending and later requests at once when stdout breaks (EPIPE)', async () => {
    const output = new PassThrough()
    const { link, closes, logger } = setup(output)
    const pending = link.peer.request('draft.load', {})
    output.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }))
    await expect(pending).rejects.toBeInstanceOf(RpcError)
    await expect(pending).rejects.toMatchObject({ rpcCode: RPC_ERROR.channelClosed })
    await expect(link.peer.request('draft.load', {})).rejects.toMatchObject({ rpcCode: RPC_ERROR.channelClosed })
    expect(closes).toEqual(['stdout-error'])
    expect(logger.find('host.link-closed')?.fields).toEqual({ why: 'stdout-error', error: 'Error:EPIPE' })
  })

  it('waits until queued frames are flushed to the pipe before exiting', async () => {
    let release: (() => void) | null = null
    const slow: OutputStream = new Writable({
      write(_chunk: Buffer, _encoding, callback) {
        release = () => {
          callback()
        }
      },
    })
    const input = new PassThrough()
    const link = new HostLink({ input, output: slow, logger: new MemoryLogger(), onClose: () => {} })
    link.start()
    await link.whenWritten(10)
    link.peer.notify('status', { shortcut: null, tray: true, visible: false, locale: 'en', rendererError: null })
    let done = false
    const waiting = link.whenWritten(1000).then(() => {
      done = true
    })
    await tick(10)
    expect(done).toBe(false)
    const flush = release as (() => void) | null
    flush?.()
    await waiting
    expect(done).toBe(true)
  })

  it('stops waiting for the pipe after the limit', async () => {
    const stuck: OutputStream = new Writable({
      write() {
        // 永远不回调：模拟管道被对方塞满。
      },
    })
    const link = new HostLink({ input: new PassThrough(), output: stuck, logger: new MemoryLogger(), onClose: () => {} })
    link.start()
    link.peer.notify('status', { shortcut: null, tray: false, visible: false, locale: 'en', rendererError: null })
    const started = Date.now()
    await link.whenWritten(30)
    expect(Date.now() - started).toBeGreaterThanOrEqual(25)
  })

  it('starts only once', () => {
    const { link, input } = setup()
    link.start()
    expect(input.listenerCount('data')).toBe(1)
  })
})
