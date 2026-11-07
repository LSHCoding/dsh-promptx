import { describe, expect, it } from 'vitest'
import { boundsForReset, boundsForShow, growToMinimum, minimumSize, resizeWidth, sameRect } from '../../../src/app/main/placement.ts'
import { initialWindowBounds, type Rect } from '../../../src/shared/layout.ts'
import { trapProcessErrors } from './helpers.ts'

trapProcessErrors()

const MAIN: Rect = { x: 0, y: 25, width: 1440, height: 875 }
const EXTERNAL: Rect = { x: 1440, y: 0, width: 1920, height: 1080 }

describe('boundsForShow', () => {
  it('uses the default size centred slightly above the middle of the cursor screen the first time', () => {
    expect(boundsForShow(null, [{ workArea: MAIN }], MAIN)).toEqual({ x: 230, y: 25 + 110, width: 980, height: 600 })
    expect(boundsForShow(null, [{ workArea: MAIN }, { workArea: EXTERNAL }], EXTERNAL)).toEqual(initialWindowBounds(EXTERNAL))
  })

  it('keeps a saved position that is still on a screen', () => {
    const saved = { x: 1600, y: 100, width: 900, height: 500 }
    expect(boundsForShow(saved, [{ workArea: MAIN }, { workArea: EXTERNAL }], MAIN)).toEqual(saved)
  })

  it('moves the window back to the cursor screen when its screen was unplugged (F-02)', () => {
    const saved = { x: 1600, y: 100, width: 900, height: 500 }
    const placed = boundsForShow(saved, [{ workArea: MAIN }], MAIN)
    expect(placed.width).toBe(900)
    expect(placed.height).toBe(500)
    expect(placed.x).toBeGreaterThanOrEqual(MAIN.x)
    expect(placed.x + placed.width).toBeLessThanOrEqual(MAIN.x + MAIN.width)
    expect(placed.y).toBeGreaterThanOrEqual(MAIN.y)
  })

  it('fills a screen that is smaller than the minimum size', () => {
    const tiny = { x: 0, y: 0, width: 480, height: 320 }
    expect(boundsForShow(null, [{ workArea: tiny }], tiny)).toEqual({ x: 0, y: 0, width: 480, height: 320 })
  })
})

describe('boundsForReset', () => {
  it('puts the default size on the primary screen', () => {
    expect(boundsForReset(MAIN)).toEqual(initialWindowBounds(MAIN))
  })
})

describe('minimumSize', () => {
  it('never goes below 520 x 360 on a normal screen', () => {
    expect(minimumSize(0, MAIN)).toEqual({ width: 520, height: 360 })
    expect(minimumSize(300, MAIN)).toEqual({ width: 520, height: 360 })
    expect(minimumSize(Number.NaN, MAIN)).toEqual({ width: 520, height: 360 })
  })

  it('follows the open panes (sum of their minimum widths, COV-13)', () => {
    expect(minimumSize(660, MAIN)).toEqual({ width: 660, height: 360 })
    expect(minimumSize(960.4, MAIN)).toEqual({ width: 960, height: 360 })
  })

  it('is capped to the work area, and lowered on screens smaller than 520 x 360', () => {
    expect(minimumSize(2000, MAIN)).toEqual({ width: 1440, height: 360 })
    expect(minimumSize(0, { x: 0, y: 0, width: 500, height: 300 })).toEqual({ width: 500, height: 300 })
  })
})

describe('growToMinimum', () => {
  it('leaves a window that is large enough untouched', () => {
    const bounds = { x: 100, y: 100, width: 980, height: 600 }
    expect(growToMinimum(bounds, { width: 660, height: 360 }, MAIN)).toEqual(bounds)
  })

  it('widens the window and keeps it inside the work area', () => {
    expect(growToMinimum({ x: 1000, y: 100, width: 600, height: 400 }, { width: 960, height: 360 }, MAIN)).toEqual({
      x: 480,
      y: 100,
      width: 960,
      height: 400,
    })
  })
})

describe('resizeWidth', () => {
  const current = { x: 400, y: 100, width: 700, height: 500 }

  it('keeps the left edge for anchor left (grows to the right)', () => {
    expect(resizeWidth(current, 900, 'left', MAIN, 520)).toEqual({ x: 400, y: 100, width: 900, height: 500 })
  })

  it('keeps the right edge for anchor right (grows to the left)', () => {
    expect(resizeWidth(current, 900, 'right', MAIN, 520)).toEqual({ x: 200, y: 100, width: 900, height: 500 })
  })

  it('pushes the window back into the work area when one side has no room', () => {
    expect(resizeWidth({ ...current, x: 1000 }, 900, 'left', MAIN, 520)).toEqual({ x: 540, y: 100, width: 900, height: 500 })
    expect(resizeWidth({ ...current, x: 50 }, 900, 'right', MAIN, 520)).toEqual({ x: 0, y: 100, width: 900, height: 500 })
  })

  it('clamps the width between the minimum and the work area', () => {
    expect(resizeWidth(current, 100, 'left', MAIN, 660).width).toBe(660)
    expect(resizeWidth(current, 5000, 'left', MAIN, 520)).toEqual({ x: 0, y: 100, width: 1440, height: 500 })
    expect(resizeWidth(current, Number.NaN, 'left', MAIN, 520)).toEqual(current)
  })
})

describe('sameRect', () => {
  it('compares all four numbers', () => {
    expect(sameRect({ x: 1, y: 2, width: 3, height: 4 }, { x: 1, y: 2, width: 3, height: 4 })).toBe(true)
    expect(sameRect({ x: 1, y: 2, width: 3, height: 4 }, { x: 1, y: 2, width: 3, height: 5 })).toBe(false)
  })
})
