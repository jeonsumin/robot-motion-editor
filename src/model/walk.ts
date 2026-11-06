// GO2 걷기 블록 (가상 걷기, 수정변동사항.md §20, spec docs/superpowers/specs/2026-11-06-go2-walk-block-design.md).
// A walk piece goes from where the piece before it ends to a point on the stage (무대 절대 좌표) in exactly its own length
// (노래 시간 — the length is the time). The steps are made, not recorded: a trot (diagonal pairs) like the Go2 editor's 보행 합성,
// the feet set where the body will be half a step later, the legs solved by IK; the first step leaves from the feet the piece
// before stands on, the last ones land where the next piece's first frame has them. Pure: poses in, poses out.
// Nothing is forced: when the time is too short for the distance, or a leg cannot reach, the walk is still made and reported (빨강).
import type { Pose } from './pose'
import { eulerToQuat, quatToEuler, quatYaw } from './rootMath'
import { footMat, legsOf, solveLeg } from './legIk'
import { STEP } from './transition'
import type { RobotDef } from '../robot/types'

export type WalkFace = 'travel' | 'keep' | 'audience' // 진행 방향 보기 · 방향 유지 · 객석 보기
export type WalkSlow = 'walk' | 'after' | 'before' // 천천히 계속 걷기 · 걷고 나서 서 있기 · 서 있다가 걷기
export interface WalkSpec { to: [number, number] /* 무대 x, y (m) */; face: WalkFace; yaw?: number /* 진행 방향 보기: the heading at the end (stage, rad); missing = the way it walked */; slow?: WalkSlow /* missing = 'walk' */ }

export const WALK = {
  half: { fwd: 0.20, back: 0.12, side: 0.08 }, // m the body may travel in one half step (one trot pair swinging), by direction — 임시값, 검증 예정
  cadence: [1.8, 4.5], // half steps per second: at least (a slow walk keeps stepping) / at most
  easyShare: 0.65, // an easy half step = this share of the limits (앞 13 cm: the Go2 editor's pace)
  turn: 0.35, // rad per half step at most when turning
  slow: 0.2, // m/s: slower than this is reported (아주 느림)
  easy: 0.5, // m/s: the pace of 걷고 나서 서 있기 / 서 있다가 걷기
  turnRate: 1, // 진행 방향 보기: a turn's top rate = the fastest turning (WALK.turn per half step at the top cadence)
  turnShare: 0.3, // … and at most this share of the walk (each turn)
  acc: { hip: 170, thigh: 300, calf: 570 } as Record<string, number>, // rad/s²: the real Move log's highest — walking is quicker than a 전이
  ease: 0.12, // share of the walk spent speeding up and slowing down (each end)
  lift: 0.05, // m a swinging foot rises at most
  still: 0.01, // m: a foot that has to move less than this stays put
  hip: [48, 54].map(d => d * Math.PI / 180), // rad: new_rl hip rule — over 48° 경고 (주황), over 54° 실패 (빨강)
  stand: 0.02, // m: every foot within this of the lowest one = standing on four feet
}

export type WalkTone = 'ok' | 'warn' | 'bad'
export interface WalkReport {
  tone: WalkTone
  reasons: { tone: Exclude<WalkTone, 'ok'>; text: string }[]
  dist: number; secs: number; speed: number // m, s, m/s (the whole piece)
  halfSteps: number; stride: number // half steps, the longest body travel in one (m)
  vel: number; acc: number; hip: number; miss: number // × motor velocity limit, × WALK.acc, rad, m
  slowFix?: string // what 걷고 나서 서 있기 would do
  startBad?: true // it cannot start (the piece before it does not end standing): no length fixes it, 기본서기 경유 does
  held?: true // (a piece on the timeline) 한계 초과, so it does not walk: it stands in its start pose (§22, 안정성 우선)
}

