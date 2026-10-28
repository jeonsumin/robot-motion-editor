import { loadDef } from '../test/defs'
import { beforeEach, expect, test } from 'vitest'
import { evalCurve } from '../model/curve'
import type { RobotDefs } from '../model/evaluate'
import { baseClip, curveKeyCount } from '../model/itemClip'
import { evaluateClip } from '../model/pose'
import { playRange, splitTarget } from '../transport'
import { actorOf, assetOwner, BLOCK_PREVIEW_ID, CLIP_ACTOR, CLIP_ITEM, createEditorStore, editingItem, editTarget, gizmoLock, keyTarget } from './store'

// 클립 편집 모드: the clip alone on a virtual actor/piece (not in the project), edits into its 수정 층 (asset:<clipId>).
const defs: RobotDefs = { g1: loadDef('g1'), go2: loadDef('go2') }
const ch = 'left_knee_joint', j = () => defs.g1.joints.findIndex(x => x.name === ch)
let st: ReturnType<typeof createEditorStore>
let c: string
const s = () => st.getState()

beforeEach(() => {
  st = createEditorStore(defs)
  c = s().project.sequence.tracks.find(t => t.kind === 'motion')!.items[0].refId
  s().setLayer('clip'); s().toggleAutoKey(); s().setKey(c, ch, 0, 0.2); s().setKey(c, ch, 119, 0.6); s().toggleAutoKey(); s().setLayer('piece')
})

test('enter: frame = clip frame, layer 이 클립 수정, virtual target; leave restores playhead and layer; not undoable', () => {
  s().setFrame(77); s().setLayer('clip')
  const before = s().project
  s().openClipEdit(c)
  expect([s().clipEdit, s().frame, s().layer, s().sel.actorId]).toEqual([c, 0, 'asset', CLIP_ACTOR])
  expect(s().project).toBe(before) // nothing added to the project
  expect(actorOf(s(), CLIP_ACTOR)).toMatchObject({ robot: 'g1', name: s().project.clips[c].name, placement: { x: 0, y: 0, yaw: 0 } })
  s().setFrame(500)
  expect(editTarget(s(), CLIP_ACTOR)).toEqual({ clipId: c, f: s().project.clips[c].length - 1, itemId: CLIP_ITEM })
  expect(keyTarget(s(), CLIP_ACTOR)!.owner).toBe(assetOwner(c))
  expect(editingItem(s())).toMatchObject({ actorId: CLIP_ACTOR, item: { start: 0, trimIn: 0, trimOut: s().project.clips[c].length } })
  expect(playRange(s())).toEqual([0, s().project.clips[c].length])
  expect(splitTarget(s())).toBeNull()
  s().setLayer('piece'); expect(s().layer).toBe('asset') // no piece here
  s().setLayer('clip'); expect(s().layer).toBe('clip')
  s().closeClipEdit()
  expect([s().clipEdit, s().frame, s().layer, s().sel.actorId]).toEqual([null, 77, 'clip', null])
  s().setLayer('asset'); expect(s().layer).toBe('clip') // 'asset' only in 클립 편집
})

test('values go into the 클립 수정 층 as deltas (no 자동 키); the original curves stay; every piece plays it; one undo', () => {
  s().openClipEdit(c); s().setFrame(60)
  const orig = s().project.clips[c], at60 = evalCurve(orig.channels[ch], 60, 0)
  s().setValue(CLIP_ACTOR, ch, at60 + 0.25)
  const clip = s().project.clips[c]
  expect(clip.channels[ch]).toBe(orig.channels[ch])
  expect(clip.offset![ch].keys.map(k => [k.f, +k.v.toFixed(9)])).toEqual([[45, 0], [60, 0.25], [75, 0]]) // eased back around the edit
  expect(evaluateClip(baseClip(s().project, defs, c)!, defs.g1, 60).q[j()]).toBeCloseTo(at60 + 0.25, 9)
  s().keyGroup(CLIP_ACTOR, '왼다리') // key the whole leg at its current difference
  expect(s().project.clips[c].offset![ch].keys).toHaveLength(3) // the edit and its two ease-back keys
  s().undo(); s().undo()
  expect(s().project.clips[c].offset).toBeUndefined()
  expect(s().clipEdit).toBe(c) // undo of an edit does not leave the mode
})

