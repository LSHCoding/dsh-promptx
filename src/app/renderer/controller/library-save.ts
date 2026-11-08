// 保存到库（需求 L-08、L-12，技术方案 5.5「库保存」，审查 S05）：
// - 同一时间只有一个 library.save 在途；在途时再按 ⌘S 合并成一次，等结果回来后用新的绑定再发；
// - 新建文件的请求带 requestId，超时后重发用同一个 id，插件返回已经建好的文件，不会建出第二个；
// - 超时属于「结果未知」：先重新读取这一条核对，再允许重试；
// - 保存完成时编辑区已经换成别的条目或被清空，不改动当前的绑定。

import type { MessageKey } from '../../../shared/i18n/index.ts'
import type { Binding, LibraryReadResult, SaveConflict, SaveMode } from '../../../shared/types.ts'
import { isBlank } from '../../../shared/text-metrics.ts'
import type { DialogButton, DialogSpec } from '../state/state.ts'
import { dialogButton, randomId, reason, text, type Context } from './context.ts'
import type { Dialogs } from './dialogs.ts'
import type { Draft } from './draft.ts'
import type { Toasts } from './toasts.ts'

export type SaveOutcome = 'saved' | 'blank' | 'conflict' | 'cancelled' | 'failed'

/** 从读取结果生成绑定：在编辑器中打开、重新载入磁盘版本时用。 */
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
  private followUp: Promise<SaveOutcome> | null = null
  /** 结果未知的新建请求：同一代绑定下重试时沿用它的 requestId。 */
  private pendingCreate: { requestId: string; generation: number } | null = null

  constructor(
    private readonly ctx: Context,
    private readonly draft: Draft,
    private readonly toasts: Toasts,
    private readonly dialogs: Dialogs,
    /** 保存后刷新侧栏列表（新条目出现在列表里）。 */
    private readonly afterSave: () => void,
  ) {}

  /** ⌘S 或工具栏「保存」。返回这次（或合并后的那次）保存的结果，供「在编辑器中打开」的「保存」判断要不要继续载入。 */
  save(): Promise<SaveOutcome> {
    if (this.current !== null) {
      this.followUp ??= this.current.then((outcome) => {
        this.followUp = null
        return outcome === 'saved' ? this.start('normal') : outcome
      })
      return this.followUp
    }
    return this.start('normal')
  }

  /** 有保存在途（含冲突对话框还没选完）。 */
  get busy(): boolean {
    return this.current !== null
  }

  private start(mode: SaveMode): Promise<SaveOutcome> {
    const run: Promise<SaveOutcome> = this.perform(mode).finally(() => {
      if (this.current !== run) return
      this.current = null
      this.setSaving(false)
    })
    this.current = run
    this.setSaving(true)
    return run
  }

  private setSaving(librarySaving: boolean): void {
    this.ctx.store.update(state => (state.draft.librarySaving === librarySaving
      ? state
      : { ...state, draft: { ...state.draft, librarySaving } }))
  }

  private async perform(mode: SaveMode): Promise<SaveOutcome> {
    if (!this.draft.ready) return 'failed'
    // 写入的是按下保存那一刻的内容，之后继续输入不影响这次写入（L-08）。
    const body = this.ctx.editor.getText()
    if (isBlank(body)) {
      this.toasts.error(text(this.ctx, 'toast.nothingToSave'))
      return 'blank'
    }
    const generation = this.draft.generation
    const binding = mode === 'saveAsNew' ? null : this.draft.binding
    const creating = binding === null
    const requestId = creating ? this.createRequestId(generation) : randomId()
    const folder = creating && mode !== 'saveAsNew' ? this.targetFolder() : null
    const result = await this.ctx.bridge.call('library.save', { text: body, binding, folder, mode, requestId })
    if (!result.ok) {
      if (result.error.code === 'promptx/channel/timeout') return this.afterTimeout(binding, body, generation)
      if (creating) this.pendingCreate = null
      this.toasts.error(text(this.ctx, 'toast.saveFailed', { reason: reason(this.ctx, result.error) }))
      return 'failed'
    }
    if (creating) this.pendingCreate = null
    if (result.value.kind === 'saved') {
      this.applySaved(result.value.binding, generation)
      return 'saved'
    }
    return this.resolveConflict(result.value.conflict, generation)
  }

  /** 新建文件的位置：库侧栏展开且选中了一个真实文件夹时存进那个文件夹，其他情况存库根目录（L-08）。 */
  private targetFolder(): string | null {
    const library = this.ctx.store.getState().library
    return library.open && library.view === 'library' && library.folder.kind === 'folder' ? library.folder.path : null
  }

  private createRequestId(generation: number): string {
    if (this.pendingCreate?.generation !== generation) this.pendingCreate = { requestId: randomId(), generation }
    return this.pendingCreate.requestId
  }

  private applySaved(binding: Binding, generation: number): void {
    if (generation === this.draft.generation) {
      this.draft.setBinding(binding, false)
      this.draft.flushSoon()
      // 保存期间继续输入了：底栏是「未保存」，并说明只存了提交时的内容（L-08）。
      const unchanged = this.ctx.editor.getText() === binding.savedBody
      this.toasts.success(text(this.ctx, unchanged ? 'toast.saved' : 'toast.savedPartial'))
    } else {
      this.toasts.success(text(this.ctx, 'toast.saved'))
    }
    this.afterSave()
  }

  /** 保存请求超时：结果未知，先核对再允许重试（技术方案 5.5，审查 S05）。 */
  private async afterTimeout(binding: Binding | null, body: string, generation: number): Promise<SaveOutcome> {
    if (binding !== null) {
      const read = await this.ctx.bridge.call('library.read', { relPath: binding.relPath })
      const stillBound = generation === this.draft.generation && this.draft.binding?.relPath === binding.relPath
      if (read.ok && stillBound && read.value.body === body) {
        // 写入其实完成了：绑定到磁盘上的这个版本，下次保存不会把自己的写入当成外部修改。
        this.applySaved(bindingFromRead(binding.libraryDir, read.value), generation)
        return 'saved'
      }
    } else {
      // 新建：保留 requestId，重试时插件直接返回已经建好的文件。刷新列表，用户能看到它是不是已经建好了。
      this.afterSave()
    }
    this.toasts.error(text(this.ctx, 'toast.saveTimedOut'))
    return 'failed'
  }

  private async resolveConflict(conflict: SaveConflict, generation: number): Promise<SaveOutcome> {
    // 保存完成时编辑区已经换了内容来源：这个冲突说的是之前的绑定，不再打扰用户。
    if (generation !== this.draft.generation) return 'conflict'
    const button = (id: string, label: MessageKey, tone?: DialogButton['tone']): DialogButton => dialogButton(this.ctx, id, label, tone)
    const cancel = button('cancel', 'common.cancel')
    const saveAsNew = button('saveAsNew', 'dialog.saveAsNew')
    let spec: DialogSpec
    switch (conflict) {
      case 'modified':
        spec = {
          title: text(this.ctx, 'dialog.modified.title'),
          message: text(this.ctx, 'dialog.modified.message'),
          buttons: [cancel, saveAsNew, button('reload', 'dialog.reload', 'primary')],
          defaultButton: 'cancel',
          escapeButton: 'cancel',
        }
        break
      case 'missing':
        spec = {
          title: text(this.ctx, 'dialog.missing.title'),
          message: text(this.ctx, 'dialog.missing.message', { title: this.draft.binding?.title ?? '' }),
          buttons: [cancel, { ...saveAsNew, tone: 'primary' }],
          defaultButton: 'cancel',
          escapeButton: 'cancel',
        }
        break
      case 'noFrontMatter':
        spec = {
          title: text(this.ctx, 'dialog.frontMatter.title'),
          message: text(this.ctx, 'dialog.frontMatter.message'),
          buttons: [cancel, saveAsNew, button('addFrontMatter', 'dialog.frontMatter.confirm', 'primary')],
          defaultButton: 'addFrontMatter',
          escapeButton: 'cancel',
        }
        break
      case 'invalidFrontMatter':
        spec = {
          title: text(this.ctx, 'dialog.invalidMeta.title'),
          message: text(this.ctx, 'dialog.invalidMeta.message'),
          buttons: [cancel, { ...saveAsNew, tone: 'primary' }],
          defaultButton: 'cancel',
          escapeButton: 'cancel',
        }
        break
    }
    const choice = await this.dialogs.open(spec)
    if (generation !== this.draft.generation) return 'cancelled'
    switch (choice.button) {
      // 另存为新 Prompt 一律存到库根目录（L-12）。
      case 'saveAsNew':
        return this.perform('saveAsNew')
      case 'addFrontMatter':
        return this.perform('addFrontMatter')
      case 'reload':
        await this.reload()
        return 'conflict'
      default:
        return 'cancelled'
    }
  }

  /** 重新载入磁盘版本（L-12）：整篇替换并清空撤销记录，绑定到磁盘上的新版本。 */
  async reload(): Promise<void> {
    const binding = this.draft.binding
    if (binding === null) return
    // 用户选「重新载入」时编辑区里的这份可以替换。读取期间编辑区又有了改动就不替换：整篇替换会清空撤销记录，
    // 这些改动没有提示就丢了（红线 1；和「在编辑器中打开」同样处理，外部审查第 1 条）。
    const replaceable = this.ctx.editor.getText()
    const read = await this.ctx.bridge.call('library.read', { relPath: binding.relPath })
    if (!read.ok) {
      this.toasts.error(text(this.ctx, 'toast.readFailed', { reason: reason(this.ctx, read.error) }))
      return
    }
    if (this.draft.binding?.relPath !== binding.relPath) return
    if (this.ctx.editor.getText() !== replaceable) {
      this.toasts.error(text(this.ctx, 'toast.editedWhileLoading'))
      return
    }
    this.ctx.editor.load(read.value.body, this.ctx.editor.getSelection())
    this.draft.setBinding(bindingFromRead(binding.libraryDir, read.value), true)
    this.draft.flushSoon()
    this.toasts.success(text(this.ctx, 'toast.reloaded'))
  }
}
