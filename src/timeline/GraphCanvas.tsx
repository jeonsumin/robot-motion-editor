import { useEffect, useRef } from 'react'
import { trackDrag } from './drag'
import { onHandleArrow } from '../layout/useLayout'
import { actorOf, ASSET, clampDf, clipLocked, editingItem, editTarget, getEditor, keyOwner, keyTarget, targetItem, type KeyRef } from '../store/store'
import { baseClip, editedClip } from '../model/itemClip'
import type { Curve, Key, Sequence } from '../model/types'
import { evalCurve } from '../model/curve'
import { fitView, handlePoints, valueToY, velocityViolations, yToValue, type ValueScale } from './graph'
import { frameToX, hoverFrame, hoverScrub, ROOT_CHANNELS, type TimeScale } from './timeScale'
import { edgeScroll, followStep, markHover, markUserScroll, resetFollow, wheelFrames } from './follow'
import { drawRuler, LABEL_W, RULER_H } from './ruler'
import { drawPieceBounds, drawRangeBand, minScrollF, startRangeDrag } from './rangeBand'
import { tv } from './viewState'

const KEY = 6, HANDLE_R = 2.5, RED = '#E5484D'
const PALETTE = ['#FFD166', '#58B4D1', '#EF8354', '#9BD36B', '#C792EA', '#4FB99F', '#E8E8E8', '#7A8CFF']
const NO_SEQ: Sequence = { tracks: [], markers: [], inF: null, outF: null }
const sameKey = (a: KeyRef, b: KeyRef) => a.channel === b.channel && a.f === b.f

interface Drag { keys: KeyRef[]; df: number; dv: number }
type Lim = { name: string; lower: number; upper: number; velocity: number }

