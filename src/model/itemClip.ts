import { evalCurve, makeKey } from './curve'
import type { RobotDefs } from './pose'
import type { Clip, Curve, Item, Key, Project } from './types'
import type { RobotDef } from '../robot/types'
import { seamLen, seamOf, seamOffset, stepOn, type Seam } from './seam'
import { boundaryPlan, nextTouching, prevTouching, standAt, stepFrames, type StepStatus } from './transition'
import { feetTrack } from '../review/feet'
import { evaluateClip, type Pose } from './pose'
import { eulerToQuat, nearestAngle, quatToEuler, quatYaw } from './rootMath'
import { feetOf, makeWalk, minWalkFrames, standPose, type WalkReport } from './walk'
import { applyXf, sortedItems, stitchXf } from './sequence'

// 조각 수정 층: Item.offset holds per-channel delta curves in clip frames (joints rad, root m/rad). The piece plays
// clip + offset; the shared clip is never touched. Spec docs/superpowers/specs/2026-10-13-piece-offset-design.md.

export const offsetKeyCount = (it: Item) => Object.values(it.offset ?? {}).reduce((n, c) => n + c.keys.length, 0)

/** The clip with `offset` added on its channels: one linear key per frame on the offset channels (joints clamped to the
 * URDF limits), every other channel shared with `clip`. Evaluated at integer frames it equals base + offset exactly. */
export function bakeOffset(clip: Clip, def: RobotDef, offset: Record<string, Curve>): Clip {
  const channels = { ...clip.channels }
  for (const [n, oc] of Object.entries(offset)) {
    if (!oc.keys.length) continue
    const base = clip.channels[n] ?? { keys: [] }, fb = n === 'root.z' ? def.standingHeight : 0
    const j = def.joints.find(j => j.name === n)
    const keys: Key[] = []
    for (let f = 0; f < clip.length; f++) {
      const v = evalCurve(base, f, fb) + evalCurve(oc, f, 0)
      keys.push(makeKey(f, j ? Math.min(Math.max(v, j.lower), j.upper) : v, 'linear'))
    }
    channels[n] = { keys }
  }
  return { ...clip, channels }
}

// Memo per offset object and clip: a project is immutable per edit, so the bake is redone only after an edit.
const cache = new WeakMap<Record<string, Curve>, WeakMap<Clip, Clip>>()

/** The clip a motion item plays: its clip, plus the item's 수정 층 when it has one (unless set to 원본 사용), plus — GO2 — the
 * 이음매 보정 at its start and the 발 걸음 이음매 legs at both of its ends. undefined for an unknown clip. Playback, CSV, physics
 * and the lead-in all use this, so what plays is what exports. */
export function itemClip(p: Project, defs: RobotDefs, it: Item): Clip | undefined {
  const base = seamedClip(p, defs, it)
  if (!base || base.robot !== 'go2') return base
  let m = stepCache.get(p)
  if (!m) stepCache.set(p, m = new WeakMap())
  if (m.has(it)) return m.get(it)
  const legs = new Map<number, number[]>()
  const head = boundaryStep(p, defs, it), next = nextTouching(p, it), tail = next && boundaryStep(p, defs, next)
  if (head?.status.kind === 'ok') for (const [f, q] of head.b) legs.set(f, q)
  if (tail?.status.kind === 'ok') for (const [f, q] of tail.a) legs.set(f, q)
  const r = legs.size ? bakeFrames(base, defs.go2, legs) : base
  m.set(it, r)
  return r
}
const stepCache = new WeakMap<Project, WeakMap<Item, Clip>>()

