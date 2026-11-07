import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { installStdioGuard, isBrokenPipe } from '../../../src/app/main/stdio-guard.ts'

describe('installStdioGuard', () => {
  it('stops writing stderr after a broken pipe and reports it once', async () => {
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    const guard = installStdioGuard({ stdout, stderr })
    const reports: string[] = []
    guard.onBroken((stream, code) => {
      reports.push(`${stream}:${code}`)
    })
    let written = ''
    stderr.on('data', (chunk: Buffer) => {
      written += chunk.toString('utf8')
    })
    guard.writeStderr('before\n')
    stderr.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }))
    stdout.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }))
    guard.writeStderr('after\n')
    await new Promise(r => setTimeout(r, 0))
    expect(written).toBe('before\n')
    expect(guard.stderrAlive()).toBe(false)
    expect(reports).toEqual(['stderr:EPIPE'])
  })

  it('recognizes broken pipe errors', () => {
    expect(isBrokenPipe(Object.assign(new Error('x'), { code: 'EPIPE' }))).toBe(true)
    expect(isBrokenPipe(Object.assign(new Error('x'), { code: 'ERR_STREAM_DESTROYED' }))).toBe(true)
    expect(isBrokenPipe(new Error('boom'))).toBe(false)
  })
})
