import { describe, expect, it } from 'vitest'
import {
  baseConfig,
  changedPatch,
  effectiveConfig,
  isLibraryDirAccepted,
  normalizeDraft,
  normalizeShortcut,
  pruneSettled,
  sameConfig,
  validatePatch,
  withField,
  withoutError,
  type Draft,
} from '../../src/client/form.ts'
import type { PromptxConfig } from '../../src/shared/types.ts'

const config: PromptxConfig = {
  libraryDir: '',
  confirmDelete: true,
  optimizeInstruction: '',
  globalShortcut: 'Control+P',
  hideOnBlur: false,
  runtimeSource: 'auto',
}

describe('暂存表单：显示的值和要提交的改动', () => {
  it('暂存的改动盖在 Host 的值上', () => {
    expect(effectiveConfig(config, { hideOnBlur: true, libraryDir: '/a' })).toEqual({ ...config, hideOnBlur: true, libraryDir: '/a' })
  })

  it('withField 返回新对象，不改原来的', () => {
    const draft: Draft = { libraryDir: '/a' }
    const next = withField(draft, 'hideOnBlur', true)
    expect(next).toEqual({ libraryDir: '/a', hideOnBlur: true })
    expect(draft).toEqual({ libraryDir: '/a' })
  })

  it('只提交和 Host 当前值不同的字段', () => {
    expect(changedPatch(config, {})).toEqual({})
    expect(changedPatch(config, { hideOnBlur: false, confirmDelete: false })).toEqual({ confirmDelete: false })
    expect(changedPatch(config, { optimizeInstruction: 'x', runtimeSource: 'mirror' })).toEqual({ optimizeInstruction: 'x', runtimeSource: 'mirror' })
  })

  it('比较前规范化：库目录去掉首尾空白，快捷键换成规范写法', () => {
    expect(changedPatch(config, { libraryDir: '   ', globalShortcut: ' control+p ' })).toEqual({})
    expect(changedPatch(config, { libraryDir: ' /a/b ', globalShortcut: 'ctrl+alt+k' })).toEqual({ libraryDir: '/a/b', globalShortcut: 'Control+Alt+K' })
    expect(normalizeDraft({ optimizeInstruction: '  keep spaces  ' })).toEqual({ optimizeInstruction: '  keep spaces  ' })
  })

  it('快捷键：合法时用规范写法，不合法时只去掉空白，空白算清空', () => {
    expect(normalizeShortcut('alt+ctrl+space')).toBe('Control+Alt+Space')
    expect(normalizeShortcut('  P ')).toBe('P')
    expect(normalizeShortcut('   ')).toBe('')
  })

  it('只有空白的优化指令和 Host 一样规范成空串；有内容的原样保留', () => {
    expect(normalizeDraft({ optimizeInstruction: ' \n\t ' })).toEqual({ optimizeInstruction: '' })
    expect(changedPatch({ ...config, optimizeInstruction: 'x' }, { optimizeInstruction: '   ' })).toEqual({ optimizeInstruction: '' })
    expect(changedPatch(config, { optimizeInstruction: '   ' })).toEqual({})
    expect(normalizeDraft({ optimizeInstruction: '\n 改写 \n' })).toEqual({ optimizeInstruction: '\n 改写 \n' })
  })
})

describe('暂存表单：保存成功后的基准', () => {
  it('sameConfig 逐字段比较', () => {
    expect(sameConfig(config, { ...config })).toBe(true)
    expect(sameConfig(config, { ...config, runtimeSource: 'official' })).toBe(false)
  })

  it('没有刚保存的值时基准就是 Host 的配置（同一个对象）', () => {
    expect(baseConfig(config, null)).toBe(config)
  })

  it('Host 的配置还和保存时一样：盖上刚保存的值', () => {
    const accepted = { base: config, values: { libraryDir: '/a', hideOnBlur: true } }
    expect(baseConfig({ ...config }, accepted)).toEqual({ ...config, libraryDir: '/a', hideOnBlur: true })
  })

  it('Host 的配置已经变了：以 Host 为准', () => {
    const accepted = { base: config, values: { libraryDir: '/a' } }
    const changed: PromptxConfig = { ...config, libraryDir: '/b' }
    expect(baseConfig(changed, accepted)).toBe(changed)
  })
})