/** The clip a piece plays without the 발 걸음 이음매: its 수정본 (or 원본) plus, GO2, the 이음매 보정 at its start. */
export function seamedClip(p: Project, defs: RobotDefs, it: Item): Clip | undefined {
  if (it.walk) return walkOf(p, defs, it)?.clip // a 걷기 piece is made whole from its neighbours: no seam, no 수정 층
  const base = it.use === 'original' ? baseClip(p, defs, it.refId) : editedClip(p, defs, it)
  if (!base || base.robot !== 'go2') return base
  let m = seamCache.get(p)
  if (!m) seamCache.set(p, m = new WeakMap())
  if (m.has(it)) return m.get(it)
  // GO2 이음매 보정 with the piece ending where this one starts (that piece as it plays without the 발 걸음 legs: they only
  // change legs inside both pieces' still frames, and the legs there are solved again anyway)
  const s = seamOf(p, defs, it, base, prev => seamedClip(p, defs, prev))
  const r = s ? bakeOffset(base, defs.go2, seamOffset(it, s)) : base
  m.set(it, r)
  return r
}
// Per project (immutable per edit) and item object: a seam depends on the piece before, so it is redone after every edit.
const seamCache = new WeakMap<Project, WeakMap<Item, Clip>>()

/** The 이음매 보정 of a piece as it plays, for the lanes: its length and whether the gap it closes is too big to look natural. */
export function itemSeam(p: Project, defs: RobotDefs, it: Item): Seam | null {
  if (it.walk) return null
  const base = it.use === 'original' ? baseClip(p, defs, it.refId) : editedClip(p, defs, it)
  return base ? seamOf(p, defs, it, base, prev => seamedClip(p, defs, prev)) : null
}

export interface BoundaryStep { status: StepStatus; a: Map<number, number[]>; b: Map<number, number[]> }
const stepPlans = new WeakMap<Project, WeakMap<Item, BoundaryStep | null>>()
/** The GO2 발 걸음 이음매 at the start of `it` (§19): null when it is off there, or `it` is not a GO2 piece starting where another
 * one ends. Its status is what the boundary marks show; `a`/`b` are the legs laid over the two pieces when it is ok. */
export function boundaryStep(p: Project, defs: RobotDefs, it: Item): BoundaryStep | null {
  let m = stepPlans.get(p)
  if (!m) stepPlans.set(p, m = new WeakMap())
  if (m.has(it)) return m.get(it)!
  let r: BoundaryStep | null = null
  const prev = stepOn(p, it) && !it.walk ? prevTouching(p, it) : null // a 걷기 piece makes its own first steps
  const A = prev && seamedClip(p, defs, prev), B = prev && seamedClip(p, defs, it)
  const rawB = prev && (it.use === 'original' ? baseClip(p, defs, it.refId) : editedClip(p, defs, it))
  if (prev && A && B && rawB && A.robot === 'go2' && B.robot === 'go2') {
    if (!itemSeam(p, defs, it) && seamLen(it) > 0 && sameBoundary(p, defs, prev, it)) r = { status: { kind: 'same' }, a: new Map(), b: new Map() }
    else {
      const head = boundaryStep(p, defs, prev) // the earlier boundary keeps its frames of `prev`
      const aFrom = head?.status.kind === 'ok' && head.b.size ? Math.max(...head.b.keys()) + 1 : prev.trimIn
      const plan = boundaryPlan(defs, prev, it, A, B, rawB, itemSeam(p, defs, it)?.n ?? 0, aFrom)
      r = { status: plan.status, ...stepFrames(prev, it, plan.poses) }
    }
  }
  m.set(it, r)
  return r
}
// S7: the seam turned itself off because the two boundary frames are equal (seamOf returns null for it)
function sameBoundary(p: Project, defs: RobotDefs, prev: Item, it: Item): boolean {
  const A = seamedClip(p, defs, prev), B = it.use === 'original' ? baseClip(p, defs, it.refId) : editedClip(p, defs, it)
  if (!A || !B) return false
  const def = defs.go2, chans = ['root.z', 'root.roll', 'root.pitch', ...def.joints.map(j => j.name)]
  return chans.every(ch => {
    const fb = ch === 'root.z' ? def.standingHeight : 0, a = A.channels[ch], b = B.channels[ch]
    const va = a ? evalCurve(a, prev.trimOut - 1, fb) : fb, vb = b ? evalCurve(b, it.trimIn, fb) : fb
    return Math.abs(va - vb) <= 1e-6
  })
}

