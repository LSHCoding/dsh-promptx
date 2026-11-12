// 小窗里复用的小控件：图标按钮（带悬停提示）、「更多」菜单和右键菜单、可拖动的分隔线。

import { useRef, type MouseEvent, type PointerEvent, type ReactElement } from 'react'
import { runTask } from '../controller/context.ts'
import type { MenuState } from '../state/state.ts'
import { Icon, type IconName } from './icons.tsx'
import { useAppState, useController, useT } from './hooks.ts'

export interface IconButtonProps {
  icon: IconName
  /** 可访问名称；没有 tip 时也是悬停提示的文字。 */
  label: string
  /** 悬停提示的文字与可访问名称不同时传入，例如名称带上文件夹名，提示只写动作。 */
  tip?: string
  /** 当前生效的快捷键（已按平台格式化）；空串时悬停提示里不显示。 */
  shortcut?: string
  pressed?: boolean
  disabled?: boolean
  /** 悬停提示对齐的一侧：靠右的按钮让提示往左展开，免得超出窗口。 */
  tipAlign?: 'start' | 'end'
  className?: string
  /** 工具栏按钮点击时不抢编辑区的焦点，点完可以接着打字；键盘仍然可以用 Tab 走到它们。 */
  keepFocus?: boolean
  onClick: (event: MouseEvent<HTMLButtonElement>) => void
}

export function IconButton(props: IconButtonProps): ReactElement {
  const t = useT()
  const text = props.tip ?? props.label
  const tip = props.shortcut === undefined || props.shortcut === ''
    ? text
    : t('common.withShortcut', { label: text, shortcut: props.shortcut })
  return (
    <button
      type="button"
      className={`px-icon-button${props.className === undefined ? '' : ` ${props.className}`}`}
      aria-label={props.label}
      aria-pressed={props.pressed}
      data-tip={tip}
      data-tip-align={props.tipAlign ?? 'start'}
      disabled={props.disabled}
      onMouseDown={(event) => {
        if (props.keepFocus === true) event.preventDefault()
      }}
      onClick={props.onClick}
    >
      <Icon name={props.icon} />
    </button>
  )
}

export interface MenuItem {
  id: string
  label: string
  disabled?: boolean
  danger?: boolean
  onSelect: () => void
}

/**
 * 右键菜单：由 openMenu 以指针位置为锚点打开，这里只负责在菜单属于自己时显示。
 * 和 MenuButton 共用 store 里的菜单状态，同一时间只开一个菜单，Esc 和点击别处都能关掉。
 */
export function ContextMenu({ menuId, items }: { menuId: string; items: MenuItem[] }): ReactElement | null {
  const menu = useAppState(state => (state.menu?.id === menuId ? state.menu : null))
  return menu === null ? null : <MenuPopup anchor={menu.anchor} items={items} />
}

/** 「更多」按钮和它的菜单。菜单状态放在 store 里，Esc 和点击别处都能先把它关掉（技术方案 5.5）。 */
export function MenuButton({ menuId, label, items, icon = 'more', className }: {
  menuId: string
  label: string
  items: MenuItem[]
  icon?: IconName
  className?: string
}): ReactElement {
  const controller = useController()
  const menu = useAppState(state => (state.menu?.id === menuId ? state.menu : null))
  const open = menu !== null
  return (
    <span className="px-menu-anchor" data-menu-trigger={menuId}>
      <IconButton
        icon={icon}
        label={label}
        pressed={open}
        tipAlign="end"
        {...(className === undefined ? {} : { className })}
        onClick={(event) => {
          event.stopPropagation()
          if (open) {
            controller.closeMenu()
            return
          }
          const rect = event.currentTarget.getBoundingClientRect()
          controller.openMenu(menuId, { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom })
        }}
      />
      {menu === null ? null : <MenuPopup anchor={menu.anchor} items={items} />}
    </span>
  )
}

function MenuPopup({ anchor, items }: { anchor: MenuState['anchor']; items: MenuItem[] }): ReactElement {
  const controller = useController()
  const viewportWidth = document.documentElement.clientWidth || window.innerWidth
  const viewportHeight = document.documentElement.clientHeight || window.innerHeight
  // 菜单右边沿对齐按钮右边沿；按钮在窗口下半部分时向上弹出，免得被窗口底边截掉。
  // 右键菜单的锚点是指针所在的一个点：从指针处向右展开，文件夹栏贴着窗口左边，向左展开会超出窗口。
  const atPoint = anchor.left === anchor.right
  const placeAbove = anchor.bottom > viewportHeight * 0.6
  const style = {
    ...(atPoint ? { left: Math.max(4, anchor.left) } : { right: Math.max(4, viewportWidth - anchor.right) }),
    ...(placeAbove ? { bottom: Math.max(4, viewportHeight - anchor.top + 4) } : { top: anchor.bottom + 4 }),
  }
  return (
    <div
      className="px-menu"
      role="menu"
      style={style}
      onClick={(event) => {
        event.stopPropagation()
      }}
    >
      {items.map(item => (
        <button
          key={item.id}
          type="button"
          role="menuitem"
          className={`px-menu-item${item.danger === true ? ' px-menu-item-danger' : ''}`}
          disabled={item.disabled}
          onClick={() => {
            controller.closeMenu()
            item.onSelect()
          }}
        >
          {item.label}
        </button>
      ))}
    </div>
  )
}

export interface DividerProps {
  orientation: 'vertical' | 'horizontal'
  label: string
  /** 拖动开始时的尺寸。传函数时在按下的那一刻才算（例如预览区实际显示的高度）。 */
  value: number | (() => number)
  /** 向左（向上）拖时尺寸变大：右边的会话栏、下方的预览区。 */
  invert?: boolean
  min?: number
  /** 拖动开始时算出的上限（例如预览区不能把列表压到 96 以下）。 */
  max?: () => number
  onResize: (value: number) => void
  onCommit: () => void
}

/** 可拖动的分隔线（需求 5.4、5.7：分隔线可以拖动调整栏宽，栏宽记在本机）。 */
export function Divider(props: DividerProps): ReactElement {
  const drag = useRef<{ start: number; value: number; max: number } | null>(null)
  const position = (event: PointerEvent<HTMLDivElement>) => (props.orientation === 'vertical' ? event.clientX : event.clientY)
  return (
    <div
      className={`px-divider px-divider-${props.orientation}`}
      role="separator"
      aria-orientation={props.orientation}
      aria-label={props.label}
      onPointerDown={(event) => {
        event.preventDefault()
        event.currentTarget.setPointerCapture(event.pointerId)
        const value = typeof props.value === 'function' ? props.value() : props.value
        drag.current = { start: position(event), value, max: props.max?.() ?? Number.POSITIVE_INFINITY }
      }}
      onPointerMove={(event) => {
        const state = drag.current
        if (state === null) return
        const delta = (position(event) - state.start) * (props.invert === true ? -1 : 1)
        const next = Math.min(Math.max(state.value + delta, props.min ?? 0), Math.max(props.min ?? 0, state.max))
        props.onResize(Math.round(next))
      }}
      onPointerUp={(event) => {
        if (drag.current === null) return
        drag.current = null
        event.currentTarget.releasePointerCapture(event.pointerId)
        props.onCommit()
      }}
    />
  )
}

/** 组件里发起异步操作：错误交给 runTask 记录，不留下没人处理的 Promise。 */
export function run(task: Promise<unknown>): void {
  runTask(task)
}
