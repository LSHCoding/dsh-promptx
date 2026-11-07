// 明暗、平台和语言写到页面上（需求 S-03，技术方案 4.7）。dsh-theme.css 按 body[data-ds-dark-theme] 切换深色、
// 按 html[data-platform=darwin] 取 macOS 的菜单底色，和 dsh 页面用的是同一套选择器。

export interface Appearance {
  theme: 'light' | 'dark'
  platform: string
  locale: 'zh' | 'en'
}

export function applyAppearance(doc: Document, appearance: Appearance): void {
  doc.documentElement.setAttribute('data-platform', appearance.platform)
  doc.documentElement.lang = appearance.locale === 'zh' ? 'zh-CN' : 'en'
  doc.body.toggleAttribute('data-ds-dark-theme', appearance.theme === 'dark')
}

/**
 * 这次按键属于输入法组字：组字中的 Enter 用来选词、Esc 用来取消组字，插件的快捷键和自动行为都不处理（E-01、O-05）。
 * Chromium 在组字开始的那一下只给 keyCode 229，isComposing 还是 false，所以两个条件都要看。
 */
export function isComposingKey(event: { isComposing: boolean; keyCode: number }): boolean {
  return event.isComposing || event.keyCode === 229
}