/** The clip with its joints replaced on the given frames (one linear key per frame on every changed joint channel). */
function bakeFrames(clip: Clip, def: RobotDef, frames: Map<number, number[]>): Clip {
  const channels = { ...clip.channels }
  def.joints.forEach((j, i) => {
    const base = clip.channels[j.name] ?? { keys: [] }
    const keys: Key[] = []
    for (let f = 0; f < clip.length; f++) {
      const q = frames.get(f)
      keys.push(makeKey(f, q ? Math.min(Math.max(q[i], j.lower), j.upper) : evalCurve(base, f, 0), 'linear'))
    }
    channels[j.name] = { keys }
  })
  return { ...clip, channels }
}

export const curveKeyCount = (o: Record<string, Curve> | undefined) => Object.values(o ?? {}).reduce((n, c) => n + c.keys.length, 0)

// Memo per clip object: an edit of the clip (or its 수정 층) makes a new clip object, so the bake is redone only then.
const baseCache = new WeakMap<Clip, Clip>()
/** The clip as an asset: its channels plus its 클립 수정 층 (Clip.offset, joints clamped), the result without `offset`. The original
 * object when there is no 수정 층. Every piece plays this under its own 수정 층; the clip edit mode shows and saves it. */
export function baseClip(p: Project, defs: RobotDefs, clipId: string): Clip | undefined {
  const clip = p.clips[clipId]
  if (!clip || !curveKeyCount(clip.offset)) return clip
  let r = baseCache.get(clip)
  if (!r) { const { offset, ...plain } = bakeOffset(clip, defs[clip.robot], clip.offset!); void offset; baseCache.set(clip, r = plain) }
  return r
}

/** The piece's 수정본 (baseClip + its 수정 층) whichever side it uses: what the editors (inspector, graph, gizmo) and the 수정본 pane show. */
export function editedClip(p: Project, defs: RobotDefs, it: Item): Clip | undefined {
  const clip = baseClip(p, defs, it.refId)
  if (!clip || !it.offset || !offsetKeyCount(it)) return clip
  let m = cache.get(it.offset)
  if (!m) cache.set(it.offset, m = new WeakMap())
  let r = m.get(clip)
  if (!r) m.set(clip, r = bakeOffset(clip, defs[clip.robot], it.offset))
  return r
}

// Shallow project copy where one item uses the given side ('original' or the 수정본); memoized per project, so a view can
// evaluate "this piece as the original" every frame without copying again. The stored project is never touched.
const useCache = new WeakMap<Project, Map<string, Project>>()
export function withUse(p: Project, itemId: string, use: Item['use'] | null): Project {
  let m = useCache.get(p)
  if (!m) useCache.set(p, m = new Map())
  const k = `${itemId}:${use ?? ''}`
  let r = m.get(k)
  if (!r) m.set(k, r = { ...p, sequence: { ...p.sequence, tracks: p.sequence.tracks.map(t => t.items.some(i => i.id === itemId)
    ? { ...t, items: t.items.map(i => { if (i.id !== itemId) return i; const n = { ...i }; if (use) n.use = use; else delete n.use; return n }) } : t) } })
  return r
}

// ---- 걷기 블록 (§20) ----
export interface WalkPlayed { clip: Clip; report: WalkReport; start: Pose; end: Pose /* track frame (the actor's placement not applied) */ }
/** 기본서기 over the feet of `p` (the 기본서기 경유 전이 조각 before a walk ends in it; the floor as bridge.ts finds it). */
export function standOver(def: RobotDef, p: Pose): Pose {
  const ft = feetTrack([p], def), floor = ft ? Math.min(...ft.at.flatMap(a => a.map(q => q[2]))) : 0
  return standAt(def, p, floor)
}
const walkCache = new WeakMap<Project, WeakMap<Item, WalkPlayed | null>>()
const walkMemo = new Map<string, { poses: Pose[]; report: WalkReport }>()

/** The walk a 걷기 piece plays (track frame; its stitch transform is the identity): from the pose the piece before it is in when it
 * starts (or 차렷 at the track origin when it is first) to its target on the stage, ending in the next piece's first pose (when that
 * stands on four feet; else 기본서기). null when `it` is not a GO2 걷기 piece on a motion track. */
