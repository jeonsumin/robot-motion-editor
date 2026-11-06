import { describe, expect, test } from 'vitest'
import { loadDef } from '../test/defs'
import type { RobotDefs } from '../model/pose'
import { makeKey } from '../model/curve'
import { newProject } from '../model/defaults'
import { parseProject, serializeProject } from '../model/projectFile'
import type { Project, ReviewVerdict } from '../model/types'
import { createEditorStore } from '../store/store'
import type { Suspect } from './detect'
import { openProblems, recordCsv, resolvedBad, splitWarnings, verdictOf } from './verdicts'

const defs: RobotDefs = { g1: loadDef('g1'), go2: loadDef('go2') }
const V = (from: number, to: number, verdict: ReviewVerdict['verdict'], clipId = 'c'): ReviewVerdict => ({ clipId, from, to, kind: 'limit', verdict, at: '2026-10-29T00:00:00.000Z' })
const S = (from: number, to: number): Suspect => ({ kind: 'limit', from, to, worst: from, joints: ['right_wrist_roll_joint'], parts: ['오른팔'], speed: 120, ratio: 3.24, jump: 2, score: 40, atLimit: true })
// a G1 project whose clip's right wrist jumps 2 rad at clip frame 60 (and stays); its piece starts at 100, trimmed from 10
function flipProject(): Project {
  const p = newProject(), t = p.sequence.tracks[0], it = t.items[0], c = p.clips[it.refId]
  c.channels['right_wrist_roll_joint'] = { keys: [makeKey(0, -1, 'linear'), makeKey(59, -1, 'linear'), makeKey(60, 1, 'linear'), makeKey(c.length - 1, 1, 'linear')] }
  it.start = 100; it.trimIn = 10
  return p
}

describe('verdicts', () => {
  test('verdictOf: same clip, ranges overlap within 2 frames (a re-check may move an item a frame)', () => {
    const review = [V(60, 60, 'bad'), V(200, 210, 'ok')]
    expect(verdictOf(review, 'c', S(50, 50), 10)?.verdict).toBe('bad') // clip frames 60
    expect(verdictOf(review, 'c', S(52, 52), 10)?.verdict).toBe('bad') // 62: within the slack
    expect(verdictOf(review, 'c', S(55, 55), 10)).toBeUndefined()
    expect(verdictOf(review, 'other', S(50, 50), 10)).toBeUndefined()
    expect(verdictOf(review, 'c', S(195, 196), 10)?.verdict).toBe('ok')
  })

  test('families (§14): a 자가충돌 verdict does not answer for a 관절 튐 on the same frames, nor the other way; 손 맞닿음 is its own', () => {
    const review = [{ ...V(60, 60, 'ok'), kind: 'collision' as const }]
    expect(verdictOf(review, 'c', S(50, 50), 10)).toBeUndefined() // a jump item on clip frame 60
    expect(verdictOf(review, 'c', { ...S(50, 50), kind: 'collision' }, 10)?.verdict).toBe('ok')
    expect(verdictOf(review, 'c', { ...S(50, 50), kind: 'handTouch' }, 10)).toBeUndefined()
    expect(resolvedBad([{ ...V(60, 60, 'bad'), kind: 'collision' as const }], 'c', [S(50, 50)], 10, 200)).toHaveLength(1) // only a jump found there: still resolved
  })

  test('resolvedBad: a 문제 있음 range that a check no longer finds, inside the checked frames only', () => {
    const review = [V(60, 60, 'bad'), V(90, 95, 'bad'), V(300, 300, 'bad'), V(120, 120, 'ok')]
    expect(resolvedBad(review, 'c', [S(50, 50)], 10, 200).map(v => v.from)).toEqual([90]) // 300 is outside [10, 210)
  })

  test('splitWarnings: speed / jump warnings inside an 안무여서 놔둠 range go apart, other kinds stay', () => {
    const p = flipProject(), it = p.sequence.tracks[0].items[0]
    p.review = [{ ...V(60, 62, 'ok'), clipId: it.refId }]
    const ws = [{ kind: 'jointVelocity' as const, frame: 150, x: 1 }, { kind: 'jointJumpError' as const, frame: 152, x: 2 }, { kind: 'jointLimit' as const, frame: 150, x: 3 }, { kind: 'jointVelocity' as const, frame: 170, x: 4 }]
    const r = splitWarnings(p, it, ws) // clip 60..62 = sequence 150..152
    expect(r.ok.map(w => w.x)).toEqual([1, 2])
    expect(r.kept.map(w => w.x)).toEqual([3, 4])
  })

  test('openProblems: a 문제 있음 verdict stays open while the jump is there, closes when the clip is fixed', () => {
    const p = flipProject(), it = p.sequence.tracks[0].items[0]
    expect(openProblems(p, defs, it)).toEqual([])
    p.review = [{ ...V(60, 60, 'bad'), clipId: it.refId }]
    expect(openProblems(p, defs, it)).toEqual([{ frame: 150, verdict: p.review[0] }])
    p.clips[it.refId].channels['right_wrist_roll_joint'] = { keys: [makeKey(0, -1, 'linear'), makeKey(p.clips[it.refId].length - 1, 1, 'linear')] } // smooth now
    expect(openProblems(p, defs, it)).toEqual([])
  })

  test('recordCsv: one row per found item with its measurements and verdict, BOM + header', () => {
    const t = { key: 'item:x', kind: 'item' as const, id: 'x', label: '타임라인 · G1 #1 · a', robot: 'g1' as const, firstFrame: 100, clipFrom: 10 }
    const csv = recordCsv('a', t, [S(50, 50), S(80, 81)], [V(60, 60, 'ok')], 'c')
    const lines = csv.replace(/^﻿/, '').trim().split('\n')
    expect(lines).toHaveLength(3)
    expect(lines[0].split(',').slice(0, 4)).toEqual(['클립', '대상', '종류', '시작 클립 프레임'])
    expect(lines[1].split(',')).toEqual(['a', '타임라인 · G1 #1 · a', '로봇 한계 초과', '60', '60', '60', '61', '1.00', '1', '오른팔', 'right_wrist_roll_joint', '120.0', '3.24', '2.000', '40.0', '예', '', '', '안무여서 놔둠', '2026-10-29T00:00:00.000Z', '', '', '', '', ''])
    expect(lines[2].split(',').slice(18, 20)).toEqual(['', '']) // 미판정
    // §16: a 발 미끄러짐 row fills its own columns (last), not the joint-speed ones
    const slip: Suspect = { kind: 'footSlip', from: 30, to: 45, worst: 40, joints: [], parts: ['왼발'], speed: 0.12, ratio: 0, jump: 0, score: 0, atLimit: false,
      foot: 'left_ankle_roll_link', travel: 0.034, load: 0.62, turn: 4, pivot: false, level: 'warn', floor: 0 }
    const row = recordCsv('a', t, [slip], [], 'c').replace(/^\uFEFF/, '').trim().split('\n')[1].split(',')
    expect(row.slice(2, 3)).toEqual(['발 미끄러짐'])
    expect(row.slice(9, 18)).toEqual(['왼발', '', '', '', '', '', '', '', ''])
    expect(row.slice(-5)).toEqual(['경고', '3.4', '62', '4', ''])
  })
})