export default function GraphCanvas() {
  const cv = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = cv.current!, ed = getEditor()
    const css = getComputedStyle(document.documentElement)
    const col = (n: string) => css.getPropertyValue(n).trim()
    const C = { bg: col('--bg'), panel: col('--panel'), line: col('--line'), text: col('--text'), accent: col('--accent'), piece: col('--piece'), rest: col('--rest'), blend: col('--blend'), inertia: col('--inertia') }
    let W = 0, H = 0, raf = 0, fitted = false
    let vs: ValueScale = { y0: 200, pxPerUnit: 100 }
    let drag: Drag | null = null

    const scale = (): TimeScale => ({ x0: LABEL_W - tv.scrollF * tv.ppf, pxPerFrame: tv.ppf })
    const ctxOf = () => {
      const s = ed.getState()
      if (!s.sel.actorId) return null
      const actor = actorOf(s, s.sel.actorId)
      const tg = keyTarget(s, s.sel.actorId)
      const item = tg && targetItem(s, tg.itemId)
      const own = tg && keyOwner(s.project, tg.owner)
      if (!actor || !item || !own) return null
      // src: the curves keys are edited on (clip, or 수정 층 deltas); clip: what deltas add to (클립 수정 층: the original; 조각:
      // the clip with its 수정 층); shown: the result (클립 편집: the clip as edited; 시퀀스: what the piece plays)
      const asset = tg.owner.startsWith(ASSET), def = s.defs[actor.robot]
      const clip = asset ? s.project.clips[item.refId] : baseClip(s.project, s.defs, item.refId)!
      const cs = scale(), piece = own.offset
      return { s, clip, def, cs, clipId: tg.owner, piece, src: own, shown: (asset ? baseClip(s.project, s.defs, item.refId) : editedClip(s.project, s.defs, item)) ?? clip }
    }
    // 이 조각 수정: a delta key sits on the result curve, i.e. at the clip's value plus the delta
    const shift = (c: { piece: boolean; clip: { channels: Record<string, Curve> }; def: { standingHeight: number } }, ch: string, f: number) =>
      c.piece ? evalCurve(c.clip.channels[ch] ?? { keys: [] }, f, ch === 'root.z' ? c.def.standingHeight : 0) : 0
    // union of sel.channel and the channels of sel.keys; 'root' / 'group:<name>' expand to their channels; max 8
    const shown = (): string[] => {
      const { sel, project, defs } = ed.getState(), out: string[] = []
      const robot = actorOf(ed.getState(), sel.actorId)?.robot
      const expand = (ch: string): string[] =>
        ch === 'root' || ch === 'group:루트' ? ROOT_CHANNELS
        : ch.startsWith('group:') ? (robot && defs[robot].groups.find(g => g.name === ch.slice(6))?.joints) || []
        : [ch]
      for (const ch of [sel.channel, ...sel.keys.map(k => k.channel)]) {
        if (!ch) continue
        for (const c of expand(ch)) if (!out.includes(c)) out.push(c)
      }
      return out.slice(0, 8)
    }
    // curve with the in-progress key drag applied (preview only; the store is untouched until mouseup)
    const curveOf = (clip: { channels: Record<string, Curve> }, joints: Lim[], ch: string): Curve => {
      const base = clip.channels[ch] ?? { keys: [] }
      const d = drag
      if (!d || !d.keys.some(k => k.channel === ch)) return base
      const j = joints.find(j => j.name === ch)
      const moved = new Set(d.keys.filter(k => k.channel === ch).map(k => k.f))
      const mv = base.keys.filter(k => moved.has(k.f)).map(k => {
        const v = k.v + d.dv
        return { ...k, f: k.f + d.df, v: j ? Math.min(Math.max(v, j.lower), j.upper) : v }
      })
      const dest = new Set(mv.map(k => k.f))
      return { keys: [...base.keys.filter(k => !moved.has(k.f) && !dest.has(k.f)), ...mv].sort((a, b) => a.f - b.f) }
    }

    const visibleClipRange = (clip: { length: number }, cs: TimeScale): [number, number] => [
      Math.max(0, Math.floor((LABEL_W - cs.x0) / tv.ppf)), Math.min(clip.length - 1, Math.ceil((W - cs.x0) / tv.ppf))]

    const fit = () => {
      const c = ctxOf(), chs = shown()
      if (!c || !chs.length || H <= RULER_H) return
      const [from, to] = visibleClipRange(c.clip, c.cs)
      const limits = chs.flatMap(ch => c.def.joints.filter(j => j.name === ch))
      const v = fitView(chs.map(ch => c.shown.channels[ch] ?? { keys: [] }), limits, from, Math.max(from + 1, to), H - RULER_H)
      vs = { y0: v.y0 + RULER_H, pxPerUnit: v.pxPerUnit }
      fitted = true
    }

    const draw = () => {
      raf = 0
      const st = ed.getState(), e0 = editingItem(st)
      if (e0 && followStep({ frame: st.frame, playF: st.frame - (e0.item.start - e0.item.trimIn), playing: st.playing, visibleF: (W - LABEL_W) / tv.ppf, contentEnd: e0.clip.length })) schedule()
      const dpr = window.devicePixelRatio || 1, ctx = canvas.getContext('2d')!
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.fillStyle = C.bg; ctx.fillRect(0, 0, W, H)
      ctx.font = '11px "IBM Plex Sans KR", sans-serif'; ctx.textBaseline = 'middle'
      const c = ctxOf(), chs = shown(), sc = scale()
      if (!c || !chs.length) {
        ctx.fillStyle = C.text; ctx.fillText('트랙 보기에서 채널을 고르세요.', 12, RULER_H + 16)
      } else {
        if (!fitted) fit()
        const { s, clip, def, cs, piece, src } = c
        const [from, to] = visibleClipRange(clip, cs)
        ctx.save(); ctx.beginPath(); ctx.rect(LABEL_W, RULER_H, W - LABEL_W, H - RULER_H); ctx.clip()
        // value grid
        const range = (H - RULER_H) / vs.pxPerUnit, raw = range / 5, mag = 10 ** Math.floor(Math.log10(raw))
        const step = [1, 2, 5, 10].map(m => m * mag).find(m => m >= raw)!
        const vTop = yToValue(vs, RULER_H), vBot = yToValue(vs, H)
        ctx.textAlign = 'right'
        for (let v = Math.ceil(vBot / step) * step; v <= vTop; v += step) {
          const y = Math.round(valueToY(vs, v)) + 0.5, zero = Math.abs(v) < step / 2
          ctx.fillStyle = zero ? C.text : C.line; ctx.globalAlpha = zero ? 0.5 : 1
          ctx.fillRect(LABEL_W, y, W - LABEL_W, 1); ctx.globalAlpha = 1
          ctx.fillStyle = C.text; ctx.fillText(String(+v.toFixed(4)), W - 4, y - 6)
        }
        ctx.textAlign = 'left'
        chs.forEach((ch, i) => {
          const color = PALETTE[i], curve = curveOf(src, piece ? [] : def.joints, ch), joint = def.joints.find(j => j.name === ch)
          const fb = ch === 'root.z' ? def.standingHeight : 0, baseC = clip.channels[ch] ?? { keys: [] }
          // the line: the edited curve, or (수정 층) clip + deltas sampled per frame over the visible range
          const line: Curve = !piece ? curve : { keys: Array.from({ length: Math.max(0, to - from + 1) }, (_, k) => ({ f: from + k, v: evalCurve(baseC, from + k, fb) + evalCurve(curve, from + k, 0), interp: 'linear' as const, inTan: { df: 0, dv: 0 }, outTan: { df: 0, dv: 0 } })) }
          if (!piece && !curve.keys.length) { // fallback value line, dimmed
            const y = valueToY(vs, ch === 'root.z' ? def.standingHeight : 0)
            ctx.globalAlpha = 0.35; ctx.strokeStyle = color; ctx.lineWidth = 1
            ctx.beginPath(); ctx.moveTo(LABEL_W, y); ctx.lineTo(W, y); ctx.stroke(); ctx.globalAlpha = 1
            return
          }
          if (joint) { // URDF limits
            ctx.strokeStyle = color; ctx.globalAlpha = 0.5; ctx.lineWidth = 1; ctx.setLineDash([4, 4])
            for (const v of [joint.lower, joint.upper]) {
              const y = Math.round(valueToY(vs, v)) + 0.5
              ctx.beginPath(); ctx.moveTo(LABEL_W, y); ctx.lineTo(W, y); ctx.stroke()
            }
            ctx.setLineDash([]); ctx.globalAlpha = 1
          }
          const stepF = Math.max(1, Math.ceil(1 / tv.ppf))
          let polyC: Curve = baseC // what poly() draws
          const poly = (a: number, b: number) => {
            ctx.beginPath()
            for (let f = a; f < b; f += stepF) {
              const x = frameToX(cs, f), y = valueToY(vs, evalCurve(polyC, f, 0))
              if (f === a) ctx.moveTo(x, y); else ctx.lineTo(x, y)
            }
            ctx.lineTo(frameToX(cs, b), valueToY(vs, evalCurve(polyC, b, 0)))
            ctx.stroke()
          }
          if (piece) { // the clip, dimmed
            polyC = { keys: line.keys.map(k => ({ ...k, v: evalCurve(baseC, k.f, fb) })) }
            ctx.strokeStyle = color; ctx.globalAlpha = 0.3; ctx.lineWidth = 1; poly(from, to); ctx.globalAlpha = 1
          }
          polyC = line
          ctx.strokeStyle = color; ctx.lineWidth = 1.5; poly(from, to)
          if (joint) {
            ctx.strokeStyle = RED; ctx.lineWidth = 3
            for (const r of velocityViolations(line, joint.velocity, from, to)) poly(r.from, r.to)
          }
          // keys + handles of selected keys
          for (const k0 of curve.keys) {
            const k = piece ? { ...k0, v: k0.v + shift(c, ch, k0.f) } : k0
            const x = frameToX(cs, k.f), y = valueToY(vs, k.v)
            if (x < LABEL_W - KEY || x > W + KEY) continue
            const dg = drag
            const isSel = dg ? dg.keys.some(d => d.channel === ch && d.f + dg.df === k.f) : s.sel.keys.some(q => sameKey(q, { channel: ch, f: k.f }))
            if (isSel && k.interp === 'bezier') {
              const h = handlePoints(k, cs, vs)
              ctx.strokeStyle = C.accent; ctx.lineWidth = 1; ctx.fillStyle = C.accent
              for (const p of [h.in, h.out]) {
                ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(p[0], p[1]); ctx.stroke()
                ctx.beginPath(); ctx.arc(p[0], p[1], HANDLE_R, 0, Math.PI * 2); ctx.fill()
              }
            }
            ctx.fillStyle = isSel ? C.accent : color
            if (piece && !isSel) { ctx.strokeStyle = C.piece; ctx.lineWidth = 1.5; ctx.strokeRect(x - KEY / 2 - 1.5, y - KEY / 2 - 1.5, KEY + 3, KEY + 3) } // 수정 층 key
            ctx.fillRect(x - KEY / 2, y - KEY / 2, KEY, KEY)
          }
        })
        ctx.restore()
        // legend
        ctx.fillStyle = C.bg; ctx.fillRect(0, RULER_H, LABEL_W, H - RULER_H)
        chs.forEach((ch, i) => {
          ctx.fillStyle = PALETTE[i]; ctx.fillRect(8, RULER_H + 12 + i * 18 - 4, 8, 8)
          ctx.fillStyle = C.text; ctx.fillText(ch.replace(/_joint$/, ''), 22, RULER_H + 12 + i * 18, LABEL_W - 28)
        })
      }
      const e = editingItem(ed.getState())
      if (e) { // only the piece's frames (and its lead-in / 끝 기본자세): the rest of the clip blank
        drawPieceBounds(ctx, sc, e.item, RULER_H, H, LABEL_W, W, C)
      }
      const sel = e?.actorId ?? ed.getState().sel.actorId, cf = (sel && editTarget(ed.getState(), sel)?.f) || 0
      drawRuler(ctx, sc, W, RULER_H, NO_SEQ, cf, C, true, ed.getState().playheadPinned)
      { const r = ed.getState().range; if (r) drawRangeBand(ctx, sc, r, 0, H, LABEL_W, W, C.accent) }
      const px = Math.round(frameToX(sc, cf)) + 0.5
      if (px >= LABEL_W) { ctx.fillStyle = C.accent; ctx.fillRect(px - 0.5, 0, 1, H) }
      ctx.fillStyle = C.line; ctx.fillRect(LABEL_W - 1, 0, 1, H)
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
    const unsub = ed.subscribe(schedule)
    document.fonts?.addEventListener('loadingdone', schedule) // labels drawn in the fallback font before IBM Plex arrived

    // ---- mouse ----
    const pos = (e: MouseEvent) => { const r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top } }
    const track = trackDrag
    const seqFrame = (x: number) => {
      const e = editingItem(ed.getState())
      return e ? e.item.start - e.item.trimIn + Math.min(Math.max(Math.round((x - scale().x0) / tv.ppf), 0), e.clip.length - 1) : 0
    }

    const onDown = (e: MouseEvent) => {
      if (e.button !== 0) return
      canvas.focus()
      const { x, y } = pos(e), c = ctxOf(), st = ed.getState()
      if (y < RULER_H && startRangeDrag(e, x, scale, m => pos(m).x, track)) return // Shift+drag on the ruler: 구간
      if (y < RULER_H) { st.setFrame(seqFrame(x)); track(m => { const mx = pos(m).x; st.setFrame(seqFrame(mx)); edgeDrag = true; edge.at(mx) }, () => { edgeDrag = false; edge.stop() }); return }
      if (!c || x < LABEL_W) return
      const { def, cs, clipId, piece, src } = c, chs = shown(), frozen = clipLocked(st.project, clipId), clip = { ...src } // locked: select only (Timeline shows the message)
      const near = (px: number, py: number) => Math.abs(px - x) <= 6 && Math.abs(py - y) <= 6

      // handle of a selected bezier key
      for (const ref of st.sel.keys) {
        const k0: Key | undefined = clip.channels[ref.channel]?.keys.find(q => q.f === ref.f)
        if (frozen || !k0 || k0.interp !== 'bezier' || !chs.includes(ref.channel)) continue
        const k = { ...k0, v: k0.v + shift(c, ref.channel, k0.f) }
        const h = handlePoints(k, cs, vs)
        const side = near(h.out[0], h.out[1]) ? 'out' : near(h.in[0], h.in[1]) ? 'in' : null
        if (!side) continue
        st.beginGesture()
        track(m => {
          const p = pos(m), df = (p.x - cs.x0) / tv.ppf - k.f, dv = yToValue(vs, p.y) - k.v
          ed.getState().setTangent(clipId, ref.channel, k.f, side, { df: side === 'out' ? Math.max(0, df) : Math.min(0, df), dv }, !m.altKey)
        }, () => ed.getState().endGesture(), () => ed.getState().cancelGesture())
        return
      }
      // key
      let hit: { ref: KeyRef; d: number } | null = null
      for (const ch of chs) for (const k of curveOf(clip, piece ? [] : def.joints, ch).keys) {
        const dx = Math.abs(frameToX(cs, k.f) - x), dy = Math.abs(valueToY(vs, k.v + shift(c, ch, k.f)) - y)
        if (dx <= KEY && dy <= KEY && (!hit || dx + dy < hit.d)) hit = { ref: { channel: ch, f: k.f }, d: dx + dy }
      }
      if (!hit) { st.setFrame(seqFrame(x)); return }
      const ref = (hit as { ref: KeyRef }).ref
      const isSel = st.sel.keys.some(q => sameKey(q, ref))
      if (e.shiftKey) st.selectKeys(isSel ? st.sel.keys.filter(q => !sameKey(q, ref)) : [ref], !isSel)
      else if (!isSel) st.selectKeys([ref], false)
      const keys = ed.getState().sel.keys
      if (!keys.length || frozen) return
      const orig = new Map(keys.map(k => [k.channel + '@' + k.f, clip.channels[k.channel].keys.find(q => q.f === k.f)!.v]))
      const delta = (m: MouseEvent) => {
        const p = pos(m)
        return { df: clampDf(clip.length, keys, (p.x - x) / tv.ppf), dv: (y - p.y) / vs.pxPerUnit }
      }
      track(m => { drag = { keys, ...delta(m) }; schedule() }, m => {
        const { df, dv } = delta(m), s2 = ed.getState()
        drag = null
        if (df !== 0 || dv !== 0) {
          s2.beginGesture()
          if (dv !== 0) for (const k of keys) s2.setKey(clipId, k.channel, k.f, orig.get(k.channel + '@' + k.f)! + dv)
          if (df !== 0) s2.moveKeys(clipId, keys, df)
          s2.endGesture()
        }
        schedule()
      }, () => { drag = null; schedule() })
    }

    const hover = hoverScrub(() => ed.getState().frame, f => { markHover(); ed.getState().setFrame(f) })
    let edgeDrag = false // past 90% / before 10% of the plot while the playhead follows the pointer: scroll
    const edge = edgeScroll(() => [LABEL_W, W], () => { const e = editingItem(ed.getState()); return [minScrollF(), (e?.item.trimOut ?? 0) - (W - LABEL_W) / tv.ppf * 0.5] },
      x => { if (edgeDrag) ed.getState().setFrame(seqFrame(x)); else hover.push(seqFrame(x)); schedule() })
    const onMove = (e: MouseEvent) => {
      const x = pos(e).x
      const f = hoverFrame(x, LABEL_W, scale(), e.buttons !== 0 || hoverOff())
      if (f !== null) { hover.push(seqFrame(x)); edge.at(x) } else if (!edgeDrag) edge.stop()
    }
    const onLeave = () => { if (!edgeDrag) edge.stop() }

    const hoverOff = () => { const s = ed.getState(); return s.playing || s.playheadPinned || !editingItem(s) }
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      markUserScroll()
      if (e.ctrlKey) {
        const { x } = pos(e), fAt = tv.scrollF + (x - LABEL_W) / tv.ppf
        tv.ppf = Math.min(Math.max(tv.ppf * (e.deltaY < 0 ? 1.15 : 1 / 1.15), 0.5), 40)
        tv.scrollF = Math.max(minScrollF(), fAt - (x - LABEL_W) / tv.ppf)
      } else if (e.shiftKey) vs = { ...vs, y0: vs.y0 - (e.deltaY || e.deltaX) } // pan values
      else { // 휠 = 구간 이동 (user, like the sequence): up = later; the playhead keeps following the pointer unless 고정
        tv.scrollF = Math.max(minScrollF(), tv.scrollF + wheelFrames(e, tv.ppf))
        if (hoverFrame(pos(e).x, LABEL_W, scale(), hoverOff()) !== null) hover.push(seqFrame(pos(e).x))
      }
      schedule()
    }

    const onKey = (e: KeyboardEvent) => {
      const t = e.target
      if (onHandleArrow(e)) return
      if (t instanceof Element && t.closest('#project')) return
      if (t instanceof HTMLElement && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName))) return
      if (e.key.toLowerCase() === 'f' && !e.ctrlKey && !e.metaKey && !e.altKey) { fit(); schedule() }
    }

    canvas.addEventListener('mousedown', onDown)
    canvas.addEventListener('mousemove', onMove)
    canvas.addEventListener('mouseleave', onLeave)
    canvas.addEventListener('wheel', onWheel, { passive: false })
    window.addEventListener('keydown', onKey)
    return () => {
      ro.disconnect(); document.fonts?.removeEventListener('loadingdone', schedule); unsub(); cancelAnimationFrame(raf); hover.stop(); edge.stop()
      canvas.removeEventListener('mousedown', onDown)
      canvas.removeEventListener('mousemove', onMove)
      canvas.removeEventListener('mouseleave', onLeave)
      canvas.removeEventListener('wheel', onWheel)
      window.removeEventListener('keydown', onKey)
    }
  }, [])

  return <canvas ref={cv} tabIndex={0} className="track-canvas" />
}
