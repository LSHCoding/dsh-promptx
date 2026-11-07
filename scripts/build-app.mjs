// tsdown 之后的第二步：把小程序组装成 Electron 能直接加载的目录 lib/app/。
// Electron 以「可执行文件 <lib/app 目录>」启动，读取这里的 package.json 的 main。
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const app = join(root, 'lib', 'app')

for (const file of ['main.cjs', 'preload.cjs', join('renderer', 'renderer.js')]) {
  if (!existsSync(join(app, file))) throw new Error(`缺少构建产物 lib/app/${file}，先运行 tsdown`)
}

// 预加载脚本只能依赖 electron：44 的沙箱预加载还能 require events/timers/url，45 起只剩 electron，
// 在构建阶段挡住，升级 Electron 时不会在运行时才发现（审查意见 TC-15）。
const preloadRequires = [...readFileSync(join(app, 'preload.cjs'), 'utf8').matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)].map(m => m[1])
const unexpected = preloadRequires.filter(name => name !== 'electron')
if (unexpected.length > 0) throw new Error(`lib/app/preload.cjs 只能 require electron，发现：${[...new Set(unexpected)].join(', ')}`)

writeFileSync(join(app, 'package.json'), `${JSON.stringify({
  name: 'promptx-companion',
  productName: 'PromptX',
  version: pkg.version,
  private: true,
  main: 'main.cjs',
}, null, 2)}\n`)

const rendererSrc = join(root, 'src', 'app', 'renderer')
cpSync(join(rendererSrc, 'index.html'), join(app, 'renderer', 'index.html'))
for (const name of readdirSync(join(rendererSrc, 'styles'))) {
  if (name.endsWith('.css')) cpSync(join(rendererSrc, 'styles', name), join(app, 'renderer', name))
}

const trayOut = join(app, 'assets', 'tray')
mkdirSync(trayOut, { recursive: true })
for (const name of readdirSync(join(root, 'assets', 'tray'))) {
  if (name.endsWith('.png')) cpSync(join(root, 'assets', 'tray', name), join(trayOut, name))
}
console.log('assembled lib/app')
