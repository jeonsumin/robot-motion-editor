// 검수 목록 (수정변동사항.md §12 · §13 · §14 · §16): suspect joint jumps, self-collisions (§14) and feet sliding / asking too much grip
// (§16), pieces past the 무대 edge (§18) of one target in a list, the frame vs. the frame before it in 3D, the
// speed / limit around it, and a verdict. The motion is never changed; verdicts are saved in the project (Project.review, undoable).
import { useEffect, useMemo, useRef, useState } from 'react'
import { useEditor, getEditor, assetOwner } from '../store/store'
import { projectTitle } from '../model/sequence'
import { COLOR } from '../model/defaults'
import type { Pose } from '../model/pose'
import type { ReviewVerdict } from '../model/types'
import { seqFocus } from '../timeline/viewState'
import { saveCsvFile } from '../fileio'
import { COLL_MIN, CONTEXT, HAND_MIN, collisionSeries, detectSuspects, itemSeries, type Suspect, type SuspectKind } from './detect'
import { overlapLinks } from './collide'
import { FOOT, FRICTION, footLabel, frictionSeries, slipSeries } from './feet'
import { legLinks, planFootFix, type FootFix } from './footFix'
import { reviewTargets, targetPoses, type ReviewTarget } from './targets'
import { STAGE_TOL, stageCheck, stageSeries, type StageCheck } from './stage'
import { clipRange, recordCsv, resolvedBad, targetClipId, verdictOf } from './verdicts'
import { noteCheck } from './reviewState'
import { ReviewView, type ReviewAngle } from './ReviewView'

const KIND: Record<SuspectKind, string> = { limit: '로봇 한계 초과', rel: '파일 기준 급변', start: '첫 프레임 튐', collision: '자가충돌', handTouch: '손 맞닿음', footSlip: '발 미끄러짐', friction: '마찰 부족', stage: '무대 이탈' }
const FILTERS: { key: 'all' | SuspectKind; label: string }[] = [{ key: 'all', label: '전체' }, ...(['limit', 'rel', 'start', 'collision', 'handTouch', 'footSlip', 'friction', 'stage'] as const).map(k => ({ key: k, label: KIND[k] }))]
const isColl = (s: Suspect | null) => !!s && (s.kind === 'collision' || s.kind === 'handTouch') // §14
const LEVEL = { warn: '경고', note: '주의' } as const // §16
const ANGLES: ReviewAngle[] = ['3/4', '정면', '측면']
const JOINT = (n: string) => n.replace(/_joint$/, '')
const sec = (f: number) => (f / 60).toFixed(1)
const sgn = (v: number) => `${v > 0 ? '+' : ''}${v.toFixed(2)}`
type Group = 'open' | 'bad' | 'ok'
const GROUP: Record<Group, string> = { open: '미처리', bad: '문제 있음 (미해결)', ok: '안무로 둔 지점' }

