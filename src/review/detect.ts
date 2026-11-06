// 검수 목록 1단계 (수정변동사항.md §12, docs/superpowers/specs/2026-10-29-review-list-design.md): suspect joint jumps in a motion.
// Only the frames BEFORE a frame are used to judge it (a jumped value stays, so what follows says little). Two rules, either flags:
//  - 로봇 한계 초과: joint speed between neighbouring frames > that joint's URDF velocity limit (model.json) — the robot cannot do it,
//    whatever the choreography.
//  - 파일 기준 급변: the change is far off what the previous two frames predict (constant speed), measured against the same joint's
//    own spread in this motion (95th percentile), and still fast (≥ 70 % of the limit) — adapts to calm vs. fierce choreography.
// Plus 첫 프레임 튐: an imported CSV whose row 1 is a fixed rest pose jumps at frame 0→1.
// Pure: no store, no three.js. Validated on 12 mocap CSVs + their hand-cleaned versions (all > 50 rad/s jumps found, no flags on cleaned data).
import type { Pose } from '../model/evaluate'
import type { RobotDef } from '../robot/types'
import { BODY_PAIRS, HAND_PAIR, pairDepths, pairName } from './collide'
import { feetTrack, footSlips, frictionItems } from './feet'

export const FPS = 60
export const REL_SCORE = 8 // 파일 기준 급변: residual / the joint's 95th-percentile residual
export const REL_MIN_SPEED = 0.7 // … and speed ≥ this × the velocity limit
export const GROUP_GAP = 15 // flagged frames this close (0.25 s) form one item
export const START_JOINT = 1.0 // rad: 첫 프레임 튐 (RL team: a joint jump > 1 rad is cut)
export const START_ROOT = 0.05 // m
export const CONTEXT = 12 // frames shown either side of an item (구간 지표)

export type SuspectKind = 'limit' | 'rel' | 'start' | 'collision' | 'handTouch' // §14: 자가충돌 · 손 맞닿음 (G1)
  | 'footSlip' | 'friction' // §16: 발 미끄러짐 · 마찰 부족 (G1, GO2; feet.ts)
  | 'stage' // §18: 무대 이탈 (pieces only; stage.ts — not from detectSuspects, which sees the motion alone)
export interface Suspect {
  kind: SuspectKind
  from: number; to: number // frames (inclusive) of the target, 0-based
  worst: number // the frame with the highest speed / limit
  joints: string[] // involved joints, worst first
  parts: string[] // 부위: 왼팔, 오른다리, 허리…
  speed: number // rad/s at the worst frame (worst joint)
  ratio: number // speed / that joint's velocity limit
  jump: number // rad, the worst joint's change at the worst frame
  score: number // 파일 기준 급변 점수: the highest residual / that joint's 95th percentile in the item (판정 기록)
  atLimit: boolean // an involved joint within 0.01 rad of its limit within 5 frames of the item (판정 기록)
  pairs?: [string, string][] // collision / handTouch: the part pairs that overlap (collide.ts), deepest first
  depth?: number // collision / handTouch: the deepest overlap in the item, mm
  level?: 'warn' | 'note' // footSlip / friction: 경고 · 주의
  foot?: string // footSlip: the foot link
  travel?: number; load?: number; turn?: number; pivot?: boolean // footSlip: m over the floor, mean weight share 0–1, heading change °, 제자리 회전
  mu?: number // friction: the highest friction coefficient needed
  floor?: number // footSlip / friction: the motion's floor height, m (구간 지표 of a window uses it)
  over?: number; side?: 'back' | 'front' | 'right' | 'left' // stage: how far past that edge of the 무대 at worst, m
}

const PART_GO2: Record<string, string> = { FL: '앞왼다리', FR: '앞오른다리', RL: '뒤왼다리', RR: '뒤오른다리' }
/** 부위 of a joint name (G1: left/right arm·leg, waist; GO2: FL/FR/RL/RR). */
export function partOf(name: string): string {
  if (name.startsWith('waist')) return '허리'
  const go2 = PART_GO2[name.slice(0, 2)]
  if (go2 && name[2] === '_') return go2
  const side = name.startsWith('left') ? '왼' : name.startsWith('right') ? '오른' : ''
  return side + (/hip|knee|ankle/.test(name) ? '다리' : '팔')
}

const p95 = (xs: number[]) => {
  if (!xs.length) return 0
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor(0.95 * (s.length - 1)))]
}

