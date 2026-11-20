import { useNotify } from '../feedback/Feedback'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { Icon } from './Icons'
import { box, clamp, contains, flatten, grips, hitMark, intersect, markBounds, moveCrop, moveMark, paintSheet, renderCrop, replaceMark, resizeCrop, shapeEnd, snapCrop, within } from './model'
import type { Box, Grip, Mark, Point, Shape, Sheet } from './model'
import './editor.css'

type ExportKind = 'copy' | 'save' | 'translate' | 'ocr'
export type EditorProps = {
  image: string
  cropFirst: boolean
  quickTranslate?: boolean
  initialCrop?: Box
  windowBounds?: Box[]
  onClose: () => void
  onExport: (kind: ExportKind, png: string) => Promise<void>
}
type Tool = Shape | 'select' | 'crop'
type Stroke = { kind: 'draw'; mark: Mark }
type Motion = { kind: 'crop-new' } | { kind: 'crop-move'; crop: Box } | { kind: 'resize'; crop: Box; grip: Grip } | { kind: 'move'; mark: Mark } | Stroke
type Gesture = { start: Point; sheet: Sheet; pointer: number; motion: Motion }
const blank = (): Sheet => ({ crop: null, marks: [] })
const palette = ['#f14d50', '#ffb32d', '#1db889', '#458df4', '#22282c', '#ffffff']
const toolNames: [Tool, string][] = [['crop', '选区'], ['select', '移动标注'], ['rect', '矩形'], ['ellipse', '椭圆'], ['arrow', '箭头'], ['pen', '画笔'], ['text', '文字'], ['mosaic', '马赛克'], ['cover', '遮盖']]
const guides: Record<Tool, string> = {
  crop: '拖动边框调整选区，拖动内部移动选区', select: '拖动标注可移动，双击文字可编辑',
  rect: '拖动绘制矩形，按住 Shift 绘制正方形', ellipse: '拖动绘制椭圆，按住 Shift 绘制正圆', arrow: '从箭尾拖向箭头，按住 Shift 锁定方向',
  pen: '按住并拖动绘制', text: '点击输入文字，双击已有文字可编辑',
  mosaic: '拖动覆盖需要打码的区域', cover: '拖动绘制实色遮盖',
}

