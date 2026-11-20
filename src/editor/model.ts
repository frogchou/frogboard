export type Point = { x: number; y: number }
export type Box = Point & { w: number; h: number }
export type Shape = 'rect' | 'ellipse' | 'arrow' | 'pen' | 'text' | 'mosaic' | 'cover'
export type Mark = {
  id: number
  kind: Shape
  a: Point
  b: Point
  color: string
  size: number
  points?: Point[]
  text?: string
}
export type Sheet = { crop: Box | null; marks: Mark[] }
export type Grip = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w'

export const clamp = (n: number, low: number, high: number) => Math.max(low, Math.min(high, n))
export function box(a: Point, b: Point): Box {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) }
}
export function contains(b: Box, p: Point, extra = 0) {
  return p.x >= b.x - extra && p.x <= b.x + b.w + extra && p.y >= b.y - extra && p.y <= b.y + b.h + extra
}
export function within(p: Point, b: Box): Point {
  return { x: clamp(p.x, b.x, b.x + b.w), y: clamp(p.y, b.y, b.y + b.h) }
}
export function shapeEnd(kind: Shape, start: Point, p: Point, bounds: Box, shift: boolean): Point {
  const end = within(p, bounds)
  if (!shift || !['rect', 'ellipse', 'arrow'].includes(kind)) return end
  const dx = end.x - start.x, dy = end.y - start.y
  let ux = dx >= 0 ? 1 : -1, uy = dy >= 0 ? 1 : -1
  let length = Math.max(Math.abs(dx), Math.abs(dy))
  if (kind === 'arrow') {
    const angle = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * Math.PI / 4
    ux = Math.cos(angle); uy = Math.sin(angle)
    if (Math.abs(ux) < 1e-8) ux = 0
    if (Math.abs(uy) < 1e-8) uy = 0
    length = Math.hypot(dx, dy)
  }
  if (ux) length = Math.min(length, ((ux > 0 ? bounds.x + bounds.w : bounds.x) - start.x) / ux)
  if (uy) length = Math.min(length, ((uy > 0 ? bounds.y + bounds.h : bounds.y) - start.y) / uy)
  return { x: start.x + ux * length, y: start.y + uy * length }
}
export function intersect(raw: Box, limits: Box): Box | null {
  const x = Math.max(raw.x, limits.x), y = Math.max(raw.y, limits.y)
  const w = Math.min(raw.x + raw.w, limits.x + limits.w) - x
  const h = Math.min(raw.y + raw.h, limits.y + limits.h) - y
  return w >= 1 && h >= 1 ? { x, y, w, h } : null
}
export function snapCrop(b: Box): Box {
  const x = Math.round(b.x), y = Math.round(b.y)
  return { x, y, w: Math.max(1, Math.round(b.x + b.w) - x), h: Math.max(1, Math.round(b.y + b.h) - y) }
}
export function grips(b: Box): [Grip, Point][] {
  const right = b.x + b.w, bottom = b.y + b.h, mx = b.x + b.w / 2, my = b.y + b.h / 2
  return [['nw', { x: b.x, y: b.y }], ['ne', { x: right, y: b.y }], ['sw', { x: b.x, y: bottom }],
    ['se', { x: right, y: bottom }], ['n', { x: mx, y: b.y }], ['s', { x: mx, y: bottom }],
    ['w', { x: b.x, y: my }], ['e', { x: right, y: my }]]
}
export function resizeCrop(b: Box, grip: Grip, p: Point): Box {
  let left = b.x, top = b.y, right = left + b.w, bottom = top + b.h
  if (grip.includes('w')) left = Math.min(right - 1, p.x)
  if (grip.includes('e')) right = Math.max(left + 1, p.x)
  if (grip.includes('n')) top = Math.min(bottom - 1, p.y)
  if (grip.includes('s')) bottom = Math.max(top + 1, p.y)
  return { x: left, y: top, w: right - left, h: bottom - top }
}
export function moveCrop(b: Box, dx: number, dy: number, limits: Box): Box {
  return { ...b, x: clamp(b.x + dx, limits.x, limits.x + limits.w - b.w),
    y: clamp(b.y + dy, limits.y, limits.y + limits.h - b.h) }
}
export function moveMark(m: Mark, dx: number, dy: number): Mark {
  const shift = (p: Point) => ({ x: p.x + dx, y: p.y + dy })
  return { ...m, a: shift(m.a), b: shift(m.b), points: m.points?.map(shift) }
}
export function lineDistance(p: Point, a: Point, b: Point) {
  const dx = b.x - a.x, dy = b.y - a.y
  const t = dx || dy ? clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy), 0, 1) : 0
  return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy)
}
export function fontFor(m: Mark) {
  return `500 ${m.size}px "Microsoft YaHei UI", "Microsoft YaHei", sans-serif`
}
export function markBounds(m: Mark, ctx: CanvasRenderingContext2D): Box {
  if (m.kind === 'text') {
    ctx.font = fontFor(m)
    const lines = (m.text || '').split('\n')
    return { ...m.a, w: Math.max(1, ...lines.map(s => ctx.measureText(s).width)), h: lines.length * m.size * 1.35 }
  }
  if (m.kind !== 'pen' || !m.points?.length) return box(m.a, m.b)
  let left = m.a.x, top = m.a.y, right = left, bottom = top
  for (const p of m.points) {
    left = Math.min(left, p.x); right = Math.max(right, p.x)
    top = Math.min(top, p.y); bottom = Math.max(bottom, p.y)
  }
  return { x: left, y: top, w: right - left, h: bottom - top }
}
export function hitMark(m: Mark, p: Point, ctx: CanvasRenderingContext2D, tolerance: number) {
  const margin = tolerance + m.size / 2
  if (m.kind === 'arrow') return lineDistance(p, m.a, m.b) <= margin
  if (m.kind === 'pen') {
    const ps = m.points ?? [m.a]
    return ps.some((pt, i) => lineDistance(p, pt, ps[i - 1] ?? pt) <= margin)
  }
  return contains(markBounds(m, ctx), p, tolerance)
}
export function replaceMark(sheet: Sheet, mark: Mark): Sheet {
  return { ...sheet, marks: sheet.marks.map(m => m.id === mark.id ? mark : m) }
}

