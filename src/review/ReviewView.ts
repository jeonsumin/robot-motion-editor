// 검수 목록's own small 3D view (수정변동사항.md §12): the frame being checked plus the frame before it as an orange ghost.
// Separate from the main Stage on purpose (nothing there changes); renders only when something changes; dispose() frees the
// WebGL context when the window closes.
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import type { Pose } from '../model/pose'
import type { RobotDef } from '../robot/types'
import { buildRobot, type RobotRig } from '../viewer/buildRobot'

export type ReviewAngle = '3/4' | '정면' | '측면'
export const GHOST = '#FF9628' // 직전 프레임
export const HIT = '#E5484D' // 자가충돌: 겹친 부위 (--warn)
export const FIX = '#3FB950' // 발 미끄러짐 추천대로 고치기 (§17): the fixed leg, the recommended foot place
const INSET = 200, INSET_GAP = 8 // px: the 위에서 본 발 view in the corner
/** 발 미끄러짐 개선 가이드 (§17): what to draw for one frame. */
export interface FootGuide { foot: string; fixed: Pose; now: Pose; path: [number, number][]; floor: number }
const GHOST_OPACITY = 0.45
// camera direction in the robot's heading frame (x = facing, y = its left, z = up)
const DIRS: Record<ReviewAngle, [number, number, number]> = { '3/4': [1, -0.75, 0.35], 정면: [1, 0, 0.12], 측면: [0, -1, 0.12] }
const DIST = 2.6

function grid(): THREE.LineSegments {
  const pts: number[] = [], E = 4
  for (let i = -E * 2; i <= E * 2; i++) { const v = i / 2; pts.push(v, -E, 0, v, E, 0, -E, v, 0, E, v, 0) }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3))
  return new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: '#3B424D' }))
}

export class ReviewView {
  private renderer: THREE.WebGLRenderer
  private scene = new THREE.Scene()
  private camera = new THREE.PerspectiveCamera(40, 1, 0.05, 50)
  private orbit: OrbitControls
  private rig: RobotRig | null = null
  private ghost: RobotRig | null = null
  private def: RobotDef | null = null
  private color = ''
  private lit: THREE.MeshStandardMaterial[] = [] // 자가충돌: materials painted red (§14)
  private fix: RobotRig | null = null // §17: the fixed leg (green), built per robot
  private fixDef: RobotDef | null = null
  private marks = new THREE.Group() // §17: the recommended foot, the foot now, the slide path — on layer 1 (the corner view sees only it)
  private insetCam = new THREE.PerspectiveCamera(40, 1, 0.02, 10)
  private inset = false
  private ro: ResizeObserver
  private raf = 0
  private target = new THREE.Vector3()

