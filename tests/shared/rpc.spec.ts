import { afterEach, describe, expect, it, vi } from 'vitest'
import { PromptxError } from '../../src/shared/errors.ts'
import { RPC_ERROR } from '../../src/shared/protocol.ts'
import { RpcError, RpcPeer } from '../../src/shared/rpc.ts'

type AReq = { 'add': { params: { a: number; b: number }; result: { sum: number } }; 'fail': { params: Record<string, never>; result: Record<string, never> }; 'slow': { params: Record<string, never>; result: Record<string, never> } }
type ANote = { 'hello': { who: string } }

type Peer = RpcPeer<AReq, ANote, AReq, ANote>

/** 两个对接的端，消息经 JSON 往返，模拟真实的序列化。 */
function pair(onRightProblem?: (problem: string) => void) {
  const ends: { left?: Peer; right?: Peer } = {}
  const deliver = (to: 'left' | 'right') => (message: unknown) => {
    queueMicrotask(() => {
      ends[to]?.receive(JSON.parse(JSON.stringify(message)))
    })
  }
  const left: Peer = new RpcPeer({ defaultTimeoutMs: 1000, send: deliver('right') })
  const right: Peer = new RpcPeer({ defaultTimeoutMs: 1000, send: deliver('left'), ...(onRightProblem ? { onProblem: onRightProblem } : {}) })
  ends.left = left
  ends.right = right
  return { left, right }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('RpcPeer', () => {
  it('pairs requests with responses', async () => {
    const { left, right } = pair()
    right.handle('add', ({ a, b }) => ({ sum: a + b }))
    await expect(left.request('add', { a: 2, b: 3 })).resolves.toEqual({ sum: 5 })
  })

  it('reports business errors with their code and detail', async () => {
    const { left, right } = pair()
    right.handle('fail', () => {
      throw new PromptxError('promptx/library/write-failed', 'EACCES: permission denied')
    })
    const error = await left.request('fail', {}).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(RpcError)
    expect((error as RpcError).rpcCode).toBe(RPC_ERROR.business)
    expect((error as RpcError).info).toEqual({ code: 'promptx/library/write-failed', detail: 'EACCES: permission denied' })
  })

  it('maps unexpected exceptions to promptx/internal and reports the problem', async () => {
    const problems: string[] = []
    const { left, right } = pair((p) => {
      problems.push(p)
    })
    right.handle('fail', () => {
      throw new TypeError('boom')
    })
    const error = await left.request('fail', {}).catch((e: unknown) => e) as RpcError
    expect(error.info.code).toBe('promptx/internal')
    expect(problems).toEqual(['handler-failed: fail'])
  })

  it('answers unknown methods with method-not-found', async () => {
    const { left } = pair()
    const error = await left.request('add', { a: 1, b: 1 }).catch((e: unknown) => e) as RpcError
    expect(error.rpcCode).toBe(RPC_ERROR.methodNotFound)
  })

  it('delivers notifications to every listener', async () => {
    const { left, right } = pair()
    const seen: string[] = []
    const off = right.on('hello', ({ who }) => seen.push(`1:${who}`))
    right.on('hello', ({ who }) => seen.push(`2:${who}`))
    left.notify('hello', { who: 'a' })
    await new Promise(r => setTimeout(r, 0))
    off()
    left.notify('hello', { who: 'b' })
    await new Promise(r => setTimeout(r, 0))
    expect(seen).toEqual(['1:a', '2:a', '2:b'])
  })

  it('times out a request and ignores the late reply', async () => {
    vi.useFakeTimers()
    const sent: unknown[] = []
    const peer = new RpcPeer<AReq, ANote, AReq, ANote>({ defaultTimeoutMs: 50, send: m => sent.push(m) })
    const result = peer.request('slow', {}).catch((e: unknown) => e)
    await vi.advanceTimersByTimeAsync(60)
    const error = await result as RpcError
    expect(error.info.code).toBe('promptx/channel/timeout')
    // 迟到的回复直接丢弃，不抛异常
    peer.receive({ jsonrpc: '2.0', id: 1, result: {} })
  })

  it('fails pending and later requests once closed', async () => {
    const peer = new RpcPeer<AReq, ANote, AReq, ANote>({ defaultTimeoutMs: 1000, send: () => {} })
    const pending = peer.request('slow', {}).catch((e: unknown) => e)
    peer.close()
    expect(((await pending) as RpcError).info.code).toBe('promptx/channel/closed')
    const later = await peer.request('slow', {}).catch((e: unknown) => e) as RpcError
    expect(later.rpcCode).toBe(RPC_ERROR.channelClosed)
    expect(peer.closed).toBe(true)
  })

  it('fails a request immediately when the transport throws', async () => {
    const peer = new RpcPeer<AReq, ANote, AReq, ANote>({ defaultTimeoutMs: 1000, send: () => { throw new Error('EPIPE') } })
    const error = await peer.request('slow', {}).catch((e: unknown) => e) as RpcError
    expect(error.rpcCode).toBe(RPC_ERROR.channelClosed)
  })

  it('reports malformed messages as problems without throwing', () => {
    const problems: string[] = []
    const peer = new RpcPeer<AReq, ANote, AReq, ANote>({ defaultTimeoutMs: 1000, send: () => {}, onProblem: p => problems.push(p) })
    peer.receive(null)
    peer.receive({ jsonrpc: '1.0', method: 'x' })
    peer.receive({ jsonrpc: '2.0' })
    expect(problems).toEqual(['invalid-message', 'invalid-message', 'invalid-message'])
  })
})
