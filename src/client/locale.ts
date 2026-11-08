// 配置页的文案。按 design-spec 8.1 注册到 dsh locale 服务的 `promptx` 命名空间（需求 7.10：命名都带 promptx 前缀），
// 组件从 dsh 注入的 `t` 取文案，跟着 dsh 的界面语言即时切换（需求 S-03）。
// 中文以需求和技术方案里写的原文为准（如「小窗正在准备」「另一个 dsh 进程已在为这个 profile 运行 PromptX」），英文是同样含义的翻译。
// 两份字典的键和 `{name}` 占位符必须一致，测试会逐项核对。

import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type { ConfigFieldError, ErrorInfo } from '../shared/types.ts'

/** dsh locale 服务里本插件的命名空间。 */
export const LOCALE_NS = 'promptx'

export const zh = {
  summary: 'PromptX 小窗、Prompt 库和优化的设置。',
  loading: '正在读取 PromptX 的状态…',
  loadFailed: '连不上 PromptX 插件（{reason}），正在重试…',
  reconnecting: '和 PromptX 插件的连接断了，正在重连；下面显示的可能不是最新状态。',
  duplicateInstance: '另一个 dsh 进程已在为这个 profile 运行 PromptX。这个进程不启动小窗，也不读写草稿；要改设置，请到那个 dsh 里修改，或者先退出它，再重启这个 dsh。',

  sectionWindow: '小窗',
  sectionLibrary: 'Prompt 库',
  sectionOptimize: '优化',

  statusLabel: '状态',
  companionRunning: '运行中',
  companionStarting: '正在启动',
  companionWaitingRuntime: '小窗正在准备',
  companionRestarting: '正在重启',
  companionStopped: '已停止',
  companionFailed: '没能启动',
  shortcutActive: '全局快捷键 {shortcut} 已生效',
  shortcutWarning: '全局快捷键 {shortcut} 已登记，{reason}',
  shortcutFailed: '全局快捷键 {shortcut} 没有生效：{reason}',
  shortcutOff: '没有设置全局快捷键',
  shortcutPending: '全局快捷键 {shortcut} 还没有登记',
  shortcutFallback: '新组合 {shortcut} 登记失败（{reason}），仍使用 {active}',
  runtimeVersionPart: '运行时 {version}',
  pidHint: '小窗进程号：{pid}',
  companionFailedReason: '小窗没能启动：{reason}',
  companionLastError: '上次退出的原因：{reason}',
  rendererReloading: '小窗界面崩溃了，正在重新加载',
  restartsExhausted: '30 秒内连续失败了 3 次，已停止自动重启。',
  restartCompanion: '重启小窗',
  showCompanion: '显示小窗',

  runtimeLabel: '运行时',
  runtimeReady: '已下载 · Electron {version}',
  runtimeMissing: '还没有下载 Electron {version}',
  runtimePaused: '已删除运行时，自动下载已暂停；点「下载」可以重新下载。',
  runtimeDownloading: '正在下载 Electron {version}',
  runtimeBytes: '{received} / {total}（{percent}%）',
  runtimeBytesUnknown: '已下载 {received}',
  runtimeWaitingOther: '另一个 dsh 进程正在下载运行时，下载完成后这里直接使用。',
  runtimeExtracting: '正在解压 Electron {version}',
  runtimeFailed: '运行时下载没有完成：{reason}',
  runtimeUnsupported: '这台电脑的系统或处理器不在支持范围内，小窗不能使用。',
  runtimeDir: '运行时目录：{dir}',
  runtimeProgressLabel: '运行时下载进度',
  download: '下载',
  retry: '重试',
  deleteRuntime: '删除运行时',
  deleteRuntimeConfirm: '删除后小窗会停止，也不再自动下载，直到你点「下载」或下次启动插件。',
  deleteRuntimeConfirmButton: '删除',
  cancel: '取消',
  runtimeInUse: '下面的版本正被其他 profile 使用，没有删除：{list}',
  runtimeInUseItem: '{version}（profile {profile}）',
  listSeparator: '、',
  sourceMirror: '国内镜像',
  sourceOfficial: '官方源',

  runtimeSourceLabel: '下载源',
  runtimeSourceAuto: '自动（先用国内镜像，失败时换官方源）',
  runtimeSourceMirror: '只用国内镜像',
  runtimeSourceOfficial: '只用官方源（GitHub）',
  runtimeSourceHint: '从下一次下载开始生效。',

  shortcutLabel: '全局快捷键',
  shortcutPlaceholder: '留空表示不用全局快捷键',
  shortcutHint: '在任何应用里呼出或隐藏小窗，默认 {default}。留空时只能从菜单栏图标打开小窗。',
  shortcutRecording: '请按下新的组合键，按 Esc 取消。',
  shortcutPreview: '显示为 {shortcut}',
  record: '录制',
  recording: '正在录制…',
  fixedShortcutsNote: '小窗里的其他快捷键暂时固定，不能修改。',

  hideOnBlurLabel: '失焦时隐藏',
  hideOnBlurHint: '切到别的应用时自动隐藏小窗；拖动或缩放小窗不算切走。',

  libraryDirLabel: '库目录',
  libraryDirHint: '写绝对路径，或以 ~ 开头的路径；留空使用默认位置。保存后小窗的库侧栏直接换成新目录。',
  confirmDeleteLabel: '删除前确认',
  confirmDeleteHint: '把 Prompt 移进回收站之前先确认。',

  instructionLabel: '优化指令',
  instructionHint: '留空时使用默认指令。改动只影响之后开始的优化。',
  restoreDefaultInstruction: '恢复默认指令',

  save: '保存',
  saving: '保存中…',
  saveFailedFields: '有设置没有通过检查，改动已保留，改好后再保存。',
  saveFailed: '没有保存成功：{reason}。改动已保留，可以再试一次。',
  actionFailed: '操作没有完成：{reason}',

  fieldLibraryDirRelative: '库目录要写绝对路径，或以 ~ 开头。',
  fieldLibraryDirReserved: '库目录不能放在 dsh 的数据目录里（默认的 promptx/library 除外）。',
  fieldLibraryDirSkills: '库目录不能放在 dsh 的技能目录里，否则里面的 Prompt 会被当成技能读取。',
  fieldShortcutInvalid: '快捷键写法不对：至少要有一个修饰键，且不能只有 Shift；主键可以是字母、数字、F1–F24、空格、方向键或常见标点。',
  fieldValueInvalid: '这个值不能用。',

  errRuntimeUnsupported: '这个平台不受支持',
  errDownloadFailed: '下载失败，请检查网络',
  errChecksumMismatch: '下载的文件没有通过校验',
  errDiskSpace: '磁盘空间不足，需要约 600 MB',
  errExtractFailed: '解压失败',
  errUnzipMissing: '系统里没有 unzip，请先安装',
  errRuntimeLocked: '另一个 dsh 进程正在下载运行时',
  errRuntimeInUse: '运行时的文件正在使用，没能全部删除',
  errSizeMismatch: '下载的文件大小不对',
  errSpawnFailed: '进程启动失败',
  errHandshakeTimeout: '启动后没有按时响应',
  errProtocolMismatch: '小窗和插件的版本对不上，请重启 dsh',
  errExited: '进程意外退出',
  errHeartbeatLost: '进程没有响应',
  errRendererGone: '小窗界面反复崩溃',
  errShortcutInvalid: '快捷键写法不对',
  errShortcutTaken: '这个组合已被别的应用占用',
  errShortcutHeldByProfile: '已被另一个 profile 的 PromptX 使用',
  errShortcutSystemConflict: '可能与系统快捷键冲突',
  errSettingsUnavailable: 'dsh 的设置服务暂时不可用',
  errInstanceDuplicate: '另一个 dsh 进程已在为这个 profile 运行 PromptX',
  errChannelClosed: '连接断开了',
  errChannelTimeout: '请求超时',
  errInternal: '内部错误',
  errUnknown: '错误 {code}',
  errWithDetail: '{message}（{detail}）',
}

