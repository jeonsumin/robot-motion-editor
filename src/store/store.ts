import { createStore, useStore, type StoreApi } from 'zustand'
import { evalCurve, makeKey } from '../model/curve'
import { simplifyCurve, simplifyTolerance } from '../model/simplify'
import { addActor as addActorTo, emptyProject, newProject, nextClipName, stageOf } from '../model/defaults'
import { evaluateClip, type RobotDefs } from '../model/evaluate'
import { inCrossfade, itemLen, resolve, sortedItems, validTrack } from '../model/sequence'
import type { Actor, Bin, Item, Clip, Curve, Interp, Project, StageSize, Tan, Track } from '../model/types'
import { validVideoTrack, videoTrack } from '../model/video'
import { groundZ, lockFeet, standQ, type Body } from '../model/bodyPose'
import { baseClip, editedClip, offsetKeyCount } from '../model/itemClip'
import { addOverRange, type Range } from '../model/rangeEdit'
import { BLEND_RANGE, HOLD_RANGE, INERTIA_CAP, previewRange } from '../model/restPose'
import { SEAM_MAX } from '../model/seam'
import type { RobotDef, RobotKind } from '../robot/types'
import type { PhysicsSettings } from '../physics/settings'

// Bumped whenever a different project is loaded; async work started against one project checks it before landing.
let generation = 0
export const projectGeneration = () => generation

export type KeyRef = { channel: string; f: number }
export type Layer = 'piece' | 'clip' | 'asset'
/** Frames over which a single 수정 층 key eases back to 0 difference (0.25 s at 60 fps). */
export const OFFSET_EASE = 15
export type { Range } from '../model/rangeEdit'
// 클립 편집 모드's virtual actor and piece (never in the project): the clip at 0, full length, at the stage origin
export const CLIP_ACTOR = '__clip_actor__', CLIP_ITEM = '__clip_item__'
type ClipEditPick = Partial<Pick<EditorState, 'clipEdit' | 'itemPreview' | 'previewFrame'>>
/** The actor an id stands for: a project actor, or (클립 편집 모드) the virtual one for the open clip. */
export function actorOf(s: Pick<EditorState, 'project'> & ClipEditPick, id: string | null): Actor | undefined {
  if (!id) return undefined
  if (id === CLIP_ACTOR) {
    const c = s.clipEdit ? s.project.clips[s.clipEdit] : undefined
    return c && { id: CLIP_ACTOR, name: c.name, robot: c.robot, color: c.robot === 'g1' ? '#58B4D1' : '#C9D65A', placement: { x: 0, y: 0, yaw: 0 } }
  }
  return s.project.actors.find(a => a.id === id)
}
export interface Selection { actorId: string | null; channel: string | null; keys: KeyRef[] }
export interface EditorState {
  defs: RobotDefs; project: Project; frame: number; playing: boolean; autoKey: boolean
  view: 'tracks' | 'graph'; sel: Selection
  videoMode: 'off' | 'overlay' | 'split'; videoOpacity: number // viewer preference: not undoable, not saved, survives loadProject
  setVideoMode(m: 'off' | 'overlay' | 'split'): void; setVideoOpacity(v: number): void
  comparePanes: string[] // clip ids shown in preview-only compare panes (max 2): not undoable, not saved, pruned when clips go away
  /** 구간 프리뷰: sequence frames [from, to) looping in their own pane (right-drag on the sequence, user); null = closed. Not saved. */
  spanPreview: [number, number] | null; setSpanPreview(r: [number, number] | null): void
  /** 배치 이동 toggle (editor state, not saved): on = the playhead sits at the selected GO2's track end - 1. */
  walkMode: boolean; setWalkMode(on: boolean): void
  playheadPinned: boolean; setPlayheadPinned(on: boolean): void // 재생헤드 고정(사용자): 마우스 따라가기만 끔, 화면 전용·저장 안 함
  openComparePane(clipId: string): void; closeComparePane(clipId: string): void
  itemPreview: string | null // item id looping in the clip preview pane: not undoable, not saved, pruned when the item goes away
  /** The clip preview's own playhead (sequence frames, from the piece's lead-in start; independent of `frame`, user) and whether it
   *  plays (looping over the piece). Edits of the previewed piece go to this frame. */
  previewFrame: number; previewPlaying: boolean; setPreviewFrame(f: number): void; setPreviewPlaying(on: boolean): void
  openItemPreview(itemId: string, play?: boolean): void; closeItemPreview(): void // its own playhead from the piece's lead-in start; play: start it
  compareOverlay: boolean; setCompareOverlay(on: boolean): void // 겹쳐 보기: the 수정본 as a ghost on the main view while comparing
  /** 원본 사용 ('original') or the 수정본 (null) for playback, CSV and physics; one undo step; false = unknown / locked / no 수정 층. */
  setItemUse(itemId: string, use: 'original' | null): boolean
  setFrame(f: number): void; setPlaying(b: boolean): void; toggleAutoKey(): void; setView(v: 'tracks' | 'graph'): void
  // What edits go to (editor state, not saved): 'piece' = the piece's 수정 층 (Item.offset; clip untouched, no 자동 키 needed),
  // 'clip' = the shared clip itself (needs 자동 키), 'asset' = the clip's 수정 층 (Clip.offset, clip edit mode; no 자동 키 needed).
  // Key actions below take a clip id, an item id (its 수정 층) or assetOwner(clipId) (the clip's 수정 층).
  layer: Layer; setLayer(l: Layer): void
  /** 클립 편집 모드 (목록 더블클릭): the clip alone on a virtual actor CLIP_ACTOR / piece CLIP_ITEM (not in the project), frame =
   *  clip frame. Entering keeps the sequence playhead and layer in clipEditReturn and switches to 'asset'; leaving restores
   *  them. Not undoable, not saved; closes by itself when the clip goes away. */
  clipEdit: string | null; clipEditReturn: { frame: number; layer: Layer } | null
  openClipEdit(clipId: string): void; closeClipEdit(): void
  clipPeek: boolean; setClipPeek(on: boolean): void // 원본 보기 (held): the main view shows the clip without its 수정 층
  /** 구간 (clip frames, clip view / 클립 편집 only): value edits add the same difference over [a, b], easing out over `fade`
   *  frames each side. Not saved; cleared when the open clip changes. */
  range: Range | null; setRange(r: Range | null): void
  stageShown: boolean; setStageShown(on: boolean): void // 무대 floor on/off in the 3D previews (UI only, not saved)
  setStage(patch: Partial<StageSize>): void // 무대 size in m (0.1 steps, 1..30): one undo step
  degrees: boolean; setDegrees(on: boolean): void // angle unit of the value fields (inspector and joint panel)
  clearOffset(itemId: string): boolean // drop the piece's whole 수정 층 (one undo step); false = none / locked
  clearClipOffset(clipId: string): boolean // drop the clip's whole 수정 층 (one undo step); false = none
  select(actorId: string | null, channel?: string | null): void; selectKeys(keys: KeyRef[], additive: boolean): void
  setValue(actorId: string, channel: string, v: number): void
  setKey(clipId: string, channel: string, f: number, v: number): void
  deleteKeys(clipId: string, keys: KeyRef[]): void
  moveKeys(clipId: string, keys: KeyRef[], df: number): void
  setInterp(clipId: string, keys: KeyRef[], interp: Interp): void
  setTangent(clipId: string, channel: string, f: number, side: 'in' | 'out', t: Tan, linked: boolean): void
  keyGroup(actorId: string, group: string): void
  keyPose(actorId: string): void // key every root and joint channel at the frame
  feetLock: boolean; setFeetLock(on: boolean): void // body edits keep the feet where they are (legs re-solved by IK)
  autoGround: boolean; setAutoGround(on: boolean): void // root.z follows the lowest foot
  poseAt(actorId: string): { def: RobotDef; f: number; body: Body; q: number[] } | null // the pose the joint panel shows
  editPose(actorId: string, values: Record<string, number>): boolean // channel -> target, one undo step (joins an open gesture); false = refused, nothing written
  standPose(actorId: string): void // 차렷 joints, no tilt, rest height; x/y/yaw kept; no foot lock
  setTrackFlag(trackId: string, flag: 'hidden' | 'locked' | 'trail', on: boolean): void // trail: 경로 표시 (display only, also on a locked track)
  setItemHidden(itemId: string, on: boolean): void // display only, also on a locked track (like the track's 숨기기)
  setClip(clipId: string, patch: { name?: string; length?: number }): boolean
  setPlacement(actorId: string, pl: Partial<Actor['placement']>): void
  setColor(actorId: string, hex: string): void
  addActor(robot: RobotKind): void
  selItem: string | null; selectItem(itemId: string | null): void
  editing: string | null; openItem(itemId: string): void; closeItem(): void
  setIn(f: number | null): void; setOut(f: number | null): void
  addMarker(f: number): void; renameMarker(index: number, name: string): void; deleteMarker(index: number): void
  newClip(robot: RobotKind): string
  // Add an imported clip to the assets. If no actor of its robot exists, create one (no default clip) and place the clip at 0; otherwise assets only (null).
  importClipToActor(clip: Clip): { actorId: string; itemId: string } | null
  // New actor (no default clip) for the clip's robot with the clip at `start`; null = unknown clip. One undo entry.
  placeClipAsNewActor(clipId: string, start: number): { actorId: string; itemId: string } | null
  // Add the clip to the assets (name deduped) and place it right after the actor's last item; new item id, null = locked/unknown/robot mismatch. One undo entry.
  // actorId null: a new actor for the clip's robot, with the clip at 0 (목록 ▸ 라이브러리 tab on a project without a GO2).
  appendClip(actorId: string | null, clip: Clip): string | null
  /** The clip into the assets only (목록에만 추가; name deduped), one undo entry; its name as stored, null = refused. */
  addClipAsset(clip: Clip): string | null
  simplifyClip(clipId: string, rot?: number, pos?: number): number
  deleteClip(clipId: string): boolean
  addMedia(name: string, durationF: number): string
  // Project-panel folders (virtual, per tab). addBin names it `폴더 n` and moves `ids` into it; moveToBin skips items of the other tab, null = top level, false = nothing changed.
  addBin(tab: Bin['tab'], ids?: string[]): string
  renameBin(id: string, name: string): boolean
  deleteBin(id: string): boolean
  moveToBin(ids: string[], binId: string | null): boolean
  addClip(clip: Clip): string // assets only, top level, name deduped (`_2`); returns the clip id
  deleteMedia(mediaId: string): boolean
  addVideoItem(mediaId: string, start: number): boolean
  addItem(actorId: string, clipId: string, start: number, shift?: { ids: string[]; by: number }): boolean // shift: pieces pushed later first (a drop that inserts)
  moveItem(itemId: string, start: number): boolean
  /** Two pieces of one motion track trade places in time (lane drag, user); the pieces re-flow end to end and each slot keeps its
   *  gap / crossfade overlap to the one before. One undo; false = other track / locked / invalid. */
  swapItems(aId: string, bId: string): boolean
  trimItem(itemId: string, side: 'in' | 'out', df: number): boolean
  splitItem(itemId: string, frame: number): boolean
  deleteItem(itemId: string): boolean
  // Flag an item so its clip preview and CSV export start from the standing pose (clips and sequence playback untouched); false = rejected.
  // mode 'prepend' = 덧붙이기, null = off (덮어쓰기 was removed).
  setRestPose(itemId: string, mode: Item['restPose'] | null): boolean
  setRestTail(itemId: string, on: boolean): boolean
  /** 덧붙이기 lead-in, 끝 기본자세 and GO2 이음매 보정 lengths of a piece, in frames (rounded, clamped); null = back to the default / auto. One undo step. */
  setRestLead(itemId: string, patch: { restHold?: number | null; restBlend?: number | 'auto' | null; inertia?: number | null; tailHold?: number | null; tailBlend?: number | null; seam?: number | null }): boolean
  setPhysics(next: PhysicsSettings): void // project-wide physics-assist settings: one undo step
  beginGesture(): void; endGesture(): void
  inGesture: boolean // a slider/gizmo drag is under way (views may skip heavy recomputation until it ends)
  // Drop the current gesture's changes (back to the pre-gesture project, nothing on redo); no-op outside a gesture.
  cancelGesture(): void
  fileName: string | null; dirty: boolean
  loadProject(p: Project, fileName: string | null): void; markSaved(fileName: string): void; newProjectFile(): void
  undo(): void; redo(): void
}

