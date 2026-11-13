import { describe, expect, it } from 'vitest'
import { en, errorText, fieldErrorText, LOCALE_NS, zh } from '../../src/client/locale.ts'
import { ERROR_CODES } from '../../src/shared/errors.ts'
import type { ConfigFieldError } from '../../src/shared/types.ts'
import { tEn, tZh } from './fixtures.ts'

const placeholders = (text: string): string[] => [...text.matchAll(/\{(\w+)\}/g)].map(match => match[1]!).sort()

describe('配置页文案', () => {
  it('命名空间带 promptx 前缀（需求 7.10）', () => {
    expect(LOCALE_NS).toBe('promptx')
  })

  it('中英文的键一致', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort())
  })

  it('中英文的占位符一致，没有空文案', () => {
    for (const key of Object.keys(zh) as Array<keyof typeof zh>) {
      expect(placeholders(en[key]), key).toEqual(placeholders(zh[key]))
      expect(zh[key].trim(), key).not.toBe('')
      expect(en[key].trim(), key).not.toBe('')
    }
  })

  it('需求和方案里写定的原文', () => {
    expect(zh.companionWaitingRuntime).toBe('小窗正在准备')
    expect(zh.restartCompanion).toBe('重启小窗')
    expect(zh.showCompanion).toBe('显示小窗')
    expect(zh.openSettingsWindow).toBe('打开 PromptX 设置')
    expect(zh.save).toBe('保存')
    expect(zh.saving).toBe('保存中…')
    expect(zh.retry).toBe('重试')
    expect(zh.download).toBe('下载')
    expect(zh.deleteRuntime).toBe('删除运行时')
    expect(zh.record).toBe('录制')
    expect(zh.duplicateInstance).toContain('另一个 dsh 进程已在为这个 profile 运行 PromptX')
  })
})

describe('错误文案', () => {
  it('配置页会显示的错误码都有专门的文案', () => {
    const shown = ERROR_CODES.filter(code => /^promptx\/(runtime|companion|shortcut|settings|instance|channel)\//.test(code) || code === 'promptx/internal')
    for (const code of shown) expect(errorText(tZh, { code }), code).not.toContain(code)
  })

  it('detail 跟在后面', () => {
    expect(errorText(tZh, { code: 'promptx/shortcut/held-by-profile', detail: 'work' })).toBe('已被另一个 profile 的 PromptX 使用（work）')
    expect(errorText(tEn, { code: 'promptx/shortcut/system-conflict', detail: 'Spotlight' })).toBe('May conflict with a system shortcut (Spotlight)')
    expect(errorText(tZh, { code: 'promptx/runtime/download-failed', detail: '  ' })).toBe('下载失败，请检查网络')
  })

  it('不认识的错误码显示错误码本身', () => {
    expect(errorText(tZh, { code: 'promptx/future/thing' })).toBe('错误 promptx/future/thing')
  })

  it('每个字段错误码都有文案', () => {
    const codes: ConfigFieldError[] = ['library-dir-relative', 'library-dir-reserved', 'library-dir-skills', 'shortcut-invalid', 'value-invalid']
    const texts = codes.map(code => fieldErrorText(tZh, code))
    expect(new Set(texts).size).toBe(codes.length)
    expect(fieldErrorText(tEn, 'library-dir-skills')).toContain('skills folder')
  })
})
