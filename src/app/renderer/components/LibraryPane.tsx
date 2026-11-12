// 库侧栏（需求 L-02 至 L-11、5.4、5.5；V0.1.5 界面方案第 1、2、6 至 9、19 条）：左边文件夹栏，右边列表栏（搜索、筛选、列表、选中预览）。
// 选中条目后才显示预览区；列表栏底部固定一行，放条目数和选中条目的操作。
// 选中「回收站」时列表栏显示回收站，分段筛选和标签下拉隐藏，搜索框照常可用。

import { useLayoutEffect, useRef, type ReactElement } from 'react'
import { relativeTime } from '../../../shared/i18n/index.ts'
import { folderOf } from '../../../shared/library-rules.ts'
import { PANE_LIMITS } from '../../../shared/layout.ts'
import type { EntryMeta, FolderSel, LibraryScope, TrashEntry } from '../../../shared/types.ts'
import { listErrorMessage, previewErrorMessage, unavailableMessage } from '../controller/context.ts'
import type { FolderChoice } from '../controller/library.ts'
import { ContextMenu, Divider, IconButton, MenuButton, run, type MenuItem } from './controls.tsx'
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

// ───────────────────────────── 文件夹栏（L-03、L-13） ─────────────────────────────

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
      <div className="px-folders-heading px-pane-head px-drag-region">
        <span>{t('library.folders')}</span>
        {/* 删除放到每个文件夹的行上（悬停按钮和右键菜单），栏头只留新建，和底部的回收站图标不再挨着两个相似的图标。 */}
        <IconButton
          icon="folderAdd"
          label={t('library.createFolder')}
          tipAlign="end"
          disabled={list?.state === 'unavailable'}
          onClick={() => { run(controller.library.createFolder()) }}
        />
      </div>
      <div className="px-folders-list">
        <FolderRow icon="all" label={t('library.all')} active={isActive({ kind: 'all' })} onClick={() => { choose({ kind: 'all' }) }} />
        <FolderRow icon="inbox" label={t('library.uncategorized')} active={isActive({ kind: 'root' })} onClick={() => { choose({ kind: 'root' }) }} />
        {(list?.folders ?? []).map((path) => {
          const segments = path.split('/')
          return (
            <FolderRow
              key={path}
              icon="folder"
              label={segments.at(-1) ?? path}
              title={path}
              depth={segments.length - 1}
              active={isActive({ kind: 'folder', path })}
              onClick={() => { choose({ kind: 'folder', path }) }}
              onDelete={() => { run(controller.library.removeFolder(path)) }}
              menuId={`folder:${path}`}
            />
          )
        })}
      </div>
      <div className="px-folders-footer px-pane-foot">
        <FolderRow icon="trash" label={t('library.trash')} active={view === 'trash'} onClick={() => { choose({ kind: 'trash' }) }} />
      </div>
    </nav>
  )
}

interface FolderRowProps {
  icon: IconName
  label: string
  title?: string
  depth?: number
  active: boolean
  onClick: () => void
  /** 真实文件夹才有：悬停或键盘聚焦时显示删除按钮，右键菜单里也有「删除文件夹」。 */
  onDelete?: () => void
  menuId?: string
}

function FolderRow(props: FolderRowProps): ReactElement {
  const controller = useController()
  const t = useT()
  const { onDelete, menuId } = props
  return (
    <div
      className="px-folder-row"
      // 右键时先触发的 pointerdown 会关掉已经打开的其他菜单（App 里点别处关菜单的处理），这里再打开这一行的菜单。
      onContextMenu={onDelete === undefined || menuId === undefined
        ? undefined
        : (event) => {
          event.preventDefault()
          controller.openMenu(menuId, { left: event.clientX, top: event.clientY, right: event.clientX, bottom: event.clientY })
        }}
    >
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
      {onDelete === undefined
        ? null
        : (
          <IconButton
            icon="delete"
            className="px-folder-action"
            label={t('library.deleteFolderNamed', { name: props.title ?? props.label })}
            tip={t('library.deleteFolder')}
            tipAlign="end"
            onClick={onDelete}
          />
        )}
      {onDelete === undefined || menuId === undefined
        ? null
        : <ContextMenu menuId={menuId} items={[{ id: 'delete', label: t('library.deleteFolder'), danger: true, onSelect: onDelete }]} />}
    </div>
  )
}

// ───────────────────────────── 列表栏（L-04、L-05） ─────────────────────────────

function ListColumn({ width, previewHeight }: { width: number; previewHeight: number }): ReactElement {
  const controller = useController()
  const t = useT()
  const view = useAppState(state => state.library.view)
  const selected = useAppState(state => (state.library.view === 'library' ? state.library.selected : state.library.trashSelected))
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
      {/* 没选中条目时不留空白的预览区，列表占满整列；选中后预览从底部展开，高度仍按记下的值（界面方案第 6 条）。 */}
      {selected === null
        ? null
        : (
          <>
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
          </>
        )}
      {view === 'library' ? <ListFooter /> : <TrashFooter />}
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
    <div className="px-search px-pane-head px-drag-region">
      <label className="px-search-field">
        <Icon name="search" />
        <input
          ref={input}
          type="search"
          placeholder={t('library.searchPlaceholder')}
          aria-label={t('library.searchPlaceholder')}
          value={query}
          spellCheck={false}
          onChange={(event) => {
            controller.library.setQuery(event.target.value)
          }}
        />
      </label>
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

/** 「更多」菜单（列表行和列表栏底部共用）：在编辑器中打开、重命名 / 标签…、复制正文、收藏 / 取消收藏、删除（L-04）。 */
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

/**
 * 选中后预览区才展开，列表区会矮下一截：把选中的行滚到可见的位置，免得被预览盖住。
 * jsdom 没有 scrollIntoView，所以按可选方法调用。
 */
function useRevealWhenSelected(selected: boolean) {
  const row = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    if (!selected || row.current === null) return
    const element: Partial<Pick<HTMLElement, 'scrollIntoView'>> = row.current
    element.scrollIntoView?.({ block: 'nearest' })
  }, [selected])
  return row
}

