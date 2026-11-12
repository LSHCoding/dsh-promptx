import { describe, it, expect } from 'vitest'
import { extractCandidate, locateCandidate, splitReply } from '../../src/shared/candidate.ts'

const lines = (...parts: string[]): string => parts.join('\n')

describe('extractCandidate：基本格式', () => {
  it('三个反引号的 prompt 块', () => {
    expect(extractCandidate(lines('改写如下：', '```prompt', '# 写作助手', '- 用中文回答', '```', '说明一句。'))).toBe('# 写作助手\n- 用中文回答')
  })

  it('四个反引号的 prompt 块', () => {
    expect(extractCandidate(lines('````prompt', '第一行', '第二行', '````'))).toBe('第一行\n第二行')
  })

  it('五个反引号的 prompt 块', () => {
    expect(extractCandidate(lines('`````prompt', '内容', '`````'))).toBe('内容')
  })

  it('结尾的反引号可以比开头多', () => {
    expect(extractCandidate(lines('```prompt', '内容', '`````'))).toBe('内容')
  })

  it('原样保留内容里的缩进、行尾空白和空行', () => {
    const body = '  缩进的行  \n\n\t制表符开头\n'
    expect(extractCandidate(`\`\`\`\`prompt\n${body}\n\`\`\`\``)).toBe(body)
  })

  it('结尾围栏后面带换行也能识别', () => {
    expect(extractCandidate('````prompt\n内容\n````\n')).toBe('内容')
  })

  it('结尾围栏前后可以有空白', () => {
    expect(extractCandidate(lines('````prompt', '内容', '  ````\t'))).toBe('内容')
  })

  it('信息串不区分大小写', () => {
    expect(extractCandidate(lines('```PROMPT', 'a', '```'))).toBe('a')
    expect(extractCandidate(lines('````Prompt', 'b', '````'))).toBe('b')
  })

  it('信息串后面可以有空格和制表符', () => {
    expect(extractCandidate(lines('```prompt   ', 'a', '```'))).toBe('a')
    expect(extractCandidate(lines('````prompt\t ', 'b', '````'))).toBe('b')
  })

  it('开头行前面可以有最多 3 个空格', () => {
    expect(extractCandidate(lines('   ```prompt', 'a', '```'))).toBe('a')
  })

  it('开头行前面有 4 个空格或制表符时不算开头', () => {
    expect(extractCandidate(lines('    ```prompt', 'a', '```'))).toBeNull()
    expect(extractCandidate(lines('\t```prompt', 'a', '```'))).toBeNull()
  })

  it('反引号和 prompt 之间有空格、prompt 后面还有别的字时不算开头', () => {
    expect(extractCandidate(lines('``` prompt', 'a', '```'))).toBeNull()
    expect(extractCandidate(lines('```prompt v2', 'a', '```'))).toBeNull()
    expect(extractCandidate(lines('```prompts', 'a', '```'))).toBeNull()
    expect(extractCandidate(lines('```prompt```', 'a', '```'))).toBeNull()
  })

  it('只认反引号围栏', () => {
    expect(extractCandidate(lines('~~~prompt', 'a', '~~~'))).toBeNull()
  })
})

describe('extractCandidate：换行符', () => {
  it('CRLF 按换行处理，内容里统一成 LF', () => {
    expect(extractCandidate('说明\r\n````prompt\r\n第一行\r\n第二行\r\n````\r\n')).toBe('第一行\n第二行')
  })

  it('单独的 CR 按换行处理', () => {
    expect(extractCandidate('````prompt\r第一行\r第二行\r````')).toBe('第一行\n第二行')
  })

  it('CRLF、CR、LF 混用', () => {
    expect(extractCandidate('````prompt\r\na\rb\nc\r\n````')).toBe('a\nb\nc')
  })

  it('CRLF 回复里带内层代码块', () => {
    const reply = lines('````prompt', '格式：', '```json', '{}', '```', '完成。', '````').replace(/\n/g, '\r\n')
    expect(extractCandidate(reply)).toBe('格式：\n```json\n{}\n```\n完成。')
  })
})

