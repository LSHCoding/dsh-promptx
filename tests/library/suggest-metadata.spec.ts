import { describe, expect, it, vi } from 'vitest'
import { suggestPromptMetadata } from '../../src/library/suggest-metadata.ts'
import type { LlmChunk, LlmLike } from '../../src/services.ts'

function model(replies: string[]) {
  return vi.fn<LlmLike['stream']>(async function* () {
    const reply = replies.shift() ?? ''
    yield { type: 'text-delta', index: 0, text: reply.slice(0, 20) }
    yield { type: 'text-delta', index: 0, text: reply.slice(20) }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })
}

function options(stream: LlmLike['stream'], controller = new AbortController()) {
  return {
    getLlm: () => ({ stream, resolveModelInfo: () => Promise.resolve({ name: 'Test' }) }),
    getModel: () => ({ provider: 'test', model: 'metadata' }),
    hasTitle: vi.fn<(title: string) => Promise<boolean>>().mockResolvedValue(false),
    signal: controller.signal,
  }
}

describe('suggestPromptMetadata', () => {
  it('uses dsh streaming and keeps English phrases intact', async () => {
    const stream = model(['```json\n{"title":"代码审查指南","tags":["code review","CODE REVIEW","软件测试","bug triage"]}\n```'])
    const context = options(stream)
    await expect(suggestPromptMetadata('请审查代码', context)).resolves.toEqual({
      title: '代码审查指南', tags: ['Code Review', '软件测试', 'Bug Triage'],
    })
    expect(stream).toHaveBeenCalledOnce()
    expect(stream.mock.calls[0]?.[0]).toMatchObject({
      provider: 'test',
      model: 'metadata',
      purpose: 'promptx-library-metadata',
      messages: [{ role: 'user', content: [{ type: 'text', text: '请审查代码' }] }],
    })
    expect(context.hasTitle).toHaveBeenCalledWith('代码审查指南')
  })

  it('regenerates a duplicate, naming only the rejected suggestion', async () => {
    const stream = model(['{"title":"代码审查","tags":["code review"]}', '{"title":"审查边界条件","tags":["test design"]}'])
    const context = options(stream)
    context.hasTitle.mockResolvedValueOnce(true)
    await expect(suggestPromptMetadata('审查边界条件', context)).resolves.toEqual({ title: '审查边界条件', tags: ['Test Design'] })
    expect(stream.mock.calls[1]?.[0].system).toContain('["代码审查"]')
  })

  it('returns the manual fallback after three duplicate titles', async () => {
    const stream = model(Array.from({ length: 4 }, () => '{"title":"代码审查","tags":["测试"]}'))
    const context = options(stream)
    context.hasTitle.mockResolvedValue(true)
    await expect(suggestPromptMetadata('正文', context)).resolves.toBeNull()
    expect(stream).toHaveBeenCalledTimes(3)
  })

  it.each([
    'not JSON',
    JSON.stringify({ title: '长'.repeat(16), tags: ['写作'] }),
    JSON.stringify({ title: '标题', tags: [42] }),
    JSON.stringify({ title: '标题', tags: [] }),
  ])('falls back on unusable metadata (%s)', async (reply) => {
    const context = options(model([reply]))
    await expect(suggestPromptMetadata('正文', context)).resolves.toBeNull()
    expect(context.hasTitle).not.toHaveBeenCalled()
  })

  it('falls back on provider failure even after a complete JSON reply', async () => {
    const stream = async function* (): AsyncGenerator<LlmChunk> {
      yield { type: 'text-delta', index: 0, text: '{"title":"标题","tags":["写作"]}' }
      yield { type: 'finish', reason: { kind: 'error', failure: { code: 'TEST', message: 'private request detail' } } }
    }
    await expect(suggestPromptMetadata('正文', options(stream))).resolves.toBeNull()
  })

  it('falls back when no default model is configured', async () => {
    const stream = model([])
    await expect(suggestPromptMetadata('正文', { ...options(stream), getModel: () => undefined })).resolves.toBeNull()
    expect(stream).not.toHaveBeenCalled()
  })

  it('returns on host shutdown even if the provider does not settle', async () => {
    const controller = new AbortController()
    const stream = async function* (): AsyncGenerator<LlmChunk> {
      yield await new Promise<LlmChunk>(() => {})
    }
    const result = suggestPromptMetadata('正文', options(stream, controller))
    controller.abort()
    await expect(result).resolves.toBeNull()
  })
})
