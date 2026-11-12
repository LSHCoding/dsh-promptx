// 库、编辑区和聊天栏并排布局。工具栏和底栏属于编辑区。

import { useEffect, useLayoutEffect, type ReactElement } from 'react'
import { PANE_LIMITS } from '../../../shared/layout.ts'
import { applyAppearance } from '../appearance.ts'
import type { AppController } from '../controller/app.ts'
import { Divider } from './controls.tsx'
import { DialogHost } from './Dialog.tsx'
import { EditorPane } from './EditorPane.tsx'
import { ControllerContext, useAppState, useController, useT } from './hooks.ts'
import { LibraryPane } from './LibraryPane.tsx'
import { SessionPane } from './SessionPane.tsx'

export function App({ controller }: { controller: AppController }): ReactElement {
  return (
    <ControllerContext.Provider value={controller}>
      <Shell />
    </ControllerContext.Provider>
  )
}

function Shell(): ReactElement {
  const controller = useController()
  const t = useT()
  const theme = useAppState(state => state.theme)
  const platform = useAppState(state => state.platform)
  const locale = useAppState(state => state.locale)
  const libraryOpen = useAppState(state => state.library.open)
  const sessionOpen = useAppState(state => state.optimize.paneOpen)
  const listWidth = useAppState(state => state.panes.listWidth)
  const sessionWidth = useAppState(state => state.panes.sessionWidth)

  useLayoutEffect(() => {
    applyAppearance(document, { theme, platform, locale })
  }, [theme, platform, locale])

  useEffect(() => {
    // 捕获阶段：先于编辑区和输入框处理窗口级快捷键（⌘↩ 在追加输入框里也是复制编辑区内容）。
    const onKeyDown = (event: KeyboardEvent) => {
      controller.handleKeydown(event)
    }
    // 点菜单以外的地方关掉菜单；点菜单按钮本身由按钮自己切换开合。
    const onPointerDown = (event: PointerEvent) => {
      if (controller.store.getState().menu === null) return
      const target = event.target
      if (target instanceof Element && target.closest('.px-menu, [data-menu-trigger]') !== null) return
      controller.closeMenu()
    }
    window.addEventListener('keydown', onKeyDown, true)
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => {
      window.removeEventListener('keydown', onKeyDown, true)
      document.removeEventListener('pointerdown', onPointerDown, true)
    }
  }, [controller])

  return (
    <div className="px-app">
      <main className="px-body">
        {libraryOpen
          ? (
            <>
              <LibraryPane />
              <Divider
                orientation="vertical"
                label={t('library.resizeList')}
                value={listWidth}
                min={PANE_LIMITS.list.min}
                onResize={(width) => {
                  controller.resizePanes({ listWidth: width })
                }}
                onCommit={() => {
                  controller.commitPaneSizes()
                }}
              />
            </>
          )
          : null}
        <EditorPane />
        {sessionOpen
          ? (
            <>
              <Divider
                orientation="vertical"
                label={t('session.resize')}
                value={sessionWidth}
                invert
                min={PANE_LIMITS.session.min}
                max={() => PANE_LIMITS.session.max}
                onResize={(width) => {
                  controller.resizePanes({ sessionWidth: width })
                }}
                onCommit={() => {
                  controller.commitPaneSizes()
                }}
              />
              <SessionPane />
            </>
          )
          : null}
      </main>
      <DialogHost />
    </div>
  )
}
