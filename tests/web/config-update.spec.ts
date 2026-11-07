import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { PromptxError } from '../../src/shared/errors.ts'
import type { PromptxConfig } from '../../src/shared/types.ts'
import { checkLibraryLocation, checkLibraryRoot, createConfigUpdater, MAX_INSTRUCTION_LENGTH } from '../../src/web/config-update.ts'
import type { LocationContext } from '../../src/web/config-update.ts'
import { trapUnexpectedErrors } from './fixtures.ts'

trapUnexpectedErrors()

// Windows 上建符号链接需要额外权限，相关用例只在 macOS、Linux 上跑。
const canSymlink = process.platform !== 'win32'

let tmp: string
let home: string
let dshHome: string

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'promptx-config-'))
  home = join(tmp, 'home')
  dshHome = join(home, '.dsh')
  await mkdir(join(dshHome, 'sessions'), { recursive: true })
  await mkdir(join(dshHome, 'promptx', 'library'), { recursive: true })
  await mkdir(join(home, '.agents', 'skills'), { recursive: true })
  await mkdir(join(tmp, 'agents-env', 'skills'), { recursive: true })
  if (canSymlink) {
    await symlink(join(dshHome, 'sessions'), join(home, 'link-to-sessions'))
    await symlink(join(dshHome, 'promptx', 'library'), join(home, 'link-to-library'))
    await symlink(join(home, '.agents', 'skills'), join(home, 'link-to-skills'))
    await symlink(dshHome, join(tmp, 'dsh-alias'))
  }
})

afterAll(async () => {
  await rm(tmp, { recursive: true, force: true })
})

function ctx(overrides: Partial<LocationContext> = {}): LocationContext {
  return {
    dshHome,
    defaultLibrary: join(dshHome, 'promptx', 'library'),
    home,
    platform: 'linux',
    env: {},
    ...overrides,
  }
}

// ───────────────────────────── 库目录的位置限制（design-spec 7.4） ─────────────────────────────

