// 库侧栏（需求 L-02 至 L-11、5.4、5.5）：左边文件夹栏，右边列表栏（搜索、筛选、列表、选中预览）。
// 选中「回收站」时列表栏显示回收站，分段筛选和标签下拉隐藏，搜索框照常可用。

import { useRef, type ReactElement } from 'react'
import { relativeTime } from '../../../shared/i18n/index.ts'
import { folderOf } from '../../../shared/library-rules.ts'
import { PANE_LIMITS } from '../../../shared/layout.ts'
import type { EntryMeta, FolderSel, LibraryScope, TrashEntry } from '../../../shared/types.ts'
import { listErrorMessage, previewErrorMessage, unavailableMessage } from '../controller/context.ts'
import type { FolderChoice } from '../controller/library.ts'
import { Divider, IconButton, MenuButton, run, type MenuItem } from './controls.tsx'
import { Icon, Star, type IconName } from './icons.tsx'
import { useAppState, useController, useFocusTarget, useT, type Translate } from './hooks.ts'

const SCOPES: readonly LibraryScope[] = ['all', 'recent', 'favorites']

const SCOPE_KEYS = {
  all: 'library.scope.all',
  recent: 'library.scope.recent',
  favorites: 'library.scope.favorites',
} as const

export function LibraryPane(): ReactElement {
  const controller = useController()
  const t = useT()
  const panes = useAppState(state => state.panes)
  return (
    <div className="px-library" data-pane="library" role="region" aria-label={t('library.label')}>
      <FolderColumn width={panes.folderWidth} />
      <Divider
        orientation="vertical"
        label={t('library.resizeFolders')}
        value={panes.folderWidth}
        min={PANE_LIMITS.folder.min}
        max={() => PANE_LIMITS.folder.max}
        onResize={(folderWidth) => {
          controller.resizePanes({ folderWidth })
        }}
        onCommit={() => {
          controller.commitPaneSizes()
        }}
      />
      <ListColumn width={panes.listWidth} previewHeight={panes.previewHeight} />
    </div>
  )
}

// ───────────────────────────── 文件夹栏（L-03） ─────────────────────────────

function sameFolder(a: FolderSel, b: FolderSel): boolean {
  if (a.kind === 'folder') return b.kind === 'folder' && a.path === b.path
  return a.kind === b.kind
}

function FolderColumn({ width }: { width: number }): ReactElement {
  const controller = useController()
  const t = useT()
  const view = useAppState(state => state.library.view)
  const folder = useAppState(state => state.library.folder)
  const list = useAppState(state => state.library.list)
  const choose = (choice: FolderChoice) => {
    run(controller.library.chooseFolder(choice))
  }
  const isActive = (choice: FolderSel) => view === 'library' && sameFolder(folder, choice)
  return (
    <nav className="px-folders" style={{ width }} aria-label={t('library.folders')}>
      <div className="px-pane-heading px-folders-heading">
        <span>{t('library.folders')}</span>
        <IconButton
          icon="folderAdd"
          label={t('library.createFolder')}
          disabled={list?.state === 'unavailable'}
          onClick={() => { run(controller.library.createFolder()) }}
        />
        <IconButton
          icon="delete"
          label={t('library.deleteFolder')}
          disabled={view !== 'library' || folder.kind !== 'folder' || list?.folders.includes(folder.path) !== true}
          onClick={() => { if (folder.kind === 'folder') run(controller.library.removeFolder(folder.path)) }}
        />
      </div>
      <div className="px-folders-list">
        <FolderButton icon="all" label={t('library.all')} active={isActive({ kind: 'all' })} onClick={() => { choose({ kind: 'all' }) }} />
        <FolderButton icon="inbox" label={t('library.uncategorized')} active={isActive({ kind: 'root' })} onClick={() => { choose({ kind: 'root' }) }} />
        {(list?.folders ?? []).map((path) => {
          const segments = path.split('/')
          return (
            <FolderButton
              key={path}
              icon="folder"
              label={segments.at(-1) ?? path}
              title={path}
              depth={segments.length - 1}
              active={isActive({ kind: 'folder', path })}
              onClick={() => { choose({ kind: 'folder', path }) }}
            />
          )
        })}
      </div>
      <div className="px-folders-footer">
        <FolderButton icon="trash" label={t('library.trash')} active={view === 'trash'} onClick={() => { choose({ kind: 'trash' }) }} />
      </div>
    </nav>
  )
}

interface FolderButtonProps {
  icon: IconName
  label: string
  title?: string
  depth?: number
  active: boolean
  onClick: () => void
}

