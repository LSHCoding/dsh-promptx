// 设置窗口的界面逻辑（V0.1.6 design-spec 3、6）。只用 settings 白名单接口，不接触主窗口的草稿、库和模型会话。
//
// 生效方式：每项单独提交，没有「保存」按钮。开关、下拉框改动即提交；快捷键录到合法组合即提交；库目录只经「更改…」
// 「恢复默认位置」两个明确动作提交（不给半截路径生效的机会，见 src/client/form.ts 文件头）；优化指令停止输入 600ms、
// 失焦、窗口隐藏或关闭前提交。提交成功到 Host 推回新配置之间，页面按提交值显示（model.ts 的覆盖值）。

import { acceleratorFromKeyEvent, type AcceleratorKeyEvent } from '../../../shared/accelerator.ts'
import type { PromptxBridge, SettingsSnapshot } from '../../../shared/bridge.ts'
import { errorReason, translate, type Locale } from '../../../shared/i18n/index.ts'
import type { ErrorInfo, PromptxConfig, SettingsSection } from '../../../shared/types.ts'
import { isComposingKey } from '../appearance.ts'
import { runTask } from '../controller/context.ts'
import { createStore, type Store } from '../state/store.ts'
import {
  canonicalShortcut,
  defaultShortcutOf,
  effectiveConfig,
  localShortcutError,
  omitFields,
  settlePending,
  shortcutScope,
  type ConfigField,
  type FieldErrors,
  type PendingValues,
  type ShortcutField,
} from './model.ts'

/** 提交值最多盖多久：Host 的新配置一般几十毫秒内就到，超时后以 Host 为准。 */
export const PENDING_MS = 5000
/** 优化指令停止输入多久后提交。 */
export const INSTRUCTION_DELAY_MS = 600

export interface SettingsNotice {
  tone: 'error' | 'info'
  text: string
  section: SettingsSection
}

export interface InstructionDraft {
  text: string
  /** 有还没提交的输入。 */
  dirty: boolean
  status: 'idle' | 'saving' | 'saved'
}

export interface SettingsState {
  snapshot: SettingsSnapshot | null
  load: 'loading' | 'ready' | 'error'
  loadError: ErrorInfo | null
  locale: Locale
  theme: 'light' | 'dark'
  section: SettingsSection
  pending: PendingValues
  errors: FieldErrors
  /** 正在提交的字段（控件显示为不可用，防止连点）。 */
  saving: Partial<Record<ConfigField, true>>
  recording: ShortcutField | null
  instruction: InstructionDraft | null
  notice: SettingsNotice | null
}

const CLOSED: ErrorInfo = { code: 'promptx/channel/closed' }

export interface SettingsControllerOptions {
  locale?: Locale
  theme?: 'light' | 'dark'
  now?: () => number
}

export class SettingsController {
  readonly store: Store<SettingsState>
  private readonly now: () => number
  private subscriptions: Array<() => void> = []
  private seenSection = -1
  private instructionTimer: ReturnType<typeof setTimeout> | null = null
  private pendingTimer: ReturnType<typeof setTimeout> | null = null
  /** 每个字段最近一次提交的序号：旧提交的回复晚到时不覆盖新提交的状态。 */
  private readonly tokens = new Map<ConfigField, number>()
  private nextToken = 0
  private started = false
  private disposed = false

  constructor(readonly bridge: PromptxBridge, options: SettingsControllerOptions = {}) {
    this.now = options.now ?? (() => Date.now())
    this.store = createStore<SettingsState>({
      snapshot: null, load: 'loading', loadError: null,
      locale: options.locale ?? 'en', theme: options.theme ?? 'light',
      section: 'shortcuts', pending: {}, errors: {}, saving: {}, recording: null, instruction: null, notice: null,
    })
  }

  async start(): Promise<void> {
    if (this.started || this.disposed) return
    this.started = true
    this.subscriptions.push(
      this.bridge.on('settings.state', (snapshot) => { this.receive(snapshot) }),
      this.bridge.on('settings.shortcutPressed', ({ accelerator }) => { this.shortcutPressed(accelerator) }),
    )
    await this.load()
  }

  async load(): Promise<void> {
    this.store.update(state => ({ ...state, load: state.snapshot?.data == null ? 'loading' : state.load, loadError: null }))
    let error: ErrorInfo = CLOSED
    try {
      const result = await this.bridge.settings.getState()
      if (this.disposed) return
      if (result.ok) {
        this.receive(result.value)
        return
      }
      error = result.error
    } catch {
      if (this.disposed) return
    }
    this.store.update(state => ({ ...state, load: state.snapshot?.data == null ? 'error' : state.load, loadError: error }))
  }

