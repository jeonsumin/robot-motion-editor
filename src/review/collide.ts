// 검수 목록 자가충돌 (수정변동사항.md §14 · §15): how far two body parts of a G1 go into each other, per frame. Each part is a few links
// and each link is the convex hull of its own mesh, so the check follows the robot's real shape (§14 used capsules: too fat at the
// torso, too thin at the hands). A hull is a little fatter than its mesh only where the mesh is hollow (≈ 3 mm at the G1 arm / torso,
// measured against the meshes): under the 5 mm 기준. Root position / rotation do not matter (the robot against itself): joint angles only.
//
// Depth of two convex shapes A, B: min over directions d of hA(d) + hB(−d) (h = support function, the farthest the shape reaches along
// d). > 0 = the overlap depth (the shortest push that separates them), < 0 = minus the gap. Any single d gives an upper bound, so a
// direction found that puts them under the 기준 settles it early; otherwise the minimum is searched (coarse directions, then refined).
import { Vector3 } from 'three'
import { ConvexHull } from 'three/examples/jsm/math/ConvexHull.js'
import type { Pose } from '../model/pose'
import type { RobotDef, Vec3 } from '../robot/types'

type R3 = number[] // 3x3 row-major
type Frame = { p: Vec3; R: R3 }
const mulR = (a: R3, b: R3): R3 => [0, 1, 2].flatMap(i => [0, 1, 2].map(j => a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j]))
const mulV = (a: R3, v: Vec3): Vec3 => [a[0] * v[0] + a[1] * v[1] + a[2] * v[2], a[3] * v[0] + a[4] * v[1] + a[5] * v[2], a[6] * v[0] + a[7] * v[1] + a[8] * v[2]]
const mulTV = (a: R3, v: Vec3): Vec3 => [a[0] * v[0] + a[3] * v[1] + a[6] * v[2], a[1] * v[0] + a[4] * v[1] + a[7] * v[2], a[2] * v[0] + a[5] * v[1] + a[8] * v[2]]
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const norm = (v: Vec3): Vec3 => { const n = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / n, v[1] / n, v[2] / n] }
function rpy([r, p, y]: Vec3): R3 { // URDF fixed-axis roll-pitch-yaw = Rz(y) Ry(p) Rx(r)
  const cr = Math.cos(r), sr = Math.sin(r), cp = Math.cos(p), sp = Math.sin(p), cy = Math.cos(y), sy = Math.sin(y)
  return [cy * cp, cy * sp * sr - sy * cr, cy * sp * cr + sy * sr, sy * cp, sy * sp * sr + cy * cr, sy * sp * cr - cy * sr, -sp, cp * sr, cp * cr]
}
function axis([x0, y0, z0]: Vec3, t: number): R3 {
  const n = Math.hypot(x0, y0, z0) || 1, x = x0 / n, y = y0 / n, z = z0 / n, c = Math.cos(t), s = Math.sin(t), C = 1 - c
  return [c + x * x * C, x * y * C - z * s, x * z * C + y * s, y * x * C + z * s, c + y * y * C, y * z * C - x * s, z * x * C - y * s, z * y * C + x * s, c + z * z * C]
}

// the parts and their links. The shoulder pitch link sits on the torso (always touching it): not part of the upper arm.
const PARTS: Record<string, string[]> = { torso: ['torso_link'] }
for (const [s, S] of [['left', 'L'], ['right', 'R']] as const) {
  PARTS[`${S}_upper`] = [`${s}_shoulder_roll_link`, `${s}_shoulder_yaw_link`]
  PARTS[`${S}_fore`] = [`${s}_elbow_link`, `${s}_wrist_roll_link`]
  PARTS[`${S}_hand`] = [`${s}_wrist_pitch_link`, `${s}_wrist_yaw_link`, `${s}_rubber_hand`]
}
// checked pairs: forearm / hand into the torso (the upper arm hangs from it: always touching), and every left × right part.
// 손 × 손 is its own kind (손 맞닿음): often meant (a clap).
export const BODY_PAIRS: [string, string][] = [['L_fore', 'torso'], ['L_hand', 'torso'], ['R_fore', 'torso'], ['R_hand', 'torso'],
  ...(['upper', 'fore', 'hand'] as const).flatMap(a => (['upper', 'fore', 'hand'] as const).filter(b => !(a === 'hand' && b === 'hand')).map(b => [`L_${a}`, `R_${b}`] as [string, string]))]