type M = number[]
const poseMat = (p: Pose): M => {
  const [x, y, z, w] = p.rootQuat, P = p.rootPos
  return [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w), P[0], 2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w), P[1],
    2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y), P[2], 0, 0, 0, 1]
}
const at3 = (m: M) => [m[3], m[7], m[11]]
const tmat = (p: number[]): M => [1, 0, 0, p[0], 0, 1, 0, p[1], 0, 0, 1, p[2], 0, 0, 0, 1]
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a))
const smooth = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x))
const q5 = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * x * (10 + x * (6 * x - 15)))
/** Even pace with WALK.ease of speeding up and slowing down at each end (speed continuous; the Go2 editor's). */
function ease(t: number) {
  const e = WALK.ease, v = 1 / (1 - e)
  if (t <= 0) return 0
  if (t >= 1) return 1
  if (t < e) return v * t * t / (2 * e)
  if (t > 1 - e) return 1 - v * (1 - t) * (1 - t) / (2 * e)
  return v * (t - e / 2)
}
const DIAG = [0, 1, 1, 0] // legsOf order FL, FR, RL, RR: FL+RR swing together, FR+RL together

/** Where each foot is (world) and whether the robot stands on all four. */
export function feetOf(def: RobotDef, p: Pose) {
  const legs = legsOf(def), feet = legs.map(l => at3(footMat(l, poseMat(p), p.q)))
  const low = Math.min(...feet.map(f => f[2])), [roll, pitch] = quatToEuler(p.rootQuat)
  // standing = on all four feet, the body level (≤ 20°) and up (≥ 70 % of 기본서기's height over the feet): not sitting or lying
  const up = p.rootPos[2] - low >= 0.7 * standHeight(def) && Math.abs(roll) < 0.35 && Math.abs(pitch) < 0.35
  // and every joint within its range (e.g. an empty clip's all-zero pose: legs straight, the calves past their limit)
  const inRange = def.joints.every((j, i) => p.q[i] >= j.lower - 0.01 && p.q[i] <= j.upper + 0.01)
  const fourFeet = legs.length === 4 && feet.every(f => f[2] - low < WALK.stand)
  return { feet, low, standing: fourFeet && up && inRange, fourFeet, inRange }
}
const standCache = new WeakMap<RobotDef, number>()
function standHeight(def: RobotDef): number { // 기본서기's body height over its feet
  let h = standCache.get(def)
  if (h === undefined) {
    const legs = legsOf(def), q = def.joints.map((_, i) => [0, 0.8, -1.5][i % 3]), m = poseMat({ rootPos: [0, 0, 0], rootQuat: [0, 0, 0, 1], q })
    standCache.set(def, h = -Math.min(...legs.map(l => at3(footMat(l, m, q))[2])))
  }
  return h
}

/** The stance a walk ends in when the next piece does not stand on four feet (or there is none): 기본서기 (0, 0.8, −1.5),
 * level, the feet at height `floor`, at x, y facing `yaw`. */
export function standPose(def: RobotDef, x: number, y: number, yaw: number, floor: number): Pose {
  const q = def.joints.map((_, i) => [0, 0.8, -1.5][i % 3])
  return { rootPos: [x, y, floor + standHeight(def)], rootQuat: eulerToQuat(0, 0, yaw), q }
}

interface Root { x: number; y: number; z: number; roll: number; pitch: number; yaw: number }

/** The walk: `n` frames from `start` to `end` (both in the frame the walk is played in; `end` has the target place and heading).
 * Frame 0 is `start`, frame n − 1 is `end`. */
