// RL 학습용 내보내기 (RL팀 요청, 수정변동사항.md §10). The usual exports stay as they are; this one is a separate option:
//  - root in the clip's own coordinates (the imported CSV's): no move to the origin, no yaw turn, no 무대 배치 / 이어붙이기.
//    수정 층 edits of the root (pelvis position / heading) ARE in it — they are part of the clip data, not of the placement.
//  - no 기본자세 (lead-in / 끝 기본자세): the piece's own frames only.
//  - an edits.json beside each CSV: the edited rows (1-based, inclusive, header excluded — csv_to_npz.py --frame_range).
//  - joint jump check: one joint > 25 rad/s frame to frame = shown (stressed within ±0.4 s of an edit boundary), > 50 = error.
import type { Pose, RobotDefs } from '../model/evaluate'
import { evaluateClip } from '../model/pose'
import { baseClip, itemClip } from '../model/itemClip'
import type { Clip, Item, Project } from '../model/types'
import type { RobotDef } from '../robot/types'
import { CSV_FPS, csvFileName, normalizedPose, posesToCsv } from './csv'
import { sha256 } from './sha256'
import { validatePoses, type Warning } from './validate'

export const JUMP_WARN = 25, JUMP_ERROR = 50 // rad/s, one joint, between neighbouring 60 fps frames (0.42 / 0.83 rad a frame)
export const SEAM_NEAR = 24 // frames: ±0.4 s around an edit range's first / last row
const LABEL = { g1: 'G1', go2: 'GO2' } as const

export type Range = [number, number] // 1-based CSV data rows, inclusive
export interface RlFile { name: string; text: string; warnings: Warning[]; ranges: Range[]; json: { name: string; text: string } }

/** Clip frames [a, b) as poses in the clip's own coordinates (what was imported, plus its edits), quaternions sign-continuous. */
export function clipPoses(clip: Clip, def: RobotDef, a: number, b: number): Pose[] {
  const out: Pose[] = []
  for (let f = a; f < b; f++) out.push(normalizedPose(evaluateClip(clip, def, f), out[out.length - 1]))
  return out
}

const poseDiff = (x: Pose, y: Pose) => {
  let d = 0
  for (let i = 0; i < 3; i++) d = Math.max(d, Math.abs(x.rootPos[i] - y.rootPos[i]))
  let dq = 0, dn = 0 // a quaternion and its negative are the same rotation
  for (let i = 0; i < 4; i++) { dq = Math.max(dq, Math.abs(x.rootQuat[i] - y.rootQuat[i])); dn = Math.max(dn, Math.abs(x.rootQuat[i] + y.rootQuat[i])) }
  d = Math.max(d, Math.min(dq, dn))
  for (let j = 0; j < x.q.length; j++) d = Math.max(d, Math.abs(x.q[j] - y.q[j]))
  return d
}

/** Sort and merge ranges that overlap or touch ([3,5] + [6,9] = [3,9]). */
export function mergeRanges(rs: Range[]): Range[] {
  const s = [...rs].sort((a, b) => a[0] - b[0]), out: Range[] = []
  for (const [a, b] of s) {
    const last = out[out.length - 1]
    if (last && a <= last[1] + 1) last[1] = Math.max(last[1], b)
    else out.push([a, b])
  }
  return out
}

/** Edited rows: where the exported pose differs from the original (root or any joint) by more than eps. 1-based, inclusive, merged. */
export function editRanges(orig: Pose[], out: Pose[], eps = 1e-6): Range[] {
  const rs: Range[] = []
  for (let i = 0; i < out.length; i++) if (poseDiff(orig[i], out[i]) > eps) rs.push([i + 1, i + 1])
  return mergeRanges(rs)
}

/** One joint moving more than 25 rad/s between neighbouring frames (warning; `near` within ±0.4 s of an edit boundary) or 50 rad/s
 * (error: an IK solution flip). One entry per joint per run of frames, like the other checks. `frame` = firstFrame + row index. */
