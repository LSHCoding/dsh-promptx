// 生成 N-01 性能检查用的 Prompt 测试库（testing-plan 6.8：1,000 条的库，展开侧栏 ≤ 1 s，搜索 ≤ 200 ms）。
// testing-plan 早就写了用这个脚本，仓库里却一直没有，手工验收没法照做（审查 F7）。
//
// 用法：node scripts/gen-library.mjs <目标目录> [--count 1000] [--seed 1] [--now <ISO 8601 时间>]
//
// - 目标目录已存在且不为空时拒绝：测试数据不会混进真实的库，也不会覆盖任何文件。目录不存在时连同上级目录一起创建。
// - 每条都是带 front matter 的 .md，格式和插件新建的文件一样（需求 6.2：LF 换行，标签用块列表，没有标签写 `tags: []`）。
//   条目分散在十来个文件夹（有嵌套）和库根目录里；标签 0 到 5 个，约 10% 收藏；
//   正文几百字节到约 20 KB，平均约 2 KB（N-01 按每条 2 KB 估算），中英文混排，有标题、列表、引用和代码块。
// - created、updated 都落在基准时间之前的 60 天内，「最近」（30 天）筛选约有一半命中。
//   基准默认取当天 UTC 零点而不是此刻：同一个 seed 在同一天里重跑，生成的内容逐字节相同；--now 可以把基准固定下来。
// - 只用 Node 自带的模块，不读仓库里的源码，装了 Node 24 的机器都能直接跑。

import { mkdir, readdir, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'

const USAGE = 'usage: node scripts/gen-library.mjs <target-dir> [--count 1000] [--seed 1] [--now <ISO 8601 time>]'
const DAY_MS = 24 * 60 * 60 * 1000
const SPAN_MS = 60 * DAY_MS
const MAX_COUNT = 100_000

/** 文件夹和权重。'' 是库根目录（侧栏的「未分类」）；「运营」下面只有子文件夹，自己没有条目。 */
const FOLDERS = [
  ['', 8],
  ['写作', 10],
  ['写作/评审', 6],
  ['代码', 12],
  ['代码/审查', 8],
  ['代码/测试', 6],
  ['翻译', 8],
  ['research', 8],
  ['research/papers', 6],
  ['运营/社媒', 6],
  ['agents', 8],
  ['misc', 4],
]

/** 标签词表，中英文都有。 */
const TAGS = ['写作', '代码', '审查', '翻译', '示例', '模板', '总结', '邮件', 'review', 'draft', 'agent', 'SQL']
/** 每条有 0、1、2、3、4、5 个标签的权重。 */
const TAG_COUNT_WEIGHTS = [15, 25, 25, 18, 10, 7]

const TITLE_HEADS = [
  '代码审查清单', '结构化写作模板', 'SQL 优化建议', '周报生成', '论文摘要', '会议纪要整理', '邮件回复', '需求澄清提问',
  'Agent 系统提示', '单元测试补全', 'Bug triage', 'Refactor plan', 'Translate to English', 'Release notes',
  'Code review: checklist', 'Interview questions',
]
const TITLE_SUBJECTS = ['后端', '前端', 'Python', 'TypeScript', 'Rust', '数据分析', '产品', '运营', 'iOS', 'security', 'onboarding', 'CLI']
// 空串多放几个：大部分标题没有后缀。` #3` 和上面的 `: ` 会让标题必须加引号写进 front matter。
const TITLE_SUFFIXES = ['', '', '', ' v2', '（精简版）', ' - draft', '（中英对照）', ' #3']

const SECTION_TITLES = ['背景', '任务', '输出格式', '约束', '示例', 'Context', 'Instructions', 'Output format', 'Checklist', 'Notes']

const SENTENCES = [
  '请检查边界条件、错误处理与可维护性。',
  '先给出结论，再分点说明理由。',
  '保留原文的术语，不要擅自改写专有名词。',
  '如果信息不足，先列出需要澄清的问题。',
  '输出使用 Markdown，标题不超过两级。',
  '每一条建议都要说明影响范围和风险。',
  '用简洁的中文回答，避免空泛的套话。',
  '对比两种方案的取舍，并说明推荐哪一种。',
  '请标注每个结论的依据来自输入的哪一段。',
  '输入：{{input}}，目标读者：{{audience}}。',
  'Review the following code for correctness and readability.',
  'Summarize the key points in no more than five bullets.',
  'Keep the original terminology and do not invent APIs.',
  'If the input is ambiguous, ask one clarifying question first.',
  'Return valid JSON with the fields listed below.',
  'Explain the trade-offs before recommending an option.',
  'Highlight any security or privacy concerns.',
  'Translate the text and keep the Markdown structure intact.',
  'List the assumptions you made at the end.',
  'Context: {{context}}',
]

const LIST_ITEMS = [
  '边界条件：空输入、超长输入、并发修改',
  '错误处理是否吞掉了异常',
  '命名是否表达了意图',
  '有没有可以删掉的重复代码',
  '测试是否覆盖了失败路径',
  'Check null and undefined handling',
  'Look for N+1 queries',
  'Make sure secrets are not logged',
  'Prefer small, focused functions',
  'Note anything that needs a follow-up ticket',
]

/** 代码块：语言和行。 */
const CODE_BLOCKS = [
  ['python', [
    'def find_issues(diff: str) -> list[str]:',
    '    issues = []',
    '    for line in diff.splitlines():',
    '        if "TODO" in line or "FIXME" in line:',
    '            issues.append(line.strip())',
    '    return issues',
  ]],
  ['ts', [
    'export function summarize(items: string[]): string {',
    '  return items',
    '    .filter(item => item.trim() !== \'\')',
    '    .map((item, index) => `${index + 1}. ${item}`)',
    '    .join(\'\\n\')',
    '}',
  ]],
  ['sql', [
    'SELECT user_id, COUNT(*) AS orders',
    'FROM orders',
    'WHERE created_at >= NOW() - INTERVAL \'30 days\'',
    'GROUP BY user_id',
    'ORDER BY orders DESC',
    'LIMIT 20;',
  ]],
  ['json', [
    '{',
    '  "summary": "一句话总结",',
    '  "risks": ["risk 1", "risk 2"],',
    '  "confidence": 0.8',
    '}',
  ]],
  ['bash', [
    'git diff --stat origin/main...HEAD',
    'pnpm test -- --reporter=dot',
  ]],
  ['prompt', [
    '你是一名资深的代码审查者。',
    'Read the diff below and list the problems by severity.',
    '{{diff}}',
  ]],
]

// ───────────────────────────── 随机数 ─────────────────────────────

/** mulberry32：32 位种子的确定性伪随机数，返回 [0, 1)。 */
function mulberry32(seed) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 0x1_0000_0000
  }
}

