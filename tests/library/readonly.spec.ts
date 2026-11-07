import { mkdir, utimes } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { RECORD_FILE } from '../../src/library/trash.ts'
import { installCrashTraps, listAll, makeService, promptFile, sha256Of, snapshotTree, useTempDirs, writeTree } from './helpers.ts'

installCrashTraps()
const temp = useTempDirs()

it('browsing, searching, previewing and opening the trash change nothing on disk (L-01 acceptance 2, 7.3)', async () => {
  const root = await temp.make()
  const trashed = '# 旧的\n\n已经删除。\n'
  await writeTree(root, {
    '代码审查清单.md': promptFile({ id: 'prompt_20261101_000000_abcdef01', title: '代码审查清单', tags: '[代码, 审查]' }, '检查边界。\n'),
    '写作/模板.md': promptFile({ title: '模板', tags: '[示例]', favorite: 'true' }, '正文\n'),
    '写作/评审/没有元数据.md': '# 没有元数据\r\n\r\n正文\r\n',
    'broken.md': '---\ntitle: a\ntitle: b\n---\nbody',
    'latin1.md': Buffer.from([0xe9, 0x0a]),
    '.obsidian/config.md': '# 其他工具的目录\n',
    'notes.txt': 'not a prompt',
    '_trash/旧的.md': trashed,
    [`_trash/${RECORD_FILE}`]: JSON.stringify({
      version: 1,
      items: [{ file: '旧的.md', originalPath: '写作/旧的.md', deletedAt: '2026-11-01T00:00:00Z', sha256: sha256Of(trashed), size: Buffer.byteLength(trashed) }],
    }),
  })
  await mkdir(join(root, '空文件夹'))
  // 把所有修改时间拨到过去，任何一次写入都会让它变化
  const past = new Date('2026-01-01T00:00:00Z')
  for (const path of ['代码审查清单.md', '写作/模板.md', '写作/评审/没有元数据.md', 'broken.md', 'latin1.md', '_trash/旧的.md']) {
    await utimes(join(root, ...path.split('/')), past, past)
  }
  const before = await snapshotTree(root)

  const service = makeService(root)
  const listed = await listAll(service)
  await listAll(service, { query: '代码 审查', refresh: false })
  await listAll(service, { folder: { kind: 'folder', path: '写作' }, scope: 'favorites', tag: '示例', refresh: false })
  await listAll(service, { folder: { kind: 'root' }, scope: 'recent' })
  for (const entry of listed.entries) {
    if (entry.status !== 'unreadable') await service.read(entry.relPath)
  }
  await service.trashList('')
  await service.trashList('旧')
  await service.trashRead('旧的.md')
  await listAll(service)

  expect(listed.total).toBe(5)
  expect(await snapshotTree(root)).toEqual(before)
})
