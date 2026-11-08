// 日志和错误里不出现 Prompt 内容（需求 N-02，testing-plan 第 3 节 tests/host/no-content-logs.spec.ts，审查 F7）。
// 模拟小程序用一个哨兵字符串走一遍草稿保存、库的新建、读取、收藏、改标题、过期绑定的保存、删除、回收站、
// 不存在的和越界的路径、搜索、优化（模拟模型，第二轮失败），收起时再写回一次草稿。
// 之后检查：Host 的全部日志（含 debug）、配置页的状态、返回给小程序的每个错误里都没有哨兵。

import { join } from 'node:path'
import type { Context, Message } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import type { LlmChunk } from '../../src/services.ts'
import { failOnProcessProblems } from '../companion/process-traps.ts'
import { cleanupHarnesses, setup, tempDir, waitFor } from './harness.ts'

failOnProcessProblems()

afterEach(async () => {
  await cleanupHarnesses()
})

const SECRET = 'SENTINEL-7f3a9c-内容'

/** 第一轮返回带哨兵的候选，之后的轮次以网络错误结束（错误信息本身不含内容）。 */
function fakeLlm() {
  let calls = 0
  return {
    async* stream(): AsyncGenerator<LlmChunk> {
      await Promise.resolve()
      calls += 1
      if (calls === 1) {
        yield { type: 'text-delta', index: 0, text: `Improved:\n\n\`\`\`prompt\n${SECRET} better\n\`\`\`\n` }
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
      }
      yield { type: 'finish', reason: { kind: 'error', failure: { code: 'TRANSPORT', message: 'socket hang up' } } }
    },
    resolveModelInfo: () => Promise.resolve({ name: 'Fake Model' }),
  }
}

function serialize(value: unknown): string {
  if (value instanceof Error) return `${value.name}: ${value.message}\n${value.stack ?? ''}`
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

describe.skipIf(process.platform === 'win32')('no prompt content in logs (N-02)', () => {
  it('keeps the sentinel out of Host logs, the config-page status and error details', async () => {
    const logs: string[] = []
    const library = join(await tempDir('promptx-host-library-'), 'library')
    const h = await setup({ typed: null, flush: `${SECRET} flush`, sweep: SECRET }, (ctx: Context) => {
      ctx.logger.exporter({
        levels: { default: 3 },
        export: (message: Message) => {
          logs.push(`${message.name} ${message.type} ${message.args.map(serialize).join(' ')}`)
        },
      })
      ctx.provide('llm', fakeLlm())
      ctx.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'fake', model: 'fake-1' }) })
    })
    const fiber = h.start({ libraryDir: library })
    await waitFor(async () => (await h.events()).some(line => line.endsWith(' sweep done')), 'sweep', 30_000)
    const status = JSON.stringify(await h.status())
    await fiber.dispose()

    const events = await h.events()
    const steps = events.filter(line => line.includes(' step '))
    // 每一步都真的走到了：该成功的成功，该失败的失败。
    for (const name of ['draft.save', 'library.save', 'library.read', 'favorite', 'rename', 'library.delete', 'trash.list', 'trash.read', 'trash.restore', 'library.list', 'optimize.start', 'optimize.followup', 'optimize.state']) {
      expect(steps.some(line => line.includes(` step ${name} ok`)), name).toBe(true)
    }
    for (const name of ['missing read', 'bad path', 'bad folder']) {
      expect(steps.some(line => line.includes(` step ${name} error `)), name).toBe(true)
    }
    expect(events.some(line => line.endsWith(' flush ok'))).toBe(true)

    for (const line of steps.filter(item => item.includes(' error '))) expect(line).not.toContain(SECRET)
    expect(status).not.toContain(SECRET)
    expect(logs.length).toBeGreaterThan(0)
    const leaked = logs.filter(line => line.includes(SECRET))
    expect(leaked).toEqual([])
  })
})