export function makeWalk(def: RobotDef, start: Pose, end: Pose, n: number, face: WalkFace, slow: WalkSlow = 'walk'): { poses: Pose[]; report: WalkReport } {
  const legs = legsOf(def), last = Math.max(n - 1, 1)
  const [r0, p0] = quatToEuler(start.rootQuat), [r1, p1] = quatToEuler(end.rootQuat)
  const A: Root = { x: start.rootPos[0], y: start.rootPos[1], z: start.rootPos[2], roll: r0, pitch: p0, yaw: quatYaw(start.rootQuat) }
  const B: Root = { x: end.rootPos[0], y: end.rootPos[1], z: end.rootPos[2], roll: r1, pitch: p1, yaw: A.yaw + wrap(quatYaw(end.rootQuat) - A.yaw) }
  const D = Math.hypot(B.x - A.x, B.y - A.y), secs = n / 60, dir = Math.atan2(B.y - A.y, B.x - A.x)
  const sA = feetOf(def, start), sB = feetOf(def, end), floor = sA.low

  // the frames the walking happens in: all of them, or (걷고 나서 서 있기 / 서 있다가 걷기, when slow) an easy-paced part
  const slowNow = D > 0.05 && D / secs < WALK.slow
  const turnNeed = Math.abs(B.yaw - A.yaw) / WALK.turn / WALK.cadence[1] * 60
  const bodyGo = (() => { // the way to the target in the start's own frame: half steps it takes at the direction limits
    if (face === 'travel') return D / WALK.half.fwd
    const c = Math.cos(A.yaw), s = Math.sin(A.yaw), fw = c * (B.x - A.x) + s * (B.y - A.y), lf = -s * (B.x - A.x) + c * (B.y - A.y)
    return Math.hypot(fw / (fw >= 0 ? WALK.half.fwd : WALK.half.back), lf / WALK.half.side)
  })()
  const easyLen = Math.min(last, Math.max(36, Math.round(D / WALK.easy * 60), Math.ceil(turnNeed), Math.ceil(bodyGo / (WALK.cadence[1] * 0.6) * 60)))
  const [w0, w1] = slowNow && slow === 'after' ? [0, easyLen] : slowNow && slow === 'before' ? [last - easyLen, last] : [0, last]
  const W = w1 - w0

  // the body: 진행 방향 보기 turns to the way it goes, walks, turns to the end heading; the others turn while they walk
  const travel = face === 'travel' && D > 0.05
  const yDir = A.yaw + wrap(dir - A.yaw), yEnd = travel ? yDir + wrap(B.yaw - yDir) : B.yaw
  // a turn eases in and out (smoothstep: its top rate 1.5 × the mean): long enough that the top rate stays within the turning limit
  const turnLen = (a: number) => Math.min(WALK.turnShare * W, Math.max(12, 1.5 * Math.abs(a) / (WALK.turn * WALK.cadence[1] * WALK.turnRate) * 60))
  const t1 = travel ? turnLen(yDir - A.yaw) : 0, t2 = travel ? turnLen(yEnd - yDir) : 0
  const root = (f: number): Root => {
    const u = Math.min(Math.max((f - w0) / Math.max(W, 1), 0), 1), k = (f - w0)
    let pos: number, yaw: number
    if (travel) {
      pos = ease(Math.min(Math.max((k - t1) / Math.max(W - t1 - t2, 1), 0), 1))
      yaw = k <= t1 ? A.yaw + (yDir - A.yaw) * smooth(k / Math.max(t1, 1)) : k >= W - t2 ? yDir + (yEnd - yDir) * smooth((k - (W - t2)) / Math.max(t2, 1)) : yDir
    } else { pos = ease(u); yaw = A.yaw + (B.yaw - A.yaw) * q5(u) }
    const s = q5(u)
    return { x: A.x + (B.x - A.x) * pos, y: A.y + (B.y - A.y) * pos, z: A.z + (B.z - A.z) * s, roll: A.roll + (B.roll - A.roll) * s, pitch: A.pitch + (B.pitch - A.pitch) * s, yaw }
  }

  // nominal footholds: where 기본서기's feet are under the body (its own frame)
  const stand = standPose(def, 0, 0, 0, 0), home = feetOf(def, stand).feet.map(f => [f[0], f[1]])
  const under = (r: Root, l: number) => { const c = Math.cos(r.yaw), s = Math.sin(r.yaw), [hx, hy] = home[l]; return [r.x + c * hx - s * hy, r.y + s * hx + c * hy, floor] }

  // half steps by effort, not by the clock: every frame adds how much of a half step the body's move and turn take at the direction
  // limits (at least the slowest cadence), and the half steps split that total evenly — so the steps come quicker while it turns or
  // speeds up, and each one stays within the limits. Too fast = a half step shorter than the top cadence allows.
  const travelIn = (a: Root, b: Root) => { // body travel a → b in the body's frame halfway: forward, left (m)
    const dx = b.x - a.x, dy = b.y - a.y, m = a.yaw + wrap(b.yaw - a.yaw) / 2, c = Math.cos(m), s = Math.sin(m)
    return [c * dx + s * dy, -s * dx + c * dy]
  }
  const effort = (a: Root, b: Root) => {
    const [fw, lf] = travelIn(a, b)
    return Math.max(Math.hypot(fw / (fw >= 0 ? WALK.half.fwd : WALK.half.back), lf / WALK.half.side), Math.abs(wrap(b.yaw - a.yaw)) / WALK.turn)
  }
  const settle = Math.min(4, Math.floor(W * 0.05)), F0 = w0, F1 = Math.max(w0 + 1, w1 - settle) // the last step is down a few frames before the end
  // in easy half steps (WALK.easyShare of the limits), at least the slowest cadence; the top cadence caps how many fit, and when it
  // does the steps are spread more evenly in time (a larger even share `c`) until none is quicker than the top cadence allows
  const ef: number[] = []
  for (let f = F0 + 1; f <= F1; f++) ef.push(effort(root(f - 1), root(f)) / WALK.easyShare)
  const minDur = 60 / WALK.cadence[1], hCap = Math.max(2, Math.floor((F1 - F0) / minDur))
  let E: number[] = [0], total = 0, h = 2, c = WALK.cadence[0] / 60
  const frameOf = (ph: number) => { // the (fractional) frame where half step `ph` begins
    const e = Math.min(Math.max(ph, 0), h) / h * total
    let lo = 0, hi = E.length - 1
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (E[m] <= e) lo = m; else hi = m }
    return F0 + lo + (E[hi] > E[lo] ? (e - E[lo]) / (E[hi] - E[lo]) : 0)
  }
  let shortest = Infinity
  for (let it = 0; it < 60; it++) {
    E = [0]; for (const e of ef) E.push(E[E.length - 1] + Math.max(e, c))
    total = E[E.length - 1]; h = Math.max(2, Math.min(Math.ceil(total - 1e-9), hCap))
    shortest = Infinity
    for (let j = 0; j < h; j++) shortest = Math.min(shortest, frameOf(j + 1) - frameOf(j))
    if (shortest >= minDur - 1e-6 || h < 2) break
    c *= 1.25
  }
  const phaseOf = (f: number) => (f <= F0 ? 0 : f >= F1 ? h : E[Math.round(f) - F0] / total * h)
  let stride = 0
  for (let j = 0; j < h; j++) stride = Math.max(stride, Math.hypot(...travelIn(root(frameOf(j)), root(frameOf(j + 1)))))
  let worst = 0, hard = [0, 0, 0] // the hardest half step against the limits (1 = at a limit): its forward, left (m), turn (rad)
  for (let j = 0; j < h; j++) {
    const a = frameOf(j), b = frameOf(j + 1), n = Math.max(1, Math.ceil(b - a)), ra = root(a), rb = root(b)
    let e = 0; for (let i = 0; i < n; i++) e += effort(root(a + (b - a) * i / n), root(a + (b - a) * (i + 1) / n))
    if (e > worst) { worst = e; hard = [...travelIn(ra, rb), wrap(rb.yaw - ra.yaw)] }
  }
  const tooFast = shortest < 60 / WALK.cadence[1] - 1e-6 || worst > 1 + 1e-6

  // footholds per half step: leg l swings in half steps of its pair's parity; it lands under where the body is half a step later,
  // and in the last two half steps where the end pose has that foot
  const hold = (l: number, j: number): number[] => (j >= h - 2 ? sB.feet[l] : under(root(frameOf(j + 1.5)), l))
  const footAt = (f: number, l: number): number[] => {
    if (f <= w0) return sA.feet[l]
    if (f >= F1) return sB.feet[l]
    const t = phaseOf(f), k = Math.min(h - 1, Math.floor(t)), ph = t - k, par = DIAG[l]
    const placed = (j: number) => (j < 0 ? sA.feet[l] : hold(l, j)) // after the swing of half step j (j < 0: where it started)
    const lastOwn = (j: number) => { let i = j; while (i >= 0 && i % 2 !== par) i--; return i } // its last own swing at or before j
    if (k % 2 !== par) return placed(lastOwn(k)) // standing: where its last swing put it
    const from = placed(lastOwn(k - 1)), to = placed(k), d = Math.hypot(to[0] - from[0], to[1] - from[1])
    if (d < WALK.still && Math.abs(to[2] - from[2]) < WALK.still) return to // nothing to do: it stays down
    const u = q5(Math.min(Math.max((ph - 0.1) / 0.8, 0), 1)), p = [0, 1, 2].map(c => from[c] + (to[c] - from[c]) * u) // goes forward once it is up
    p[2] += Math.min(WALK.lift, Math.max(0.02, 0.3 * d)) * Math.sin(Math.PI * ph) ** 2
    return p
  }

  // the legs by IK, frame by frame (each solve starts from the frame before: no jump to another leg branch)
  const poses: Pose[] = []
  let q = [...start.q], miss = 0
  for (let f = 0; f < n; f++) {
    if (f === 0) { poses.push({ rootPos: [...start.rootPos] as Pose['rootPos'], rootQuat: [...start.rootQuat] as Pose['rootQuat'], q: [...start.q] }); continue }
    if (f === n - 1) { poses.push({ rootPos: [...end.rootPos] as Pose['rootPos'], rootQuat: [...end.rootQuat] as Pose['rootQuat'], q: [...end.q] }); continue }
    if (f <= w0 || f >= w1) { const e = f <= w0 ? start : end; q = [...e.q]; poses.push({ rootPos: [...e.rootPos] as Pose['rootPos'], rootQuat: [...e.rootQuat] as Pose['rootQuat'], q: [...e.q] }); continue }
    const r = root(f), p: Pose = { rootPos: [r.x, r.y, r.z], rootQuat: eulerToQuat(r.roll, r.pitch, r.yaw), q: [...q] }
    const M0 = poseMat(p)
    legs.forEach((leg, l) => {
      const tg = footAt(f, l), qq = [...p.q]
      solveLeg(def, leg, M0, tmat(tg), qq, 40)
      const m = at3(footMat(leg, M0, qq))
      miss = Math.max(miss, Math.hypot(m[0] - tg[0], m[1] - tg[1], m[2] - tg[2]))
      for (const i of leg.qis) p.q[i] = qq[i]
    })
    q = p.q
    poses.push(p)
  }

  // the report
  let vel = 0, acc = 0, hip = 0
  for (let f = 1; f < n; f++) def.joints.forEach((j, i) => {
    vel = Math.max(vel, Math.abs(poses[f].q[i] - poses[f - 1].q[i]) * 60 / j.velocity)
    if (f + 1 < n) acc = Math.max(acc, Math.abs(poses[f + 1].q[i] - 2 * poses[f].q[i] + poses[f - 1].q[i]) * 3600 / (WALK.acc[j.name.split('_')[1]] ?? Infinity))
    if (/_hip_joint$/.test(j.name)) hip = Math.max(hip, Math.abs(poses[f].q[i]))
  })
  const reasons: WalkReport['reasons'] = [], speed = D / secs, cm = (m: number) => `${(m * 100).toFixed(0)} cm`
  if (!sA.inRange) reasons.push({ tone: 'bad', text: '출발 불가 — 앞 조각 끝 자세의 관절이 범위 밖 (기본서기 경유 넣기로 해결)' })
  else if (!sA.standing) reasons.push({ tone: 'bad', text: '출발 불가 — 앞 조각이 네 발로 서 있지 않은 자세로 끝남 (기본서기 경유 넣기로 해결)' })
  if (tooFast) {
    const [fw, lf, tw] = hard, parts = [Math.abs(fw) >= 0.005 ? `${fw >= 0 ? '앞' : '뒤'} ${cm(Math.abs(fw))}` : '', Math.abs(lf) >= 0.005 ? `옆 ${cm(Math.abs(lf))}` : '', Math.abs(tw) >= 0.02 ? `회전 ${(Math.abs(tw) * 180 / Math.PI).toFixed(0)}°` : ''].filter(Boolean)
    reasons.push({ tone: 'bad', text: `속도 ${speed.toFixed(2)} m/s — 한 걸음에 ${parts.join(' · ') || cm(stride)}를 가야 해서 한계(앞 ${cm(WALK.half.fwd)} · 뒤 ${cm(WALK.half.back)} · 옆 ${cm(WALK.half.side)} · 회전 ${(WALK.turn * 180 / Math.PI).toFixed(0)}°, 초당 ${WALK.cadence[1]}걸음)를 넘음` })
  }
  if (miss > STEP.ik) reasons.push({ tone: 'bad', text: `다리가 안 닿음 — 발이 목표에 최대 ${(miss * 100).toFixed(1)} cm 못 닿음` })
  if (vel > 1) reasons.push({ tone: 'bad', text: `관절 속도 — 모터 한계의 ${vel.toFixed(2)}배` })
  else if (vel > STEP.vel) reasons.push({ tone: 'warn', text: `관절 속도 — 모터 한계의 ${vel.toFixed(2)}배 (권장 ${STEP.vel}배 이하)` })
  if (hip > WALK.hip[1]) reasons.push({ tone: 'bad', text: `hip ${(hip * 180 / Math.PI).toFixed(0)}° — new_rl 기준 54° 초과 (실패)` })
  else if (hip > WALK.hip[0]) reasons.push({ tone: 'warn', text: `hip ${(hip * 180 / Math.PI).toFixed(0)}° — new_rl 기준 48° 초과 (경고)` })
  if (acc > 1) reasons.push({ tone: 'warn', text: `관절 가속 — 실기 걷기 녹화 최대치의 ${acc.toFixed(1)}배` })
  let slowFix: string | undefined
  if (slowNow && slow === 'walk') {
    slowFix = `걷고 나서 서 있기로 바꾸면 ${(easyLen / 60).toFixed(1)}초 걷고 ${((last - easyLen) / 60).toFixed(1)}초 서 있음`
    reasons.push({ tone: 'warn', text: `아주 느림 — ${secs.toFixed(1)}초 동안 ${D.toFixed(2)} m (평균 ${speed.toFixed(2)} m/s, 기준 ${WALK.slow} m/s 미만), 한 번에 ${cm(stride)}씩 종종걸음` })
  }
  const tone: WalkTone = reasons.some(r => r.tone === 'bad') ? 'bad' : reasons.length ? 'warn' : 'ok'
  return { poses, report: { tone, reasons, dist: D, secs, speed, halfSteps: h, stride, vel, acc, hip, miss, slowFix, ...(sA.standing ? {} : { startBad: true as const }) } }
}

