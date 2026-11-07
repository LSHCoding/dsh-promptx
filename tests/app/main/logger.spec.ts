import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  errorCode,
  FileLogger,
  formatLogLine,
  formatLogValue,
  LOG_FILE_NAME,
  LOG_KEEP_FILES,
  LOG_MAX_BYTES,
} from '../../../src/app/main/logger.ts'
import { PromptxError } from '../../../src/shared/errors.ts'
import { RpcError } from '../../../src/shared/rpc.ts'
import { trapProcessErrors, useTempDir } from './helpers.ts'

trapProcessErrors()
const tempDir = useTempDir('logs')

/** 哨兵字符串：任何一处日志里出现它，就说明内容漏进了日志（N-02，testing-plan no-content-logs）。 */
const SENTINEL = 'PROMPTX_SENTINEL_写作助手 secret'
const TIME = new Date('2026-11-08T01:02:03.004Z')

describe('formatLogValue', () => {
  it('writes numbers, booleans, null and identifier-like strings as they are', () => {
    expect(formatLogValue(12.345)).toBe('12.35')
    expect(formatLogValue(Number.NaN)).toBe('NaN')
    expect(formatLogValue(true)).toBe('true')
    expect(formatLogValue(null)).toBe('null')
    expect(formatLogValue(undefined)).toBe('undefined')
    expect(formatLogValue('promptx/shortcut/taken')).toBe('promptx/shortcut/taken')
    expect(formatLogValue('draft.save')).toBe('draft.save')
    expect(formatLogValue('Control+Alt+P')).toBe('Control+Alt+P')
    expect(formatLogValue('44.10.2')).toBe('44.10.2')
    expect(formatLogValue('')).toBe('""')
  })

  it('redacts anything that could be content', () => {
    expect(formatLogValue(SENTINEL)).toBe('[redacted]')
    expect(formatLogValue('two words')).toBe('[redacted]')
    expect(formatLogValue('中文')).toBe('[redacted]')
    expect(formatLogValue('a'.repeat(81))).toBe('[redacted]')
    expect(formatLogValue('line\nbreak')).toBe('[redacted]')
    expect(formatLogValue({ text: SENTINEL })).toBe('[object]')
    expect(formatLogValue([SENTINEL])).toBe('[object]')
  })

  it('writes errors as their code, never their message', () => {
    expect(formatLogValue(new Error(SENTINEL))).toBe('Error')
  })
})

describe('errorCode', () => {
  it('uses the business code of PromptxError and RpcError', () => {
    expect(errorCode(new PromptxError('promptx/draft/unreadable', SENTINEL))).toBe('promptx/draft/unreadable')
    expect(errorCode(new RpcError(-32010, { code: 'promptx/library/not-found', detail: SENTINEL }))).toBe('promptx/library/not-found')
    expect(errorCode(new RpcError(-32010, { code: SENTINEL }))).toBe('RpcError')
  })

  it('uses the class name and errno code of system errors', () => {
    const error = Object.assign(new Error(`EACCES: permission denied, open '/x/${SENTINEL}'`), { code: 'EACCES' })
    expect(errorCode(error)).toBe('Error:EACCES')
    expect(errorCode(new SyntaxError(`Unexpected token in JSON at "${SENTINEL}"`))).toBe('SyntaxError')
    expect(errorCode(SENTINEL)).toBe('non-error')
  })
})

describe('formatLogLine', () => {
  it('writes time, pid, level, event and fields on one line', () => {
    expect(formatLogLine(TIME, 4242, 'INFO', 'call.slow', { method: 'library.list', ms: 1234.5 })).toBe(
      '2026-11-08T01:02:03.004Z 4242 INFO call.slow method=library.list ms=1234.5\n',
    )
  })

  it('drops fields with unsafe names and redacts unsafe event names', () => {
    expect(formatLogLine(TIME, 1, 'WARN', SENTINEL, { [SENTINEL]: 1, ok: true })).toBe(
      '2026-11-08T01:02:03.004Z 1 WARN [redacted] ok=true\n',
    )
  })
})

