// GO2 발 걸음 이음매 (블록 경계 개선 1단계, 수정변동사항.md §19, spec docs/superpowers/specs/2026-11-06-go2-step-seam-design.md).
// Where a GO2 piece B starts right at the end of piece A (the 이음매 보정 boundary), the seam blends the body but leaves the feet
// gliding over the floor. With 발 걸음 이음매 on, the legs around the boundary are solved again by IK so that every foot either
// stays where it stands or is lifted and set down at its new place — inside the frames where both pieces already stand still on
// four feet. Nothing moves in time (user: 노래 시간에 맞춘 안무 — 시간 유지), the root is untouched, the clips are never changed:
// the result is per-frame leg values that itemClip lays over the two pieces.
// A plan is kept only when it is as gentle as the real recordings (STEP limits); otherwise nothing changes and the boundary is
// reported (주황), and a boundary where the number of feet on the floor changes is only reported (빨강) — never forced.
import { evaluateClip, type Pose, type RobotDefs } from './pose'
import { quatYaw, yawQuat, quatMul } from './rootMath'
import { footMat, legsOf, solveLeg, type Leg } from './legIk'
import { feetTrack, centerOfMass } from '../review/feet'
import type { Clip, Item, Project } from './types'
import type { RobotDef } from '../robot/types'

export const STEP = {
  small: 0.03, // m: a foot that has to move less than this glides (no lift) — the 3 cm rule of the Go2 editor
  vel: 0.8, // × the motor velocity limit
  acc: { hip: 120, thigh: 170, calf: 300 } as Record<string, number>, // rad/s² (99th percentile of the real recordings)
  air: 12, // frames (0.2 s) a lifted foot stays up at least
  ik: 0.01, // m a foot may miss its planned place
  com: 0.01, // m the centre of mass stays inside three feet (one foot at a time)
  still: 0.002, // m per frame: a foot slower than this on the floor stands still
  look: 62, // frames looked at on either side of the boundary (at most half of each piece)
  ends: [20, 36, 48, 60], // step-window ends tried (frames after the boundary, cut at B's still frames)
  shift: 0.06, // m the body leans towards the three feet before one is lifted (one foot at a time)
}
const DIAG = [[1, 2], [0, 3]] // legsOf order FL, FR, RL, RR: FR+RL, FL+RR (the trot pairs)

export type StepWhy = { noTime?: true; miss?: number; vel?: number; acc?: number; air?: number; com?: number }
export type StepStatus =
  | { kind: 'ok'; groups: number; one: boolean; from: number; to: number; moved: number } // 초록: applied (frames relative to B's first)
  | { kind: 'same' } // 경계 프레임이 같음 (S7): no seam, nothing to do
  | { kind: 'fail'; why: StepWhy } // 주황: no plan within the limits — the seam stays as it was
  | { kind: 'lift' } // 빨강: the number of feet on the floor changes (뒷발 서기 등) — shown only
  | { kind: 'air' } // 빨강: no foot on the floor at the boundary — shown only
export interface StepResult {
  status: StepStatus
  a: Map<number, number[]> // A's clip frame → its joint values (def order, all joints; only the legs differ)
  b: Map<number, number[]> // B's clip frame → ...
}

type M = number[]
const poseMat = (p: Pose): M => {
  const [x, y, z, w] = p.rootQuat, P = p.rootPos
  return [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w), P[0], 2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w), P[1],
    2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y), P[2], 0, 0, 0, 1]
}
const at3 = (m: M) => [m[3], m[7], m[11]]
const tmat = (p: number[]): M => [1, 0, 0, p[0], 0, 1, 0, p[1], 0, 0, 1, p[2], 0, 0, 0, 1]
const q5 = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * x * (10 + x * (6 * x - 15))) // no speed or acceleration at either end
const lift = (d: number) => Math.min(0.05, Math.max(0.02, 0.3 * d))
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a))

