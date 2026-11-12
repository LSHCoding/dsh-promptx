// 主窗口的保存始终新建库条目；已有条目的更新只由独立编辑窗口发起。
// 同一时刻只发一次新建，超时重试沿用 requestId，防止连续按键和未知结果产生重复文件。

import type { BridgeResult } from '../../../shared/bridge.ts'
import { normalizeTagPhrases } from '../../../shared/library-rules.ts'
import type { CompanionRequests } from '../../../shared/protocol.ts'
import type { Binding, LibraryReadResult, PromptMetadata, SaveResult } from '../../../shared/types.ts'
import { isBlank } from '../../../shared/text-metrics.ts'
import type { MetadataForm } from '../state/state.ts'
import { dialogButton, randomId, reason, text, type Context } from './context.ts'
import type { Dialogs } from './dialogs.ts'
import type { Draft } from './draft.ts'
import type { Toasts } from './toasts.ts'

export type SaveOutcome = 'saved' | 'blank' | 'conflict' | 'cancelled' | 'failed'
export const CONFIRM_METADATA_BUTTON = 'confirmMetadata'

type SaveRequest = CompanionRequests['library.save']['params'] & { metadata: PromptMetadata }

interface PendingCreate {
  generation: number
  request: SaveRequest
}

export function bindingFromRead(libraryDir: string, read: LibraryReadResult): Binding {
  return {
    libraryDir,
    relPath: read.entry.relPath,
    id: read.entry.id,
    title: read.entry.title,
    sha256: read.version.sha256,
    size: read.version.size,
    savedBody: read.body,
  }
}

export class LibrarySave {
  private current: Promise<SaveOutcome> | null = null
  private pendingCreate: PendingCreate | null = null
  private disposed = false
  /** 仅供保存完成提示和端到端结果展示，不作为后续写入的绑定。 */
  lastSavedRelPath: string | null = null

  constructor(
    private readonly ctx: Context,
    private readonly draft: Draft,
    private readonly toasts: Toasts,
    private readonly dialogs: Dialogs,
    private readonly afterSave: () => void,
  ) {}

  save(): Promise<SaveOutcome> {
    if (this.disposed) return Promise.resolve('failed')
    if (this.current !== null) return this.current
    const run = this.perform().finally(() => {
      if (this.current !== run) return
      this.current = null
      this.setSaving(false)
    })
    this.current = run
    this.setSaving(true)
    return run
  }

  saveAsNew(): Promise<SaveOutcome> {
    return this.save()
  }

  get busy(): boolean {
    return this.current !== null
  }

  dispose(): void {
    this.disposed = true
  }

  private setSaving(librarySaving: boolean): void {
    this.ctx.store.update(state => (state.draft.librarySaving === librarySaving
      ? state
      : { ...state, draft: { ...state.draft, librarySaving } }))
  }

