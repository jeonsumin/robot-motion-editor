import { useEffect, useMemo, useRef, useState } from 'react'
import { parseCsvPoses } from '../export/importCsv'
import type { Pose } from '../model/pose'
import type { Clip } from '../model/types'
import { BLOCK_PREVIEW_ID, getEditor, trackLocked, useEditor } from '../store/store'
import { blockUrl, GO2_BLOCKS, type Block } from './blocks'
import { blockActual, buildBlockClip, emptyClipFor } from './build'

export type Template = { fps: number; poses: Pose[] }
// One fetch per block; a failed load is dropped so picking the block again retries.
const cache = new Map<string, Promise<Template>>()
const loaded = new Map<string, Template>()
/** The template if it has already loaded (a library row dragged to the timeline needs it synchronously). */
export const cachedTemplate = (id: string) => loaded.get(id)
export function loadTemplate(id: string): Promise<Template> {
  let p = cache.get(id)
  if (!p) {
    p = fetch(blockUrl(id))
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.text() })
      .then(text => parseCsvPoses(text, getEditor().getState().defs, undefined))
    p.then(t => loaded.set(id, t), () => cache.delete(id))
    cache.set(id, p)
  }
  return p
}

// Why the real value differs from the typed one: the clip is the real log's start + stop parts plus whole repeated steps.
// The values a loop block can really make (user: no 1 m / 100° in the list when the log cannot do it): whole steps n = 1..STEPS,
// per direction (Rotate: 좌 then 우). Each option's value lands exactly on its n (blockActual rounds to the nearest step).
const STEPS = 20
export const stepOptions = (b: Block, poses: Template['poses']): { v: string; label: string }[] =>
  b.kind !== 'loop' ? [] : (b.param === 'degrees' ? [1, -1] : [1]).flatMap(sg => {
    const one = blockActual(b, poses, sg)!
    return Array.from({ length: STEPS }, (_, k) => {
      const v = sg * (Math.abs(one.base) + (k + 1) * Math.abs(one.per)), a = blockActual(b, poses, v)!
      return { v: String(v), label: b.param === 'meters' ? `${a.actual.toFixed(2)} m (${a.n}걸음)` : `${sg > 0 ? '좌' : '우'} ${Math.round(Math.abs(a.actual))}° (${a.n}걸음)` }
    })
  })

// The step list: a button and a list of at most ~8 rows that scrolls (a native <select> popup can't be sized and ran over the
// window, user). The list floats over the page (fixed, under the button or above it when there is no room): the dialog keeps its
// size and does not clip it. ↑/↓ change the value, Esc / a click outside closes the list.
function StepPicker({ options, value, onChange }: { options: { v: string; label: string }[]; value: string; onChange: (v: string) => void }) {
  const [open, setOpen] = useState(false), [at, setAt] = useState<React.CSSProperties>({})
  const box = useRef<HTMLDivElement>(null), list = useRef<HTMLUListElement>(null)
  const place = () => { // under the button, or above it when the window has no room below
    const r = box.current!.getBoundingClientRect(), h = 216, below = innerHeight - r.bottom - 4 >= h
    setAt({ left: r.left, width: r.width, ...(below ? { top: r.bottom + 2 } : { bottom: innerHeight - r.top + 2 }) })
  }
  useEffect(() => {
    if (!open) return
    const ul = list.current, cur = ul?.querySelector<HTMLElement>('[aria-selected="true"]') // scroll only the list: scrollIntoView would
    if (ul && cur) ul.scrollTop = cur.offsetTop - (ul.clientHeight - cur.offsetHeight) / 2 // also scroll the panel and close it at once
    const away = (e: PointerEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false) }
    const close = () => setOpen(false)
    // a scrolled panel (the 목록 panel scrolls the focused button into view as the list opens): follow the button, don't close
    const follow = (e: Event) => { if (!list.current?.contains(e.target as Node)) place() }
    addEventListener('pointerdown', away); addEventListener('resize', close); addEventListener('scroll', follow, true)
    return () => { removeEventListener('pointerdown', away); removeEventListener('resize', close); removeEventListener('scroll', follow, true) }
  }, [open])
  const i = options.findIndex(o => o.v === value)
  const onKey = (e: React.KeyboardEvent) => {
    const d = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0
    if (d && options.length) { e.preventDefault(); onChange(options[Math.min(Math.max(i + d, 0), options.length - 1)].v) }
    else if (e.key === 'Escape' && open) { e.preventDefault(); e.stopPropagation(); setOpen(false) } // not the dialog's Esc
    else if (e.key === 'Enter' && open) { e.preventDefault(); setOpen(false) }
  }
  return (
    <div className="step-pick" ref={box} onKeyDown={onKey}>
      <button type="button" aria-label="값" aria-haspopup="listbox" aria-expanded={open} disabled={!options.length} onClick={() => { if (!open) place(); setOpen(o => !o) }}>
        <span>{options[i]?.label ?? '불러오는 중…'}</span><i aria-hidden="true">▾</i>
      </button>
      {open && <ul ref={list} role="listbox" aria-label="값 목록" style={at}>
        {options.map(o => <li key={o.v} role="option" aria-selected={o.v === value} onClick={() => { onChange(o.v); setOpen(false) }}>{o.label}</li>)}
      </ul>}
    </div>
  )
}

