// PromptX 在 dsh 插件页里的配置页（需求 S-01、S-02、S-03、F-05、F-06、5.9、6.6、6.8、7.7、7.8；design-spec 4.4、D12）。
//
// 页面按需求 5.9 的 P0 部分分三节：小窗（状态、运行时、下载源、全局快捷键、失焦时隐藏）、Prompt 库（库目录、删除前确认）、
// 优化（优化指令）。
//
// 保存方式照 dsh 自己的设置表单（dsh-client-ui-primitives 的 SettingsForm，独立审查 COV-02）：改动先暂存，底部一个「保存」
// 一次提交所有改动过的字段；没有改动、有字段不合法、正在保存时「保存」不可用，保存中显示「保存中…」；Host 返回的字段错误显示在
// 对应字段下面，暂存的值保留，并给出提示；离开页面（组件卸载）丢弃没保存的改动；不设「取消」。
// 不能直接用 SettingsForm 组件：AGENTS.md 不允许把 dsh 的 Client 包当模块 require，所以照它的行为自己实现。
//
// 动作类按钮立即执行，不经过暂存：「重启小窗」「显示小窗」「下载 / 重试」「删除运行时」「录制」。

import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent, type ReactNode } from 'react'
import { acceleratorFromKeyEvent, formatAccelerator, parseAccelerator } from '../shared/accelerator.ts'
import { toErrorInfo } from '../shared/errors.ts'
import type {
  CompanionState,
  ConfigFieldError,
  ConfigUpdateResult,
  ErrorInfo,
  PanelStatus,
  PromptxConfig,
  RuntimeSource,
  RuntimeStatus,
} from '../shared/types.ts'
import type { ActionResult, CompanionAction, PromptxApi, RuntimeAction, StatusStore } from './api.ts'
import { Button, clampPercent, ProgressBar, StatusDot, Switch, type DotState } from './controls.tsx'
import {
  baseConfig,
  changedPatch,
  effectiveConfig,
  normalizeShortcut,
  pruneSettled,
  sameConfig,
  validatePatch,
  withField,
  withoutError,
  type AcceptedSave,
  type ConfigField,
  type Draft,
  type FieldErrors,
} from './form.ts'
import { errorText, fieldErrorText, type PromptxTranslate } from './locale.ts'
import { CONFIG_PAGE_CSS } from './styles.ts'

/** 配置页用到的接口：保存配置和几个动作。 */
export type ConfigPageApi = Pick<PromptxApi, 'saveConfig' | 'companion' | 'runtime'>

export interface ConfigPageProps {
  t: PromptxTranslate
  /** 长轮询循环提供的状态，和导航逻辑共用一份。 */
  store: StatusStore
  api: ConfigPageApi
  /** 页面当前的界面语言，用来挑默认优化指令的语言做占位文字（design-spec 4.7：以 zh 开头为中文，其余为英文）。 */
  language: 'zh' | 'en'
}

const SEPARATOR = ' · '

export function ConfigPage({ t, store, api, language }: ConfigPageProps): ReactNode {
  const { status, error } = useSyncExternalStore(store.subscribe, store.getSnapshot)
  let body: ReactNode
  if (status === null) {
    body = (
      <p className="promptx-notice" role="status">
        {error === null ? t('loading') : t('loadFailed', { reason: errorText(t, error) })}
      </p>
    )
  } else if (status.instance === 'duplicate') {
    // 同一个 profile 已有另一个 dsh 进程在运行 PromptX：这个进程不启动小程序、不打开草稿，整页只说明原因（design-spec 4.1）。
    body = <p className="promptx-notice" role="status">{t('duplicateInstance')}</p>
  } else {
    body = <ConfigForm t={t} status={status} api={api} language={language} connectionError={error} />
  }
  return (
    <div className="promptx-config" data-promptx-config="">
      <style>{CONFIG_PAGE_CSS}</style>
      {body}
    </div>
  )
}

