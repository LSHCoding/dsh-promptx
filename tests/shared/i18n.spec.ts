import { describe, it, expect } from 'vitest'
import { ERROR_CODES } from '../../src/shared/errors.ts'
import {
  describeError,
  errnoMessage,
  errorMessage,
  errorReason,
  format,
  isMessageKey,
  MESSAGE_KEYS,
  placeholdersOf,
  relativeTime,
  resolveLocale,
  translate,
} from '../../src/shared/i18n/index.ts'
import { en } from '../../src/shared/i18n/en.ts'
import { zh } from '../../src/shared/i18n/zh.ts'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const NOW = Date.UTC(2026, 10, 8, 12, 0, 0)

describe('两份字典', () => {
  it('键完全一致', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort())
    expect(MESSAGE_KEYS.length).toBe(Object.keys(zh).length)
  })

  it('每一条的占位符完全一致', () => {
    for (const key of MESSAGE_KEYS) {
      expect(placeholdersOf(en[key]), key).toEqual(placeholdersOf(zh[key]))
    }
  })

  it('没有空文案', () => {
    for (const key of MESSAGE_KEYS) {
      expect(zh[key].trim(), key).not.toBe('')
      expect(en[key].trim(), key).not.toBe('')
    }
  })

  it('每个错误码都有中英文文案（键为 error.<code>）', () => {
    for (const code of ERROR_CODES) {
      const key = `error.${code}`
      expect(isMessageKey(key), key).toBe(true)
    }
  })

  it('除了内部错误本身，每个错误码都有自己的说法，不会落到「内部错误」', () => {
    for (const code of ERROR_CODES) {
      if (code === 'promptx/internal') continue
      expect(errorMessage('zh', code), code).not.toBe(zh['error.promptx/internal'])
      expect(errorMessage('en', code), code).not.toBe(en['error.promptx/internal'])
    }
  })

  it('需求原文逐字使用（S-03、技术方案 8.1）', () => {
    expect(zh['editor.placeholder']).toBe('输入 Prompt，支持 Markdown。')
    expect(zh['editor.loading']).toBe('正在载入草稿…')
    expect(zh['toast.copied']).toBe('已复制。')
    expect(zh['toast.nothingToCopy']).toBe('没有可复制的内容。')
    expect(translate('zh', 'toast.copyFailed', { reason: '原因' })).toBe('复制失败：原因')
    expect(translate('zh', 'status.draftSaveFailed', { reason: '原因' })).toBe('草稿保存失败：原因')
    expect(zh['toast.cleared']).toBe('已清空编辑器。')
    expect(translate('zh', 'toast.clearedBound', { title: '代码审查' })).toBe('已清空编辑器，库中《代码审查》未改动。')
    expect(zh['toast.nothingToSave']).toBe('没有可保存的内容。')
    expect(zh['toast.saved']).toBe('Prompt 已保存。')
    expect(zh['toast.savedPartial']).toBe('已保存提交时的内容，后续输入尚未保存。')
    expect(translate('zh', 'toast.editing', { title: 'A' })).toBe('正在编辑库中 Prompt：A')
    expect(translate('zh', 'toast.inserted', { title: 'A' })).toBe('已插入：A')
    expect(translate('zh', 'toast.nothingToInsert', { title: 'A' })).toBe('《A》没有正文可插入。')
    expect(zh['toast.bodyCopied']).toBe('已复制正文。')
    expect(zh['toast.movedToTrash']).toBe('Prompt 已移入回收站。')
    expect(translate('zh', 'toast.restored', { path: '写作/a.md' })).toBe('已恢复到：写作/a.md')
    expect(zh['toast.nothingToOptimize']).toBe('没有可优化的内容。')
    expect(zh['toast.optimizeCancelled']).toBe('已取消优化。')
    expect(zh['toast.optimizeApplied']).toBe('已应用优化。')
    expect(zh['toast.optimizeReturned']).toBe('优化结果已返回。')
    expect(zh['toast.candidateCopied']).toBe('候选已复制。')
    expect(zh['toast.candidateStale']).toBe('该候选已过期，请重新生成。')
    expect(translate('zh', 'status.optimizing', { model: 'M' })).toBe('正在用 M 优化，可继续编辑。')
    expect(zh['error.promptx/optimize/no-model']).toBe('dsh 里还没有可用的模型，请先在 dsh 设置中配置模型。')
    expect(translate('zh', 'library.unavailable', { reason: 'R' })).toBe('库目录不可用：R')
    expect(zh['library.openSettings']).toBe('打开插件配置')
    expect(zh['library.empty']).toBe('还没有保存的 Prompt')
    expect(zh['library.noMatch']).toBe('没有匹配的 Prompt')
    expect(zh['library.searchPlaceholder']).toBe('搜索 Prompt')
    expect(zh['library.selectHint']).toBe('选择一个 Prompt 查看内容')
    expect(zh['library.untitled']).toBe('未命名 Prompt')
    expect(zh['dialog.unsaved.title']).toBe('当前编辑器有未保存的内容')
    expect(translate('zh', 'dialog.unsaved.message', { title: '代码审查清单' })).toBe('载入「代码审查清单」会替换当前编辑器内容，要先怎么处理？')
    expect(zh['dialog.frontMatter.title']).toBe('为这个 Markdown 文件补上 Prompt 信息？')
    expect(zh['dialog.frontMatter.message']).toBe('保存会在文件开头加入 id、title、created、updated 字段，正文按你的编辑写入。取消则不改动原文件。')
    expect(zh['dialog.modified.title']).toBe('文件已被外部修改')
    expect(zh['dialog.modified.message']).toBe('磁盘上的新内容没有被覆盖。可以重新载入磁盘版本（当前编辑内容会被替换），或把当前编辑内容另存为新 Prompt。')
    expect(translate('zh', 'dialog.missing.message', { title: 'A' })).toBe('「A」的文件已被删除或移走。')
    expect(zh['dialog.metaModified.title']).toBe('文件已被外部修改，刷新后可以重新操作。')
    expect(zh['dialog.delete.title']).toBe('删除 Prompt？')
    expect(zh['dialog.delete.message']).toBe('删除后移入回收站，可以在回收站恢复。编辑器里的内容不会改变。')
    expect(zh['dialog.occupied.title']).toBe('原路径已被占用')
    expect(translate('zh', 'dialog.occupied.message', { path: 'a-2.md' })).toBe('将恢复到：a-2.md。原位置的文件不会被覆盖。')
    expect(zh['dialog.optimizeModified.title']).toBe('草稿在优化期间已经修改')
    expect(zh['dialog.optimizeModified.message']).toBe('应用候选会替换当前的手工编辑。')
    expect(zh['dialog.rename.tagsHint']).toBe('用逗号分隔，最多 5 个')
  })
})