function pick(random, items) {
  return items[Math.floor(random() * items.length)]
}

function between(random, min, max) {
  return min + Math.floor(random() * (max - min + 1))
}

/** 按权重选下标。 */
function weighted(random, weights) {
  const total = weights.reduce((sum, weight) => sum + weight, 0)
  let roll = random() * total
  for (let index = 0; index < weights.length; index++) {
    roll -= weights[index]
    if (roll < 0) return index
  }
  return weights.length - 1
}

/** 不重复地选 n 个。 */
function sample(random, items, n) {
  const pool = [...items]
  const chosen = []
  while (chosen.length < n && pool.length > 0) chosen.push(pool.splice(Math.floor(random() * pool.length), 1)[0])
  return chosen
}

// ───────────────────────────── 正文 ─────────────────────────────

/** 正文的目标字节数：大多数一两 KB，少数 4 到 8 KB，偶尔 12 到 20 KB，平均约 2 KB。 */
function targetBytes(random) {
  const roll = random()
  if (roll < 0.02) return between(random, 12_000, 19_500)
  if (roll < 0.1) return between(random, 4_000, 8_000)
  return Math.min(6_000, 300 + Math.floor(-Math.log(1 - random()) * 1_100))
}

function paragraph(random) {
  let text = ''
  for (let count = between(random, 1, 4); count > 0; count--) {
    const sentence = pick(random, SENTENCES)
    // 中文句子之间不加空格，其余情况句子之间空一格。
    const joined = text === '' || (/[。？！]$/.test(text) && /^[^A-Za-z]/.test(sentence))
    text += joined ? sentence : ` ${sentence}`
  }
  return text
}