function EntryRow({ entry, selected, now }: { entry: EntryMeta; selected: boolean; now: number }): ReactElement {
  const controller = useController()
  const t = useT()
  const locale = useAppState(state => state.locale)
  const menuId = `entry:${entry.relPath}`
  const menuOpen = useAppState(state => state.menu?.id === menuId)
  const row = useRevealWhenSelected(selected)
  const select = () => {
    run(controller.library.select(entry.relPath))
  }
  return (
    <div
      ref={row}
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
      {/* 悬停或选中时才显示的三个操作；不显示时标题占满整行（L-04）。提示向左展开，见 app.css 的列表区。 */}
      <div
        className="px-row-actions"
        onClick={(event) => { event.stopPropagation() }}
        onDoubleClick={(event) => { event.stopPropagation() }}
      >
        <IconButton
          icon="open"
          label={t('library.action.open')}
          tipAlign="end"
          disabled={entry.status === 'unreadable'}
          onClick={() => {
            run(controller.library.openEntry(entry.relPath))
          }}
        />
        <IconButton
          icon="delete"
          label={t('library.action.delete')}
          tipAlign="end"
          onClick={() => {
            run(controller.library.remove(entry.relPath))
          }}
        />
        <MenuButton menuId={menuId} label={t('common.more')} items={entryMenu(entry, t, controller)} />
      </div>
    </div>
  )
}

function Preview(): ReactElement | null {
  const t = useT()
  const preview = useAppState(state => state.library.preview)
  const locale = useAppState(state => state.locale)
  if (preview === null) return null
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
    </div>
  )
}

type CountKeys = ['library.countOne', 'library.countMany'] | ['trash.countOne', 'trash.countMany']

/** 条目数：英文区分单复数，中文两条文案相同。 */
function countLabel(t: Translate, count: number, [one, many]: CountKeys): string {
  return t(count === 1 ? one : many, { count })
}

/** 列表栏底部：左边是条目数，选中条目后右边出现「插入到光标」和「⋯」，位置不随预览高度移动。 */
function ListFooter(): ReactElement {
  const controller = useController()
  const t = useT()
  const list = useAppState(state => state.library.list)
  const preview = useAppState(state => state.library.preview)
  const count = list?.state === 'ok' ? list.entries.length : 0
  return (
    <div className="px-list-footer px-pane-foot">
      <span className="px-list-count">{count === 0 ? null : countLabel(t, count, ['library.countOne', 'library.countMany'])}</span>
      {preview === null
        ? null
        : (
          <>
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
            <MenuButton menuId={`preview:${preview.entry.relPath}`} label={t('common.more')} items={entryMenu(preview.entry, t, controller)} />
          </>
        )}
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
            {trash.entries.map(entry => (
              <TrashRow
                key={entry.file}
                entry={entry}
                selected={entry.file === selected}
                location={originalFolder(entry, t)}
                deletedAgo={entry.deletedAt === null ? null : t('trash.deletedAgo', { time: relativeTime(entry.deletedAt, now, locale) })}
                onSelect={() => {
                  run(controller.library.selectTrash(entry.file))
                }}
              />
            ))}
          </div>
        )}
    </>
  )
}

interface TrashRowProps {
  entry: TrashEntry
  selected: boolean
  location: string
  deletedAgo: string | null
  onSelect: () => void
}

function TrashRow(props: TrashRowProps): ReactElement {
  const row = useRevealWhenSelected(props.selected)
  return (
    <div
      ref={row}
      className="px-row"
      role="option"
      aria-selected={props.selected}
      tabIndex={0}
      onClick={props.onSelect}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          props.onSelect()
        }
      }}
    >
      <div className="px-row-main">
        <div className="px-row-title" title={props.entry.title}>
          {props.entry.kind === 'folder' ? <Icon name="folder" /> : null}
          <span className="px-row-title-text">{props.entry.title}</span>
        </div>
        <div className="px-row-meta">
          {props.deletedAgo === null ? null : <span>{props.deletedAgo}</span>}
          <span>{props.location}</span>
        </div>
      </div>
    </div>
  )
}

function TrashPreview(): ReactElement | null {
  const t = useT()
  const preview = useAppState(state => state.library.trashPreview)
  const locale = useAppState(state => state.locale)
  if (preview === null) return null
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
    </div>
  )
}

/** 回收站视图的底部：左边是条目数，选中后右边是「恢复」。 */
function TrashFooter(): ReactElement {
  const controller = useController()
  const t = useT()
  const trash = useAppState(state => state.library.trash)
  const preview = useAppState(state => state.library.trashPreview)
  const count = trash?.entries.length ?? 0
  return (
    <div className="px-list-footer px-pane-foot">
      <span className="px-list-count">{count === 0 ? null : countLabel(t, count, ['trash.countOne', 'trash.countMany'])}</span>
      {preview === null
        ? null
        : (
          <button
            type="button"
            className="px-button"
            onClick={() => {
              run(controller.library.restore(preview.entry.file))
            }}
          >
            {t('trash.restore')}
          </button>
        )}
    </div>
  )
}
