import { useEffect, useLayoutEffect, useRef, useSyncExternalStore, type ReactElement } from 'react'
import { errorReason, translate, type MessageKey } from '../../../shared/i18n/index.ts'
import { folderOf } from '../../../shared/library-rules.ts'
import type { SaveConflict } from '../../../shared/types.ts'
import { applyAppearance } from '../appearance.ts'
import { Icon } from '../components/icons.tsx'
import { runTask } from '../controller/context.ts'
import { formatShortcut, windowShortcut } from '../shortcuts.ts'
import type { EntryEditorController } from './controller.ts'

const CONFLICT_KEYS: Record<SaveConflict, MessageKey> = {
  modified: 'entryEditor.conflictModified',
  missing: 'entryEditor.conflictMissing',
  noFrontMatter: 'entryEditor.conflictNoFrontMatter',
  invalidFrontMatter: 'entryEditor.conflictInvalidFrontMatter',
  destinationOccupied: 'entryEditor.conflictDestinationOccupied',
}

export function EntryEditorApp({ controller }: { controller: EntryEditorController }): ReactElement {
  const state = useSyncExternalStore(controller.store.subscribe, controller.store.getState)
  const { snapshot, locale, theme } = state
  const host = useRef<HTMLDivElement>(null)
  const t = (key: MessageKey) => translate(locale, key)
  const ready = state.load === 'ready'
  const frozen = snapshot?.freezeId != null
  const busy = state.action !== null || snapshot?.saving === true || frozen
  const currentFolder = folderOf(snapshot?.binding.relPath ?? '')
  const selectedFolder = state.metadata.folder ?? currentFolder
  // 恢复草稿中选过的文件夹可能已经被移走，仍显示该选择，用户可以换到新的目标。
  const folders = [...new Set([...(snapshot?.folders ?? []), currentFolder, selectedFolder])].filter(folder => folder !== '')

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
  const relPath = snapshot?.binding.relPath ?? ''
  const status = !ready ? null : frozen ? 'busy' : busy ? 'saving' : state.dirty ? 'unsaved' : 'saved'
  // V0.1.5（界面方案第 16 条）：标题只在可编辑的大标题里出现一次，文件夹和标签压成一行，正文区更高。
  return (
    <main className="px-app px-entry-editor" aria-label={t('entryEditor.mode')}>
      <header className="px-entry-header">
        <div className="px-entry-crumb" title={relPath === '' ? undefined : relPath}>
          <span className="px-entry-mode">{t('entryEditor.mode')}</span>
          {relPath === '' ? null : <span className="px-entry-path">{relPath}</span>}
        </div>
        <div className="px-entry-actions">
          <button
            type="button"
            className="px-button px-button-primary"
            disabled={!ready || busy || !state.dirty}
            title={translate(locale, 'common.withShortcut', { label: t('entryEditor.save'), shortcut: formatShortcut(windowShortcut('save'), controller.bridge.platform) })}
            onMouseDown={(event) => { event.preventDefault() }}
            onClick={() => { runTask(controller.save()) }}
          >
            {t('entryEditor.save')}
          </button>
          <button
            type="button"
            className="px-icon-button"
            aria-label={t('common.close')}
            title={t('common.close')}
            disabled={frozen}
            onClick={() => { runTask(controller.close()) }}
          >
            <Icon name="close" />
          </button>
        </div>
      </header>
      {snapshot === null ? null : (
        <div className="px-entry-metadata">
          <input
            className="px-entry-title"
            type="text"
            aria-label={t('dialog.rename.titleField')}
            placeholder={t('dialog.rename.titleField')}
            value={state.metadata.title}
            readOnly={!ready || frozen}
            spellCheck={false}
            onChange={(event) => { controller.updateMetadata('title', event.target.value) }}
          />
          <div className="px-entry-fields">
            <label className="px-pill" title={t('dialog.saveMetadata.folder')}>
              <Icon name="folder" />
              <select
                aria-label={t('dialog.saveMetadata.folder')}
                value={selectedFolder}
                disabled={!ready || busy || snapshot.binding.libraryDir !== snapshot.config?.libraryDir}
                onChange={(event) => { controller.updateMetadata('folder', event.target.value) }}
              >
                <option value="">{t('library.uncategorized')}</option>
                {folders.map(folder => <option key={folder} value={folder}>{folder}</option>)}
              </select>
              <Icon name="chevron" size={14} className="px-pill-chevron" />
            </label>
            <label className="px-pill px-pill-grow" title={t('dialog.rename.tagsHint')}>
              <Icon name="tag" />
              <input
                type="text"
                aria-label={t('dialog.rename.tagsField')}
                aria-describedby="entry-editor-tags-hint"
                placeholder={t('entryEditor.tagsPlaceholder')}
                value={state.metadata.tags}
                readOnly={!ready || frozen}
                spellCheck={false}
                onChange={(event) => { controller.updateMetadata('tags', event.target.value) }}
              />
            </label>
            {/* 有标签时占位文字看不到，规则仍要让读屏软件读到。 */}
            <span className="px-visually-hidden" id="entry-editor-tags-hint">{t('dialog.rename.tagsHint')}</span>
          </div>
        </div>
      )}
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
        {status === null
          ? null
          : (
            <span className="px-entry-state" data-state={status}>
              {t(status === 'busy' ? 'entryEditor.busy' : status === 'saving' ? 'entryEditor.saving' : status === 'unsaved' ? 'entryEditor.unsaved' : 'entryEditor.saved')}
            </span>
          )}
        {snapshot?.recovered === true ? <span>{t('entryEditor.recovered')}</span> : null}
        <span className="px-entry-scope">{t('entryEditor.scope')}</span>
      </footer>
    </main>
  )
}
