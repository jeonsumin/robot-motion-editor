import type { RobotDefs } from './evaluate'
import { validTrack } from './sequence'
import type { Curve, Media, Project } from './types'
import { validVideoTrack } from './video'

const INTERP = ['linear', 'bezier', 'hold'] as const
const ROOT_CH = ['root.x', 'root.y', 'root.z', 'root.roll', 'root.pitch', 'root.yaw']
const r6 = (x: number) => Math.round(x * 1e6) / 1e6 + 0 // +0 turns -0 into 0

// v2: each curve is { k: [f, v, interp, inDf, inDv, outDf, outDv, ...] }, reals rounded to 6 decimals, no indentation.
// Clip channels, clips' 수정 층 and items' 수정 층 (offset) use the same encoding.
const packCurves = (chs: Record<string, Curve>) => Object.fromEntries(Object.entries(chs).map(([ch, cv]) => [ch, {
  k: cv.keys.flatMap(k => [k.f, r6(k.v), INTERP.indexOf(k.interp), r6(k.inTan.df), r6(k.inTan.dv), r6(k.outTan.df), r6(k.outTan.dv)]),
}]))
// project files are saved as <title>.mproj; older *.motion.json (and plain .json) still open and save under the new name
import { REVIEW_KINDS } from './review'

export const PROJECT_EXT = '.mproj'
export const projectFileName = (name: string) => name.replace(/(\.mproj|(\.motion)?\.json)$/i, '') + PROJECT_EXT

export const serializeProject = (p: Project): string => JSON.stringify({
  ...p, version: 2,
  clips: Object.fromEntries(Object.entries(p.clips).map(([id, c]) => [id, c.offset ? { ...c, channels: packCurves(c.channels), offset: packCurves(c.offset) } : { ...c, channels: packCurves(c.channels) }])),
  sequence: { ...p.sequence, tracks: p.sequence.tracks.map(t => ({ ...t, items: t.items.map(it => it.offset ? { ...it, offset: packCurves(it.offset) } : it) })) },
})

class Bad extends Error {}
const fail = (path: string, what = '형식이 올바르지 않습니다'): never => { throw new Bad(`${path} ${what}`) }
const isObj = (v: unknown): v is Record<string, any> => typeof v === 'object' && v !== null && !Array.isArray(v)
const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v)
const int = (v: unknown) => Number.isInteger(v)
const str = (v: unknown) => typeof v === 'string'

