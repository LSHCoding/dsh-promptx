// 工具栏（需求 5.3、5.6，S-02）：左组 库、保存、优化或停止、清空，有会话时加「会话」；右组 设置、关闭。
// 按钮只显示图标，悬停提示包含名称和当前快捷键。小窗没有系统标题栏，拖动工具栏的空白处移动小窗。

import type { ReactElement } from 'react'
import { formatShortcut, WINDOW_SHORTCUTS } from '../shortcuts.ts'
import { IconButton, run } from './controls.tsx'
import { useAppState, useController, useT } from './hooks.ts'

export function Toolbar(): ReactElement {
  const controller = useController()
  const t = useT()
  const platform = useAppState(state => state.platform)
  const libraryOpen = useAppState(state => state.library.open)
  const status = useAppState(state => state.editor.status)
  const loaded = useAppState(state => state.draft.load === 'ready')
  const session = useAppState(state => state.optimize.session)
  const sessionOpen = useAppState(state => state.optimize.paneOpen)
  const running = session?.rounds.some(round => round.status === 'running') ?? false
  const shortcut = (command: keyof typeof WINDOW_SHORTCUTS) => formatShortcut(WINDOW_SHORTCUTS[command], platform)

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
          disabled={!loaded}
          keepFocus
          onClick={() => {
            run(controller.save())
          }}
        />
        <IconButton
          icon={running ? 'stop' : 'optimize'}
          label={running ? t('toolbar.stop') : t('toolbar.optimize')}
          shortcut={shortcut('optimize')}
          keepFocus
          onClick={() => {
            run(controller.optimize.toggle())
          }}
        />
        <IconButton
          icon="clear"
          label={t('toolbar.clear')}
          disabled={!loaded || status === 'blank'}
          keepFocus
          onClick={() => {
            controller.clear()
          }}
        />
        {session === null
          ? null
          : (
            <IconButton
              icon="session"
              label={t('toolbar.session')}
              pressed={sessionOpen}
              keepFocus
              onClick={() => {
                run(controller.optimize.togglePane())
              }}
            />
          )}
      </div>
      <div className="px-toolbar-drag" />
      <div className="px-toolbar-group">
        <IconButton
          icon="settings"
          label={t('toolbar.settings')}
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
