// 검수 목록 발 미끄러짐 추천대로 고치기 (수정변동사항.md §17): undo one 발 미끄러짐 item — the foot's contact point stays where it
// started sliding (the slide subtracted frame by frame; the foot keeps its own tilt and heading, so a heel lift or a turn in the
// choreography lives on), held until the foot leaves the floor (up for FIX.air frames or more: a shorter hop of a dragged foot is part
// of the drag) or starts moving fast (FOOT.vMax), then eased back over EASE_OUT frames
// in the air; eased in over EASE_IN frames before. The leg's joints are solved by IK (model/legIk.ts), pelvis and upper body untouched.
// Checked before it may be applied: the leg reaches, no joint jolt, the item is gone and nothing new is found, no deeper floor.
// When the full fix fails a check, a weaker one is tried (FIX.ks: the slide undone by 80 %, 60 %, 40 % — 붙잡는 세기, as the Go2 editor's
// pinStrength): it may leave part of the slide (the item stays listed) if that is at most FIX.restMax of it; 100 % is the fix as before.
// Validated on 12 G1 mocap clips (93 of 113 items fixable, leg joints changed by 4° median) — holding the whole foot pose of the first
// frame instead (G1 Motion Editor) bent the legs 32° median. Pure: no store.
import type { Pose } from '../model/pose'
import { footMat, legsOf, solveLeg, type Leg } from '../model/legIk'
import type { RobotDef } from '../robot/types'
import { detectSuspects, type Suspect } from './detect'
import { FOOT, feetTrack, type FeetTrack } from './feet'

export const FIX = { easeIn: 6, easeOut: 8, maxHold: 300, air: 5, reach: 0.005, jolt: 1.5, joltMin: 12, deeper: 0.005, ks: [1, 0.8, 0.6, 0.4], restMax: 0.8 }
const ss = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x))
const DEG = 180 / Math.PI

export interface FootFix {
  ok: boolean
  why: string[] // reasons it may not be applied (empty when ok)
  from: number; to: number // frames changed (target frames, inclusive)
  hold: [number, number] // frames the slide is undone in full (item start … the foot lifts)
  lift: number // the frame the foot lifts (or starts moving fast), -1 = not within FIX.maxHold
  qis: number[] // the leg's joint indices (def.joints)
  q: number[][] // per changed frame: the new values of qis
  reach: number // the leg's worst miss while held, m
  maxDeg: number // the biggest joint change, °
  drift: number // how far the foot slid by the time it lifts, m (k of it is undone)
  k: number // 붙잡는 세기: the share of the slide undone (1 = all; FIX.ks)
  rest: number // the slide left at the same place after the fix (its item's travel, m); 0 = none found (gone or under the detection limits)
  shift: number; shiftAt: number // the fixed foot vs the foot now: the biggest gap over the floor, m, and its frame (개선 가이드)
  soon: boolean // lifts within FIX.easeIn frames after the item: maybe a step
  poses?: Pose[] // the fixed motion (for the preview), when it was computed
  path: [number, number][] // the foot (link origin) over the floor from the item start to the lift, as it slides now (개선 가이드)
  floor: number // m
}

const rootM = (p: Pose) => {
  const [x, y, z, w] = p.rootQuat, P = p.rootPos
  return [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w), P[0], 2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w), P[1],
    2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y), P[2], 0, 0, 0, 1]
}
const fam = (k: Suspect['kind']) => (k === 'limit' || k === 'rel' || k === 'start' ? 'jump' : k)
const same = (a: Suspect, b: Suspect) => fam(a.kind) === fam(b.kind) && (a.foot ?? '') === (b.foot ?? '') && a.from <= b.to + 2 && b.from <= a.to + 2
const KO: Record<Suspect['kind'], string> = { limit: '로봇 한계 초과', rel: '파일 기준 급변', start: '첫 프레임 튐', collision: '자가충돌', handTouch: '손 맞닿음', footSlip: '발 미끄러짐', friction: '마찰 부족', stage: '무대 이탈' }

/** The links from the root down to `foot` (not the root): the leg the fix changes (the 3D view paints it). */
export function legLinks(def: RobotDef, foot: string): string[] {
  const parent = new Map([...def.joints, ...def.fixedJoints].map(j => [j.child, j.parent])), out: string[] = []
  for (let l: string | undefined = foot; l && l !== def.rootLink; l = parent.get(l)) out.unshift(l)
  return out
}

/** The fix of 발 미끄러짐 `item` in `poses` (as the target plays), with its checks. `found` = this motion's items (detectSuspects). */
export function planFootFix(poses: Pose[], def: RobotDef, item: Suspect, found: Suspect[], track?: FeetTrack): FootFix {
  const N = poses.length, t = track ?? feetTrack(poses, def), leg = legsOf(def).find(l => l.foot === item.foot)
  const k = t ? t.feet.findIndex(f => f.link === item.foot) : -1
  const none = (why: string): FootFix => ({ ok: false, why: [why], from: item.from, to: item.to, hold: [item.from, item.to], lift: -1, qis: leg?.qis ?? [], q: [], reach: 0, maxDeg: 0, drift: 0, k: 1, rest: 0, shift: 0, shiftAt: item.from, soon: false, path: [], floor: t?.floor ?? 0 })
  if (item.kind !== 'footSlip' || !t || !leg || k < 0) return none('발 미끄러짐 항목이 아닙니다')
  let lift = -1
  // the foot lifts: up for FIX.air frames or more (a shorter hop of a dragged foot is part of the drag: held on), or moving fast on the floor
  for (let f = item.to + 1; f < Math.min(N - 1, item.to + FIX.maxHold); f++) {
    if (t.down[k][f]) { if (t.slide[k][f] > FOOT.vMax) { lift = f; break } continue }
    let u = f
    while (u < N && !t.down[k][u]) u++
    if (u - f >= FIX.air || u >= N) { lift = f; break }
    f = u - 1
  }
  if (lift < 0) return none(`발을 떼는 순간이 ${FIX.maxHold / 60}초 안에 없음 — 어느 쪽으로 붙잡아도 다른 곳이 미끄러짐`)
  const full = fixWith(poses, def, item, found, t, leg, k, lift, 1)
  if (full.ok) return full
  for (const K of FIX.ks.slice(1)) { const w = fixWith(poses, def, item, found, t, leg, k, lift, K); if (w.ok) return w }
  return full // none works: the reasons of the full fix
}