describe('extractCandidate：内层代码块', () => {
  it('四个反引号的外层里有 ```json，内层代码块之后的内容不丢（O-03 验收）', () => {
    const body = lines('# 任务', '按下面格式输出：', '```json', '{"a": 1}', '```', '注意事项：', '- 不要输出解释')
    expect(extractCandidate(lines('改写稿：', '````prompt', body, '````', '以上。'))).toBe(body)
  })

  it('多个带信息串的内层代码块', () => {
    const body = lines('格式：', '```json', '{}', '```', '命令：', '```bash', 'echo hello', '```', '完成。')
    expect(extractCandidate(lines('````prompt', body, '````'))).toBe(body)
  })

  it('比外层短的无信息串内层代码块', () => {
    const body = lines('示例：', '```', 'text', '```', '保留结尾。')
    expect(extractCandidate(lines('````prompt', body, '````'))).toBe(body)
  })

  it('内层代码块的结尾可以比开头长，只要比外层短', () => {
    const body = lines('示例：', '```json', '{}', '````', '保留结尾。')
    expect(extractCandidate(lines('`````prompt', body, '`````'))).toBe(body)
  })

  it('比外层短的 ```prompt 是内层示例，不会把候选截断', () => {
    const body = lines('你是 Prompt 工程师，按下面的格式输出：', '```prompt', '示例', '```', '其余要求不变。')
    expect(extractCandidate(lines('````prompt', body, '````'))).toBe(body)
  })

  it('内层代码块里的围栏行和信息串都是正文', () => {
    const body = lines('```markdown', '````prompt', '```json', '```')
    expect(extractCandidate(lines('`````prompt', body, '`````'))).toBe(body)
  })

  it('内层代码块里出现同样长的 prompt 开头只是正文', () => {
    const body = lines('```text', '````prompt', '```', '后文')
    expect(extractCandidate(lines('````prompt', body, '````'))).toBe(body)
  })

  it('信息串里带反引号的行不是围栏，按正文处理', () => {
    const body = lines('```js `x`', '后文')
    expect(extractCandidate(lines('```prompt', body, '```'))).toBe(body)
  })
})

describe('extractCandidate：判断不出边界时不给候选', () => {
  it('内层带信息串的代码块和外层一样长', () => {
    expect(extractCandidate(lines('```prompt', '# 任务', '```json', '{"a":1}', '```', '注意事项……', '```'))).toBeNull()
  })

  it('内层带信息串的代码块比外层长', () => {
    expect(extractCandidate(lines('```prompt', '正文', '````json', '{}', '````', '结尾', '```'))).toBeNull()
  })

  it('无信息串的内层代码块和外层一样长（第一个围栏既像结尾又像内层开头）', () => {
    expect(extractCandidate(lines('```prompt', '正文', '```', '无语言代码', '```', '注意事项', '```'))).toBeNull()
  })

  it('候选结束后又出现不短于外层的纯反引号行', () => {
    expect(extractCandidate(lines('````prompt', 'A', '````', '示例：', '````', 'example', '````'))).toBeNull()
  })

  it('短的内层代码块没结束就遇到外层长度的围栏', () => {
    expect(extractCandidate(lines('````prompt', '正文', '```json', '{}', '````'))).toBeNull()
    expect(extractCandidate(lines('````prompt', '正文', '```', 'code', '````', '后文', '````'))).toBeNull()
  })

  it('前一个 prompt 块没结束又出现一个同样长的，之后还有外层长度的围栏', () => {
    expect(extractCandidate(lines('```prompt', '正文', '```prompt', '示例', '```', '结尾', '```'))).toBeNull()
  })

  it('重新开始的块更长时，按最早那一块的长度判断后面的围栏', () => {
    expect(extractCandidate(lines('```prompt', 'A', '````prompt', 'B', '````', 'C', '```'))).toBeNull()
  })

  it('内层代码块交叠', () => {
    expect(extractCandidate(lines('```prompt', '正文', '```json', '{}', '```bash', 'run', '```', '结尾', '```'))).toBeNull()
  })

  it('等长内层判不出时，前面另有完整的候选就取前面那个', () => {
    const reply = lines('```prompt', '第一稿', '```', '```prompt', '第二稿', '```json', '{}', '```', '尾部', '```')
    expect(extractCandidate(reply)).toBe('第一稿')
  })

  it('等长内层判不出时，后面另有完整的候选就取后面那个', () => {
    const reply = lines('```prompt', 'A', '```json', '{}', '```', 'B', '```', '```prompt', '最终稿', '```')
    expect(extractCandidate(reply)).toBe('最终稿')
  })

  it('后一块边界有歧义时，取前一个完整的候选', () => {
    const reply = lines('```prompt', '第一稿', '```', '```prompt', '第二稿开头', '```', '无语言代码', '```', '尾部', '```')
    expect(extractCandidate(reply)).toBe('第一稿')
  })
})

