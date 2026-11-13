import { afterEach, describe, expect, it, vi } from 'vitest'
import { EntryEditorManager, type EntryEditorOptions } from '../../../src/app/main/entry-editor.ts'
import { resolveConfig } from '../../../src/app/main/appearance.ts'
import { registerEntryEditorIpc, registerIpcHandlers, UntrustedSenderError } from '../../../src/app/main/ipc.ts'
import { IPC_CHANNELS } from '../../../src/app/main/channels.ts'
import { PromptxError } from '../../../src/shared/errors.ts'
import { RpcError } from '../../../src/shared/rpc.ts'
import type { DraftRecord, EntryMeta, LibraryReadResult, PromptMetadata, SaveResult } from '../../../src/shared/types.ts'
import type { EntryEditorSnapshot } from '../../../src/shared/bridge.ts'
import { BASE_CONFIG, FakePlatform, type FakeWindow } from './fakes.ts'

const managers: EntryEditorManager[] = []
afterEach(() => { for (const manager of managers.splice(0)) manager.dispose() })

function entry(relPath = 'a.md', body = '原文'): LibraryReadResult {
  const meta: EntryMeta = {
    relPath, folder: relPath.slice(0, Math.max(0, relPath.lastIndexOf('/'))), id: relPath, title: relPath, tags: [], favorite: false,
    updatedAt: 0, createdAt: null, status: 'ok', hasFrontMatter: true,
  }
  return { entry: meta, body, version: { sha256: `sha-${body}`, size: body.length } }
}

function setup(recovery: DraftRecord | null = null) {
  const platform = new FakePlatform()
  platform.ready()
  const parent = platform.createWindow({ width: 680, height: 540, backgroundColor: '#fff' }) as FakeWindow
  const config = resolveConfig(BASE_CONFIG, { languages: ['zh'], dark: false })
  let saved: SaveResult | null = null
  let failLoad = false
  let folders = ['写作', '代码']
  const requests: { method: string; params: unknown }[] = []
  let read = (relPath: string) => Promise.resolve(entry(relPath))
  let persist = (_input: unknown) => Promise.resolve({ updatedAt: 'now' })
  let save = (input: { text: string; metadata?: Partial<PromptMetadata> }) => Promise.resolve(saved ?? {
    kind: 'saved' as const, created: false, entry: { ...entry().entry, ...input.metadata },
    binding: {
      libraryDir: config.libraryDir, relPath: 'a.md', id: 'a.md', title: input.metadata?.title ?? 'a.md',
      sha256: `sha-${input.text}`, size: input.text.length, savedBody: input.text,
    },
  })
  const request = (async (method: string, params: Record<string, unknown>) => {
    requests.push({ method, params })
    if (method === 'entryDraft.load') {
      if (failLoad) throw new PromptxError('promptx/draft/unreadable')
      return { record: recovery }
    }
    if (method === 'entryDraft.save') return persist(params)
    if (method === 'library.folders') return { folders }
    if (method === 'library.read') return read(params.relPath as string)
    if (method === 'library.save') return save(params as { text: string })
    throw new Error('unexpected method')
  }) as EntryEditorOptions['request']
  const changed = vi.fn()
  let autoPrepare = true
  let finalText: string | null = null
  const createWindow = platform.createWindow.bind(platform)
  platform.createWindow = (options) => {
    const window = createWindow(options) as FakeWindow
    if (options.page === 'entry-editor') window.onSend = (event, payload) => {
      if (event !== 'entryEditor.state' || !autoPrepare) return
      const snapshot = payload as EntryEditorSnapshot
      if (snapshot.freezeId === null) return
      const text = finalText ?? snapshot.text
      finalText = null
      manager.prepared(snapshot.freezeId, snapshot.generation, text, { anchor: text.length, head: text.length }, snapshot.metadata)
    }
    return window
  }
  const manager = new EntryEditorManager({
    platform, parent, request, config: () => config, changed, logger: { info() {}, warn() {}, error() {} },
  })
  managers.push(manager)
  return {
    manager, platform, parent, config, requests, changed,
    child: () => platform.windows[1] as FakeWindow,
    setResult(value: SaveResult) { saved = value },
    setSave(value: typeof save) { save = value },
    setRead(value: typeof read) { read = value },
    setFolders(value: string[]) { folders = value },
    setPersist(value: typeof persist) { persist = value },
    failRecovery(value: boolean) { failLoad = value },
    prepareAutomatically(value: boolean) { autoPrepare = value },
    prepareWithText(value: string) { finalText = value },
  }
}

