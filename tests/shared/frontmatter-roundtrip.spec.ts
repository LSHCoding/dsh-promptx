import { describe, expect, it } from 'vitest'
import { parsePromptFile, patchFrontMatter, renderNewPromptFile } from '../../src/shared/frontmatter.ts'

// 审查意见 S11：新文件和每次写回都必须能被同一个解析器原样读回，否则会写出非法 YAML 或把自己的文件读错。
const TRICKY = [
  'Fix bug #123', '"Hello" world', '- 第一项', 'Note:', '{{task}}', '[draft] x', '*x', '| a |',
  'yes', 'No', 'on', 'null', '~', '123', '1.5', '2026-11-07', ' leading', 'trailing ', 'a: b', 'tab\there',
  '`code`', '@user', '%x', '!x', '&x', '?x', ',x', '>x', "it's", 'C#', '代码审查清单', '「引号」',
]

describe('front matter round trip', () => {
  it.each(TRICKY)('new file title %j reads back unchanged', (title) => {
    const text = renderNewPromptFile({ id: 'prompt_20261107_120000_1a2b3c4d', title, created: '2026-11-07T12:00:00Z', updated: '2026-11-07T12:00:00Z' }, 'body')
    const parsed = parsePromptFile(text)
    expect(parsed.frontMatter?.state).toBe('ok')
    expect(parsed.frontMatter?.fields.title).toBe(title)
  })

  it.each(TRICKY)('patched title and tag %j read back unchanged', (value) => {
    const base = renderNewPromptFile({ id: 'prompt_20261107_120000_1a2b3c4d', title: 'x', created: '2026-11-07T12:00:00Z', updated: '2026-11-07T12:00:00Z' }, 'body')
    const patched = patchFrontMatter(base, { title: value, tags: [value.trim() === '' ? 'x' : value.trim()] })
    expect(patched.ok).toBe(true)
    if (!patched.ok) return
    const parsed = parsePromptFile(patched.text)
    expect(parsed.frontMatter?.state).toBe('ok')
    expect(parsed.frontMatter?.fields.title).toBe(value)
    expect(parsed.frontMatter?.fields.tags).toEqual([value.trim() === '' ? 'x' : value.trim()])
  })
})
