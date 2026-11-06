import { describe, expect, test } from 'vitest'
import { loadDef } from '../test/defs'
import type { Pose, RobotDefs } from '../model/pose'
import { evalCurve, makeKey } from '../model/curve'
import { addFrameDeltas } from '../model/rangeEdit'
import { createEditorStore } from '../store/store'
import { detectSuspects } from './detect'
import { feetTrack, footSlips } from './feet'
import { FIX, planFootFix } from './footFix'

const g1 = loadDef('g1'), go2 = loadDef('go2'), defs: RobotDefs = { g1, go2 }
const yawQ = (t: number): [number, number, number, number] => [0, 0, Math.sin(t / 2), Math.cos(t / 2)]
const ss = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x))
// glides 10 cm/s with its feet down from frame 60, then (frame 100) rises 8 cm over 12 frames: the feet leave the floor
const glideLift = (def: typeof g1, n = 160, lift = 100): Pose[] => Array.from({ length: n }, (_, f) => ({
  rootPos: [Math.max(0, Math.min(f, lift) - 60) * 0.1 / 60, 0, def.rest.z + 0.08 * ss((f - lift) / 12)], rootQuat: yawQ(0), q: [...def.rest.q],
}))

describe('발 미끄러짐 추천대로 고치기 (§17)', () => {
  test('the slide is undone until the feet lift: the item is gone, nothing new, the leg bends a few degrees (G1, GO2)', () => {
    for (const def of [g1, go2]) {
      const ps = glideLift(def), found = detectSuspects(ps, def), slip = found.find(s => s.kind === 'footSlip')!
      expect(slip).toBeDefined()
      const fix = planFootFix(ps, def, slip, found)
      expect(fix.why).toEqual([])
      expect(fix.ok).toBe(true)
      expect(fix.k).toBe(1); expect(fix.rest).toBe(0) // the full fix: nothing left
      expect(fix.hold[0]).toBe(60); expect(fix.hold[1]).toBeGreaterThan(100); expect(fix.hold[1]).toBeLessThan(108) // lifted 12 mm a few frames into the rise
      expect(fix.drift).toBeCloseTo(0.0667, 2) // 40 frames × 10 cm/s
      expect(fix.maxDeg).toBeLessThan(15)
      expect(fix.q).toHaveLength(fix.to - fix.from + 1)
      expect(footSlips(feetTrack(fix.poses!, def)!).filter(s => s.foot === slip.foot)).toEqual([])
    }
  })

  test('a short hop of a dragged foot (up under FIX.air frames) is part of the drag: held on until the real lift', () => {
    // knees bent (room to reach); glides 10 cm/s from frame 60, hops 2 cm for 3 frames at 90 (still gliding), rises off the floor at 120
    const q = g1.joints.map((j, i) => (/knee/.test(j.name) ? 0.6 : /hip_pitch|ankle_pitch/.test(j.name) ? -0.3 : g1.rest.q[i]))
    const ps: Pose[] = Array.from({ length: 180 }, (_, f) => ({ rootPos: [Math.max(0, Math.min(f, 120) - 60) * 0.1 / 60, 0, 0.74 + (f >= 90 && f < 93 ? 0.02 : 0) + 0.08 * ss((f - 120) / 12)], rootQuat: yawQ(0), q }))
    const found = detectSuspects(ps, g1), slip = found.find(s => s.kind === 'footSlip' && s.from === 60)!
    const fix = planFootFix(ps, g1, slip, found)
    expect(fix.hold[1]).toBeGreaterThan(120) // not 90: the hop does not end the hold
    expect(fix.shift).toBeGreaterThan(0.05); expect(fix.shiftAt).toBeGreaterThan(110)
  })

  test('붙잡는 세기: when the full fix fails a check, a weaker one undoes part of the slide (the rest stays listed)', () => {
    // straight legs, glides 12 cm/s for 60 frames (12 cm), then rises: undoing all of it is out of the leg's reach
    const ps: Pose[] = Array.from({ length: 180 }, (_, f) => ({ rootPos: [Math.max(0, Math.min(f, 120) - 60) * 0.12 / 60, 0, g1.rest.z + 0.08 * ss((f - 120) / 12)], rootQuat: yawQ(0), q: [...g1.rest.q] }))
    const found = detectSuspects(ps, g1), slip = found.find(s => s.kind === 'footSlip')!, fix = planFootFix(ps, g1, slip, found)
    expect(fix.ok).toBe(true)
    expect(fix.k).toBe(0.6) // 100 % and 80 %: the leg does not reach
    expect(fix.why).toEqual([])
    expect(fix.rest).toBeGreaterThan(0); expect(fix.rest).toBeLessThanOrEqual(FIX.restMax * slip.travel!) // 12 cm → about 5 cm left
    expect(fix.drift).toBeCloseTo(0.12, 1) // the whole slide, of which 60 % is undone
  })

  test('a foot that never lifts cannot be held: refused with the reason', () => {
    const ps = Array.from({ length: 120 }, (_, f) => ({ rootPos: [Math.max(0, f - 60) * 0.1 / 60, 0, g1.rest.z] as [number, number, number], rootQuat: yawQ(0), q: [...g1.rest.q] }))
    const found = detectSuspects(ps, g1), fix = planFootFix(ps, g1, found.find(s => s.kind === 'footSlip')!, found)
    expect(fix.ok).toBe(false)
    expect(fix.why[0]).toMatch(/발을 떼는 순간/)
  })

  test('a slide too long for the leg is refused (다리가 닿지 않음)', () => {
    const ps: Pose[] = Array.from({ length: 220 }, (_, f) => ({ rootPos: [Math.max(0, Math.min(f, 160) - 10) * 0.25 / 60, 0, g1.rest.z + 0.08 * ss((f - 160) / 12)], rootQuat: yawQ(0), q: [...g1.rest.q] }))
    const found = detectSuspects(ps, g1), fix = planFootFix(ps, g1, found.find(s => s.kind === 'footSlip')!, found)
    expect(fix.ok).toBe(false)
    expect(fix.why.join(' ')).toMatch(/닿지 않음/)
  })

  test('addFrameDeltas: per-frame values added on their frames as linear keys, the curve outside untouched', () => {
    const c = { keys: [makeKey(0, 1, 'linear'), makeKey(100, 2, 'linear')] }
    const r = addFrameDeltas(c, 0, 40, [0.1, 0.2, 0.3], 101)
    expect(evalCurve(r, 39, 0)).toBeCloseTo(1.39); expect(evalCurve(r, 40, 0)).toBeCloseTo(1.5); expect(evalCurve(r, 42, 0)).toBeCloseTo(1.72)
    expect(evalCurve(r, 43, 0)).toBeCloseTo(1.43); expect(evalCurve(r, 100, 0)).toBeCloseTo(2)
    expect(addFrameDeltas(undefined, 0, 5, [1], 10).keys.map(k => [k.f, k.v])).toEqual([[0, 0], [4, 0], [5, 1], [6, 0]])
  })

  test('addOffsetDeltas: on the piece\'s 수정 층 (clip untouched), one undo step; refused for a piece set to 원본 사용', () => {
    const st = createEditorStore(defs), s = () => st.getState(), it = s().project.sequence.tracks[0].items[0], clip = s().project.clips[it.refId]
    expect(s().addOffsetDeltas(it.id, 10, { left_knee_joint: [0.1, 0.2] })).toBe(true)
    const o = s().project.sequence.tracks[0].items[0].offset!.left_knee_joint
    expect(evalCurve(o, 11, 0)).toBeCloseTo(0.2)
    expect(s().project.clips[it.refId]).toBe(clip)
    s().undo()
    expect(s().project.sequence.tracks[0].items[0].offset).toBeUndefined()
    s().addOffsetDeltas(it.id, 10, { left_knee_joint: [0.1] })
    expect(s().setItemUse(it.id, 'original')).toBe(true)
    expect(s().addOffsetDeltas(it.id, 10, { left_knee_joint: [0.1] })).toBe(false) // it would not play
  })
})
