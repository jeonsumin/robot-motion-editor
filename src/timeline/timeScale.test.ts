import { loadDef } from '../test/defs'
import { expect, test } from 'vitest'

import type { RobotDefs } from '../model/evaluate'
import { newProject } from '../model/defaults'
import { makeKey } from '../model/curve'
import { buildRows, formatTimecode, frameToX, hitKey, hoverFrame, keysIn, ROOT_CHANNELS, xToFrame } from './timeScale'

const load = loadDef
const defs: RobotDefs = { g1: load('g1'), go2: load('go2') }
const g1Only = () => { const p = newProject(); return { ...p, actors: [p.actors[0]] } }

test('frame<->x roundtrip', () => {
  const s = { x0: 160, pxPerFrame: 4 }
  expect(xToFrame(s, frameToX(s, 37))).toBe(37)
})

test('timecode', () => {
  expect(formatTimecode(0)).toBe('00:00.00')
  expect(formatTimecode(61)).toBe('00:01.01')
  expect(formatTimecode(3600)).toBe('01:00.00')
  expect(formatTimecode(-61)).toBe('-00:01.01')
})

test('buildRows: one row per actor holding root + every joint channel', () => {
  const rows = buildRows(g1Only(), defs)
  expect(rows).toHaveLength(1)
  expect(rows[0].channels).toEqual([...ROOT_CHANNELS, ...defs.g1.joints.map(j => j.name)])
})

test('hitKey on the one row returns every channel key at that frame', () => {
  const p = g1Only()
  const clip = Object.values(p.clips)[0]
  clip.channels['root.x'] = { keys: [makeKey(10, 0), makeKey(20, 0)] }
  clip.channels['left_knee_joint'] = { keys: [makeKey(10, 0)] }
  const rows = buildRows(p, defs)
  const s = { x0: 160, pxPerFrame: 4 }, H = 20
  const x = frameToX(s, 10)
  expect(hitKey(rows, clip, s, H, x + 3, 10)).toEqual([{ channel: 'root.x', f: 10 }, { channel: 'left_knee_joint', f: 10 }])
  expect(hitKey(rows, clip, s, H, x + 6, 10)).toBeNull()
})

test('keysIn returns sorted keys with lo <= f <= hi', () => {
  const ks = [0, 3, 5, 9, 12].map(f => makeKey(f, 0))
  expect(keysIn(ks, 4, 9).map(k => k.f)).toEqual([5, 9])
  expect(keysIn(ks, -5, 0).map(k => k.f)).toEqual([0])
  expect(keysIn(ks, 13, 20)).toEqual([])
  expect(keysIn([], 0, 9)).toEqual([])
})

test('hoverFrame: null in the label column or when busy, else the frame under x', () => {
  const sc = { x0: 100, pxPerFrame: 2 }
  expect(hoverFrame(100, 100, sc, false)).toBe(null)
  expect(hoverFrame(50, 100, sc, false)).toBe(null)
  expect(hoverFrame(200, 100, sc, true)).toBe(null)
  expect(hoverFrame(200, 100, sc, false)).toBe(50)
})

test('parseTimecode: a bare number is a frame; m:ss.ff like the display (ff = frames 0-59, missing = 0); else null', async () => {
  const { parseTimecode, formatTimecode } = await import('./timeScale')
  expect(parseTimecode('11192')).toBe(11192)
  expect(parseTimecode(' 02:25.43 ')).toBe((2 * 60 + 25) * 60 + 43)
  expect(parseTimecode('2:25')).toBe((2 * 60 + 25) * 60)
  expect(parseTimecode('0:01.4')).toBe(64)
  expect(parseTimecode(formatTimecode(8743))).toBe(8743) // round trip with the display
  for (const bad of ['', 'abc', '1:60', '1:00.60', '1.5', '-3', '1:2:3']) expect(parseTimecode(bad)).toBeNull()
})