export const HAND_PAIR: [string, string] = ['L_hand', 'R_hand']
const KO: Record<string, string> = { torso: '몸통', L_upper: '왼위팔', L_fore: '왼아래팔', L_hand: '왼손', R_upper: '오른위팔', R_fore: '오른아래팔', R_hand: '오른손' }
export const pairName = ([a, b]: [string, string]) => `${KO[a]}×${KO[b]}`

// ---- shapes: a link's hull points (link frame), its bounding sphere, and a cube map of directions → farthest point (fast support) ----
const N = 32 // cube map cells per face side (≈ 2.8°): the support it gives is off by well under 0.1 mm
type Shape = { pts: Float64Array; c: Vec3; r: number; map: Int32Array } // map: cell → index in pts of its farthest point (−1 = not yet)
const cell = (d: Vec3): [number, number, number] => { // face 0..5, i, j
  const ax = Math.abs(d[0]), ay = Math.abs(d[1]), az = Math.abs(d[2])
  let f: number, u: number, v: number, m: number
  if (ax >= ay && ax >= az) { f = d[0] > 0 ? 0 : 1; m = ax; u = d[1]; v = d[2] } else if (ay >= az) { f = d[1] > 0 ? 2 : 3; m = ay; u = d[0]; v = d[2] } else { f = d[2] > 0 ? 4 : 5; m = az; u = d[0]; v = d[1] }
  const k = (x: number) => Math.min(N - 1, Math.max(0, Math.floor((x / m + 1) / 2 * N)))
  return [f, k(u), k(v)]
}
const cellDir = (f: number, i: number, j: number): Vec3 => {
  const u = (i + 0.5) / N * 2 - 1, v = (j + 0.5) / N * 2 - 1, s = f % 2 === 0 ? 1 : -1
  return norm(f < 2 ? [s, u, v] : f < 4 ? [u, s, v] : [u, v, s])
}
function farthest(pts: Float64Array, d: Vec3): number {
  let best = 0, bv = -Infinity
  for (let k = 0; k < pts.length; k += 3) { const v = pts[k] * d[0] + pts[k + 1] * d[1] + pts[k + 2] * d[2]; if (v > bv) { bv = v; best = k } }
  return best
}
function shapeOf(def: RobotDef, link: string): Shape | null {
  const l = def.links[link], m = l?.mesh ? def.meshes[l.mesh] : null
  if (!l || !m || m.positions.length < 12) return null
  const Ro = rpy(l.rpy), P = m.positions, pts: Vector3[] = []
  for (let k = 0; k < P.length; k += 3) { const v = add(mulV(Ro, [P[k], P[k + 1], P[k + 2]]), l.xyz); pts.push(new Vector3(v[0], v[1], v[2])) }
  const seen = new Set<Vector3>()
  for (const f of new ConvexHull().setFromPoints(pts).faces) { let e = f.edge; do { seen.add(e.head().point); e = e.next } while (e !== f.edge) }
  const hull = seen.size >= 4 ? [...seen] : pts
  const out = new Float64Array(hull.length * 3)
  hull.forEach((v, i) => { out[i * 3] = v.x; out[i * 3 + 1] = v.y; out[i * 3 + 2] = v.z })
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity]
  for (let k = 0; k < out.length; k++) { lo[k % 3] = Math.min(lo[k % 3], out[k]); hi[k % 3] = Math.max(hi[k % 3], out[k]) }
  const c: Vec3 = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2]
  let r = 0
  for (let k = 0; k < out.length; k += 3) r = Math.max(r, Math.hypot(out[k] - c[0], out[k + 1] - c[1], out[k + 2] - c[2]))
  return { pts: out, c, r, map: new Int32Array(6 * N * N).fill(-1) } // cells filled when first asked (most never are)
}
/** Support of a shape along local direction d: the best of the points stored for d's cell and its 8 neighbours. */
function support(s: Shape, d: Vec3): number {
  const [f, i, j] = cell(d), P = s.pts
  let bv = -Infinity
  for (let a = Math.max(0, i - 1); a <= Math.min(N - 1, i + 1); a++) for (let b = Math.max(0, j - 1); b <= Math.min(N - 1, j + 1); b++) {
    const c = (f * N + a) * N + b
    if (s.map[c] < 0) s.map[c] = farthest(P, cellDir(f, a, b))
    const k = s.map[c], v = P[k] * d[0] + P[k + 1] * d[1] + P[k + 2] * d[2]
    if (v > bv) bv = v
  }
  return bv
}

