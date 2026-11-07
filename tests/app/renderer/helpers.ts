// 小窗界面测试用的假预加载桥和小工具。假桥记录每个请求，按方法名交给测试里写的处理函数，
// 窗口用一个简单的模型（位置、宽度、屏幕可用区域）回应 getBounds / setWidth。

import { vi } from 'vitest'
import type { CompanionRequests, RendererForwardedMethod } from '../../../src/shared/protocol.ts'
import {
  DEFAULT_PREFS,
  type BridgeEventName,
  type BridgeEvents,
  type BridgeResult,
  type Prefs,
  type PromptxBridge,
  type ResolvedConfig,
  type WindowBounds,
} from '../../../src/shared/bridge.ts'
import type {
  Binding,
  DraftRecord,
  EntryMeta,
  ErrorInfo,
  LibraryListResult,
  LibraryReadResult,
  OptimizeRound,
  OptimizeSession,
} from '../../../src/shared/types.ts'
import { AppController } from '../../../src/app/renderer/controller/app.ts'

type Params<M extends RendererForwardedMethod> = CompanionRequests[M]['params']
type Result<M extends RendererForwardedMethod> = CompanionRequests[M]['result']
type Handler<M extends RendererForwardedMethod> = (params: Params<M>) => BridgeResult<Result<M>> | Promise<BridgeResult<Result<M>>>
type HandlerTable = { [M in RendererForwardedMethod]?: Handler<M> }

export interface Call {
  method: RendererForwardedMethod
  params: unknown
}

export function ok<T>(value: T): BridgeResult<T> {
  return { ok: true, value }
}

export function fail(code: string, detail?: string): BridgeResult<never> {
  const error: ErrorInfo = detail === undefined ? { code } : { code, detail }
  return { ok: false, error }
}

export interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

export const LIBRARY_DIR = '/tmp/promptx-test/library'

export function config(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
  return {
    globalShortcut: 'Control+P',
    hideOnBlur: false,
    confirmDelete: true,
    locale: 'zh',
    theme: 'light',
    libraryDir: LIBRARY_DIR,
    profile: 'test',
    resolvedLocale: 'zh',
    resolvedTheme: 'light',
    ...overrides,
  }
}

export function entry(relPath: string, overrides: Partial<EntryMeta> = {}): EntryMeta {
  const slash = relPath.lastIndexOf('/')
  return {
    relPath,
    folder: slash === -1 ? '' : relPath.slice(0, slash),
    id: `prompt_${relPath}`,
    title: relPath.replace(/\.md$/, '').split('/').at(-1) ?? relPath,
    tags: [],
    favorite: false,
    updatedAt: Date.now(),
    createdAt: null,
    status: 'ok',
    hasFrontMatter: true,
    ...overrides,
  }
}

export function listResult(entries: EntryMeta[], overrides: Partial<LibraryListResult> = {}): LibraryListResult {
  return {
    state: 'ok',
    root: LIBRARY_DIR,
    folders: [],
    tags: [],
    entries,
    total: entries.length,
    ...overrides,
  }
}

export function readResult(meta: EntryMeta, body: string, sha256 = `sha-${meta.relPath}`): LibraryReadResult {
  return { entry: meta, body, version: { sha256, size: body.length } }
}

export function binding(relPath: string, savedBody: string, overrides: Partial<Binding> = {}): Binding {
  return {
    libraryDir: LIBRARY_DIR,
    relPath,
    id: `prompt_${relPath}`,
    title: relPath.replace(/\.md$/, ''),
    sha256: `sha-${relPath}`,
    size: savedBody.length,
    savedBody,
    ...overrides,
  }
}

export function draftRecord(text: string, extra: Partial<DraftRecord> = {}): DraftRecord {
  return { version: 1, text, selection: null, binding: null, updatedAt: '2026-11-08T00:00:00Z', ...extra }
}

export function round(id: string, overrides: Partial<OptimizeRound> = {}): OptimizeRound {
  return { id, kind: 'initial', input: '草稿', status: 'running', reply: '', candidate: null, ...overrides }
}

