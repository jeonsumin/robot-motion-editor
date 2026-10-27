import type { RobotDefs } from '../model/evaluate'
import type { Clip, Project, Actor } from '../model/types'

export interface TimeScale { x0: number; pxPerFrame: number }
export const frameToX = (s: TimeScale, f: number) => s.x0 + f * s.pxPerFrame
export const xToFrame = (s: TimeScale, x: number) => Math.round((x - s.x0) / s.pxPerFrame)

// Keys (sorted by f) with lo <= f <= hi, found by binary search.
export function keysIn<K extends { f: number }>(keys: K[], lo: number, hi: number): K[] {
  let a = 0, b = keys.length
  while (a < b) { const m = (a + b) >> 1; if (keys[m].f < lo) a = m + 1; else b = m }
  let e = a
  while (e < keys.length && keys[e].f <= hi) e++
  return keys.slice(a, e)
}

const p2 = (n: number) => String(n).padStart(2, '0')
export function formatTimecode(f: number): string {
  if (f < 0) return '-' + formatTimecode(-f)
  const sec = Math.floor(f / 60)
  return `${p2(Math.floor(sec / 60))}:${p2(sec % 60)}.${p2(f % 60)}`
}

/** 시간·프레임 입력(사용자): 숫자만 = 프레임 번호, 콜론이 있으면 화면 표시와 같은 "분:초.프레임"(프레임 0~59, 생략 = 0; 한 자리 ".4" = 4프레임).
 * 형식이 틀리면 null. */
export function parseTimecode(text: string): number | null {
  const t = text.trim()
  if (/^\d+$/.test(t)) return Number(t)
  const m = /^(\d+):(\d{1,2})(?:\.(\d{1,2}))?$/.exec(t)
  if (!m) return null
  const sec = Number(m[2]), fr = m[3] === undefined ? 0 : Number(m[3])
  return sec > 59 || fr > 59 ? null : (Number(m[1]) * 60 + sec) * 60 + fr
}

export interface Row { kind: 'group'; actorId: string; label: string; channels: string[] }
export const ROOT_CHANNELS = ['root.x', 'root.y', 'root.z', 'root.roll', 'root.pitch', 'root.yaw']

// One key row per actor: its channels are the root and every joint, so a diamond stands for the whole pose at that frame.
export function buildRows(p: Project, defs: RobotDefs, actors: Pick<Actor, 'id' | 'name' | 'robot'>[] = p.actors): Row[] {
  return actors.map(a => ({ kind: 'group', actorId: a.id, label: a.name, channels: [...ROOT_CHANNELS, ...defs[a.robot].joints.map(j => j.name)] }))
}

// y is relative to the top of rows[0]; returns clip frames of keys under the point (group rows: every channel key at that frame).
export function hitKey(rows: Row[], clip: Pick<Clip, 'channels'>, s: TimeScale, rowH: number, x: number, y: number): { channel: string; f: number }[] | null {
  const row = rows[Math.floor(y / rowH)]
  if (!row || y < 0) return null
  const hits: { channel: string; f: number }[] = []
  let best = 5
  for (const channel of row.channels) {
    for (const k of clip.channels[channel]?.keys ?? []) {
      const d = Math.abs(frameToX(s, k.f) - x)
      if (d < best) { best = d; hits.length = 0 }
      if (d <= best && d <= 4) hits.push({ channel, f: k.f })
    }
  }
  const f = hits[0]?.f
  const same = hits.filter(h => h.f === f)
  return same.length ? same : null
}

// Hover scrub: the frame under the pointer, or null when hovering the label column or while something else owns the mouse.
export const hoverFrame = (x: number, labelW: number, s: TimeScale, busy: boolean): number | null =>
  busy || x <= labelW ? null : xToFrame(s, x)

// Coalesces hover frames to one store update per animation frame, skipping no-ops.
export function hoverScrub(getFrame: () => number, setFrame: (f: number) => void) {
  let raf = 0, next = 0
  return {
    push(f: number) { next = f; if (!raf) raf = requestAnimationFrame(() => { raf = 0; if (next !== getFrame()) setFrame(next) }) },
    stop() { cancelAnimationFrame(raf); raf = 0 },
  }
}