const minMemo = new Map<string, number | null>()
/** The shortest length (frames, in 0.1 s steps) at which the walk from `start` to `end` is no longer 한계 초과; `n` itself when it
 * is not; null when no length fixes it (it cannot start, or not even in 2 minutes). For the 최소 시간 button — never applied by itself. */
export function minWalkFrames(def: RobotDef, start: Pose, end: Pose, n: number, face: WalkFace, slow: WalkSlow = 'walk'): number | null {
  const bad = (k: number) => makeWalk(def, start, end, k, face, slow).report.tone === 'bad'
  if (!feetOf(def, start).standing) return null
  if (!bad(n)) return n
  const key = JSON.stringify([start, end, face, slow]), hit = minMemo.get(key)
  if (hit !== undefined) return hit
  let lo = n, hi = Math.ceil(n * 1.25) + 6, out: number | null = null
  while (hi <= 60 * 120 && bad(hi)) { lo = hi; hi = Math.ceil(hi * 1.5) }
  if (hi <= 60 * 120) {
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (bad(m)) lo = m; else hi = m }
    out = Math.ceil(hi / 6) * 6
    for (let k = 0; k < 10 && bad(out); k++) out += 6
    if (bad(out)) out = null
  }
  if (minMemo.size > 100) minMemo.delete(minMemo.keys().next().value!)
  minMemo.set(key, out)
  return out
}

/** "출발점에서 1.44 m · 왼쪽 앞 34°": where `to` (stage) is from a robot standing at `start` (stage), in its own heading. */
export function describeTo(start: Pose, to: [number, number]): string {
  const dx = to[0] - start.rootPos[0], dy = to[1] - start.rootPos[1], d = Math.hypot(dx, dy)
  if (d < 0.01) return '출발점 그대로'
  const a = wrap(Math.atan2(dy, dx) - quatYaw(start.rootQuat)) * 180 / Math.PI, abs = Math.abs(a)
  const side = abs < 5 ? '앞' : abs > 175 ? '뒤' : abs > 85 && abs < 95 ? (a > 0 ? '왼쪽' : '오른쪽') : `${a > 0 ? '왼쪽' : '오른쪽'} ${abs < 90 ? '앞' : '뒤'}`
  return `출발점에서 ${d.toFixed(2)} m · ${side}${abs >= 5 && abs <= 175 ? ` ${abs.toFixed(0)}°` : ''}`
}
