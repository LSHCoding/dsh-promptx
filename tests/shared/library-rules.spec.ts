import { describe, expect, it } from 'vitest'
import {
  DISPLAY_TITLE_MAX_CHARS,
  displayTitle,
  extractTitle,
  FILE_STEM_MAX_CHARS,
  fileNameCandidates,
  folderOf,
  formatIsoUtc,
  generatePromptId,
  isMarkdownFileName,
  makeFileStem,
  MAX_TAGS,
  newPromptTitle,
  normalizeRelPath,
  normalizeTags,
  parseTimestamp,
  splitRelPath,
  tagKey,
  TITLE_MAX_CHARS,
} from '../../src/shared/library-rules.ts'

/** 用户看到的字符数。 */
function graphemeCount(text: string): number {
  return Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)).length
}

function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length
}

const FAMILY = '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466}'

describe('extractTitle', () => {
  it('uses the first ATX heading without the # markers', () => {
    expect(extractTitle('# 代码审查\n\n检查边界条件。')).toBe('代码审查')
  })

  it('prefers a heading over earlier plain lines', () => {
    expect(extractTitle('intro line\n\n## Section title\nmore')).toBe('Section title')
  })

  it('recognizes heading levels 1 to 6 and up to three spaces of indentation', () => {
    expect(extractTitle('###### Six')).toBe('Six')
    expect(extractTitle('   # Indented')).toBe('Indented')
    expect(extractTitle('#\tTabbed')).toBe('Tabbed')
  })

  it('strips surrounding spaces and a closing # sequence', () => {
    expect(extractTitle('##   Title ##  ')).toBe('Title')
    expect(extractTitle('# Title #')).toBe('Title')
    expect(extractTitle('# C#')).toBe('C#')
    expect(extractTitle('# a # b')).toBe('a # b')
  })

  it.each([
    ['seven # signs', '####### Seven', '####### Seven'],
    ['no space after #', '#hashtag line', '#hashtag line'],
    ['four spaces of indentation', '    # code', '# code'],
  ])('does not treat %s as a heading', (_name, body, title) => {
    expect(extractTitle(body)).toBe(title)
  })

  it('ignores headings inside fenced code blocks', () => {
    expect(extractTitle('```bash\n# install deps\n```\n# Real')).toBe('Real')
    expect(extractTitle('~~~\n# x\n~~~\n# Real')).toBe('Real')
    expect(extractTitle('````\n```\n# x\n````\n# Real')).toBe('Real')
    expect(extractTitle('```\n# x\n```   \n# Real')).toBe('Real')
  })

  it('does not open a fence on a backtick line whose info string contains a backtick', () => {
    expect(extractTitle('``` a`b\n# Real')).toBe('Real')
  })

  it('falls back to the first non-empty line when there is no heading', () => {
    expect(extractTitle('\n\n   first line  \nsecond')).toBe('first line')
    expect(extractTitle('```bash\n# only in code\n```')).toBe('```bash')
  })

  it('skips empty headings', () => {
    expect(extractTitle('#\n\n## ##\n# Real')).toBe('Real')
    expect(extractTitle('#\n\n## \nHello')).toBe('Hello')
  })

  it('accepts CRLF and CR line breaks', () => {
    expect(extractTitle('first\r\n# Heading')).toBe('Heading')
    expect(extractTitle('one\rtwo')).toBe('one')
  })

  it('truncates to 40 user-visible characters by default', () => {
    expect(TITLE_MAX_CHARS).toBe(40)
    expect(extractTitle('x'.repeat(41))).toBe('x'.repeat(40))
    expect(extractTitle('标'.repeat(50))).toBe('标'.repeat(40))
    expect(extractTitle('x'.repeat(40))).toBe('x'.repeat(40))
  })

  it('never cuts an emoji or a combining sequence in half', () => {
    const families = extractTitle(FAMILY.repeat(41))
    expect(families).toBe(FAMILY.repeat(40))
    expect(extractTitle('e\u0301'.repeat(45))).toBe('e\u0301'.repeat(40))
    expect(graphemeCount(extractTitle(`# ${'😀a'.repeat(30)}`) ?? '')).toBe(40)
  })

  it('drops whitespace left at the end by truncation', () => {
    expect(extractTitle(`${'a'.repeat(39)} ${'b'.repeat(10)}`)).toBe('a'.repeat(39))
  })

  it('honours a custom limit and Infinity', () => {
    expect(extractTitle('# abcdef', 3)).toBe('abc')
    expect(extractTitle(`# ${'x'.repeat(100)}`, Infinity)).toBe('x'.repeat(100))
  })

  it.each(['', '   \n\t\n', '#\n##', '\n\n'])('returns null when %j has no text', (body) => {
    expect(extractTitle(body)).toBeNull()
  })
})

