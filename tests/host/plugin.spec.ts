// Host 组装（src/host.ts）的集成测试（testing-plan 第 3 节 tests/host/plugin.spec.ts，审查 F7）：
// 真实的 cordis Context + dsh 存储栈加载 src/index.ts，运行时目录里放一个假的「Electron」，它其实是一段 shell 脚本，
// 用 Node 跑 tests/fixtures/host-companion.mjs。覆盖：草稿写回与卸载顺序、同一 profile 的重复实例（审查 H1、H3）、
// 重启和卸载撞在一起（审查 H2）、同一进程里先卸载再加载（审查 F2 的重试）、小程序上报的语言和界面崩溃（审查 F5、CR-03）。
// 假的可执行文件是 shell 脚本，Windows 上跑不了，这些用例在 Windows 上跳过（Windows 的 CI 仍然跑其余单测和冒烟测试）。

import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { pidAlive } from '../../src/companion/process-utils.ts'
import { failOnProcessProblems } from '../companion/process-traps.ts'
import { cleanupHarnesses, leases, setup, sleep, storedDraft, tempDir, waitFor } from './harness.ts'

failOnProcessProblems()

afterEach(async () => {
  await cleanupHarnesses()
})

describe.skipIf(process.platform === 'win32')('PromptX Host wiring', () => {
  it('starts the companion, saves its draft, and keeps the shutdown flush before closing the draft store', async () => {
    const h = await setup()
    const fiber = h.start()
    await waitFor(async () => (await h.status()).companion.state === 'running', 'running')
    await waitFor(async () => (await h.events()).some(line => line.endsWith(' save ok')), 'draft save')
    expect((await h.status()).instance).toBe('active')
    await fiber.dispose()
    const [pid] = await h.starts()
    expect((await h.events()).some(line => line.endsWith(' flush ok'))).toBe(true)
    expect(await storedDraft(h.home)).toBe('flushed on shutdown')
    expect(pidAlive(pid!)).toBe(false)
    expect(await leases(h.home)).toEqual([])
  })

  it('keeps a duplicate instance away from the companion, the runtime and the active lease (H1, H3)', async () => {
    const h = await setup()
    const first = h.start()
    await waitFor(async () => (await h.status()).companion.state === 'running', 'first running')
    await waitFor(async () => (await leases(h.home)).length === 1, 'lease')
    const second = h.start()
    // 后加载的实例注册的路由覆盖了前一个：下面的请求都发给重复的实例。
    await waitFor(async () => (await h.status()).instance === 'duplicate', 'duplicate')
    for (const [path, action] of [['/api/dsh-promptx/companion', 'restart'], ['/api/dsh-promptx/companion', 'show'], ['/api/dsh-promptx/runtime', 'download'], ['/api/dsh-promptx/runtime', 'delete']] as const) {
      const response = await h.post(path, { action })
      expect(response.status, `${path} ${action}`).toBe(409)
      expect(response.body.error?.code).toBe('promptx/instance/duplicate')
    }
    await sleep(500)
    expect(await h.starts()).toHaveLength(1)
    await second.dispose()
    // 重复的实例卸载时不能删掉正在运行的小程序的租约。
    expect(await leases(h.home)).toHaveLength(1)
    const [pid] = await h.starts()
    expect(pidAlive(pid!)).toBe(true)
    await first.dispose()
    expect(await leases(h.home)).toEqual([])
  })

  it('does not relaunch the companion when a restart races with unloading the plugin (H2)', async () => {
    const h = await setup()
    const fiber = h.start()
    await waitFor(async () => (await h.status()).companion.state === 'running', 'running')
    await waitFor(async () => (await h.events()).some(line => line.endsWith(' save ok')), 'draft save')
    const restarting = h.post('/api/dsh-promptx/companion', { action: 'restart' })
    await fiber.dispose()
    await restarting
    await sleep(1_500)
    const alive = (await h.starts()).filter(pid => pidAlive(pid))
    expect(alive).toEqual([])
  })

  it('takes over in the same process once the previous instance has unloaded (F2 retry)', async () => {
    const h = await setup()
    const first = h.start()
    await waitFor(async () => (await h.status()).companion.state === 'running', 'first running')
    const unloading = first.dispose()
    const second = h.start()
    await unloading
    await waitFor(async () => {
      const status = await h.status()
      return status.instance === 'active' && status.companion.state === 'running'
    }, 'second instance running', 15_000)
    expect(await h.starts()).toHaveLength(2)
    await second.dispose()
  })

  it('names untitled prompts in the language the companion reports (F5)', async () => {
    const h = await setup({ locale: 'en', typed: null, saveText: '#\n##\n' })
    // 库目录不能在 dsh 数据目录里（design-spec 7.4），另建一个临时目录。
    const library = join(await tempDir('promptx-host-library-'), 'library')
    const fiber = h.start({ libraryDir: library })
    await waitFor(async () => (await h.events()).some(line => line.includes(' library ')), 'library save')
    expect((await h.events()).find(line => line.includes(' library '))).toMatch(/library ok "Untitled prompt"$/)
    const files = await readdir(library)
    expect(files).toHaveLength(1)
    expect(await readFile(join(library, files[0]!), 'utf8')).toContain('title: Untitled prompt')
    await fiber.dispose()
  })

  it('shows a renderer crash on the config page while the companion keeps running (CR-03)', async () => {
    const h = await setup({ rendererError: { code: 'promptx/companion/renderer-gone', detail: 'crashed' } })
    const fiber = h.start()
    await waitFor(async () => (await h.status()).companion.error !== undefined, 'renderer error')
    const status = await h.status()
    expect(status.companion.state).toBe('running')
    expect(status.companion.error).toEqual({ code: 'promptx/companion/renderer-gone', detail: 'crashed' })
    await fiber.dispose()
  })
})