function ConfigForm(props: {
  t: PromptxTranslate
  status: PanelStatus
  api: ConfigPageApi
  language: 'zh' | 'en'
  connectionError: ErrorInfo | null
}): ReactNode {
  const { t, status } = props
  const form = useStagedConfig(status.config, status.platform, props.api)
  const actions = useActions(props.api)
  const ids = useId()
  const { values, errors, saving } = form
  return (
    <>
      {props.connectionError === null ? null : <p className="promptx-notice" data-tone="warning" role="status">{t('reconnecting')}</p>}

      <section className="promptx-section" aria-labelledby={`${ids}-window`}>
        <h4 className="promptx-section-title" id={`${ids}-window`}>{t('sectionWindow')}</h4>
        <StatusField t={t} status={status} actions={actions} />
        <RuntimeField t={t} runtime={status.runtime} actions={actions} />
        <RuntimeSourceField
          t={t}
          value={values.runtimeSource}
          error={errors.runtimeSource}
          disabled={saving}
          onChange={(value) => {
            form.stage('runtimeSource', value)
          }}
        />
        <ShortcutField
          t={t}
          value={values.globalShortcut}
          platform={status.platform}
          defaultShortcut={status.defaultShortcut}
          error={errors.globalShortcut}
          disabled={saving}
          onChange={(value) => {
            form.stage('globalShortcut', value)
          }}
        />
        <SwitchField
          t={t}
          label={t('hideOnBlurLabel')}
          hint={t('hideOnBlurHint')}
          checked={values.hideOnBlur}
          error={errors.hideOnBlur}
          disabled={saving}
          onChange={(value) => {
            form.stage('hideOnBlur', value)
          }}
        />
      </section>

      <section className="promptx-section" aria-labelledby={`${ids}-library`}>
        <h4 className="promptx-section-title" id={`${ids}-library`}>{t('sectionLibrary')}</h4>
        <TextField
          t={t}
          label={t('libraryDirLabel')}
          hint={t('libraryDirHint')}
          value={values.libraryDir}
          placeholder={status.effectiveLibraryDir}
          error={errors.libraryDir}
          disabled={saving}
          onChange={(value) => {
            form.stage('libraryDir', value)
          }}
        />
        <SwitchField
          t={t}
          label={t('confirmDeleteLabel')}
          hint={t('confirmDeleteHint')}
          checked={values.confirmDelete}
          error={errors.confirmDelete}
          disabled={saving}
          onChange={(value) => {
            form.stage('confirmDelete', value)
          }}
        />
      </section>

      <section className="promptx-section" aria-labelledby={`${ids}-optimize`}>
        <h4 className="promptx-section-title" id={`${ids}-optimize`}>{t('sectionOptimize')}</h4>
        <InstructionField
          t={t}
          value={values.optimizeInstruction}
          defaultInstruction={status.defaultInstruction[props.language]}
          error={errors.optimizeInstruction}
          disabled={saving}
          onChange={(value) => {
            form.stage('optimizeInstruction', value)
          }}
        />
      </section>

      <p className="promptx-footnote">{t('fixedShortcutsNote')}</p>

      <div className="promptx-footer">
        {form.notice === null ? null : <p className="promptx-footer-notice" role="status">{saveNoticeText(t, form.notice)}</p>}
        <button type="button" className="promptx-save" disabled={!form.canSave} onClick={form.save}>
          {saving ? t('saving') : t('save')}
        </button>
      </div>
    </>
  )
}

// ───────────────────────────── 暂存与保存 ─────────────────────────────

type SaveNotice = { kind: 'fields' } | { kind: 'error'; error: ErrorInfo }

function saveNoticeText(t: PromptxTranslate, notice: SaveNotice): string {
  return notice.kind === 'fields' ? t('saveFailedFields') : t('saveFailed', { reason: errorText(t, notice.error) })
}

interface StagedConfig {
  /** 页面上显示的值：暂存的改动盖在 Host 的当前值上。 */
  readonly values: PromptxConfig
  /** 页面自己查出的错误和 Host 返回的字段错误。 */
  readonly errors: FieldErrors
  readonly saving: boolean
  readonly canSave: boolean
  readonly notice: SaveNotice | null
  readonly stage: <K extends ConfigField>(field: K, value: PromptxConfig[K]) => void
  readonly save: () => void
}