function hullMargin(c: number[], pts: number[][]): number { // signed distance of c inside the convex hull of pts (xy); −1 under 3 points
  if (pts.length < 3) return -1
  const h = [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1]), cr = (o: number[], a: number[], b: number[]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
  const lo: number[][] = [], up: number[][] = []
  for (const p of h) { while (lo.length >= 2 && cr(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop(); lo.push(p) }
  for (const p of [...h].reverse()) { while (up.length >= 2 && cr(up[up.length - 2], up[up.length - 1], p) <= 0) up.pop(); up.push(p) }
  const hull = [...lo.slice(0, -1), ...up.slice(0, -1)]
  let m = Infinity
  for (let i = 0; i < hull.length; i++) { const a = hull[i], b = hull[(i + 1) % hull.length]; m = Math.min(m, cr(a, b, c) / Math.hypot(b[0] - a[0], b[1] - a[1])) }
  return m
}
function incenter([A, B, C]: number[][]) {
  const a = Math.hypot(B[0] - C[0], B[1] - C[1]), b = Math.hypot(A[0] - C[0], A[1] - C[1]), c = Math.hypot(A[0] - B[0], A[1] - B[1]), s = a + b + c
  return [(a * A[0] + b * B[0] + c * C[0]) / s, (a * A[1] + b * B[1] + c * C[1]) / s]
}
const place = (p: Pose, xf: { x: number; y: number; yaw: number }): Pose => {
  const c = Math.cos(xf.yaw), s = Math.sin(xf.yaw), [x, y, z] = p.rootPos
  return { rootPos: [c * x - s * y + xf.x, s * x + c * y + xf.y, z], rootQuat: quatMul(yawQuat(xf.yaw), p.rootQuat), q: p.q }
}

export interface StepInput {
  def: RobotDef
  a: Pose[] // A's last frames as it plays (seamed), A's clip coordinates; a[a.length - 1] = its last frame
  b: Pose[] // B's first frames as it plays (seamed), placed after A like the sequence stitches it
  raw: Pose[] // B's first frames without the seam (its own feet), placed the same way
  seam: number // B's 이음매 보정 frames
}

export type Plan = { status: StepStatus; poses: Map<number, Pose> }
/** The plan for one boundary (pure: poses in, per-frame poses out). Frame k: k < 0 = A's frame trimOut + k, k ≥ 0 = B's trimIn + k.
 * `one`: also try one foot at a time with the body leaning onto the other three first — it moves the root, so only a 전이 조각
 * (a piece of its own, 수동) uses it; on a boundary the root is never touched. */
export function planStep(inp: StepInput, opts: { one?: boolean; ends?: number[]; starts?: number[] } = {}): Plan {
  const { def, a, b, raw, seam } = inp, legs = legsOf(def), none = new Map<number, Pose>()
  const K0 = -a.length, K1 = b.length - 1
  const base = (k: number) => (k < 0 ? a[a.length + k] : b[k]) // the body as it plays now
  const own = (k: number) => (k < 0 ? a[a.length + k] : raw[k]) // the feet each piece puts down by itself
  const seq: Pose[] = []; for (let k = K0; k <= K1; k++) seq.push(own(k))
  const ft = feetTrack(seq, def)
  if (!ft || legs.length !== 4) return { status: { kind: 'fail', why: { noTime: true } }, poses: none }
  const floor = ft.floor, down = (k: number) => legs.map((_, l) => ft.down[l][k - K0])
  const feet = seq.map(p => legs.map(l => at3(footMat(l, poseMat(p), p.q))))
  const foot = (k: number, l: number) => feet[k - K0][l]
  const still = (k: number, d: -1 | 1) => down(k).every(Boolean) && (k + d < K0 || k + d > K1 ||
    legs.every((_, l) => Math.hypot(foot(k + d, l)[0] - foot(k, l)[0], foot(k + d, l)[1] - foot(k, l)[1]) < STEP.still))
  let stillA = 0; for (let k = -1; k >= K0 && still(k, -1); k--) stillA++
  let stillB = 0; for (let k = 0; k <= K1 && still(k, 1); k++) stillB++
  const gA = down(-1), gB = down(0), nA = gA.filter(Boolean).length, nB = gB.filter(Boolean).length
  if (!nA || !nB) return { status: { kind: 'air' }, poses: none }
  if (nA !== nB) return { status: { kind: 'lift' }, poses: none }
  const fA = feet[-1 - K0], fB = feet[-K0]
  const dist = legs.map((_, l) => Math.hypot(fB[l][0] - fA[l][0], fB[l][1] - fA[l][1]))
  const mv = legs.map((_, l) => l).filter(l => gA[l] && gB[l] && dist[l] > STEP.small)
  const glide = Math.max(...dist) > STEP.still // a foot has to get somewhere (≤ 3 cm: it glides, over a window as long as a step)
  const regEnd = Math.min(K1 - 2, seam) // the seam glides the feet up to here: these frames are solved too

  type Cand = { poses: Map<number, Pose>; ok: boolean; score: number; why: StepWhy; status: Extract<StepStatus, { kind: 'ok' }> }
  const cands: Cand[] = []
  const ends = [...new Set((opts.ends ?? STEP.ends).map(e => Math.min(e, stillB, K1 - 2)))]
  const starts = [...new Set((opts.starts ?? [0, Math.floor(stillA / 2), stillA]).map(s => -Math.min(s, -K0 - 3)))]
  for (const ek of ends) for (const sk of starts) {
    if ((mv.length || glide) && ek - sk < STEP.air) continue
    if (ek - sk < 1 && regEnd < 1) continue
    const groupsList: number[][][] = []
    if (mv.length) {
      if (opts.one && mv.every(l => gA.filter((g, x) => g && x !== l).length >= 3)) groupsList.push(mv.map(l => [l]))
      const pairs = DIAG.map(p => p.filter(l => mv.includes(l))).filter(p => p.length)
      if (pairs.length < mv.length) groupsList.push(pairs)
    } else groupsList.push([])
    for (const groups of groupsList) cands.push(tryPlan(sk, ek, groups))
  }
  function tryPlan(sk: number, ek: number, groups: number[][]): Cand {
    const one = groups.length > 0 && groups.every(g => g.length === 1), G = groups.length, L = ek - sk
    const units = one ? G + 0.3 : Math.max(G, 1), w = L / units
    const slot = (g: number) => (one ? [sk + (g + 0.3) * w, sk + (g + 1) * w] : [sk + g * w, sk + (g + 1) * w])
    const start = fA, target = legs.map((_, l) => foot(Math.max(ek, 0), l))
    const posAt = (k: number, l: number): number[] => {
      if (k >= ek || k < sk) return foot(k, l) // each piece's own feet (B's own steps kept)
      const gi = groups.findIndex(g => g.includes(l))
      if (gi < 0) { const u = q5((k - sk) / Math.max(L, 1)); return [0, 1, 2].map(c => start[l][c] + (target[l][c] - start[l][c]) * u) } // ≤ 3 cm: glide
      const [w0, w1] = slot(gi), t = (k - w0) / (w1 - w0)
      if (t <= 0) return start[l]
      if (t >= 1) return target[l]
      const u = q5(Math.min(Math.max((t - 0.15) / 0.7, 0), 1)), d = Math.hypot(target[l][0] - start[l][0], target[l][1] - start[l][1])
      const p = [0, 1, 2].map(c => start[l][c] + (target[l][c] - start[l][c]) * u)
      p[2] += lift(d) * Math.sin(Math.PI * t) ** 2 // up and down softly (no vertical speed at either end)
      return p
    }
    // one foot at a time: the body leans towards the other three before each lift and back at the end (the root path returns)
    const comBase = one ? centerOfMass(Array.from({ length: L + 1 }, (_, i) => base(sk + i)), def)! : []
    const want = (gi: number) => {
      if (gi < 0 || gi >= G) return [0, 0]
      const l = groups[gi][0], kk = Math.round(slot(gi)[0]), sup = legs.map((_, j) => j).filter(j => j !== l).map(j => posAt(kk, j))
      const c = comBase[kk - sk], ic = incenter(sup)
      let dx = ic[0] - c[0], dy = ic[1] - c[1]; const m = Math.hypot(dx, dy)
      if (m > STEP.shift) { dx *= STEP.shift / m; dy *= STEP.shift / m }
      return [dx, dy]
    }
    const offAt = (k: number): number[] => {
      if (!one || k <= sk || k >= ek) return [0, 0]
      const x = (k - sk) / w, g = Math.min(Math.floor(x), G), fr = x - g, p0 = want(g - 1), p1 = want(g), r = q5(Math.min(fr / 0.3, 1))
      return [p0[0] + (p1[0] - p0[0]) * r, p0[1] + (p1[1] - p0[1]) * r]
    }
    const out = new Map<number, Pose>(), poses: Pose[] = []
    const k0 = Math.max(K0, sk - 3), r1 = Math.max(ek, regEnd), k1 = Math.min(K1, r1 + 2)
    let miss = 0
    for (let k = k0; k <= k1; k++) {
      const bp = base(k), o = offAt(k)
      const p: Pose = { rootPos: [bp.rootPos[0] + o[0], bp.rootPos[1] + o[1], bp.rootPos[2]], rootQuat: bp.rootQuat, q: [...bp.q] }
      if (k >= sk && k <= r1) {
        legs.forEach((leg: Leg, l) => {
          const tg = posAt(k, l), q = [...p.q]
          solveLeg(def, leg, poseMat(p), tmat(tg), q, 40)
          const m = at3(footMat(leg, poseMat(p), q))
          miss = Math.max(miss, Math.hypot(m[0] - tg[0], m[1] - tg[1], m[2] - tg[2]))
          for (const i of leg.qis) p.q[i] = q[i]
        })
        out.set(k, p)
      }
      poses.push(p)
    }
    let v = 0, acc = 0
    for (let i = 1; i < poses.length; i++) def.joints.forEach((j, n) => {
      v = Math.max(v, Math.abs(poses[i].q[n] - poses[i - 1].q[n]) * 60 / j.velocity)
      if (i < poses.length - 1) acc = Math.max(acc, Math.abs(poses[i + 1].q[n] - 2 * poses[i].q[n] + poses[i - 1].q[n]) * 3600 / (STEP.acc[j.name.split('_')[1]] ?? Infinity))
    })
    const t = feetTrack(poses, def, floor)!
    let air = Infinity
    t.feet.forEach((_, l) => { let run = 0; for (let i = 0; i < poses.length; i++) { if (!t.down[l][i]) run++; else { if (run >= 2) air = Math.min(air, run); run = 0 } } })
    let com = 0
    if (one) { const cm = centerOfMass(poses, def)!; for (let i = 0; i < poses.length; i++) { const sup = legs.map((_, l) => l).filter(l => t.down[l][i]).map(l => t.at[l][i]); if (sup.length === 3 && hullMargin(cm[i], sup) < STEP.com) com++ } }
    const ok = miss <= STEP.ik && v <= STEP.vel && acc <= 1 && (!mv.length || air >= STEP.air) && com === 0
    const why: StepWhy = {}
    if (miss > STEP.ik) why.miss = miss
    if (v > STEP.vel) why.vel = v
    if (acc > 1) why.acc = acc
    if (mv.length && air < STEP.air) why.air = air === Infinity ? 0 : air
    if (com) why.com = com
    return { poses: out, ok, score: Math.max(v / STEP.vel, acc), why, status: { kind: 'ok', groups: G, one, from: sk, to: r1, moved: mv.length } }
  }
  const ok = cands.filter(c => c.ok).sort((x, y) => x.score - y.score)
  if (ok.length) return { status: ok[0].status, poses: ok[0].poses }
  if (!cands.length) return { status: { kind: 'fail', why: { noTime: true } }, poses: none }
  const near = [...cands].sort((x, y) => Object.keys(x.why).length - Object.keys(y.why).length || x.score - y.score)[0]
  return { status: { kind: 'fail', why: near.why }, poses: none }
}

/** B placed after A the way stitchTransforms places a cut piece: B's first frame one frame on from A's last at its speed. */
export function placeAfter(aPrev: Pose, aLast: Pose, b0: Pose) {
  const yl = quatYaw(aLast.rootQuat), yp = quatYaw(aPrev.rootQuat)
  const ax = 2 * aLast.rootPos[0] - aPrev.rootPos[0], ay = 2 * aLast.rootPos[1] - aPrev.rootPos[1], ayaw = yl + wrap(yl - yp)
  const yaw = ayaw - quatYaw(b0.rootQuat), c = Math.cos(yaw), s = Math.sin(yaw)
  const xf = { x: ax - (c * b0.rootPos[0] - s * b0.rootPos[1]), y: ay - (s * b0.rootPos[0] + c * b0.rootPos[1]), yaw }
  return (p: Pose) => place(p, xf)
}

// ---- the boundary of a piece in a project ----
const itemLen = (it: Item) => it.trimOut - it.trimIn

/** The piece that ends where `it` starts on its motion track (the 이음매 보정 boundary), or null. */
export function prevTouching(p: Project, it: Item): Item | null {
  const track = p.sequence.tracks.find(t => t.kind === 'motion' && t.items.some(i => i.id === it.id))
  return track?.items.find(i => i.id !== it.id && i.start + itemLen(i) === it.start) ?? null
}
/** The piece that starts where `it` ends, or null. */
export function nextTouching(p: Project, it: Item): Item | null {
  const track = p.sequence.tracks.find(t => t.kind === 'motion' && t.items.some(i => i.id === it.id))
  return track?.items.find(i => i.id !== it.id && i.start === it.start + itemLen(it)) ?? null
}

// content cache: the same two pieces meeting the same way give the same plan, whatever else changed in the project
const memo = new Map<string, Plan>()
function hashPoses(lists: Pose[][], seam: number): string {
  let h1 = 0x811c9dc5, h2 = 0x9747b28c
  const mix = (v: number) => { const x = Math.round(v * 1e6) | 0; h1 = Math.imul(h1 ^ x, 0x01000193) >>> 0; h2 = Math.imul(h2 ^ (x >>> 7), 0x01000193) >>> 0 }
  mix(seam)
  for (const l of lists) { mix(l.length); for (const p of l) { p.rootPos.forEach(mix); p.rootQuat.forEach(mix); p.q.forEach(mix) } }
  return h1.toString(16) + h2.toString(16)
}

/** The 발 걸음 이음매 at the start of B (`it`), from the clips as they play without it (`seamed`, `rawB`). A's frames before
 * `aFrom` are not used (the 발 걸음 of A's own start may have them: the earlier boundary comes first). */
export function boundaryPlan(defs: RobotDefs, A: Item, B: Item, seamedA: Clip, seamedB: Clip, rawB: Clip, seam: number, aFrom = A.trimIn): Plan {
  const def = defs.go2
  const na = Math.min(STEP.look, A.trimOut - Math.max(aFrom, A.trimIn)), nb = Math.min(STEP.look, itemLen(B) - 2)
  const a: Pose[] = []; for (let f = A.trimOut - na; f < A.trimOut; f++) a.push(evaluateClip(seamedA, def, f))
  const bs: Pose[] = [], br: Pose[] = []
  for (let f = B.trimIn; f < B.trimIn + nb; f++) { bs.push(evaluateClip(seamedB, def, f)); br.push(evaluateClip(rawB, def, f)) }
  if (a.length < 2 || bs.length < 3) return { status: { kind: 'fail', why: { noTime: true } }, poses: new Map() }
  const key = hashPoses([a, bs, br], seam)
  const hit = memo.get(key)
  if (hit) return hit
  const put = placeAfter(a[a.length - 2], a[a.length - 1], bs[0])
  const r = planStep({ def, a, b: bs.map(put), raw: br.map(put), seam })
  if (memo.size > 400) memo.delete(memo.keys().next().value!)
  memo.set(key, r)
  return r
}

/** Split a plan into A's and B's clip frames (joint values; the root stays as the pieces play it). */
export function stepFrames(A: Item, B: Item, poses: Map<number, Pose>): Pick<StepResult, 'a' | 'b'> {
  const a = new Map<number, number[]>(), b = new Map<number, number[]>()
  for (const [k, p] of poses) (k < 0 ? a.set(A.trimOut + k, p.q) : b.set(B.trimIn + k, p.q))
  return { a, b }
}

/** What a boundary mark says: its colour, a short label, and the reasons (numbers) for 주황. */
export function stepText(st: StepStatus): { tone: 'ok' | 'warn' | 'bad' | 'same'; label: string; detail: string } {
  switch (st.kind) {
    case 'ok': return { tone: 'ok', label: '발 걸음 이음매 적용',
      detail: st.moved ? `발 ${st.moved}개를 대각 두 발씩 들어 옮김 (${Math.round((st.to - st.from) / 6) / 10}초, 시간 그대로)` : '발 고정 (3 cm 이하는 천천히 맞춤, 시간 그대로)' }
    case 'same': return { tone: 'same', label: '경계 프레임이 같음', detail: '이음매 없이 바로 이어짐' }
    case 'lift': return { tone: 'bad', label: '바닥에 닿는 발 수가 바뀜', detail: '뒷발 서기 등 — 표시만, 기존 이음매 그대로' }
    case 'air': return { tone: 'bad', label: '경계에 바닥에 닿은 발이 없음', detail: '표시만, 기존 이음매 그대로' }
    case 'fail': {
      const w = st.why, r: string[] = []
      if (w.noTime) r.push('두 조각이 경계 근처에 네 발로 서 있는 시간이 0.2초가 안 됨')
      if (w.miss !== undefined) r.push(`발이 목표에 ${(w.miss * 100).toFixed(1)} cm 못 닿음`)
      if (w.vel !== undefined) r.push(`관절 속도 한계의 ${w.vel.toFixed(2)}배 (상한 ${STEP.vel}배)`)
      if (w.acc !== undefined) r.push(`관절 가속 상한의 ${w.acc.toFixed(1)}배`)
      if (w.air !== undefined) r.push(`발이 떠 있는 시간 ${(w.air / 60).toFixed(2)}초 (0.2초 미만)`)
      if (w.com !== undefined) r.push(`무게중심이 디딘 발 밖 ${w.com}프레임`)
      return { tone: 'warn', label: '시간 안에 조건을 못 맞춤 — 기존 이음매 유지', detail: r.join(' · ') }
    }
  }
}

// ---- 수동 전이 조각 (§19, 우클릭 메뉴에서만: 시간이 늘어남) ----
export const BRIDGE_LENS = [36, 60, 90, 120, 150, 180] // frames tried, shortest first
/** GO2 기본서기: (0, 0.8, −1.5) on every leg (the Go2 editor's STAND, the library's 003 and the real standup end). */
export const STAND_Q = [0, 0.8, -1.5]
export type Bridge = { ok: true; poses: Pose[] } | { ok: false; status: StepStatus }

/** A piece of its own from pose `from` to pose `to` (both in one frame of reference), `n` frames: the body eases over (no speed
 * at either end), the feet stay or are lifted one at a time with the body leaning onto the other three first (or in trot
 * pairs) — the first `n` that meets the STEP limits. Its first frame is `from`, its last `to`. */
export function bridgeBetween(def: RobotDef, from: Pose, to: Pose): Bridge {
  let last: StepStatus = { kind: 'fail', why: { noTime: true } }
  for (const n of BRIDGE_LENS) {
    const body: Pose[] = []
    for (let k = 0; k < n; k++) {
      const u = q5(k / (n - 1)), l = (x: number, y: number) => x + (y - x) * u
      body.push({ rootPos: [l(from.rootPos[0], to.rootPos[0]), l(from.rootPos[1], to.rootPos[1]), l(from.rootPos[2], to.rootPos[2])],
        rootQuat: slerpQ(from.rootQuat, to.rootQuat, u), q: from.q.map((v, i) => l(v, to.q[i])) })
    }
    const tail = Array.from({ length: 4 }, () => to)
    const r = planStep({ def, a: [from, from, from], b: [...body, ...tail], raw: [...body.map(() => to), ...tail], seam: n - 1 },
      { one: true, ends: [n - 4], starts: [0] })
    last = r.status
    if (r.status.kind === 'lift' || r.status.kind === 'air') return { ok: false, status: r.status }
    if (r.status.kind !== 'ok') continue
    return { ok: true, poses: body.map((p, k) => r.poses.get(k) ?? p) }
  }
  return { ok: false, status: last }
}
function slerpQ(a: Pose['rootQuat'], b: Pose['rootQuat'], t: number): Pose['rootQuat'] {
  let d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]
  const bb = d < 0 ? b.map(v => -v) : b; d = Math.abs(d)
  let ka = 1 - t, kb = t
  if (d < 0.9995) { const th = Math.acos(d), sn = Math.sin(th); ka = Math.sin((1 - t) * th) / sn; kb = Math.sin(t * th) / sn }
  const r = a.map((v, i) => ka * v + kb * bb[i]), n = Math.hypot(...r)
  return r.map(v => v / n) as Pose['rootQuat']
}

/** 기본서기 with pose `at`'s heading, standing over the middle of `at`'s feet (the fewest steps): the joints of STAND_Q, the body
 * level and as high as puts the feet on `floor`. */
export function standAt(def: RobotDef, at: Pose, floor: number): Pose {
  const legs = legsOf(def), q = def.joints.map((_, i) => STAND_Q[i % 3])
  const yaw = quatYaw(at.rootQuat), probe: Pose = { rootPos: [0, 0, 0], rootQuat: yawQuat(yaw), q }
  const mid = (fs: number[][]) => [0, 1, 2].map(c => fs.reduce((t, f) => t + f[c], 0) / fs.length)
  const fa = mid(legs.map(l => at3(footMat(l, poseMat(at), at.q)))), fs = legs.map(l => at3(footMat(l, poseMat(probe), q))), fp = mid(fs)
  const low = Math.min(...fs.map(f => f[2]))
  return { ...probe, rootPos: [fa[0] - fp[0], fa[1] - fp[1], floor - low] }
}

/** The manual 전이 조각 between A's last frames and B's first frame: 'step' = straight from A's end to B's start, 'stand' = through
 * 기본서기 (both halves as bridgeBetween). Poses in A's clip frame; null when it cannot be made within the limits. */
export function bridgePoses(def: RobotDef, aPrev: Pose, aLast: Pose, b0: Pose, kind: 'step' | 'stand'): Bridge {
  const to = placeAfter(aPrev, aLast, b0)(b0)
  if (kind === 'step') return bridgeBetween(def, aLast, to)
  const ft = feetTrack([aLast, to], def), floor = ft ? Math.min(...ft.at.flatMap(a => a.map(p => p[2]))) : 0
  const s1 = standAt(def, aLast, floor), s2 = standAt(def, to, floor)
  const p1 = bridgeBetween(def, aLast, s1)
  if (!p1.ok) return p1
  const p2 = bridgeBetween(def, { ...s1, rootPos: [...s1.rootPos] as Pose['rootPos'] }, s2)
  if (!p2.ok) return p2
  const p3 = bridgeBetween(def, s2, to)
  if (!p3.ok) return p3
  return { ok: true, poses: [...p1.poses, ...p2.poses.slice(1), ...p3.poses.slice(1)] }
}
