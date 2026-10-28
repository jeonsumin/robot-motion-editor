import { useEffect, useRef, useState, type ReactNode } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js'
import { evalCurve } from '../model/curve'
import { COLOR, stageOf } from '../model/defaults'
import { evaluate, evaluateClip, evaluateItem, evaluateRoot, placeItemPose } from '../model/evaluate'
import { rebasePose } from '../model/pose'
import { itemLead, leadInPose, restClipFor, tailedClip } from '../model/restPose'
import { baseClip, editedClip, offsetKeyCount, withUse } from '../model/itemClip'
import { nearestAngle, quatYaw } from '../model/rootMath'
import { hiddenAt, itemLen, resolve, sortedItems, stitchTransforms, worldToClipRoot } from '../model/sequence'
import type { Actor, Clip, Project } from '../model/types'
import { actorOf, BLOCK_PREVIEW_ID, CLIP_ACTOR, clipLocked, editingItem, editTarget, getEditor, gizmoLock, targetItem, trackLocked, useEditor } from '../store/store'
import { sequenceEnd } from '../transport'
import { cancelDrag, trackDrag } from '../timeline/drag'
import { loadTemplate } from '../go2blocks/Go2BlockPanel'
import { trackEnd, walkStart, walkToClip } from '../go2blocks/walkTo'
import { buildRobot, pivotAngle, type RobotRig } from './buildRobot'
import type { RobotDef } from '../robot/types'
import { followStep } from './follow'
import { disposeStage, makeStage } from './stageFloor'

const css = (n: string) => getComputedStyle(document.documentElement).getPropertyValue(n).trim()
const EXTENT = 5
const TARGET = new THREE.Vector3(0.75, 0, 0.6)
const EYE = new THREE.Vector3(3.2, -3.4, 2).sub(TARGET) // initial camera offset from the target
// unit directions from target: front (+x), side (-y), top (tiny y offset avoids up-vector degeneracy)
const VIEWS: Record<string, [number, number, number]> = { '1': [1, 0, 0.15], '3': [0, -1, 0.15], '7': [0, -0.001, 1] }

function makeGrid(): THREE.LineSegments {
  const fine: number[] = [], bold: number[] = []
  for (let i = -EXTENT * 2; i <= EXTENT * 2; i++) {
    const v = i / 2, out = i % 2 === 0 ? bold : fine
    out.push(v, -EXTENT, 0, v, EXTENT, 0, -EXTENT, v, 0, EXTENT, v, 0)
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute([...fine, ...bold], 3))
  const col = new THREE.Color(css('--line') || '#3B424D'), hi = col.clone().multiplyScalar(1.8)
  const colors: number[] = []
  for (let i = 0; i < fine.length / 3; i++) colors.push(col.r, col.g, col.b)
  for (let i = 0; i < bold.length / 3; i++) colors.push(hi.r, hi.g, hi.b)
  g.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3))
  return new THREE.LineSegments(g, new THREE.LineBasicMaterial({ vertexColors: true }))
}

const OVERLAY = '#6ED3A3' // 겹쳐 보기 ghost: the 조각 수정 층 colour (--piece)

// trailKey/trailClips: what the cached trail was built from (items + placement serialized, clips by identity)
interface Entry { rig: RobotRig; trail: THREE.Line; dot: THREE.Points; ghost: boolean; trailKey?: string; trailClips?: (Clip | undefined)[] }

/** One 3D view. `compareClipId` = a view-only compare pane: one robot at the origin driven by that clip from sequence frame 0 (no gizmo, picking or actors). Omitted = the main pane (every actor).
 * With `itemId` + `range`, an item with 기본자세 덧붙이기 plays its lead-in clip instead (preview only).
 * With `range` = [from, to) clip frames, the compare robot shows that range, root re-based so frame `from` sits at the origin: with `itemId` it follows
 * the main playhead (item start = `from`), else it loops on its own 60 fps clock. */
