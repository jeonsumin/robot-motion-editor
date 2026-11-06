import { describe, expect, test } from 'vitest'
import { loadDef } from '../test/defs'
import type { Pose } from '../model/pose'
import { CONTEXT, detectSuspects as detectAll, itemSeries, partOf, startJump } from './detect'

const g1 = loadDef('g1'), J = g1.joints.length
// the jump items only: these synthetic motions swing every joint at random, so the arms also cross the torso (자가충돌, collide.test.ts)
// and the feet slide (발 미끄러짐, feet.test.ts)
const detectSuspects = (ps: Pose[], def: typeof g1) => detectAll(ps, def).filter(s => s.kind === 'limit' || s.kind === 'rel' || s.kind === 'start')
const idx = (n: string) => g1.joints.findIndex(j => j.name === n)
// a calm dance: every joint swings slowly (≤ 1 rad/s), root walks a little
const calm = (n = 600): Pose[] => Array.from({ length: n }, (_, t) => ({
  rootPos: [0.002 * t, 0, 0.78], rootQuat: [0, 0, 0, 1],
  q: Array.from({ length: J }, (_, j) => 0.3 * Math.sin(t / 40 + j)),
}))
const set = (ps: Pose[], from: number, to: number, joint: string, add: number) => {
  const k = idx(joint)
  for (let t = from; t <= to && t < ps.length; t++) ps[t].q[k] += add
}

describe('detectSuspects', () => {
  test('a calm motion has no suspects', () => {
    expect(detectSuspects(calm(), g1)).toEqual([])
  })

  test('a held flip (IK branch change) = one 로봇 한계 초과 item at the jump frame', () => {
    const ps = calm(); set(ps, 300, 599, 'right_wrist_roll_joint', 2.5) // 150 rad/s, then stays
    const s = detectSuspects(ps, g1)
    expect(s).toHaveLength(1)
    expect(s[0]).toMatchObject({ kind: 'limit', from: 300, to: 300, worst: 300, joints: ['right_wrist_roll_joint'], parts: ['오른팔'] })
    expect(s[0].ratio).toBeCloseTo(2.5 * 60 / 37, 0)
    expect(s[0].jump).toBeCloseTo(2.5, 1)
  })

  test('a flip and its return 0.2 s later = one item (grouped), two separate flips far apart = two items, worst first', () => {
    const ps = calm(); set(ps, 200, 211, 'left_wrist_yaw_joint', 1.5) // in at 200, back at 212
    set(ps, 450, 599, 'left_elbow_joint', 2.0)
    const s = detectSuspects(ps, g1)
    expect(s.map(x => [x.from, x.to])).toEqual([[200, 212], [450, 450]]) // wrist: 90 rad/s / 22 = 4.1×, elbow 120 / 37 = 3.2×
    expect(s[0].joints).toEqual(['left_wrist_yaw_joint'])
  })

  test('a one-frame spike is flagged at its frame and at its return', () => {
    const ps = calm(); set(ps, 333, 333, 'right_shoulder_pitch_joint', 1.2)
    const s = detectSuspects(ps, g1)
    expect(s).toHaveLength(1)
    expect([s[0].from, s[0].to]).toEqual([333, 334])
  })

  test('파일 기준 급변: under the limit but far off this motion (≥ 70 % of the limit)', () => {
    const ps = calm(); set(ps, 300, 599, 'left_knee_joint', 0.27) // 16.2 rad/s: 81 % of the knee limit 20
    const s = detectSuspects(ps, g1)
    expect(s).toHaveLength(1)
    expect(s[0]).toMatchObject({ kind: 'rel', from: 300, joints: ['left_knee_joint'], parts: ['왼다리'] })
  })

  test('a fast but smooth swing well under the limit is not flagged', () => {
    const ps = calm(); const k = idx('right_shoulder_yaw_joint')
    for (let t = 0; t < ps.length; t++) ps[t].q[k] = 1.2 * Math.sin(t / 6) // peak 12 rad/s, smooth
    expect(detectSuspects(ps, g1)).toEqual([])
  })

  test('첫 프레임 튐: an imported rest-pose row 1 is one start item, frame 1 is not counted again', () => {
    const ps = calm(); ps[0] = { rootPos: [0, 0, 0.793], rootQuat: [0, 0, 0, 1], q: ps[0].q.map((v, j) => (j === idx('left_elbow_joint') ? v + 1.5 : v)) }
    expect(startJump(ps)).toBe(true)
    const s = detectSuspects(ps, g1)
    expect(s).toHaveLength(1)
    expect(s[0]).toMatchObject({ kind: 'start', from: 0, to: 1, joints: ['left_elbow_joint'] })
    expect(startJump(calm())).toBe(false)
  })

  test('itemSeries: frames around the item, speed / limit of its joints, worst frame highest', () => {
    const ps = calm(); set(ps, 300, 599, 'right_wrist_roll_joint', 2.5)
    const [s] = detectSuspects(ps, g1), r = itemSeries(ps, g1, s)
    expect(r.from).toBe(300 - CONTEXT)
    expect(r.values).toHaveLength(2 * CONTEXT + 1)
    expect(r.values.indexOf(Math.max(...r.values))).toBe(CONTEXT)
    expect(r.values[CONTEXT]).toBeGreaterThan(1)
  })

  test('partOf names G1 and GO2 parts', () => {
    expect(['left_wrist_roll_joint', 'right_knee_joint', 'waist_yaw_joint', 'FL_calf_joint', 'RR_hip_joint'].map(partOf))
      .toEqual(['왼팔', '오른다리', '허리', '앞왼다리', '뒤오른다리'])
  })
})