export function walkOf(p: Project, defs: RobotDefs, it: Item): WalkPlayed | null {
  if (!it.walk) return null
  let m = walkCache.get(p)
  if (!m) walkCache.set(p, m = new WeakMap())
  if (m.has(it)) return m.get(it)!
  m.set(it, null) // (re-entered while being made: nothing yet)
  const track = p.sequence.tracks.find(t => t.kind === 'motion' && t.items.some(i => i.id === it.id))
  const actor = track && p.actors.find(a => a.id === track.actorId), base = p.clips[it.refId]
  if (!track || !actor || actor.robot !== 'go2' || !base || base.robot !== 'go2') return null
  const def = defs.go2, items = sortedItems(track), k = items.findIndex(i => i.id === it.id), prev = items[k - 1], next = items[k + 1]
  let start: Pose = { rootPos: [0, 0, def.rest.z], rootQuat: [0, 0, 0, 1], q: [...def.rest.q] }
  if (prev) {
    const pc = itemClip(p, defs, prev), xf = stitchXf(p, defs, track, prev.id)
    const pcf = Math.min(Math.max(it.start - prev.start + prev.trimIn, prev.trimIn), prev.trimOut - 1)
    if (pc && xf) start = applyXf(evaluateClip(pc, def, pcf), xf)
  }
  // the target and the end heading in the track frame (the actor's placement taken off)
  const pl = actor.placement, c = Math.cos(-pl.yaw), s = Math.sin(-pl.yaw), dx = it.walk.to[0] - pl.x, dy = it.walk.to[1] - pl.y
  const tx = c * dx - s * dy, ty = s * dx + c * dy, y0 = quatYaw(start.rootQuat)
  const dir = Math.hypot(tx - start.rootPos[0], ty - start.rootPos[1]) > 0.05 ? Math.atan2(ty - start.rootPos[1], tx - start.rootPos[0]) : y0
  const yawEnd = it.walk.face === 'audience' ? -pl.yaw : it.walk.face === 'travel' ? (it.walk.yaw !== undefined ? it.walk.yaw - pl.yaw : dir) : y0
  // the end pose: the next piece's first pose there (so it carries on without a seam), else 기본서기
  const nc = next && (next.use === 'original' ? baseClip(p, defs, next.refId) : editedClip(p, defs, next))
  const n0 = nc && !next.walk ? evaluateClip(nc, def, next.trimIn) : null
  const floor = feetOf(def, start).low
  let end: Pose
  if (n0 && feetOf(def, n0).standing) { const [r, pt] = quatToEuler(n0.rootQuat); end = { rootPos: [tx, ty, n0.rootPos[2]], rootQuat: eulerToQuat(r, pt, yawEnd), q: [...n0.q] } }
  else end = standPose(def, tx, ty, yawEnd, floor)
  const n = it.trimOut - it.trimIn, slow = it.walk.slow ?? 'walk'
  const key = JSON.stringify([start, end, n, it.walk.face, slow])
  let w = walkMemo.get(key)
  if (!w) {
    w = makeWalk(def, start, end, n, it.walk.face, slow)
    if (walkMemo.size > 200) walkMemo.delete(walkMemo.keys().next().value!)
    walkMemo.set(key, w)
  }
  // 한계 초과 (§22, 안정성 우선): no walk that breaks the pose — it stands in its start pose (shown red, not exported)
  const held = w.report.tone === 'bad'
  const poses = [...Array.from({ length: it.trimIn }, () => start), ...(held ? Array.from({ length: n }, () => start) : w.poses)]
  const r: WalkPlayed = { clip: { ...posesClip(poses, def, base), length: Math.max(base.length, it.trimOut) }, report: held ? { ...w.report, held: true } : w.report, start, end }
  m.set(it, r)
  return r
}

