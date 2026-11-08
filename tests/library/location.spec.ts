import { mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { checkLibraryDir, resolveLibraryDir } from '../../src/config.ts'
import { RECORD_FILE } from '../../src/library/trash.ts'
import { exists, installCrashTraps, listAll, makeService, promptFile, readText, sha256Of, snapshotTree, useTempDirs, writeTree } from './helpers.ts'

installCrashTraps()
const temp = useTempDirs()

// 库目录的位置限制（需求 L-01、S-01、7.10；design-spec 7.4）。字面规则在 config.ts 的 checkLibraryDir，
// 需要读文件系统的部分由 Host 经 checkRoot 传进库服务；库服务自己负责按 realpath 跳过 dsh 自己的目录（审查意见 S13）。
const home = process.platform === 'win32' ? 'C:\\Users\\me' : '/home/me'
const dshHome = join(home, '.dsh')
const ctx = { dshHome, defaultLibrary: join(dshHome, 'promptx', 'library'), home, platform: 'linux' }

describe('library location rules', () => {
  it('uses the default library for an empty value', () => {
    expect(checkLibraryDir('', ctx)).toBeNull()
    expect(checkLibraryDir('   ', ctx)).toBeNull()
    expect(resolveLibraryDir('', ctx)).toBe(ctx.defaultLibrary)
  })

  it('refuses relative paths', () => {
    expect(checkLibraryDir('prompts', ctx)).toBe('library-dir-relative')
    expect(checkLibraryDir('./prompts', ctx)).toBe('library-dir-relative')
  })

  // 审查 H5：手改补丁文件写进去的相对路径原来按 dsh 进程的当前目录解析成绝对路径，库服务的相对路径检查从来不会触发，
  // 库就建在启动 dsh 的目录里（项目仓库里；桌面版的当前目录是 `/`，直接 EACCES）。现在原样交给库服务
  it('leaves a value that is neither absolute nor ~-prefixed unresolved (review H5)', () => {
    expect(resolveLibraryDir('Documents/Prompts', ctx)).toBe('Documents/Prompts')
    expect(resolveLibraryDir('  ./prompts ', ctx)).toBe('./prompts')
    expect(resolveLibraryDir('~user/prompts', ctx)).toBe('~user/prompts')
    expect(isAbsolute(resolveLibraryDir('../prompts', ctx))).toBe(false)
    expect(resolveLibraryDir('~', ctx)).toBe(home)
    expect(resolveLibraryDir(` ${join(home, 'p')} `, ctx)).toBe(join(home, 'p'))
  })

  it('never scans or creates a hand-edited relative library under the working directory (review H5)', async () => {
    const name = `promptx-h5-probe-${process.pid}`
    const configured = resolveLibraryDir(name, ctx)
    try {
      const service = makeService(configured)
      expect(await listAll(service)).toMatchObject({
        state: 'unavailable',
        root: name,
        entries: [],
        error: { code: 'promptx/library/unavailable', detail: 'library-dir-relative' },
      })
      await expect(service.save({ text: '# New\n', binding: null, folder: null, mode: 'normal', requestId: '' }))
        .rejects.toMatchObject({ code: 'promptx/library/unavailable', detail: 'library-dir-relative' })
      await expect(service.read('a.md')).rejects.toMatchObject({ code: 'promptx/library/unavailable', detail: 'library-dir-relative' })
      expect(await exists(resolve(name))).toBe(false)
    } finally {
      // 修复前这里会在当前目录建出库目录，测试结束时清掉
      await rm(resolve(name), { recursive: true, force: true })
    }
  })

  it('expands ~ to the home directory', () => {
    expect(checkLibraryDir('~/prompts', ctx)).toBeNull()
    expect(resolveLibraryDir('~/prompts', ctx)).toBe(join(home, 'prompts'))
  })

  it('refuses the dsh data directory and everything in it except promptx/library', () => {
    expect(checkLibraryDir(dshHome, ctx)).toBe('library-dir-reserved')
    for (const reserved of ['sessions', 'storages', 'profiles', 'cache', join('promptx', 'runtime'), 'promptx']) {
      expect(checkLibraryDir(join(dshHome, reserved), ctx)).toBe('library-dir-reserved')
    }
    expect(checkLibraryDir(join(dshHome, 'promptx', 'library'), ctx)).toBeNull()
    expect(checkLibraryDir(join(dshHome, 'promptx', 'library', '写作'), ctx)).toBeNull()
  })

  it('refuses dsh skill directories, also through ~', () => {
    expect(checkLibraryDir(join(home, 'project', '.dsh', 'skills', 'p'), ctx)).toBe('library-dir-skills')
    expect(checkLibraryDir(join(home, '.agents', 'skills'), ctx)).toBe('library-dir-skills')
    expect(checkLibraryDir('~/.agents/skills/mine', ctx)).toBe('library-dir-skills')
  })

  it('compares case-insensitively on macOS and Windows', () => {
    const mac = { ...ctx, platform: 'darwin' }
    expect(checkLibraryDir(join(home, 'project', '.DSH', 'Skills'), mac)).toBe('library-dir-skills')
    expect(checkLibraryDir(join(dshHome.toUpperCase(), 'SESSIONS'), mac)).toBe('library-dir-reserved')
    expect(checkLibraryDir(join(home, 'project', '.DSH', 'Skills'), ctx)).toBeNull()
  })
})

describe('directories the scan skips (S13)', () => {
  /** 库里套着一个 dsh 数据目录（例如库设成了它的上级目录）：里面有技能文件和 PromptX 自己的目录。 */
  async function libraryAroundDshHome(): Promise<{ root: string; skip: string[] }> {
    const root = await temp.make()
    await writeTree(root, {
      'a.md': promptFile({ id: 'prompt_20261101_000000_abcdef01', title: 'A' }, 'a'),
      'dsh-data/skills/review/SKILL.md': promptFile({ name: 'review' }, 'skill body'),
      'dsh-data/promptx/library/x.md': '# x\n',
    })
    const real = await realpath(root)
    return { root, skip: [join(real, 'dsh-data'), join(real, 'dsh-data', 'skills'), join(real, 'dsh-data', 'promptx')] }
  }

  it('refuses a library whose root is itself on the skip list', async () => {
    const { root, skip } = await libraryAroundDshHome()
    const service = makeService(join(root, 'dsh-data'), { skipRealpaths: () => skip })
    expect(await listAll(service)).toMatchObject({ state: 'unavailable', error: { code: 'promptx/library/unavailable', detail: 'library-dir-reserved' } })
    await expect(service.read('skills/review/SKILL.md')).rejects.toMatchObject({ code: 'promptx/library/unavailable' })
    await expect(service.save({ text: '# New\n', binding: null, folder: null, mode: 'normal', requestId: '' }))
      .rejects.toMatchObject({ code: 'promptx/library/unavailable' })
  })

  it('compares the skip list case-insensitively on macOS and Windows', async () => {
    const { root, skip } = await libraryAroundDshHome()
    const upper = skip.map(path => path.toUpperCase())
    const mac = await listAll(makeService(root, { skipRealpaths: () => upper }, { platform: 'darwin' }))
    expect(mac.entries.map(entry => entry.relPath)).toEqual(['a.md'])
  })

  it('never reads, writes, deletes or saves into a skipped directory', async () => {
    const { root, skip } = await libraryAroundDshHome()
    const service = makeService(root, { skipRealpaths: () => skip })
    expect((await listAll(service)).entries.map(entry => entry.relPath)).toEqual(['a.md'])
    const before = await snapshotTree(root)
    const skill = 'dsh-data/skills/review/SKILL.md'
    const invalid = { code: 'promptx/library/invalid-path' }
    await expect(service.read(skill)).rejects.toMatchObject(invalid)
    await expect(service.delete(skill)).rejects.toMatchObject(invalid)
    await expect(service.updateMeta({ relPath: skill, patch: { favorite: true }, addFrontMatter: true })).rejects.toMatchObject(invalid)
    const content = await readText(root, skill)
    const binding = { libraryDir: root, relPath: skill, id: null, title: 'review', sha256: sha256Of(content), size: Buffer.byteLength(content), savedBody: '' }
    await expect(service.save({ text: 'overwritten', binding, folder: null, mode: 'normal', requestId: '' })).rejects.toMatchObject(invalid)
    await expect(service.save({ text: '# New skill\n', binding: null, folder: 'dsh-data/skills/new', mode: 'normal', requestId: '' })).rejects.toMatchObject(invalid)
    await expect(service.save({ text: '# Into promptx\n', binding: null, folder: 'dsh-data/promptx', mode: 'normal', requestId: '' })).rejects.toMatchObject(invalid)
    expect(await snapshotTree(root)).toEqual(before)
  })

  it('restores to the library root when the recorded original place is inside a skipped directory', async () => {
    const { root, skip } = await libraryAroundDshHome()
    const trashed = '# trashed\n'
    await mkdir(join(root, '_trash'))
    await writeFile(join(root, '_trash', 'SKILL.md'), trashed)
    await writeFile(join(root, '_trash', RECORD_FILE), JSON.stringify({
      version: 1,
      items: [{ file: 'SKILL.md', originalPath: 'dsh-data/skills/other/SKILL.md', deletedAt: '2026-11-01T00:00:00Z', sha256: sha256Of(trashed), size: Buffer.byteLength(trashed) }],
    }))
    const service = makeService(root, { skipRealpaths: () => skip })
    await expect(service.trashRestore({ file: 'SKILL.md', target: 'alternative', alternative: 'dsh-data/skills/x.md', acceptModified: false }))
      .rejects.toMatchObject({ code: 'promptx/library/invalid-path' })
    expect(await service.trashRestore({ file: 'SKILL.md', target: 'original', alternative: null, acceptModified: false }))
      .toEqual({ kind: 'restored', relPath: 'SKILL.md' })
    expect(await readFile(join(root, 'SKILL.md'), 'utf8')).toBe(trashed)
    await expect(readFile(join(root, 'dsh-data', 'skills', 'other', 'SKILL.md'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
