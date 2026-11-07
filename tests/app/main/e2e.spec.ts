import { describe, expect, it } from 'vitest'
import type { ClipboardLike } from '../../../src/app/main/clipboard.ts'
import {
  MAX_TYPING_SIZE,
  parseE2eCommand,
  runE2eCommand,
  sampleDraft,
  type CopyTiming,
  type E2eDeps,
  type RendererE2eRequest,
} from '../../../src/app/main/e2e.ts'
import type { E2eRendererResult } from '../../../src/app/main/ipc.ts'
import { trapProcessErrors } from './helpers.ts'

trapProcessErrors()

class FakeClipboard implements ClipboardLike {
  text = 'what the user had copied'
  writes: string[] = []

  writeText(text: string): Promise<void> {
    this.writes.push(text)
    this.text = text
    return Promise.resolve()
  }

  readText(): Promise<string> {
    return Promise.resolve(this.text)
  }
}

/**
 * 假的主进程环境：一个时钟、一扇窗、一个按 action 回应的渲染进程。core-path 的回应模拟渲染进程走「复制并隐藏」：
 * 主进程收到复制请求、写剪贴板、核对、隐藏，每一步推进时钟。
 */
class Harness implements E2eDeps {
  visible = false
  focused = false
  clock = 0
  readonly clipboard = new FakeClipboard()
  readonly requests: RendererE2eRequest[] = []
  readonly shows: string[] = []
  readonly hides: string[] = []
  timing: CopyTiming = { requestedAt: null, verifiedAt: null, hiddenAt: null }
  /** 渲染进程的回应；返回 null 表示没有回应（超时）。 */
  respond: (request: RendererE2eRequest) => E2eRendererResult | null = request => this.defaultRespond(request)
  focusOnShow = true
  copyBreaksClipboard = false

  isVisible(): boolean {
    return this.visible
  }

  show(reason: string): void {
    this.shows.push(reason)
    this.clock += 8
    this.visible = true
    if (this.focusOnShow) this.focused = true
  }

  hide(reason: string): void {
    this.hides.push(reason)
    this.visible = false
    this.focused = false
    this.timing = { ...this.timing, hiddenAt: this.clock }
  }

  waitForFocus(): Promise<boolean> {
    return Promise.resolve().then(() => this.focused)
  }

  waitForHidden(): Promise<boolean> {
    return Promise.resolve(!this.visible)
  }

  askRenderer(request: RendererE2eRequest): Promise<E2eRendererResult | null> {
    this.requests.push(request)
    this.clock += 2
    return Promise.resolve(this.respond(request))
  }

  now(): number {
    return this.clock
  }

  copyTiming(): CopyTiming {
    return { ...this.timing }
  }

  state(): Record<string, unknown> {
    return { visible: this.visible, booted: true }
  }

  defaultRespond(request: RendererE2eRequest): E2eRendererResult | null {
    switch (request.action) {
      case 'core-path': {
        this.timing = { requestedAt: this.clock, verifiedAt: null, hiddenAt: this.timing.hiddenAt }
        this.clock += 5
        this.clipboard.text = this.copyBreaksClipboard ? 'something else' : request.text ?? ''
        this.timing = { ...this.timing, verifiedAt: this.clock }
        this.clock += 1
        this.hide('copy')
        return { ok: true, data: { copyMs: 6 } }
      }
      case 'save-to-library':
        this.clock += 40
        return { ok: true, data: { outcome: 'saved', relPath: 'e2e.md' } }
      case 'typing-latency':
        return { ok: true, data: { ms: 12, length: request.text?.length ?? -1, size: request.size ?? -1 } }
      case 'state':
        return { ok: true, data: { draftLoaded: true } }
      default:
        return { ok: false, data: { error: 'unknown-action' } }
    }
  }
}

const TEXT = '# 写作助手\n\n## 要求\n\n- 第一项\n    - 缩进的子项\n'

describe('parseE2eCommand', () => {
  it('accepts the commands the companion handles', () => {
    expect(parseE2eCommand({ action: 'core-path', text: 'x' })).toEqual({ action: 'core-path', text: 'x' })
    expect(parseE2eCommand({ action: 'save-to-library' })).toEqual({ action: 'save-to-library' })
    expect(parseE2eCommand({ action: 'state', extra: 1 })).toEqual({ action: 'state' })
    expect(parseE2eCommand({ action: 'typing-latency', size: 100_000 })).toEqual({ action: 'typing-latency', size: 100_000 })
  })

  it('rejects malformed commands and the ones the Host handles itself', () => {
    expect(parseE2eCommand(null)).toBeNull()
    expect(parseE2eCommand({ action: 'core-path' })).toBeNull()
    expect(parseE2eCommand({ action: 'host-read', relPath: 'a.md' })).toBeNull()
    expect(parseE2eCommand({ action: 'typing-latency', size: -1 })).toBeNull()
    expect(parseE2eCommand({ action: 'typing-latency', size: 1.5 })).toBeNull()
    expect(parseE2eCommand({ action: 'typing-latency', size: MAX_TYPING_SIZE + 1 })).toBeNull()
    expect(parseE2eCommand({ action: 'delete-everything' })).toBeNull()
  })
})

describe('sampleDraft', () => {
  it('produces exactly the requested length with mixed Chinese and English lines', () => {
    for (const size of [0, 1, 99, 100_000]) expect(sampleDraft(size)).toHaveLength(size)
    expect(sampleDraft(200)).toMatch(/草稿/)
    expect(sampleDraft(200)).toMatch(/\n- /)
  })
})

