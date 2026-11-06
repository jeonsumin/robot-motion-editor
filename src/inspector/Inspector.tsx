import { useEffect, useState } from 'react'
import { stageOf } from '../model/defaults'
import { curveKeyCount, offsetKeyCount } from '../model/itemClip'
import { actorOf, clipLocked, editLock, editTarget, getEditor, targetItem, trackLocked, useEditor } from '../store/store'
import JointPanel from '../viewer/JointPanel'
import { sortedItems } from '../model/sequence'
import type { Item, Project } from '../model/types'
import { WalkInspector } from './WalkPanel'

const ROOT = ['root.x', 'root.y', 'root.z', 'root.roll', 'root.pitch', 'root.yaw']

function StageSection() {
  const { project, stageShown } = useEditor(s => s)
  if (!stageShown) return null
  const st = stageOf(project), set = getEditor().getState().setStage
  return (
    <section className="insp-sec">
      <h3 className="insp-sec-t">무대</h3>
      <div className="insp-grid3">
        {([['width', '가로'], ['depth', '깊이']] as const).map(([k, lab]) => (
          <label key={k} className="insp-field"><span className="insp-lab">{lab}</span>
            <span className="insp-unit"><input type="number" aria-label={`무대 ${lab}`} min={1} max={30} step={0.1} key={st[k]} defaultValue={st[k]}
              onBlur={e => { set({ [k]: e.target.valueAsNumber }); e.target.value = String(stageOf(getEditor().getState().project)[k]) }}
              onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur() }} /><i>m</i></span>
          </label>
        ))}
      </div>
      <p className="insp-hint">객석은 +X 쪽입니다</p>
    </section>
  )
}

// 걷기 조각 (§20) of this actor's track: the selected one, else (when no clip piece is the target) the one at the playhead
function walkItem(project: Project, actorId: string, frame: number, selItem: string | null, fallback: boolean): Item | null {
  const track = project.sequence.tracks.find(t => t.kind === 'motion' && t.actorId === actorId)
  if (!track) return null
  const picked = track.items.find(i => i.id === selItem)
  if (picked?.walk) return picked
  if (!fallback) return null
  const items = sortedItems(track)
  const at = items.filter(i => frame >= i.start && frame < i.start + (i.trimOut - i.trimIn)).at(-1) ?? items.filter(i => i.start <= frame).at(-1)
  return at?.walk ? at : null
}

