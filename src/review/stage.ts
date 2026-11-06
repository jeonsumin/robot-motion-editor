// 검수 목록 무대 이탈 (수정변동사항.md §18, the Go2 Dance Studio's 사용 구역 check): frames where a piece on the timeline reaches past the
// 무대 (stage size of the project, centred on the origin: depth along x with the audience at +x, width along y). The robot's reach is
// its link hulls (collide.floorBox: the arms of a G1 too, not just its body), placed as it plays — 이어붙이기 and 무대 배치 included.
// Only pieces (a library clip has no place on the stage). Nothing is moved: the item says how far, and which 배치 change would bring
// the piece in (and how many other pieces of the robot that would push out) — set by hand (user: 수기 조정).
// Not a verdict kind: a verdict is saved on the clip's frames, but where a piece stands depends on the piece (and the ones before it).
import { stageOf } from '../model/defaults'
import { evaluateClip, type Pose } from '../model/pose'
import { itemClip } from '../model/itemClip'
import { placeItemPose, type RobotDefs } from '../model/evaluate'
import type { Item, Project } from '../model/types'
import { floorBox } from './collide'
import { GROUP_GAP, type Suspect } from './detect'

export const STAGE_TOL = 0.01 // m past the edge before it counts (the hull is a little fatter than the mesh; a few mm is noise)
export type Box = [number, number, number, number] // min x, max x, min y, max y (m, world)
export const SIDES = ['back', 'front', 'right', 'left'] as const // past min x, max x, min y, max y
export type Side = typeof SIDES[number]
export const SIDE_KO: Record<Side, string> = { front: '객석 쪽', back: '무대 뒤쪽', left: '객석에서 볼 때 왼쪽', right: '객석에서 볼 때 오른쪽' }

/** How far past each edge (m, ≤ 0 = inside) the box is: [back, front, right, left] (SIDES order). */
export function pastEdges(b: Box, p: Project): [number, number, number, number] {
  const { width, depth } = stageOf(p), hx = depth / 2, hy = width / 2
  return [-hx - b[0], b[1] - hx, -hy - b[2], b[3] - hy]
}

/** Each frame's reach of a piece (its own frames trimIn..trimOut, as it plays on the stage). */
export function itemBoxes(p: Project, defs: RobotDefs, it: Item): Box[] {
  const clip = itemClip(p, defs, it)
  if (!clip) return []
  const def = defs[clip.robot], out: Box[] = []
  for (let f = it.trimIn; f < it.trimOut; f++) out.push(floorBox(placeItemPose(p, defs, it.id, evaluateClip(clip, def, f) as Pose), def))
  return out
}

const span = (bs: Box[]): Box => bs.reduce<Box>((a, b) => [Math.min(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.max(a[3], b[3])], [Infinity, -Infinity, Infinity, -Infinity])

/** The smallest 배치 change (dx, dy in m) that brings a reach `b` inside the stage (STAGE_TOL kept), or null when it is wider than the stage. */
export function moveInside(b: Box, p: Project): [number, number] | null {
  const { width, depth } = stageOf(p), hx = depth / 2 - STAGE_TOL, hy = width / 2 - STAGE_TOL
  const fit = (lo: number, hi: number, h: number) => (hi - lo > 2 * h ? null : lo < -h ? -h - lo : hi > h ? h - hi : 0)
  const dx = fit(b[0], b[1], hx), dy = fit(b[2], b[3], hy)
  return dx === null || dy === null ? null : [dx, dy]
}

export interface StageCheck {
  items: Suspect[] // kind 'stage', one per side and run of frames (frames of the piece, 0-based)
  boxes: Box[] // the piece's reach per frame (구간 지표)
  move: [number, number] | null // 배치 change bringing the whole piece in (null = the piece's path is wider than the stage)
  others: number // other pieces of the same robot that this change would push out (that are inside now)
}

/** 무대 이탈 of piece `itemId` (null: not a piece on a motion track). */
export function stageCheck(p: Project, defs: RobotDefs, itemId: string): StageCheck | null {
  const track = p.sequence.tracks.find(t => t.kind === 'motion' && t.items.some(i => i.id === itemId))
  const it = track?.items.find(i => i.id === itemId)
  if (!track || !it) return null
  const boxes = itemBoxes(p, defs, it), items: Suspect[] = []
  SIDES.forEach((side, k) => {
    let cur: Suspect | null = null
    boxes.forEach((b, f) => {
      const v = pastEdges(b, p)[k]
      if (v <= STAGE_TOL) return
      if (cur && f - cur.to <= GROUP_GAP) cur.to = f
      else items.push(cur = { kind: 'stage', from: f, to: f, worst: f, joints: [], parts: [SIDE_KO[side]], speed: 0, ratio: 0, jump: 0, score: 0, atLimit: false, over: v, side })
      if (v > cur.over!) { cur.over = v; cur.worst = f }
    })
  })
  items.sort((a, b) => a.from - b.from)
  const move = items.length ? moveInside(span(boxes), p) : [0, 0] as [number, number]
  let others = 0
  if (items.length && move && (move[0] || move[1])) for (const o of track.items) {
    if (o.id === it.id) continue
    const s = span(itemBoxes(p, defs, o)), now = pastEdges(s, p), then = pastEdges([s[0] + move[0], s[1] + move[0], s[2] + move[1], s[3] + move[1]], p)
    if (Math.max(...now) <= STAGE_TOL && Math.max(...then) > STAGE_TOL) others++
  }
  return { items, boxes, move, others }
}

/** 구간 지표 of a 무대 이탈 item: cm past its edge per frame, CONTEXT frames either side. */
export function stageSeries(c: StageCheck, s: Suspect, p: Project, context: number): { from: number; values: number[] } {
  const k = SIDES.indexOf(s.side!), from = Math.max(0, s.from - context), to = Math.min(c.boxes.length - 1, s.to + context)
  return { from, values: c.boxes.slice(from, to + 1).map(b => Math.max(0, pastEdges(b, p)[k]) * 100) }
}
