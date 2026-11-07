import { describe, expect, it } from 'vitest'
import {
  addFrontMatter,
  editorBody,
  formatYamlString,
  fromLf,
  parsePromptFile,
  patchFrontMatter,
  renderNewPromptFile,
  replaceBody,
  toLf,
} from '../../src/shared/frontmatter.ts'
import type { FrontMatterPatch, ParsedFrontMatter } from '../../src/shared/frontmatter.ts'

/** 用 LF 连接各行。 */
function lines(...rows: string[]): string {
  return rows.join('\n')
}

/** 解析并断言有 front matter。 */
function frontMatterOf(text: string): ParsedFrontMatter {
  const parsed = parsePromptFile(text)
  expect(parsed.frontMatter).not.toBeNull()
  return parsed.frontMatter!
}

/** 断言 front matter 被判定为写坏了。 */
function expectInvalid(text: string): void {
  expect(frontMatterOf(text)).toEqual({ state: 'invalid', fields: {}, tagsLayout: 'absent' })
}

/** 断言 front matter 正常，返回解析出的字段。 */
function fieldsOf(text: string): ParsedFrontMatter['fields'] {
  const frontMatter = frontMatterOf(text)
  expect(frontMatter.state).toBe('ok')
  return frontMatter.fields
}

/** patch 成功时返回新文本。 */
function patched(text: string, patch: FrontMatterPatch): string {
  const result = patchFrontMatter(text, patch)
  if (!result.ok) throw new Error(`patch failed: ${result.reason}`)
  return result.text
}

const SAMPLE = lines(
  '---',
  'id: prompt_20261107_120000_1a2b3c4d',
  'title: 代码审查清单',
  'tags:',
  '  - 代码',
  '  - 审查',
  'favorite: false',
  'created: 2026-11-07T12:00:00Z',
  'updated: 2026-11-07T12:00:00Z',
  '---',
  '# 代码审查',
  '',
  '检查边界条件、错误处理与可维护性。',
)

describe('parsePromptFile: locating the front matter', () => {
  it('reads the six known fields and the body of a typical file', () => {
    expect(parsePromptFile(SAMPLE)).toEqual({
      bom: false,
      eol: 'lf',
      frontMatter: {
        state: 'ok',
        fields: {
          id: 'prompt_20261107_120000_1a2b3c4d',
          title: '代码审查清单',
          tags: ['代码', '审查'],
          favorite: false,
          created: '2026-11-07T12:00:00Z',
          updated: '2026-11-07T12:00:00Z',
        },
        tagsLayout: 'block',
      },
      body: '# 代码审查\n\n检查边界条件、错误处理与可维护性。',
    })
  })

  it('treats a file whose first line is not --- as having no front matter', () => {
    const text = lines('# Title', '---', 'id: x', '---', 'body')
    expect(parsePromptFile(text)).toEqual({ bom: false, eol: 'lf', frontMatter: null, body: text })
  })

  it('handles an empty file', () => {
    expect(parsePromptFile('')).toEqual({ bom: false, eol: 'lf', frontMatter: null, body: '' })
  })

  it.each([
    ['a blank first line', lines('', '---', 'id: x', '---')],
    ['an indented opening line', lines(' ---', 'id: x', '---')],
    ['text after the dashes', lines('--- x', 'id: x', '---')],
    ['four dashes', lines('----', 'id: x', '---')],
  ])('does not see front matter after %s', (_name, text) => {
    expect(parsePromptFile(text).frontMatter).toBeNull()
  })

  it('allows trailing spaces and tabs on both delimiter lines', () => {
    const parsed = parsePromptFile('--- \t\nid: a\n---  \nbody')
    expect(parsed.frontMatter?.fields).toEqual({ id: 'a' })
    expect(parsed.body).toBe('body')
  })

  it('accepts ... as the closing line', () => {
    const parsed = parsePromptFile(lines('---', 'id: a', '...', 'body'))
    expect(parsed.frontMatter?.state).toBe('ok')
    expect(parsed.body).toBe('body')
  })

  it('stops at the first closing line', () => {
    const parsed = parsePromptFile(lines('---', 'id: a', '---', 'title: not meta', '---', 'tail'))
    expect(parsed.frontMatter?.fields).toEqual({ id: 'a' })
    expect(parsed.body).toBe('title: not meta\n---\ntail')
  })

  it('gives an empty body when the closing line ends the file', () => {
    expect(parsePromptFile('---\nid: a\n---').body).toBe('')
    expect(parsePromptFile('---\nid: a\n---\n').body).toBe('')
  })

  it('accepts an empty front matter', () => {
    expect(parsePromptFile('---\n---\nbody')).toEqual({
      bom: false,
      eol: 'lf',
      frontMatter: { state: 'ok', fields: {}, tagsLayout: 'absent' },
      body: 'body',
    })
  })

  it('marks an unclosed front matter invalid and keeps the whole text as the body', () => {
    const text = lines('---', 'id: a', 'body')
    expect(parsePromptFile(text)).toEqual({
      bom: false,
      eol: 'lf',
      frontMatter: { state: 'invalid', fields: {}, tagsLayout: 'absent' },
      body: text,
    })
    expect(parsePromptFile('---').frontMatter?.state).toBe('invalid')
    expect(parsePromptFile('\ufeff---\nx').body).toBe('---\nx')
  })

  it('keeps the original line endings in the body', () => {
    const parsed = parsePromptFile('---\r\nid: a\r\n---\r\nline 1\r\nline 2\r\n')
    expect(parsed.body).toBe('line 1\r\nline 2\r\n')
    expect(editorBody(parsed)).toBe('line 1\nline 2\n')
  })

  it('detects the BOM with and without front matter', () => {
    const withFrontMatter = parsePromptFile('\ufeff---\nid: a\n---\nbody')
    expect(withFrontMatter.bom).toBe(true)
    expect(withFrontMatter.frontMatter?.fields).toEqual({ id: 'a' })
    expect(withFrontMatter.body).toBe('body')
    expect(parsePromptFile('\ufeffhello')).toEqual({ bom: true, eol: 'lf', frontMatter: null, body: 'hello' })
  })

  it.each([
    ['LF', 'a\nb\r\nc', 'lf'],
    ['CRLF', 'a\r\nb\nc', 'crlf'],
    ['a lone CR', 'a\rb\r\nc', 'lf'],
    ['no line break', 'abc', 'lf'],
  ] as const)('takes the line ending style from the first break (%s)', (_name, text, eol) => {
    expect(parsePromptFile(text).eol).toBe(eol)
  })

  it('understands CRLF and lone CR line breaks inside the front matter', () => {
    expect(fieldsOf('---\r\nid: a\r\ntitle: T\r\n---\r\nx')).toEqual({ id: 'a', title: 'T' })
    const parsed = parsePromptFile('---\rid: a\r---\rbody')
    expect(parsed.frontMatter?.fields).toEqual({ id: 'a' })
    expect(parsed.body).toBe('body')
  })
})

