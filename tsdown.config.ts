import { defineConfig, type UserConfig } from 'tsdown'

// tsdown 只做转译与打包，类型检查由 `pnpm typecheck` 负责。
// 五个产物：Host、Client、小程序主进程、预加载脚本、小窗界面。
// 所有条目都 clean: false，由 build 脚本先删 lib/，避免数组里的条目并行构建时互相清掉产物。

const production = JSON.stringify(process.env.NODE_ENV ?? 'production')

/** Host 半边：Node 库 lib/index.js，dsh 按包名加载。dsh 自己的包从宿主解析，其余内联。 */
const host: UserConfig = {
  name: 'host',
  entry: { index: 'src/index.ts' },
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  dts: false,
  clean: false,
  fixedExtension: false,
  external: [/^@deepseek-ai\//],
  noExternal: (id: string) => (id.startsWith('@deepseek-ai/') ? undefined : true),
}

// Client 半边：照搬 kun2-5code/dsh-plugin-template 的做法，产物包成 __ModuleLoader__ 格式，
// React 从 dsh 页面的模块表取，其余（包括 shared 代码）内联。
const CLIENT_EXTERNALS = ['react', 'react/jsx-runtime']
const client: UserConfig = {
  name: 'client',
  entry: { client: 'src/client/index.tsx' },
  outDir: 'lib',
  format: ['cjs'],
  platform: 'browser',
  target: 'es2022',
  dts: false,
  clean: false,
  sourcemap: false,
  external: CLIENT_EXTERNALS,
  noExternal: (id: string) => (CLIENT_EXTERNALS.includes(id) ? undefined : true),
  define: { 'process.env.NODE_ENV': production },
  outputOptions: {
    entryFileNames: 'client.js',
    banner: 'window.__ModuleLoader__.load({ id: "dsh-promptx", factory: (require) => {',
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
}

/** 小程序主进程：CJS，electron 由运行时提供，其余内联。 */
const appMain: UserConfig = {
  name: 'app-main',
  entry: { main: 'src/app/main/index.ts' },
  outDir: 'lib/app',
  format: ['cjs'],
  platform: 'node',
  target: 'es2024',
  dts: false,
  clean: false,
  external: ['electron'],
  noExternal: (id: string) => (id === 'electron' ? undefined : true),
  outputOptions: { entryFileNames: 'main.cjs' },
}

// 预加载脚本：Electron 44 起沙箱预加载只能 require 'electron'，所以只外部化它。
const appPreload: UserConfig = {
  name: 'app-preload',
  entry: { preload: 'src/app/preload/index.ts' },
  outDir: 'lib/app',
  format: ['cjs'],
  platform: 'node',
  target: 'es2024',
  dts: false,
  clean: false,
  external: ['electron'],
  noExternal: (id: string) => (id === 'electron' ? undefined : true),
  outputOptions: { entryFileNames: 'preload.cjs' },
}

/** 小窗界面：IIFE，React 和 CodeMirror 全部打包进来。 */
const appRenderer: UserConfig = {
  name: 'app-renderer',
  entry: { renderer: 'src/app/renderer/index.tsx' },
  outDir: 'lib/app/renderer',
  format: ['iife'],
  platform: 'browser',
  target: 'es2022',
  dts: false,
  clean: false,
  noExternal: () => true,
  define: { 'process.env.NODE_ENV': production },
  outputOptions: { entryFileNames: 'renderer.js' },
}

export default defineConfig([host, client, appMain, appPreload, appRenderer])
