// 对话框（需求 5.8，技术方案 5.5）：在小窗内居中，打开时将焦点放到默认按钮或第一个输入框，
// Tab 在对话框里循环，Esc 等于对话框指定的按钮（由窗口级快捷键处理，见 AppController.handleKeydown）。

import { useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactElement } from 'react'
import { isComposingKey } from '../appearance.ts'
import type { DialogState, MetadataForm } from '../state/state.ts'
import { useAppState, useController, useT } from './hooks.ts'

export function DialogHost(): ReactElement | null {
  const dialog = useAppState(state => state.dialog)
  // 每个对话框用自己的 id 做 key：前一个关掉、下一个接着打开时输入框和焦点都重新开始。
  return dialog === null ? null : <Dialog key={dialog.id} dialog={dialog} />
}

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled])'

function Dialog({ dialog }: { dialog: DialogState }): ReactElement {
  const controller = useController()
  const t = useT()
  const titleId = useId()
  const root = useRef<HTMLDivElement>(null)
  const [form, setForm] = useState<MetadataForm | undefined>(dialog.form)
  // 标题为空时禁用表单的提交按钮。
  const blocked = (buttonId: string) => form !== undefined && buttonId === dialog.defaultButton && form.title.trim() === ''
  const resolve = (button: string) => {
    if (blocked(button)) return
    controller.resolveDialog(dialog.id, form === undefined ? { button } : { button, form })
  }

  useLayoutEffect(() => {
    const element = root.current
    if (element === null) return undefined
    const previous = document.activeElement
    const defaultFocused = form === undefined || (dialog.focusDefaultButton === true && !blocked(dialog.defaultButton))
    const target = defaultFocused
      ? element.querySelector<HTMLElement>(`[data-button="${dialog.defaultButton}"]`)
      : element.querySelector<HTMLElement>('input')
    target?.focus()
    return () => {
      // 关闭时焦点还在对话框里（或已经没有焦点）：还给打开前的元素，否则对话框一消失焦点就落到 body 上，
      // 用户得先点一下才能接着打字。关闭后的操作已经把焦点放到别处（例如编辑区）时不抢。
      const active = document.activeElement
      const lost = active === null || active === document.body || element.contains(active)
      if (lost && previous instanceof HTMLElement && previous.isConnected) previous.focus()
    }
    // 依赖故意为空：只在打开时决定一次焦点位置，之后用户自己移动焦点。
  }, [])

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (isComposingKey(event.nativeEvent)) return
    if (event.key === 'Tab') {
      const element = root.current
      if (element === null) return
      const items = [...element.querySelectorAll<HTMLElement>(FOCUSABLE)]
      const first = items.at(0)
      const last = items.at(-1)
      if (first === undefined || last === undefined) return
      const active = document.activeElement
      if (event.shiftKey && (active === first || !element.contains(active))) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && (active === last || !element.contains(active))) {
        event.preventDefault()
        first.focus()
      }
      return
    }
    // 输入框里按 Enter 等于默认按钮。
    if (event.key === 'Enter' && event.target instanceof HTMLInputElement) {
      event.preventDefault()
      resolve(dialog.defaultButton)
    }
  }

  return (
    <div
      className="px-dialog-backdrop"
      // 点背景不让焦点离开对话框。
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) event.preventDefault()
      }}
    >
      <div className="px-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} ref={root} onKeyDown={onKeyDown}>
        <h2 className="px-dialog-title" id={titleId}>{dialog.title}</h2>
        {dialog.message === undefined ? null : <p className="px-dialog-message">{dialog.message}</p>}
        {form === undefined
          ? null
          : (
            <div className="px-dialog-form">
              <label className="px-field">
                <span className="px-field-label">{t('dialog.rename.titleField')}</span>
                <input
                  className="px-input"
                  value={form.title}
                  spellCheck={false}
                  onChange={(event) => {
                    setForm({ ...form, title: event.target.value })
                  }}
                />
              </label>
              <label className="px-field">
                <span className="px-field-label">{t('dialog.rename.tagsField')}</span>
                <input
                  className="px-input"
                  value={form.tags}
                  spellCheck={false}
                  onChange={(event) => {
                    setForm({ ...form, tags: event.target.value })
                  }}
                />
                <span className="px-field-hint">{t('dialog.rename.tagsHint')}</span>
              </label>
            </div>
          )}
        {dialog.error === undefined ? null : <p className="px-dialog-error" role="alert">{dialog.error}</p>}
        <div className="px-dialog-buttons">
          {dialog.buttons.map(button => (
            <button
              key={button.id}
              type="button"
              data-button={button.id}
              className={`px-button${button.tone === undefined ? '' : ` px-button-${button.tone}`}`}
              disabled={blocked(button.id)}
              onClick={() => {
                resolve(button.id)
              }}
            >
              {button.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
