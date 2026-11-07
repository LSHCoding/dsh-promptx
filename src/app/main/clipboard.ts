// 写剪贴板并读回核对（需求 F-03，design-spec 5.4，审查 COV-09）。Electron 44 起剪贴板只在主进程可用，而且是异步的。
// 写完读回比对，不一致算写入失败：剪贴板管理器、远程桌面同步工具偶尔会改写或吞掉内容，
// 「复制并隐藏」必须确认剪贴板里就是编辑区全文后才隐藏，否则用户切回原应用粘贴出来的是别的东西。

import type { BridgeResult } from '../../shared/bridge.ts'
import { toErrorInfo } from '../../shared/errors.ts'

export interface ClipboardLike {
  writeText(text: string): Promise<void>
  readText(): Promise<string>
}

/**
 * Windows 剪贴板里的文本可能被系统或其他程序换成 CRLF；编辑区只有 LF，比较时统一换行，
 * 其余（首尾空白、空行、缩进）必须逐字相同。
 */
function sameText(a: string, b: string): boolean {
  return a === b || a.replace(/\r\n/g, '\n') === b.replace(/\r\n/g, '\n')
}

export class ClipboardWriter {
  readonly #clipboard: ClipboardLike
  /** 写入和读回要成对完成，两次复制交错时读回的会是另一次写入的内容，所以排队执行。 */
  #queue: Promise<unknown> = Promise.resolve()

  constructor(clipboard: ClipboardLike) {
    this.#clipboard = clipboard
  }

  write(text: string): Promise<BridgeResult<null>> {
    const run = this.#queue.then(() => this.#writeAndVerify(text))
    this.#queue = run.catch(() => {})
    return run
  }

  async #writeAndVerify(text: string): Promise<BridgeResult<null>> {
    try {
      await this.#clipboard.writeText(text)
      const back = await this.#clipboard.readText()
      if (!sameText(back, text)) return { ok: false, error: { code: 'promptx/clipboard/write-failed', detail: 'read-back mismatch' } }
      return { ok: true, value: null }
    } catch (error) {
      // detail 只取系统错误信息的第一行（toErrorInfo），剪贴板 API 的报错里没有正文。
      return { ok: false, error: toErrorInfo(error, 'promptx/clipboard/write-failed') }
    }
  }
}