describe('runE2eCommand: core-path', () => {
  it('shows from hidden, copies and hides, verifies the clipboard and restores it', async () => {
    const harness = new Harness()
    const result = await runE2eCommand({ action: 'core-path', text: TEXT }, harness)
    expect(result).toEqual({
      ok: true,
      data: {
        showMs: 10,
        readyMs: 10,
        copyToHiddenMs: 6,
        focused: true,
        rendererAck: true,
        hidden: true,
        clipboardMatches: true,
        clipboardBeforeHide: true,
        renderer: { copyMs: 6 },
      },
    })
    // 先确认渲染进程处理完显示事件，再让它走核心路径。
    expect(harness.requests.map(request => request.action)).toEqual(['state', 'core-path'])
    expect(harness.requests[1]).toEqual({ action: 'core-path', text: TEXT })
    expect(harness.clipboard.text).toBe('what the user had copied')
    expect(harness.clipboard.writes).toEqual(['what the user had copied'])
  })

  it('hides a visible window first so the show time is measured from hidden', async () => {
    const harness = new Harness()
    harness.visible = true
    harness.focused = true
    await runE2eCommand({ action: 'core-path', text: TEXT }, harness)
    expect(harness.hides[0]).toBe('e2e')
    expect(harness.shows).toEqual(['e2e'])
  })

  it('fails when the clipboard does not hold the text, and still restores it', async () => {
    const harness = new Harness()
    harness.copyBreaksClipboard = true
    const result = await runE2eCommand({ action: 'core-path', text: TEXT }, harness)
    expect(result.ok).toBe(false)
    expect(result.data.clipboardMatches).toBe(false)
    expect(harness.clipboard.text).toBe('what the user had copied')
  })

  it('reports a missing keyboard focus without failing (recent macOS refuses focus to script-initiated shows)', async () => {
    const harness = new Harness()
    harness.focusOnShow = false
    const result = await runE2eCommand({ action: 'core-path', text: TEXT }, harness)
    expect(result.ok).toBe(true)
    expect(result.data.focused).toBe(false)
    expect(typeof result.data.readyMs).toBe('number')
  })

  it('fails when the renderer does not answer, without a copy-to-hidden time', async () => {
    const harness = new Harness()
    harness.respond = () => null
    const result = await runE2eCommand({ action: 'core-path', text: TEXT }, harness)
    expect(result.ok).toBe(false)
    expect(result.data).toMatchObject({
      rendererAck: false,
      hidden: false,
      copyToHiddenMs: null,
      clipboardBeforeHide: false,
      renderer: null,
    })
  })

  it('reports a hide that came before the clipboard was verified', async () => {
    const harness = new Harness()
    harness.respond = (request) => {
      if (request.action !== 'core-path') return harness.defaultRespond(request)
      harness.timing = { requestedAt: harness.clock, verifiedAt: null, hiddenAt: null }
      harness.hide('copy')
      harness.clock += 3
      harness.clipboard.text = request.text ?? ''
      harness.timing = { ...harness.timing, verifiedAt: harness.clock }
      return { ok: true, data: {} }
    }
    const result = await runE2eCommand({ action: 'core-path', text: TEXT }, harness)
    expect(result.ok).toBe(false)
    expect(result.data.clipboardBeforeHide).toBe(false)
  })

  it('compares the clipboard ignoring CRLF conversions', async () => {
    const harness = new Harness()
    harness.respond = (request) => {
      const result = harness.defaultRespond(request)
      if (request.action === 'core-path') harness.clipboard.text = TEXT.replace(/\n/g, '\r\n')
      return result
    }
    expect((await runE2eCommand({ action: 'core-path', text: TEXT }, harness)).data.clipboardMatches).toBe(true)
  })
})

describe('runE2eCommand: other commands', () => {
  it('times save-to-library and passes the renderer data through', async () => {
    const harness = new Harness()
    expect(await runE2eCommand({ action: 'save-to-library' }, harness)).toEqual({
      ok: true,
      data: { ms: 42, outcome: 'saved', relPath: 'e2e.md' },
    })
  })

  it('reports a save that the renderer never answered', async () => {
    const harness = new Harness()
    harness.respond = () => null
    expect(await runE2eCommand({ action: 'save-to-library' }, harness)).toMatchObject({
      ok: false,
      error: { code: 'promptx/channel/timeout' },
    })
  })

  it('sends a generated draft of the requested size for typing-latency, with the window shown', async () => {
    const harness = new Harness()
    const result = await runE2eCommand({ action: 'typing-latency', size: 100_000 }, harness)
    expect(result).toEqual({ ok: true, data: { ms: 12, length: 100_000, size: 100_000 } })
    expect(harness.shows).toEqual(['e2e'])
    // 原来是隐藏的，量完再藏回去。
    expect(harness.hides).toEqual(['e2e'])
  })

  it('leaves a visible window visible after typing-latency', async () => {
    const harness = new Harness()
    harness.visible = true
    await runE2eCommand({ action: 'typing-latency', size: 10 }, harness)
    expect(harness.shows).toEqual([])
    expect(harness.hides).toEqual([])
  })

  it('combines the main process and renderer state', async () => {
    const harness = new Harness()
    expect(await runE2eCommand({ action: 'state' }, harness)).toEqual({
      ok: true,
      data: { visible: false, booted: true, renderer: { draftLoaded: true } },
    })
    harness.respond = () => null
    expect((await runE2eCommand({ action: 'state' }, harness)).data.renderer).toBeNull()
  })

  it('answers unsupported commands with an error instead of throwing', async () => {
    const harness = new Harness()
    expect(await runE2eCommand({ action: 'host-read', relPath: 'x.md' }, harness)).toEqual({
      ok: false,
      data: {},
      error: { code: 'promptx/internal', detail: 'unsupported e2e command' },
    })
    expect(harness.requests).toEqual([])
  })
})