describe('translate / format', () => {
  it('按 {名字} 替换占位符，数字也可以', () => {
    expect(translate('zh', 'status.withChars', { status: '未保存', count: 309 })).toBe('未保存 · 309 字符')
    expect(translate('en', 'status.withChars', { status: 'Unsaved', count: 309 })).toBe('Unsaved · 309 chars')
  })

  it('漏传的参数原样留着，界面上能看出来', () => {
    expect(format('复制失败：{reason}', {})).toBe('复制失败：{reason}')
    expect(format('没有占位符')).toBe('没有占位符')
  })

  it('isMessageKey 只认字典里有的键', () => {
    expect(isMessageKey('toast.copied')).toBe(true)
    expect(isMessageKey('toast.nope')).toBe(false)
    expect(isMessageKey('toString')).toBe(false)
  })
})

describe('resolveLocale', () => {
  it('以 zh 开头的是中文，其余都是英文', () => {
    expect(resolveLocale('zh')).toBe('zh')
    expect(resolveLocale('zh-CN')).toBe('zh')
    expect(resolveLocale('ZH-tw')).toBe('zh')
    expect(resolveLocale('en-US')).toBe('en')
    expect(resolveLocale('ja')).toBe('en')
    expect(resolveLocale(null)).toBe('en')
    expect(resolveLocale(undefined)).toBe('en')
  })
})

