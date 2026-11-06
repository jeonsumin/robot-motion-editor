import { posesToClip } from '../export/importCsv'
import { rebasePose, type Pose, type RobotDefs } from '../model/pose'
import { quatYaw } from '../model/rootMath'
import { applyXf, blendPose, type Xf } from '../model/sequence'
import type { Clip } from '../model/types'
import type { Block, LoopSpec } from './blocks'

export const SEAM = 5 // source frames blended after each loop seam
const MAX_LOOPS = 100 // Move ≈ 62m, Rotate ≈ 7200°; keeps a typo like 10000 from hanging the tab
const DEG = 180 / Math.PI
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a))

type LoopBlock = Extract<Block, { kind: 'loop' }>
const specOf = (b: LoopBlock, value: number): LoopSpec => b.id === 'move' ? b.spec : value >= 0 ? b.left : b.right

// Planar transform taking the loop's first frame onto its last: applyXf(a, d) has b's x, y and yaw.
function loopXf(a: Pose, b: Pose): Xf {
  const yaw = wrap(quatYaw(b.rootQuat) - quatYaw(a.rootQuat)), c = Math.cos(yaw), s = Math.sin(yaw)
  const [ax, ay] = a.rootPos
  return { x: b.rootPos[0] - (c * ax - s * ay), y: b.rootPos[1] - (s * ax + c * ay), yaw }
}
// d applied k times after `from`
function powXf(d: Xf, k: number, from: Xf = { x: 0, y: 0, yaw: 0 }): Xf {
  let out = from
  for (let i = 0; i < k; i++) {
    const c = Math.cos(d.yaw), s = Math.sin(d.yaw)
    out = { x: c * out.x - s * out.y + d.x, y: s * out.x + c * out.y + d.y, yaw: out.yaw + d.yaw }
  }
  return out
}

const dist = (a: Pose, b: Pose) => Math.hypot(b.rootPos[0] - a.rootPos[0], b.rootPos[1] - a.rootPos[1])
const turn = (a: Pose, b: Pose) => wrap(quatYaw(b.rootQuat) - quatYaw(a.rootQuat)) * DEG

// n loops so that head + n·loop + tail lands nearest `value`; actual = what that clip really covers.
function loopPlan(b: LoopBlock, poses: Pose[], value: number) {
  const spec = specOf(b, value), [s, e] = spec.loop, h0 = poses[spec.head[0]], t0 = poses[spec.tail[0]], tl = poses[spec.tail[1] - 1]
  const d = loopXf(poses[s], poses[e])
  const m = b.id === 'move'
  const per = m ? dist(poses[s], poses[e]) : d.yaw * DEG
  const base = m ? dist(h0, poses[s]) + dist(t0, tl) : turn(h0, poses[s]) + turn(t0, tl)
  const n = Math.min(MAX_LOOPS, Math.max(1, Math.round((Math.abs(value) - Math.abs(base)) / Math.abs(per))))
  const actual = m ? dist(h0, applyXf(tl, powXf(d, n - 1))) : base + n * per
  return { spec, d, n, actual, base, per }
}

/** Loop count and the value the clip really covers (m or signed degrees); null for fixed blocks. base = what the start + stop parts
 *  of the log cover, per = one repeated step: the clip can only cover base + n × per (n ≥ 1), so the smallest is base + per. */
export function blockActual(block: Block, poses: Pose[], value: number): { n: number; actual: number; base: number; per: number } | null {
  if (block.kind !== 'loop') return null
  const { n, actual, base, per } = loopPlan(block, poses, value)
  return { n, actual, base, per }
}

export const EMPTY_FRAMES = 30
/** The Empty block: the GO2 rest pose (standing still) held `frames` 60fps frames at the origin; `hold` lets a piece's end drag it longer. */
export function emptyBlockClip(frames: number, defs: RobotDefs): Clip {
  const { q, z } = defs.go2.rest, pose: Pose = { rootPos: [0, 0, z], rootQuat: [0, 0, 0, 1], q }
  return { ...posesToClip(Array(frames).fill(pose), 60, 'go2', defs, `Empty_${frames}f`), hold: true }
}
/** The 목록's Empty clip (every Empty piece shares it, user), or a new 30-frame one. */
export const emptyClipFor = (clips: Record<string, Clip>, defs: RobotDefs) => Object.values(clips).find(c => c.hold && c.name !== '걷기' /* store WALK_CLIP: the 걷기 pieces' clip */) ?? emptyBlockClip(EMPTY_FRAMES, defs)

/** Loop blocks: head + loop × n + tail source poses (n from `value`, as `blockActual`); fixed blocks: `poses`. */
export function blockPoses(block: Block, poses: Pose[], value: number): Pose[] {
  if (block.kind !== 'loop') return poses
  const { spec, d, n } = loopPlan(block, poses, value)
  const [s, e] = spec.loop
  const out = poses.slice(spec.head[0], spec.head[1])
  let prev = powXf(d, 0), xk = prev
  for (let k = 0; k < n; k++) {
    if (k > 0) { prev = xk; xk = powXf(d, 1, xk) }
    poses.slice(s, e).forEach((p, i) => {
      const cur = applyXf(p, xk)
      out.push(k > 0 && i < SEAM ? blendPose(applyXf(poses[e + i], prev), cur, (i + 1) / (SEAM + 1)) : cur)
    })
  }
  // the tail continues the last loop copy (d^(n-1)), as poses[e..] continue poses[s..e)
  for (const p of poses.slice(spec.tail[0], spec.tail[1])) out.push(applyXf(p, xk))
  return out
}

/** Source poses (at `fps`) -> 60fps GO2 clip starting at the origin. Loop blocks: head + loop × n + tail. */
export function buildBlockClip(block: Block, poses: Pose[], fps: number, value: number, defs: RobotDefs): Clip {
  const out = blockPoses(block, poses, value), origin = out[0]
  const actual = block.kind === 'loop' ? loopPlan(block, poses, value).actual : 0
  const name = block.kind !== 'loop' ? block.label : block.id === 'move' ? `Move_${+actual.toFixed(1)}m` : `Rotate_${Math.round(actual)}deg`
  return posesToClip(out.map(p => rebasePose(p, origin)), fps, 'go2', defs, name)
}