export default function Stage({ compareClipId: cid, range, itemId, span, children }: { compareClipId?: string; range?: [number, number]; itemId?: string; span?: boolean /* 구간 프리뷰: the store's spanPreview frames looped, every robot, read-only */; children?: ReactNode }) {
  const [lo, hi] = range ?? [0, 0]
  const host = useRef<HTMLDivElement>(null)
  // 로봇 따라가기: per-pane local UI state, read by the render loop through a ref
  const [follow, setFollow] = useState(false)
  const followRef = useRef(false)
  followRef.current = follow
  // 경로 표시 of a compare/clip pane (its one robot), off by default; the main pane follows each track's 경로 표시 (Track.trail, sequence)
  const [trail, setTrail] = useState(false)
  const trailRef = useRef(false)
  trailRef.current = trail
  // 무대: the main pane shares the store flag, the clip/compare/span panes toggle their own
  const main = !cid && !span
  const [stageLocal, setStageLocal] = useState(true)
  const stageStore = useEditor(s => s.stageShown)
  const stageOn = main ? stageStore : stageLocal
  const walk = useEditor(s => s.walkMode)
  const seqView = useEditor(s => !s.editing && !s.clipEdit)
  // 배치 이동 notices (too close, locked, logs not loaded), 3 s
  const [walkMsg, setWalkMsgState] = useState('')
  const msgTimer = useRef(0)
  const setWalkMsg = (m: string) => { setWalkMsgState(m); clearTimeout(msgTimer.current); msgTimer.current = window.setTimeout(() => setWalkMsgState(''), 3000) }
  const stageRef = useRef(true)
  stageRef.current = stageOn

  useEffect(() => {
    const el = host.current!
    const ranged = hi > lo
    const store = getEditor()
    const target = TARGET.clone()
    const scene = new THREE.Scene()
    scene.background = new THREE.Color(css('--bg') || '#22262D')
    const grid = makeGrid()
    scene.add(grid)
    let stageG: THREE.Group | null = null, stageKey = ''
    const hemi = new THREE.HemisphereLight(0xffffff, 0x4a505c, 1.4)
    hemi.position.set(0, 0, 1)
    const sun = new THREE.DirectionalLight(0xffffff, 1.6)
    sun.position.set(2, -3, 4)
    scene.add(hemi, sun)

    const camera = new THREE.PerspectiveCamera(45, 1, 0.05, 100)
    camera.up.set(0, 0, 1)
    camera.position.copy(target).add(EYE)
    const renderer = new THREE.WebGLRenderer({ antialias: true })
    renderer.setPixelRatio(window.devicePixelRatio)
    el.appendChild(renderer.domElement)
    // joint gizmo label: angle now, change since the drag began, limits (user: show how the angle is being turned)
    const tag = document.createElement('div')
    tag.className = 'gz-tag'; tag.hidden = true; el.appendChild(tag)
    let dragFrom: number | null = null
    const orbit = new OrbitControls(camera, renderer.domElement)
    orbit.target.copy(target)
    orbit.update()
    const tc = new TransformControls(camera, renderer.domElement)
    tc.setSize(0.8)
    // the clip preview edits the piece it shows: joints picked and turned here (user: edit in the clip preview); its robot is keyed
    // by the piece's actor so selection, gizmo and setValue work as on the main view. Root: panel numbers (the pane is re-based).
    const editPane = !!(cid && itemId && hi > lo)
    const paneActor = editPane ? store.getState().project.sequence.tracks.find(t => t.items.some(i => i.id === itemId))?.actorId : undefined
    const paneKey = paneActor ?? cid
    const mainView = !cid && !span // the editable main view (picking, gizmo, overlay)
    if (mainView || editPane) scene.add(tc.getHelper())
    // dev/e2e hook
    // dev/e2e hook: __stage = main pane, __stages = every pane by key ('main' or the compare clip id)
    const hook = { stage: () => (stageG?.visible ? stageG : null), camera, tc, entries: () => entries, renderer, camTarget: () => orbit.target.toArray(), overlay: () => overlays.values().next().value?.rig ?? null, overlays: () => overlays }
    const syncStage = () => {
      const { width, depth } = stageOf(store.getState().project), key = `${width}x${depth}`
      if (key === stageKey) return
      stageKey = key
      if (stageG) { scene.remove(stageG); disposeStage(stageG) }
      stageG = makeStage(width, depth, { floor: css('--panel') || '#2B3038', line: css('--line') || '#3B424D', edge: css('--dim') || '#8d96a3', front: css('--accent') || '#F0A43A' })
      stageG.visible = stageRef.current; grid.visible = !stageRef.current
      scene.add(stageG); dirty = true
    }
    const hookKey = span ? 'span' : ranged ? 'preview' : cid ?? 'main'
    if (import.meta.env.DEV) {
      const w = window as any
      ;(w.__stages ??= {})[hookKey] = hook
      if (mainView) w.__stage = hook
    }

    let dirty = true, raf = 0
    const t0 = performance.now()
    let shownF = -1
    // compare-pane pose at clip frame f (re-based to the range start when looping a range)
    const clipPose = (clip: Clip, def: RobotDef, f: number) =>
      ranged ? rebasePose(evaluateClip(clip, def, f), evaluateClip(clip, def, lo)) : evaluateClip(clip, def, f)
    const entries = new Map<string, Entry>()
    let rootMode: 'translate' | 'rotate' = 'translate'
    let last: number[] = []

    // hidden track: stage-only (rig, trail, dot, picking, gizmo); evaluation and export are untouched
    const isHidden = (p: Project, id: string) => !!p.sequence.tracks.find(t => t.kind === 'motion' && t.actorId === id)?.hidden
    // main pane: that track's 경로 표시 on and the track shown
    const showTrail = (p: Project, id: string) => { const t = p.sequence.tracks.find(t => t.kind === 'motion' && t.actorId === id); return !!t?.trail && !t.hidden }
    // track hidden, or (sequence view) the piece under the playhead hidden
    const offStage = (s: { project: Project; frame: number; editing: string | null }, id: string) => {
      const t = s.project.sequence.tracks.find(t => t.kind === 'motion' && t.actorId === id)
      return !!t && (t.hidden || (!s.editing && hiddenAt(t, s.frame)))
    }
    // the actors drawn here: the project's, or (클립 편집 모드) the virtual one for the open clip
    const viewActors = (s: ReturnType<typeof store.getState>) => s.clipEdit && !span ? [actorOf(s, CLIP_ACTOR)].filter(a => !!a) : s.project.actors
    // 클립 편집: the clip as edited (baseClip), or while 원본 보기 is held the original
    const clipEditPose = (s: ReturnType<typeof store.getState>, original: boolean) => {
      const clip = original ? s.project.clips[s.clipEdit!] : baseClip(s.project, s.defs, s.clipEdit!)!
      return evaluateClip(clip, s.defs[clip.robot], Math.min(Math.max(Math.round(s.frame), 0), clip.length - 1))
    }
    type S = ReturnType<typeof store.getState>
    // an actor's pose on the main view from project `vp` (the clip view: its piece, lead-in and 끝 기본자세 as the preview and CSV)
    const mainPose = (s: S, vp: Project, a: Actor) => {
      const ei = editingItem(s), t = ei && ei.actorId === a.id ? editTarget(s, a.id) : null
      const lead = t && s.editing ? leadInPose(vp, s.defs, ei!.item, s.frame) : null // clip view on the piece's 기본자세 · 전이 · 관성 / 끝 기본자세
      return lead ? placeItemPose(vp, s.defs, ei!.item.id, lead) : t ? evaluateItem(vp, s.defs, t.itemId, t.f) : evaluate(vp, s.defs, a.id, s.frame)
    }
    // 겹쳐 보기 ghosts, one per actor: the original under the edit. 클립 편집: the clip without its 클립 수정 층 (겹쳐 보기 button);
    // sequence / clip view: the piece under the playhead without its 조각 수정 층 (원본 겹쳐 보기, always on — user: see the edit against G1 #1)
    const overlays = new Map<string, { robot: string; rig: RobotRig }>()
    const ghostOf = (s: S, a: Actor): (() => ReturnType<typeof mainPose>) | null => {
      if (s.clipEdit) return s.compareOverlay && !s.clipPeek ? () => clipEditPose(s, true) : null
      const ei = editingItem(s)
      if (ei && ei.actorId !== a.id) return null // the other actors are ghosts already
      const t = s.project.sequence.tracks.find(t => t.kind === 'motion' && t.actorId === a.id)
      const it = ei ? ei.item : t && resolve(sortedItems(t), s.frame)?.item
      if (!it || it.use === 'original' || !offsetKeyCount(it)) return null
      return () => mainPose(s, withUse(s.project, it.id, 'original'), a)
    }
    const applyOverlay = (s: S) => {
      const want = new Map<string, () => ReturnType<typeof mainPose>>()
      for (const a of viewActors(s)) { const g = !offStage(s, a.id) && ghostOf(s, a); if (g) want.set(a.id, g) }
      for (const [id, o] of overlays) {
        const a = want.has(id) ? viewActors(s).find(x => x.id === id) : undefined
        if (!a || o.robot !== a.robot) { scene.remove(o.rig.root); disposeObj(o.rig.root); overlays.delete(id) }
      }
      for (const [id, pose] of want) {
        let o = overlays.get(id)
        if (!o) {
          const robot = viewActors(s).find(x => x.id === id)!.robot
          overlays.set(id, o = { robot, rig: buildRobot(s.defs[robot], OVERLAY) }); o.rig.setGhost(true); scene.add(o.rig.root)
        }
        o.rig.applyPose(pose())
      }
    }
    const spanT0 = performance.now()
    const applyAll = () => {
      if (span) { // 구간 프리뷰: the stored sequence on its own loop over spanPreview (read each frame: a right-drag reshapes it live)
        const s = store.getState(), sp = s.spanPreview
        if (!sp) return
        const f = sp[0] + Math.floor((performance.now() - spanT0) * 60 / 1000) % Math.max(sp[1] - sp[0], 1)
        for (const a of s.project.actors) {
          const e = entries.get(a.id)
          if (!e) continue
          const hid = offStage({ ...s, frame: f, editing: null }, a.id)
          e.rig.root.visible = e.dot.visible = !hid; e.trail.visible = false
          if (hid) continue
          const pose = evaluate(s.project, s.defs, a.id, f)
          e.rig.applyPose(pose); e.dot.position.set(pose.rootPos[0], pose.rootPos[1], 0.002)
        }
        dirty = true
        return
      }
      const s = store.getState(), vp = s.project
      const ei = editingItem(s)
      for (const a of viewActors(s)) {
        const e = entries.get(a.id)
        if (!e) continue
        if (s.clipEdit) { // the open clip at the origin
          e.rig.root.visible = e.dot.visible = true; e.trail.visible = false
          if (e.ghost) { e.ghost = false; e.rig.setGhost(false) }
          const pose = clipEditPose(s, s.clipPeek)
          e.rig.applyPose(pose); e.dot.position.set(pose.rootPos[0], pose.rootPos[1], 0.002)
          continue
        }
        const hid = offStage(s, a.id)
        e.rig.root.visible = e.dot.visible = !hid
        e.trail.visible = showTrail(s.project, a.id)
        if (hid) continue
        const ghost = !!ei && ei.actorId !== a.id
        if (e.ghost !== ghost) { e.ghost = ghost; e.rig.setGhost(ghost) }
        const pose = mainPose(s, vp, a)
        e.rig.applyPose(pose)
        e.dot.position.set(pose.rootPos[0], pose.rootPos[1], 0.002)
      }
      if (mainView) applyOverlay(s)
      dirty = true
    }

    const disposeObj = (o: THREE.Object3D) =>
      o.traverse(c => {
        const m = c as THREE.Mesh
        m.geometry?.dispose()
        for (const x of [m.material].flat()) x?.dispose()
      })
    const disposeEntry = (e: Entry) => {
      scene.remove(e.rig.root, e.trail, e.dot)
      for (const o of [e.rig.root, e.trail, e.dot]) disposeObj(o)
    }

    // the clip a compare pane shows: the original, or (item preview) the piece's clip with its 수정 층 and rest-pose bake
    const shownClip = () => {
      const { defs, blockPreview } = store.getState(), project = paneProject()
      const clip = !cid ? undefined : cid === BLOCK_PREVIEW_ID ? blockPreview?.clip : project.clips[cid] // 라이브러리 미리보기: a clip outside the project
      if (!clip || !ranged || !itemId) return clip
      const it = project.sequence.tracks.flatMap(t => t.items).find(i => i.id === itemId)
      const base = (it && tailedClip(project, defs, it)) || clip // with its 끝 기본자세 after trimOut
      const ld = it ? itemLead(project, defs, it) : null // prepend: range = [trimIn − 관성, trimOut + 정지 + 전이), the derived clip's frames
      return ld ? restClipFor(base, defs[clip.robot], lo, hi, 'prepend', ld.hold, ld.blend) : base
    }
    const paneProject = () => store.getState().project
    // compare pane: one rig for the clip at the origin; trail rebuilt only when the clip object changes
    const syncClip = () => {
      const { project, defs } = store.getState()
      const clip = shownClip()
      if (!clip) return
      let e = entries.get(paneKey!)
      if (!e) {
        // item preview: the piece's actor colour, like that robot on the main stage; compare pane: the robot type colour
        const actor = itemId ? project.actors.find(a => a.id === project.sequence.tracks.find(t => t.items.some(i => i.id === itemId))?.actorId) : undefined
        const hex = actor?.color ?? COLOR[clip.robot], color = new THREE.Color(hex)
        const rig = buildRobot(defs[clip.robot], hex)
        const trail = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color }))
        trail.visible = trailRef.current
        const dot = new THREE.Points(
          new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0], 3)),
          new THREE.PointsMaterial({ color, size: 8, sizeAttenuation: false }))
        scene.add(rig.root, trail, dot)
        e = { rig, trail, dot, ghost: false }
        entries.set(paneKey!, e)
      }
      if (e.trailClips?.[0] === clip) return
      e.trailClips = [clip]
      const noJoints = { ...defs[clip.robot], joints: [] }, pts: number[] = []
      for (let f = ranged ? lo : 0, end = ranged ? Math.min(hi, clip.length) : clip.length; f < end; f++) { const p = clipPose(clip, noJoints, f).rootPos; pts.push(p[0], p[1], 0.002) }
      e.trail.geometry.dispose()
      e.trail.geometry = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(pts, 3))
    }
    const applyClip = () => {
      const st0 = store.getState(), s = { ...st0, project: paneProject(), frame: st0.clipEdit ? st0.clipEditReturn?.frame ?? 0 : itemId ? st0.previewFrame : st0.frame }, clip = shownClip(), e = entries.get(paneKey!) // item preview: its own playhead
      if (!clip || !e) return
      // item preview follows the main playhead: range frame lo shows at the item start, or (기본자세 덧붙이기) 1.5 s before it,
      // where the timeline draws the lead-in, so preview, lane, physics graph and CSV rows line up; clamped to the range outside it
      const it = itemId ? s.project.sequence.tracks.flatMap(t => t.items).find(i => i.id === itemId) : undefined
      const f = !ranged ? Math.floor((performance.now() - t0) * 60 / 1000) % Math.max(clip.length, 1) // ⇄ 비교: its own loop, not the sequence (user)
        : it ? lo + Math.min(Math.max(s.frame - it.start + (itemLead(s.project, s.defs, it)?.lead ?? 0), 0), hi - lo - 1)
        : lo + Math.floor((performance.now() - t0) * 60 / 1000) % Math.max(hi - lo, 1)
      if (f === shownF) return
      shownF = f
      const pose = clipPose(clip, s.defs[clip.robot], Math.min(Math.max(f, 0), clip.length - 1))
      e.rig.applyPose(pose)
      e.dot.position.set(pose.rootPos[0], pose.rootPos[1], 0.002)
      dirty = true
    }

    const syncActors = () => {
      const s = store.getState()
      const { project, defs } = s
      const actors = viewActors(s), ids = new Set(actors.map(a => a.id))
      for (const [id, e] of entries) if (!ids.has(id)) { disposeEntry(e); entries.delete(id) }
      for (const a of actors) {
        if (!ids.has(a.id)) continue
        const color = new THREE.Color(a.color)
        let e = entries.get(a.id)
        if (!e) {
          const rig = buildRobot(defs[a.robot], a.color)
          const trail = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color }))
          trail.visible = false
          const dot = new THREE.Points(
            new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0], 3)),
            new THREE.PointsMaterial({ color, size: 8, sizeAttenuation: false }))
          scene.add(rig.root, trail, dot)
          e = { rig, trail, dot, ghost: false }
          entries.set(a.id, e)
        } else e.rig.setColor(a.color)
        if (!showTrail(project, a.id)) continue // built only while shown; rebuilt on show if anything changed meanwhile (trailKey)
        // trail covers the whole sequence; rebuilt only when this actor's items, placement or clips change
        const track = project.sequence.tracks.find(t => t.kind === 'motion' && t.actorId === a.id)
        const clips = track?.items.map(i => project.clips[i.refId]) ?? []
        const key = JSON.stringify([track?.items, a.placement])
        if (e.trailKey === key && e.trailClips && clips.length === e.trailClips.length && clips.every((c, i) => c === e.trailClips![i])) continue
        e.trailKey = key; e.trailClips = clips
        const pts: number[] = []
        if (track?.items.length) {
          for (let f = 0, end = sequenceEnd(project); f < end; f++) {
            const p = evaluateRoot(project, defs, a.id, f).rootPos
            pts.push(p[0], p[1], 0.002)
          }
        }
        e.trail.geometry.dispose()
        e.trail.geometry = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(pts, 3))
      }
    }

    // crossfade (displayed pose is a blend, not invertible) or stitched first frame (root x/y/yaw pinned): no gizmo
    const locked = () => {
      const s = store.getState(), id = s.sel.actorId
      const t = id ? editTarget(s, id) : null
      if (editPane) { // joints of this piece only, while the playhead is in it (crossfade / locked track: no gizmo as on the main view)
        const g = gizmoLock(s)
        const pi = s.project.sequence.tracks.flatMap(t => t.items).find(i => i.id === itemId)
        const off = !pi || s.previewFrame < pi.start || s.previewFrame >= pi.start + pi.trimOut - pi.trimIn
        return off || id !== paneActor || !s.sel.channel || s.sel.channel.startsWith('root') || t?.itemId !== itemId || (g !== null && g !== 'compare')
          || trackLocked(s.project, id!) || clipLocked(s.project, t.clipId)
      }
      const ei = editingItem(s), offPiece = !!ei && !s.clipEdit && (s.frame < ei.item.start || s.frame >= ei.item.start + ei.item.trimOut - ei.item.trimIn)
      return offPiece || gizmoLock(s) !== null || (!!id && (offStage(s, id) || trackLocked(s.project, id) || (!!t && clipLocked(s.project, t.clipId))))
    }
    const syncSelection = () => {
      const s = store.getState()
      const { sel } = s
      const ch = sel.channel?.startsWith('root') ? 'root' : sel.channel
      const accent = new THREE.Color(css('--accent') || '#F0A43A').multiplyScalar(0.5)
      for (const [id, e] of entries)
        for (const [obj, via] of e.rig.linkToJoint) {
          const m = obj as THREE.Mesh
          if (!m.isMesh) continue
          ;(m.material as THREE.MeshStandardMaterial).emissive.set(id === sel.actorId && via === ch ? accent : 0x000000)
        }
      const e = sel.actorId ? entries.get(sel.actorId) : undefined
      // re-attaching mid-drag would reset TransformControls' axis and kill the drag
      const target = !e || locked() ? null : ch === 'root' ? e.rig.root : ch ? e.rig.jointPivots[ch] ?? null : null
      if (!tc.dragging && tc.object !== (target ?? undefined)) {
        tc.detach()
        if (target) tc.attach(target)
      }
      if (e && ch === 'root') {
        if (!tc.object) { dirty = true; return }
        tc.setMode(rootMode)
        tc.setSpace(rootMode === 'rotate' ? 'local' : 'world')
        tc.showX = tc.showY = tc.showZ = true
      } else if (e && ch && e.rig.jointPivots[ch] && tc.object) {
        const robot = actorOf(s, sel.actorId)!.robot
        const ax = s.defs[robot].joints.find(j => j.name === ch)!.axis
        tc.setMode('rotate')
        tc.setSpace('local')
        tc.showX = !!ax[0]; tc.showY = !!ax[1]; tc.showZ = !!ax[2]
      }
      dirty = true
    }

    // a rig root world pose in clip-local root channels: undo placement, then the item's stitch transform
    const toClipRoot = (actorId: string, pos: THREE.Vector3, q: THREE.Quaternion) => {
      const s = store.getState(), actor = actorOf(s, actorId)!, target = editTarget(s, actorId)
      const track = s.project.sequence.tracks.find(t => t.items.some(i => i.id === target?.itemId))
      const xf = (track && target && stitchTransforms(s.project, s.defs, track).get(target.itemId)) || { x: 0, y: 0, yaw: 0 }
      return worldToClipRoot({ pos: [pos.x, pos.y, pos.z], quat: [q.x, q.y, q.z, q.w] }, actor.placement, xf)
    }
    // current gizmo values for the root, in clip-local channels
    const rootValues = (): [string, number][] => {
      const s = store.getState(), actor = actorOf(s, s.sel.actorId)!
      const target = editTarget(s, actor.id)
      const track = s.project.sequence.tracks.find(t => t.items.some(i => i.id === target?.itemId))
      const o = entries.get(actor.id)!.rig.root
      const r = toClipRoot(actor.id, o.position, o.quaternion)
      if (rootMode === 'translate') return [['root.x', r.x], ['root.y', r.y], ['root.z', r.z]]
      // euler read-back wraps to (-pi, pi]; keep each angle continuous with the stored channel value
      if (!target) return [['root.roll', r.roll], ['root.pitch', r.pitch], ['root.yaw', r.yaw]]
      const it = track?.items.find(i => i.id === target.itemId), clip = (it && editedClip(s.project, s.defs, it)) || s.project.clips[target.clipId]
      const cur = (ch: string) => evalCurve(clip.channels[ch] ?? { keys: [] }, target.f, 0)
      return [['root.roll', nearestAngle(r.roll, cur('root.roll'))], ['root.pitch', nearestAngle(r.pitch, cur('root.pitch'))], ['root.yaw', nearestAngle(r.yaw, cur('root.yaw'))]]
    }

    tc.addEventListener('dragging-changed', e => {
      orbit.enabled = !e.value
      if (e.value) store.getState().beginGesture()
      else store.getState().endGesture()
      if (e.value && store.getState().sel.channel?.startsWith('root')) last = rootValues().map(v => v[1])
      dragFrom = e.value ? jointAngle()?.a ?? null : null
    })
    tc.addEventListener('change', () => { dirty = true })
    const jointAngle = () => { // the gizmo's joint and its angle now, or null (root / no gizmo)
      const s = store.getState(), ch = s.sel.channel, o = tc.object, actor = s.sel.actorId ? actorOf(s, s.sel.actorId) : undefined
      const j = o && ch && actor ? s.defs[actor.robot].joints.find(j => j.name === ch) : undefined
      return j && o ? { j, o, a: pivotAngle(o, j.axis) } : null
    }
    const tagPos = new THREE.Vector3()
    // rings around the joint gizmo (user: like Blender's rotate gizmo): X red, Y green, Z blue in the joint's frame, the axis it
    // turns on bright and the others faint (drawn only: TransformControls handles the one real axis), a white ring facing the camera
    const ringMat = (color: string) => new THREE.MeshBasicMaterial({ color, transparent: true, depthTest: false, depthWrite: false })
    const torus = (r: number, color: string) => { const m = new THREE.Mesh(new THREE.TorusGeometry(r, 0.012, 6, 72), ringMat(color)); m.renderOrder = 998; return m }
    const axisRings = new THREE.Group(), viewRing = torus(0.62, '#ffffff')
    const rings = [torus(0.5, '#E5484D'), torus(0.5, '#6CC24A'), torus(0.5, '#4C8DF6')] // normals X, Y, Z
    rings[0].rotation.y = Math.PI / 2; rings[1].rotation.x = Math.PI / 2
    axisRings.add(...rings); axisRings.visible = viewRing.visible = false
    ;(viewRing.material as THREE.MeshBasicMaterial).opacity = 0.55
    if (mainView || editPane) scene.add(axisRings, viewRing)
    const ringQ = new THREE.Quaternion()
    let ringPx = 0
    const updateRings = () => {
      const g = jointAngle()
      axisRings.visible = viewRing.visible = !!g
      if (!g) return
      g.o.getWorldPosition(tagPos); g.o.getWorldQuaternion(ringQ)
      // same on-screen size as TransformControls' rotate rings (its scale rule: factor * size / 4)
      const s = tagPos.distanceTo(camera.position) * Math.min(1.9 * Math.tan(Math.PI * camera.fov / 360) / camera.zoom, 7) * 0.8 / 4
      axisRings.position.copy(tagPos); axisRings.quaternion.copy(ringQ); axisRings.scale.setScalar(s)
      viewRing.position.copy(tagPos); viewRing.quaternion.copy(camera.quaternion); viewRing.scale.setScalar(s)
      const ax = g.j.axis.map(Math.abs), on = ax.indexOf(Math.max(...ax))
      rings.forEach((r, i) => { (r.material as THREE.MeshBasicMaterial).opacity = i === on ? 0.9 : 0.35 })
      ringPx = 0.62 * s / (tagPos.distanceTo(camera.position) * Math.tan(Math.PI * camera.fov / 360)) * el.clientHeight / 2 // white ring radius on screen
    }
    const updateTag = () => {
      const g = jointAngle()
      if (!g) { tag.hidden = true; return }
      const deg = store.getState().degrees, f = (v: number) => deg ? `${(v * 180 / Math.PI).toFixed(1)}°` : v.toFixed(3)
      const d = dragFrom === null ? '' : ` (${g.a - dragFrom >= 0 ? '+' : '−'}${f(Math.abs(g.a - dragFrom))})`
      tag.textContent = `${g.j.name.replace(/_joint$/, '')} ${f(g.a)}${d} · 범위 ${f(g.j.lower)} ~ ${f(g.j.upper)}`
      tag.classList.toggle('near', g.a - g.j.lower < 0.1 * (g.j.upper - g.j.lower) || g.j.upper - g.a < 0.1 * (g.j.upper - g.j.lower))
      g.o.getWorldPosition(tagPos).project(camera)
      tag.style.left = `${(tagPos.x + 1) / 2 * el.clientWidth + ringPx}px`; // just outside the white ring tag.style.top = `${(1 - tagPos.y) / 2 * el.clientHeight}px`
      tag.hidden = false
    }
    tc.addEventListener('objectChange', () => {
      const s = store.getState(), { actorId, channel } = s.sel
      if (!actorId || !channel) return
      if (channel.startsWith('root')) {
        rootValues().forEach(([ch, v], i) => {
          if (Math.abs(v - last[i]) > 1e-6) { last[i] = v; s.setValue(actorId, ch, v) }
        })
      } else {
        const pivot = entries.get(actorId)!.rig.jointPivots[channel]
        const robot = actorOf(s, actorId)!.robot
        const ax = s.defs[robot].joints.find(j => j.name === channel)!.axis
        s.setValue(actorId, channel, pivotAngle(pivot, ax))
      }
      if (editPane) { shownF = -1; applyClip() } else applyAll() // snaps back when the value was clamped
    })
    orbit.addEventListener('change', () => { dirty = true })

    // click-to-select (ignore orbit drags and gizmo hits)
    const ray = new THREE.Raycaster(), ndc = new THREE.Vector2()
    let down: [number, number] | null = null, onGizmo = false
    const dom = renderer.domElement
    // the nearest visible, non-ghost robot link under the pointer (sets `ray`)
    const aim = (ev: MouseEvent) => {
      const r = dom.getBoundingClientRect()
      ndc.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1)
      ray.setFromCamera(ndc, camera)
    }
    const pick = (ev: PointerEvent) => {
      aim(ev)
      let best: { id: string; via: string; d: number } | null = null
      for (const [id, e] of entries) {
        if (e.ghost || !e.rig.root.visible) continue
        const hit = ray.intersectObject(e.rig.root, true)[0]
        const via = hit && e.rig.linkToJoint.get(hit.object)
        if (via && (!best || hit.distance < best.d)) best = { id, via, d: hit.distance }
      }
      return best
    }
    // 3D 끌기 (main view): moves the actor's placement (no keys, no 수정 층)
    const canDrag = (id: string) => {
      const s = store.getState()
      return !!actorOf(s, id) && !s.playing && !s.clipEdit && !offStage(s, id) && !trackLocked(s.project, id)
    }
    const floor = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0), hitP = new THREE.Vector3()
    // grab candidate from pointerdown on a draggable robot; `on` once it moved past 4 px
    let grab: { id: string; at: THREE.Vector3; x: number; y: number; on: boolean } | null = null
    // 배치 이동 + GO2: the robot stays; a dashed line from its track-end spot to the cursor, release appends a walk clip
    // there (trackDrag, so Ctrl+Z mid-drag cancels it)
    let walking = false
    const walkDrag = (id: string, ev: MouseEvent) => {
      const s = store.getState(), start = walkStart(s.project, s.defs, id)
      const color = css('--accent') || '#F0A43A'
      const line = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineDashedMaterial({ color, dashSize: 0.1, gapSize: 0.06 }))
      const ring = new THREE.Mesh(new THREE.RingGeometry(0.12, 0.16, 32), new THREE.MeshBasicMaterial({ color }))
      const show = (ev: MouseEvent) => {
        aim(ev)
        if (!ray.ray.intersectPlane(floor, hitP)) return
        line.geometry.setFromPoints([new THREE.Vector3(start.x, start.y, 0.01), new THREE.Vector3(hitP.x, hitP.y, 0.01)]); line.computeLineDistances()
        ring.position.set(hitP.x, hitP.y, 0.01); dirty = true
      }
      const stop = () => { scene.remove(line, ring); disposeObj(line); disposeObj(ring); walking = false; orbit.enabled = true; dom.style.cursor = ''; dirty = true }
      walking = true; dom.style.cursor = 'grabbing'; scene.add(line, ring); show(ev)
      trackDrag(show, async ev => {
        stop(); aim(ev)
        if (!ray.ray.intersectPlane(floor, hitP)) return
        const target = { x: hitP.x, y: hitP.y }
        const t = await Promise.all([loadTemplate('rotate'), loadTemplate('move')]).catch(() => null)
        if (!t) return setWalkMsg('걷기 로그를 불러오지 못했습니다')
        const r = walkToClip(t[0], t[1], start, target, store.getState().defs)
        if ('error' in r) return setWalkMsg(r.error)
        if (!store.getState().appendClip(id, r.clip)) return setWalkMsg('트랙이 잠겨 있어 걷기를 붙이지 못했습니다')
        store.getState().setFrame(trackEnd(store.getState().project, id) - 1)
      }, stop)
    }
    const onDown = (ev: PointerEvent) => {
      down = [ev.clientX, ev.clientY]; onGizmo = tc.axis !== null; el.focus()
      if (!mainView || onGizmo || ev.button !== 0) return
      const b = pick(ev)
      if (!b || !canDrag(b.id) || !ray.ray.intersectPlane(floor, hitP)) return
      const pl = actorOf(store.getState(), b.id)!.placement
      grab = { id: b.id, at: hitP.clone(), x: pl.x, y: pl.y, on: false }
      orbit.enabled = false // on a robot: no camera
    }
    let hoverEv: PointerEvent | null = null, hoverRaf = 0
    const onMove = (ev: PointerEvent) => {
      if (!grab) { // hover cursor, one raycast per frame
        if (!ev.buttons && !hoverRaf) hoverRaf = requestAnimationFrame(() => { hoverRaf = 0; const b = hoverEv && pick(hoverEv); dom.style.cursor = b && canDrag(b.id) ? 'grab' : '' })
        hoverEv = ev
        return
      }
      if (!grab.on) {
        if (Math.hypot(ev.clientX - down![0], ev.clientY - down![1]) <= 4) return
        const s = store.getState()
        if (s.walkMode && !s.editing && !s.clipEdit && actorOf(s, grab.id)!.robot === 'go2') { const id = grab.id; grab = null; return walkDrag(id, ev) }
        grab.on = true; s.beginGesture(); dom.style.cursor = 'grabbing'
      }
      pick(ev)
      if (!ray.ray.intersectPlane(floor, hitP)) return
      store.getState().setPlacement(grab.id, { x: grab.x + hitP.x - grab.at.x, y: grab.y + hitP.y - grab.at.y })
    }
    const onCancel = () => {
      const g = grab
      if (g) { grab = null; orbit.enabled = true }
      if (g?.on) { store.getState().endGesture(); dom.style.cursor = '' }
    }
    const onUp = (ev: PointerEvent) => {
      const g = grab
      if (g) { grab = null; orbit.enabled = true }
      if (g?.on) { store.getState().endGesture(); dom.style.cursor = 'grab'; return }
      if (!down || Math.hypot(ev.clientX - down[0], ev.clientY - down[1]) > 4 || onGizmo) return
      const best = pick(ev)
      if (best) store.getState().select(best.id, best.via)
      else store.getState().select(null)
    }
    if (mainView || editPane) { dom.addEventListener('pointerdown', onDown); dom.addEventListener('pointerup', onUp); dom.addEventListener('pointercancel', onCancel) }
    if (mainView) dom.addEventListener('pointermove', onMove)

    const onKey = (ev: KeyboardEvent) => {
      const v = VIEWS[ev.key]
      if (v) {
        const d = camera.position.distanceTo(orbit.target)
        camera.position.copy(followRef.current ? orbit.target : target).add(new THREE.Vector3(...v).normalize().multiplyScalar(d))
        orbit.update()
      } else if (mainView && ev.key.toLowerCase() === 'r' && store.getState().sel.channel?.startsWith('root')) {
        rootMode = rootMode === 'translate' ? 'rotate' : 'translate'
        syncSelection()
      }
    }
    el.addEventListener('keydown', onKey)

    const ro = new ResizeObserver(() => {
      const w = el.clientWidth, h = el.clientHeight
      if (!w || !h) return
      renderer.setSize(w, h)
      camera.aspect = w / h
      camera.updateProjectionMatrix()
      dirty = true
    })
    ro.observe(el)

    let wasLocked = false
    if (cid) { syncClip(); applyClip(); if (editPane) syncSelection() } else { syncActors(); applyAll(); if (mainView) syncSelection() }
    syncStage()
    const unsub = store.subscribe((s, prev) => {
      if (s.project !== prev.project) syncStage()
      if (cid) {
        if (s.project !== prev.project || (cid === BLOCK_PREVIEW_ID && s.blockPreview !== prev.blockPreview)) { syncClip(); shownF = -1 }
        applyClip()
        if (editPane) { const lk = locked(); if (s.sel !== prev.sel || lk !== wasLocked) syncSelection(); wasLocked = lk }
        return
      }
      if (s.project !== prev.project || s.clipEdit !== prev.clipEdit) syncActors()
      applyAll()
      if (span) return // read-only: no selection or gizmo
      const key = (p: typeof s.project) => p.actors.map(a => a.id + a.robot).join() + (s.clipEdit ?? '')
      const lk = locked()
      if (s.sel !== prev.sel || key(s.project) !== key(prev.project) || lk !== wasLocked) syncSelection()
      wasLocked = lk
    })

    // tracked robot: compare/clip pane = its one robot; main = selected actor if shown, else the first shown one
    const tracked = () => {
      if (cid) return entries.get(paneKey!)
      const s = store.getState(), sel = s.sel.actorId && entries.get(s.sel.actorId)
      if (sel && sel.rig.root.visible) return sel
      return viewActors(s).map(a => entries.get(a.id)).find(e => e?.rig.root.visible)
    }
    const pos = new THREE.Vector3()
    let wasFollowing = false
    const followCam = () => {
      const on = followRef.current, e = on ? tracked() : undefined
      if (!e) { wasFollowing = false; return }
      e.rig.root.getWorldPosition(pos)
      const r = followStep(orbit.target.toArray(), camera.position.toArray(), pos.toArray(), wasFollowing ? 0.15 : 1)
      wasFollowing = true
      const moved = Math.abs(r.target[0] - orbit.target.x) + Math.abs(r.target[1] - orbit.target.y) + Math.abs(r.target[2] - orbit.target.z) > 1e-6
      orbit.target.fromArray(r.target); camera.position.fromArray(r.camera)
      if (moved) { orbit.update(); dirty = true }
    }
    let shownTrail = trailRef.current, shownStage = stageRef.current
    const loop = () => {
      raf = requestAnimationFrame(loop)
      if (stageRef.current !== shownStage) { // 무대 toggled
        shownStage = stageRef.current
        if (stageG) stageG.visible = shownStage
        grid.visible = !shownStage
        dirty = true
      }
      if (trailRef.current !== shownTrail) { // 경로 표시 toggled
        shownTrail = trailRef.current
        if (cid) for (const e of entries.values()) e.trail.visible = shownTrail
        dirty = true
      }
      if (cid) applyClip() // panes play on their own (item preview: its own playhead; ⇄ 비교: a loop)
      else if (span) applyAll() // 구간 프리뷰: its own loop
      followCam()
      if (!dirty) return
      dirty = false
      updateRings()
      renderer.render(scene, camera)
      updateTag()
    }
    loop()

    return () => {
      cancelAnimationFrame(raf)
      unsub(); ro.disconnect()
      dom.removeEventListener('pointerdown', onDown)
      dom.removeEventListener('pointerup', onUp)
      dom.removeEventListener('pointercancel', onCancel)
      dom.removeEventListener('pointermove', onMove); cancelAnimationFrame(hoverRaf)
      if (grab?.on) store.getState().endGesture()
      if (walking) cancelDrag()
      el.removeEventListener('keydown', onKey)
      for (const e of entries.values()) disposeEntry(e)
      for (const o of overlays.values()) disposeObj(o.rig.root)
      disposeObj(grid); if (stageG) { scene.remove(stageG); disposeStage(stageG) }; disposeObj(axisRings); disposeObj(viewRing)
      tc.dispose(); orbit.dispose()
      // dispose() alone keeps the WebGL context alive until GC; release it now so opening/closing
      // preview panes never hits the browser's context limit (which kills the oldest pane's context)
      renderer.forceContextLoss(); renderer.dispose()
      el.removeChild(dom); el.removeChild(tag)
      if (import.meta.env.DEV) {
        const w = window as any
        if (w.__stages?.[hookKey] === hook) delete w.__stages[hookKey]
        if (w.__stage === hook) delete w.__stage
      }
    }
  }, [cid, lo, hi, itemId, span])

  return (
    <>
      <div ref={host} tabIndex={0} style={{ width: '100%', height: '100%', outline: 'none', position: 'relative' }} />
      <div className="pv-tools">
        <button className="pv-btn" aria-pressed={follow} onClick={() => setFollow(f => !f)}>로봇 따라가기</button>
        <button className="pv-btn" aria-pressed={stageOn} onClick={() => main ? getEditor().getState().setStageShown(!stageOn) : setStageLocal(v => !v)} title="무대와 객석 방향을 보여 줍니다">무대</button>
        {main && seqView && <button className="pv-btn" aria-pressed={walk} onClick={() => { if (!walk) { loadTemplate('rotate').catch(() => {}); loadTemplate('move').catch(() => {}) } getEditor().getState().setWalkMode(!walk) }} title="GO2를 끌어 놓은 곳까지 걷는 클립을 트랙 끝에 붙입니다">배치 이동</button>}
        {walkMsg && <span className="pv-msg" role="status">{walkMsg}</span>}
        {cid && <button className="pv-btn" aria-pressed={trail} onClick={() => setTrail(v => !v)} title="로봇 골반이 지나간 바닥 경로를 선으로 보여 줍니다">경로 표시</button>}
        {children}
      </div>
    </>
  )
}