// Put the draft's clips/media in `ids` into bin `binId` (null = top level); items of the other tab are skipped. Returns how many changed.
function setBin(p: Project, ids: string[], binId: string | null): number {
  const tab = binId === null ? null : p.bins?.find(b => b.id === binId)?.tab
  const to = binId ?? undefined
  let n = 0
  const put = <T extends { bin?: string }>(o: T): T => {
    if (o.bin === to) return o
    n++
    const { bin: _, ...rest } = o
    return (to === undefined ? rest : { ...rest, bin: to }) as T
  }
  for (const id of ids) {
    const c = p.clips[id]
    if (c && (tab === null || tab === 'clip')) p.clips[id] = put(c)
  }
  if (tab === null || tab === 'media') p.media = p.media.map(m => ids.includes(m.id) ? put(m) : m)
  return n
}

const MAX_UNDO = 200
const ROOT = ['root.x', 'root.y', 'root.z', 'root.roll', 'root.pitch', 'root.yaw']

// Lock rules: an actor's motion track locked; a clip is locked if ANY item referencing it sits on a locked track.
// Put `clip` in the draft's assets, renaming it `name_2`, `name_3`… if its robot already has that name.
function addUniqueClip(p: Project, clip: Clip) {
  const taken = new Set(Object.values(p.clips).filter(c => c.robot === clip.robot).map(c => c.name))
  let name = clip.name
  for (let n = 2; taken.has(name); n++) name = `${clip.name}_${n}`
  p.clips[clip.id] = { ...clip, name }
}
export const trackLocked = (p: Project, actorId: string) => p.sequence.tracks.some(t => t.kind === 'motion' && t.actorId === actorId && t.locked)
// (also takes an item id: that piece's 수정 층 is locked with its track)
export const clipLocked = (p: Project, clipId: string) => p.sequence.tracks.some(t => t.locked && t.items.some(i => i.refId === clipId || i.id === clipId))

// Key owner ID of a clip's 수정 층 (Clip.offset); a plain clip ID is its original channels, an item ID that piece's 수정 층.
export const ASSET = 'asset:'
export const assetOwner = (clipId: string) => ASSET + clipId
const assetClipId = (id: string) => id.startsWith(ASSET) ? id.slice(ASSET.length) : null

// Curves a key action edits: a clip's channels, a clip's or an item's 수정 층 (deltas, clip frames, length of its clip). Read only.
export function keyOwner(p: Project, id: string): { channels: Record<string, Curve>; length: number; robot: RobotKind; offset: boolean } | null {
  const ac = assetClipId(id), asset = ac !== null ? p.clips[ac] : undefined
  if (asset) return { channels: asset.offset ?? {}, length: asset.length, robot: asset.robot, offset: true }
  const clip = p.clips[id]
  if (clip) return { channels: clip.channels, length: clip.length, robot: clip.robot, offset: false }
  for (const t of p.sequence.tracks) for (const it of t.items) if (it.id === id && p.clips[it.refId])
    return { channels: it.offset ?? {}, length: p.clips[it.refId].length, robot: p.clips[it.refId].robot, offset: true }
  return null
}

// editTarget plus the key owner for the current layer (the clip, or the item for its 수정 층).
export function keyTarget(s: Pick<EditorState, 'project' | 'frame' | 'editing' | 'layer'> & ClipEditPick, actorId: string) {
  const t = editTarget(s, actorId)
  return t && { ...t, owner: s.layer === 'asset' ? assetOwner(t.clipId) : s.layer === 'piece' && t.itemId !== CLIP_ITEM ? t.itemId : t.clipId }
}

