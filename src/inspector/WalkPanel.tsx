// 걷기 블록 설정 칸 (§20): the 라이브러리's 걷기 (가상) add panel and the inspector of a selected 걷기 piece share these fields —
// 도착 위치 (무대 기준), 방향, 시간 ⇄ 속도, 시간에 비해 거리가 짧을 때 — and the walk's state (초록 / 주황 / 빨강 with the reasons).
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { getEditor, trackLocked, useEditor } from '../store/store'
import { walkOf, walkPreview } from '../model/itemClip'
import { bridgeFor, standBridgeAfter } from '../model/bridge'
import { sortedItems } from '../model/sequence'
import { describeTo, type WalkFace, type WalkReport, type WalkSlow, type WalkSpec } from '../model/walk'
import { applyXf } from '../model/sequence'
import type { Item } from '../model/types'

const FACES: [WalkFace, string][] = [['travel', '진행 방향'], ['keep', '방향 유지'], ['audience', '객석 보기']]
const SLOWS: [WalkSlow, string][] = [['walk', '천천히 계속 걷기'], ['after', '걷고 나서 서 있기'], ['before', '서 있다가 걷기']]
const TONE: Record<WalkReport['tone'], string> = { ok: '정상', warn: '주의', bad: '한계 초과' }
export const WALK_DEFAULT_FRAMES = 120

/** A number box that commits on blur / Enter (an empty box commits `undefined` when `optional`). */
function Num({ label, value, unit, step, onCommit, disabled, optional, placeholder }: { label: string; value: number | undefined; unit: string; step: number
  onCommit: (v: number | undefined) => void; disabled?: boolean; optional?: boolean; placeholder?: string }) {
  return (
    <span className="insp-unit wk-num"><input type="number" aria-label={label} step={step} disabled={disabled} placeholder={placeholder}
      key={value === undefined ? 'none' : value.toFixed(4)} defaultValue={value === undefined ? '' : +value.toFixed(3)}
      onBlur={e => { const v = e.target.value.trim() === '' ? undefined : e.target.valueAsNumber; if (v === undefined ? optional : Number.isFinite(v)) onCommit(v) }}
      onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur() }} /><i>{unit}</i></span>
  )
}

