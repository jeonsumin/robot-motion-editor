import { readFileSync } from 'node:fs'
import { expect, test } from 'vitest'
import { loadDef } from '../test/defs'
import type { RobotDefs } from '../model/evaluate'
import { CLIP_ACTOR, createEditorStore } from '../store/store'
import { csvToClip } from './importCsv'
import { editRanges, editsJson, jumpWarnings, mergeRanges, rlClipExport, rlItemExport } from './rlExport'
import { sha256 } from './sha256'

const defs: RobotDefs = { g1: loadDef('g1'), go2: loadDef('go2') }

test('sha256: standard vectors (UTF-8)', () => {
  expect(sha256('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
  expect(sha256('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  expect(sha256('a'.repeat(1000))).toBe('41edece42d63e8d9bf515a9ba6932e1c20cbc9f5a5d134645adb5db1b9737ea3')
})

test('mergeRanges: overlapping and touching ranges become one; sorted', () => {
  expect(mergeRanges([[10, 12], [1, 3], [4, 5], [11, 20], [30, 30]])).toEqual([[1, 5], [10, 20], [30, 30]])
})

test('editsJson: names the CSV, its hash, fps, the row rule and the ranges', () => {
  const j = editsJson('G1_x.csv', 'abc', [[1200, 1450], [3010, 3122]])
  expect(j.name).toBe('G1_x.edits.json')
  expect(JSON.parse(j.text)).toEqual({ source_csv: 'G1_x.csv', sha256: sha256('abc'), fps: 60, frame_index: '1-based, inclusive, header 제외', ranges: [[1200, 1450], [3010, 3122]] })
})

test('jumpWarnings: > 25 rad/s shown (near an edit boundary = near), > 50 rad/s error; one entry per run', () => {
  const def = defs.g1, n = def.joints.length
  const pose = (v: number) => ({ rootPos: [0, 0, 0.79] as [number, number, number], rootQuat: [0, 0, 0, 1] as [number, number, number, number], q: Array(n).fill(0).map((_, k) => k === 3 ? v : 0) })
  const poses = [0, 0, 0.45, 0.45, 0.45, 1.35, 1.35].map(pose) // row 3: +0.45 rad (27 rad/s), row 6: +0.9 rad (54 rad/s)
  const w = jumpWarnings(poses, def, 100, [[6, 6]])
  expect(w.map(x => [x.kind, x.frame, x.channel, x.near])).toEqual([['jointJump', 102, def.joints[3].name, true], ['jointJumpError', 105, def.joints[3].name, true]])
  expect(jumpWarnings(poses, def, 0, [[200, 210]]).map(x => x.near)).toEqual([false, false]) // far from any edit
})

test('rlClipExport: the imported CSV coordinates as they were (no move / turn); no edits = no ranges', () => {
  const text = readFileSync('assets/examples/g1_walk.csv', 'utf8'), src = text.split('\n').filter(Boolean)
  const st = createEditorStore(defs), s = () => st.getState()
  s().addClipAsset(csvToClip(text, defs, undefined, 'walk'))
  const id = Object.values(s().project.clips).find(c => c.name === 'walk')!.id
  const r = rlClipExport(s().project, defs, id), rows = r.text.split('\n').slice(1).map(l => l.split(','))
  const first = (line: string) => line.split(',').slice(4, 11).map(Number)
  const srcRows = src.filter(l => !/frequency/i.test(l))
  expect(rows.length).toBe(srcRows.length)
  rows[0].slice(4, 11).map(Number).forEach((v, i) => expect(v).toBeCloseTo(first(srcRows[0])[i], 5)) // root xyz + quat xyzw unchanged
  rows.at(-1)!.slice(4, 7).map(Number).forEach((v, i) => expect(v).toBeCloseTo(first(srcRows.at(-1)!)[i], 5))
  expect(r.ranges).toEqual([])
  expect(JSON.parse(r.json.text).sha256).toBe(sha256(r.text))
})

test('rlClipExport / rlItemExport: edits (joints AND root) are in, and listed as 1-based rows; 무대 배치 is not', () => {
  const st = createEditorStore(defs), s = () => st.getState()
  const t = s().project.sequence.tracks.find(t => t.kind === 'motion')!, it = t.items[0], c = it.refId, actor = t.actorId!
  s().setPlacement(actor, { x: 5, y: -3 }) // 무대 배치: must not reach the RL CSV
  s().openClipEdit(c)
  s().setFrame(40); s().setValue(CLIP_ACTOR, 'left_knee_joint', 0.6)
  s().setFrame(90); s().setValue(CLIP_ACTOR, 'root.x', 0.25) // a root (pelvis) edit: must be in it
  s().closeClipEdit()
  const p = s().project, plain = rlClipExport({ ...p, clips: { ...p.clips, [c]: { ...p.clips[c], offset: undefined } } }, defs, c)
  const r = rlClipExport(p, defs, c), x = (txt: string, row: number) => Number(txt.split('\n')[row].split(',')[4])
  expect(r.ranges.length).toBeGreaterThan(0)
  expect(r.ranges.some(([a, b]) => a <= 41 && 41 <= b)).toBe(true) // frame 40 = row 41
  expect(r.ranges.some(([a, b]) => a <= 91 && 91 <= b)).toBe(true)
  expect(x(r.text, 91) - x(plain.text, 91)).toBeCloseTo(0.25, 4) // the root edit is in
  expect(x(r.text, 1)).toBeCloseTo(x(plain.text, 1), 6) // and nothing moved it to the origin or the stage
  const ri = rlItemExport(p, defs, actor, it.id)
  expect(x(ri.text, 91)).toBeCloseTo(x(r.text, 91), 6) // the piece: same clip coordinates, not +5 m of 무대 배치
  expect(ri.ranges).toEqual(r.ranges.map(([a, b]) => [a - it.trimIn, b - it.trimIn]).filter(([, b]) => b >= 1))
})

test('editRanges: identical poses = none', () => {
  const p = { rootPos: [0, 0, 1] as [number, number, number], rootQuat: [0, 0, 0, 1] as [number, number, number, number], q: [0, 0] }
  expect(editRanges([p, p], [p, { ...p, rootQuat: [0, 0, 0, -1] }])).toEqual([]) // -q is the same rotation
})