function useStagedConfig(config: PromptxConfig, platform: string, api: ConfigPageApi): StagedConfig {
  const [draft, setDraft] = useState<Draft>({})
  const [accepted, setAccepted] = useState<AcceptedSave | null>(null)
  const [hostErrors, setHostErrors] = useState<FieldErrors>({})
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState<SaveNotice | null>(null)
  const mounted = useMountedRef()

  // 比较改动、显示字段用的基准：Host 的配置，刚保存成功而 Host 的新配置还没经长轮询到达时盖上刚保存的值（form.ts 的 baseConfig）。
  const base = useMemo(() => baseConfig(config, accepted), [config, accepted])

  // Host 报来的配置和保存时不同了：刚保存的值已经反映进来（或者又被别处改了），从此以 Host 为准。
  // 这层覆盖要当场丢掉，不能只是暂时不生效：配置以后改回保存前的样子时，它不能又冒出来。
  useEffect(() => {
    if (accepted !== null && !sameConfig(accepted.base, config)) setAccepted(null)
  }, [accepted, config])

  // 基准变了（Host 的配置更新了，或者刚保存成功），去掉已经和它相同的暂存项（form.ts 的 pruneSettled）。
  useEffect(() => {
    setDraft(current => pruneSettled(current, base))
  }, [base])

  const patch = changedPatch(base, draft)
  const errors: FieldErrors = { ...hostErrors, ...validatePatch(patch, platform) }
  const canSave = !saving && Object.keys(patch).length > 0 && Object.keys(errors).length === 0

  const stage = <K extends ConfigField>(field: K, value: PromptxConfig[K]): void => {
    setDraft(current => withField(current, field, value))
    // Host 报的错针对的是提交时的值，用户改了这个字段，旧错误就不再成立。
    setHostErrors(current => withoutError(current, field))
    setNotice(null)
  }

  const save = (): void => {
    if (!canSave) return
    // 提交时的 Host 配置和已经保存过、还没落定的值：成功后据此显示，直到 Host 的新配置到达。
    const configAtSave = config
    const pending = accepted !== null && sameConfig(accepted.base, config) ? accepted.values : {}
    // 提交规范化后的值（快捷键规范写法、库目录去空白），输入框也换成它，失败时保留的就是提交的值。
    setDraft(current => ({ ...current, ...patch }))
    setSaving(true)
    setNotice(null)
    const settle = (result: ConfigUpdateResult): void => {
      if (!mounted.current) return
      setSaving(false)
      if (result.ok) {
        setHostErrors({})
        setAccepted({ base: configAtSave, values: { ...pending, ...patch } })
        return
      }
      // 保存失败：暂存的值原样保留，字段错误显示在对应字段下，底部给出提示。
      setHostErrors(result.errors)
      if (Object.keys(result.errors).length > 0) setNotice({ kind: 'fields' })
      else setNotice({ kind: 'error', error: result.error ?? { code: 'promptx/internal' } })
    }
    requestSave(api, patch).then(settle, (error: unknown) => {
      settle({ ok: false, errors: {}, error: toErrorInfo(error) })
    })
  }

  return { values: effectiveConfig(base, draft), errors, saving, canSave, notice, stage, save }
}

/** api.ts 的保存请求不会抛异常（网络错误也转成结果）；这里再兜一层，换成别的实现时同步抛错也走失败分支，「保存中…」不会卡住。 */
function requestSave(api: ConfigPageApi, patch: Draft): Promise<ConfigUpdateResult> {
  try {
    return api.saveConfig(patch)
  } catch (error) {
    return Promise.resolve({ ok: false, errors: {}, error: toErrorInfo(error) })
  }
}

function useMountedRef(): { readonly current: boolean } {
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  return mounted
}

// ───────────────────────────── 动作 ─────────────────────────────

type ActionName = CompanionAction | RuntimeAction

interface Actions {
  /** 正在执行的动作；同一时间只执行一个，期间其他动作按钮不可用。 */
  readonly busy: ActionName | null
  readonly failure: { action: ActionName; error: ErrorInfo } | null
  /** 最近一次「删除运行时」的结果，用来显示没有删除的版本。 */
  readonly lastDelete: ActionResult | null
  readonly run: (action: ActionName) => void
}

function useActions(api: ConfigPageApi): Actions {
  const [busy, setBusy] = useState<ActionName | null>(null)
  const [failure, setFailure] = useState<Actions['failure']>(null)
  const [lastDelete, setLastDelete] = useState<ActionResult | null>(null)
  const mounted = useMountedRef()

  const run = (action: ActionName): void => {
    if (busy !== null) return
    setBusy(action)
    setFailure(null)
    const settle = (result: ActionResult): void => {
      if (!mounted.current) return
      setBusy(null)
      if (action === 'delete') setLastDelete(result)
      if (!result.ok) setFailure({ action, error: result.error ?? { code: 'promptx/internal' } })
    }
    let task: Promise<ActionResult>
    try {
      task = action === 'restart' || action === 'show' ? api.companion(action) : api.runtime(action)
    } catch (error) {
      task = Promise.resolve({ ok: false, error: toErrorInfo(error) })
    }
    task.then(settle, (error: unknown) => {
      settle({ ok: false, error: toErrorInfo(error) })
    })
  }

  return { busy, failure, lastDelete, run }
}