/** The fields. `spec` + `frames` are the values shown; `start` (stage) is where the walk starts (for the distance and the speed). */
export function WalkFields({ pickKey, spec, frames, start, dist, report, onSpec, onFrames, disabled, fix }: { pickKey: string; spec: WalkSpec; frames: number
  start: Parameters<typeof describeTo>[0] | null; dist: number; report: WalkReport | null; disabled?: boolean
  onSpec: (patch: Partial<WalkSpec>) => void; onFrames: (frames: number) => void; fix?: ReactNode /* 해결 버튼 under the state */ }) {
  const secs = frames / 60, speed = dist / Math.max(secs, 1e-6)
  // 무대에서 찍기 (§21): the next click on the main stage's floor sets 도착 위치 (the latest onSpec, through a ref)
  const picking = useEditor(s => s.walkPick?.key === pickKey)
  const onSpecRef = useRef(onSpec)
  onSpecRef.current = onSpec
  const from: [number, number] | null = start ? [start.rootPos[0], start.rootPos[1]] : null
  const pick = () => getEditor().getState().setWalkPick(picking || !from ? null : { key: pickKey, from, apply: to => onSpecRef.current({ to }) })
  const off = disabled || !from
  useEffect(() => { if (off && picking) getEditor().getState().setWalkPick(null) }, [off, picking])
  useEffect(() => () => { const s = getEditor().getState(); if (s.walkPick?.key === pickKey) s.setWalkPick(null) }, [pickKey]) // panel closed
  return (
    <div className="wk">
      <div className="insp-field"><span className="insp-lab">도착 위치 (무대 기준)
        <button type="button" className="wk-pick" aria-pressed={picking} disabled={off} onClick={pick}
          title="무대 바닥을 클릭해 도착 위치를 정합니다 (Esc · 우클릭: 취소)">{picking ? '찍는 중… (Esc 취소)' : '무대에서 찍기'}</button></span>
        <div className="wk-row">
          <span className="wk-dim" aria-hidden="true">X</span>
          <Num label="도착 X" value={spec.to[0]} unit="m" step={0.05} disabled={disabled} onCommit={v => onSpec({ to: [v!, spec.to[1]] })} />
          <span className="wk-dim" aria-hidden="true">Y</span>
          <Num label="도착 Y" value={spec.to[1]} unit="m" step={0.05} disabled={disabled} onCommit={v => onSpec({ to: [spec.to[0], v!] })} />
        </div>
        {start && <span className="wk-dim" role="note">{describeTo(start, spec.to)}</span>}
      </div>
      <div className="insp-field"><span className="insp-lab">방향</span>
        <div className="wk-seg" role="group" aria-label="방향">
          {FACES.map(([f, lab]) => <button key={f} type="button" aria-pressed={spec.face === f} disabled={disabled} className={spec.face === f ? 'on' : ''}
            onClick={() => onSpec({ face: f })}>{lab}</button>)}
        </div>
        {spec.face === 'travel' && <label className="insp-field"><span className="insp-lab">도착 방향 <span>비우면 걸어온 방향</span></span>
          <Num label="도착 방향" value={spec.yaw === undefined ? undefined : spec.yaw * 180 / Math.PI} unit="°" step={5} optional placeholder="진행 방향" disabled={disabled}
            onCommit={v => onSpec({ yaw: v === undefined ? undefined : v * Math.PI / 180 })} /></label>}
      </div>
      <div className="insp-field"><span className="insp-lab">시간 / 속도</span>
        <div className="wk-row">
          <Num label="시간" value={secs} unit="초" step={0.1} disabled={disabled} onCommit={v => onFrames(Math.round(v! * 60))} />
          <span className="wk-dim" aria-hidden="true">⇄</span>
          <Num label="속도" value={speed} unit="m/s" step={0.05} disabled={disabled || dist < 0.01} onCommit={v => { if (v! > 0) onFrames(Math.round(dist / v! * 60)) }} />
        </div>
      </div>
      <label className="insp-field"><span className="insp-lab">시간에 비해 거리가 짧을 때</span>
        <select aria-label="시간에 비해 거리가 짧을 때" value={spec.slow ?? 'walk'} disabled={disabled} onChange={e => onSpec({ slow: e.target.value as WalkSlow })}>
          {SLOWS.map(([v, lab]) => <option key={v} value={v}>{lab}</option>)}
        </select>
      </label>
      {report && <WalkState report={report}>{fix}</WalkState>}
    </div>
  )
}

export function WalkState({ report, children }: { report: WalkReport; children?: ReactNode }) {
  return (
    <div className="wk-state" role="status">
      <div><span className={`wk-tone ${report.tone}`}>● {TONE[report.tone]}</span>{' '}
        <span className="wk-dim">평균 {report.speed.toFixed(2)} m/s · {report.halfSteps}걸음 · 한 걸음 {(report.stride * 100).toFixed(0)} cm · 관절 속도 {report.vel.toFixed(2)}배</span></div>
      {report.reasons.map((r, i) => <div key={i} className={`wk-why ${r.tone}`}>{r.text}</div>)}
      {report.slowFix && <div className="wk-dim">→ {report.slowFix}</div>}
      {report.held ? <div className="wk-why bad">자세가 무너지지 않게 걷지 않고 출발 자세로 서 있습니다 · 고치기 전에는 내보내지 않습니다</div>
        : report.tone === 'bad' && <div className="wk-dim">한계 초과 — 이대로는 만들지 않습니다 (시간은 자동으로 늘리지 않음)</div>}
      {children && <div className="wk-fix">{children}</div>}
    </div>
  )
}

const sec = (f: number) => (f / 60).toFixed(1)
type Refused = { patch: Partial<WalkSpec> & { frames?: number }; report: WalkReport; minFrames: number | null }

/** Inspector: the selected 걷기 piece. An edit that would leave it (or another walk of the track) 한계 초과 is not applied (§22):
 * the reasons and 해결 버튼 show instead — 최소 시간으로 (the pieces after it move back; only when pressed), 기본서기 경유 넣기. */