export function paintMark(ctx: CanvasRenderingContext2D, m: Mark, source: HTMLImageElement, tile: HTMLCanvasElement) {
  ctx.save()
  ctx.strokeStyle = ctx.fillStyle = m.color
  ctx.lineWidth = m.size
  ctx.lineCap = ctx.lineJoin = 'round'
  const b = box(m.a, m.b)
  ctx.beginPath()
  switch (m.kind) {
    case 'rect': ctx.strokeRect(b.x, b.y, b.w, b.h); break
    case 'ellipse':
      ctx.ellipse(b.x + b.w / 2, b.y + b.h / 2, b.w / 2, b.h / 2, 0, 0, 2 * Math.PI)
      ctx.stroke(); break
    case 'arrow': {
      const dx = m.b.x - m.a.x, dy = m.b.y - m.a.y, length = Math.hypot(dx, dy)
      if (!length) break
      const head = Math.min(length * 0.65, m.size * 5)
      const back = { x: m.b.x - head * dx / length, y: m.b.y - head * dy / length }
      ctx.moveTo(m.a.x, m.a.y); ctx.lineTo(back.x, back.y); ctx.stroke()
      ctx.beginPath(); ctx.moveTo(m.b.x, m.b.y)
      ctx.lineTo(back.x - dy / length * head * 0.46, back.y + dx / length * head * 0.46)
      ctx.lineTo(back.x + dy / length * head * 0.46, back.y - dx / length * head * 0.46)
      ctx.closePath(); ctx.fill(); break
    }
    case 'pen': {
      const points = m.points ?? [m.a]
      if (points.length === 1) { ctx.arc(m.a.x, m.a.y, m.size / 2, 0, Math.PI * 2); ctx.fill(); break }
      ctx.moveTo(m.a.x, m.a.y)
      for (const p of points) ctx.lineTo(p.x, p.y)
      ctx.stroke(); break
    }
    case 'text':
      ctx.font = fontFor(m); ctx.textBaseline = 'top'
      ;(m.text ?? '').split('\n').forEach((line, i) => ctx.fillText(line, m.a.x, m.a.y + i * m.size * 1.35))
      break
    case 'cover': ctx.fillRect(b.x, b.y, b.w, b.h); break
    case 'mosaic': {
      const area = intersect(b, { x: 0, y: 0, w: source.naturalWidth, h: source.naturalHeight })
      if (!area) break
      tile.width = Math.max(1, Math.ceil(area.w / (m.size * 4)))
      tile.height = Math.max(1, Math.ceil(area.h / (m.size * 4)))
      const sample = tile.getContext('2d')!
      // Sample the composited picture so a later mosaic preserves earlier opaque covers.
      const t = ctx.getTransform()
      sample.drawImage(ctx.canvas, t.a * area.x + t.e, t.d * area.y + t.f,
        t.a * area.w, t.d * area.h, 0, 0, tile.width, tile.height)
      ctx.imageSmoothingEnabled = false
      ctx.clearRect(area.x, area.y, area.w, area.h)
      ctx.drawImage(tile, area.x, area.y, area.w, area.h)
      break
    }
  }
  ctx.restore()
}

export function paintSheet(ctx: CanvasRenderingContext2D, source: HTMLImageElement, sheet: Sheet, tile: HTMLCanvasElement, hideId?: number) {
  ctx.drawImage(source, 0, 0)
  if (!sheet.crop) return
  const c = sheet.crop
  ctx.save(); ctx.beginPath(); ctx.rect(c.x, c.y, c.w, c.h); ctx.clip()
  for (const mark of sheet.marks) if (mark.id !== hideId) paintMark(ctx, mark, source, tile)
  ctx.restore()
}
export function renderCrop(source: HTMLImageElement, sheet: Sheet, out: HTMLCanvasElement, tile: HTMLCanvasElement, hideId?: number) {
  if (!sheet.crop) throw new Error('请先选择截图区域')
  const c = snapCrop(sheet.crop)
  if (out.width !== c.w || out.height !== c.h) { out.width = c.w; out.height = c.h }
  const ctx = out.getContext('2d')
  if (!ctx) throw new Error('无法创建导出画布')
  ctx.setTransform(1, 0, 0, 1, -c.x, -c.y)
  ctx.clearRect(c.x, c.y, c.w, c.h)
  paintSheet(ctx, source, sheet, tile, hideId)
}
export function flatten(source: HTMLImageElement, sheet: Sheet): string {
  const out = document.createElement('canvas')
  renderCrop(source, sheet, out, document.createElement('canvas'))
  const png = out.toDataURL('image/png')
  if (!png.startsWith('data:image/png')) throw new Error('图片超过画布支持的大小')
  return png
}
