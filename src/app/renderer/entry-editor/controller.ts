// 库条目的独立编辑会话。只用 entryEditor 白名单，不接入主窗口的草稿、库保存或模型会话。

import type { EntryEditorSnapshot, PromptxBridge, ResolvedConfig } from '../../../shared/bridge.ts'
import { translate, type Locale } from '../../../shared/i18n/index.ts'
import type { ErrorInfo } from '../../../shared/types.ts'
import { isComposingKey } from '../appearance.ts'
import { runTask } from '../controller/context.ts'
import { createEditorController, type EditorController } from '../editor/controller.ts'
import { createStore, type Store } from '../state/store.ts'

export interface EntryEditorState {
  snapshot: EntryEditorSnapshot | null
  load: 'loading' | 'ready' | 'error'
  error: ErrorInfo | null
  dirty: boolean
  action: 'save' | 'reload' | null
  locale: Locale
  theme: 'light' | 'dark'
}

const CLOSED: ErrorInfo = { code: 'promptx/channel/closed' }

export class EntryEditorController {
  readonly editor: EditorController
  readonly store: Store<EntryEditorState>
  private subscriptions: Array<() => void> = []
  private applying = false
  private disposed = false
  private started = false
  private loadToken = 0
  private preparedFreeze: { id: number; generation: number } | null = null

  constructor(readonly bridge: PromptxBridge, locale: Locale = 'en') {
    this.store = createStore<EntryEditorState>({ snapshot: null, load: 'loading', error: null, dirty: false, action: null, locale, theme: 'light' })
    this.editor = createEditorController({
      platform: bridge.platform,
      placeholder: translate(locale, 'editor.placeholder'),
      ariaLabel: translate(locale, 'entryEditor.editorLabel'),
    })
    this.subscriptions.push(this.editor.onUpdate((update) => {
      if (this.applying || this.store.getState().load !== 'ready' || (!update.docChanged && !update.selectionSet)) return
      const snapshot = this.store.getState().snapshot
      if (snapshot === null || snapshot.freezeId !== null) return
      const text = this.editor.getText()
      this.bridge.entryEditor.update(text, this.editor.getSelection(), snapshot.generation)
      const dirty = text !== snapshot.binding.savedBody
      this.store.update(state => state.dirty === dirty ? state : { ...state, dirty })
    }))
  }

  async start(): Promise<void> {
    if (this.started || this.disposed) return
    this.started = true
    this.subscriptions.push(
      this.bridge.on('entryEditor.state', (snapshot) => { this.receive(snapshot) }),
      this.bridge.on('config', (config) => { this.configure(config) }),
      this.bridge.on('window.shown', () => { this.editor.focus() }),
      this.bridge.on('e2e', (command) => {
        const state = this.store.getState()
        // 此事件只由主进程经测试模式的 Host 入口发送；仍走正常正文变更与镜像通道。
        if (command.action === 'entry-edit-text' && typeof command.text === 'string' &&
          state.load === 'ready' && state.snapshot?.freezeId === null) this.editor.replaceAll(command.text)
      }),
    )
    await this.load()
  }

  async load(): Promise<void> {
    const token = ++this.loadToken
    this.preparedFreeze = null
    this.store.update(state => ({ ...state, load: 'loading', error: null }))
    this.editor.setEditable(false)
    try {
      const result = await this.bridge.entryEditor.getState()
      if (this.disposed || token !== this.loadToken) return
      if (result.ok) this.receive(result.value)
      else this.store.update(state => ({ ...state, load: 'error', error: result.error }))
    } catch {
      if (!this.disposed && token === this.loadToken) this.store.update(state => ({ ...state, load: 'error', error: CLOSED }))
    }
  }