export default function Inspector() {
  const ed = getEditor()
  const { project, frame, sel, editing, clipEdit, selItem } = useEditor(s => s)
  const [lenMsg, setLenMsg] = useState(false)
  const [tol, setTol] = useState(0.001)
  const [simpMsg, setSimpMsg] = useState<{ n: number; at: number } | null>(null)
  useEffect(() => { if (!simpMsg) return; const t = setTimeout(() => setSimpMsg(null), 3000); return () => clearTimeout(t) }, [simpMsg])
  const actor = actorOf({ project, clipEdit }, sel.actorId)
  if (!actor) return <div className="insp"><p className="insp-hint">무대에서 링크를 클릭하거나 타임라인에서 채널을 고르세요.</p><StageSection /></div>
  const clipMode = !!clipEdit // 클립 편집 모드: the open clip on its virtual actor

  const target = editTarget({ project, frame, editing, clipEdit }, actor.id)
  const walk = clipMode ? null : walkItem(project, actor.id, frame, selItem, !target)
  if (walk) return (
    <div className="insp">
      <div className="insp-head">
        <span className="insp-swatch" style={{ background: actor.color }} aria-hidden="true" />
        <b className="insp-title">{actor.name}</b>
        <span className="pp-tag">GO2</span>
      </div>
      <WalkInspector key={walk.id} item={walk} />
      <StageSection />
    </div>
  )
  if (!target) return <div className="insp"><p className="insp-hint">이 액터에 클립이 없습니다.</p><StageSection /></div>
  const { clipId } = target
  const clip = project.clips[clipId]
  const item = targetItem({ project, editing, clipEdit }, target.itemId)!
  const nOffset = clipMode ? curveKeyCount(clip.offset) : offsetKeyCount(item)
  const lockedTrack = clipMode ? false : trackLocked(project, actor.id) || clipLocked(project, clipId) // a clip's 수정 층 is the asset's own

  const channels = sel.channel === 'root' ? ROOT : sel.channel && !sel.channel.startsWith('group:') ? [sel.channel] : []
  const locks = channels.map(ch => editLock({ project, frame, editing, clipEdit }, actor.id, ch))
  const xfade = locks.includes('crossfade')
  const stitch = locks.includes('stitch')

  const act = ed.getState()

  return (
    <div className="insp">
      <div className="insp-head">
        {clipMode ? <span className="insp-swatch" style={{ background: actor.color }} aria-hidden="true" />
          : <label className="insp-swatch" style={{ background: actor.color }} title="로봇 색 바꾸기">
            <input type="color" aria-label="색" value={actor.color} onChange={e => act.setColor(actor.id, e.target.value)} />
          </label>}
        <b className="insp-title">{clipMode ? `${actor.name} (클립 편집)` : actor.name}</b>
        <span className="pp-tag">{actor.robot === 'g1' ? 'G1' : 'GO2'}</span>
      </div>
      {/* edits always go to a 수정 층 (user: only the clip being edited changes): 시퀀스 = this piece, 클립 편집 = this clip */}
      <div className="insp-note">
        <span className="insp-hint">{nOffset ? `${clipMode ? '이 클립' : '이 조각'}의 수정 키 ${nOffset}개` : clipMode ? '원본은 그대로 두고 이 클립에 더합니다' : '원본 클립은 그대로 두고 이 조각에만 더합니다'}</span>
        {nOffset > 0 && (clipMode
          ? <button onClick={() => act.clearClipOffset(clipId)} title="이 클립의 수정을 모두 지우고 원본대로 되돌립니다">수정 지우기</button>
          : <button disabled={lockedTrack} onClick={() => act.clearOffset(item.id)} title="이 조각의 수정을 모두 지우고 원본 클립대로 되돌립니다">수정 지우기</button>)}
      </div>
      {xfade && <p className="insp-hint" role="status">크로스페이드 구간에서는 클립 보기에서 편집하세요</p>}
      {!xfade && stitch && <p className="insp-hint" role="status">이 프레임의 루트 위치·방향은 앞 클립 끝에 맞춰집니다</p>}
      <JointPanel />
      {!clipMode && <section className="insp-sec">
      <h3 className="insp-sec-t">배치</h3>
      <div className="insp-grid3">
        {(['x', 'y', 'yaw'] as const).map(k => (
          <label key={k} className="insp-field"><span className="insp-lab">{k}</span>
            <span className="insp-unit"><input type="number" aria-label={k} step={k === 'yaw' ? 1 : 0.01} disabled={lockedTrack}
              value={k === 'yaw' ? +(actor.placement.yaw * 180 / Math.PI).toFixed(1) : actor.placement[k]}
              onChange={e => {
                const v = e.target.valueAsNumber
                if (Number.isFinite(v)) act.setPlacement(actor.id, { [k]: k === 'yaw' ? v * Math.PI / 180 : v })
              }} /><i>{k === 'yaw' ? '°' : 'm'}</i></span>
          </label>
        ))}
      </div>
      </section>}
      <section className="insp-sec">
      <h3 className="insp-sec-t">클립</h3>
      <label className="insp-field"><span className="insp-lab">이름</span>
        <input aria-label="클립 이름" key={`n${clip.name}`} disabled={lockedTrack} defaultValue={clip.name}
          onBlur={e => act.setClip(clipId, { name: e.target.value })}
          onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur() }} />
      </label>
      <label className="insp-field"><span className="insp-lab">길이<span>{(clip.length / 60).toFixed(2)}초</span></span>
          <span className="insp-unit insp-unit-w"><input type="number" aria-label="길이 (프레임)" min={1} step={1} key={`l${clip.length}`} disabled={lockedTrack} defaultValue={clip.length}
            onBlur={e => {
              if (!act.setClip(clipId, { length: e.target.valueAsNumber })) { setLenMsg(true); setTimeout(() => setLenMsg(false), 3000) }
              e.target.value = String(ed.getState().project.clips[clipId].length) }}
            onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur() }} /><i>프레임</i></span>
      </label>
      <div className="insp-field"><span className="insp-lab" title="이 오차 안에서 곡선 모양을 유지하며 키를 줄입니다">키 줄이기 허용 오차</span>
        <div className="insp-tol">
          <input type="number" aria-label="허용 오차" min={0.00001} step={0.0001} value={tol} onChange={e => setTol(e.target.valueAsNumber)} />
          <button disabled={lockedTrack || !(tol >= 0.00001)} onClick={() => setSimpMsg({ n: act.simplifyClip(clipId, tol, tol), at: Date.now() })}>키 줄이기</button>
        </div>
      </div>
      </section>
      {lockedTrack && <p className="insp-hint" role="status">잠긴 트랙입니다</p>}
      {simpMsg && <p className="insp-hint" role="status">{simpMsg.n > 0 ? `키 ${simpMsg.n}개를 줄였습니다` : '줄일 키가 없습니다'}</p>}
      {lenMsg && <p className="insp-hint" role="status">다른 클립과 겹쳐서 길이를 바꿀 수 없습니다</p>}
      <StageSection />
    </div>
  )
}