function ActionFailure({ t, actions, of }: { t: PromptxTranslate; actions: Actions; of: readonly ActionName[] }): ReactNode {
  const failure = actions.failure
  if (failure === null || !of.includes(failure.action)) return null
  return <p className="promptx-error" role="status">{t('actionFailed', { reason: errorText(t, failure.error) })}</p>
}

// ───────────────────────────── 小窗状态 ─────────────────────────────

function companionStateText(t: PromptxTranslate, state: CompanionState): string {
  switch (state) {
    case 'running': return t('companionRunning')
    case 'starting': return t('companionStarting')
    case 'waiting-runtime': return t('companionWaitingRuntime')
    case 'restarting': return t('companionRestarting')
    case 'stopped': return t('companionStopped')
    case 'failed': return t('companionFailed')
  }
}

/**
 * 全局快捷键的状态说明，按需求 5.11 的写法：「全局快捷键 ⌃P 已生效」，没生效或可能冲突时写原因（F-01、F-05）。
 *
 * 小程序上报的 accelerator 是它实际登记着的组合，可能和配置不同（design-spec 5.4）：
 * - 带着警告或错误：新组合登记失败，退回了旧组合，写「新组合 X 登记失败，仍使用 Y」；
 * - 什么都没带：小程序还没处理刚保存的新组合（配置经长轮询先到了），写「还没有登记」，不能说成已生效或失败。
 */
function describeShortcut(t: PromptxTranslate, status: PanelStatus): { text: string; warning: boolean } {
  const configured = normalizeShortcut(status.config.globalShortcut)
  if (configured === '') return { text: t('shortcutOff'), warning: false }
  const requested = formatAccelerator(configured, status.platform)
  const shortcut = status.shortcut
  // 小程序刚启动、还没上报登记结果。
  if (shortcut === null) return { text: t('shortcutPending', { shortcut: requested }), warning: false }
  const current = normalizeShortcut(shortcut.accelerator)
  const caution = shortcut.registered ? shortcut.warning ?? shortcut.error : shortcut.error
  if (current !== configured) {
    if (!shortcut.registered || caution === undefined || caution.code === 'promptx/shortcut/system-conflict') {
      return { text: t('shortcutPending', { shortcut: requested }), warning: false }
    }
    const active = formatAccelerator(current, status.platform)
    return { text: t('shortcutFallback', { shortcut: requested, active, reason: cautionText(t, caution, configured) }), warning: true }
  }
  if (!shortcut.registered) {
    const reason = caution === undefined ? t('errInternal') : errorText(t, caution)
    return { text: t('shortcutFailed', { shortcut: requested, reason }), warning: true }
  }
  // 登记成功但有提醒：可能与系统快捷键冲突（macOS 的登记不独占，design-spec 5.4）。
  if (caution !== undefined) return { text: t('shortcutWarning', { shortcut: requested, reason: errorText(t, caution) }), warning: true }
  return { text: t('shortcutActive', { shortcut: requested }), warning: false }
}

/**
 * 退回旧组合时的原因。小程序把没登记上的新组合写在 detail 里（src/app/main/shortcut-manager.ts），
 * 文案里已经写了新组合，detail 再跟一遍只是重复，这种时候只写原因本身。
 */
function cautionText(t: PromptxTranslate, caution: ErrorInfo, requested: string): string {
  const detail = caution.detail?.trim() ?? ''
  if (detail !== '' && normalizeShortcut(detail) === requested) return errorText(t, { code: caution.code })
  return errorText(t, caution)
}

/**
 * 状态行：「运行中 · 全局快捷键 ⌃P 已生效 · 运行时 44.10.2」（需求 5.9、5.11，F-05 的状态说明含运行时版本）。
 * 运行时版本只在运行时就绪时写：还没下载、已删除时写版本号像是在说它已经装好了，那一行的情况由下面的「运行时」说明。
 */
function describeStatus(t: PromptxTranslate, status: PanelStatus): { tone: DotState; text: string } {
  const { companion, runtime } = status
  const parts = [companionStateText(t, companion.state)]
  let tone: DotState
  switch (companion.state) {
    case 'running': {
      const shortcut = describeShortcut(t, status)
      parts.push(shortcut.text)
      tone = shortcut.warning ? 'warning' : 'done'
      break
    }
    case 'failed':
      tone = 'error'
      break
    case 'stopped':
      tone = 'idle'
      break
    case 'waiting-runtime':
    case 'starting':
    case 'restarting':
      // 运行时下载失败或平台不支持时，「正在准备」不会自己好起来，不显示成进行中。
      tone = runtime.state === 'failed' || runtime.state === 'unsupported' ? 'warning' : 'ongoing'
      break
  }
  if (runtime.state === 'ready' && runtime.version !== '') parts.push(t('runtimeVersionPart', { version: runtime.version }))
  return { tone, text: parts.join(SEPARATOR) }
}

