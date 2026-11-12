import { describe, it, expect } from 'vitest'
import { TAG_COLOR_COUNT, tagColorIndex, tagHash } from '../../src/shared/tag-colors.ts'

describe('tagColorIndex：按标签名算出的色号', () => {
  it('色号固定：和设计稿 tag-palettes.html 里的示例一致，改哈希会让所有标签换色', () => {
    const sample = ['等待确认', 'PromptX', 'Bug修复', '提示词优化', 'Prompt工程', '代码', '审查', '写作', '翻译', '研究', '安全', '性能']
    expect(sample.map(tagColorIndex)).toEqual(sample.map(tag => tagHash(tag.toLowerCase()) % TAG_COLOR_COUNT))
    expect(Object.fromEntries(sample.map(tag => [tag, tagColorIndex(tag)]))).toEqual({
      '等待确认': 2, 'PromptX': 8, 'Bug修复': 7, '提示词优化': 4, 'Prompt工程': 9, '代码': 7,
      '审查': 5, '写作': 5, '翻译': 1, '研究': 7, '安全': 3, '性能': 9,
    })
  })

  it('同一个标签不论大小写、Unicode 组合形式，都是同一个颜色', () => {
    expect(tagColorIndex('Code Review')).toBe(tagColorIndex('code review'))
    expect(tagColorIndex('PROMPTX')).toBe(tagColorIndex('PromptX'))
    // é：预组合字符和「e + 组合重音符」。
    expect(tagColorIndex('caf\u00E9')).toBe(tagColorIndex('cafe\u0301'))
  })

  it('色号总在 0 到 TAG_COLOR_COUNT - 1 之间，空串也有颜色', () => {
    for (const tag of ['', 'a', '很长很长的标签名'.repeat(20), '🙂', 'Writing Guide']) {
      const index = tagColorIndex(tag)
      expect(Number.isInteger(index)).toBe(true)
      expect(index).toBeGreaterThanOrEqual(0)
      expect(index).toBeLessThan(TAG_COLOR_COUNT)
    }
  })

  it('分布大致均匀：1000 个不同的标签，每个颜色都用到，最多的一色不超过平均数的 1.5 倍', () => {
    const counts = Array.from({ length: TAG_COLOR_COUNT }, () => 0)
    for (let i = 0; i < 1000; i++) {
      const index = tagColorIndex(`标签${i}`)
      counts[index] = (counts[index] ?? 0) + 1
    }
    expect(Math.min(...counts)).toBeGreaterThan(0)
    expect(Math.max(...counts)).toBeLessThanOrEqual(150)
  })
})
