import { expect, test } from 'vitest'
import { addActor, emptyProject } from './defaults'
import { dropPlacement, insertLabel, laneDropFrame } from './dropPlacement'
import type { Clip, Project } from './types'

const clip = (id: string, robot: 'g1' | 'go2' = 'g1', length = 100): Clip => ({ id, name: id, robot, length, channels: {} })
const item = (refId: string, start: number, len = 100) => ({ id: `i${start}`, refId, start, trimIn: 0, trimOut: len })

// one G1 actor whose track holds clip "a" at 0..100; asset clip "b" (G1, 100) and "g" (GO2)
function proj(): Project {
  const p = addActor(emptyProject(), 'g1', false)
  p.clips = { a: clip('a'), b: clip('b'), g: clip('g', 'go2') }
  p.sequence.tracks[0].items = [item('a', 0)]
  return p
}
const row = (p: Project) => p.sequence.tracks[0].id
const b = { kind: 'clip', id: 'b' } as const

test('rule 1: free frame is used as is', () => {
  const p = proj(); p.sequence.tracks[0].items = [item('a', 0, 50)]
  expect(dropPlacement(p, b, row(p), 300)).toEqual({ kind: 'existing', trackId: row(p), start: 300 })
})
test('rule 1: a drop inside a piece inserts at its nearer edge: front half before it (it and the rest pushed back), back half after it', () => {
  const p = proj() // a at 0..100
  expect(dropPlacement(p, b, row(p), 40)).toEqual({ kind: 'existing', trackId: row(p), start: 0, shift: { ids: ['i0'], by: 100 } })
  expect(dropPlacement(p, b, row(p), 0)).toEqual({ kind: 'existing', trackId: row(p), start: 0, shift: { ids: ['i0'], by: 100 } })
  expect(dropPlacement(p, b, row(p), 70)).toEqual({ kind: 'existing', trackId: row(p), start: 100 })
  p.sequence.tracks[0].items = [item('a', 0), item('a', 100), item('a', 250)] // back half of the first: the two after it move by the clip length
  expect(dropPlacement(p, b, row(p), 80)).toEqual({ kind: 'existing', trackId: row(p), start: 100, shift: { ids: ['i100', 'i250'], by: 100 } })
})
test('rule 1: a drop in a gap too short for the clip stays at the drop frame and pushes the pieces after it just enough', () => {
  const p = proj(); p.sequence.tracks[0].items = [item('a', 0, 50), item('a', 100, 50)] // gap 50..100 is 50 long, clip b is 100
  expect(dropPlacement(p, b, row(p), 50)).toEqual({ kind: 'existing', trackId: row(p), start: 50, shift: { ids: ['i100'], by: 50 } })
  expect(dropPlacement(p, b, row(p), 10)).toEqual({ kind: 'existing', trackId: row(p), start: 0, shift: { ids: ['i0', 'i100'], by: 100 } })
})
test('rule 1: negative frame clamps to 0; locked track rejects', () => {
  const p = proj(); p.sequence.tracks[0].items = []
  expect(dropPlacement(p, b, row(p), -9)).toMatchObject({ start: 0 })
  p.sequence.tracks[0].locked = true
  expect(dropPlacement(p, b, row(p), 5)).toEqual({ kind: 'reject', reason: '잠긴 트랙입니다' })
})
test('rule 2: below the tracks creates a new actor at the frame', () => {
  expect(dropPlacement(proj(), b, null, 250)).toEqual({ kind: 'newActor', robot: 'g1', start: 250 })
})
test('rule 2: empty timeline places at 0', () => {
  expect(dropPlacement({ ...emptyProject(), clips: { b: clip('b') } }, b, null, 250)).toEqual({ kind: 'newActor', robot: 'g1', start: 0 })
})
test('rule 2: another robot\'s track creates a new actor instead of rejecting', () => {
  const p = proj()
  expect(dropPlacement(p, { kind: 'clip', id: 'g' }, row(p), 30)).toEqual({ kind: 'newActor', robot: 'go2', start: 30 })
})
test('rule 3: video from a motion row goes to V1, snapped; V1 missing is fine', () => {
  const p = proj(); p.media = [{ id: 'm', name: 'm', durationF: 60 }]
  expect(dropPlacement(p, { kind: 'media', id: 'm' }, row(p), 20)).toEqual({ kind: 'video', start: 20 })
  p.sequence.tracks.unshift({ id: 'v', kind: 'video', hidden: false, locked: false, items: [{ id: 'x', refId: 'm', start: 0, trimIn: 0, trimOut: 60 }] })
  expect(dropPlacement(p, { kind: 'media', id: 'm' }, row(p), 20)).toEqual({ kind: 'video', start: 60 })
  expect(dropPlacement(p, { kind: 'media', id: 'm' }, 'v', 300)).toEqual({ kind: 'video', start: 300 })
})

