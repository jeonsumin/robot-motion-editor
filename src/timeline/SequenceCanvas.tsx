import { useEffect, useRef, useState } from 'react'
import { trackDrag } from './drag'
import { getEditor, useEditor } from '../store/store'
import { itemLen, sortedItems, pieceName, pieceTag, projectTitle } from '../model/sequence'
import { BLEND_RANGE, HOLD_RANGE, INERTIA_CAP, itemLead, itemTail, previewRange, REST_BLEND, REST_HOLD } from '../model/restPose'
import { SEAM_MAX } from '../model/seam'
import type { Item, Track } from '../model/types'
import { itemSeam, offsetKeyCount } from '../model/itemClip'
import { seqFlash, seqFocus, tv } from './viewState'
import { edgeScroll, followStep, markHover, markUserScroll, resetFollow, wheelFrames } from './follow'
import { sequenceEnd } from '../transport'
import { drawRuler, hitMarker, LABEL_W, RULER_H } from './ruler'
import { dropPlacement, insertLabel, laneDropFrame } from '../model/dropPlacement'
import { COLOR } from '../model/defaults'
import { draggedAsset, draggedClips, dropAsset, dropClips, isAssetDrag } from './assetDrop'
import { mediaUrl, subscribeMedia } from '../media/registry'
import { exportOne } from '../export/exportOne'
import { formatTimecode, frameToX, hoverFrame, hoverScrub, xToFrame, type TimeScale } from './timeScale'
import { usePhysics } from '../physics/physicsStore'
import { runItems, stale } from '../physics/runItem'
import { withDefaults } from '../physics/settings'
import { badge, drawAssist, segmentAt, seqFrameOf, treeSuffix, treeTag, DIM, WARN_RED } from './physGraph'
import { drawScrollbar, pressScrollbar, SB_W, sbGeom } from './vscroll'
import { drawMinimap, MM_H, mmDrag, mmFit, mmGeom, mmHit, type MmHit } from './minimap'

const ROW_H = 28, EDGE = 6, LEN_EDGE = 4 // px: piece trim handle, lead-in / 끝 block edge
const DENY = '이 위치에 놓을 수 없습니다'
const LOCKED = '잠긴 트랙입니다'
// lead-in / 끝 기본자세 blocks in a lane: the outer edge of each one drags its length (user)
type LenKey = 'restHold' | 'restBlend' | 'inertia' | 'tailBlend' | 'tailHold' | 'seam'
const LEN_NAME: Record<LenKey, string> = { restHold: '기본자세', restBlend: '전이', inertia: '관성', tailBlend: '끝 전이', tailHold: '끝 기본자세', seam: '이음' }
const SEAM_WARN = '이음 ⚠: 앞 조각 끝 자세와 차이가 커서 이어지는 동작이 어색할 수 있습니다'
const ICON_HIT = 18 // hit area; icons are drawn 14px: (motion) path, eye, padlock at the label column's right edge
const TRAIL_X = LABEL_W - 56, EYE_X = LABEL_W - 36, LOCK_X = LABEL_W - 16, PLAY_X = EYE_X - 20 // PLAY_X: piece lanes, left of the eye
const TRI_W = 18, NAME_X = 20, CHILD_X = NAME_X + 16 // disclosure triangle hit width; track / child label x