function StatusField({ t, status, actions }: { t: PromptxTranslate; status: PanelStatus; actions: Actions }): ReactNode {
  const { companion, runtime } = status
  const summary = describeStatus(t, status)
  // 平台不支持、或运行时已删除（自动下载暂停）时重启起不来：后者由「运行时」那一行的「下载」恢复（design-spec 5.1「删除」）。
  const cannotRestart = runtime.state === 'unsupported' || (runtime.state === 'missing' && runtime.paused === true)
  return (
    <div className="promptx-field" data-promptx-field="status">
      <div className="promptx-field-head">
        <span className="promptx-label">{t('statusLabel')}</span>
        <span className="promptx-actions">
          <Button
            disabled={actions.busy !== null || companion.state !== 'running'}
            onClick={() => {
              actions.run('show')
            }}
          >
            {t('showCompanion')}
          </Button>
          <Button
            disabled={actions.busy !== null || cannotRestart}
            onClick={() => {
              actions.run('restart')
            }}
          >
            {t('restartCompanion')}
          </Button>
        </span>
      </div>
      <p className="promptx-status-line" data-promptx-status="">
        <StatusDot state={summary.tone} />
        <span>{summary.text}</span>
      </p>
      {companion.state === 'failed'
        ? (
          // 30 秒内连续失败 3 次后小程序进程已经不在，菜单栏图标也没了，原因和「重启小窗」只能在这里看到（design-spec 5.2、第 13 节）。
          <div className="promptx-panel" role="alert">
            <p className="promptx-error">
              {t('companionFailedReason', { reason: companion.error === undefined ? t('errInternal') : errorText(t, companion.error) })}
            </p>
            {companion.restartsExhausted === true ? <p className="promptx-hint">{t('restartsExhausted')}</p> : null}
          </div>
        )
        : null}
      {/* 自动重启期间写上次退出的原因：连续失败时用户能先看到在发生什么，不用等到 failed（F-06）。 */}
      {companion.state === 'restarting' && companion.error !== undefined
        ? <p className="promptx-hint">{t('companionLastError', { reason: errorText(t, companion.error) })}</p>
        : null}
      {status.companionPid === undefined ? null : <p className="promptx-hint">{t('pidHint', { pid: status.companionPid })}</p>}
      <ActionFailure t={t} actions={actions} of={['show', 'restart']} />
    </div>
  )
}

// ───────────────────────────── 运行时 ─────────────────────────────

function runtimeText(t: PromptxTranslate, runtime: RuntimeStatus): string {
  switch (runtime.state) {
    case 'unsupported': return t('runtimeUnsupported')
    case 'missing': return runtime.paused === true ? t('runtimePaused') : t('runtimeMissing', { version: runtime.version })
    case 'downloading': return t('runtimeDownloading', { version: runtime.version })
    case 'extracting': return t('runtimeExtracting', { version: runtime.version })
    case 'ready': return t('runtimeReady', { version: runtime.version })
    case 'failed': return t('runtimeFailed', { reason: runtime.error === undefined ? t('errInternal') : errorText(t, runtime.error) })
  }
}

function runtimeTone(runtime: RuntimeStatus): DotState {
  switch (runtime.state) {
    case 'ready': return 'done'
    case 'downloading':
    case 'extracting': return 'ongoing'
    case 'failed': return 'error'
    case 'missing': return runtime.paused === true ? 'idle' : 'warning'
    case 'unsupported': return 'idle'
  }
}

function formatMegabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * 下载进度：「45.2 MB / 112.3 MB（40%）· 国内镜像」；总大小不知道时只写已下载的量。
 * 状态是下载中却没有已下载的字节数，表示本进程在等另一个 dsh 进程（别的 profile）下完：下载锁在它手里，
 * 这边没有进度可报（design-spec 5.1「下载锁」；src/companion/runtime.ts 等锁时就是这样上报的）。
 */