function list(random) {
  const numbered = random() < 0.4
  const lines = []
  const items = sample(random, LIST_ITEMS, between(random, 2, 6))
  items.forEach((item, index) => {
    lines.push(numbered ? `${index + 1}. ${item}` : `- ${item}`)
    if (random() < 0.15) lines.push(`${numbered ? '   ' : '  '}- ${pick(random, LIST_ITEMS)}`)
  })
  return lines.join('\n')
}

function codeBlock(random) {
  const [language, lines] = pick(random, CODE_BLOCKS)
  return ['```' + language, ...lines, '```'].join('\n')
}

function quote(random) {
  return `> ${pick(random, SENTENCES)}`
}

function makeBody(random, title) {
  const target = targetBytes(random)
  const blocks = []
  let size = 0
  const add = (block) => {
    blocks.push(block)
    size += Buffer.byteLength(block) + 2
  }
  // 大多数 Prompt 以标题行开头，侧栏的标题提取和预览都按这个最常见的写法来。
  if (random() < 0.7) add(`# ${title}`)
  // 写够目标字节数为止；最后一块不停在标题行上。
  while (size < target || (blocks.at(-1) ?? '').startsWith('#')) {
    const roll = random()
    if (roll < 0.4) add(paragraph(random))
    else if (roll < 0.6) add(list(random))
    else if (roll < 0.72) add(`## ${pick(random, SECTION_TITLES)}`)
    else if (roll < 0.88) add(codeBlock(random))
    else add(quote(random))
  }
  return `${blocks.join('\n\n')}\n`
}

// ───────────────────────────── front matter 和文件名 ─────────────────────────────

/** 写成 YAML 字符串：只含文字、数字和少数安全标点时不加引号（和插件的习惯一样），否则用双引号。 */
function yamlString(value) {
  if (/^[\p{L}\p{N}][\p{L}\p{N} ._()（）·-]*$/u.test(value) && !/^(?:true|false|yes|no|on|off|null)$/i.test(value)) return value
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
}

/** 不带毫秒的 UTC 时间，和插件写入的格式一样。 */
function isoSeconds(ms) {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z')
}

/** `prompt_` + 创建时间（UTC `YYYYMMDD_HHMMSS`）+ `_` + 8 位小写十六进制（需求 6.2）。同一个库里不重复。 */
function promptId(random, created, used) {
  const iso = isoSeconds(created)
  const stamp = `${iso.slice(0, 10).replaceAll('-', '')}_${iso.slice(11, 19).replaceAll(':', '')}`
  for (;;) {
    const id = `prompt_${stamp}_${Math.floor(random() * 0x1_0000_0000).toString(16).padStart(8, '0')}`
    if (!used.has(id)) {
      used.add(id)
      return id
    }
  }
}

function renderFile(entry) {
  const lines = ['---', `id: ${entry.id}`, `title: ${yamlString(entry.title)}`]
  if (entry.tags.length === 0) lines.push('tags: []')
  else lines.push('tags:', ...entry.tags.map(tag => `  - ${yamlString(tag)}`))
  lines.push(`favorite: ${String(entry.favorite)}`, `created: ${entry.created}`, `updated: ${entry.updated}`, '---', '')
  return lines.join('\n') + entry.body
}

