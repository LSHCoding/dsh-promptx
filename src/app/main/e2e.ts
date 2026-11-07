// 端到端测试命令（testing-plan 5，design-spec 9、D17）。只有 hello 回复的 mode 为 e2e 时，app.ts 才注册 e2e.run；
// 环境变量打不开它（项目目录的 .env 可以设置任意 PROMPTX_* 变量）。返回的数据只有耗时、布尔值和相对路径，不带文本。
// 字段名和 scripts/e2e-local.mjs 的判定对应：core-path 的 showMs、copyToHiddenMs、hidden、clipboardMatches，
// save-to-library 的 ms、relPath，typing-latency 的 ms。
//
// - core-path：记下剪贴板原有的文本 → 从隐藏状态显示小窗，计到「窗口拿到焦点、渲染进程确认已处理显示事件」的耗时 →
//   让渲染进程写入文本并执行「复制并隐藏」→ 核对剪贴板和隐藏状态，计从复制请求到隐藏的耗时 → 还原剪贴板。
// - save-to-library：渲染进程走一遍 ⌘S，主进程计往返耗时。
// - typing-latency：主进程生成 size 字的草稿交给渲染进程，渲染进程插入一个字符、量到绘制完成（N-01）。
//   窗口隐藏时页面不出帧，量之前先显示小窗。
// - state：主进程和渲染进程各报一份状态。
// - host-read 由 Host 自己处理，不会转给小程序；转来了也只报不支持。

import type { E2eResult } from '../../shared/protocol.ts'
import type { ClipboardLike } from './clipboard.ts'
import type { E2eRendererResult } from './ipc.ts'

/** 小程序处理的端到端命令。 */
export type CompanionE2eCommand =
  | { action: 'core-path'; text: string }
  | { action: 'save-to-library' }
  | { action: 'state' }
  | { action: 'typing-latency'; size: number }

/** 发给渲染进程的 e2e 事件（不含序号）。typing-latency 的草稿放在 text 里，size 一并带上。 */
export interface RendererE2eRequest {
  action: string
  text?: string
  size?: number
}

export interface CopyTiming {
  /** 最近一次「复制并隐藏」请求到达主进程的时间。 */
  requestedAt: number | null
  /** 这次请求的剪贴板写入并核对通过的时间（随后才开始隐藏）。 */
  verifiedAt: number | null
  /** 最近一次隐藏的时间。 */
  hiddenAt: number | null
}

export interface E2eDeps {
  isVisible(): boolean
  show(reason: string): void
  hide(reason: string): void
  /** 等窗口拿到焦点（已有焦点时立即返回 true），超时返回 false。 */
  waitForFocus(timeoutMs: number): Promise<boolean>
  /** 等窗口隐藏（已隐藏时立即返回 true），超时返回 false。 */
  waitForHidden(timeoutMs: number): Promise<boolean>
  /** 发 e2e 事件给渲染进程并等它的 e2eDone；渲染进程没回应时为 null。 */
  askRenderer(request: RendererE2eRequest, timeoutMs: number): Promise<E2eRendererResult | null>
  clipboard: ClipboardLike
  now(): number
  copyTiming(): CopyTiming
  /** 主进程看到的状态（可见、焦点、快捷键、菜单栏图标等）。 */
  state(): Record<string, unknown>
}

export const E2E_TIMEOUTS = {
  focus: 3000,
  hidden: 3000,
  corePath: 10_000,
  save: 20_000,
  state: 3000,
  typing: 30_000,
} as const

/** typing-latency 的草稿上限：需求里最大的是 10 万字，留出余量但不让一条命令塞爆进程。 */
export const MAX_TYPING_SIZE = 1_000_000

function normalizeEol(text: string): string {
  return text.replace(/\r\n/g, '\n')
}

function readClipboard(clipboard: ClipboardLike): Promise<string | null> {
  return clipboard.readText().catch(() => null)
}

/** 协议消息在运行时没有类型保证，先核对形状。不认识的命令（包括 Host 自己处理的 host-read）返回 null。 */
export function parseE2eCommand(raw: unknown): CompanionE2eCommand | null {
  if (typeof raw !== 'object' || raw === null) return null
  const { action, text, size } = raw as { action?: unknown; text?: unknown; size?: unknown }
  switch (action) {
    case 'core-path':
      return typeof text === 'string' ? { action, text } : null
    case 'save-to-library':
    case 'state':
      return { action }
    case 'typing-latency':
      return typeof size === 'number' && Number.isSafeInteger(size) && size >= 0 && size <= MAX_TYPING_SIZE ? { action, size } : null
    default:
      return null
  }
}

/** 一段像真实草稿的文本，正好 size 个 UTF-16 单元（中英文混排、有列表和空行，CodeMirror 的分行和换行都会用到）。 */
export function sampleDraft(size: number): string {
  const block = '## PromptX 草稿示例\n\n- 第一项：说明要做什么\n- Second item: keep the original intent\n    - 缩进的子项\n\n'
  return block.repeat(Math.ceil(size / block.length)).slice(0, size)
}