export default function ReviewDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null), viewEl = useRef<HTMLDivElement>(null), view = useRef<ReviewView | null>(null)
  const project = useEditor(s => s.project), defs = useEditor(s => s.defs), title = useEditor(s => projectTitle(s.fileName))
  const setVerdict = useEditor(s => s.setReviewVerdict)
  const targets = useMemo(() => (open ? reviewTargets(project, title) : []), [open, project, title])
  const [tKey, setTKey] = useState('')
  const target = targets.find(t => t.key === tKey) ?? null
  const clipId = target ? targetClipId(project, target) : undefined
  const [run, setRun] = useState(0) // 다시 검사
  const [res, setRes] = useState<{ key: string; poses: Pose[]; items: Suspect[]; stage: StageCheck | null } | null>(null)
  const [filter, setFilter] = useState<'all' | SuspectKind>('all')
  const [showResolved, setShowResolved] = useState(false)
  const [sel, setSel] = useState(0), [cur, setCur] = useState(0)
  const [angle, setAngle] = useState<ReviewAngle>('3/4'), [ghost, setGhost] = useState(true)
  const [msg, setMsg] = useState('')
  const [fix, setFix] = useState<{ item: Suspect; fix: FootFix } | null>(null), [showFix, setShowFix] = useState(true) // §17 추천대로 고치기

  useEffect(() => {
    const d = ref.current
    if (!d) return
    if (open && !d.open) {
      const s = getEditor().getState(), ts = reviewTargets(s.project, projectTitle(s.fileName))
      const want = s.selItem ? `item:${s.selItem}` : s.clipEdit ? `clip:${s.clipEdit}` : ''
      setTKey(ts.find(t => t.key === want)?.key ?? ts[0]?.key ?? ''); setRes(null); setSel(0); setMsg('')
      d.showModal()
    }
    if (!open && d.open) d.close()
  }, [open])

  // run the check for the chosen target (after the dialog paints: a long motion takes a moment)
  useEffect(() => {
    if (!open || !target) return
    let live = true
    const id = setTimeout(() => {
      const s = getEditor().getState(), poses = targetPoses(s.project, s.defs, target)
      if (!live) return
      const stage = poses && target.kind === 'item' ? stageCheck(s.project, s.defs, target.id) : null // §18: pieces only (where it stands)
      const items = poses ? [...detectSuspects(poses, s.defs[target.robot]), ...(stage?.items ?? [])] : []
      setRes({ key: target.key, poses: poses ?? [], items, stage })
      setSel(0)
      const cid = targetClipId(s.project, target)
      if (cid && poses) { // 해결됨: 문제 있음 verdicts in this range that the check no longer finds (the timeline greys them)
        const inRange = (s.project.review ?? []).filter(v => v.clipId === cid && v.verdict === 'bad' && v.to >= target.clipFrom && v.from < target.clipFrom + poses.length)
        noteCheck(inRange, resolvedBad(s.project.review, cid, items, target.clipFrom, poses.length))
      }
    }, 0)
    return () => { live = false; clearTimeout(id) }
  }, [open, tKey, run]) // eslint-disable-line react-hooks/exhaustive-deps

  const ready = !!res && !!target && res.key === target.key
  const all = ready ? res!.items : []
  const vOf = (s: Suspect): ReviewVerdict | undefined => (clipId && target ? verdictOf(project.review, clipId, s, target.clipFrom) : undefined)
  const groupOf = (s: Suspect): Group => vOf(s)?.verdict ?? 'open'
  const filtered = all.filter(s => filter === 'all' || s.kind === filter)
  const groups = (['open', 'bad', 'ok'] as Group[]).map(g => ({ g, items: filtered.filter(s => groupOf(s) === g) }))
  const flat = groups.flatMap(x => x.items) // selection order: 미처리, 문제 있음, 안무 (안무 always last, user)
  const item = flat[Math.min(sel, flat.length - 1)] ?? null
  const counts = (k: 'all' | SuspectKind) => all.filter(s => k === 'all' || s.kind === k).length
  const n = (g: Group) => all.filter(s => groupOf(s) === g).length
  const resolved = ready && clipId ? resolvedBad(project.review, clipId, all, target!.clipFrom, res!.poses.length) : []

  useEffect(() => { if (item) setCur(item.worst) }, [item?.from, item?.to, item?.kind, res]) // eslint-disable-line react-hooks/exhaustive-deps

  // the 3D view lives while the dialog is open
  useEffect(() => {
    if (!open || !viewEl.current) return
    const v = new ReviewView(viewEl.current); view.current = v
    return () => { v.dispose(); view.current = null }
  }, [open])
  const poses = ready ? res!.poses : []
  const def = target ? defs[target.robot] : null
  useEffect(() => {
    const v = view.current
    if (!v || !def || !item || !poses[cur]) return
    v.show(def, COLOR[target!.robot], poses[cur], ghost && !isColl(item) && cur > 0 ? poses[cur - 1] : null) // 자가충돌: the red parts instead of the ghost
    v.highlight(isColl(item) ? overlapLinks(poses[cur], def, item.pairs!) : item.kind === 'footSlip' ? [item.foot!] : []) // 자가충돌: the links that overlap in this frame red (§15); 발 미끄러짐: the foot (§16)
  }, [item, cur, ghost, poses, def]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { const v = view.current; if (v && item && poses[item.worst]) v.aim(poses[item.worst], angle) }, [item, angle, poses])
  // §17: the fix of the 발 미끄러짐 item shown (after the paint: it checks the whole motion again, a fraction of a second)
  useEffect(() => {
    if (!item || item.kind !== 'footSlip' || !def || !ready) return
    let live = true
    const id = setTimeout(() => { if (live) setFix({ item, fix: planFootFix(poses, def, item, all) }) }, 0)
    return () => { live = false; clearTimeout(id) }
  }, [item, res]) // eslint-disable-line react-hooks/exhaustive-deps
  const itemFix = fix && item && fix.item === item ? fix.fix : null
  useEffect(() => {
    const v = view.current
    if (!v || !def) return
    const inFix = !!itemFix?.poses && item?.kind === 'footSlip' && cur >= itemFix.from && cur <= itemFix.to
    v.preview(def, inFix && showFix ? itemFix!.poses![cur] : null, inFix ? legLinks(def, item!.foot!) : [])
    v.guide(inFix ? { foot: item!.foot!, fixed: itemFix!.poses![cur], now: poses[cur], path: itemFix!.path.slice(0, Math.max(1, Math.min(cur, itemFix!.lift) - itemFix!.hold[0] + 1)), floor: itemFix!.floor } : null, def)
  }, [itemFix, cur, showFix, poses, def, item]) // eslint-disable-line react-hooks/exhaustive-deps
  const applyFix = () => {
    if (!itemFix?.ok || !itemFix.poses || !target || !def || !item) return
    const owner = target.kind === 'item' ? target.id : assetOwner(target.id), deltas: Record<string, number[]> = {}
    itemFix.qis.forEach((qi, ci) => { deltas[def.joints[qi].name] = itemFix.q.map((row, j) => row[ci] - poses[itemFix.from + j].q[qi]) })
    if (getEditor().getState().addOffsetDeltas(owner, target.clipFrom + itemFix.from, deltas)) {
      setMsg(`${item.parts[0]} 미끄러짐을 ${itemFix.k < 1 ? `붙잡는 세기 ${Math.round(itemFix.k * 100)}%로 ` : ''}고쳤습니다 (f${itemFix.from}~f${itemFix.to}, 다리 관절 최대 ${itemFix.maxDeg.toFixed(0)}°${itemFix.rest > 0 ? ` · ${(itemFix.rest * 100).toFixed(1)}cm 남아 목록에 남음` : ''}) · 되돌리기: 검수 창을 닫고 타임라인에서 Ctrl+Z`)
      setRun(k => k + 1) // check again: the item should be gone
    } else setMsg(target.kind === 'item' ? '고칠 수 없습니다: 트랙이 잠겼거나 조각이 원본 사용으로 되어 있습니다' : '고칠 수 없습니다')
  }

  const stage = ready ? res!.stage : null
  const series = item && def ? (item.kind === 'stage' ? (stage ? stageSeries(stage, item, project, CONTEXT) : null) : isColl(item) ? collisionSeries(poses, def, item) : item.kind === 'footSlip' ? slipSeries(poses, def, item, CONTEXT)
    : item.kind === 'friction' ? frictionSeries(poses, def, item, CONTEXT) : itemSeries(poses, def, item)) : null
  // the chart's red line: 관통 기준 (mm), 한계 1.0배, 미끄러짐 기준 (cm/s) or 마찰 주의 (and a second line at 경고)
  const lim = item?.kind === 'stage' ? STAGE_TOL * 100 : item?.kind === 'handTouch' ? HAND_MIN : isColl(item) ? COLL_MIN : item?.kind === 'footSlip' ? FOOT.vMin * 100 : item?.kind === 'friction' ? FRICTION.note : 1
  const lim2 = item?.kind === 'friction' ? FRICTION.warn : null
  const step = (d: number) => { if (series) setCur(c => Math.min(Math.max(c + d, series.from), series.from + series.values.length - 1)) }
  // a verdict is saved on the clip's frames (undoable); the same button again clears it. The item moves to its group, the
  // selection stays at the same place in the list (= the next 미처리 one after judging one)
  const judge = (v: ReviewVerdict['verdict']) => {
    if (!item || !target || !clipId || item.kind === 'stage') return // 무대 이탈: no verdict (§18)
    setVerdict({ clipId, kind: item.kind, ...clipRange(item, target.clipFrom), ...(item.foot ? { foot: item.foot } : {}) }, vOf(item)?.verdict === v ? null : v)
  }
  const clearResolved = (v: ReviewVerdict) => setVerdict({ clipId: v.clipId, from: v.from, to: v.to, kind: v.kind, foot: v.foot }, null)
  const goTimeline = () => {
    if (!target) return
    const s = getEditor().getState()
    onClose()
    if (target.kind === 'item') {
      if (s.clipEdit) s.closeClipEdit()
      getEditor().getState().setFrame(target.firstFrame + cur)
      getEditor().getState().selectItem(target.id)
      seqFocus.fn?.(target.id)
    } else {
      s.openClipEdit(target.id)
      getEditor().getState().setFrame(cur)
    }
  }
  const exportRecord = async () => {
    if (!target || !clipId || !ready) return
    const name = project.clips[clipId]?.name ?? 'clip'
    try {
      const ok = await saveCsvFile(`${name.replace(/[/\\:*?"<>|#\s]/g, '_')}_검수기록.csv`, recordCsv(name, target, all, project.review, clipId))
      if (ok) setMsg(`판정 기록 ${all.length}건을 내보냈습니다`)
    } catch (e) { setMsg(`판정 기록 내보내기 실패: ${e instanceof Error ? e.message : e}`) }
  }

  const csvRow = (f: number) => (target ? target.clipFrom + f + 1 : f + 1)
  const title1 = (s: Suspect) => isColl(s) ? `${s.parts.slice(0, 2).join(', ')}${s.parts.length > 2 ? ` 외 ${s.parts.length - 2}` : ''} 관통 ${s.depth!.toFixed(1)}mm`
    : s.kind === 'footSlip' ? `${s.parts[0]} ${(s.travel! * 100).toFixed(1)}cm ${s.pivot ? `제자리 회전 ${Math.round(s.turn!)}°` : '미끄러짐'} · 체중 ${Math.round(s.load! * 100)}%`
    : s.kind === 'stage' ? `${s.parts[0]} 경계를 ${(s.over! * 100).toFixed(1)}cm 넘음`
    : s.kind === 'friction' ? `필요 마찰계수 ${s.mu!.toFixed(2)} (주의 ${FRICTION.note.toFixed(1)} · 경고 ${FRICTION.warn.toFixed(1)})`
    : s.kind === 'start' ? `첫 프레임 튐 · ${s.parts.join('·') || '전신'} ${s.jump.toFixed(2)} rad`
    : `${s.parts.join('·')} ${Math.round(s.speed)} rad/s · 로봇 한계 ${s.ratio.toFixed(1)}배`
  const sub1 = (s: Suspect) => `f${s.from}${s.to > s.from ? `~f${s.to}` : ''} · ${sec(s.from)}초 · ${s.to - s.from + 1}프레임` + (isColl(s) || s.kind === 'friction' || s.kind === 'stage' ? ` · 최악 f${s.worst}`
    : s.kind === 'footSlip' ? ` · 최고 ${Math.round(s.speed * 100)}cm/s` : ` · ${s.joints.length}개 관절`)
  const max = series ? Math.max((lim2 ?? lim) * 1.2, ...series.values) : 1
  const H = 100, y = (v: number) => H - 6 - Math.sqrt(v / max) * (H - 14) // sqrt: small values stay visible next to a big jump
  const itemV = item ? vOf(item)?.verdict : undefined
  const place = target?.kind === 'item' ? project.actors.find(a => a.id === project.sequence.tracks.find(t => t.items.some(i => i.id === target.id))?.actorId)?.placement : undefined // §18 배치 추천

  return (
    <dialog ref={ref} className="rv" onClose={onClose} aria-label="검수 목록"
      onKeyDown={e => { // keys stay in the window (not the editor's shortcuts); ← → step a frame
        e.stopPropagation()
        if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !(e.target instanceof HTMLSelectElement)) { e.preventDefault(); step(e.key === 'ArrowLeft' ? -1 : 1) }
      }}>
      <div className="rv-head">
        <h2>⚠ 검수 목록</h2>
        <span className="rv-dim">튀는 관절·자가충돌·발 미끄러짐·무대 이탈을 찾아 3D로 확인하고 판정합니다 (모션은 바꾸지 않음 · 판정은 프로젝트에 저장)</span>
        {msg && <span role="status" className="rv-msg">{msg}</span>}
        <button className="rv-close" onClick={onClose}>닫기</button>
      </div>
      <div className="rv-bar">
        <label className="rv-dim">대상 <select aria-label="검수 대상" value={tKey} onChange={e => { setTKey(e.target.value); setSel(0) }}>
          {targets.map(t => <option key={t.key} value={t.key}>{t.label}</option>)}
        </select></label>
        <div className="rv-filters" role="group" aria-label="종류">
          {FILTERS.map(f => <button key={f.key} aria-pressed={filter === f.key} onClick={() => { setFilter(f.key); setSel(0) }}>{f.label} {counts(f.key)}</button>)}
        </div>
        <span className="rv-dim rv-count">미처리 {n('open')} · 문제 {n('bad')} · 안무 {n('ok')} / 전체 {all.length}</span>
        <label className="rv-check"><input type="checkbox" checked={showResolved} onChange={e => setShowResolved(e.target.checked)} />해결된 것도 보기 {resolved.length}</label>
        <span className="rv-tools">
        <button className="rv-again" onClick={() => setRun(k => k + 1)} title="지금 상태(수정 층 포함)로 다시 검사합니다. 문제 있음으로 둔 지점에서 튐이 사라졌으면 해결됨이 됩니다">다시 검사</button>
        <button onClick={exportRecord} disabled={!ready} title="이 대상의 검출 항목을 측정값·판정과 함께 CSV로 저장합니다 (기준 다듬기용)">판정 기록 내보내기</button>
        </span>
      </div>
      <div className="rv-body">
        <ul className="rv-list" aria-label="의심 지점">
          {!targets.length && <li className="rv-empty">검사할 모션이 없습니다</li>}
          {targets.length > 0 && !ready && <li className="rv-empty">검사 중…</li>}
          {ready && !all.length && <li className="rv-empty">의심 지점이 없습니다</li>}
          {ready && all.length > 0 && !n('open') && <li className="rv-empty">미처리 항목이 없습니다</li>}
          {groups.map(({ g, items }) => items.length > 0 && [
            g !== 'open' && <li key={`h-${g}`} className={`rv-group ${g}`}>{GROUP[g]} {items.length}</li>,
            ...items.map(s => {
              const i = flat.indexOf(s), v = vOf(s)
              return (
                <li key={`${g}-${s.kind}-${s.foot ?? ''}-${s.from}-${s.to}`}>
                  <button className="rv-item" aria-current={s === item} onClick={() => setSel(i)}>
                    <span className={`rv-chip ${s.kind}`}>{KIND[s.kind]}</span>
                    <b>{title1(s)}</b>{s.level && <span className={`rv-lv ${s.level}`}>{LEVEL[s.level]}</span>}{v && <span className={`rv-v ${v.verdict}`}>{v.verdict === 'bad' ? '문제 있음' : '안무여서 놔둠'}</span>}
                    <span className="rv-sub">{sub1(s)}</span>
                  </button>
                </li>
              )
            }),
          ])}
          {showResolved && resolved.length > 0 && [
            <li key="h-res" className="rv-group res">해결됨 {resolved.length}</li>,
            ...resolved.map(v => (
              <li key={`res-${v.from}-${v.to}-${v.at}`} className="rv-res">
                <span className="rv-chip res">해결됨</span>
                <span>{KIND[v.kind]}{v.foot ? ` · ${footLabel(v.foot)}` : ''} · 클립 f{v.from}{v.to > v.from ? `~f${v.to}` : ''} · 문제 있음으로 판정했던 지점, 지금은 튐 없음</span>
                <button onClick={() => clearResolved(v)} title="해결된 판정을 지웁니다">판정 지우기</button>
              </li>
            )),
          ]}
        </ul>
        <div className="rv-main">
          <div className="rv-title">
            {item ? <><b>f{cur} · {sec(cur)}초</b><span className="rv-dim">CSV {csvRow(cur)}행{target!.kind === 'item' ? ` · 시퀀스 F${target!.firstFrame + cur}` : ''} · {KIND[item.kind]} · {isColl(item) || !item.joints.length ? item.parts.join(', ') : item.joints.map(JOINT).join(', ')}{item.level ? ` · ${LEVEL[item.level]}` : ''}</span></> : <span className="rv-dim">항목을 고르세요</span>}
          </div>
          {item?.kind === 'stage' && stage && <div className="rv-guide" aria-label="배치 추천">
            <div className="rv-guide-head"><b>배치 추천 · {item.parts[0]}</b><span className="rv-dim">로봇은 옮기지 않습니다 — 배치는 직접 조정</span></div>
            {stage.move ? <>
              <div>· 무대 배치를 <b>X {sgn(stage.move[0])}m · Y {sgn(stage.move[1])}m</b> 옮기면 이 조각은 무대 안 (경계에서 {STAGE_TOL * 100}cm 여유)</div>
              {place && <div>· 인스펙터 <b>배치</b>: x {place.x.toFixed(2)} → <b>{(place.x + stage.move[0]).toFixed(2)}</b> · y {place.y.toFixed(2)} → <b>{(place.y + stage.move[1]).toFixed(2)}</b> <span className="rv-dim">(또는 무대에서 로봇을 끌어서)</span></div>}
              <div className={stage.others ? 'rv-note' : 'rv-dim'}>· {stage.others ? `같은 로봇의 다른 조각 ${stage.others}개가 새로 무대를 벗어남 — 배치는 로봇 전체를 옮기므로 동선과 함께 확인하세요` : '같은 로봇의 다른 조각은 그대로 무대 안'}</div>
            </> : <div className="rv-red">· 이 조각의 동선이 무대보다 넓어 배치만으로는 들어오지 않음 — 동선을 줄이거나 무대 크기를 늘려야 함</div>}
            <div className="rv-dim">· 판정하지 않는 항목입니다 (조각마다 서 있는 곳이 달라 클립에 저장할 수 없음) · 고친 뒤 다시 검사</div>
          </div>}
          {item?.kind === 'footSlip' && <div className={`rv-guide${itemFix && !itemFix.ok ? ' no' : ''}`} aria-label="개선 가이드">
            <div className="rv-guide-head"><b>개선 가이드 · {item.parts[0]} 붙잡기</b>
              <span className="rv-dim">{item.pivot ? '제자리 회전' : `체중 ${Math.round(item.load! * 100)}% 실린 채 미끄러짐`}</span>
              <span className="rv-gap" />
              <label className="rv-check"><input type="checkbox" checked={showFix} onChange={e => setShowFix(e.target.checked)} />고친 모습</label>
              <button className="rv-fix" disabled={!itemFix?.ok || !clipId} onClick={applyFix} title="미끄러진 만큼 발을 되돌려 다리만 다시 계산해 수정 층에 넣습니다 (원본은 그대로). 되돌리려면 검수 창을 닫고 타임라인에서 Ctrl+Z">추천대로 고치기</button>
            </div>
            {!itemFix ? <div className="rv-dim">점검 중…</div> : <>
              {itemFix.lift >= 0 && <div>· 발바닥을 <b>f{itemFix.hold[0]}</b> 자리에 붙잡고, 발을 떼는 <b>f{itemFix.lift}</b>까지 유지 — 지금은 그 사이 {(item.travel! * 100).toFixed(1)}cm 미끄러져 처음 자리에서 <b className="rv-red">{(itemFix.drift * 100).toFixed(1)}cm</b> 벗어남</div>}
              {itemFix.poses && <div>· 고친 모습과 지금의 차이: 발이 최대 <b>{(itemFix.shift * 100).toFixed(1)}cm</b> 옮겨짐 <span className="rv-dim">(f{itemFix.shiftAt}{itemFix.shift < 0.02 ? ' · 2cm 미만이라 3D에서는 겹쳐 보일 수 있음' : ''})</span></div>}
              {itemFix.ok && itemFix.k < 1 && <div className="rv-note">· 붙잡는 세기 <b>{Math.round(itemFix.k * 100)}%</b> — 전부 되돌리면 점검에 걸려서 미끄러진 거리의 {Math.round(itemFix.k * 100)}%만 되돌림 · 미끄러짐 {(item.travel! * 100).toFixed(1)}cm → {itemFix.rest > 0 ? <><b>{(itemFix.rest * 100).toFixed(1)}cm</b> (항목은 목록에 남음)</> : <b>검출 기준 미만</b>}</div>}
              {itemFix.ok && <div>· 고친 모습(초록): 다리만 다시 계산 · 다리 관절 최대 {itemFix.maxDeg.toFixed(0)}° 변화 <span className="rv-dim">(골반·상체 그대로, 발 방향·기울기는 원래대로)</span></div>}
              {itemFix.ok && <div className="rv-dim">· 고친 뒤 되돌리기: 검수 창을 닫고 타임라인에서 Ctrl+Z (실행취소 한 번에 이 수정 전체가 돌아감)</div>}
              {itemFix.ok && itemFix.soon && <div className="rv-note">· 미끄러진 직후 발을 뗌 — 걸음일 수 있으니 영상과 비교해 확인한 뒤 고치세요</div>}
              {!itemFix.ok && <div className="rv-red">· 자동으로 고칠 수 없음: {itemFix.why.join(' / ')}</div>}
            </>}
          </div>}
          <div className="rv-view" ref={viewEl}>
            {item?.kind === 'footSlip' && itemFix?.poses && cur >= itemFix.from && cur <= itemFix.to && <div className="rv-inset"><span>위에서 본 발 · 초록 = 추천 위치 · 빨간 테두리 = 지금</span></div>}
            <div className="rv-legend">{isColl(item) && <><i className="h" />빨강 = 겹친 부위 </>}{item?.kind === 'footSlip' && <><i className="h" />빨강 = 미끄러지는 발 · 선 = 밀린 경로 </>}{item?.kind === 'footSlip' && itemFix?.poses && showFix && <><i className="f" />초록 = 고친 모습 </>}{ghost && !isColl(item) && <><i className="g" />주황 = 직전 f{Math.max(cur - 1, 0)} </>}<i className="c" />지금 f{cur}</div>
            <div className="rv-angles">
              <button aria-pressed={ghost && !isColl(item)} disabled={isColl(item)} title={isColl(item) ? '자가충돌은 겹친 부위를 빨간색으로 보여 줍니다' : '직전 프레임을 주황색으로 겹쳐 봅니다'} onClick={() => setGhost(g => !g)}>겹쳐 보기</button>
              {ANGLES.map(a => <button key={a} aria-pressed={angle === a} onClick={() => setAngle(a)}>{a}</button>)}
            </div>
          </div>
          <div className="rv-chart-head"><b>구간 지표</b>{series && <span className="rv-dim">f{series.from}~f{series.from + series.values.length - 1} (앞뒤 {CONTEXT}프레임) · {item!.kind === 'stage' ? `${item!.parts[0]} 경계를 넘은 거리(cm, 로봇 몸 외곽) · 최대 ${Math.max(...series.values).toFixed(1)}cm` : isColl(item) ? `관통 깊이(mm) · 최대 ${Math.max(...series.values).toFixed(1)}mm`
            : item!.kind === 'footSlip' ? `${item!.parts[0]} 접촉점이 바닥 위를 미끄러지는 속도(cm/s) · 최대 ${Math.max(...series.values).toFixed(1)}cm/s`
            : item!.kind === 'friction' ? `필요 마찰계수(수평 힘 / 수직 힘) · 최대 ${Math.max(...series.values).toFixed(2)}`
            : `관련 관절 속도 / 로봇 한계 · 최대 ${Math.max(...series.values).toFixed(1)}배`}</span>}</div>
          <svg className="rv-chart" viewBox={`0 0 ${series?.values.length ?? 1} ${H}`} preserveAspectRatio="none" role="img" aria-label="구간 지표">
            {series?.values.map((v, i) => {
              const f = series.from + i, inItem = item && f >= item.from && f <= item.to
              return <rect key={i} x={i + 0.12} width={0.76} y={y(v)} height={H - 6 - y(v)} className={f === cur ? 'cur' : v > lim ? 'over' : inItem ? 'in' : ''} onClick={() => setCur(f)} />
            })}
            {series && <line x1={0} x2={series.values.length} y1={y(lim)} y2={y(lim)} className="lim" />}
            {series && lim2 !== null && <line x1={0} x2={series.values.length} y1={y(lim2)} y2={y(lim2)} className="lim lim2" />}
            {series && itemFix && item?.kind === 'footSlip' && itemFix.lift >= 0 && <rect className="hold" x={Math.max(0, itemFix.hold[0] - series.from)} width={Math.max(0, Math.min(itemFix.hold[1], series.from + series.values.length - 1) - Math.max(itemFix.hold[0], series.from) + 1)} y={H - 5} height={5} />}
          </svg>
          <div className="rv-legend2 rv-dim">회색 = 앞뒤 여유 · 밝은 회색 = 의심 구간 · 주황 = {item?.kind === 'stage' ? `경계를 ${lim}cm 넘게 벗어남` : isColl(item) ? `기준(${lim}mm) 넘게 겹침` : item?.kind === 'footSlip' ? `바닥에 닿은 채 ${lim}cm/s 넘게 움직임 (0 = 발이 떠 있음)` : item?.kind === 'friction' ? `마찰계수 ${lim} 넘게 필요` : '로봇 한계 초과'} · 흰색 = 보고 있는 프레임 · 빨간 점선 = {item?.kind === 'stage' ? `기준 ${lim}cm` : isColl(item) ? `기준 ${lim}mm` : item?.kind === 'footSlip' ? `기준 ${lim}cm/s` : item?.kind === 'friction' ? `주의 ${lim} · 굵은 점선 = 경고 ${lim2?.toFixed(1)}` : '한계(1.0배)'} · 막대를 누르면 그 프레임</div>
          <div className="rv-actions">
            <button disabled={!item} onClick={() => step(-1)}>◀ 1</button>
            <button disabled={!item} onClick={() => step(1)}>1 ▶</button>
            <button disabled={!item} onClick={() => item && setCur(item.worst)}>최악 프레임</button>
            <button disabled={!item} onClick={goTimeline}>타임라인에서 보기</button>
            <span className="rv-gap" />
            <button disabled={!item || !clipId || item.kind === 'stage'} className="bad" aria-pressed={itemV === 'bad'} onClick={() => judge('bad')} title="미해결 문제로 남깁니다 (타임라인 빨간 표시 · 내보낼 때 경고). 다시 누르면 판정을 지웁니다">문제 있음</button>
            <button disabled={!item || !clipId || item.kind === 'stage'} className="ok" aria-pressed={itemV === 'ok'} onClick={() => judge('ok')} title="문제로 세지 않고 '안무로 둔 지점'으로 남깁니다 (내보내기 경고에서 빠지고 따로 표시). 다시 누르면 판정을 지웁니다">안무여서 놔둠</button>
          </div>
        </div>
      </div>
    </dialog>
  )
}
