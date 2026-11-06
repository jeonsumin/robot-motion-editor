// 검수 목록: what can be checked — the motion pieces on the timeline (as they play: clip + 클립/조각 수정 층, trimIn..trimOut) and the
// clips in 목록 (클립 수정 층, whole length). GO2 Empty 블럭 (hold) is skipped: it stands still by design.
import type { Pose, RobotDefs } from '../model/pose'
import { baseClip, itemClip } from '../model/itemClip'
import { pieceName } from '../model/sequence'
import type { Project } from '../model/types'
import type { RobotKind } from '../robot/types'
import { clipPoses } from '../export/rlExport'

export interface ReviewTarget {
  key: string // 'item:<id>' | 'clip:<id>'
  kind: 'item' | 'clip'
  id: string // item id or clip id
  label: string
  robot: RobotKind
  firstFrame: number // sequence frame of pose 0 (item) / clip frame 0 (clip)
  clipFrom: number // clip frame of pose 0 (= trimIn for a piece): CSV row = clipFrom + index + 1
}

export function reviewTargets(p: Project, title: string): ReviewTarget[] {
  const out: ReviewTarget[] = []
  for (const t of p.sequence.tracks) {
    if (t.kind !== 'motion') continue
    const actor = p.actors.find(a => a.id === t.actorId)
    for (const it of [...t.items].sort((a, b) => a.start - b.start)) {
      const clip = p.clips[it.refId]
      if (!actor || !clip || clip.hold) continue
      out.push({ key: `item:${it.id}`, kind: 'item', id: it.id, label: `타임라인 · ${actor.name} · ${pieceName(t, it, clip, title)}`, robot: clip.robot, firstFrame: it.start, clipFrom: it.trimIn })
    }
  }
  for (const c of Object.values(p.clips)) {
    if (c.hold) continue
    out.push({ key: `clip:${c.id}`, kind: 'clip', id: c.id, label: `목록 클립 · ${c.name}`, robot: c.robot, firstFrame: 0, clipFrom: 0 })
  }
  return out
}

/** The frames of a target as they play, or null when it no longer exists. */
export function targetPoses(p: Project, defs: RobotDefs, t: ReviewTarget): Pose[] | null {
  if (t.kind === 'item') {
    const it = p.sequence.tracks.flatMap(x => x.items).find(i => i.id === t.id)
    const clip = it && itemClip(p, defs, it)
    return it && clip ? clipPoses(clip, defs[clip.robot], it.trimIn, it.trimOut) : null
  }
  const clip = baseClip(p, defs, t.id)
  return clip ? clipPoses(clip, defs[clip.robot], 0, clip.length) : null
}
