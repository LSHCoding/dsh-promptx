// 草稿：从插件读回、自动保存、绑定，以及底栏的保存状态和字符数（需求 F-01、E-02、E-03，技术方案 4.5、5.5）。

import type { BridgeResult } from '../../../shared/bridge.ts'
import { countCharacters, isBlank } from '../../../shared/text-metrics.ts'
import type { Binding, ErrorInfo, TextSelection } from '../../../shared/types.ts'
import type { AppState, DraftSlice, SaveStatus } from '../state/state.ts'
import type { Context } from './context.ts'

/** 第一次出现未保存的改动后最迟多久发出保存（防抖 600 ms，最长等待 600 ms）。 */
export const AUTOSAVE_MS = 600

/** 字符数和保存状态在输入停顿多久后重算。 */
export const METRICS_MS = 150

export function saveStatus(text: string, binding: Binding | null): SaveStatus {
  if (isBlank(text)) return 'blank'
  return binding !== null && text === binding.savedBody ? 'saved' : 'unsaved'
}

interface DraftSnapshot {
  text: string
  selection: TextSelection
  binding: Binding | null
}

function sameSnapshot(a: DraftSnapshot, b: DraftSnapshot): boolean {
  return a.binding === b.binding
    && a.selection.anchor === b.selection.anchor
    && a.selection.head === b.selection.head
    && a.text === b.text
}

/**
 * 草稿保存的节奏（技术方案 5.5，审查 S07）：
 * - 第一次出现改动后最迟 600 ms 发出保存。计时从第一次改动开始，之后的输入不再推迟它，所以连续打字也至少每 600 ms 存一次；
 * - 同一时间只有一个 draft.save 在途；在途期间只记下「又有改动」，回来后立即用最新内容再发一次；
 * - 读回草稿之前不发任何保存（enable 之前所有调用都忽略），避免空草稿覆盖原记录（F-01）。
 */
export class DraftSaver {
  private enabled = false
  private dirty = false
  private timer: ReturnType<typeof setTimeout> | null = null
  private inFlight = false
  private lastSaved: DraftSnapshot | null = null
  private waiters: Array<() => void> = []

  constructor(
    private readonly read: () => DraftSnapshot,
    private readonly send: (snapshot: DraftSnapshot) => Promise<BridgeResult<{ updatedAt: string }>>,
    private readonly onResult: (error: ErrorInfo | null) => void,
  ) {}

  get isEnabled(): boolean {
    return this.enabled
  }

  /** 草稿读回之后才允许保存；saved 是插件那边现有的内容，和它相同时不必再发。 */
  enable(saved: DraftSnapshot): void {
    this.enabled = true
    this.lastSaved = saved
  }

  markDirty(): void {
    if (!this.enabled) return
    this.dirty = true
    if (this.timer === null && !this.inFlight) {
      this.timer = setTimeout(() => {
        this.timer = null
        this.sendLatest()
      }, AUTOSAVE_MS)
    }
  }

  /**
   * 立即保存：隐藏小窗、复制并隐藏、清空、退出前（E-02）。调用方不必等它（隐藏不等草稿保存，技术方案 5.4）；
   * 返回的 Promise 在这之前的改动都写完或失败后结束，供主进程的 flush 请求使用。
   */
  flush(): Promise<void> {
    if (!this.enabled) return Promise.resolve()
    this.clearTimer()
    this.dirty = true
    if (!this.inFlight) this.sendLatest()
    return this.whenIdle()
  }

  dispose(): void {
    this.clearTimer()
    this.release()
  }

  private sendLatest(): void {
    const snapshot = this.read()
    this.dirty = false
    if (this.lastSaved !== null && sameSnapshot(snapshot, this.lastSaved)) {
      this.release()
      return
    }
    this.inFlight = true
    const finish = (result: BridgeResult<unknown>): void => {
      this.inFlight = false
      if (result.ok) this.lastSaved = snapshot
      this.onResult(result.ok ? null : result.error)
      if (this.dirty) this.sendLatest()
      else this.release()
    }
    this.send(snapshot).then(finish, (error: unknown) => {
      finish({ ok: false, error: { code: 'promptx/internal', detail: error instanceof Error ? error.message : String(error) } })
    })
  }

  private whenIdle(): Promise<void> {
    if (this.timer === null && !this.inFlight) return Promise.resolve()
    return new Promise((resolve) => {
      this.waiters.push(resolve)
    })
  }

  private release(): void {
    if (this.timer !== null || this.inFlight) return
    const waiters = this.waiters
    this.waiters = []
    for (const resolve of waiters) resolve()
  }

  private clearTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
  }
}

export class Draft {
  readonly saver: DraftSaver
  /** 绑定的「代」：在编辑器中打开、清空、解除绑定、重新载入都换一代。保存结果回来时代号变了就不改绑定（L-08）。 */
  private generationValue = 0
  private loadToken = 0
  private metricsTimer: ReturnType<typeof setTimeout> | null = null
  private readonly unsubscribe: () => void

