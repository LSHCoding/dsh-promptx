// 优化会话栏（需求 O-02 至 O-07、5.6；V0.1.5 界面方案第 5、12 至 15 条）：头部是「优化会话」、模型名称、「清空会话」
// 和隐藏小窗按钮。没有会话时显示空状态；回复的说明用正文字体，改写稿放进卡片，边生成边显示。
// 底部是一体式输入框，可以发起优化或追加要求，生成中按钮变成「取消」。

import { useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactElement } from 'react'
import { splitReply } from '../../../shared/candidate.ts'
import { describeError } from '../../../shared/i18n/index.ts'
import { countCharacters, isBlank } from '../../../shared/text-metrics.ts'
import type { OptimizeRound } from '../../../shared/types.ts'
import { isComposingKey } from '../appearance.ts'
import { formatShortcut, windowShortcut } from '../shortcuts.ts'
import { MenuButton, run } from './controls.tsx'
import { Icon, Spinner } from './icons.tsx'
import { useAppState, useController, useFocusTarget, useT } from './hooks.ts'
import { HideButton } from './Toolbar.tsx'

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
      <header className="px-session-head px-pane-head px-drag-region">
        <span className="px-session-title">{t('session.title')}</span>
        <span className="px-session-model" title={session?.model.name}>{session?.model.name}</span>
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
        <span className="px-toolbar-sep" aria-hidden="true" />
        <HideButton />
      </header>
      <div
        className="px-session-messages"
        ref={messages}
        onScroll={(event) => {
          const element = event.currentTarget
          stick.current = element.scrollHeight - element.scrollTop - element.clientHeight <= STICK_TO_BOTTOM_PX
        }}
      >
        {session === null
          ? <EmptyState />
          : session.rounds.map(round => <Round key={round.id} round={round} model={session.model.name} />)}
      </div>
      <ChatInput />
    </aside>
  )
}