// Remount on a new source so its edits, selection and undo stack are independent.
export default function Editor(props: EditorProps) {
  return <EditorSurface key={props.image} {...props}/>
}
function EditorSurface({ image, cropFirst, quickTranslate, initialCrop, windowBounds, onClose, onExport }: EditorProps) {
  const stage = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const textarea = useRef<HTMLTextAreaElement>(null)
  const controls = useRef<HTMLDivElement>(null)
  const [dock, setDock] = useState({ w: 740, h: 85 })
  const [source, setSource] = useState<HTMLImageElement | null>(null)
  const [view, setView] = useState({ w: 1, h: 1, dpr: 1 })
  const [sheet, setSheet] = useState<Sheet>(blank)
  const current = useRef(sheet), past = useRef<Sheet[]>([]), future = useRef<Sheet[]>([])
  const [preview, setPreview] = useState<Sheet | null>(null)
  const scene = preview ?? sheet
  const [tool, setTool] = useState<Tool>(cropFirst ? 'crop' : 'select')
  const [selected, select] = useState<number | null>(null)
  const [color, setColor] = useState(palette[0])
  const [weight, setWeight] = useState(3)
  const [fontSize, setFontSize] = useState(24)
  const [draft, setDraft] = useState<Mark | null>(null)
  const editingText = !!draft
  const draftRef = useRef<Mark | null>(null)
  const nextId = useRef(0), gesture = useRef<Gesture | null>(null)
  const [dragging, setDragging] = useState(false)
  const scratch = useRef<HTMLCanvasElement | null>(null)
  const mosaicPreview = useRef<{ sheet: Sheet; hideId?: number; canvas: HTMLCanvasElement } | null>(null)
  const notify = useNotify()
  const [loadFailed, setLoadFailed] = useState(false), [busy, setBusy] = useState(false)
  const exporting = useRef(false)
  const [hoverWindow, setHoverWindow] = useState<Box | null>(null)
  const [cursor, setCursor] = useState('')
  const initial = useRef({ initialCrop, cropFirst })
  const imageBox: Box = { x: 0, y: 0, w: source?.naturalWidth ?? 1, h: source?.naturalHeight ?? 1 }
  const padding = cropFirst ? 0 : Math.min(55, view.w * .05, view.h * .12)
  const fit = Math.max(.0001, Math.min((view.w - padding * 2) / imageBox.w, (view.h - padding * 2) / imageBox.h))
  const offset = { x: (view.w - imageBox.w * fit) / 2, y: (view.h - imageBox.h * fit) / 2 }

  useEffect(() => {
    let active = true
    const img = new Image()
    img.onload = () => {
      if (!active) return
      const all = { x: 0, y: 0, w: img.naturalWidth, h: img.naturalHeight }
      const preset = initial.current.initialCrop
      const crop = (preset && intersect(preset, all)) || (initial.current.cropFirst ? null : all)
      current.current = { crop: crop ? snapCrop(crop) : null, marks: [] }
      setSheet(current.current); setSource(img)
    }
    img.onerror = () => { if (active) { setLoadFailed(true); notify('图片加载失败，请关闭后重新打开。') } }
    img.src = image
    return () => { active = false }
  }, [image])
  useLayoutEffect(() => {
    const el = stage.current!
    const measure = () => {
      const r = el.getBoundingClientRect()
      setView({ w: Math.max(1, r.width), h: Math.max(1, r.height), dpr: window.devicePixelRatio || 1 })
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el); window.addEventListener('resize', measure)
    return () => { observer.disconnect(); window.removeEventListener('resize', measure) }
  }, [])
  useLayoutEffect(() => {
    const el = controls.current
    if (!el) return
    const measure = () => {
      const r = el.getBoundingClientRect()
      setDock(old => old.w === r.width && old.h === r.height ? old : { w: r.width, h: r.height })
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [editingText])

  useLayoutEffect(() => {
    const el = canvas.current, ctx = el?.getContext('2d')
    if (!el || !ctx || !source) return
    const width = Math.round(view.w * view.dpr), height = Math.round(view.h * view.dpr)
    if (el.width !== width || el.height !== height) { el.width = width; el.height = height }
    ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0)
    ctx.clearRect(0, 0, view.w, view.h)
    ctx.save(); ctx.translate(offset.x, offset.y); ctx.scale(fit, fit)
    const tile = scratch.current ?? (scratch.current = document.createElement('canvas'))
    if (scene.crop && scene.crop.w >= 1 && scene.crop.h >= 1 && scene.marks.some(m => m.kind === 'mosaic')) {
      // DPI or viewport scaling must never change the mosaic's sampled pixels.
      const previous = mosaicPreview.current
      const native = previous?.canvas ?? document.createElement('canvas')
      if (previous?.sheet !== scene || previous.hideId !== draft?.id) {
        renderCrop(source, scene, native, tile, draft?.id)
        mosaicPreview.current = { sheet: scene, hideId: draft?.id, canvas: native }
      }
      const c = snapCrop(scene.crop)
      ctx.drawImage(source, 0, 0)
      ctx.clearRect(c.x, c.y, c.w, c.h)
      ctx.drawImage(native, c.x, c.y)
    } else paintSheet(ctx, source, scene, tile, draft?.id)
    const sel = scene.marks.find(m => m.id === selected)
    if (sel && !draft && !dragging && scene.crop && tool !== 'crop') {
      const b = markBounds(sel, ctx), gap = 4 / fit
      ctx.save(); ctx.beginPath()
      ctx.rect(scene.crop.x, scene.crop.y, scene.crop.w, scene.crop.h); ctx.clip()
      ctx.lineWidth = 1 / fit; ctx.strokeStyle = '#057f68'; ctx.setLineDash([4 / fit, 3 / fit])
      ctx.strokeRect(b.x - gap, b.y - gap, b.w + gap * 2, b.h + gap * 2); ctx.restore()
    }
    ctx.restore()
    const c = scene.crop ?? hoverWindow
    if (!c) {
      ctx.fillStyle = 'rgba(8,18,21,.32)'; ctx.fillRect(0, 0, view.w, view.h)
      return
    }
    const screen = { x: offset.x + fit * c.x, y: offset.y + fit * c.y, w: c.w * fit, h: c.h * fit }
    ctx.fillStyle = 'rgba(7,16,19,.58)'
    ctx.beginPath(); ctx.rect(0, 0, view.w, view.h); ctx.rect(screen.x, screen.y, screen.w, screen.h); ctx.fill('evenodd')
    ctx.lineWidth = 1.5; ctx.strokeStyle = '#41ddad'; ctx.strokeRect(screen.x, screen.y, screen.w, screen.h)
    if (tool === 'crop' && scene.crop) {
      for (const [, gp] of grips(screen)) {
        ctx.fillStyle = '#f4fffa'; ctx.fillRect(gp.x - 3, gp.y - 3, 6, 6); ctx.strokeRect(gp.x - 3, gp.y - 3, 6, 6)
      }
    }
  }, [source, scene, view, fit, offset.x, offset.y, selected, draft, tool, hoverWindow, dragging])

  function showSheet(value: Sheet) {
    current.current = value; setSheet(value); setPreview(null)
  }
  function commit(value: Sheet) {
    past.current = [...past.current.slice(-79), current.current]
    future.current = []; showSheet(value)
  }
  function history(back: boolean) {
    const from = back ? past.current : future.current, to = back ? future.current : past.current
    const item = from.pop()
    if (item) { to.push(current.current); showSheet(item); select(null); setHoverWindow(null) }
  }
  function updateDraft(mark: Mark | null) { draftRef.current = mark; setDraft(mark) }
  function finishText(cancel = false) {
    const m = draftRef.current
    if (!m) return
    updateDraft(null)
    if (cancel) return
    const doc = current.current, existing = doc.marks.find(v => v.id === m.id)
    if (m.text?.trim()) {
      if (existing?.text !== m.text || existing.size !== m.size || existing.color !== m.color)
        commit(existing ? replaceMark(doc, m) : { ...doc, marks: [...doc.marks, m] })
      select(m.id)
    } else if (existing) {
      commit({ ...doc, marks: doc.marks.filter(v => v.id !== m.id) }); select(null)
    }
  }
  function editText(m: Mark) {
    updateDraft({ ...m }); select(m.id)
    requestAnimationFrame(() => {
      textarea.current?.focus()
      const el = textarea.current
      if (el) el.setSelectionRange(el.value.length, el.value.length)
    })
  }
  async function send(kind: ExportKind) {
    if (exporting.current || !source) return
    finishText()
    const doc = current.current
    if (!doc.crop) return
    exporting.current = true; setBusy(true)
    try { await onExport(kind, flatten(source, doc)) }
    catch (err) { notify(err instanceof Error ? err.message : String(err)) }
    finally { exporting.current = false; setBusy(false) }
  }
  function cancelDrag() {
    gesture.current = null; setDragging(false); setPreview(null); setCursor('')
  }
  function removeSelected() {
    if (selected === null || !current.current.marks.some(m => m.id === selected)) return
    commit({ ...current.current, marks: current.current.marks.filter(m => m.id !== selected) }); select(null)
  }
  useEffect(() => {
    function key(e: KeyboardEvent) {
      if (e.isComposing || e.keyCode === 229) return
      const mod = e.ctrlKey || e.metaKey
      if (draftRef.current) {
        if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); finishText(true) }
        else if (mod && e.key === 'Enter') { e.preventDefault(); e.stopImmediatePropagation(); finishText() }
        else if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); e.stopImmediatePropagation(); void send('save') }
        return
      }
      if (busy) return
      let op: (() => void) | undefined
      if (e.key === 'Escape') op = gesture.current ? cancelDrag : onClose
      else if (gesture.current) return
      else if (mod && e.key.toLowerCase() === 'z') op = () => history(!e.shiftKey)
      else if (mod && e.key.toLowerCase() === 'y') op = () => history(false)
      else if (mod && e.key.toLowerCase() === 's') op = () => { void send('save') }
      else if (e.key === 'Delete' || e.key === 'Backspace') op = removeSelected
      else if (e.key === 'Enter' && !(e.target instanceof HTMLButtonElement)) op = () => { void send(quickTranslate ? 'translate' : 'copy') }
      if (op) { e.preventDefault(); e.stopImmediatePropagation(); op() }
    }
    window.addEventListener('keydown', key, true)
    return () => window.removeEventListener('keydown', key, true)
  })

  function point(e: {clientX: number; clientY: number}) {
    const r = canvas.current!.getBoundingClientRect()
    return { x: (e.clientX - r.left - offset.x) / fit, y: (e.clientY - r.top - offset.y) / fit }
  }
  function topMark(p: Point, doc: Sheet) {
    const ctx = canvas.current!.getContext('2d')!
    return [...doc.marks].reverse().find(m => hitMark(m, p, ctx, 4 / fit))
  }
  function gripAt(c: Box, p: Point) {
    return grips(c).find(([,v]) => Math.abs(v.x - p.x) <= 7 / fit && Math.abs(v.y - p.y) <= 7 / fit)?.[0]
  }
  function windowAt(p: Point) {
    const found = windowBounds?.find(b => contains(b, p))
    return found ? intersect(found, imageBox) : null
  }
  function down(e: ReactPointerEvent<HTMLCanvasElement>) {
    if (!source || busy || e.button !== 0 || gesture.current) return
    finishText(); canvas.current?.focus({ preventScroll: true })
    const doc = current.current, p = point(e), c = doc.crop
    if (!contains(imageBox, p, 7 / fit)) return
    const start = within(p, imageBox)
    let motion: Motion
    if (!c || tool === 'crop') {
      const grip = c && gripAt(c, p)
      if (c && grip) motion = { kind: 'resize', grip, crop: c }
      else if (c && contains(c, p)) motion = { kind: 'crop-move', crop: c }
      else motion = { kind: 'crop-new' }
      select(null)
    } else {
      if (!contains(c, p)) return
      const existing = (tool === 'select' || tool === 'text') ? topMark(p, doc) : null
      if (tool === 'select') {
        select(existing?.id ?? null)
        if (!existing) return
        motion = { kind: 'move', mark: existing }
      } else {
        const kind = tool
        const mark: Mark = { id: ++nextId.current, a: start, b: start, kind,
          size: (kind === 'text' ? fontSize : weight) / fit, color }
        if (kind === 'text') { editText(existing?.kind === 'text' ? existing : { ...mark, text: '' }); return }
        if (kind === 'pen') mark.points = [start]
        motion = { kind: 'draw', mark }; select(null)
      }
    }
    gesture.current = { start, sheet: doc, pointer: e.pointerId, motion }
    setDragging(true)
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  function drag(g: Gesture, p: Point, shift: boolean): Sheet {
    const m = g.motion, start = g.start, doc = g.sheet
    if (m.kind === 'crop-new') return { ...doc, crop: box(start, within(p, imageBox)) }
    if (m.kind === 'resize') return { ...doc, crop: resizeCrop(m.crop, m.grip, within(p, imageBox)) }
    if (m.kind === 'crop-move') return { ...doc, crop: moveCrop(m.crop, p.x - start.x, p.y - start.y, imageBox) }
    if (m.kind === 'move') {
      const end = within(p, doc.crop!)
      return replaceMark(doc, moveMark(m.mark, end.x - start.x, end.y - start.y))
    }
    const mark = m.mark
    const end = shapeEnd(mark.kind, start, p, doc.crop!, shift)
    if (mark.kind === 'pen' && (mark.b.x !== end.x || mark.b.y !== end.y)) mark.points!.push(end)
    mark.b = end
    return { ...doc, marks: [...doc.marks, mark] }
  }
  function move(e: ReactPointerEvent<HTMLCanvasElement>) {
    const p = point(e), g = gesture.current
    if (g) { if (g.pointer === e.pointerId) setPreview(drag(g, p, e.shiftKey)); return }
    if (!source) return
    const c = current.current.crop
    if (!c) { setHoverWindow(windowAt(p)); setCursor('crosshair'); return }
    if (tool === 'crop') {
      const grip = gripAt(c, p); setCursor(grip ? grip + '-resize' : contains(c,p) ? 'move' : 'crosshair')
    } else if (tool === 'select') setCursor(contains(c,p) && topMark(p, current.current) ? 'move' : 'default')
    else setCursor(tool === 'text' ? 'text' : 'crosshair')
  }
  function up(e: ReactPointerEvent<HTMLCanvasElement>) {
    const g = gesture.current
    if (!g || g.pointer !== e.pointerId) return
    const p = point(e), dist = Math.hypot(p.x - g.start.x, p.y - g.start.y) * fit
    let value = drag(g, p, e.shiftKey)
    cancelDrag(); setHoverWindow(null)
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
    const type = g.motion.kind
    if (type === 'crop-new') {
      if (dist < 4) { const b = windowAt(p); if (!b) return; value = { ...value, crop: b } }
      if (!value.crop || value.crop.w < 1 || value.crop.h < 1) return
    } else if (dist < 1 && (type !== 'draw' || g.motion.mark.kind !== 'pen')) return
    if (type === 'draw') select(g.motion.mark.id)
    if (value.crop) value = { ...value, crop: snapCrop(value.crop) }
    commit(value)
    if (quickTranslate && type === 'crop-new') void send('translate')
  }
  function wholeImage() {
    if (!source) return
    commit({ ...current.current, crop: imageBox }); setHoverWindow(null)
    if (quickTranslate) void send('translate')
  }
  function chooseTool(t: Tool) {
    finishText(); setTool(t); select(null); setCursor('')
    if (t === 'cover') setColor(palette[4])
  }
  function changeColor(chosen: string) {
    setColor(chosen)
    const m = current.current.marks.find(v => v.id === selected)
    if (m && m.kind !== 'mosaic' && m.color !== chosen) commit(replaceMark(current.current, { ...m, color: chosen }))
  }
  function changeSize(n: number, text: boolean) {
    if (text) setFontSize(n); else setWeight(n)
    const m = current.current.marks.find(v => v.id === selected)
    if (m && m.kind !== 'cover' && (m.kind === 'text') === text) commit(replaceMark(current.current, { ...m, size: n / fit }))
  }
  const activeMark = scene.marks.find(m => m.id === selected)
  const styled = activeMark?.kind ?? tool
  const showStyles = !!scene.crop && styled !== 'crop' && styled !== 'select'
  const accent = activeMark?.color ?? color
  const sizeBox = scene.crop && snapCrop(scene.crop)
  const title = quickTranslate ? '截图翻译' : cropFirst ? '截图标注' : '图片标注'
  const draftX = draft ? offset.x + draft.a.x * fit : 0
  const draftY = draft ? offset.y + draft.a.y * fit : 0
  const positionDraft = { left: clamp(draftX, 2, Math.max(2, view.w - 110)), top: clamp(draftY, 2, Math.max(2, view.h - 64)) }
  // Anchor to the committed selection. Reserve space for the style row so changing
  // tools or drawing another object never flips the toolbar to the opposite side.
  const anchor = cropFirst ? sheet.crop : null
  let dockPosition: { left: number; top: number } | undefined
  if (anchor) {
    const top = offset.y + anchor.y * fit, bottom = top + anchor.h * fit
    const roomBelow = view.h - bottom - 10, roomAbove = top - 10
    const reserve = Math.max(dock.h, view.w < 560 ? 156 : 117)
    const below = roomBelow >= reserve || (roomAbove < reserve && roomBelow >= roomAbove)
    dockPosition = {
      left: clamp(offset.x + (anchor.x + anchor.w / 2) * fit, dock.w / 2 + 6, view.w - dock.w / 2 - 6),
      top: clamp(below ? bottom + 8 : top - dock.h - 8, 6, view.h - dock.h - 6),
    }
  }
  return <div className="fb-editor" ref={stage} role="dialog" aria-modal="true" aria-label={title}>
    <canvas ref={canvas} aria-label="截图选区与标注画布" tabIndex={-1} style={{cursor: cursor || (tool === 'select' ? 'default' : 'crosshair')}}
      onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={cancelDrag} onLostPointerCapture={cancelDrag}
      onPointerLeave={() => { if (!gesture.current) setHoverWindow(null) }}
      onDoubleClick={e => {
        if (tool !== 'select' || !scene.crop || busy) return
        const p = point(e), m = contains(scene.crop, p) && topMark(p, current.current)
        if (m && m.kind === 'text') editText(m)
      }}/>
    <div className="fbe-header"><div className="fbe-identity"><span className="fbe-logo"><Icon name="capture"/></span><b>{title}</b>
      {sizeBox && <span className="fbe-dim">{sizeBox.w} × {sizeBox.h}</span>}</div>
      <button type="button" title="退出（Esc）" aria-label="退出编辑" className="fbe-exit" onClick={onClose} disabled={busy}><Icon name="close"/></button></div>
    {!draft && <div ref={controls} className={'fbe-controls' + (anchor ? ' fbe-floating' : '')} style={{ ...dockPosition, visibility: dragging ? 'hidden' : 'visible' }}>
      {source && <div className="fbe-hint">{busy ? '正在导出…' : !scene.crop ? (windowBounds?.length ? '点击窗口，或拖动选择区域' : '按住并拖动，选择截图区域') : guides[tool]}
        {!sheet.crop && !preview && <button type="button" onClick={wholeImage} disabled={busy}>选择全图</button>}</div>}
      {scene.crop && <div className="fbe-toolbox">
        {showStyles && <div className="fbe-styles">
          {styled !== 'mosaic' && <div className="fbe-palette" role="group" aria-label="标注颜色">
            {palette.map((c,i) => <button type="button" key={c} aria-label={['红色','黄色','绿色','蓝色','墨色','白色'][i]} title={['红色','黄色','绿色','蓝色','墨色','白色'][i]} aria-pressed={c === accent} style={{backgroundColor:c}} onClick={() => changeColor(c)}/>)}
          </div>}
          {styled !== 'cover' && <label className="fbe-size">{styled === 'text' ? '字号' : styled === 'mosaic' ? '颗粒' : '线宽'}
            <select aria-label={styled === 'text' ? '字号' : styled === 'mosaic' ? '颗粒' : '线宽'} value={activeMark ? Math.round(activeMark.size * fit) : styled === 'text' ? fontSize : weight} onChange={e => changeSize(Number(e.target.value), styled === 'text')}>
              {Array.from(new Set([...(styled === 'text' ? [14,18,24,32,48,64] : [2,3,5,8,12]), ...(activeMark ? [Math.round(activeMark.size * fit)] : [])])).sort((a,b)=>a-b).map(s => <option key={s} value={s}>{s}</option>)}
            </select></label>}
        </div>}
        <div className="fbe-bar" role="toolbar" aria-label="标注工具">
          <div className="fbe-group">{toolNames.map(([t,n]) => <button type="button" key={t} className="fbe-icon" title={n} aria-label={n} aria-pressed={tool === t} disabled={busy} onClick={() => chooseTool(t)}><Icon name={t}/></button>)}</div>
          <div className="fbe-group"><button type="button" className="fbe-icon" title="撤销（Ctrl+Z）" aria-label="撤销" disabled={busy || !past.current.length} onClick={() => history(true)}><Icon name="undo"/></button>
            <button type="button" className="fbe-icon" title="重做（Ctrl+Shift+Z）" aria-label="重做" disabled={busy || !future.current.length} onClick={() => history(false)}><Icon name="redo"/></button>
            <button type="button" className="fbe-icon" title="删除选中标注（Delete）" aria-label="删除标注" disabled={busy || !activeMark} onClick={removeSelected}><Icon name="trash"/></button></div>
          <div className="fbe-group"><button type="button" className="fbe-action" title="保存 PNG（Ctrl+S）" disabled={busy} onClick={() => void send('save')}><Icon name="save"/><span>保存</span></button>
            <button type="button" className="fbe-action" disabled={busy} onClick={() => void send('translate')}><Icon name="translate"/><span>翻译</span></button>
            <button type="button" className="fbe-action" title="提取选区中的文字" disabled={busy} onClick={() => void send('ocr')}><Icon name="ocr"/><span>提取文字</span></button>
            <button type="button" className="fbe-copy fbe-action" title="复制到剪贴板（Enter）" disabled={busy} onClick={() => void send('copy')}><Icon name="copy"/>复制</button></div>
        </div>
      </div>}
    </div>}
    {draft && <div className="fbe-textedit" style={positionDraft}>
      <textarea aria-label="标注文字" ref={textarea} spellCheck={false} placeholder="输入文字…" value={draft.text ?? ''}
        style={{fontSize: draft.size * fit, color:draft.color, width:Math.max(100,Math.min(430,view.w-positionDraft.left-10)), maxHeight: Math.max(42, view.h-positionDraft.top-35)}}
        rows={Math.min(10, Math.max(2, (draft.text ?? '').split('\n').length + 1))}
        onChange={e => updateDraft({...draft,text:e.target.value})} onBlur={() => finishText()}/>
      <small>Enter 换行 · Ctrl+Enter 完成</small>
    </div>}
    {!source && !loadFailed && <div className="fbe-loading">正在打开图片…</div>}
  </div>
}
