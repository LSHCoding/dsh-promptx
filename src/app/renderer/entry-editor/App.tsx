import { useEffect, useLayoutEffect, useRef, useSyncExternalStore, type ReactElement } from 'react'
import { errorReason, translate, type MessageKey } from '../../../shared/i18n/index.ts'
import type { SaveConflict } from '../../../shared/types.ts'
import { applyAppearance } from '../appearance.ts'
import { runTask } from '../controller/context.ts'
import { formatShortcut, WINDOW_SHORTCUTS } from '../shortcuts.ts'
import type { EntryEditorController } from './controller.ts'

const CONFLICT_KEYS: Record<SaveConflict, MessageKey> = {
  modified: 'entryEditor.conflictModified',
  missing: 'entryEditor.conflictMissing',
  noFrontMatter: 'entryEditor.conflictNoFrontMatter',
  invalidFrontMatter: 'entryEditor.conflictInvalidFrontMatter',
}

export function EntryEditorApp({ controller }: { controller: EntryEditorController }): ReactElement {
  const state = useSyncExternalStore(controller.store.subscribe, controller.store.getState)
  const { snapshot, locale, theme } = state
  const host = useRef<HTMLDivElement>(null)
  const t = (key: MessageKey) => translate(locale, key)
  const ready = state.load === 'ready'
  const frozen = snapshot?.freezeId != null
  const busy = state.action !== null || snapshot?.saving === true || frozen
  const title = snapshot?.binding.title ?? t('entryEditor.mode')

  useLayoutEffect(() => {
    applyAppearance(document, { platform: controller.bridge.platform, locale, theme })
    document.title = snapshot === null ? t('entryEditor.mode') : translate(locale, 'entryEditor.windowTitle', { title: snapshot.binding.title })
  }, [controller, locale, theme, snapshot])

  useLayoutEffect(() => {
    if (host.current === null) return undefined
    controller.editor.mount(host.current)
    if (controller.store.getState().load === 'ready') controller.editor.focus()
    return () => { controller.editor.unmount() }
  }, [controller])

  useEffect(() => {
    const onKeydown = (event: KeyboardEvent) => { controller.handleKeydown(event) }
    window.addEventListener('keydown', onKeydown, true)
    return () => { window.removeEventListener('keydown', onKeydown, true) }
  }, [controller])

  const reason = state.error === null ? '' : errorReason(locale, state.error)
  return (
    <main className="px-app px-entry-editor" aria-label={t('entryEditor.mode')}>
      <header className="px-entry-header">
        <div className="px-entry-heading">
          <span className="px-entry-mode">{t('entryEditor.mode')}</span>
          <h1 title={title}>{title}</h1>
        </div>
        <div className="px-entry-actions">
          <button
            type="button"
            className="px-button px-button-primary"
            disabled={!ready || busy || !state.dirty}
            title={translate(locale, 'common.withShortcut', { label: t('entryEditor.save'), shortcut: formatShortcut(WINDOW_SHORTCUTS.save, controller.bridge.platform) })}
            onMouseDown={(event) => { event.preventDefault() }}
            onClick={() => { runTask(controller.save()) }}
          >
            {t('entryEditor.save')}
          </button>
          <button type="button" className="px-button" disabled={frozen} onClick={() => { runTask(controller.close()) }}>{t('common.close')}</button>
        </div>
      </header>
      {snapshot === null ? null : <div className="px-entry-path" title={snapshot.binding.relPath}>{snapshot.binding.relPath}</div>}
      <div className="px-editor-area">
        <div className="px-editor" ref={host} />
        {state.load === 'loading' ? <div className="px-editor-overlay" role="status">{t('entryEditor.loading')}</div> : null}
        {state.load === 'error'
          ? (
            <div className="px-editor-overlay px-editor-overlay-error" role="alert">
              <p>{translate(locale, 'entryEditor.loadFailed', { reason })}</p>
              <button type="button" className="px-button" onClick={() => { runTask(controller.load()) }}>{t('common.retry')}</button>
            </div>
          )
          : null}
      </div>
      {snapshot?.conflict === null || snapshot === null ? null : (
        <aside className="px-entry-notice" role="alert">
          <span>{t(CONFLICT_KEYS[snapshot.conflict])}</span>
          {snapshot.conflict === 'modified'
            ? <button type="button" className="px-button" disabled={busy} onClick={() => { runTask(controller.reload()) }}>{t('entryEditor.reloadConfirm')}</button>
            : null}
        </aside>
      )}
      {ready && state.error !== null && snapshot?.conflict == null
        ? <div className="px-entry-notice" role="alert">{translate(locale, 'entryEditor.actionFailed', { reason })}</div>
        : null}
      <footer className="px-entry-status" aria-live="polite">
        {ready
          ? <span>{t(frozen ? 'entryEditor.busy' : busy ? 'entryEditor.saving' : state.dirty ? 'entryEditor.unsaved' : 'entryEditor.saved')}</span>
          : null}
        {snapshot?.recovered === true ? <span>{t('entryEditor.recovered')}</span> : null}
        <span className="px-entry-scope">{t('entryEditor.scope')}</span>
      </footer>
    </main>
  )
}