describe('checkLibraryLocation', () => {
  it('accepts the default (empty) value, absolute paths and ~ paths outside dsh', async () => {
    await expect(checkLibraryLocation('', ctx())).resolves.toBeNull()
    await expect(checkLibraryLocation('~/prompts', ctx())).resolves.toBeNull()
    await expect(checkLibraryLocation(join(tmp, 'elsewhere', 'prompts'), ctx())).resolves.toBeNull()
    await expect(checkLibraryLocation(join(dshHome, 'promptx', 'library', 'work'), ctx())).resolves.toBeNull()
  })

  it('rejects relative paths', async () => {
    await expect(checkLibraryLocation('prompts', ctx())).resolves.toBe('library-dir-relative')
    await expect(checkLibraryLocation('./prompts', ctx())).resolves.toBe('library-dir-relative')
  })

  it('rejects the dsh data directory and everything in it except promptx/library', async () => {
    for (const path of [dshHome, join(dshHome, 'sessions'), join(dshHome, 'promptx'), join(dshHome, 'promptx', 'runtime'), join(dshHome, 'storages', 'x')]) {
      await expect(checkLibraryLocation(path, ctx()), path).resolves.toBe('library-dir-reserved')
    }
    await expect(checkLibraryLocation('~/.dsh/sessions', ctx())).resolves.toBe('library-dir-reserved')
  })

  it('rejects a directory that contains the dsh data directory unless a dot segment lies in between', async () => {
    const data = join(tmp, 'data')
    const plainHome = join(data, 'dsh')
    const plain = ctx({ dshHome: plainHome, defaultLibrary: join(plainHome, 'promptx', 'library') })
    await expect(checkLibraryLocation(data, plain)).resolves.toBe('library-dir-reserved')
    await expect(checkLibraryLocation(tmp, plain)).resolves.toBe('library-dir-reserved')
    // 库设成用户主目录、数据目录是 ~/.dsh：扫描会跳过 .dsh，可以。
    await expect(checkLibraryLocation('~', ctx())).resolves.toBeNull()
    await expect(checkLibraryLocation(home, ctx())).resolves.toBeNull()
  })

  it('rejects .dsh/skills and .agents/skills anywhere in the path', async () => {
    await expect(checkLibraryLocation('~/.dsh/skills', ctx())).resolves.toBe('library-dir-skills')
    await expect(checkLibraryLocation(join(tmp, 'project', '.agents', 'skills', 'x'), ctx())).resolves.toBe('library-dir-skills')
    await expect(checkLibraryLocation(join(tmp, 'project', '.dsh', 'skills'), ctx())).resolves.toBe('library-dir-skills')
  })

  it('rejects the skills folder of every agents home: configured, DSH_AGENTS_HOME and the default', async () => {
    const envHome = join(tmp, 'agents-env')
    await expect(checkLibraryLocation(join(envHome, 'skills', 'p'), ctx({ env: { DSH_AGENTS_HOME: envHome } }))).resolves.toBe('library-dir-skills')
    await expect(checkLibraryLocation(join(envHome, 'other'), ctx({ env: { DSH_AGENTS_HOME: envHome } }))).resolves.toBeNull()
    // 空白的 DSH_AGENTS_HOME 视为没设置（和 dsh-home-paths 一致）。
    await expect(checkLibraryLocation(join(envHome, 'skills'), ctx({ env: { DSH_AGENTS_HOME: '   ' } }))).resolves.toBeNull()
    const configured = join(tmp, 'configured-agents')
    await expect(checkLibraryLocation(join(configured, 'skills'), ctx({ agentsHome: configured }))).resolves.toBe('library-dir-skills')
    await expect(checkLibraryLocation(join(configured, 'skills', 'deep', 'er'), ctx({ agentsHome: '  ' + configured }))).resolves.toBe('library-dir-skills')
  })

  it('rejects custom skill directories configured in dsh-skill-filesystem, including ~ paths', async () => {
    const custom = join(tmp, 'my-skills')
    const context = ctx({ extraSkillDirs: [custom, '~/team-skills', '  '] })
    await expect(checkLibraryLocation(custom, context)).resolves.toBe('library-dir-skills')
    await expect(checkLibraryLocation(join(custom, 'deep', 'x'), context)).resolves.toBe('library-dir-skills')
    await expect(checkLibraryLocation(join(home, 'team-skills', 'p'), context)).resolves.toBe('library-dir-skills')
    await expect(checkLibraryLocation(join(tmp, 'my-skills-not'), context)).resolves.toBeNull()
  })

  it.skipIf(!canSymlink)('follows symlinks to the real location, also below directories that do not exist yet', async () => {
    await expect(checkLibraryLocation(join(home, 'link-to-sessions'), ctx())).resolves.toBe('library-dir-reserved')
    await expect(checkLibraryLocation(join(home, 'link-to-sessions', 'not', 'yet'), ctx())).resolves.toBe('library-dir-reserved')
    await expect(checkLibraryLocation(join(home, 'link-to-skills', 'x'), ctx())).resolves.toBe('library-dir-skills')
    // 指向默认库目录的链接可以用。
    await expect(checkLibraryLocation(join(home, 'link-to-library', 'work'), ctx())).resolves.toBeNull()
  })

  it.skipIf(!canSymlink)('compares against the real dsh data directory when it is given through an alias', async () => {
    const alias = join(tmp, 'dsh-alias')
    const viaAlias = ctx({ dshHome: alias, defaultLibrary: join(alias, 'promptx', 'library') })
    await expect(checkLibraryLocation(join(dshHome, 'sessions'), viaAlias)).resolves.toBe('library-dir-reserved')
    await expect(checkLibraryLocation(join(dshHome, 'promptx', 'library', 'x'), viaAlias)).resolves.toBeNull()
  })

  it('ignores case on macOS and Windows but not on Linux', async () => {
    // 用不存在的目录，避免宿主文件系统自己的大小写规则干扰（realpath 会返回磁盘上的写法）。
    const mixed = join(tmp, 'Case', 'DshHome')
    const lower = join(tmp, 'case', 'dshhome', 'sessions')
    const base = { dshHome: mixed, defaultLibrary: join(mixed, 'promptx', 'library') }
    await expect(checkLibraryLocation(lower, ctx({ ...base, platform: 'darwin' }))).resolves.toBe('library-dir-reserved')
    await expect(checkLibraryLocation(lower, ctx({ ...base, platform: 'win32' }))).resolves.toBe('library-dir-reserved')
    await expect(checkLibraryLocation(lower, ctx({ ...base, platform: 'linux' }))).resolves.toBeNull()
    await expect(checkLibraryLocation(join(tmp, 'Project', '.AGENTS', 'Skills'), ctx({ platform: 'darwin' }))).resolves.toBe('library-dir-skills')
  })
})

