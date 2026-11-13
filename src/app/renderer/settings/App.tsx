// 设置窗口的界面（V0.1.6 design-spec 3）。左侧导航，右侧按分组卡片排列；每行左边是名称和说明，右边是控件。
// 颜色只用 dsh 主题变量，样式在 styles/settings.css。

import { useEffect, useId, useLayoutEffect, useRef, useSyncExternalStore, type KeyboardEvent, type ReactElement, type ReactNode } from 'react'
import { errorReason, translate, type MessageKey } from '../../../shared/i18n/index.ts'
import { SETTINGS_SECTIONS } from '../../../shared/settings.ts'
import type { PromptxConfig, RuntimeSource, SettingsData, SettingsSection } from '../../../shared/types.ts'
import { COPY_AND_HIDE_SHORTCUT } from '../../../shared/window-shortcuts.ts'
import { applyAppearance } from '../appearance.ts'
import { Icon, Spinner, type IconName } from '../components/icons.tsx'
import { runTask } from '../controller/context.ts'
import type { SettingsController, SettingsState } from './controller.ts'
import {
  defaultShortcutOf,
  describeGlobalShortcut,
  displayShortcut,
  fieldErrorText,
  shortcutTokens,
  WINDOW_COMMAND_ROWS,
  type ShortcutField,
  type StatusTone,
} from './model.ts'

const SECTION_ICONS: Readonly<Record<SettingsSection, IconName>> = {
  shortcuts: 'keyboard',
  editor: 'text',
  library: 'folder',
  optimize: 'optimize',
  about: 'info',
}

interface SectionProps {
  controller: SettingsController
  state: SettingsState
  data: SettingsData
  config: PromptxConfig
  t: (key: MessageKey, params?: Readonly<Record<string, string | number>>) => string
}

export function SettingsApp({ controller }: { controller: SettingsController }): ReactElement {
  const state = useSyncExternalStore(controller.store.subscribe, controller.store.getState)
  const { locale, theme, section } = state
  const t = (key: MessageKey, params?: Readonly<Record<string, string | number>>) => translate(locale, key, params)
  const data = state.snapshot?.data ?? null
  const config = controller.config()

  useLayoutEffect(() => {
    applyAppearance(document, { platform: controller.bridge.platform, locale, theme })
    document.title = translate(locale, 'settings.windowTitle')
  }, [controller, locale, theme])

  useEffect(() => {
    const onKeydown = (event: globalThis.KeyboardEvent) => {
      if (controller.handleKeydown(event)) {
        event.preventDefault()
        event.stopPropagation()
      }
    }
    // 窗口失焦、被隐藏时把优化指令里还没提交的输入交出去。
    const flush = () => { runTask(controller.flushInstruction()) }
    const onVisibility = () => { if (document.visibilityState === 'hidden') flush() }
    window.addEventListener('keydown', onKeydown, true)
    window.addEventListener('blur', flush)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.removeEventListener('keydown', onKeydown, true)
      window.removeEventListener('blur', flush)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [controller])

  return (
    <main className="px-app px-settings">
      <Navigation controller={controller} section={section} t={t} version={data?.hostVersion ?? null} />
      <section className="px-settings-main" aria-labelledby="px-settings-heading">
        <header className="px-settings-head">
          <h1 className="px-settings-heading" id="px-settings-heading">{t(`settings.section.${section}`)}</h1>
          <button
            type="button"
            className="px-icon-button"
            aria-label={t('common.close')}
            title={t('common.close')}
            onClick={() => { runTask(controller.close()) }}
          >
            <Icon name="close" />
          </button>
        </header>
        <div className="px-settings-body" data-section={section}>
          {state.notice?.section === section
            ? (
              <div className="px-settings-notice" data-tone={state.notice.tone} role={state.notice.tone === 'error' ? 'alert' : 'status'}>
                <span>{state.notice.text}</span>
                <button type="button" className="px-icon-button px-icon-button-sm" aria-label={t('common.dismiss')} onClick={() => { controller.dismissNotice() }}>
                  <Icon name="close" size={14} />
                </button>
              </div>
            )
            : null}
          {data === null || config === null
            ? <LoadState controller={controller} state={state} t={t} />
            : <SectionContent controller={controller} state={state} data={data} config={config} t={t} />}
        </div>
      </section>
    </main>
  )
}

function Navigation({ controller, section, t, version }: {
  controller: SettingsController
  section: SettingsSection
  t: SectionProps['t']
  version: string | null
}): ReactElement {
  const items = useRef<Partial<Record<SettingsSection, HTMLButtonElement | null>>>({})
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    // 上下方向键在分区之间移动，和系统设置的侧栏一致。
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    event.preventDefault()
    const index = SETTINGS_SECTIONS.indexOf(section)
    const next = SETTINGS_SECTIONS[(index + (event.key === 'ArrowDown' ? 1 : SETTINGS_SECTIONS.length - 1)) % SETTINGS_SECTIONS.length]
    if (next === undefined) return
    controller.selectSection(next)
    items.current[next]?.focus()
  }
  return (
    <nav className="px-settings-nav" aria-label={t('settings.navLabel')}>
      <div className="px-settings-nav-head">{t('settings.title')}</div>
      <div className="px-settings-nav-list" onKeyDown={onKeyDown}>
        {SETTINGS_SECTIONS.map(item => (
          <button
            key={item}
            ref={(element) => { items.current[item] = element }}
            type="button"
            className="px-settings-nav-item"
            aria-current={item === section ? 'page' : undefined}
            tabIndex={item === section ? 0 : -1}
            onClick={() => { controller.selectSection(item) }}
          >
            <Icon name={SECTION_ICONS[item]} />
            <span>{t(`settings.section.${item}`)}</span>
          </button>
        ))}
      </div>
      {version === null ? null : <div className="px-settings-nav-foot">{t('settings.version', { version })}</div>}
    </nav>
  )
}

