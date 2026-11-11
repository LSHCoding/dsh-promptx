// 小窗主进程与预加载脚本之间的 IPC 通道名，统一写成 promptx:<名称>。
// 这个文件只放常量，只有类型 import：预加载脚本会把它内联进 preload.cjs，
// 而 Electron 45 起沙箱预加载只能 require 'electron'，这里一旦引入别的运行时模块，预加载就加载不了。

import type { BridgeEventName } from '../../shared/bridge.ts'

export const IPC_CHANNELS = {
  // 渲染进程 invoke，主进程 handle（有返回值）
  call: 'promptx:call',
  getConfig: 'promptx:getConfig',
  windowHide: 'promptx:window.hide',
  windowCopyAndHide: 'promptx:window.copyAndHide',
  windowCopyText: 'promptx:window.copyText',
  windowGetBounds: 'promptx:window.getBounds',
  windowSetWidth: 'promptx:window.setWidth',
  windowOpenSettings: 'promptx:window.openSettings',
  prefsGet: 'promptx:prefs.get',
  entryEditorOpen: 'promptx:entryEditor.open',
  entryEditorGetState: 'promptx:entryEditor.getState',
  entryEditorSave: 'promptx:entryEditor.save',
  entryEditorReload: 'promptx:entryEditor.reload',
  entryEditorClose: 'promptx:entryEditor.close',
  entryEditorUpdate: 'promptx:entryEditor.update',
  entryEditorPrepared: 'promptx:entryEditor.prepared',
  // 渲染进程 send，主进程 on（没有返回值）
  ready: 'promptx:ready',
  flushed: 'promptx:flushed',
  e2eDone: 'promptx:e2eDone',
  windowSetMinWidth: 'promptx:window.setMinWidth',
  prefsSet: 'promptx:prefs.set',
  /** 主进程 → 渲染进程：webContents.send(event, 事件名, 载荷)。 */
  event: 'promptx:event',
} as const

/** 用 Record 列出事件名：BridgeEvents 加了事件而这里漏写时编译失败，白名单不会悄悄缺项。 */
const EVENT_FLAGS: Record<BridgeEventName, true> = {
  'entryEditor.state': true,
  'config': true,
  'optimize.event': true,
  'library.changed': true,
  'library.entriesChanged': true,
  'window.shown': true,
  'window.hidden': true,
  'flush': true,
  'e2e': true,
}

/** 渲染进程可以订阅的事件（白名单）。 */
export const BRIDGE_EVENT_NAMES = Object.keys(EVENT_FLAGS) as BridgeEventName[]
