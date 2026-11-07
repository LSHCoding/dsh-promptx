// 从 @deepseek-ai/dsh-client-ui-theme 的 Client 产物里提取 dsh 的主题变量（--dsw-*、--dsh-*），
// 生成小窗用的 src/app/renderer/styles/dsh-theme.css。小窗的样式只引用这些同名变量，
// 观感和 dsh 一致；dsh 升级换色后重新运行本脚本即可。
//
// 用法：node scripts/extract-dsh-theme.mjs
import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(join(root, 'package.json'))
const pkgPath = require.resolve('@deepseek-ai/dsh-client-ui-theme/package.json')
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
const source = readFileSync(join(dirname(pkgPath), 'lib', 'client.js'), 'utf8')

// 产物里的样式是压缩后的字符串字面量。按「选择器 { 声明 }」切块，只保留定义主题变量的块。
const KEEP_SELECTOR = /^(?::root|body|body\[data-ds-dark-theme\]|html\[data-platform=[a-z0-9]+\] body(?:\[data-ds-dark-theme\])?)$/
const rules = []
const seen = new Set()
for (const match of source.matchAll(/([^{}"'`;]+)\{([^{}]*)\}/g)) {
  const selector = match[1].trim()
  if (!KEEP_SELECTOR.test(selector)) continue
  // 字符串字面量里的引号是转义过的（\\"），还原成 CSS 原文。
  const declarations = match[2]
    .replace(/\\(["'\\])/g, '$1')
    .split(';')
    .map(part => part.trim())
    .filter(part => /^--(?:dsw|dsh)-[a-z0-9-]+\s*:/.test(part))
  if (declarations.length === 0) continue
  const key = `${selector}{${declarations.join(';')}}`
  if (seen.has(key)) continue
  seen.add(key)
  rules.push({ selector, declarations })
}

if (!rules.some(rule => rule.selector === 'body[data-ds-dark-theme]')) {
  throw new Error('没有找到深色主题的变量块，dsh-client-ui-theme 的产物结构可能变了')
}

const header = `/*
 * 由 scripts/extract-dsh-theme.mjs 从 @deepseek-ai/dsh-client-ui-theme ${pkg.version} 生成，不要手改。
 * 来源：DeepSeek Harness（https://github.com/deepseek-ai/deepseek-harness），MIT 许可，
 * 版权归 DeepSeek 所有；许可全文见 THIRD_PARTY_NOTICES.md。
 */
`
const body = rules
  .map(rule => `${rule.selector} {\n${rule.declarations.map(d => `  ${d.replace(/\s*:\s*/, ': ')};`).join('\n')}\n}\n`)
  .join('\n')
const target = join(root, 'src', 'app', 'renderer', 'styles', 'dsh-theme.css')
writeFileSync(target, `${header}\n${body}`)
console.log(`wrote ${target}: ${rules.length} rule blocks, ${rules.reduce((n, r) => n + r.declarations.length, 0)} variables`)
