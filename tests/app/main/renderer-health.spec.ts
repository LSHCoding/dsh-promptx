import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  RENDERER_CRASH_WINDOW_MS,
  RENDERER_FATAL_EXIT_CODE,
  RENDERER_UNRESPONSIVE_LIMIT_MS,
  RendererHealth,
  type FatalReason,
} from '../../../src/app/main/renderer-health.ts'
import { trapProcessErrors } from './helpers.ts'

trapProcessErrors()

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

function setup(): { health: RendererHealth; fatal: FatalReason[]; clock: { now: number } } {
  const fatal: FatalReason[] = []
  const clock = { now: 0 }
  const health = new RendererHealth({
    now: () => clock.now,
    onFatal: (reason) => {
      fatal.push(reason)
    },
  })
  return { health, fatal, clock }
}

describe('RendererHealth', () => {
  it('uses the design limits: 30 s between crashes, 10 s unresponsive, exit code 3', () => {
    expect(RENDERER_CRASH_WINDOW_MS).toBe(30_000)
    expect(RENDERER_UNRESPONSIVE_LIMIT_MS).toBe(10_000)
    expect(RENDERER_FATAL_EXIT_CODE).toBe(3)
  })

  it('ignores a clean exit', () => {
    const { health, fatal } = setup()
    expect(health.gone('clean-exit')).toBe('ignore')
    expect(health.healthy).toBe(true)
    expect(fatal).toEqual([])
  })

  it('reloads after the first crash and is unhealthy until the window reports ready again', () => {
    const { health } = setup()
    expect(health.gone('crashed')).toBe('reload')
    expect(health.healthy).toBe(false)
    health.recovered()
    expect(health.healthy).toBe(true)
  })

  it('gives up on a second crash within 30 seconds', () => {
    const { health, fatal, clock } = setup()
    health.gone('oom')
    clock.now += 30_000
    expect(health.gone('crashed')).toBe('fatal')
    expect(fatal).toEqual(['second-crash'])
    expect(health.healthy).toBe(false)
    // 已经判定退出后不再重复通知。
    expect(health.gone('crashed')).toBe('fatal')
    expect(fatal).toHaveLength(1)
  })

  it('reloads again when crashes are more than 30 seconds apart', () => {
    const { health, fatal, clock } = setup()
    health.gone('crashed')
    health.recovered()
    clock.now += 30_001
    expect(health.gone('killed')).toBe('reload')
    expect(fatal).toEqual([])
  })

  it('gives up when the window stays unresponsive for 10 seconds', () => {
    const { health, fatal } = setup()
    health.unresponsive()
    health.unresponsive()
    vi.advanceTimersByTime(9999)
    expect(fatal).toEqual([])
    vi.advanceTimersByTime(1)
    expect(fatal).toEqual(['unresponsive'])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('forgets an unresponsive period once the window responds again', () => {
    const { health, fatal } = setup()
    health.unresponsive()
    vi.advanceTimersByTime(5000)
    health.responsive()
    vi.advanceTimersByTime(20_000)
    expect(fatal).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('stops the unresponsive timer on a crash and on dispose', () => {
    const crash = setup()
    crash.health.unresponsive()
    crash.health.gone('crashed')
    expect(vi.getTimerCount()).toBe(0)

    const disposed = setup()
    disposed.health.unresponsive()
    disposed.health.dispose()
    vi.advanceTimersByTime(20_000)
    expect(disposed.fatal).toEqual([])
  })
})
