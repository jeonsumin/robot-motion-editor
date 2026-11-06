import { actorOf, clipLocked, editingItem, getEditor, useEditor } from '../store/store'
import { exportClipCsv } from '../export/csv'
import { saveCsvFile, writeTextFiles } from '../fileio'
import { rlClipExport } from '../export/rlExport'
import { curveKeyCount, offsetKeyCount } from '../model/itemClip'
import { useEffect, useRef, useState } from 'react'
import { DATA_FPS, parsePlayFps, playTime, PLAY_FPS_MAX, PLAY_FPS_MIN, PLAY_FPS_PRESETS } from '../playClock'
import { cutAtFrame, sequenceEnd } from '../transport'
import GraphCanvas from './GraphCanvas'
import { draggedAsset, dropAssetInClipView, isAssetDrag } from './assetDrop'
import SequenceCanvas from './SequenceCanvas'
import TrackCanvas from './TrackCanvas'
import { formatTimecode, parseTimecode } from './timeScale'
import { usePhysics } from '../physics/physicsStore'
import { cancelAll } from '../physics/runItem'
import { PHYS_NOTE } from './physGraph'

// 자르기: type a sequence frame (starts at the playhead) and cut the piece there — same target rule as the C key.
function CutControl({ disabled }: { disabled: boolean }) {
  const [val, setVal] = useState<string | null>(null), [msg, setMsg] = useState('')
  const close = () => { setVal(null); setMsg('') }
  if (val === null) return (
    <button className="tl-cut" disabled={disabled} onClick={() => { setVal(String(getEditor().getState().frame)); setMsg('') }}
      title={disabled ? '시퀀스에서만 자를 수 있습니다' : '입력한 프레임에서 조각을 자릅니다 (C = 재생헤드에서 자르기)'}>자르기</button>
  )
  const cut = () => {
    const f = Number(val)
    if (!val.trim() || !Number.isInteger(f) || f < 0) { setMsg('0 이상의 정수 프레임을 입력하세요'); return }
    const why = cutAtFrame(getEditor(), f)
    if (why) setMsg(why); else close()
  }
  return (
    <form className="tl-cutform" role="group" aria-label="자르기" onSubmit={ev => { ev.preventDefault(); cut() }}>
      <input autoFocus aria-label="자를 프레임" inputMode="numeric" value={val} onChange={ev => { setVal(ev.target.value); setMsg('') }}
        onKeyDown={ev => { if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); close() } }} onFocus={ev => ev.target.select()} />
      <button type="submit">자르기</button>
      <button type="button" aria-label="자르기 닫기" onClick={close}>✕</button>
      {msg && <span className="tl-cutmsg" role="status">{msg}</span>}
    </form>
  )
}

// 시간·프레임 입력해서 이동(사용자): 현재 시간을 누르면 입력 칸 — 프레임 번호 또는 분:초.프레임, Enter = 이동(0~끝으로 맞춤), Esc·칸 밖 = 취소.
// 재생헤드 고정 중에도 이동(직접 조작), 화면 밖이면 기존 따라가기가 그 위치로 넘김.
function TimeJump({ frame, end }: { frame: number; end: number }) {
  const [val, setVal] = useState<string | null>(null), [msg, setMsg] = useState('')
  const close = () => { setVal(null); setMsg('') }
  if (val === null) return (
    <span className="tl-time">
      <button className="tl-timebtn" aria-label="시간 입력해서 이동" title="눌러서 프레임 번호 또는 분:초.프레임을 입력하면 그 위치로 이동합니다"
        onClick={() => { setVal(formatTimecode(frame)); setMsg('') }}><b>{formatTimecode(frame)}</b></button>
      <span className="tl-dim"> / {formatTimecode(end)}</span>
    </span>
  )
  const go = () => {
    const f = parseTimecode(val)
    if (f === null) { setMsg('프레임 번호 또는 분:초.프레임으로 입력하세요'); return }
    getEditor().getState().setFrame(Math.min(Math.max(f, 0), end))
    close()
  }
  return (
    <form className="tl-cutform" role="group" aria-label="시간 입력" onSubmit={ev => { ev.preventDefault(); go() }}>
      <input autoFocus aria-label="이동할 프레임 또는 시간" placeholder="11192 / 02:25.43" value={val} onChange={ev => { setVal(ev.target.value); setMsg('') }}
        onKeyDown={ev => { if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); close() } }} onFocus={ev => ev.target.select()} onBlur={close} />
      {msg && <span className="tl-cutmsg" role="status">{msg}</span>}
    </form>
  )
}