  /** 页面上显示的配置：Host 的配置盖上还在等待的提交值。还没取到配置时为 null。 */
  config(): PromptxConfig | null {
    const { snapshot, pending } = this.store.getState()
    return snapshot?.data == null ? null : effectiveConfig(snapshot.data.config, pending, this.now())
  }

  private receive(snapshot: SettingsSnapshot): void {
    if (this.disposed) return
    const switchSection = snapshot.section.seq > this.seenSection
    if (switchSection) this.seenSection = snapshot.section.seq
    this.store.update((state) => {
      const data = snapshot.data
      const pending = data === null ? state.pending : settlePending(state.pending, data.config, this.now())
      // 指令框没有未提交的输入时跟着 Host 的值走（dsh 页面里改了也能看到）；有输入时保留用户正在写的内容。
      const instruction = data === null || state.instruction?.dirty === true || state.instruction?.status === 'saving'
        ? state.instruction
        : { text: effectiveConfig(data.config, pending, this.now()).optimizeInstruction, dirty: false, status: state.instruction?.status ?? 'idle' }
      return {
        ...state,
        snapshot,
        pending,
        instruction,
        load: data === null ? (state.snapshot?.data == null ? (snapshot.error === null ? 'loading' : 'error') : 'ready') : 'ready',
        loadError: snapshot.error,
        locale: snapshot.config?.resolvedLocale ?? state.locale,
        theme: snapshot.config?.resolvedTheme ?? state.theme,
        section: switchSection ? snapshot.section.section : state.section,
      }
    })
    this.schedulePendingSweep()
  }

  selectSection(section: SettingsSection): void {
    this.cancelRecording()
    this.store.update(state => (state.section === section ? state : { ...state, section, notice: null }))
  }

  dismissNotice(): void {
    this.store.update(state => (state.notice === null ? state : { ...state, notice: null }))
  }

  // ───────────────────────────── 提交 ─────────────────────────────

  /** 提交一组改动。返回是否已被 Host 接受。 */
  async submit(patch: Partial<PromptxConfig>): Promise<boolean> {
    const fields = Object.keys(patch) as ConfigField[]
    if (fields.length === 0 || this.disposed) return false
    const token = ++this.nextToken
    for (const field of fields) this.tokens.set(field, token)
    const until = this.now() + PENDING_MS
    this.store.update((state) => {
      const pending = { ...state.pending }
      const saving = { ...state.saving }
      for (const field of fields) {
        pending[field] = { value: patch[field] as string | boolean, until }
        saving[field] = true
      }
      const errors = omitFields(state.errors, fields)
      return { ...state, pending, errors, saving, notice: state.notice?.tone === 'error' ? null : state.notice }
    })
    let accepted = false
    let failure: { errors: FieldErrors; error: ErrorInfo | null } | null = null
    try {
      const result = await this.bridge.settings.update(patch)
      if (!result.ok) failure = { errors: {}, error: result.error }
      else if (!result.value.ok) failure = { errors: result.value.errors, error: result.value.error ?? null }
      else accepted = true
    } catch {
      failure = { errors: {}, error: CLOSED }
    }
    if (this.isDisposed()) return accepted
    const current = fields.filter(field => this.tokens.get(field) === token)
    this.store.update((state) => {
      const saving = omitFields(state.saving, current)
      // 主进程在回复之前已经推来写入之后取的快照（main/settings-window.ts 的 update）：取成功时它就是最终值，
      // 提交值不再需要，哪怕别处紧接着又改了同一项，也照实显示。取失败时留着提交值，到期后以 Host 为准。
      const fresh = state.snapshot?.error === null
      const pending = failure === null && !fresh ? state.pending : omitFields(state.pending, current)
      const errors = { ...state.errors }
      for (const field of current) {
        const error = failure?.errors[field]
        if (error !== undefined) errors[field] = error
      }
      const notice = failure !== null && Object.keys(failure.errors).length === 0 && current.length > 0
        ? { tone: 'error' as const, text: translate(state.locale, 'settings.saveFailed', { reason: errorReason(state.locale, failure.error ?? { code: 'promptx/internal' }) }), section: state.section }
        : state.notice
      return { ...state, pending, errors, saving, notice }
    })
    if (accepted) this.schedulePendingSweep()
    return accepted
  }

