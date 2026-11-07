// 生成 src/companion/electron-release.ts：小程序运行时的 Electron 版本和各平台压缩包的 SHA-256。
//
// 版本取 devDependencies 里 electron 的版本（唯一来源）。校验值有两个来源，必须一致才写入：
// 1. 已安装的 electron npm 包自带的 checksums.json（npm 安装时有锁文件里的完整性校验保护）；
// 2. GitHub Releases 上的 SHASUMS256.txt。
// 下载源（镜像、官方）在运行时只当传输通道，校验值不从下载源获取。
//
// 用法：先 pnpm add -D electron@<版本>，再 node scripts/update-electron-checksums.mjs
import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(join(root, 'package.json'))
const electronDir = dirname(require.resolve('electron/package.json'))
const version = JSON.parse(readFileSync(join(electronDir, 'package.json'), 'utf8')).version
const npmSums = JSON.parse(readFileSync(join(electronDir, 'checksums.json'), 'utf8'))

const TARGETS = ['darwin-arm64', 'darwin-x64', 'win32-x64', 'win32-arm64', 'linux-x64', 'linux-arm64']

const response = await fetch(`https://github.com/electron/electron/releases/download/v${version}/SHASUMS256.txt`, { redirect: 'follow' })
if (!response.ok) throw new Error(`下载 SHASUMS256.txt 失败：HTTP ${response.status}`)
const githubSums = new Map()
for (const line of (await response.text()).split('\n')) {
  const match = /^([0-9a-f]{64}) [ *]?(\S+)$/.exec(line.trim())
  if (match) githubSums.set(match[2], match[1])
}

// 文件大小用来限制下载量、核对续传的 Content-Range：取 GitHub 发布资源的 Content-Length。
async function assetSize(file) {
  const res = await fetch(`https://github.com/electron/electron/releases/download/v${version}/${file}`, { method: 'HEAD', redirect: 'follow' })
  const length = Number(res.headers.get('content-length'))
  if (!res.ok || !Number.isSafeInteger(length) || length <= 0) throw new Error(`${file} 取不到文件大小：HTTP ${res.status}`)
  return length
}

const entries = []
for (const target of TARGETS) {
  const file = `electron-v${version}-${target}.zip`
  const fromNpm = npmSums[file]
  const fromGithub = githubSums.get(file)
  if (!fromNpm || !fromGithub) throw new Error(`${file} 缺少校验值（npm: ${fromNpm ?? '无'}，GitHub: ${fromGithub ?? '无'}）`)
  if (fromNpm !== fromGithub) throw new Error(`${file} 两处校验值不一致：npm ${fromNpm}，GitHub ${fromGithub}`)
  entries.push({ target, file, sha256: fromNpm, size: await assetSize(file) })
}

const lines = entries.map(e => `  '${e.target}': { file: '${e.file}', sha256: '${e.sha256}', size: ${e.size} },`).join('\n')
const content = `// 由 scripts/update-electron-checksums.mjs 生成，不要手改。
// 校验值同时核对了 electron@${version} npm 包的 checksums.json 和 GitHub Releases 的 SHASUMS256.txt。

/** 小程序使用的 Electron 版本。 */
export const ELECTRON_VERSION = '${version}'

/** 支持的平台-架构，与 Node 的 process.platform、process.arch 写法一致。 */
export type RuntimeTarget = ${TARGETS.map(t => `'${t}'`).join(' | ')}

/** 各平台压缩包的文件名、SHA-256（小写十六进制）和字节数。 */
export const ELECTRON_ASSETS: Readonly<Record<RuntimeTarget, { readonly file: string; readonly sha256: string; readonly size: number }>> = {
${lines}
}
`
const target = join(root, 'src', 'companion', 'electron-release.ts')
writeFileSync(target, content)
console.log(`wrote ${target} for Electron ${version}`)