function FolderButton(props: FolderButtonProps): ReactElement {
  return (
    <button
      type="button"
      className="px-folder"
      aria-current={props.active ? 'true' : undefined}
      title={props.title ?? props.label}
      // 子文件夹每层缩进一级（需求 5.7）。
      style={{ paddingLeft: 10 + (props.depth ?? 0) * 14 }}
      onClick={props.onClick}
    >
      <Icon name={props.icon} />
      <span className="px-folder-label">{props.label}</span>
    </button>
  )
}

// ───────────────────────────── 列表栏（L-04、L-05） ─────────────────────────────

function ListColumn({ width, previewHeight }: { width: number; previewHeight: number }): ReactElement {
  const controller = useController()
  const t = useT()
  const view = useAppState(state => state.library.view)
  const column = useRef<HTMLElement>(null)
  const preview = useRef<HTMLDivElement>(null)
  // 预览区实际显示的高度。窗口矮时 CSS 把预览区压得比记下的高度矮（最矮 128，审查 CR-07），拖动要从显示的高度算起，
  // 否则往下拖的头几十像素没有反应；往上拖的上限也按它算。没有排版（offsetHeight 为 0）时按记下的高度。
  const shownPreviewHeight = (): number => {
    const shown = preview.current?.offsetHeight ?? 0
    return shown > 0 ? shown : previewHeight
  }
  return (
    <section className="px-list-column" style={{ width }} ref={column}>
      <SearchBox />
      {view === 'library' ? <Filters /> : <div className="px-pane-heading">{t('library.trash')}</div>}
      <div className="px-list-area">
        {view === 'library' ? <EntryList /> : <TrashList />}
      </div>
      <Divider
        orientation="horizontal"
        label={t('library.resizePreview')}
        value={shownPreviewHeight}
        invert
        min={PANE_LIMITS.preview.min}
        // 预览拖高时列表部分至少留 96（需求 5.7）。
        max={() => {
          const area = column.current?.querySelector('.px-list-area')
          const listHeight = area instanceof HTMLElement ? area.clientHeight : 0
          return shownPreviewHeight() + Math.max(0, listHeight - PANE_LIMITS.listPart.min)
        }}
        onResize={(height) => {
          controller.resizePanes({ previewHeight: height })
        }}
        onCommit={() => {
          controller.commitPaneSizes()
        }}
      />
      <div className="px-preview-area" style={{ height: previewHeight }} ref={preview}>
        {view === 'library' ? <Preview /> : <TrashPreview />}
      </div>
    </section>
  )
}

function SearchBox(): ReactElement {
  const controller = useController()
  const t = useT()
  const query = useAppState(state => state.library.query)
  const input = useRef<HTMLInputElement>(null)
  useFocusTarget('search', input)
  return (
    <div className="px-search">
      <input
        ref={input}
        type="search"
        className="px-input"
        placeholder={t('library.searchPlaceholder')}
        aria-label={t('library.searchPlaceholder')}
        value={query}
        spellCheck={false}
        onChange={(event) => {
          controller.library.setQuery(event.target.value)
        }}
      />
    </div>
  )
}

function Filters(): ReactElement {
  const controller = useController()
  const t = useT()
  const scope = useAppState(state => state.library.scope)
  const tag = useAppState(state => state.library.tag)
  const list = useAppState(state => state.library.list)
  return (
    <div className="px-filters">
      <div className="px-segmented" role="radiogroup" aria-label={t('library.scopeLabel')}>
        {SCOPES.map(item => (
          <button
            key={item}
            type="button"
            role="radio"
            aria-checked={item === scope}
            className="px-segment"
            onClick={() => {
              run(controller.library.setScope(item))
            }}
          >
            {t(SCOPE_KEYS[item])}
          </button>
        ))}
      </div>
      <select
        className="px-select"
        aria-label={t('library.tagLabel')}
        value={tag ?? ''}
        onChange={(event) => {
          run(controller.library.setTag(event.target.value === '' ? null : event.target.value))
        }}
      >
        <option value="">{t('library.allTags')}</option>
        {(list?.tags ?? []).map(item => <option key={item} value={item}>{item}</option>)}
      </select>
    </div>
  )
}

function EntryList(): ReactElement {
  const controller = useController()
  const t = useT()
  const list = useAppState(state => state.library.list)
  const listError = useAppState(state => state.library.listError)
  const selected = useAppState(state => state.library.selected)
  const locale = useAppState(state => state.locale)

  if (listError !== null) return <p className="px-empty">{listErrorMessage(locale, listError)}</p>
  if (list === null) return <div className="px-empty" />
  if (list.state === 'unavailable') {
    // 库目录不可用：侧栏说明原因，编辑、复制、优化照常可用（L-01）。
    return (
      <div className="px-empty px-unavailable" role="alert">
        <p>{unavailableMessage(locale, list.error ?? { code: 'promptx/library/unavailable' })}</p>
        <button
          type="button"
          className="px-button"
          onClick={() => {
            run(controller.openSettings())
          }}
        >
          {t('library.openSettings')}
        </button>
      </div>
    )
  }
  if (list.entries.length === 0) return <p className="px-empty">{list.total === 0 ? t('library.empty') : t('library.noMatch')}</p>
  const now = Date.now()
  return (
    <div className="px-list" role="listbox" aria-label={t('library.label')}>
      {list.entries.map(entry => (
        <EntryRow key={entry.relPath} entry={entry} selected={entry.relPath === selected} now={now} />
      ))}
    </div>
  )
}