  setToggle(field: 'convertMiddleDot' | 'convertYen' | 'confirmDelete', value: boolean): void {
    runTask(this.submit({ [field]: value }))
  }

  setRuntimeSource(value: PromptxConfig['runtimeSource']): void {
    if (this.config()?.runtimeSource === value) return
    runTask(this.submit({ runtimeSource: value }))
  }

  // ───────────────────────────── 快捷键 ─────────────────────────────

  startRecording(field: ShortcutField): void {
    if (this.store.getState().recording === field) return
    this.bridge.settings.setRecording(true)
    this.store.update(state => ({ ...state, recording: field, errors: omitFields(state.errors, [field]) }))
  }

  cancelRecording(): void {
    if (this.store.getState().recording === null) return
    this.bridge.settings.setRecording(false)
    this.store.update(state => ({ ...state, recording: null }))
  }

  /** 录制中的一次按键。返回 true 表示这次按键已经处理（调用方应阻止默认行为和冒泡）。 */
  recordKey(event: AcceleratorKeyEvent & { isComposing: boolean; keyCode: number }): boolean {
    const field = this.store.getState().recording
    if (field === null) return false
    if (isComposingKey(event)) return true
    const plain = !event.ctrlKey && !event.altKey && !event.shiftKey && !event.metaKey
    // 小窗内快捷键允许单独的 Esc（「隐藏小窗」的默认键），录制时 Esc 只取消；要设成 Esc 用「恢复默认」。
    if (event.key === 'Escape' && plain) {
      this.cancelRecording()
      return true
    }
    if (event.key === 'Tab' && plain) {
      this.cancelRecording()
      return false
    }
    const accelerator = acceleratorFromKeyEvent(event, this.bridge.platform, shortcutScope(field))
    // 只按了修饰键，或组合不合法（没有修饰键、只有 Shift）：继续等。
    if (accelerator === null) return true
    this.commitShortcut(field, accelerator)
    return true
  }

  /** 主进程转来的全局快捷键（系统先拦下了这次按键）。 */
  private shortcutPressed(accelerator: string): void {
    const field = this.store.getState().recording
    if (field === null) return
    this.commitShortcut(field, canonicalShortcut(accelerator, field))
  }

  commitShortcut(field: ShortcutField, value: string): void {
    this.cancelRecording()
    const config = this.config()
    const data = this.store.getState().snapshot?.data
    if (config === null || data == null) return
    const next = canonicalShortcut(value, field)
    if (next === canonicalShortcut(config[field], field)) return
    const error = localShortcutError(field, next, config, data.platform)
    if (error !== null) {
      this.store.update(state => ({ ...state, errors: { ...state.errors, [field]: error } }))
      return
    }
    runTask(this.submit({ [field]: next }))
  }

  clearShortcut(field: ShortcutField): void {
    this.commitShortcut(field, '')
  }

  resetShortcut(field: ShortcutField): void {
    const data = this.store.getState().snapshot?.data
    if (data == null) return
    this.commitShortcut(field, defaultShortcutOf(field, data))
  }

  // ───────────────────────────── 库目录 ─────────────────────────────

  async chooseLibraryDir(): Promise<void> {
    this.dismissNotice()
    const result = await this.bridge.settings.chooseLibraryDir()
    if (this.disposed) return
    if (!result.ok) {
      this.showNotice('error', translate(this.locale(), 'settings.saveFailed', { reason: errorReason(this.locale(), result.error) }), 'library')
      return
    }
    const path = result.value
    if (path === null || path === this.config()?.libraryDir) return
    await this.submit({ libraryDir: path })
  }

  async resetLibraryDir(): Promise<void> {
    if (this.config()?.libraryDir === '') return
    await this.submit({ libraryDir: '' })
  }

  async openLibraryDir(): Promise<void> {
    const result = await this.bridge.settings.openLibraryDir()
    if (!result.ok && !this.disposed) this.showNotice('error', translate(this.locale(), 'settings.library.openFailed'), 'library')
  }

  // ───────────────────────────── 优化指令 ─────────────────────────────

  editInstruction(text: string): void {
    this.store.update(state => ({ ...state, instruction: { text, dirty: true, status: state.instruction?.status ?? 'idle' } }))
    if (this.instructionTimer !== null) clearTimeout(this.instructionTimer)
    this.instructionTimer = setTimeout(() => {
      this.instructionTimer = null
      runTask(this.flushInstruction())
    }, INSTRUCTION_DELAY_MS)
  }

