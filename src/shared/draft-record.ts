// 草稿记录的校验（需求 6.5、E-02，技术方案 4.5、7.5）。
//
// dsh 的存储服务在打开存储单元时对每条记录调用 `schema.parse()`，只要求有这一个方法，
// 所以这里自己写校验，以 `{ parse }` 的形式交给 `domainTable`，不为此引入 zod。
// 校验不过就抛错：存储服务把它报成 invalid-record，Host 再报 `promptx/draft/unreadable`，
// 小窗保持不可编辑、不覆盖原记录（F-01）。错误信息会进日志，所以只写字段名，不带任何字段的值。

import type { Binding, DraftRecord, EntryMetadataDraft, TextSelection } from './types.ts'

type Fields = Record<string, unknown>

function fail(message: string): never {
  throw new Error(`invalid draft record: ${message}`)
}

function isObject(value: unknown): value is Fields {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function expectString(value: unknown, field: string): string {
  if (typeof value !== 'string') fail(`${field} must be a string`)
  return value
}

function expectCount(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) fail(`${field} must be a non-negative integer`)
  return value
}

/**
 * 只检查选区是两个非负整数，不和正文长度比对：长度对不上不该让整份草稿读不出来，
 * 恢复选区时由编辑器按文档长度收紧。
 */
function parseSelection(value: unknown): TextSelection {
  if (!isObject(value)) fail('selection must be null or an object')
  return {
    anchor: expectCount(value.anchor, 'selection.anchor'),
    head: expectCount(value.head, 'selection.head'),
  }
}

/** 绑定只检查字段齐全、类型正确；路径和摘要是否还对得上，由 LibraryService 在用到时核对。 */
function parseBinding(value: unknown): Binding {
  if (!isObject(value)) fail('binding must be null or an object')
  const id = value.id
  if (id !== null && typeof id !== 'string') fail('binding.id must be a string or null')
  return {
    libraryDir: expectString(value.libraryDir, 'binding.libraryDir'),
    relPath: expectString(value.relPath, 'binding.relPath'),
    id,
    title: expectString(value.title, 'binding.title'),
    sha256: expectString(value.sha256, 'binding.sha256'),
    size: expectCount(value.size, 'binding.size'),
    savedBody: expectString(value.savedBody, 'binding.savedBody'),
  }
}

function parseEntryMetadata(value: unknown): EntryMetadataDraft {
  if (!isObject(value)) fail('entryMetadata must be an object')
  if (!Array.isArray(value.savedTags)) fail('entryMetadata.savedTags must be an array')
  return {
    title: expectString(value.title, 'entryMetadata.title'),
    tags: expectString(value.tags, 'entryMetadata.tags'),
    savedTags: value.savedTags.map(tag => expectString(tag, 'entryMetadata.savedTags item')),
    ...(value.folder === undefined ? {} : { folder: expectString(value.folder, 'entryMetadata.folder') }),
  }
}

/**
 * 严格校验一条草稿记录，返回只含已知字段的新对象（多余的字段丢掉）。
 * 不合法时抛出 Error，信息里不含用户内容。
 */
export function parseDraftRecord(raw: unknown): DraftRecord {
  if (!isObject(raw)) fail('record must be an object')
  if (raw.version !== 1) fail('version must be 1')
  const binding = raw.binding === null ? null : parseBinding(raw.binding)
  if (raw.entryMetadata !== undefined && binding === null) fail('entryMetadata needs a binding')
  return {
    version: 1,
    text: expectString(raw.text, 'text'),
    selection: raw.selection === null ? null : parseSelection(raw.selection),
    binding,
    updatedAt: expectString(raw.updatedAt, 'updatedAt'),
    ...(raw.entryMetadata === undefined ? {} : { entryMetadata: parseEntryMetadata(raw.entryMetadata) }),
  }
}

/** 交给 dsh 存储服务的记录校验器（形状同 zod 的 schema，存储服务只调用 parse）。 */
export const draftRecordSchema = { parse: parseDraftRecord }