/** 「更多」菜单（列表行和预览区共用）：在编辑器中打开、重命名 / 标签…、复制正文、收藏 / 取消收藏、删除（L-04）。 */
function entryMenu(entry: EntryMeta, t: Translate, controller: ReturnType<typeof useController>): MenuItem[] {
  const unreadable = entry.status === 'unreadable'
  return [
    { id: 'open', label: t('library.action.open'), disabled: unreadable, onSelect: () => { run(controller.library.openEntry(entry.relPath)) } },
    { id: 'rename', label: t('library.action.rename'), disabled: unreadable, onSelect: () => { run(controller.library.rename(entry.relPath)) } },
    { id: 'copy', label: t('library.action.copyBody'), disabled: unreadable, onSelect: () => { run(controller.library.copyBody(entry.relPath)) } },
    {
      id: 'favorite',
      label: entry.favorite ? t('library.action.unfavorite') : t('library.action.favorite'),
      disabled: unreadable,
      onSelect: () => { run(controller.library.toggleFavorite(entry.relPath)) },
    },
    { id: 'delete', label: t('library.action.delete'), danger: true, onSelect: () => { run(controller.library.remove(entry.relPath)) } },
  ]
}

function EntryRow({ entry, selected, now }: { entry: EntryMeta; selected: boolean; now: number }): ReactElement {
  const controller = useController()
  const t = useT()
  const locale = useAppState(state => state.locale)
  const menuId = `entry:${entry.relPath}`
  const menuOpen = useAppState(state => state.menu?.id === menuId)
  const select = () => {
    run(controller.library.select(entry.relPath))
  }
  return (
    <div
      className="px-row"
      role="option"
      aria-selected={selected}
      data-menu-open={menuOpen ? 'true' : undefined}
      tabIndex={0}
      onClick={select}
      onDoubleClick={() => {
        if (entry.status === 'unreadable') return
        // 选中同步完成，不等预览读取；插入沿用编辑器失焦前保留的选区和读取失效保护。
        if (controller.store.getState().library.selected !== entry.relPath) select()
        run(controller.library.insertSelected())
      }}
      onKeyDown={(event) => {
        if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) {
          event.preventDefault()
          select()
        }
      }}
    >
      <div className="px-row-main">
        <div className="px-row-title" title={entry.title}>
          {entry.favorite ? <Star label={t('library.favorited')} /> : null}
          <span className="px-row-title-text">{entry.title}</span>
        </div>
        <div className="px-row-meta">
          <span>{relativeTime(entry.updatedAt, now, locale)}</span>
          {entry.tags.slice(0, 2).map(tag => <span key={tag} className="px-tag">{tag}</span>)}
          {entry.status === 'unreadable' ? <span className="px-badge">{t('library.badge.unreadable')}</span> : null}
          {entry.status === 'invalid-meta' ? <span className="px-badge">{t('library.badge.invalidMeta')}</span> : null}
        </div>
      </div>
      {/* 悬停或选中时才显示的三个操作；不显示时标题占满整行（L-04）。 */}
      <div
        className="px-row-actions"
        onClick={(event) => { event.stopPropagation() }}
        onDoubleClick={(event) => { event.stopPropagation() }}
      >
        <IconButton
          icon="open"
          label={t('library.action.open')}
          disabled={entry.status === 'unreadable'}
          onClick={() => {
            run(controller.library.openEntry(entry.relPath))
          }}
        />
        <IconButton
          icon="delete"
          label={t('library.action.delete')}
          onClick={() => {
            run(controller.library.remove(entry.relPath))
          }}
        />
        <MenuButton menuId={menuId} label={t('common.more')} items={entryMenu(entry, t, controller)} />
      </div>
    </div>
  )
}