describe('parsePromptFile: scalar values', () => {
  const titleOf = (value: string): string | undefined => fieldsOf(lines('---', `title: ${value}`, '---')).title

  it('strips a trailing comment from a plain value', () => {
    expect(titleOf('Hello world # note')).toBe('Hello world')
    expect(titleOf('Hello\t# note')).toBe('Hello')
  })

  it('keeps # that is not preceded by whitespace', () => {
    expect(titleOf('C#')).toBe('C#')
    expect(titleOf('a#b')).toBe('a#b')
  })

  it('reads single-quoted values with doubled quotes', () => {
    expect(titleOf('\'It\'\'s fine\'')).toBe('It\'s fine')
    expect(titleOf('\'a # b\' # comment')).toBe('a # b')
  })

  it('reads double-quoted values with escapes', () => {
    expect(titleOf('"a\\"b\\\\c\\nd\\te\\u00e9\\x41\\U0001F600\\/"')).toBe('a"b\\c\nd\teéA😀/')
    expect(titleOf('"x" # comment')).toBe('x')
  })

  it('keeps quotes inside plain values', () => {
    expect(titleOf('it\'s "quoted"')).toBe('it\'s "quoted"')
  })

  it('reads empty and null values as missing, and "" as an empty string', () => {
    expect(fieldsOf(lines('---', 'title:', 'id: ~', 'created: null', 'updated:   # none', '---'))).toEqual({})
    expect(titleOf('""')).toBe('')
    expect(titleOf('\'\'')).toBe('')
  })

  it('keeps numbers and booleans as strings for string fields', () => {
    expect(fieldsOf(lines('---', 'id: 123', 'title: true', '---'))).toEqual({ id: '123', title: 'true' })
  })

  it('keeps created and updated as the original strings', () => {
    expect(fieldsOf(lines('---', 'created: 2026-11-07 12:00:00', 'updated: \'2026-11-07\'', '---'))).toEqual({
      created: '2026-11-07 12:00:00',
      updated: '2026-11-07',
    })
  })

  it('reads favorite case-insensitively, also when quoted', () => {
    expect(fieldsOf(lines('---', 'favorite: TRUE', '---')).favorite).toBe(true)
    expect(fieldsOf(lines('---', 'favorite: False', '---')).favorite).toBe(false)
    expect(fieldsOf(lines('---', 'favorite: \'true\'', '---')).favorite).toBe(true)
    expect(fieldsOf(lines('---', 'favorite:', '---')).favorite).toBeUndefined()
  })

  it.each(['maybe', 'yes', '1', '[true]'])('marks favorite: %s invalid', (value) => {
    expectInvalid(lines('---', `favorite: ${value}`, '---'))
  })

  it('allows spaces before the colon and a tab after it', () => {
    expect(fieldsOf(lines('---', 'title  : spaced', '---')).title).toBe('spaced')
    expect(fieldsOf(lines('---', 'title:\ttabbed', '---')).title).toBe('tabbed')
  })

  it('recognizes quoted keys', () => {
    expect(fieldsOf(lines('---', '"title": Quoted', '\'id\': x', '---'))).toEqual({ title: 'Quoted', id: 'x' })
  })

  it('treats keys case-sensitively', () => {
    expect(fieldsOf(lines('---', 'Title: X', 'TAGS: [a]', '---'))).toEqual({})
  })

  it.each([
    ['an unterminated double quote', 'title: "abc'],
    ['an unterminated single quote', 'title: \'abc'],
    ['an unknown escape', 'title: "\\q"'],
    ['text after a quoted value', 'title: "a" b'],
    ['a comment glued to a quoted value', 'title: "a"#b'],
    ['": " inside a plain value', 'title: a: b'],
    ['a plain value ending with a colon', 'title: a:'],
    ['a flow sequence', 'title: [draft] notes'],
    ['a flow mapping', 'title: {a: 1}'],
    ['an anchor', 'title: &x a'],
    ['an alias', 'title: *x'],
    ['a tag', 'title: !str a'],
    ['a literal block scalar', 'title: |'],
    ['a folded block scalar', 'title: >'],
    ['a reserved @', 'title: @a'],
    ['a reserved backtick', 'title: `a`'],
    ['a directive-like %', 'title: %a'],
    ['a sequence entry', 'title: - a'],
  ])('marks the front matter invalid for %s', (_name, line) => {
    expectInvalid(lines('---', line, '---'))
  })

  it.each([
    ['a continued plain value', ['title: a', '  b']],
    ['a value on the next line', ['title:', '  Foo']],
    ['a list under a scalar field', ['title:', '- a']],
    ['a multi-line quoted value', ['title: "a', '  b"']],
    ['a block scalar body', ['id: |', '  x']],
  ])('marks the front matter invalid for %s', (_name, rows) => {
    expectInvalid(lines('---', ...rows, '---'))
  })

  it('ignores comment lines under a scalar field', () => {
    expect(fieldsOf(lines('---', 'title: a', '  # note', '# other', '---'))).toEqual({ title: 'a' })
  })
})