  constructor(private el: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true })
    this.renderer.setPixelRatio(window.devicePixelRatio)
    el.appendChild(this.renderer.domElement)
    this.scene.background = new THREE.Color('#22262D')
    const hemi = new THREE.HemisphereLight(0xffffff, 0x4a505c, 1.4); hemi.position.set(0, 0, 1)
    const sun = new THREE.DirectionalLight(0xffffff, 1.6); sun.position.set(2, -3, 4)
    this.scene.add(grid(), hemi, sun, this.marks)
    this.camera.up.set(0, 0, 1)
    this.camera.layers.enable(1); this.insetCam.layers.set(1)
    this.orbit = new OrbitControls(this.camera, this.renderer.domElement)
    this.orbit.addEventListener('change', () => this.draw())
    this.ro = new ResizeObserver(() => this.resize())
    this.ro.observe(el)
    this.resize()
  }

  private resize() {
    const w = this.el.clientWidth, h = this.el.clientHeight
    if (!w || !h) return
    this.renderer.setSize(w, h, false)
    this.renderer.domElement.style.width = '100%'; this.renderer.domElement.style.height = '100%'
    this.camera.aspect = w / h; this.camera.updateProjectionMatrix()
    this.draw()
  }

  /** Coalesce changes into one render on the next animation frame. */
  draw() {
    if (this.raf) return
    this.raf = requestAnimationFrame(() => {
      this.raf = 0
      this.renderer.render(this.scene, this.camera)
      if (!this.inset) return
      const w = this.el.clientWidth // the corner view (위에서 본 발, §17): same scene, its marks only
      if (w < INSET * 2) return
      this.renderer.setScissorTest(true)
      this.renderer.setViewport(w - INSET - INSET_GAP, INSET_GAP, INSET, INSET); this.renderer.setScissor(w - INSET - INSET_GAP, INSET_GAP, INSET, INSET)
      this.renderer.render(this.scene, this.insetCam)
      this.renderer.setScissorTest(false); this.renderer.setViewport(0, 0, w, this.el.clientHeight)
    })
  }

  /** §17: the fixed leg (`links`) in green at `pose`, or none. */
  preview(def: RobotDef, pose: Pose | null, links: string[]) {
    if (def !== this.fixDef) {
      if (this.fix) { this.scene.remove(this.fix.root); dispose(this.fix.root) }
      this.fixDef = def; this.fix = buildRobot(def, FIX); this.fix.setGhost(true)
      this.fix.root.traverse(o => { const m = (o as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined; if (m) m.opacity = 0.55 })
      this.scene.add(this.fix.root)
    }
    const want = new Set(links)
    this.fix!.root.visible = !!pose
    if (pose) {
      this.fix!.applyPose(pose)
      this.fix!.root.traverse(o => { if ((o as THREE.Mesh).isMesh) o.visible = want.has(o.parent?.name ?? '') })
    }
    this.draw()
  }

  /** §17: the 개선 가이드 marks of one frame (and the corner view above the foot), or none. */
  guide(g: FootGuide | null, def: RobotDef | null) {
    for (const o of [...this.marks.children]) { this.marks.remove(o); o.traverse(c => { const m = c as THREE.Mesh; if (m.isMesh) { (m.material as THREE.Material).dispose(); if (m.userData.own) m.geometry.dispose() } }) }
    this.inset = !!g && !!def
    if (!g || !def) { this.draw(); return }
    if (def !== this.fixDef) this.preview(def, null, []) // the green rig, built once per robot
    this.fix!.applyPose(g.fixed); this.rig?.applyPose(g.now) // (the main rig shows `now` already)
    const foot = (rig: RobotRig | null, color: string) => { // copies of that foot's meshes (shared geometry), flat-coloured, in place
      const out: THREE.Mesh[] = []
      rig?.root.getObjectByName(g.foot)?.children.forEach(c => { const m = c as THREE.Mesh; if (m.isMesh) { const k = new THREE.Mesh(m.geometry, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.6 })); k.applyMatrix4(m.matrixWorld); out.push(k) } })
      return out
    }
    const add = (o: THREE.Object3D) => { o.traverse(c => c.layers.set(1)); this.marks.add(o) }
    for (const m of foot(this.fix, FIX)) add(m)
    // the foot now: its outline over the floor (a filled copy over the green one blotches where they overlap)
    const pts: [number, number][] = [], v = new THREE.Vector3()
    this.rig?.root.getObjectByName(g.foot)?.children.forEach(c => {
      const m = c as THREE.Mesh, pos = m.isMesh ? m.geometry.getAttribute('position') : null
      if (!pos) return
      const step = Math.max(1, Math.floor(pos.count / 1500))
      for (let i = 0; i < pos.count; i += step) { v.fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld); pts.push([v.x, v.y]) }
    })
    const ring = hull2(pts)
    if (ring.length > 2) {
      const loop = ring.map(([x, y]) => new THREE.Vector3(x, y, g.floor + 0.004))
      const line = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(loop, true, 'catmullrom', 0), loop.length * 4, 0.0025, 5, true), new THREE.MeshBasicMaterial({ color: HIT, depthTest: false }))
      line.renderOrder = 2; line.userData.own = true; add(line)
    }
    if (g.path.length > 1) {
      const pts = g.path.map(([x, y]) => new THREE.Vector3(x, y, g.floor + 0.003))
      const tube = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), Math.max(8, pts.length * 2), 0.003, 6), new THREE.MeshBasicMaterial({ color: HIT }))
      tube.userData.own = true; add(tube)
    }
    // the corner camera: straight down over the two feet, the robot's facing up
    const box = new THREE.Box3().setFromObject(this.marks), c = box.getCenter(new THREE.Vector3())
    const [x, y, z, w] = g.now.rootQuat, yaw = Math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z))
    this.insetCam.position.set(c.x, c.y, g.floor + 0.62); this.insetCam.up.set(Math.cos(yaw), Math.sin(yaw), 0); this.insetCam.lookAt(c.x, c.y, g.floor)
    this.draw()
  }

  private dropRigs() {
    for (const r of [this.rig, this.ghost]) if (r) { this.scene.remove(r.root); dispose(r.root) }
    this.rig = this.ghost = null
  }

  /** Show `pose` (and `prev` as the ghost, or none). Rebuilds the robots when the robot type changes. */
  show(def: RobotDef, color: string, pose: Pose, prev: Pose | null) {
    if (def !== this.def) {
      this.dropRigs(); this.def = def; this.color = color; this.lit = []
      this.rig = buildRobot(def, color)
      this.ghost = buildRobot(def, GHOST); this.ghost.setGhost(true)
      this.ghost.root.traverse(o => { const m = (o as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined; if (m) m.opacity = GHOST_OPACITY })
      this.scene.add(this.rig.root, this.ghost.root)
    }
    this.rig!.applyPose(pose)
    this.ghost!.root.visible = !!prev
    if (prev) this.ghost!.applyPose(prev)
    this.draw()
  }

  /** 자가충돌 (§14): paint these links (their own meshes, not their children) red; [] = none. */
  highlight(links: string[]) {
    for (const m of this.lit) m.color.set(this.color)
    this.lit = []
    if (!this.rig) return
    const want = new Set(links)
    this.rig.root.traverse(o => {
      if (!want.has(o.name)) return
      for (const c of o.children) { const m = (c as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined; if ((c as THREE.Mesh).isMesh && m) { m.color.set(HIT); this.lit.push(m) } }
    })
    this.draw()
  }

  /** Point the camera at the robot from `angle`, relative to the facing of `pose` (orbiting with the mouse still works). */
  aim(pose: Pose, angle: ReviewAngle) {
    const [x, y, z, w] = pose.rootQuat
    const yaw = Math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z))
    const [a, b, c] = DIRS[angle], cy = Math.cos(yaw), sy = Math.sin(yaw)
    const d = new THREE.Vector3(a * cy - b * sy, a * sy + b * cy, c).normalize().multiplyScalar(DIST)
    this.target.set(pose.rootPos[0], pose.rootPos[1], Math.max(pose.rootPos[2] - 0.05, 0.3))
    this.orbit.target.copy(this.target)
    this.camera.position.copy(this.target).add(d)
    this.orbit.update()
    this.draw()
  }

  dispose() {
    cancelAnimationFrame(this.raf)
    this.ro.disconnect()
    this.orbit.dispose()
    this.dropRigs()
    this.guide(null, null)
    if (this.fix) { this.scene.remove(this.fix.root); dispose(this.fix.root); this.fix = null }
    this.scene.traverse(o => dispose(o))
    this.renderer.dispose()
    this.renderer.forceContextLoss()
    this.renderer.domElement.remove()
  }
}

/** Convex hull of 2D points (monotone chain), counter-clockwise. */
function hull2(p: [number, number][]): [number, number][] {
  const a = [...p].sort((u, w) => u[0] - w[0] || u[1] - w[1]), cross = (o: number[], u: number[], w: number[]) => (u[0] - o[0]) * (w[1] - o[1]) - (u[1] - o[1]) * (w[0] - o[0])
  const lo: [number, number][] = [], hi: [number, number][] = []
  for (const q of a) { while (lo.length > 1 && cross(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q) }
  for (const q of a.reverse()) { while (hi.length > 1 && cross(hi[hi.length - 2], hi[hi.length - 1], q) <= 0) hi.pop(); hi.push(q) }
  return [...lo.slice(0, -1), ...hi.slice(0, -1)]
}

function dispose(o: THREE.Object3D) {
  o.traverse(c => {
    const m = c as THREE.Mesh
    m.geometry?.dispose()
    for (const x of [m.material].flat()) (x as THREE.Material | undefined)?.dispose()
  })
}
