import { describe, expect, test } from 'vitest'
import { loadDef } from '../test/defs'
import type { Pose } from '../model/pose'
import { BODY_PAIRS, HAND_PAIR, overlapLinks, pairDepths } from './collide'
import { collisionSeries, detectSuspects } from './detect'

const g1 = loadDef('g1'), go2 = loadDef('go2'), J = g1.joints.length
const pose = (set: Record<string, number> = {}): Pose => ({ rootPos: [0, 0, 0.78], rootQuat: [0, 0, 0, 1], q: Array.from({ length: J }, (_, i) => set[g1.joints[i].name] ?? g1.rest.q[i]) })
const FORE_IN = { left_shoulder_roll_joint: -0.3, left_shoulder_yaw_joint: -0.8 } // left forearm ~3 cm into the torso, nothing else
const CROSS = { left_shoulder_roll_joint: -0.6, left_shoulder_yaw_joint: -0.8 } // deeper, the left hand also on the right forearm and hand
const GRAZE = { left_shoulder_roll_joint: -0.18, left_shoulder_yaw_joint: -0.8 } // ~3 mm: under the 5 mm 기준
const seq = (n: number, at: [number, number, Record<string, number>][]) => Array.from({ length: n }, (_, t) => pose(at.find(([a, b]) => t >= a && t <= b)?.[2]))
const kinds = (ps: Pose[]) => detectSuspects(ps, g1).filter(s => s.depth !== undefined)

describe('자가충돌 (§14 · §15: the links\' mesh hulls)', () => {
  test('the standing pose is clear; GO2 is not checked', () => {
    expect(Math.max(...pairDepths([pose()], g1, [...BODY_PAIRS, HAND_PAIR])![0])).toBeLessThanOrEqual(0)
    expect(pairDepths([pose()], go2, BODY_PAIRS)).toBeNull()
    expect(overlapLinks(pose(), go2, BODY_PAIRS)).toEqual([])
  })

  test('a forearm into the torso for 10 frames = one 자가충돌 item with its pair, worst frame and depth', () => {
    const s = kinds(seq(120, [[60, 69, FORE_IN]]))
    expect(s).toHaveLength(1)
    expect(s[0]).toMatchObject({ kind: 'collision', from: 60, to: 69, parts: ['왼아래팔×몸통'] })
    expect(s[0].depth!).toBeGreaterThan(25)
    expect(s[0].depth!).toBeLessThan(40)
    const c = collisionSeries(seq(120, [[60, 69, FORE_IN]]), g1, s[0])
    expect(c.from).toBe(48); expect(c.values).toHaveLength(10 + 24); expect(c.values[0]).toBe(0); expect(c.values[12]).toBeCloseTo(s[0].depth!, 5)
  })

  test('손 × 손 is its own kind (손 맞닿음); the other overlaps of that pose are one 자가충돌 item, deepest pair first', () => {
    const s = kinds(seq(120, [[60, 69, CROSS]]))
    expect(s.map(x => x.kind)).toEqual(['collision', 'handTouch'])
    expect(s[0].parts[0]).toBe('왼아래팔×몸통')
    expect(s[0].parts).not.toContain('왼손×오른손')
    expect(s[1]).toMatchObject({ from: 60, to: 69, parts: ['왼손×오른손'] })
    expect(s[1].depth!).toBeGreaterThan(20)
  })

  test('the parts painted red: only the links that overlap in that pose', () => {
    expect(overlapLinks(pose(FORE_IN), g1, BODY_PAIRS).sort()).toEqual(['left_elbow_link', 'torso_link'])
    expect(overlapLinks(pose(), g1, BODY_PAIRS)).toEqual([])
    expect(overlapLinks(pose(CROSS), g1, [HAND_PAIR]).every(l => /wrist|hand/.test(l))).toBe(true)
  })

  test('under 5 mm, or one frame only, is not flagged; gaps up to 6 frames join one item', () => {
    expect(kinds(seq(120, [[60, 69, GRAZE]]))).toEqual([])
    expect(kinds(seq(120, [[60, 60, FORE_IN]]))).toEqual([])
    expect(kinds(seq(120, [[40, 44, FORE_IN], [50, 54, FORE_IN], [80, 84, FORE_IN]])).map(x => [x.from, x.to])).toEqual([[40, 54], [80, 84]])
  })
})
