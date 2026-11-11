import { describe, it, expect } from 'vitest'
import {
  DEFAULT_WINDOW,
  ensureVisible,
  initialWindowBounds,
  MIN_WINDOW,
  PANE_LIMITS,
  planPaneClose,
  planPaneOpen,
  type PaneOpenInput,
  type Rect,
} from '../../src/shared/layout.ts'

const LIBRARY = PANE_LIMITS.folder.default + PANE_LIMITS.list.default // 450
const SESSION = PANE_LIMITS.session.default // 420
const EDITOR_MIN = PANE_LIMITS.editor.min // 330

const input = (overrides: Partial<PaneOpenInput> & Pick<PaneOpenInput, 'window' | 'opening'>): PaneOpenInput => ({
  workArea: { x: 0, width: 1920 },
  panes: { library: { open: false, width: LIBRARY }, session: { open: false, width: SESSION } },
  editorMin: EDITOR_MIN,
  ...overrides,
})

describe('常量', () => {
  it('与需求 5.7 一致', () => {
    expect(DEFAULT_WINDOW).toEqual({ width: 980, height: 600 })
    expect(MIN_WINDOW).toEqual({ width: 520, height: 360 })
    expect(PANE_LIMITS).toEqual({
      folder: { min: 130, max: 460, default: 150 },
      list: { min: 200, default: 300 },
      editor: { min: 330 },
      session: { min: 300, max: 560, default: 420 },
      preview: { min: 128, default: 232 },
      listPart: { min: 96 },
    })
  })
})

describe('planPaneOpen：先加宽', () => {
  it('打开库侧栏时向左加宽，编辑区宽度不变', () => {
    const plan = planPaneOpen(input({ window: { x: 500, width: 980 }, opening: 'library' }))
    expect(plan).toEqual({
      window: { x: 50, width: 1430 },
      collapse: null,
      editorWidth: 980,
      restoreWidth: 980,
      restoreX: 500,
      grown: { left: 450, right: 0 },
    })
  })

  it('打开会话栏时向右加宽', () => {
    const plan = planPaneOpen(input({ window: { x: 100, width: 980 }, opening: 'session' }))
    expect(plan.window).toEqual({ x: 100, width: 1400 })
    expect(plan.grown).toEqual({ left: 0, right: 420 })
    expect(plan.editorWidth).toBe(980)
    expect(plan.collapse).toBeNull()
  })

  it('偏好的一侧没有空余时向另一侧加宽', () => {
    const library = planPaneOpen(input({ window: { x: 0, width: 980 }, opening: 'library' }))
    expect(library.window).toEqual({ x: 0, width: 1430 })
    expect(library.grown).toEqual({ left: 0, right: 450 })
    const session = planPaneOpen(input({ window: { x: 940, width: 980 }, opening: 'session' }))
    expect(session.window).toEqual({ x: 520, width: 1400 })
    expect(session.grown).toEqual({ left: 420, right: 0 })
  })

  it('偏好的一侧空余不够时，剩下的从另一侧补', () => {
    const plan = planPaneOpen(input({ window: { x: 200, width: 980 }, opening: 'library' }))
    expect(plan.window).toEqual({ x: 0, width: 1430 })
    expect(plan.grown).toEqual({ left: 200, right: 250 })
    expect(plan.editorWidth).toBe(980)
  })

  it('按所在屏幕的可用区域计算（副屏的坐标不从 0 开始）', () => {
    const plan = planPaneOpen(input({ window: { x: 2000, width: 980 }, workArea: { x: 1920, width: 1440 }, opening: 'library' }))
    expect(plan.window).toEqual({ x: 1920, width: 1430 })
    expect(plan.grown).toEqual({ left: 80, right: 370 })
  })

  it('另一侧的栏已经打开时，编辑区仍保持原宽度', () => {
    const plan = planPaneOpen(input({
      window: { x: 600, width: 1400 },
      panes: { library: { open: false, width: LIBRARY }, session: { open: true, width: SESSION } },
      opening: 'library',
    }))
    expect(plan.window).toEqual({ x: 150, width: 1850 })
    expect(plan.editorWidth).toBe(980)
    expect(plan.collapse).toBeNull()
  })
})

