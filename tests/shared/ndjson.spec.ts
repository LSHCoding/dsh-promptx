import { describe, expect, it } from 'vitest'
import { encodeFrame, FrameDecoder, type FrameRejection } from '../../src/shared/ndjson.ts'

const enc = new TextEncoder()

function collect(maxFrameBytes = 1024) {
  const frames: unknown[] = []
  const rejects: FrameRejection[] = []
  const decoder = new FrameDecoder({ maxFrameBytes, onFrame: v => frames.push(v), onReject: r => rejects.push(r) })
  return { decoder, frames, rejects }
}

describe('FrameDecoder', () => {
  it('decodes frames split across chunks and merged in one chunk', () => {
    const { decoder, frames } = collect()
    const text = encodeFrame({ a: 1 }) + encodeFrame({ b: '两' }) + encodeFrame([3])
    const bytes = enc.encode(text)
    for (let i = 0; i < bytes.length; i += 3) decoder.push(bytes.subarray(i, i + 3))
    expect(frames).toEqual([{ a: 1 }, { b: '两' }, [3]])
  })

  it('keeps a multibyte character split between chunks intact', () => {
    const { decoder, frames } = collect()
    const bytes = enc.encode(encodeFrame({ s: '中文🙂' }))
    const cut = bytes.indexOf(0xe4) + 1 // 切在「中」的第一个字节之后
    decoder.push(bytes.subarray(0, cut))
    decoder.push(bytes.subarray(cut))
    expect(frames).toEqual([{ s: '中文🙂' }])
  })

  it('tolerates CRLF line endings', () => {
    const { decoder, frames } = collect()
    decoder.push(enc.encode('{"x":1}\r\n{"y":2}\r\n'))
    expect(frames).toEqual([{ x: 1 }, { y: 2 }])
  })

  it('rejects invalid JSON, invalid UTF-8 and empty lines without stopping', () => {
    const { decoder, frames, rejects } = collect()
    decoder.push(enc.encode('not json\n\n'))
    decoder.push(new Uint8Array([0xff, 0xfe, 0x0a]))
    decoder.push(enc.encode('{"ok":true}\n'))
    expect(rejects).toEqual(['invalid-json', 'empty', 'invalid-utf8'])
    expect(frames).toEqual([{ ok: true }])
    expect(decoder.rejected).toBe(3)
  })

  it('discards an oversized line up to its newline and resumes with the next frame', () => {
    const { decoder, frames, rejects } = collect(16)
    decoder.push(enc.encode('{"long":"aaaaaaaa'))
    decoder.push(enc.encode('aaaaaaaaaaaaaaaaaa"}'))
    // 超长那一行的剩余部分不能被当成新的帧
    decoder.push(enc.encode('{"tail":1}\n{"n":2}\n'))
    expect(rejects).toEqual(['oversized'])
    expect(frames).toEqual([{ n: 2 }])
  })

  it('drops an unterminated trailing fragment on end()', () => {
    const { decoder, frames } = collect()
    decoder.push(enc.encode('{"a":1}\n{"b":'))
    decoder.end()
    decoder.push(enc.encode('{"c":3}\n'))
    expect(frames).toEqual([{ a: 1 }, { c: 3 }])
  })

  it('encodes values on a single line even when strings contain newlines', () => {
    const line = encodeFrame({ text: 'a\nb\r\nc' })
    expect(line.endsWith('\n')).toBe(true)
    expect(line.slice(0, -1).includes('\n')).toBe(false)
  })
})
