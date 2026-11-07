import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { redirectConsoleToStderr } from '../../../src/app/main/console.ts'
import { companionPaths, readCompanionEnv } from '../../../src/app/main/env.ts'
import { COMPANION_ENV } from '../../../src/shared/protocol.ts'
import { trapProcessErrors } from './helpers.ts'

trapProcessErrors()

const DATA_DIR = join('/', 'tmp', 'dsh-home', 'promptx')

describe('readCompanionEnv', () => {
  it('reads the values the Host computed', () => {
    const result = readCompanionEnv({
      [COMPANION_ENV.dataDir]: DATA_DIR,
      [COMPANION_ENV.profile]: '工作',
      [COMPANION_ENV.profileHash]: '0123456789abcdef',
      [COMPANION_ENV.parentPid]: '4321',
    }, 99)
    expect(result).toEqual({ ok: true, env: { dataDir: DATA_DIR, profile: '工作', profileHash: '0123456789abcdef', parentPid: 4321 } })
  })

  it('refuses to run without an absolute data directory (not started by the Host)', () => {
    expect(readCompanionEnv({}, 99).ok).toBe(false)
    expect(readCompanionEnv({ [COMPANION_ENV.dataDir]: 'relative/promptx' }, 99).ok).toBe(false)
    expect(readCompanionEnv({ [COMPANION_ENV.dataDir]: '   ' }, 99).ok).toBe(false)
  })

  it('never lets the profile hash point the Electron data directory elsewhere', () => {
    for (const hash of ['../../etc', 'a/b', '', 'x'.repeat(65), '名字']) {
      const result = readCompanionEnv({ [COMPANION_ENV.dataDir]: DATA_DIR, [COMPANION_ENV.profileHash]: hash }, 99)
      expect(result.ok && result.env.profileHash).toBe('none')
    }
  })

  it('reads nothing else from the environment: test modes come only from the hello reply (S10)', () => {
    const result = readCompanionEnv({
      [COMPANION_ENV.dataDir]: DATA_DIR,
      PROMPTX_E2E: '1',
      PROMPTX_MODE: 'e2e',
      PROMPTX_LOG_PATH: '/tmp/elsewhere.log',
      DSH_PROMPTX_E2E: '1',
    }, 99)
    expect(result.ok && Object.keys(result.env).sort()).toEqual(['dataDir', 'parentPid', 'profile', 'profileHash'])
  })

  it('falls back to the real parent pid when the Host did not pass one, and ignores bogus values', () => {
    const base = { [COMPANION_ENV.dataDir]: DATA_DIR }
    expect(readCompanionEnv(base, 99)).toMatchObject({ env: { parentPid: 99 } })
    expect(readCompanionEnv({ ...base, [COMPANION_ENV.parentPid]: 'abc' }, 99)).toMatchObject({ env: { parentPid: 99 } })
    expect(readCompanionEnv({ ...base, [COMPANION_ENV.parentPid]: '1' }, 1)).toMatchObject({ env: { parentPid: null } })
    expect(readCompanionEnv({ ...base, [COMPANION_ENV.parentPid]: '-5' }, 0)).toMatchObject({ env: { parentPid: null } })
  })
})

describe('companionPaths', () => {
  it('puts every file under <dsh>/promptx as design-spec 7.7 lists', () => {
    const result = readCompanionEnv({ [COMPANION_ENV.dataDir]: DATA_DIR, [COMPANION_ENV.profileHash]: 'abcdef0123456789' }, 99)
    if (!result.ok) throw new Error('env should be valid')
    expect(companionPaths(result.env)).toEqual({
      prefs: join(DATA_DIR, 'prefs.json'),
      logDir: join(DATA_DIR, 'logs'),
      locksDir: join(DATA_DIR, 'locks'),
      userData: join(DATA_DIR, 'electron', 'abcdef0123456789'),
    })
  })
})

describe('redirectConsoleToStderr', () => {
  it('sends every console method to the given stream so stdout carries only protocol frames', () => {
    const saved = { ...console }
    const sink = new PassThrough()
    let output = ''
    sink.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8')
    })
    try {
      redirectConsoleToStderr(sink)
      console.log('log line')
      console.info('info line')
      console.warn('warn line')
      console.error('error line')
      console.debug('debug line')
    } finally {
      Object.assign(console, saved)
    }
    expect(output).toBe('log line\ninfo line\nwarn line\nerror line\ndebug line\n')
  })
})