const stepWhy = (a: { base: number; per: number }, unit: string) => {
  const f = (x: number) => unit === 'm' ? `${Math.abs(x).toFixed(2)}m` : `${Math.round(Math.abs(x))}°`
  return `실제 GO2 로그를 이어 붙여 만듭니다: 시작·멈춤 동작만으로 ${f(a.base)}, 한 걸음마다 ${f(a.per)}. 걸음은 1번 이상 통째로만 넣을 수 있어 가장 작은 값은 ${f(a.base + a.per)}이고, 그 뒤로 ${f(a.per)}씩 커집니다.`
}

export type AddTarget = string | null | 'asset' // a GO2 actor id (its track end), null = a new GO2 actor, 'asset' = 목록에만 추가
export type Added = { actorId: string | null; name: string; reused: boolean }

/** Build the block clip (a loop block at the step value `v`; Empty = the one Empty clip) and add it to `target`. The same block already
 * in 목록 (same name) is used as it is (user). Shared by the 추가 button and the right-click menu. Returns null when nothing was added. */
export function addBlock(block: Block, t: Template | undefined, v: number, target: AddTarget): Added | null {
  const a = blockAsset(block, t, v)
  if (!a) return null
  const st = getEditor().getState(), have = a.clip ? undefined : st.project.clips[a.id], clip = have ?? a.clip!
  if (target === 'asset') { // 목록에만 추가
    if (have) return { actorId: null, name: have.name, reused: true }
    const name = st.addClipAsset(clip); return name ? { actorId: null, name, reused: false } : null
  }
  const itemId = st.appendClip(target, clip)
  const p = getEditor().getState().project, track = itemId ? p.sequence.tracks.find(tr => tr.items.some(i => i.id === itemId)) : null
  return itemId && track?.actorId ? { actorId: track.actorId, name: p.clips[clip.id]?.name ?? clip.name, reused: !!have } : null
}

/** The clip a block makes at `v` (for a drop / an insert that needs the clip itself): the 목록 clip of the same name when there is one. */
export function blockAsset(block: Block, t: Template | undefined, v: number): { kind: 'clip'; id: string; clip?: Clip } | null {
  const st = getEditor().getState(), built = block.kind === 'empty' ? emptyClipFor(st.project.clips, st.defs) : t ? buildBlockClip(block, t.poses, t.fps, v, st.defs) : null
  if (!built) return null
  const have = st.project.clips[built.id] ?? Object.values(st.project.clips).find(c => c.robot === 'go2' && c.name === built.name)
  return have ? { kind: 'clip', id: have.id } : { kind: 'clip', id: built.id, clip: built }
}

/** 라이브러리 미리보기용 클립: 항상 새로 만든 블록 클립(목록의 같은 이름 클립을 쓰지 않음 — 나중에 미세 수정을 얹어도 목록 클립은 그대로),
 * id = BLOCK_PREVIEW_ID. Empty = 30프레임 차렷. */
