import { evalCurve, makeKey } from './curve'
import { split } from './restPose'
import type { Curve, Key } from './types'

// 구간 수정 (spec docs/superpowers/specs/2026-10-15-clip-edit-mode-design.md §3): one value change spread over a frame range,
// full inside [a, b], easing to nothing over `fade` frames on each side, so dense (per-frame) curves change smoothly.

export interface Range { a: number; b: number; fade: number }

const smooth = (t: number) => t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t)

/** Weight of frame f: 1 inside [a, b], smoothstep down to 0 over `fade` frames outside, 0 beyond. */
export function rangeWeight(r: Range, f: number): number {
  if (f >= r.a && f <= r.b) return 1
  if (r.fade <= 0) return 0
  const d = f < r.a ? r.a - f : f - r.b
  return 1 - smooth(d / (r.fade + 1))
}

/** `curve` with `d · w(f)` added on every frame of [a − fade, b + fade] (clipped to [0, length − 1]) as linear keys, the curve
 * outside that window unchanged (split exactly at its edges). `fallback` = the value of an empty curve; `clamp` bounds each
 * written value (a joint's URDF limits on an original clip; none for 수정 층 deltas). */
export function addOverRange(curve: Curve | undefined, fallback: number, r: Range, d: number, length: number,
  clamp: (v: number) => number = v => v): Curve {
  const lo = Math.max(0, r.a - r.fade), hi = Math.min(length - 1, r.b + r.fade)
  const ks: Key[] = curve?.keys.length ? curve.keys : [makeKey(0, fallback, 'linear')]
  const c = { keys: ks }
  const win: Key[] = []
  for (let f = lo; f <= hi; f++) win.push(makeKey(f, clamp(evalCurve(c, f, fallback) + d * rangeWeight(r, f)), 'linear'))
  const left = lo > 0 ? split(ks, lo - 1)[0] : []
  if (left.length) left[left.length - 1] = { ...left.at(-1)!, interp: 'linear' } // straight into the window
  const right = hi < length - 1 ? split(ks, hi + 1)[1] : []
  return { keys: [...left, ...win, ...right] }
}

/** `curve` with per-frame `deltas` added on frames from … from + deltas.length − 1 (clipped to [0, length − 1]) as linear keys, the
 *  curve outside unchanged (split exactly at the edges). 발 미끄러짐 추천대로 고치기 (§17): the leg joints' change, on a 수정 층. */
export function addFrameDeltas(curve: Curve | undefined, fallback: number, from: number, deltas: number[], length: number): Curve {
  const lo = Math.max(0, from), hi = Math.min(length - 1, from + deltas.length - 1)
  if (hi < lo) return curve ?? { keys: [] }
  const ks: Key[] = curve?.keys.length ? curve.keys : [makeKey(0, fallback, 'linear')]
  const c = { keys: ks }, win: Key[] = []
  for (let f = lo; f <= hi; f++) win.push(makeKey(f, evalCurve(c, f, fallback) + deltas[f - from], 'linear'))
  const left = lo > 0 ? split(ks, lo - 1)[0] : []
  if (left.length) left[left.length - 1] = { ...left.at(-1)!, interp: 'linear' }
  const right = hi < length - 1 ? split(ks, hi + 1)[1] : []
  return { keys: [...left, ...win, ...right] }
}