/** Poses → the channels of `base` (one linear key per frame; roll, pitch, yaw unwrapped). */
function posesClip(poses: Pose[], def: RobotDef, base: Clip): Clip {
  const names = ['root.x', 'root.y', 'root.z', 'root.roll', 'root.pitch', 'root.yaw', ...def.joints.map(j => j.name)]
  const vals: number[][] = names.map(() => [])
  let prev: number[] | null = null
  for (const p of poses) {
    const e = quatToEuler(p.rootQuat), u: number[] = prev ? e.map((v, i) => nearestAngle(v, prev![i])) : e
    prev = u
    ;[...p.rootPos, ...u, ...p.q].forEach((v, i) => vals[i].push(v))
  }
  const channels: Clip['channels'] = {}
  names.forEach((nm, i) => { channels[nm] = { keys: vals[i].map((v, f) => makeKey(f, v, 'linear')) } })
  return { ...base, channels }
}

/** What a new 걷기 piece of `frames` frames at the end of `actorId`'s track (null = a new robot at the origin) would do — for the
 * 라이브러리 add panel: its start (stage) and its report. It ends standing in 기본서기 (nothing after it yet). */
export function walkPreview(p: Project, defs: RobotDefs, actorId: string | null, spec: { to: [number, number]; face: 'travel' | 'keep' | 'audience'; yaw?: number; slow?: 'walk' | 'after' | 'before' }, frames: number,
  viaStand = false /* after a 기본서기 경유 전이 조각 (it starts in 기본서기 over the last piece's feet) */): { start: Pose; report: WalkReport; minFrames: number | null } | null {
  const def = defs.go2, actor = actorId ? p.actors.find(a => a.id === actorId) : null
  if (actorId && (!actor || actor.robot !== 'go2')) return null
  const track = actor && p.sequence.tracks.find(t => t.kind === 'motion' && t.actorId === actor.id)
  const pl = actor?.placement ?? { x: 0, y: 0, yaw: 0 }
  let start: Pose = { rootPos: [0, 0, def.rest.z], rootQuat: [0, 0, 0, 1], q: [...def.rest.q] }
  const last = track && sortedItems(track).at(-1)
  if (track && last) {
    const lc = itemClip(p, defs, last), xf = stitchXf(p, defs, track, last.id)
    if (lc && xf) start = applyXf(evaluateClip(lc, def, last.trimOut - 1), xf)
    if (viaStand) start = standOver(def, start)
  }
  const c = Math.cos(-pl.yaw), s = Math.sin(-pl.yaw), dx = spec.to[0] - pl.x, dy = spec.to[1] - pl.y, tx = c * dx - s * dy, ty = s * dx + c * dy
  const y0 = quatYaw(start.rootQuat), dir = Math.hypot(tx - start.rootPos[0], ty - start.rootPos[1]) > 0.05 ? Math.atan2(ty - start.rootPos[1], tx - start.rootPos[0]) : y0
  const yawEnd = spec.face === 'audience' ? -pl.yaw : spec.face === 'travel' ? (spec.yaw !== undefined ? spec.yaw - pl.yaw : dir) : y0
  const end = standPose(def, tx, ty, yawEnd, feetOf(def, start).low)
  const n = Math.max(2, Math.round(frames)), key = JSON.stringify([start, end, n, spec.face, spec.slow ?? 'walk'])
  let w = walkMemo.get(key)
  if (!w) { w = makeWalk(def, start, end, n, spec.face, spec.slow ?? 'walk'); if (walkMemo.size > 200) walkMemo.delete(walkMemo.keys().next().value!); walkMemo.set(key, w) }
  return { start: applyXf(start, pl), report: w.report, minFrames: w.report.tone === 'bad' ? minWalkFrames(def, start, end, n, spec.face, spec.slow ?? 'walk') : null }
}

/** The 걷기 pieces among `itemIds` that are 한계 초과 (they stand instead of walking): CSV · RL 학습용 내보내기 refuses them (§22). */
export function redWalks(p: Project, defs: RobotDefs, itemIds: string[]): { itemId: string; text: string }[] {
  const out: { itemId: string; text: string }[] = []
  for (const it of p.sequence.tracks.flatMap(t => t.items)) {
    if (!it.walk || !itemIds.includes(it.id)) continue
    const w = walkOf(p, defs, it)
    if (w?.report.tone === 'bad') out.push({ itemId: it.id, text: w.report.reasons.filter(r => r.tone === 'bad').map(r => r.text).join(' · ') })
  }
  return out
}
