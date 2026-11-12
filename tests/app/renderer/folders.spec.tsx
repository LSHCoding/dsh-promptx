// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { DialogHost } from '../../../src/app/renderer/components/Dialog.tsx'
import { ControllerContext } from '../../../src/app/renderer/components/hooks.ts'
import { LibraryPane } from '../../../src/app/renderer/components/LibraryPane.tsx'
import type { AppController } from '../../../src/app/renderer/controller/app.ts'
import type { TrashEntry } from '../../../src/shared/types.ts'
import { FakeBridge, listResult, ok, settle, startController } from './helpers.ts'

let controller: AppController | undefined

afterEach(() => {
  cleanup()
  controller?.dispose()
})

describe('文件夹栏', () => {
  it('新建、确认删除和恢复文件夹，回收站不读取文件夹正文', async () => {
    const bridge = new FakeBridge()
    const trashedFolder: TrashEntry = {
      file: '.promptx-folder-Ua89Kr', kind: 'folder', title: '写作', originalPath: '写作', deletedAt: null,
    }
    let folders: string[] = []
    let trash: TrashEntry[] = []
    bridge.handle('library.list', () => ok(listResult([], { folders })))
    bridge.handle('library.createFolder', ({ name }) => {
      folders = [name]
      return ok({ folder: name })
    })
    bridge.handle('library.deleteFolder', () => {
      folders = []
      trash = [trashedFolder]
      return ok({ trashFile: trashedFolder.file })
    })
    bridge.handle('trash.list', () => ok({ recordState: 'ok', entries: trash }))
    bridge.handle('trash.restore', () => {
      folders = ['写作']
      trash = []
      return ok({ kind: 'restored', relPath: '写作' })
    })
    const app = await startController(bridge)
    controller = app
    await app.library.open()
    render(<ControllerContext.Provider value={app}><LibraryPane /><DialogHost /></ControllerContext.Provider>)
    // 「全部」「未分类」和回收站没有删除按钮；栏头只有「新建文件夹」（V0.1.5）。
    expect(screen.queryAllByRole('button', { name: /^删除文件夹/ })).toEqual([])
    fireEvent.click(screen.getByRole('button', { name: '新建文件夹' }))
    const createDialog = within(screen.getByRole('dialog'))
    fireEvent.change(createDialog.getByRole('textbox', { name: '文件夹名称' }), { target: { value: '写作' } })
    await act(async () => {
      fireEvent.click(createDialog.getByRole('button', { name: '新建文件夹' }))
      await settle()
    })
    expect(screen.getByRole('button', { name: '写作' }).getAttribute('aria-current')).toBe('true')
    // 删除按钮在文件夹行上，名称带着文件夹，提示只写动作。
    const deleteFolder = screen.getByRole('button', { name: '删除文件夹「写作」' })
    expect(deleteFolder.getAttribute('data-tip')).toBe('删除文件夹')
    fireEvent.click(deleteFolder)
    expect(bridge.callsTo('library.deleteFolder')).toHaveLength(0)
    await act(async () => {
      fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '删除' }))
      await settle()
    })
    expect(screen.queryByRole('button', { name: '写作' })).toBeNull()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '回收站' }))
      await settle()
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('option', { name: /写作/ }))
      await settle()
    })
    expect(bridge.callsTo('trash.read')).toEqual([])
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '恢复' }))
      await settle()
    })
    expect(bridge.callsTo('trash.restore')).toMatchObject([{ file: trashedFolder.file, target: 'original' }])
    expect(screen.getByRole('button', { name: '写作' })).toBeDefined()
  })

  it('右键文件夹弹出菜单，从菜单删除同样先确认；「全部」「未分类」没有菜单', async () => {
    const bridge = new FakeBridge()
    bridge.handle('library.list', () => ok(listResult([], { folders: ['写作'] })))
    bridge.handle('library.deleteFolder', () => ok({ trashFile: '.promptx-folder-1' }))
    const app = await startController(bridge)
    controller = app
    await app.library.open()
    render(<ControllerContext.Provider value={app}><LibraryPane /><DialogHost /></ControllerContext.Provider>)
    fireEvent.contextMenu(screen.getByRole('button', { name: '全部' }), { clientX: 20, clientY: 60 })
    expect(screen.queryByRole('menu')).toBeNull()

    expect(fireEvent.contextMenu(screen.getByRole('button', { name: '写作' }), { clientX: 40, clientY: 120 })).toBe(false)
    const menu = screen.getByRole('menu')
    // 文件夹栏贴着窗口左边，菜单从指针处向右展开。
    expect(menu.style.left).toBe('40px')
    await act(async () => {
      fireEvent.click(within(menu).getByRole('menuitem', { name: '删除文件夹' }))
      await settle()
    })
    expect(screen.queryByRole('menu')).toBeNull()
    expect(bridge.callsTo('library.deleteFolder')).toHaveLength(0)
    await act(async () => {
      fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '删除' }))
      await settle()
    })
    expect(bridge.callsTo('library.deleteFolder')).toMatchObject([{ folder: '写作' }])
  })
})