/** The fix undoing `K` of the slide (1 = all), with its checks. */
function fixWith(poses: Pose[], def: RobotDef, item: Suspect, found: Suspect[], t: FeetTrack, leg: Leg, k: number, lift: number, K: number): FootFix {
  const N = poses.length, a = item.from, s = Math.max(0, a - FIX.easeIn), e = Math.min(N - 1, lift + FIX.easeOut)
  // the slide so far, undone: minus the contact point's moves from a up to the frame (kept from the lift on)
  const back: [number, number][] = poses.map(() => [0, 0])
  for (let f = a; f < lift; f++) back[f + 1] = [back[f][0] - K * t.move[k][f][0], back[f][1] - K * t.move[k][f][1]]
  for (let f = lift + 1; f <= e; f++) back[f] = back[lift]
  const out = poses.map(p => p), q: number[][] = []
  let warm = [...poses[s].q], reach = 0, maxDeg = 0, shift = 0, shiftAt = a
  for (let f = s; f <= e; f++) {
    const w = f < a ? ss((f - s + 1) / (a - s + 1)) : f <= lift ? 1 : 1 - ss((f - lift) / (e - lift + 1))
    const root = rootM(poses[f]), target = footMat(leg, root, poses[f].q)
    target[3] += back[f][0]; target[7] += back[f][1]
    const qq = [...poses[f].q]
    for (const i of leg.qis) qq[i] = warm[i] // go on from the frame before: no jump to another leg branch
    solveLeg(def, leg, root, target, qq, 80)
    if (w > 0.99) { const m = footMat(leg, root, qq); reach = Math.max(reach, Math.hypot(m[3] - target[3], m[7] - target[7], m[11] - target[11])) }
    const nq = [...poses[f].q]
    for (const i of leg.qis) { nq[i] = poses[f].q[i] + (qq[i] - poses[f].q[i]) * w; maxDeg = Math.max(maxDeg, Math.abs(nq[i] - poses[f].q[i]) * DEG) }
    out[f] = { ...poses[f], q: nq }
    const was = footMat(leg, root, poses[f].q), now = footMat(leg, root, nq), d = Math.hypot(now[3] - was[3], now[7] - was[7]) // the foot moved over the floor
    if (d > shift) { shift = d; shiftAt = f }
    q.push(leg.qis.map(i => nq[i]))
    warm = qq
  }
  const why: string[] = []
  if (reach > FIX.reach) why.push(`다리가 추천 위치에 닿지 않음 (${(reach * 1000).toFixed(0)}mm 모자람)`)
  const jolt = (P: Pose[]) => { let m = 0; for (let f = Math.max(1, s - 30); f <= Math.min(N - 2, e + 30); f++) for (const i of leg.qis) m = Math.max(m, Math.abs(P[f + 1].q[i] - 2 * P[f].q[i] + P[f - 1].q[i]) * DEG); return m }
  const jB = jolt(poses), jA = jolt(out)
  if (jA > Math.max(jB * FIX.jolt, FIX.joltMin)) why.push(`다리 관절이 튐 (${jB.toFixed(1)} → ${jA.toFixed(1)}°/프레임²)`)
  const t2 = feetTrack(out.slice(s, e + 1), def, t.floor)!, low = (L: number[]) => Math.min(...L)
  if (low(t2.low[k]) < low(t.low[k].slice(s, e + 1)) - FIX.deeper) why.push('발이 바닥을 더 파고듦')
  const after = detectSuspects(out, def)
  const left = after.find(x => same(x, item)), rest = left?.travel ?? 0
  if (left && (K === 1 || rest > FIX.restMax * (item.travel ?? 0))) why.push('고쳐도 같은 자리에 미끄러짐이 남음') // a weaker fix may leave a little
  const fresh = after.filter(x => !found.some(y => same(x, y)))
  if (fresh.length) why.push(`새 문제가 생김: ${fresh.slice(0, 3).map(x => `${KO[x.kind]}${x.foot ? `(${x.parts[0]})` : ''} f${x.from}`).join(', ')}${fresh.length > 3 ? ` 외 ${fresh.length - 3}` : ''}`)
  return { ok: !why.length, why, from: s, to: e, hold: [a, lift], lift, qis: leg.qis, q, reach, maxDeg, drift: Math.hypot(...back[lift]) / K, k: K, rest, shift, shiftAt, soon: lift - item.to < FIX.easeIn, poses: out,
    path: t.at[k].slice(a, lift + 1).map(p => [p[0], p[1]] as [number, number]), floor: t.floor }
}
