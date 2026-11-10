// 主窗口的保存始终新建库条目；已有条目的更新只由独立编辑窗口发起。
// 同一时刻只发一次新建，超时重试沿用 requestId，防止连续按键和未知结果产生重复文件。

import type { Binding, LibraryReadResult } from '../../../shared/types.ts'
import { isBlank } from '../../../shared/text-metrics.ts'
import { randomId, reason, text, type Context } from './context.ts'
import type { Draft } from './draft.ts'
import type { Toasts } from './toasts.ts'

export type SaveOutcome = 'saved' | 'blank' | 'conflict' | 'cancelled' | 'failed'

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
  private pendingCreate: { requestId: string; generation: number } | null = null
  /** 仅供保存完成提示和端到端结果展示，不作为后续写入的绑定。 */
  lastSavedRelPath: string | null = null

  constructor(
    private readonly ctx: Context,
    private readonly draft: Draft,
    private readonly toasts: Toasts,
    private readonly afterSave: () => void,
  ) {}

  save(): Promise<SaveOutcome> {
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
    if (this.pendingCreate?.generation !== generation) {
      this.pendingCreate = { requestId: randomId(), generation }
    }
    const requestId = this.pendingCreate.requestId
    const result = await this.ctx.bridge.call('library.save', {
      text: body,
      binding: null,
      folder: this.targetFolder(),
      mode: 'normal',
      requestId,
    })
    if (!result.ok) {
      if (result.error.code === 'promptx/channel/timeout') {
        // 新建是否完成尚不确定，保留 id；下一次保存让 Host 返回同一次创建的结果。
        this.afterSave()
        this.toasts.error(text(this.ctx, 'toast.saveTimedOut'))
      } else {
        this.pendingCreate = null
        this.toasts.error(text(this.ctx, 'toast.saveFailed', { reason: reason(this.ctx, result.error) }))
      }
      return 'failed'
    }
    this.pendingCreate = null
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

  private targetFolder(): string | null {
    const { open, view, folder, list } = this.ctx.store.getState().library
    if (!open || view !== 'library' || folder.kind !== 'folder') return null
    return list?.folders.includes(folder.path) === true ? folder.path : null
  }
}