describe('parsePromptFile: structure', () => {
  it('ignores comments, unknown fields and nested content', () => {
    const text = lines(
      '---',
      '# leading comment',
      'source: web',
      'id: a',
      'meta:',
      '  nested: 1',
      '  list: [1, 2]',
      'desc: |',
      '  line one',
      '  title: not a key',
      'aliases:',
      '- x',
      '- y',
      'title: Real',
      '---',
    )
    expect(fieldsOf(text)).toEqual({ id: 'a', title: 'Real' })
  })

  it('marks a duplicated known field invalid', () => {
    expectInvalid(lines('---', 'title: a', 'title: b', '---'))
    expectInvalid(lines('---', 'id: a', '"id": a', '---'))
    expectInvalid(lines('---', 'tags: [a]', 'tags: [b]', '---'))
  })

  it('allows a duplicated unknown field', () => {
    expect(fieldsOf(lines('---', 'x: 1', 'x: 2', 'id: a', '---'))).toEqual({ id: 'a' })
  })

  it('allows comments and blank lines before the first key', () => {
    expect(fieldsOf(lines('---', '', '# c', '  # indented comment', 'id: a', '---'))).toEqual({ id: 'a' })
  })

  it.each([
    ['an indented mapping', ['  title: a', '  id: b']],
    ['a top-level sequence', ['- a', '- b']],
    ['plain text', ['just some text']],
    ['a key without a space after the colon', ['title:x']],
    ['a complex key', ['? a', ': b']],
    ['a flow mapping', ['{title: a}']],
    ['a directive', ['%YAML 1.2']],
    ['a key cut by a comment', ['foo #bar: baz']],
  ])('marks the front matter invalid for %s', (_name, rows) => {
    expectInvalid(lines('---', ...rows, '---'))
  })

  it('treats lines inside a multi-line quoted value as part of that value', () => {
    const text = lines('---', 'desc: "first', 'title: fake', '  end"', 'title: Real', '---')
    expect(fieldsOf(text)).toEqual({ title: 'Real' })
  })

  it('treats lines inside a multi-line flow collection as part of that value', () => {
    expect(fieldsOf(lines('---', 'aliases: [a,', 'title: fake]', 'title: Real', '---'))).toEqual({ title: 'Real' })
    expect(fieldsOf(lines('---', 'meta: {a: "x', '  y", b: [1,', '  2]}', 'id: z', '---'))).toEqual({ id: 'z' })
  })

  it('marks a never-closed quote or bracket invalid', () => {
    expectInvalid(lines('---', 'desc: "abc', 'title: x', '---'))
    expectInvalid(lines('---', 'aliases: [a, b', 'title: x', '---'))
  })

  it('does not treat an apostrophe inside a flow item as a quote', () => {
    expect(fieldsOf(lines('---', 'aliases: [it\'s, b]', 'title: x', '---'))).toEqual({ title: 'x' })
  })
})

