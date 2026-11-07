import { describe, expect, it } from 'vitest'
import { ClipboardWriter, type ClipboardLike } from '../../../src/app/main/clipboard.ts'
import { trapProcessErrors } from './helpers.ts'

trapProcessErrors()

/** 假剪贴板：写入是异步的（Electron 44 的 clipboard.writeText 返回 Promise），可以让它出错或改写内容。 */
class FakeClipboard implements ClipboardLike {
  text = ''
  writes: string[] = []
  failWrite: Error | null = null
  failRead: Error | null = null
  /** 模拟剪贴板管理器之类的程序改写了内容。 */
  rewrite: ((text: string) => string) | null = null

  async writeText(text: string): Promise<void> {
    await Promise.resolve()
    if (this.failWrite !== null) throw this.failWrite
    this.writes.push(text)
    this.text = this.rewrite === null ? text : this.rewrite(text)
  }

  async readText(): Promise<string> {
    await Promise.resolve()
    if (this.failRead !== null) throw this.failRead
    return this.text
  }
}

describe('ClipboardWriter', () => {
  it('writes the text exactly and confirms it by reading it back', async () => {
    const clipboard = new FakeClipboard()
    const text = '  # 标题\n\n- 列表\n    - 缩进\n\n'
    await expect(new ClipboardWriter(clipboard).write(text)).resolves.toEqual({ ok: true, value: null })
    expect(clipboard.writes).toEqual([text])
  })

  it('accepts a read-back that only differs by CRLF line endings (Windows)', async () => {
    const clipboard = new FakeClipboard()
    clipboard.rewrite = text => text.replace(/\n/g, '\r\n')
    await expect(new ClipboardWriter(clipboard).write('a\nb\n')).resolves.toEqual({ ok: true, value: null })
  })

  it('fails when the read-back differs in any other way', async () => {
    const clipboard = new FakeClipboard()
    clipboard.rewrite = text => text.trim()
    await expect(new ClipboardWriter(clipboard).write(' a ')).resolves.toEqual({
      ok: false,
      error: { code: 'promptx/clipboard/write-failed', detail: 'read-back mismatch' },
    })
  })

  it('reports a write error with the first line of the system message only', async () => {
    const clipboard = new FakeClipboard()
    clipboard.failWrite = new Error('clipboard is locked\nstack details')
    await expect(new ClipboardWriter(clipboard).write('secret prompt')).resolves.toEqual({
      ok: false,
      error: { code: 'promptx/clipboard/write-failed', detail: 'clipboard is locked' },
    })
  })

  it('reports a read-back error as a failed write', async () => {
    const clipboard = new FakeClipboard()
    clipboard.failRead = new Error('read failed')
    const result = await new ClipboardWriter(clipboard).write('x')
    expect(result).toMatchObject({ ok: false, error: { code: 'promptx/clipboard/write-failed' } })
  })

  it('runs copies one after another so a read-back never sees the other write', async () => {
    const clipboard = new FakeClipboard()
    const writer = new ClipboardWriter(clipboard)
    const results = await Promise.all([writer.write('first'), writer.write('second'), writer.write('third')])
    expect(results.every(result => result.ok)).toBe(true)
    expect(clipboard.writes).toEqual(['first', 'second', 'third'])
  })

  it('keeps working after a failed copy', async () => {
    const clipboard = new FakeClipboard()
    const writer = new ClipboardWriter(clipboard)
    clipboard.failWrite = new Error('busy')
    expect((await writer.write('a')).ok).toBe(false)
    clipboard.failWrite = null
    expect((await writer.write('b')).ok).toBe(true)
  })
})