describe('暂存表单：落定的暂存项', () => {
  it('和 Host 新值相同的暂存项去掉，其余保留', () => {
    const draft: Draft = { libraryDir: '/a', hideOnBlur: true }
    expect(pruneSettled(draft, { ...config, libraryDir: '/a' })).toEqual({ hideOnBlur: true })
  })

  it('没有可去掉的项时返回原对象', () => {
    const draft: Draft = { libraryDir: '/a' }
    expect(pruneSettled(draft, config)).toBe(draft)
    const empty: Draft = {}
    expect(pruneSettled(empty, config)).toBe(empty)
  })

  it('用原值比较：正在输入的结尾空格不会被吞掉', () => {
    const draft: Draft = { libraryDir: '/a/b ' }
    expect(pruneSettled(draft, { ...config, libraryDir: '/a/b' })).toBe(draft)
  })

  it('withoutError 去掉一个字段的错误；没有时原样返回', () => {
    const errors = { libraryDir: 'library-dir-reserved', globalShortcut: 'shortcut-invalid' } as const
    expect(withoutError(errors, 'libraryDir')).toEqual({ globalShortcut: 'shortcut-invalid' })
    expect(withoutError(errors, 'hideOnBlur')).toBe(errors)
  })
})

describe('暂存表单：页面自己能查出的错误', () => {
  it('库目录：相对路径不行，绝对路径和 ~ 开头可以，空串表示默认目录', () => {
    expect(validatePatch({ libraryDir: 'prompts' }, 'darwin')).toEqual({ libraryDir: 'library-dir-relative' })
    expect(validatePatch({ libraryDir: '~prompts' }, 'darwin')).toEqual({ libraryDir: 'library-dir-relative' })
    expect(validatePatch({ libraryDir: '/Users/me/Prompts' }, 'darwin')).toEqual({})
    expect(validatePatch({ libraryDir: '~/Prompts' }, 'linux')).toEqual({})
    expect(validatePatch({ libraryDir: '' }, 'darwin')).toEqual({})
  })

  it('库目录按运行 dsh 的电脑的平台判断', () => {
    expect(isLibraryDirAccepted('C:\\Prompts', 'win32')).toBe(true)
    expect(isLibraryDirAccepted('D:/Prompts', 'win32')).toBe(true)
    expect(isLibraryDirAccepted('\\\\server\\share', 'win32')).toBe(true)
    expect(isLibraryDirAccepted('~\\Prompts', 'win32')).toBe(true)
    expect(isLibraryDirAccepted('C:Prompts', 'win32')).toBe(false)
    expect(isLibraryDirAccepted('C:\\Prompts', 'darwin')).toBe(false)
    expect(isLibraryDirAccepted('~', 'linux')).toBe(true)
  })

  it('快捷键：不合法的组合不行，空串表示不注册', () => {
    expect(validatePatch({ globalShortcut: 'P' }, 'darwin')).toEqual({ globalShortcut: 'shortcut-invalid' })
    expect(validatePatch({ globalShortcut: 'Shift+P' }, 'darwin')).toEqual({ globalShortcut: 'shortcut-invalid' })
    expect(validatePatch({ globalShortcut: 'Control+' }, 'darwin')).toEqual({ globalShortcut: 'shortcut-invalid' })
    expect(validatePatch({ globalShortcut: 'Control+Alt+K' }, 'darwin')).toEqual({})
    expect(validatePatch({ globalShortcut: '' }, 'darwin')).toEqual({})
  })

  it('不在这次提交里的字段不检查（手改补丁文件写坏的值不拦别的字段保存）', () => {
    expect(validatePatch({ hideOnBlur: true }, 'darwin')).toEqual({})
  })
})