function LoadState({ controller, state, t }: { controller: SettingsController; state: SettingsState; t: SectionProps['t'] }): ReactElement {
  if (state.load === 'error') {
    const reason = state.loadError === null ? '' : errorReason(state.locale, state.loadError)
    return (
      <div className="px-settings-empty" role="alert">
        <p>{t('settings.loadFailed', { reason })}</p>
        <button type="button" className="px-button" onClick={() => { runTask(controller.load()) }}>{t('common.retry')}</button>
      </div>
    )
  }
  return (
    <div className="px-settings-empty" role="status">
      <Spinner label={t('settings.loading')} />
      <p>{t('settings.loading')}</p>
    </div>
  )
}

function SectionContent(props: SectionProps): ReactElement {
  switch (props.state.section) {
    case 'shortcuts': return <ShortcutsSection {...props} />
    case 'editor': return <EditorSection {...props} />
    case 'library': return <LibrarySection {...props} />
    case 'optimize': return <OptimizeSection {...props} />
    case 'about': return <AboutSection {...props} />
  }
}

// ───────────────────────────── 布局小件 ─────────────────────────────

function Group({ title, hint, children }: { title: string; hint?: string; children: ReactNode }): ReactElement {
  const id = useId()
  return (
    <section className="px-settings-group" aria-labelledby={id}>
      <h2 className="px-settings-group-title" id={id}>{title}</h2>
      <div className="px-settings-card">{children}</div>
      {hint === undefined ? null : <p className="px-settings-group-hint">{hint}</p>}
    </section>
  )
}

function Row({ label, labelFor, hint, status, error, children, stacked }: {
  label: string
  labelFor?: string
  hint?: string
  status?: { tone: StatusTone; text: string }
  error?: string
  children?: ReactNode
  stacked?: boolean
}): ReactElement {
  return (
    <div className="px-settings-row" data-stacked={stacked === true ? '' : undefined}>
      <div className="px-settings-row-text">
        {labelFor === undefined
          ? <span className="px-settings-label">{label}</span>
          : <label className="px-settings-label" htmlFor={labelFor}>{label}</label>}
        {hint === undefined ? null : <span className="px-settings-hint">{hint}</span>}
        {status === undefined
          ? null
          : (
            <span className="px-settings-status" role="status">
              <span className="px-dot" data-tone={status.tone} aria-hidden="true" />
              {status.text}
            </span>
          )}
        {error === undefined ? null : <span className="px-settings-error" role="alert">{error}</span>}
      </div>
      {children === undefined ? null : <div className="px-settings-control">{children}</div>}
    </div>
  )
}