describe('project file and store', () => {
  test('review saves and reopens; a bad entry or one on a missing clip is dropped without failing the file', () => {
    const p = flipProject(), c = p.sequence.tracks[0].items[0].refId
    p.review = [{ ...V(60, 60, 'bad'), clipId: c }]
    expect(parseProject(serializeProject(p), defs).review).toEqual(p.review)
    const raw = JSON.parse(serializeProject(p))
    raw.review.push({ ...V(1, 2, 'ok'), clipId: 'nope' }, { ...V(5, 3, 'ok'), clipId: c }, { clipId: c, from: 1, to: 2, kind: 'x', verdict: 'ok', at: 'a' }, 7)
    expect(parseProject(JSON.stringify(raw), defs).review).toEqual(p.review)
    raw.review = 'junk'
    expect(parseProject(JSON.stringify(raw), defs).review).toBeUndefined()
    delete raw.review
    expect(parseProject(JSON.stringify(raw), defs).review).toBeUndefined() // older files: no review
  })

  test('setReviewVerdict: one undo step, replaces an overlapping verdict of the same clip, null clears, dirty', () => {
    const st = createEditorStore(defs), s = () => st.getState()
    const c = s().project.sequence.tracks[0].items[0].refId
    s().setReviewVerdict({ clipId: c, from: 60, to: 60, kind: 'limit' }, 'bad')
    expect(s().project.review).toMatchObject([{ clipId: c, from: 60, to: 60, verdict: 'bad' }])
    expect(s().dirty).toBe(true)
    s().setReviewVerdict({ clipId: c, from: 61, to: 62, kind: 'limit' }, 'ok') // overlaps (within 2 frames): replaces
    expect(s().project.review).toMatchObject([{ from: 61, to: 62, verdict: 'ok' }])
    s().setReviewVerdict({ clipId: c, from: 300, to: 300, kind: 'rel' }, 'bad')
    expect(s().project.review).toHaveLength(2)
    s().undo()
    expect(s().project.review).toHaveLength(1)
    s().setReviewVerdict({ clipId: c, from: 61, to: 62, kind: 'limit' }, null)
    expect(s().project.review).toBeUndefined()
    s().setReviewVerdict({ clipId: c, from: 60, to: 60, kind: 'limit' }, 'bad')
    s().setReviewVerdict({ clipId: c, from: 60, to: 64, kind: 'collision' }, 'ok') // another family on the same frames: both kept
    expect(s().project.review!.map(v => v.kind)).toEqual(['limit', 'collision'])
    s().setReviewVerdict({ clipId: c, from: 61, to: 61, kind: 'rel' }, 'ok') // same family (관절 튐): replaces the limit one
    expect(s().project.review!.map(v => [v.kind, v.verdict])).toEqual([['collision', 'ok'], ['rel', 'ok']])
  })
})

describe('발 미끄러짐 verdicts (§16)', () => {
  test('each foot is its own spot: a verdict on the left foot does not answer for the right one on the same frames; saved and reopened', () => {
    const ed = createEditorStore(defs), s = ed.getState(), c = s.project.sequence.tracks[0].items[0].refId
    s.setReviewVerdict({ clipId: c, from: 30, to: 40, kind: 'footSlip', foot: 'left_ankle_roll_link' }, 'bad')
    s.setReviewVerdict({ clipId: c, from: 30, to: 40, kind: 'footSlip', foot: 'right_ankle_roll_link' }, 'ok')
    const r = ed.getState().project.review!
    expect(r.map(v => [v.foot, v.verdict])).toEqual([['left_ankle_roll_link', 'bad'], ['right_ankle_roll_link', 'ok']])
    const slip = (foot: string) => ({ kind: 'footSlip' as const, from: 20, to: 30, foot })
    expect(verdictOf(r, c, slip('left_ankle_roll_link'), 10)?.verdict).toBe('bad')
    expect(verdictOf(r, c, slip('right_ankle_roll_link'), 10)?.verdict).toBe('ok')
    expect(parseProject(serializeProject(ed.getState().project), defs).review?.map(v => v.foot)).toEqual(['left_ankle_roll_link', 'right_ankle_roll_link'])
  })
})
