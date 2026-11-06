import { useEffect, useRef, useState } from 'react'
import { fetchRobotDef } from './robot/loadRobot'
import { getEditor, gizmoLock, initEditor, useEditor } from './store/store'
import Inspector from './inspector/Inspector'
import Stage from './viewer/Stage'
import StagePanes from './viewer/StagePanes'
import ProjectPanel from './project/ProjectPanel'
import Timeline from './timeline/Timeline'
import ExportDialog from './export/ExportDialog'
import { startTransport } from './transport'
import { onMessage, onShowHub } from './projectActions'
import FileMenu from './FileMenu'
import ReviewDialog from './review/ReviewDialog'
import PhysicsDialog from './physics/PhysicsDialog'
import { usePhysics } from './physics/physicsStore'
import { stale } from './physics/runItem'
import CsvFpsDialog from './project/CsvFpsDialog'
import StartScreen from './StartScreen'
import { MENUBAR_H, layoutBounds, useLayout, type Layout } from './layout/useLayout'
import { tv } from './timeline/viewState'

export function CrossfadeHint() {
  const lock = useEditor(gizmoLock)
  return lock === 'crossfade' ? <div className="stage-hint hi">크로스페이드 구간에서는 클립 보기에서 편집하세요</div>
    : lock === 'stitch' ? <div className="stage-hint hi">이 프레임의 루트 위치·방향은 앞 클립 끝에 맞춰집니다</div>
    : lock === 'compare' ? <div className="stage-hint hi">이 조각은 오른쪽 클립 프리뷰에서 관절을 눌러 고치세요</div>
    : lock === 'clipRoot' ? <div className="stage-hint hi">클립 편집에서는 루트를 패널 숫자로 고치세요</div> : null
}

function Menubar() {
  const st = useEditor(s => s)
  const [exporting, setExporting] = useState(false)
  const [physicsOpen, setPhysicsOpen] = useState(false)
  const [reviewOpen, setReviewOpen] = useState(false) // 검수 목록 (§12)
  const name = useEditor(s => s.fileName ?? 'Motion Editor'), dirty = useEditor(s => s.dirty)
  const [msg, setMsg] = useState('')
  const title = name + (dirty ? ' •' : '')
  useEffect(() => { document.title = title }, [title])
  useEffect(() => {
    if (!dirty) return
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = '' }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty])
  useEffect(() => {
    let t: number | undefined
    const off = onMessage(m => { setMsg(m); clearTimeout(t); t = window.setTimeout(() => setMsg(''), 3000) })
    return () => { off(); clearTimeout(t) }
  }, [])
  return (
    <>
      <FileMenu onExport={() => setExporting(true)} onPhysics={() => setPhysicsOpen(true)} />
      <button className="mb-review" onClick={() => setReviewOpen(true)} title="모션의 튀는 관절(로봇 속도 한계 초과·급변)과 자가충돌을 모아 보고 판정합니다">⚠ 검수 목록</button>
      <span className="mb-title">{title}</span>
      {msg && <span role="status" className="mb-msg">{msg}</span>}
      <PhysicsDialog open={physicsOpen} onClose={() => setPhysicsOpen(false)} />
      <ExportDialog open={exporting} onClose={() => setExporting(false)} />
      <ReviewDialog open={reviewOpen} onClose={() => setReviewOpen(false)} />
    </>
  )
}