describe('parsePromptFile: tags', () => {
  const tagsOf = (...rows: string[]): { layout: string; tags: string[] | undefined } => {
    const frontMatter = frontMatterOf(lines('---', ...rows, 'title: t', '---'))
    expect(frontMatter.state).toBe('ok')
    expect(frontMatter.fields.title).toBe('t')
    return { layout: frontMatter.tagsLayout, tags: frontMatter.fields.tags }
  }

  it('reads an indented block list', () => {
    expect(tagsOf('tags:', '  - a', '  - b')).toEqual({ layout: 'block', tags: ['a', 'b'] })
  })

  it('reads a block list at the same indent as tags:', () => {
    expect(tagsOf('tags:', '- a', '- b')).toEqual({ layout: 'block', tags: ['a', 'b'] })
  })

  it('reads quoted items and skips comments, blank lines and empty items', () => {
    expect(tagsOf('tags: # mine', '  - a # first', '', '  # comment', '  - \'b c\'', '  - "d"', '  -', '  - ~'))
      .toEqual({ layout: 'block', tags: ['a', 'b c', 'd'] })
  })

  it('reads a single-line flow list', () => {
    expect(tagsOf('tags: [a, \'b\', "c d"]')).toEqual({ layout: 'flow', tags: ['a', 'b', 'c d'] })
    expect(tagsOf('tags: [ a ,b, ]  # comment')).toEqual({ layout: 'flow', tags: ['a', 'b'] })
    expect(tagsOf('tags: [~]')).toEqual({ layout: 'flow', tags: [] })
  })

  it('reads tags without deduplicating or limiting them', () => {
    expect(tagsOf('tags: [a, A, b, c, d, e, f]').tags).toEqual(['a', 'A', 'b', 'c', 'd', 'e', 'f'])
  })

  it.each([
    [['tags:']],
    [['tags: []']],
    [['tags: [ ]']],
    [['tags: ~']],
    [['tags: null # none']],
    [['tags:   # none']],
    [['tags:', '  # nothing yet', '']],
  ])('reads %j as an empty list', (rows) => {
    expect(tagsOf(...rows)).toEqual({ layout: 'empty', tags: [] })
  })

  it('reports a missing tags field as absent', () => {
    expect(tagsOf()).toEqual({ layout: 'absent', tags: undefined })
  })

  it.each([
    ['a multi-line flow list', ['tags: [a,', '  b]']],
    ['an anchored list', ['tags: &t', '  - a']],
    ['an alias', ['tags: *t']],
    ['a block scalar', ['tags: |', '  a']],
    ['a plain string', ['tags: a, b']],
    ['a quoted string', ['tags: \'a\'']],
    ['a nested list', ['tags:', '  - - a']],
    ['a mapping item', ['tags:', '  - a: b']],
    ['a flow item', ['tags:', '  - [a]']],
    ['inconsistent indentation', ['tags:', '  - a', '    - b']],
    ['a continued item', ['tags:', '  - a', '    b']],
    ['a tab-indented item', ['tags:', '\t- a']],
    ['a nested flow list', ['tags: [a, [b]]']],
    ['a flow mapping', ['tags: {a: 1}']],
    ['text after a flow list', ['tags: [a] b']],
    ['a flow list followed by items', ['tags: [a]', '  - b']],
    ['a flow item with ": "', ['tags: [a: b]']],
    ['an empty flow item', ['tags: [a,, b]']],
  ])('reads %s as an unsupported layout with no tags', (_name, rows) => {
    expect(tagsOf(...rows)).toEqual({ layout: 'unsupported', tags: [] })
  })
})

describe('toLf, fromLf and editorBody', () => {
  it('converts CRLF and CR to LF', () => {
    expect(toLf('a\r\nb\rc\nd')).toBe('a\nb\nc\nd')
    expect(editorBody(parsePromptFile('x\ry\r\nz'))).toBe('x\ny\nz')
  })

  it('converts LF text to the requested style without doubling CR', () => {
    expect(fromLf('a\nb', 'crlf')).toBe('a\r\nb')
    expect(fromLf('a\r\nb', 'crlf')).toBe('a\r\nb')
    expect(fromLf('a\r\nb', 'lf')).toBe('a\nb')
  })
})

describe('patchFrontMatter: refusals', () => {
  it('refuses a file without front matter', () => {
    expect(patchFrontMatter('# Title\nbody', { updated: 'x' })).toEqual({ ok: false, reason: 'no-front-matter' })
  })

  it('refuses an unclosed or broken front matter', () => {
    expect(patchFrontMatter('---\nid: a\nbody', { updated: 'x' })).toEqual({ ok: false, reason: 'invalid' })
    expect(patchFrontMatter('---\nfavorite: maybe\n---\n', { updated: 'x' })).toEqual({ ok: false, reason: 'invalid' })
  })

  it('refuses to write tags in an unsupported layout but still writes other fields', () => {
    const text = lines('---', 'tags: [a,', '  b]', 'title: Old', '---', 'body')
    expect(patchFrontMatter(text, { tags: ['x'] })).toEqual({ ok: false, reason: 'unsupported-layout' })
    expect(patchFrontMatter(text, { tags: [], title: 'New' })).toEqual({ ok: false, reason: 'unsupported-layout' })
    expect(patched(text, { title: 'New' })).toBe(text.replace('title: Old', 'title: New'))
  })
})

