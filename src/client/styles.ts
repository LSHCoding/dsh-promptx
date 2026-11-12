// 配置页的样式。尺寸、间距、发丝线和配色照 dsh 自己的设置表单和控件改写，改动只有类名和少量布局。来源：
// DeepSeek Harness 0.2.2-rc.1（https://github.com/deepseek-ai/deepseek-harness，MIT，许可全文见 THIRD_PARTY_NOTICES.md）的
// packages/client/ui-primitives/src/ 下 settings-form/SettingsForm、settings-form/fields、Switch、Button、StateDot 的 .module.css，
// 以及 ui-plugin-manager 详情页的分区标题。
//
// 为什么不直接用 dsh 的控件：AGENTS.md 不允许把 dsh 的 Client 包当模块 require（它们会不经通知地变更），
// 所以按 dsh 插件开发的建议把结构和 CSS 抄进来，类名一律换成 promptx- 前缀，避免和 dsh、其他插件撞名。
// 颜色只用 dsh 的主题变量（--dsw-alias-*），明暗切换由 dsh 的主题负责；不写字面颜色值（AGENTS.md「代码分层」）。
// 样式随组件渲染成一个 <style> 元素，不往 document.head 里插东西，组件卸载时一起移除（AGENTS.md：不改自己组件以外的 DOM）。