  /** 把指令框里还没提交的输入交给 Host（停止输入后、失焦、窗口隐藏或关闭前）。 */
  async flushInstruction(): Promise<void> {
    if (this.instructionTimer !== null) clearTimeout(this.instructionTimer)
    this.instructionTimer = null
    const draft = this.store.getState().instruction
    if (draft === null || !draft.dirty) return
    const text = draft.text
    this.store.update(state => ({ ...state, instruction: state.instruction === null ? null : { ...state.instruction, dirty: false, status: 'saving' } }))
    const accepted = await this.submit({ optimizeInstruction: text })
    if (this.disposed) return
    this.store.update((state) => {
      const instruction = state.instruction
      if (instruction === null) return state
      // 提交期间又有输入：保持 dirty，等下一次提交；提交失败时把输入标回未提交，内容不丢。
      if (!accepted) return { ...state, instruction: { ...instruction, dirty: true, status: 'idle' } }
      return { ...state, instruction: { ...instruction, status: instruction.dirty ? 'idle' : 'saved' } }
    })
  }

  /** 把默认指令填进文本框，当作一次输入（停止输入后提交）。 */
  startFromDefault(): void {
    const data = this.store.getState().snapshot?.data
    if (data == null) return
    this.editInstruction(data.defaultInstruction[this.locale()])
  }

  async restoreDefaultInstruction(): Promise<void> {
    if (this.instructionTimer !== null) clearTimeout(this.instructionTimer)
    this.instructionTimer = null
    this.store.update(state => ({ ...state, instruction: { text: '', dirty: true, status: state.instruction?.status ?? 'idle' } }))
    await this.flushInstruction()
  }

  // ───────────────────────────── 其他 ─────────────────────────────

  async openInDsh(): Promise<void> {
    await this.flushInstruction()
    const result = await this.bridge.settings.openInDsh()
    if (this.disposed) return
    if (!result.ok) {
      this.showNotice('error', translate(this.locale(), 'settings.about.openFailed', { reason: errorReason(this.locale(), result.error) }), 'about')
      return
    }
    if (result.value.navigated) this.showNotice('info', translate(this.locale(), 'settings.about.openedInDsh'), 'about')
  }

  async close(): Promise<void> {
    this.cancelRecording()
    await this.flushInstruction()
    await this.bridge.settings.close()
  }

  /** 窗口级按键：录制中交给 recordKey；Esc、⌘W / Ctrl+W 关闭窗口。返回是否已处理。 */
  handleKeydown(event: AcceleratorKeyEvent & { isComposing: boolean; keyCode: number; defaultPrevented: boolean }): boolean {
    if (this.store.getState().recording !== null) return this.recordKey(event)
    if (event.defaultPrevented || isComposingKey(event)) return false
    const plain = !event.ctrlKey && !event.altKey && !event.shiftKey && !event.metaKey
    const mod = this.bridge.platform === 'darwin' ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey
    if ((event.key === 'Escape' && plain) || (mod && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'w')) {
      runTask(this.close())
      return true
    }
    return false
  }

  dispose(): void {
    this.disposed = true
    if (this.instructionTimer !== null) clearTimeout(this.instructionTimer)
    if (this.pendingTimer !== null) clearTimeout(this.pendingTimer)
    this.instructionTimer = null
    this.pendingTimer = null
    for (const unsubscribe of this.subscriptions.splice(0)) unsubscribe()
  }

  /** await 之后读：写成方法，类型检查不会把 await 之前的判断沿用到之后。 */
  private isDisposed(): boolean {
    return this.disposed
  }

  private locale(): Locale {
    return this.store.getState().locale
  }

  private showNotice(tone: SettingsNotice['tone'], text: string, section: SettingsSection): void {
    this.store.update(state => ({ ...state, notice: { tone, text, section } }))
  }

  /** 覆盖值到期时重新算一次：Host 一直没推回新配置时，页面最终以 Host 的值为准。 */
  private schedulePendingSweep(): void {
    if (this.pendingTimer !== null || this.disposed) return
    const { pending, snapshot } = this.store.getState()
    const items = Object.values(pending)
    if (items.length === 0 || snapshot?.data == null) return
    const due = Math.min(...items.map(item => item.until)) - this.now() + 10
    this.pendingTimer = setTimeout(() => {
      this.pendingTimer = null
      const data = this.store.getState().snapshot?.data
      if (data == null) return
      this.store.update(state => ({ ...state, pending: settlePending(state.pending, data.config, this.now()) }))
      this.schedulePendingSweep()
    }, Math.max(0, due))
  }
}
