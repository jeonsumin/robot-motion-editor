import { loadDef } from '../test/defs'
import { beforeEach, expect, test } from 'vitest'
import type { RobotDefs } from '../model/evaluate'
import { createEditorStore, editTarget, keyOwner } from './store'
import { groundZ, bodyMat } from '../model/bodyPose'
import { footMat, legsOf } from '../model/legIk'

const defs: RobotDefs = { g1: loadDef('g1'), go2: loadDef('go2') }
let st: ReturnType<typeof createEditorStore>
let actor: string
const s = () => st.getState()

beforeEach(() => {
  st = createEditorStore(defs)
  actor = s().project.actors[0].id
})

test('editPose writes several channels as one undo step, even inside an open gesture', () => {
  const before = s().project
  s().beginGesture()
  expect(s().editPose(actor, { 'root.x': 0.3, left_knee_joint: 0.5 })).toBe(true)
  expect(s().editPose(actor, { 'root.x': 0.4 })).toBe(true)
  s().endGesture()
  expect(s().poseAt(actor)!.body.x).toBeCloseTo(0.4)
  s().undo()
  expect(s().project).toBe(before)
})
test('editPose outside a gesture is one undo step', () => {
  const before = s().project
  s().editPose(actor, { 'root.x': 0.3, left_knee_joint: 0.5 })
  expect(s().inGesture).toBe(false)
  s().undo()
  expect(s().project).toBe(before)
})
test('feetLock: small move keeps feet, 1 m move is refused and changes nothing', () => {
  s().setFeetLock(true)
  expect(s().editPose(actor, { 'root.x': s().poseAt(actor)!.body.x + 0.03 })).toBe(true)
  const before = s().project
  expect(s().editPose(actor, { 'root.x': 5 })).toBe(false)
  expect(s().project).toBe(before)
})
test('autoGround: knee bend recomputes root.z so the lowest foot is on the floor', () => {
  s().setAutoGround(true)
  s().editPose(actor, { left_knee_joint: 1.2, right_knee_joint: 1.2 })
  const p = s().poseAt(actor)!
  expect(p.body.z).toBeCloseTo(groundZ(p.def, p.q, p.body), 3)
})
test('standPose: rest joints, zero tilt, rest height, x/y/yaw kept; works over an existing piece edit; one undo', () => {
  s().setValue(actor, 'left_knee_joint', 1)
  s().editPose(actor, { 'root.x': 0.2, 'root.yaw': 0.5, 'root.pitch': 0.1 })
  const before = s().project
  s().standPose(actor)
  const p = s().poseAt(actor)!
  p.def.joints.forEach((_, i) => expect(p.q[i]).toBeCloseTo(p.def.rest.q[i], 4))
  expect(p.body).toMatchObject({ x: expect.closeTo(0.2), yaw: expect.closeTo(0.5), pitch: expect.closeTo(0), roll: expect.closeTo(0), z: expect.closeTo(p.def.rest.z) })
  s().undo(); expect(s().project).toBe(before)
})
test('keyPose keys every root and joint channel at the frame', () => {
  s().setFrame(7)
  s().keyPose(actor)
  const f = editTarget(s(), actor)!.f
  const own = keyOwner(s().project, s().project.sequence.tracks.find(t => t.actorId === actor)!.items[0].id)!
  const names = ['root.x', 'root.y', 'root.z', 'root.roll', 'root.pitch', 'root.yaw', ...defs.g1.joints.map(j => j.name)]
  for (const n of names) expect(own.channels[n]?.keys.some(k => k.f === f), n).toBe(true)
})

test('undo mid-gesture cancels the pose edit and ignores later editPose calls until endGesture', () => {
  const before = s().project
  s().beginGesture()
  expect(s().editPose(actor, { 'root.x': 0.3 })).toBe(true)
  s().undo()
  expect(s().project).toBe(before)
  expect(s().editPose(actor, { 'root.x': 0.5 })).toBe(false)
  s().editPose(actor, { 'root.x': 0.6 })
  expect(s().project).toBe(before)
  s().endGesture()
  expect(s().editPose(actor, { 'root.x': 0.7 })).toBe(true)
  expect(s().poseAt(actor)!.body.x).toBeCloseTo(0.7)
})
test('feetLock + autoGround: feet stay within 1 cm while the body is raised and moved', () => {
  s().setFeetLock(true); s().setAutoGround(true)
  s().editPose(actor, { 'root.z': s().poseAt(actor)!.body.z + 0.03 })
  const feet = () => { const p = s().poseAt(actor)!; return legsOf(p.def).map(l => footMat(l, bodyMat(p.body), p.q)) }
  const a = feet()
  expect(s().editPose(actor, { 'root.x': s().poseAt(actor)!.body.x + 0.03 })).toBe(true)
  const b = feet()
  a.forEach((m, i) => [3, 7, 11].forEach(k => expect(Math.abs(m[k] - b[i][k])).toBeLessThan(0.01)))
})

test('shiftBody (체중 이동): the body moves along its own heading, the feet stay (feetLock off too), one undo; too far is refused', () => {
  for (const robot of ['g1', 'go2'] as const) {
    const st2 = createEditorStore(defs), g = () => st2.getState()
    if (robot === 'go2') g().addActor('go2')
    const id = g().project.actors.find(a => a.robot === robot)!.id
    g().standPose(id) // 차렷 (a new GO2 actor's empty clip has straight legs: nothing to bend)
    g().editPose(id, { 'root.yaw': Math.PI / 2 }) // facing +y: 앞 = +y, 왼쪽 = −x
    expect(g().feetLock).toBe(false)
    const feet = () => { const p = g().poseAt(id)!; return legsOf(p.def).map(l => footMat(l, bodyMat(p.body), p.q)) }
    const a = feet(), b0 = g().poseAt(id)!.body, before = g().project
    expect(g().shiftBody(id, 0.02, 0)).toBe(true)
    expect(g().shiftBody(id, 0, 0.02)).toBe(true)
    const b1 = g().poseAt(id)!.body
    expect(b1.x - b0.x).toBeCloseTo(-0.02, 4); expect(b1.y - b0.y).toBeCloseTo(0.02, 4)
    feet().forEach((m, i) => [3, 7, 11].forEach(k => expect(Math.abs(m[k] - a[i][k])).toBeLessThan(0.01)))
    g().undo(); g().undo()
    expect(g().project).toBe(before)
    expect(g().shiftBody(id, 1, 0)).toBe(false)
    expect(g().project).toBe(before)
  }
})
