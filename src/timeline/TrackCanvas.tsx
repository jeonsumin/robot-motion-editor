import { useEffect, useRef, useState } from 'react'
import { trackDrag } from './drag'
import { onHandleArrow } from '../layout/useLayout'
import { actorOf, clampDf, CLIP_ACTOR, clipLocked, editingItem, editTarget, getEditor, keyOwner, keyTarget, targetItem, type KeyRef } from '../store/store'
import type { Interp, Sequence } from '../model/types'
import { tv } from './viewState'
import { buildRows, frameToX, hitKey, hoverFrame, hoverScrub, keysIn, xToFrame, type TimeScale } from './timeScale'
import { edgeScroll, followStep, markHover, markUserScroll, resetFollow, wheelFrames } from './follow'
import { drawRuler, LABEL_W, RULER_H } from './ruler'
import { drawPieceBounds, drawRangeBand, minScrollF, startRangeDrag } from './rangeBand'
import { drawScrollbar, pressScrollbar, SB_W, sbGeom } from './vscroll'
import { usePhysics } from '../physics/physicsStore'
import { stale } from '../physics/runItem'
import { withDefaults } from '../physics/settings'
import { drawAssist } from './physGraph'

const ROW_H = 20, KEY = 7, BAND = 24 // 보조력 band under the ruler, only while the open item has a result
const NO_SEQ: Sequence = { tracks: [], markers: [], inF: null, outF: null }
const sameKey = (a: KeyRef, b: KeyRef) => a.channel === b.channel && a.f === b.f

// {channel, dfFromFirst, v, interp}[] - survives view switches
let clipboard: { channel: string; dfFromFirst: number; v: number; interp: Interp }[] = []

interface Ui {
  scrollY: number
  dragDf: number                          // key-drag preview offset (frames)
  box: { x0: number; y0: number; x1: number; y1: number } | null
}

