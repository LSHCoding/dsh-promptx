// 库侧栏（需求 L-02 至 L-12，技术方案 5.5）：列表、筛选、预览、插入到光标、在编辑器中打开、重命名与标签、收藏、
// 复制正文、删除和回收站。库的读写都在插件里（一个操作只实现一次），这里只发请求、处理结果和用户的选择。
// 每个异步请求都带令牌，结果回来时令牌已过期就丢弃（技术方案 5.5「异步结果与回退规则」）。

import { normalizeTags, tagKey } from '../../../shared/library-rules.ts'
import type { MessageKey } from '../../../shared/i18n/index.ts'
import type { EntryMeta, FolderSel, LibraryListResult, LibraryScope, MetaPatch, MetaResult, RestoreTarget } from '../../../shared/types.ts'
import { insertSnippet } from '../editor/commands.ts'
import { focusWithin, nothingFocused } from '../focus.ts'
import type { LibrarySlice } from '../state/state.ts'
import { dialogButton, reason, runTask, text, type Context } from './context.ts'
import type { Dialogs } from './dialogs.ts'
import type { Draft } from './draft.ts'
import type { PaneLayout } from './layout.ts'
import type { Toasts } from './toasts.ts'

/** 搜索框输入后多久再查询：边输入边过滤，又不至于每个按键都发请求（N-01：搜索输入到结果稳定 ≤ 200 ms）。 */
export const SEARCH_DEBOUNCE_MS = 80

/** 选了文件夹栏的哪一项：一个文件夹选择，或「回收站」。 */
export type FolderChoice = FolderSel | { kind: 'trash' }

