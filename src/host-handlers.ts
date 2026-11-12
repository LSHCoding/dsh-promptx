// 小程序 → Host 的请求和通知分发。小程序是本机进程，但仍按不可信输入对待：每个参数先做类型检查，
// 路径等语义检查交给各服务（库服务会再规范化相对路径、拒绝符号链接）。
// 草稿保存只在这个连接上成功读回草稿之后才允许（design-spec 4.5：读回之前不保存，避免空草稿覆盖原记录）。

import type { DraftApi, HostPeer, LibraryApi, OptimizeApi } from './services.ts'
import { PromptxError } from './shared/errors.ts'
import type {
  Binding,
  CompanionStatus,
  ErrorInfo,
  FolderSel,
  LibraryScope,
  MetaPatch,
  PromptMetadata,
  RestoreTarget,
  SaveMode,
  TextSelection,
} from './shared/types.ts'

export interface CompanionHandlerDeps {
  draft: DraftApi
  entryDraft: DraftApi
  library: LibraryApi
  optimize: OptimizeApi
  suggestMetadata: (text: string) => Promise<PromptMetadata | null>
  openSettings: () => { open: string | null; navigated: boolean }
  onStatus: (status: CompanionStatus) => void
  onRestartRequest: () => void
}

/** 给新建立的连接注册所有处理函数。每个连接一份状态（是否已读回草稿）。 */
export function attachCompanionHandlers(peer: HostPeer, deps: CompanionHandlerDeps): void {
  let draftLoaded = false
  let entryDraftLoaded = false

  peer.handle('draft.load', async () => {
    const record = await deps.draft.load()
    draftLoaded = true
    return { record }
  })
  peer.handle('draft.save', (params) => {
    if (!draftLoaded) return Promise.reject(new PromptxError('promptx/draft/unreadable', 'draft not loaded on this connection'))
    const p = record(params)
    return deps.draft.save({ text: str(p.text, 'text'), selection: selection(p.selection), binding: binding(p.binding) })
  })

  peer.handle('entryDraft.load', async () => {
    entryDraftLoaded = false
    const record = await deps.entryDraft.load()
    entryDraftLoaded = true
    return { record }
  })
  peer.handle('entryDraft.save', (params) => {
    if (!entryDraftLoaded) return Promise.reject(new PromptxError('promptx/draft/unreadable', 'entry draft not loaded on this connection'))
    const p = record(params)
    const draft = { text: str(p.text, 'text'), selection: selection(p.selection), binding: binding(p.binding) }
    if (p.entryMetadata === undefined) return deps.entryDraft.save(draft)
    const metadata = record(p.entryMetadata)
    return deps.entryDraft.save({
      ...draft,
      entryMetadata: {
        title: str(metadata.title, 'entryMetadata.title'),
        tags: str(metadata.tags, 'entryMetadata.tags'),
        savedTags: strings(metadata.savedTags, 'entryMetadata.savedTags'),
        ...(metadata.folder === undefined ? {} : { folder: str(metadata.folder, 'entryMetadata.folder') }),
      },
    })
  })

  peer.handle('library.list', (params) => {
    const p = record(params)
    return deps.library.list({
      folder: folder(p.folder),
      scope: oneOf<LibraryScope>(p.scope, ['all', 'recent', 'favorites'], 'scope'),
      tag: nullableStr(p.tag, 'tag'),
      query: str(p.query, 'query'),
      refresh: bool(p.refresh, 'refresh'),
    })
  })
  peer.handle('library.read', params => deps.library.read(str(record(params).relPath, 'relPath')))
  peer.handle('library.folders', params => deps.library.folders(str(record(params).libraryDir, 'libraryDir')))
  peer.handle('library.createFolder', (params) => {
    const p = record(params)
    return deps.library.createFolder(str(p.name, 'name'), str(p.libraryDir, 'libraryDir'))
  })
  peer.handle('library.deleteFolder', (params) => {
    const p = record(params)
    return deps.library.deleteFolder(str(p.folder, 'folder'), str(p.libraryDir, 'libraryDir'))
  })
  peer.handle('library.suggestMetadata', async params => ({
    metadata: await deps.suggestMetadata(str(record(params).text, 'text')),
  }))
  peer.handle('library.save', (params) => {
    const p = record(params)
    return deps.library.save({
      text: str(p.text, 'text'),
      binding: binding(p.binding),
      folder: nullableStr(p.folder, 'folder'),
      mode: oneOf<SaveMode>(p.mode, ['normal', 'saveAsNew', 'addFrontMatter'], 'mode'),
      requestId: str(p.requestId, 'requestId'),
      ...(p.metadata === undefined ? {} : { metadata: metadataPatch(record(p.metadata), 'metadata') }),
      ...(p.libraryDir === undefined ? {} : { libraryDir: str(p.libraryDir, 'libraryDir') }),
      ...(p.folderMustExist === undefined ? {} : { folderMustExist: bool(p.folderMustExist, 'folderMustExist') }),
      ...(p.moveToFolder === undefined ? {} : { moveToFolder: str(p.moveToFolder, 'moveToFolder') }),
    })
  })
  peer.handle('library.updateMeta', (params) => {
    const p = record(params)
    return deps.library.updateMeta({
      relPath: str(p.relPath, 'relPath'),
      patch: metaPatch(p.patch),
      addFrontMatter: bool(p.addFrontMatter, 'addFrontMatter'),
      ...(p.tagPhrases === undefined ? {} : { tagPhrases: bool(p.tagPhrases, 'tagPhrases') }),
    })
  })
  peer.handle('library.delete', params => deps.library.delete(str(record(params).relPath, 'relPath')))
  peer.handle('trash.list', params => deps.library.trashList(str(record(params).query, 'query')))
  peer.handle('trash.read', params => deps.library.trashRead(str(record(params).file, 'file')))
  peer.handle('trash.restore', (params) => {
    const p = record(params)
    return deps.library.trashRestore({
      file: str(p.file, 'file'),
      target: oneOf<RestoreTarget>(p.target, ['original', 'alternative'], 'target'),
      alternative: nullableStr(p.alternative, 'alternative'),
      acceptModified: bool(p.acceptModified, 'acceptModified'),
      ...(p.libraryDir === undefined ? {} : { libraryDir: str(p.libraryDir, 'libraryDir') }),
    })
  })

  peer.handle('optimize.start', async params => ({ session: await deps.optimize.start(str(record(params).text, 'text')) }))
  peer.handle('optimize.followup', async params => ({ session: await deps.optimize.followup(str(record(params).text, 'text')) }))
  peer.handle('optimize.retry', async params => ({ session: await deps.optimize.retry(str(record(params).roundId, 'roundId')) }))
  peer.handle('optimize.cancel', () => ({ session: deps.optimize.cancel() }))
  peer.handle('optimize.clear', () => {
    deps.optimize.clear()
    return {}
  })
  peer.handle('optimize.state', () => ({ session: deps.optimize.state() }))

  peer.handle('host.openSettings', () => deps.openSettings())

  peer.on('status', (status) => {
    // 字段不合格的整条忽略：Host 拿 locale 选优化指令的语言、拿 rendererError 给配置页显示，不能用半截数据。
    const parsed = companionStatus(status)
    if (parsed !== null) deps.onStatus(parsed)
  })
  peer.on('host.restartCompanion', () => {
    deps.onRestartRequest()
  })
}