// Which clip and clip frame edits for `actorId` go to. Clip view: the open item (trims ignored); else the item covering the frame.
export function editTarget(s: Pick<EditorState, 'project' | 'frame' | 'editing'> & ClipEditPick, actorId: string):
  { clipId: string; f: number; itemId: string } | null {
  const p = s.project
  if (s.clipEdit) { // 클립 편집 모드: the virtual piece only
    const c = p.clips[s.clipEdit]
    return actorId === CLIP_ACTOR && c ? { clipId: c.id, f: Math.min(Math.max(Math.round(s.frame), 0), c.length - 1), itemId: CLIP_ITEM } : null
  }
  if (s.editing) for (const t of p.sequence.tracks) {
    const it = t.items.find(i => i.id === s.editing)
    if (it && t.actorId === actorId) {
      const f = Math.min(Math.max(s.frame - it.start + it.trimIn, 0), p.clips[it.refId].length - 1)
      return { clipId: it.refId, f, itemId: it.id }
    }
  }
  const track = p.sequence.tracks.find(t => t.kind === 'motion' && t.actorId === actorId)
  if (!track) return null
  // the piece open in the clip preview is edited at the preview's own playhead (inside the piece: its lead-in / 끝 기본자세 clamp)
  const pv = s.itemPreview != null && s.previewFrame != null ? track.items.find(i => i.id === s.itemPreview) : undefined
  if (pv) return { clipId: pv.refId, f: Math.min(Math.max(Math.round(s.previewFrame!) - pv.start, 0), pv.trimOut - pv.trimIn - 1) + pv.trimIn, itemId: pv.id }
  const items = sortedItems(track)
  const cover = items.filter(i => s.frame >= i.start && s.frame < i.start + (i.trimOut - i.trimIn)).at(-1) // later item wins on overlap
  if (cover) return { clipId: cover.refId, f: s.frame - cover.start + cover.trimIn, itemId: cover.id }
  const r = resolve(items, s.frame)
  return r && { clipId: r.item.refId, f: r.cf, itemId: r.item.id }
}

/** An item by id: a project item, or (클립 편집 모드) the virtual piece CLIP_ITEM. */
export function targetItem(s: Pick<EditorState, 'project' | 'editing'> & ClipEditPick, itemId: string): Item | undefined {
  return itemId === CLIP_ITEM ? editingItem(s)?.item : s.project.sequence.tracks.flatMap(t => t.items).find(i => i.id === itemId)
}

// The item open in clip view with its actor and clip, or null in sequence view.
export function editingItem(s: Pick<EditorState, 'project' | 'editing'> & ClipEditPick): { item: Item; actorId: string | null; clip: Clip } | null {
  if (s.clipEdit) {
    const clip = s.project.clips[s.clipEdit]
    return clip ? { item: { id: CLIP_ITEM, refId: clip.id, start: 0, trimIn: 0, trimOut: clip.length }, actorId: CLIP_ACTOR, clip } : null
  }
  if (!s.editing) return null
  for (const t of s.project.sequence.tracks) {
    const item = t.items.find(i => i.id === s.editing)
    if (item) return { item, actorId: t.actorId ?? null, clip: s.project.clips[item.refId] }
  }
  return null
}

// Why edits of `channel` are off: a crossfade shows a blend (sequence view, any channel);
// the first frame of a stitched item has its root x/y/yaw matched to the previous item (z/roll/pitch stay editable).
export function editLock(s: Pick<EditorState, 'project' | 'frame' | 'editing'> & ClipEditPick, actorId: string, channel: string): 'crossfade' | 'stitch' | null {
  const track = s.project.sequence.tracks.find(t => t.kind === 'motion' && t.actorId === actorId)
  if (!track) return null
  if (!s.editing && inCrossfade(track, s.frame)) return 'crossfade'
  if (!['root.x', 'root.y', 'root.yaw'].includes(channel)) return null
  const t = editTarget(s, actorId), item = t && track.items.find(i => i.id === t.itemId)
  return item && t.f === item.trimIn && sortedItems(track)[0] !== item ? 'stitch' : null
}

// Stage gizmo lock for the selected channel. The root gizmo moves x/y/yaw together, so any root channel uses root.x
// (a z/roll/pitch selection still locks it on a stitch frame; splitting handles is out of scope).
export function gizmoLock(s: Pick<EditorState, 'project' | 'frame' | 'editing' | 'sel'> & Partial<Pick<EditorState, 'itemPreview' | 'clipEdit'>>): 'crossfade' | 'stitch' | 'compare' | 'clipRoot' | null {
  const { actorId, channel } = s.sel
  if (!actorId || !channel || channel.startsWith('group:')) return null
  if (s.clipEdit) return channel.startsWith('root') ? 'clipRoot' : null // 클립 편집: root by numbers only (no stage placement to move against)
  // the piece open in the clip preview is edited there (user: edit in the clip preview, not on the main view)
  if (!s.editing && s.itemPreview && editTarget(s, actorId)?.itemId === s.itemPreview) return 'compare'
  return editLock(s, actorId, channel.startsWith('root') ? 'root.x' : channel)
}

// One shared delta for every selected key (all channels) so min f >= 0 and max f <= length-1.
export function clampDf(length: number, keys: KeyRef[], df: number): number {
  if (!keys.length) return 0
  return Math.min(Math.max(Math.round(df), -Math.min(...keys.map(k => k.f))), length - 1 - Math.max(...keys.map(k => k.f)))
}

// Clips and channels an edit mutates; 'all' = every channel of the clip.
type Touched = { clipId: string; channels: string[] | 'all' }[]
const chans = (keys: KeyRef[]) => [...new Set(keys.map(k => k.channel))]

// Dev/test only: deep-freeze clips so code mutating a shared (undeclared) curve throws. Frozen curves are skipped.
function freezeClips(p: Project): Project {
  if (!import.meta.env.DEV) return p
  for (const clip of Object.values(p.clips)) {
    for (const c of Object.values(clip.channels)) {
      if (Object.isFrozen(c)) continue
      for (const k of c.keys) { Object.freeze(k.inTan); Object.freeze(k.outTan); Object.freeze(k) }
      Object.freeze(c.keys); Object.freeze(c)
    }
    if (clip.offset) for (const c of Object.values(clip.offset)) {
      if (Object.isFrozen(c)) continue
      for (const k of c.keys) { Object.freeze(k.inTan); Object.freeze(k.outTan); Object.freeze(k) }
      Object.freeze(c.keys); Object.freeze(c)
    }
    if (clip.offset) Object.freeze(clip.offset)
    Object.freeze(clip.channels); Object.freeze(clip)
  }
  return p
}

