// 工具栏和列表用的线条图标。颜色跟随文字（currentColor），只有收藏星标用固定的黄色（需求 5.10）。

import type { ReactElement } from 'react'

export type IconName =
  | 'library'
  | 'save'
  | 'optimize'
  | 'stop'
  | 'clear'
  | 'session'
  | 'settings'
  | 'close'
  | 'open'
  | 'delete'
  | 'more'
  | 'copy'
  | 'folder'
  | 'trash'
  | 'all'
  | 'inbox'

const PATHS: Readonly<Record<IconName, ReactElement>> = {
  library: (
    <>
      <rect x="2.5" y="3" width="11" height="10" rx="1.5" />
      <path d="M6 3v10" />
    </>
  ),
  save: (
    <>
      <path d="M3.5 2.5h7l2 2v8a1 1 0 0 1-1 1h-8a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1Z" />
      <path d="M5.5 2.5v3h4v-3M5 13.5v-4h6v4" />
    </>
  ),
  optimize: (
    <>
      <path d="M7 2.5 8.2 5.8 11.5 7 8.2 8.2 7 11.5 5.8 8.2 2.5 7l3.3-1.2Z" />
      <path d="M12 10.5v3M10.5 12h3" />
    </>
  ),
  stop: <rect x="4" y="4" width="8" height="8" rx="1.5" />,
  clear: (
    <>
      <path d="m9.5 3 3.5 3.5-6 6H3.5v-3.5Z" />
      <path d="M7 12.5h6.5M6.5 6l3.5 3.5" />
    </>
  ),
  session: <path d="M3 3.5h10a1 1 0 0 1 1 1V10a1 1 0 0 1-1 1H7l-3 2.5V11H3a1 1 0 0 1-1-1V4.5a1 1 0 0 1 1-1Z" />,
  settings: (
    <>
      <circle cx="8" cy="8" r="2" />
      <path d="M8 1.8v1.7M8 12.5v1.7M14.2 8h-1.7M3.5 8H1.8M12.4 3.6l-1.2 1.2M4.8 11.2l-1.2 1.2M12.4 12.4l-1.2-1.2M4.8 4.8 3.6 3.6" />
    </>
  ),
  close: <path d="m4 4 8 8M12 4l-8 8" />,
  open: (
    <>
      <path d="M9 3h4v4M13 3 7.5 8.5" />
      <path d="M11.5 9.5v3a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h3" />
    </>
  ),
  delete: (
    <>
      <path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.1a1 1 0 0 0 1 .9h3.8a1 1 0 0 0 1-.9l.6-8.1" />
    </>
  ),
  more: (
    <>
      <circle cx="3.5" cy="8" r="0.9" />
      <circle cx="8" cy="8" r="0.9" />
      <circle cx="12.5" cy="8" r="0.9" />
    </>
  ),
  copy: (
    <>
      <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
      <path d="M3.5 10.5h-.5a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1h6.5a1 1 0 0 1 1 1v.5" />
    </>
  ),
  folder: <path d="M2 4.5a1 1 0 0 1 1-1h3.2l1.5 1.5H13a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1Z" />,
  trash: (
    <>
      <path d="M3 4.5h10M4.5 4.5l.6 8.1a1 1 0 0 0 1 .9h3.8a1 1 0 0 0 1-.9l.6-8.1" />
      <path d="M6.5 7v4M9.5 7v4" />
    </>
  ),
  all: (
    <>
      <rect x="2.5" y="2.5" width="4.5" height="4.5" rx="1" />
      <rect x="9" y="2.5" width="4.5" height="4.5" rx="1" />
      <rect x="2.5" y="9" width="4.5" height="4.5" rx="1" />
      <rect x="9" y="9" width="4.5" height="4.5" rx="1" />
    </>
  ),
  inbox: (
    <>
      <path d="M2.5 9.5 4 3.5h8l1.5 6v3a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1Z" />
      <path d="M2.5 9.5h3l1 1.5h3l1-1.5h3" />
    </>
  ),
}

export function Icon({ name }: { name: IconName }): ReactElement {
  return (
    <svg className="px-icon" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
      <g fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
        {PATHS[name]}
      </g>
    </svg>
  )
}

/** 收藏星标：黄色图标，配「已收藏」的无障碍文字（需求 5.10）。 */
export function Star({ label }: { label: string }): ReactElement {
  return (
    <svg className="px-star" viewBox="0 0 16 16" width="12" height="12" role="img" aria-label={label}>
      <path d="M8 1.6 9.9 5.6l4.4.6-3.2 3 .8 4.4L8 11.5l-3.9 2.1.8-4.4-3.2-3 4.4-.6Z" />
    </svg>
  )
}

export function Spinner({ label }: { label: string }): ReactElement {
  return (
    <svg className="px-spinner" viewBox="0 0 16 16" width="14" height="14" role="img" aria-label={label}>
      <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.6" strokeDasharray="26 12" strokeLinecap="round" />
    </svg>
  )
}