// ---- the robot: link frames and shapes, built once per robot ----
type Step = { parent: string; child: string; xyz: Vec3; Ro: R3; axis: Vec3; qi: number }
type Plan = { steps: Step[]; shapes: Record<string, Shape> }
const plans = new WeakMap<RobotDef, Plan | null>()
function planOf(def: RobotDef): Plan | null {
  if (plans.has(def)) return plans.get(def)!
  const byChild = new Map<string, { parent: string; child: string; xyz: Vec3; rpy: Vec3; axis: Vec3; name: string }>()
  for (const j of [...def.joints, ...def.fixedJoints]) byChild.set(j.child, j)
  const qi = new Map(def.joints.map((j, i) => [j.name, i])), seen = new Set<string>(), steps: Step[] = []
  const visit = (link: string) => { // parents first
    const j = byChild.get(link)
    if (!j || seen.has(link)) return
    visit(j.parent); seen.add(link)
    steps.push({ parent: j.parent, child: link, xyz: j.xyz, Ro: rpy(j.rpy), axis: j.axis, qi: qi.get(j.name) ?? -1 })
  }
  const shapes: Record<string, Shape> = {}
  let ok = true
  for (const l of Object.values(PARTS).flat()) { visit(l); const s = shapeOf(def, l); if (s) shapes[l] = s; else ok = false }
  const plan = ok ? { steps, shapes } : null // a G1 without one of these meshes: not checked
  plans.set(def, plan)
  return plan
}
function linkFrames(def: RobotDef, plan: Plan, q: ArrayLike<number>): Record<string, Frame> {
  const out: Record<string, Frame> = { [def.rootLink]: { p: [0, 0, 0], R: [1, 0, 0, 0, 1, 0, 0, 0, 1] } }
  for (const st of plan.steps) {
    const par = out[st.parent]
    let R = mulR(par.R, st.Ro)
    if (st.qi >= 0) R = mulR(R, axis(st.axis, q[st.qi]))
    out[st.child] = { p: add(par.p, mulV(par.R, st.xyz)), R }
  }
  return out
}

// ---- depth of two placed shapes ----
type Placed = { s: Shape; f: Frame }
const h = (x: Placed, d: Vec3) => dot(x.f.p, d) + support(x.s, mulTV(x.f.R, d))
const hD = (a: Placed, b: Placed, d: Vec3) => h(a, d) + h(b, [-d[0], -d[1], -d[2]])
const FIB: Vec3[] = Array.from({ length: 256 }, (_, i) => { // directions spread evenly over the sphere
  const z = 1 - (2 * i + 1) / 256, r = Math.sqrt(1 - z * z), t = i * Math.PI * (3 - Math.sqrt(5))
  return [r * Math.cos(t), r * Math.sin(t), z] as Vec3
})
const tangents = (d: Vec3): [Vec3, Vec3] => {
  const t1 = norm(Math.abs(d[0]) < 0.9 ? [0, -d[2], d[1]] : [-d[2], 0, d[0]])
  return [t1, [d[1] * t1[2] - d[2] * t1[1], d[2] * t1[0] - d[0] * t1[2], d[0] * t1[1] - d[1] * t1[0]]]
}
/** Lower hD around d: step along 8 directions on the sphere, halve the step when none is lower. Stops at `floor` (settled). */
function refine(a: Placed, b: Placed, d: Vec3, v: number, step: number, floor: number): number {
  for (let it = 0; it < 400 && step > 1e-4 && v > floor; it++) {
    const [t1, t2] = tangents(d)
    let bd = d, bv = v
    for (const [x, y] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      const e = norm([d[0] + step * (x * t1[0] + y * t2[0]), d[1] + step * (x * t1[1] + y * t2[1]), d[2] + step * (x * t1[2] + y * t2[2])])
      const w = hD(a, b, e)
      if (w < bv) { bv = w; bd = e }
    }
    if (bv < v) { v = bv; d = bd } else step /= 2
  }
  return v
}
/** Overlap depth in m of two placed shapes (> 0 = into each other, ≤ 0 = clear). Any value at or under `floor` may be returned for
 *  a depth at or under `floor` (an upper bound: enough to know it is under the 기준). */