// 재생 fps (user): frames per second the playback runs at (data stays 60 fps). A menu of presets + 직접 입력 (1~240 integer);
// not 60 = orange, and the wall-clock playback time (frame / fps) shows beside it. Not saved.
function PlayFps({ frame, end }: { frame: number; end: number }) {
  const fps = useEditor(s => s.playFps), st = getEditor().getState()
  const [menu, setMenu] = useState<{ left: number; top: number } | null>(null), [val, setVal] = useState<string | null>(null), [msg, setMsg] = useState('')
  const btn = useRef<HTMLButtonElement>(null), list = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!menu) return
    list.current?.querySelector<HTMLElement>('[aria-checked=true]')?.focus()
    const away = (e: Event) => { if (!list.current?.contains(e.target as Node) && e.target !== btn.current) setMenu(null) }
    document.addEventListener('pointerdown', away); window.addEventListener('resize', away)
    return () => { document.removeEventListener('pointerdown', away); window.removeEventListener('resize', away) }
  }, [menu])
  const pick = (f: number) => { st.setPlayFps(f); setMenu(null); btn.current?.focus() }
  const opts = PLAY_FPS_PRESETS.includes(fps) ? PLAY_FPS_PRESETS : [...PLAY_FPS_PRESETS, fps] // a typed value shows at the end, checked
  const go = () => {
    const f = val === null ? null : parsePlayFps(val)
    if (f === null) { setMsg(`${PLAY_FPS_MIN}~${PLAY_FPS_MAX} 사이 정수로 입력하세요`); return }
    st.setPlayFps(f); setVal(null); setMsg('')
  }
  const onMenuKey = (e: React.KeyboardEvent) => {
    const its = [...list.current!.querySelectorAll<HTMLElement>('[role^=menuitem]')], i = its.indexOf(document.activeElement as HTMLElement)
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setMenu(null); btn.current?.focus() }
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); its[(i + (e.key === 'ArrowDown' ? 1 : its.length - 1)) % its.length]?.focus() }
    else if (e.key === 'Tab') setMenu(null)
  }
  if (val !== null) return (
    <form className="tl-cutform" role="group" aria-label="재생 fps 입력" onSubmit={ev => { ev.preventDefault(); go() }}>
      <input autoFocus aria-label="초당 재생 프레임 수" inputMode="numeric" value={val} onChange={ev => { setVal(ev.target.value); setMsg('') }}
        onKeyDown={ev => { if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); setVal(null); setMsg('') } }}
        onFocus={ev => ev.target.select()} onBlur={() => { setVal(null); setMsg('') }} /><span className="tl-dim">fps</span>
      {msg && <span className="tl-cutmsg" role="status">{msg}</span>}
    </form>
  )
  return (
    <>
      <button ref={btn} className={fps === DATA_FPS ? 'tl-playfps' : 'tl-playfps on'} aria-haspopup="menu" aria-expanded={!!menu}
        title="초당 재생 프레임 수 — 보는 속도만 바뀌고 데이터·CSV는 60fps 그대로입니다"
        onClick={() => { if (menu) { setMenu(null); return } const r = btn.current!.getBoundingClientRect(); setMenu({ left: r.left, top: r.bottom + 2 }) }}>
        재생 {fps}fps <i aria-hidden="true">▾</i>
      </button>
      {fps !== DATA_FPS && <span className="tl-playtime" title={`${fps}fps로 재생할 때 실제로 걸리는 시간`}>재생 {playTime(frame, fps)} / {playTime(end, fps)}</span>}
      {menu && (
        <div ref={list} role="menu" aria-label="재생 fps" className="tl-menu" style={{ left: menu.left, top: menu.top, minWidth: 110 }} onKeyDown={onMenuKey}>
          {opts.map(f => (
            <button key={f} role="menuitemradio" aria-checked={f === fps} tabIndex={-1} className={f === fps ? 'cur' : undefined} onClick={() => pick(f)}>
              <span className="tl-check" aria-hidden="true">{f === fps ? '✓' : ''}</span>{f}fps{f === DATA_FPS ? ' (원래 속도)' : ''}
            </button>
          ))}
          <button role="menuitem" tabIndex={-1} onClick={() => { setMenu(null); setVal(String(fps)); setMsg('') }}>
            <span className="tl-check" aria-hidden="true" />직접 입력…
          </button>
        </div>
      )}
    </>
  )
}