describe('extractCandidate：候选之后的内容', () => {
  it('候选之后更短的无信息串代码块不影响候选', () => {
    expect(extractCandidate(lines('````prompt', '完整稿', '````', '补充示例：', '```', 'example', '```'))).toBe('完整稿')
  })

  it('多个候选后面跟着更短的代码块时取最后一个候选', () => {
    const reply = lines('````prompt', '第一稿', '````', '````prompt', '最后稿', '````', '补充示例：', '```', 'example', '```')
    expect(extractCandidate(reply)).toBe('最后稿')
  })

  it('候选之后带信息串的代码块不影响候选', () => {
    expect(extractCandidate(lines('```prompt', '完整稿', '```', '```json', '{}', '```'))).toBe('完整稿')
  })

  it('候选之后的代码块里出现 ```prompt 不算开头', () => {
    const reply = lines('```prompt', '完整稿', '```', '另一个例子：', '````text', '```prompt', '示例', '```', '````')
    expect(extractCandidate(reply)).toBe('完整稿')
  })

  it('普通代码块里的 ```prompt 不算开头', () => {
    expect(extractCandidate(lines('示例：', '````markdown', '```prompt', '示例', '```', '````'))).toBeNull()
  })
})

describe('extractCandidate：没结束的块和多个块', () => {
  it('没有结尾的块不算候选', () => {
    expect(extractCandidate(lines('```prompt', '正文还没写完'))).toBeNull()
    expect(extractCandidate(lines('````prompt', '正文', '```'))).toBeNull()
  })

  it('内层代码块没结束，外层也就没结束', () => {
    expect(extractCandidate(lines('````prompt', '正文', '```json', '{}'))).toBeNull()
    expect(extractCandidate(lines('````prompt', '正文', '```json', '{}', '```', '还没有外层结尾'))).toBeNull()
  })

  it('多个完整的候选取最后一个', () => {
    expect(extractCandidate(lines('```prompt', '第一稿', '```', '再改一版：', '```prompt', '第二稿', '```'))).toBe('第二稿')
  })

  it('最后一个块没结束时取前一个完整的候选', () => {
    const reply = lines('```prompt', '第一稿', '```', '```prompt', '第二稿', '```', '```prompt', '未完成', '```json', '{}', '```')
    expect(extractCandidate(reply)).toBe('第二稿')
  })

  it('前一个 prompt 块忘了结尾，后面完整的那一块就是候选', () => {
    expect(extractCandidate(lines('```prompt', '草稿', '', '```prompt', '完整稿', '```'))).toBe('完整稿')
  })

  it('被更长的 prompt 开头打断后，按新开头的长度判断内层和结尾', () => {
    const body = lines('完整稿', '```', '内层', '```', '后文')
    expect(extractCandidate(lines('```prompt', '草稿', '````prompt', body, '````'))).toBe(body)
  })
})

