// 库条目的独立编辑会话。目标和原文件版本由主进程持有，子窗口不能改写主草稿或选择任意保存路径。
// 恢复记录与主草稿分开；关闭确认、库冲突和退出恢复均不能隐式覆盖 Prompt 文件。

import {
  entryFolderPatch, entryMetadataPatch, isEntryDirty,
  type BridgeResult, type EntryEditorSnapshot, type EntryMetadataFields, type ResolvedConfig,
} from '../../shared/bridge.ts'
import { toErrorInfo } from '../../shared/errors.ts'
import { translate, type MessageKey } from '../../shared/i18n/index.ts'
import type { CompanionRequests } from '../../shared/protocol.ts'
import { RpcError } from '../../shared/rpc.ts'
import type { Binding, EntryMetadataDraft, ErrorInfo, LibraryReadResult, PromptMetadata, SaveResult, TextSelection } from '../../shared/types.ts'
import { WINDOW_BACKGROUND } from './appearance.ts'
import type { CompanionLogger } from './logger.ts'
import type { CompanionPlatform, MainWindow, MessageBoxOptions } from './platform.ts'
import { runTask } from './tasks.ts'

type EntryMethod = 'entryDraft.load' | 'entryDraft.save' | 'library.folders' | 'library.read' | 'library.save'
type SaveParams = CompanionRequests['library.save']['params']

export interface EntryEditorOptions {
  platform: CompanionPlatform
  parent: MainWindow
  config(): ResolvedConfig | null
  request<M extends EntryMethod>(method: M, params: CompanionRequests[M]['params']): Promise<CompanionRequests[M]['result']>
  changed(libraryDir: string): void
  logger: CompanionLogger
}

const success: BridgeResult<null> = { ok: true, value: null }
const closed = { code: 'promptx/channel/closed' }

function bindingOf(libraryDir: string, read: LibraryReadResult): Binding {
  return {
    libraryDir, relPath: read.entry.relPath, id: read.entry.id, title: read.entry.title,
    sha256: read.version.sha256, size: read.version.size, savedBody: read.body,
  }
}

function metadataOf(title: string, savedTags: string[]): EntryMetadataDraft {
  return { title, tags: savedTags.join(', '), savedTags }
}

function errorInfoOf(error: unknown): ErrorInfo {
  if (error instanceof RpcError) return error.info
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
    ? error as ErrorInfo
    : toErrorInfo(error)
}

export class EntryEditorManager {
  private state: EntryEditorSnapshot | null = null
  private window: MainWindow | null = null
  private initialized = false
  private initializing: Promise<void> | null = null
  private currentSave: Promise<BridgeResult<null>> | null = null
  private pendingMove: { state: EntryEditorSnapshot; params: SaveParams } | null = null
  private transition: Promise<BridgeResult<null>> | null = null
  private writing: Promise<void> | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private revision = 0
  private persisted = 0
  private generation = 0
  private disposed = false
  private active = false
  private requestedGeneration = 0
  private nextFreezeId = 0
  private freezePromise: Promise<boolean> | null = null
  private exiting = false
  private preparing: {
    id: number
    generation: number
    resolve(ready: boolean): void
    timer: ReturnType<typeof setTimeout>
  } | null = null

  constructor(private readonly options: EntryEditorOptions) {}

  get focused(): boolean { return this.window?.isFocused() ?? false }
  get windowCreated(): boolean { return this.window !== null && !this.window.isDestroyed() }
  get stateRequested(): boolean { return this.state !== null && this.requestedGeneration === this.state.generation }
  acceptsGeneration(generation: unknown): boolean {
    return this.active && typeof generation === 'number' && Number.isSafeInteger(generation) && this.state?.generation === generation
  }
  canAct(generation: unknown): boolean {
    return !this.exiting && this.transition === null && this.state?.freezeId === null && this.acceptsGeneration(generation)
  }

  isSender(sender: unknown): boolean {
    return this.active && (this.window?.isSender(sender) ?? false)
  }

  getState(): BridgeResult<EntryEditorSnapshot> {
    if (this.state !== null && this.active) this.requestedGeneration = this.state.generation
    return this.state === null || !this.active ? { ok: false, error: closed } : { ok: true, value: this.snapshot() }
  }

  initialize(): Promise<void> {
    if (this.initialized) return Promise.resolve()
    this.initializing ??= this.loadRecovery().finally(() => { this.initializing = null })
    return this.initializing
  }

