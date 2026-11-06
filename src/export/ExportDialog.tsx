import { useEffect, useMemo, useRef, useState } from 'react'
import { useEditor } from '../store/store'
import { formatTimecode } from '../timeline/timeScale'
import { downloadBlob, pickDirectory, writeTextFiles } from '../fileio'
import { zip } from './zip'
import { exportItemCsv, itemFrameRange } from './csv'
import { rlItemExport } from './rlExport'
import { needsRun, physicsWarnings } from './physicsWarn'
import { usePhysics } from '../physics/physicsStore'
import { runItems } from '../physics/runItem'
import { pieceName, projectTitle } from '../model/sequence'
import { seqFocus } from '../timeline/viewState'
import { openProblems, splitWarnings } from '../review/verdicts'
import { redWalks } from '../model/itemClip'

const Spin = () => <span className="spin" aria-hidden="true" />
const tick = () => new Promise<void>(r => setTimeout(r, 0)) // let the dialog repaint between items (a long export froze the page)
type Row = { actor: { id: string; name: string; robot: string }; item: import('../model/types').Item; t: import('../model/types').Track }
type W = ReturnType<typeof exportItemCsv>['warnings'][number]
// '검수 미해결': a 문제 있음 verdict (검수 목록, §13) that a fresh check still finds on the piece
// '걷기 한계 초과' (§22): a 걷기 piece that stands instead of walking — not exported until it is fixed
type CsvWarn = Omit<W, 'kind'> & { kind: W['kind'] | '검수 미해결' | '걷기 한계 초과'; actorId: string; actorName: string; itemId: string }

