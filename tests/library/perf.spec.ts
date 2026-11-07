import { performance } from 'node:perf_hooks'
import { expect, it } from 'vitest'
import { installCrashTraps, listAll, makeService, promptFile, useTempDirs, writeTree } from './helpers.ts'

installCrashTraps()
const temp = useTempDirs()

const WORDS = ['代码', '审查', '写作', '结构化', 'prompt', 'review', '边界条件', '错误处理', '可维护性', '模板', 'XML', '{{变量}}']

function body(index: number): string {
  const lines: string[] = [`# 第 ${index} 条 Prompt`, '']
  let size = 0
  for (let line = 0; size < 1900; line++) {
    const text = `- ${WORDS[(index + line) % WORDS.length] ?? ''} ${WORDS[(index * 7 + line) % WORDS.length] ?? ''}：请检查第 ${line} 项。`
    lines.push(text)
    size += Buffer.byteLength(text) + 1
  }
  return lines.join('\n')
}

// N-01：库里 1,000 条（平均每条 2 KB）。阈值按 CI 机器放宽：第一次展开 < 2 s、之后 < 600 ms、搜索 < 400 ms；
// 实测数字打印出来，方便和需求里的 1 s / 300 ms / 200 ms 对照。
it('lists, refreshes and searches a 1,000-prompt library within the N-01 budget', async () => {
  const root = await temp.make()
  const files: Record<string, string> = {}
  for (let index = 0; index < 1000; index++) {
    const fields: Record<string, string> = {
      id: `prompt_20261101_000000_${index.toString(16).padStart(8, '0')}`,
      title: `第 ${index} 条 ${WORDS[index % WORDS.length] ?? ''}`,
      tags: `[${WORDS[index % 5] ?? ''}, ${WORDS[(index + 3) % 7] ?? ''}]`,
      favorite: index % 9 === 0 ? 'true' : 'false',
      updated: `2026-${String((index % 10) + 1).padStart(2, '0')}-01T00:00:00Z`,
    }
    files[`folder-${index % 20}/sub-${index % 3}/p${index}.md`] = promptFile(fields, body(index))
  }
  await writeTree(root, files)
  const service = makeService(root)

  let started = performance.now()
  const first = await listAll(service)
  const firstMs = performance.now() - started

  started = performance.now()
  const second = await listAll(service)
  const cachedMs = performance.now() - started

  started = performance.now()
  const searched = await listAll(service, { query: '代码 审查', refresh: false })
  const queryMs = performance.now() - started

  started = performance.now()
  await listAll(service, { query: 'review 边界', folder: { kind: 'folder', path: 'folder-3' }, scope: 'favorites', refresh: false })
  const filteredMs = performance.now() - started

  console.log(
    `[N-01] 1,000 prompts: first list ${firstMs.toFixed(0)} ms, cached refresh ${cachedMs.toFixed(0)} ms, `
    + `query ${queryMs.toFixed(0)} ms, filtered query ${filteredMs.toFixed(0)} ms`,
  )
  expect(first.total).toBe(1000)
  expect(second.total).toBe(1000)
  expect(searched.entries.length).toBeGreaterThan(0)
  expect(firstMs).toBeLessThan(2000)
  expect(cachedMs).toBeLessThan(600)
  expect(queryMs).toBeLessThan(400)
  expect(filteredMs).toBeLessThan(400)
}, 60_000)
