import { expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { loadDef } from '../test/defs'
import { parseCsvPoses, posesToClip } from '../export/importCsv'
import { createEditorStore } from '../store/store'
import { emptyProject } from './defaults'
import { evaluate, type RobotDefs } from './evaluate'
import { boundaryStep, itemClip, seamedClip, itemSeam } from './itemClip'
import { feetTrack } from '../review/feet'
import { STEP } from './transition'
import { parseProject, serializeProject } from './projectFile'
import type { Clip, Item } from './types'
import type { Pose } from './pose'

const defs: RobotDefs = { g1: loadDef('g1'), go2: loadDef('go2') }
const def = defs.go2
const logPoses = (f: string) => parseCsvPoses(readFileSync(`public/go2-blocks/${f}`, 'utf8'), defs, 60)
// a library block's last pose held for `n` frames (a piece that stands still in that stance)
const hold = (f: string, id: string, n = 120, edit?: (p: Pose) => Pose): Clip => {
  const { robot, fps, poses } = logPoses(f), last = structuredClone(poses[poses.length - 1])
  return { ...posesToClip(Array.from({ length: n }, () => structuredClone(edit ? edit(last) : last)), fps, robot, defs, id), id }
}
const WIDE = '기본 자세/007_넓게_서기.csv', NARROW = '기본 자세/008_좁게_서기.csv'

function pair(a: Clip, b: Clip, on: boolean | 'project' = 'project') {
  const st = createEditorStore(defs, emptyProject()), s = () => st.getState()
  s().appendClip(null, a); const actor = s().project.actors[0].id
  const ib = s().appendClip(actor, b)!
  const item = (id: string) => s().project.sequence.tracks.flatMap(t => t.items).find(i => i.id === id)!
  const ia = s().project.sequence.tracks.find(t => t.actorId === actor)!.items.find(i => i.id !== ib)!.id
  if (on === 'project') s().setStepSeam(true); else s().setItemStep(ib, on)
  return { s, actor, ia, ib, item }
}
const range = (s: () => { project: any }, actor: string, f0: number, f1: number) => { const o: Pose[] = []; for (let f = f0; f <= f1; f++) o.push(evaluate(s().project, defs, actor, f)); return o }
const slide = (ps: Pose[], floor?: number) => {
  const t = feetTrack(ps, def, floor)!; let sum = 0
  t.feet.forEach((_, l) => { for (let k = 0; k + 1 < ps.length; k++) if (t.down[l][k] && t.down[l][k + 1]) sum += Math.hypot(...t.move[l][k]) })
  return { sum, t }
}

test('off by default: nothing changes (the pieces play their seamed clips)', () => {
  const { s, ib, ia, item } = pair(hold(WIDE, 'a'), hold(NARROW, 'b'), 'project')
  s().setStepSeam(false)
  expect(boundaryStep(s().project, defs, item(ib))).toBeNull()
  expect(itemClip(s().project, defs, item(ib))).toBe(seamedClip(s().project, defs, item(ib)))
  expect(itemClip(s().project, defs, item(ia))).toBe(seamedClip(s().project, defs, item(ia)))
})

test('wide stance → narrow stance: the feet are lifted and set down (trot pairs) instead of gliding; time and root untouched', () => {
  const { s, actor, ib, item } = pair(hold(WIDE, 'a'), hold(NARROW, 'b'))
  const st = boundaryStep(s().project, defs, item(ib))!
  expect(st.status).toMatchObject({ kind: 'ok', one: false, groups: 2, moved: 4 })
  const b0 = item(ib).start, on = range(s, actor, b0 - 62, b0 + 62)
  s().setStepSeam(false)
  const off = range(s, actor, b0 - 62, b0 + 62), floor = feetTrack(off, def)!.floor
  expect(item(ib).start).toBe(b0) // no frame added or moved
  on.forEach((p, i) => { p.rootPos.forEach((v, c) => expect(v).toBeCloseTo(off[i].rootPos[c], 9)) }) // the body path is the seam's
  const was = slide(off, floor), now = slide(on, floor)
  expect(was.sum).toBeGreaterThan(0.3) // 4 feet × ~11 cm glide
  expect(now.sum).toBeLessThan(0.02)
  expect(now.t.down.some(d => d.some(x => !x))).toBe(true) // feet leave the floor
  // gentle: joint speed and acceleration within the limits, every foot up for at least 0.2 s
  for (let k = 1; k + 1 < on.length; k++) def.joints.forEach((j, n) => {
    expect(Math.abs(on[k].q[n] - on[k - 1].q[n]) * 60 / j.velocity).toBeLessThanOrEqual(STEP.vel + 1e-9)
    expect(Math.abs(on[k + 1].q[n] - 2 * on[k].q[n] + on[k - 1].q[n]) * 3600).toBeLessThanOrEqual(STEP.acc[j.name.split('_')[1]] + 1e-6)
  })
  now.t.down.forEach(d => { let run = 0; d.forEach(x => { if (!x) run++; else { if (run) expect(run).toBeGreaterThanOrEqual(STEP.air); run = 0 } }) })
})

test('the piece\'s own switch wins over the project default', () => {
  const { s, ib, item } = pair(hold(WIDE, 'a'), hold(NARROW, 'b'), true)
  expect(s().project.stepSeam).toBeUndefined()
  expect(boundaryStep(s().project, defs, item(ib))?.status.kind).toBe('ok')
  s().setStepSeam(true); s().setItemStep(ib, false)
  expect(boundaryStep(s().project, defs, item(ib))).toBeNull()
  s().undo(); expect(boundaryStep(s().project, defs, item(ib))?.status.kind).toBe('ok')
  s().setItemStep(ib, null); expect(item(ib).step).toBeUndefined()
})

test('equal boundary frames (Go2 editor blocks share theirs, S7): no seam and nothing done — only while it is on', () => {
  const { s, actor, ib, item } = pair(hold(NARROW, 'a'), hold(NARROW, 'b'))
  expect(itemSeam(s().project, defs, item(ib))).toBeNull()
  expect(boundaryStep(s().project, defs, item(ib))!.status.kind).toBe('same')
  const b0 = item(ib).start, q = evaluate(s().project, defs, actor, b0 - 1).q
  expect(evaluate(s().project, defs, actor, b0 + 5).q).toEqual(q)
  s().setStepSeam(false)
  expect(itemSeam(s().project, defs, item(ib))).not.toBeNull() // off: the seam as before
})

test('a front foot raised at the start of the next piece (feet on the floor change): shown only, nothing changed', () => {
  const raise = (p: Pose): Pose => ({ ...p, q: p.q.map((v, i) => (i === 1 ? 0.0 : i === 2 ? -2.4 : v)) }) // FL thigh forward, calf folded: paw up
  const { s, ib, item } = pair(hold(NARROW, 'a'), hold(NARROW, 'b', 120, raise))
  const st = boundaryStep(s().project, defs, item(ib))!
  expect(st.status.kind).toBe('lift')
  expect(itemClip(s().project, defs, item(ib))).toBe(seamedClip(s().project, defs, item(ib)))
})

test('no still frames to step in (both pieces glide over the floor at the boundary): reported, nothing changed', () => {
  const glide = (f: string, id: string): Clip => { // the stance carried along x at 0.3 m/s: never standing still
    const { robot, fps, poses } = logPoses(f), last = poses[poses.length - 1]
    return { ...posesToClip(Array.from({ length: 120 }, (_, i) => ({ ...structuredClone(last), rootPos: [last.rootPos[0] + 0.005 * i, last.rootPos[1], last.rootPos[2]] as Pose['rootPos'] })), fps, robot, defs, id), id }
  }
  const { s, ib, ia, item } = pair(glide(NARROW, 'a'), glide(WIDE, 'b'))
  const st = boundaryStep(s().project, defs, item(ib))!
  expect(st.status).toEqual({ kind: 'fail', why: { noTime: true } })
  expect(itemClip(s().project, defs, item(ib))).toBe(seamedClip(s().project, defs, item(ib)))
  expect(itemClip(s().project, defs, item(ia))).toBe(seamedClip(s().project, defs, item(ia)))
})

test('saved and opened again: the project default and the piece switches', () => {
  const { s, ib } = pair(hold(WIDE, 'a'), hold(NARROW, 'b'))
  s().setItemStep(ib, false)
  const back = parseProject(serializeProject(s().project), defs)
  expect(back.stepSeam).toBe(true)
  expect(back.sequence.tracks.flatMap((t: { items: Item[] }) => t.items).find((i: Item) => i.id === ib)!.step).toBe(false)
  const bad = JSON.parse(serializeProject(s().project)); bad.sequence.tracks.find((t: any) => t.kind === 'motion').items[1].step = 'yes'
  expect(() => parseProject(JSON.stringify(bad), defs)).toThrow(/step/)
  const odd = JSON.parse(serializeProject(s().project)); odd.stepSeam = 'on'
  expect(parseProject(JSON.stringify(odd), defs).stepSeam).toBeUndefined()
})

test('전이 조각 넣기 (manual, adds time): a piece of its own from A\'s end to B\'s start, the feet stepped; B and later pieces move back', async () => {
  const { bridgeFor } = await import('./bridge')
  const { s, actor, ib, item } = pair(hold(WIDE, 'a'), hold(NARROW, 'b'))
  s().setStepSeam(false)
  const later = s().appendClip(actor, hold(NARROW, 'c'))!
  const b0 = item(ib).start, c0 = item(later).start
  const r = bridgeFor(s().project, defs, ib, 'step')!
  expect('clip' in r).toBe(true)
  const clip = (r as { clip: Clip }).clip
  expect(s().insertBridge(ib, clip)).toBe(true)
  expect([item(ib).start, item(later).start]).toEqual([b0 + clip.length, c0 + clip.length])
  const ps = range(s, actor, b0 - 5, b0 + clip.length + 5), floor = feetTrack(ps, def)!.floor
  expect(slide(ps, floor).sum).toBeLessThan(0.03)
  for (let k = 1; k < ps.length; k++) def.joints.forEach((j, n) => expect(Math.abs(ps[k].q[n] - ps[k - 1].q[n]) * 60 / j.velocity).toBeLessThanOrEqual(STEP.vel + 1e-9))
  // the robot ends where B used to start: the bridge only adds time
  s().undo()
  expect([item(ib).start, item(later).start]).toEqual([b0, c0])
  const before = evaluate(s().project, defs, actor, b0)
  s().insertBridge(ib, clip)
  const after = evaluate(s().project, defs, actor, item(ib).start)
  for (const c of [0, 1]) expect(after.rootPos[c]).toBeCloseTo(before.rootPos[c], 2) // x, y (its height: B's own, no seam left)
})

test('기본서기 경유 넣기: sitting → standing goes through 기본서기 (0, 0.8, −1.5)', async () => {
  const { bridgeFor } = await import('./bridge')
  const { STAND_Q } = await import('./transition')
  const { s, actor, ib, item } = pair(hold('앉기_엎드리기/011_앉기.csv', 'sit'), hold('기본 자세/004_높이_서기.csv', 'tall'))
  const r = bridgeFor(s().project, defs, ib, 'stand')!
  if (!('clip' in r)) throw new Error(JSON.stringify(r))
  const b0 = item(ib).start
  s().insertBridge(ib, r.clip)
  const ps = range(s, actor, b0, item(ib).start)
  const near = ps.map(p => Math.max(...p.q.map((v, i) => Math.abs(v - STAND_Q[i % 3]))))
  expect(Math.min(...near)).toBeLessThan(0.02) // it stands in 기본서기 on the way
  for (let k = 1; k < ps.length; k++) def.joints.forEach((j, n) => expect(Math.abs(ps[k].q[n] - ps[k - 1].q[n]) * 60 / j.velocity).toBeLessThanOrEqual(STEP.vel + 1e-9))
})