/** 还没有会话：说明聊天栏的用途，给出和工具栏「优化」相同的入口（界面方案第 12 条）。 */
function EmptyState(): ReactElement {
  const controller = useController()
  const t = useT()
  const platform = useAppState(state => state.platform)
  const shortcuts = useAppState(state => state.config?.windowShortcuts)
  const blank = useAppState(state => state.draft.load !== 'ready' || state.editor.status === 'blank')
  const submitting = useAppState(state => state.optimize.submitting)
  const shortcut = formatShortcut(windowShortcut('optimize', shortcuts), platform)
  return (
    <div className="px-session-empty">
      <div className="px-session-empty-badge"><Icon name="optimize" size={20} /></div>
      <p className="px-session-empty-title">{t('session.emptyTitle')}</p>
      <p className="px-session-empty-text">{t('session.emptyBody')}</p>
      <button
        type="button"
        className="px-button px-session-empty-action"
        disabled={blank || submitting}
        onClick={() => {
          run(controller.optimize.toggle())
        }}
      >
        <Icon name="optimize" />
        <span>{t('session.optimizeEditor')}</span>
        {/* 键帽只是提示，读屏软件读按钮名称就够了。 */}
        {shortcut === '' ? null : <kbd className="px-kbd" aria-hidden="true">{shortcut}</kbd>}
      </button>
      <p className="px-session-empty-text">{t('session.emptyHint')}</p>
    </div>
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
  const view = replyView(round)
  return (
    <div className="px-round" data-status={round.status}>
      {round.kind === 'initial'
        ? <InitialMessage text={round.input} />
        : (
          <div className="px-user-msg">
            {/* 追加的要求靠右对齐就能看出是谁说的；读屏软件仍然要听到「你」。 */}
            <span className="px-visually-hidden">{t('session.you')}</span>
            <div className="px-user-msg-text">{round.input}</div>
          </div>
        )}
      <div className="px-reply">
        <div className="px-reply-model"><Icon name="optimize" size={14} />{model}</div>
        {view.before === '' ? null : <div className="px-reply-text">{view.before}</div>}
        {view.card === null ? null : <CandidateCard round={round} text={view.card.text} mode={view.card.mode} />}
        {view.after === '' ? null : <div className="px-reply-text">{view.after}</div>}
        {round.status === 'running' && view.card?.mode !== 'open'
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
        {round.status === 'done' && round.candidate === null
          ? (
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
          : null}
      </div>
    </div>
  )
}

type CardMode = 'actions' | 'open' | 'plain'

interface ReplyView {
  before: string
  card: { text: string; mode: CardMode } | null
  after: string
}

/**
 * 一轮回复怎么显示（O-03、界面方案第 14 条）。完成的一轮以 Host 提取的 round.candidate 为准，「应用」「复制」用的也是它；
 * 前端用同一套规则定位它在回复里的位置，把前后的说明分开。两边对不上时（Host 和小窗版本不一致）不冒险切分，
 * 整段回复照常显示，卡片里放候选。生成中的一轮按当前收到的内容切分，卡片不给操作按钮。
 */
export function replyView(round: OptimizeRound): ReplyView {
  const running = round.status === 'running'
  const parts = splitReply(round.reply, running)
  if (round.status === 'done') {
    if (round.candidate === null) return { before: parts.candidate === null ? parts.before : round.reply.trim(), card: null, after: '' }
    if (parts.candidate === round.candidate) {
      return { before: parts.before, card: { text: round.candidate, mode: 'actions' }, after: parts.after }
    }
    return { before: round.reply.trim(), card: { text: round.candidate, mode: 'actions' }, after: '' }
  }
  if (parts.candidate === null) return { before: parts.before, card: null, after: '' }
  return { before: parts.before, card: { text: parts.candidate, mode: running ? 'open' : 'plain' }, after: parts.after }
}

/** 改写稿卡片：头部是「改写稿 · 字符数」和「复制」「应用」「⋯」，⋯ 里是「复制整段回复」（O-04）。 */
function CandidateCard({ round, text, mode }: { round: OptimizeRound; text: string; mode: CardMode }): ReactElement {
  const controller = useController()
  const t = useT()
  return (
    <div className="px-candidate">
      <div className="px-candidate-head">
        <span className="px-candidate-label">{t('session.candidate')}</span>
        {mode === 'open'
          ? (
            <>
              <span className="px-candidate-meta">{t('session.running')}</span>
              <Spinner label={t('status.optimizingIndicator')} />
            </>
          )
          : <span className="px-candidate-meta">{`· ${t('status.chars', { count: countCharacters(text) })}`}</span>}
        {mode === 'actions'
          ? (
            <>
              <button
                type="button"
                className="px-button px-button-sm"
                onClick={() => {
                  run(controller.optimize.copyCandidate(round.id))
                }}
              >
                {t('session.copy')}
              </button>
              <button
                type="button"
                className="px-button px-button-sm px-button-primary"
                onClick={() => {
                  run(controller.optimize.apply(round.id))
                }}
              >
                {t('session.apply')}
              </button>
              <MenuButton
                menuId={`reply:${round.id}`}
                label={t('common.more')}
                className="px-icon-button-sm"
                items={[{ id: 'copyReply', label: t('session.copyWholeReply'), onSelect: () => { run(controller.optimize.copyReply(round.id)) } }]}
              />
            </>
          )
          : null}
      </div>
      <pre className="px-candidate-body">{text}</pre>
    </div>
  )
}

/**
 * 第一轮发出的整段 Prompt（编辑区全文，或在空会话里直接输入的内容）：默认最多显示四行，超出时可以展开（界面方案第 15 条）。
 * 是否超出要量排版后的高度，长段落会自动换行，按字数或换行数估不准。
 */
function InitialMessage({ text }: { text: string }): ReactElement {
  const t = useT()
  const body = useRef<HTMLDivElement>(null)
  const [expanded, setExpanded] = useState(false)
  const [overflowing, setOverflowing] = useState(false)

  useLayoutEffect(() => {
    const element = body.current
    if (element === null || expanded) return undefined
    const measure = () => {
      setOverflowing(element.scrollHeight > element.clientHeight + 1)
    }
    measure()
    // 拖宽或拖窄会话栏会改变换行，重新量一次。
    if (typeof ResizeObserver === 'undefined') return undefined
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => {
      observer.disconnect()
    }
  }, [text, expanded])

  return (
    <div className="px-user-msg" data-expanded={expanded ? 'true' : undefined}>
      <div className="px-user-msg-label">{t('session.initialLabel', { count: countCharacters(text) })}</div>
      <div className="px-user-msg-draft" ref={body}>{text}</div>
      {overflowing || expanded
        ? (
          <button
            type="button"
            className="px-link-button"
            aria-expanded={expanded}
            onClick={() => {
              setExpanded(value => !value)
            }}
          >
            {expanded ? t('session.collapse') : t('session.expand')}
          </button>
        )
        : null}
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
    <div className="px-composer-wrap">
      <div
        className="px-composer"
        onMouseDown={(event) => {
          // 点输入框四周的空白（按键提示那一行）也把焦点交给文本框，整块看起来是一个输入框，用起来也一样。
          if (event.target instanceof Element && event.target.closest('button, textarea') !== null) return
          event.preventDefault()
          input.current?.focus()
        }}
      >
        <textarea
          ref={input}
          // px-followup-input 是端到端脚本认输入框用的类名。
          className="px-followup-input"
          rows={2}
          value={followup}
          placeholder={placeholder}
          aria-label={placeholder}
          spellCheck={false}
          onChange={(event) => {
            controller.optimize.setFollowup(event.target.value)
          }}
          onKeyDown={onKeyDown}
        />
        <div className="px-composer-bar">
          <span className="px-composer-hint">{t('session.composerHint')}</span>
          {running
            ? (
              <button
                type="button"
                className="px-send"
                aria-label={t('session.cancel')}
                title={t('session.cancel')}
                onClick={() => {
                  run(controller.optimize.cancel())
                }}
              >
                <Icon name="stop" />
              </button>
            )
            : (
              <button
                type="button"
                className="px-send"
                aria-label={t('session.send')}
                title={t('session.send')}
                disabled={submitting || isBlank(followup)}
                onClick={() => {
                  run(controller.optimize.sendMessage())
                }}
              >
                <Icon name="send" strokeWidth={1.7} />
              </button>
            )}
        </div>
      </div>
    </div>
  )
}
