import { createHash } from 'node:crypto'
import { chmod, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import type { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import { afterEach, describe, expect, it } from 'vitest'
import { createDraftService } from '../../src/draft/service.ts'
import type { DraftApi } from '../../src/services.ts'
import type { Binding, DraftRecord } from '../../src/shared/types.ts'
import { canTestPermissions, exists, installCrashTraps, useTempDirs } from '../library/helpers.ts'

installCrashTraps()
const temp = useTempDirs()

const HASH = '0123456789abcdef'
const OTHER_HASH = 'fedcba9876543210'
const NOW = new Date('2026-11-08T12:00:00.000Z')

interface Stack {
  facility: DomainFacility
  dispose: () => Promise<void>
}

const stacks: Stack[] = []
const services: DraftApi[] = []

afterEach(async () => {
  for (const service of services.splice(0)) await service.close()
  for (const stack of stacks.splice(0)) await stack.dispose()
})

/** 真实的 dsh 存储栈：存储中心 + JSON 后端（root 是临时目录）+ 领域存储，按各包 README 的组合方式加载。 */
async function createStack(root: string): Promise<Stack> {
  const ctx = new Context()
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root })
  await ctx.plugin(StorageDomain, { backend: 'json' })
  const facility = ctx.get('storageDomain')
  if (facility === undefined) throw new Error('storageDomain was not provided')
  const stack = { facility, dispose: async () => { await ctx.fiber.dispose() } }
  stacks.push(stack)
  return stack
}

function draftService(stack: Stack, hash = HASH, name = 'promptx-dev'): DraftApi {
  const service = createDraftService({ facility: stack.facility, profile: { name, hash }, now: () => NOW })
  services.push(service)
  return service
}

/** 和 Host 一样由 profile 名得到哈希：UTF-8 的 SHA-256 前 16 位小写十六进制（design-spec 4.5）。 */
function profileHashOf(name: string): string {
  return createHash('sha256').update(name, 'utf8').digest('hex').slice(0, 16)
}

function unitFile(root: string, hash = HASH): string {
  return join(root, `promptx_draft_${hash}.json`)
}

const BINDING: Binding = {
  libraryDir: '/Users/me/.dsh/promptx/library',
  relPath: '写作/代码审查清单.md',
  id: 'prompt_20261107_120000_1a2b3c4d',
  title: '代码审查清单',
  sha256: 'a'.repeat(64),
  size: 1234,
  savedBody: '# 代码审查\n',
}

function recordOf(text: string): DraftRecord {
  return { version: 1, text, selection: { anchor: 1, head: 3 }, binding: BINDING, updatedAt: NOW.toISOString() }
}

function unitDocument(record: unknown, version = 1, hash = HASH): string {
  return `${JSON.stringify({ unit: { name: `promptx_draft_${hash}`, version }, global: null, tables: { draft: { current: record } } }, null, 2)}\n`
}