  private async loadRecovery(): Promise<void> {
    const { record } = await this.options.request('entryDraft.load', {})
    if (this.disposed) return
    if (record === null || record.binding === null || (record.text === record.binding.savedBody && record.entryMetadata === undefined)) {
      this.initialized = true
      return
    }
    const [metadata, folders] = await Promise.all([
      record.entryMetadata ?? this.readRecoveryMetadata(record.binding),
      this.readFolders(record.binding.libraryDir),
    ])
    if (this.isDisposed()) return
    this.initialized = true
    this.state = {
      generation: ++this.generation, binding: record.binding, text: record.text, selection: record.selection,
      metadata, folders,
      config: this.options.config(), saving: false, error: null, conflict: null, recovered: true, freezeId: null,
    }
    this.active = true
    this.ensureWindow()
    if (this.options.parent.isVisible()) this.show()
  }

  private async readRecoveryMetadata(binding: Binding): Promise<EntryMetadataDraft> {
    // 旧恢复记录不含标签。只有仍是原文件版本时才从库补回，避免把新版本的元数据混进旧草稿。
    if (binding.libraryDir === this.options.config()?.libraryDir) {
      const read = await this.options.request('library.read', { relPath: binding.relPath }).catch(() => null)
      if (read !== null && read.version.sha256 === binding.sha256 && read.version.size === binding.size) {
        return metadataOf(binding.title, read.entry.tags)
      }
    }
    return metadataOf(binding.title, [])
  }

  private async readFolders(libraryDir: string): Promise<string[]> {
    if (libraryDir !== this.options.config()?.libraryDir) return []
    const result = await this.options.request('library.folders', { libraryDir }).catch(() => null)
    return result?.folders ?? []
  }

  open(relPath: string): Promise<BridgeResult<null>> {
    return this.runTransition(() => this.openEntry(relPath))
  }

  private async openEntry(relPath: string): Promise<BridgeResult<null>> {
    await this.initialize()
    if (this.disposed || this.exiting) return { ok: false, error: closed }
    const libraryDir = this.options.config()?.libraryDir
    if (libraryDir === undefined) return { ok: false, error: closed }
    if (this.active && this.state?.binding.libraryDir === libraryDir && this.state.binding.relPath === relPath) {
      this.ensureWindow()
      this.show()
      return success
    }
    if (!(await this.freeze())) return this.fail({ code: 'promptx/channel/timeout' })
    if (!(await this.resolveUnsaved())) return success
    const revision = this.revision
    const [read, folders] = await Promise.all([this.options.request('library.read', { relPath }), this.readFolders(libraryDir)])
    if (this.isDisposed() || revision !== this.revision || libraryDir !== this.options.config()?.libraryDir) return success
    this.state = {
      generation: ++this.generation, binding: bindingOf(libraryDir, read), text: read.body,
      metadata: metadataOf(read.entry.title, read.entry.tags), folders,
      selection: { anchor: 0, head: 0 }, config: this.options.config(), saving: false,
      error: null, conflict: null, recovered: false, freezeId: null,
    }
    this.active = true
    this.revision++
    await this.flush()
    this.ensureWindow()
    this.publish()
    this.show()
    return success
  }

  update(text: string, selection: TextSelection, metadata?: EntryMetadataFields): void {
    if (this.state === null || !this.active || this.disposed) return
    if (this.state.freezeId !== null && this.preparing === null) return
    const length = text.length
    if (selection.anchor < 0 || selection.head < 0 || selection.anchor > length || selection.head > length) return
    const folderChanged = metadata?.folder !== undefined && metadata.folder !== this.state.metadata.folder
    this.state = {
      ...this.state, text, selection, metadata: { ...this.state.metadata, ...metadata },
      conflict: folderChanged && this.state.conflict === 'destinationOccupied' ? null : this.state.conflict,
      error: folderChanged && this.state.error?.code === 'promptx/library/folder-not-found' ? null : this.state.error,
    }
    this.revision++
    // 最迟首个修改后 600ms 落盘，连续输入不会无限推迟。
    if (this.timer === null) this.timer = setTimeout(() => {
      this.timer = null
      runTask(this.options.logger, 'entry-draft-save', this.flush())
    }, 600)
  }