  private async perform(): Promise<SaveOutcome> {
    if (!this.draft.ready) return 'failed'
    const body = this.ctx.editor.getText()
    if (isBlank(body)) {
      this.toasts.error(text(this.ctx, 'toast.nothingToSave'))
      return 'blank'
    }
    const generation = this.draft.generation
    const libraryDir = this.draft.libraryDir
    const pending = this.pendingCreate
    this.pendingCreate = null
    const retry = pending?.generation === generation && pending.request.libraryDir === libraryDir
      ? pending.request
      : null
    // 超时后的重试提交原来确认过的正文、元数据和目标，Host 可按同一个 id 返回已建好的条目。
    let request = retry
    let form: MetadataForm
    let folderOptions: readonly string[] = []
    let formError: string | undefined
    let manual = false
    if (retry === null) {
      const [metadata, folders] = await Promise.all([this.suggestMetadata(body), this.getFolders(libraryDir)])
      if (this.cancelled(generation, libraryDir)) return 'cancelled'
      manual = metadata === null
      form = { title: metadata?.title ?? '', tags: metadata?.tags.join(', ') ?? '' }
      folderOptions = folders
    } else {
      form = { title: retry.metadata.title, tags: retry.metadata.tags.join(', '), folder: retry.folder ?? '' }
    }

    while (true) {
      if (request === null) {
        const choice = await this.dialogs.open({
          title: text(this.ctx, 'dialog.saveMetadata.title'),
          ...(manual ? { message: text(this.ctx, 'dialog.saveMetadata.manual') } : {}),
          ...(formError === undefined ? {} : { error: formError }),
          buttons: [
            dialogButton(this.ctx, 'cancel', 'common.cancel'),
            dialogButton(this.ctx, CONFIRM_METADATA_BUTTON, 'dialog.saveMetadata.confirm', 'primary'),
          ],
          defaultButton: CONFIRM_METADATA_BUTTON,
          escapeButton: 'cancel',
          focusDefaultButton: formError === undefined,
          form,
          folderOptions,
        })
        if (choice.button !== CONFIRM_METADATA_BUTTON || choice.form === undefined || this.cancelled(generation, libraryDir)) return 'cancelled'
        const title = choice.form.title.trim()
        if (title === '') return 'cancelled'
        form = choice.form
        const expectedLibrary = libraryDir ?? this.draft.libraryDir
        const folder = form.folder !== undefined && folderOptions.includes(form.folder) ? form.folder : null
        request = {
          text: retry?.text ?? body,
          binding: null,
          folder,
          ...(folder === null ? {} : { folderMustExist: true }),
          mode: 'normal',
          requestId: randomId(),
          ...(expectedLibrary === undefined ? {} : { libraryDir: expectedLibrary }),
          metadata: { title, tags: normalizeTagPhrases([form.tags]) },
        }
      }

      const result = await this.ctx.bridge.call('library.save', request)
      if (this.disposed) return 'cancelled'
      if (!result.ok && (result.error.code === 'promptx/library/duplicate-title' || (request.folder !== null && result.error.code === 'promptx/library/not-found'))) {
        if (this.cancelled(generation, libraryDir)) return 'cancelled'
        // 模型检查和确认之间可能有其他写入。把已填字段带回对话框，让用户修正。
        formError = reason(this.ctx, result.error)
        folderOptions = await this.getFolders(libraryDir)
        if (this.cancelled(generation, libraryDir)) return 'cancelled'
        if (form.folder !== undefined && !folderOptions.includes(form.folder)) form = { ...form, folder: '' }
        request = null
        continue
      }
      return this.finishSave(generation, request, result)
    }
  }

  private async suggestMetadata(body: string): Promise<PromptMetadata | null> {
    this.setSuggesting(true)
    try {
      const result = await this.ctx.bridge.call('library.suggestMetadata', { text: body })
      return result.ok ? result.value.metadata : null
    } finally {
      this.setSuggesting(false)
    }
  }

  private setSuggesting(librarySuggesting: boolean): void {
    this.ctx.store.update(state => ({ ...state, draft: { ...state.draft, librarySuggesting } }))
  }

  private cancelled(generation: number, libraryDir: string | undefined): boolean {
    if (this.disposed) return true
    if (libraryDir !== undefined && libraryDir !== this.draft.libraryDir) {
      this.toasts.error(text(this.ctx, 'toast.libraryChanged'))
      return true
    }
    return generation !== this.draft.generation
  }

  private finishSave(generation: number, request: SaveRequest, result: BridgeResult<SaveResult>): SaveOutcome {
    if (!result.ok) {
      if (result.error.code === 'promptx/channel/timeout') {
        this.pendingCreate = { generation, request }
        this.afterSave()
        this.toasts.error(text(this.ctx, 'toast.saveTimedOut'))
      } else {
        this.toasts.error(text(this.ctx, 'toast.saveFailed', { reason: reason(this.ctx, result.error) }))
      }
      return 'failed'
    }
    if (result.value.kind !== 'saved') return 'conflict'
    this.lastSavedRelPath = result.value.entry.relPath
    if (generation === this.draft.generation) {
      this.draft.markSaved(result.value.binding.savedBody)
      this.draft.flushSoon()
      const unchanged = this.ctx.editor.getText() === result.value.binding.savedBody
      this.toasts.success(text(this.ctx, unchanged ? 'toast.saved' : 'toast.savedPartial'))
    } else {
      this.toasts.success(text(this.ctx, 'toast.saved'))
    }
    this.afterSave()
    return 'saved'
  }

  private async getFolders(libraryDir: string | undefined): Promise<string[]> {
    if (libraryDir === undefined) return []
    const result = await this.ctx.bridge.call('library.folders', { libraryDir })
    return result.ok ? result.value.folders : []
  }
}
