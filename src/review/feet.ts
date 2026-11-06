// 검수 목록 발 미끄러짐 · 마찰 부족 (수정변동사항.md §16): G1 and GO2 feet that slide over the floor while standing on it, and
// stretches where the motion asks the floor for more grip than it has. Pure: no store, no three.js. Only frames of the target are used.
//
//  - 발 미끄러짐: a foot is down when its lowest point is within FOOT.contact of the clip's floor (the median of the lowest foot per frame:
//    retargeted data sits a few mm under z = 0). Its contact point (the lowest point of the foot mesh, followed as the same point of the
//    foot into the next frame, so a foot rolling over its toe or a GO2 ball foot rolling does not count) moving FOOT.vMin…vMax over
//    the floor for FOOT.minFrames and at least FOOT.minTravel is one item (faster = stepping). 경고 when that foot carries its share of
//    the weight (centre of mass between the feet down), 주의 for a dragged foot and a G1 foot turning in place (제자리 회전).
//  - 마찰 부족: the ground force the centre-of-mass motion needs, horizontal over vertical (= the friction coefficient it needs), while a
//    foot is down. Over FRICTION.note for FRICTION.minFrames = 주의, over FRICTION.warn (the physics check's floor) = 경고.
import type { Pose } from '../model/evaluate'
import { legsOf } from '../model/legIk'
import { INERTIA } from '../robot/inertia'
import type { RobotDef, Vec3 } from '../robot/types'
import type { Suspect } from './detect'

export const FOOT = { contact: 0.012, vMin: 0.03, vMax: 0.3, minFrames: 8, minTravel: 0.02, pivotDeg: 15, pivotNet: 0.03, loadShare: 0.8 }
export const FRICTION = { note: 0.6, warn: 1.0, minFrames: 3, gap: 6, smooth: 5 }
const FPS = 60, G = 9.81, SAMPLE = 600 // contact candidates per foot

type R3 = number[] // 3x3 row-major
type Frame = { p: Vec3; R: R3 }
const mulR = (a: R3, b: R3): R3 => {
  const r = new Array<number>(9)
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) r[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j]
  return r
}
const mulV = (a: R3, v: ArrayLike<number>): Vec3 => [a[0] * v[0] + a[1] * v[1] + a[2] * v[2], a[3] * v[0] + a[4] * v[1] + a[5] * v[2], a[6] * v[0] + a[7] * v[1] + a[8] * v[2]]
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
function rpy([r, p, y]: Vec3): R3 { // URDF fixed-axis roll-pitch-yaw = Rz(y) Ry(p) Rx(r)
  const cr = Math.cos(r), sr = Math.sin(r), cp = Math.cos(p), sp = Math.sin(p), cy = Math.cos(y), sy = Math.sin(y)
  return [cy * cp, cy * sp * sr - sy * cr, cy * sp * cr + sy * sr, sy * cp, sy * sp * sr + cy * cr, sy * sp * cr - cy * sr, -sp, cp * sr, cp * cr]
}
function axis([x0, y0, z0]: Vec3, t: number): R3 {
  const n = Math.hypot(x0, y0, z0) || 1, x = x0 / n, y = y0 / n, z = z0 / n, c = Math.cos(t), s = Math.sin(t), C = 1 - c
  return [c + x * x * C, x * y * C - z * s, x * z * C + y * s, y * x * C + z * s, c + y * y * C, y * z * C - x * s, z * x * C - y * s, z * y * C + x * s, c + z * z * C]
}
const quatR = ([x, y, z, w]: number[]): R3 => [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w), 2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w), 2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]

// ---- the robot: every link's frame, feet contact candidates, masses; built once per robot ----
type Step = { parent: string; child: string; xyz: Vec3; Ro: R3; axis: Vec3; qi: number }
type Foot = { link: string; label: string; pts: number[][]; orient: boolean }
type Plan = { steps: Step[]; feet: Foot[]; mass: [string, number, Vec3][]; total: number }
const plans = new WeakMap<RobotDef, Plan | null>()
const FOOT_KO: Record<string, string> = { left: '왼발', right: '오른발', FL: '앞왼발', FR: '앞오른발', RL: '뒤왼발', RR: '뒤오른발' }
export const footLabel = (link: string) => FOOT_KO[link.split('_')[0]] ?? link

