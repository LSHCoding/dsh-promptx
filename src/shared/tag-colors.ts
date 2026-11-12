// 标签的颜色（V0.1.5 维护者追加，配色方案 A「雾霭」）：按标签名算出色号，新标签直接有颜色。
// 同一个标签在列表、预览、不同电脑上都是同一个颜色，不需要存任何数据；色数比标签少时会有重色，这是不存数据的代价。
// 色号对应的颜色定义在小窗的 app.css（浅色、深色各一套）。纯逻辑，Host、Client、小程序都可以用。

import { tagKey } from './library-rules.ts'

/** 配色方案里的颜色数。改动它会让所有标签换色，app.css 里的色号要同步增删。 */
export const TAG_COLOR_COUNT = 10

/**
 * 标签名的 32 位哈希：FNV-1a，再做一次 murmur3 的位混合（fmix32）。
 * 只用 FNV-1a 时，色数是 2 的幂（例如 8）取模只看最低几位，FNV-1a 的低位不够散，颜色会扎堆。
 * 按 UTF-16 码元计算，和设计稿里的示例一致。
 */
export function tagHash(text: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  hash ^= hash >>> 16
  hash = Math.imul(hash, 0x85ebca6b) >>> 0
  hash ^= hash >>> 13
  hash = Math.imul(hash, 0xc2b2ae35) >>> 0
  hash ^= hash >>> 16
  return hash >>> 0
}

/** 标签的色号（0 到 TAG_COLOR_COUNT - 1）。和比较标签是否相同用同一个键：忽略大小写，统一 Unicode 组合形式。 */
export function tagColorIndex(tag: string): number {
  return tagHash(tagKey(tag)) % TAG_COLOR_COUNT
}
