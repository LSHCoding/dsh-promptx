// 优化会话栏（需求 O-02 至 O-07、5.6）：标题「优化会话」，旁边是模型名称和「清空会话」；消息按时间排列，
// 回复边生成边显示。底部的输入框可以发起优化或追加要求，生成中显示「取消」。

import { useLayoutEffect, useRef, type KeyboardEvent, type ReactElement } from 'react'
import { describeError } from '../../../shared/i18n/index.ts'
import { isBlank } from '../../../shared/text-metrics.ts'
import type { OptimizeRound } from '../../../shared/types.ts'
import { isComposingKey } from '../appearance.ts'
import { MenuButton, run } from './controls.tsx'
import { Spinner } from './icons.tsx'
import { useAppState, useController, useFocusTarget, useT } from './hooks.ts'

/** 距离底部不超过这么多像素就算「在底部」，新内容到来时跟着滚到底。 */
export const STICK_TO_BOTTOM_PX = 24

export function SessionPane(): ReactElement {
  const controller = useController()
  const t = useT()
  const session = useAppState(state => state.optimize.session)
  const width = useAppState(state => state.panes.sessionWidth)
  const messages = useRef<HTMLDivElement>(null)
  // 用户往上翻看早先的消息时为 false：生成中的回复不把视图强行拉到底（O-02）。
  const stick = useRef(true)

  useLayoutEffect(() => {
    const element = messages.current
    if (element !== null && stick.current) element.scrollTop = element.scrollHeight
  }, [session])

  return (
    <aside className="px-session" data-pane="session" style={{ width }} aria-label={t('session.label')}>
      <header className="px-session-head">
        <span className="px-session-title">{t('session.title')}</span>
        {session === null ? null : <span className="px-session-model" title={session.model.name}>{session.model.name}</span>}
        <button
          type="button"
          className="px-text-button"
          disabled={session === null}
          onClick={() => {
            run(controller.optimize.clear())
          }}
        >
          {t('session.clear')}
        </button>
      </header>
      <div
        className="px-session-messages"
        ref={messages}
        onScroll={(event) => {
          const element = event.currentTarget
          stick.current = element.scrollHeight - element.scrollTop - element.clientHeight <= STICK_TO_BOTTOM_PX
        }}
      >
        {session?.rounds.map(round => <Round key={round.id} round={round} model={session.model.name} />)}
      </div>
      <ChatInput />
    </aside>
  )
}

function Round({ round, model }: { round: OptimizeRound; model: string }): ReactElement {
  const controller = useController()
  const t = useT()
  const locale = useAppState(state => state.locale)
  const retry = (
    <button
      type="button"
      className="px-button"
      onClick={() => {
        run(controller.optimize.retry(round.id))
      }}
    >
      {t('session.retry')}
    </button>
  )
  return (
    <div className="px-round" data-status={round.status}>
      <div className="px-bubble px-bubble-user">
        <div className="px-bubble-label">{t('session.you')}</div>
        <div className="px-bubble-text px-bubble-text-user">{round.input}</div>
      </div>
      <div className="px-bubble px-bubble-reply">
        <div className="px-bubble-label">{model}</div>
        {round.reply === '' ? null : <div className="px-bubble-text">{round.reply}</div>}
        {round.status === 'running'
          ? (
            <div className="px-round-status">
              <Spinner label={t('status.optimizingIndicator')} />
              {round.reply === '' ? <span>{t('session.running')}</span> : null}
            </div>
          )
          : null}
        {round.status === 'failed'
          ? (
            <div className="px-round-status px-round-error" role="alert">
              <span>{t('session.failed', { reason: describeError(locale, round.error ?? { code: 'promptx/optimize/failed' }) })}</span>
              {retry}
            </div>
          )
          : null}
        {round.status === 'cancelled'
          ? (
            <div className="px-round-status">
              <span>{t('session.cancelled')}</span>
              {retry}
            </div>
          )
          : null}
        {round.status === 'done' ? <RoundActions round={round} /> : null}
      </div>
    </div>
  )
}

/** 有候选时「应用」「复制」「⋯」，⋯ 里是「复制整段回复」；提取不到候选时只有「复制回复」（O-03、O-04）。 */
function RoundActions({ round }: { round: OptimizeRound }): ReactElement {
  const controller = useController()
  const t = useT()
  if (round.candidate === null) {
    return (
      <div className="px-round-actions">
        <button
          type="button"
          className="px-button"
          onClick={() => {
            run(controller.optimize.copyReply(round.id))
          }}
        >
          {t('session.copyReply')}
        </button>
      </div>
    )
  }
  return (
    <div className="px-round-actions">
      <button
        type="button"
        className="px-button px-button-primary"
        onClick={() => {
          run(controller.optimize.apply(round.id))
        }}
      >
        {t('session.apply')}
      </button>
      <button
        type="button"
        className="px-button"
        onClick={() => {
          run(controller.optimize.copyCandidate(round.id))
        }}
      >
        {t('session.copy')}
      </button>
      <MenuButton
        menuId={`reply:${round.id}`}
        label={t('common.more')}
        items={[{ id: 'copyReply', label: t('session.copyWholeReply'), onSelect: () => { run(controller.optimize.copyReply(round.id)) } }]}
      />
    </div>
  )
}

/**
 * 聊天输入框：不带修饰键的 Enter 发送，Shift+Enter 换行，输入法组字时 Enter 用来选词；
 * 有一轮在进行时不能发送（输入框仍可以先写下一轮的要求）。⌘↩ 由窗口级快捷键处理，复制的是编辑区内容（F-03）。
 */
function ChatInput(): ReactElement {
  const controller = useController()
  const t = useT()
  const followup = useAppState(state => state.optimize.followup)
  const submitting = useAppState(state => state.optimize.submitting)
  const emptySession = useAppState(state => state.optimize.session === null)
  const running = useAppState(state => state.optimize.session?.rounds.some(round => round.status === 'running') ?? false)
  const placeholder = t(emptySession ? 'session.initialPlaceholder' : 'session.followupPlaceholder')
  const input = useRef<HTMLTextAreaElement>(null)
  useFocusTarget('followup', input)
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter' || isComposingKey(event.nativeEvent)) return
    if (event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) return
    event.preventDefault()
    if (!running && !submitting) run(controller.optimize.sendMessage())
  }
  return (
    <div className="px-followup">
      <textarea
        ref={input}
        className="px-input px-followup-input"
        rows={3}
        value={followup}
        placeholder={placeholder}
        aria-label={placeholder}
        spellCheck={false}
        onChange={(event) => {
          controller.optimize.setFollowup(event.target.value)
        }}
        onKeyDown={onKeyDown}
      />
      {running
        ? (
          <button
            type="button"
            className="px-button"
            onClick={() => {
              run(controller.optimize.cancel())
            }}
          >
            {t('session.cancel')}
          </button>
        )
        : (
          <button
            type="button"
            className="px-button px-button-primary"
            disabled={submitting || isBlank(followup)}
            onClick={() => {
              run(controller.optimize.sendMessage())
            }}
          >
            {t('session.send')}
          </button>
        )}
    </div>
  )
}