describe('extractCandidate：没有候选', () => {
  it('没有代码块', () => {
    expect(extractCandidate('这是一段没有代码块的回复。')).toBeNull()
  })

  it('空回复', () => {
    expect(extractCandidate('')).toBeNull()
  })

  it('只有不带 prompt 的代码块', () => {
    expect(extractCandidate(lines('```', '代码', '```'))).toBeNull()
    expect(extractCandidate(lines('```js', 'const a = 1', '```'))).toBeNull()
  })

  it('空的 prompt 块不算候选', () => {
    expect(extractCandidate(lines('```prompt', '```'))).toBeNull()
    expect(extractCandidate(lines('````prompt', '  ', '\t', '````'))).toBeNull()
  })

  it('空的 prompt 块不会盖过前面完整的候选', () => {
    expect(extractCandidate(lines('```prompt', '有效', '```', '```prompt', '', '```'))).toBe('有效')
  })
})

describe('locateCandidate：候选的位置', () => {
  it('给出开头行和结尾围栏行的行号，内容和 extractCandidate 相同', () => {
    const reply = lines('说明一句。', '', '````prompt', '# 标题', '正文', '````', '', '补充。')
    expect(locateCandidate(reply)).toEqual({ text: '# 标题\n正文', start: 2, end: 5 })
    expect(extractCandidate(reply)).toBe('# 标题\n正文')
  })

  it('多个候选时取最后一个完整的', () => {
    expect(locateCandidate(lines('```prompt', '第一版', '```', '```prompt', '第二版', '```'))).toEqual({ text: '第二版', start: 3, end: 5 })
  })

  it('CRLF 按一个换行计行号', () => {
    expect(locateCandidate('说明\r\n```prompt\r\n内容\r\n```')).toEqual({ text: '内容', start: 1, end: 3 })
  })

  it('没有候选时为 null', () => {
    expect(locateCandidate('只有说明')).toBeNull()
    expect(locateCandidate(lines('```prompt', '没写完'))).toBeNull()
  })
})

describe('splitReply：会话栏的说明、改写稿和后文', () => {
  it('完整的候选：说明、正文、后文分开，去掉首尾空行', () => {
    expect(splitReply(lines('', '改写如下：', '', '````prompt', '# 标题', '', '正文', '````', '', '有疑问可以追问。', ''), false)).toEqual({
      before: '改写如下：',
      candidate: '# 标题\n\n正文',
      after: '有疑问可以追问。',
      open: false,
    })
  })

  it('没有候选：整段回复作为说明', () => {
    expect(splitReply(lines('', '这段 Prompt 已经很清楚，不需要改写。', ''), false)).toEqual({
      before: '这段 Prompt 已经很清楚，不需要改写。',
      candidate: null,
      after: '',
      open: false,
    })
  })

  it('还在生成时，没收尾的 prompt 块当作正在写的改写稿', () => {
    expect(splitReply(lines('改写如下：', '````prompt', '# 标题', '正文写到一半'), true)).toEqual({
      before: '改写如下：',
      candidate: '# 标题\n正文写到一半',
      after: '',
      open: true,
    })
  })

  it('生成结束后没收尾的块不算候选，回复原样作为说明', () => {
    const reply = lines('改写如下：', '````prompt', '没写完')
    expect(splitReply(reply, false)).toEqual({ before: reply, candidate: null, after: '', open: false })
  })

  it('还在生成、候选已经收尾时按完整的候选分段', () => {
    expect(splitReply(lines('```prompt', '内容', '```', '后面还在写'), true)).toEqual({
      before: '',
      candidate: '内容',
      after: '后面还在写',
      open: false,
    })
  })

  it('边界有歧义、提取不到候选时，整段作为说明', () => {
    const reply = lines('```prompt', '外层', '```', '内层？', '```')
    expect(extractCandidate(reply)).toBeNull()
    expect(splitReply(reply, false).candidate).toBeNull()
    expect(splitReply(reply, false).before).toBe(reply)
  })
})