export function session(id: string, rounds: OptimizeRound[], name = 'DeepSeek-V4'): OptimizeSession {
  return { id, model: { provider: 'deepseek', model: 'deepseek-v4', name }, rounds }
}

/** 假的预加载桥。没有处理函数的请求返回 promptx/internal，方便发现漏写的处理。 */
export class FakeBridge implements PromptxBridge {
  readonly platform: string
  readonly calls: Call[] = []
  readonly handlers: HandlerTable = {}
  readonly listeners = new Map<BridgeEventName, Set<(payload: never) => void>>()
  bounds: WindowBounds = { x: 400, y: 100, width: 980, height: 600, workArea: { x: 0, y: 0, width: 1920, height: 1080 } }
  configValue: ResolvedConfig | null = config()
  storedPrefs: Prefs = structuredClone(DEFAULT_PREFS)

  readonly ready = vi.fn<PromptxBridge['ready']>()
  readonly flushed = vi.fn<PromptxBridge['flushed']>()
  readonly e2eDone = vi.fn<PromptxBridge['e2eDone']>()

  readonly window = {
    hide: vi.fn(async () => {}),
    copyAndHide: vi.fn(async (_text: string): Promise<BridgeResult<null>> => ok(null)),
    copyText: vi.fn(async (_text: string): Promise<BridgeResult<null>> => ok(null)),
    getBounds: vi.fn(async (): Promise<WindowBounds> => ({ ...this.bounds })),
    setWidth: vi.fn(async (width: number, anchor: 'left' | 'right'): Promise<WindowBounds> => this.applyWidth(width, anchor)),
    openSettings: vi.fn(async (): Promise<BridgeResult<{ navigated: boolean }>> => ok({ navigated: true })),
    setModalOpen: vi.fn<(open: boolean) => void>(),
    setMinWidth: vi.fn<(width: number) => void>(),
  }

  readonly prefs = {
    get: vi.fn(async (): Promise<Prefs> => structuredClone(this.storedPrefs)),
    set: vi.fn((patch: Partial<Pick<Prefs, 'panes' | 'library'>>) => {
      this.storedPrefs = { ...this.storedPrefs, ...patch }
    }),
  }

  constructor(platform = 'darwin') {
    this.platform = platform
    this.handle('draft.load', () => ok({ record: null }))
    this.handle('draft.save', () => ok({ updatedAt: '2026-11-08T00:00:00Z' }))
    this.handle('optimize.state', () => ok({ session: null }))
    this.handle('library.list', () => ok(listResult([])))
  }

  handle<M extends RendererForwardedMethod>(method: M, handler: Handler<M>): void {
    ;(this.handlers as Record<string, unknown>)[method] = handler
  }

  call<M extends RendererForwardedMethod>(method: M, params: Params<M>): Promise<BridgeResult<Result<M>>> {
    this.calls.push({ method, params })
    const handler: Handler<M> | undefined = this.handlers[method]
    if (handler === undefined) return Promise.resolve(fail('promptx/internal', `no handler for ${method}`))
    return Promise.resolve(handler(params))
  }

  callsTo<M extends RendererForwardedMethod>(method: M): Array<Params<M>> {
    return this.calls.filter(item => item.method === method).map(item => item.params as Params<M>)
  }

  on<E extends BridgeEventName>(event: E, listener: (payload: BridgeEvents[E]) => void): () => void {
    let set = this.listeners.get(event)
    if (set === undefined) {
      set = new Set()
      this.listeners.set(event, set)
    }
    const stored = listener as (payload: never) => void
    set.add(stored)
    return () => {
      set.delete(stored)
    }
  }

  emit<E extends BridgeEventName>(event: E, payload: BridgeEvents[E]): void {
    for (const listener of this.listeners.get(event) ?? []) (listener as (payload: BridgeEvents[E]) => void)(payload)
  }

  async getConfig(): Promise<ResolvedConfig | null> {
    return this.configValue
  }

