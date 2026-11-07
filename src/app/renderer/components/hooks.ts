// 组件读状态、取文案、拿焦点用的几个 hook。

import { createContext, useCallback, useContext, useEffect, useSyncExternalStore, type RefObject } from 'react'
import { translate, type MessageKey, type MessageParams } from '../../../shared/i18n/index.ts'
import type { AppController } from '../controller/app.ts'
import type { AppState, FocusRequest } from '../state/state.ts'

export const ControllerContext = createContext<AppController | null>(null)

export function useController(): AppController {
  const controller = useContext(ControllerContext)
  if (controller === null) throw new Error('ControllerContext is missing')
  return controller
}

/** 选取状态的一部分。选择函数要返回状态里已有的对象或原始值，不能每次新建对象，否则会反复渲染。 */
export function useAppState<T>(select: (state: AppState) => T): T {
  const { store } = useController()
  return useSyncExternalStore(store.subscribe, () => select(store.getState()))
}

export type Translate = (key: MessageKey, params?: MessageParams) => string

export function useT(): Translate {
  const locale = useAppState(state => state.locale)
  return useCallback((key: MessageKey, params?: MessageParams) => translate(locale, key, params), [locale])
}

/** 响应「把焦点放到某处」的请求（⌘L 后的搜索框、一轮结束后的追加输入框）。 */
export function useFocusTarget(target: FocusRequest['target'], ref: RefObject<HTMLElement | null>): void {
  const controller = useController()
  const focus = useAppState(state => state.focus)
  useEffect(() => {
    if (focus?.target !== target || ref.current === null) return
    if (controller.takeFocus(focus)) ref.current.focus()
  }, [controller, focus, ref, target])
}