export function WalkInspector({ item }: { item: Item }) {
  const project = useEditor(s => s.project), defs = useEditor(s => s.defs)
  const track = project.sequence.tracks.find(t => t.items.some(i => i.id === item.id)), actor = project.actors.find(a => a.id === track?.actorId)
  const w = walkOf(project, defs, item)
  const [msg, setMsg] = useState('')
  const [refused, setRefused] = useState<Refused | null>(null)
  const [rev, setRev] = useState(0) // a refused value typed in a box: the boxes show the piece's values again
  if (!w || !actor) return null
  const start = applyXf(w.start, actor.placement), locked = trackLocked(project, actor.id)
  const dist = Math.hypot(item.walk!.to[0] - start.rootPos[0], item.walk!.to[1] - start.rootPos[1])
  const act = getEditor().getState(), len = item.trimOut - item.trimIn
  const moved = (d: number) => d ? ` · 뒤 조각이 ${sec(Math.abs(d))}초 ${d > 0 ? '밀렸습니다' : '당겨졌습니다'}` : ''
  const apply = (patch: Refused['patch'], done = '') => {
    if (act.setWalk(item.id, patch)) { setRefused(null); setMsg(done + (patch.frames !== undefined ? moved(patch.frames - len) : '')); return }
    const pv = act.previewWalk(item.id, patch)
    setRev(r => r + 1)
    if (pv && pv.report.tone === 'bad') { setRefused({ patch, ...pv }); setMsg('') }
    else setMsg(pv ? '다른 걷기 조각이 한계 초과가 되어 적용하지 않았습니다' : locked ? '잠긴 트랙입니다' : '바꿀 수 없습니다')
  }
  // already 한계 초과 (held — another piece changed, or a file opened): the ways out
  const now = w.report.tone === 'bad' && !locked ? act.previewWalk(item.id, {}) : null
  const stand = w.report.startBad && !locked ? bridgeFor(project, defs, item.id, 'stand') : null
  const standBtn = stand && 'clip' in stand ? <button onClick={() => { if (act.insertBridge(item.id, stand.clip)) setMsg(`기본서기 경유 ${sec(stand.clip.length)}초를 넣었습니다${moved(stand.clip.length)}`) }}
    title="앞 조각 끝 자세에서 기본서기로 서는 전이 조각을 이 걷기 앞에 넣습니다 (시간이 늘어남, 실행취소 한 번)">기본서기 경유 넣기 — 뒤 조각 {sec(stand.clip.length)}초 밀림</button> : null
  const minBtn = (n: number | null | undefined, patch: Refused['patch'] = {}) => n ? <button onClick={() => apply({ ...patch, frames: n })}
    title="한계 안에 드는 가장 짧은 시간으로 바꿉니다 (0.1초 단위, 실행취소 한 번)">최소 시간 {sec(n)}초로{Object.keys(patch).some(k => k !== 'frames') ? ' 하고 적용' : ''} — 뒤 조각 {sec(Math.abs(n - len))}초 {n >= len ? '밀림' : '당겨짐'}</button> : null
  return (
    <section className="insp-sec">
      <h3 className="insp-sec-t">걷기 조각</h3>
      <WalkFields key={rev} pickKey={item.id} spec={item.walk!} frames={len} start={start} dist={dist} report={w.report} disabled={locked}
        fix={w.report.tone === 'bad' && (minBtn(now?.minFrames) || standBtn) ? <>{minBtn(now?.minFrames)}{standBtn}</> : null}
        onSpec={patch => apply(patch)} onFrames={n => apply({ frames: n })} />
      {refused && <div className="wk-refused" role="alert">
        <b>적용하지 않았습니다 — 한계 초과가 됩니다</b>
        {refused.report.reasons.filter(r => r.tone === 'bad').map((r, i) => <div key={i} className="wk-why bad">{r.text}</div>)}
        <div className="wk-fix">
          {minBtn(refused.minFrames, refused.patch)}
          {refused.report.startBad && standBtn}
          <button onClick={() => setRefused(null)}>닫기</button>
        </div>
      </div>}
      <ul className="wk-notes">
        <li>첫 걸음: 앞 조각 끝의 발 위치에서 출발</li>
        <li>마지막 걸음: 다음 조각 첫 자세의 발 위치에 딛음 (없거나 서 있지 않으면 기본서기)</li>
        <li>앞 조각이 바뀌어도 도착점은 그대로 — 뒤 조각 위치 유지</li>
        <li>걷기는 순수 이동 — 관절 수정·자르기 없음 (길이는 막대 끝을 끌어서)</li>
        <li>한계를 넘는 걷기는 만들지 않음 — 시간은 버튼을 눌렀을 때만 늘어남</li>
      </ul>
      {locked && <p className="insp-hint" role="status">잠긴 트랙입니다</p>}
      {msg && <p className="insp-hint" role="status">{msg}</p>}
    </section>
  )
}

