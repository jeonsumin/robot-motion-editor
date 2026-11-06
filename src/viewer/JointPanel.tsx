import { useEffect, useState } from 'react'
import { groundZ } from '../model/bodyPose'
import { evalCurve } from '../model/curve'
import type { Interp } from '../model/types'
import { baseClip, editedClip } from '../model/itemClip'
import { evaluateClip } from '../model/pose'
import type { RobotDef } from '../robot/types'
import { actorOf, assetOwner, clipLocked, editLock, editTarget, getEditor, keyOwner, targetItem, trackLocked, useEditor, type EditorState } from '../store/store'
import { playRange } from '../transport'

// 관절 패널 (spec 2026-10-19-pose-panel-design.md §2), the inspector's 값 section: the whole robot — 몸통 (무대 위치 · 자세) rows,
// then every part (부위) with one slider row per joint — frame/key tools on the whole pose, 기본 서기로, foot lock, 바닥 밀착, 체중 이동 and
// the 구간 row. Every value edit goes through editPose (setValue per channel, one undo step).

const ROOT_RANGE: Record<string, [number, number]> = {
  'root.x': [-5, 5], 'root.y': [-5, 5], 'root.z': [0, 2],
  'root.roll': [-Math.PI, Math.PI], 'root.pitch': [-Math.PI, Math.PI], 'root.yaw': [-Math.PI, Math.PI],
}
const BODY: [string, string, number][] = [ // channel, label, number step in m (angles: 1° / 0.001 rad)
  ['root.x', '무대 X', 0.01], ['root.y', '무대 Y', 0.01], ['root.yaw', '방향', 0], ['root.z', '높이', 0.005],
  ['root.pitch', '앞뒤 기울기', 0], ['root.roll', '좌우 기울기', 0],
]
const BODY_LABEL = new Map(BODY.map(([c, l]) => [c, l]))
const SHIFT = 0.02 // m per 체중 이동 click (the Go2 Dance Studio's step)
const SHIFTS: [string, number, number][] = [['◀ 왼', 0, 1], ['오른 ▶', 0, -1], ['▲ 앞', 1, 0], ['▼ 뒤', -1, 0]] // label, forward, left
const GO2_PARTS: [string, string][] = [['FR', '오른앞 (FR)'], ['FL', '왼앞 (FL)'], ['RR', '오른뒤 (RR)'], ['RL', '왼뒤 (RL)']]
const GO2_ROW: Record<string, string> = { hip: '고관절', thigh: '허벅지', calf: '무릎' }
const isAngle = (ch: string, joint: boolean) => joint || /roll|pitch|yaw/.test(ch)
const INTERPS: [Interp, string][] = [['linear', '선형'], ['bezier', '이즈'], ['hold', '홀드']]
// A slider drag ends on the next release anywhere: the slider may be disabled or unmounted mid-drag (selection cleared,
// lock), and a gesture left open would merge every later edit into one undo step.
const endOnRelease = () => {
  const end = () => { getEditor().getState().endGesture(); removeEventListener('pointerup', end); removeEventListener('pointercancel', end) }
  addEventListener('pointerup', end); addEventListener('pointercancel', end)
}

const sectionsOf = (def: RobotDef) => def.kind === 'go2'
  ? GO2_PARTS.map(([g, title]) => ({ title, rows: (def.groups.find(x => x.name === g)?.joints ?? []).map(ch => ({ ch, label: GO2_ROW[ch.split('_')[1]] ?? ch })) }))
  : def.groups.map(g => ({ title: g.name, rows: g.joints.map(ch => ({ ch, label: ch.replace(/_joint$/, '') })) }))

