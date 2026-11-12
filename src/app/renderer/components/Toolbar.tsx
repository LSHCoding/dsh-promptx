// 编辑区工具栏：左组为库、保存、优化或停止、清空、聊天；右组为设置、关闭。
// 按钮只显示图标，悬停提示包含名称和当前快捷键。小窗没有系统标题栏，拖动工具栏的空白处移动小窗。

import type { ReactElement } from 'react'
import { formatShortcut, windowShortcut, type WindowCommand } from '../shortcuts.ts'
import { IconButton, run } from './controls.tsx'
import { useAppState, useController, useT } from './hooks.ts'

export function Toolbar(): ReactElement {
  const controller = useController()
  const t = useT()
  const platform = useAppState(state => state.platform)
  const shortcuts = useAppState(state => state.config?.windowShortcuts)
  const libraryOpen = useAppState(state => state.library.open)
  const status = useAppState(state => state.editor.status)
  const loaded = useAppState(state => state.draft.load === 'ready')
  const saving = useAppState(state => state.draft.librarySaving)
  const session = useAppState(state => state.optimize.session)
  const submitting = useAppState(state => state.optimize.submitting)
  const sessionOpen = useAppState(state => state.optimize.paneOpen)
  const running = session?.rounds.some(round => round.status === 'running') ?? false
  const shortcut = (command: WindowCommand) => formatShortcut(windowShortcut(command, shortcuts), platform)

  return (
    <header className="px-toolbar" role="toolbar" aria-label={t('toolbar.label')}>
      <div className="px-toolbar-group">
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
        <IconButton
          icon="session"
          label={t('toolbar.session')}
          shortcut={shortcut('chat')}
          pressed={sessionOpen}
          keepFocus
          onClick={() => {
            run(controller.optimize.togglePane())
          }}
        />
      </div>
      <div className="px-toolbar-drag" />
      <div className="px-toolbar-group">
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
          icon="close"
          label={t('toolbar.close')}
          shortcut={shortcut('hide')}
          tipAlign="end"
          keepFocus
          onClick={() => {
            run(controller.hide())
          }}
        />
      </div>
    </header>
  )
}