export function createEditorStore(defs: RobotDefs, initial: Project = newProject()): StoreApi<EditorState> {
  return createStore<EditorState>((set, get) => {
    let undoS: Project[] = [], redoS: Project[] = []
    let gesture = false // edits inside a gesture share one undo entry
    let gestureMoved = false // the gesture has committed (pushed its undo entry, cleared redo)
    let suspended = false // undo hit mid-gesture: the rest of that gesture's edits are dropped until endGesture

    // One user action = one undo entry: mutate a clone, push the old project. In a gesture only the first change pushes.
    const commit = (next: Project) => {
      if (suspended) return
      for (const t of next.sequence.tracks) for (const it of t.items) if (it.offset) { // no empty 수정 층 left behind
        for (const [n, c] of Object.entries(it.offset)) if (!c.keys.length) delete it.offset[n]
        if (!Object.keys(it.offset).length) delete it.offset
      }
      for (const c of Object.values(next.clips)) if (c.offset && !Object.isFrozen(c)) { // (only clips this edit copied)
        for (const [n, cv] of Object.entries(c.offset)) if (!cv.keys.length) delete c.offset[n]
        if (!Object.keys(c.offset).length) delete c.offset
      }
      // The draft deep-copied every piece's 수정 층: keep the old object where it did not change, so the bakes and caches keyed
      // on it (itemClip, lead-in, foot contact, IK) keep hitting after an edit elsewhere. Committed projects are never mutated.
      const old = new Map(get().project.sequence.tracks.flatMap(t => t.items.map(i => [i.id, i.offset] as const)))
      for (const t of next.sequence.tracks) for (const it of t.items) {
        const o = old.get(it.id)
        if (o && it.offset && it.offset !== o && JSON.stringify(it.offset) === JSON.stringify(o)) it.offset = o
      }
      if (!gesture || !gestureMoved) { undoS = [...undoS, get().project].slice(-MAX_UNDO); redoS = [] }
      if (gesture) gestureMoved = true
      set({ project: freezeClips(next), ...follow(next) })
    }
    // the open clip edit stays while its clip exists; otherwise the fields that close it (playhead and layer restored)
    const keepClipEdit = (p: Project): Partial<EditorState> => {
      const s = get()
      return !s.clipEdit || p.clips[s.clipEdit] ? {} : { clipEdit: null, clipEditReturn: null, frame: s.clipEditReturn?.frame ?? 0, layer: s.clipEditReturn?.layer ?? 'piece', playing: false, sel: { actorId: null, channel: null, keys: [] } }
    }
    const keepPanes = (p: Project) => {
      const c = get().comparePanes, k = c.filter(id => id in p.clips)
      return k.length === c.length ? c : k
    }
    // the view state that follows a new project (edit, undo, redo, cancelled gesture)
    const follow = (p: Project): Partial<EditorState> => ({ editing: keepEditing(p), dirty: true, comparePanes: keepPanes(p), itemPreview: keepPreview(p), ...keepClipEdit(p) })
    const keepPreview = (p: Project) => {
      const id = get().itemPreview
      return id && p.sequence.tracks.some(t => t.items.some(i => i.id === id)) ? id : null
    }
    const keepEditing = (p: Project) => {
      const e = get().editing
      return e && p.sequence.tracks.some(t => t.items.some(i => i.id === e)) ? e : null
    }
    // Copy-on-write draft: actors/sequence cloned; per touched clip only the declared channels get fresh curves,
    // all other curves stay shared with older snapshots (frozen in dev, so an undeclared mutation throws).
    const draft = (touched: Touched): Project => {
      const p = get().project
      const next: Project = { ...p, actors: structuredClone(p.actors), sequence: structuredClone(p.sequence), clips: { ...p.clips }, media: [...p.media] }
      for (const { clipId: id, channels } of touched) {
        const ac = assetClipId(id), clipId = ac ?? id, clip = next.clips[clipId]
        if (!clip) continue
        const chs = { ...clip.channels }
        if (ac === null) for (const n of channels === 'all' ? Object.keys(chs) : channels)
          if (chs[n]) chs[n] = { keys: chs[n].keys.map(k => ({ ...k, inTan: { ...k.inTan }, outTan: { ...k.outTan } })) }
        // the 클립 수정 층 is small (keys on edited channels only): a touched clip gets its own copy
        next.clips[clipId] = clip.offset ? { ...clip, channels: chs, offset: structuredClone(clip.offset) } : { ...clip, channels: chs }
      }
      return next
    }
    const edit = (fn: (p: Project) => void, touched: Touched) => {
      const next = draft(touched)
      fn(next)
      commit(next)
    }

    // Mutate a candidate; commit only if fn returns true (rejection leaves project and stacks untouched).
    const tryEdit = (fn: (p: Project) => boolean, touched: Touched = []): boolean => {
      const next = draft(touched)
      if (!fn(next)) return false
      commit(next)
      return true
    }
    const findItem = (p: Project, id: string) => {
      for (const t of p.sequence.tracks) { const it = t.items.find(i => i.id === id); if (it) return { t, it } }
      return null
    }

    // Track rule by kind: V1 uses media bounds and forbids overlap; motion tracks allow crossfades.
    const validItems = (p: Project, t: Track) => t.kind === 'video' ? validVideoTrack(t.items, Object.fromEntries(p.media.map(m => [m.id, m]))) : validTrack(t.items)
    const refLen = (p: Project, t: Track, it: Item) => t.kind === 'video' ? p.media.find(m => m.id === it.refId)?.durationF ?? 0 : p.clips[it.refId].length

    // Writable curves of a key owner in the draft: a clip's channels, or an item's 수정 층 (created on demand, emptied ones dropped on commit).
    type Owner = { channels: Record<string, Curve>; length: number; robot: RobotKind; offset: boolean }
    const ownerOf = (p: Project, id: string): Owner | null => {
      const ac = assetClipId(id), asset = ac !== null ? p.clips[ac] : undefined
      if (asset) return { channels: (asset.offset ??= {}), length: asset.length, robot: asset.robot, offset: true }
      const clip = p.clips[id]
      if (clip) return { channels: clip.channels, length: clip.length, robot: clip.robot, offset: false }
      const it = findItem(p, id)?.it, c = it && p.clips[it.refId]
      return it && c ? { channels: (it.offset ??= {}), length: c.length, robot: c.robot, offset: true } : null
    }
    const putKey = (clip: Owner | Clip, channel: string, f: number, v: number) => {
      const j = defs[clip.robot].joints.find(j => j.name === channel)
      if (j && !('offset' in clip && clip.offset)) v = Math.min(Math.max(v, j.lower), j.upper) // deltas: the sum is clamped when baked
      f = Math.min(Math.max(Math.round(f), 0), clip.length - 1)
      const keys = (clip.channels[channel] ??= { keys: [] }).keys
      const k = keys.find(k => k.f === f)
      if (k) k.v = v
      else { keys.push(makeKey(f, v)); keys.sort((a, b) => a.f - b.f) }
    }
    // A 수정 층 key changes only its neighbourhood: on each side with no key within OFFSET_EASE frames, a key there keeps the
    // layer's value from before the edit, so the change eases back to what played before (a lone key would hold its difference
    // over the whole clip). Returns those [frame, value] pins, taken before the new key is put.
    const offsetPins = (o: Owner, channel: string, f: number): [number, number][] => {
      f = Math.min(Math.max(Math.round(f), 0), o.length - 1)
      const c = o.channels[channel] ?? { keys: [] }, out: [number, number][] = []
      const a = Math.max(f - OFFSET_EASE, 0), b = Math.min(f + OFFSET_EASE, o.length - 1)
      if (a < f && !c.keys.some(k => k.f >= a && k.f < f)) out.push([a, evalCurve(c, a, 0)])
      if (b > f && !c.keys.some(k => k.f > f && k.f <= b)) out.push([b, evalCurve(c, b, 0)])
      return out
    }
    // 구간 수정: the value change at the playhead (clip frame t.f, inside the range) added over the whole range, eased at its ends,
    // on the edited curves (a 수정 층's deltas, or the original clip clamped to the joint limits). Playhead outside: nothing.
    const setOverRange = (s: EditorState, t: { clipId: string; f: number; itemId: string }, channel: string, v: number) => {
      const r = s.range!
      if (t.f < r.a || t.f > r.b) return
      const raw = s.project.clips[t.clipId], def = defs[raw.robot], j = def.joints.find(j => j.name === channel)
      const fb = channel === 'root.z' ? def.standingHeight : 0
      if (j) v = Math.min(Math.max(v, j.lower), j.upper)
      const asset = s.layer === 'asset' || (s.layer !== 'clip' && t.itemId === CLIP_ITEM)
      const ownerId = s.layer === 'clip' ? t.clipId : asset ? assetOwner(t.clipId) : t.itemId
      if (ownerId === t.clipId && clipLocked(s.project, t.clipId)) return
      const own = keyOwner(s.project, ownerId)
      if (!own) return
      const under = own.offset ? (asset ? raw : baseClip(s.project, defs, t.clipId)!) : null
      const cur = (under ? evalCurve(under.channels[channel] ?? { keys: [] }, t.f, fb) : 0) + evalCurve(own.channels[channel] ?? { keys: [] }, t.f, own.offset ? 0 : fb)
      const d = v - cur
      if (Math.abs(d) < 1e-12) return
      const next = addOverRange(own.channels[channel], own.offset ? 0 : fb, r, d, own.length,
        j && !own.offset ? (x => Math.min(Math.max(x, j.lower), j.upper)) : undefined)
      edit(p => { ownerOf(p, ownerId)!.channels[channel] = next }, [{ clipId: ownerId, channels: [channel] }])
    }
    const findKey = (clip: Owner, r: KeyRef) => clip.channels[r.channel]?.keys.find(k => k.f === r.f)

    const keyChannels = (actorId: string, names: string[]) => {
        const actor = actorOf(get(), actorId)
        if (!actor) return // stale id: the actor may have been removed with its last clip
        const def = defs[actor.robot]
        const t = keyTarget(get(), actorId)
        if (!t || trackLocked(get().project, actorId) || clipLocked(get().project, t.clipId)) return
        const { clipId, f } = t
        if (names.some(n => editLock(get(), actorId, n))) return
        if (t.owner !== clipId) { // 수정 층: key every channel at its current difference
          edit(p => { const o = ownerOf(p, t.owner)!; for (const n of names) putKey(o, n, f, evalCurve(o.channels[n] ?? { keys: [] }, f, 0)) }, [{ clipId: t.owner, channels: [] }])
          return
        }
        edit(p => {
          const clip = p.clips[clipId]
          const pose = evaluateClip(clip, def, f)
          for (const n of names) {
            const v = ROOT.includes(n)
              ? evalCurve(clip.channels[n] ?? { keys: [] }, f, n === 'root.z' ? def.standingHeight : 0)
              : pose.q[def.joints.findIndex(j => j.name === n)]
            putKey(clip, n, f, v)
          }
        }, [{ clipId, channels: names }])
      }
    const poseAt: EditorState['poseAt'] = actorId => {
      const s = get(), actor = actorOf(s, actorId), t = actor && editTarget(s, actorId), item = t && targetItem(s, t.itemId)
      if (!actor || !t || !item) return null
      const def = defs[actor.robot], shown = (s.clipEdit ? baseClip(s.project, defs, t.clipId) : editedClip(s.project, defs, item)) ?? s.project.clips[t.clipId]
      const r = (c: string) => evalCurve(shown.channels[c] ?? { keys: [] }, t.f, c === 'root.z' ? def.standingHeight : 0)
      return { def, f: t.f, body: { x: r('root.x'), y: r('root.y'), z: r('root.z'), roll: r('root.roll'), pitch: r('root.pitch'), yaw: r('root.yaw') }, q: [...evaluateClip(shown, def, t.f).q] }
    }
    const editPose = (actorId: string, values: Record<string, number>, lock: boolean) => {
      if (suspended) return false // the gesture was cancelled by undo and is still held
      const cur = poseAt(actorId)
      if (!cur) return false
      const { def } = cur, body: Body = { ...cur.body }
      let q = [...cur.q]
      for (const k of ['x', 'y', 'z', 'roll', 'pitch', 'yaw'] as const) if (values[`root.${k}`] !== undefined) body[k] = values[`root.${k}`]
      def.joints.forEach((j, i) => { if (values[j.name] !== undefined) q[i] = Math.min(Math.max(values[j.name], j.lower), j.upper) })
      const locked = lock && ROOT.some(c => values[c] !== undefined)
      if (locked) {
        const solved = lockFeet(def, q, cur.body, body)
        if (!solved) return false
        q = solved
      }
      if (!locked && get().autoGround && values['root.z'] === undefined) body.z = groundZ(def, q, body)
      const was = gesture
      if (!was) get().beginGesture()
      const chan = (b: Body, qq: number[]) => [...ROOT.map(c => [c, b[c.slice(5) as keyof Body]] as const), ...def.joints.map((j, i) => [j.name, qq[i]] as const)]
      const had = new Map(chan(cur.body, cur.q))
      for (const [c, x] of chan(body, q)) if (Math.abs(x - had.get(c)!) > 1e-9) get().setValue(actorId, c, x)
      if (!was) get().endGesture()
      return true
    }

    return {
      selItem: null, selectItem: selItem => set({ selItem }),
      editing: null,
      openItem: itemId => {
        const t = get().project.sequence.tracks.find(t => t.items.some(i => i.id === itemId))
        if (t?.kind !== 'motion') return
        if (get().clipEdit) get().closeClipEdit()
        set({ editing: itemId, selItem: itemId, sel: { actorId: t.actorId ?? null, channel: null, keys: [] }, range: null })
      },
      closeItem: () => set(s => ({ editing: null, frame: Math.max(s.frame, 0), range: null })),
      setIn: f => edit(p => { p.sequence.inF = f; if (f !== null && p.sequence.outF !== null && p.sequence.outF <= f) p.sequence.outF = null }, []),
      setOut: f => edit(p => { p.sequence.outF = f; if (f !== null && p.sequence.inF !== null && p.sequence.inF >= f) p.sequence.inF = null }, []),
      addMarker: f => edit(p => {
        const n = Math.max(0, ...p.sequence.markers.map(m => Number(/^마커 (\d+)$/.exec(m.name)?.[1] ?? 0))) + 1
        p.sequence.markers.push({ f: Math.round(f), name: `마커 ${n}` })
        p.sequence.markers.sort((a, b) => a.f - b.f)
      }, []),
      renameMarker: (i, name) => edit(p => { if (p.sequence.markers[i]) p.sequence.markers[i].name = name }, []),
      deleteMarker: i => edit(p => { p.sequence.markers.splice(i, 1) }, []),
      defs, project: freezeClips(initial), frame: 0, playing: false, autoKey: false, view: 'tracks',
      sel: { actorId: null, channel: null, keys: [] },
      setFrame: frame => set({ frame }),
      setPlaying: playing => set({ playing }),
      toggleAutoKey: () => set(s => ({ autoKey: !s.autoKey })),
      layer: 'piece',
      setLayer: layer => set(s => s.layer === layer || (s.clipEdit ? layer === 'piece' : layer === 'asset') ? s : { layer, sel: { ...s.sel, keys: [] } }),
      clipEdit: null, clipEditReturn: null, clipPeek: false,
      range: null,
      setRange: r => set(s => {
        const e = editingItem(s)
        if (!r || !e) return { range: null }
        const top = e.clip.length - 1, a = Math.min(Math.max(Math.round(Math.min(r.a, r.b)), 0), top), b = Math.min(Math.max(Math.round(Math.max(r.a, r.b)), 0), top)
        return { range: { a, b, fade: Math.min(Math.max(Math.round(r.fade), 0), 600) } }
      }),
      stageShown: true, setStageShown: stageShown => set({ stageShown }),
      degrees: true, setDegrees: degrees => set({ degrees }),
      setClipPeek: on => set({ clipPeek: on }),
      openClipEdit: clipId => {
        const s = get()
        if (!s.project.clips[clipId] || s.clipEdit === clipId) return
        const ret = s.clipEditReturn ?? { frame: s.frame, layer: s.layer }
        set({ clipEdit: clipId, clipEditReturn: ret, frame: 0, playing: false, editing: null, layer: 'asset', selItem: null, sel: { actorId: CLIP_ACTOR, channel: null, keys: [] }, range: null })
      },
      closeClipEdit: () => set(s => s.clipEdit ? { clipEdit: null, clipEditReturn: null, range: null, frame: s.clipEditReturn?.frame ?? 0, layer: s.clipEditReturn?.layer ?? 'piece', playing: false, sel: { actorId: null, channel: null, keys: [] } } : s),
      clearOffset: itemId => tryEdit(p => {
        const f = findItem(p, itemId)
        if (!f || f.t.locked || !f.it.offset) return false
        delete f.it.offset; delete f.it.use
        set(s => ({ sel: { ...s.sel, keys: [] } }))
        return true
      }),
      clearClipOffset: clipId => tryEdit(p => {
        if (!p.clips[clipId]?.offset) return false
        delete p.clips[clipId].offset
        set(s => ({ sel: { ...s.sel, keys: [] } }))
        return true
      }, [{ clipId: assetOwner(clipId), channels: [] }]),
      setView: view => set({ view }),
      videoMode: 'overlay', videoOpacity: 0.5,
      setVideoMode: videoMode => set({ videoMode }),
      setVideoOpacity: v => set({ videoOpacity: Math.min(Math.max(v, 0), 1) }),
      comparePanes: [],
      openComparePane: id => set(s => s.comparePanes.includes(id) || !s.project.clips[id] ? s : { comparePanes: [...s.comparePanes, id].slice(-2) }),
      closeComparePane: id => set(s => ({ comparePanes: s.comparePanes.filter(x => x !== id) })),
      playheadPinned: false,
      setPlayheadPinned: on => set({ playheadPinned: on }),
      walkMode: false,
      setWalkMode: on => {
        set({ walkMode: on })
        const s = get()
        if (!on || s.editing || s.clipEdit) return // sequence frames only mean something in the sequence view
        const a = actorOf(s, s.sel.actorId), go2 = a?.robot === 'go2' ? a : s.project.actors.find(x => x.robot === 'go2')
        const items = s.project.sequence.tracks.find(t => t.kind === 'motion' && t.actorId === go2?.id)?.items ?? []
        if (items.length) set({ frame: Math.max(...items.map(i => i.start + itemLen(i))) - 1 })
      },
      spanPreview: null, setSpanPreview: r => set({ spanPreview: r && r[1] > r[0] ? [Math.max(0, Math.round(r[0])), Math.round(r[1])] : null }),
      itemPreview: null, compareOverlay: false,
      setCompareOverlay: on => set({ compareOverlay: on }),
      openItemPreview: (id, play) => {
        if (!findItem(get().project, id)) return
        const r = previewRange(get().project, defs, id) // the preview's own playhead; the main one stays (user)
        set({ itemPreview: id, previewFrame: r ? r[0] : 0, previewPlaying: !!play && !!r })
      },
      closeItemPreview: () => set({ itemPreview: null, previewPlaying: false }),
      previewFrame: 0, previewPlaying: false,
      setPreviewFrame: f => set({ previewFrame: Math.round(f) }),
      setPreviewPlaying: previewPlaying => set({ previewPlaying }),
      setItemUse: (itemId, use) => tryEdit(p => {
        const f = findItem(p, itemId)
        if (!f || f.t.locked || f.t.kind !== 'motion' || (use && !offsetKeyCount(f.it))) return false
        if (use) f.it.use = use; else delete f.it.use
        return true
      }),
      select: (actorId, channel = null) => {
        const e = editingItem(get())
        if (e && actorId && actorId !== e.actorId) return // other actors are ghosts in clip view
        set({ sel: { actorId, channel, keys: [] } })
      },
      selectKeys: (keys, additive) => set(s => {
        const base = additive ? s.sel.keys : []
        const add = keys.filter((k, i) =>
          !base.some(b => b.channel === k.channel && b.f === k.f) &&
          keys.findIndex(o => o.channel === k.channel && o.f === k.f) === i)
        return { sel: { ...s.sel, keys: [...base, ...add] } }
      }),
      setValue: (actorId, channel, v) => {
        const s = get()
        if (s.layer === 'clip' && !s.autoKey) return
        const t = editTarget(s, actorId)
        if (!t || editLock(s, actorId, channel) || trackLocked(s.project, actorId)) return
        if (s.range && (s.editing || s.clipEdit)) return setOverRange(s, t, channel, v)
        if (s.layer === 'clip') return s.setKey(t.clipId, channel, t.f, v)
        // 수정 층: key the difference from what lies under it (클립 수정 층: the original; 조각: the clip with its 수정 층), so the
        // result shows v here (joints clamped like a clip key)
        const asset = s.layer === 'asset' || t.itemId === CLIP_ITEM
        const under = asset ? s.project.clips[t.clipId] : baseClip(s.project, defs, t.clipId)!, def = defs[under.robot], j = def.joints.find(j => j.name === channel)
        if (j) v = Math.min(Math.max(v, j.lower), j.upper)
        const ownerId = asset ? assetOwner(t.clipId) : t.itemId, d = v - evalCurve(under.channels[channel] ?? { keys: [] }, t.f, channel === 'root.z' ? def.standingHeight : 0)
        if (clipLocked(s.project, ownerId)) return
        edit(p => { // the value here, easing back to what played before around it (offsetPins)
          const o = ownerOf(p, ownerId)
          if (!o) return
          const pins = offsetPins(o, channel, t.f)
          putKey(o, channel, t.f, d)
          for (const [pf, pv] of pins) putKey(o, channel, pf, pv)
        }, [{ clipId: ownerId, channels: [channel] }])
      },
      setKey: (clipId, channel, f, v) => clipLocked(get().project, clipId) ? undefined : edit(p => { const o = ownerOf(p, clipId); if (o) putKey(o, channel, f, v) }, [{ clipId, channels: [channel] }]),
      deleteKeys: (clipId, keys) => clipLocked(get().project, clipId) ? undefined : edit(p => {
        const clip = ownerOf(p, clipId)
        if (!clip) return
        for (const r of keys) {
          const c = clip.channels[r.channel]
          if (c) c.keys = c.keys.filter(k => k.f !== r.f)
        }
        set(s => ({ sel: { ...s.sel, keys: s.sel.keys.filter(k => !keys.some(r => r.channel === k.channel && r.f === k.f)) } }))
      }, [{ clipId, channels: chans(keys) }]),
      moveKeys: (clipId, keys, df) => {
        if (clipLocked(get().project, clipId)) return
        const moved: KeyRef[] = []
        edit(p => {
          const clip = ownerOf(p, clipId)
          if (!clip) return
          const d = clampDf(clip.length, keys, df)
          for (const channel of new Set(keys.map(k => k.channel))) {
            const c = clip.channels[channel]
            if (!c) continue
            const from = new Set(keys.filter(k => k.channel === channel).map(k => k.f))
            const sel = c.keys.filter(k => from.has(k.f))
            if (!sel.length) continue
            const mv = sel.map(k => ({ ...k, f: k.f + d }))
            const dest = new Set(mv.map(k => k.f))
            c.keys = [...c.keys.filter(k => !from.has(k.f) && !dest.has(k.f)), ...mv].sort((a, b) => a.f - b.f)
            moved.push(...mv.map(k => ({ channel, f: k.f })))
          }
        }, [{ clipId, channels: chans(keys) }])
        set(s => ({ sel: { ...s.sel, keys: moved } }))
      },
      setInterp: (clipId, keys, interp) => clipLocked(get().project, clipId) ? undefined : edit(p => {
        for (const r of keys) {
          const o = ownerOf(p, clipId), k = o && findKey(o, r)
          if (!k) continue
          k.interp = interp
          if (interp === 'bezier') { k.inTan.dv = 0; k.outTan.dv = 0 }
        }
      }, [{ clipId, channels: chans(keys) }]),
      setTangent: (clipId, channel, f, side, t, linked) => clipLocked(get().project, clipId) ? undefined : edit(p => {
        const o = ownerOf(p, clipId), k = o && findKey(o, { channel, f })
        if (!k) return
        const [mine, other] = side === 'out' ? [k.outTan, k.inTan] : [k.inTan, k.outTan]
        mine.df = t.df; mine.dv = t.dv
        if (linked && t.df !== 0) other.dv = (t.dv / t.df) * other.df
      }, [{ clipId, channels: [channel] }]),
      keyGroup: (actorId, group) => {
        const actor = actorOf(get(), actorId)
        if (!actor) return // stale id: the actor may have been removed with its last clip
        const names = group === '루트' ? ROOT : defs[actor.robot].groups.find(g => g.name === group)?.joints
        if (!names) throw new Error(`unknown group ${group}`)
        keyChannels(actorId, names)
      },
      keyPose: actorId => {
        const actor = actorOf(get(), actorId)
        if (actor) keyChannels(actorId, [...ROOT, ...defs[actor.robot].joints.map(j => j.name)])
      },
      feetLock: false, setFeetLock: on => set({ feetLock: on }),
      autoGround: false, setAutoGround: on => set({ autoGround: on }),
      poseAt,
      editPose: (actorId, values) => editPose(actorId, values, get().feetLock),
      standPose: actorId => {
        const p = poseAt(actorId)
        if (!p) return
        const v: Record<string, number> = { 'root.pitch': 0, 'root.roll': 0 }
        if (!get().autoGround) v['root.z'] = p.def.rest.z
        standQ(p.def).forEach((x, i) => { v[p.def.joints[i].name] = x })
        editPose(actorId, v, false)
      },
      setStage: patch => {
        const clean: Partial<StageSize> = {}
        for (const k of ['width', 'depth'] as const) { const v = patch[k]; if (v !== undefined && Number.isFinite(v)) clean[k] = Math.min(30, Math.max(1, Math.round(v * 10) / 10)) }
        const cur = stageOf(get().project)
        if (Object.entries(clean).some(([k, v]) => cur[k as keyof StageSize] !== v)) edit(p => { p.stage = { ...stageOf(p), ...clean } }, [])
      },
      setPhysics: next => edit(p => { p.physics = next }, []),
      setTrackFlag: (trackId, flag, on) => edit(p => {
        const t = p.sequence.tracks.find(t => t.id === trackId)
        if (!t) return
        if (flag !== 'trail') t[flag] = on
        else if (on && t.kind === 'motion') t.trail = true
        else delete t.trail
      }, []),
      setItemHidden: (itemId, on) => edit(p => { const it = findItem(p, itemId)?.it; if (it) { if (on) it.hidden = true; else delete it.hidden } }, []),
      setClip: (clipId, patch) => {
        if (clipLocked(get().project, clipId)) return false
        const name = patch.name?.trim() || undefined
        const len = patch.length === undefined ? undefined : Math.round(patch.length)
        if (len !== undefined && !(len >= 1)) return get().setClip(clipId, { name })
        if (name === undefined && len === undefined) return true
        const gone: KeyRef[] = []
        const ok = tryEdit(p => {
          const clip = p.clips[clipId]
          if (name) clip.name = name
          if (len === undefined) return true
          const old = clip.length
          clip.length = len
          for (const [channel, c] of Object.entries(clip.channels)) {
            for (const k of c.keys) if (k.f > len - 1) gone.push({ channel, f: k.f })
            c.keys = c.keys.filter(k => k.f <= len - 1)
          }
          if (clip.offset) for (const c of Object.values(clip.offset)) c.keys = c.keys.filter(k => k.f <= len - 1) // 클립 수정 층 too
          // an item ending at the clip end follows the new end; other trims are kept, clamped into the clip
          for (const t of p.sequence.tracks) {
            let hit = false
            for (const it of t.items) if (it.refId === clipId) {
              if (it.offset) for (const c of Object.values(it.offset)) c.keys = c.keys.filter(k => k.f <= len - 1)
              it.trimOut = it.trimOut === old ? len : Math.min(it.trimOut, len)
              it.trimIn = Math.min(it.trimIn, it.trimOut - 1)
              hit = true
            }
            if (hit && !validTrack(t.items)) return false
          }
          return true
        }, [{ clipId, channels: len === undefined ? [] : 'all' }])
        if (ok && gone.length) set(s => ({ sel: { ...s.sel, keys: s.sel.keys.filter(k => !gone.some(r => r.channel === k.channel && r.f === k.f)) } }))
        return ok
      },
      setPlacement: (actorId, pl) => { if (trackLocked(get().project, actorId)) return; edit(p => {
        Object.assign(p.actors.find(a => a.id === actorId)!.placement, pl)
      }, []) },
      setColor: (actorId, hex) => edit(p => { p.actors.find(a => a.id === actorId)!.color = hex }, []),
      addActor: robot => commit(addActorTo({ ...get().project, actors: structuredClone(get().project.actors), sequence: structuredClone(get().project.sequence), clips: { ...get().project.clips } }, robot)),
      newClip: robot => {
        const id = crypto.randomUUID()
        edit(p => { p.clips[id] = { id, name: nextClipName(p, robot), robot, length: 120, channels: {} } }, [])
        return id
      },
      importClipToActor: clip => {
        let out: { actorId: string; itemId: string } | null = null
        tryEdit(p => {
          const exists = p.actors.some(a => a.robot === clip.robot)
          if (!exists) Object.assign(p, addActorTo(p, clip.robot, false))
          addUniqueClip(p, clip)
          if (exists) return true
          const actor = p.actors.at(-1)!, track = p.sequence.tracks.find(t => t.kind === 'motion' && t.actorId === actor.id)!
          const item = { id: crypto.randomUUID(), refId: clip.id, start: 0, trimIn: 0, trimOut: clip.length }
          track.items.push(item)
          out = { actorId: actor.id, itemId: item.id }
          return true
        })
        return out
      },
      addClipAsset: clip => {
        let name: string | null = null
        tryEdit(p => { addUniqueClip(p, clip); name = p.clips[clip.id].name; return true })
        return name
      },
      appendClip: (actorId, clip) => {
        let out: string | null = null
        tryEdit(p => {
          if (actorId === null) Object.assign(p, addActorTo(p, clip.robot, false))
          const id = actorId ?? p.actors.at(-1)!.id
          const actor = p.actors.find(a => a.id === id)
          const track = p.sequence.tracks.find(t => t.kind === 'motion' && t.actorId === id)
          if (!actor || !track || track.locked || actor.robot !== clip.robot) return false
          if (!p.clips[clip.id]) addUniqueClip(p, clip) // a clip already in the assets is placed as it is (no copy)
          const item = { id: crypto.randomUUID(), refId: clip.id, start: Math.max(0, ...track.items.map(i => i.start + itemLen(i))), trimIn: 0, trimOut: clip.length }
          track.items.push(item)
          out = item.id
          return validTrack(track.items)
        })
        return out
      },
      placeClipAsNewActor: (clipId, start) => {
        let out: { actorId: string; itemId: string } | null = null
        tryEdit(p => {
          const clip = p.clips[clipId]
          if (!clip) return false
          Object.assign(p, addActorTo(p, clip.robot, false))
          const actor = p.actors.at(-1)!, track = p.sequence.tracks.at(-1)!
          const item = { id: crypto.randomUUID(), refId: clipId, start: Math.round(start), trimIn: 0, trimOut: clip.length }
          track.items.push(item)
          out = { actorId: actor.id, itemId: item.id }
          return true
        }) // clips are only referenced, never mutated: nothing touched
        return out
      },
      simplifyClip: (clipId, rot = 0.001, pos = 0.001) => {
        const clip = get().project.clips[clipId]
        if (!clip || clipLocked(get().project, clipId)) return 0
        const next: Record<string, Curve> = {}
        let cut = 0
        for (const [ch, c] of Object.entries(clip.channels)) {
          const r = simplifyCurve(c, simplifyTolerance(ch, rot, pos))
          cut += c.keys.length - r.keys.length
          next[ch] = r
        }
        if (cut === 0) return 0
        edit(p => { Object.assign(p.clips[clipId].channels, next) }, [{ clipId, channels: 'all' }])
        return cut
      },
      deleteClip: clipId => tryEdit(p => {
        if (!p.clips[clipId] || p.sequence.tracks.some(t => t.items.some(i => i.refId === clipId))) return false
        delete p.clips[clipId]
        return true
      }),
      addMedia: (name, durationF) => {
        if (!Number.isInteger(durationF) || durationF < 1) throw new Error(`invalid durationF ${durationF}`)
        const id = crypto.randomUUID()
        edit(p => {
          if (!videoTrack(p)) p.sequence.tracks.unshift({ id: crypto.randomUUID(), kind: 'video', hidden: false, locked: false, items: [] })
          const taken = new Set(p.media.map(m => m.name))
          let n = name
          for (let i = 2; taken.has(n); i++) n = `${name}_${i}`
          p.media.push({ id, name: n, durationF })
        }, [])
        return id
      },
      addBin: (tab, ids = []) => {
        const id = crypto.randomUUID()
        edit(p => {
          const bins = p.bins ?? []
          let n = 1
          while (bins.some(b => b.tab === tab && b.name === `폴더 ${n}`)) n++
          p.bins = [...bins, { id, name: `폴더 ${n}`, tab }]
          setBin(p, ids, id)
        }, [])
        return id
      },
      renameBin: (id, name) => {
        const n = name.trim()
        return !!n && tryEdit(p => {
          if (!p.bins?.find(b => b.id === id) || p.bins.find(b => b.id === id)!.name === n) return false // unchanged = no undo entry
          p.bins = p.bins.map(b => b.id === id ? { ...b, name: n } : b)
          return true
        })
      },
      deleteBin: id => tryEdit(p => {
        if (!p.bins?.some(b => b.id === id)) return false
        for (const [cid, c] of Object.entries(p.clips)) if (c.bin === id) { const { bin: _, ...rest } = c; p.clips[cid] = rest }
        p.media = p.media.map(m => { if (m.bin !== id) return m; const { bin: _, ...rest } = m; return rest })
        p.bins = p.bins.filter(b => b.id !== id)
        return true
      }),
      moveToBin: (ids, binId) => tryEdit(p => {
        if (binId !== null && !p.bins?.some(b => b.id === binId)) return false
        return setBin(p, ids, binId) > 0
      }),
      addClip: clip => {
        edit(p => { const { bin: _, ...top } = clip; addUniqueClip(p, top) }, [])
        return clip.id
      },
      deleteMedia: mediaId => tryEdit(p => {
        if (!p.media.some(m => m.id === mediaId) || p.sequence.tracks.some(t => t.items.some(i => i.refId === mediaId))) return false
        p.media = p.media.filter(m => m.id !== mediaId)
        return true
      }),
      addVideoItem: (mediaId, start) => tryEdit(p => {
        const m = p.media.find(m => m.id === mediaId), t = videoTrack(p)
        if (!m || !t || t.locked) return false
        t.items.push({ id: crypto.randomUUID(), refId: mediaId, start: Math.round(start), trimIn: 0, trimOut: m.durationF })
        return validItems(p, t)
      }),
      addItem: (actorId, clipId, start, shift) => tryEdit(p => {
        const clip = p.clips[clipId]
        const track = p.sequence.tracks.find(t => t.kind === 'motion' && t.actorId === actorId)
        const actor = p.actors.find(a => a.id === actorId)
        if (!clip || !track || track.locked || !actor || actor.robot !== clip.robot) return false
        if (shift) for (const it of track.items) if (shift.ids.includes(it.id)) it.start += Math.round(shift.by)
        track.items.push({ id: crypto.randomUUID(), refId: clipId, start: Math.round(start), trimIn: 0, trimOut: clip.length })
        return validTrack(track.items)
      }),
      moveItem: (itemId, start) => tryEdit(p => {
        const f = findItem(p, itemId)
        if (!f || f.t.locked) return false
        f.it.start = Math.round(start)
        return validItems(p, f.t)
      }),
      trimItem: (itemId, side, df) => tryEdit(p => {
        const f = findItem(p, itemId)
        if (!f || f.t.locked) return false
        const d = Math.round(df), it = f.it
        if (side === 'in') { it.start += d; it.trimIn += d } else it.trimOut += d
        const c = f.t.kind === 'motion' ? p.clips[it.refId] : undefined
        if (c?.hold && it.trimOut > c.length) p.clips[c.id] = { ...c, length: it.trimOut } // Empty: its end drags the clip longer (never shorter: other pieces)
        return it.trimIn >= 0 && it.trimIn < it.trimOut && it.trimOut <= refLen(p, f.t, it) && validItems(p, f.t)
      }),
      splitItem: (itemId, frame) => tryEdit(p => {
        const f = findItem(p, itemId)
        if (!f || f.t.locked) return false
        const it = f.it, cut = Math.round(frame) - it.start + it.trimIn
        if (!(cut > it.trimIn && cut < it.trimOut)) return false
        const right: Item = { id: crypto.randomUUID(), refId: it.refId, start: Math.round(frame), trimIn: cut, trimOut: it.trimOut }
        if (it.offset) right.offset = structuredClone(it.offset) // clip frames: each piece keeps the part under it
        if (it.use) right.use = it.use
        if (f.t.kind === 'motion') { it.restTail ??= true; right.restTail = true } // 끝 기본자세 on both pieces (user: every cut ends each piece standing); one turned off stays off
        if (f.t.kind === 'motion') { it.restPose = 'prepend'; right.restPose = 'prepend' } // 기본자세 덧붙이기 on both pieces by default (user)
        it.trimOut = cut
        f.t.items.push(right)
        return validItems(p, f.t)
      }),
      swapItems: (aId, bId) => tryEdit(p => {
        const f = findItem(p, aId), g = findItem(p, bId)
        if (!f || !g || f.t !== g.t || f.t.locked || f.t.kind !== 'motion' || aId === bId) return false
        const items = sortedItems(f.t), i = items.indexOf(f.it), j = items.indexOf(g.it)
        const gaps = items.map((it, k) => k ? it.start - (items[k - 1].start + itemLen(items[k - 1])) : it.start)
        ;[items[i], items[j]] = [items[j], items[i]]
        let end = 0
        items.forEach((it, k) => { it.start = Math.max(0, (k ? end : 0) + gaps[k]); end = it.start + itemLen(it) })
        return validItems(p, f.t)
      }),
      deleteItem: itemId => {
        const ok = tryEdit(p => {
          const f = findItem(p, itemId)
          if (!f || f.t.locked) return false
          // a cut piece goes back into its neighbour (user: the original CSV runs on): the piece just before takes over its range, or
          // (the first piece) the one just after. Only a continuous neighbour: same clip, adjoining clip frames and sequence frames.
          // Otherwise the slot is left empty, nothing moves. The deleted piece's 수정 goes with it.
          const items = sortedItems(f.t), k = items.indexOf(f.it), b = f.it
          const prev = items[k - 1], next = items[k + 1]
          const joins = (x: Item | undefined, y: Item | undefined) => !!x && !!y && x.refId === y.refId && x.trimOut === y.trimIn && x.start + itemLen(x) === y.start
          if (f.t.kind === 'motion' && joins(prev, b)) {
            prev.trimOut = b.trimOut
            if (b.restTail === undefined) delete prev.restTail; else prev.restTail = b.restTail // its end is the deleted piece's end now
          } else if (f.t.kind === 'motion' && !prev && joins(b, next)) {
            next.start = b.start; next.trimIn = b.trimIn
            const front = ['restPose', 'restHold', 'restBlend', 'inertia'] as const // its front is the deleted piece's front now
            for (const key of front) delete next[key]
            Object.assign(next, Object.fromEntries(front.filter(key => b[key] !== undefined).map(key => [key, b[key]])))
          }
          f.t.items = f.t.items.filter(i => i.id !== itemId)
          // last clip of a motion track gone -> the robot goes with it (the clip stays in the assets)
          if (f.t.kind === 'motion' && !f.t.items.length) {
            p.actors = p.actors.filter(a => a.id !== f.t.actorId)
            p.sequence.tracks = p.sequence.tracks.filter(t => t !== f.t)
          }
          return true
        })
        if (ok) set(s => ({
          selItem: s.selItem === itemId ? null : s.selItem,
          sel: s.sel.actorId && !s.project.actors.some(a => a.id === s.sel.actorId) ? { actorId: null, channel: null, keys: [] } : s.sel,
        }))
        return ok
      },
      setRestPose: (itemId, mode) => tryEdit(p => {
        const f = findItem(p, itemId)
        if (!f || f.t.locked || f.t.kind !== 'motion') return false
        if (mode) f.it.restPose = mode; else delete f.it.restPose
        return true
      }),
      setRestTail: (itemId, on) => tryEdit(p => {
        const f = findItem(p, itemId)
        if (!f || f.t.locked || f.t.kind !== 'motion') return false
        f.it.restTail = on // false: turned off (a later cut keeps it off)
        return true
      }),
      setRestLead: (itemId, patch) => tryEdit(p => {
        const f = findItem(p, itemId)
        if (!f || f.t.locked || f.t.kind !== 'motion') return false
        const lim = { restHold: HOLD_RANGE, restBlend: BLEND_RANGE, inertia: [0, Math.min(INERTIA_CAP, f.it.trimIn)], tailHold: HOLD_RANGE, tailBlend: BLEND_RANGE, seam: [0, SEAM_MAX] } as const
        for (const k of ['restHold', 'restBlend', 'inertia', 'tailHold', 'tailBlend', 'seam'] as const) {
          const v = patch[k]
          if (v === undefined) continue
          if (v === null) delete f.it[k]
          else if (v === 'auto') f.it.restBlend = 'auto'
          else if (Number.isFinite(v)) f.it[k] = Math.min(Math.max(Math.round(v), lim[k][0]), lim[k][1])
          else return false
        }
        return true
      }),
      fileName: null, dirty: false,
      loadProject: (project, fileName) => {
        generation++
        undoS = []; redoS = []; gesture = false; gestureMoved = false; suspended = false
        set({ project: freezeClips(project), fileName, dirty: false, frame: 0, playing: false, editing: null, selItem: null, sel: { actorId: null, channel: null, keys: [] }, comparePanes: [], spanPreview: null, itemPreview: null, clipEdit: null, clipEditReturn: null, range: null, layer: get().clipEditReturn?.layer ?? get().layer })
      },
      markSaved: fileName => set({ fileName, dirty: false }),
      newProjectFile: () => get().loadProject(emptyProject(), null),
      beginGesture: () => {
        if (gesture) return
        gesture = true; gestureMoved = false; suspended = false // undo entry + redo clear wait for the first commit
        set({ inGesture: true })
      },
      endGesture: () => { gesture = false; suspended = false; if (get().inGesture) set({ inGesture: false }) },
      inGesture: false,
      cancelGesture: () => {
        if (!gesture) return
        const moved = gestureMoved
        gesture = false; gestureMoved = false
        const prev = undoS.at(-1)
        if (!moved || !prev) return
        undoS = undoS.slice(0, -1)
        set(s => ({ project: prev, sel: { ...s.sel, keys: [] }, ...follow(prev) }))
      },
      undo: () => {
        // Mid-gesture (slider, gizmo, tangent drag): cancel just that gesture; its remaining edits are dropped.
        if (gesture) { get().cancelGesture(); suspended = true; return }
        if (suspended) return
        const prev = undoS.at(-1)
        if (!prev) return
        undoS = undoS.slice(0, -1); redoS = [...redoS, get().project]
        set(s => ({ project: prev, sel: { ...s.sel, keys: [] }, ...follow(prev) }))
      },
      redo: () => {
        if (gesture || suspended) return
        const next = redoS.at(-1)
        if (!next) return
        redoS = redoS.slice(0, -1); undoS = [...undoS, get().project]
        set(s => ({ project: next, sel: { ...s.sel, keys: [] }, ...follow(next) }))
      },
    }
  })
}

let editor: StoreApi<EditorState> | null = null
export function initEditor(defs: RobotDefs): StoreApi<EditorState> {
  return (editor = createEditorStore(defs, emptyProject()))
}
export function getEditor(): StoreApi<EditorState> {
  if (!editor) throw new Error('editor not initialized')
  return editor
}
export function useEditor<T>(selector: (s: EditorState) => T): T {
  return useStore(getEditor(), selector)
}