/** What the panel edits for the selected actor (channel or not); null when it has nothing editable. */
export function editView(s: EditorState) {
  const actor = actorOf(s, s.sel.actorId)
  if (!actor) return null
  const def = s.defs[actor.robot], t = editTarget(s, actor.id)
  const item = t && targetItem(s, t.itemId)
  if (!t || !item) return null
  const clip = s.project.clips[t.clipId], clipMode = !!s.clipEdit
  const shown = (clipMode ? baseClip(s.project, s.defs, clip.id) : editedClip(s.project, s.defs, item)) ?? clip
  const piece = s.layer === 'piece' && !clipMode, asset = s.layer === 'asset' && clipMode
  const owner = asset ? assetOwner(clip.id) : piece ? item.id : clip.id
  const lockedAll = asset ? false : trackLocked(s.project, actor.id) || clipLocked(s.project, clip.id)
  const pose = evaluateClip(shown, def, t.f)
  const value = (c: string) => {
    const j = def.joints.findIndex(x => x.name === c)
    if (j >= 0) return { joint: true, v: pose.q[j], lo: def.joints[j].lower, hi: def.joints[j].upper }
    const [lo, hi] = ROOT_RANGE[c] ?? [0, 0]
    return { joint: false, v: evalCurve(shown.channels[c] ?? { keys: [] }, t.f, c === 'root.z' ? def.standingHeight : 0), lo, hi }
  }
  return {
    actor, def, f: t.f, item, owner, sections: sectionsOf(def), value,
    canEdit: piece || asset || s.autoKey, locked: (c: string) => lockedAll || !!editLock(s, actor.id, c),
    curves: keyOwner(s.project, owner)?.channels ?? {},
  }
}