describe('独立条目编辑窗口', () => {
  it('只打开子窗，目标由主进程绑定，不读取或改写主草稿', async () => {
    const h = setup()
    expect(await h.manager.open('a.md')).toEqual({ ok: true, value: null })
    expect(h.child().options).toMatchObject({ parent: h.parent, page: 'entry-editor' })
    expect(h.child().visible).toBe(true)
    expect(h.manager.getState()).toMatchObject({ ok: true, value: { text: '原文', binding: { relPath: 'a.md' } } })
    expect(h.requests.map(call => call.method)).toEqual(['entryDraft.load', 'library.read', 'library.folders', 'entryDraft.save'])
    await h.manager.save()
    expect(h.requests.some(call => call.method === 'library.save')).toBe(false)
    h.manager.update('新文', { anchor: 2, head: 2 })
    expect(await h.manager.save()).toEqual({ ok: true, value: null })
    const write = h.requests.find(call => call.method === 'library.save')
    expect(write?.params).toMatchObject({ text: '新文', binding: { relPath: 'a.md', savedBody: '原文' }, mode: 'normal' })
    expect(write?.params).not.toHaveProperty('metadata')
    expect(h.changed).toHaveBeenCalledOnce()
  })

  it('只改文件夹也能移动同一条目，保存成功后更新路径和草稿基线', async () => {
    const h = setup()
    await h.manager.open('写作/a.md')
    const opened = h.manager.getState()
    if (!opened.ok) throw new Error('missing entry')
    const { binding, metadata, folders } = opened.value
    expect(folders).toEqual(['写作', '代码'])
    h.manager.update('原文', { anchor: 0, head: 0 }, { ...metadata, folder: '' })
    await h.manager.flush()
    expect(h.requests.at(-1)?.params).toHaveProperty('entryMetadata.folder', '')
    h.setResult({ kind: 'saved', created: false, entry: entry().entry, binding: { ...binding, relPath: 'a.md' } })
    expect(await h.manager.save()).toEqual({ ok: true, value: null })
    const writes = () => h.requests.filter(call => call.method === 'library.save')
    expect(writes()[0]?.params).toMatchObject({ moveToFolder: '', text: '原文', binding, libraryDir: h.config.libraryDir })
    expect(writes()[0]?.params).not.toHaveProperty('metadata')
    expect(h.manager.getState()).toMatchObject({ ok: true, value: { binding: { relPath: 'a.md', id: binding.id } } })
    expect(h.requests.at(-1)?.params).not.toHaveProperty('entryMetadata')
    await h.manager.save()
    expect(writes()).toHaveLength(1)
  })

  it('目标目录消失时刷新可选目录，并保留选项和未保存正文', async () => {
    const h = setup()
    await h.manager.open('a.md')
    h.manager.update('改动', { anchor: 2, head: 2 }, { title: 'a.md', tags: '', folder: '写作' })
    h.setFolders(['代码'])
    h.setSave(() => Promise.reject(new RpcError(-32000, { code: 'promptx/library/folder-not-found' })))
    expect(await h.manager.save()).toMatchObject({ ok: false, error: { code: 'promptx/library/folder-not-found' } })
    expect(h.manager.getState()).toMatchObject({ ok: true, value: {
      text: '改动', binding: { relPath: 'a.md' }, folders: ['代码'], metadata: { folder: '写作' },
    } })
  })

  it('移动请求超时后原样重发，并在结果回来后保留后来输入的内容', async () => {
    const h = setup()
    await h.manager.open('a.md')
    const opened = h.manager.getState()
    if (!opened.ok) throw new Error('missing entry')
    const { binding, metadata } = opened.value
    h.manager.update('原文', { anchor: 0, head: 0 }, { ...metadata, folder: '写作' })
    h.setSave(() => Promise.reject(new RpcError(-32000, { code: 'promptx/channel/timeout' })))
    expect(await h.manager.save()).toMatchObject({ ok: false, error: { code: 'promptx/channel/timeout' } })
    h.manager.update('改动', { anchor: 2, head: 2 }, { ...metadata, folder: '代码' })
    h.setSave(() => Promise.resolve({ kind: 'saved', created: false, entry: entry('写作/a.md').entry, binding: { ...binding, relPath: '写作/a.md' } }))
    expect(await h.manager.save()).toEqual({ ok: true, value: null })
    const writes = h.requests.filter(call => call.method === 'library.save')
    expect(writes).toHaveLength(2)
    expect(writes[1]?.params).toEqual(writes[0]?.params)
    expect(h.manager.getState()).toMatchObject({ ok: true, value: {
      text: '改动', binding: { relPath: '写作/a.md', savedBody: '原文' }, metadata: { folder: '代码' },
    } })
    expect(h.requests.at(-1)?.params).toHaveProperty('entryMetadata.folder', '代码')
  })

  it('只改标题或标签也保存，对每次写入只传改动的字段', async () => {
    const h = setup()
    const read = entry()
    read.entry.tags = ['Code Review']
    h.setRead(() => Promise.resolve(read))
    await h.manager.open('a.md')
    expect(h.manager.getState()).toMatchObject({ ok: true, value: { metadata: { title: 'a.md', tags: 'Code Review' } } })
    h.setResult({ kind: 'saved', created: false, entry: { ...read.entry, title: '评审' }, binding: {
      libraryDir: h.config.libraryDir, relPath: 'a.md', id: 'a.md', title: '评审', sha256: 'saved', size: 2, savedBody: '原文',
    } })
    h.manager.update('原文', { anchor: 0, head: 0 }, { title: '评审', tags: 'Code Review' })
    expect(await h.manager.save()).toEqual({ ok: true, value: null })
    expect(h.requests.find(call => call.method === 'library.save')?.params).toMatchObject({ metadata: { title: '评审' } })
    expect(h.requests.find(call => call.method === 'library.save')?.params).not.toHaveProperty('metadata.tags')
    expect(h.requests.at(-1)?.params).not.toHaveProperty('entryMetadata')
    h.setResult({ kind: 'saved', created: false, entry: { ...read.entry, title: '评审', tags: ['Code Review', '风格检查'] }, binding: {
      libraryDir: h.config.libraryDir, relPath: 'a.md', id: 'a.md', title: '评审', sha256: 'tags-saved', size: 2, savedBody: '原文',
    } })
    h.manager.update('原文', { anchor: 0, head: 0 }, { title: '评审', tags: 'Code Review, 风格检查' })
    expect(await h.manager.save()).toEqual({ ok: true, value: null })
    const write = h.requests.filter(call => call.method === 'library.save').at(-1)
    expect(write?.params).toMatchObject({ metadata: { tags: ['Code Review', '风格检查'] } })
    expect(write?.params).not.toHaveProperty('metadata.title')
    h.manager.update('原文', { anchor: 0, head: 0 }, { title: '库中已有标题', tags: 'Code Review, 风格检查' })
    h.setSave(() => Promise.reject(new PromptxError('promptx/library/duplicate-title')))
    expect(await h.manager.save()).toMatchObject({ ok: false, error: { code: 'promptx/library/duplicate-title' } })
    await h.manager.flush()
    expect(h.requests.at(-1)?.params).toHaveProperty('entryMetadata.title', '库中已有标题')
  })

  it('正文保存后同步旧文件的新推导标题，避免将旧标题误当成未保存的修改', async () => {
    const h = setup()
    await h.manager.open('a.md')
    h.setResult({ kind: 'saved', created: false, entry: { ...entry().entry, title: '新标题' }, binding: {
      libraryDir: h.config.libraryDir, relPath: 'a.md', id: 'a.md', title: '新标题', sha256: 'saved', size: 4, savedBody: '新标题\n',
    } })
    h.manager.update('新标题\n', { anchor: 4, head: 4 })
    await h.manager.save()
    expect(h.manager.getState()).toMatchObject({ ok: true, value: { metadata: { title: '新标题' } } })
    expect(h.requests.at(-1)?.params).not.toHaveProperty('entryMetadata')
    await h.manager.save()
    expect(h.requests.filter(call => call.method === 'library.save')).toHaveLength(1)
  })

  it('恢复只有元数据修改的草稿，关闭取消后仍保留输入', async () => {
    const record: DraftRecord = {
      version: 1, text: '原文', selection: null, updatedAt: 'now',
      binding: { libraryDir: BASE_CONFIG.libraryDir, relPath: 'a.md', id: 'a.md', title: '原名', sha256: 'old', size: 2, savedBody: '原文' },
      entryMetadata: { title: '未保存标题', tags: 'Code Review,', savedTags: ['旧标签'] },
    }
    const h = setup(record)
    await h.manager.initialize()
    h.manager.show()
    expect(h.manager.getState()).toMatchObject({ ok: true, value: { recovered: true, metadata: record.entryMetadata } })
    await h.manager.close()
    expect(h.child().visible).toBe(true)
    expect(h.manager.getState()).toMatchObject({ ok: true, value: { metadata: record.entryMetadata } })
    h.platform.messageBoxAnswers.push(1)
    await h.manager.close()
    expect(h.child().visible).toBe(false)
    expect(h.requests.at(-1)?.params).not.toHaveProperty('entryMetadata')
  })

  it('同一条目重复打开只聚焦，不替换未保存内容；其他条目切换可以取消', async () => {
    const h = setup()
    await h.manager.open('a.md')
    h.manager.update('未保存', { anchor: 3, head: 3 })
    await h.manager.open('a.md')
    expect(h.platform.windows).toHaveLength(2)
    await h.manager.open('b.md')
    expect(h.manager.getState()).toMatchObject({ ok: true, value: { text: '未保存', binding: { relPath: 'a.md' } } })
    expect(h.requests.filter(call => call.method === 'library.read')).toHaveLength(1)
  })

  it('关闭默认取消，明确放弃后只关闭子窗并保留磁盘原文', async () => {
    const h = setup()
    await h.manager.open('a.md')
    h.manager.update('未保存', { anchor: 3, head: 3 })
    await h.manager.close()
    expect(h.child().visible).toBe(true)
    h.platform.messageBoxAnswers.push(1)
    await h.manager.close()
    expect(h.child().visible).toBe(false)
    expect(h.requests.some(call => call.method === 'library.save')).toBe(false)
    expect(h.requests.at(-1)).toMatchObject({ method: 'entryDraft.save', params: { text: '原文' } })
  })

  it('关闭选择保存时更新条目，保存失败保留子窗和内容', async () => {
    const h = setup()
    await h.manager.open('a.md')
    h.manager.update('新文', { anchor: 2, head: 2 })
    h.setSave(() => Promise.reject(new PromptxError('promptx/library/write-failed')))
    h.platform.messageBoxAnswers.push(2)
    await h.manager.close()
    expect(h.child().visible).toBe(true)
    expect(h.manager.getState()).toMatchObject({ ok: true, value: { text: '新文', error: { code: 'promptx/library/write-failed' } } })
  })

  it('保存期间继续输入不被保存结果替换；连点只发送一个库写入', async () => {
    const h = setup()
    await h.manager.open('a.md')
    let finish!: (result: SaveResult) => void
    h.setSave(() => new Promise((resolve) => { finish = resolve }))
    h.manager.update('提交', { anchor: 2, head: 2 })
    const first = h.manager.save()
    expect(h.manager.save()).toBe(first)
    h.manager.update('提交之后继续', { anchor: 6, head: 6 })
    finish({ kind: 'saved', created: false, entry: entry().entry, binding: {
      libraryDir: h.config.libraryDir, relPath: 'a.md', id: 'a.md', title: 'a.md', sha256: 'saved', size: 2, savedBody: '提交',
    } })
    await first
    expect(h.manager.getState()).toMatchObject({ ok: true, value: { text: '提交之后继续', binding: { savedBody: '提交' } } })
    expect(h.requests.filter(call => call.method === 'library.save')).toHaveLength(1)
  })

  it('外部版本冲突保留编辑，重新载入明确确认后冻结旧文档再载入磁盘版本', async () => {
    const h = setup()
    await h.manager.open('a.md')
    h.manager.update('未保存', { anchor: 3, head: 3 })
    h.setResult({ kind: 'conflict', conflict: 'modified' })
    expect((await h.manager.save()).ok).toBe(false)
    expect(h.manager.getState()).toMatchObject({ ok: true, value: { text: '未保存', conflict: 'modified' } })
    await h.manager.reload()
    expect(h.requests.filter(call => call.method === 'library.read')).toHaveLength(1)
    let finish: ((read: LibraryReadResult) => void) | undefined
    h.setRead(() => new Promise((resolve) => { finish = resolve }))
    h.platform.messageBoxAnswers.push(1)
    const reload = h.manager.reload()
    for (let turn = 0; turn < 32 && finish === undefined; turn++) await Promise.resolve()
    if (finish === undefined) throw new Error('reload did not start')
    h.manager.update('新输入', { anchor: 3, head: 3 })
    expect(h.manager.getState()).toMatchObject({ ok: true, value: { text: '未保存' } })
    finish(entry('a.md', '外部内容'))
    await reload
    expect(h.manager.getState()).toMatchObject({ ok: true, value: { text: '外部内容', freezeId: null } })
  })

  it('没有front matter时确认后才补写，取消不写第二次', async () => {
    const h = setup()
    await h.manager.open('a.md')
    h.setResult({ kind: 'conflict', conflict: 'noFrontMatter' })
    h.manager.update('正文', { anchor: 2, head: 2 })
    await h.manager.save()
    expect(h.requests.filter(call => call.method === 'library.save')).toHaveLength(1)
    h.platform.messageBoxAnswers.push(1)
    await h.manager.save()
    expect(h.requests.filter(call => call.method === 'library.save').at(-1)?.params).toMatchObject({ mode: 'addFrontMatter' })
  })

  it('换库后拒绝保存旧条目，仍能保留其恢复草稿', async () => {
    const h = setup()
    await h.manager.open('a.md')
    h.manager.update('旧库改动', { anchor: 4, head: 4 })
    h.config.libraryDir = '/other/library'
    expect((await h.manager.save()).ok).toBe(false)
    await h.manager.flush()
    expect(h.requests.some(call => call.method === 'library.save')).toBe(false)
    expect(h.requests.at(-1)).toMatchObject({ method: 'entryDraft.save', params: { text: '旧库改动', binding: { libraryDir: BASE_CONFIG.libraryDir } } })
  })

  it('恢复未保存条目，主窗隐藏时子窗也隐藏；崩溃只重新加载自己的窗口', async () => {
    const record: DraftRecord = {
      version: 1, text: '恢复内容', selection: { anchor: 2, head: 2 }, updatedAt: 'now',
      binding: { libraryDir: BASE_CONFIG.libraryDir, relPath: 'a.md', id: 'a.md', title: 'a.md', sha256: 'old', size: 2, savedBody: '原文' },
    }
    const h = setup(record)
    await h.manager.initialize()
    expect(h.child().visible).toBe(false)
    h.manager.show()
    expect(h.manager.getState()).toMatchObject({ ok: true, value: { text: '恢复内容', recovered: true } })
    h.child().rendererGone('crashed')
    expect(h.child().calls).toContain('reload')
    expect(h.parent.calls).not.toContain('reload')
    h.manager.hide()
    expect(h.child().visible).toBe(false)
  })

  it('恢复记录读取失败时不读库、不建可编辑窗口、不覆盖记录；下次可以重试', async () => {
    const h = setup()
    h.failRecovery(true)
    expect((await h.manager.open('a.md')).ok).toBe(false)
    expect(h.platform.windows).toHaveLength(1)
    expect(h.requests.map(call => call.method)).toEqual(['entryDraft.load'])
    h.failRecovery(false)
    expect((await h.manager.open('a.md')).ok).toBe(true)
  })

  it('子窗口不能访问主通用IPC，主窗口不能调用子窗口保存和更新', async () => {
    const h = setup()
    await h.manager.open('a.md')
    registerEntryEditorIpc(h.platform.ipc, sender => h.parent.isSender(sender), () => h.manager)
    // 主通用通道的isTrusted只保留父窗口，子窗不会因拥有entry能力获得draft/prefs权限。
    const call = vi.fn()
    registerIpcHandlers(h.platform.ipc, {
      isTrusted: sender => h.parent.isSender(sender),
      handlers: { call } as unknown as Parameters<typeof registerIpcHandlers>[1]['handlers'],
    })
    await expect(h.platform.ipc.invoke(h.parent.sender, IPC_CHANNELS.entryEditorSave)).rejects.toThrow(UntrustedSenderError)
    await expect(h.platform.ipc.invoke(h.child().sender, IPC_CHANNELS.call, 'draft.save', {})).rejects.toThrow(UntrustedSenderError)
    await expect(h.platform.ipc.invoke(h.child().sender, IPC_CHANNELS.prefsGet)).rejects.toThrow(UntrustedSenderError)
    h.platform.ipc.send(h.parent.sender, IPC_CHANNELS.entryEditorUpdate, '越权', { anchor: 2, head: 2 })
    expect(h.manager.getState()).toMatchObject({ ok: true, value: { text: '原文' } })
    const state = h.manager.getState()
    if (!state.ok) throw new Error('missing state')
    h.platform.ipc.send(h.child().sender, IPC_CHANNELS.entryEditorUpdate, '允许', { anchor: 2, head: 2 }, state.value.generation)
    expect(h.manager.getState()).toMatchObject({ ok: true, value: { text: '允许' } })
    expect(call).not.toHaveBeenCalled()
  })

  it('切换B恢复记录写入尚未完成时，A的晚到IPC不能修改或操作B', async () => {
    const h = setup()
    await h.manager.open('a.md')
    const old = h.manager.getState()
    if (!old.ok) throw new Error('missing A')
    registerEntryEditorIpc(h.platform.ipc, sender => h.parent.isSender(sender), () => h.manager)
    let finish!: (value: { updatedAt: string }) => void
    h.setPersist(() => new Promise((resolve) => { finish = resolve }))
    const opening = h.manager.open('b.md')
    for (let turn = 0; turn < 12; turn++) await Promise.resolve()
    const current = h.manager.getState()
    if (!current.ok) throw new Error('missing B')
    expect(current.value.binding.relPath).toBe('b.md')
    expect(current.value.generation).not.toBe(old.value.generation)
    h.platform.ipc.send(h.child().sender, IPC_CHANNELS.entryEditorUpdate, 'A的晚到内容', { anchor: 0, head: 0 }, old.value.generation)
    for (const channel of [IPC_CHANNELS.entryEditorSave, IPC_CHANNELS.entryEditorReload, IPC_CHANNELS.entryEditorClose]) {
      await expect(h.platform.ipc.invoke(h.child().sender, channel, old.value.generation)).resolves.toMatchObject({ ok: false })
    }
    for (const generation of [undefined, NaN]) {
      await expect(h.platform.ipc.invoke(h.child().sender, IPC_CHANNELS.entryEditorSave, generation)).resolves.toMatchObject({ ok: false })
    }
    expect(h.manager.getState()).toMatchObject({ ok: true, value: { text: '原文', binding: { relPath: 'b.md' } } })
    expect(h.requests.filter(call => call.method === 'library.read')).toHaveLength(2)
    expect(h.requests.filter(call => call.method === 'library.save')).toHaveLength(0)
    finish({ updatedAt: 'now' })
    await opening
  })

  it('切换前收齐A的最后输入，未确认保存或放弃时不能开始载入B', async () => {
    const h = setup()
    await h.manager.open('a.md')
    h.manager.getState()
    h.prepareWithText('尚未传给主进程的最后输入')
    await h.manager.open('b.md')
    expect(h.platform.messageBoxes).toHaveLength(1)
    expect(h.manager.getState()).toMatchObject({
      ok: true, value: { text: '尚未传给主进程的最后输入', binding: { relPath: 'a.md' }, freezeId: null },
    })
    expect(h.requests.filter(call => call.method === 'library.read')).toHaveLength(1)
    await h.manager.flush()
    expect(h.requests.at(-1)).toMatchObject({ method: 'entryDraft.save', params: { text: '尚未传给主进程的最后输入' } })
  })

  it('屏障超时取消切换并恢复A可编辑，原文字和恢复记录仍在', async () => {
    const h = setup()
    await h.manager.open('a.md')
    h.manager.getState()
    h.manager.update('主进程已知的A输入', { anchor: 0, head: 0 })
    h.prepareAutomatically(false)
    expect(await h.manager.open('b.md')).toMatchObject({ ok: false, error: { code: 'promptx/channel/timeout' } })
    expect(h.manager.getState()).toMatchObject({ ok: true, value: { text: '主进程已知的A输入', freezeId: null } })
    expect(h.requests.filter(call => call.method === 'library.read')).toHaveLength(1)
    h.manager.update('恢复后继续输入', { anchor: 0, head: 0 })
    await h.manager.flush()
    expect(h.requests.at(-1)).toMatchObject({ method: 'entryDraft.save', params: { text: '恢复后继续输入' } })
  })

  it('只有匹配sender、屏障id和代次的prepared能提交最终文本并放行切换', async () => {
    const h = setup()
    await h.manager.open('a.md')
    h.manager.getState()
    h.prepareAutomatically(false)
    registerEntryEditorIpc(h.platform.ipc, sender => h.parent.isSender(sender), () => h.manager)
    const opening = h.manager.open('b.md')
    for (let turn = 0; turn < 12; turn++) await Promise.resolve()
    const state = h.manager.getState()
    if (!state.ok || state.value.freezeId === null) throw new Error('missing freeze barrier')
    const { freezeId, generation } = state.value
    const args = [freezeId, generation, '越权内容', { anchor: 0, head: 0 }]
    h.platform.ipc.send(h.parent.sender, IPC_CHANNELS.entryEditorPrepared, ...args)
    h.platform.ipc.send(h.child().sender, IPC_CHANNELS.entryEditorPrepared, freezeId + 1, generation, '错误id', { anchor: 0, head: 0 })
    h.platform.ipc.send(h.child().sender, IPC_CHANNELS.entryEditorPrepared, freezeId, generation + 1, '错误代次', { anchor: 0, head: 0 })
    expect(h.manager.getState()).toMatchObject({ ok: true, value: { text: '原文', freezeId } })
    expect(h.requests.filter(call => call.method === 'library.read')).toHaveLength(1)
    h.platform.ipc.send(h.child().sender, IPC_CHANNELS.entryEditorPrepared, freezeId, generation, '最后输入', { anchor: 4, head: 4 })
    await opening
    expect(h.manager.getState()).toMatchObject({ ok: true, value: { text: '最后输入', binding: { relPath: 'a.md' }, freezeId: null } })
  })

  it('正常退出收齐最后输入，只写恢复草稿，不弹框或更新库文件', async () => {
    const h = setup()
    await h.manager.open('a.md')
    h.manager.getState()
    h.prepareWithText('退出前最后输入')
    await h.manager.flushForExit()
    expect(h.requests.at(-1)).toMatchObject({ method: 'entryDraft.save', params: { text: '退出前最后输入' } })
    expect(h.requests.some(call => call.method === 'library.save')).toBe(false)
    expect(h.platform.messageBoxes).toHaveLength(0)
  })
})
