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
