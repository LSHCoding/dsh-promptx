// 本机端到端测试（testing-plan 第 5 节）：在临时 DSH_HOME 里建 promptx-dev profile、装上本仓库、启动 dsh，
// 通过 dsh 的 /api/dsh-promptx/* 路由驱动真实的小程序，跑核心路径并按 N-01 的阈值判定。
// 不碰日常的 ~/.dsh：所有数据都在临时目录里，结束后删除（--keep 保留）。
//
// 用法：pnpm build && node scripts/e2e-local.mjs [--keep]
// 运行时缓存：<仓库>/.smoke-runtime/（和冒烟测试共用），有就复制进临时目录，没有就让插件自己下载。

import { spawn, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

const DSH = '@deepseek-ai/dsh@0.2.2-rc.1'
const PROFILE = 'promptx-dev'
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const keep = process.argv.includes('--keep')
const results = []
let failed = false

function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  if (!ok) failed = true
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
}

function npx(args, env) {
  const bin = process.platform === 'win32' ? 'npx.cmd' : 'npx'
  return execFileSync(bin, ['-y', DSH, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: 600_000 })
}

if (!existsSync(join(root, 'lib', 'index.js')) || !existsSync(join(root, 'lib', 'app', 'main.cjs'))) {
  console.error('缺少构建产物，先运行 pnpm build')
  process.exit(2)
}

const home = mkdtempSync(join(tmpdir(), 'promptx-e2e-'))
const env = { ...process.env, DSH_HOME: home }
delete env.DSH_PROMPTX_E2E
let dsh = null

