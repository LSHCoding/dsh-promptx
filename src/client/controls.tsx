// 配置页用到的几个基础控件：按钮、开关、状态点、进度条。结构和交互照 dsh 的 ui-primitives（Button、Switch、StateDot）改写，
// 样式在 styles.ts。不直接用 dsh 的控件，原因见 styles.ts 文件头。

import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react'

type ButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className' | 'type'> & {
  /** danger：删除这类动作，文字用错误色。 */
  tone?: 'danger' | undefined
  children: ReactNode
}

/** 描边小按钮（dsh Button 的 outline + sm）。动作类按钮都用它。转发 ref，内联确认关掉后要把焦点还给它。 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button({ tone, children, ...rest }, ref) {
  return (
    <button ref={ref} type="button" className="promptx-button" data-tone={tone} {...rest}>
      {children}
    </button>
  )
})

/**
 * 开关。用 role="switch" 和 aria-checked 表达状态（需求 S-03「开关有可读的开关状态」），外观也只看 aria-checked，
 * 视觉状态和读屏读到的状态不会对不上。名字由页面上可见的 <label htmlFor> 提供（button 是可被 label 关联的元素，
 * 点标签文字也能切换），不另写一份隐藏文字。
 */
export function Switch(props: {
  id: string
  checked: boolean
  onChange: (next: boolean) => void
  describedBy?: string | undefined
  disabled?: boolean | undefined
}): ReactNode {
  return (
    <button
      id={props.id}
      type="button"
      role="switch"
      className="promptx-switch"
      aria-checked={props.checked}
      aria-describedby={props.describedBy}
      disabled={props.disabled}
      onClick={() => {
        props.onChange(!props.checked)
      }}
    >
      <span className="promptx-switch-thumb" />
    </button>
  )
}

export type DotState = 'done' | 'warning' | 'error' | 'ongoing' | 'idle'

/** 状态点（dsh StateDot 的实心点）。只是装饰，状态由旁边的文字说明。 */
export function StatusDot({ state }: { state: DotState }): ReactNode {
  return <span className="promptx-dot" data-state={state} aria-hidden="true" />
}

/** 进度条。total 不知道时显示来回移动的条（不确定进度），读屏不报数值。 */
export function ProgressBar({ value, total, label }: { value: number; total: number | undefined; label: string }): ReactNode {
  if (total === undefined || total <= 0) {
    return (
      <div className="promptx-progress" role="progressbar" aria-label={label} data-indeterminate="">
        <div className="promptx-progress-bar" />
      </div>
    )
  }
  const percent = clampPercent(value, total)
  return (
    <div className="promptx-progress" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
      <div className="promptx-progress-bar" style={{ width: `${percent}%` }} />
    </div>
  )
}

/** 已完成的百分比，向下取整并限制在 0–100：没下完之前不显示 100%。 */
export function clampPercent(value: number, total: number): number {
  if (total <= 0) return 0
  return Math.min(100, Math.max(0, Math.floor((value / total) * 100)))
}
