import { describe, expect, it } from 'vitest'
import { isOpenableUrl, planSettingsOpen } from '../../../src/app/main/settings.ts'
import { trapProcessErrors } from './helpers.ts'

trapProcessErrors()

describe('isOpenableUrl', () => {
  it('allows dsh and web addresses only', () => {
    expect(isOpenableUrl('dsh://open')).toBe(true)
    expect(isOpenableUrl('http://127.0.0.1:5173/?token=abc')).toBe(true)
    expect(isOpenableUrl('https://dsh.example.test/')).toBe(true)
    expect(isOpenableUrl('file:///Applications/Calculator.app')).toBe(false)
    expect(isOpenableUrl('javascript:alert(1)')).toBe(false)
    expect(isOpenableUrl('smb://share/x')).toBe(false)
    expect(isOpenableUrl('not a url')).toBe(false)
  })
})

describe('planSettingsOpen', () => {
  it('opens dsh://open on the desktop app and hides at once', () => {
    expect(planSettingsOpen({ open: 'dsh://open', navigated: true }, 'window')).toEqual({ openUrl: 'dsh://open', hide: 'now', error: null })
    expect(planSettingsOpen({ open: 'dsh://open', navigated: false }, 'tray')).toEqual({ openUrl: 'dsh://open', hide: 'now', error: null })
  })

  it('opens the web address when no dsh page is online', () => {
    const url = 'http://127.0.0.1:4096/?token=t'
    expect(planSettingsOpen({ open: url, navigated: false }, 'window')).toEqual({ openUrl: url, hide: 'now', error: null })
  })

  it('keeps the window for the toast when a page switched to the settings (window button)', () => {
    expect(planSettingsOpen({ open: null, navigated: true }, 'window')).toEqual({ openUrl: null, hide: 'delayed', error: null })
  })

  it('hides at once from the tray, where nobody would see the toast', () => {
    expect(planSettingsOpen({ open: null, navigated: true }, 'tray')).toEqual({ openUrl: null, hide: 'now', error: null })
  })

  it('still hides when there is nothing to open (the request stays valid for 60 s)', () => {
    expect(planSettingsOpen({ open: null, navigated: false }, 'window')).toEqual({ openUrl: null, hide: 'now', error: null })
  })

  it('refuses addresses that are not dsh or http(s) and keeps the window', () => {
    expect(planSettingsOpen({ open: 'file:///etc/passwd', navigated: false }, 'window')).toEqual({
      openUrl: null,
      hide: 'none',
      error: { code: 'promptx/settings/unavailable', detail: 'unsupported url' },
    })
  })
})