/** Lower half of a foot's mesh in its link frame (at most SAMPLE points): where it can touch the floor. */
function footPoints(def: RobotDef, link: string): number[][] {
  const l = def.links[link], m = l?.mesh ? def.meshes[l.mesh] : null
  if (!l || !m) return [[0, 0, 0]] // no mesh: the link origin
  const Ro = rpy(l.rpy), P = m.positions, all: number[][] = []
  for (let k = 0; k < P.length; k += 3) all.push(add(mulV(Ro, [P[k], P[k + 1], P[k + 2]]), l.xyz))
  const lo = Math.min(...all.map(v => v[2])), hi = Math.max(...all.map(v => v[2]))
  const low = all.filter(v => v[2] <= lo + 0.5 * (hi - lo)), step = Math.max(1, Math.ceil(low.length / SAMPLE))
  const pts = low.filter((_, i) => i % step === 0), min = low.reduce((a, b) => (b[2] < a[2] ? b : a))
  return pts.includes(min) ? pts : [...pts, min] // keep the lowest point itself
}

function planOf(def: RobotDef): Plan | null {
  if (plans.has(def)) return plans.get(def)!
  const legs = legsOf(def), inertia = INERTIA[def.kind]
  if (!legs.length || !inertia) { plans.set(def, null); return null }
  const qi = new Map(def.joints.map((j, i) => [j.name, i])), steps: Step[] = []
  const byParent = new Map<string, RobotDef['fixedJoints']>()
  for (const j of [...def.joints, ...def.fixedJoints]) byParent.set(j.parent, [...(byParent.get(j.parent) ?? []), j])
  const visit = (link: string) => { for (const j of byParent.get(link) ?? []) { steps.push({ parent: j.parent, child: j.child, xyz: j.xyz, Ro: rpy(j.rpy), axis: j.axis, qi: qi.get(j.name) ?? -1 }); visit(j.child) } }
  visit(def.rootLink)
  const known = new Set([def.rootLink, ...steps.map(s => s.child)])
  const mass = Object.entries(inertia).filter(([n]) => known.has(n)).map(([n, [m, x, y, z]]) => [n, m, [x, y, z]] as [string, number, Vec3])
  const plan = { steps, feet: legs.map(l => ({ link: l.foot, label: footLabel(l.foot), pts: footPoints(def, l.foot), orient: l.orient })), mass, total: mass.reduce((s, x) => s + x[1], 0) }
  plans.set(def, plan)
  return plan
}

function frames(def: RobotDef, plan: Plan, ps: Pose): Record<string, Frame> {
  const out: Record<string, Frame> = { [def.rootLink]: { p: [...ps.rootPos] as Vec3, R: quatR(ps.rootQuat) } }
  for (const st of plan.steps) {
    const par = out[st.parent]
    let R = mulR(par.R, st.Ro)
    if (st.qi >= 0) R = mulR(R, axis(st.axis, ps.q[st.qi]))
    out[st.child] = { p: add(par.p, mulV(par.R, st.xyz)), R }
  }
  return out
}

/** Whole-body centre of mass (world) of a pose; null for a robot without masses. */
export function centerOfMass(poses: Pose[], def: RobotDef): Vec3[] | null {
  const plan = planOf(def)
  if (!plan) return null
  return poses.map(ps => comOf(plan, frames(def, plan, ps)))
}
function comOf(plan: Plan, fr: Record<string, Frame>): Vec3 {
  const c: Vec3 = [0, 0, 0]
  for (const [n, m, cl] of plan.mass) { const w = add(fr[n].p, mulV(fr[n].R, cl)); c[0] += m * w[0]; c[1] += m * w[1]; c[2] += m * w[2] }
  return [c[0] / plan.total, c[1] / plan.total, c[2] / plan.total]
}

// ---- per-frame feet track ----
export interface FeetTrack {
  feet: { link: string; label: string; orient: boolean }[]
  low: number[][] // [foot][frame] lowest point height, m
  down: boolean[][] // [foot][frame] on the floor
  slide: number[][] // [foot][frame] speed of the contact point over the floor from this frame to the next, m/s (last frame 0)
  move: [number, number][][] // [foot][frame] that move over the floor, m (x, y) — 추천대로 고치기 (§17) undoes it
  at: Vec3[][] // [foot][frame] foot link origin (world)
  yaw: number[][] // [foot][frame] foot heading, rad
  com: Vec3[] // centre of mass per frame
  floor: number // m
}

