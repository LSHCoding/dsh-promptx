import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runTask, withTimeout } from '../../../src/app/main/tasks.ts'
import { EventWaiters, ReplyWaiters } from '../../../src/app/main/waiters.ts'
import { MemoryLogger, trapProcessErrors } from './helpers.ts'

trapProcessErrors()

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('ReplyWaiters', () => {
  it('resolves the waiter with the matching id', async () => {
    const waiters = new ReplyWaiters<string>()
    const id = waiters.nextId()
    const reply = waiters.wait(id, 1000)
    expect(waiters.resolve(id + 1, 'wrong')).toBe(false)
    expect(waiters.resolve(id, 'ok')).toBe(true)
    await expect(reply).resolves.toBe('ok')
    expect(waiters.resolve(id, 'again')).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('gives null on timeout and on dispose', async () => {
    const waiters = new ReplyWaiters<string>()
    const timedOut = waiters.wait(waiters.nextId(), 100)
    await vi.advanceTimersByTimeAsync(100)
    await expect(timedOut).resolves.toBeNull()
    const disposed = waiters.wait(waiters.nextId(), 100)
    waiters.dispose()
    await expect(disposed).resolves.toBeNull()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('hands out increasing ids', () => {
    const waiters = new ReplyWaiters<string>()
    expect([waiters.nextId(), waiters.nextId(), waiters.nextId()]).toEqual([1, 2, 3])
  })
})

describe('EventWaiters', () => {
  it('resolves every waiter of an event once', async () => {
    const waiters = new EventWaiters<'show' | 'hide'>()
    const first = waiters.wait('show', 1000)
    const second = waiters.wait('show', 1000)
    const other = waiters.wait('hide', 1000)
    waiters.emit('show')
    await expect(first).resolves.toBe(true)
    await expect(second).resolves.toBe(true)
    waiters.dispose()
    await expect(other).resolves.toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('gives false on timeout and ignores events nobody waits for', async () => {
    const waiters = new EventWaiters<'focus'>()
    waiters.emit('focus')
    const waiting = waiters.wait('focus', 50)
    await vi.advanceTimersByTimeAsync(50)
    await expect(waiting).resolves.toBe(false)
  })
})

describe('runTask', () => {
  it('logs a rejected task by label and error code', async () => {
    const logger = new MemoryLogger()
    runTask(logger, 'boot', Promise.reject(new Error('secret text')))
    await vi.advanceTimersByTimeAsync(0)
    expect(logger.entries).toEqual([{ level: 'warn', event: 'task.failed', fields: { task: 'boot', error: 'Error' } }])
  })

  it('logs a task function that throws synchronously', () => {
    const logger = new MemoryLogger()
    runTask(logger, 'sync', () => {
      throw new TypeError('boom')
    })
    expect(logger.entries[0]?.fields).toEqual({ task: 'sync', error: 'TypeError' })
  })

  it('does not throw when the logger itself throws', async () => {
    const logger = {
      warn: () => {
        throw new Error('logger broken')
      },
    }
    runTask(logger, 'x', Promise.reject(new Error('y')))
    await vi.advanceTimersByTimeAsync(0)
  })

  it('logs nothing for a task that succeeds', async () => {
    const logger = new MemoryLogger()
    runTask(logger, 'ok', () => Promise.resolve(1))
    await vi.advanceTimersByTimeAsync(0)
    expect(logger.entries).toEqual([])
  })
})

describe('withTimeout', () => {
  it('returns the value when it comes in time', async () => {
    await expect(withTimeout(Promise.resolve('value'), 100, 'fallback')).resolves.toBe('value')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('returns the fallback on timeout or rejection', async () => {
    const slow = withTimeout(new Promise<string>(() => {}), 100, 'fallback')
    await vi.advanceTimersByTimeAsync(100)
    await expect(slow).resolves.toBe('fallback')
    await expect(withTimeout(Promise.reject(new Error('x')), 100, 'fallback')).resolves.toBe('fallback')
  })
})