export function previewClip(block: Block, t: Template | undefined, v: number): Clip | null {
  const { defs } = getEditor().getState(), built = block.kind === 'empty' ? emptyClipFor({}, defs) : t ? buildBlockClip(block, t.poses, t.fps, v, defs) : null
  return built && { ...built, id: BLOCK_PREVIEW_ID }
}

// The 라이브러리 tab's input for the picked block. target: a GO2 actor id (its track end), null = a new GO2 actor, 'asset' = 목록에만
// 추가 (the asset list only, nothing on the sequence). onAdded gets the actor the block went to (null for 목록 only), the clip name and
// whether an existing 목록 clip was used (same name: no new clip, user).
// value / onValue: the chosen step value kept by the list (the right-click menu adds the same value), else kept here.
export default function Go2BlockPanel({ target, blockId, onAdded, value: shared, onValue }: { target: AddTarget; blockId: string; onAdded?: (actorId: string | null, name: string, reused: boolean) => void
  value?: string; onValue?: (v: string) => void }) {
  const locked = useEditor(s => !!target && target !== 'asset' && trackLocked(s.project, target))
  const block = GO2_BLOCKS.find(b => b.id === blockId)!
  const [own, setOwn] = useState('') // a loop block's chosen step value (the first reachable one once its template loads)
  const value = shared ?? own, setValue = (v: string) => { setOwn(v); onValue?.(v) }
  const [tpl, setTpl] = useState<{ id: string; t?: Template; err?: string } | null>(null)

  useEffect(() => {
    let live = true
    setTpl(null)
    if (blockId === 'empty') return // no log to load
    loadTemplate(blockId).then(t => live && setTpl({ id: blockId, t }), (e: Error) => live && setTpl({ id: blockId, err: e.message }))
    return () => { live = false }
  }, [blockId])

  const t = tpl?.id === blockId ? tpl.t : undefined
  const options = useMemo(() => t ? stepOptions(block, t.poses) : [], [t, block])
  useEffect(() => { if (options.length && !options.some(o => o.v === value)) setValue(options[0].v) }, [options, value]) // the smallest by default
  const v = block.kind === 'loop' ? (value.trim() === '' ? NaN : Number(value)) : 0
  const empty = block.kind === 'empty'
  const valid = empty || Number.isFinite(v) && (block.kind !== 'loop' || options.some(o => o.v === value))
  const ready = empty || !!t
  const actual = t && valid ? blockActual(block, t.poses, v) : null
  const unit = block.kind === 'loop' && block.param === 'meters' ? 'm' : '°'

  const add = () => {
    if (!ready || !valid) return
    const r = addBlock(block, t, v, target)
    if (r) onAdded?.(r.actorId, r.name, r.reused)
  }

  return (
    <>
      <h3 className="pp-blk-t">{block.label}</h3>
      {block.kind === 'loop' && (
        <div className="pp-blk-field"><span>{block.param === 'meters' ? '거리' : '각도'}<span className="pp-dim"> · 실제로 갈 수 있는 값만</span></span>{/* a div: a label would re-click the button */}
          <StepPicker options={options} value={value} onChange={setValue} />
        </div>
      )}
      {empty && <p className="pp-dim">기본자세로 서 있는 30프레임. 타임라인에서 막대 끝을 끌어 길이를 바꿉니다.</p>}
      {actual && <p className="pp-dim" role="status">→ 실제 {+actual.actual.toFixed(unit === 'm' ? 2 : 0)}{unit} ({actual.n}회)</p>}
      {actual && <p className="pp-dim pp-why">{stepWhy(actual, unit)}</p>}
      {tpl?.id === blockId && tpl.err && <p className="pp-msg" role="alert" style={{ color: 'var(--warn)' }}>템플릿을 불러오지 못했습니다: {tpl.err}</p>}
      <div className="pp-tools">
        <span className="pp-gap" />
        <button disabled={!ready || !valid || locked} onClick={add}>추가</button>
      </div>
    </>
  )
}
