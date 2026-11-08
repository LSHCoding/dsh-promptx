// scripts/gen-library.mjs（testing-plan 6.8 的 1,000 条测试库，审查 F7）：生成的每个文件都要被插件自己的解析器读成合法的 Prompt，
// 字段齐全；同样的 seed 和基准时间结果不变；不往已有内容的目录里写。

import { spawn } from 'node:child_process'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { parsePromptFile, type FrontMatterFields } from '../../src/shared/frontmatter.ts'
import { parseTimestamp } from '../../src/shared/library-rules.ts'

const SCRIPT = fileURLToPath(new URL('../../scripts/gen-library.mjs', import.meta.url))
const NOW = '2026-11-08T00:00:00Z'
const DAY_MS = 24 * 60 * 60 * 1000

const temps: string[] = []

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'promptx-gen-library-'))
  temps.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(temps.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

interface Run {
  code: number | null
  stdout: string
  stderr: string
}

/** 用跑测试的这个 Node 执行脚本，等它退出。 */
async function generate(args: readonly string[]): Promise<Run> {
  const child = spawn(process.execPath, [SCRIPT, ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
    stdout += chunk
  })
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
    stderr += chunk
  })
  const code = await new Promise<number | null>((resolve, reject) => {
    child.on('error', reject)
    child.on('close', resolve)
  })
  return { code, stdout, stderr }
}

/** 库里所有 .md 的相对路径（`/` 分隔），排好序。 */
async function markdownFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true })
  return entries
    .filter(entry => entry.isFile() && entry.name.endsWith('.md'))
    .map(entry => relative(root, join(entry.parentPath, entry.name)).split(sep).join('/'))
    .sort()
}

interface Entry {
  path: string
  fields: FrontMatterFields
  body: string
}

/** 用插件的解析器读出每一条；front matter 不是 ok 的直接让测试失败。 */
async function readLibrary(root: string): Promise<Entry[]> {
  const entries: Entry[] = []
  for (const path of await markdownFiles(root)) {
    const parsed = parsePromptFile(await readFile(join(root, ...path.split('/')), 'utf8'))
    expect(parsed.frontMatter?.state, path).toBe('ok')
    expect(parsed.bom, path).toBe(false)
    expect(parsed.eol, path).toBe('lf')
    entries.push({ path, fields: parsed.frontMatter!.fields, body: parsed.body })
  }
  return entries
}

function folderOf(path: string): string {
  const slash = path.lastIndexOf('/')
  return slash < 0 ? '' : path.slice(0, slash)
}