  save(): Promise<BridgeResult<null>> {
    if (this.currentSave !== null) return this.currentSave
    const task = this.saveEntry().catch((error: unknown) => this.fail(error)).finally(() => {
      this.currentSave = null
      if (this.state !== null) this.state = { ...this.state, saving: false }
      this.publish()
    })
    this.currentSave = task
    return task
  }

  private async saveEntry(): Promise<BridgeResult<null>> {
    const current = this.state
    if (current === null || !this.active || this.disposed) return { ok: false, error: closed }
    const pending = this.pendingMove?.state.generation === current.generation ? this.pendingMove : null
    const state = pending?.state ?? current
    const metadata = entryMetadataPatch(state, state.metadata)
    const metadataChanged = Object.keys(metadata).length > 0
    const moveToFolder = entryFolderPatch(state.binding, state.metadata)
    // 仅按保存快捷键不能改写原文件的元数据或更新时间。
    if (pending === null && state.text === state.binding.savedBody && !metadataChanged && moveToFolder === undefined) return success
    if (state.binding.libraryDir !== this.options.config()?.libraryDir) {
      return this.fail({ code: 'promptx/library/unavailable', detail: 'library-changed' })
    }
    this.state = { ...current, saving: true, error: null, conflict: null }
    this.publish()
    let params: SaveParams = pending?.params ?? {
      text: state.text, binding: state.binding, folder: null, mode: 'normal',
      requestId: `entry-${this.options.platform.pid}-${Date.now()}-${this.revision}`,
      ...(metadataChanged ? { metadata } : {}),
      ...(moveToFolder === undefined ? {} : { moveToFolder, libraryDir: state.binding.libraryDir }),
    }
    this.pendingMove = null
    let result: SaveResult
    try {
      result = await this.options.request('library.save', params)
      if (result.kind === 'conflict' && result.conflict === 'noFrontMatter') {
        const revision = this.revision
        const answer = await this.confirm('frontMatter', ['entryEditor.cancel', 'entryEditor.frontMatterConfirm'], 0, 0)
        if (answer !== 1 || revision !== this.revision || state.binding.libraryDir !== this.options.config()?.libraryDir) return success
        params = { ...params, mode: 'addFrontMatter' }
        result = await this.options.request('library.save', params)
      }
    } catch (error) {
      const { code } = errorInfoOf(error)
      // 超时后 Host 可能已经移动成功。下次保存先重发原请求，确认新路径和版本后再提交继续输入的内容。
      if (params.moveToFolder !== undefined && code === 'promptx/channel/timeout') this.pendingMove = { state, params }
      if (code === 'promptx/library/folder-not-found') {
        const folders = await this.readFolders(state.binding.libraryDir)
        if (this.state.generation === state.generation) this.state = { ...this.state, folders }
      }
      throw error
    }
    if (this.state.generation !== state.generation) return success
    if (result.kind === 'conflict') {
      this.state = { ...this.state, conflict: result.conflict }
      this.publish()
      return { ok: false, error: { code: 'promptx/library/conflict', detail: result.conflict } }
    }
    // 保存期间的新输入留在当前文档；只推进文件版本与已保存的正文、标题和标签。
    const { title, tags, folder } = this.state.metadata
    this.state = {
      ...this.state, binding: result.binding,
      metadata: {
        // 无显式标题的旧文件由正文推导标题，正文保存后同步新标题。
        title: metadata.title === undefined && title === state.metadata.title ? result.binding.title : title,
        tags: metadata.tags === undefined && tags === state.metadata.tags ? result.entry.tags.join(', ') : tags,
        savedTags: result.entry.tags,
        ...(folder === undefined ? {} : { folder }),
      },
      error: null, conflict: null, recovered: false,
    }
    this.revision++
    await this.flush()
    this.options.changed(result.binding.libraryDir)
    this.publish()
    return success
  }

  reload(): Promise<BridgeResult<null>> {
    if (this.exiting) return Promise.resolve({ ok: false, error: closed })
    return this.runTransition(() => this.reloadEntry())
  }