// 클립 편집 모드 bar: path back to the sequence, 원본 보기 (held), 겹쳐 보기 (원본 ghost), CSV 저장 (the clip as edited).
function ClipEditBar({ clipId, name }: { clipId: string; name: string }) {
  const st = getEditor().getState(), overlay = useEditor(s => s.compareOverlay), peek = useEditor(s => s.clipPeek)
  const n = useEditor(s => curveKeyCount(s.project.clips[clipId]?.offset)), draft = useEditor(s => s.clipEditDraft === clipId)
  const [msg, setMsg] = useState('')
  const saveCsv = async () => {
    const s = getEditor().getState()
    try {
      const { name: file, text, warnings } = exportClipCsv(s.project, s.defs, clipId)
      if (warnings.length && !window.confirm(`경고 ${warnings.length}개가 있습니다 (관절 한계·속도·루트). 그래도 저장할까요?`)) return
      setMsg((await saveCsvFile(file, text)) ? 'CSV를 저장했습니다' : '')
    } catch (err) { setMsg(`저장 실패: ${err instanceof Error ? err.message : err}`) }
  }
  // RL 학습용 저장 (RL팀): the whole clip with its edits, original coordinates, no 기본자세, + edits.json (two downloads)
  const saveRl = async () => {
    const s = getEditor().getState()
    try {
      const r = rlClipExport(s.project, s.defs, clipId)
      const err = r.warnings.filter(w => w.kind === 'jointJumpError'), jump = r.warnings.filter(w => w.kind === 'jointJump'), near = jump.filter(w => w.near)
      if (err.length && !window.confirm(`관절 점프 오류(50 rad/s 초과, IK 해 뒤집힘 의심)가 ${err.length}개 있습니다 (첫 프레임 ${err[0].frame}). 학습할 수 없는 데이터일 수 있습니다. 그래도 저장할까요?`)) return
      await writeTextFiles(null, [{ name: r.name, text: r.text }, r.json])
      setMsg(`${r.name}와 edits.json을 내려받았습니다 · 수정 구간 ${r.ranges.length}개`
        + (jump.length ? ` · 관절 점프 ${jump.length}개${near.length ? ` (이음매 근처 ${near.length}개: 프레임 ${near.slice(0, 3).map(w => w.frame).join(', ')}${near.length > 3 ? '…' : ''})` : ''}` : ''))
    } catch (err) { setMsg(`저장 실패: ${err instanceof Error ? err.message : err}`) }
  }
  const hold = (on: boolean) => () => st.setClipPeek(on)
  return (
    <span className="tl-crumb tl-clipedit" role="group" aria-label="클립 편집">
      <button onClick={() => st.closeClipEdit()} title="시퀀스로 돌아갑니다 (Esc)">시퀀스로</button>
      <span> ▸ 목록 ▸ {name} <span className="tl-dim">(클립 편집{n ? ` · 수정 키 ${n}개` : ''})</span></span>
      <button aria-pressed={peek} onPointerDown={hold(true)} onPointerUp={hold(false)} onPointerLeave={hold(false)}
        onKeyDown={ev => { if (ev.key === ' ' || ev.key === 'Enter') { ev.preventDefault(); st.setClipPeek(true) } }} onKeyUp={hold(false)} onBlur={hold(false)}
        title="누르고 있는 동안 수정 전 원본을 보여 줍니다">원본 보기</button>
      <button aria-pressed={overlay} onClick={() => st.setCompareOverlay(!overlay)} title="수정 전 원본을 반투명으로 겹쳐 보여 줍니다">겹쳐 보기</button>
      {draft && <button onClick={() => st.cancelDraftClip()} title="라이브러리 미리보기에서 넣은 이 클립을 목록에서 빼고 나갑니다 (실행취소로 되돌릴 수 있음)">추가 취소</button>}
      <button onClick={saveRl} title="RL 학습용: 수정이 반영된 전체 CSV를 원본 좌표 그대로(이동·회전 없음) 저장하고, 수정한 프레임 구간 edits.json을 함께 내려받습니다">RL 학습용 저장</button>
      <button className="tl-primary" onClick={saveCsv} title="수정한 클립을 CSV로 저장합니다 (기본자세·리드인 없이, 루트 로컬)">CSV 저장</button>
      {msg && <span className="tl-cutmsg" role="status">{msg}</span>}
    </span>
  )
}