  constructor(private readonly ctx: Context, private readonly onLoaded: (loaded: boolean) => void) {
    this.saver = new DraftSaver(
      () => ({ text: ctx.editor.getText(), selection: ctx.editor.getSelection(), binding: this.binding }),
      snapshot => ctx.bridge.call('draft.save', snapshot),
      (error) => {
        this.update(draft => (draft.saveError === error ? draft : { ...draft, saveError: error }))
      },
    )
    this.unsubscribe = ctx.editor.onUpdate((update) => {
      if (!update.docChanged) return
      this.saver.markDirty()
      this.scheduleMetrics()
    })
  }

  get state(): DraftSlice {
    return this.ctx.store.getState().draft
  }

  get binding(): Binding | null {
    return this.state.binding
  }

  get generation(): number {
    return this.generationValue
  }

  get ready(): boolean {
    return this.state.load === 'ready'
  }

  /** 读回草稿（F-01）。失败时编辑区保持不可编辑，显示原因和「重试」，不给出可以编辑的空白草稿。 */
  async load(): Promise<void> {
    const token = ++this.loadToken
    this.update(draft => ({ ...draft, load: 'loading', loadError: null }))
    this.ctx.editor.setEditable(false)
    const result = await this.ctx.bridge.call('draft.load', {})
    if (token !== this.loadToken) return
    if (!result.ok) {
      this.update(draft => ({ ...draft, load: 'error', loadError: result.error }))
      this.onLoaded(false)
      return
    }
    const record = result.value.record
    const text = record?.text ?? ''
    // 没有记录过选区（包括第一次使用）时光标放在文末。
    this.ctx.editor.load(text, record?.selection ?? null)
    const binding = record?.binding ?? null
    this.generationValue++
    this.update(draft => ({ ...draft, load: 'ready', loadError: null, binding }))
    this.ctx.editor.setEditable(true)
    this.saver.enable({ text, selection: record?.selection ?? this.ctx.editor.getSelection(), binding })
    this.checkLibraryDir()
    this.refreshMetrics()
    this.onLoaded(true)
  }

  /**
   * 换绑定。newGeneration 为 true 表示编辑区换成了别的内容来源（打开、清空、解除绑定、重新载入），
   * 在途的保存回来后不再改动绑定；保存成功、改元数据后更新版本号属于同一代。
   */
  setBinding(binding: Binding | null, newGeneration: boolean): void {
    if (newGeneration) this.generationValue++
    this.update(draft => (draft.binding === binding ? draft : { ...draft, binding }))
    this.refreshMetrics()
    this.saver.markDirty()
  }

  /** 绑定的库目录和当前库目录不同（配置改了）：解除绑定，正文不动（L-01，技术方案 6.2）。 */
  checkLibraryDir(libraryDir: string | undefined = this.ctx.store.getState().config?.libraryDir): void {
    const binding = this.binding
    if (!this.ready || binding === null || libraryDir === undefined || libraryDir === '') return
    if (binding.libraryDir === libraryDir) return
    this.setBinding(null, true)
    this.flushSoon()
  }

  /** 按编辑区当前全文算出的保存状态，不等 150 ms 的防抖。操作判断（L-07 是否有未保存内容）用它。 */
  currentStatus(): SaveStatus {
    return saveStatus(this.ctx.editor.getText(), this.binding)
  }

  scheduleMetrics(): void {
    if (this.metricsTimer !== null) clearTimeout(this.metricsTimer)
    this.metricsTimer = setTimeout(() => {
      this.metricsTimer = null
      this.refreshMetrics()
    }, METRICS_MS)
  }

  refreshMetrics(): void {
    if (this.metricsTimer !== null) clearTimeout(this.metricsTimer)
    this.metricsTimer = null
    const text = this.ctx.editor.getText()
    const status = saveStatus(text, this.binding)
    const chars = countCharacters(text)
    this.ctx.store.update((state: AppState) => (state.editor.status === status && state.editor.chars === chars
      ? state
      : { ...state, editor: { status, chars } }))
  }

  /** 立即保存，不等结果。 */
  flushSoon(): void {
    this.saver.flush().catch(() => {
      // flush 不会失败（失败原因由 onResult 显示在底栏）；这里只防止出现没人处理的 Promise 拒绝。
    })
  }

  dispose(): void {
    this.unsubscribe()
    this.saver.dispose()
    if (this.metricsTimer !== null) clearTimeout(this.metricsTimer)
    this.metricsTimer = null
  }

  private update(updater: (draft: DraftSlice) => DraftSlice): void {
    this.ctx.store.update((state) => {
      const draft = updater(state.draft)
      return draft === state.draft ? state : { ...state, draft }
    })
  }
}
