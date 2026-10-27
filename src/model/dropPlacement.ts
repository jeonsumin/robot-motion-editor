import type { RobotKind } from '../robot/types'
import { itemLen, validTrack } from './sequence'
import type { Clip, Item, Project } from './types'
import { validVideoTrack, videoTrack } from './video'

// `clip` = a new clip not yet in the project (id === clip.id): a GO2 block dragged from the library.
export interface Asset { kind: 'clip' | 'media'; id: string; clip?: Clip }
export type Placement =
  | { kind: 'existing'; trackId: string; start: number; shift?: { ids: string[]; by: number } /* pieces pushed later to make room */ }
  | { kind: 'newActor'; robot: RobotKind; start: number }
  | { kind: 'video'; start: number }
  | { kind: 'reject'; reason: string }

const end = (it: Item) => it.start + itemLen(it)

// First valid start among: the drop frame, the end of the items it would overlap, the end of the track. Never overlaps an item (no crossfade).
function snap(items: Item[], refId: string, len: number, frame: number, ok: (items: Item[]) => boolean): number | null {
  const hit = items.filter(i => i.start < frame + len && frame < end(i))
  const cands = [frame, hit.length ? Math.max(...hit.map(end)) : frame, Math.max(0, ...items.map(end))]
  const free = (s: number) => items.every(i => s + len <= i.start || end(i) <= s)
  return cands.find(start => free(start) && ok([...items, { id: '', refId, start, trimIn: 0, trimOut: len }])) ?? null
}

// Motion track: the clip goes where it is dropped (user). Inside a piece: at its start (front half) or its end (back half), that piece /
// the ones after it pushed later by the clip's length (their gaps and crossfades kept). In a gap: at the drop frame, the pieces after
// it pushed only as far as needed. Never overlaps.
function insertAt(items: Item[], len: number, f: number): { start: number; shift?: { ids: string[]; by: number } } {
  const sorted = [...items].sort((a, b) => a.start - b.start)
  const k = sorted.map((it, i) => [it, i] as const).filter(([it]) => it.start <= f && f < end(it)).at(-1)?.[1] // later piece wins on overlap
  if (k !== undefined) {
    const it = sorted[k], front = f < it.start + itemLen(it) / 2
    const later = sorted.slice(front ? k : k + 1)
    return { start: front ? it.start : end(it), shift: later.length ? { ids: later.map(i => i.id), by: len } : undefined }
  }
  const later = sorted.filter(i => i.start >= f), by = later.length ? f + len - later[0].start : 0
  return { start: f, shift: by > 0 ? { ids: later.map(i => i.id), by } : undefined }
}

/** 펼친 레인에 놓기(사용자): 위치는 놓은 시각이 아니라 그 레인의 조각 기준 — 막대 앞쪽 절반보다 왼쪽이면 그 조각 앞,
 * 그 밖(레인의 빈 곳 포함)은 그 조각 바로 뒤. insertAt에 넘길 프레임을 돌려줌(끼워 넣기·밀어내기 규칙은 그대로). */
export function laneDropFrame(it: Item, frame: number): number {
  return frame < it.start + itemLen(it) / 2 ? it.start : end(it)
}

/** 끼울 자리 표시(사용자): 앞뒤 조각을 막대에 보이는 이름(`name`, 프로젝트 이름 뺀 조각 이름)으로 "GO2-1 ↔ GO2-2 사이" / "GO2-1 앞" / "GO2-3 뒤".
 * 넣기 전 기준(화면에 보이는 이름). 빈 트랙이면 ''. */
export function insertLabel(items: Item[], start: number, shift: { ids: string[] } | undefined, name: (it: Item) => string): string {
  const moved = new Set(shift?.ids ?? []), s = [...items].sort((a, b) => a.start - b.start)
  const k = s.filter(i => !moved.has(i.id) && i.start < start).length // pieces that stay in front of the new one
  return !s.length ? '' : k === 0 ? `${name(s[0])} 앞` : k === s.length ? `${name(s[k - 1])} 뒤` : `${name(s[k - 1])} ↔ ${name(s[k])} 사이`
}

/** Where a dragged asset lands for a drop at `frame` over the track `rowTrackId` (null = not over a track row). Pure; used by the ghost and the drop. */
export function dropPlacement(p: Project, asset: Asset, rowTrackId: string | null, frame: number): Placement {
  const f = Math.max(0, Math.round(frame))
  if (asset.kind === 'media') {
    const m = p.media.find(m => m.id === asset.id), t = videoTrack(p)
    if (!m) return { kind: 'reject', reason: '알 수 없는 영상입니다' }
    if (t?.locked) return { kind: 'reject', reason: '잠긴 트랙입니다' }
    const media = Object.fromEntries(p.media.map(m => [m.id, m]))
    const start = snap(t?.items ?? [], m.id, m.durationF, f, items => validVideoTrack(items, media))
    return start === null ? { kind: 'reject', reason: '이 위치에 놓을 수 없습니다' } : { kind: 'video', start }
  }
  const clip = asset.clip ?? p.clips[asset.id]
  if (!clip) return { kind: 'reject', reason: '알 수 없는 클립입니다' }
  const t = p.sequence.tracks.find(t => t.id === rowTrackId)
  const actor = t?.kind === 'motion' ? p.actors.find(a => a.id === t.actorId) : undefined
  if (t && actor?.robot === clip.robot) {
    if (t.locked) return { kind: 'reject', reason: '잠긴 트랙입니다' }
    const { start, shift } = insertAt(t.items, clip.length, f)
    const moved = t.items.map(i => shift?.ids.includes(i.id) ? { ...i, start: i.start + shift.by } : i)
    if (!validTrack([...moved, { id: '', refId: clip.id, start, trimIn: 0, trimOut: clip.length }])) return { kind: 'reject', reason: '이 위치에 놓을 수 없습니다' }
    return shift ? { kind: 'existing', trackId: t.id, start, shift } : { kind: 'existing', trackId: t.id, start }
  }
  const empty = p.sequence.tracks.every(t => !t.items.length)
  return { kind: 'newActor', robot: clip.robot, start: empty ? 0 : f }
}
