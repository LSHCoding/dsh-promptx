// 编辑区和它下方的底栏（需求 E-01、F-01、5.3）。草稿读回之前编辑区显示「正在载入草稿…」且不能编辑；
// 读取失败时显示原因和「重试」，编辑区保持不可编辑，不给出可以编辑的空白草稿。

import { useLayoutEffect, useRef, type ReactElement } from 'react'
import { errorReason } from '../../../shared/i18n/index.ts'
import { run } from './controls.tsx'
import { useAppState, useController, useT } from './hooks.ts'
import { StatusBarContainer } from './StatusBar.tsx'

export function EditorPane(): ReactElement {
  const controller = useController()
  const t = useT()
  const host = useRef<HTMLDivElement>(null)
  const load = useAppState(state => state.draft.load)
  const loadError = useAppState(state => state.draft.loadError)
  const locale = useAppState(state => state.locale)

  useLayoutEffect(() => {
    if (host.current === null) return undefined
    controller.editor.mount(host.current)
    controller.editorMounted()
    return () => {
      controller.editor.unmount()
    }
  }, [controller])

  return (
    <section className="px-editor-column">
      <div className="px-editor-area">
        <div className="px-editor" ref={host} />
        {load === 'loading'
          ? <div className="px-editor-overlay" role="status">{t('editor.loading')}</div>
          : null}
        {load === 'error'
          ? (
            <div className="px-editor-overlay px-editor-overlay-error" role="alert">
              <p>{t('editor.loadFailed', { reason: loadError === null ? '' : errorReason(locale, loadError) })}</p>
              <button
                type="button"
                className="px-button"
                onClick={() => {
                  run(controller.retryLoad())
                }}
              >
                {t('common.retry')}
              </button>
            </div>
          )
          : null}
      </div>
      <StatusBarContainer />
    </section>
  )
}
