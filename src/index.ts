// PromptX 的 Host 入口：name / inject / Config / apply，只负责组装（AGENTS.md 代码分层）。
// 组装细节在 host.ts；各业务在 library、draft、optimize、companion、web 目录里。

import type { Context } from '@deepseek-ai/cordis'
import { Config, type ConfigRefs } from './config.ts'
import { startPromptxHost } from './host.ts'

export const name = 'dsh-promptx'

/** 只把存储设为必需：其他服务被重新提供时，必需的注入会让插件整体重载、小程序跟着重启（design-spec 4.1）。 */
export const inject = ['storageDomain']

export { Config }

export function apply(ctx: Context, config: ConfigRefs): void {
  startPromptxHost(ctx, config)
}
