import type { Sequence } from '../model/types'
import { formatTimecode, frameToX, type TimeScale } from './timeScale'
import { DIM } from './physGraph'

export const LABEL_W = 160, RULER_H = 24
export interface Colors { bg: string; panel: string; line: string; text: string; accent: string }

// [minor, major] frame steps; major labels are >= `gap` px apart (60, or wider when the label carries the frame number too)
const STEPS: [number, number][] = [[1, 1], [1, 2], [1, 5], [5, 10], [5, 15], [10, 30], [10, 60], [30, 120], [60, 300], [60, 600], [300, 1800], [600, 3600]]
export function tickStep(ppf: number, gap = 60): { minor: number; major: number } {
  const [minor, major] = STEPS.find(([, M]) => M * ppf >= gap) ?? STEPS[STEPS.length - 1]
  return { minor, major }
}

// Index of the marker within 4px of x, or null.
export function hitMarker(seq: Sequence, sc: TimeScale, x: number): number | null {
  let best: number | null = null, bd = 4
  seq.markers.forEach((m, i) => { const d = Math.abs(frameToX(sc, m.f) - x); if (d <= bd) { bd = d; best = i } })
  return best
}

/** `frames`: (sequence and clip view) each label also shows its frame number, and the playhead carries a tag with the current frame. */
/** `pinned`: 재생헤드 고정 중 — the frame tag is drawn hollow (accent outline and text on the dark background). */
export function drawRuler(ctx: CanvasRenderingContext2D, sc: TimeScale, w: number, h: number, seq: Sequence, frame: number, C: Colors, frames = false, pinned = false): void {
  ctx.fillStyle = C.panel; ctx.fillRect(0, 0, w, h)
  ctx.fillStyle = C.line; ctx.fillRect(0, h - 1, w, 1)
  ctx.save(); ctx.beginPath(); ctx.rect(LABEL_W, 0, w - LABEL_W, h); ctx.clip()
  const { inF, outF } = seq
  if (inF !== null || outF !== null) {
    const a = inF === null ? LABEL_W : frameToX(sc, inF), b = outF === null ? w : frameToX(sc, outF)
    ctx.globalAlpha = 0.25; ctx.fillStyle = C.accent; ctx.fillRect(a, 0, b - a, h - 1); ctx.globalAlpha = 1
    ctx.fillStyle = C.accent
    if (inF !== null) ctx.fillRect(Math.round(a), 0, 1, h)
    if (outF !== null) ctx.fillRect(Math.round(b), 0, 1, h)
  }
  const { minor, major } = tickStep(sc.pxPerFrame, frames ? 92 : 60)
  const f0 = Math.max(0, Math.floor((LABEL_W - sc.x0) / sc.pxPerFrame / minor) * minor), f1 = (w - sc.x0) / sc.pxPerFrame
  ctx.font = '11px "IBM Plex Sans KR", sans-serif'; ctx.textBaseline = 'middle'; ctx.textAlign = 'left'
  for (let f = f0; f <= f1; f += minor) {
    const x = Math.round(frameToX(sc, f)) + 0.5, big = f % major === 0
    ctx.fillStyle = big ? C.text : C.line
    ctx.fillRect(x, big ? 10 : 16, 1, big ? 14 : 8)
    if (big) {
      const tc = formatTimecode(f)
      ctx.fillStyle = C.text; ctx.fillText(tc, x + 3, 6)
      if (frames) { const tw = ctx.measureText(tc).width; ctx.font = '10px "IBM Plex Sans KR", sans-serif'; ctx.fillStyle = DIM; ctx.fillText(String(f), x + 3 + tw + 5, 6); ctx.font = '11px "IBM Plex Sans KR", sans-serif' }
    }
  }
  ctx.fillStyle = C.text
  for (const m of seq.markers) {
    const x = frameToX(sc, m.f)
    ctx.beginPath(); ctx.moveTo(x - 4, h - 9); ctx.lineTo(x + 4, h - 9); ctx.lineTo(x, h - 2); ctx.fill()
  }
  const px = Math.round(frameToX(sc, frame)) + 0.5
  ctx.fillStyle = C.accent; ctx.fillRect(px - 0.5, 0, 1, h)
  if (frames && px >= LABEL_W - 20 && px <= w + 20) { // playhead frame tag, kept inside the ruler
    ctx.font = '500 10.5px "IBM Plex Sans KR", sans-serif'
    const t = String(frame), tw = Math.ceil(ctx.measureText(t).width) + 10, th = 14
    const tx = Math.min(Math.max(px - tw / 2, LABEL_W + 1), w - tw - 1)
    ctx.beginPath(); ctx.roundRect(tx + (pinned ? 0.5 : 0), h - th - 2 + (pinned ? 0.5 : 0), tw - (pinned ? 1 : 0), th - (pinned ? 1 : 0), 3)
    if (pinned) { ctx.fillStyle = C.bg; ctx.fill(); ctx.strokeStyle = C.accent; ctx.lineWidth = 1; ctx.stroke() } else { ctx.fillStyle = C.accent; ctx.fill() }
    ctx.fillStyle = pinned ? C.accent : C.bg; ctx.textAlign = 'center'; ctx.fillText(t, tx + tw / 2, h - 2 - th / 2 + 0.5); ctx.textAlign = 'left'
    ctx.font = '11px "IBM Plex Sans KR", sans-serif'
  }
  ctx.restore()
}
