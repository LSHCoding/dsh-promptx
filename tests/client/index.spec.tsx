// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apply, inject, type ClientContext } from '../../src/client/index.tsx'
import { en, zh, type PromptxTranslate } from '../../src/client/locale.ts'
import { deferred, installRejectionTraps, jsonResponse, makeStatus, tZh, type Deferred } from './fixtures.ts'

installRejectionTraps()

interface Registration {
  options: Record<string, unknown>
  component: (props: { view: 'summary' | 'page'; t: PromptxTranslate }) => ReactNode
  disposed: boolean
}

/**
 * 模拟 dsh 交给 apply 的 Context：effect 记下清理函数，插件卸载时倒序执行，和 cordis 的 fiber 一样；
 * inject(deps, callback) 像 cordis 一样在依赖的服务可用时运行子插件（服务重新出现时再运行一次），卸载后不再运行。
 */
/** 本测试文件建过的 Context：测试中途失败时由 afterEach 卸载，长轮询循环不会漏到下一个测试里。 */
const liveContexts = new Set<{ unload: () => void }>()

function createFakeContext() {
  const disposers: Array<() => void> = []
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>()
  const registrations: Registration[] = []
  const injections: Array<{ key: string; disposed: boolean }> = []
  const dictionaries: Array<{ ns: string; dicts: unknown; disposed: boolean }> = []
  const subPlugins: Array<{ deps: string[]; callback: () => void }> = []
  const openBundle = vi.fn<(name: string) => void>()
  let navigationAvailable = true
  let unloaded = false
  let active = 'zh-CN'

  const ctx = {
    inject: (deps: string[], callback: () => void) => {
      if (unloaded) throw new Error('inactive context')
      subPlugins.push({ deps, callback })
      if (deps.every(name => name !== 'pluginNavigation' || navigationAvailable)) callback()
    },
    effect: (execute: () => () => unknown, _label?: string) => {
      const dispose = execute()
      let done = false
      const run = (): void => {
        if (done) return
        done = true
        dispose()
      }
      disposers.push(run)
      return run
    },
    on: (name: string, listener: (...args: unknown[]) => void) => {
      const set = listeners.get(name) ?? new Set()
      set.add(listener)
      listeners.set(name, set)
      return () => set.delete(listener)
    },
    get: (name: string) => (name === 'pluginNavigation' && navigationAvailable ? { openBundle, openList: vi.fn() } : undefined),
    locale: {
      register: (ns: string, dicts: unknown) => {
        const record = { ns, dicts, disposed: false }
        dictionaries.push(record)
        return () => {
          record.disposed = true
        }
      },
      getLocale: () => ({ active, locales: [], revision: 0 }),
    },
    slots: {
      inject: (key: string, callback: () => () => void) => {
        const record = { key, disposed: false }
        injections.push(record)
        const dispose = callback()
        return () => {
          record.disposed = true
          dispose()
        }
      },
      register: (options: Record<string, unknown>, component: Registration['component']) => {
        const record: Registration = { options, component, disposed: false }
        registrations.push(record)
        return () => {
          record.disposed = true
        }
      },
    },
  }

  const fake = {
    ctx: ctx as unknown as ClientContext,
    registrations,
    injections,
    dictionaries,
    openBundle,
    listenerCount: (name: string) => listeners.get(name)?.size ?? 0,
    emit: (name: string, ...args: unknown[]) => {
      for (const listener of [...(listeners.get(name) ?? [])]) listener(...args)
    },
    setLocale: (value: string) => {
      active = value
    },
    setNavigationAvailable: (value: boolean) => {
      const appeared = value && !navigationAvailable
      navigationAvailable = value
      if (!appeared || unloaded) return
      for (const plugin of subPlugins) {
        if (plugin.deps.includes('pluginNavigation')) plugin.callback()
      }
    },
    subPluginDeps: () => subPlugins.map(plugin => plugin.deps),
    unload: () => {
      unloaded = true
      subPlugins.length = 0
      liveContexts.delete(fake)
      for (const dispose of disposers.splice(0).reverse()) dispose()
    },
  }
  liveContexts.add(fake)
  return fake
}

interface StatusRequest {
  url: string
  signal: AbortSignal
  reply: Deferred<Response>
}