// ─────────── 参数检查：不合格时抛 promptx/internal（只带字段名，不带值） ───────────

function invalid(field: string): PromptxError {
  return new PromptxError('promptx/internal', `invalid parameter: ${field}`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw invalid('params')
  return value
}

function str(value: unknown, field: string): string {
  if (typeof value !== 'string') throw invalid(field)
  return value
}

function strings(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) throw invalid(field)
  return value as string[]
}

function nullableStr(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null
  return str(value, field)
}

function bool(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') throw invalid(field)
  return value
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) throw invalid(field)
  return value as T
}

function nonNegativeInt(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw invalid(field)
  return value
}

function selection(value: unknown): TextSelection | null {
  if (value === null || value === undefined) return null
  const v = record(value)
  return { anchor: nonNegativeInt(v.anchor, 'selection.anchor'), head: nonNegativeInt(v.head, 'selection.head') }
}

function folder(value: unknown): FolderSel {
  const v = record(value)
  if (v.kind === 'all') return { kind: 'all' }
  if (v.kind === 'root') return { kind: 'root' }
  if (v.kind === 'folder') return { kind: 'folder', path: str(v.path, 'folder.path') }
  throw invalid('folder')
}

function binding(value: unknown): Binding | null {
  if (value === null || value === undefined) return null
  const v = record(value)
  return {
    libraryDir: str(v.libraryDir, 'binding.libraryDir'),
    relPath: str(v.relPath, 'binding.relPath'),
    id: nullableStr(v.id, 'binding.id'),
    title: str(v.title, 'binding.title'),
    sha256: str(v.sha256, 'binding.sha256'),
    size: nonNegativeInt(v.size, 'binding.size'),
    savedBody: str(v.savedBody, 'binding.savedBody'),
  }
}

function errorInfo(value: unknown): ErrorInfo | null | undefined {
  if (value === null) return null
  if (!isRecord(value) || typeof value.code !== 'string') return undefined
  if (value.detail !== undefined && typeof value.detail !== 'string') return undefined
  return value.detail === undefined ? { code: value.code } : { code: value.code, detail: value.detail.slice(0, 300) }
}

/** status 通知的检查。shortcut 原样交给配置页（页面自己会再检查）；其余字段都要合格，否则返回 null。 */
export function companionStatus(value: unknown): CompanionStatus | null {
  if (!isRecord(value)) return null
  const { shortcut, tray, visible, locale } = value
  if (shortcut !== null && !isRecord(shortcut)) return null
  if (typeof tray !== 'boolean' || typeof visible !== 'boolean') return null
  if (locale !== 'zh' && locale !== 'en') return null
  const rendererError = errorInfo(value.rendererError)
  if (rendererError === undefined) return null
  return { shortcut: shortcut as CompanionStatus['shortcut'], tray, visible, locale, rendererError }
}

function metaPatch(value: unknown): MetaPatch {
  const v = record(value)
  const patch: MetaPatch = metadataPatch(v, 'patch')
  if (v.favorite !== undefined) patch.favorite = bool(v.favorite, 'patch.favorite')
  return patch
}

function metadataPatch(value: Record<string, unknown>, field: string): Partial<PromptMetadata> {
  const patch: Partial<PromptMetadata> = {}
  if (value.title !== undefined) patch.title = str(value.title, `${field}.title`)
  if (value.tags !== undefined) patch.tags = strings(value.tags, `${field}.tags`)
  return patch
}