// Returns the project (extra fields kept) or throws Error with a Korean message naming the first problem.
export function parseProject(text: string, defs: RobotDefs): Project {
  let p: any
  try { p = JSON.parse(text) } catch { throw new Error('프로젝트 파일을 읽을 수 없습니다') }
  if (!isObj(p)) throw new Error('프로젝트 파일을 읽을 수 없습니다')
  try {
    if (p.version !== 1 && p.version !== 2) throw new Bad(`지원하지 않는 버전입니다: ${p.version}`)
    if (p.fps !== 60) throw new Bad(`fps는 60이어야 합니다: ${p.fps}`)
    const robot = (v: unknown, path: string) => { if (!str(v) || !Object.hasOwn(defs, v)) fail(path, '로봇 종류를 알 수 없습니다') }
    const tan = (t: any, path: string) => { if (!isObj(t) || !num(t.df) || !num(t.dv)) fail(path) }

    if (!Array.isArray(p.actors)) fail('actors')
    const actorIds = new Set<string>(), actorRobot: Record<string, string> = {}, itemIds = new Set<string>(), motionActors = new Set<string>()
    p.actors.forEach((a: any, i: number) => {
      const at = `actors.${i}`
      if (!isObj(a) || !str(a.id) || !str(a.name) || !str(a.color)) fail(at)
      robot(a.robot, `${at}.robot`)
      if (!isObj(a.placement) || !num(a.placement.x) || !num(a.placement.y) || !num(a.placement.yaw)) fail(`${at}.placement`)
      if (actorIds.has(a.id)) fail(`${at}.id`, '중복된 ID입니다')
      actorIds.add(a.id); actorRobot[a.id] = a.robot
    })

    // Bins (virtual folders): a bad bin on an item is dropped below, never rejected.
    const binTab = new Map<string, string>()
    if (p.bins !== undefined) {
      if (!Array.isArray(p.bins)) fail('bins')
      p.bins.forEach((b: any, i: number) => {
        const at = `bins.${i}`
        if (!isObj(b) || !str(b.id) || !str(b.name) || !(['clip', 'media'] as unknown[]).includes(b.tab)) fail(at)
        if (binTab.has(b.id)) fail(`${at}.id`, '중복된 ID입니다')
        binTab.set(b.id, b.tab)
      })
    }

    if (!isObj(p.clips)) fail('clips')
    for (const [id, c] of Object.entries<any>(p.clips)) {
      const at = `clips.${id}`
      if (!isObj(c) || c.id !== id || !str(c.name)) fail(at)
      robot(c.robot, `${at}.robot`)
      if (!int(c.length) || c.length < 1) fail(`${at}.length`)
      if (!isObj(c.channels)) fail(`${at}.channels`)
      curves(c.channels, `${at}.channels`, c.robot, true)
      if (c.offset !== undefined) { if (!isObj(c.offset)) fail(`${at}.offset`); curves(c.offset, `${at}.offset`, c.robot, false) }
      if (c.bin !== undefined && binTab.get(c.bin) !== 'clip') delete c.bin
      if (c.hold !== undefined && c.hold !== true) delete c.hold
    }

    // Expands v2 { k } into { keys } in place and checks the keys. clampJoints: r6 rounding must not push a clip key past its
    // URDF limit (off for 수정 층 deltas, which must also name a joint or root channel of the robot).
    function curves(chs: Record<string, any>, at: string, rb: keyof RobotDefs, clampJoints: boolean) {
      for (const [ch, cv0] of Object.entries<any>(chs)) {
        let cv = cv0
        const jd = defs[rb].joints.find((j: { name: string }) => j.name === ch)
        if (!clampJoints && !jd && !ROOT_CH.includes(ch)) fail(`${at}.${ch}`, '채널 이름을 알 수 없습니다')
        const clampJ = (v: number) => jd && clampJoints ? Math.min(Math.max(v, jd.lower), jd.upper) : v
        if (p.version === 2) { // expand { k } into { keys } so v1 and v2 share the key checks below
          const kp = `${at}.${ch}.k`
          if (!isObj(cv0) || !Array.isArray(cv0.k) || cv0.k.length % 7 !== 0 || !cv0.k.every(num)) fail(kp)
          const keys: any[] = []
          for (let i = 0; i < cv0.k.length; i += 7) {
            const [f, v, ip, idf, idv, odf, odv] = cv0.k.slice(i, i + 7)
            if (!(ip in INTERP)) fail(`${kp}.${i + 2}`)
            keys.push({ f, v: clampJ(v), interp: INTERP[ip], inTan: { df: idf, dv: idv }, outTan: { df: odf, dv: odv } })
          }
          cv = chs[ch] = { keys }
        }
        if (!isObj(cv) || !Array.isArray(cv.keys)) fail(`${at}.${ch}`)
        cv.keys.forEach((k: any, i: number) => {
          const kt = `${at}.${ch}.keys.${i}`
          if (!isObj(k) || !int(k.f) || !num(k.v)) fail(kt)
          if (i > 0 && k.f <= cv.keys[i - 1].f) fail(`${kt}.f`, '순서가 올바르지 않습니다')
          if (!['linear', 'bezier', 'hold'].includes(k.interp)) fail(`${kt}.interp`)
          tan(k.inTan, `${kt}.inTan`); tan(k.outTan, `${kt}.outTan`)
        })
      }
    }

    if (!Array.isArray(p.media)) fail('media')
    const media: Record<string, Media> = Object.create(null) // no prototype: an id of "__proto__" is just a key
    p.media.forEach((m: any, i: number) => {
      const at = `media.${i}`
      if (!isObj(m) || !str(m.id) || !str(m.name)) fail(at)
      if (!int(m.durationF) || m.durationF < 1) fail(`${at}.durationF`)
      if (Object.hasOwn(media, m.id)) fail(`${at}.id`, '중복된 ID입니다')
      if (m.bin !== undefined && binTab.get(m.bin) !== 'media') delete m.bin
      media[m.id] = m
    })
    let videoTracks = 0
    const s = p.sequence
    if (!isObj(s)) fail('sequence')
    if (!Array.isArray(s.tracks)) fail('sequence.tracks')
    if (!Array.isArray(s.markers) || s.markers.some((m: any) => !isObj(m) || !num(m.f) || !str(m.name))) fail('sequence.markers')
    for (const k of ['inF', 'outF']) if (s[k] !== null && !int(s[k])) fail(`sequence.${k}`)
    s.tracks.forEach((t: any, i: number) => {
      const at = `sequence.tracks.${i}`
      if (!isObj(t) || !str(t.id) || !['video', 'motion'].includes(t.kind) || typeof t.hidden !== 'boolean' || typeof t.locked !== 'boolean') fail(at)
      if (t.trail !== undefined && t.trail !== true) fail(`${at}.trail`)
      if (t.kind === 'video') {
        if (++videoTracks > 1) fail(at, '영상 트랙은 하나만 둘 수 있습니다')
        if (t.actorId !== undefined) fail(`${at}.actorId`, '영상 트랙에는 액터가 없어야 합니다')
      }
      if (t.kind === 'motion' && !actorIds.has(t.actorId)) fail(`${at}.actorId`, '액터가 없습니다')
      if (t.kind === 'motion') { if (motionActors.has(t.actorId)) fail(`${at}.actorId`, '액터의 트랙이 중복됩니다'); motionActors.add(t.actorId) }
      if (!Array.isArray(t.items)) fail(`${at}.items`)
      t.items.forEach((it: any, j: number) => {
        const it_ = `${at}.items.${j}`
        if (!isObj(it) || !str(it.id) || !int(it.start) || !int(it.trimIn) || !int(it.trimOut)) fail(it_)
        if (it.restPose !== undefined && it.restPose !== true && it.restPose !== 'prepend') fail(`${it_}.restPose`)
        if (it.restPose === true) delete it.restPose // 기본자세 덮어쓰기 was removed: an old file opens with it off
        if (it.hidden !== undefined && it.hidden !== true) fail(`${it_}.hidden`)
        if (it.restTail !== undefined && typeof it.restTail !== 'boolean') fail(`${it_}.restTail`)
        if (it.restHold !== undefined && !(int(it.restHold) && it.restHold >= 0)) fail(`${it_}.restHold`)
        if (it.restBlend !== undefined && it.restBlend !== 'auto' && !(int(it.restBlend) && it.restBlend >= 0)) fail(`${it_}.restBlend`)
        if (it.inertia !== undefined && !(int(it.inertia) && it.inertia >= 0)) fail(`${it_}.inertia`)
        for (const k of ['tailHold', 'tailBlend', 'seam']) if (it[k] !== undefined && !(int(it[k]) && it[k] >= 0)) fail(`${it_}.${k}`)
        if (it.step !== undefined && typeof it.step !== 'boolean') fail(`${it_}.step`)
        if (it.walk !== undefined) { // 걷기 (§20)
          const w = it.walk
          if (!isObj(w) || !Array.isArray(w.to) || w.to.length !== 2 || !w.to.every(num) || !['travel', 'keep', 'audience'].includes(w.face)
            || (w.yaw !== undefined && !num(w.yaw)) || (w.slow !== undefined && !['walk', 'after', 'before'].includes(w.slow))) fail(`${it_}.walk`)
          if (t.kind !== 'motion' || it.trimIn !== 0) fail(`${it_}.walk`, '걷기 조각이 올바르지 않습니다')
        }
        if (itemIds.has(it.id)) fail(`${it_}.id`, '중복된 ID입니다')
        itemIds.add(it.id)
        if (t.kind === 'video') {
          if (!str(it.refId) || !Object.hasOwn(media, it.refId)) fail(`${it_}.refId`, '영상이 없습니다')
          if (it.trimOut > media[it.refId].durationF) fail(`${it_}.trimOut`, '영상 길이를 넘습니다')
          return
        }
        if (!str(it.refId) || !Object.hasOwn(p.clips, it.refId)) fail(`${it_}.refId`, '클립이 없습니다')
        if (t.kind === 'motion' && p.clips[it.refId].robot !== actorRobot[t.actorId]) fail(`${it_}.refId`, '클립의 로봇이 액터와 다릅니다')
        if (it.trimOut > p.clips[it.refId].length) fail(`${it_}.trimOut`, '클립 길이를 넘습니다')
        if (it.use !== undefined && it.use !== 'original') fail(`${it_}.use`)
        if (it.offset !== undefined) { if (!isObj(it.offset)) fail(`${it_}.offset`); curves(it.offset, `${it_}.offset`, p.clips[it.refId].robot, false) }
      })
      if (!(t.kind === 'video' ? validVideoTrack(t.items, media) : validTrack(t.items))) fail(at, '항목 배치가 올바르지 않습니다 (겹침 또는 범위)')
    })
  } catch (e) {
    throw e instanceof Bad ? new Error(e.message) : e
  }
  p.version = 2
  if (!isObj(p.physics)) delete p.physics
  if (!(isObj(p.stage) && [p.stage.width, p.stage.depth].every(v => typeof v === 'number' && v >= 1 && v <= 30))) delete p.stage
  if (p.stepSeam !== true) delete p.stepSeam // GO2 발 걸음 이음매 기본값 (§19): optional, anything but true is off
  // 검수 판정 (§13): optional; a bad entry (or one on a clip that is gone) is dropped, never rejects the file
  if (p.review !== undefined) {
    const ok = Array.isArray(p.review) ? p.review.filter((v: any) => isObj(v) && str(v.clipId) && Object.hasOwn(p.clips, v.clipId) && int(v.from) && int(v.to)
      && v.from >= 0 && v.to >= v.from && REVIEW_KINDS.includes(v.kind) && ['bad', 'ok'].includes(v.verdict) && str(v.at)) : []
    if (ok.length) p.review = ok.map((v: any) => ({ clipId: v.clipId, from: v.from, to: v.to, kind: v.kind, verdict: v.verdict, at: v.at, ...(str(v.foot) ? { foot: v.foot } : {}) }))
    else delete p.review
  }
  return p as Project
}