describe('draft service (E-02, F-01, design-spec 4.5)', () => {
  it('starts empty, saves a record and reads it back after a restart', async () => {
    const root = await temp.make()
    const first = draftService(await createStack(root))
    expect(await first.load()).toBeNull()
    expect(await first.save({ text: '草稿\n第二行', selection: { anchor: 1, head: 3 }, binding: BINDING })).toEqual({ updatedAt: NOW.toISOString() })
    const onDisk = JSON.parse(await readFile(unitFile(root), 'utf8')) as { unit: { name: string; version: number } }
    expect(onDisk.unit).toEqual({ name: `promptx_draft_${HASH}`, version: 1 })

    const second = draftService(await createStack(root), HASH)
    await first.close()
    expect(await second.load()).toEqual(recordOf('草稿\n第二行'))
  })

  it('keeps exactly the DraftRecord fields', async () => {
    const root = await temp.make()
    const service = draftService(await createStack(root))
    await service.load()
    await service.save({ text: 'x', selection: null, binding: null })
    const stored = JSON.parse(await readFile(unitFile(root), 'utf8')) as { tables: { draft: { current: unknown } } }
    expect(stored.tables.draft.current).toEqual({ version: 1, text: 'x', selection: null, binding: null, updatedAt: NOW.toISOString() })
  })

  it('refuses to save before a successful load in this process', async () => {
    const root = await temp.make()
    const service = draftService(await createStack(root))
    await expect(service.save({ text: 'x', selection: null, binding: null })).rejects.toMatchObject({ code: 'promptx/draft/unreadable', detail: 'not-loaded' })
    expect(await exists(unitFile(root))).toBe(false)
  })

  it.each([
    ['malformed JSON', '{ "unit": ', 'malformed-medium'],
    ['a version 2 stamp', unitDocument(recordOf('newer'), 2), 'version-mismatch'],
    ['a record that fails the schema', unitDocument({ ...recordOf('x'), text: 5 }), 'invalid-record'],
    ['a foreign unit header', unitDocument(recordOf('x'), 1, 'aaaaaaaaaaaaaaaa'), 'malformed-medium'],
  ])('reports %s as unreadable and never overwrites it', async (_label, content, code) => {
    const root = await temp.make()
    await writeFile(unitFile(root), content)
    const service = draftService(await createStack(root))
    await expect(service.load()).rejects.toMatchObject({ code: 'promptx/draft/unreadable', detail: code })
    await expect(service.save({ text: '', selection: null, binding: null })).rejects.toMatchObject({ code: 'promptx/draft/unreadable' })
    await expect(service.load()).rejects.toMatchObject({ code: 'promptx/draft/unreadable' })
    expect(await readFile(unitFile(root), 'utf8')).toBe(content)
  })

  it('reports a record file without read permission as unreadable (POSIX)', async (ctx) => {
    if (!canTestPermissions) ctx.skip()
    const root = await temp.make()
    const content = unitDocument(recordOf('secret draft'))
    await writeFile(unitFile(root), content)
    await chmod(unitFile(root), 0o000)
    const service = draftService(await createStack(root))
    await expect(service.load()).rejects.toMatchObject({ code: 'promptx/draft/unreadable', detail: 'EACCES' })
    await expect(service.save({ text: '', selection: null, binding: null })).rejects.toMatchObject({ code: 'promptx/draft/unreadable' })
    await chmod(unitFile(root), 0o644)
    expect(await readFile(unitFile(root), 'utf8')).toBe(content)
  })

  it('retries the open on the next load once the file is fixed', async () => {
    const root = await temp.make()
    await writeFile(unitFile(root), 'garbage')
    const service = draftService(await createStack(root))
    await expect(service.load()).rejects.toMatchObject({ code: 'promptx/draft/unreadable' })
    await writeFile(unitFile(root), unitDocument(recordOf('recovered')))
    expect(await service.load()).toEqual(recordOf('recovered'))
    await service.save({ text: 'after retry', selection: null, binding: null })
    expect((JSON.parse(await readFile(unitFile(root), 'utf8')) as { tables: { draft: { current: DraftRecord } } }).tables.draft.current.text).toBe('after retry')
  })

  it('keeps profiles apart, even when another profile has a broken record', async () => {
    const root = await temp.make()
    const stack = await createStack(root)
    await writeFile(unitFile(root, OTHER_HASH), '{ broken')
    const mine = draftService(stack, HASH, '工作')
    const other = draftService(stack, OTHER_HASH, '生活')
    expect(await mine.load()).toBeNull()
    await mine.save({ text: 'mine', selection: null, binding: null })
    await expect(other.load()).rejects.toMatchObject({ code: 'promptx/draft/unreadable' })
    expect(await readFile(unitFile(root, OTHER_HASH), 'utf8')).toBe('{ broken')
    await rm(unitFile(root, OTHER_HASH))
    expect(await other.load()).toBeNull()
    await other.save({ text: 'other', selection: null, binding: null })
    expect((await mine.load())?.text).toBe('mine')
    expect((await other.load())?.text).toBe('other')
  })

  it('gives every profile name its own unit, including CJK names and names that differ only by punctuation (TC-05)', async () => {
    const root = await temp.make()
    const stack = await createStack(root)
    const names = ['工作', '生活', 'my.dev', 'my_dev', 'default']
    const hashes = names.map(profileHashOf)
    expect(new Set(hashes).size).toBe(names.length)
    const drafts = names.map((name, index) => draftService(stack, hashes[index], name))
    for (const [index, draft] of drafts.entries()) {
      expect(await draft.load()).toBeNull()
      await draft.save({ text: `draft of ${names[index] ?? ''}`, selection: null, binding: null })
    }
    for (const [index, draft] of drafts.entries()) expect((await draft.load())?.text).toBe(`draft of ${names[index] ?? ''}`)
    for (const hash of hashes) expect(await exists(unitFile(root, hash))).toBe(true)
  })

  it('is not blocked by another profile whose record fails the schema (COV-01)', async () => {
    const root = await temp.make()
    const stack = await createStack(root)
    const invalid = unitDocument({ ...recordOf('x'), selection: { anchor: -1, head: 0 } }, 1, OTHER_HASH)
    await writeFile(unitFile(root, OTHER_HASH), invalid)
    const mine = draftService(stack, HASH, '工作')
    expect(await mine.load()).toBeNull()
    await mine.save({ text: 'mine', selection: null, binding: null })
    const other = draftService(stack, OTHER_HASH, '生活')
    await expect(other.load()).rejects.toMatchObject({ code: 'promptx/draft/unreadable', detail: 'invalid-record' })
    await expect(other.save({ text: '', selection: null, binding: null })).rejects.toMatchObject({ code: 'promptx/draft/unreadable' })
    expect(await readFile(unitFile(root, OTHER_HASH), 'utf8')).toBe(invalid)
  })

  it('closes a unit whose reads start failing and opens it again on the next load', async () => {
    // 真实后端在写入结果不明（unknown-state）时会隔离单元：之后的读写都抛错，直到关闭。这里用假的存储服务模拟
    const failure = Object.assign(new Error('storage: unknown state'), { code: 'unknown-state' })
    let opens = 0
    let closes = 0
    const record = recordOf('from disk')
    const facility = {
      open: async () => {
        opens++
        const broken = opens === 1
        return {
          table: () => ({
            get: () => {
              if (broken) throw failure
              return record
            },
            put: async () => undefined,
          }),
          close: async () => {
            closes++
          },
        }
      },
    } as unknown as Pick<DomainFacility, 'open'>
    const service = createDraftService({ facility, profile: { name: 'p', hash: HASH }, now: () => NOW })
    services.push(service)
    await expect(service.load()).rejects.toMatchObject({ code: 'promptx/draft/unreadable', detail: 'unknown-state' })
    expect(closes).toBe(1)
    await expect(service.save({ text: 'x', selection: null, binding: null })).rejects.toMatchObject({ code: 'promptx/draft/unreadable', detail: 'not-loaded' })
    expect(await service.load()).toEqual(record)
    expect(opens).toBe(2)
    expect(await service.save({ text: 'x', selection: null, binding: null })).toEqual({ updatedAt: NOW.toISOString() })
  })

  it('shares one open between concurrent loads', async () => {
    const root = await temp.make()
    const service = draftService(await createStack(root))
    const [a, b, c] = await Promise.all([service.load(), service.load(), service.load()])
    expect([a, b, c]).toEqual([null, null, null])
  })

  it('validates the record before writing so a bad value can never lock the draft', async () => {
    const root = await temp.make()
    const service = draftService(await createStack(root))
    await service.load()
    await service.save({ text: 'good', selection: null, binding: null })
    await expect(service.save({ text: 'bad', selection: { anchor: -1, head: 0 }, binding: null }))
      .rejects.toMatchObject({ code: 'promptx/draft/write-failed', detail: 'invalid-record' })
    expect((await service.load())?.text).toBe('good')
  })

  it('reports write failures and keeps the previous record (POSIX)', async (ctx) => {
    if (!canTestPermissions) ctx.skip()
    const root = await temp.make()
    const service = draftService(await createStack(root))
    await service.load()
    await service.save({ text: 'kept', selection: null, binding: null })
    await chmod(root, 0o555)
    try {
      await expect(service.save({ text: 'lost', selection: null, binding: null })).rejects.toMatchObject({ code: 'promptx/draft/write-failed', detail: 'EACCES' })
    } finally {
      await chmod(root, 0o755)
    }
    expect((await service.load())?.text).toBe('kept')
  })

  it('closes the unit, refuses later calls and frees the name for a new instance', async () => {
    const root = await temp.make()
    const stack = await createStack(root)
    const first = draftService(stack)
    await first.load()
    const pending = first.save({ text: 'flushed on close', selection: null, binding: null })
    await first.close()
    await pending
    await expect(first.load()).rejects.toMatchObject({ code: 'promptx/draft/unreadable', detail: 'closed' })
    await expect(first.save({ text: 'x', selection: null, binding: null })).rejects.toMatchObject({ code: 'promptx/draft/unreadable', detail: 'closed' })
    const second = draftService(stack)
    expect((await second.load())?.text).toBe('flushed on close')
  })

  it('closes a unit that finishes opening after close() was called', async () => {
    const root = await temp.make()
    const stack = await createStack(root)
    const service = draftService(stack)
    const loading = service.load()
    await service.close()
    await expect(loading).rejects.toMatchObject({ code: 'promptx/draft/unreadable' })
    // 名字已经释放，新的实例可以打开同一个单元
    expect(await draftService(stack).load()).toBeNull()
  })

  it('turns an invalid profile hash into an unreadable draft instead of failing at construction', async () => {
    const root = await temp.make()
    const service = draftService(await createStack(root), 'NOT-A-HASH')
    await expect(service.load()).rejects.toMatchObject({ code: 'promptx/draft/unreadable', detail: 'invalid-domain-name' })
  })
})
