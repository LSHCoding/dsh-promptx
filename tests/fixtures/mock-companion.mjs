// 测试用的模拟小程序：独立的 Node 脚本，不 import 项目里的 TS 代码，自己实现最小的 NDJSON + JSON-RPC 2.0。
// supervisor.spec.ts 用 process.execPath 启动它，用参数选择行为：
//
//   --mode=<模式>          见下面的 MODES
//   --protocol=<n>         hello 里报的协议版本（supervisor.spec.ts 默认传当前的 PROTOCOL_VERSION）
//   --stderr-lines=<n>     启动时往 stderr 写 n 行
//   --garbage              hello 之前先发几帧坏数据
//   --notify-first         hello 之前先发一个 status 通知
//   --ping-delay=<ms>      隔这么久才回 ping，每收到一个往 stderr 写 ping received；上一个 ping 还没回又收到新的，
//                          往 stderr 写 ping overlap
//
// 握手成功后往 stderr 写一行 `hello ok: protocol=<n> mode=<模式> host=<版本>`，测试据此核对 Host 的 hello 回复。
//
// 和真实的小程序一样：stdin 读到结尾（Host 退出或关掉管道）就退出，避免测试结束后留下孤儿进程。

const MODES = new Set([
  'normal', // 握手、回 ping、收到 shutdown 回复后以 0 退出
  'no-handshake', // 不发 hello
  'wrong-protocol', // hello 里报错误的协议版本，收到错误回复后照常活着，等 Host 结束它
  'exit-early', // 一启动就以退出码 3 退出
  'ignore-ping', // 握手后不回 ping
  'ignore-sigterm', // 握手后忽略 SIGTERM，也不回 shutdown，只能 SIGKILL
  'crash-after-ready', // 握手后 50 ms 以退出码 1 退出
  'draft-on-shutdown', // 收到 shutdown 后先发 status 通知和 draft.save 请求，拿到回复再回复 shutdown
  'close-stdout', // 握手后关掉 stdout，但进程继续活着
  'stop-reading', // 握手后不再读 stdin（Host 的写缓冲会越积越多）
])

const options = new Map()
for (const arg of process.argv.slice(2)) {
  const [key, value = 'true'] = arg.replace(/^--/, '').split('=')
  options.set(key, value)
}
const mode = options.get('mode') ?? 'normal'
if (!MODES.has(mode)) {
  process.stderr.write(`unknown mode: ${mode}\n`)
  process.exit(2)
}

// Host 关掉管道后再写会 EPIPE：直接退出，不要让异常把测试输出弄乱。
process.stdout.on('error', () => process.exit(0))
process.stderr.on('error', () => {})

let nextId = 1
const pending = new Map()
const pingDelay = Number(options.get('ping-delay') ?? 0)
let pingsInFlight = 0

function send(message) {
  if (!process.stdout.writable) return
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

function request(method, params) {
  const id = nextId++
  send({ jsonrpc: '2.0', id, method, params })
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }))
}

function notify(method, params) {
  send({ jsonrpc: '2.0', method, params })
}

function reply(id, result) {
  send({ jsonrpc: '2.0', id, result })
}

async function onRequest(message) {
  switch (message.method) {
    case 'ping':
      if (mode === 'ignore-ping') return
      if (pingsInFlight > 0) process.stderr.write('ping overlap\n')
      pingsInFlight += 1
      if (pingDelay > 0) {
        process.stderr.write('ping received\n')
        await new Promise(resolve => setTimeout(resolve, pingDelay))
      }
      pingsInFlight -= 1
      reply(message.id, {})
      return
    case 'shutdown':
      if (mode === 'ignore-sigterm') return
      if (mode === 'draft-on-shutdown') {
        notify('status', { shortcut: null, tray: false, visible: false, locale: 'en', rendererError: null })
        try {
          await request('draft.save', { text: 'draft written on shutdown', selection: null, binding: null })
        } catch {
          // Host 没处理也照样退出。
        }
      }
      reply(message.id, {})
      setTimeout(() => process.exit(0), 10)
      return
    default:
      send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `method not found: ${message.method}` } })
  }
}

function onMessage(message) {
  if (typeof message.method === 'string') {
    if (message.id !== undefined) {
      onRequest(message).catch(() => {})
    }
    return
  }
  const waiter = pending.get(message.id)
  if (waiter === undefined) return
  pending.delete(message.id)
  if (message.error !== undefined) waiter.reject(message.error)
  else waiter.resolve(message.result)
}

let buffer = ''
function onData(chunk) {
  buffer += chunk
  for (;;) {
    const index = buffer.indexOf('\n')
    if (index === -1) break
    const line = buffer.slice(0, index)
    buffer = buffer.slice(index + 1)
    if (line.trim() === '') continue
    try {
      onMessage(JSON.parse(line))
    } catch {
      // 坏帧忽略。
    }
  }
}
process.stdin.setEncoding('utf8')
process.stdin.on('data', onData)
process.stdin.on('end', () => process.exit(0))

const stderrLines = Number(options.get('stderr-lines') ?? 0)
for (let i = 0; i < stderrLines; i++) process.stderr.write(`mock stderr line ${i + 1}\n`)

async function main() {
  if (mode === 'exit-early') {
    process.exit(3)
  }
  if (options.has('garbage')) {
    process.stdout.write('this is not json\n')
    process.stdout.write('\n')
    process.stdout.write('{"jsonrpc":"2.0","method":\n')
  }
  if (options.has('notify-first')) notify('status', { shortcut: null, tray: true, visible: false, locale: 'en', rendererError: null })
  if (mode === 'no-handshake') return
  if (mode === 'ignore-sigterm') process.on('SIGTERM', () => {})
  const protocol = mode === 'wrong-protocol' ? 999 : Number(options.get('protocol') ?? 1)
  try {
    const result = await request('hello', { protocol, appVersion: '0.0.0-mock', electron: 'mock', platform: process.platform, arch: process.arch })
    process.stderr.write(`hello ok: protocol=${result?.protocol} mode=${result?.mode} host=${result?.hostVersion}\n`)
  } catch (error) {
    // 把错误码写到 stderr，测试从 Host 的日志里核对；然后照常活着，等 Host 结束它（验证 Host 不会把它留下）。
    process.stderr.write(`hello rejected: ${error?.code} ${error?.data?.code}\n`)
    return
  }
  if (mode === 'crash-after-ready') setTimeout(() => process.exit(1), 50)
  if (mode === 'close-stdout') {
    setTimeout(() => {
      process.stdout.end()
    }, 50)
  }
  if (mode === 'stop-reading') {
    setTimeout(() => {
      process.stdin.off('data', onData)
      process.stdin.pause()
      // 暂停后 stdin 不再让事件循环保持活跃，进程会自己退出：用一个计时器把它留住，等 Host 来结束。
      setInterval(() => {}, 1_000)
    }, 20)
  }
}

main().catch(() => process.exit(1))