/** Per-frame flags and speed / limit ratios for every joint. `skip0` = frame 1 belongs to a 첫 프레임 튐 item (not judged here). */
function frameFlags(poses: Pose[], def: RobotDef, skip0: boolean) {
  const n = poses.length, J = def.joints.length
  const ratio: number[][] = poses.map(() => new Array(J).fill(0))
  const flag: boolean[][] = poses.map(() => new Array(J).fill(false))
  const score: number[][] = poses.map(() => new Array(J).fill(0))
  const resid: number[][] = Array.from({ length: J }, () => [])
  const t0 = skip0 ? 2 : 1
  for (let t = t0; t < n; t++) for (let j = 0; j < J; j++) {
    const lim = def.joints[j].velocity
    ratio[t][j] = lim > 0 ? Math.abs(poses[t].q[j] - poses[t - 1].q[j]) * FPS / lim : 0
    if (t >= t0 + 1) resid[j].push(Math.abs(poses[t].q[j] - 2 * poses[t - 1].q[j] + poses[t - 2].q[j]))
  }
  const scale = resid.map(r => Math.max(p95(r), 1e-4))
  for (let t = t0 + 1; t < n; t++) for (let j = 0; j < J; j++) score[t][j] = Math.abs(poses[t].q[j] - 2 * poses[t - 1].q[j] + poses[t - 2].q[j]) / scale[j]
  for (let t = t0; t < n; t++) for (let j = 0; j < J; j++) {
    if (ratio[t][j] > 1) { flag[t][j] = true; continue }
    if (t < t0 + 1 || ratio[t][j] < REL_MIN_SPEED) continue
    if (score[t][j] > REL_SCORE) flag[t][j] = true
  }
  return { ratio, flag, score }
}

/** True when frame 0 → 1 is a 첫 프레임 튐 (an imported rest-pose row 1). */
export function startJump(poses: Pose[]): boolean {
  if (poses.length < 2) return false
  const [a, b] = poses
  const dq = Math.max(0, ...a.q.map((v, i) => Math.abs(b.q[i] - v)))
  const dr = Math.hypot(b.rootPos[0] - a.rootPos[0], b.rootPos[1] - a.rootPos[1], b.rootPos[2] - a.rootPos[2])
  return dq > START_JOINT || dr > START_ROOT
}

const LIMIT_NEAR = 0.01, LIMIT_WIN = 5
function nearLimit(poses: Pose[], def: RobotDef, joints: string[], from: number, to: number): boolean {
  const idx = joints.map(n => def.joints.findIndex(j => j.name === n)).filter(i => i >= 0)
  for (let t = Math.max(0, from - LIMIT_WIN); t <= Math.min(poses.length - 1, to + LIMIT_WIN); t++)
    for (const j of idx) { const q = poses[t].q[j], d = def.joints[j]; if (q - d.lower < LIMIT_NEAR || d.upper - q < LIMIT_NEAR) return true }
  return false
}

/** The suspect items of a motion, most severe first (첫 프레임 튐 first of all). */
export function detectSuspects(poses: Pose[], def: RobotDef): Suspect[] {
  const out: Suspect[] = []
  const start = startJump(poses)
  if (start) {
    const [a, b] = poses
    const dq = a.q.map((v, i) => Math.abs(b.q[i] - v)), k = dq.indexOf(Math.max(...dq))
    const joints = def.joints.map((j, i) => [j.name, dq[i]] as const).filter(([, d]) => d > 0.3).sort((x, y) => y[1] - x[1]).map(([n]) => n)
    const lim = def.joints[k].velocity
    out.push({ kind: 'start', from: 0, to: 1, worst: 1, joints, parts: [...new Set(joints.map(partOf))], speed: dq[k] * FPS, ratio: lim > 0 ? dq[k] * FPS / lim : 0, jump: dq[k],
      score: 0, atLimit: nearLimit(poses, def, joints, 0, 1) })
  }
  const { ratio, flag, score } = frameFlags(poses, def, start)
  const frames = flag.map((row, t) => (row.some(Boolean) ? t : -1)).filter(t => t >= 0)
  const groups: number[][] = []
  for (const t of frames) {
    const g = groups[groups.length - 1]
    if (g && t - g[g.length - 1] <= GROUP_GAP) g.push(t)
    else groups.push([t])
  }
  for (const g of groups) {
    let worst = g[0], wj = 0, best = -1
    const hit = new Map<number, number>() // joint -> its highest ratio in the item
    let limit = false, sc = 0
    for (const t of g) flag[t].forEach((f, j) => {
      if (!f) return
      sc = Math.max(sc, score[t][j])
      if (ratio[t][j] > 1) limit = true
      hit.set(j, Math.max(hit.get(j) ?? 0, ratio[t][j]))
      if (ratio[t][j] > best) { best = ratio[t][j]; worst = t; wj = j }
    })
    const joints = [...hit].sort((a, b) => b[1] - a[1]).map(([j]) => def.joints[j].name)
    out.push({ kind: limit ? 'limit' : 'rel', from: g[0], to: g[g.length - 1], worst, joints, parts: [...new Set(joints.map(partOf))],
      speed: best * def.joints[wj].velocity, ratio: best, jump: Math.abs(poses[worst].q[wj] - poses[worst - 1].q[wj]), score: sc, atLimit: nearLimit(poses, def, joints, g[0], g[g.length - 1]) })
  }
  const jumps = out.sort((a, b) => (a.kind === 'start' ? -1 : b.kind === 'start' ? 1 : b.ratio - a.ratio))
  const feet = feetTrack(poses, def) // §16
  return [...jumps, ...collisions(poses, def, BODY_PAIRS, 'collision', COLL_MIN), ...collisions(poses, def, [HAND_PAIR], 'handTouch', HAND_MIN),
    ...(feet ? [...footSlips(feet), ...frictionItems(feet)] : [])]
}