const KEY_STEP = 16
/** 6px separator overlaid on a panel boundary. sign: +1 if dragging toward +axis grows the panel, -1 if it shrinks. */
function Resizer({ k, axis, value, min, max, sign, style, label, set, reset }: {
  k: keyof Layout; min: number; max: number; axis: 'x' | 'y'; value: number; sign: 1 | -1; style: React.CSSProperties; label: string
  set: (p: Partial<Layout>, persist?: boolean) => void; reset: (keys: (keyof Layout)[]) => void
}) {
  const drag = useRef<{ p: number; v: number } | null>(null)
  useEffect(() => () => { document.body.style.userSelect = ''; document.body.style.cursor = '' }, [])
  const pos = (e: { clientX: number; clientY: number }) => (axis === 'x' ? e.clientX : e.clientY)
  const end = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return
    drag.current = null
    document.body.style.userSelect = ''; document.body.style.cursor = ''
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
    set({}, true)
  }
  return (
    <div className={`resizer ${axis}`} role="separator" tabIndex={0} aria-label={label}
      aria-orientation={axis === 'x' ? 'vertical' : 'horizontal'} aria-valuenow={value} aria-valuemin={min} aria-valuemax={max} style={style}
      onPointerDown={e => {
        if (e.button !== 0) return
        e.preventDefault() // keep focus off the handle after a drag; Tab still reaches it
        e.currentTarget.setPointerCapture(e.pointerId)
        drag.current = { p: pos(e), v: value }
        document.body.style.userSelect = 'none'; document.body.style.cursor = axis === 'x' ? 'col-resize' : 'row-resize'
      }}
      onPointerMove={e => { if (drag.current) set({ [k]: drag.current.v + sign * (pos(e) - drag.current.p) }) }}
      onPointerUp={end} onPointerCancel={end} onLostPointerCapture={end as never}
      onDoubleClick={() => reset([k])}
      onKeyDown={e => {
        const d = axis === 'x' ? { ArrowRight: 1, ArrowLeft: -1 }[e.key] : { ArrowDown: 1, ArrowUp: -1 }[e.key]
        if (d === undefined) return
        e.preventDefault(); e.stopPropagation(); set({ [k]: value + sign * d * KEY_STEP }, true)
      }} />
  )
}

export default function App() {
  const [status, setStatus] = useState<string>('loading')
  const [layout, setLayout, resetLayout] = useLayout()
  // 프로젝트 팝업: at start (must pick, e2e skips it) and from 메뉴 새 프로젝트·열기 (closable); n remounts it fresh
  const [hub, setHub] = useState<{ n: number; closable: boolean; adding: boolean } | null>(() => {
    try { if (localStorage.getItem('me.noStart') === '1') return null } catch { /* storage blocked: show it */ }
    return { n: 0, closable: false, adding: false }
  })
  useEffect(() => onShowHub(adding => setHub(h => ({ n: (h?.n ?? 0) + 1, closable: true, adding }))), [])

  useEffect(() => {
    Promise.all([fetchRobotDef('g1'), fetchRobotDef('go2')])
      .then(([g1, go2]) => { initEditor({ g1, go2 }); if (import.meta.env.DEV) (window as any).__editor = getEditor(), (window as any).__tv = tv, (window as any).__physics = { usePhysics, stale }; setStatus('ready') })
      .catch(e => setStatus(`로봇 불러오기 실패: ${e instanceof Error ? e.message : e}`))
  }, [])

  useEffect(() => (status === 'ready' ? startTransport() : undefined), [status])

  const bounds = layoutBounds(layout, window.innerWidth, window.innerHeight)
  return (
    <div id="app" style={{ gridTemplateColumns: `${layout.left}px 1fr ${layout.right}px`, gridTemplateRows: `${MENUBAR_H}px 1fr ${layout.bottom}px` }}>
      <header id="menubar">{status === 'ready' ? <Menubar /> : 'Motion Editor'}</header>
      <aside id="project">{status === 'ready' && <ProjectPanel />}</aside>
      {status === 'ready' && <CsvFpsDialog />}
      {status === 'ready' && hub && <StartScreen key={hub.n} closable={hub.closable} adding={hub.adding} onDone={() => setHub(null)} />}
      <main id="stage">
        {status === 'ready'
          ? <StagePanes robot={<div className="stage-3d"><CrossfadeHint /><Stage /></div>} />
          : <div className="stage-3d">{status === 'loading' ? '로봇 불러오는 중…' : status}</div>}
      </main>
      <aside id="inspector">{status === "ready" && <Inspector />}</aside>
      <section id="timeline">{status === 'ready' && <Timeline />}</section>
      <Resizer k="left" axis="x" sign={1} label="프로젝트 패널 너비" value={layout.left} min={bounds.left[0]} max={bounds.left[1]} set={setLayout} reset={resetLayout}
        style={{ left: layout.left - 3, top: MENUBAR_H, bottom: layout.bottom }} />
      <Resizer k="right" axis="x" sign={-1} label="인스펙터 너비" value={layout.right} min={bounds.right[0]} max={bounds.right[1]} set={setLayout} reset={resetLayout}
        style={{ right: layout.right - 3, top: MENUBAR_H, bottom: layout.bottom }} />
      <Resizer k="bottom" axis="y" sign={-1} label="타임라인 높이" value={layout.bottom} min={bounds.bottom[0]} max={bounds.bottom[1]} set={setLayout} reset={resetLayout}
        style={{ left: 0, right: 0, bottom: layout.bottom - 3 }} />
    </div>
  )
}