/** `promptx` 命名空间的全部键。 */
export type PromptxLocaleKey = keyof typeof zh

export const en: Record<PromptxLocaleKey, string> = {
  summary: 'Settings for the PromptX window, prompt library, and optimization.',
  loading: 'Reading the PromptX status…',
  loadFailed: 'Cannot reach the PromptX plugin ({reason}). Retrying…',
  reconnecting: 'Lost the connection to the PromptX plugin; reconnecting. The status below may be out of date.',
  duplicateInstance: 'Another dsh process is already running PromptX for this profile. This process does not start the PromptX window or touch the draft. Change the settings in that dsh, or quit it and restart this one.',

  sectionWindow: 'PromptX window',
  sectionLibrary: 'Prompt library',
  sectionOptimize: 'Optimization',

  statusLabel: 'Status',
  companionRunning: 'Running',
  companionStarting: 'Starting',
  companionWaitingRuntime: 'The window is getting ready',
  companionRestarting: 'Restarting',
  companionStopped: 'Stopped',
  companionFailed: 'Could not start',
  shortcutActive: 'Global shortcut {shortcut} is active',
  shortcutWarning: 'Global shortcut {shortcut} is registered. {reason}',
  shortcutFailed: 'Global shortcut {shortcut} is not active: {reason}',
  shortcutOff: 'No global shortcut set',
  shortcutPending: 'Global shortcut {shortcut} is not registered yet',
  shortcutFallback: 'Could not register {shortcut} ({reason}); still using {active}',
  runtimeVersionPart: 'Runtime {version}',
  pidHint: 'Window process ID: {pid}',
  companionFailedReason: 'The PromptX window could not start: {reason}',
  companionLastError: 'Last exit reason: {reason}',
  rendererReloading: 'The window crashed and is reloading',
  restartsExhausted: 'It failed 3 times within 30 seconds, so automatic restarts have stopped.',
  restartCompanion: 'Restart window',
  showCompanion: 'Show window',

  runtimeLabel: 'Runtime',
  runtimeReady: 'Downloaded · Electron {version}',
  runtimeMissing: 'Electron {version} is not downloaded yet',
  runtimePaused: 'The runtime was deleted and automatic download is paused. Click Download to get it again.',
  runtimeDownloading: 'Downloading Electron {version}',
  runtimeBytes: '{received} of {total} ({percent}%)',
  runtimeBytesUnknown: '{received} downloaded',
  runtimeWaitingOther: 'Another dsh process is downloading the runtime; it will be used here once the download finishes.',
  runtimeExtracting: 'Extracting Electron {version}',
  runtimeFailed: 'The runtime download did not finish: {reason}',
  runtimeUnsupported: 'This computer\'s operating system or processor is not supported, so the PromptX window cannot run.',
  runtimeDir: 'Runtime folder: {dir}',
  runtimeProgressLabel: 'Runtime download progress',
  download: 'Download',
  retry: 'Retry',
  deleteRuntime: 'Delete runtime',
  deleteRuntimeConfirm: 'Deleting stops the PromptX window and pauses automatic download until you click Download or the plugin starts again.',
  deleteRuntimeConfirmButton: 'Delete',
  cancel: 'Cancel',
  runtimeInUse: 'These versions are in use by other profiles and were not deleted: {list}',
  runtimeInUseItem: '{version} (profile {profile})',
  listSeparator: ', ',
  sourceMirror: 'China mirror',
  sourceOfficial: 'Official source',

  runtimeSourceLabel: 'Download source',
  runtimeSourceAuto: 'Automatic (China mirror first, then the official source)',
  runtimeSourceMirror: 'China mirror only',
  runtimeSourceOfficial: 'Official source (GitHub) only',
  runtimeSourceHint: 'Applies from the next download.',

  shortcutLabel: 'Global shortcut',
  shortcutPlaceholder: 'Leave empty for no global shortcut',
  shortcutHint: 'Shows or hides the PromptX window from any app. The default is {default}. When empty, open the window from the menu bar icon.',
  shortcutRecording: 'Press the new key combination, or Esc to cancel.',
  shortcutPreview: 'Shown as {shortcut}',
  record: 'Record',
  recording: 'Recording…',
  fixedShortcutsNote: 'The other shortcuts inside the PromptX window are fixed for now.',

  hideOnBlurLabel: 'Hide when inactive',
  hideOnBlurHint: 'Hide the PromptX window when you switch to another app. Moving or resizing the window does not count.',

  libraryDirLabel: 'Library folder',
  libraryDirHint: 'An absolute path, or one starting with ~. Leave empty for the default location. After saving, the library sidebar in the window shows the new folder.',
  confirmDeleteLabel: 'Confirm before deleting',
  confirmDeleteHint: 'Ask before moving a prompt to the trash.',

  instructionLabel: 'Optimization instruction',
  instructionHint: 'Leave empty to use the default instruction. Changes apply to optimizations started afterwards.',
  restoreDefaultInstruction: 'Restore default instruction',

  save: 'Save',
  saving: 'Saving…',
  saveFailedFields: 'Some settings did not pass the checks. Your changes are kept; correct them and save again.',
  saveFailed: 'Could not save: {reason}. Your changes are kept; try again.',
  actionFailed: 'The action did not complete: {reason}',

  fieldLibraryDirRelative: 'Use an absolute path, or one starting with ~.',
  fieldLibraryDirReserved: 'The library cannot be inside the dsh data folder, except the default promptx/library.',
  fieldLibraryDirSkills: 'The library cannot be inside a dsh skills folder, or its prompts would be read as skills.',
  fieldShortcutInvalid: 'Invalid shortcut: use at least one modifier, not Shift alone, and a letter, digit, F1–F24, Space, arrow key, or common punctuation as the key.',
  fieldValueInvalid: 'This value is not accepted.',

  errRuntimeUnsupported: 'This platform is not supported',
  errDownloadFailed: 'The download failed; check the network',
  errChecksumMismatch: 'The downloaded file failed verification',
  errDiskSpace: 'Not enough disk space; about 600 MB is needed',
  errExtractFailed: 'Could not extract the runtime',
  errUnzipMissing: 'unzip is not installed; install it first',
  errRuntimeLocked: 'Another dsh process is downloading the runtime',
  errRuntimeInUse: 'Some runtime files are in use and could not be deleted',
  errSizeMismatch: 'The downloaded file has the wrong size',
  errSpawnFailed: 'The process could not start',
  errHandshakeTimeout: 'It did not respond in time after starting',
  errProtocolMismatch: 'The window and plugin versions do not match; restart dsh',
  errExited: 'The process exited unexpectedly',
  errHeartbeatLost: 'The process stopped responding',
  errRendererGone: 'The window interface kept crashing',
  errShortcutInvalid: 'The shortcut is not valid',
  errShortcutTaken: 'Another app already uses this combination',
  errShortcutHeldByProfile: 'Already used by PromptX in another profile',
  errShortcutSystemConflict: 'May conflict with a system shortcut',
  errSettingsUnavailable: 'The dsh settings service is not available right now',
  errInstanceDuplicate: 'Another dsh process is already running PromptX for this profile',
  errChannelClosed: 'The connection was lost',
  errChannelTimeout: 'The request timed out',
  errInternal: 'Internal error',
  errUnknown: 'Error {code}',
  errWithDetail: '{message} ({detail})',
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** PromptX 配置页的文案。 */
    promptx: PromptxLocaleKey
  }
}