describe('patchFrontMatter: minimal edits', () => {
  const custom = lines(
    '---',
    'id: prompt_20261107_120000_1a2b3c4d',
    '# 来源说明，不要删',
    'source: web',
    'title: 代码审查清单  # 手写的注释',
    'tags:',
    '  - 代码',
    'favorite: false',
    'created: 2026-11-07T12:00:00Z',
    'updated: 2026-11-07T12:00:00Z',
    'extra:',
    '  nested: true',
    '---',
    '正文',
  )

  it('changes only the updated line and keeps custom fields, comments and order', () => {
    const result = patched(custom, { updated: '2026-11-08T09:30:00Z' })
    expect(result).toBe(custom.replace('updated: 2026-11-07T12:00:00Z', 'updated: 2026-11-08T09:30:00Z'))
  })

  it('returns the text unchanged for an empty patch or unchanged values', () => {
    expect(patched(custom, {})).toBe(custom)
    expect(patched(custom, { title: '代码审查清单', favorite: false, tags: ['代码'], id: 'prompt_20261107_120000_1a2b3c4d' }))
      .toBe(custom)
  })

  it('keeps the trailing comment when replacing a value', () => {
    expect(patched(custom, { title: '新标题' })).toBe(custom.replace('title: 代码审查清单  # 手写的注释', 'title: 新标题  # 手写的注释'))
  })

  it('keeps a plain title plain when possible', () => {
    expect(patched('---\ntitle: Old\n---\n', { title: 'New title' })).toBe('---\ntitle: New title\n---\n')
  })

  it.each([
    ' leading space', 'trailing space ', 'a: b', 'a #b', '- item', '? q', ': c', '[x]', '{x}', '#x', '&x', '*x', '!x',
    '|x', '>x', '\'x', '"x', '%x', '@x', '`x', ',x', 'true', 'False', 'null', '~', 'yes', 'No', 'on', '123', '-1.5',
    '0x1F', '1e3', '.inf', '12:30', '2026-11-07', '2026-11-07T12:00:00Z', '', 'end:', 'tab\tend\t',
  ])('switches a plain title to double quotes when %j needs quoting', (value) => {
    const result = patched('---\ntitle: Old\n---\n', { title: value })
    expect(result.split('\n')[1]).toMatch(/^title: "/)
    expect(parsePromptFile(result).frontMatter?.fields.title).toBe(value)
  })

  it('keeps single quotes and escapes embedded quotes', () => {
    expect(patched('---\ntitle: \'Old\'  # c\n---\n', { title: 'It\'s new' })).toBe('---\ntitle: \'It\'\'s new\'  # c\n---\n')
  })

  it('keeps double quotes and escapes the value', () => {
    expect(patched('---\ntitle: "Old"\n---\n', { title: 'say "hi" \\ bye' })).toBe('---\ntitle: "say \\"hi\\" \\\\ bye"\n---\n')
  })

  it('falls back to double quotes when single quotes cannot hold the value', () => {
    expect(patched('---\ntitle: \'Old\'\n---\n', { title: 'a\nb' })).toBe('---\ntitle: "a\\nb"\n---\n')
  })

  it('fills in an empty value after the colon', () => {
    expect(patched('---\ntitle:\n---\n', { title: 'New' })).toBe('---\ntitle: New\n---\n')
    expect(patched('---\ntitle:   # c\n---\n', { title: 'New' })).toBe('---\ntitle: New   # c\n---\n')
    expect(patched('---\ntitle: ~\n---\n', { title: 'New' })).toBe('---\ntitle: New\n---\n')
  })

  it('keeps the quote style of updated and created and leaves timestamps unquoted', () => {
    const text = lines('---', 'created: \'2026-01-01T00:00:00Z\'', 'updated: 2026-01-01', '---', '')
    expect(patched(text, { created: '2026-02-02T00:00:00Z', updated: '2026-03-03T00:00:00Z' }))
      .toBe(lines('---', 'created: \'2026-02-02T00:00:00Z\'', 'updated: 2026-03-03T00:00:00Z', '---', ''))
  })

  it('toggles favorite on its own line only', () => {
    expect(patched(custom, { favorite: true })).toBe(custom.replace('favorite: false', 'favorite: true'))
  })

  it('keeps the quote style of favorite', () => {
    expect(patched('---\nfavorite: \'false\'\n---\n', { favorite: true })).toBe('---\nfavorite: \'true\'\n---\n')
    expect(patched('---\nfavorite: "FALSE"\n---\n', { favorite: true })).toBe('---\nfavorite: "true"\n---\n')
    expect(patched('---\nfavorite:\n---\n', { favorite: false })).toBe('---\nfavorite: false\n---\n')
    expect(patched('---\nfavorite: TRUE\n---\n', { favorite: true })).toBe('---\nfavorite: TRUE\n---\n')
  })

  it('adds a missing id and replaces updated in place', () => {
    const text = lines('---', 'title: T', 'updated: 2026-01-01T00:00:00Z', 'note: keep', '---', 'body')
    expect(patched(text, { id: 'prompt_20260101_000000_abcdef01', updated: '2026-02-01T00:00:00Z' })).toBe(lines(
      '---',
      'title: T',
      'updated: 2026-02-01T00:00:00Z',
      'note: keep',
      'id: prompt_20260101_000000_abcdef01',
      '---',
      'body',
    ))
  })

  it('inserts missing fields before the closing line in the fixed order', () => {
    const text = lines('---', 'source: web', '...', 'body')
    const result = patched(text, {
      updated: '2026-01-02T00:00:00Z',
      favorite: true,
      created: '2026-01-01T00:00:00Z',
      tags: ['a'],
      title: 'T: x',
      id: 'p1',
    })
    expect(result).toBe(lines(
      '---',
      'source: web',
      'id: p1',
      'title: "T: x"',
      'tags:',
      '  - a',
      'favorite: true',
      'created: 2026-01-01T00:00:00Z',
      'updated: 2026-01-02T00:00:00Z',
      '...',
      'body',
    ))
  })

  it('inserts into an empty front matter', () => {
    expect(patched('---\n---\nbody', { id: 'p1' })).toBe('---\nid: p1\n---\nbody')
  })

  it('preserves CRLF line endings and the BOM', () => {
    const text = '\ufeff---\r\ntitle: Old\r\nupdated: 2026-01-01T00:00:00Z\r\n---\r\nbody\r\n'
    const result = patched(text, { title: 'New', id: 'p1', tags: ['a', 'b'] })
    expect(result).toBe('\ufeff---\r\ntitle: New\r\nupdated: 2026-01-01T00:00:00Z\r\nid: p1\r\ntags:\r\n  - a\r\n  - b\r\n---\r\nbody\r\n')
    expect(result.replaceAll('\r\n', '')).not.toMatch(/[\r\n]/)
  })

  it('patches a file that uses lone CR line breaks', () => {
    const result = patched('---\rtitle: Old\r---\rbody', { title: 'New', id: 'p1' })
    expect(result).toBe('---\rtitle: New\rid: p1\n---\rbody')
    expect(parsePromptFile(result).frontMatter?.fields).toEqual({ title: 'New', id: 'p1' })
  })
})

describe('patchFrontMatter: tags', () => {
  const doc = (...rows: string[]): string => lines('---', ...rows, 'title: T', '---', 'body')

  it('rewrites a block list with the original indent and dash style', () => {
    expect(patched(doc('tags:', '    -   a', '    -   b'), { tags: ['x', 'z'] })).toBe(doc('tags:', '    -   x', '    -   z'))
  })

  it('rewrites a block list at the same indent as tags:', () => {
    expect(patched(doc('tags:', '- a', '- b'), { tags: ['a', 'c'] })).toBe(doc('tags:', '- a', '- c'))
  })

  it('appends new items after the last item', () => {
    expect(patched(doc('tags:', '  - a', '# after'), { tags: ['a', 'b', 'c'] })).toBe(doc('tags:', '  - a', '  - b', '  - c', '# after'))
  })

  it('removes surplus items and keeps comment lines between them', () => {
    expect(patched(doc('tags:', '  - a', '  # about b', '  - b', '  - c'), { tags: ['a'] })).toBe(doc('tags:', '  - a', '  # about b'))
  })

  it('keeps unchanged items byte for byte, including their comments', () => {
    expect(patched(doc('tags:', '  - \'a\' # first', '  - b # second'), { tags: ['a', 'c'] }))
      .toBe(doc('tags:', '  - \'a\' # first', '  - c # second'))
  })

  it('fills empty items', () => {
    expect(patched(doc('tags:', '  -', '  - a'), { tags: ['x', 'z'] })).toBe(doc('tags:', '  - x', '  - z'))
    expect(patched(doc('tags:', '  -'), { tags: ['x', 'z'] })).toBe(doc('tags:', '  - x', '  - z'))
  })

  it('quotes YAML 1.1 boolean words such as y and n', () => {
    expect(patched(doc('tags: [a]'), { tags: ['y', 'N', 'off'] })).toBe(doc('tags: ["y", "N", "off"]'))
  })

  it('writes an empty block list as tags: []', () => {
    expect(patched(doc('tags: # mine', '  - a', '  # note', '  - b'), { tags: [] })).toBe(doc('tags: [] # mine', '  # note'))
  })

  it('quotes block items that need it', () => {
    expect(patched(doc('tags:', '  - a'), { tags: ['a: b', 'true', 'ok'] })).toBe(doc('tags:', '  - "a: b"', '  - "true"', '  - ok'))
  })

  it('rewrites a flow list in place', () => {
    expect(patched(doc('tags: [a, b]  # c'), { tags: ['x', 'y z', 'a,b', 'true', 'k:v'] }))
      .toBe(doc('tags: [x, y z, "a,b", "true", "k:v"]  # c'))
    expect(patched(doc('tags: [a, b]'), { tags: [] })).toBe(doc('tags: []'))
    expect(patched(doc('tags: [~]'), { tags: ['a'] })).toBe(doc('tags: [a]'))
  })

  it.each([
    [['tags:'], ['tags:']],
    [['tags: []'], ['tags:']],
    [['tags: [] # none'], ['tags: # none']],
    [['tags: ~'], ['tags:']],
    [['tags:  # none'], ['tags:  # none']],
  ])('turns the empty layout %j into a two-space block list', (rows, keyLine) => {
    expect(patched(doc(...rows), { tags: ['a', 'b'] })).toBe(doc(...keyLine, '  - a', '  - b'))
  })

  it('puts new items right after an empty tags: line', () => {
    expect(patched(doc('tags:', '  # none yet', 'favorite: false'), { tags: ['a'] }))
      .toBe(doc('tags:', '  - a', '  # none yet', 'favorite: false'))
  })

  it('leaves an empty layout alone when the new list is empty', () => {
    expect(patched(doc('tags:'), { tags: [] })).toBe(doc('tags:'))
    expect(patched(doc('tags: []'), { tags: [] })).toBe(doc('tags: []'))
  })

  it('inserts a missing tags field as a block list, or tags: [] when empty', () => {
    expect(patched(doc(), { tags: ['a', 'b'] })).toBe(lines('---', 'title: T', 'tags:', '  - a', '  - b', '---', 'body'))
    expect(patched(doc(), { tags: [] })).toBe(lines('---', 'title: T', 'tags: []', '---', 'body'))
  })

  it('keeps new items ahead of fields inserted after a trailing block list', () => {
    const text = lines('---', 'title: T', 'tags:', '- a', '---', '')
    const result = patched(text, { tags: ['a', 'b'], updated: '2026-01-01T00:00:00Z' })
    expect(result).toBe(lines('---', 'title: T', 'tags:', '- a', '- b', 'updated: 2026-01-01T00:00:00Z', '---', ''))
    expect(parsePromptFile(result).frontMatter).toEqual({
      state: 'ok',
      fields: { title: 'T', tags: ['a', 'b'], updated: '2026-01-01T00:00:00Z' },
      tagsLayout: 'block',
    })
  })

  it('uses CRLF for rewritten and added tag lines in a CRLF file', () => {
    const text = '---\r\ntags:\r\n  - a\r\nx: [ ]\r\nother:\r\n---\r\n'
    expect(patched(text, { tags: ['a', 'b'] })).toBe('---\r\ntags:\r\n  - a\r\n  - b\r\nx: [ ]\r\nother:\r\n---\r\n')
    expect(patched('---\r\ntags: []\r\n---\r\n', { tags: ['a'] })).toBe('---\r\ntags:\r\n  - a\r\n---\r\n')
  })

  it('round-trips through the parser', () => {
    for (const rows of [['tags:', '  - a'], ['tags: [a]'], ['tags:'], []]) {
      const result = patched(doc(...rows), { tags: ['x y', '#z', 'C#'] })
      expect(parsePromptFile(result).frontMatter?.fields.tags).toEqual(['x y', '#z', 'C#'])
    }
  })
})

describe('patchFrontMatter: invariants across layouts', () => {
  const documents: [string, string][] = [
    ['the sample file', SAMPLE],
    ['a flow list with comments and unknown fields', lines(
      '---',
      '# 说明',
      'title: \'Quoted\'  # c',
      'source: web',
      'tags: [a, "b c"]  # tags',
      'meta:',
      '  - nested',
      'favorite: TRUE',
      '---',
      'body',
    )],
    ['an empty tags line with a comment below', lines('---', 'id: x', 'tags:', '  # none', 'updated: "2026-01-01"', '---', '')],
    ['tags: []', lines('---', 'tags: []', 'title: T', '---', 'text')],
    ['no tags, no id and a ... closing line', lines('---', 'title: "Say \\"hi\\""', 'extra: 1', '...', '# H')],
    ['a block list at the same indent', lines('---', 'tags:', '- a', '- b', '---', '')],
    ['an empty front matter', lines('---', '---', 'body')],
    ['CRLF with a BOM', `\ufeff${SAMPLE.replaceAll('\n', '\r\n')}\r\n`],
  ]
  const patches: FrontMatterPatch[] = [
    { title: 'New: title' },
    { title: '' },
    { tags: ['x', 'y z', 'C#'] },
    { tags: [] },
    { tags: ['a', 'b', 'c', 'd', 'e'] },
    { favorite: true },
    { favorite: false },
    { id: 'prompt_20261201_000000_00000000', updated: '2026-12-01T00:00:00Z' },
    { id: 'p', title: 'T', tags: ['k'], favorite: true, created: '2026-01-01T00:00:00Z', updated: '2026-12-01T00:00:00Z' },
  ]

  for (const [name, text] of documents) {
    it(`keeps ${name} parseable with only the patched fields changed`, () => {
      const before = parsePromptFile(text)
      expect(before.frontMatter?.state).toBe('ok')
      expect(patched(text, before.frontMatter?.fields ?? {})).toBe(text)
      for (const patch of patches) {
        const result = patched(text, patch)
        const after = parsePromptFile(result)
        expect(after.frontMatter).toEqual({
          state: 'ok',
          fields: { ...before.frontMatter?.fields, ...patch },
          tagsLayout: expect.any(String) as string,
        })
        expect(after.body).toBe(before.body)
        expect(after.bom).toBe(before.bom)
        expect(after.eol).toBe(before.eol)
        if (before.eol === 'crlf') expect(result.replaceAll('\r\n', '')).not.toMatch(/[\r\n]/)
        expect(patched(result, patch)).toBe(result)
      }
    })
  }
})

describe('replaceBody', () => {
  it('keeps the BOM and the front matter bytes and writes the body with CRLF', () => {
    const text = '\ufeff---\r\ntitle: "T"  # c\r\n---\r\nold\r\nbody\r\n'
    expect(replaceBody(text, 'new\nbody\n')).toBe('\ufeff---\r\ntitle: "T"  # c\r\n---\r\nnew\r\nbody\r\n')
  })

  it('writes the body with LF in an LF file', () => {
    expect(replaceBody('---\nid: a\n...\nold', 'line 1\nline 2')).toBe('---\nid: a\n...\nline 1\nline 2')
  })

  it('normalizes stray CRLF in the new body before converting', () => {
    expect(replaceBody('---\r\nid: a\r\n---\r\n', 'a\r\nb\rc')).toBe('---\r\nid: a\r\n---\r\na\r\nb\r\nc')
  })

  it('replaces everything after the BOM when there is no front matter', () => {
    expect(replaceBody('\ufeff# old\r\ntext', '# new\nbody')).toBe('\ufeff# new\r\nbody')
    expect(replaceBody('old', '')).toBe('')
  })

  it('replaces everything after the BOM when the front matter is not closed', () => {
    expect(replaceBody('---\nid: a\nold', '---\nid: a\nnew')).toBe('---\nid: a\nnew')
  })

  it('adds a line break after a closing line at the end of the file', () => {
    expect(replaceBody('---\r\nid: a\r\n---', 'body')).toBe('---\r\nid: a\r\n---\r\nbody')
    expect(replaceBody('---\nid: a\n---', '')).toBe('---\nid: a\n---')
  })

  it('keeps a broken front matter as it is', () => {
    expect(replaceBody('---\nfavorite: maybe\n---\nold', 'new')).toBe('---\nfavorite: maybe\n---\nnew')
  })
})

describe('addFrontMatter', () => {
  const fields = { id: 'prompt_20261107_120000_1a2b3c4d', title: 'Title', created: '2026-11-07T12:00:00Z', updated: '2026-11-07T12:00:00Z' }

  it('prepends id, title, created and updated and keeps the content after it', () => {
    expect(addFrontMatter('# Title\n\nbody\n', fields)).toBe(lines(
      '---',
      'id: prompt_20261107_120000_1a2b3c4d',
      'title: Title',
      'created: 2026-11-07T12:00:00Z',
      'updated: 2026-11-07T12:00:00Z',
      '---',
      '# Title',
      '',
      'body',
      '',
    ))
  })

  it('uses the file line ending style and keeps the BOM first', () => {
    const text = '\ufeffline 1\r\nline 2'
    const result = addFrontMatter(text, fields)
    expect(result).toBe(`\ufeff---\r\nid: ${fields.id}\r\ntitle: Title\r\ncreated: ${fields.created}\r\nupdated: ${fields.updated}\r\n---\r\nline 1\r\nline 2`)
    expect(result.endsWith(text.slice(1))).toBe(true)
  })

  it('quotes a title that needs it and parses back', () => {
    const result = addFrontMatter('body', { ...fields, title: 'Note: draft #1' })
    expect(result).toContain('title: "Note: draft #1"\n')
    const parsed = parsePromptFile(result)
    expect(parsed.frontMatter).toEqual({
      state: 'ok',
      fields: { id: fields.id, title: 'Note: draft #1', created: fields.created, updated: fields.updated },
      tagsLayout: 'absent',
    })
    expect(parsed.body).toBe('body')
  })

  it('works on an empty file', () => {
    expect(parsePromptFile(addFrontMatter('', fields)).body).toBe('')
  })

  it('works on a file that starts with an unclosed ---', () => {
    const text = '---\nnot front matter\n'
    const parsed = parsePromptFile(addFrontMatter(text, fields))
    expect(parsed.frontMatter?.state).toBe('ok')
    expect(parsed.body).toBe(text)
  })

  it('throws when the file already has front matter', () => {
    expect(() => addFrontMatter('---\nid: a\n---\n', fields)).toThrow()
    expect(() => addFrontMatter('---\nfavorite: maybe\n---\n', fields)).toThrow()
  })
})

describe('renderNewPromptFile', () => {
  const fields = { id: 'prompt_20261107_120000_1a2b3c4d', title: '代码审查清单', created: '2026-11-07T12:00:00Z', updated: '2026-11-07T12:00:00Z' }

  it('renders the documented layout with LF and no BOM', () => {
    expect(renderNewPromptFile(fields, '# 代码审查\n\n检查边界条件。\n')).toBe(lines(
      '---',
      'id: prompt_20261107_120000_1a2b3c4d',
      'title: 代码审查清单',
      'tags: []',
      'favorite: false',
      'created: 2026-11-07T12:00:00Z',
      'updated: 2026-11-07T12:00:00Z',
      '---',
      '# 代码审查',
      '',
      '检查边界条件。',
      '',
    ))
  })

  it('quotes the title when needed and keeps the body as is', () => {
    const result = renderNewPromptFile({ ...fields, title: 'true' }, 'a\r\nb')
    expect(result).toContain('\ntitle: "true"\n')
    expect(result.endsWith('---\na\r\nb')).toBe(true)
  })

  it('parses back to the same fields with an empty tags layout', () => {
    const parsed = parsePromptFile(renderNewPromptFile(fields, 'body'))
    expect(parsed).toEqual({
      bom: false,
      eol: 'lf',
      frontMatter: { state: 'ok', fields: { ...fields, tags: [], favorite: false }, tagsLayout: 'empty' },
      body: 'body',
    })
  })
})

describe('formatYamlString', () => {
  it.each(['Hello', '代码审查清单', 'C#', 'a-b', 'v1.0', 'it\'s', 'a:b', 'x y', 'prompt_20261107_120000_1a2b3c4d'])(
    'leaves %j unquoted',
    (value) => {
      expect(formatYamlString(value)).toBe(value)
    },
  )

  it('uses double quotes for values that need them', () => {
    expect(formatYamlString('a: b')).toBe('"a: b"')
    expect(formatYamlString('')).toBe('""')
    expect(formatYamlString('null')).toBe('"null"')
  })

  it('writes single quotes on request and doubles embedded quotes', () => {
    expect(formatYamlString('it\'s', 'single')).toBe('\'it\'\'s\'')
    expect(formatYamlString(' x ', 'single')).toBe('\' x \'')
  })

  it('writes double quotes on request', () => {
    expect(formatYamlString('plain', 'double')).toBe('"plain"')
  })

  it('escapes control characters, line separators and the BOM', () => {
    expect(formatYamlString('a\tb\r\n\x01\u2028\ufeff', 'single')).toBe('"a\\tb\\r\\n\\u0001\\u2028\\ufeff"')
    expect(formatYamlString('\x7f')).toBe('"\\u007f"')
  })

  it('round-trips tricky values through a title line', () => {
    const values = ['a "b" \\c', 'x\ny', '#tag', '- item', '  pad  ', '😀 emoji', 'é', 'yes', '0o17', '\\u0041', 'a\u0085b']
    for (const value of values) {
      for (const style of ['plain', 'single', 'double'] as const) {
        const text = `---\ntitle: ${formatYamlString(value, style)}\n---\n`
        expect(parsePromptFile(text).frontMatter?.fields.title).toBe(value)
      }
    }
  })
})
