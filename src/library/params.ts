// 小窗传来的库请求参数的校验（design-spec 9「Host 再校验每个参数」）。协议层只管收发和配对，不检查参数的形状；
// 渲染进程出了问题、两端版本不一致时，参数可能缺字段或类型不对。这里把它们拦在服务之外：
// 形状不对报 promptx/internal（说明是 invalid-params 之类的固定词），不带参数的值；路径的校验在 rel-path.ts。

import { PromptxError } from '../shared/errors.ts'
import { normalizeTagPhrases, normalizeTags } from '../shared/library-rules.ts'
import type { Binding, FolderSel, LibraryListParams, LibraryScope, PromptMetadata, RestoreTarget, SaveMode } from '../shared/types.ts'

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item: unknown) => typeof item === 'string')
}

function invalid(detail = 'invalid-params'): PromptxError {
  return new PromptxError('promptx/internal', detail)
}

function expectString(value: unknown): string {
  if (typeof value !== 'string') throw invalid()
  return value
}

function expectBoolean(value: unknown): boolean {
  if (typeof value !== 'boolean') throw invalid()
  return value
}

function expectStringOrNull(value: unknown): string | null {
  if (value !== null && typeof value !== 'string') throw invalid()
  return value
}

function parseFolderSel(value: unknown): FolderSel {
  if (!isObject(value)) throw invalid()
  switch (value.kind) {
    case 'all':
      return { kind: 'all' }
    case 'root':
      return { kind: 'root' }
    case 'folder':
      // 路径只用来按前缀筛选，不碰文件系统：不存在或不合格的路径筛出空列表，小窗随后回到「全部」（L-03）
      return { kind: 'folder', path: expectString(value.path) }
    default:
      throw invalid()
  }
}

function parseScope(value: unknown): LibraryScope {
  if (value === 'all' || value === 'recent' || value === 'favorites') return value
  throw invalid()
}

export function parseListParams(value: unknown): LibraryListParams {
  if (!isObject(value)) throw invalid()
  return {
    folder: parseFolderSel(value.folder),
    scope: parseScope(value.scope),
    tag: expectStringOrNull(value.tag),
    query: expectString(value.query),
    refresh: expectBoolean(value.refresh),
  }
}

export interface SaveRequest {
  text: string
  /** 形状在用到时由 parseBinding 检查：另存为新 Prompt 不看绑定。 */
  binding: unknown
  folder: string | null
  mode: SaveMode
  requestId: string
  metadata: Partial<PromptMetadata> | undefined
  libraryDir: string | undefined
}

function parseSaveMode(value: unknown): SaveMode {
  if (value === 'normal' || value === 'saveAsNew' || value === 'addFrontMatter') return value
  throw invalid()
}

export function parseSaveRequest(value: unknown): SaveRequest {
  if (!isObject(value)) throw invalid()
  if (value.binding !== null && !isObject(value.binding)) throw invalid()
  return {
    text: expectString(value.text),
    binding: value.binding,
    folder: expectStringOrNull(value.folder),
    mode: parseSaveMode(value.mode),
    requestId: expectString(value.requestId),
    metadata: value.metadata === undefined ? undefined : parsePromptMetadata(value.metadata, true),
    libraryDir: value.libraryDir === undefined ? undefined : expectString(value.libraryDir),
  }
}

/** 绑定的字段齐全、类型正确时返回它（只含已知字段），否则返回 null。路径由调用方再校验。 */
export function parseBinding(value: unknown): Binding | null {
  if (!isObject(value)) return null
  const { libraryDir, relPath, id, title, sha256, size, savedBody } = value
  if (typeof libraryDir !== 'string' || typeof relPath !== 'string' || typeof title !== 'string') return null
  if (typeof sha256 !== 'string' || typeof savedBody !== 'string') return null
  if (id !== null && typeof id !== 'string') return null
  if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0) return null
  return { libraryDir, relPath, id, title, sha256, size, savedBody }
}

/** 整理过的元数据修改：标题已去掉首尾空白，标签已按 L-09 的规则整理。 */
export interface MetaRequest {
  title?: string
  tags?: string[]
  favorite?: boolean
}

function parsePromptMetadata(value: unknown, tagPhrases: boolean): Partial<PromptMetadata> {
  if (!isObject(value)) throw invalid()
  const request: Partial<PromptMetadata> = {}
  if (value.title !== undefined) {
    const title = expectString(value.title).trim()
    if (title === '' || /[\r\n\0\u2028\u2029]/u.test(title)) throw new PromptxError('promptx/library/invalid-title')
    request.title = title
  }
  if (value.tags !== undefined) {
    if (!isStringArray(value.tags)) throw invalid()
    request.tags = tagPhrases ? normalizeTagPhrases(value.tags) : normalizeTags(value.tags)
  }
  return request
}

function parseMetaPatch(value: unknown, tagPhrases: boolean): MetaRequest {
  if (!isObject(value)) throw invalid()
  const request: MetaRequest = parsePromptMetadata(value, tagPhrases)
  if (value.favorite !== undefined) request.favorite = expectBoolean(value.favorite)
  return request
}

export interface MetaUpdate {
  relPath: unknown
  patch: MetaRequest
  addFrontMatter: boolean
}

export function parseMetaUpdate(value: unknown): MetaUpdate {
  if (!isObject(value)) throw invalid()
  const tagPhrases = value.tagPhrases === undefined ? false : expectBoolean(value.tagPhrases)
  return { relPath: value.relPath, patch: parseMetaPatch(value.patch, tagPhrases), addFrontMatter: expectBoolean(value.addFrontMatter) }
}

export interface RestoreRequest {
  file: unknown
  target: RestoreTarget
  alternative: string | null
  acceptModified: boolean
}

export function parseRestoreRequest(value: unknown): RestoreRequest {
  if (!isObject(value)) throw invalid()
  const target = value.target
  if (target !== 'original' && target !== 'alternative') throw invalid()
  return {
    file: value.file,
    target,
    alternative: expectStringOrNull(value.alternative),
    acceptModified: expectBoolean(value.acceptModified),
  }
}