export default function TrackCanvas() {
  const cv = useRef<HTMLCanvasElement>(null)
  const ui = useRef<Ui>({ scrollY: 0, dragDf: 0, box: null })
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const menuOpen = useRef(false)
  menuOpen.current = !!menu

  useEffect(() => {
    const canvas = cv.current!, ed = getEditor(), u = ui.current
    const css = getComputedStyle(document.documentElement)
    const col = (n: string) => css.getPropertyValue(n).trim()
    const C = { bg: col('--bg'), panel: col('--panel'), line: col('--line'), text: col('--text'), accent: col('--accent'), piece: col('--piece'), rest: col('--rest'), blend: col('--blend'), inertia: col('--inertia') }
    let W = 0, H = 0, raf = 0, sbHover = false, sbDrag = false

    const scale = (): TimeScale => ({ x0: LABEL_W - tv.scrollF * tv.ppf, pxPerFrame: tv.ppf })
    // the open item, its clip and the curves keys are edited on: the clip, or (이 조각 수정) the item's 수정 층 (owner = item id)
    const itemOf = (actorId: string) => {
      const s = ed.getState(), t = keyTarget(s, actorId)
      const item = t && targetItem(s, t.itemId)
      const own = t && keyOwner(s.project, t.owner)
      // piece: keys sit on a 수정 층 (the piece's or the clip's); only those keys are drawn (user: hide the clip's own keys)
      return item && own ? { item, clip: s.project.clips[item.refId], owner: t.owner, keys: own, piece: own.offset } : null
    }
    // clip view: the time axis is clip frames, so the clip scale is the view scale
    const clipScale = (actorId: string): TimeScale | null => itemOf(actorId) ? scale() : null
    const toSeq = (clipF: number) => { // clip frame -> sequence frame of the open item
      const e = editingItem(ed.getState())
      return e ? e.item.start - e.item.trimIn + Math.min(Math.max(clipF, 0), e.clip.length - 1) : 0
    }
    const rows = () => {
      const s = ed.getState(), a = editingItem(s)?.actorId, v = s.clipEdit ? actorOf(s, CLIP_ACTOR) : undefined
      return buildRows(s.project, s.defs, v ? [v] : undefined).filter(r => r.actorId === a)
    }
    const band = () => { const e = editingItem(ed.getState()), m = e && usePhysics.getState().byItem[e.item.id]?.metrics; return e && m ? { e, m } : null }
    const top = () => RULER_H + (band() ? BAND : 0) // rows start here
    const rowAt = (y: number) => Math.floor((y - top() + u.scrollY) / ROW_H)
    const rowY = (i: number) => top() + i * ROW_H - u.scrollY
    const sbar = () => sbGeom(top(), H, rows().length * ROW_H, u.scrollY) // vertical scrollbar, null when the rows fit

    const draw = () => {
      raf = 0
      const s = ed.getState(), dpr = window.devicePixelRatio || 1
      const e0 = editingItem(s)
      if (e0 && followStep({ frame: s.frame, playF: s.frame - (e0.item.start - e0.item.trimIn), playing: s.playing, visibleF: (W - LABEL_W) / tv.ppf, contentEnd: e0.clip.length })) schedule()
      const ctx = canvas.getContext('2d')!
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.fillStyle = C.bg; ctx.fillRect(0, 0, W, H)
      ctx.font = '11px "IBM Plex Sans KR", sans-serif'; ctx.textBaseline = 'middle'
      const rs = rows(), sc = scale(), T = top()
      const maxY = Math.max(0, rs.length * ROW_H - (H - T))
      if (u.scrollY > maxY) u.scrollY = maxY // the panel grew

      ctx.save(); ctx.beginPath(); ctx.rect(0, T, W, H - T); ctx.clip()
      rs.forEach((r, i) => {
        const y = rowY(i)
        if (y + ROW_H < T || y > H) return
        const actor = actorOf(s, r.actorId)!
        ctx.fillStyle = C.panel; ctx.fillRect(0, y, W, ROW_H)
        ctx.fillStyle = C.line; ctx.fillRect(0, y + ROW_H - 1, W, 1)
        const cs = clipScale(r.actorId), it = itemOf(r.actorId)
        if (cs && it) {
          // only keys in the visible frame range (widened by a key-drag preview offset)
          const pad = Math.abs(u.dragDf) + 1, lo = xToFrame(cs, LABEL_W - KEY) - pad, hi = xToFrame(cs, W + KEY) + pad
          const frames = new Set<number>()
          for (const ch of r.channels) for (const k of keysIn(it.keys.channels[ch]?.keys ?? [], lo, hi)) frames.add(k.f)
          for (const f of frames) {
            const isSel = s.sel.actorId === r.actorId &&
              r.channels.some(ch => s.sel.keys.some(k => sameKey(k, { channel: ch, f })))
            const x = frameToX(cs, f + (isSel ? u.dragDf : 0)), cy = y + ROW_H / 2, h = KEY / 2 + 0.5
            if (x < LABEL_W - KEY || x > W + KEY) continue
            ctx.fillStyle = isSel ? C.accent : it.piece ? C.piece : C.text
            ctx.beginPath()
            ctx.moveTo(x, cy - h); ctx.lineTo(x + h, cy); ctx.lineTo(x, cy + h); ctx.lineTo(x - h, cy); ctx.fill()
          }
        }
        // label column, drawn over keys scrolled beneath it
        ctx.fillStyle = C.panel; ctx.fillRect(0, y, LABEL_W, ROW_H - 1)
        ctx.fillStyle = actor.color
        ctx.fillText(r.label, 6, y + ROW_H / 2, LABEL_W - 6)
      })
      ctx.restore()

      const b = band()
      if (b) { // 보조력 band: the item's CSV frame 0 is clip frame trimIn
        const actor = actorOf(s, b.e.actorId)!
        ctx.fillStyle = C.panel; ctx.fillRect(0, RULER_H, W, BAND); ctx.fillStyle = C.line; ctx.fillRect(0, RULER_H + BAND - 1, W, 1)
        drawAssist(ctx, b.m.pct, b.m.segments, b.e.item.trimIn, sc, LABEL_W, W, RULER_H + 3, BAND - 6, actor.color,
          withDefaults(s.project.physics)[actor.robot].warnPct, stale(s.project, s.defs, b.e.actorId!, b.e.item.id))
        ctx.fillStyle = C.text; ctx.fillText('보조력', 6, RULER_H + BAND / 2)
      }
      const e = editingItem(s)
      if (e) { // only the piece's frames (and its lead-in / 끝 기본자세): the rest of the clip blank
        drawPieceBounds(ctx, sc, e.item, RULER_H, H, LABEL_W, W, C)
      }
      const pa = e?.actorId ?? s.sel.actorId, tg = pa ? editTarget(s, pa) : null, cf = tg?.f ?? 0
      drawRuler(ctx, sc, W, RULER_H, NO_SEQ, cf, C, true, s.playheadPinned)
      if (s.range) drawRangeBand(ctx, sc, s.range, 0, H, LABEL_W, W, C.accent)

      if (u.box) {
        const b = u.box
        ctx.strokeStyle = C.accent; ctx.lineWidth = 1
        ctx.strokeRect(Math.min(b.x0, b.x1) + 0.5, Math.min(b.y0, b.y1) + 0.5, Math.abs(b.x1 - b.x0), Math.abs(b.y1 - b.y0))
      }
      const px = Math.round(frameToX(sc, cf)) + 0.5
      if (px >= LABEL_W) { ctx.fillStyle = C.accent; ctx.fillRect(px - 0.5, 0, 1, H) }
      ctx.fillStyle = C.line; ctx.fillRect(LABEL_W - 1, 0, 1, H)
      const sb = sbar()
      if (sb) drawScrollbar(ctx, W, sb, sbHover, sbDrag, C)
    }
    const schedule = () => { if (!raf) raf = requestAnimationFrame(draw) }

    const resize = () => {
      const dpr = window.devicePixelRatio || 1, r = canvas.getBoundingClientRect()
      W = r.width; H = r.height
      canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr)
      schedule()
    }
    resetFollow()
    const ro = new ResizeObserver(resize); ro.observe(canvas); resize()
    const unsub = ed.subscribe(schedule), unsubPhys = usePhysics.subscribe(schedule)
    document.fonts?.addEventListener('loadingdone', schedule) // labels drawn in the fallback font before IBM Plex arrived

    // ---- mouse ----
    const pos = (e: MouseEvent) => { const r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top } }
    const frameAtX = (x: number) => toSeq(xToFrame(scale(), x))
    const drag = trackDrag

    // key under the cursor, with the owning actor's clip
    const keyAt = (x: number, y: number) => {
      const r = rows()[rowAt(y)]
      if (!r || y < top() || x < LABEL_W) return null
      const cs = clipScale(r.actorId), it = itemOf(r.actorId)
      if (!cs || !it) return null
      const hit = hitKey([r], it.keys, cs, ROW_H, x, ROW_H / 2)
      return hit && { actorId: r.actorId, clipId: it.owner, hit }
    }
    const selected = (hit: KeyRef[]) => hit.every(h => ed.getState().sel.keys.some(q => sameKey(q, h)))

    const onDown = (e: MouseEvent) => {
      if (e.button !== 0) return
      setMenu(null); canvas.focus()
      const { x, y } = pos(e), s = ed.getState()
      if (y < RULER_H && startRangeDrag(e, x, scale, m => pos(m).x, drag)) return // Shift+drag on the ruler: 구간
      if (y < top()) { // ruler (and 보조력 band) scrub
        s.setFrame(frameAtX(x))
        drag(m => { const mx = pos(m).x; s.setFrame(frameAtX(mx)); edgeDrag = true; edge.at(mx) }, () => { edgeDrag = false; edge.stop() })
        return
      }
      const sb = sbar()
      if (sb && x >= W - SB_W) { pressScrollbar(sb, y, u.scrollY, v => { u.scrollY = v; schedule() }, on => { sbDrag = on; schedule() }, drag, m => pos(m).y); return }
      if (x < LABEL_W) { // label column
        const r = rows()[rowAt(y)]
        if (!r) return
        if (s.sel.actorId !== r.actorId) s.select(r.actorId, null) // same robot: the joint stays
        schedule(); return
      }
      const k = keyAt(x, y)
      if (k) {
        if (s.sel.actorId !== k.actorId) s.select(k.actorId, null)
        if (e.shiftKey) {
          if (selected(k.hit)) s.selectKeys(ed.getState().sel.keys.filter(q => !k.hit.some(h => sameKey(q, h))), false)
          else s.selectKeys(k.hit, true)
        } else if (!selected(k.hit)) s.selectKeys(k.hit, false)
        if (clipLocked(ed.getState().project, k.clipId)) return // selection works; moving is blocked (Timeline shows the message)
        const clipLen = keyOwner(ed.getState().project, k.clipId)!.length
        drag(m => { u.dragDf = clampDf(clipLen, ed.getState().sel.keys, (pos(m).x - x) / tv.ppf); schedule() }, m => {
          const df = Math.round((pos(m).x - x) / tv.ppf), st = ed.getState()
          u.dragDf = 0
          if (df !== 0 && st.sel.keys.length) st.moveKeys(k.clipId, st.sel.keys, df)
          schedule()
        }, () => { u.dragDf = 0; schedule() })
        return
      }
      // empty: click = setFrame, drag = box select
      let moved = false
      drag(m => {
        const p = pos(m)
        if (!moved && Math.hypot(p.x - x, p.y - y) < 3) return
        moved = true; u.box = { x0: x, y0: y, x1: p.x, y1: p.y }; schedule()
      }, () => {
        const st = ed.getState()
        if (!moved) {
          st.setFrame(frameAtX(x))
          if (!e.shiftKey) st.selectKeys([], false)
          return
        }
        const b = u.box!; u.box = null
        const bx0 = Math.min(b.x0, b.x1), bx1 = Math.max(b.x0, b.x1)
        const r0 = rowAt(Math.min(b.y0, b.y1)), r1 = rowAt(Math.max(b.y0, b.y1))
        const rs = rows(), found: KeyRef[] = []
        let actorId: string | null = null // selection stays within one actor
        for (let i = Math.max(r0, 0); i <= r1 && i < rs.length; i++) {
          const r = rs[i], cs = clipScale(r.actorId), it = itemOf(r.actorId)
          if (!cs || !it || (actorId && r.actorId !== actorId)) continue
          for (const ch of r.channels) for (const key of it.keys.channels[ch]?.keys ?? []) {
            const kx = frameToX(cs, key.f)
            if (kx >= bx0 && kx <= bx1 && kx >= LABEL_W) { actorId = r.actorId; found.push({ channel: ch, f: key.f }) }
          }
        }
        const additive = e.shiftKey && st.sel.actorId === actorId
        if (actorId && st.sel.actorId !== actorId) st.select(actorId)
        st.selectKeys(found, additive)
        schedule()
      }, () => { u.box = null; schedule() })
    }

    const hover = hoverScrub(() => ed.getState().frame, f => { markHover(); ed.getState().setFrame(f) })
    let edgeDrag = false // past 90% / before 10% of the track area while the playhead follows the pointer: scroll
    const edge = edgeScroll(() => [LABEL_W, W - SB_W], () => { const e = editingItem(ed.getState()); return [minScrollF(), (e?.item.trimOut ?? 0) - (W - SB_W - LABEL_W) / tv.ppf * 0.5] },
      x => { if (edgeDrag) ed.getState().setFrame(frameAtX(x)); else { const f = hoverFrame(x, LABEL_W, scale(), false); if (f !== null) hover.push(toSeq(f)) } schedule() })
    const onMove = (e: MouseEvent) => {
      const { x, y } = pos(e), over = y >= top() && x >= W - SB_W && !!sbar()
      if (over !== sbHover) { sbHover = over; schedule() }
      if (over) { if (!edgeDrag) edge.stop(); return }
      const f = hoverFrame(pos(e).x, LABEL_W, scale(), e.buttons !== 0 || hoverOff())
      if (f !== null) { hover.push(toSeq(f)); edge.at(x) } else if (!edgeDrag) edge.stop()
    }

    const hoverOff = () => { const s = ed.getState(); return s.playing || s.playheadPinned || menuOpen.current || !editingItem(s) }
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      markUserScroll()
      if (e.ctrlKey) {
        const { x } = pos(e), fAt = tv.scrollF + (x - LABEL_W) / tv.ppf
        tv.ppf = Math.min(Math.max(tv.ppf * (e.deltaY < 0 ? 1.15 : 1 / 1.15), 0.5), 40)
        tv.scrollF = Math.max(minScrollF(), fAt - (x - LABEL_W) / tv.ppf)
      } else if (e.shiftKey || pos(e).x < LABEL_W || pos(e).x >= W - SB_W) { // vertical scroll (Shift, or over the labels / scrollbar)
        const max = Math.max(0, rows().length * ROW_H - (H - top()))
        u.scrollY = Math.min(Math.max(u.scrollY + (e.deltaY || e.deltaX), 0), max)
      } else { // 휠 = 구간 이동 (user, like the sequence): up = later; the playhead keeps following the pointer unless 고정
        tv.scrollF = Math.max(minScrollF(), tv.scrollF + wheelFrames(e, tv.ppf))
        const f = hoverFrame(pos(e).x, LABEL_W, scale(), hoverOff())
        if (f !== null) hover.push(toSeq(f))
      }
      schedule()
    }

    const onContext = (e: MouseEvent) => {
      e.preventDefault()
      const { x, y } = pos(e), k = keyAt(x, y), s = ed.getState()
      if (!k) return
      if (s.sel.actorId !== k.actorId) s.select(k.actorId, null)
      if (!selected(k.hit)) s.selectKeys(k.hit, false)
      if (clipLocked(s.project, k.clipId)) return
      setMenu({ x: e.clientX, y: e.clientY })
    }

    const onKey = (e: KeyboardEvent) => {
      const t = e.target
      if (onHandleArrow(e)) return
      if (t instanceof Element && t.closest('#project')) return
      if (t instanceof HTMLElement && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName))) return
      const s = ed.getState()
      if (s.view !== 'tracks' || !s.sel.actorId || e.altKey) return
      const target = keyTarget(s, s.sel.actorId)
      if (!target) return
      const { owner: clipId, f } = target
      const keys = s.sel.keys, mod = e.ctrlKey || e.metaKey, k = e.key.toLowerCase()
      const frozen = clipLocked(s.project, clipId)
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (keys.length && !frozen) { e.preventDefault(); s.deleteKeys(clipId, keys) }
      } else if (mod && k === 'c') {
        const clip = keyOwner(s.project, clipId)!
        const items = keys.flatMap(r => {
          const key = clip.channels[r.channel]?.keys.find(q => q.f === r.f)
          return key ? [{ channel: r.channel, f: key.f, v: key.v, interp: key.interp }] : []
        })
        if (!items.length) return
        e.preventDefault()
        const first = Math.min(...items.map(i => i.f))
        clipboard = items.map(i => ({ channel: i.channel, dfFromFirst: i.f - first, v: i.v, interp: i.interp }))
      } else if (mod && k === 'v') {
        if (!clipboard.length || frozen) return
        e.preventDefault()
        s.beginGesture()
        for (const c of clipboard) s.setKey(clipId, c.channel, f + c.dfFromFirst, c.v)
        for (const interp of ['linear', 'bezier', 'hold'] as const) {
          const ks = clipboard.filter(c => c.interp === interp).map(c => ({ channel: c.channel, f: f + c.dfFromFirst }))
          if (ks.length) s.setInterp(clipId, ks, interp)
        }
        s.endGesture()
      }
    }

    canvas.addEventListener('mousedown', onDown)
    canvas.addEventListener('mousemove', onMove)
    const onLeave = () => { if (!edgeDrag) edge.stop(); if (sbHover) { sbHover = false; schedule() } }
    canvas.addEventListener('mouseleave', onLeave)
    canvas.addEventListener('wheel', onWheel, { passive: false })
    canvas.addEventListener('contextmenu', onContext)
    window.addEventListener('keydown', onKey)
    return () => {
      ro.disconnect(); document.fonts?.removeEventListener('loadingdone', schedule); unsub(); unsubPhys(); cancelAnimationFrame(raf); hover.stop(); edge.stop()
      canvas.removeEventListener('mousedown', onDown)
      canvas.removeEventListener('mousemove', onMove)
      canvas.removeEventListener('mouseleave', onLeave)
      canvas.removeEventListener('wheel', onWheel)
      canvas.removeEventListener('contextmenu', onContext)
      window.removeEventListener('keydown', onKey)
    }
  }, [])

  // context menu closes on Escape / outside click
  useEffect(() => {
    if (!menu) return
    const close = () => setMenu(null)
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); close() } }
    addEventListener('mousedown', close); addEventListener('keydown', esc, true) // capture: runs before transport's Esc
    return () => { removeEventListener('mousedown', close); removeEventListener('keydown', esc, true) }
  }, [menu])

  const apply = (interp: Interp) => {
    const s = getEditor().getState()
    const t = s.sel.actorId && s.sel.keys.length ? keyTarget(s, s.sel.actorId) : null
    if (t) s.setInterp(t.owner, s.sel.keys, interp)
    setMenu(null)
  }
  return (
    <>
      <canvas ref={cv} tabIndex={0} className="track-canvas" />
      {menu && (
        <div className="tl-menu" style={{ left: menu.x, top: menu.y }} onMouseDown={e => e.stopPropagation()}>
          {([['선형', 'linear'], ['이즈', 'bezier'], ['홀드', 'hold']] as const).map(([l, i]) =>
            <button key={i} onClick={() => apply(i)}>{l}</button>)}
        </div>
      )}
    </>
  )
}