export default function ExportDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null)
  const project = useEditor(s => s.project), defs = useEditor(s => s.defs), title = useEditor(s => projectTitle(s.fileName))
  const setFrame = useEditor(s => s.setFrame), select = useEditor(s => s.select), selectItem = useEditor(s => s.selectItem)
  const openItemPreview = useEditor(s => s.openItemPreview), setPreviewFrame = useEditor(s => s.setPreviewFrame)
  const [msg, setMsg] = useState('')
  const [dir, setDir] = useState<FileSystemDirectoryHandle | null>(null) // 다운로드 폴더: kept while the app runs, null = the browser's
  const [skip, setSkip] = useState(false) // 물리 검증 건너뛰기 (dialog state only)
  const [rl, setRl] = useState(false) // RL 학습용: 원본 좌표 · 기본자세 제외 · edits.json (dialog state only, the usual export unchanged)
  const [exporting, setExporting] = useState<{ key: string; done: number; total: number } | null>(null) // the export in progress: its button shows it
  const [csvWarns, setCsvWarns] = useState<CsvWarn[] | null>(null) // CSV checks: worked out after the dialog shows (null = 검사 중)
  const [okWarns, setOkWarns] = useState<CsvWarn[]>([]) // speed / jump warnings inside 안무여서 놔둠 ranges (§13): listed apart, not counted
  const phys = usePhysics(s => s.byItem), prog = usePhysics(s => s.progress), loading = usePhysics(s => s.loading)

  useEffect(() => {
    const d = ref.current
    if (!d) return
    if (open && !d.open) { setMsg(''); d.showModal() }
    if (!open && d.open) d.close()
  }, [open])

  const rows = useMemo(() => project.sequence.tracks.flatMap(t => {
    const actor = project.actors.find(a => a.id === t.actorId)
    return actor && t.kind === 'motion' ? t.items.map(item => ({ actor, item, t })) : []
  }), [project])
  const groups = (['g1', 'go2'] as const).map(robot => ({ robot, rows: rows.filter(r => r.actor.robot === robot) })).filter(g => g.rows.length)

  // which items need a physics run: each check builds that item's CSV, so one item per tick after the dialog shows (all at once
  // froze the page on 내보내기, user); the boxes show 확인 중 until it is done
  const [scanning, setScanning] = useState(true) // true from the first render the dialog shows (a stale result never flashes)
  useEffect(() => {
    if (!open) { setScanning(true); return } // ready for the next open
    if (skip) { setScanning(false); return }
    let live = true
    setScanning(true)
    void (async () => {
      const todo: { actorId: string; itemId: string }[] = []
      for (const { actor, item } of rows) {
        await tick()
        if (!live) return
        if (needsRun(project, defs, actor.id, item.id, usePhysics.getState().byItem[item.id])) todo.push({ actorId: actor.id, itemId: item.id })
      }
      if (!live) return
      for (const t of todo) { await tick(); if (!live) return; void runItems([t]) } // queued first (each builds its CSV: one per tick), so a stale result never shows its warnings
      setScanning(false)
    })()
    return () => { live = false }
  }, [project, defs, open, skip, rows]) // not phys: a finished run does not need a new scan (and would flash 확인 중)
  const busy = (rs: typeof rows) => open && !skip && (scanning || rs.some(({ item }) => ['queued', 'running'].includes(phys[item.id]?.status)))
  const running = busy(rows)

  // the CSV checks build every item's CSV: one item per tick after the dialog shows, so opening it does not freeze
  useEffect(() => {
    if (!open) return
    let live = true
    setCsvWarns(null)
    void (async () => {
      const out: CsvWarn[] = [], ok: CsvWarn[] = []
      for (const { actor, item } of rows) {
        await tick()
        if (!live) return
        const who = { actorId: actor.id, actorName: actor.name, itemId: item.id }
        const sp = splitWarnings(project, item, (rl ? rlItemExport : exportItemCsv)(project, defs, actor.id, item.id).warnings)
        out.push(...sp.kept.map(w => ({ ...w, ...who })), ...openProblems(project, defs, item).map(o => ({ kind: '검수 미해결' as const, frame: o.frame, channel: '',
          message: `검수 목록에서 문제 있음으로 판정한 지점에 아직 튐이 있습니다 (클립 f${o.verdict.from}${o.verdict.to > o.verdict.from ? `~f${o.verdict.to}` : ''})`, ...who })))
        ok.push(...sp.ok.map(w => ({ ...w, ...who })))
        out.push(...redWalks(project, defs, [item.id]).map(r => ({ kind: '걷기 한계 초과' as const, frame: item.start, channel: '', message: `걷지 않고 서 있음 — ${r.text} (고치기 전에는 내보내지 않음)`, ...who })))
      }
      if (live) { setCsvWarns(out); setOkWarns(ok) }
    })()
    return () => { live = false }
  }, [project, defs, open, rows, rl])
  // physics warnings only once the scan has queued what is stale: before that a stale result's warnings would show
  const warnings = useMemo(() => [...(csvWarns ?? []), ...(open && !skip && !scanning ? rows.flatMap(({ actor, item }) =>
    physicsWarnings(project, defs, item, phys[item.id]).map(w => ({ ...w, actorId: actor.id, actorName: actor.name, itemId: item.id }))) : [])],
  [csvWarns, project, defs, open, skip, phys, rows, scanning])
  // rs: one box's items (its own count, user: GO2 with one item showed the whole queue's 20/21); none = every item
  const physLabel = (rs = rows) => {
    if (scanning && !prog) return '물리 검증 확인 중'
    if (loading) return '물리 엔진 불러오는 중'
    const left = rs.filter(({ item }) => ['queued', 'running'].includes(phys[item.id]?.status)).length
    return `물리 검증 중 ${Math.min(rs.length - left + 1, rs.length)}/${rs.length}`
  }

  async function choose() {
    try { const d = await pickDirectory(); if (d) setDir(d) } catch (e) { setMsg(`폴더 선택 실패: ${e instanceof Error ? e.message : e}`) }
  }
  // one robot's items (G1 / GO2 내보내기) or one item (row 내보내기) into the 다운로드 폴더: label prefixes the message, zipName names the zip
  async function doExport(rs: Row[], key: string, zipName = 'motion_export.zip', label = '') {
    if (exporting) return
    const red = redWalks(project, defs, rs.map(r => r.item.id)) // §22 안정성 우선: no 한계 초과 walk goes out (CSV or RL 학습용)
    if (red.length) { setMsg(`${label}내보내지 않았습니다 — 한계 초과 걷기 ${red.length}개 (경고 목록에서 눌러 고칠 곳으로 이동)`); return }
    setExporting({ key, done: 0, total: rs.length })
    try {
      const taken = new Set<string>(), files: { name: string; text: string }[] = []
      let errors = 0
      let open = 0 // 검수 미해결 (§13)
      for (const { actor, item } of rs) {
        await tick()
        open += openProblems(project, defs, item).length
        if (rl) { // RL 학습용: the piece's own frames in original coordinates + its edits.json
          const r = rlItemExport(project, defs, actor.id, item.id, taken, title)
          files.push({ name: r.name, text: r.text }, r.json)
          errors += splitWarnings(project, item, r.warnings).kept.filter(w => w.kind === 'jointJumpError').length // 안무여서 놔둠 ranges not asked about
        } else {
          const { name, text } = exportItemCsv(project, defs, actor.id, item.id, taken, title)
          files.push({ name, text })
        }
        setExporting({ key, done: rl ? files.length / 2 : files.length, total: rs.length })
      }
      await tick()
      if (open && !window.confirm(`검수 목록에서 문제 있음으로 판정한 지점 중 아직 해결되지 않은 곳이 ${open}개 있습니다. 그래도 내보낼까요?`)) return
      // RL 학습용: ask only for 관절 점프 오류 (> 50 rad/s, an IK flip); the 25 rad/s ones are shown in the list, not asked about
      if (errors && !window.confirm(`관절 점프 오류(50 rad/s 초과, IK 해 뒤집힘 의심)가 ${errors}개 있습니다. 학습할 수 없는 데이터일 수 있습니다. 그래도 내보낼까요?`)) return
      const what = rl ? `CSV ${files.length / 2}개와 edits.json ${files.length / 2}개` : `CSV ${files.length}개`
      // No folder picked and several files: one zip download instead of a download per file.
      if (!dir && files.length > 1) {
        downloadBlob(zipName, new Blob([zip(files)], { type: 'application/zip' }))
        setMsg(`${label}${what}를 zip으로 내보냈습니다.`)
      } else {
        await writeTextFiles(dir, files)
        setMsg(`${label}${what}를 ${dir ? `${dir.name} 폴더에 ` : ''}내보냈습니다.`)
      }
    } catch (e) { setMsg(`내보내기 실패: ${e instanceof Error ? e.message : e}`) }
    finally { setExporting(null) }
  }
  const exportLabel = (key: string, idle: string) => exporting?.key === key ? <><Spin /> 내보내는 중… {exporting.done}/{exporting.total}</> : idle

  return (
    <dialog ref={ref} className="exp" onClose={onClose} aria-label="내보내기" aria-busy={!!exporting}
      onCancel={e => { if (exporting) e.preventDefault() }}>{/* Esc waits for the export to finish */}
      <h2>내보내기</h2>
      <div className="exp-row exp-opts">
        {/* a browser gives the folder's name only, never its full path */}
        <span className="exp-dim exp-dir" title={dir ? dir.name : '브라우저의 기본 다운로드 폴더'}>다운로드 폴더: {dir ? dir.name : '브라우저 기본 다운로드 폴더'}</span>
        <button onClick={choose} disabled={!!exporting}>다운로드 폴더 선택</button>
        {dir && <button onClick={() => setDir(null)} title="브라우저 기본 다운로드 폴더로 되돌립니다">기본으로</button>}
      </div>
      <div className="exp-row exp-rlopt">
        <label className="exp-check" title="원본 CSV 좌표 그대로(이동·회전·무대 배치 없음, 루트 수정은 포함) · 기본자세(리드인·끝 기본자세) 제외 · CSV마다 수정 구간 edits.json 함께 저장 · 관절 점프 검사">
          <input type="checkbox" checked={rl} disabled={!!exporting} onChange={e => setRl(e.target.checked)} /> RL 학습용 (원본 좌표 · 기본자세 제외 · edits.json)
        </label>
      </div>
      <div className="exp-items">
        {groups.map(g => {
          const R = g.robot.toUpperCase()
          return <fieldset key={g.robot} role="group" aria-label={R} className="exp-box">
          <legend className="exp-group">{R}</legend>
          {/* on the box's top line at its far end, like the legend at its start */}
          <button className="exp-all" disabled={busy(g.rows) || !!exporting} onClick={() => doExport(g.rows, g.robot, `${g.robot}_export.zip`, `${R} `)}
            title={`${R} 항목을 모두 내보냅니다`} aria-label={`${R} 내보내기`}>{busy(g.rows) ? <><Spin /> {physLabel(g.rows)}</> : exportLabel(g.robot, `${R} 내보내기`)}</button>
          <div className="exp-list">
          {g.rows.map(r => {
          const { actor, item, t } = r, { from, to } = itemFrameRange(item)
          return (
            <div key={item.id} className="exp-row exp-item">
              <span>{actor.name} · {pieceName(t, item, project.clips[item.refId], title)}</span>
              <span className="exp-dim">{formatTimecode(from)}–{formatTimecode(to)} · {to - from}프레임</span>
              {busy([r]) ? <span className="exp-one-spin" title="물리 검증 중"><Spin /></span>
                : <button className={'exp-one' + (exporting?.key === item.id ? ' on' : '')} disabled={!!exporting} onClick={() => doExport([r], item.id)} title="이 항목만 내보냅니다" aria-label="내보내기">{exportLabel(item.id, '내보내기')}</button>}
            </div>
          )
        })}
          </div>
        </fieldset>})}
      </div>
      <div className="exp-row exp-sub-row">
        <h3 className="exp-sub">물리 검증 목록{(csvWarns === null || running) && <span className="exp-dim exp-checking"><Spin /> {csvWarns === null ? '검사 중…' : physLabel()}</span>}</h3>
        <label className="exp-check"><input type="checkbox" checked={skip} onChange={e => setSkip(e.target.checked)} /> 물리 검증 건너뛰기</label>
      </div>
      {!skip && rows.map(({ actor, item }) => ({ actor, item, st: phys[item.id] })).filter(r => r.st?.status === 'error').map(({ actor, item, st }) => (
        <div key={item.id} className="exp-dim">물리 검증 생략: {actor.name} · {project.clips[item.refId]?.name} ({st?.message})</div>
      ))}
      {warnings.length > 0 && (
        <ul className="exp-warn" aria-label="경고">
          {warnings.map((w, i) => (
            <li key={i} className={w.near ? 'near' : w.kind === 'jointJumpError' || w.kind === '검수 미해결' || w.kind === '걷기 한계 초과' ? 'err' : undefined}><button onClick={() => { // that piece: selected, its clip preview looping from the warning's frame (user)
              setFrame(w.frame); select(w.actorId, w.channel); selectItem(w.itemId); openItemPreview(w.itemId, true); setPreviewFrame(w.frame); seqFocus.fn?.(w.itemId); onClose() }}>
              {w.actorName} · {w.kind} · {w.frame} · {w.channel} · {w.message}
            </button></li>
          ))}
        </ul>
      )}
      {okWarns.length > 0 && (
        <details className="exp-ok">
          <summary className="exp-dim">안무로 둔 지점 {okWarns.length}건 — 검수 목록에서 안무여서 놔둠으로 판정해 경고에서 뺐습니다</summary>
          <ul className="exp-warn" aria-label="안무로 둔 지점">
            {okWarns.map((w, i) => <li key={i} className="ok"><span>{w.actorName} · {w.kind} · {w.frame} · {w.channel} · {w.message}</span></li>)}
          </ul>
        </details>
      )}
      <div className="exp-row exp-foot">
        <p role="status" className="exp-dim exp-msg">{msg}</p>
        <button className="exp-close" onClick={onClose} disabled={!!exporting} title={exporting ? '내보내기가 끝나면 닫을 수 있습니다' : undefined}>닫기</button>
      </div>
    </dialog>
  )
}