let statusRequests: StatusRequest[] = []
let posts: Array<{ url: string; body: unknown }> = []
const fetchSpy = vi.fn((input: string, init: RequestInit): Promise<Response> => {
  if (input.startsWith('api/dsh-promptx/status')) {
    const reply = deferred<Response>()
    const signal = init.signal!
    signal.addEventListener('abort', () => {
      reply.reject(new DOMException('The operation was aborted.', 'AbortError'))
    })
    statusRequests.push({ url: input, signal, reply })
    return reply.promise
  }
  expect(typeof init.body).toBe('string')
  posts.push({ url: input, body: JSON.parse(init.body as string) })
  return Promise.resolve(jsonResponse({ ok: true }))
})

beforeEach(() => {
  statusRequests = []
  posts = []
  fetchSpy.mockClear()
  vi.stubGlobal('fetch', fetchSpy)
})

afterEach(() => {
  cleanup()
  for (const fake of [...liveContexts]) fake.unload()
  vi.unstubAllGlobals()
})

async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve()
  })
}

function setVisibility(state: DocumentVisibilityState): () => void {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state })
  return () => {
    Reflect.deleteProperty(document, 'visibilityState')
  }
}

describe('Client 入口', () => {
  it('声明依赖 slots 和 locale', () => {
    expect(inject).toEqual(['slots', 'locale'])
  })

  it('apply 注册文案、在插件页的 keyed slot 上挂配置页（键是 dsh-promptx），并启动长轮询和状态上报', async () => {
    const fake = createFakeContext()
    const restoreVisibility = setVisibility('visible')
    try {
      apply(fake.ctx)
    } finally {
      restoreVisibility()
    }

    expect(fake.dictionaries).toEqual([{ ns: 'promptx', dicts: { zh, en }, disposed: false }])
    expect(fake.injections.map(item => item.key)).toEqual(['plugins.bundle.config'])
    expect(fake.registrations).toHaveLength(1)
    expect(fake.registrations[0]?.options).toEqual({ name: 'plugins.bundle.config', key: 'dsh-promptx', locale: 'promptx' })

    expect(statusRequests).toHaveLength(1)
    const clientId = /clientId=([0-9a-f]{32})$/.exec(statusRequests[0]!.url)?.[1]
    expect(statusRequests[0]?.url).toBe(`api/dsh-promptx/status?clientId=${clientId}`)
    expect(posts).toEqual([{ url: 'api/dsh-promptx/client-state', body: { clientId, locale: 'zh-CN', visible: true } }])

    fake.unload()
  })

  it('配置页组件从长轮询拿状态；summary 视图只给一句概述', async () => {
    const fake = createFakeContext()
    apply(fake.ctx)
    const Entry = fake.registrations[0]!.component
    expect(Entry({ view: 'summary', t: tZh })).toBe(zh.summary)

    render(createElement(Entry, { view: 'page', t: tZh }))
    expect(screen.getByRole('status').textContent).toBe(zh.loading)

    await act(async () => {
      statusRequests[0]!.reply.resolve(jsonResponse(makeStatus({ seq: 3 })))
      await statusRequests[0]!.reply.promise
    })
    await settle()
    expect(screen.getByRole('button', { name: '保存' })).toBeTruthy()
    expect(statusRequests).toHaveLength(2)
    expect(statusRequests[1]?.url).toMatch(/^api\/dsh-promptx\/status\?since=3&clientId=[0-9a-f]{32}$/)

    fake.unload()
  })

  it('配置页的默认指令按当前界面语言取', async () => {
    const fake = createFakeContext()
    fake.setLocale('en-US')
    apply(fake.ctx)
    statusRequests[0]!.reply.resolve(jsonResponse(makeStatus()))
    await settle()
    render(createElement(fake.registrations[0]!.component, { view: 'page', t: tZh }))
    expect(screen.getByLabelText<HTMLTextAreaElement>('优化指令').placeholder).toBe(makeStatus().defaultInstruction.en)
    fake.unload()
  })

  it('收到 60 秒内的「打开配置页」请求时切到插件页，同一个请求只切一次（第一次轮询也算）', async () => {
    const fake = createFakeContext()
    apply(fake.ctx)
    statusRequests[0]!.reply.resolve(jsonResponse(makeStatus({ seq: 5, navigate: { seq: 2, ageMs: 1_500 } })))
    await settle()
    expect(fake.openBundle).toHaveBeenCalledTimes(1)
    expect(fake.openBundle).toHaveBeenCalledWith('dsh-promptx')

    statusRequests[1]!.reply.resolve(jsonResponse(makeStatus({ seq: 6, navigate: { seq: 2, ageMs: 26_500 } })))
    await settle()
    expect(fake.openBundle).toHaveBeenCalledTimes(1)

    statusRequests[2]!.reply.resolve(jsonResponse(makeStatus({ seq: 7, navigate: { seq: 3, ageMs: 70_000 } })))
    await settle()
    expect(fake.openBundle).toHaveBeenCalledTimes(1)
    fake.unload()
  })

  it('新打开的页面第一次轮询时导航服务还没到：服务一出现就切页，不用等下一次轮询；同一个请求只切一次', async () => {
    const fake = createFakeContext()
    fake.setNavigationAvailable(false)
    apply(fake.ctx)
    expect(fake.subPluginDeps()).toEqual([['pluginNavigation']])
    statusRequests[0]!.reply.resolve(jsonResponse(makeStatus({ seq: 1, navigate: { seq: 1, ageMs: 1_500 } })))
    await settle()
    expect(fake.openBundle).not.toHaveBeenCalled()
    expect(statusRequests).toHaveLength(2)

    fake.setNavigationAvailable(true)
    expect(fake.openBundle).toHaveBeenCalledTimes(1)
    expect(fake.openBundle).toHaveBeenCalledWith('dsh-promptx')
    statusRequests[1]!.reply.resolve(jsonResponse(makeStatus({ seq: 2, navigate: { seq: 1, ageMs: 26_500 } })))
    await settle()
    expect(fake.openBundle).toHaveBeenCalledTimes(1)
    fake.unload()
  })

  it('导航服务一直不在：什么也不做，也不出错，轮询照常', async () => {
    const fake = createFakeContext()
    fake.setNavigationAvailable(false)
    apply(fake.ctx)
    statusRequests[0]!.reply.resolve(jsonResponse(makeStatus({ seq: 1, navigate: { seq: 4, ageMs: 0 } })))
    await settle()
    statusRequests[1]!.reply.resolve(jsonResponse(makeStatus({ seq: 2, navigate: { seq: 4, ageMs: 25_000 } })))
    await settle()
    expect(fake.openBundle).not.toHaveBeenCalled()
    expect(statusRequests).toHaveLength(3)
    fake.unload()
  })

  it('界面语言切换、页面可见性变化时上报页面状态', async () => {
    const fake = createFakeContext()
    apply(fake.ctx)
    await settle()
    const clientId = (posts[0]?.body as { clientId: string }).clientId

    fake.setLocale('en')
    fake.emit('locale/change', { active: 'en', locales: [], revision: 1 })
    await settle()
    expect(posts.at(-1)?.body).toEqual({ clientId, locale: 'en', visible: document.visibilityState === 'visible' })

    const restore = setVisibility('hidden')
    try {
      document.dispatchEvent(new Event('visibilitychange'))
      await settle()
    } finally {
      restore()
    }
    expect(posts.at(-1)?.body).toEqual({ clientId, locale: 'en', visible: false })
    expect(posts).toHaveLength(3)
    fake.unload()
  })

  it('插件卸载时全部清理：中止长轮询、撤下配置页和文案、移除监听，之后不再发请求', async () => {
    const fake = createFakeContext()
    apply(fake.ctx)
    await settle()
    expect(fake.listenerCount('locale/change')).toBe(1)

    fake.unload()
    expect(statusRequests[0]?.signal.aborted).toBe(true)
    expect(fake.registrations.every(item => item.disposed)).toBe(true)
    expect(fake.injections.every(item => item.disposed)).toBe(true)
    expect(fake.dictionaries.every(item => item.disposed)).toBe(true)
    expect(fake.listenerCount('locale/change')).toBe(0)

    const before = fetchSpy.mock.calls.length
    fake.emit('locale/change', { active: 'en', locales: [], revision: 2 })
    document.dispatchEvent(new Event('visibilitychange'))
    fake.setNavigationAvailable(false)
    fake.setNavigationAvailable(true)
    await settle()
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(fetchSpy.mock.calls.length).toBe(before)
    expect(statusRequests).toHaveLength(1)
    expect(fake.openBundle).not.toHaveBeenCalled()
  })
})