  private receive(snapshot: EntryEditorSnapshot): void {
    if (this.disposed) return
    const previous = this.store.getState().snapshot
    // getState 的回复可能晚于推送事件；保存/配置推送也可能带着用户继续输入前的正文。
    // 只在主进程明确切换文档代次时载入，普通状态更新永不替换当前编辑内容或撤销栈。
    if (previous !== null && snapshot.generation < previous.generation) return
    this.loadToken++
    const replacing = previous === null || snapshot.generation !== previous.generation
    const frozen = snapshot.freezeId !== null
    this.applying = true
    try {
      if (replacing) this.editor.load(snapshot.text, snapshot.selection)
      this.editor.setEditable(!frozen)
      if (snapshot.config !== null) this.configure(snapshot.config)
    } finally {
      this.applying = false
    }
    this.store.update(state => ({
      ...state,
      snapshot,
      load: 'ready',
      error: snapshot.error,
      dirty: this.editor.getText() !== snapshot.binding.savedBody,
      action: replacing ? null : state.action,
    }))
    if (snapshot.freezeId !== null) {
      const { id, generation } = this.preparedFreeze ?? { id: null, generation: null }
      if (id !== snapshot.freezeId || generation !== snapshot.generation) {
        this.preparedFreeze = { id: snapshot.freezeId, generation: snapshot.generation }
        // 先变为只读，再回传实际状态；相同代次的过期 snapshot.text 不能覆盖最后输入。
        this.bridge.entryEditor.prepared(snapshot.freezeId, snapshot.generation, this.editor.getText(), this.editor.getSelection())
      }
    } else {
      this.preparedFreeze = null
      if (replacing || previous.freezeId !== null) this.editor.focus()
    }
  }

  private configure(config: ResolvedConfig): void {
    this.editor.setInputConversions({ middleDot: config.convertMiddleDot, yen: config.convertYen })
    this.editor.setLabels({
      placeholder: translate(config.resolvedLocale, 'editor.placeholder'),
      ariaLabel: translate(config.resolvedLocale, 'entryEditor.editorLabel'),
    })
    this.store.update(state => ({ ...state, locale: config.resolvedLocale, theme: config.resolvedTheme }))
  }

  async save(): Promise<void> {
    await this.perform('save')
  }

  async reload(): Promise<void> {
    await this.perform('reload')
  }

  private async perform(action: 'save' | 'reload'): Promise<void> {
    const state = this.store.getState()
    if (state.load !== 'ready' || state.action !== null || state.snapshot === null || state.snapshot.saving ||
      state.snapshot.freezeId !== null || !this.active()) return
    const generation = state.snapshot.generation
    this.bridge.entryEditor.update(this.editor.getText(), this.editor.getSelection(), generation)
    this.store.update(current => ({ ...current, action, error: null }))
    let error: ErrorInfo | null = null
    try {
      const result = await this.bridge.entryEditor[action](generation)
      if (!result.ok) error = result.error
    } catch {
      error = CLOSED
    }
    if (!this.active() || this.store.getState().snapshot?.generation !== generation) return
    this.store.update(current => ({ ...current, action: null, error: error ?? current.error }))
  }

  async close(): Promise<void> {
    if (!this.active()) return
    const { snapshot, load } = this.store.getState()
    if (snapshot?.freezeId != null) return
    if (load === 'ready' && snapshot !== null) this.bridge.entryEditor.update(this.editor.getText(), this.editor.getSelection(), snapshot.generation)
    try {
      await this.bridge.entryEditor.close(snapshot?.generation)
    } catch {
      if (this.active()) this.store.update(state => ({ ...state, error: CLOSED }))
    }
  }

  private active(): boolean {
    return !this.disposed
  }

  handleKeydown(event: KeyboardEvent): void {
    if (event.defaultPrevented || isComposingKey(event)) return
    const mod = this.bridge.platform === 'darwin' ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey
    if (mod && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 's') {
      event.preventDefault()
      runTask(this.save())
    } else if (event.key === 'Escape' && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
      event.preventDefault()
      runTask(this.close())
    }
  }

  dispose(): void {
    this.disposed = true
    this.loadToken++
    for (const unsubscribe of this.subscriptions.splice(0)) unsubscribe()
    this.editor.unmount()
  }
}