/** Feet of `poses` (60 fps). `floor` = a floor height found before (a window of a longer motion); default: this motion's. */
export function feetTrack(poses: Pose[], def: RobotDef, floor?: number): FeetTrack | null {
  const plan = planOf(def), N = poses.length
  if (!plan || !N) return null
  const F = poses.map(ps => frames(def, plan, ps))
  const com = F.map(fr => comOf(plan, fr))
  const low: number[][] = [], idx: number[][] = []
  for (const ft of plan.feet) {
    const l: number[] = [], ix: number[] = []
    for (const fr of F) {
      const { p, R } = fr[ft.link]
      let best = Infinity, bi = 0
      ft.pts.forEach((v, i) => { const z = p[2] + R[6] * v[0] + R[7] * v[1] + R[8] * v[2]; if (z < best) { best = z; bi = i } })
      l.push(best); ix.push(bi)
    }
    low.push(l); idx.push(ix)
  }
  const fl = floor ?? (() => { const m = Array.from({ length: N }, (_, f) => Math.min(...low.map(l => l[f]))).sort((a, b) => a - b); return m[N >> 1] })()
  const world = (fr: Frame, v: number[]) => add(fr.p, mulV(fr.R, v))
  const move = plan.feet.map((ft, k) => F.map((fr, f): [number, number] => {
    if (f + 1 >= N) return [0, 0]
    const v = ft.pts[idx[k][f]], a = world(fr[ft.link], v), b = world(F[f + 1][ft.link], v) // the same point of the foot, one frame on
    return [b[0] - a[0], b[1] - a[1]]
  }))
  const slide = move.map(m => m.map(([x, y]) => Math.hypot(x, y) * FPS))
  return {
    feet: plan.feet.map(({ link, label, orient }) => ({ link, label, orient })), low,
    down: low.map(l => l.map(z => z < fl + FOOT.contact)), slide, move,
    at: plan.feet.map(ft => F.map(fr => fr[ft.link].p)), yaw: plan.feet.map(ft => F.map(fr => Math.atan2(fr[ft.link].R[3], fr[ft.link].R[0]))),
    com, floor: fl,
  }
}

/** Share of the weight on foot k at frame f: the feet down weighted by closeness to the centre of mass over the floor (1 = alone). */
function loadShare(t: FeetTrack, k: number, f: number): number {
  const down = t.feet.map((_, i) => i).filter(i => t.down[i][f])
  if (!down.includes(k)) return 0
  if (down.length === 1) return 1
  const c = t.com[f], w = down.map(i => 1 / Math.max(Math.hypot(t.at[i][f][0] - c[0], t.at[i][f][1] - c[1]), 1e-3))
  return w[down.indexOf(k)] / w.reduce((a, b) => a + b, 0)
}

const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a))
const base = { joints: [] as string[], speed: 0, ratio: 0, jump: 0, score: 0, atLimit: false }

/** 발 미끄러짐 items of a motion: 경고 first, then the longest slide. */
export function footSlips(t: FeetTrack): Suspect[] {
  const out: Suspect[] = [], N = t.com.length
  t.feet.forEach((ft, k) => {
    const on = (f: number) => t.down[k][f] && t.slide[k][f] >= FOOT.vMin && t.slide[k][f] <= FOOT.vMax
    for (let f = 0; f < N;) {
      if (!on(f)) { f++; continue }
      const a = f
      while (f < N && on(f)) f++
      const b = f - 1
      if (b - a + 1 < FOOT.minFrames) continue
      let travel = 0, worst = a, load = 0, rel = 0
      for (let i = a; i <= b; i++) {
        travel += t.slide[k][i] / FPS
        if (t.slide[k][i] > t.slide[k][worst]) worst = i
        const s = loadShare(t, k, i), n = t.feet.filter((_, j) => t.down[j][i]).length
        load += s; rel += s * n
      }
      if (travel < FOOT.minTravel) continue
      load /= b - a + 1; rel /= b - a + 1
      const turn = Math.abs(wrap(t.yaw[k][b + 1 < N ? b + 1 : b] - t.yaw[k][a])) * 180 / Math.PI
      const net = Math.hypot(t.at[k][b][0] - t.at[k][a][0], t.at[k][b][1] - t.at[k][a][1])
      const pivot = ft.orient && turn > FOOT.pivotDeg && net < FOOT.pivotNet
      out.push({ ...base, kind: 'footSlip', from: a, to: b, worst, parts: [ft.label], speed: t.slide[k][worst], foot: ft.link, travel, load, turn, pivot,
        level: !pivot && rel >= FOOT.loadShare ? 'warn' : 'note', floor: t.floor })
    }
  })
  return out.sort((x, y) => (x.level === y.level ? y.travel! - x.travel! : x.level === 'warn' ? -1 : 1))
}