export function jumpWarnings(poses: Pose[], def: RobotDef, firstFrame: number, ranges: Range[]): Warning[] {
  const out: Warning[] = [], active = new Set<string>()
  const bounds = ranges.flatMap(([a, b]) => [a, b]) // rows
  for (let i = 1; i < poses.length; i++) {
    const row = i + 1, near = bounds.some(r => Math.abs(r - row) <= SEAM_NEAR)
    def.joints.forEach((j, k) => {
      const sp = Math.abs(poses[i].q[k] - poses[i - 1].q[k]) * CSV_FPS
      const kind = sp > JUMP_ERROR ? 'jointJumpError' : sp > JUMP_WARN ? 'jointJump' : null, key = j.name
      if (!kind) { active.delete(key); return }
      if (active.has(key)) return
      active.add(key)
      out.push({ kind, frame: firstFrame + i, channel: j.name, near,
        message: `${near ? '이음매 근처 · ' : ''}${j.name} ${kind === 'jointJumpError' ? '관절 점프 오류(IK 해 뒤집힘 의심)' : '관절 점프'} ${sp.toFixed(1)} rad/s (> ${kind === 'jointJumpError' ? JUMP_ERROR : JUMP_WARN})` })
    })
  }
  return out
}

/** The edits.json beside a CSV: which CSV (name + SHA-256 of its exact text), fps, the row convention and the edited ranges. */
export function editsJson(csvName: string, csvText: string, ranges: Range[]): { name: string; text: string } {
  const head = { source_csv: csvName, sha256: sha256(csvText), fps: CSV_FPS, frame_index: '1-based, inclusive, header 제외' }
  const text = `${JSON.stringify(head, null, 2).slice(0, -2)},\n  "ranges": [${ranges.map(r => `[${r[0]}, ${r[1]}]`).join(', ')}]\n}\n`
  return { name: csvName.replace(/\.csv$/i, '') + '.edits.json', text }
}

function build(name: string, out: Pose[], orig: Pose[], def: RobotDef, firstFrame: number): RlFile {
  const ranges = editRanges(orig, out), text = posesToCsv(out, def)
  return { name, text, ranges, json: editsJson(name, text, ranges), warnings: [...validatePoses(out, def, firstFrame), ...jumpWarnings(out, def, firstFrame, ranges)] }
}

/** 클립 편집 모드 `RL 학습용 저장`: the whole clip with its 클립 수정 층, original coordinates. Warnings use clip frames. */
export function rlClipExport(p: Project, defs: RobotDefs, clipId: string): RlFile {
  const clip = baseClip(p, defs, clipId), orig = p.clips[clipId]
  if (!clip || !orig) throw new Error(`unknown clip ${clipId}`)
  const def = defs[clip.robot]
  const name = `${LABEL[clip.robot]}_${clip.name.replace(/[/\\:*?"<>|#\s]/g, '_')}.csv`
  return build(name, clipPoses(clip, def, 0, clip.length), clipPoses(orig, def, 0, orig.length), def, 0)
}

/** 내보내기 창 `RL 학습용`: one piece's own frames (trimIn..trimOut) as it plays (clip + piece 수정 층), no 기본자세, original
 * coordinates. Warnings use sequence frames, like the usual export, so clicking one goes to it. */
export function rlItemExport(p: Project, defs: RobotDefs, actorId: string, itemId: string, taken = new Set<string>(), project?: string): RlFile {
  const item = p.sequence.tracks.flatMap(t => t.items).find(i => i.id === itemId) as Item | undefined
  const clip = item && itemClip(p, defs, item), orig = item && p.clips[item.refId]
  if (!item || !clip || !orig) throw new Error(`unknown item ${itemId}`)
  const def = defs[clip.robot]
  return build(csvFileName(p, actorId, itemId, taken, project), clipPoses(clip, def, item.trimIn, item.trimOut), clipPoses(orig, def, item.trimIn, item.trimOut), def, item.start)
}