function progressText(t: PromptxTranslate, runtime: RuntimeStatus): string {
  const received = runtime.received
  if (received === undefined) return t('runtimeWaitingOther')
  const total = runtime.total
  const bytes = total !== undefined && total > 0
    ? t('runtimeBytes', { received: formatMegabytes(received), total: formatMegabytes(total), percent: clampPercent(received, total) })
    : t('runtimeBytesUnknown', { received: formatMegabytes(received) })
  if (runtime.source === undefined) return bytes
  return `${bytes}${SEPARATOR}${t(runtime.source === 'mirror' ? 'sourceMirror' : 'sourceOfficial')}`
}

function RuntimeField({ t, runtime, actions }: { t: PromptxTranslate; runtime: RuntimeStatus; actions: Actions }): ReactNode {
  const id = useId()
  const [confirming, setConfirming] = useState(false)
  const deleteButton = useRef<HTMLButtonElement>(null)
  const busy = actions.busy !== null
  const canDelete = runtime.state === 'ready' || runtime.state === 'failed'
  // 被其他 profile 用着的版本：Host 的状态里有就以它为准，否则用这次删除请求的回复（design-spec 5.1「删除」）。
  const inUseBy = runtime.inUseBy ?? actions.lastDelete?.inUseBy ?? []

  // 运行时进入不能删除的状态（开始下载、已删除）时收起确认，免得之后回到可删除状态时确认框又自己冒出来。
  useEffect(() => {
    if (!canDelete) setConfirming(false)
  }, [canDelete])

  const cancel = (): void => {
    setConfirming(false)
    deleteButton.current?.focus()
  }

  return (
    <div className="promptx-field" data-promptx-field="runtime">
      <div className="promptx-field-head">
        <span className="promptx-label">{t('runtimeLabel')}</span>
        <span className="promptx-actions">
          {runtime.state === 'missing'
            ? (
              <Button
                disabled={busy}
                onClick={() => {
                  actions.run('download')
                }}
              >
                {t('download')}
              </Button>
            )
            : null}
          {runtime.state === 'failed'
            ? (
              <Button
                disabled={busy}
                onClick={() => {
                  actions.run('download')
                }}
              >
                {t('retry')}
              </Button>
            )
            : null}
          {canDelete
            ? (
              <Button
                ref={deleteButton}
                tone="danger"
                disabled={busy}
                aria-expanded={confirming}
                onClick={() => {
                  setConfirming(true)
                }}
              >
                {t('deleteRuntime')}
              </Button>
            )
            : null}
        </span>
      </div>
      <p className="promptx-status-line" data-promptx-runtime="">
        <StatusDot state={runtimeTone(runtime)} />
        <span>{runtimeText(t, runtime)}</span>
      </p>
      {runtime.state === 'downloading'
        ? (
          <>
            {/* 没有已下载的字节数（在等另一个进程）时画不确定进度的条。 */}
            <ProgressBar
              value={runtime.received ?? 0}
              total={runtime.received === undefined ? undefined : runtime.total}
              label={t('runtimeProgressLabel')}
            />
            <p className="promptx-hint">{progressText(t, runtime)}</p>
          </>
        )
        : null}
      {/* 失败时原因已经写在上面那行；暂停时那行说的是「已删除」，旧的错误不再相关。 */}
      {runtime.error !== undefined && runtime.state !== 'failed' && runtime.paused !== true
        ? <p className="promptx-hint">{errorText(t, runtime.error)}</p>
        : null}
      {confirming && canDelete
        ? (
          <div
            className="promptx-panel"
            role="group"
            aria-labelledby={`${id}-confirm`}
            onKeyDown={(event) => {
              if (event.key !== 'Escape') return
              // Esc 只关掉这个确认，不让它冒泡到 dsh 去关页面或对话框。
              event.stopPropagation()
              cancel()
            }}
          >
            <p id={`${id}-confirm`}>{t('deleteRuntimeConfirm')}</p>
            <span className="promptx-control-row">
              <Button
                tone="danger"
                disabled={busy}
                onClick={() => {
                  setConfirming(false)
                  actions.run('delete')
                }}
              >
                {t('deleteRuntimeConfirmButton')}
              </Button>
              {/* 焦点先给「取消」：删除虽然可以重新下载，也要约 100 MB，连按两下回车不该就删掉。 */}
              <Button autoFocus onClick={cancel}>{t('cancel')}</Button>
            </span>
          </div>
        )
        : null}
      {inUseBy.length > 0
        ? (
          <p className="promptx-hint">
            {t('runtimeInUse', { list: inUseBy.map(item => t('runtimeInUseItem', item)).join(t('listSeparator')) })}
          </p>
        )
        : null}
      {/* 卸载插件后运行时目录不会自动删除，按这里写的位置手动删（需求 6.8、7.8）。 */}
      {runtime.dir === '' ? null : <p className="promptx-hint">{t('runtimeDir', { dir: runtime.dir })}</p>}
      <ActionFailure t={t} actions={actions} of={['download', 'delete']} />
    </div>
  )
}

