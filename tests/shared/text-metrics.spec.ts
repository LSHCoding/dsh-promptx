import { describe, it, expect, vi, afterEach } from 'vitest'
import { countCharacters, isBlank } from '../../src/shared/text-metrics.ts'

describe('countCharacters', () => {
  it('空串是 0', () => {
    expect(countCharacters('')).toBe(0)
  })

  it('ASCII 按字符计', () => {
    expect(countCharacters('hello')).toBe(5)
  })

  it('一个汉字算 1 个', () => {
    expect(countCharacters('写作助手')).toBe(4)
  })

  it('码点超出 BMP 的汉字算 1 个', () => {
    // U+20BB7，UTF-16 里是两个代理项
    expect('𠮷'.length).toBe(2)
    expect(countCharacters('𠮷野家')).toBe(3)
  })

  it('一个 emoji 算 1 个，包括肤色、ZWJ 序列和国旗', () => {
    expect(countCharacters('😀')).toBe(1)
    expect(countCharacters('👍🏽')).toBe(1)
    expect(countCharacters('👨‍👩‍👧‍👦')).toBe(1)
    expect(countCharacters('🇨🇳')).toBe(1)
    expect(countCharacters('a😀b')).toBe(3)
  })

  it('带组合符号的字母算 1 个', () => {
    // e + U+0301 组合重音
    expect(countCharacters('é')).toBe(1)
    expect(countCharacters('café')).toBe(4)
  })

  it('换行和空白也计数', () => {
    expect(countCharacters('a\nb')).toBe(3)
    expect(countCharacters('  ')).toBe(2)
    expect(countCharacters('　')).toBe(1)
  })

  it('长文本计数正确', () => {
    expect(countCharacters('字'.repeat(100_000))).toBe(100_000)
  })
})

describe('countCharacters：没有 Intl.Segmenter 时', () => {
  const original = Intl.Segmenter

  afterEach(() => {
    Reflect.set(Intl, 'Segmenter', original)
    vi.resetModules()
  })

  it('退回按码点计数', async () => {
    Reflect.set(Intl, 'Segmenter', undefined)
    vi.resetModules()
    const fresh = await import('../../src/shared/text-metrics.ts')
    expect(fresh.countCharacters('写作𠮷')).toBe(3)
    expect(fresh.countCharacters('é')).toBe(2)
    expect(fresh.countCharacters('')).toBe(0)
  })
})

describe('isBlank', () => {
  it('空串是空白', () => {
    expect(isBlank('')).toBe(true)
  })

  it('空格、制表符、换行是空白', () => {
    expect(isBlank(' \t\n\r\n ')).toBe(true)
  })

  it('全角空格和不换行空格是空白', () => {
    expect(isBlank('　　')).toBe(true)
    expect(isBlank(' ')).toBe(true)
  })

  it('有任何可见字符就不是空白', () => {
    expect(isBlank(' a ')).toBe(false)
    expect(isBlank('　字')).toBe(false)
    expect(isBlank('😀')).toBe(false)
  })
})