/** 라이브러리 › 걷기 (가상): a new 걷기 piece at the end of `actorId`'s track (null = a new GO2 robot). */
export function WalkAddPanel({ actorId, onAdded }: { actorId: string | null; onAdded: (actorId: string, text: string) => void }) {
  const project = useEditor(s => s.project), defs = useEditor(s => s.defs)
  const locked = !!actorId && trackLocked(project, actorId)
  const [spec, setSpec] = useState<WalkSpec | null>(null), [frames, setFrames] = useState(WALK_DEFAULT_FRAMES)
  // until something is typed: 1 m ahead of where the robot will be
  const base = walkPreview(project, defs, actorId, { to: [0, 0], face: 'keep' }, frames)
  if (!base) return null
  const h = Math.atan2(2 * (base.start.rootQuat[3] * base.start.rootQuat[2] + base.start.rootQuat[0] * base.start.rootQuat[1]), 1 - 2 * (base.start.rootQuat[1] ** 2 + base.start.rootQuat[2] ** 2))
  const cur: WalkSpec = spec ?? { to: [+(base.start.rootPos[0] + Math.cos(h)).toFixed(2), +(base.start.rootPos[1] + Math.sin(h)).toFixed(2)], face: 'keep' }
  // the track ends in a pose it cannot walk off from (앉기 …): 기본서기 경유 goes in first — only with the button that says so (§22)
  const track = actorId ? project.sequence.tracks.find(t => t.kind === 'motion' && t.actorId === actorId) : undefined
  const last = track && sortedItems(track).at(-1)
  const pv0 = walkPreview(project, defs, actorId, cur, frames)!
  const via = !!pv0.report.startBad && !!last
  const pv = via ? walkPreview(project, defs, actorId, cur, frames, true)! : pv0
  const bridge = via ? standBridgeAfter(project, defs, last!) : null, bridgeClip = bridge && 'clip' in bridge ? bridge.clip : null
  const bad = pv.report.tone === 'bad' || (via && !bridgeClip)
  const dist = Math.hypot(cur.to[0] - pv.start.rootPos[0], cur.to[1] - pv.start.rootPos[1])
  const add = () => {
    if (bad) return
    const st = getEditor().getState(), id = st.addWalk(actorId, cur, frames, bridgeClip ?? undefined)
    if (!id) return
    const a = getEditor().getState().project.sequence.tracks.find(t => t.items.some(i => i.id === id))?.actorId
    if (a) onAdded(a, `걷기를 추가했습니다 (${dist.toFixed(2)} m · ${(frames / 60).toFixed(1)}초${bridgeClip ? ` · 앞에 기본서기 경유 ${sec(bridgeClip.length)}초` : ''})`)
  }
  return (
    <>
      <h3 className="pp-blk-t">걷기 (가상)</h3>
      <WalkFields pickKey="add" spec={cur} frames={frames} start={pv.start} dist={dist} report={pv.report} disabled={locked}
        fix={pv.report.tone === 'bad' && pv.minFrames ? <button onClick={() => setFrames(pv.minFrames!)} title="한계 안에 드는 가장 짧은 시간 (0.1초 단위)">최소 시간 {sec(pv.minFrames)}초로</button> : null}
        onSpec={patch => setSpec(s => ({ ...(s ?? cur), ...patch }))} onFrames={n => { if (n >= 2) setFrames(n) }} />
      {via && <p className="pp-dim pp-why wk-via" role="note">{bridgeClip ? `앞 조각이 서 있지 않은 자세로 끝납니다 → 기본서기 경유 ${sec(bridgeClip.length)}초를 먼저 넣고 걷기를 붙입니다 (시간이 늘어남)`
        : '앞 조각이 서 있지 않은 자세로 끝나고, 기본서기 경유도 만들 수 없어 걷기를 붙일 수 없습니다'}</p>}
      <p className="pp-dim pp-why">트랙 끝에 붙습니다. 걸음은 계산으로 만들고(트로트), 다음에 붙는 조각의 첫 자세로 끝납니다. 한계를 넘는 걷기는 만들지 않습니다.</p>
      <div className="pp-tools"><span className="pp-gap" /><button disabled={locked || bad} onClick={add}
        title={bad ? '한계 초과라 추가할 수 없습니다 — 위의 이유와 해결 버튼을 보세요' : undefined}>{bridgeClip ? '기본서기 경유 넣고 추가' : '추가'}</button></div>
    </>
  )
}