/** 开关：role="switch"，外观只看 aria-checked，视觉状态和读屏读到的状态不会对不上。 */
function Switch({ id, checked, disabled, describedBy, onChange }: {
  id: string
  checked: boolean
  disabled?: boolean
  describedBy?: string
  onChange: (next: boolean) => void
}): ReactElement {
  return (
    <button
      id={id}
      type="button"
      role="switch"
      className="px-switch"
      aria-checked={checked}
      aria-describedby={describedBy}
      disabled={disabled}
      onClick={() => { onChange(!checked) }}
    >
      <span className="px-switch-thumb" />
    </button>
  )
}

function Keys({ tokens }: { tokens: string[] }): ReactElement {
  return (
    <span className="px-keys" aria-hidden="true">
      {tokens.map((token, index) => <kbd key={`${index}-${token}`} className="px-key">{token}</kbd>)}
    </span>
  )
}

type RecorderProps = SectionProps & { field: ShortcutField; label: string }

function ShortcutRecorder({ field, label, controller, state, data, config, t }: RecorderProps): ReactElement {
  const platform = data.platform
  const recording = state.recording === field
  const value = config[field]
  const shown = displayShortcut(value, field, platform)
  const fallback = defaultShortcutOf(field, data)
  const saving = state.saving[field] === true
  const canReset = fallback !== value && !(fallback === '' && value === '')
  return (
    <div className="px-recorder-group">
      <button
        type="button"
        className="px-recorder"
        data-recording={recording ? '' : undefined}
        data-invalid={state.errors[field] === undefined ? undefined : ''}
        aria-label={t('settings.recorder.label', { action: label, shortcut: shown === '' ? t('settings.recorder.none') : shown })}
        aria-pressed={recording}
        disabled={saving}
        onClick={() => {
          if (recording) controller.cancelRecording()
          else controller.startRecording(field)
        }}
        onBlur={() => {
          if (controller.store.getState().recording === field) controller.cancelRecording()
        }}
      >
        {recording
          ? <span className="px-recorder-prompt">{t('settings.recorder.recording')}</span>
          : shown === ''
            ? <span className="px-recorder-empty">{t('settings.recorder.none')}</span>
            : <Keys tokens={shortcutTokens(value, field, platform)} />}
      </button>
      <span className="px-recorder-actions">
        <button
          type="button"
          className="px-icon-button px-icon-button-sm"
          data-hidden={canReset ? undefined : ''}
          tabIndex={canReset ? undefined : -1}
          aria-hidden={canReset ? undefined : true}
          disabled={saving || !canReset}
          aria-label={t('settings.recorder.reset', { shortcut: fallback === '' ? t('settings.recorder.none') : displayShortcut(fallback, field, platform) })}
          title={t('settings.recorder.reset', { shortcut: fallback === '' ? t('settings.recorder.none') : displayShortcut(fallback, field, platform) })}
          onClick={() => { controller.resetShortcut(field) }}
        >
          <Icon name="reset" size={14} />
        </button>
        <button
          type="button"
          className="px-icon-button px-icon-button-sm px-recorder-clear"
          data-hidden={value === '' ? '' : undefined}
          tabIndex={value === '' ? -1 : undefined}
          aria-hidden={value === '' ? true : undefined}
          disabled={saving || value === ''}
          aria-label={`${t('settings.recorder.clear')} ${label}`}
          title={t('settings.recorder.clear')}
          onClick={() => { controller.clearShortcut(field) }}
        >
          <Icon name="close" size={14} />
        </button>
      </span>
    </div>
  )
}

// ───────────────────────────── 分区 ─────────────────────────────