describe('planPaneOpen：再压编辑区', () => {
  it('加宽到可用区域为止，不够的部分从编辑区扣', () => {
    // 屏幕 1280，小窗 980 居中：两侧各 150，只能加宽 300，编辑区 980 → 830
    const plan = planPaneOpen(input({ window: { x: 150, width: 980 }, workArea: { x: 0, width: 1280 }, opening: 'library' }))
    expect(plan.window).toEqual({ x: 0, width: 1280 })
    expect(plan.editorWidth).toBe(830)
    expect(plan.collapse).toBeNull()
  })

  it('编辑区可以正好压到最小宽度', () => {
    // 屏幕 1200 已铺满：会话栏 420 + 库侧栏 450 + 编辑区 330
    const plan = planPaneOpen(input({
      window: { x: 0, width: 1200 },
      workArea: { x: 0, width: 1200 },
      panes: { library: { open: false, width: LIBRARY }, session: { open: true, width: SESSION } },
      opening: 'library',
    }))
    expect(plan.window).toEqual({ x: 0, width: 1200 })
    expect(plan.editorWidth).toBe(EDITOR_MIN)
    expect(plan.collapse).toBeNull()
  })
})

describe('planPaneOpen：最后收起另一侧', () => {
  it('编辑区压到最小宽度还不够时，收起会话栏', () => {
    // 屏幕 1024，小窗 980：只能加宽 44；会话栏 420 打开着，编辑区 560 → 154 < 330
    const plan = planPaneOpen(input({
      window: { x: 22, width: 980 },
      workArea: { x: 0, width: 1024 },
      panes: { library: { open: false, width: LIBRARY }, session: { open: true, width: SESSION } },
      opening: 'library',
    }))
    expect(plan.window).toEqual({ x: 0, width: 1024 })
    expect(plan.collapse).toBe('session')
    expect(plan.editorWidth).toBe(1024 - LIBRARY)
  })

  it('打开会话栏时保留库侧栏', () => {
    const plan = planPaneOpen(input({
      window: { x: 0, width: 1024 },
      workArea: { x: 0, width: 1024 },
      panes: { library: { open: true, width: LIBRARY }, session: { open: false, width: SESSION } },
      opening: 'session',
    }))
    expect(plan.window).toEqual({ x: 0, width: 1024 })
    expect(plan.collapse).toBeNull()
    expect(plan.editorWidth).toBe(1024 - LIBRARY - SESSION)
  })

  it('编辑区本来就比最小宽度窄时，不再压，直接收起另一侧', () => {
    const plan = planPaneOpen(input({
      window: { x: 0, width: 720 },
      workArea: { x: 0, width: 760 },
      panes: { library: { open: false, width: 400 }, session: { open: true, width: 420 } },
      opening: 'library',
    }))
    // 编辑区原来 300 < 330；只能加宽 40，需要 400
    expect(plan.collapse).toBe('session')
    expect(plan.window).toEqual({ x: 0, width: 760 })
    expect(plan.editorWidth).toBe(360)
  })

  it('另一侧没有打开时没法收起，屏幕不够就铺满，编辑区小于最小宽度', () => {
    const plan = planPaneOpen(input({ window: { x: 40, width: 600 }, workArea: { x: 0, width: 700 }, opening: 'library' }))
    expect(plan.window).toEqual({ x: 0, width: 700 })
    expect(plan.collapse).toBeNull()
    expect(plan.editorWidth).toBe(250)
  })

  it('编辑区宽度不会是负数', () => {
    const plan = planPaneOpen(input({ window: { x: 0, width: 400 }, workArea: { x: 0, width: 400 }, opening: 'library' }))
    expect(plan.editorWidth).toBe(0)
  })
})

describe('planPaneOpen：其他情况', () => {
  it('要打开的栏已经打开时什么都不变', () => {
    const plan = planPaneOpen(input({
      window: { x: 100, width: 1400 },
      panes: { library: { open: true, width: LIBRARY }, session: { open: false, width: SESSION } },
      opening: 'library',
    }))
    expect(plan).toEqual({
      window: { x: 100, width: 1400 },
      collapse: null,
      editorWidth: 950,
      restoreWidth: 1400,
      restoreX: 100,
      grown: { left: 0, right: 0 },
    })
  })

  it('窗口有一部分跑到可用区域外时，那一侧不再往外长', () => {
    const plan = planPaneOpen(input({ window: { x: -100, width: 980 }, opening: 'library' }))
    expect(plan.grown).toEqual({ left: 0, right: 450 })
    expect(plan.window).toEqual({ x: -100, width: 1430 })
  })

  it('窗口比可用区域还宽时不加宽', () => {
    const plan = planPaneOpen(input({ window: { x: -10, width: 1000 }, workArea: { x: 0, width: 980 }, opening: 'session' }))
    expect(plan.grown).toEqual({ left: 0, right: 0 })
    expect(plan.window).toEqual({ x: -10, width: 1000 })
    expect(plan.editorWidth).toBe(580)
  })
})