test('원본 클립 수정 in 클립 편집 needs 자동 키 and writes the clip; root gizmo locked, joints not', () => {
  s().openClipEdit(c); s().setLayer('clip'); s().setFrame(30)
  const v0 = s().project.clips[c].channels[ch]
  s().setValue(CLIP_ACTOR, ch, 1.0)
  expect(s().project.clips[c].channels[ch]).toBe(v0) // 자동 키 off: nothing
  s().toggleAutoKey(); s().setValue(CLIP_ACTOR, ch, 1.0)
  expect(evalCurve(s().project.clips[c].channels[ch], 30, 0)).toBeCloseTo(1.0, 9)
  s().select(CLIP_ACTOR, 'root.x'); expect(gizmoLock(s())).toBe('clipRoot')
  s().select(CLIP_ACTOR, ch); expect(gizmoLock(s())).toBeNull()
  const other = s().project.actors[0].id
  s().select(other, ch); expect(s().sel.actorId).toBe(CLIP_ACTOR) // only the open clip can be selected
})

test('the mode closes by itself when the clip goes away; opening a sequence clip view leaves it; loading a project resets it', () => {
  const id = s().newClip('g1') // an unused clip that can be deleted
  s().setFrame(12)
  s().openClipEdit(id)
  expect(s().deleteClip(id)).toBe(true)
  expect([s().clipEdit, s().frame]).toEqual([null, 12])
  s().undo(); s().openClipEdit(id); s().redo() // redo deletes it again
  expect(s().clipEdit).toBeNull()
  s().openClipEdit(c)
  const it = s().project.sequence.tracks.find(t => t.kind === 'motion')!.items[0]
  s().openItem(it.id)
  expect([s().clipEdit, s().editing]).toEqual([null, it.id])
  s().closeItem(); s().openClipEdit(c)
  s().loadProject(structuredClone(s().project), null)
  expect(s().clipEdit).toBeNull()
})

test('구간 수정: a value change spreads over the range (same difference inside, eased, outside untouched); one undo per gesture', () => {
  s().openClipEdit(c)
  s().setRange({ a: 70, b: 40, fade: 10 }) // order normalized
  expect(s().range).toEqual({ a: 40, b: 70, fade: 10 })
  const base = () => baseClip(s().project, defs, c)!, val = (f: number) => evaluateClip(base(), defs.g1, f).q[j()]
  const before = [20, 29, 35, 40, 55, 70, 75, 81, 100].map(val)
  s().setFrame(55)
  s().beginGesture()
  s().setValue(CLIP_ACTOR, ch, val(55) + 0.1); s().setValue(CLIP_ACTOR, ch, val(55) + 0.1) // a drag: two steps to +0.2 total
  s().endGesture()
  const after = [20, 29, 35, 40, 55, 70, 75, 81, 100].map(val), diff = after.map((v, i) => v - before[i])
  expect(diff[3]).toBeCloseTo(0.2, 6); expect(diff[4]).toBeCloseTo(0.2, 6); expect(diff[5]).toBeCloseTo(0.2, 6)
  expect(diff[2]).toBeGreaterThan(0); expect(diff[2]).toBeLessThan(0.2); expect(diff[6]).toBeGreaterThan(0)
  for (const i of [0, 1, 7, 8]) expect(diff[i]).toBeCloseTo(0, 6)
  expect(s().project.clips[c].channels[ch].keys.length).toBe(2) // the original is untouched (edits went to the 클립 수정 층)
  s().undo()
  expect([20, 55, 75].map(val)).toEqual([before[0], before[4], before[6]].map(v => expect.closeTo(v, 9)))
  s().setFrame(10); s().setValue(CLIP_ACTOR, ch, 1.2) // playhead outside the range: nothing
  expect(s().project.clips[c].offset).toBeUndefined()
  s().closeClipEdit(); expect(s().range).toBeNull()
})