describe('checkLibraryRoot', () => {
  it('returns null for a usable root and promptx/library/unavailable with the reason otherwise', async () => {
    await expect(checkLibraryRoot(join(dshHome, 'promptx', 'library'), ctx())).resolves.toBeNull()
    await expect(checkLibraryRoot(join(tmp, 'prompts'), ctx())).resolves.toBeNull()
    await expect(checkLibraryRoot(join(dshHome, 'sessions'), ctx())).resolves.toEqual({ code: 'promptx/library/unavailable', detail: 'library-dir-reserved' })
    await expect(checkLibraryRoot(join(home, '.agents', 'skills'), ctx())).resolves.toEqual({ code: 'promptx/library/unavailable', detail: 'library-dir-skills' })
  })
})

// ───────────────────────────── 保存配置 ─────────────────────────────

function updater(options: { apply?: (patch: Partial<PromptxConfig>) => Promise<void>; context?: () => LocationContext } = {}) {
  const applied: Array<Partial<PromptxConfig>> = []
  const locationContext = vi.fn(options.context ?? (() => ctx()))
  const update = createConfigUpdater({
    locationContext,
    apply: options.apply ?? ((patch) => {
      applied.push(patch)
      return Promise.resolve()
    }),
  })
  return { update, applied, locationContext }
}