describe('FileLogger', () => {
  const dir = (): string => join(tempDir(), 'logs')

  it('creates the directory and appends lines to companion.log', () => {
    const logger = new FileLogger({ dir: dir(), now: () => TIME, pid: 7 })
    logger.info('start', { electron: '44.10.2' })
    logger.warn('shortcut.failed', { code: 'promptx/shortcut/taken' })
    logger.error('hello.failed', { error: new Error(SENTINEL) })
    expect(logger.file).toBe(join(dir(), LOG_FILE_NAME))
    expect(readFileSync(logger.file, 'utf8')).toBe([
      '2026-11-08T01:02:03.004Z 7 INFO start electron=44.10.2',
      '2026-11-08T01:02:03.004Z 7 WARN shortcut.failed code=promptx/shortcut/taken',
      '2026-11-08T01:02:03.004Z 7 ERROR hello.failed error=Error',
      '',
    ].join('\n'))
  })

  it('never writes content, whatever the caller passes', () => {
    const logger = new FileLogger({ dir: dir() })
    logger.info('call.failed', { method: 'draft.save', text: SENTINEL, nested: { body: SENTINEL } })
    logger.warn(SENTINEL, { error: new PromptxError('promptx/internal', SENTINEL) })
    logger.error('x', { [SENTINEL]: SENTINEL })
    expect(readFileSync(logger.file, 'utf8')).not.toContain('SENTINEL')
  })

  it('echoes warnings and errors (to stderr in the app) but not info lines', () => {
    const echoed: string[] = []
    const logger = new FileLogger({ dir: dir(), now: () => TIME, pid: 1, echo: line => echoed.push(line) })
    logger.info('a')
    logger.warn('b')
    logger.error('c')
    expect(echoed).toEqual(['2026-11-08T01:02:03.004Z 1 WARN b\n', '2026-11-08T01:02:03.004Z 1 ERROR c\n'])
  })

  it('keeps writing to the file when the echo throws', () => {
    const logger = new FileLogger({
      dir: dir(),
      echo: () => {
        throw new Error('EPIPE')
      },
    })
    logger.warn('still.logged')
    expect(readFileSync(logger.file, 'utf8')).toContain('still.logged')
  })

  it('rotates at the size limit and keeps three files in all', () => {
    const logger = new FileLogger({ dir: dir(), maxBytes: 200, now: () => TIME, pid: 1 })
    for (let i = 0; i < 40; i++) logger.info('rotation.test', { index: i })
    const files = readdirSync(dir()).sort()
    expect(files).toEqual([LOG_FILE_NAME, `${LOG_FILE_NAME}.1`, `${LOG_FILE_NAME}.2`])
    for (const file of files) expect(statSync(join(dir(), file)).size).toBeLessThanOrEqual(200)
    // 最新的一行在当前文件里，较早的行在 .1、.2 里，最老的已经删掉。
    expect(readFileSync(join(dir(), LOG_FILE_NAME), 'utf8')).toContain('index=39')
    expect(readFileSync(join(dir(), `${LOG_FILE_NAME}.2`), 'utf8')).not.toContain('index=0\n')
  })

  it('uses 1 MiB and three files by default (design-spec 7.7)', () => {
    expect(LOG_MAX_BYTES).toBe(1024 * 1024)
    expect(LOG_KEEP_FILES).toBe(3)
  })

  it('counts an existing file towards the limit after a restart', () => {
    const existing = join(tempDir(), 'logs-existing')
    const first = new FileLogger({ dir: existing, maxBytes: 120, now: () => TIME, pid: 1 })
    first.info('first.process', { index: 1 })
    first.info('first.process', { index: 2 })
    const second = new FileLogger({ dir: existing, maxBytes: 120, now: () => TIME, pid: 2 })
    second.info('second.process', { index: 3 })
    expect(existsSync(join(existing, `${LOG_FILE_NAME}.1`))).toBe(true)
    expect(readFileSync(join(existing, LOG_FILE_NAME), 'utf8')).toContain('second.process')
  })

  it('swallows file errors so logging can never break the app', () => {
    const blocker = join(tempDir(), 'blocker')
    writeFileSync(blocker, 'x')
    const logger = new FileLogger({ dir: join(blocker, 'logs') })
    expect(() => {
      logger.info('cannot.write')
      logger.error('still.cannot')
    }).not.toThrow()
  })
})