test('구간 수정 on a piece (시퀀스 클립 보기, 이 조각 수정) writes that piece\'s 수정 층 only', () => {
  const it = s().project.sequence.tracks.find(t => t.kind === 'motion')!.items[0]
  s().openItem(it.id); s().setRange({ a: 10, b: 20, fade: 5 })
  const actor = s().project.actors[0].id
  s().setFrame(it.start - it.trimIn + 15)
  s().setValue(actor, ch, evaluateClip(s().project.clips[c], defs.g1, 15).q[j()] + 0.3)
  const off = s().project.sequence.tracks.find(t => t.kind === 'motion')!.items[0].offset![ch]
  expect(evalCurve(off, 15, 0)).toBeCloseTo(0.3, 6); expect(evalCurve(off, 30, 0)).toBeCloseTo(0, 9)
  expect(s().project.clips[c].offset).toBeUndefined()
})

test('shortening the clip drops its 수정 층 keys past the end; 키 줄이기 touches only the original curves', () => {
  s().openClipEdit(c)
  for (const f of [10, 100]) { s().setFrame(f); s().setValue(CLIP_ACTOR, ch, evalCurve(s().project.clips[c].channels[ch], f, 0) + 0.1) }
  expect(s().project.clips[c].offset![ch].keys.map(k => k.f)).toEqual([0, 10, 25, 85, 100, 115])
  s().closeClipEdit()
  expect(s().setClip(c, { length: 60 })).toBe(true)
  expect(s().project.clips[c].offset![ch].keys.map(k => k.f)).toEqual([0, 10, 25])
  const off = s().project.clips[c].offset
  s().simplifyClip(c, 0.01)
  expect(s().project.clips[c].offset).toEqual(off)
})

// 고쳐서 추가 (user): the 라이브러리 미리보기 clip goes into 목록 as <name>_수정 and opens in 클립 편집; 추가 취소 takes it out again
test('editPreviewAsClip / cancelDraftClip: a new 목록 clip in 클립 편집, edits into its 수정 층, 추가 취소 removes it (undoable)', () => {
  const src = s().project.clips[c], n0 = Object.keys(s().project.clips).length
  expect(s().editPreviewAsClip()).toBeNull() // nothing previewed
  s().setBlockPreview({ blockId: 'x', value: '', clip: { ...src, id: BLOCK_PREVIEW_ID, name: 'Hello' } })
  expect(s().editPreviewAsClip()).toBe('Hello_수정')
  const id = s().clipEdit!
  expect([s().blockPreview, s().clipEditDraft, s().project.clips[id].name, Object.keys(s().project.clips).length]).toEqual([null, id, 'Hello_수정', n0 + 1])
  expect(s().project.clips[id].channels).toEqual(src.channels) // the block's own data, nothing changed
  s().setValue(CLIP_ACTOR, ch, 0.9) // edits land in its 수정 층, the original stays
  expect(curveKeyCount(s().project.clips[id].offset)).toBeGreaterThan(0)
  expect(s().project.clips[id].channels).toEqual(src.channels)

  s().cancelDraftClip()
  expect([s().clipEdit, s().clipEditDraft, s().project.clips[id], Object.keys(s().project.clips).length]).toEqual([null, null, undefined, n0])
  s().undo() // the 추가 취소 comes back undone: the clip is back (in 목록, not in 클립 편집)
  expect(s().project.clips[id]?.name).toBe('Hello_수정')

  s().setBlockPreview({ blockId: 'x', value: '', clip: { ...src, id: BLOCK_PREVIEW_ID, name: 'Hello' } })
  expect(s().editPreviewAsClip()).toBe('Hello_수정_2') // a taken name gets the next number
  s().closeClipEdit()
  expect(s().clipEditDraft).toBeNull() // left the usual way: it is a normal 목록 clip now
})