describe('relativeTime', () => {
  it('不到 1 分钟是刚刚', () => {
    expect(relativeTime(NOW, NOW, 'zh')).toBe('刚刚')
    expect(relativeTime(NOW - 59_000, NOW, 'zh')).toBe('刚刚')
    expect(relativeTime(NOW - 59_000, NOW, 'en')).toBe('just now')
  })

  it('分钟、小时、天', () => {
    expect(relativeTime(NOW - MINUTE, NOW, 'zh')).toBe('1 分钟前')
    expect(relativeTime(NOW - 59 * MINUTE, NOW, 'zh')).toBe('59 分钟前')
    expect(relativeTime(NOW - HOUR, NOW, 'zh')).toBe('1 小时前')
    expect(relativeTime(NOW - 3 * HOUR - 5 * MINUTE, NOW, 'zh')).toBe('3 小时前')
    expect(relativeTime(NOW - DAY, NOW, 'zh')).toBe('1 天前')
    expect(relativeTime(NOW - 30 * DAY, NOW, 'zh')).toBe('30 天前')
  })

  it('英文区分单复数', () => {
    expect(relativeTime(NOW - MINUTE, NOW, 'en')).toBe('1 minute ago')
    expect(relativeTime(NOW - 2 * MINUTE, NOW, 'en')).toBe('2 minutes ago')
    expect(relativeTime(NOW - HOUR, NOW, 'en')).toBe('1 hour ago')
    expect(relativeTime(NOW - 5 * HOUR, NOW, 'en')).toBe('5 hours ago')
    expect(relativeTime(NOW - DAY, NOW, 'en')).toBe('1 day ago')
    expect(relativeTime(NOW - 3 * DAY, NOW, 'en')).toBe('3 days ago')
  })

  it('时间在将来或不是数字时也显示刚刚，不出现负数', () => {
    expect(relativeTime(NOW + HOUR, NOW, 'zh')).toBe('刚刚')
    expect(relativeTime(Number.NaN, NOW, 'zh')).toBe('刚刚')
  })

  it('回收站的「N 天前删除」', () => {
    expect(translate('zh', 'trash.deletedAgo', { time: relativeTime(NOW - 3 * DAY, NOW, 'zh') })).toBe('3 天前删除')
    expect(translate('en', 'trash.deletedAgo', { time: relativeTime(NOW - 3 * DAY, NOW, 'en') })).toBe('Deleted 3 days ago')
  })
})

describe('系统错误', () => {
  it('认识的系统错误名换成一句原因', () => {
    expect(errnoMessage('zh', 'EACCES: permission denied, open \'/x/a.md\'')).toBe('没有权限')
    expect(errnoMessage('zh', 'EPERM: operation not permitted')).toBe('没有权限')
    expect(errnoMessage('zh', 'ENOSPC: no space left on device')).toBe('磁盘空间不足')
    expect(errnoMessage('zh', 'EROFS: read-only file system')).toBe('只读文件系统')
    expect(errnoMessage('zh', 'ENOENT: no such file or directory')).toBe('文件或文件夹不存在')
    expect(errnoMessage('zh', 'EBUSY: resource busy or locked')).toBe('文件正被占用')
    expect(errnoMessage('en', 'EACCES: permission denied')).toBe('permission denied')
    expect(errnoMessage('zh', 'EACCES')).toBe('没有权限')
  })

  it('不认识的错误名或普通文字返回 null', () => {
    expect(errnoMessage('zh', 'EWHATEVER: something')).toBeNull()
    expect(errnoMessage('zh', 'rate limited by upstream')).toBeNull()
    expect(errnoMessage('zh', 'EACCESS denied')).toBeNull()
  })

  it('describeError：错误码的文案后附上原因；认识的系统错误换成说法，其余原样附上', () => {
    expect(describeError('zh', { code: 'promptx/library/write-failed' })).toBe('写入文件失败')
    expect(describeError('zh', { code: 'promptx/library/write-failed', detail: 'EACCES: permission denied' })).toBe('写入文件失败（没有权限）')
    expect(describeError('zh', { code: 'promptx/optimize/failed', detail: 'upstream said no' })).toBe('优化失败（upstream said no）')
    expect(describeError('en', { code: 'promptx/library/write-failed', detail: 'ENOSPC: no space' })).toBe('Couldn\'t write the file (not enough disk space)')
  })

  it('不认识的错误码按内部错误显示', () => {
    expect(errorMessage('zh', 'promptx/unknown/thing')).toBe('内部错误')
    expect(describeError('en', { code: 'promptx/unknown/thing' })).toBe('Internal error')
  })

  it('errorReason：认识的系统错误直接说原因，不重复外层提示的意思', () => {
    expect(errorReason('zh', { code: 'promptx/library/write-failed', detail: 'EACCES: permission denied' })).toBe('没有权限')
    expect(translate('zh', 'toast.saveFailed', { reason: errorReason('zh', { code: 'promptx/library/write-failed', detail: 'ENOSPC: x' }) }))
      .toBe('保存失败：磁盘空间不足')
    expect(errorReason('zh', { code: 'promptx/clipboard/write-failed' })).toBe('写入剪贴板失败')
    expect(errorReason('zh', { code: 'promptx/optimize/failed', detail: 'boom' })).toBe('优化失败（boom）')
  })
})