// Transport controls sit with the timeline they drive; the breadcrumb shows only in clip view.
function TimelineHeader() {
  const playing = useEditor(s => s.playing), frame = useEditor(s => s.frame)
  const end = useEditor(s => sequenceEnd(s.project))
  const view = useEditor(s => s.view)
  const project = useEditor(s => s.project), editing = useEditor(s => s.editing), clipEdit = useEditor(s => s.clipEdit)
  const st = getEditor().getState()
  const e = editing || clipEdit ? editingItem({ project, editing, clipEdit }) : null
  const actor = e && actorOf({ project, clipEdit }, e.actorId)
  const clipView = !!editing || !!clipEdit
  const shownEnd = clipEdit && e ? e.clip.length : end
  const progress = usePhysics(s => s.progress), loading = usePhysics(s => s.loading)
  const anyDone = usePhysics(s => Object.values(s.byItem).some(v => v.status === 'done'))
  return (
    <div className="tl-head">
      <button className="tl-play" onClick={() => st.setPlaying(!playing)} aria-label={playing ? '정지' : '재생'} title="재생 / 정지 (Space)">
        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
          {playing ? <path d="M2.5 1.5h2.5v9H2.5zM7 1.5h2.5v9H7z" fill="currentColor" /> : <path d="M3 1.2v9.6L10.6 6z" fill="currentColor" />}
        </svg>
      </button>
      <TimeJump frame={frame} end={shownEnd} />
      <span className="tl-fps">60 fps</span>
      <PlayFps frame={frame} end={shownEnd} />
      <span className="tl-sep" aria-hidden="true" />
      <CutControl disabled={clipView} />
      <span className="tl-seg" role="group" aria-label="클립 보기" title={clipView ? '클립 보기 방식 (Tab)' : '클립을 열면 고를 수 있습니다'}>
        <button aria-pressed={view === 'tracks'} disabled={!clipView} onClick={() => st.setView('tracks')}>트랙</button>
        <button aria-pressed={view === 'graph'} disabled={!clipView} onClick={() => st.setView('graph')}>그래프</button>
      </span>
      {clipEdit && e && <ClipEditBar clipId={clipEdit} name={e.clip.name} />}
      {e && !clipEdit && (
        <span className="tl-crumb">
          <button onClick={() => st.closeItem()}>시퀀스</button>
          <span> ▸ {actor?.name} / {e.clip.name}</span>
        </span>
      )}
      {(progress || loading) && (
        <span className="tl-phys" role="status">
          {loading ? '물리 엔진 불러오는 중…' : `물리 검증 ${progress!.done + 1}/${progress!.total} · ${Math.round(progress!.cur * 100)}%`}
          <button onClick={cancelAll}>취소</button>
        </span>
      )}
      {anyDone && !progress && !loading && <span className="tl-note" title="물리 검증 배지·그래프는 MuJoCo로 계산한 참고값입니다">ⓘ {PHYS_NOTE}</span>}
    </div>
  )
}

export default function Timeline() {
  const view = useEditor(s => s.view), editing = useEditor(s => s.editing), clipEdit = useEditor(s => s.clipEdit)
  const project = useEditor(s => s.project)
  const e = editing || clipEdit ? editingItem({ project, editing, clipEdit }) : null
  return (
    <div className="tl-wrap">
      <TimelineHeader />
      {!editing && !clipEdit ? <SequenceCanvas /> : (
        <div className="tl-body" onDragOver={ev => { if (!clipEdit && isAssetDrag(ev.dataTransfer)) ev.preventDefault() }}
          onDrop={ev => { const a = clipEdit ? null : draggedAsset(ev.dataTransfer); if (a) { ev.preventDefault(); dropAssetInClipView(a) } }}>
          {view === 'tracks' ? <TrackCanvas /> : <GraphCanvas />}
          {e && editing && clipLocked(project, e.clip.id) && <div className="seq-msg" role="status" style={{ left: 164, top: 28 }}>잠긴 트랙입니다</div>}
        </div>
      )}
    </div>
  )
}