function Preview(): ReactElement {
  const controller = useController()
  const t = useT()
  const preview = useAppState(state => state.library.preview)
  const locale = useAppState(state => state.locale)
  if (preview === null) return <p className="px-empty">{t('library.selectHint')}</p>
  const entry = preview.entry
  return (
    <div className="px-preview">
      <div className="px-preview-head">
        <div className="px-preview-title" title={entry.title}>
          {entry.favorite ? <Star label={t('library.favorited')} /> : null}
          <span>{entry.title}</span>
        </div>
        <div className="px-preview-meta">
          <span>{relativeTime(entry.updatedAt, Date.now(), locale)}</span>
          {entry.tags.map(tag => <span key={tag} className="px-tag">{tag}</span>)}
        </div>
      </div>
      <div className="px-preview-body">
        {preview.status === 'ready' ? <pre className="px-preview-text">{preview.body}</pre> : null}
        {preview.status === 'error'
          ? (
            <p className="px-preview-error" role="alert">
              {previewErrorMessage(locale, preview.error ?? { code: 'promptx/library/unreadable', detail: entry.unreadableReason ?? 'read-failed' })}
            </p>
          )
          : null}
      </div>
      <div className="px-preview-actions">
        <button
          type="button"
          className="px-button"
          disabled={preview.status !== 'ready'}
          onMouseDown={(event) => {
            event.preventDefault()
          }}
          onClick={() => {
            run(controller.library.insertSelected())
          }}
        >
          {t('library.insert')}
        </button>
        <MenuButton menuId={`preview:${entry.relPath}`} label={t('common.more')} items={entryMenu(entry, t, controller)} />
      </div>
    </div>
  )
}

// ───────────────────────────── 回收站（L-11） ─────────────────────────────

function originalFolder(entry: TrashEntry, t: Translate): string {
  if (entry.originalPath === null) return t('trash.unknownLocation')
  const folder = folderOf(entry.originalPath)
  return folder === '' ? t('library.uncategorized') : folder
}

function TrashList(): ReactElement {
  const controller = useController()
  const t = useT()
  const trash = useAppState(state => state.library.trash)
  const trashError = useAppState(state => state.library.trashError)
  const selected = useAppState(state => state.library.trashSelected)
  const query = useAppState(state => state.library.query)
  const locale = useAppState(state => state.locale)
  if (trashError !== null) return <p className="px-empty">{listErrorMessage(locale, trashError)}</p>
  if (trash === null) return <div className="px-empty" />
  const now = Date.now()
  return (
    <>
      {trash.recordState === 'unreadable' ? <p className="px-notice" role="alert">{t('trash.recordUnreadable')}</p> : null}
      {trash.entries.length === 0
        ? <p className="px-empty">{query.trim() === '' ? t('trash.empty') : t('library.noMatch')}</p>
        : (
          <div className="px-list" role="listbox" aria-label={t('library.trash')}>
            {trash.entries.map((entry) => {
              const select = () => {
                run(controller.library.selectTrash(entry.file))
              }
              return (
                <div
                  key={entry.file}
                  className="px-row"
                  role="option"
                  aria-selected={entry.file === selected}
                  tabIndex={0}
                  onClick={select}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault()
                      select()
                    }
                  }}
                >
                  <div className="px-row-main">
                    <div className="px-row-title" title={entry.title}>
                      {entry.kind === 'folder' ? <Icon name="folder" /> : null}
                      <span className="px-row-title-text">{entry.title}</span>
                    </div>
                    <div className="px-row-meta">
                      {entry.deletedAt === null ? null : <span>{t('trash.deletedAgo', { time: relativeTime(entry.deletedAt, now, locale) })}</span>}
                      <span>{originalFolder(entry, t)}</span>
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        )}
    </>
  )
}

function TrashPreview(): ReactElement {
  const controller = useController()
  const t = useT()
  const preview = useAppState(state => state.library.trashPreview)
  const locale = useAppState(state => state.locale)
  if (preview === null) return <p className="px-empty">{t('library.selectHint')}</p>
  const { entry } = preview
  const originalParent = entry.originalPath === null ? '' : folderOf(entry.originalPath)
  const originalPath = entry.kind === 'folder' ? entry.originalPath : originalParent === '' ? t('trash.root') : `${originalParent}/`
  const location = entry.originalPath === null
    ? t('trash.originalUnknown')
    : t('trash.originalLocation', { path: originalPath ?? '' })
  return (
    <div className="px-preview">
      <div className="px-preview-head">
        <div className="px-preview-title" title={entry.title}><span>{entry.title}</span></div>
        <div className="px-preview-meta"><span>{location}</span></div>
      </div>
      <div className="px-preview-body">
        {preview.status === 'ready' && entry.kind !== 'folder' ? <pre className="px-preview-text">{preview.body}</pre> : null}
        {preview.status === 'error' && preview.error !== null
          ? <p className="px-preview-error" role="alert">{previewErrorMessage(locale, preview.error)}</p>
          : null}
      </div>
      <div className="px-preview-actions">
        <button
          type="button"
          className="px-button"
          onClick={() => {
            run(controller.library.restore(entry.file))
          }}
        >
          {t('trash.restore')}
        </button>
      </div>
    </div>
  )
}
