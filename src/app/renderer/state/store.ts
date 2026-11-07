// 小窗界面的状态容器（技术方案 5.5）：一个可订阅的不可变状态，React 组件经 useSyncExternalStore 读取。
// 不引入第三方状态库（产品红线 5）；每次更新替换被改动的那一片，组件按片选择，没变的片引用不变，不会重渲染。

export type Listener = () => void

// 写成函数属性而不是方法：useSyncExternalStore 直接拿走 subscribe、getState，它们不依赖 this。
export interface Store<S> {
  getState: () => S
  /** 用函数算出新状态；返回同一个对象时不通知订阅者。 */
  update: (updater: (state: S) => S) => void
  subscribe: (listener: Listener) => () => void
}

export function createStore<S>(initial: S): Store<S> {
  let state = initial
  const listeners = new Set<Listener>()
  return {
    getState: () => state,
    update(updater) {
      const next = updater(state)
      if (Object.is(next, state)) return
      state = next
      // 复制一份再遍历：通知过程中有组件取消订阅时不影响这一轮。
      for (const listener of [...listeners]) listener()
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}