// Eye (slashed when the track is hidden) and padlock (shackle open when unlocked); `on` = accent, off = line.
function drawEye(ctx: CanvasRenderingContext2D, cx: number, cy: number, on: boolean, col: string) {
  ctx.save(); ctx.strokeStyle = ctx.fillStyle = col; ctx.lineWidth = 1.5
  ctx.beginPath(); ctx.ellipse(cx, cy, 7, 4.5, 0, 0, Math.PI * 2); ctx.stroke()
  ctx.beginPath(); ctx.arc(cx, cy, 2, 0, Math.PI * 2); ctx.fill()
  if (on) { ctx.beginPath(); ctx.moveTo(cx - 6, cy + 6); ctx.lineTo(cx + 6, cy - 6); ctx.stroke() }
  ctx.restore()
}
// Piece lane play / pause of the clip preview's loop: a triangle, or two bars while that piece plays
function drawPlay(ctx: CanvasRenderingContext2D, cx: number, cy: number, playing: boolean, col: string) {
  ctx.save(); ctx.fillStyle = col
  if (playing) { ctx.fillRect(cx - 4, cy - 5, 3, 10); ctx.fillRect(cx + 1, cy - 5, 3, 10) }
  else { ctx.beginPath(); ctx.moveTo(cx - 4, cy - 5); ctx.lineTo(cx + 5, cy); ctx.lineTo(cx - 4, cy + 5); ctx.closePath(); ctx.fill() }
  ctx.restore()
}
// 경로 표시: a floor path (S curve) ending in the root dot
function drawTrail(ctx: CanvasRenderingContext2D, cx: number, cy: number, col: string) {
  ctx.save(); ctx.strokeStyle = ctx.fillStyle = col; ctx.lineWidth = 1.5
  ctx.beginPath(); ctx.moveTo(cx - 6, cy + 5); ctx.bezierCurveTo(cx + 6, cy + 5, cx - 6, cy - 4, cx + 4, cy - 4); ctx.stroke()
  ctx.beginPath(); ctx.arc(cx + 5, cy - 4, 2, 0, Math.PI * 2); ctx.fill()
  ctx.restore()
}
function drawLock(ctx: CanvasRenderingContext2D, cx: number, cy: number, on: boolean, col: string) {
  ctx.save(); ctx.strokeStyle = ctx.fillStyle = col; ctx.lineWidth = 1.5
  ctx.fillRect(cx - 5, cy - 1, 10, 7)
  ctx.beginPath(); ctx.moveTo(cx - 3, cy - 1); ctx.lineTo(cx - 3, cy - 4); ctx.arc(cx, cy - 4, 3, Math.PI, 0)
  ctx.lineTo(cx + 3, on ? cy - 1 : cy - 5); ctx.stroke()
  ctx.restore()
}
const isVideo = (t: Track) => t.kind === 'video'
// "<start>–<end> · <clip name>" of a child row (sequence frames); time first since split pieces share a clip name
const restTag = (it: Item) => it.restPose === 'prepend' ? '기본자세 덧붙임' : '기본자세'
const childLabel = (t: Track, it: Item, name: string) => `${pieceTag(t, it).split(' · ')[0]}${pieceTag(t, it) ? ' · ' : ''}${formatTimecode(it.start)}–${formatTimecode(it.start + itemLen(it))} · ${name}${it.restPose ? ` · ${restTag(it)}` : ''}`
// short lane label: "#n · m:ss" of the piece start ("m:ss" alone for a clip's only piece); exact times are in the hover text
const mss = (f: number) => { const t = Math.floor(f / 60); return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}` }
const laneLabel = (t: Track, it: Item) => `${pieceTag(t, it).split(' · ')[0]}${pieceTag(t, it) ? ' · ' : ''}${mss(it.start)}`
// text cut to `w` px with an ellipsis
function fit(ctx: CanvasRenderingContext2D, text: string, w: number) {
  if (ctx.measureText(text).width <= w) return text
  let n = text.length
  while (n > 0 && ctx.measureText(text.slice(0, n) + '…').width > w) n--
  return text.slice(0, n) + '…'
}
// Label column rows: one per track, plus (expanded motion tracks) one child per item in time order, and under a piece with a
// 수정 층 its 수정 row (`edit`); y is canvas px.
interface Row { t: Track; it?: Item; y: number; h: number }
const hasEdit = (it: Item) => offsetKeyCount(it) > 0

// In-progress drag preview; the store is untouched until mouseup.
interface Drag { itemId: string; mode: 'move' | 'in' | 'out'; df: number; swapTo?: string /* lane drag onto another piece's lane: trade places */ }
interface Msg { text: string; left: number; top: number }
interface Ctx { x: number; y: number; actorId: string; trackId: string; itemId: string | null } // itemId null: track label menu
interface Rename { index: number; left: number; value: string }

export default function SequenceCanvas() {
  const cv = useRef<HTMLCanvasElement>(null)
  const [msg, setMsg] = useState<Msg | null>(null)
  const [rename, setRename] = useState<Rename | null>(null)
  const [ctx, setCtx] = useState<Ctx | null>(null)
  const [ph, setPh] = useState<{ x: number; y: number } | null>(null) // 재생헤드 고정 menu (ruler / empty space right-click)
  const menuRef = useRef<HTMLDivElement>(null)
  const cancel = useRef(false)
  const renaming = useRef(false)
  renaming.current = !!rename
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set()) // track ids with their item list open (UI only, not saved)
  const exp = useRef(expanded)
  exp.current = expanded
  const redraw = useRef<() => void>(() => {})
  useEffect(() => redraw.current(), [expanded])
  const toggle = (id: string) => setExpanded(e => { const n = new Set(e); if (!n.delete(id)) n.add(id); return n })
  // a motion track that gains a piece (a cut, a drop) and has several opens its staircase of piece rows
  const tracks = useEditor(s => s.project.sequence.tracks), counts = useRef(new Map<string, number>())
  useEffect(() => {
    const grown = tracks.filter(t => !isVideo(t) && t.items.length >= 2 && t.items.length > (counts.current.get(t.id) ?? 0)).map(t => t.id)
    counts.current = new Map(tracks.map(t => [t.id, t.items.length]))
    if (grown.some(id => !exp.current.has(id))) setExpanded(e => new Set([...e, ...grown]))
  }, [tracks])

  useEffect(() => {
    const canvas = cv.current!, ed = getEditor()
    const css = getComputedStyle(document.documentElement)
    const col = (n: string) => css.getPropertyValue(n).trim()
    const C = { bg: col('--bg'), panel: col('--panel'), line: col('--line'), text: col('--text'), accent: col('--accent'), rest: col('--rest'), piece: col('--piece'), inertia: col('--inertia'), blend: col('--blend') }
    let W = 0, H = 0, raf = 0, drag: Drag | null = null, ghost: { y: number; start: number; len: number; color: string; line?: number /* 레인 사이 삽입선 y */; label?: string /* 끼울 자리 "GO2-1 ↔ GO2-2 사이" */ } | null = null, timer = 0, scrollY = 0, scrollTo = 0 // rows: shown offset, and where the wheel is easing it to
    let sbHover = false, sbDrag = false, mmHover: MmHit | null = null, mmDragging = false

    const scale = (): TimeScale => ({ x0: LABEL_W - tv.scrollF * tv.ppf, pxPerFrame: tv.ppf })
    // V1 (always first) only shows once the project has media
    const tracks = () => { const p = ed.getState().project; return p.sequence.tracks.filter(t => t.kind === 'motion' || (isVideo(t) && p.media.length > 0)) }
    const refLen = (it: Item) => { const p = ed.getState().project, c = p.clips[it.refId]; return c?.hold ? Infinity : c?.length ?? p.media.find(m => m.id === it.refId)?.durationF ?? 0 } // Empty: no end
    const refName = (it: Item) => { const p = ed.getState().project; return p.clips[it.refId]?.name ?? p.media.find(m => m.id === it.refId)?.name ?? '' }
    // items of a track with the drag preview applied
    const shown = (t: Track): Item[] => t.items.map(it => {
      if (!drag || drag.itemId !== it.id) return it
      const clipLen = refLen(it), d = drag.df
      if (drag.mode === 'move') return { ...it, start: Math.max(0, it.start + d) }
      if (drag.mode === 'in') { const k = Math.min(Math.max(d, -it.trimIn), itemLen(it) - 1); return { ...it, start: it.start + k, trimIn: it.trimIn + k } }
      return { ...it, trimOut: it.trimOut + Math.min(Math.max(d, 1 - itemLen(it)), clipLen - it.trimOut) }
    })
    const stairs = (t: Track) => !isVideo(t) && exp.current.has(t.id) // pieces laid out one per lane below the track row
    const layout = (): Row[] => {
      const out: Row[] = []
      let y = RULER_H - scrollY
      for (const t of tracks()) {
        out.push({ t, y, h: ROW_H }); y += ROW_H
        if (stairs(t)) for (const it of sortedItems(t)) { out.push({ t, it, y, h: ROW_H }); y += ROW_H } // one lane per piece, going down
      }
      return out
    }
    // minimap under the lanes (spec: the whole sequence plus half a screen, the visible window boxed), always shown
    const mm = () => mmGeom(LABEL_W, W - SB_W, sequenceEnd(ed.getState().project), tv.scrollF, tv.ppf)
    const hbH = () => MM_H // rows end above it
    const maxScroll = () => Math.max(0, layout().reduce((a, r) => a + r.h, 0) - (H - hbH() - RULER_H)) // 0 when the rows fit
    const sbar = () => sbGeom(RULER_H, H - hbH(), layout().reduce((a, r) => a + r.h, 0), scrollY) // vertical scrollbar, null when the rows fit
    const flash = (text: string, row: number) => {
      const r = layout()[row]
      if (!r) return
      setMsg({ text, left: LABEL_W + 4, top: r.y + r.h + 2 })
      clearTimeout(timer); timer = window.setTimeout(() => setMsg(null), 2000)
    }

    // stored assist result of a motion item, and whether the current project would export a different CSV
    const phys = (t: Track, it: Item) => {
      const s = ed.getState(), st = usePhysics.getState().byItem[it.id]
      return { st, old: !!t.actorId && stale(s.project, s.defs, t.actorId, it.id) }
    }
    const GRAPH = 0.6 // graph fills the bar's bottom 40%
    // lead-in / tail lengths walk the whole clip (foot contact, motion amount): during a slider or gizmo drag the lanes keep the
    // lengths from the drag start and catch up when it ends
    const leads = new Map<string, ReturnType<typeof itemLead>>(), tails = new Map<string, ReturnType<typeof itemTail>>()
    let lenDrag: { itemId: string; key: LenKey; value: number } | null = null // a block edge being dragged: drawn with that length
    const dragged = (it: Item) => lenDrag?.itemId === it.id ? { ...it, [lenDrag.key]: lenDrag.value } : null
    const leadOf = (it: Item) => { const s = ed.getState(), d = dragged(it); if (d) return itemLead(s.project, s.defs, d); if (!s.inGesture || !leads.has(it.id)) leads.set(it.id, itemLead(s.project, s.defs, it)); return leads.get(it.id)! }
    const tailOf = (it: Item) => { const s = ed.getState(), d = dragged(it); if (d) return itemTail(s.project, s.defs, d); if (!s.inGesture || !tails.has(it.id)) tails.set(it.id, itemTail(s.project, s.defs, it)); return tails.get(it.id)! }
    const seams = new Map<string, ReturnType<typeof itemSeam>>() // GO2 이음매 보정 at a piece's start
    const seamOf = (it: Item) => { const s = ed.getState(), d = dragged(it); if (d) return itemSeam(s.project, s.defs, d); if (!s.inGesture || !seams.has(it.id)) seams.set(it.id, itemSeam(s.project, s.defs, it)); return seams.get(it.id)! }
    seqFlash.fn = (text, itemId) => flash(text, layout().findIndex(r => !r.it && r.t.items.some(i => i.id === itemId)))

    const draw = () => {
      raf = 0
      const s = ed.getState(), dpr = window.devicePixelRatio || 1
      if (followStep({ frame: s.frame, playF: s.frame, playing: s.playing, visibleF: (W - LABEL_W) / tv.ppf, contentEnd: sequenceEnd(s.project) })) schedule()
      const sc = scale()
      const ctx = canvas.getContext('2d')!
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.fillStyle = C.bg; ctx.fillRect(0, 0, W, H)
      ctx.font = '11px "IBM Plex Sans KR", sans-serif'; ctx.textBaseline = 'middle'; ctx.textAlign = 'left'
      const hatch = (a: number, b: number, y: number, alpha: number) => {
        ctx.save(); ctx.beginPath(); ctx.rect(a, y + 2, b - a, ROW_H - 5); ctx.clip()
        ctx.strokeStyle = C.text; ctx.globalAlpha = alpha; ctx.lineWidth = 1; ctx.beginPath()
        for (let hx = a - ROW_H; hx < b + ROW_H; hx += 6) {
          ctx.moveTo(hx, y + ROW_H - 3); ctx.lineTo(hx + ROW_H - 5, y + 2)
          ctx.moveTo(hx, y + 2); ctx.lineTo(hx + ROW_H - 5, y + ROW_H - 3)
        }
        ctx.stroke(); ctx.restore()
      }
      // rows: clamp first (rows collapsed or the panel grew), then ease toward the wheel target; laid out only after that, so a frame
      // never shows the rows shifted past the end (that one-frame jump was the flicker)
      const maxY = maxScroll()
      scrollTo = Math.min(Math.max(scrollTo, 0), maxY)
      if (scrollY > maxY) scrollY = maxY
      if (scrollY !== scrollTo) { scrollY = Math.abs(scrollTo - scrollY) < 0.5 ? scrollTo : scrollY + (scrollTo - scrollY) * 0.35; schedule() }
      const rows = layout()
      // Bars of `items` in one row at y: fill, 기본자세 section, outline, assist graph, crossfade hatch over `xfade`, labels.
      const bars = (t: Track, items: Item[], y: number, color: string, lane: boolean, xfade: [number, number][]) => {
        const video = isVideo(t), actor = s.project.actors.find(a => a.id === t.actorId)
        ctx.save(); ctx.beginPath(); ctx.rect(LABEL_W, y, W - LABEL_W, ROW_H); ctx.clip()
        const ga = (t.locked ? 0.5 : 1) * (lane && items[0]?.hidden ? 0.4 : 1) // locked: half transparent, no hatch; hidden: faded
        ctx.globalAlpha = ga
        for (const it of items) {
          const x = frameToX(sc, it.start), w = itemLen(it) * tv.ppf, by = y + 2, bh = ROW_H - 5
          if (video) { ctx.fillStyle = C.panel; ctx.fillRect(x, by, w, bh) }
          else { ctx.fillStyle = color; ctx.globalAlpha = 0.18 * ga; ctx.fillRect(x, by, w, bh); ctx.globalAlpha = ga }
          const ld = it.restPose ? leadOf(it) : null
          if (ld) { // 기본자세 덧붙이기: the lead-in played before the piece
            ctx.fillStyle = C.rest; ctx.globalAlpha = 0.55 * ga
            { // 기본자세 (정지) · 전이 · 관성 (original frames), each in its own colour; one row: a strip, so the piece before stays visible
              let xs = x - ld.lead * tv.ppf
              for (const [n, c] of [[ld.hold, C.rest], [ld.blend, C.blend], [ld.inertia, C.inertia]] as const) {
                ctx.fillStyle = c; ctx.fillRect(xs, by, n * tv.ppf, lane ? bh : 4); xs += n * tv.ppf
              }
            }
            ctx.globalAlpha = ga
          }
          const sm = video ? null : seamOf(it)
          if (sm) { // 이음매 보정: the first frames of the piece, eased from the piece before
            ctx.globalAlpha = 0.45 * ga; ctx.fillStyle = sm.warn ? WARN_RED : C.blend; ctx.fillRect(x, by, sm.n * tv.ppf, lane ? bh : 4); ctx.globalAlpha = ga
          }
          const tl = tailOf(it)
          if (tl) { // 끝 기본자세 after the piece's end: 전이 then 기본자세 (정지); one row: a strip, so the next piece stays visible
            ctx.globalAlpha = 0.55 * ga
            let xs = x + w
            for (const [n, c] of [[tl.blend, C.blend], [tl.hold, C.rest]] as const) { ctx.fillStyle = c; ctx.fillRect(xs, by, n * tv.ppf, lane ? bh : 4); xs += n * tv.ppf }
            ctx.globalAlpha = ga
          }
          if (hasEdit(it)) { // 수정됨: the span of its 수정 keys tinted (lane), the keys as ticks along the bar's bottom edge (clip frames inside the trim)
            const fs = [...new Set(Object.values(it.offset!).flatMap(c => c.keys.map(k => k.f)))].filter(f => f >= it.trimIn && f < it.trimOut)
            ctx.fillStyle = C.piece
            if (lane && fs.length) { const a = Math.min(...fs), b = Math.max(...fs) + 1; ctx.globalAlpha = 0.3 * ga; ctx.fillRect(frameToX(sc, it.start + a - it.trimIn), by, (b - a) * tv.ppf, bh) }
            ctx.globalAlpha = ga
            for (const f of fs) ctx.fillRect(Math.round(frameToX(sc, it.start + f - it.trimIn)) - 1, by + bh - 4, 2, 4)
          }
          if (video && !mediaUrl(it.refId)) hatch(x, x + w, y, 0.25) // offline
          ctx.strokeStyle = it.id === s.selItem ? C.accent : video ? C.line : color; ctx.lineWidth = 1
          ctx.strokeRect(x + 0.5, by + 0.5, w - 1, bh - 1)
          if (it.id === s.itemPreview) { // the piece open in the clip preview: a light dashed frame inside the bar
            ctx.save(); ctx.strokeStyle = C.text; ctx.lineWidth = 1.5; ctx.setLineDash([4, 3])
            ctx.strokeRect(x + 2.5, by + 2.5, w - 5, bh - 5); ctx.restore()
          }
          const { st, old } = video ? { st: undefined, old: false } : phys(t, it)
          if (st?.metrics && actor) drawAssist(ctx, st.metrics.pct, st.metrics.segments, seqFrameOf(s.project, s.defs, it, 0), sc, Math.max(x, LABEL_W), x + w,
            by + bh * GRAPH, bh * (1 - GRAPH), color, withDefaults(s.project.physics)[actor.robot].warnPct, old)
        }
        for (const [a, b] of xfade) hatch(frameToX(sc, a), frameToX(sc, b), y, 0.5) // crossfade, hatched both ways
        ctx.fillStyle = C.text
        for (const it of items) {
          // 기본자세 section label: only where the whole word fits inside the coloured block (덧붙이기 only in a lane)
          const ld = it.restPose === 'prepend' ? leadOf(it) : null
          const rb = ld && lane ? [frameToX(sc, it.start) - ld.lead * tv.ppf, ld.hold * tv.ppf] : null
          const tag = (text: string, x0: number, x1: number) => { // a section label, only where the whole word fits inside its block
            const a = Math.max(x0, LABEL_W)
            if (x1 - a >= ctx.measureText(text).width + 8) ctx.fillText(text, a + 4, y + ROW_H / 2)
          }
          if (rb) tag('기본자세', rb[0], rb[0] + rb[1])
          if (rb && ld) {
            const b0 = rb[0] + rb[1], b1 = b0 + ld.blend * tv.ppf
            tag('전이', b0, b1)
            tag('관성', b1, b1 + ld.inertia * tv.ppf)
          }
          const tl = lane ? tailOf(it) : null
          if (tl) { const e0 = frameToX(sc, it.start + itemLen(it)), e1 = e0 + tl.blend * tv.ppf; tag('전이', e0, e1); tag('기본자세', e1, e1 + tl.hold * tv.ppf) }
          const x = Math.max(frameToX(sc, it.start), LABEL_W) + 4, right = frameToX(sc, it.start + itemLen(it)) - 4
          const { st, old } = video ? { st: undefined, old: false } : phys(t, it), b = badge(st, old)
          const ty = st?.metrics ? y + 9 : y + ROW_H / 2 // above the graph
          const br = Math.min(right, W - 4), bw = b && br - x >= ctx.measureText(b).width ? ctx.measureText(b).width + 8 : 0
          if (b && bw) { // badge at the bar's (visible) right end
            ctx.fillStyle = b.startsWith('⚠') || st?.status === 'error' ? WARN_RED : old ? DIM : C.text
            ctx.fillText(b, br - bw + 8, ty); ctx.fillStyle = C.text
          }
          const nr = bw ? br - bw : right
          if (nr > x) ctx.fillText((video ? refName(it) : pieceName(t, it, ed.getState().project.clips[it.refId], projectTitle(ed.getState().fileName)) + (hasEdit(it) ? ' · 수정됨' : '')) + (video && !mediaUrl(it.refId) ? ' (오프라인)' : ''), x, ty, nr - x)
        }
        ctx.restore()
      }
      // overlaps of neighbouring items (crossfades) as frame ranges
      const overlaps = (items: Item[]) => items.slice(1).map((n, k) => [n.start, items[k].start + itemLen(items[k])] as [number, number]).filter(([a, b]) => b > a)
      rows.forEach(r => {
        const { t, y } = r, actor = s.project.actors.find(a => a.id === t.actorId), video = isVideo(t)
        const color = actor?.color ?? C.text
        const items = sortedItems({ ...t, items: shown(t) })
        ctx.fillStyle = C.line; ctx.fillRect(0, y + ROW_H - 1, W, 1)
        if (r.it) { // piece lane (staircase): that piece's bar, with the crossfades it takes part in
          const it = items.find(i => i.id === r.it!.id) ?? r.it
          bars(t, [it], y, color, true, overlaps(items).filter(([a, b]) => a < it.start + itemLen(it) && b > it.start))
          if (drag?.swapTo === it.id) { ctx.save(); ctx.strokeStyle = C.accent; ctx.lineWidth = 2; ctx.setLineDash([5, 3]); ctx.strokeRect(LABEL_W + 1, y + 1, W - LABEL_W - 2, ROW_H - 3); ctx.restore() } // drop here: trade places
          ctx.fillStyle = C.bg; ctx.fillRect(0, y, LABEL_W - 1, ROW_H - 1)
          drawEye(ctx, EYE_X, y + ROW_H / 2, !!it.hidden, it.hidden ? C.accent : C.line)
          const previewing = it.id === s.itemPreview
          drawPlay(ctx, PLAY_X, y + ROW_H / 2, previewing && s.previewPlaying, previewing ? C.accent : C.line)
          ctx.font = '10px "IBM Plex Sans KR", sans-serif'
          ctx.fillStyle = it.id === s.selItem ? C.accent : hasEdit(it) ? C.piece : C.text // 수정됨: green
          // the column is narrow: "#n · start" (the bar shows the clip name), a short physics tag on the right; the full text on hover
          const { st, old } = phys(t, r.it), tag = treeTag(st, old), right = PLAY_X - ICON_HIT / 2 - 4, tw = tag.text ? ctx.measureText(tag.text).width + 6 : 0
          if (tag.text) {
            ctx.save(); ctx.textAlign = 'right'; ctx.fillStyle = tag.warn ? WARN_RED : DIM; ctx.fillText(tag.text, right, y + ROW_H / 2); ctx.restore()
          }
          const warn = (it.restPose === 'prepend' && leadOf(it)?.why === 'review' || seamOf(it)?.warn ? '⚠ ' : '') // 관성 검토 필요, in front so it is never cut
          ctx.fillText(fit(ctx, warn + laneLabel(t, it) + (hasEdit(it) ? ' 수정' : ''), right - CHILD_X - tw), CHILD_X, y + ROW_H / 2)
          ctx.font = '11px "IBM Plex Sans KR", sans-serif'
          return
        }
        if (!stairs(t)) bars(t, items, y, color, false, overlaps(items)) // expanded: the bars are in the lanes below
        ctx.fillStyle = C.bg; ctx.fillRect(0, y, LABEL_W, ROW_H - 1)
        ctx.globalAlpha = t.hidden ? 0.4 : 1
        if (!video) { ctx.fillStyle = C.text; ctx.fillText(exp.current.has(t.id) ? '▾' : '▸', 6, y + ROW_H / 2) }
        ctx.fillStyle = color; ctx.fillText(video ? 'V1 참조영상' : actor?.name ?? '', video ? 8 : NAME_X, y + ROW_H / 2, (video ? EYE_X - 8 : TRAIL_X - NAME_X) - 9)
        ctx.globalAlpha = 1
        drawEye(ctx, EYE_X, y + ROW_H / 2, t.hidden, t.hidden ? C.accent : C.line)
        drawLock(ctx, LOCK_X, y + ROW_H / 2, t.locked, t.locked ? C.accent : C.line)
        if (!video) drawTrail(ctx, TRAIL_X, y + ROW_H / 2, t.trail ? C.accent : C.line)
      })
      if (ghost) {
        ctx.save(); ctx.beginPath(); ctx.rect(LABEL_W, RULER_H, W - LABEL_W, H - RULER_H); ctx.clip()
        const gx = frameToX(sc, ghost.start), gw = ghost.len * tv.ppf
        ctx.globalAlpha = 0.3; ctx.fillStyle = ghost.color; ctx.fillRect(gx, ghost.y + 2, gw, ROW_H - 5)
        ctx.globalAlpha = 1; ctx.strokeStyle = ghost.color; ctx.strokeRect(gx + 0.5, ghost.y + 2.5, gw - 1, ROW_H - 6)
        if (ghost.line !== undefined) { ctx.fillStyle = C.accent; ctx.fillRect(LABEL_W, ghost.line - 1, W - LABEL_W, 2) } // 레인 기준 드롭: 들어갈 순서
        if (ghost.label) { // 끼울 자리 번호: 고스트 오른쪽(넘치면 왼쪽)에 작은 글자
          ctx.font = '10px "IBM Plex Sans KR", sans-serif'
          const tw = ctx.measureText(ghost.label).width + 8, cy = ghost.y + ROW_H / 2
          const lx = Math.min(W - tw, Math.max(LABEL_W, gx + gw + 4 + tw <= W ? gx + gw + 4 : gx - 4 - tw)) // ghost off-screen: the label stays at the edge
          ctx.fillStyle = C.bg; ctx.fillRect(lx, cy - 8, tw, 15)
          ctx.fillStyle = DIM; ctx.fillText(ghost.label, lx + 4, cy)
          ctx.font = '11px "IBM Plex Sans KR", sans-serif'
        }
        ctx.restore()
      }
      drawRuler(ctx, sc, W, RULER_H, s.project.sequence, s.frame, C, true, s.playheadPinned)
      const px = Math.round(frameToX(sc, s.frame)) + 0.5
      if (s.spanPreview) { // the 구간 프리뷰's span, over the ruler and the rows
        const a = Math.max(frameToX(sc, s.spanPreview[0]), LABEL_W), b = frameToX(sc, s.spanPreview[1])
        if (b > a) { ctx.save(); ctx.fillStyle = C.accent; ctx.globalAlpha = 0.25; ctx.fillRect(a, 0, b - a, RULER_H - 1); ctx.globalAlpha = 0.07; ctx.fillRect(a, RULER_H, b - a, H - RULER_H); ctx.restore() }
      }
      if (px >= LABEL_W) { ctx.fillStyle = C.accent; ctx.fillRect(px - 0.5, RULER_H, 1, H - RULER_H) }
      if (s.itemPreview) { // the clip preview's own playhead
        const qx = Math.round(frameToX(sc, s.previewFrame)) + 0.5
        if (qx >= LABEL_W) { ctx.save(); ctx.strokeStyle = C.text; ctx.globalAlpha = 0.6; ctx.setLineDash([3, 3]); ctx.beginPath(); ctx.moveTo(qx, RULER_H); ctx.lineTo(qx, H); ctx.stroke(); ctx.restore() }
      }
      ctx.fillStyle = C.line; ctx.fillRect(LABEL_W - 1, 0, 1, H)
      const sb = sbar()
      if (sb) drawScrollbar(ctx, W, sb, sbHover, sbDrag, C)
      const end = sequenceEnd(s.project), mmTracks = tracks().map(t => ({
        color: isVideo(t) ? DIM : s.project.actors.find(a => a.id === t.actorId)?.color ?? C.text,
        spans: shown(t).map(i => [i.start, i.start + itemLen(i)] as [number, number]) }))
      drawMinimap(ctx, mm(), H - MM_H, tv.scrollF, mmTracks, { frame: s.frame, inF: s.project.sequence.inF, outF: s.project.sequence.outF,
        markers: s.project.sequence.markers.map(m => m.f) }, `전체 ${mss(end)}`, LABEL_W, mmHover, mmDragging, { ...C, dim: DIM })
    }
    const schedule = () => { if (!raf) raf = requestAnimationFrame(draw) }
    redraw.current = schedule

    const resize = () => {
      const dpr = window.devicePixelRatio || 1, r = canvas.getBoundingClientRect()
      W = r.width; H = r.height
      canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr)
      schedule()
    }
    resetFollow()
    const ro = new ResizeObserver(resize); ro.observe(canvas); resize()
    const unsub = ed.subscribe(schedule), unsubMedia = subscribeMedia(schedule), unsubPhys = usePhysics.subscribe(schedule)
    document.fonts?.addEventListener('loadingdone', schedule) // labels drawn in the fallback font before IBM Plex arrived

    // ---- mouse ----
    const pos = (e: { clientX: number; clientY: number }) => { const r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top } }
    const frameAt = (x: number) => Math.max(0, xToFrame(scale(), x))
    const track = trackDrag
    const rowAt = (y: number) => y < RULER_H ? -1 : layout().findIndex(r => y >= r.y && y < r.y + r.h)
    // topmost item under (x, y) with the zone of the hit: a lane holds its piece, a collapsed track row all of them
    const itemAt = (x: number, y: number) => {
      const r = layout()[rowAt(y)], t = r?.t
      if (!t || y < RULER_H || x < LABEL_W || (!r.it && stairs(t))) return null
      const sc = scale()
      const items = r.it ? t.items.filter(i => i.id === r.it!.id) : sortedItems(t).reverse() // later item wins
      const span = (i: Item) => { const x0 = frameToX(sc, i.start), x1 = frameToX(sc, i.start + itemLen(i)); return { x0, x1, edge: Math.min(EDGE, (x1 - x0) / 3) } }
      for (const it of items) { // edges of every item first, so a crossfade tail stays trimmable
        const { x0, x1, edge } = span(it)
        if (x >= x0 && x - x0 < edge) return { t, it, mode: 'in' as Drag['mode'] }
        if (x <= x1 && x1 - x < edge) return { t, it, mode: 'out' as Drag['mode'] }
      }
      const it = items.find(i => { const { x0, x1 } = span(i); return x >= x0 && x <= x1 })
      return it ? { t, it, mode: 'move' as Drag['mode'] } : null
    }

    // the lead-in / 끝 기본자세 block edge under (x, y) in a lane: lead-in blocks by their left edge (the piece start stays put), 끝
    // blocks by their right edge, outside the bar (its ends trim the piece); the 이음 block inside the bar by its right edge
    const lenEdgeAt = (x: number, y: number) => {
      const r = layout()[rowAt(y)]
      if (!r?.it || r.t.locked || isVideo(r.t) || x < LABEL_W) return null
      const it = r.it, sc = scale(), s0 = frameToX(sc, it.start), s1 = frameToX(sc, it.start + itemLen(it))
      const cand: [LenKey, number, number][] = [] // key, edge x, current length
      if (x >= s0 && x <= s1) { const sm = seamOf(it), ex = sm && s0 + sm.n * tv.ppf; if (sm && ex! - s0 > EDGE && s1 - ex! > EDGE) cand.push(['seam', ex!, sm.n]) }
      const ld = x < s0 && it.restPose === 'prepend' ? leadOf(it) : null, tl = x > s1 ? tailOf(it) : null
      if (ld) { const x0 = s0 - ld.lead * tv.ppf; cand.push(['restHold', x0, ld.hold], ['restBlend', x0 + ld.hold * tv.ppf, ld.blend], ['inertia', x0 + (ld.hold + ld.blend) * tv.ppf, ld.inertia]) }
      if (tl) cand.push(['tailBlend', s1 + tl.blend * tv.ppf, tl.blend], ['tailHold', s1 + tl.tail * tv.ppf, tl.hold])
      let best: { key: LenKey; value: number; d: number; t: Track; it: Item } | null = null
      for (const [key, ex, value] of cand) { const d = Math.abs(x - ex); if (d <= LEN_EDGE && (!best || d < best.d)) best = { key, value, d, t: r.t, it } }
      return best
    }
    const lenDragFrom = (e: MouseEvent, h: NonNullable<ReturnType<typeof lenEdgeAt>>, row: number) => {
      const x = pos(e).x, s = ed.getState(), sign = h.key.startsWith('tail') || h.key === 'seam' ? 1 : -1 // lead-in edges grow leftwards
      const [lo, hi] = h.key === 'inertia' ? [0, Math.min(INERTIA_CAP, h.it.trimIn)] : h.key === 'seam' ? [0, Math.min(SEAM_MAX, itemLen(h.it))] : h.key.endsWith('Hold') ? HOLD_RANGE : BLEND_RANGE
      s.selectItem(h.it.id)
      if (h.t.actorId) s.select(h.t.actorId)
      const at = (m: MouseEvent) => Math.min(Math.max(h.value + sign * Math.round((pos(m).x - x) / tv.ppf), lo), hi)
      track(m => {
        const v = at(m)
        if (v !== (lenDrag?.value ?? h.value)) { lenDrag = { itemId: h.it.id, key: h.key, value: v }; flash(`${LEN_NAME[h.key]} ${v}프레임 (${(v / 60).toFixed(2)}초)`, row); schedule() }
      }, m => {
        const v = at(m)
        lenDrag = null
        if (v !== h.value && !ed.getState().setRestLead(h.it.id, { [h.key]: v })) flash(h.t.locked ? LOCKED : DENY, row)
        schedule()
      }, () => { lenDrag = null; schedule() })
    }

    // a far-off piece (user: hard to find the block): scroll the lanes so it (with its lead-in / 끝 기본자세) is in view
    const focusPiece = (it: Item) => {
      const st = ed.getState(), [lo, hi] = previewRange(st.project, st.defs, it.id) ?? [it.start, it.start + itemLen(it)]
      const vis = (W - SB_W - LABEL_W) / tv.ppf
      if (lo < tv.scrollF || hi > tv.scrollF + vis) { markUserScroll(); tv.scrollF = Math.max(0, hi - lo < vis * 0.9 ? lo - (vis - (hi - lo)) / 2 : lo - vis * 0.05) }
      // its lane (else its track row) fully inside the rows area, e.g. a piece at the bottom of a long list
      const r = layout().find(r => r.it?.id === it.id) ?? layout().find(r => !r.it && r.t.items.some(i => i.id === it.id))
      const bottom = H - hbH()
      if (r && r.y < RULER_H) scrollY = scrollTo = Math.max(0, scrollY - (RULER_H - r.y))
      else if (r && r.y + r.h > bottom) scrollY = scrollTo = Math.min(maxScroll(), scrollY + (r.y + r.h - bottom))
      schedule()
    }
    seqFocus.fn = id => { const it = ed.getState().project.sequence.tracks.flatMap(t => t.items).find(i => i.id === id); if (it) focusPiece(it) }

    // right-drag: a 구간 프리뷰 of that span opens and loops (user); a right-click without a drag keeps its menu (onContext)
    let loopDragged = false
    const loopDrag = (e: MouseEvent) => {
      const x0 = pos(e).x, s = ed.getState(), f0 = frameAt(x0)
      let started = false
      loopDragged = false // a contextmenu that never came must not swallow this press's menu
      const set = (m: MouseEvent) => {
        const x1 = pos(m).x
        if (!started && Math.abs(x1 - x0) < 4) return
        started = true
        const f1 = frameAt(x1)
        s.setSpanPreview([Math.min(f0, f1), Math.max(f0, f1) + 1])
      }
      track(set, m => { set(m); loopDragged = started }, () => {})
    }
    const onDown = (e: MouseEvent) => {
      if (e.button === 2) { loopDrag(e); return }
      if (e.button !== 0) return
      canvas.focus()
      const { x, y } = pos(e), s = ed.getState(), row = rowAt(y)
      if (y < RULER_H) {
        const mi = hitMarker(s.project.sequence, scale(), x)
        if (mi !== null) { s.setFrame(s.project.sequence.markers[mi].f); return }
        s.setFrame(frameAt(x)); track(scrubDrag, scrubEnd)
        return
      }
      const sb = sbar()
      if (sb && x >= W - SB_W) { pressScrollbar(sb, y, scrollY, v => { scrollY = scrollTo = v; schedule() }, on => { sbDrag = on; schedule() }, track, m => pos(m).y); return }
      if (y >= H - MM_H) { // minimap: drag the window (move / an edge = zoom); outside = centre the window there, then drag it
        if (x < LABEL_W) return
        const g = mm(), hit = mmHit(g, tv.scrollF, x), view = W - SB_W - LABEL_W
        if (hit === 'outside') tv.scrollF = Math.min(Math.max(g.total * (x - g.x0) / (g.x1 - g.x0) - g.vis / 2, 0), Math.max(0, g.total - g.vis))
        const kind = hit === 'outside' ? 'move' : hit, at = { scrollF: tv.scrollF, vis: g.vis }, before = { scrollF: tv.scrollF, ppf: tv.ppf }
        const apply = (w: { scrollF: number; vis: number }) => { markUserScroll(); tv.scrollF = w.scrollF; if (kind !== 'move') tv.ppf = view / w.vis; schedule() }
        markUserScroll(); mmDragging = true; schedule()
        track(m => apply(mmDrag(g, at, kind, pos(m).x - x)), () => { mmDragging = false; schedule() },
          () => { tv.scrollF = before.scrollF; tv.ppf = before.ppf; mmDragging = false; schedule() })
        return
      }
      const r = layout()[row]
      if (r?.it && x < LABEL_W && Math.abs(x - EYE_X) <= ICON_HIT / 2) { s.setItemHidden(r.it.id, !r.it.hidden); return } // the piece's 숨기기
      if (r?.it && x < LABEL_W && Math.abs(x - PLAY_X) <= ICON_HIT / 2) { // play / pause that piece's loop in the clip preview
        if (s.itemPreview === r.it.id) s.setPreviewPlaying(!s.previewPlaying)
        else s.openItemPreview(r.it.id, true)
        s.selectItem(r.it.id)
        if (r.t.actorId) s.select(r.t.actorId)
        focusPiece(r.it)
        return
      }
      if (r?.it && x < LABEL_W) { // lane label: select the piece and preview it
        s.selectItem(r.it.id)
        if (r.t.actorId) s.select(r.t.actorId)
        s.openItemPreview(r.it.id, true)
        focusPiece(r.it)
        return
      }
      if (x < LABEL_W) {
        const t = r?.t
        if (!t) return
        if (!isVideo(t) && x < TRI_W) setExpanded(e => { const n = new Set(e); if (!n.delete(t.id)) n.add(t.id); return n })
        else if (!isVideo(t) && Math.abs(x - TRAIL_X) <= ICON_HIT / 2) s.setTrackFlag(t.id, 'trail', !t.trail)
        else if (Math.abs(x - EYE_X) <= ICON_HIT / 2) s.setTrackFlag(t.id, 'hidden', !t.hidden)
        else if (Math.abs(x - LOCK_X) <= ICON_HIT / 2) s.setTrackFlag(t.id, 'locked', !t.locked)
        else if (t.actorId) s.select(t.actorId)
        return
      }
      const le = lenEdgeAt(x, y)
      if (le) { lenDragFrom(e, le, row); return }
      const hit = itemAt(x, y)
      if (!hit) {
        s.selectItem(null); s.setFrame(frameAt(x))
        track(scrubDrag, scrubEnd)
        return
      }
      const { t, it, mode } = hit
      const m = usePhysics.getState().byItem[it.id]?.metrics, ry = layout()[row].y
      if (m && t.actorId && mode === 'move' && y >= ry + 2 + (ROW_H - 5) * GRAPH && !stale(s.project, s.defs, t.actorId, it.id)) {
        const seg = segmentAt(m.segments, xToFrame(scale(), x) - seqFrameOf(s.project, s.defs, it, 0)) // red span: jump to its start
        if (seg) { hover.stop(); s.selectItem(it.id); s.setFrame(Math.max(it.start, seqFrameOf(s.project, s.defs, it, seg.from))); return } // drop the pending hover scrub
      }
      s.selectItem(it.id)
      if (t.actorId) s.select(t.actorId)
      // a lane bar dragged up / down onto another piece's lane of the same track: the two trade places (user)
      const swapTarget = (m: MouseEvent) => { const tr = mode === 'move' && r?.it ? layout()[rowAt(pos(m).y)] : undefined
        return tr?.it && tr.t.id === t.id && tr.it.id !== it.id ? tr.it.id : undefined }
      track(m => {
        const swapTo = swapTarget(m), df = swapTo ? 0 : Math.round((pos(m).x - x) / tv.ppf)
        if (df !== (drag?.df ?? 0) || swapTo !== drag?.swapTo) { drag = { itemId: it.id, mode, df, swapTo }; schedule() }
      }, m => {
        const swapTo = swapTarget(m), df = swapTo ? 0 : Math.round((pos(m).x - x) / tv.ppf), st = ed.getState()
        drag = null
        if (swapTo) { if (!st.swapItems(it.id, swapTo)) flash(t.locked ? LOCKED : DENY, row); schedule(); return }
        if (df === 0 && r?.it) st.openItemPreview(it.id, true) // a click on a lane bar also previews (and plays) that piece
        if (df !== 0) {
          const ok = mode === 'move' ? st.moveItem(it.id, Math.max(0, it.start + df)) : st.trimItem(it.id, mode, df)
          if (!ok) flash(t.locked ? LOCKED : DENY, row)
        }
        schedule()
      }, () => { drag = null; schedule() })
    }

    const onDbl = (e: MouseEvent) => {
      const { x, y } = pos(e), s = ed.getState()
      if (y >= H - MM_H) { // minimap: fit the whole sequence
        if (x >= LABEL_W) { const f = mmFit(W - SB_W - LABEL_W, sequenceEnd(s.project)); markUserScroll(); tv.scrollF = f.scrollF; tv.ppf = f.ppf; schedule() }
        return
      }
      if (y < RULER_H) {
        const mi = hitMarker(s.project.sequence, scale(), x)
        if (mi !== null) { cancel.current = false; setRename({ index: mi, left: Math.max(LABEL_W, x - 55), value: s.project.sequence.markers[mi].name }) }
        return
      }
      const hit = itemAt(x, y)
      if (hit && !isVideo(hit.t)) { // the piece becomes the main, editable view; the clip view's window shows just its frames
        s.closeItemPreview(); s.openItem(hit.it.id)
        if (s.frame < hit.it.start || s.frame >= hit.it.start + itemLen(hit.it)) s.setFrame(hit.it.start)
        const [lo, hi] = previewRange(s.project, s.defs, hit.it.id) ?? [hit.it.start, hit.it.start + itemLen(hit.it)] // with its lead-in / 끝 기본자세
        tv.ppf = Math.min(Math.max((W - LABEL_W - SB_W) / Math.max(hi - lo, 1), 0.5), 40); tv.scrollF = lo - hit.it.start + hit.it.trimIn
      }
    }

    const onContext = (e: MouseEvent) => {
      const { x, y } = pos(e), s = ed.getState()
      if (loopDragged) { loopDragged = false; e.preventDefault(); return } // the right-drag set a loop span: no menu
      if (y >= RULER_H) { // motion item (bar or child row): item menu; motion track label: track menu
        const r = layout()[rowAt(y)]
        if (r && !r.it && x < LABEL_W && r.t.actorId && !isVideo(r.t)) { e.preventDefault(); setCtx({ x: e.clientX, y: e.clientY, actorId: r.t.actorId, trackId: r.t.id, itemId: null }); return }
        const hit = r?.it ? { t: r.t, it: r.it } : itemAt(x, y)
        if (hit && hit.t.actorId && !isVideo(hit.t)) { e.preventDefault(); setCtx({ x: e.clientX, y: e.clientY, actorId: hit.t.actorId, trackId: hit.t.id, itemId: hit.it.id }); return }
        if (hit || x < LABEL_W || y >= H - MM_H || (x >= W - SB_W && !!sbar())) return // a video bar, a label, the minimap or scrollbar: no menu
        e.preventDefault(); setPh({ x: e.clientX, y: e.clientY }) // empty space: 재생헤드 고정 menu (user)
        return
      }
      e.preventDefault()
      const mi = hitMarker(s.project.sequence, scale(), x)
      if (mi !== null) s.deleteMarker(mi)
      else if (x >= LABEL_W) setPh({ x: e.clientX, y: e.clientY }) // ruler: 재생헤드 고정 / 고정 해제 (+ 구간 프리뷰 닫기 when it is open)
    }

    const hover = hoverScrub(() => ed.getState().frame, f => { markHover(); ed.getState().setFrame(f) })
    // past 90% / before 10% of the track area while the playhead follows the pointer: scroll (dragging: the playhead itself)
    let edgeDrag = false
    const edge = edgeScroll(() => [LABEL_W, W - SB_W], () => [0, sequenceEnd(ed.getState().project) - (W - SB_W - LABEL_W) / tv.ppf * 0.5],
      x => { if (edgeDrag) ed.getState().setFrame(frameAt(x)); else { const f = hoverFrame(x, LABEL_W, scale(), false); if (f !== null) hover.push(Math.max(0, f)) } schedule() })
    const scrubDrag = (m: MouseEvent) => { const x = pos(m).x; ed.getState().setFrame(frameAt(x)); edgeDrag = true; edge.at(x) }
    const scrubEnd = () => { edgeDrag = false; edge.stop() }
    const onMove = (e: MouseEvent) => {
      const { x, y } = pos(e), over = y >= RULER_H && x >= W - SB_W && !!sbar()
      const overH = !over && y >= H - MM_H, hit = overH && x >= LABEL_W ? mmHit(mm(), tv.scrollF, x) : null
      if (over !== sbHover) { sbHover = over; schedule() }
      if (hit !== mmHover) { mmHover = hit; schedule() }
      if (over || overH) { canvas.style.cursor = hit === 'left' || hit === 'right' ? 'ew-resize' : hit === 'move' ? 'grab' : ''; if (!edgeDrag) edge.stop(); return }
      const h = itemAt(x, y), le = lenEdgeAt(x, y)
      canvas.style.cursor = le || (h && h.mode !== 'move') ? 'ew-resize' : ''
      // hover help for the track label icons
      const r = x < LABEL_W && y >= RULER_H ? layout()[rowAt(y)] : undefined, near = (ix: number) => Math.abs(x - ix) <= ICON_HIT / 2
      const tip = le ? `끌어서 ${LEN_NAME[le.key]} 길이 조절 (${le.value}프레임)` + (le.key === 'seam' && seamOf(le.it)?.warn ? `\n${SEAM_WARN}` : '') : !r ? '' : r.it ? (near(EYE_X) ? '이 조각 숨기기' : near(PLAY_X) ? (ed.getState().itemPreview === r.it.id && ed.getState().previewPlaying ? '멈춤' : '재생 (클립 프리뷰에서 반복)') : laneTip(r.t, r.it))
        : !isVideo(r.t) && near(TRAIL_X) ? '경로 표시: 이 로봇의 골반이 지나간 바닥 경로를 메인 화면에 선으로 보여 줍니다'
        : near(EYE_X) ? '숨기기' : near(LOCK_X) ? '잠그기' : ''
      if (canvas.title !== tip) canvas.title = tip
      const f = hoverFrame(x, LABEL_W, scale(), e.buttons !== 0 || hoverOff())
      if (f !== null) { hover.push(Math.max(0, f)); edge.at(x) } else if (!edgeDrag) edge.stop()
    }
    // the playhead follows the pointer unless playing, renaming a marker or 재생헤드 고정 (user)
    const hoverOff = () => { const s = ed.getState(); return s.playing || s.playheadPinned || renaming.current }

    // full text of a lane label (hover): piece, time range, clip, 기본자세, physics
    const laneTip = (t: Track, it: Item) => {
      const s = ed.getState(), { st, old } = phys(t, it), ld = it.restPose === 'prepend' ? leadOf(it) : null
      return childLabel(t, it, s.project.clips[it.refId]?.name ?? '') + treeSuffix(st, old).replace(/^ · /, '\n물리 검증: ')
        + (ld?.why === 'review' ? '\n관성 검토 필요' : '') + (seamOf(it)?.warn ? `\n${SEAM_WARN}` : '') + (it.restTail ? '\n끝 기본자세 (전이 · 정지 0.5초)' : '') + (hasEdit(it) ? `\n수정됨 · 수정 키 ${offsetKeyCount(it)}개 (클립 프리뷰에서 고침 · 우클릭: 수정 지우기)` : '')
        + (it.id === s.itemPreview ? '\n클립 프리뷰에서 보는 중' : '')
    }
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      markUserScroll()
      const { x, y } = pos(e)
      if (e.ctrlKey) {
        const fAt = tv.scrollF + (x - LABEL_W) / tv.ppf
        tv.ppf = Math.min(Math.max(tv.ppf * (e.deltaY < 0 ? 1.15 : 1 / 1.15), 0.5), 40)
        tv.scrollF = Math.max(0, fAt - (x - LABEL_W) / tv.ppf)
      } else if (e.shiftKey || x < LABEL_W || (x >= W - SB_W && y >= RULER_H && !!sbar())) { // rows: Shift + wheel, or over the labels / scrollbar; eased in draw (nothing moves when they fit)
        const d = e.shiftKey ? e.deltaY || e.deltaX : e.deltaY
        scrollTo = Math.min(Math.max(scrollTo + (e.deltaMode === 1 ? d * ROW_H : d), 0), maxScroll())
      } else { // 휠 = 구간 이동 (user): up = later, down = earlier; the playhead keeps following the pointer unless 고정
        tv.scrollF = Math.max(0, tv.scrollF + wheelFrames(e, tv.ppf))
        const f = y < H - MM_H ? hoverFrame(x, LABEL_W, scale(), hoverOff()) : null
        if (f !== null) hover.push(Math.max(0, f))
      }
      schedule()
    }

    // ---- asset drag from the project panel: the ghost bar and the drop use the same dropPlacement ----
    const setGhost = (g: typeof ghost) => { ghost = g; schedule() }
    // a child row drops onto its track; a piece lane decides by its piece (front half = before it, else right after it), not by the frame
    const dropAt = (e: DragEvent) => {
      const { x, y } = pos(e), row = layout()[rowAt(y)], frame = row?.it ? laneDropFrame(row.it, frameAt(x)) : frameAt(x)
      return { row, frame, front: !!row?.it && frame === row.it.start }
    }
    const onDragOver = (e: DragEvent) => {
      if (!isAssetDrag(e.dataTransfer ?? null)) return
      e.preventDefault()
      const asset = draggedAsset(null)
      if (!asset) return
      const { row, frame, front } = dropAt(e), p = ed.getState().project, pl = dropPlacement(p, asset, row?.t.id ?? null, frame)
      if (pl.kind === 'reject') return setGhost(null)
      const rows = layout(), last = rows.at(-1), bottom = last ? last.y + last.h : RULER_H - scrollY
      if (pl.kind === 'newActor') setGhost({ y: bottom, start: pl.start, len: (asset.clip ?? p.clips[asset.id]).length, color: COLOR[pl.robot] })
      else {
        const lane = pl.kind === 'existing' && row?.it && row.t.id === pl.trackId ? row : undefined // over a piece lane: the ghost sits on it
        const t = lane ?? (pl.kind === 'video' ? rows.find(r => !r.it && isVideo(r.t)) : rows.find(r => !r.it && r.t.id === pl.trackId))
        const actor = p.actors.find(a => a.id === t?.t.actorId)
        setGhost(t ? { y: t.y, start: pl.start, len: asset.kind === 'clip' ? (asset.clip ?? p.clips[asset.id]).length : p.media.find(m => m.id === asset.id)!.durationF, color: actor?.color ?? C.accent,
          line: lane ? (front ? lane.y : lane.y + ROW_H) : undefined,
          label: pl.kind === 'existing' ? insertLabel(t.t.items, pl.start, pl.shift, it => { // the bar's name without the project prefix
            const pt = projectTitle(ed.getState().fileName), n = pieceName(t.t, it, p.clips[it.refId], pt)
            return n.startsWith(pt + '-') ? n.slice(pt.length + 1) : n
          }) : undefined } : null)
      }
    }
    const onDrop = (e: DragEvent) => {
      setGhost(null)
      const asset = draggedAsset(e.dataTransfer ?? null)
      if (!asset) return
      e.preventDefault()
      const { row, frame } = dropAt(e), many = draggedClips()
      const reason = many.length > 1 ? dropClips(many, row?.t.id ?? null, frame) : dropAsset(asset, row?.t.id ?? null, frame) // ponytail: the ghost shows the first clip only
      if (reason) flash(reason, Math.max(0, layout().findIndex(r => r === row)))
    }
    const clearGhost = () => { if (ghost) setGhost(null) }

    canvas.addEventListener('mousedown', onDown)
    canvas.addEventListener('mousemove', onMove)
    const onLeave = () => { if (!edgeDrag) edge.stop(); if (sbHover || mmHover) { sbHover = false; mmHover = null; schedule() } }
    canvas.addEventListener('mouseleave', onLeave)
    canvas.addEventListener('dblclick', onDbl)
    canvas.addEventListener('contextmenu', onContext)
    canvas.addEventListener('wheel', onWheel, { passive: false })
    canvas.addEventListener('dragover', onDragOver)
    canvas.addEventListener('drop', onDrop)
    canvas.addEventListener('dragleave', clearGhost)
    addEventListener('dragend', clearGhost)
    return () => {
      seqFlash.fn = null; seqFocus.fn = null
      ro.disconnect(); document.fonts?.removeEventListener('loadingdone', schedule); unsub(); unsubMedia(); unsubPhys(); hover.stop(); edge.stop(); cancelAnimationFrame(raf); clearTimeout(timer)
      canvas.removeEventListener('mousedown', onDown)
      canvas.removeEventListener('mousemove', onMove)
      canvas.removeEventListener('mouseleave', onLeave)
      canvas.removeEventListener('dblclick', onDbl)
      canvas.removeEventListener('contextmenu', onContext)
      canvas.removeEventListener('wheel', onWheel)
      canvas.removeEventListener('dragover', onDragOver)
      canvas.removeEventListener('drop', onDrop)
      canvas.removeEventListener('dragleave', clearGhost)
      removeEventListener('dragend', clearGhost)
    }
  }, [])

  const commit = () => {
    if (rename && !cancel.current) {
      const name = rename.value.trim()
      if (name) getEditor().getState().renameMarker(rename.index, name)
    }
    setRename(null)
  }
  const closeCtx = (refocus: boolean) => { setCtx(null); setPh(null); if (refocus) cv.current?.focus() }
  useEffect(() => {
    if (!ctx && !ph) return
    menuRef.current?.querySelector<HTMLElement>('[role=menuitem]')?.focus()
    const away = (e: Event) => { if (!menuRef.current?.contains(e.target as Node)) { setCtx(null); setPh(null) } }
    document.addEventListener('pointerdown', away); document.addEventListener('wheel', away, true); document.addEventListener('scroll', away, true)
    return () => { document.removeEventListener('pointerdown', away); document.removeEventListener('wheel', away, true); document.removeEventListener('scroll', away, true) }
  }, [ctx, ph])
  const runExport = async (c: Ctx) => {
    const st = getEditor().getState(), m = await exportOne(st.project, st.defs, c.actorId, c.itemId!, undefined, projectTitle(st.fileName))
    if (m) seqFlash.fn?.(m, c.itemId!)
  }
  const project = useEditor(s => s.project), byItem = usePhysics(s => s.byItem)
  const pinned = useEditor(s => s.playheadPinned), spanOpen = useEditor(s => !!s.spanPreview)
  // 재생헤드 고정 (user): only the pointer-follow stops; clicks on the ruler, the arrow keys and playback still move it
  const pinItem = <button role="menuitem" tabIndex={-1} title={pinned ? '재생헤드가 다시 마우스를 따라갑니다' : '마우스를 움직여도 재생헤드가 이 프레임에 머뭅니다'}
    onClick={() => { closeCtx(true); getEditor().getState().setPlayheadPinned(!pinned) }}>{pinned ? '고정 해제' : '재생헤드 고정'}</button>
  const menuKeys = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeCtx(true) } else if (e.key === 'Tab') closeCtx(true)
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const its = [...menuRef.current!.querySelectorAll<HTMLElement>('[role=menuitem]')], i = its.indexOf(document.activeElement as HTMLElement)
      its[(i + (e.key === 'ArrowDown' ? 1 : its.length - 1)) % its.length]?.focus()
    }
  }
  // a robot is known to have no physics model once one of its items came back 미지원
  const robotOf = (actorId?: string) => project.actors.find(a => a.id === actorId)?.robot
  const noModel = !!ctx && project.sequence.tracks.some(t => robotOf(t.actorId) === robotOf(ctx.actorId) && t.items.some(i => byItem[i.id]?.message === '미지원'))
  const runPhys = (c: Ctx) => {
    const t = project.sequence.tracks.find(t => t.id === c.trackId)
    if (t) void runItems((c.itemId ? [c.itemId] : sortedItems(t).map(i => i.id)).map(itemId => ({ actorId: c.actorId, itemId })))
  }
  const ctxItem = ctx?.itemId ? project.sequence.tracks.find(t => t.id === ctx.trackId)?.items.find(i => i.id === ctx.itemId) ?? null : null
  const rows = project.sequence.tracks.filter(t => t.kind === 'motion' || (isVideo(t) && project.media.length > 0))
  return (
    <div className="tl-body">
      <canvas ref={cv} tabIndex={0} className="track-canvas seq-canvas" />
      <div className="sr-only">
        {rows.map(t => {
          const name = isVideo(t) ? 'V1 참조영상' : project.actors.find(a => a.id === t.actorId)?.name ?? ''
          const flag = (f: 'hidden' | 'locked' | 'trail', label: string) =>
            <button aria-pressed={!!t[f]} onClick={() => getEditor().getState().setTrackFlag(t.id, f, !t[f])}>{name} {label}</button>
          const open = !isVideo(t) && expanded.has(t.id)
          return (
            <span key={t.id}>
              {!isVideo(t) && <button aria-expanded={open} onClick={() => toggle(t.id)}>{name} 클립 목록</button>}
              {!isVideo(t) && flag('trail', '경로 표시')}{flag('hidden', '숨기기')}{flag('locked', '잠그기')}
              {open && sortedItems(t).map(it => (
                <button key={it.id} onClick={() => { const s = getEditor().getState(); s.selectItem(it.id); s.openItemPreview(it.id) }}>
                  {childLabel(t, it, project.clips[it.refId]?.name ?? '')} 클립 프리뷰
                </button>
              ))}
              {open && sortedItems(t).map(it => (
                <button key={`h${it.id}`} aria-pressed={!!it.hidden} onClick={() => getEditor().getState().setItemHidden(it.id, !it.hidden)}>
                  {childLabel(t, it, project.clips[it.refId]?.name ?? '')} 숨기기
                </button>
              ))}
            </span>
          )
        })}
      </div>
      {!rows.length && <div className="seq-empty">CSV 가져오기로 모션을 불러오세요</div>}
      {ctx && (
        <div ref={menuRef} role="menu" aria-label="클립" className="tl-menu" style={{ left: ctx.x, top: ctx.y }} onKeyDown={menuKeys}>
          {ctx.itemId && <button role="menuitem" tabIndex={-1} onClick={() => { closeCtx(false); void runExport(ctx) }}>export하기</button>}
          {ctxItem && hasEdit(ctxItem) && <button role="menuitem" tabIndex={-1} title="이 조각의 수정을 모두 지우고 원본 클립대로 되돌립니다"
            onClick={() => { closeCtx(false); if (!getEditor().getState().clearOffset(ctxItem.id)) seqFlash.fn?.(LOCKED, ctxItem.id) }}>수정 지우기</button>}
          <button role="menuitem" tabIndex={-1} aria-disabled={noModel} title={noModel ? '미지원' : undefined}
            onClick={() => { if (noModel) return; closeCtx(false); runPhys(ctx) }}>{ctx.itemId ? '물리 검증' : '트랙 물리 검증'}</button>
          {pinItem}
        </div>
      )}
      {ph && !ctx && (
        <div ref={menuRef} role="menu" aria-label="재생헤드" className="tl-menu" style={{ left: ph.x, top: ph.y }} onKeyDown={menuKeys}>
          {pinItem}
          {spanOpen && <button role="menuitem" tabIndex={-1} onClick={() => { closeCtx(true); getEditor().getState().setSpanPreview(null) }}>구간 프리뷰 닫기</button>}
        </div>
      )}
      {msg && <div className="seq-msg" style={{ left: msg.left, top: msg.top }}>{msg.text}</div>}
      {rename && (
        <input className="seq-rename" autoFocus value={rename.value} style={{ left: rename.left }}
          onChange={e => setRename({ ...rename, value: e.target.value })} onBlur={commit}
          onKeyDown={e => {
            if (e.key === 'Enter') e.currentTarget.blur()
            else if (e.key === 'Escape') { cancel.current = true; e.currentTarget.blur() }
          }} />
      )}
    </div>
  )
}
