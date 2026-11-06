import { describe, expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { loadDef } from '../test/defs'
import { parseCsvPoses, posesToClip } from '../export/importCsv'
import { createEditorStore } from '../store/store'
import { emptyProject } from './defaults'
import { evaluate, type RobotDefs } from './evaluate'
import { itemClip, walkOf } from './itemClip'
import { feetOf, makeWalk, standPose, WALK, type WalkFace, type WalkSpec } from './walk'
import { STEP } from './transition'
import { quatYaw } from './rootMath'
import { parseProject, serializeProject } from './projectFile'
import type { Clip, Item } from './types'
import type { Pose } from './pose'

const defs: RobotDefs = { g1: loadDef('g1'), go2: loadDef('go2') }
const def = defs.go2
const deg = (r: number) => r * 180 / Math.PI
// planted feet: the foot centre moving over the floor while it is down (z within 3 mm of the floor)
function planted(poses: Pose[]) {
  const fs = poses.map(p => feetOf(def, p).feet), fl = Math.min(...fs[0].map(f => f[2]))
  let slide = 0, up = 0
  for (let l = 0; l < 4; l++) for (let k = 0; k + 1 < poses.length; k++) {
    const a = fs[k][l], b = fs[k + 1][l]
    if (a[2] - fl < 0.003 && b[2] - fl < 0.003) slide += Math.hypot(b[0] - a[0], b[1] - a[1])
    if (a[2] - fl > 0.012) up++
  }
  return { slide, up }
}
const limits = (ps: Pose[]) => { let v = 0; for (let k = 1; k < ps.length; k++) def.joints.forEach((j, i) => { v = Math.max(v, Math.abs(ps[k].q[i] - ps[k - 1].q[i]) * 60 / j.velocity) }); return v }

describe('makeWalk (가상 걷기)', () => {
  const run = (x: number, y: number, secs: number, face: WalkFace, yaw = 0, slow?: 'walk' | 'after' | 'before') => {
    const a = standPose(def, 0, 0, 0, 0.022), b = standPose(def, x, y, yaw, 0.022)
    return makeWalk(def, a, b, Math.round(secs * 60), face, slow)
  }
  test.each([['앞 2 m · 3초', 2, 0], ['옆 0.5 m · 2초', 0, 0.5], ['뒤 1 m · 3초', -1, 0], ['대각선 0.9, 0.4 · 2.4초', 0.9, 0.4]] as const)(
    '%s (방향 유지): ends on the target, heading kept, planted feet never slide, within the limits — 초록', (_, x, y) => {
      const secs = x === 2 || x === -1 ? 3 : x ? 2.4 : 2, { poses, report } = run(x, y, secs, 'keep')
      const e = poses.at(-1)!
      expect(Math.hypot(e.rootPos[0] - x, e.rootPos[1] - y)).toBeLessThan(0.01)
      for (const p of poses) expect(Math.abs(deg(quatYaw(p.rootQuat)))).toBeLessThan(1) // 방향 유지: it never turns
      const { slide, up } = planted(poses)
      expect(slide).toBeLessThan(0.005)
      expect(up).toBeGreaterThan(0) // it steps
      expect(report.tone).toBe('ok')
      expect(limits(poses)).toBeLessThanOrEqual(STEP.vel)
    })
  test('진행 방향 보기: turns to where it goes, walks, turns to the end heading', () => {
    const { poses, report } = run(1, 1, 3.5, 'travel', 0)
    const yaws = poses.map(p => deg(quatYaw(p.rootQuat)))
    expect(Math.max(...yaws)).toBeGreaterThan(44) // faced the way (45°)
    expect(Math.abs(yaws.at(-1)!)).toBeLessThan(1)
    expect(planted(poses).slide).toBeLessThan(0.005)
    expect(report.tone).toBe('ok')
  })
  test('너무 짧은 시간: still made, reported 빨강 with the numbers (no time added)', () => {
    const { poses, report } = run(1.4, 1, 0.8, 'keep')
    expect(poses).toHaveLength(48)
    expect(report.tone).toBe('bad')
    expect(report.reasons.map(r => r.text).join()).toMatch(/속도 2\.15 m\/s — 한 걸음에 앞 \d+ cm · 옆 \d+ cm/)
  })
  test('아주 느림: 주황; 걷고 나서 서 있기 / 서 있다가 걷기 put an easy-paced walk first / last', () => {
    const slow = run(0, 0.25, 3, 'keep')
    expect(slow.report.tone).toBe('warn')
    expect(slow.report.reasons[0].text).toMatch(/^아주 느림/)
    expect(slow.report.slowFix).toMatch(/걷고 나서 서 있기로 바꾸면/)
    const after = run(0, 0.25, 3, 'keep', 0, 'after'), before = run(0, 0.25, 3, 'keep', 0, 'before')
    expect(after.report.tone).toBe('ok')
    const moved = (ps: Pose[], f: number) => Math.hypot(ps[f].rootPos[0], ps[f].rootPos[1] - 0)
    expect(moved(after.poses, 120)).toBeCloseTo(0.25, 3) // done early, standing at the target
    expect(moved(before.poses, 60)).toBeLessThan(1e-6) // still at the start
  })
})

const logPoses = (f: string) => parseCsvPoses(readFileSync(`public/go2-blocks/${f}`, 'utf8'), defs, 60)
const hold = (f: string, id: string, n = 90, edit?: (p: Pose) => Pose): Clip => {
  const { robot, fps, poses } = logPoses(f), last = edit ? edit(poses[poses.length - 1]) : poses[poses.length - 1]
  return { ...posesToClip(Array.from({ length: n }, () => structuredClone(last)), fps, robot, defs, id), id }
}
const facingX = (p: Pose): Pose => ({ ...p, rootQuat: [0, 0, 0, 1] }) // the log stands facing −y: turned to +x
const STAND = '기본 자세/003_기본_서기.csv'
function stage() {
  const st = createEditorStore(defs, emptyProject()), s = () => st.getState()
  s().appendClip(null, hold(STAND, 'a', 90, facingX))
  const actor = s().project.actors[0].id
  const item = (id: string) => s().project.sequence.tracks.flatMap(t => t.items).find(i => i.id === id)!
  const world = (f: number) => evaluate(s().project, defs, actor, f)
  return { s, actor, item, world }
}
const endF = (it: Item) => it.start + it.trimOut - it.trimIn - 1

describe('걷기 조각 on the timeline', () => {
  test('ends on its stage target; the next piece starts there in the pose the walk ended in', () => {
    const { s, actor, item, world } = stage()
    s().setPlacement(actor, { x: 0.5, y: -1, yaw: 0.3 })
    const p0 = world(89), h = quatYaw(p0.rootQuat), to: [number, number] = [p0.rootPos[0] + Math.cos(h), p0.rootPos[1] + Math.sin(h)] // 1 m ahead
    const w = s().addWalk(actor, { to, face: 'keep' }, 150)!
    const c = s().appendClip(actor, hold(STAND, 'c'))!
    const e = world(endF(item(w))), n0 = world(item(c).start)
    expect(Math.hypot(e.rootPos[0] - to[0], e.rootPos[1] - to[1])).toBeLessThan(0.01)
    expect(Math.hypot(n0.rootPos[0] - to[0], n0.rootPos[1] - to[1])).toBeLessThan(0.01)
    n0.q.forEach((v, i) => expect(v).toBeCloseTo(e.q[i], 2)) // (its 이음매 보정 adds the walk's last frame step: tiny)
    expect(walkOf(s().project, defs, item(w))!.report.tone).toBe('ok')
  })
  test('the pieces after a walk stay where they are when a piece before it changes (도착점 고정)', () => {
    const { s, actor, item, world } = stage()
    const w1 = s().addWalk(actor, { to: [1, 0], face: 'keep' }, 150)!
    s().addWalk(actor, { to: [2, 0], face: 'keep' }, 150)
    const c = s().appendClip(actor, hold(STAND, 'c'))!
    const at = () => world(item(c).start + 30).rootPos
    const before = at()
    expect(s().setWalk(w1, { to: [0.8, 0.1] })).toBe(true)
    const after = at()
    after.forEach((v, i) => expect(v).toBeCloseTo(before[i], 3)) // within a millimetre (the walk's last-frame speed)
    s().undo(); expect(item(w1).walk!.to).toEqual([1, 0])
  })
  test('진행 방향 보기 / 객석 보기: the heading it ends in (stage)', () => {
    const { s, actor, item, world } = stage()
    s().setPlacement(actor, { x: 0, y: 0, yaw: 0.7 })
    const w = s().addWalk(actor, { to: [1, 1], face: 'audience' }, 240)!
    expect(deg(quatYaw(world(endF(item(w))).rootQuat))).toBeCloseTo(0, 0) // 객석 = +x
    s().setWalk(w, { face: 'travel', yaw: Math.PI / 2 })
    expect(deg(quatYaw(world(endF(item(w))).rootQuat))).toBeCloseTo(90, 0)
  })
  test('time / speed: a new length moves the pieces after it; one undo', () => {
    const { s, actor, item } = stage()
    const w = s().addWalk(actor, { to: [1, 0], face: 'keep' }, 120)!, c = s().appendClip(actor, hold(STAND, 'c'))!
    const c0 = item(c).start
    expect(s().setWalk(w, { frames: 180 })).toBe(true)
    expect(item(w).trimOut).toBe(180)
    expect(item(c).start).toBe(c0 + 60)
    s().undo()
    expect([item(w).trimOut, item(c).start]).toEqual([120, c0])
  })
  test('a walk is made, not edited: no 수정 층, no cut, its start stays put', () => {
    const { s, actor, item } = stage()
    const w = s().addWalk(actor, { to: [1, 0], face: 'keep' }, 120)!
    s().setFrame(item(w).start + 30); s().select(actor, 'FL_thigh_joint'); s().setValue(actor, 'FL_thigh_joint', 1.2)
    expect(item(w).offset).toBeUndefined()
    expect(s().splitItem(w, item(w).start + 60)).toBe(false)
    expect(s().trimItem(w, 'in', 10)).toBe(false)
    expect(s().trimItem(w, 'out', 30)).toBe(true) // its length (time) can change
  })
  test('§22 안정성 우선: an edit that would make a walk 한계 초과 is refused, with the shortest length that is not', () => {
    const { s, actor, item } = stage()
    expect(s().addWalk(actor, { to: [2.56, 0], face: 'keep' }, 120)).toBeNull() // 1.28 m/s: not made
    expect(s().project.sequence.tracks.flatMap(t => t.items)).toHaveLength(1)
    const w = s().addWalk(actor, { to: [2.56, 0], face: 'keep' }, 240)!
    expect(walkOf(s().project, defs, item(w))!.report.tone).not.toBe('bad')
    expect(s().setWalk(w, { frames: 120 })).toBe(false) // too short now: refused, nothing changed
    expect(item(w).trimOut).toBe(240)
    expect(s().trimItem(w, 'out', -120)).toBe(false) // the bar end dragged: the same
    const pv = s().previewWalk(w, { frames: 120 })!
    expect(pv.report.tone).toBe('bad')
    expect(pv.minFrames).toBeGreaterThan(120)
    expect(pv.minFrames! % 6).toBe(0) // 0.1 s steps
    expect(s().setWalk(w, { frames: pv.minFrames! })).toBe(true) // the 최소 시간 button
    expect(walkOf(s().project, defs, item(w))!.report.tone).not.toBe('bad')
    expect(s().setWalk(w, { frames: pv.minFrames! - 12 })).toBe(false)
    // an edit of this walk that would make the next walk 한계 초과 is refused too
    const w2 = s().addWalk(actor, { to: [3.4, 0], face: 'keep' }, 120)!
    expect(walkOf(s().project, defs, item(w2))!.report.tone).not.toBe('bad')
    expect(s().setWalk(w, { to: [1.6, 0] })).toBe(false) // w2 would have 1.8 m in 2 s
    expect(item(w).walk!.to).toEqual([2.56, 0])
  })
  test('starting from a piece that does not stand (앉기): refused; 기본서기 경유 넣고 추가 makes it — one undo', async () => {
    const { standBridgeAfter } = await import('./bridge')
    const { walkPreview } = await import('./itemClip')
    const st = createEditorStore(defs, emptyProject()), s = () => st.getState()
    s().appendClip(null, hold('앉기_엎드리기/011_앉기.csv', 'sit'))
    const actor = s().project.actors[0].id, spec: WalkSpec = { to: [0, -1], face: 'keep' } // 1 m ahead (it sits facing −y)
    const pv = walkPreview(s().project, defs, actor, spec, 150)!
    expect(pv.report).toMatchObject({ tone: 'bad', startBad: true })
    expect(pv.report.reasons[0].text).toMatch(/^출발 불가/)
    expect(pv.minFrames).toBeNull() // no length fixes it
    expect(s().addWalk(actor, spec, 150)).toBeNull()
    expect(walkPreview(s().project, defs, actor, spec, 150, true)!.report.tone).toBe('ok') // after 기본서기 경유
    const sit = s().project.sequence.tracks.flatMap(t => t.items)[0]
    const r = standBridgeAfter(s().project, defs, sit)!
    if (!('clip' in r)) throw new Error(JSON.stringify(r))
    const w = s().addWalk(actor, spec, 150, r.clip)!
    const items = () => s().project.sequence.tracks.flatMap(t => t.items).sort((a, b) => a.start - b.start)
    expect(items().map(i => i.start)).toEqual([0, sit.trimOut - sit.trimIn, sit.trimOut - sit.trimIn + r.clip.length]) // end to end
    expect(walkOf(s().project, defs, items()[2])!.report.tone).toBe('ok')
    expect(items()[2].id).toBe(w)
    s().undo(); expect(items()).toHaveLength(1) // bridge and walk: one undo
  })
  test('한계 초과 by another edit (its 기본서기 경유 deleted): it does not walk — it stands in its start pose; 기본서기 경유 넣기 fixes it', async () => {
    const { standBridgeAfter, bridgeFor } = await import('./bridge')
    const st = createEditorStore(defs, emptyProject()), s = () => st.getState()
    s().appendClip(null, hold('앉기_엎드리기/011_앉기.csv', 'sit'))
    const actor = s().project.actors[0].id, sit = s().project.sequence.tracks.flatMap(t => t.items)[0]
    const r = standBridgeAfter(s().project, defs, sit) as { clip: Clip }
    const w = s().addWalk(actor, { to: [0, -1], face: 'keep' }, 150, r.clip)!
    const bridgeId = s().project.sequence.tracks.flatMap(t => t.items).find(i => i.refId === r.clip.id)!.id
    expect(s().deleteItem(bridgeId)).toBe(true) // not an edit of the walk: allowed
    const it = s().project.sequence.tracks.flatMap(t => t.items).find(i => i.id === w)!
    const played = walkOf(s().project, defs, it)!
    expect(played.report).toMatchObject({ tone: 'bad', held: true, startBad: true })
    const { redWalks } = await import('./itemClip')
    expect(redWalks(s().project, defs, [w, sit.id]).map(r => r.itemId)).toEqual([w]) // not exported (CSV · RL 학습용)
    const { exportOne } = await import('../export/exportOne')
    expect(await exportOne(s().project, defs, actor, w, () => true)).toMatch(/^내보내지 않았습니다 — 한계 초과 걷기/)
    const ps = Array.from({ length: 150 }, (_, k) => evaluate(s().project, defs, actor, it.start + k))
    ps.forEach(p => { p.q.forEach((v, i) => expect(v).toBeCloseTo(ps[0].q[i], 9)); p.rootPos.forEach((v, i) => expect(v).toBeCloseTo(ps[0].rootPos[i], 9)) }) // stands still
    const b = bridgeFor(s().project, defs, w, 'stand')
    if (!b || !('clip' in b)) throw new Error(JSON.stringify(b))
    expect(s().insertBridge(w, b.clip)).toBe(true)
    const it2 = s().project.sequence.tracks.flatMap(t => t.items).find(i => i.id === w)!
    expect(walkOf(s().project, defs, it2)!.report.tone).toBe('ok')
    expect(limits(Array.from({ length: b.clip.length + 4 }, (_, k) => evaluate(s().project, defs, actor, it2.start - b.clip.length - 2 + k)))).toBeLessThanOrEqual(STEP.vel + 1e-9)
  })
  test('from an empty clip\'s all-zero pose (legs straight, calves past their range): 출발 불가, not added', async () => {
    const { walkPreview } = await import('./itemClip')
    const st = createEditorStore(defs, emptyProject()), s = () => st.getState()
    s().addActor('go2') // with its empty 120-frame clip
    const actor = s().project.actors[0].id
    const r = walkPreview(s().project, defs, actor, { to: [1, 0], face: 'keep' }, 120)!.report
    expect(r.tone).toBe('bad')
    expect(r.reasons[0].text).toBe('출발 불가 — 앞 조각 끝 자세의 관절이 범위 밖 (기본서기 경유 넣기로 해결)')
    expect(s().addWalk(actor, { to: [1, 0], face: 'keep' }, 120)).toBeNull()
  })
  test('기본자세 (앞·끝) cannot be put on a walk', () => {
    const { s, actor } = stage()
    const w = s().addWalk(actor, { to: [1, 0], face: 'keep' }, 120)!
    expect([s().setRestPose(w, 'prepend'), s().setRestTail(w, true), s().setRestLead(w, { restHold: 30 })]).toEqual([false, false, false])
  })
  test('the first piece of a new robot: from 차렷 at its placement', () => {
    const st = createEditorStore(defs, emptyProject()), s = () => st.getState()
    const w = s().addWalk(null, { to: [0.6, 0], face: 'keep' }, 120)!
    const actor = s().project.actors[0].id, it = s().project.sequence.tracks.flatMap(t => t.items).find(i => i.id === w)!
    expect(evaluate(s().project, defs, actor, it.start).q).toEqual(def.rest.q)
    expect(evaluate(s().project, defs, actor, endF(it)).rootPos[0]).toBeCloseTo(0.6, 2)
  })
  test('saved and opened again; a bad walk entry is refused', () => {
    const { s, actor } = stage()
    const spec: WalkSpec = { to: [1, 0.5], face: 'travel', yaw: 0.2, slow: 'after' }
    const w = s().addWalk(actor, spec, 180)!
    const back = parseProject(serializeProject(s().project), defs)
    expect(back.sequence.tracks.flatMap(t => t.items).find(i => i.id === w)!.walk).toEqual(spec)
    const bad = JSON.parse(serializeProject(s().project)); bad.sequence.tracks.find((t: any) => t.kind === 'motion').items[1].walk.face = 'run'
    expect(() => parseProject(JSON.stringify(bad), defs)).toThrow(/walk/)
  })
})
void WALK
