import assert from 'node:assert/strict'
import test from 'node:test'
import { box, grips, hitMark, intersect, lineDistance, moveCrop, moveMark, resizeCrop, shapeEnd, snapCrop } from './model.ts'

test('reverse drags preserve both physical endpoints after rounding', () => {
  const crop = box({ x: 220.8, y: 78.2 }, { x: 49.9, y: 31.7 })
  assert.deepEqual(snapCrop(crop), { x: 50, y: 32, w: 171, h: 46 })
})
test('native window bounds are clipped at the monitor edge', () => {
  const monitor = { x: 0, y: 0, w: 1920, h: 1080 }
  assert.deepEqual(intersect({ x: -140, y: 300, w: 1000, h: 900 }, monitor), { x: 0, y: 300, w: 860, h: 780 })
  assert.equal(intersect({ x: -500, y: 20, w: 400, h: 400 }, monitor), null)
})
test('moving the selection preserves its size and stays on the monitor', () => {
  const region = { x: 30, y: 50, w: 150, h: 90 }
  assert.deepEqual(moveCrop(region, 600, -120, { x: 0, y: 0, w: 500, h: 300 }), { x: 350, y: 0, w: 150, h: 90 })
  assert.equal(region.x, 30)
})
test('all eight grips preserve the opposite edge and a positive area', () => {
  const crop = { x: 30, y: 40, w: 100, h: 70 }
  for (const [grip, p] of grips(crop)) {
    assert.deepEqual(resizeCrop(crop, grip, p), crop)
    const crossed = resizeCrop(crop, grip, { x: p.x === 30 ? 200 : 0, y: p.y === 40 ? 200 : 0 })
    assert.ok(crossed.w >= 1 && crossed.h >= 1)
  }
  assert.deepEqual(resizeCrop(crop, 'nw', { x: 135, y: 125 }), { x: 129, y: 109, w: 1, h: 1 })
})
test('moving pen objects leaves the undo snapshot intact', () => {
  const mark = { id: 1, kind: 'pen', a: { x: 10, y: 20 }, b: { x: 20, y: 40 }, points: [{ x: 10, y: 20 }, { x: 20, y: 40 }], size: 3, color: '#ff0000' }
  const moved = moveMark(mark, -8, 9)
  assert.deepEqual(moved.points, [{ x: 2, y: 29 }, { x: 12, y: 49 }])
  assert.equal(mark.points[0].x, 10)
  assert.equal(hitMark(mark, { x: 15, y: 30 }, null, 1), true)
  assert.equal(hitMark(mark, { x: 10, y: 40 }, null, 1), false)
  assert.equal(lineDistance({ x: 3, y: 4 }, { x: 0, y: 0 }, { x: 0, y: 0 }), 5)
})
test('Shift creates circles and squares in all directions and clips both sides equally', () => {
  const bounds = { x: 20, y: 20, w: 80, h: 70 }, start = { x: 60, y: 60 }
  assert.deepEqual(shapeEnd('rect', start, { x: 25, y: 68 }, bounds, true), { x: 30, y: 90 })
  assert.deepEqual(shapeEnd('ellipse', start, { x: 80, y: 58 }, bounds, true), { x: 80, y: 40 })
  assert.deepEqual(shapeEnd('ellipse', start, { x: 80, y: 58 }, bounds, false), { x: 80, y: 58 })
})
test('Shift snaps arrows to multiples of 45 degrees without leaving the crop', () => {
  const bounds = { x: 5, y: 10, w: 85, h: 60 }, start = { x: 50, y: 50 }
  const diagonal = shapeEnd('arrow', start, { x: 85, y: 70 }, bounds, true)
  assert.ok(Math.abs(diagonal.x - 70) < 1e-8 && Math.abs(diagonal.y - 70) < 1e-8)
  const horizontal = shapeEnd('arrow', start, { x: 9, y: 45 }, bounds, true)
  assert.equal(horizontal.y, 50); assert.ok(horizontal.x >= bounds.x)
})