// ───────────────────────────── 字段 ─────────────────────────────

function FieldMessage({ t, id, error, hint, live }: {
  t: PromptxTranslate
  id: string
  error: ConfigFieldError | undefined
  hint: string
  live?: boolean
}): ReactNode {
  if (error !== undefined) return <p className="promptx-error" id={id}>{fieldErrorText(t, error)}</p>
  return <p className="promptx-hint" id={id} aria-live={live === true ? 'polite' : undefined}>{hint}</p>
}

const RUNTIME_SOURCE_OPTIONS: ReadonlyArray<{ value: RuntimeSource; key: 'runtimeSourceAuto' | 'runtimeSourceMirror' | 'runtimeSourceOfficial' }> = [
  { value: 'auto', key: 'runtimeSourceAuto' },
  { value: 'mirror', key: 'runtimeSourceMirror' },
  { value: 'official', key: 'runtimeSourceOfficial' },
]

function RuntimeSourceField({ t, value, error, disabled, onChange }: {
  t: PromptxTranslate
  value: RuntimeSource
  error: ConfigFieldError | undefined
  disabled: boolean
  onChange: (value: RuntimeSource) => void
}): ReactNode {
  const id = useId()
  return (
    <div className="promptx-field" data-promptx-field="runtimeSource">
      <div className="promptx-field-head">
        <label className="promptx-label" htmlFor={id}>{t('runtimeSourceLabel')}</label>
      </div>
      <div className="promptx-select-wrap">
        <select
          id={id}
          className="promptx-input promptx-select"
          value={value}
          disabled={disabled}
          aria-invalid={error === undefined ? undefined : true}
          aria-describedby={`${id}-message`}
          onChange={(event) => {
            const next = RUNTIME_SOURCE_OPTIONS.find(option => option.value === event.target.value)
            if (next !== undefined) onChange(next.value)
          }}
        >
          {RUNTIME_SOURCE_OPTIONS.map(option => <option key={option.value} value={option.value}>{t(option.key)}</option>)}
        </select>
      </div>
      <FieldMessage t={t} id={`${id}-message`} error={error} hint={t('runtimeSourceHint')} />
    </div>
  )
}

function ShortcutField({ t, value, platform, defaultShortcut, error, disabled, onChange }: {
  t: PromptxTranslate
  value: string
  /** 运行 dsh 的电脑的平台：快捷键是注册在那台电脑上的，显示和录制都按它（⌘ 还是 Win）。 */
  platform: string
  defaultShortcut: string
  error: ConfigFieldError | undefined
  disabled: boolean
  onChange: (value: string) => void
}): ReactNode {
  const id = useId()
  const [recording, setRecording] = useState(false)
  const recordButton = useRef<HTMLButtonElement>(null)
  const normalized = normalizeShortcut(value)
  const preview = normalized !== '' && parseAccelerator(normalized).ok ? formatAccelerator(normalized, platform) : null
  const hint = recording
    ? t('shortcutRecording')
    : t('shortcutHint', { default: defaultShortcut === '' ? '—' : formatAccelerator(defaultShortcut, platform) })

  // 录制：按下「录制」后监听这个按钮上的一次 keydown，换算成 Electron 加速键写法填进输入框（只是暂存，保存后才生效）。
  const onRecordKey = (event: KeyboardEvent<HTMLButtonElement>): void => {
    if (!recording || event.nativeEvent.isComposing) return
    // Tab 不拦：焦点照常移走，失焦时录制结束，键盘用户不会被困在按钮上。
    if (event.key === 'Tab') return
    const plain = !event.ctrlKey && !event.altKey && !event.shiftKey && !event.metaKey
    // 拦下其余按键：不让回车、空格再次触发按钮，也不让 dsh 自己的快捷键响应正在录制的组合。
    event.preventDefault()
    event.stopPropagation()
    if (event.key === 'Escape' && plain) {
      setRecording(false)
      return
    }
    const accelerator = acceleratorFromKeyEvent(event, platform)
    // 只按了修饰键，或者组合不合法（没有修饰键、只有 Shift）：继续等。
    if (accelerator === null) return
    onChange(accelerator)
    setRecording(false)
  }

  return (
    <div className="promptx-field" data-promptx-field="globalShortcut">
      <div className="promptx-field-head">
        <label className="promptx-label" htmlFor={id}>{t('shortcutLabel')}</label>
      </div>
      <div className="promptx-control-row">
        <input
          id={id}
          className="promptx-input"
          type="text"
          value={value}
          placeholder={t('shortcutPlaceholder')}
          disabled={disabled}
          spellCheck={false}
          autoComplete="off"
          aria-invalid={error === undefined ? undefined : true}
          aria-describedby={`${id}-message`}
          onChange={(event) => {
            onChange(event.target.value)
          }}
        />
        {preview === null ? null : <kbd className="promptx-kbd" title={t('shortcutPreview', { shortcut: preview })}>{preview}</kbd>}
        <Button
          ref={recordButton}
          aria-pressed={recording}
          aria-describedby={`${id}-message`}
          disabled={disabled}
          onClick={() => {
            // macOS 上的 Safari、Firefox 点按钮不会把焦点给它，按键就到不了这里的 onKeyDown；开始录制时主动拿焦点。
            if (!recording) recordButton.current?.focus()
            setRecording(!recording)
          }}
          onBlur={() => {
            setRecording(false)
          }}
          onKeyDown={onRecordKey}
        >
          {recording ? t('recording') : t('record')}
        </Button>
      </div>
      <FieldMessage t={t} id={`${id}-message`} error={recording ? undefined : error} hint={hint} live />
    </div>
  )
}

