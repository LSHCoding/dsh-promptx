// 从一轮优化回复里提取候选改写稿（需求 O-03）。
//
// 候选是信息串为 `prompt` 的代码块的内容。模型按格式约定用四个反引号包外层、三个反引号写内层，
// 但实际回复里经常出现等长的内层代码块、忘了收尾、在说明文字里再举一个代码块的例子等情况。
// 这里的取舍是：边界只要有两种读法，就宁可不给候选（界面退回「复制回复」），也不给出截断的改写稿，
// 因为「应用」会整篇替换编辑区，截断的候选比没有候选更糟。
//
// 规则（行首最多 3 个空格的 ```prompt 开头；围栏行只认反引号）：
// - 候选内没有打开的内层代码块时：
//   - 只有反引号、个数 c ≥ N（外层长度）的行结束候选；c < N 的打开一个无信息串的内层代码块。
//   - 带信息串、长度 M < N 的围栏行打开内层代码块（包括更短的 ```prompt 示例）；M ≥ N 时判断不出
//     内外层归属，这一块作废。
//   - 同样长或更长的 prompt 开头行：前一块没结束又出现一个，前一块作废，从这一行重新开始。
// - 内层代码块（长度 K）打开时：只有反引号、个数 c ≥ K 的行结束它；c 同时 ≥ N 时也可能是外层结尾，
//   这一块作废。其余行（包括带信息串的围栏行）都是正文。
// - 候选结束后、下一个 prompt 开头之前，如果在普通代码块之外又出现只有反引号、个数不少于外层的行，
//   刚才的「结尾」也可能是一个等长内层代码块的开头，这一块作废。
// - 候选之外的普通代码块照常配对，里面的 ```prompt 只是代码块内容，不算开头。
// - 内容只有空白的块不算候选：应用它等于清空编辑区。
// - 取最后一个完整、无歧义的候选；没结束的块不算。

import { isBlank } from './text-metrics.ts'

type Line =
  /** prompt 开头行：行首 0–3 个空格，3 个以上反引号紧跟 prompt（不区分大小写），之后只有空白。 */
  | { kind: 'opener'; length: number }
  /** 其他带信息串的围栏行。信息串里不能有反引号，否则按 Markdown 规则这不是围栏。 */
  | { kind: 'info'; length: number }
  /** 只有反引号（前后可以有空白）的围栏行。 */
  | { kind: 'bare'; length: number }
  | { kind: 'text' }

const OPENER = /^ {0,3}(`{3,})prompt[ \t]*$/i
const BARE = /^[ \t]*(`{3,})[ \t]*$/
const INFO = /^[ \t]*(`{3,})([^`]*)$/

function classify(line: string): Line {
  const opener = OPENER.exec(line)
  if (opener?.[1] !== undefined) return { kind: 'opener', length: opener[1].length }
  const bare = BARE.exec(line)
  if (bare?.[1] !== undefined) return { kind: 'bare', length: bare[1].length }
  const info = INFO.exec(line)
  if (info?.[1] !== undefined && !isBlank(info[2] ?? '')) return { kind: 'info', length: info[1].length }
  return { kind: 'text' }
}

interface OpenBlock {
  /** 外层反引号个数 N。 */
  fence: number
  /**
   * 结束后判断「其实没结束」用的长度。重新开始的块可能其实是前一块里的内层代码块，
   * 那样的话前一块的结尾还在后面，所以取这一串重新开始的块里最早那一块的长度。
   */
  threshold: number
  /** 打开中的内层代码块的反引号个数；没有时为 null。 */
  inner: number | null
  valid: boolean
  lines: string[]
}

interface Pending {
  text: string
  threshold: number
}

function startBlock(fence: number, threshold: number): OpenBlock {
  return { fence, threshold, inner: null, valid: true, lines: [] }
}

/**
 * 返回最后一个完整、边界无歧义的候选的内容（开头行和结尾行之间的各行，按 `\n` 拼接，原样保留）；
 * 没有时返回 null。CRLF 和 CR 都按换行处理。
 */
export function extractCandidate(reply: string): string | null {
  const lines = reply.replace(/\r\n?/g, '\n').split('\n')
  /** 已经确定的最后一个候选：它之后出现了新的 prompt 开头，边界不会再被推翻。 */
  let committed: string | null = null
  /** 刚结束的候选，后面的围栏行还可能让它作废。 */
  let pending: Pending | null = null
  let block: OpenBlock | null = null
  /** 候选之外的普通代码块的开头长度；不在普通代码块里时为 null。 */
  let regular: number | null = null

  for (const line of lines) {
    const fence = classify(line)

    if (block !== null) {
      if (block.inner !== null) {
        if (fence.kind === 'bare' && fence.length >= block.inner) {
          // 能结束内层的行如果也够长到结束外层，就不知道它属于哪一层。
          if (fence.length >= block.fence) block.valid = false
          block.inner = null
        }
        block.lines.push(line)
        continue
      }
      switch (fence.kind) {
        case 'bare':
          if (fence.length >= block.fence) {
            const text = block.lines.join('\n')
            if (block.valid && !isBlank(text)) pending = { text, threshold: block.threshold }
            block = null
          } else {
            block.inner = fence.length
            block.lines.push(line)
          }
          break
        case 'opener':
          if (fence.length >= block.fence) {
            block = startBlock(fence.length, Math.min(block.threshold, fence.length))
          } else {
            block.inner = fence.length
            block.lines.push(line)
          }
          break
        case 'info':
          if (fence.length >= block.fence) block.valid = false
          block.inner = fence.length
          block.lines.push(line)
          break
        case 'text':
          block.lines.push(line)
          break
      }
      continue
    }

    if (regular !== null) {
      if (fence.kind === 'bare' && fence.length >= regular) regular = null
      continue
    }

    switch (fence.kind) {
      case 'opener':
        if (pending !== null) committed = pending.text
        pending = null
        block = startBlock(fence.length, fence.length)
        break
      case 'bare':
        if (pending !== null && fence.length >= pending.threshold) pending = null
        regular = fence.length
        break
      case 'info':
        regular = fence.length
        break
      case 'text':
        break
    }
  }

  return pending?.text ?? committed
}