export const CONFIG_PAGE_CSS = `
.promptx-config {
  display: flex;
  flex-direction: column;
  min-width: 0;
  font-size: 13px;
  line-height: 1.5;
  color: var(--dsw-alias-label-primary);
}

.promptx-section {
  display: flex;
  flex-direction: column;
}

.promptx-section + .promptx-section {
  margin-top: 32px;
}

.promptx-section-title {
  margin: 0;
  font-size: 14px;
  font-weight: 500;
  line-height: 20px;
  color: var(--dsw-alias-label-primary);
}

.promptx-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 12px 0;
}

.promptx-field + .promptx-field {
  border-top: 0.5px solid var(--dsw-alias-border-l2);
}

.promptx-field-head {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 28px;
}

.promptx-label {
  flex: 1;
  min-width: 0;
  font-size: 13px;
  font-weight: 500;
  line-height: 1.5;
  color: var(--dsw-alias-label-primary);
}

.promptx-actions {
  display: inline-flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
}

.promptx-control-row {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.promptx-input {
  box-sizing: border-box;
  flex: 1;
  min-width: 0;
  width: 100%;
  height: 34px;
  padding: 0 12px;
  border: 0.5px solid var(--dsw-alias-border-l4);
  border-radius: var(--dsw-radius-md);
  background: var(--dsw-alias-bg-layer-3);
  font: inherit;
  font-size: 13px;
  line-height: 1.5;
  color: var(--dsw-alias-label-primary);
}

.promptx-input::placeholder {
  color: var(--dsw-alias-label-tertiary);
}

.promptx-input:focus-visible {
  outline: none;
  border-color: var(--dsw-alias-state-business-primary);
}

.promptx-input:disabled {
  color: var(--dsw-alias-label-tertiary);
  cursor: default;
}

.promptx-input[aria-invalid='true'] {
  border-color: var(--dsw-alias-state-error-primary);
}

.promptx-textarea {
  height: auto;
  min-height: 168px;
  padding: 8px 12px;
  resize: vertical;
  white-space: pre-wrap;
}

.promptx-select-wrap {
  position: relative;
  display: flex;
  min-width: 0;
}

.promptx-select {
  appearance: none;
  padding-right: 32px;
  cursor: pointer;
}

@media (hover: hover) {
  .promptx-select:hover:not(:disabled) {
    background: var(--dsw-alias-interactive-bg-hover);
  }
}

/* 下拉箭头用两条边框画，颜色跟主题变量走，不用带字面颜色的图片。 */
.promptx-select-wrap::after {
  content: '';
  position: absolute;
  top: 50%;
  right: 14px;
  width: 6px;
  height: 6px;
  margin-top: -5px;
  border-right: 1.5px solid var(--dsw-alias-label-tertiary);
  border-bottom: 1.5px solid var(--dsw-alias-label-tertiary);
  transform: rotate(45deg);
  pointer-events: none;
}

.promptx-hint {
  margin: 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--dsw-alias-label-tertiary);
  overflow-wrap: anywhere;
}

.promptx-error {
  margin: 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--dsw-alias-state-error-primary);
  overflow-wrap: anywhere;
}

.promptx-status-line {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0;
  font-size: 13px;
  line-height: 1.5;
  color: var(--dsw-alias-label-primary);
  overflow-wrap: anywhere;
}

.promptx-notice {
  margin: 0;
  padding: 10px 12px;
  border-radius: var(--dsw-radius-md);
  background: var(--dsw-alias-bg-module-platform);
  font-size: 12px;
  line-height: 1.5;
  color: var(--dsw-alias-label-secondary);
  overflow-wrap: anywhere;
}

.promptx-notice[data-tone='error'] {
  color: var(--dsw-alias-state-error-primary);
}

.promptx-notice[data-tone='warning'] {
  color: var(--dsw-alias-state-warn-label);
}

.promptx-notice + .promptx-section,
.promptx-config > .promptx-notice + .promptx-notice {
  margin-top: 12px;
}

.promptx-panel {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 12px;
  border-radius: var(--dsw-radius-md);
  background: var(--dsw-alias-bg-module-platform);
}

.promptx-panel p {
  margin: 0;
}

.promptx-button {
  box-sizing: border-box;
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  gap: 4px;
  height: 28px;
  padding: 0 10px;
  border: 0.5px solid transparent;
  border-radius: var(--dsw-radius-sm);
  background: transparent;
  box-shadow: inset 0 0 0 0.5px var(--dsw-alias-border-l3);
  font: inherit;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-primary);
  white-space: nowrap;
  cursor: pointer;
}

@media (hover: hover) {
  .promptx-button:hover:not(:disabled) {
    background: var(--dsw-alias-interactive-bg-hover);
  }
}

.promptx-button:active:not(:disabled),
.promptx-button[aria-pressed='true'] {
  background: var(--dsw-alias-interactive-bg-active);
}

.promptx-button[data-tone='danger'] {
  color: var(--dsw-alias-state-error-primary);
}

.promptx-button:disabled {
  opacity: 0.45;
  cursor: default;
}

.promptx-button:focus-visible,
.promptx-save:focus-visible,
.promptx-switch:focus-visible {
  outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-alias-state-business-primary);
  outline-offset: 2px;
}

.promptx-switch-row {
  display: flex;
  align-items: center;
  gap: 16px;
}

.promptx-switch-text {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.promptx-switch {
  box-sizing: border-box;
  position: relative;
  flex: 0 0 auto;
  width: 36px;
  height: 20px;
  padding: 2px;
  border: 0;
  border-radius: 999px;
  background: var(--dsw-alias-border-l3);
  cursor: pointer;
}

.promptx-switch[aria-checked='true'] {
  background: var(--dsw-alias-brand-primary);
}

.promptx-switch:disabled {
  opacity: 0.45;
  cursor: default;
}

.promptx-switch-thumb {
  display: block;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: var(--dsw-alias-label-primary-foreground);
  transition: transform 120ms ease;
}

.promptx-switch[aria-checked='false'] .promptx-switch-thumb {
  background: var(--dsw-alias-switch-thumb);
}

.promptx-switch[aria-checked='true'] .promptx-switch-thumb {
  transform: translateX(16px);
}

.promptx-dot {
  display: inline-block;
  flex: none;
  width: 6px;
  height: 6px;
  margin: 0 2px;
  border-radius: 50%;
  background: var(--dsw-alias-state-idle-primary);
}

.promptx-dot[data-state='done'] {
  background: var(--dsw-alias-state-success-primary);
}

.promptx-dot[data-state='warning'] {
  background: var(--dsw-alias-state-warn-primary);
}

.promptx-dot[data-state='error'] {
  background: var(--dsw-alias-state-error-primary);
}

.promptx-dot[data-state='ongoing'] {
  background: var(--dsw-alias-label-tertiary);
  animation: promptx-pulse 1.5s ease-in-out infinite;
}

@keyframes promptx-pulse {
  50% { opacity: 0.3; }
}

.promptx-progress {
  position: relative;
  height: 4px;
  border-radius: 999px;
  background: var(--dsw-alias-border-l2);
  overflow: hidden;
}

.promptx-progress-bar {
  position: absolute;
  top: 0;
  bottom: 0;
  left: 0;
  border-radius: inherit;
  background: var(--dsw-alias-brand-primary);
  transition: width 200ms ease;
}

.promptx-progress[data-indeterminate] .promptx-progress-bar {
  width: 30%;
  animation: promptx-indeterminate 1.2s ease-in-out infinite;
}

@keyframes promptx-indeterminate {
  from { left: -30%; }
  to { left: 100%; }
}

@media (prefers-reduced-motion: reduce) {
  .promptx-dot[data-state='ongoing'],
  .promptx-progress[data-indeterminate] .promptx-progress-bar {
    animation: none;
  }

  .promptx-progress-bar,
  .promptx-switch-thumb {
    transition: none;
  }
}

.promptx-kbd {
  display: inline-flex;
  flex: none;
  align-items: center;
  height: 22px;
  padding: 0 6px;
  border-radius: var(--dsw-radius-xs);
  background: var(--dsw-alias-bg-module-platform);
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-secondary);
  white-space: nowrap;
}

.promptx-footer {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  padding-top: 16px;
}

.promptx-footer-notice {
  flex: 1;
  min-width: 0;
  margin: 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--dsw-alias-state-error-primary);
}

.promptx-save {
  appearance: none;
  flex: none;
  border: 1px solid transparent;
  border-radius: var(--dsw-radius-md);
  padding: 5px 14px;
  font: inherit;
  font-size: 13px;
  line-height: 1.5;
  background: var(--dsw-alias-label-primary);
  color: var(--dsw-alias-bg-layer-3);
  cursor: pointer;
}

.promptx-save:disabled {
  opacity: 0.45;
  cursor: default;
}
`