describe('newPromptTitle', () => {
  it('uses the extracted title, limited to 40 characters', () => {
    expect(newPromptTitle('# 标题\n正文', '未命名 Prompt')).toBe('标题')
    expect(newPromptTitle('y'.repeat(60), '未命名 Prompt')).toBe('y'.repeat(40))
  })

  it('falls back to the untitled text', () => {
    expect(newPromptTitle('   \n', '未命名 Prompt')).toBe('未命名 Prompt')
  })
})

describe('displayTitle', () => {
  it('uses the front matter title when it is not blank', () => {
    expect(displayTitle('  My Title ', '# Other', 'a.md')).toBe('My Title')
  })

  it.each([undefined, null, '', '   '])('extracts from the body beyond the 40-character limit for new prompts when the title is %j', (title) => {
    expect(displayTitle(title, `# ${'x'.repeat(60)}`, 'a.md')).toBe('x'.repeat(60))
  })

  it('caps a title taken from the body at 200 characters but keeps a front matter title whole (review SEC-01)', () => {
    expect(DISPLAY_TITLE_MAX_CHARS).toBe(200)
    // 第一行就有 2 MiB 的文件不会变成 2 MiB 的列表标题
    expect(displayTitle(undefined, 'x'.repeat(2 * 1024 * 1024), 'a.md')).toBe('x'.repeat(200))
    expect(displayTitle(null, `# ${'标'.repeat(300)}\n`, 'a.md')).toBe('标'.repeat(200))
    expect(displayTitle('y'.repeat(300), '', 'a.md')).toBe('y'.repeat(300))
  })

  it('falls back to the file name without .md', () => {
    expect(displayTitle(undefined, '', 'notes.md')).toBe('notes')
    expect(displayTitle('', '  \n', '写作/评审/评审意见.MD')).toBe('评审意见')
    expect(displayTitle(undefined, '', 'README')).toBe('README')
  })
})