/** 由标题生成文件名主体，规则同需求 6.2：非法字符换成 `-`，去掉开头的点和空白，最长 60 个字符。 */
function fileStem(title) {
  const cleaned = title.replace(/[/\\:*?"<>|\u0000-\u001f\u007f]/g, '-').replace(/^[\s.]+/, '').trimEnd()
  const stem = Array.from(cleaned).slice(0, 60).join('').trimEnd()
  return stem === '' ? 'prompt' : stem
}

/** 同一文件夹里重名时依次用 `<名字>-<id 末 8 位>.md`、`-2`、`-3`……（需求 6.2）。 */
function* fileNames(stem, id) {
  yield `${stem}.md`
  const base = `${stem}-${id.slice(-8)}`
  yield `${base}.md`
  for (let n = 2; ; n++) yield `${base}-${n}.md`
}

/**
 * 在 dir 里新建文件，返回用掉的文件名。taken 按小写记下这个文件夹里已用的名字：大小写不敏感的文件系统上
 * 也得到同样的结果，生成的库在各平台上一致。wx 只是保险，目标目录本来是空的。
 */
async function writeNewFile(dir, stem, id, text, taken) {
  for (const name of fileNames(stem, id)) {
    const key = name.normalize('NFC').toLowerCase()
    if (taken.has(key)) continue
    taken.add(key)
    try {
      await writeFile(join(dir, name), text, { flag: 'wx' })
      return name
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
    }
  }
  throw new Error('unreachable')
}

// ───────────────────────────── 命令行 ─────────────────────────────

/** 目标目录不能用时返回原因：已存在但不是目录，或者不是空的。 */
async function targetProblem(dir) {
  let info
  try {
    info = await stat(dir)
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
  if (!info.isDirectory()) return `${dir} 已存在且不是目录`
  if ((await readdir(dir)).length > 0) return `${dir} 不是空目录；为了不把测试数据混进真实的库，请换一个不存在或空的目录`
  return null
}

function fail(message, code) {
  console.error(`gen-library: ${message}`)
  return code
}

async function main(argv) {
  let parsed
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        count: { type: 'string', default: '1000' },
        seed: { type: 'string', default: '1' },
        now: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
    })
  } catch (error) {
    return fail(`${error.message}\n${USAGE}`, 2)
  }
  const { values, positionals } = parsed
  if (values.help === true) {
    console.log(USAGE)
    return 0
  }
  if (positionals.length !== 1) return fail(USAGE, 2)
  const count = Number(values.count)
  if (!/^\d+$/.test(values.count) || count < 1 || count > MAX_COUNT) return fail(`--count 要是 1 到 ${MAX_COUNT} 的整数`, 2)
  if (!/^-?\d+$/.test(values.seed) || !Number.isSafeInteger(Number(values.seed))) return fail('--seed 要是整数', 2)
  const parsedNow = values.now === undefined ? Date.now() : Date.parse(values.now)
  if (Number.isNaN(parsedNow)) return fail('--now 要是 ISO 8601 时间，例如 2026-11-08T00:00:00Z', 2)
  // 默认基准取当天 UTC 零点：同一天里重跑结果不变。给了 --now 时只去掉毫秒。
  const base = values.now === undefined ? parsedNow - (parsedNow % DAY_MS) : parsedNow - (parsedNow % 1000)

  const target = resolve(positionals[0])
  const problem = await targetProblem(target)
  if (problem !== null) return fail(problem, 1)

  const random = mulberry32(Number(values.seed))
  const folderWeights = FOLDERS.map(([, weight]) => weight)
  const usedIds = new Set()
  const taken = new Map()
  for (let index = 0; index < count; index++) {
    const [folder] = FOLDERS[weighted(random, folderWeights)]
    const title = `${pick(random, TITLE_HEADS)} · ${pick(random, TITLE_SUBJECTS)}${pick(random, TITLE_SUFFIXES)}`
    const tags = sample(random, TAGS, weighted(random, TAG_COUNT_WEIGHTS))
    const favorite = random() < 0.1
    // updated 在 60 天里均匀分布；created 在 60 天前到 updated 之间。都取整到秒。
    const updated = base - Math.floor((random() * SPAN_MS) / 1000) * 1000
    const created = updated - Math.floor((random() * (updated - (base - SPAN_MS))) / 1000) * 1000
    const id = promptId(random, created, usedIds)
    const body = makeBody(random, title)
    const dir = folder === '' ? target : join(target, ...folder.split('/'))
    await mkdir(dir, { recursive: true })
    if (!taken.has(folder)) taken.set(folder, new Set())
    const text = renderFile({ id, title, tags, favorite, created: isoSeconds(created), updated: isoSeconds(updated), body })
    await writeNewFile(dir, fileStem(title), id, text, taken.get(folder))
  }
  console.log(`wrote ${count} prompts to ${target}`)
  return 0
}

// 写到一半出错（权限、磁盘满、目标路径的上级是文件）时报一行原因；已经写下的文件留着，换个空目录重跑即可。
process.exitCode = await main(process.argv.slice(2)).catch(error => fail(error instanceof Error ? error.message : String(error), 1))
