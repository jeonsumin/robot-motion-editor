import { evaluateClip, type Pose, type RobotDefs } from './pose'
import { quatMul, quatYaw, yawQuat, type Quat } from './rootMath'
import type { Clip, Item, Project, Track } from './types'
import { itemClip } from './itemClip'

export interface Xf { x: number; y: number; yaw: number } // clip root -> track coords

export const itemLen = (it: Item): number => it.trimOut - it.trimIn
export const sortedItems = (track: Track): Item[] => [...track.items].sort((a, b) => a.start - b.start)

/** Name tag of a cut piece: "#n · F<from>–<to>" = its order among the track's pieces of the same clip (by start, like the
 * CSV file's _n) and the clip frames it plays; '' when the item is that clip's only piece on the track. */
export function pieceTag(t: Track, it: Item): string {
  const ps = sortedItems(t).filter(i => i.refId === it.refId)
  return ps.length > 1 ? `#${ps.findIndex(i => i.id === it.id) + 1} · F${it.trimIn}–${it.trimOut}` : ''
}
/** Project name for piece names: the saved file name without its extension, 'Untitled' before the first save. */
export const projectTitle = (fileName: string | null) => fileName?.replace(/(\.mproj|(\.motion)?\.json)$/i, '') || 'Untitled'
/** Display name of an item: GO2 = "<project>-GO2-<n>" for every piece (n = start order on its track, user: library blocks too);
 * G1 = "<project>-G1-<n>" for a cut piece (n = pieceTag's #n), the clip name for a lone item. */
export const pieceName = (t: Track, it: Item, clip: Pick<Clip, 'name' | 'robot'> | undefined, project: string) =>
  clip?.robot === 'go2' ? `${project}-GO2-${sortedItems(t).findIndex(i => i.id === it.id) + 1}`
    : pieceTag(t, it) ? `${project}-${clip?.robot.toUpperCase() ?? ''}-${pieceTag(t, it).split(' · ')[0].slice(1)}` : clip?.name ?? ''

// `items` must be sorted by start. Item + clip frame for a stage frame: before first item -> its trimIn; gap/after -> previous item's last frame.
export function resolve(items: Item[], frame: number): { item: Item; cf: number } | null {
  let prev: Item | null = null
  for (const it of items) {
    if (frame < it.start) return prev ? { item: prev, cf: prev.trimOut - 1 } : { item: it, cf: it.trimIn }
    if (frame < it.start + itemLen(it)) return { item: it, cf: frame - it.start + it.trimIn }
    prev = it
  }
  return prev ? { item: prev, cf: prev.trimOut - 1 } : null
}

export function applyXf(pose: Pose, xf: Xf): Pose {
  const c = Math.cos(xf.yaw), s = Math.sin(xf.yaw)
  const [x, y, z] = pose.rootPos
  return {
    rootPos: [c * x - s * y + xf.x, s * x + c * y + xf.y, z],
    rootQuat: quatMul(yawQuat(xf.yaw), pose.rootQuat),
    q: pose.q,
  }
}

export function slerp(a: Quat, b: Quat, t: number): Quat {
  let dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]
  const bb: Quat = dot < 0 ? [-b[0], -b[1], -b[2], -b[3]] : b
  dot = Math.abs(dot)
  let ka = 1 - t, kb = t
  if (dot < 0.9995) { // else nearly parallel: lerp
    const th = Math.acos(dot), sn = Math.sin(th)
    ka = Math.sin((1 - t) * th) / sn
    kb = Math.sin(t * th) / sn
  }
  const r = a.map((v, i) => ka * v + kb * bb[i]) as Quat
  const n = Math.hypot(...r)
  return r.map(v => v / n) as Quat
}

export function blendPose(a: Pose, b: Pose, w: number): Pose {
  const l = (x: number, y: number) => x + (y - x) * w
  return {
    rootPos: [l(a.rootPos[0], b.rootPos[0]), l(a.rootPos[1], b.rootPos[1]), l(a.rootPos[2], b.rootPos[2])],
    rootQuat: slerp(a.rootQuat, b.rootQuat, w),
    q: a.q.map((v, i) => l(v, b.q[i])),
  }
}

const cache = new WeakMap<Project, Map<string, Stitch>>() // Project is immutable per edit

/** One frame on at the last velocity (x, y, yaw wrapped): where a piece cut onto `last` starts (see stitchTransforms). */
export const advanceXf = (prev: Xf, last: Xf): Xf => ({
  x: 2 * last.x - prev.x, y: 2 * last.y - prev.y,
  yaw: last.yaw + Math.atan2(Math.sin(last.yaw - prev.yaw), Math.cos(last.yaw - prev.yaw)),
})

type Stitch = { out: Map<string, Xf>; items: Item[]; i: number; busy: boolean }
const stitchState = (p: Project, track: Track): Stitch => {
  let perTrack = cache.get(p)
  if (!perTrack) cache.set(p, perTrack = new Map())
  let st = perTrack.get(track.id)
  if (!st) perTrack.set(track.id, st = { out: new Map(), items: sortedItems(track), i: 0, busy: false })
  return st
}
/** Work the stitch out up to item index `upto` (inclusive). A 걷기 piece (§20) is played in track coordinates (its own clip is
 * made from where the piece before it ends), so its transform is the identity and it is never evaluated here — which lets the
 * walk ask for the transforms of the pieces before it while they are being worked out. */
