import { describe, it, expect } from 'vitest'
import { draftRecordSchema, parseDraftRecord } from '../../src/shared/draft-record.ts'
import type { Binding, DraftRecord } from '../../src/shared/types.ts'

const SECRET = '用户的草稿正文-不能出现在错误信息里'

const binding = (): Binding => ({
  libraryDir: '/Users/me/.dsh/promptx/library',
  relPath: '写作/评审意见.md',
  id: 'prompt_20261107_120000_1a2b3c4d',
  title: '评审意见',
  sha256: 'a'.repeat(64),
  size: 1234,
  savedBody: SECRET,
})

const record = (): DraftRecord => ({
  version: 1,
  text: SECRET,
  selection: { anchor: 3, head: 7 },
  binding: binding(),
  updatedAt: '2026-11-07T12:00:00.000Z',
})

/** 断言抛错，并且错误信息里没有用户内容。 */
function expectRejected(raw: unknown, field: string): void {
  let error: unknown
  try {
    parseDraftRecord(raw)
  } catch (caught) {
    error = caught
  }
  expect(error).toBeInstanceOf(Error)
  const message = (error as Error).message
  expect(message).toContain(field)
  expect(message).not.toContain(SECRET)
  expect(message).not.toContain('评审意见')
}

describe('parseDraftRecord：合法记录', () => {
  it('完整记录原样通过', () => {
    expect(parseDraftRecord(record())).toEqual(record())
  })

  it('没有选区、没有绑定', () => {
    const raw = { ...record(), selection: null, binding: null }
    expect(parseDraftRecord(raw)).toEqual(raw)
  })

  it('绑定的 id 可以是 null', () => {
    const raw = { ...record(), binding: { ...binding(), id: null } }
    expect(parseDraftRecord(raw).binding?.id).toBeNull()
  })

  it('空正文、选区在 0、文件大小为 0 都合法', () => {
    const raw = { ...record(), text: '', selection: { anchor: 0, head: 0 }, binding: { ...binding(), size: 0, savedBody: '' } }
    expect(parseDraftRecord(raw)).toEqual(raw)
  })

  it('选区可以是反向的', () => {
    expect(parseDraftRecord({ ...record(), selection: { anchor: 9, head: 2 } }).selection).toEqual({ anchor: 9, head: 2 })
  })

  it('多余的字段丢掉，返回的是新对象', () => {
    const raw = {
      ...record(),
      extra: 1,
      selection: { anchor: 1, head: 2, goal: 5 },
      binding: { ...binding(), format: { bom: false } },
    }
    const parsed = parseDraftRecord(raw)
    expect(parsed).toEqual({ ...record(), selection: { anchor: 1, head: 2 } })
    expect(Object.keys(parsed).sort()).toEqual(['binding', 'selection', 'text', 'updatedAt', 'version'])
    expect(Object.keys(parsed.selection ?? {}).sort()).toEqual(['anchor', 'head'])
    expect(Object.keys(parsed.binding ?? {}).sort()).toEqual(['id', 'libraryDir', 'relPath', 'savedBody', 'sha256', 'size', 'title'])
    expect(parsed).not.toBe(raw)
    expect(parsed.binding).not.toBe(raw.binding)
  })

  it('可以经过 JSON 往返', () => {
    expect(parseDraftRecord(JSON.parse(JSON.stringify(record())))).toEqual(record())
  })
})

describe('parseDraftRecord：不合法记录', () => {
  it('不是对象', () => {
    for (const raw of [null, undefined, 'text', 1, true, []]) expectRejected(raw, 'record')
  })

  it('version 不是 1', () => {
    expectRejected({ ...record(), version: 2 }, 'version')
    expectRejected({ ...record(), version: '1' }, 'version')
    const { version: _version, ...withoutVersion } = record()
    expectRejected(withoutVersion, 'version')
  })

  it('text 不是字符串', () => {
    expectRejected({ ...record(), text: 1 }, 'text')
    expectRejected({ ...record(), text: null }, 'text')
    const { text: _text, ...withoutText } = record()
    expectRejected(withoutText, 'text')
  })

  it('updatedAt 不是字符串', () => {
    expectRejected({ ...record(), updatedAt: 1_700_000_000_000 }, 'updatedAt')
    const { updatedAt: _updatedAt, ...withoutUpdatedAt } = record()
    expectRejected(withoutUpdatedAt, 'updatedAt')
  })

  it('selection 缺失或不是对象', () => {
    const { selection: _selection, ...withoutSelection } = record()
    expectRejected(withoutSelection, 'selection')
    expectRejected({ ...record(), selection: [1, 2] }, 'selection')
    expectRejected({ ...record(), selection: 'all' }, 'selection')
  })

  it('选区的位置不是非负整数', () => {
    for (const anchor of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '3', null, 2 ** 53]) {
      expectRejected({ ...record(), selection: { anchor, head: 0 } }, 'selection.anchor')
    }
    expectRejected({ ...record(), selection: { anchor: 0 } }, 'selection.head')
  })

  it('binding 缺失或不是对象', () => {
    const { binding: _binding, ...withoutBinding } = record()
    expectRejected(withoutBinding, 'binding')
    expectRejected({ ...record(), binding: 'x' }, 'binding')
  })

  it('binding 的字段缺失或类型不对', () => {
    const stringFields = ['libraryDir', 'relPath', 'title', 'sha256', 'savedBody'] as const
    for (const field of stringFields) {
      expectRejected({ ...record(), binding: { ...binding(), [field]: 1 } }, `binding.${field}`)
      const partial = Object.fromEntries(Object.entries(binding()).filter(([key]) => key !== field))
      expectRejected({ ...record(), binding: partial }, `binding.${field}`)
    }
    expectRejected({ ...record(), binding: { ...binding(), id: 1 } }, 'binding.id')
    const { id: _id, ...withoutId } = binding()
    expectRejected({ ...record(), binding: withoutId }, 'binding.id')
  })

  it('文件大小不是非负整数', () => {
    for (const size of [-1, 1.5, '1234', null]) {
      expectRejected({ ...record(), binding: { ...binding(), size } }, 'binding.size')
    }
  })
})

describe('draftRecordSchema', () => {
  it('parse 就是 parseDraftRecord', () => {
    expect(draftRecordSchema.parse(record())).toEqual(record())
    expect(() => draftRecordSchema.parse({ version: 1 })).toThrow(Error)
  })
})
