import { defineLanguageFacet, HighlightStyle, Language, languageDataProp, syntaxHighlighting, syntaxTree } from '@codemirror/language'
import type { Extension, Range } from '@codemirror/state'
import { Decoration, ViewPlugin, type DecorationSet, type EditorView, type ViewUpdate } from '@codemirror/view'
import { styleTags, Tag, tags } from '@lezer/highlight'
import { parser } from '@lezer/markdown'

const listMark = Tag.define()
const linkSyntax = Tag.define()
const codeFence = Tag.define()
const codeText = Tag.define()

const languageData = defineLanguageFacet()
const markdown = new Language(languageData, parser.configure({
  props: [
    languageDataProp.add({ Document: languageData }),
    // 用语法树区分同一个符号的用途，例如行内反引号与代码块围栏。
    // 标题的 #、强调的星号、引用的 >、行内代码的反引号沿用默认的 processingInstruction，统一按语法符号着色。
    styleTags({
      ListMark: listMark,
      'Link/LinkMark Link/URL Link/LinkTitle Link/LinkLabel Image/LinkMark Image/URL Image/LinkTitle Image/LinkLabel': linkSyntax,
      'FencedCode/CodeMark FencedCode/CodeInfo': codeFence,
      'FencedCode/CodeText CodeBlock/CodeText': codeText,
    }),
  ],
}), [], 'markdown')

// 和插入菜单的标签名规则一致。CommonMark 不把带 . 或 : 的名字当成 HTML，只看语法树会漏掉菜单插入的这类标签。
const TAG = /<(\/?)([A-Za-z][\w.:-]*)(?:\s[^<>\n]*)?\/?>/g
// 这些节点里的尖括号属于代码、链接地址或注释，不按标签着色。
const RAW_NODES = new Set(['InlineCode', 'FencedCode', 'CodeBlock', 'URL', 'Comment', 'CommentBlock', 'ProcessingInstruction', 'ProcessingInstructionBlock'])

const codeSpan = Decoration.mark({ class: 'px-md-code-span' })
const tagSpan = Decoration.mark({ class: 'px-md-tag' })
const tagBracket = Decoration.mark({ class: 'px-md-tag-bracket' })
const tagName = Decoration.mark({ class: 'px-md-tag-name' })
const quoteLine = Decoration.line({ class: 'px-md-quote-line' })
const codeLine = Decoration.line({ class: 'px-md-code-line' })
const codeStart = Decoration.line({ class: 'px-md-code-line px-md-code-start' })
const codeEnd = Decoration.line({ class: 'px-md-code-line px-md-code-end' })
const codeOnly = Decoration.line({ class: 'px-md-code-line px-md-code-start px-md-code-end' })

/** 代码块和引用的整行样式、行内代码的底色、自定义标签块。只算当前渲染范围。 */
function blockDecorations(view: EditorView): DecorationSet {
  const { doc } = view.state
  const { from, to } = view.viewport
  const firstVisible = doc.lineAt(from).number
  const lastVisible = doc.lineAt(to).number
  const ranges: Array<Range<Decoration>> = []
  const raw: Array<{ from: number; to: number }> = []
  // 嵌套引用的内层和外层覆盖同一批行，每行只加一次。
  let quotedThrough = 0
  syntaxTree(view.state).iterate({
    from,
    to,
    enter(node) {
      if (node.name === 'FencedCode' || node.name === 'CodeBlock') {
        const first = doc.lineAt(node.from).number
        const last = doc.lineAt(node.to).number
        for (let number = Math.max(first, firstVisible); number <= Math.min(last, lastVisible); number++) {
          const decoration = number === first ? (number === last ? codeOnly : codeStart) : number === last ? codeEnd : codeLine
          ranges.push(decoration.range(doc.line(number).from))
        }
      } else if (node.name === 'Blockquote') {
        const first = Math.max(doc.lineAt(node.from).number, quotedThrough + 1, firstVisible)
        const last = doc.lineAt(node.to).number
        for (let number = first; number <= Math.min(last, lastVisible); number++) ranges.push(quoteLine.range(doc.line(number).from))
        quotedThrough = Math.max(quotedThrough, last)
        return
      } else if (node.name === 'InlineCode') {
        ranges.push(codeSpan.range(node.from, node.to))
      } else if (node.name === 'Autolink') {
        // 带冒号的标签名（例如菜单插入的 <ns:tag>）会被 CommonMark 当成自动链接 <scheme:rest>。
        // 真正的网址和邮箱带 / 或 @，标签的写法匹配不上，所以不排除自动链接，也不进去排除它的 URL。
        return false
      }
      if (!RAW_NODES.has(node.name)) return
      raw.push({ from: node.from, to: node.to })
      return false
    },
  })
  for (const match of view.state.sliceDoc(from, to).matchAll(TAG)) {
    const start = from + match.index
    const end = start + match[0].length
    if (raw.some(range => range.from < end && range.to > start)) continue
    const nameStart = start + 1 + (match[1] ?? '').length
    const nameEnd = nameStart + (match[2] ?? '').length
    ranges.push(
      tagSpan.range(start, end),
      tagBracket.range(start, nameStart),
      tagName.range(nameStart, nameEnd),
      tagBracket.range(nameEnd, end),
    )
  }
  return Decoration.set(ranges, true)
}

// 语法高亮插件用的是 Prec.high，优先级高的标记嵌在里层。这个插件保持默认优先级，
// 行内代码底色和标签块因此各是一个包在高亮分段外面的元素，圆角不会被拆成几段。
const markdownBlocks = ViewPlugin.fromClass(class {
  decorations: DecorationSet

  constructor(view: EditorView) {
    this.decorations = blockDecorations(view)
  }

  update(update: ViewUpdate): void {
    if (update.docChanged || update.viewportChanged || syntaxTree(update.startState) !== syntaxTree(update.state)) {
      this.decorations = blockDecorations(update.view)
    }
  }
}, { decorations: plugin => plugin.decorations })

export const markdownSourceHighlighting: Extension = [
  markdown,
  markdownBlocks,
  syntaxHighlighting(HighlightStyle.define([
    { tag: tags.quote, class: 'px-md-quote' },
    { tag: tags.heading, class: 'px-md-heading' },
    { tag: tags.strong, class: 'px-md-strong' },
    { tag: tags.emphasis, class: 'px-md-emphasis' },
    { tag: listMark, class: 'px-md-list' },
    { tag: tags.link, class: 'px-md-link' },
    { tag: linkSyntax, class: 'px-md-link-syntax' },
    { tag: tags.monospace, class: 'px-md-code' },
    { tag: codeFence, class: 'px-md-code-fence' },
    { tag: codeText, class: 'px-md-code-block' },
    { tag: [tags.processingInstruction, tags.contentSeparator], class: 'px-md-mark' },
  ], { scope: markdown })),
]