export class Library {
  private listToken = 0
  private previewToken = 0
  private trashToken = 0
  private trashPreviewToken = 0
  private insertToken = 0
  /**
   * 库目录的代次：插件推来 library.changed 时加一。删除、改元数据、恢复、打开这些操作的请求只带相对路径，
   * 插件按请求到达时的库目录解释它；用户确认之前库目录换了，同一个相对路径指的就是另一个库里的文件。
   * 所以这些操作开始时记下代次，确认之后核对，变了就停下（外部审查第 2 条）。
   */
  private libraryGeneration = 0
  private searchTimer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private readonly ctx: Context,
    private readonly draft: Draft,
    private readonly toasts: Toasts,
    private readonly dialogs: Dialogs,
    private readonly layout: PaneLayout,
    /** 把焦点交给搜索框（和 ⌘L 同一个焦点请求）。 */
    private readonly focusSearch: () => void,
  ) {}

  get state(): LibrarySlice {
    return this.ctx.store.getState().library
  }

  // ───────────────────────────── 展开与收起（L-02） ─────────────────────────────

  /** 展开侧栏，每次展开都重新读取一次磁盘状态（L-01）。 */
  async open(): Promise<void> {
    if (this.state.open) return
    await this.layout.open('library')
    await this.reload()
  }

  async close(): Promise<void> {
    // 正文读取完成前收起了侧栏：这次插入作废（L-06）。
    this.cancelInsert()
    const hadFocus = focusWithin('library')
    await this.layout.close('library')
    // 焦点原来在侧栏里，侧栏一收起焦点就没了着落，交回编辑区，用户可以直接接着打字（L-02）。
    if (hadFocus || nothingFocused()) this.ctx.editor.focus()
  }

  /**
   * 工具栏「库」。展开时和 ⌘L 一样把焦点放进搜索框（需求 4.3 第 1 步「侧栏展开，焦点在搜索框」，审查 CR-06）：
   * 按钮带 keepFocus，点下去焦点留在编辑区，不交出去的话用户接着打的搜索词会打进草稿。侧栏一出现就交，不等列表重读完。
   * 收起时焦点照旧由 close() 交回编辑区。
   */
  async toggle(): Promise<void> {
    this.toasts.beginAction()
    if (this.state.open) {
      await this.close()
      return
    }
    await this.layout.open('library')
    this.focusSearch()
    await this.reload()
  }

  /** 列表或回收站，按当前视图刷新并重读磁盘。 */
  reload(): Promise<void> {
    if (this.state.view !== 'trash') return this.refresh(true)
    // 回收站视图里文件夹栏同样列出库里的真实文件夹（需求 5.5）。换库时列表清空了，这里一起读，
    // 否则要等用户先点「全部」才看得到新库的文件夹（外部审查第二轮复核）
    if (this.state.list !== null) return this.refreshTrash()
    return Promise.all([this.refreshTrash(), this.refresh(true)]).then(() => undefined)
  }

  // ───────────────────────────── 筛选与搜索（L-03、L-04） ─────────────────────────────

  async chooseFolder(choice: FolderChoice): Promise<void> {
    this.cancelInsert()
    if (choice.kind === 'trash') {
      this.update(library => ({ ...library, view: 'trash' }))
      await this.refreshTrash()
      return
    }
    this.update(library => ({ ...library, view: 'library', folder: choice }))
    this.savePrefs()
    await this.refresh(false)
  }

  async setScope(scope: LibraryScope): Promise<void> {
    this.update(library => ({ ...library, scope }))
    this.savePrefs()
    await this.refresh(false)
  }

  async setTag(tag: string | null): Promise<void> {
    this.update(library => ({ ...library, tag }))
    this.savePrefs()
    await this.refresh(false)
  }

  setQuery(query: string): void {
    this.update(library => ({ ...library, query }))
    if (this.searchTimer !== null) clearTimeout(this.searchTimer)
    this.searchTimer = setTimeout(() => {
      this.searchTimer = null
      runTask(this.state.view === 'trash' ? this.refreshTrash() : this.refresh(false))
    }, SEARCH_DEBOUNCE_MS)
  }

  /**
   * 查询库列表。refreshIndex 为 true 时插件先重读磁盘（展开侧栏时），搜索输入时只查询。
   * 记下的文件夹已不存在时回到「全部」，记下的标签已不存在时回到「全部标签」（L-03、L-04），然后重查一次。
   */
  async refresh(refreshIndex: boolean): Promise<void> {
    const token = ++this.listToken
    const { folder, scope, tag, query } = this.state
    const result = await this.ctx.bridge.call('library.list', { folder, scope, tag, query, refresh: refreshIndex })
    if (token !== this.listToken) return
    if (!result.ok) {
      this.update(library => ({ ...library, listError: result.error }))
      return
    }
    const list = result.value
    const fallback = this.fallbackFilters(list)
    if (fallback !== null) {
      this.update(library => ({ ...library, ...fallback }))
      this.savePrefs()
      await this.refresh(false)
      return
    }
    const keep = this.state.selected !== null && list.entries.some(entry => entry.relPath === this.state.selected)
    this.update(library => ({
      ...library,
      list,
      listError: null,
      selected: keep ? library.selected : null,
      preview: keep ? library.preview : null,
    }))
    // 重读磁盘后预览也要跟着更新：文件可能刚被外部修改。
    const selected = keep ? list.entries.find(entry => entry.relPath === this.state.selected) : undefined
    if (refreshIndex && selected !== undefined) await this.loadPreview(selected)
  }

  private fallbackFilters(list: LibraryListResult): Pick<LibrarySlice, 'folder' | 'tag'> | null {
    // 库目录不可用或还不存在时文件夹和标签都是空的，这时不动用户记下的选择。
    if (list.state !== 'ok') return null
    const { folder, tag } = this.state
    const folderGone = folder.kind === 'folder' && !list.folders.includes(folder.path)
    const tagGone = tag !== null && !list.tags.some(existing => tagKey(existing) === tagKey(tag))
    if (!folderGone && !tagGone) return null
    return { folder: folderGone ? { kind: 'all' } : folder, tag: tagGone ? null : tag }
  }

  private savePrefs(): void {
    const { folder, scope, tag } = this.state
    this.ctx.bridge.prefs.set({ library: { folder, scope, tag } })
  }

  // ───────────────────────────── 选中与预览（L-05） ─────────────────────────────

  async select(relPath: string): Promise<void> {
    // 换了选中项：读取中的插入作废（L-06）。
    this.cancelInsert()
    const entry = this.entry(relPath)
    if (entry === undefined) return
    this.update(library => ({ ...library, selected: relPath }))
    await this.loadPreview(entry)
  }

  private async loadPreview(entry: EntryMeta): Promise<void> {
    const token = ++this.previewToken
    const relPath = entry.relPath
    if (entry.status === 'unreadable') {
      // 超过 2 MiB、不是 UTF-8 的文件不读，直接说明原因；「插入到光标」不可用（L-01、L-05）。
      const error = { code: 'promptx/library/unreadable', detail: entry.unreadableReason ?? 'read-failed' }
      this.update(library => ({ ...library, preview: { relPath, status: 'error', entry, body: '', error } }))
      return
    }
    // 读取中预览区留空，不显示不完整的内容（L-05）。
    this.update(library => ({ ...library, preview: { relPath, status: 'loading', entry, body: '', error: null } }))
    const result = await this.ctx.bridge.call('library.read', { relPath })
    if (token !== this.previewToken) return
    this.update(library => ({
      ...library,
      preview: result.ok
        ? { relPath, status: 'ready', entry: result.value.entry, body: result.value.body, error: null }
        : { relPath, status: 'error', entry, body: '', error: result.error },
    }))
  }

  entry(relPath: string): EntryMeta | undefined {
    const { list, preview } = this.state
    return list?.entries.find(entry => entry.relPath === relPath) ?? (preview?.relPath === relPath ? preview.entry : undefined)
  }

  // ───────────────────────────── 插入到光标（L-06） ─────────────────────────────

  /** 读取正文期间换了选中项、收起侧栏或隐藏小窗时调用：这次插入作废。 */
  cancelInsert(): void {
    this.insertToken++
  }

  async insertSelected(): Promise<void> {
    this.toasts.beginAction()
    const relPath = this.state.selected
    if (relPath === null || !this.draft.ready) return
    const token = ++this.insertToken
    const result = await this.ctx.bridge.call('library.read', { relPath })
    // 读取期间换了选中项、收起了侧栏（包括为会话栏腾地方被收起）或隐藏了小窗：这次插入作废（L-06）。
    if (token !== this.insertToken || !this.state.open || this.state.selected !== relPath) return
    if (!result.ok) {
      this.toasts.error(text(this.ctx, 'toast.readFailed', { reason: reason(this.ctx, result.error) }))
      return
    }
    const title = result.value.entry.title
    const { anchor, head } = this.ctx.editor.getSelection()
    const edit = insertSnippet(this.ctx.editor.getText(), { from: anchor, to: head }, result.value.body)
    if (edit === null) {
      this.toasts.error(text(this.ctx, 'toast.nothingToInsert', { title }))
      return
    }
    // 一步可以撤销的插入，不改变绑定（L-06）。
    this.ctx.editor.apply(edit)
    this.ctx.editor.focus()
    this.toasts.success(text(this.ctx, 'toast.inserted', { title }))
  }

  // ───────────────────────────── 在编辑器中打开（L-07） ─────────────────────────────

  async openEntry(relPath: string): Promise<void> {
    this.toasts.beginAction()
    if (!this.draft.ready) return
    const entry = this.entry(relPath)
    if (entry?.status === 'unreadable') return
    const generation = this.libraryGeneration
    const result = await this.ctx.bridge.entryEditor.open(relPath)
    if (this.libraryChangedSince(generation)) return
    if (!result.ok) {
      this.toasts.error(text(this.ctx, 'toast.readFailed', { reason: reason(this.ctx, result.error) }))
    }
    // 独立编辑窗口拥有目标与版本，主窗口的正文、选区和撤销历史保持原样。
  }

  // ───────────────────────────── 重命名 / 标签、收藏（L-09、L-10） ─────────────────────────────

  async rename(relPath: string): Promise<void> {
    this.toasts.beginAction()
    const entry = this.entry(relPath)
    if (entry === undefined || entry.status === 'unreadable') return
    const generation = this.libraryGeneration
    const choice = await this.dialogs.open({
      title: text(this.ctx, 'dialog.rename.title'),
      buttons: [dialogButton(this.ctx, 'cancel', 'common.cancel'), dialogButton(this.ctx, 'save', 'dialog.rename.save', 'primary')],
      defaultButton: 'save',
      escapeButton: 'cancel',
      form: { title: entry.title, tags: entry.tags.join(', ') },
    })
    if (choice.button !== 'save' || choice.form === undefined) return
    const title = choice.form.title.trim()
    // 标题去掉首尾空白后为空时「保存」不可用；这里再兜一次底。
    if (title === '') return
    await this.updateMeta(relPath, { title, tags: normalizeTags(choice.form.tags) }, 'toast.metaSaved', false, generation)
  }

  async toggleFavorite(relPath: string): Promise<void> {
    this.toasts.beginAction()
    const entry = this.entry(relPath)
    if (entry === undefined || entry.status === 'unreadable') return
    await this.updateMeta(relPath, { favorite: !entry.favorite }, entry.favorite ? 'toast.unfavorited' : 'toast.favorited')
  }

  /** generation：用户做决定（重命名对话框、补 front matter 的确认）之前的库目录代次，见 libraryGeneration。 */
  private async updateMeta(
    relPath: string,
    patch: MetaPatch,
    success: MessageKey,
    addFrontMatter = false,
    generation = this.libraryGeneration,
  ): Promise<void> {
    if (this.libraryChangedSince(generation)) return
    const result = await this.ctx.bridge.call('library.updateMeta', { relPath, patch, addFrontMatter })
    if (!result.ok) {
      this.toasts.error(text(this.ctx, 'toast.metaFailed', { reason: reason(this.ctx, result.error) }))
      return
    }
    const value = result.value
    // 结果回来时库目录已经换了：改的是旧库里的文件。绑定、选中和预览都属于新库，不拿旧库的结果去改它们；
    // 冲突也不再弹对话框（对话框说的是旧库里的文件），按已取消处理（外部审查第二轮复核）
    const current = generation === this.libraryGeneration
    if (value.kind === 'saved') {
      if (current) this.applyMetaToBinding(relPath, value)
      this.toasts.success(text(this.ctx, success))
      await this.refresh(false)
      if (current && this.state.selected === relPath) await this.loadPreview(value.entry)
      return
    }
    if (this.libraryChangedSince(generation)) return
    switch (value.conflict) {
      case 'noFrontMatter': {
        // 没有 front matter 的文件先确认补上（L-09、L-10 按 L-08 的方式）。
        const choice = await this.dialogs.open({
          title: text(this.ctx, 'dialog.frontMatter.title'),
          message: text(this.ctx, 'dialog.frontMatter.metaMessage'),
          buttons: [dialogButton(this.ctx, 'cancel', 'common.cancel'), dialogButton(this.ctx, 'addFrontMatter', 'dialog.frontMatter.confirm', 'primary')],
          defaultButton: 'addFrontMatter',
          escapeButton: 'cancel',
        })
        if (choice.button === 'addFrontMatter') await this.updateMeta(relPath, patch, success, true, generation)
        return
      }
      case 'modified': {
        // 写入那一刻文件又变了：不写入，提示刷新后重新操作（L-09）。
        const choice = await this.dialogs.open({
          title: text(this.ctx, 'dialog.metaModified.title'),
          buttons: [dialogButton(this.ctx, 'cancel', 'common.cancel'), dialogButton(this.ctx, 'refresh', 'dialog.refresh', 'primary')],
          defaultButton: 'refresh',
          escapeButton: 'cancel',
        })
        if (choice.button === 'refresh') await this.reload()
        return
      }
      case 'missing':
        this.toasts.error(text(this.ctx, 'toast.entryMissing'))
        await this.reload()
        return
      case 'invalidFrontMatter':
        this.toasts.error(text(this.ctx, 'toast.metaInvalid'))
        return
      case 'unsupportedLayout':
        this.toasts.error(text(this.ctx, 'toast.metaLayout'))
        return
    }
  }

  /**
   * 改元数据后的绑定（技术方案 5.5，审查 COV-03、S04）：改的是绑定的文件、且插件修改前读到的版本（before）就是绑定记下的版本时，
   * 把绑定换成修改后的版本（after）和新标题，并立即保存草稿记录；before 和绑定的版本不同，说明之前就有外部修改，
   * 绑定不动，下次保存照常弹「文件已被外部修改」，不吞掉那次外部修改。
   */
  private applyMetaToBinding(relPath: string, result: Extract<MetaResult, { kind: 'saved' }>): void {
    const binding = this.draft.binding
    if (binding?.relPath !== relPath) return
    if (binding.sha256 !== result.before.sha256 || binding.size !== result.before.size) return
    this.draft.setBinding({
      ...binding,
      sha256: result.after.sha256,
      size: result.after.size,
      title: result.entry.title,
      id: result.entry.id,
    }, false)
    this.draft.flushSoon()
  }

  // ───────────────────────────── 复制正文（L-10） ─────────────────────────────

  async copyBody(relPath: string): Promise<void> {
    this.toasts.beginAction()
    const result = await this.ctx.bridge.call('library.read', { relPath })
    if (!result.ok) {
      this.toasts.error(text(this.ctx, 'toast.readFailed', { reason: reason(this.ctx, result.error) }))
      return
    }
    // 只写剪贴板，小窗不隐藏，草稿不变。
    const copied = await this.ctx.bridge.window.copyText(result.value.body)
    if (copied.ok) this.toasts.success(text(this.ctx, 'toast.bodyCopied'))
    else this.toasts.error(text(this.ctx, 'toast.copyFailed', { reason: reason(this.ctx, copied.error) }))
  }

  // ───────────────────────────── 删除与回收站（L-11） ─────────────────────────────

  async remove(relPath: string): Promise<void> {
    this.toasts.beginAction()
    const generation = this.libraryGeneration
    if (this.ctx.store.getState().config?.confirmDelete !== false) {
      const choice = await this.dialogs.open({
        title: text(this.ctx, 'dialog.delete.title'),
        message: text(this.ctx, 'dialog.delete.message'),
        buttons: [dialogButton(this.ctx, 'cancel', 'common.cancel'), dialogButton(this.ctx, 'delete', 'dialog.delete.confirm', 'danger')],
        defaultButton: 'delete',
        escapeButton: 'cancel',
      })
      if (choice.button !== 'delete') return
      if (this.libraryChangedSince(generation)) return
    }
    const result = await this.ctx.bridge.call('library.delete', { relPath })
    if (!result.ok) {
      this.toasts.error(text(this.ctx, 'toast.deleteFailed', { reason: reason(this.ctx, result.error) }))
      return
    }
    // 删除回来时库目录已经换了：删的是旧库里的文件，新库里同路径的条目可能刚被打开或选中，不能把它的绑定和选中清掉
    // （外部审查第二轮复核）。删除确实做了，照常提示
    if (generation === this.libraryGeneration) {
      // 被删的条目正绑定在编辑区：内容不变，解除绑定，之后保存会新建文件。
      if (this.draft.binding?.relPath === relPath) {
        this.draft.setBinding(null, true)
        this.draft.flushSoon()
      }
      if (this.state.selected === relPath) {
        this.cancelInsert()
        this.previewToken++
        this.update(library => ({ ...library, selected: null, preview: null }))
      }
    }
    this.toasts.success(text(this.ctx, 'toast.movedToTrash'))
    await this.refresh(false)
  }

  async refreshTrash(): Promise<void> {
    const token = ++this.trashToken
    const result = await this.ctx.bridge.call('trash.list', { query: this.state.query })
    if (token !== this.trashToken) return
    if (!result.ok) {
      this.update(library => ({ ...library, trashError: result.error }))
      return
    }
    const trash = result.value
    const keep = this.state.trashSelected !== null && trash.entries.some(entry => entry.file === this.state.trashSelected)
    this.update(library => ({
      ...library,
      trash,
      trashError: null,
      trashSelected: keep ? library.trashSelected : null,
      trashPreview: keep ? library.trashPreview : null,
    }))
  }

  async selectTrash(file: string): Promise<void> {
    const entry = this.state.trash?.entries.find(item => item.file === file)
    if (entry === undefined) return
    const token = ++this.trashPreviewToken
    this.update(library => ({
      ...library,
      trashSelected: file,
      trashPreview: { file, status: 'loading', entry, body: '', error: null },
    }))
    const result = await this.ctx.bridge.call('trash.read', { file })
    if (token !== this.trashPreviewToken) return
    this.update(library => ({
      ...library,
      trashPreview: result.ok
        ? { file, status: 'ready', entry: result.value.entry, body: result.value.body, error: null }
        : { file, status: 'error', entry, body: '', error: result.error },
    }))
  }

  /**
   * 恢复（L-11）：原位置被占用时确认后恢复到替代路径，把对话框里显示的那个路径原样带回去，插件发现它此时也被占用就再返回 occupied；
   * 回收站里的文件在删除后被修改过时先提示，确认后仍可恢复。
   */
  async restore(file: string): Promise<void> {
    await this.restoreFile(file, 'original', null, false, this.libraryGeneration)
  }

  /** generation：用户点「恢复」时的库目录代次；确认替代路径、确认恢复改过的文件之后据此核对，见 libraryGeneration。 */
  private async restoreFile(
    file: string,
    target: RestoreTarget,
    alternative: string | null,
    acceptModified: boolean,
    generation: number,
  ): Promise<void> {
    this.toasts.beginAction()
    if (this.libraryChangedSince(generation)) return
    const result = await this.ctx.bridge.call('trash.restore', { file, target, alternative, acceptModified })
    if (!result.ok) {
      this.toasts.error(text(this.ctx, 'toast.restoreFailed', { reason: reason(this.ctx, result.error) }))
      return
    }
    const value = result.value
    // 结果回来时库目录已经换了：恢复的是旧库回收站里的文件。新库回收站里同名文件的选中不动；
    // 要用户再确认的结果（占用、改过）不再弹对话框，按已取消处理（外部审查第二轮复核）
    const current = generation === this.libraryGeneration
    if (!current && value.kind !== 'restored') {
      this.libraryChangedSince(generation)
      return
    }
    switch (value.kind) {
      case 'restored':
        if (current && this.state.trashSelected === file) {
          this.trashPreviewToken++
          this.update(library => ({ ...library, trashSelected: null, trashPreview: null }))
        }
        this.toasts.success(text(this.ctx, 'toast.restored', { path: value.relPath }))
        await this.refreshTrash()
        return
      case 'occupied': {
        const choice = await this.dialogs.open({
          title: text(this.ctx, 'dialog.occupied.title'),
          message: text(this.ctx, 'dialog.occupied.message', { path: value.alternative }),
          buttons: [dialogButton(this.ctx, 'cancel', 'common.cancel'), dialogButton(this.ctx, 'alternative', 'dialog.occupied.confirm', 'primary')],
          defaultButton: 'alternative',
          escapeButton: 'cancel',
        })
        if (choice.button === 'alternative') await this.restoreFile(file, 'alternative', value.alternative, acceptModified, generation)
        return
      }
      case 'modified': {
        await this.refreshTrash()
        const choice = await this.dialogs.open({
          title: text(this.ctx, 'dialog.trashModified.title'),
          message: text(this.ctx, 'dialog.trashModified.message'),
          buttons: [dialogButton(this.ctx, 'cancel', 'common.cancel'), dialogButton(this.ctx, 'restore', 'dialog.trashModified.confirm', 'primary')],
          defaultButton: 'cancel',
          escapeButton: 'cancel',
        })
        if (choice.button === 'restore') await this.restoreFile(file, target, alternative, true, generation)
        return
      }
      case 'missing':
        this.toasts.error(text(this.ctx, 'toast.trashEntryMissing'))
        await this.refreshTrash()
        return
    }
  }

  // ───────────────────────────── 库目录变了 ─────────────────────────────

  /**
   * 插件推来 library.changed（只在库目录真的变了时推）：绑定的库目录不同就解除绑定（L-01），侧栏开着就重读；
   * 代次加一，还开着的确认框之后再确认也不会作用到新库里（外部审查第 2 条）。
   */
  async onLibraryChanged(libraryDir: string): Promise<void> {
    this.libraryGeneration++
    this.draft.onLibraryChanged(libraryDir)
    this.cancelInsert()
    // 旧库的列表、回收站列表、选中和预览当场清掉，还在途的旧结果也作废，和代次加一在同一步完成：
    // 列表里的相对路径到了插件那边按新库解释，旧行还能点的话，删除、重命名、收藏会落到新库里同路径的文件上。
    // 新库第一次列出要全量扫描，慢盘上要几秒；侧栏收起时不重读，旧列表会一直留到下次展开（外部审查第 2 条复核）
    this.listToken++
    this.trashToken++
    this.previewToken++
    this.trashPreviewToken++
    this.update(library => ({
      ...library,
      list: null,
      listError: null,
      trash: null,
      trashError: null,
      selected: null,
      preview: null,
      trashSelected: null,
      trashPreview: null,
    }))
    // 行的「更多」菜单不随失焦关闭：换库前开着的菜单会挂到新库同路径的那一行上
    this.ctx.store.update(state => (state.menu === null ? state : { ...state, menu: null }))
    if (this.state.open) await this.reload()
  }

  dispose(): void {
    if (this.searchTimer !== null) clearTimeout(this.searchTimer)
    this.searchTimer = null
  }

  /** 从 generation 那一代到现在库目录换过：提示这次操作已取消，返回 true（见 libraryGeneration）。 */
  private libraryChangedSince(generation: number): boolean {
    if (generation === this.libraryGeneration) return false
    this.toasts.error(text(this.ctx, 'toast.libraryChanged'))
    return true
  }

  private update(updater: (library: LibrarySlice) => LibrarySlice): void {
    this.ctx.store.update((state) => {
      const library = updater(state.library)
      return library === state.library ? state : { ...state, library }
    })
  }
}