function ShortcutsSection(props: SectionProps): ReactElement {
  const { state, data, config, t } = props
  const platform = data.platform
  const globalLabel = t('settings.shortcuts.global')
  const globalError = state.errors.globalShortcut
  const pendingGlobal = state.pending.globalShortcut !== undefined || state.saving.globalShortcut === true
  const status = pendingGlobal
    ? { tone: 'ongoing' as const, text: t('settings.shortcutStatus.pending') }
    : describeGlobalShortcut(state.locale, config.globalShortcut, state.snapshot?.shortcut ?? null, platform)
  return (
    <>
      <Group title={t('settings.shortcuts.globalGroup')}>
        <Row
          label={globalLabel}
          hint={t('settings.shortcuts.globalHint', { default: displayShortcut(data.defaultShortcut, 'globalShortcut', platform) || t('settings.recorder.none') })}
          status={status}
          {...(globalError === undefined ? {} : { error: fieldErrorText(state.locale, globalError) })}
        >
          <ShortcutRecorder {...props} field="globalShortcut" label={globalLabel} />
        </Row>
      </Group>
      <Group title={t('settings.shortcuts.windowGroup')} hint={t('settings.shortcuts.windowHint')}>
        {WINDOW_COMMAND_ROWS.map(({ field, label }) => {
          const error = state.errors[field]
          return (
            <Row key={field} label={t(label)} {...(error === undefined ? {} : { error: fieldErrorText(state.locale, error) })}>
              <ShortcutRecorder {...props} field={field} label={t(label)} />
            </Row>
          )
        })}
        <Row label={t('settings.command.copyAndHide')}>
          <div className="px-recorder-group">
            <span className="px-recorder" data-fixed="">
              <Keys tokens={shortcutTokens(COPY_AND_HIDE_SHORTCUT, 'shortcutSave', platform)} />
            </span>
            <span className="px-recorder-actions px-recorder-fixed">{t('settings.shortcuts.fixed')}</span>
          </div>
        </Row>
      </Group>
    </>
  )
}

function EditorSection({ controller, state, config, t }: SectionProps): ReactElement {
  const ids = useId()
  const rows = [
    { field: 'convertMiddleDot', label: 'settings.editor.middleDot', hint: 'settings.editor.middleDotHint' },
    { field: 'convertYen', label: 'settings.editor.yen', hint: 'settings.editor.yenHint' },
  ] as const
  return (
    <Group title={t('settings.editor.conversionsGroup')} hint={t('settings.editor.conversionsHint')}>
      {rows.map(({ field, label, hint }) => {
        const error = state.errors[field]
        return (
          <Row key={field} label={t(label)} labelFor={`${ids}-${field}`} hint={t(hint)} {...(error === undefined ? {} : { error: fieldErrorText(state.locale, error) })}>
            <Switch
              id={`${ids}-${field}`}
              checked={config[field]}
              disabled={state.saving[field] === true}
              onChange={(next) => { controller.setToggle(field, next) }}
            />
          </Row>
        )
      })}
    </Group>
  )
}

function LibrarySection({ controller, state, data, config, t }: SectionProps): ReactElement {
  const id = useId()
  const isDefault = config.libraryDir.trim() === ''
  // 刚选了新目录、Host 的新配置还没到时，显示刚选的目录。
  const path = config.libraryDir === data.config.libraryDir
    ? data.effectiveLibraryDir
    : isDefault ? data.defaultLibraryDir : config.libraryDir
  const saving = state.saving.libraryDir === true
  const error = state.errors.libraryDir
  return (
    <>
      <Group title={t('settings.library.locationGroup')}>
        <Row
          label={t('settings.library.dir')}
          hint={t('settings.library.dirHint')}
          stacked
          {...(error === undefined ? {} : { error: fieldErrorText(state.locale, error) })}
        >
          <div className="px-path" title={path}>
            <Icon name="folder" />
            <span className="px-path-text">{path}</span>
            {isDefault ? <span className="px-settings-badge">{t('settings.library.default')}</span> : null}
          </div>
          <div className="px-path-actions">
            <button type="button" className="px-button px-button-sm" disabled={saving} onClick={() => { runTask(controller.chooseLibraryDir()) }}>
              {t('settings.library.change')}
            </button>
            <button type="button" className="px-button px-button-sm" disabled={saving} onClick={() => { runTask(controller.openLibraryDir()) }}>
              {t('settings.library.open')}
            </button>
            {isDefault
              ? null
              : (
                <button type="button" className="px-text-button px-path-reset" disabled={saving} onClick={() => { runTask(controller.resetLibraryDir()) }}>
                  {t('settings.library.reset')}
                </button>
              )}
          </div>
        </Row>
      </Group>
      <Group title={t('settings.library.deleteGroup')}>
        <Row label={t('settings.library.confirmDelete')} labelFor={`${id}-confirm`} hint={t('settings.library.confirmDeleteHint')}>
          <Switch
            id={`${id}-confirm`}
            checked={config.confirmDelete}
            disabled={state.saving.confirmDelete === true}
            onChange={(next) => { controller.setToggle('confirmDelete', next) }}
          />
        </Row>
      </Group>
    </>
  )
}

