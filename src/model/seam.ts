import { evalCurve, makeKey } from './curve'
import type { RobotDefs } from './pose'
import type { Clip, Curve, Item, Project } from './types'

// GO2 이음매 보정 (spec docs/superpowers/specs/2026-10-19-go2-seam-blend-design.md): where a GO2 piece starts right at the end of the
// one before it, its first N frames get the difference to that end (pose one frame on at its speed, and the speed) added, eased
// to 0 (inertialization). Library blocks then chain without a pop; no frames are added and the block CSVs stay as they are.

export const SEAM_DEFAULT = 20, SEAM_MAX = 180
const itemLen = (it: Item) => it.trimOut - it.trimIn // (not from ./sequence: it imports itemClip, which imports this)
const SEAM_ROOT = ['root.z', 'root.roll', 'root.pitch'] // x/y/yaw: the sequence's root stitching
const WARN = { q: 45 * Math.PI / 180, z: 0.05 } // a gap this big (sitting end → standing start) cannot look natural in a seam

export interface Seam { n: number; d0: Record<string, number>; v0: Record<string, number>; warn: boolean }

/** GO2 발 걸음 이음매 (§19, model/transition.ts) at the start of `it`: the piece's own switch, else the project's default (off). */
export const stepOn = (p: Project, it: Item) => it.step ?? p.stepSeam === true
const SAME = 1e-6 // rad / m: a boundary whose two frames are equal (Go2 editor blocks share their boundary frame)

export const seamLen = (it: Item) => Math.min(Math.max(Math.round(it.seam ?? SEAM_DEFAULT), 0), SEAM_MAX, itemLen(it))
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a))

/** The seam of GO2 piece `it` (playing `base`) with the piece that ends where it starts on its track; null when there is none.
 * `prevClip` gives the clip that piece plays (itemClip, with its own seam). */
export function seamOf(p: Project, defs: RobotDefs, it: Item, base: Clip, prevClip: (prev: Item) => Clip | undefined): Seam | null {
  if (base.robot !== 'go2') return null
  const track = p.sequence.tracks.find(t => t.kind === 'motion' && t.items.some(i => i.id === it.id))
  const prev = track?.items.find(i => i.id !== it.id && i.start + itemLen(i) === it.start)
  const n = seamLen(it), a = prev && prevClip(prev)
  if (!prev || !a || !n) return null
  const def = defs.go2, e = prev.trimOut - 1, t0 = it.trimIn
  const d0: Record<string, number> = {}, v0: Record<string, number> = {}
  let warn = false, same = true
  for (const ch of [...SEAM_ROOT, ...def.joints.map(j => j.name)]) {
    const fb = ch === 'root.z' ? def.standingHeight : 0, A = a.channels[ch] ?? { keys: [] }, B = base.channels[ch] ?? { keys: [] }
    const ae = evalCurve(A, e, fb), va = itemLen(prev) > 1 ? ae - evalCurve(A, e - 1, fb) : 0
    const b0 = evalCurve(B, t0, fb), vb = t0 + 1 < base.length ? evalCurve(B, t0 + 1, fb) - b0 : 0
    const ang = ch === 'root.roll' || ch === 'root.pitch'
    d0[ch] = ang ? wrap(ae + va - b0) : ae + va - b0 // B's first frame: A's last one frame on at its speed
    v0[ch] = va - vb
    if (Math.abs(ang ? wrap(ae - b0) : ae - b0) > SAME) same = false
    if (Math.abs(d0[ch]) > (ch === 'root.z' ? WARN.z : WARN.q)) warn = true
  }
  if (same && stepOn(p, it)) return null // 경계 프레임이 같음 (S7): already joined, the seam would only push it a frame off
  return { n, d0, v0, warn }
}

/** The seam as delta curves in clip frames (one key per frame over [trimIn, trimIn + n], 0 outside). */
export function seamOffset(it: Item, s: Seam): Record<string, Curve> {
  const out: Record<string, Curve> = {}
  for (const ch of Object.keys(s.d0)) {
    const keys = it.trimIn > 0 ? [makeKey(it.trimIn - 1, 0, 'linear')] : []
    for (let k = 0; k <= s.n; k++) {
      const u = k / s.n, h00 = 2 * u ** 3 - 3 * u * u + 1, h10 = u ** 3 - 2 * u * u + u // Hermite: value d0, slope v0 at 0; 0 and flat at n
      keys.push(makeKey(it.trimIn + k, s.d0[ch] * h00 + s.v0[ch] * s.n * h10, 'linear'))
    }
    out[ch] = { keys }
  }
  return out
}