// 펼친 레인에 놓기(사용자): 그 레인 조각의 앞쪽 절반보다 왼쪽 = 그 조각 앞, 그 밖(빈 곳 포함) = 그 조각 바로 뒤
test('lane drop: decided by the lane piece, not by the frame', () => {
  const p = proj(), t = p.sequence.tracks[0]
  t.items = [item('a', 0), item('a', 200)] // pieces 0..100 and 200..300, gap 100..200
  const [first, second] = t.items
  const at = (it: typeof first, f: number) => dropPlacement(p, b, row(p), laneDropFrame(it, f))
  // first lane: front half = before it (everything pushed), back half or empty space far right = right after it
  expect(at(first, 20)).toEqual({ kind: 'existing', trackId: row(p), start: 0, shift: { ids: ['i0', 'i200'], by: 100 } })
  expect(at(first, 70)).toEqual({ kind: 'existing', trackId: row(p), start: 100 }) // gap 100..200 fits the clip: nothing moves
  expect(at(first, 900)).toEqual({ kind: 'existing', trackId: row(p), start: 100 }) // empty part of lane 1 right of the second piece: still after the first
  // second lane: left empty space = before it, past the middle = the end
  expect(at(second, 10)).toEqual({ kind: 'existing', trackId: row(p), start: 200, shift: { ids: ['i200'], by: 100 } })
  expect(at(second, 260)).toEqual({ kind: 'existing', trackId: row(p), start: 300 })
})
test('lane drop: after a piece that touches the next one, the next ones are pushed by the clip length', () => {
  const p = proj(), t = p.sequence.tracks[0]
  t.items = [item('a', 0), item('a', 100), item('a', 250)]
  expect(dropPlacement(p, b, row(p), laneDropFrame(t.items[0], 999))).toEqual({ kind: 'existing', trackId: row(p), start: 100, shift: { ids: ['i100', 'i250'], by: 100 } })
})
test('laneDropFrame: front half -> piece start, else piece end', () => {
  const it = item('a', 40, 100)
  expect([laneDropFrame(it, 0), laneDropFrame(it, 89), laneDropFrame(it, 90), laneDropFrame(it, 500)]).toEqual([40, 40, 140, 140])
})
test('insertLabel: the neighbours by start order, before the insert, named as on their bars', () => {
  const its = [item('a', 200), item('a', 0), item('a', 100)] // unsorted on purpose
  const nm = (it: { start: number }) => `P${it.start}`
  expect(insertLabel([], 0, undefined, nm)).toBe('')
  expect(insertLabel(its, 0, { ids: ['i0', 'i100', 'i200'] }, nm)).toBe('P0 앞')
  expect(insertLabel(its, 100, { ids: ['i100', 'i200'] }, nm)).toBe('P0 ↔ P100 사이')
  expect(insertLabel(its, 300, undefined, nm)).toBe('P200 뒤')
  expect(insertLabel([item('a', 0, 50), item('a', 200, 50)], 50, undefined, nm)).toBe('P0 ↔ P200 사이') // in a gap, nothing pushed
})
