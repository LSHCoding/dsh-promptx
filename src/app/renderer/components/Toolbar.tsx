// 编辑区工具栏（V0.1.5 按位置分组）：左端是「库」开关，分隔线后是保存、优化或停止、清空；右端是设置和「聊天」开关，
// 开关和它控制的栏在同一侧。隐藏小窗的按钮始终在窗口右上角：聊天栏关闭时在工具栏最右侧，打开时移到聊天栏头。
// 按钮只显示图标，悬停提示包含名称和当前快捷键。小窗没有系统标题栏，拖动工具栏的空白处移动小窗。

import type { ReactElement } from 'react'
import { formatShortcut, windowShortcut, type WindowCommand } from '../shortcuts.ts'
import { IconButton, run } from './controls.tsx'
import { useAppState, useController, useT } from './hooks.ts'

function useShortcut(): (command: WindowCommand) => string {
  const platform = useAppState(state => state.platform)
  const shortcuts = useAppState(state => state.config?.windowShortcuts)
  return (command: WindowCommand) => formatShortcut(windowShortcut(command, shortcuts), platform)
}

export function Toolbar(): ReactElement {
  const controller = useController()
  const t = useT()
  const shortcut = useShortcut()
  const libraryOpen = useAppState(state => state.library.open)
  const status = useAppState(state => state.editor.status)
  const loaded = useAppState(state => state.draft.load === 'ready')
  const saving = useAppState(state => state.draft.librarySaving)
  const session = useAppState(state => state.optimize.session)
  const submitting = useAppState(state => state.optimize.submitting)
  const sessionOpen = useAppState(state => state.optimize.paneOpen)
  const running = session?.rounds.some(round => round.status === 'running') ?? false

  return (
    <header className="px-toolbar px-pane-head" role="toolbar" aria-label={t('toolbar.label')}>
      <IconButton
        icon="library"
        label={t('toolbar.library')}
        shortcut={shortcut('library')}
        pressed={libraryOpen}
        keepFocus
        onClick={() => {
          run(controller.library.toggle())
        }}
      />
      <span className="px-toolbar-sep" aria-hidden="true" />
      <IconButton
        icon="save"
        label={t('toolbar.save')}
        shortcut={shortcut('save')}
        disabled={!loaded || saving || status === 'blank'}
        keepFocus
        onClick={() => {
          run(controller.save())
        }}
      />
      <IconButton
        icon={running ? 'stop' : 'optimize'}
        label={running ? t('toolbar.stop') : t('toolbar.optimize')}
        shortcut={shortcut('optimize')}
        disabled={submitting && !running}
        keepFocus
        onClick={() => {
          run(controller.optimize.toggle())
        }}
      />
      <IconButton
        icon="clear"
        label={t('toolbar.clear')}
        shortcut={shortcut('clear')}
        disabled={!loaded || status === 'blank'}
        keepFocus
        onClick={() => {
          controller.clear()
        }}
      />
      <div className="px-toolbar-drag" />
      <IconButton
        icon="settings"
        label={t('toolbar.settings')}
        shortcut={shortcut('settings')}
        tipAlign="end"
        keepFocus
        onClick={() => {
          run(controller.openSettings())
        }}
      />
      <IconButton
        icon="session"
        label={t('toolbar.session')}
        shortcut={shortcut('chat')}
        pressed={sessionOpen}
        tipAlign="end"
        keepFocus
        onClick={() => {
          run(controller.optimize.togglePane())
        }}
      />
      {sessionOpen
        ? null
        : (
          <>
            <span className="px-toolbar-sep" aria-hidden="true" />
            <HideButton />
          </>
        )}
    </header>
  )
}

/** 隐藏小窗。工具栏和聊天栏头共用，同一时间只出现在窗口最右侧的那一栏。 */
export function HideButton(): ReactElement {
  const controller = useController()
  const t = useT()
  const shortcut = useShortcut()
  return (
    <IconButton
      icon="close"
      label={t('toolbar.close')}
      shortcut={shortcut('hide')}
      tipAlign="end"
      keepFocus
      onClick={() => {
        run(controller.hide())
      }}
    />
  )
}