/**
 * 配置页用到的翻译函数：dsh 注入的 `t`（`TranslateNS<'promptx'>`）可以直接当它用。
 * 单独写出这个窄类型，是为了让组件和测试不依赖 dsh 的运行时，只依赖键名。
 */
export type PromptxTranslate = (key: PromptxLocaleKey, params?: Record<string, unknown>) => string

/** Host 和小程序的错误码 → 文案键（错误码见 shared/errors.ts）。没有列出的显示「错误 {code}」。 */
const ERROR_KEYS: ReadonlyMap<string, PromptxLocaleKey> = new Map<string, PromptxLocaleKey>([
  ['promptx/runtime/unsupported', 'errRuntimeUnsupported'],
  ['promptx/runtime/download-failed', 'errDownloadFailed'],
  ['promptx/runtime/checksum-mismatch', 'errChecksumMismatch'],
  ['promptx/runtime/disk-space', 'errDiskSpace'],
  ['promptx/runtime/extract-failed', 'errExtractFailed'],
  ['promptx/runtime/unzip-missing', 'errUnzipMissing'],
  ['promptx/runtime/locked', 'errRuntimeLocked'],
  ['promptx/runtime/in-use', 'errRuntimeInUse'],
  ['promptx/runtime/size-mismatch', 'errSizeMismatch'],
  ['promptx/companion/spawn-failed', 'errSpawnFailed'],
  ['promptx/companion/handshake-timeout', 'errHandshakeTimeout'],
  ['promptx/companion/protocol-mismatch', 'errProtocolMismatch'],
  ['promptx/companion/exited', 'errExited'],
  ['promptx/companion/heartbeat-lost', 'errHeartbeatLost'],
  ['promptx/companion/renderer-gone', 'errRendererGone'],
  ['promptx/shortcut/invalid', 'errShortcutInvalid'],
  ['promptx/shortcut/taken', 'errShortcutTaken'],
  ['promptx/shortcut/held-by-profile', 'errShortcutHeldByProfile'],
  ['promptx/shortcut/system-conflict', 'errShortcutSystemConflict'],
  ['promptx/settings/unavailable', 'errSettingsUnavailable'],
  ['promptx/instance/duplicate', 'errInstanceDuplicate'],
  ['promptx/channel/closed', 'errChannelClosed'],
  ['promptx/channel/timeout', 'errChannelTimeout'],
  ['promptx/internal', 'errInternal'],
])

/**
 * 错误的显示文案。detail 是系统错误信息或 profile 名之类的补充（按约定不含用户内容），有就跟在后面，
 * 例如「已被另一个 profile 的 PromptX 使用（work）」「下载失败，请检查网络（ECONNRESET）」。
 */
export function errorText(t: PromptxTranslate, info: ErrorInfo): string {
  const key = ERROR_KEYS.get(info.code)
  const message = key === undefined ? t('errUnknown', { code: info.code }) : t(key)
  const detail = info.detail?.trim() ?? ''
  return detail === '' ? message : t('errWithDetail', { message, detail })
}

const FIELD_ERROR_KEYS: Readonly<Record<ConfigFieldError, PromptxLocaleKey>> = {
  'library-dir-relative': 'fieldLibraryDirRelative',
  'library-dir-reserved': 'fieldLibraryDirReserved',
  'library-dir-skills': 'fieldLibraryDirSkills',
  'shortcut-invalid': 'fieldShortcutInvalid',
  'value-invalid': 'fieldValueInvalid',
}

/** 字段级错误（Host 校验结果或页面自己的检查）的文案。 */
export function fieldErrorText(t: PromptxTranslate, error: ConfigFieldError): string {
  return t(FIELD_ERROR_KEYS[error])
}
