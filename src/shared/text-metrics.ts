// 底栏的字符数和「空白」判断（需求 E-03）。字符数按用户看到的字符计：一个汉字、一个 emoji、
// 一个带组合符号的字母都算 1 个，所以按字形簇切分，不能用 UTF-16 长度。

/** undefined：还没检查过；null：运行环境没有 Intl.Segmenter。 */
let graphemeSegmenter: Intl.Segmenter | null | undefined

function getSegmenter(): Intl.Segmenter | null {
  if (graphemeSegmenter === undefined) {
    // 小窗和配置页都跑在较新的 Chromium / Node 上，正常都有 Segmenter；
    // 留一条退路是为了在缺少完整 ICU 的环境里底栏仍能显示一个接近的数字，而不是直接报错。
    const Segmenter = (Intl as { Segmenter?: typeof Intl.Segmenter }).Segmenter
    graphemeSegmenter = Segmenter === undefined ? null : new Segmenter('und', { granularity: 'grapheme' })
  }
  return graphemeSegmenter
}

/** 按字形簇计数；没有 Intl.Segmenter 时退回按码点计数（emoji 组合序列会多算）。 */
export function countCharacters(text: string): number {
  if (text === '') return 0
  const segmenter = getSegmenter()
  let count = 0
  if (segmenter === null) {
    for (const _codePoint of text) count++
    return count
  }
  for (const _segment of segmenter.segment(text)) count++
  return count
}

/** 只含空白（含全角空格、换行、制表符）或为空。用 \S 找第一个非空白字符，10 万字的草稿也不必整篇复制。 */
export function isBlank(text: string): boolean {
  return !/\S/.test(text)
}