function SwitchField({ t, label, hint, checked, error, disabled, onChange }: {
  t: PromptxTranslate
  label: string
  hint: string
  checked: boolean
  error: ConfigFieldError | undefined
  disabled: boolean
  onChange: (value: boolean) => void
}): ReactNode {
  const id = useId()
  return (
    <div className="promptx-field">
      <div className="promptx-switch-row">
        <div className="promptx-switch-text">
          <label className="promptx-label" htmlFor={id}>{label}</label>
          <p className="promptx-hint" id={`${id}-hint`}>{hint}</p>
        </div>
        <Switch id={id} checked={checked} describedBy={`${id}-hint`} disabled={disabled} onChange={onChange} />
      </div>
      {error === undefined ? null : <p className="promptx-error">{fieldErrorText(t, error)}</p>}
    </div>
  )
}

function TextField({ t, label, hint, value, placeholder, error, disabled, onChange }: {
  t: PromptxTranslate
  label: string
  hint: string
  value: string
  placeholder: string
  error: ConfigFieldError | undefined
  disabled: boolean
  onChange: (value: string) => void
}): ReactNode {
  const id = useId()
  return (
    <div className="promptx-field">
      <div className="promptx-field-head">
        <label className="promptx-label" htmlFor={id}>{label}</label>
      </div>
      <input
        id={id}
        className="promptx-input"
        type="text"
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        spellCheck={false}
        autoComplete="off"
        aria-invalid={error === undefined ? undefined : true}
        aria-describedby={`${id}-message`}
        onChange={(event) => {
          onChange(event.target.value)
        }}
      />
      <FieldMessage t={t} id={`${id}-message`} error={error} hint={hint} />
    </div>
  )
}

function InstructionField({ t, value, defaultInstruction, error, disabled, onChange }: {
  t: PromptxTranslate
  value: string
  /** 留空时生效的默认指令，显示成占位文字（需求 O-08）。 */
  defaultInstruction: string
  error: ConfigFieldError | undefined
  disabled: boolean
  onChange: (value: string) => void
}): ReactNode {
  const id = useId()
  return (
    <div className="promptx-field">
      <div className="promptx-field-head">
        <label className="promptx-label" htmlFor={id}>{t('instructionLabel')}</label>
      </div>
      <textarea
        id={id}
        className="promptx-input promptx-textarea"
        value={value}
        placeholder={defaultInstruction}
        rows={8}
        disabled={disabled}
        spellCheck={false}
        aria-invalid={error === undefined ? undefined : true}
        aria-describedby={`${id}-message`}
        onChange={(event) => {
          onChange(event.target.value)
        }}
      />
      <div className="promptx-control-row">
        {/* 只把指令框暂存为空（空 = 使用默认指令），保存后才生效（design-spec 4.4）。 */}
        <Button
          disabled={disabled || value === ''}
          onClick={() => {
            onChange('')
          }}
        >
          {t('restoreDefaultInstruction')}
        </Button>
      </div>
      <FieldMessage t={t} id={`${id}-message`} error={error} hint={t('instructionHint')} />
    </div>
  )
}