function advance(p: Project, defs: RobotDefs, track: Track, st: Stitch, upto: number) {
  if (st.busy) return // re-entered (a walk asking while the pieces after it are worked out): what is there is all it needs
  st.busy = true
  try {
    const actor = p.actors.find(a => a.id === track.actorId), { out, items } = st
    for (; st.i <= Math.min(upto, items.length - 1); st.i++) {
      const it = items[st.i], prev = st.i > 0 ? items[st.i - 1] : null
      let xf: Xf = { x: 0, y: 0, yaw: 0 }
      if (!it.walk && prev && actor) {
        const clip = itemClip(p, defs, it), prevClip = itemClip(p, defs, prev)
        if (clip && prevClip) {
          const def = defs[actor.robot]
          const pcf = Math.min(Math.max(it.start - prev.start + prev.trimIn, prev.trimIn), prev.trimOut - 1)
          const P = applyXf(evaluateClip(prevClip, def, pcf), out.get(prev.id)!)
          let [px, py] = P.rootPos, pyaw = quatYaw(P.rootQuat)
          if (it.start - prev.start >= itemLen(prev)) {
            // cut (no overlap): B's first frame follows A's last, so advance one frame at A's last velocity — else the root stalls a frame
            const P0 = applyXf(evaluateClip(prevClip, def, Math.max(pcf - 1, prev.trimIn)), out.get(prev.id)!)
            ;({ x: px, y: py, yaw: pyaw } = advanceXf({ x: P0.rootPos[0], y: P0.rootPos[1], yaw: quatYaw(P0.rootQuat) }, { x: px, y: py, yaw: pyaw }))
          }
          const C = evaluateClip(clip, def, it.trimIn)
          const yaw = pyaw - quatYaw(C.rootQuat)
          const c = Math.cos(yaw), s = Math.sin(yaw)
          xf = { x: px - (c * C.rootPos[0] - s * C.rootPos[1]), y: py - (s * C.rootPos[0] + c * C.rootPos[1]), yaw }
        }
      }
      out.set(it.id, xf)
    }
  } finally { st.busy = false }
}
export function stitchTransforms(p: Project, defs: RobotDefs, track: Track): Map<string, Xf> {
  const st = stitchState(p, track)
  advance(p, defs, track, st, Infinity)
  return st.out
}
/** The stitch transform of one piece, working out only the pieces up to it (a 걷기 piece needs the one before it). */
export function stitchXf(p: Project, defs: RobotDefs, track: Track, itemId: string): Xf | undefined {
  const st = stitchState(p, track), k = st.items.findIndex(i => i.id === itemId)
  if (k >= 0) advance(p, defs, track, st, k)
  return st.out.get(itemId)
}

// Track rule: start >= 0, distinct starts, only neighbours overlap (never i and i+2), overlap <= min(len)-1.
export function validTrack(items: Item[]): boolean {
  const s = [...items].sort((a, b) => a.start - b.start)
  if (s.some(it => it.start < 0 || it.trimIn < 0 || itemLen(it) < 1)) return false
  for (let i = 0; i + 1 < s.length; i++) {
    const end = s[i].start + itemLen(s[i])
    if (s[i + 1].start === s[i].start) return false
    if (end - s[i + 1].start > Math.min(itemLen(s[i]), itemLen(s[i + 1])) - 1) return false
    if (i + 2 < s.length && end > s[i + 2].start) return false
  }
  return true
}

// Inverse of world = placement . xf . clipRoot: a world root pose -> clip-local root channels.
export function worldToClipRoot(world: { pos: [number, number, number]; quat: Quat }, placement: Xf, xf: Xf) {
  const un = (v: [number, number], t: Xf): [number, number] => {
    const dx = v[0] - t.x, dy = v[1] - t.y, c = Math.cos(t.yaw), s = Math.sin(t.yaw)
    return [c * dx + s * dy, -s * dx + c * dy]
  }
  const [x, y] = un(un([world.pos[0], world.pos[1]], placement), xf)
  const [qx, qy, qz, qw] = quatMul(yawQuat(-xf.yaw), quatMul(yawQuat(-placement.yaw), world.quat))
  return {
    x, y, z: world.pos[2],
    roll: Math.atan2(2 * (qw * qx + qy * qz), 1 - 2 * (qx * qx + qy * qy)),
    pitch: Math.asin(Math.max(-1, Math.min(1, 2 * (qw * qy - qz * qx)))),
    yaw: Math.atan2(2 * (qw * qz + qx * qy), 1 - 2 * (qy * qy + qz * qz)),
  }
}

// Stage-only 숨기기 of pieces: hidden when every piece covering `frame` is hidden (both in a crossfade); in a gap or past
// the end, the piece the robot holds (as `resolve`). Evaluation and export ignore it.
export function hiddenAt(track: Track, frame: number): boolean {
  const s = sortedItems(track), cover = s.filter(i => frame >= i.start && frame < i.start + itemLen(i))
  return cover.length ? cover.every(i => i.hidden) : !!resolve(s, frame)?.item.hidden
}

// True when `frame` lies in a crossfade overlap of the track.
export function inCrossfade(track: Track, frame: number): boolean {
  const s = sortedItems(track)
  return s.some((a, i) => i + 1 < s.length && frame >= s[i + 1].start && frame < a.start + itemLen(a))
}