describe('planPaneClose：关闭后恢复宽度', () => {
  const cases: Array<[string, PaneOpenInput]> = [
    ['只向左加宽', input({ window: { x: 500, width: 980 }, opening: 'library' })],
    ['两侧都加宽', input({ window: { x: 200, width: 980 }, opening: 'library' })],
    ['向右加宽', input({ window: { x: 100, width: 980 }, opening: 'session' })],
    ['压了编辑区', input({ window: { x: 150, width: 980 }, workArea: { x: 0, width: 1280 }, opening: 'library' })],
    ['收起了另一侧', input({
      window: { x: 22, width: 980 },
      workArea: { x: 0, width: 1024 },
      panes: { library: { open: false, width: LIBRARY }, session: { open: true, width: SESSION } },
      opening: 'library',
    })],
  ]

  for (const [name, openInput] of cases) {
    it(`窗口没动过时回到打开前的位置和宽度：${name}`, () => {
      const plan = planPaneOpen(openInput)
      expect(planPaneClose({ window: plan.window, grown: plan.grown })).toEqual({ x: plan.restoreX, width: plan.restoreWidth })
    })
  }

  it('栏打开期间拖动过窗口时，宽度复原，位置跟着用户拖到的地方', () => {
    const plan = planPaneOpen(input({ window: { x: 500, width: 980 }, opening: 'library' }))
    const moved = { x: plan.window.x + 300, width: plan.window.width }
    expect(planPaneClose({ window: moved, grown: plan.grown })).toEqual({ x: 800, width: 980 })
  })

  it('两块栏先后打开，先关先打开的那块，只收回它加的宽度', () => {
    const library = planPaneOpen(input({ window: { x: 500, width: 980 }, opening: 'library' }))
    const session = planPaneOpen(input({
      window: library.window,
      panes: { library: { open: true, width: LIBRARY }, session: { open: false, width: SESSION } },
      opening: 'session',
    }))
    expect(session.window).toEqual({ x: 50, width: 1850 })
    const afterLibrary = planPaneClose({ window: session.window, grown: library.grown })
    expect(afterLibrary).toEqual({ x: 500, width: 1400 })
    // 编辑区回到 1400 - 420 = 980
    expect(afterLibrary.width - SESSION).toBe(980)
    expect(planPaneClose({ window: afterLibrary, grown: session.grown })).toEqual({ x: 500, width: 980 })
  })

  it('用户把窗口缩窄后关闭，最多收到最小宽度', () => {
    expect(planPaneClose({ window: { x: 0, width: 700 }, grown: { left: 300, right: 100 } })).toEqual({ x: 180, width: 520 })
    expect(planPaneClose({ window: { x: 0, width: 600 }, grown: { left: 0, right: 450 }, minWidth: 400 })).toEqual({ x: 0, width: 400 })
  })

  it('窗口已经不比最小宽度宽时不收', () => {
    expect(planPaneClose({ window: { x: 10, width: 500 }, grown: { left: 100, right: 100 } })).toEqual({ x: 10, width: 500 })
  })

  it('没有加宽过时不变', () => {
    expect(planPaneClose({ window: { x: 10, width: 1200 }, grown: { left: 0, right: 0 } })).toEqual({ x: 10, width: 1200 })
  })
})

describe('initialWindowBounds', () => {
  it('大屏幕上是 980×600，水平居中，上方留出 40% 的空余', () => {
    expect(initialWindowBounds({ x: 0, y: 25, width: 1920, height: 1055 })).toEqual({ x: 470, y: 25 + 182, width: 980, height: 600 })
  })

  it('屏幕坐标不从 0 开始时按可用区域定位', () => {
    const workArea = { x: -1440, y: 100, width: 1440, height: 900 }
    expect(initialWindowBounds(workArea)).toEqual({ x: -1440 + 230, y: 100 + 120, width: 980, height: 600 })
  })

  it('放不下默认大小时取可用区域减去四周各 24，位置仍按水平居中、上方 40%', () => {
    // 高 620 - 48 = 572，上方留 (620 - 572) × 0.4 ≈ 19
    expect(initialWindowBounds({ x: 0, y: 0, width: 1000, height: 620 })).toEqual({ x: 24, y: 19, width: 952, height: 572 })
  })

  it('默认大小连同边距正好放下时不缩', () => {
    expect(initialWindowBounds({ x: 0, y: 0, width: 1028, height: 648 })).toEqual({ x: 24, y: 19, width: 980, height: 600 })
  })

  it('减去边距后比最小尺寸还小时用最小尺寸', () => {
    expect(initialWindowBounds({ x: 0, y: 0, width: 540, height: 380 })).toEqual({ x: 10, y: 8, width: 520, height: 360 })
  })

  it('屏幕比最小尺寸还小时铺满可用区域', () => {
    expect(initialWindowBounds({ x: 0, y: 30, width: 480, height: 320 })).toEqual({ x: 0, y: 30, width: 480, height: 320 })
  })
})