export default function JointPanel() {
  const s = useEditor(st => st)
  const [refused, setRefused] = useState(0) // foot lock could not hold: 안내 for 3 s
  useEffect(() => { if (!refused) return; const t = setTimeout(() => setRefused(0), 3000); return () => clearTimeout(t) }, [refused])
  const v = editView(s)
  if (!v) return null
  const ed = getEditor(), act = ed.getState()
  const all = [...BODY.map(b => b[0]), ...v.sections.flatMap(x => x.rows.map(r => r.ch))] // ↑/↓ order
  const sel = s.sel.channel === 'root' ? 'root.x' : s.sel.channel
  const deg = s.degrees, num = (x: number, d: boolean) => (d ? (x * 180) / Math.PI : x).toFixed(d ? 1 : 3)
  const set = (c: string, x: number) => { const ok = act.editPose(v.actor.id, { [c]: x }); if (!ok) setRefused(Date.now()); return ok }
  const clipView = !!(s.editing || s.clipEdit), r = clipView ? s.range : null
  const outside = !!r && (v.f < r.a || v.f > r.b)
  // clip view on the piece's lead-in / 끝 기본자세: those frames are not the piece's own
  const offPiece = !!s.editing && !s.clipEdit && (s.frame < v.item.start || s.frame >= v.item.start + v.item.trimOut - v.item.trimIn)
  const poseBlocked = !v.canEdit || outside || offPiece || all.some(v.locked) // tools on the whole pose
  const blocked = (c: string) => !v.canEdit || v.locked(c) || outside || offPiece
    || (c === 'root.z' && s.autoGround) || (s.feetLock && !c.startsWith('root.'))
  const here = Object.entries(v.curves).flatMap(([channel, c]) => c.keys.filter(k => k.f === v.f).map(k => ({ channel, interp: k.interp })))
  const keyRefs = here.map(k => ({ channel: k.channel, f: v.f }))
  const shownInterp = (here.find(k => k.channel === sel) ?? here[0])?.interp
  // the piece open in the clip preview is edited on the preview's own playhead (kept on the piece, paused)
  const onPreview = !s.editing && !s.clipEdit && s.itemPreview === v.item.id
  const go = (nf: number) => {
    const st = ed.getState()
    if (onPreview) { st.setPreviewPlaying(false); st.setPreviewFrame(Math.min(Math.max(nf, v.item.start), v.item.start + v.item.trimOut - v.item.trimIn - 1)) }
    else if (st.editing || st.clipEdit) { const [lo, hi] = playRange(st); st.setFrame(Math.min(Math.max(nf, lo), hi - 1)) } else st.setFrame(Math.max(nf, 0))
  }
  const jump = (dir: 1 | -1) => {
    const fs = Object.values(v.curves).flatMap(c => c.keys.map(k => k.f)), to = dir > 0 ? Math.min(...fs.filter(k => k > v.f)) : Math.max(...fs.filter(k => k < v.f))
    if (Number.isFinite(to)) go(to - v.item.trimIn + v.item.start)
  }
  const step = (d: 1 | -1) => go((onPreview ? ed.getState().previewFrame : ed.getState().frame) + d) // one frame, inside the clip view's range like the transport arrows
  const onKey = (e: React.KeyboardEvent) => {
    const el = e.target as HTMLInputElement
    if (el.tagName === 'INPUT' && el.type !== 'range') return
    const i = sel ? all.indexOf(sel) : -1
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault(); e.stopPropagation()
      act.select(v.actor.id, all[i < 0 ? 0 : Math.min(Math.max(i + (e.key === 'ArrowUp' ? -1 : 1), 0), all.length - 1)])
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault(); e.stopPropagation()
      if (i < 0 || blocked(sel!)) return
      const { joint, v: x, lo, hi } = v.value(sel!), step = (isAngle(sel!, joint) ? 0.5 * Math.PI / 180 : 0.005) * (e.shiftKey ? 10 : 1)
      const nx = x + (e.key === 'ArrowRight' ? step : -step)
      set(sel!, joint ? Math.min(Math.max(nx, lo), hi) : nx)
    }
  }
  const row = (c: string, label: string, mStep = 0.001) => {
    const { joint, v: x, lo, hi } = v.value(c), d = deg && isAngle(c, joint), name = BODY_LABEL.get(c) ?? c
    const near = joint && (x - lo < 0.1 * (hi - lo) || hi - x < 0.1 * (hi - lo))
    return (
      <div key={c} className={c === sel ? 'jp-row sel' : 'jp-row'} onPointerDown={() => { if (c !== sel) act.select(v.actor.id, c) }}>
        <span className="jp-name" title={c}>{label}</span>
        <input type="range" className={near ? 'near' : ''} min={lo} max={hi} step={0.001} value={x} disabled={blocked(c)} aria-label={`${name} 슬라이더`}
          onPointerDown={e => { e.currentTarget.setPointerCapture(e.pointerId); act.beginGesture(); endOnRelease() }}
          onChange={e => set(c, +e.target.value)} />
        <span className="jp-val">
          <input type="number" key={`${v.f}-${x}-${d}`} defaultValue={num(x, d)} step={d ? 1 : isAngle(c, joint) ? 0.001 : mStep} disabled={blocked(c)} aria-label={`${name} 숫자`}
            onBlur={e => { const n = e.target.valueAsNumber; if (!Number.isFinite(n) || e.target.value === num(x, d)) return; const a = d ? n * Math.PI / 180 : n; if (!set(c, joint ? Math.min(Math.max(a, lo), hi) : a)) e.target.value = num(x, d) }}
            onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur() }} />
          <i>{d ? '°' : isAngle(c, joint) ? 'rad' : 'm'}</i>
        </span>
      </div>
    )
  }
  const feet = v.def.kind === 'g1' ? '두' : '네'
  const fit = () => { const p = act.poseAt(v.actor.id); if (p) set('root.z', groundZ(p.def, p.q, p.body)) }
  return (
    <section className="jp" role="group" aria-label="관절 패널" tabIndex={-1} onKeyDown={onKey}>
      <h3 className="jp-head">
        <span>값</span>
        <span className="jp-f">{s.clipEdit ? '클립' : onPreview ? '클립 프리뷰' : '시퀀스'} F{v.f}</span>
      </h3>
      {outside && <p className="jp-hint warn">재생헤드를 구간 안으로 옮기세요</p>}
      {offPiece && <p className="jp-hint warn">기본자세·전이·관성 구간입니다 · 조각 안에서 고치세요</p>}
      {refused > 0 && <p className="jp-hint warn" role="status">{feet} 발을 고정한 채 더 움직일 수 없습니다</p>}
      <div className="jp-tools">
        <button aria-label="이전 프레임" title="1프레임 뒤로" onClick={() => step(-1)}>◀ 1F</button>
        <button aria-label="다음 프레임" title="1프레임 앞으로" onClick={() => step(1)}>1F ▶</button>
        <span className="jp-gap" />
        <button aria-label="이전 키" title="이전 키(◆)로" onClick={() => jump(-1)}>◀ 키</button>
        <button aria-label="다음 키" title="다음 키(◆)로" onClick={() => jump(1)}>키 ▶</button>
      </div>
      <div className="jp-tools">
        <button disabled={poseBlocked} title="이 프레임의 자세 전체(몸통 + 모든 관절)를 키로" onClick={() => act.keyPose(v.actor.id)}>키 추가</button>
        <button disabled={!here.length || poseBlocked} onClick={() => act.deleteKeys(v.owner, keyRefs)}>키 삭제</button>
        <select aria-label="보간" title="이 프레임 키의 보간" disabled={!here.length || poseBlocked} value={shownInterp ?? ''}
          onChange={e => act.setInterp(v.owner, keyRefs, e.target.value as Interp)}>
          {!here.length && <option value="" />}
          {INTERPS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
        <span className="jp-gap" />
        <button className="jp-unit" aria-pressed={deg} onClick={() => act.setDegrees(!deg)} title="각도 단위 (도 / rad)">{deg ? '도' : 'rad'}</button>
      </div>
      <div className="jp-tools">
        <button disabled={poseBlocked || s.feetLock} title="차렷 관절 · 기울기 0 · 기본 높이 (무대 X·Y·방향은 그대로)" onClick={() => act.standPose(v.actor.id)}>기본 서기로</button>
      </div>
      <h4 className="jp-sec">몸통 (무대 위치 · 자세)</h4>
      <div className="jp-rows">{BODY.map(([c, l, st]) => row(c, l, st))}</div>
      <div className="jp-tools jp-wrap">
        <button className="jp-unit" aria-pressed={s.feetLock} onClick={() => act.setFeetLock(!s.feetLock)}>{feet} 발 위치 고정</button>
        <label className="jp-check"><input type="checkbox" checked={s.autoGround} onChange={e => act.setAutoGround(e.target.checked)} />바닥 밀착 (높이 자동)</label>
        <button disabled={blocked('root.z') || s.autoGround} onClick={fit}>바닥에 맞추기</button>
      </div>
      <div className="jp-tools jp-wrap" role="group" aria-label="체중 이동">
        <span className="jp-lbl" title={`몸통(골반)만 ${SHIFT * 100}cm씩 옮기고 ${feet} 발은 제자리 (발 위치 고정이 꺼져 있어도 항상 고정) · 로봇이 보는 방향 기준`}>체중 이동</span>
        {SHIFTS.map(([label, fw, lf]) => <button key={label} disabled={poseBlocked} onClick={() => { if (!act.shiftBody(v.actor.id, fw * SHIFT, lf * SHIFT)) setRefused(Date.now()) }}>{label}</button>)}
      </div>
      {v.sections.map(x => (
        <div key={x.title}>
          <h4 className="jp-sec jp-part">{x.title}</h4>
          <div className="jp-rows">{x.rows.map(rw => row(rw.ch, rw.label))}</div>
        </div>
      ))}
      {clipView && <RangeRow />}
    </section>
  )
}

// 구간 줄: a – b (clip frames), 가감 frames, 해제; picked by Shift+drag on the clip-view ruler.
function RangeRow() {
  const r = useEditor(s => s.range), act = getEditor().getState()
  if (!r) return <div className="jp-range"><span className="jp-hint">구간: 눈금자를 Shift+드래그로 선택</span></div>
  const field = (label: string, key: 'a' | 'b' | 'fade', value: number) => (
    <label className="jp-rf">{label}<input type="number" aria-label={`구간 ${label}`} key={`${key}-${value}`} defaultValue={value} step={1} min={0}
      onBlur={e => { const n = e.target.valueAsNumber; if (Number.isFinite(n)) act.setRange({ ...r, [key]: n }) }}
      onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur() }} /></label>
  )
  return (
    <div className="jp-range" role="group" aria-label="구간">
      <span>구간</span>{field('시작', 'a', r.a)}<span>–</span>{field('끝', 'b', r.b)}{field('가감', 'fade', r.fade)}
      <button aria-label="구간 해제" title="구간 해제" onClick={() => act.setRange(null)}>✕</button>
    </div>
  )
}
