import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FlushCoordinator } from '../../../src/app/main/flush.ts'
import { trapProcessErrors } from './helpers.ts'

trapProcessErrors()

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('FlushCoordinator', () => {
  it('sends a numbered flush and resolves when the renderer answers', async () => {
    const sent: number[] = []
    const flush = new FlushCoordinator({ send: id => sent.push(id) > 0 })
    const result = flush.flush(1500)
    expect(sent).toEqual([1])
    flush.flushed(1)
    await expect(result).resolves.toBe('flushed')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('gives up after the timeout so a stuck renderer cannot hold the exit', async () => {
    const flush = new FlushCoordinator({ send: () => true })
    const result = flush.flush(1500)
    await vi.advanceTimersByTimeAsync(1499)
    flush.flushed(99)
    await vi.advanceTimersByTimeAsync(1)
    await expect(result).resolves.toBe('flushed')

    const late = flush.flush(1500)
    await vi.advanceTimersByTimeAsync(1500)
    await expect(late).resolves.toBe('timeout')
    // 超时后的回应不再影响什么。
    flush.flushed(2)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('skips at once when the renderer is not ready (no draft to write)', async () => {
    const flush = new FlushCoordinator({ send: () => false })
    await expect(flush.flush(1500)).resolves.toBe('skipped')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('treats a throwing send as skipped', async () => {
    const flush = new FlushCoordinator({
      send: () => {
        throw new Error('webContents destroyed')
      },
    })
    await expect(flush.flush(1500)).resolves.toBe('skipped')
  })

  it('completes every earlier request with one answer, because the renderer always saves the latest text', async () => {
    const flush = new FlushCoordinator({ send: () => true })
    const first = flush.flush(1500)
    const second = flush.flush(1500)
    const third = flush.flush(1500)
    flush.flushed(2)
    await expect(first).resolves.toBe('flushed')
    await expect(second).resolves.toBe('flushed')
    await vi.advanceTimersByTimeAsync(1500)
    await expect(third).resolves.toBe('timeout')
  })

  it('does not let an answer that came before the request complete it', async () => {
    const flush = new FlushCoordinator({ send: () => true })
    flush.flushed(5)
    const pending = flush.flush(100)
    await vi.advanceTimersByTimeAsync(100)
    await expect(pending).resolves.toBe('timeout')
  })

  it('ends waiting requests as skipped on dispose and leaves no timers', async () => {
    const flush = new FlushCoordinator({ send: () => true })
    const pending = flush.flush(1500)
    flush.dispose()
    await expect(pending).resolves.toBe('skipped')
    expect(vi.getTimerCount()).toBe(0)
  })
})
