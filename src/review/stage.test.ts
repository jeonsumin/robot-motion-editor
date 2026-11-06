import { describe, expect, test } from 'vitest'
import { loadDef } from '../test/defs'
import type { RobotDefs } from '../model/pose'
import { makeKey } from '../model/curve'
import { newProject } from '../model/defaults'
import { eulerToQuat } from '../model/rootMath'
import type { Project } from '../model/types'
import { floorBox } from './collide'
import { STAGE_TOL, stageCheck, stageSeries } from './stage'

const defs: RobotDefs = { g1: loadDef('g1'), go2: loadDef('go2') }
// a G1 project whose one piece walks along x from 0 to `to` m over its clip (stage 10 × 6 m: x = depth 6 → edge at ±3 m)
function walkProject(to: number): Project {
  const p = newProject(), it = p.sequence.tracks[0].items[0], c = p.clips[it.refId]
  c.channels['root.x'] = { keys: [makeKey(0, 0, 'linear'), makeKey(c.length - 1, to, 'linear')] }
  return p
}

describe('무대 이탈 (§18)', () => {
  test('floorBox: the robot\'s reach over the floor follows the root (moved, turned) — G1 arms included, GO2 body', () => {
    for (const def of [defs.g1, defs.go2]) {
      const at = (x: number, y: number, yaw: number) => floorBox({ rootPos: [x, y, def.rest.z], rootQuat: eulerToQuat(0, 0, yaw), q: [...def.rest.q] }, def)
      const b = at(0, 0, 0), m = at(1, 2, 0), t = at(0, 0, Math.PI / 2)
      expect(b[1] - b[0]).toBeGreaterThan(0.1); expect(b[1] - b[0]).toBeLessThan(0.9)
      expect(b[3] - b[2]).toBeGreaterThan(0.1); expect(b[3] - b[2]).toBeLessThan(0.9)
      m.forEach((v, i) => expect(v).toBeCloseTo(b[i] + (i < 2 ? 1 : 2), 6))
      expect(t[3] - t[2]).toBeCloseTo(b[1] - b[0], 3) // turned 90°: its x reach is now along y
    }
  })

  test('a piece walking to x = 3.5 m goes past the 객석 edge: one item, how far, and the 배치 change that brings it in', () => {
    const p = walkProject(3.5), it = p.sequence.tracks[0].items[0], c = stageCheck(p, defs, it.id)!
    expect(c.items).toHaveLength(1)
    const s = c.items[0], reach = Math.max(...c.boxes.map(b => b[1]))
    expect(s).toMatchObject({ kind: 'stage', side: 'front', parts: ['객석 쪽'], to: c.boxes.length - 1, worst: c.boxes.length - 1 })
    expect(s.over!).toBeCloseTo(reach - 3, 6)
    expect(c.move![0]).toBeCloseTo(3 - STAGE_TOL - reach, 6); expect(c.move![1]).toBe(0)
    expect(c.others).toBe(0)
    const series = stageSeries(c, s, p, 12)
    expect(series.values.at(-1)).toBeCloseTo(s.over! * 100, 4)
    // the suggested 배치 applied by hand: nothing found any more
    const q = structuredClone(p); q.actors[0].placement.x += c.move![0]
    expect(stageCheck(q, defs, it.id)!.items).toEqual([])
  })

  test('inside the stage: nothing; wider than the stage: no 배치 can bring it in; a bigger 무대 does', () => {
    const p = walkProject(1.5)
    expect(stageCheck(p, defs, p.sequence.tracks[0].items[0].id)!.items).toEqual([])
    const w = walkProject(7), c = stageCheck(w, defs, w.sequence.tracks[0].items[0].id)!
    expect(c.items.length).toBeGreaterThan(0)
    expect(c.move).toBeNull()
    w.stage = { width: 6, depth: 12 }; w.actors[0].placement.x = -3.5
    expect(stageCheck(w, defs, w.sequence.tracks[0].items[0].id)!.items).toEqual([])
  })

  test('the 배치 change counts the other pieces of the robot it would push out', () => {
    // the first piece goes out to x = 3.5 and comes back to 0; the second (stitched at 0) walks back to x = −2.8: inside now
    const p = walkProject(0), t = p.sequence.tracks[0], it = t.items[0], c1 = p.clips[it.refId], mid = c1.length >> 1
    c1.channels['root.x'] = { keys: [makeKey(0, 0, 'linear'), makeKey(mid, 3.5, 'linear'), makeKey(c1.length - 1, 0, 'linear')] }
    const c2 = structuredClone(c1); c2.id = 'back'; c2.name = 'back'
    c2.channels['root.x'] = { keys: [makeKey(0, 0, 'linear'), makeKey(c2.length - 1, -2.8, 'linear')] }
    p.clips.back = c2
    t.items.push({ ...structuredClone(it), id: 'i2', refId: 'back', start: it.start + it.trimOut - it.trimIn })
    expect(stageCheck(p, defs, 'i2')!.items).toEqual([])
    const c = stageCheck(p, defs, it.id)!
    expect(c.move![0]).toBeLessThan(-0.4)
    expect(c.others).toBe(1) // moving the robot back pushes the second piece past the back edge
  })
})