  private applyWidth(width: number, anchor: 'left' | 'right'): WindowBounds {
    const { workArea } = this.bounds
    const clamped = Math.min(width, workArea.width)
    let x = anchor === 'left' ? this.bounds.x : this.bounds.x + this.bounds.width - clamped
    x = Math.min(Math.max(x, workArea.x), workArea.x + workArea.width - clamped)
    this.bounds = { ...this.bounds, x, width: clamped }
    return { ...this.bounds }
  }
}

/** 等所有已经排队的 Promise 回调跑完（不推进假计时器）。 */
export async function settle(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve()
}

/** 建一个总控并启动，草稿读回成功后返回。 */
export async function startController(bridge: FakeBridge): Promise<AppController> {
  const controller = new AppController({ bridge, locale: 'zh' })
  await controller.start()
  await controller.layout.settled()
  return controller
}

/** 模拟用户在光标处打字（普通输入事务，和键盘输入一样会触发自动保存）。 */
export function type(controller: AppController, text: string): void {
  const { head } = controller.editor.getSelection()
  controller.editor.dispatch({ changes: { from: head, insert: text }, selection: { anchor: head + text.length }, userEvent: 'input.type' })
}

/** 当前底栏提示的文字；没有提示时为 null。 */
export function toastText(controller: AppController): string | null {
  return controller.store.getState().toast?.text ?? null
}

/** 当前打开的对话框；没有时抛错，测试里直接拿来断言。 */
export function openDialog(controller: AppController): NonNullable<ReturnType<AppController['store']['getState']>['dialog']> {
  const dialog = controller.store.getState().dialog
  if (dialog === null) throw new Error('no dialog is open')
  return dialog
}

/** 点对话框的某个按钮。 */
export function chooseDialog(controller: AppController, button: string): void {
  controller.resolveDialog(openDialog(controller).id, { button })
}

/**
 * 让没人处理的 Promise 拒绝和异常直接让测试失败（照 Host 侧测试的要求）。
 * 返回的函数在 afterEach 里调用：先解除监听，再把收集到的问题抛出来。
 */
export function trapUnhandled(): () => void {
  const errors: unknown[] = []
  const onError = (error: unknown) => {
    errors.push(error)
  }
  process.on('unhandledRejection', onError)
  process.on('uncaughtException', onError)
  return () => {
    process.off('unhandledRejection', onError)
    process.off('uncaughtException', onError)
    if (errors.length > 0) throw new Error(`unhandled: ${errors.map(String).join('; ')}`)
  }
}

/**
 * jsdom 没有排版：CodeMirror 量尺寸时调用的 Range.getClientRects、getBoundingClientRect 不存在，补上返回空矩形的版本。
 * 只在 DOM 测试里调用。
 */
export function installLayoutStubs(): void {
  const proto = Range.prototype as Partial<Pick<Range, 'getClientRects' | 'getBoundingClientRect'>>
  proto.getClientRects ??= () => Object.assign([], { item: () => null })
  proto.getBoundingClientRect ??= () => new DOMRect()
}

export interface KeyInit {
  key: string
  code?: string
  keyCode?: number
  isComposing?: boolean
  ctrlKey?: boolean
  altKey?: boolean
  shiftKey?: boolean
  metaKey?: boolean
}

/** 窗口级快捷键处理用到的键盘事件（不需要 DOM）。 */
export function keyEvent(init: KeyInit): Parameters<AppController['handleKeydown']>[0] & { defaultPrevented: boolean } {
  const event = {
    key: init.key,
    code: init.code ?? '',
    keyCode: init.keyCode ?? 0,
    isComposing: init.isComposing ?? false,
    ctrlKey: init.ctrlKey ?? false,
    altKey: init.altKey ?? false,
    shiftKey: init.shiftKey ?? false,
    metaKey: init.metaKey ?? false,
    defaultPrevented: false,
    preventDefault() {
      event.defaultPrevented = true
    },
    stopPropagation() {},
  }
  return event
}
