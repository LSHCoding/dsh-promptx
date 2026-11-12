// 底栏（需求 E-03、5.3）：左侧绑定的标题、保存状态和字符数；中间操作提示；右侧优化进行中的指示和「复制并隐藏」。
// 小窗变窄时先截断提示文字（悬停显示全文），再把字符数收进悬停提示；保存状态和「复制并隐藏」始终可见。

import { useLayoutEffect, useRef, useState, type ReactElement } from 'react'
import { errorReason, type MessageKey } from '../../../shared/i18n/index.ts'
import { formatShortcut, windowShortcut } from '../shortcuts.ts'
import type { SaveStatus } from '../state/state.ts'
import { run } from './controls.tsx'
import { Spinner } from './icons.tsx'
import { useAppState, useController, useT, type Translate } from './hooks.ts'

/** 底栏比这个宽度窄时，字符数收进保存状态的悬停提示。 */
export const COMPACT_STATUS_WIDTH = 460

export interface StatusMessage {
  kind: 'success' | 'error' | 'info'
  text: string
  /** 来自提示（toast）时带上它的 id，错误提示可以关掉。 */
  toastId?: number
}

export interface StatusBarProps {
  /** 底栏的实际宽度；0 表示还没量到，按宽的布局显示。 */
  width: number
  status: SaveStatus
  chars: number
  boundTitle: string | null
  message: StatusMessage | null
  optimizing: boolean
  /** 「复制并隐藏」的快捷键（已格式化）；空串时不显示。 */
  copyShortcut: string
  t: Translate
  onCopy: () => void
  onDismiss: (toastId: number) => void
}

const STATUS_KEYS: Readonly<Record<SaveStatus, MessageKey>> = {
  blank: 'status.blank',
  unsaved: 'status.unsaved',
  saved: 'status.saved',
}

export function StatusBar(props: StatusBarProps): ReactElement {
  const { t, message } = props
  const compact = props.width > 0 && props.width < COMPACT_STATUS_WIDTH
  const statusLabel = t(STATUS_KEYS[props.status])
  const charsLabel = t('status.chars', { count: props.chars })
  const fullStatus = t('status.withChars', { status: statusLabel, count: props.chars })
  return (
    <footer className="px-statusbar" data-compact={compact ? 'true' : undefined}>
      <div className="px-status" title={compact ? fullStatus : undefined}>
        {props.boundTitle === null ? null : <span className="px-status-title" title={props.boundTitle}>{props.boundTitle}</span>}
        <span className="px-status-state" data-status={props.status}>{statusLabel}</span>
        {/* 「未保存 · 309 字符」（E-03）；窄时字符数收进上面的悬停提示。 */}
        {compact ? null : <span className="px-status-chars">{`· ${charsLabel}`}</span>}
      </div>
      <div className="px-status-message" role="status" aria-live="polite">
        {message === null ? null : <span className={`px-message px-message-${message.kind}`} title={message.text}>{message.text}</span>}
        {message?.kind === 'error' && message.toastId !== undefined
          ? <DismissButton label={t('common.dismiss')} onClick={() => { props.onDismiss(message.toastId ?? 0) }} />
          : null}
      </div>
      <div className="px-status-actions">
        {props.optimizing ? <Spinner label={t('status.optimizingIndicator')} /> : null}
        <button
          type="button"
          className="px-button px-button-primary px-copy-button"
          // 点按钮不抢编辑区的焦点：复制失败、小窗没隐藏时可以接着打字。
          onMouseDown={(event) => {
            event.preventDefault()
          }}
          onClick={props.onCopy}
        >
          {t('status.copyAndHide')}
          {/* 快捷键放在按钮里的键帽上（V0.1.5）。键帽只是提示，按钮的可访问名称仍是「复制并隐藏」。 */}
          {props.copyShortcut === '' ? null : <kbd className="px-kbd" aria-hidden="true">{props.copyShortcut}</kbd>}
        </button>
      </div>
    </footer>
  )
}

/** 错误提示一直显示，直到下一次操作或用户点这个按钮关掉（E-03）。 */
function DismissButton({ label, onClick }: { label: string; onClick: () => void }): ReactElement {
  return (
    <button type="button" className="px-message-dismiss" aria-label={label} title={label} onClick={onClick}>
      ×
    </button>
  )
}

/** 接上状态：提示的优先级是 错误提示 > 草稿保存失败 > 成功提示 > 优化进行中。 */
export function StatusBarContainer(): ReactElement {
  const controller = useController()
  const t = useT()
  const ref = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  const editor = useAppState(state => state.editor)
  const binding = useAppState(state => state.draft.binding)
  const saveError = useAppState(state => state.draft.saveError)
  const suggesting = useAppState(state => state.draft.librarySuggesting)
  const toast = useAppState(state => state.toast)
  const session = useAppState(state => state.optimize.session)
  const platform = useAppState(state => state.platform)
  const locale = useAppState(state => state.locale)
  const running = session?.rounds.some(round => round.status === 'running') ?? false

  useLayoutEffect(() => {
    const element = ref.current
    if (element === null) return undefined
    setWidth(element.clientWidth)
    if (typeof ResizeObserver === 'undefined') return undefined
    const observer = new ResizeObserver(() => {
      setWidth(element.clientWidth)
    })
    observer.observe(element)
    return () => {
      observer.disconnect()
    }
  }, [])

  let message: StatusMessage | null = null
  if (toast?.kind === 'error') message = { kind: 'error', text: toast.text, toastId: toast.id }
  else if (saveError !== null) message = { kind: 'error', text: t('status.draftSaveFailed', { reason: errorReason(locale, saveError) }) }
  else if (suggesting) message = { kind: 'info', text: t('status.generatingMetadata') }
  else if (toast !== null) message = { kind: 'success', text: toast.text, toastId: toast.id }
  else if (running && session !== null) message = { kind: 'info', text: t('status.optimizing', { model: session.model.name }) }

  return (
    <div className="px-statusbar-host" ref={ref}>
      <StatusBar
        width={width}
        status={editor.status}
        chars={editor.chars}
        boundTitle={binding?.title ?? null}
        message={message}
        optimizing={running}
        copyShortcut={formatShortcut(windowShortcut('copyAndHide'), platform)}
        t={t}
        onCopy={() => {
          run(controller.copyAndHide())
        }}
        onDismiss={(id) => {
          controller.dismissToast(id)
        }}
      />
    </div>
  )
}
