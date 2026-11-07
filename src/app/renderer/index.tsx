// 小窗界面的入口：拿到预加载脚本暴露的桥，创建总控，挂上 React。

import { createRoot } from 'react-dom/client'
import { getBridge } from './bridge.ts'
import { App } from './components/App.tsx'
import { AppController, fallbackLocale } from './controller/app.ts'
import { runTask } from './controller/context.ts'

function main(): void {
  const container = document.getElementById('root')
  if (container === null) return
  const bridge = getBridge()
  if (bridge === null) {
    // 只有在小程序之外直接打开 index.html 时才会走到这里。
    container.textContent = 'PromptX: the preload bridge is missing.'
    return
  }
  // 主进程在 hello 回复之后才有配置；在那之前跟随系统的语言和明暗，拿到配置后立即切换。
  const dark = window.matchMedia('(prefers-color-scheme: dark)').matches
  const controller = new AppController({ bridge, locale: fallbackLocale(), theme: dark ? 'dark' : 'light' })
  createRoot(container).render(<App controller={controller} />)
  runTask(controller.start())
}

main()