describe('scripts/gen-library.mjs', () => {
  it('writes the requested number of prompts that the library parser reads with every field', async () => {
    const library = join(await tempDir(), 'nested', 'library')
    const result = await generate([library, '--count', '25', '--seed', '7', '--now', NOW])
    expect(result.code).toBe(0)
    expect(result.stderr).toBe('')
    expect(result.stdout).toContain(library)
    expect(result.stdout).toContain('25')

    const entries = await readLibrary(library)
    expect(entries).toHaveLength(25)
    const now = Date.parse(NOW)
    for (const { path, fields, body } of entries) {
      const { id, title, tags, favorite, created, updated } = fields
      expect(id, path).toMatch(/^prompt_\d{8}_\d{6}_[0-9a-f]{8}$/)
      // id 里的时间就是创建时间（需求 6.2）。
      expect(id!.slice(7, 22), path).toBe(created!.slice(0, 19).replace(/[-:]/g, '').replace('T', '_'))
      expect(title?.trim(), path).toBeTruthy()
      // 以标题行开头的正文，front matter 里的标题和它一字不差：带 `: `、` #` 的标题要加对引号才读得回来。
      if (body.startsWith('# ')) expect(title, path).toBe(body.slice(2, body.indexOf('\n')))
      expect(tags!.length, path).toBeLessThanOrEqual(5)
      expect(new Set(tags).size, path).toBe(tags!.length)
      expect(typeof favorite, path).toBe('boolean')
      const createdAt = parseTimestamp(created!)
      const updatedAt = parseTimestamp(updated!)
      expect(createdAt, path).not.toBeNull()
      expect(updatedAt, path).not.toBeNull()
      expect(createdAt!, path).toBeLessThanOrEqual(updatedAt!)
      expect(createdAt!, path).toBeGreaterThanOrEqual(now - 60 * DAY_MS)
      expect(updatedAt!, path).toBeLessThanOrEqual(now)
      const bytes = Buffer.byteLength(body)
      expect(bytes, path).toBeGreaterThanOrEqual(200)
      expect(bytes, path).toBeLessThanOrEqual(20 * 1024)
    }
    expect(new Set(entries.map(entry => entry.fields.id)).size).toBe(25)
    // 「最近」（30 天）筛选有命中，也不是全部命中。
    const recent = entries.filter(entry => parseTimestamp(entry.fields.updated!)! >= now - 30 * DAY_MS).length
    expect(recent).toBeGreaterThan(0)
    expect(recent).toBeLessThan(25)
    // 分散在几个文件夹里，其中有嵌套的。
    const folders = new Set(entries.map(entry => folderOf(entry.path)))
    expect(folders.size).toBeGreaterThanOrEqual(3)
    expect([...folders].some(folder => folder.includes('/'))).toBe(true)
    // 正文中英文混排，有小标题、列表和代码块。
    const bodies = entries.map(entry => entry.body).join('\n')
    expect(bodies).toMatch(/[一-鿿]/)
    expect(bodies).toMatch(/[A-Za-z]{4,}/)
    expect(bodies).toMatch(/^## /m)
    expect(bodies).toMatch(/^(?:- |\d+\. )/m)
    expect(bodies).toContain('```')
  })

  it('generates 1,000 prompts by default, shaped like the N-01 library', async () => {
    const library = join(await tempDir(), 'library')
    expect((await generate([library, '--now', NOW])).code).toBe(0)
    const entries = await readLibrary(library)
    expect(entries).toHaveLength(1000)
    // 约 10% 收藏，约一半在 30 天内更新过，平均每条约 2 KB（N-01 的估算），十来个文件夹。
    const favorites = entries.filter(entry => entry.fields.favorite === true).length
    expect(favorites).toBeGreaterThan(50)
    expect(favorites).toBeLessThan(150)
    const now = Date.parse(NOW)
    const recent = entries.filter(entry => parseTimestamp(entry.fields.updated!)! >= now - 30 * DAY_MS).length
    expect(recent).toBeGreaterThan(350)
    expect(recent).toBeLessThan(650)
    const sizes = entries.map(entry => Buffer.byteLength(entry.body))
    const mean = sizes.reduce((sum, size) => sum + size, 0) / sizes.length
    expect(mean).toBeGreaterThan(1_500)
    expect(mean).toBeLessThan(2_600)
    expect(Math.max(...sizes)).toBeGreaterThan(10 * 1024)
    expect(new Set(entries.map(entry => folderOf(entry.path))).size).toBeGreaterThanOrEqual(10)
  })

  it('generates the same library for the same seed and base time', async () => {
    const root = await tempDir()
    const snapshot = async (dir: string): Promise<Record<string, string>> => {
      const files: Record<string, string> = {}
      for (const path of await markdownFiles(dir)) files[path] = await readFile(join(dir, ...path.split('/')), 'utf8')
      return files
    }
    const options = ['--count', '40', '--now', NOW]
    expect((await generate([join(root, 'a'), ...options, '--seed', '42'])).code).toBe(0)
    expect((await generate([join(root, 'b'), ...options, '--seed', '42'])).code).toBe(0)
    expect((await generate([join(root, 'c'), ...options, '--seed', '43'])).code).toBe(0)
    const first = await snapshot(join(root, 'a'))
    expect(Object.keys(first)).toHaveLength(40)
    expect(await snapshot(join(root, 'b'))).toEqual(first)
    expect(await snapshot(join(root, 'c'))).not.toEqual(first)
  })

  it('fills an existing empty directory', async () => {
    const library = await tempDir()
    expect((await generate([library, '--count', '3', '--now', NOW])).code).toBe(0)
    expect(await markdownFiles(library)).toHaveLength(3)
  })

  it('refuses a target that is not empty, or not a directory, and leaves it untouched', async () => {
    const library = await tempDir()
    await writeFile(join(library, 'mine.md'), 'my prompt\n')
    const refused = await generate([library, '--count', '5'])
    expect(refused.code).toBe(1)
    expect(refused.stderr).toContain(library)
    expect(refused.stdout).toBe('')
    expect(await readdir(library)).toEqual(['mine.md'])
    expect(await readFile(join(library, 'mine.md'), 'utf8')).toBe('my prompt\n')
    const file = await generate([join(library, 'mine.md'), '--count', '5'])
    expect(file.code).toBe(1)
    expect(await readFile(join(library, 'mine.md'), 'utf8')).toBe('my prompt\n')
  })

  it.each([
    { args: ['--count', '0'] },
    { args: ['--count', 'many'] },
    { args: ['--seed', '1.5'] },
    { args: ['--now', 'yesterday'] },
    { args: ['--bogus'] },
  ])('rejects $args without writing anything', async ({ args }) => {
    const library = join(await tempDir(), 'library')
    const result = await generate([library, ...args])
    expect(result.code).toBe(2)
    expect(result.stderr).toContain('gen-library:')
    await expect(readdir(library)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