describe('createConfigUpdater', () => {
  it('applies a valid patch once, normalized', async () => {
    const { update, applied } = updater()
    await expect(update({
      libraryDir: '  ~/prompts  ',
      confirmDelete: false,
      optimizeInstruction: '  \n\t',
      globalShortcut: 'alt+ctrl+p',
      hideOnBlur: true,
      runtimeSource: 'mirror',
    })).resolves.toEqual({ ok: true })
    expect(applied).toEqual([{
      libraryDir: '~/prompts',
      confirmDelete: false,
      optimizeInstruction: '',
      globalShortcut: 'Control+Alt+P',
      hideOnBlur: true,
      runtimeSource: 'mirror',
    }])
  })

  it('keeps a real instruction exactly as written and stores an empty shortcut as disabled', async () => {
    const { update, applied } = updater()
    await update({ optimizeInstruction: '  请改写得更简洁。\n', globalShortcut: '   ' })
    expect(applied).toEqual([{ optimizeInstruction: '  请改写得更简洁。\n', globalShortcut: '' }])
  })

  it('keeps the canonical shortcut used by the end-to-end script unchanged', async () => {
    const { update, applied } = updater()
    await update({ globalShortcut: 'Control+Alt+Shift+F9' })
    expect(applied).toEqual([{ globalShortcut: 'Control+Alt+Shift+F9' }])
  })

  it('writes nothing when any field is invalid and reports every invalid field', async () => {
    const { update, applied } = updater()
    await expect(update({ libraryDir: 'relative/dir', hideOnBlur: true, globalShortcut: 'P', runtimeSource: 'auto' })).resolves.toEqual({
      ok: false,
      errors: { libraryDir: 'library-dir-relative', globalShortcut: 'shortcut-invalid' },
    })
    await expect(update({ libraryDir: join(dshHome, 'sessions'), confirmDelete: true })).resolves.toEqual({
      ok: false,
      errors: { libraryDir: 'library-dir-reserved' },
    })
    await expect(update({ libraryDir: '~/.agents/skills/prompts' })).resolves.toEqual({ ok: false, errors: { libraryDir: 'library-dir-skills' } })
    await expect(update({ globalShortcut: 'Shift+A' })).resolves.toEqual({ ok: false, errors: { globalShortcut: 'shortcut-invalid' } })
    expect(applied).toEqual([])
  })

  it('reports value-invalid for wrong types and out-of-range values', async () => {
    const { update, applied } = updater()
    await expect(update({
      libraryDir: 5,
      confirmDelete: 'yes',
      optimizeInstruction: null,
      globalShortcut: false,
      hideOnBlur: 1,
      runtimeSource: 'cdn',
    })).resolves.toEqual({
      ok: false,
      errors: {
        libraryDir: 'value-invalid',
        confirmDelete: 'value-invalid',
        optimizeInstruction: 'value-invalid',
        globalShortcut: 'value-invalid',
        hideOnBlur: 'value-invalid',
        runtimeSource: 'value-invalid',
      },
    })
    await expect(update({ optimizeInstruction: 'x'.repeat(MAX_INSTRUCTION_LENGTH + 1) })).resolves.toEqual({
      ok: false,
      errors: { optimizeInstruction: 'value-invalid' },
    })
    await expect(update({ libraryDir: '/tmp/a\0b' })).resolves.toEqual({ ok: false, errors: { libraryDir: 'value-invalid' } })
    expect(applied).toEqual([])
  })

  it('rejects unknown fields and non-object patches as a whole', async () => {
    const { update, applied } = updater()
    for (const patch of [{ libraryDir: '~/p', theme: 'dark' }, null, [], 'patch', 1, Object.create({ hideOnBlur: true }) as unknown]) {
      const result = await update(patch)
      expect(result.ok, JSON.stringify(patch)).toBe(false)
      expect(result).toMatchObject({ errors: {}, error: { code: 'promptx/internal' } })
    }
    expect(applied).toEqual([])
  })

  it('does not touch the settings for an empty patch and only reads the location context when needed', async () => {
    const { update, applied, locationContext } = updater()
    await expect(update({})).resolves.toEqual({ ok: true })
    await update({ hideOnBlur: true })
    expect(locationContext).not.toHaveBeenCalled()
    expect(applied).toEqual([{ hideOnBlur: true }])
  })

  it('reports a failed write as promptx/settings/unavailable with the first line of the system message', async () => {
    const failing = updater({ apply: () => Promise.reject(new Error('Config field "promptx.x" is not volatile\n    at write')) })
    await expect(failing.update({ hideOnBlur: true })).resolves.toEqual({
      ok: false,
      errors: {},
      error: { code: 'promptx/settings/unavailable', detail: 'Config field "promptx.x" is not volatile' },
    })
    const business = updater({ apply: () => Promise.reject(new PromptxError('promptx/internal')) })
    await expect(business.update({ hideOnBlur: true })).resolves.toEqual({ ok: false, errors: {}, error: { code: 'promptx/settings/unavailable' } })
  })

  it('reports promptx/settings/unavailable when the location context cannot be read', async () => {
    const { update, applied } = updater({
      context: () => {
        throw new Error('configEditor disposed')
      },
    })
    await expect(update({ libraryDir: '~/prompts' })).resolves.toEqual({
      ok: false,
      errors: {},
      error: { code: 'promptx/settings/unavailable', detail: 'configEditor disposed' },
    })
    expect(applied).toEqual([])
  })
})
