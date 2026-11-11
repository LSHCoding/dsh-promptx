// tests/host/plugin.spec.ts 用的模拟小程序：独立的 Node 脚本，自己实现最小的 NDJSON + JSON-RPC 2.0。
// 测试把它包成假的 Electron 可执行文件放进运行时目录，由真实的 Host（src/index.ts）启动。
//
// 行为由 `<PROMPTX_DATA_DIR>/mock-script.json` 决定（测试在启动插件前写好）：
//   protocol        hello 里报的协议版本
//   typed           读回草稿后保存的文字（null 表示不保存）
//   flush           收到 shutdown 时先写回的草稿（null 表示不写）
//   locale          status 里报的界面语言
//   rendererError   status 里报的界面崩溃状态
//   saveText        读回草稿后保存到库的文字（null 表示不保存）
//   sweep           不为 null 时，最后用它作为内容依次调用库、回收站、优化的各个请求（日志不含内容的检查）
// 每一步往 `<PROMPTX_DATA_DIR>/mock-events.txt` 追加一行 `<pid> <事件>`，测试据此核对。
// 和真实的小程序一样：stdin 读到结尾就退出，测试结束后不会留下孤儿进程。

import { appendFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const dataDir = process.env.PROMPTX_DATA_DIR ?? '.'
const script = JSON.parse(readFileSync(join(dataDir, 'mock-script.json'), 'utf8'))

function log(line) {
  try {
    appendFileSync(join(dataDir, 'mock-events.txt'), `${process.pid} ${line}\n`)
  } catch {
    // 数据目录已经被测试删掉：没关系。
  }
}

process.stdout.on('error', () => process.exit(0))
process.stderr.on('error', () => {})
log('start')

let nextId = 1
const pending = new Map()

function send(message) {
  if (process.stdout.writable) process.stdout.write(`${JSON.stringify(message)}\n`)
}

function request(method, params) {
  const id = nextId++
  send({ jsonrpc: '2.0', id, method, params })
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
  })
}

function notify(method, params) {
  send({ jsonrpc: '2.0', method, params })
}

async function onRequest(message) {
  if (message.method === 'ping') {
    send({ jsonrpc: '2.0', id: message.id, result: {} })
    return
  }
  if (message.method === 'shutdown') {
    if (script.flush !== null) {
      try {
        await request('draft.save', { text: script.flush, selection: null, binding: null })
        log('flush ok')
      } catch (error) {
        log(`flush failed ${JSON.stringify(error?.data ?? error)}`)
      }
    }
    send({ jsonrpc: '2.0', id: message.id, result: {} })
    setTimeout(() => process.exit(0), 20)
    return
  }
  send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'method not found' } })
}

let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  for (;;) {
    const end = buffer.indexOf('\n')
    if (end < 0) break
    const line = buffer.slice(0, end)
    buffer = buffer.slice(end + 1)
    if (line.trim() === '') continue
    let message
    try {
      message = JSON.parse(line)
    } catch {
      continue
    }
    if (typeof message.method === 'string') {
      if (message.id !== undefined) onRequest(message).catch(() => {})
      continue
    }
    const waiter = pending.get(message.id)
    if (waiter === undefined) continue
    pending.delete(message.id)
    if (message.error) waiter.reject(message.error)
    else waiter.resolve(message.result)
  }
})
process.stdin.on('end', () => {
  log('stdin-end')
  process.exit(0)
})

async function main() {
  try {
    await request('hello', { protocol: script.protocol, appVersion: 'mock', electron: 'mock', platform: process.platform, arch: process.arch })
    log('hello ok')
  } catch {
    log('hello failed')
    return
  }
  notify('status', { shortcut: null, tray: false, visible: false, locale: script.locale, rendererError: script.rendererError })
  try {
    const result = await request('draft.load', {})
    log(`load ok ${JSON.stringify(result?.record?.text ?? null)}`)
  } catch (error) {
    log(`load failed ${JSON.stringify(error?.data ?? error)}`)
    return
  }
  if (script.typed !== null) {
    try {
      await request('draft.save', { text: script.typed, selection: null, binding: null })
      log('save ok')
    } catch (error) {
      log(`save failed ${JSON.stringify(error?.data ?? error)}`)
    }
  }
  if (script.saveText !== null) {
    try {
      const result = await request('library.save', { text: script.saveText, binding: null, folder: null, mode: 'normal', requestId: 'mock-1' })
      log(`library ok ${JSON.stringify(result?.binding?.title ?? null)}`)
    } catch (error) {
      log(`library failed ${JSON.stringify(error?.data ?? error)}`)
    }
  }
  if (script.sweep !== null) await sweep(script.sweep)
  log('script done')
}

async function step(name, method, params) {
  try {
    const result = await request(method, params)
    log(`step ${name} ok`)
    return result
  } catch (error) {
    log(`step ${name} error ${JSON.stringify(error?.data ?? error)}`)
    return null
  }
}

const pause = ms => new Promise(resolve => setTimeout(resolve, ms))

async function sweep(secret) {
  await step('draft.save', 'draft.save', { text: `${secret} draft`, selection: null, binding: null })
  const saved = await step('library.save', 'library.save', { text: `# ${secret}\n\n${secret} body\n`, binding: null, folder: null, mode: 'normal', requestId: 'sweep-1' })
  const binding = saved?.binding ?? null
  const relPath = binding?.relPath ?? `${secret}.md`
  await step('library.read', 'library.read', { relPath })
  await step('favorite', 'library.updateMeta', { relPath, patch: { favorite: true }, addFrontMatter: false })
  await step('rename', 'library.updateMeta', { relPath, patch: { title: `${secret} renamed` }, addFrontMatter: false })
  if (binding !== null) {
    await step('stale save', 'library.save', { text: `${secret} stale`, binding: { ...binding, sha256: '0'.repeat(64) }, folder: null, mode: 'normal', requestId: 'sweep-2' })
  }
  const deleted = await step('library.delete', 'library.delete', { relPath })
  await step('trash.list', 'trash.list', { query: secret })
  if (deleted !== null) {
    await step('trash.read', 'trash.read', { file: deleted.trashFile })
    await step('trash.restore', 'trash.restore', { file: deleted.trashFile, target: 'original', alternative: null, acceptModified: false })
  }
  await step('missing read', 'library.read', { relPath: `${secret}-missing.md` })
  await step('bad path', 'library.read', { relPath: `../${secret}.md` })
  await step('bad folder', 'library.save', { text: `${secret} x`, binding: null, folder: `../${secret}`, mode: 'normal', requestId: 'sweep-3' })
  await step('library.list', 'library.list', { folder: { kind: 'all' }, scope: 'all', tag: null, query: secret, refresh: true })
  const suggestion = await step('library.suggestMetadata', 'library.suggestMetadata', { text: `${secret} metadata` })
  if (suggestion?.metadata === null) log('metadata manual fallback')
  await step('optimize.start', 'optimize.start', { text: `${secret} optimize` })
  await pause(400)
  await step('optimize.followup', 'optimize.followup', { text: `${secret} again` })
  await pause(400)
  await step('optimize.state', 'optimize.state', {})
  log('sweep done')
}

main().catch(() => {})