  private async reloadEntry(): Promise<BridgeResult<null>> {
    try {
      if (this.currentSave !== null) await this.currentSave
      if (!(await this.freeze())) return this.fail({ code: 'promptx/channel/timeout' })
      const state = this.state
      if (state === null || !this.active) return { ok: false, error: closed }
      if (state.binding.libraryDir !== this.options.config()?.libraryDir) return this.fail({ code: 'promptx/library/unavailable', detail: 'library-changed' })
      const revision = this.revision
      if (this.dirty()) {
        const answer = await this.confirm('reload', ['entryEditor.cancel', 'entryEditor.reloadConfirm'], 0, 0)
        if (answer !== 1 || revision !== this.revision) return success
      }
      const [read, folders] = await Promise.all([
        this.options.request('library.read', { relPath: state.binding.relPath }), this.readFolders(state.binding.libraryDir),
      ])
      if (revision !== this.revision || state.binding.libraryDir !== this.options.config()?.libraryDir) return success
      this.state = {
        ...state, generation: ++this.generation, text: read.body, selection: { anchor: 0, head: 0 },
        metadata: metadataOf(read.entry.title, read.entry.tags), folders,
        binding: bindingOf(state.binding.libraryDir, read), error: null, conflict: null, recovered: false, freezeId: null,
      }
      this.revision++
      await this.flush()
      this.publish()
      return success
    } catch (error) { return this.fail(error) }
  }

  close(): Promise<void> {
    if (this.exiting) return Promise.resolve()
    return this.runTransition(async () => {
      if (this.disposed) return { ok: false, error: closed }
      if (!(await this.freeze())) return this.fail({ code: 'promptx/channel/timeout' })
      if (!(await this.resolveUnsaved())) return success
      await this.flush()
      this.active = false
      this.window?.hide()
      this.options.parent.focus()
      return success
    }).then(() => {})
  }

  private runTransition(run: () => Promise<BridgeResult<null>>): Promise<BridgeResult<null>> {
    if (this.transition !== null) return this.transition
    const task = Promise.resolve().then(run).catch((error: unknown) => this.fail(error)).finally(() => {
      this.transition = null
      if (this.state !== null && this.state.freezeId !== null && !this.exiting) {
        this.state = { ...this.state, freezeId: null }
        this.publish()
      }
    })
    this.transition = task
    return task
  }