/** Friction a motion needs per frame (horizontal / vertical ground force from the centre of mass acceleration); 0 with no foot down
 *  or while falling freely. `com` smoothed over FRICTION.smooth frames first (60 fps capture noise). */
export function frictionNeed(t: FeetTrack): number[] {
  const N = t.com.length, h = FRICTION.smooth >> 1
  const sm = t.com.map((_, f) => { const a = Math.max(0, f - h), b = Math.min(N - 1, f + h), s: Vec3 = [0, 0, 0]; for (let i = a; i <= b; i++) for (let c = 0; c < 3; c++) s[c] += t.com[i][c]; return s.map(v => v / (b - a + 1)) as Vec3 })
  return sm.map((_, f) => {
    if (f < 1 || f >= N - 1 || !t.down.some(d => d[f])) return 0
    const acc = [0, 1, 2].map(c => (sm[f + 1][c] - 2 * sm[f][c] + sm[f - 1][c]) * FPS * FPS), up = acc[2] + G
    return up > 0.5 ? Math.hypot(acc[0], acc[1]) / up : 0
  })
}

/** 마찰 부족 items: frames over FRICTION.note joined across FRICTION.gap, kept with FRICTION.minFrames over it; 경고 with
 *  FRICTION.minFrames over FRICTION.warn. Most demanding first. */
export function frictionItems(t: FeetTrack): Suspect[] {
  const mu = frictionNeed(t), groups: number[][] = []
  mu.forEach((m, f) => { if (m <= FRICTION.note) return; const g = groups.at(-1); if (g && f - g.at(-1)! <= FRICTION.gap) g.push(f); else groups.push([f]) })
  return groups.filter(g => g.length >= FRICTION.minFrames).map(g => {
    const worst = g.reduce((a, b) => (mu[b] > mu[a] ? b : a))
    const level: 'warn' | 'note' = g.filter(f => mu[f] >= FRICTION.warn).length >= FRICTION.minFrames ? 'warn' : 'note'
    return { ...base, kind: 'friction' as const, from: g[0], to: g.at(-1)!, worst, parts: ['전신'], mu: mu[worst], level, floor: t.floor }
  }).sort((x, y) => (x.level === y.level ? y.mu! - x.mu! : x.level === 'warn' ? -1 : 1))
}

/** 구간 지표 of a 발 미끄러짐 item: the contact point's speed over the floor (cm/s) at each frame around it, 0 while the foot is up. */
export function slipSeries(poses: Pose[], def: RobotDef, s: Suspect, context: number): { from: number; values: number[] } {
  const from = Math.max(0, s.from - context), to = Math.min(poses.length - 1, s.to + context)
  const t = feetTrack(poses.slice(from, to + 2), def, s.floor), k = t ? t.feet.findIndex(f => f.link === s.foot) : -1
  return { from, values: Array.from({ length: to - from + 1 }, (_, i) => (t && k >= 0 && t.down[k][i] ? t.slide[k][i] * 100 : 0)) }
}

/** 구간 지표 of a 마찰 부족 item: the friction the motion needs at each frame around it. */
export function frictionSeries(poses: Pose[], def: RobotDef, s: Suspect, context: number): { from: number; values: number[] } {
  const from = Math.max(0, s.from - context), to = Math.min(poses.length - 1, s.to + context), pad = FRICTION.smooth + 1
  const a = Math.max(0, from - pad), t = feetTrack(poses.slice(a, Math.min(poses.length, to + pad + 1)), def, s.floor)
  const mu = t ? frictionNeed(t) : []
  return { from, values: Array.from({ length: to - from + 1 }, (_, i) => mu[from - a + i] ?? 0) }
}