// 자가충돌 (§14, user: 5 mm · 2 frames · 손×손 apart at 20 mm): frames where a pair overlaps more than `min` mm, grouped like the
// jumps (COLL_GAP), kept when at least COLL_FRAMES frames overlap. Most severe first. G1 only.
export const COLL_MIN = 5, HAND_MIN = 20, COLL_FRAMES = 2, COLL_GAP = 6
function collisions(poses: Pose[], def: RobotDef, pairs: [string, string][], kind: 'collision' | 'handTouch', min: number): Suspect[] {
  const d = pairDepths(poses, def, pairs, min) // under `min`: only known to be under it
  if (!d) return []
  const frames = d.map((row, t) => (row.some(x => x > min) ? t : -1)).filter(t => t >= 0), groups: number[][] = []
  for (const t of frames) { const g = groups[groups.length - 1]; if (g && t - g[g.length - 1] <= COLL_GAP) g.push(t); else groups.push([t]) }
  return groups.filter(g => g.length >= COLL_FRAMES).map(g => {
    const best = new Map<number, number>() // pair -> deepest
    let worst = g[0], depth = -Infinity
    for (const t of g) d[t].forEach((x, i) => {
      if (x <= min) return
      best.set(i, Math.max(best.get(i) ?? -Infinity, x))
      if (x > depth) { depth = x; worst = t }
    })
    const ps = [...best].sort((a, b) => b[1] - a[1]).map(([i]) => pairs[i])
    return { kind, from: g[0], to: g[g.length - 1], worst, joints: [], parts: ps.map(pairName), speed: 0, ratio: 0, jump: 0, score: 0, atLimit: false, pairs: ps, depth }
  }).sort((a, b) => b.depth! - a.depth!)
}

/** 구간 지표 of a collision / handTouch item: overlap depth in mm (the deepest of its pairs) at each frame around it. */
export function collisionSeries(poses: Pose[], def: RobotDef, s: Suspect): { from: number; values: number[] } {
  const from = Math.max(0, s.from - CONTEXT), to = Math.min(poses.length - 1, s.to + CONTEXT)
  const d = pairDepths(poses.slice(from, to + 1), def, s.pairs ?? []) ?? []
  return { from, values: d.map(row => Math.max(0, ...row)) }
}

/** 구간 지표: frames [from − CONTEXT, to + CONTEXT] clamped, value = the highest speed / limit of the item's joints at each frame. */
export function itemSeries(poses: Pose[], def: RobotDef, s: Suspect): { from: number; values: number[] } {
  const from = Math.max(1, s.from - CONTEXT), to = Math.min(poses.length - 1, s.to + CONTEXT)
  const idx = s.joints.map(n => def.joints.findIndex(j => j.name === n)).filter(i => i >= 0)
  const values: number[] = []
  for (let t = from; t <= to; t++) values.push(Math.max(0, ...idx.map(j => {
    const lim = def.joints[j].velocity
    return lim > 0 ? Math.abs(poses[t].q[j] - poses[t - 1].q[j]) * FPS / lim : 0
  })))
  return { from, values }
}