describe('ensureVisible', () => {
  const primary: Rect = { x: 0, y: 25, width: 1440, height: 875 }
  const external: Rect = { x: 1440, y: 0, width: 1920, height: 1080 }
  const displays = [{ workArea: primary }, { workArea: external }]

  it('在屏幕里时不动', () => {
    const bounds = { x: 100, y: 100, width: 980, height: 600 }
    expect(ensureVisible(bounds, displays, primary)).toEqual(bounds)
  })

  it('只有工具栏露出一部分但仍能拖到时不动', () => {
    const bounds = { x: 1440 - 64, y: 500, width: 980, height: 600 }
    expect(ensureVisible(bounds, [{ workArea: primary }], primary)).toEqual(bounds)
  })

  it('外接显示器拔掉后，移回鼠标所在屏幕，大小放得下就保留', () => {
    const bounds = { x: 1600, y: 200, width: 1000, height: 700 }
    expect(ensureVisible(bounds, [{ workArea: primary }], primary)).toEqual({ x: 220, y: 25 + 70, width: 1000, height: 700 })
  })

  it('移回时原来的大小放不下，用默认大小', () => {
    const bounds = { x: 1600, y: 0, width: 1800, height: 1000 }
    expect(ensureVisible(bounds, [{ workArea: primary }], primary)).toEqual(initialWindowBounds(primary))
  })

  it('工具栏露出的宽度不到 64 时移回', () => {
    const bounds = { x: 1440 - 63, y: 500, width: 980, height: 600 }
    expect(ensureVisible(bounds, [{ workArea: primary }], primary)).toEqual({ x: 230, y: 25 + 110, width: 980, height: 600 })
  })

  it('工具栏跑到可用区域上沿之外（例如菜单栏底下）时移回', () => {
    // 顶部 40 像素里只有 15 像素落在可用区域里
    const bounds = { x: 100, y: 0, width: 980, height: 600 }
    expect(ensureVisible(bounds, [{ workArea: primary }], primary)).toEqual({ x: 230, y: 25 + 110, width: 980, height: 600 })
  })

  it('工具栏正好露出 64×24 时不动', () => {
    const bounds = { x: 1440 - 64, y: 25 + 24 - 40, width: 980, height: 600 }
    expect(ensureVisible(bounds, [{ workArea: primary }], primary)).toEqual(bounds)
  })

  it('窗口比所在屏幕的可用区域还大时缩到可用区域以内', () => {
    const bounds = { x: -50, y: 30, width: 1600, height: 1000 }
    expect(ensureVisible(bounds, [{ workArea: primary }], primary)).toEqual({ x: 0, y: 25, width: 1440, height: 875 })
  })

  it('只有一个方向超出时只调整那个方向', () => {
    const bounds = { x: 100, y: 40, width: 1500, height: 600 }
    expect(ensureVisible(bounds, [{ workArea: primary }], primary)).toEqual({ x: 0, y: 40, width: 1440, height: 600 })
  })

  it('跨两块屏幕时按工具栏露出更多的那块屏幕收紧', () => {
    const bounds = { x: 1000, y: 100, width: 2000, height: 600 }
    // 主屏露出 440，外接屏露出 1560
    expect(ensureVisible(bounds, displays, primary)).toEqual({ x: 1440, y: 100, width: 1920, height: 600 })
  })

  it('记下的尺寸比最小尺寸还小时放大到最小尺寸', () => {
    const bounds = { x: 100, y: 100, width: 300, height: 200 }
    expect(ensureVisible(bounds, [{ workArea: primary }], primary)).toEqual({ x: 100, y: 100, width: 520, height: 360 })
  })

  it('屏幕比最小尺寸还小时铺满可用区域', () => {
    const tiny: Rect = { x: 0, y: 0, width: 480, height: 320 }
    expect(ensureVisible({ x: 0, y: 0, width: 980, height: 600 }, [{ workArea: tiny }], tiny)).toEqual(tiny)
  })

  it('没有任何屏幕信息时移到后备的可用区域', () => {
    const bounds = { x: 100, y: 100, width: 980, height: 600 }
    expect(ensureVisible(bounds, [], primary)).toEqual({ x: 230, y: 25 + 110, width: 980, height: 600 })
  })

  it('记下的数字坏了时用默认位置和大小', () => {
    expect(ensureVisible({ x: Number.NaN, y: 0, width: 980, height: 600 }, displays, primary)).toEqual(initialWindowBounds(primary))
    expect(ensureVisible({ x: 0, y: 30, width: Number.NaN, height: 600 }, displays, primary)).toEqual(initialWindowBounds(primary))
  })
})
