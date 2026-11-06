import { describe, expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { loadDef } from '../test/defs'
import type { Pose } from '../model/pose'
import type { Vec3 } from '../robot/types'
import { centerOfMass, feetTrack, footSlips, frictionItems, frictionNeed, slipSeries, type FeetTrack } from './feet'
import { detectSuspects } from './detect'

const g1 = loadDef('g1'), go2 = loadDef('go2')
const yawQ = (t: number): [number, number, number, number] => [0, 0, Math.sin(t / 2), Math.cos(t / 2)]
const stand = (def: typeof g1, x = 0, y = 0, z = def.rest.z, yaw = 0): Pose => ({ rootPos: [x, y, z], rootQuat: yawQ(yaw), q: [...def.rest.q] })
const clip = (n: number, at: (f: number) => Pose) => Array.from({ length: n }, (_, f) => at(f))

describe('발 미끄러짐 · 마찰 부족 (§16)', () => {
  test('centre of mass = MuJoCo\'s (physics model masses, URDF link frames) for G1 and GO2', () => {
    const ref = JSON.parse(readFileSync(new URL('../test/com.ref.json', import.meta.url), 'utf8')) as Record<'g1' | 'go2', { q: Record<string, number>; com: Vec3 }[]>
    for (const [def, cases] of [[g1, ref.g1], [go2, ref.go2]] as const) for (const c of cases) {
      const [com] = centerOfMass([{ rootPos: [0.1, -0.2, 0.5], rootQuat: yawQ(0.4), q: def.joints.map(j => c.q[j.name]) }], def)!
      com.forEach((v, i) => expect(v).toBeCloseTo(c.com[i], 4))
    }
  })

  test('standing still: feet down, nothing found (G1, GO2)', () => {
    for (const def of [g1, go2]) {
      const t = feetTrack(clip(120, () => stand(def)), def)!
      expect(t.down.every(d => d.every(Boolean))).toBe(true)
      expect([...footSlips(t), ...frictionItems(t)]).toEqual([])
    }
  })

  test('the whole robot gliding at 10 cm/s with its feet down = one 경고 per foot; at 50 cm/s it is stepping, not sliding', () => {
    for (const def of [g1, go2]) {
      const s = footSlips(feetTrack(clip(120, f => stand(def, f < 60 ? 0 : (f - 60) * 0.1 / 60)), def)!)
      expect(s).toHaveLength(def.kind === 'g1' ? 2 : 4)
      for (const x of s) {
        expect(x).toMatchObject({ kind: 'footSlip', from: 60, to: 118, level: 'warn' })
        expect(x.travel!).toBeCloseTo(0.0983, 2) // 59 frames × 10 cm/s
      }
      expect(footSlips(feetTrack(clip(120, f => stand(def, f < 60 ? 0 : (f - 60) * 0.5 / 60)), def)!)).toEqual([])
    }
  })

  test('a foot in the air does not slide; the floor is the motion\'s own (a clip a few mm under z = 0)', () => {
    const lifted = clip(120, f => stand(g1, f < 90 ? 0 : (f - 90) * 0.1 / 60, 0, g1.rest.z + (f < 90 ? -0.005 : 0.05)))
    const t = feetTrack(lifted, g1)!
    expect(t.floor).toBeLessThan(-0.003)
    expect(t.down[0][100]).toBe(false)
    expect(footSlips(t)).toEqual([])
  })

  test('weight share: 경고 for a foot carrying its share, 주의 for a dragged one; a G1 foot turning in place = 주의 (제자리 회전)', () => {
    const N = 20, still = (x: number): Vec3[] => Array.from({ length: N }, () => [x, 0, 0])
    const track = (com: number, turn = 0, move = 0.05): FeetTrack => ({
      feet: [{ link: 'left_ankle_roll_link', label: '왼발', orient: true }, { link: 'right_ankle_roll_link', label: '오른발', orient: true }],
      low: [new Array(N).fill(0), new Array(N).fill(0)], down: [new Array(N).fill(true), new Array(N).fill(true)],
      slide: [new Array(N).fill(0.1), new Array(N).fill(0)], move: [new Array(N).fill([0.1 / 60, 0]), new Array(N).fill([0, 0])], at: [Array.from({ length: N }, (_, f) => [f * move / N, 0.2, 0] as Vec3), still(0).map(() => [0, -0.2, 0])],
      yaw: [Array.from({ length: N }, (_, f) => turn * f / N), new Array(N).fill(0)], com: still(0).map(() => [0, com, 0.6] as Vec3), floor: 0,
    })
    expect(footSlips(track(0.15))[0]).toMatchObject({ level: 'warn', parts: ['왼발'] }) // weight over the sliding foot
    const drag = footSlips(track(-0.15))[0] // weight over the other foot
    expect(drag.level).toBe('note'); expect(drag.load!).toBeLessThan(0.4)
    expect(footSlips(track(0.15, 0.6, 0.01))[0]).toMatchObject({ level: 'note', pivot: true })
  })

  test('마찰 부족: pushing the body sideways at 7 m/s² = 주의 (μ ≈ 0.7), at 12 m/s² = 경고; standing still needs none', () => {
    const push = (a: number) => clip(120, f => { const t = Math.max(0, f - 50) / 60, u = Math.min(t, 20 / 60); return stand(g1, 0, 0.5 * a * u * u + a * (20 / 60) * (t - u)) })
    // accelerating over frames 50–70, then gliding on (the feet slide too: also 발 미끄러짐)
    const note = frictionItems(feetTrack(push(7), g1)!), warn = frictionItems(feetTrack(push(12), g1)!)
    expect(note).toHaveLength(1); expect(note[0]).toMatchObject({ kind: 'friction', level: 'note' }); expect(note[0].mu!).toBeCloseTo(7 / 9.81, 1)
    expect(warn[0]).toMatchObject({ level: 'warn' }); expect(warn[0].mu!).toBeGreaterThan(1)
    expect(Math.max(...frictionNeed(feetTrack(clip(60, () => stand(g1)), g1)!))).toBe(0)
  })

  test('detectSuspects lists them after the jumps and collisions; 구간 지표 = the contact point\'s speed (cm/s)', () => {
    const ps = clip(120, f => stand(g1, f < 60 ? 0 : (f - 60) * 0.1 / 60))
    const s = detectSuspects(ps, g1).filter(x => x.kind === 'footSlip')
    expect(s).toHaveLength(2)
    const c = slipSeries(ps, g1, s[0], 12)
    expect(c.from).toBe(48)
    expect(c.values[0]).toBe(0)
    expect(c.values[20]).toBeCloseTo(10, 0)
  })
})