function depth(a: Placed, b: Placed, floor: number): number {
  const ca = add(a.f.p, mulV(a.f.R, a.s.c)), cb = add(b.f.p, mulV(b.f.R, b.s.c))
  const between: Vec3 = [cb[0] - ca[0], cb[1] - ca[1], cb[2] - ca[2]], dist = Math.hypot(...between)
  if (dist - a.s.r - b.s.r > 0) return a.s.r + b.s.r - dist // the bounding spheres apart
  const d0 = dist > 1e-9 ? norm(between) : [1, 0, 0] as Vec3
  let best = refine(a, b, d0, hD(a, b, d0), 0.3, floor) // A → B: separates them when they are apart
  if (best <= floor) return best
  const coarse = FIB.map(d => ({ d, v: hD(a, b, d) })).sort((x, y) => x.v - y.v)
  if (coarse[0].v <= floor) return coarse[0].v
  for (const c of coarse.slice(0, 4)) best = Math.min(best, refine(a, b, c.d, c.v, 0.15, floor)) // a few starts: more than one local low
  return best
}

/** Overlap depth in mm (> 0 = into each other, ≤ 0 = clear) of each part pair (the deepest of its links), per pose, and for each the
 *  links that go deepest. Values at or under `floorMm` are only known to be there (searched no further). G1 only (null otherwise). */
export function pairDepths(poses: Pose[], def: RobotDef, pairs: [string, string][], floorMm = 0): number[][] | null {
  const plan = def.kind === 'g1' ? planOf(def) : null
  if (!plan) return null
  return poses.map(ps => {
    const fr = linkFrames(def, plan, ps.q)
    return pairs.map(([A, B]) => {
      let best = -Infinity
      for (const la of PARTS[A]) for (const lb of PARTS[B]) best = Math.max(best, depth({ s: plan.shapes[la], f: fr[la] }, { s: plan.shapes[lb], f: fr[lb] }, floorMm / 1000))
      return best * 1000
    })
  })
}

/** The links of these part pairs that overlap in this pose (the 3D view paints them). */
export function overlapLinks(pose: Pose, def: RobotDef, pairs: [string, string][]): string[] {
  const plan = def.kind === 'g1' ? planOf(def) : null
  if (!plan) return []
  const fr = linkFrames(def, plan, pose.q), out = new Set<string>()
  for (const [A, B] of pairs) for (const la of PARTS[A]) for (const lb of PARTS[B]) {
    if (depth({ s: plan.shapes[la], f: fr[la] }, { s: plan.shapes[lb], f: fr[lb] }, 0) > 0) { out.add(la); out.add(lb) }
  }
  return [...out]
}

// ---- 무대 이탈 (수정변동사항.md §18): how far the whole robot reaches over the floor, with the same link hulls (every link with a mesh) ----
const bodies = new WeakMap<RobotDef, Plan>()
function bodyOf(def: RobotDef): Plan {
  const hit = bodies.get(def)
  if (hit) return hit
  const byChild = new Map([...def.joints, ...def.fixedJoints].map(j => [j.child, j]))
  const qi = new Map(def.joints.map((j, i) => [j.name, i])), seen = new Set<string>(), steps: Step[] = [], shapes: Record<string, Shape> = {}
  const visit = (link: string) => { // parents first
    const j = byChild.get(link)
    if (!j || seen.has(link)) return
    visit(j.parent); seen.add(link)
    steps.push({ parent: j.parent, child: link, xyz: j.xyz, Ro: rpy(j.rpy), axis: j.axis, qi: qi.get(j.name) ?? -1 })
  }
  for (const l of Object.keys(def.links)) { const s = shapeOf(def, l); if (s) { shapes[l] = s; visit(l) } } // links without a mesh: nothing to reach with
  const plan = { steps, shapes }
  bodies.set(def, plan)
  return plan
}
const quatR = ([x, y, z, w]: number[]): R3 => [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w), 2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w),
  2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]
const AXES: Vec3[] = [[-1, 0, 0], [1, 0, 0], [0, -1, 0], [0, 1, 0]]
/** The robot's reach over the floor in this (world) pose: [min x, max x, min y, max y] in m of its link hulls (≈ the meshes). */
export function floorBox(pose: Pose, def: RobotDef): [number, number, number, number] {
  const plan = bodyOf(def), fr = linkFrames(def, plan, pose.q), R0 = quatR(pose.rootQuat), P0 = pose.rootPos
  const out = [Infinity, -Infinity, Infinity, -Infinity]
  for (const [l, s] of Object.entries(plan.shapes)) {
    const f = fr[l]
    if (!f) continue
    const R = mulR(R0, f.R), p = add(P0, mulV(R0, f.p))
    AXES.forEach((d, i) => { // reach along d: −min x, max x, −min y, max y
      const v = dot(p, d) + support(s, mulTV(R, d))
      if (i % 2) out[i] = Math.max(out[i], v); else out[i] = Math.min(out[i], -v)
    })
  }
  return out as [number, number, number, number]
}
