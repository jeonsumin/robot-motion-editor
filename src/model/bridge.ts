// 수동 전이 조각 (§19, 우클릭 메뉴 "전이 조각 넣기" / "기본서기 경유 넣기"): a GO2 piece of its own between A and the piece B
// that starts where A ends — from A's last frame to B's first, the feet stepped one at a time (or in trot pairs) within the
// STEP limits. It adds time: B and every later piece move back by its length (user: 시간 추가는 선택지로만, 자동은 안 됨).
import { posesToClip } from '../export/importCsv'
import { evaluateClip, type RobotDefs } from './pose'
import { editedClip, baseClip, itemClip, standOver } from './itemClip'
import { bridgeBetween, bridgePoses, prevTouching, type StepStatus } from './transition'
import type { Clip, Item, Project } from './types'
import { sortedItems } from './sequence'

export type BridgeKind = 'step' | 'stand'
export const BRIDGE_NAME: Record<BridgeKind, string> = { step: '전이 조각', stand: '기본서기 경유' }
const memo = new Map<string, { clip: Clip } | { status: StepStatus }>()

/** The 전이 조각 that would go before piece `itemId` (a new clip, not in the project yet), or why there is none; null when the
 * piece is not a GO2 piece starting right where another GO2 piece ends. */
export function bridgeFor(p: Project, defs: RobotDefs, itemId: string, kind: BridgeKind): { clip: Clip } | { status: StepStatus } | null {
  const B = p.sequence.tracks.flatMap(t => t.items).find(i => i.id === itemId)
  if (B?.walk) { // before a 걷기 piece: after the piece before it, even with a gap (it walks off from that piece's end)
    const t = p.sequence.tracks.find(t => t.items.some(i => i.id === B.id))!, items = sortedItems(t), A = items[items.indexOf(B) - 1]
    return A ? walkBridge(p, defs, A, kind) : null
  }
  const A = B && prevTouching(p, B)
  if (!A || !B) return null
  const ca = itemClip(p, defs, A), cb = B.use === 'original' ? baseClip(p, defs, B.refId) : editedClip(p, defs, B)
  if (!ca || !cb || ca.robot !== 'go2' || cb.robot !== 'go2' || A.trimOut - A.trimIn < 2) return null
  const def = defs.go2, aPrev = evaluateClip(ca, def, A.trimOut - 2), aLast = evaluateClip(ca, def, A.trimOut - 1), b0 = evaluateClip(cb, def, B.trimIn)
  const key = kind + JSON.stringify([aPrev, aLast, b0])
  const hit = memo.get(key)
  if (hit) return hit
  const r = bridgePoses(def, aPrev, aLast, b0, kind)
  const out = r.ok ? { clip: { ...posesToClip(r.poses, 60, 'go2', defs, BRIDGE_NAME[kind]), id: crypto.randomUUID() } } : { status: r.status }
  if (memo.size > 100) memo.delete(memo.keys().next().value!)
  memo.set(key, out)
  return out
}

/** Before a 걷기 piece (§20): it walks off from A's last pose, so only 기본서기 경유 helps — A's end → 기본서기 over A's feet
 * (a walk can only start standing on four feet). */
function walkBridge(p: Project, defs: RobotDefs, A: Item, kind: BridgeKind): { clip: Clip } | { status: StepStatus } | null {
  return kind === 'stand' ? standBridgeAfter(p, defs, A) : null
}
/** 기본서기 경유 after piece A (its end → 기본서기 over its feet): before a 걷기 piece, or (라이브러리 `기본서기 경유 넣고 추가`) before a new one. */
export function standBridgeAfter(p: Project, defs: RobotDefs, A: Item): { clip: Clip } | { status: StepStatus } | null {
  const ca = itemClip(p, defs, A)
  if (!ca || ca.robot !== 'go2' || A.trimOut - A.trimIn < 1) return null
  const def = defs.go2, aLast = evaluateClip(ca, def, A.trimOut - 1), key = 'walk' + JSON.stringify(aLast)
  const hit = memo.get(key)
  if (hit) return hit
  const r = bridgeBetween(def, aLast, standOver(def, aLast))
  const out = r.ok ? { clip: { ...posesToClip(r.poses, 60, 'go2', defs, BRIDGE_NAME.stand), id: crypto.randomUUID() } } : { status: r.status }
  if (memo.size > 100) memo.delete(memo.keys().next().value!)
  memo.set(key, out)
  return out
}