try {
  console.log(`DSH_HOME=${home}`)
  npx(['--profile', PROFILE, '--from-default-profile', 'web', '--dump-config'], env)
  npx(['plugin', '--profile', PROFILE, 'add', root], env)

  // 复制缓存的运行时，避免每次都下载 120 MB。
  const cache = join(root, '.smoke-runtime')
  if (existsSync(cache)) {
    for (const name of readdirSync(cache)) {
      if (existsSync(join(cache, name, '.ready'))) {
        const target = join(home, 'promptx', 'runtime', name)
        mkdirSync(dirname(target), { recursive: true })
        // macOS 上用 ditto 复制，保留 Electron Framework 里的符号链接。
        if (process.platform === 'darwin') execFileSync('/usr/bin/ditto', [join(cache, name), target])
        else cpSync(join(cache, name), target, { recursive: true, verbatimSymlinks: true })
        console.log(`copied cached runtime ${name}`)
      }
    }
  }

  const spawnedAt = Date.now()
  const bin = process.platform === 'win32' ? 'npx.cmd' : 'npx'
  // npx 只是包装：真正的 dsh 是它的子进程。放进单独的进程组，结束时对整个组发信号，才不会留下 dsh 和小程序。
  dsh = spawn(bin, ['-y', DSH, '--profile', PROFILE, '--no-open', '--port', '0'], {
    env: { ...env, DSH_PROMPTX_E2E: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  })
  dsh.once('error', (error) => {
    console.error(`dsh 启动失败：${error.message}`)
  })
  const tokenUrl = await new Promise((resolve, reject) => {
    let buffer = ''
    const timer = setTimeout(() => {
      reject(new Error('120 秒内没有看到 dsh web 的地址'))
    }, 120_000)
    const onData = (chunk) => {
      buffer += chunk.toString()
      const match = /dsh web: (https?:\/\/\S+)/.exec(buffer)
      if (match) {
        clearTimeout(timer)
        resolve(match[1])
      }
    }
    dsh.stdout.on('data', onData)
    dsh.stderr.on('data', onData)
  })
  // N-01「dsh 启动后到小程序就绪」从 dsh 打印出地址（服务已经起来）开始计时；npx 解析包的时间不算。
  const startedAt = Date.now()
  console.log(`dsh up after ${startedAt - spawnedAt} ms`)
  const origin = new URL(tokenUrl).origin

  // 用带口令的地址换 cookie，之后的请求都带上它。
  const login = await fetch(tokenUrl, { redirect: 'manual' })
  const cookie = login.headers.getSetCookie().map(c => c.split(';')[0]).join('; ')
  const headers = { cookie, origin, 'content-type': 'application/json' }
  const api = async (path, body) => {
    const res = await fetch(`${origin}/api/dsh-promptx/${path}`, body === undefined ? { headers } : { method: 'POST', headers, body: JSON.stringify(body) })
    const text = await res.text()
    if (!res.ok) throw new Error(`${path}: HTTP ${res.status} ${text.slice(0, 200)}`)
    return JSON.parse(text)
  }

  // 1. 运行时就绪、小程序运行、快捷键登记
  let status = await api('status?since=-1')
  const deadline = Date.now() + 15 * 60_000
  while (!(status.runtime.state === 'ready' && status.companion.state === 'running') && Date.now() < deadline) {
    if (status.runtime.state === 'failed' || status.companion.state === 'failed') break
    status = await api(`status?since=${status.seq}`)
  }
  const readyMs = Date.now() - startedAt
  check('runtime ready', status.runtime.state === 'ready', status.runtime.error?.code ?? '')
  check('companion running', status.companion.state === 'running', status.companion.error?.code ?? '')
  check('dsh start to companion ready <= 3000 ms (cached runtime)', readyMs <= 3000, `${readyMs} ms`)
  // 快捷键的登记结果在握手之后由小程序单独上报，稍等一下。
  const shortcutDeadline = Date.now() + 10_000
  while (status.shortcut === null && Date.now() < shortcutDeadline) status = await api(`status?since=${status.seq}`)
  check('global shortcut registered', status.shortcut?.registered === true, status.shortcut?.error?.code ?? status.shortcut?.warning?.code ?? '')

  // 小程序握手后才加载界面：等界面报告就绪（编辑器挂好、草稿读回）再开始测核心路径。
  const uiDeadline = Date.now() + 15_000
  let ui = await api('e2e', { command: { action: 'state' } })
  while (ui.data?.rendererReady !== true && Date.now() < uiDeadline) {
    await sleep(200)
    ui = await api('e2e', { command: { action: 'state' } })
  }
  check('companion window UI ready', ui.data?.rendererReady === true, JSON.stringify(ui.data?.renderer ?? null))

  // 2. 核心路径，跑 5 次取中位数
  const text = '# 写作助手\n\n## 要求\n\n- 第一项\n    - 缩进的子项\n\n```\ncode\n```\n'
  const shows = []
  const hides = []
  let focusMissing = 0
  for (let i = 0; i < 5; i++) {
    const r = await api('e2e', { command: { action: 'core-path', text } })
    check(`core path #${i + 1}`, r.ok === true && r.data.clipboardMatches === true && r.data.hidden === true, JSON.stringify(r.data))
    if (typeof r.data.readyMs === 'number') shows.push(r.data.readyMs)
    if (r.data.focused !== true) focusMissing += 1
    if (typeof r.data.copyToHiddenMs === 'number') hides.push(r.data.copyToHiddenMs)
    await sleep(300)
  }
  const median = arr => [...arr].sort((a, b) => a - b)[Math.floor(arr.length / 2)] ?? Infinity
  check('show to editor ready median <= 100 ms', median(shows) <= 100, shows.map(n => n.toFixed(1)).join(', '))
  check('show to editor ready max <= 200 ms', Math.max(...shows) <= 200, shows.map(n => n.toFixed(1)).join(', '))
  if (focusMissing > 0) {
    // 不算失败：新版 macOS 不让没有用户输入事件的后台应用抢键盘焦点，按全局快捷键呼出时的焦点要手工验收。
    console.log(`INFO  keyboard focus not granted to ${focusMissing}/5 script-initiated shows (expected on recent macOS; check the ⌃P path by hand)`)
  }
  check('copy to hidden <= 200 ms', Math.max(...hides) <= 200, hides.join(', '))
  const profileHash = createHash('sha256').update(PROFILE, 'utf8').digest('hex').slice(0, 16)
  const draftFile = join(home, 'storages', `promptx_draft_${profileHash}.json`)
  await sleep(800)
  check('draft persisted', existsSync(draftFile) && readFileSync(draftFile, 'utf8').includes(JSON.stringify(text).slice(1, 20)), draftFile)

  // 3. 保存到库
  const saved = await api('e2e', { command: { action: 'save-to-library' } })
  check('save to library', saved.ok === true, JSON.stringify(saved.data))
  check('manual fallback and confirmed save <= 500 ms', saved.data.metadataFallback === true && typeof saved.data.ms === 'number' && saved.data.ms <= 500, `${saved.data.ms} ms`)
  if (typeof saved.data.relPath === 'string') {
    const file = readFileSync(join(status.effectiveLibraryDir, saved.data.relPath), 'utf8')
    check('new file has front matter fields', ['id:', 'title:', 'tags:', 'favorite:', 'created:', 'updated:'].every(k => file.includes(`\n${k}`)), saved.data.relPath)
    check('confirmed title and phrase tag are persisted', file.includes('E2E Prompt ') && file.includes('E2E Save'))

    // 主窗口每次独立保存均新建；未改动的前两条必须逐字节保留。
    const snapshots = new Map([[saved.data.relPath, file]])
    for (let index = 0; index < 2; index++) {
      const next = await api('e2e', { command: { action: 'save-to-library' } })
      const relPath = next.data.relPath
      const distinct = next.ok === true && typeof relPath === 'string' && !snapshots.has(relPath)
      check(`main save #${index + 2} creates a distinct entry`, distinct, String(relPath))
      if (distinct) snapshots.set(relPath, readFileSync(join(status.effectiveLibraryDir, relPath), 'utf8'))
    }
    check('earlier entries unchanged after repeated saves', [...snapshots].every(([path, bytes]) => readFileSync(join(status.effectiveLibraryDir, path), 'utf8') === bytes))
    const beforeEdit = await api('e2e', { command: { action: 'state' } })
    check('main draft has no file-update binding', beforeEdit.ok === true && beforeEdit.data.renderer?.boundRelPath === null)

    // 子窗实际加载并请求状态；测试模式模拟编辑，原生manager沿正式保存链只更新指定文件。
    const editedBody = '# 独立条目编辑\n\n修改已有条目，主窗口草稿保持原样。'
    const metadata = { title: '独立条目编辑', tags: ['Entry Editing', '复核'] }
    const edited = await api('e2e', { command: { action: 'edit-entry', relPath: saved.data.relPath, text: editedBody, metadata } })
    const updatedFile = readFileSync(join(status.effectiveLibraryDir, saved.data.relPath), 'utf8')
    check('entry editor loads and edits through its renderer', edited.ok === true && edited.data.windowCreated === true && edited.data.stateRequested === true && edited.data.rendererEchoed === true)
    check('entry editor saves only its target', edited.data.targetRelPath === saved.data.relPath && edited.data.savedBodyMatches === true && updatedFile.endsWith(editedBody))
    check('entry editor saves custom title and phrase tags', edited.data.metadataMatches === true && [metadata.title, ...metadata.tags].every(value => updatedFile.includes(value)))
    const folder = 'E2E Folder'
    mkdirSync(join(status.effectiveLibraryDir, folder))
    const moved = await api('e2e', { command: { action: 'edit-entry', relPath: saved.data.relPath, text: editedBody, folder } })
    const movedPath = `${folder}/${saved.data.relPath}`
    check('entry editor moves the existing entry on a folder-only save', moved.ok === true && moved.data.targetRelPath === movedPath
      && !existsSync(join(status.effectiveLibraryDir, saved.data.relPath)), JSON.stringify(moved.data))
    check('folder-only move preserves file bytes', existsSync(join(status.effectiveLibraryDir, movedPath))
      && readFileSync(join(status.effectiveLibraryDir, movedPath), 'utf8') === updatedFile)
    check('other entries unchanged after entry editing', [...snapshots].filter(([path]) => path !== saved.data.relPath).every(([path, bytes]) => readFileSync(join(status.effectiveLibraryDir, path), 'utf8') === bytes))
    await sleep(800)
    const afterEdit = await api('e2e', { command: { action: 'state' } })
    const mainDraft = JSON.parse(readFileSync(draftFile, 'utf8'))
    check('entry editing preserves the main draft', afterEdit.data.renderer?.textLength === beforeEdit.data.renderer?.textLength && afterEdit.data.renderer?.boundRelPath === null && mainDraft.tables.draft.current.text === text)
  }

  // 4. 读取 256 KiB 的条目
  const big = `# 大文件\n\n${'内容'.repeat(256 * 1024 / 6)}\n`
  writeFileSync(join(status.effectiveLibraryDir, 'e2e-256k.md'), big)
  const read = await api('e2e', { command: { action: 'host-read', relPath: 'e2e-256k.md' } })
  check('read 256 KiB <= 300 ms', read.ok === true && read.data.ms <= 300, `${read.data.ms} ms`)

  // 5. 10 万字草稿里插入一个字符到绘制完成
  const typing = await api('e2e', { command: { action: 'typing-latency', size: 100_000 } })
  check('keystroke at 100k chars <= 50 ms', typing.ok === true && typing.data.ms <= 50, `${typing.data.ms} ms`)

  // 6. 全局快捷键和工具栏快捷键写入 profile，并立即推给小窗。
  const pidBefore = status.companionPid
  const original = status.config.globalShortcut
  const originalChat = status.config.shortcutChat
  const probe = 'Control+Alt+Shift+F9'
  const chatProbe = 'Control+Alt+Shift+F10'
  const update = await api('config', { patch: { globalShortcut: probe, shortcutChat: 'shift+alt+ctrl+f10' } })
  check('config update accepted', update.ok === true, JSON.stringify(update))
  let after = await api('status?since=-1')
  const until = Date.now() + 10_000
  while (after.shortcut?.accelerator !== probe && Date.now() < until) after = await api(`status?since=${after.seq}`)
  check('new shortcut registered live', after.shortcut?.accelerator === probe && after.shortcut.registered === true, after.shortcut?.error?.code ?? '')
  check('companion not restarted by config change', after.companionPid === pidBefore, `${pidBefore} -> ${after.companionPid}`)
  const patchFile = join(home, 'profiles', PROFILE, 'cordis.patch.yml')
  const persisted = readFileSync(patchFile, 'utf8')
  check('toolbar shortcut normalized and stored in profile', after.config.shortcutChat === chatProbe
    && /^\s*shortcutChat:\s*['"]?Control\+Alt\+Shift\+F10['"]?\s*$/m.test(persisted))
  let shortcutState = await api('e2e', { command: { action: 'state' } })
  const shortcutPushDeadline = Date.now() + 10_000
  while (shortcutState.data?.renderer?.chatShortcut !== chatProbe && Date.now() < shortcutPushDeadline) {
    await sleep(200)
    shortcutState = await api('e2e', { command: { action: 'state' } })
  }
  check('toolbar shortcut applied live in renderer', shortcutState.data?.renderer?.chatShortcut === chatProbe)
  await api('config', { patch: { globalShortcut: original, shortcutChat: originalChat } })

  // 7. 用真实 Electron 的布局核对工具栏、空白聊天栏和重启宽度。
  const rendererState = async () => (await api('e2e', { command: { action: 'state' } })).data?.renderer
  const beforeChat = await rendererState()
  check('toolbar fits the editor and chat starts closed', beforeChat?.toolbarInEditor === true && beforeChat.editorWidth > 0 && beforeChat.sessionOpen === false)
  await api('companion', { action: 'show' })
  const chat = await api('e2e', { command: { action: 'toggle-chat' } })
  const withChat = await rendererState()
  check('open chat with an input box before optimizing', chat.ok === true && withChat?.sessionOpen === true
    && withChat.chatComposerReady === true && withChat.editorWidth > 0)

  await api('companion', { action: 'restart' })
  const restartDeadline = Date.now() + 15_000
  let restarted
  do {
    after = await api('status?since=-1')
    if (after.companion.state === 'running' && after.companionPid !== pidBefore) {
      restarted = await rendererState()
      if (restarted?.draftLoaded === true && restarted.editorWidth > 0) break
    }
    await sleep(200)
  } while (Date.now() < restartDeadline)
  check('chat starts closed after restart', restarted?.sessionOpen === false)
  check('editor width preserved across restart', Math.abs(restarted?.editorWidth - withChat?.editorWidth) <= 1,
    `${withChat?.editorWidth} -> ${restarted?.editorWidth}`)

  // 8. 停止 dsh，小程序随之退出
  const pid = after.companionPid
  const exited = new Promise(resolve => dsh.once('exit', resolve))
  process.kill(-dsh.pid, 'SIGTERM')
  await exited
  dsh = null
  await sleep(2000)
  let alive = false
  try {
    if (typeof pid === 'number') {
      process.kill(pid, 0)
      alive = true
    }
  } catch {
    alive = false
  }
  check('companion exits with dsh', !alive, `pid ${pid}`)
} catch (error) {
  check('e2e run', false, error instanceof Error ? error.message : String(error))
} finally {
  if (dsh !== null) {
    try {
      process.kill(-dsh.pid, 'SIGKILL')
    } catch {
      // 进程组已经不在。
    }
  }
  if (!keep) rmSync(home, { recursive: true, force: true })
  console.log(`\n${results.filter(r => r.ok).length}/${results.length} checks passed${keep ? `; kept ${home}` : ''}`)
  process.exitCode = failed ? 1 : 0
}