function OptimizeSection({ controller, state, data, t }: SectionProps): ReactElement {
  const id = useId()
  const draft = state.instruction
  const text = draft?.text ?? ''
  const saving = draft?.status === 'saving' || state.saving.optimizeInstruction === true
  const kind = text.trim() === '' ? t('settings.optimize.usingDefault') : t('settings.optimize.custom')
  const progress = saving ? t('settings.optimize.saving') : draft?.status === 'saved' && !draft.dirty ? t('settings.optimize.saved') : null
  const error = state.errors.optimizeInstruction
  return (
    <section className="px-settings-group" aria-labelledby={`${id}-title`}>
      <h2 className="px-settings-group-title" id={`${id}-title`}>
        <label htmlFor={`${id}-text`}>{t('settings.optimize.instruction')}</label>
      </h2>
      <div className="px-settings-card px-instruction-card">
        <textarea
          id={`${id}-text`}
          className="px-instruction"
          value={text}
          placeholder={data.defaultInstruction[state.locale]}
          spellCheck={false}
          aria-describedby={`${id}-hint`}
          onChange={(event) => { controller.editInstruction(event.target.value) }}
          onBlur={() => { runTask(controller.flushInstruction()) }}
        />
        <div className="px-instruction-foot">
          <span className="px-instruction-state" aria-live="polite">
            {kind}
            {progress === null ? null : <span className="px-instruction-progress">{progress}</span>}
          </span>
          {text.trim() === ''
            ? <button type="button" className="px-button px-button-sm" onClick={() => { controller.startFromDefault() }}>{t('settings.optimize.startFromDefault')}</button>
            : <button type="button" className="px-button px-button-sm" disabled={saving} onClick={() => { runTask(controller.restoreDefaultInstruction()) }}>{t('settings.optimize.restore')}</button>}
        </div>
      </div>
      {error === undefined ? null : <p className="px-settings-error" role="alert">{fieldErrorText(state.locale, error)}</p>}
      <p className="px-settings-group-hint" id={`${id}-hint`}>{t('settings.optimize.instructionHint')}</p>
    </section>
  )
}

const RUNTIME_SOURCES: ReadonlyArray<{ value: RuntimeSource; label: MessageKey }> = [
  { value: 'auto', label: 'settings.about.sourceAuto' },
  { value: 'mirror', label: 'settings.about.sourceMirror' },
  { value: 'official', label: 'settings.about.sourceOfficial' },
]

function AboutSection({ controller, state, data, config, t }: SectionProps): ReactElement {
  const id = useId()
  const electron = state.snapshot?.electronVersion ?? data.runtime.version
  return (
    <>
      <Group title={t('settings.about.appGroup')}>
        <Row label={t('settings.about.version')}><span className="px-settings-value">{data.hostVersion}</span></Row>
        <Row label={t('settings.about.runtime')}><span className="px-settings-value">{t('settings.about.runtimeValue', { version: electron })}</span></Row>
        <Row label={t('settings.about.profile')}><span className="px-settings-value">{data.profile}</span></Row>
      </Group>
      <Group title={t('settings.about.sourceGroup')}>
        <Row label={t('settings.about.source')} labelFor={`${id}-source`} hint={t('settings.about.sourceHint')}>
          <span className="px-settings-select">
            <select
              id={`${id}-source`}
              value={config.runtimeSource}
              disabled={state.saving.runtimeSource === true}
              onChange={(event) => {
                const next = RUNTIME_SOURCES.find(option => option.value === event.target.value)
                if (next !== undefined) controller.setRuntimeSource(next.value)
              }}
            >
              {RUNTIME_SOURCES.map(option => <option key={option.value} value={option.value}>{t(option.label)}</option>)}
            </select>
            <Icon name="chevron" size={14} className="px-settings-select-chevron" />
          </span>
        </Row>
      </Group>
      <Group title={t('settings.about.dshGroup')}>
        <Row label={t('settings.about.pluginPage')} hint={t('settings.about.pluginPageHint')}>
          <button type="button" className="px-button px-button-sm" onClick={() => { runTask(controller.openInDsh()) }}>
            {t('settings.about.openInDsh')}
            <Icon name="open" size={14} />
          </button>
        </Row>
      </Group>
    </>
  )
}