export async function runE2eCommand(raw: unknown, deps: E2eDeps): Promise<E2eResult> {
  const command = parseE2eCommand(raw)
  if (command === null) return { ok: false, data: {}, error: { code: 'promptx/internal', detail: 'unsupported e2e command' } }
  switch (command.action) {
    case 'core-path':
      return corePath(command.text, deps)
    case 'save-to-library':
      return saveToLibrary(deps)
    case 'typing-latency':
      return typingLatency(command.size, deps)
    case 'state': {
      const renderer = await deps.askRenderer({ action: 'state' }, E2E_TIMEOUTS.state)
      return { ok: true, data: { ...deps.state(), renderer: renderer?.data ?? null } }
    }
  }
}

/** 从隐藏状态显示小窗，返回到可以输入的耗时：窗口拿到焦点，且渲染进程已经处理完显示事件（编辑区拿到焦点）。 */
async function showAndMeasure(deps: E2eDeps): Promise<{ showMs: number; focused: boolean; rendererAck: boolean }> {
  if (deps.isVisible()) {
    deps.hide('e2e')
    await deps.waitForHidden(E2E_TIMEOUTS.hidden)
  }
  const started = deps.now()
  // 先挂上等待再显示：focus 事件可能在 show() 里同步发出。
  const focus = deps.waitForFocus(E2E_TIMEOUTS.focus).then(ok => ({ ok, at: deps.now() }))
  deps.show('e2e')
  // 渲染进程按顺序处理主进程发来的消息：window.shown（把焦点交给编辑区）先于这次询问到达，回复到了就说明处理完了。
  const ack = deps.askRenderer({ action: 'state' }, E2E_TIMEOUTS.focus).then(result => ({ ok: result !== null, at: deps.now() }))
  const [focused, acked] = await Promise.all([focus, ack])
  return { showMs: Math.max(focused.at, acked.at) - started, focused: focused.ok, rendererAck: acked.ok }
}

async function corePath(text: string, deps: E2eDeps): Promise<E2eResult> {
  const previous = await readClipboard(deps.clipboard)
  try {
    const shown = await showAndMeasure(deps)
    const before = deps.copyTiming().requestedAt
    const renderer = await deps.askRenderer({ action: 'core-path', text }, E2E_TIMEOUTS.corePath)
    const hidden = await deps.waitForHidden(E2E_TIMEOUTS.hidden)
    const timing = deps.copyTiming()
    const copiedAt = timing.requestedAt !== null && timing.requestedAt !== before ? timing.requestedAt : null
    const copyToHiddenMs = copiedAt !== null && timing.hiddenAt !== null && timing.hiddenAt >= copiedAt ? timing.hiddenAt - copiedAt : null
    // 「小窗开始消失前剪贴板已经写好」（N-01）：核对通过的时间不晚于隐藏的时间。
    const clipboardBeforeHide = copiedAt !== null && timing.verifiedAt !== null && timing.verifiedAt >= copiedAt
      && timing.hiddenAt !== null && timing.verifiedAt <= timing.hiddenAt
    const clipboardText = await readClipboard(deps.clipboard)
    const clipboardMatches = clipboardText !== null && normalizeEol(clipboardText) === normalizeEol(text)
    const ok = shown.focused && shown.rendererAck && renderer?.ok === true && hidden && clipboardMatches && clipboardBeforeHide
    return {
      ok,
      data: {
        showMs: shown.showMs,
        copyToHiddenMs,
        focused: shown.focused,
        rendererAck: shown.rendererAck,
        hidden,
        clipboardMatches,
        clipboardBeforeHide,
        renderer: renderer?.data ?? null,
      },
    }
  } finally {
    if (previous !== null) await deps.clipboard.writeText(previous).catch(() => {})
  }
}

async function saveToLibrary(deps: E2eDeps): Promise<E2eResult> {
  const started = deps.now()
  const result = await deps.askRenderer({ action: 'save-to-library' }, E2E_TIMEOUTS.save)
  const ms = deps.now() - started
  if (result === null) return { ok: false, data: { ms }, error: { code: 'promptx/channel/timeout', detail: 'renderer' } }
  // 渲染进程自己量了耗时（不含 IPC）时以它为准。
  return { ok: result.ok, data: { ms, ...result.data } }
}

async function typingLatency(size: number, deps: E2eDeps): Promise<E2eResult> {
  const wasVisible = deps.isVisible()
  if (!wasVisible) {
    const focused = deps.waitForFocus(E2E_TIMEOUTS.focus)
    deps.show('e2e')
    await focused
  }
  const result = await deps.askRenderer({ action: 'typing-latency', text: sampleDraft(size), size }, E2E_TIMEOUTS.typing)
  if (!wasVisible) deps.hide('e2e')
  if (result === null) return { ok: false, data: {}, error: { code: 'promptx/channel/timeout', detail: 'renderer' } }
  return { ok: result.ok, data: result.data }
}