// 审查 SEC-01、SEC-02：标题、围栏、标签两端的处理原来是平方级回溯的正则，一行里几万个空白就要几秒，
// 而它们在 Host 主线程上同步运行。这里用约 20 万个字符的对抗输入，阈值按 CI 机器放宽到 200 ms，实测时间打印出来。
describe('adversarial lines finish in linear time (review SEC-01, SEC-02)', () => {
  const N = 200_000

  function timed<T>(label: string, run: () => T): T {
    const started = performance.now()
    const result = run()
    const ms = performance.now() - started
    console.log(`[SEC-01/02] ${label}: ${ms.toFixed(1)} ms`)
    expect(ms).toBeLessThan(200)
    return result
  }

  it('a long run of blanks inside a heading', () => {
    expect(timed('heading with spaces', () => extractTitle(`# a${' '.repeat(N)}b`))).toBe('a')
    expect(timed('heading with spaces, no limit', () => extractTitle(`## a${' \t'.repeat(N / 2)}b`, Infinity))).toBe(`a${' \t'.repeat(N / 2)}b`)
    expect(timed('blank line then text', () => extractTitle(`${' '.repeat(N)}x`))).toBe('x')
  })

  it('closing # sequences after a long run of blanks', () => {
    expect(timed('closing hashes', () => extractTitle(`# a${' '.repeat(N)}###`))).toBe('a')
    expect(timed('hashes that do not close', () => extractTitle(`# a${' '.repeat(N)}#b`, Infinity))).toBe(`a${' '.repeat(N)}#b`)
    expect(timed('a heading of hashes only', () => extractTitle(`# ${'#'.repeat(N)}\n# Real`))).toBe('Real')
    expect(timed('a long # run inside the text', () => extractTitle(`# a${'#'.repeat(N)} b`, Infinity))).toBe(`a${'#'.repeat(N)} b`)
  })

  it('long fence-like lines', () => {
    // 含 U+2028、U+2029 的行原来不算围栏（`.` 不匹配它们），后面的标题照常认出来
    expect(timed('backticks then a line separator', () => extractTitle(`${'`'.repeat(N)}\u2028\n# Real`))).toBe('Real')
    expect(timed('tildes then a paragraph separator', () => extractTitle(`${'~'.repeat(N)}\u2029x\n# Real`))).toBe('Real')
    expect(timed('a long fence that is closed', () => extractTitle(`${'`'.repeat(N)}\n# inside\n${'`'.repeat(N)}\n# Real`))).toBe('Real')
    // 不是标题行，退回第一行文字，截到 40 个字符后去掉末尾空白
    expect(timed('a heading with a line separator', () => extractTitle(`# a${' '.repeat(N)}\u2028b`))).toBe('# a')
  })

  it('a long # run inside a tag', () => {
    const middle = `a${'#'.repeat(N)}b`
    expect(timed('tag with hashes inside', () => normalizeTags(middle))).toEqual([middle])
    expect(timed('tag with hash edges', () => normalizeTags([`${'＃'.repeat(N)}tag${'#'.repeat(N)}`]))).toEqual(['tag'])
  })
})

describe('makeFileStem', () => {
  it('replaces characters that are not allowed in file names', () => {
    expect(makeFileStem('a/b\\c:d*e?f"g<h>i|j')).toBe('a-b-c-d-e-f-g-h-i-j')
  })

  it('replaces line breaks, tabs and other control characters', () => {
    expect(makeFileStem('a\nb\rc\td\x00e\x7f')).toBe('a-b-c-d-e-')
  })

  it('keeps ordinary titles as they are', () => {
    expect(makeFileStem('代码审查清单')).toBe('代码审查清单')
    expect(makeFileStem('v1.0 release.')).toBe('v1.0 release.')
  })

  it('trims surrounding spaces', () => {
    expect(makeFileStem('  Title  ')).toBe('Title')
    expect(makeFileStem('\u3000全角空格\u3000')).toBe('全角空格')
  })

  it.each([
    ['.hidden', 'hidden'],
    ['...x', 'x'],
    ['. .x', 'x'],
    [' . x', 'x'],
  ])('removes leading dots from %j', (title, stem) => {
    expect(makeFileStem(title)).toBe(stem)
  })

  it.each(['', '   ', '...', ' . . '])('uses prompt when %j leaves nothing', (title) => {
    expect(makeFileStem(title)).toBe('prompt')
  })

  it('cuts to 60 characters and trims again', () => {
    expect(FILE_STEM_MAX_CHARS).toBe(60)
    expect(makeFileStem('a'.repeat(70))).toBe('a'.repeat(60))
    expect(makeFileStem('文'.repeat(70))).toBe('文'.repeat(60))
    expect(makeFileStem(`${'a'.repeat(59)} b`)).toBe('a'.repeat(59))
  })

  it('cuts by user-visible characters', () => {
    expect(makeFileStem('e\u0301'.repeat(70))).toBe('e\u0301'.repeat(60))
  })

  it('keeps long emoji titles within the file name byte limit without splitting them', () => {
    const stem = makeFileStem(FAMILY.repeat(70))
    expect(utf8Bytes(stem)).toBeLessThanOrEqual(200)
    expect(stem).toBe(FAMILY.repeat(8))
    expect(utf8Bytes(makeFileStem('😀'.repeat(70)))).toBe(200)
  })

  it('never starts with a dot or contains reserved characters', () => {
    for (const title of ['..//..', '.\\.', ' .:. ', '. / .', '\n.\n']) {
      const stem = makeFileStem(title)
      expect(stem.startsWith('.')).toBe(false)
      expect(stem).not.toMatch(/[/\\:*?"<>|\n\r\t]/)
      expect(stem.trim()).toBe(stem)
    }
  })
})

describe('generatePromptId', () => {
  it('formats the UTC time and four random bytes', () => {
    const now = new Date(Date.UTC(2026, 10, 7, 12, 0, 0))
    expect(generatePromptId(now, new Uint8Array([0x1a, 0x2b, 0x3c, 0x4d]))).toBe('prompt_20261107_120000_1a2b3c4d')
  })

  it('pads every part with zeros', () => {
    const now = new Date(Date.UTC(2026, 0, 2, 3, 4, 5))
    expect(generatePromptId(now, new Uint8Array([0x00, 0x01, 0xab, 0xff]))).toBe('prompt_20260102_030405_0001abff')
  })

  it('uses only the first four bytes', () => {
    const id = generatePromptId(new Date(0), new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))
    expect(id).toBe('prompt_19700101_000000_01020304')
    expect(id).toMatch(/^prompt_\d{8}_\d{6}_[0-9a-f]{8}$/)
  })

  it('throws when fewer than four bytes are given', () => {
    expect(() => generatePromptId(new Date(0), new Uint8Array(3))).toThrow(RangeError)
  })
})

describe('fileNameCandidates', () => {
  function take(iterable: Iterable<string>, count: number): string[] {
    const out: string[] = []
    for (const name of iterable) {
      out.push(name)
      if (out.length === count) break
    }
    return out
  }

  it('tries the stem, then the id suffix, then numbered variants', () => {
    expect(take(fileNameCandidates('写作', 'prompt_20261107_120000_1a2b3c4d'), 5)).toEqual([
      '写作.md',
      '写作-1a2b3c4d.md',
      '写作-1a2b3c4d-2.md',
      '写作-1a2b3c4d-3.md',
      '写作-1a2b3c4d-4.md',
    ])
  })

  it('is lazy and unbounded', () => {
    const names = take(fileNameCandidates('p', 'prompt_20261107_120000_1a2b3c4d'), 1000)
    expect(names).toHaveLength(1000)
    expect(names[999]).toBe('p-1a2b3c4d-999.md')
  })

  it('copes with short or empty ids', () => {
    expect(take(fileNameCandidates('p', 'abc'), 3)).toEqual(['p.md', 'p-abc.md', 'p-abc-2.md'])
    expect(take(fileNameCandidates('p', ''), 3)).toEqual(['p.md', 'p-2.md', 'p-3.md'])
  })
})

describe('normalizeTags', () => {
  it('handles the acceptance example', () => {
    expect(normalizeTags('写作，示例; 写作 #评审')).toEqual(['写作', '示例', '评审'])
  })

  it('splits on commas, semicolons, line breaks and whitespace', () => {
    expect(normalizeTags('a,b;c\nd\r\ne')).toEqual(['a', 'b', 'c', 'd', 'e'])
    expect(normalizeTags('a，b；c\u3000d\te')).toEqual(['a', 'b', 'c', 'd', 'e'])
  })

  it('strips #, commas and semicolons at both ends', () => {
    expect(normalizeTags('##a## ＃b＃ #c,')).toEqual(['a', 'b', 'c'])
    expect(normalizeTags('c#sharp')).toEqual(['c#sharp'])
  })

  it('deduplicates case-insensitively and keeps the first spelling', () => {
    expect(normalizeTags('Tag tag TAG other')).toEqual(['Tag', 'other'])
    expect(normalizeTags(['caf\u00e9', 'cafe\u0301'])).toEqual(['caf\u00e9'])
  })

  it('keeps at most five tags', () => {
    expect(MAX_TAGS).toBe(5)
    expect(normalizeTags('a b c d e f g')).toEqual(['a', 'b', 'c', 'd', 'e'])
    expect(normalizeTags('a a b b c c d d e e f')).toEqual(['a', 'b', 'c', 'd', 'e'])
  })

  it('splits every item of an array', () => {
    expect(normalizeTags(['a, b', 'c', 'A', '#d'])).toEqual(['a', 'b', 'c', 'd'])
  })

  it.each(['', '  , ; ', '###', '，；'])('returns no tags for %j', (input) => {
    expect(normalizeTags(input)).toEqual([])
  })

  it('returns no tags for an empty array', () => {
    expect(normalizeTags([])).toEqual([])
  })
})

describe('tagKey', () => {
  it('ignores case and Unicode composition', () => {
    expect(tagKey('ABC')).toBe(tagKey('abc'))
    expect(tagKey('Caf\u00e9')).toBe(tagKey('cafe\u0301'))
    expect(tagKey('a')).not.toBe(tagKey('b'))
  })
})

describe('normalizeRelPath', () => {
  it.each([
    ['a.md', 'a.md'],
    ['写作/评审/评审意见.md', '写作/评审/评审意见.md'],
    ['a\\b\\c.md', 'a/b/c.md'],
    ['a b/c d.md', 'a b/c d.md'],
    ['_trash/x.md', '_trash/x.md'],
  ])('accepts %j', (input, expected) => {
    expect(normalizeRelPath(input)).toBe(expected)
  })

  it.each([
    '',
    '/a.md',
    '\\a.md',
    '//server/share/a.md',
    'C:/a.md',
    'c:a.md',
    'C:\\a.md',
    'a//b.md',
    'a/',
    '.',
    '..',
    './a.md',
    '../a.md',
    'a/./b.md',
    'a/../b.md',
    'a\\..\\b.md',
    '.hidden/a.md',
    'a/.b.md',
    'a\0.md',
  ])('rejects %j', (input) => {
    expect(normalizeRelPath(input)).toBeNull()
  })
})

describe('isMarkdownFileName', () => {
  it.each(['a.md', 'A.MD', 'x.Md', '代码审查清单.md', 'a.b.md', 'line\nbreak.md'])('accepts %j', (name) => {
    expect(isMarkdownFileName(name)).toBe(true)
  })

  it.each(['.md', 'a.markdown', 'a.md.txt', 'amd', 'a.mdx', 'a.m'])('rejects %j', (name) => {
    expect(isMarkdownFileName(name)).toBe(false)
  })
})

describe('splitRelPath and folderOf', () => {
  it('splits root-level and nested paths', () => {
    expect(splitRelPath('a.md')).toEqual({ folder: '', name: 'a.md' })
    expect(splitRelPath('写作/评审/x.md')).toEqual({ folder: '写作/评审', name: 'x.md' })
    expect(folderOf('a.md')).toBe('')
    expect(folderOf('写作/x.md')).toBe('写作')
  })
})

describe('formatIsoUtc', () => {
  it('writes UTC without milliseconds', () => {
    expect(formatIsoUtc(new Date(Date.UTC(2026, 10, 7, 12, 0, 0, 123)))).toBe('2026-11-07T12:00:00Z')
    expect(formatIsoUtc(new Date(Date.UTC(2026, 0, 2, 3, 4, 5)))).toBe('2026-01-02T03:04:05Z')
  })

  it('round-trips through parseTimestamp', () => {
    const time = Date.UTC(2026, 5, 15, 8, 30, 45)
    expect(parseTimestamp(formatIsoUtc(new Date(time)))).toBe(time)
  })
})

describe('parseTimestamp', () => {
  const noonUtc = Date.UTC(2026, 10, 7, 12, 0, 0)

  it.each([
    '2026-11-07T12:00:00Z',
    '2026-11-07t12:00:00z',
    '2026-11-07T20:00:00+08:00',
    '2026-11-07T20:00:00+0800',
    '2026-11-07T20:00:00+08',
    '2026-11-07T07:00:00-05:00',
    '2026-11-07 12:00:00 Z',
    '2026-11-07  12:00:00Z',
    '2026-11-07T12:00Z',
    '  2026-11-07T12:00:00Z  ',
  ])('reads %j with a time zone', (value) => {
    expect(parseTimestamp(value)).toBe(noonUtc)
  })

  it('reads fractional seconds', () => {
    expect(parseTimestamp('2026-11-07T12:00:00.5Z')).toBe(noonUtc + 500)
    expect(parseTimestamp('2026-11-07T12:00:00.123456Z')).toBe(noonUtc + 123)
  })

  it('reads values without a time zone as local time', () => {
    const localNoon = new Date(2026, 10, 7, 12, 0, 0).getTime()
    expect(parseTimestamp('2026-11-07T12:00:00')).toBe(localNoon)
    expect(parseTimestamp('2026-11-07 12:00:00')).toBe(localNoon)
    expect(parseTimestamp('2026-11-07 12:00')).toBe(localNoon)
  })

  it('reads a date-only value as local midnight', () => {
    expect(parseTimestamp('2026-11-07')).toBe(new Date(2026, 10, 7).getTime())
    expect(parseTimestamp('2026-1-2')).toBe(new Date(2026, 0, 2).getTime())
  })

  it('checks leap years', () => {
    expect(parseTimestamp('2028-02-29')).toBe(new Date(2028, 1, 29).getTime())
    expect(parseTimestamp('2000-02-29T00:00:00Z')).toBe(Date.UTC(2000, 1, 29))
    expect(parseTimestamp('2026-02-29')).toBeNull()
    expect(parseTimestamp('1900-02-29T00:00:00Z')).toBeNull()
  })

  it('keeps years below 100 as written', () => {
    expect(new Date(parseTimestamp('0099-03-04T05:06:07Z') ?? Number.NaN).getUTCFullYear()).toBe(99)
    expect(new Date(parseTimestamp('0099-03-04') ?? Number.NaN).getFullYear()).toBe(99)
  })

  it.each([
    '',
    'yesterday',
    '2026/11/07',
    '07-11-2026',
    '2026-13-01',
    '2026-00-10',
    '2026-11-31',
    '2026-11-00',
    '2026-11-07T24:00:00Z',
    '2026-11-07T12:60:00Z',
    '2026-11-07T12:00:60Z',
    '2026-11-07T12',
    '2026-11-07T12:00:00+25:00',
    '2026-11-07T12:00:00+08:75',
    '2026-11-07T12:00:00Zjunk',
    '2026-11-07Z',
    'Sat, 07 Nov 2026 12:00:00 GMT',
    '1731000000000',
  ])('returns null for %j', (value) => {
    expect(parseTimestamp(value)).toBeNull()
  })
})