  private freeze(): Promise<boolean> {
    // 尚未请求初始文档的页面不能编辑，无需等它冻结；复用窗口之后仍须握手，不能只比较当前代次。
    if (!this.active || this.state === null || this.window === null || this.requestedGeneration === 0) return Promise.resolve(true)
    if (this.freezePromise !== null) return this.freezePromise
    if (this.state.freezeId !== null) return Promise.resolve(true)
    const id = ++this.nextFreezeId
    const generation = this.state.generation
    this.state = { ...this.state, freezeId: id }
    const ready = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        if (this.preparing?.id !== id) return
        this.preparing = null
        resolve(false)
      }, 1500)
      this.preparing = { id, generation, resolve, timer }
    })
    this.freezePromise = ready.finally(() => { this.freezePromise = null })
    this.publish()
    return this.freezePromise
  }

  prepared(id: number, generation: number, text: string, selection: TextSelection, metadata?: EntryMetadataFields): void {
    const pending = this.preparing
    if (pending === null || pending.id !== id || pending.generation !== generation || !this.acceptsGeneration(generation)) return
    if (selection.anchor < 0 || selection.head < 0 || selection.anchor > text.length || selection.head > text.length) return
    // 界面进入只读后回传最终编辑内容，主进程据此判断是否有未保存的修改。
    this.update(text, selection, metadata)
    clearTimeout(pending.timer)
    this.preparing = null
    pending.resolve(true)
  }

  async flushForExit(): Promise<void> {
    this.exiting = true
    await this.freeze()
    await this.flush()
  }

  sendE2eText(text: string, metadata?: PromptMetadata, folder?: string): void {
    this.window?.send('e2e', {
      id: 0, action: 'entry-edit-text', text,
      ...(metadata === undefined ? {} : { metadata }), ...(folder === undefined ? {} : { folder }),
    })
  }

  private dirty(): boolean {
    const state = this.state
    return state !== null && isEntryDirty(state, state.text, state.metadata)
  }

  private async resolveUnsaved(): Promise<boolean> {
    if (this.currentSave !== null) await this.currentSave
    if (!this.active || !this.dirty()) return true
    const revision = this.revision
    const answer = await this.confirm('unsaved', ['entryEditor.cancel', 'entryEditor.discard', 'entryEditor.save'], 2, 0)
    if (answer === 0 || revision !== this.revision) return false
    if (answer === 2) {
      const result = await this.save()
      return result.ok && !this.dirty()
    }
    if (this.state !== null) {
      this.state = {
        ...this.state, generation: ++this.generation, text: this.state.binding.savedBody,
        metadata: metadataOf(this.state.binding.title, this.state.metadata.savedTags),
        selection: null, error: null, conflict: null,
      }
      this.revision++
      await this.flush()
      this.publish()
    }
    return true
  }

  private confirm(
    kind: 'unsaved' | 'reload' | 'frontMatter', buttons: MessageKey[], defaultId: number, cancelId: number,
  ): Promise<number> {
    const window = this.window ?? this.options.parent
    const locale = this.options.config()?.resolvedLocale ?? 'en'
    const keys = {
      unsaved: ['entryEditor.unsavedTitle', 'entryEditor.unsavedMessage'],
      reload: ['entryEditor.reloadTitle', 'entryEditor.reloadMessage'],
      frontMatter: ['entryEditor.frontMatterTitle', 'entryEditor.frontMatterMessage'],
    } as const
    const [title, message] = keys[kind]
    const box: MessageBoxOptions = {
      title: translate(locale, title), message: translate(locale, message, { title: this.state?.binding.title ?? '' }),
      buttons: buttons.map(key => translate(locale, key)), defaultId, cancelId,
    }
    return this.options.platform.showMessageBox(window, box)
  }

  flush(): Promise<void> {
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
    if (this.writing !== null) return this.writing.then(() => this.flush())
    if (!this.initialized || this.state === null || this.persisted === this.revision) return Promise.resolve()
    const revision = this.revision
    const { text, selection, binding, metadata } = this.state
    const metadataChanged = isEntryDirty(this.state, binding.savedBody, metadata)
    const task = this.options.request('entryDraft.save', {
      text, selection, binding, ...(metadataChanged ? { entryMetadata: metadata } : {}),
    }).then(() => {
      this.persisted = revision
    }).catch((error: unknown) => {
      this.fail(error)
      throw error
    }).finally(() => { this.writing = null })
    this.writing = task
    return task
  }

  applyConfig(): void {
    if (this.state === null) return
    this.state = { ...this.state, config: this.options.config() }
    this.publish()
  }

  show(): void {
    if (!this.active || this.window === null || this.disposed) return
    this.window.show()
    this.window.focus()
    this.window.send('window.shown', {})
  }

  hide(): void {
    this.window?.hide()
    runTask(this.options.logger, 'entry-draft-hide', this.flush())
  }

  dispose(): void {
    this.disposed = true
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
    if (this.preparing !== null) {
      clearTimeout(this.preparing.timer)
      this.preparing.resolve(false)
      this.preparing = null
    }
    this.window?.destroy()
    this.window = null
  }

  private ensureWindow(): void {
    if (this.window !== null && !this.window.isDestroyed()) return
    const theme = this.options.config()?.resolvedTheme ?? 'light'
    this.window = this.options.platform.createWindow({
      width: 680, height: 540, backgroundColor: WINDOW_BACKGROUND[theme], parent: this.options.parent, entryEditor: true,
    })
    this.window.onClose((prevent) => {
      if (this.disposed) return
      prevent()
      runTask(this.options.logger, 'entry-editor-close', this.close())
    })
    this.window.onRendererGone(() => {
      if (this.disposed) return
      // 主进程已镜像最近输入，重新加载只向该子窗重放，不碰主草稿。
      runTask(this.options.logger, 'entry-editor-recover', this.flush())
      this.window?.reload()
    })
    this.publish()
  }

  private snapshot(): EntryEditorSnapshot {
    if (this.state === null) throw new Error('entry editor not loaded')
    return { ...this.state, config: this.options.config() }
  }

  private isDisposed(): boolean { return this.disposed }

  private publish(): void {
    if (this.state === null || this.window === null) return
    const snapshot = this.snapshot()
    this.window.send('entryEditor.state', snapshot)
    const locale = snapshot.config?.resolvedLocale ?? 'en'
    this.window.setTitle(translate(locale, 'entryEditor.windowTitle', { title: snapshot.binding.title }))
    this.window.setBackgroundColor(WINDOW_BACKGROUND[snapshot.config?.resolvedTheme ?? 'light'])
  }

  private fail(error: unknown): BridgeResult<never> {
    const info = errorInfoOf(error)
    if (this.state !== null) this.state = { ...this.state, error: info }
    this.publish()
    return { ok: false, error: info }
  }
}
