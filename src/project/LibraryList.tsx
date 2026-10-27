import { useEffect, useRef, useState } from 'react'
import Go2BlockPanel, { addBlock, blockAsset, cachedTemplate, loadTemplate, stepOptions, type AddTarget } from '../go2blocks/Go2BlockPanel'
import { GO2_BLOCKS, GO2_FOLDERS, type Block } from '../go2blocks/blocks'
import { buildBlockClip, emptyClipFor } from '../go2blocks/build'
import { getEditor, trackLocked, useEditor } from '../store/store'
import { dropAsset, setDragged } from '../timeline/assetDrop'
import { RowMenu, type Entry as MenuEntry } from './AssetList'

const KIND = { fixed: '고정', meters: '거리', degrees: '각도', empty: '길이' } as const
export const filterBlocks = (query: string) => { const q = query.trim().toLowerCase(); return GO2_BLOCKS.filter(b => b.label.toLowerCase().includes(q)) }

type Entry = { kind: 'dir'; key: string; name: string; n: number; open: boolean } | { kind: 'block'; key: string; b: Block; inDir: boolean }

/** 라이브러리 tab: the GO2 blocks by folder (public/go2-blocks/<folder>, folded until opened; a name filter opens the folders it hits),
 * Empty on top; the picked block's input below. Fixed blocks drag to the timeline once loaded. */
export default function LibraryList({ query }: { query: string }) {
  const [sel, setSel] = useState<string | null>(null)
  const [focus, setFocus] = useState<string | null>(null)
  const [msg, setMsg] = useState('')
  const treeRef = useRef<HTMLDivElement>(null)
  // 붙일 로봇: picked here (a GO2's track end / 'new' = a new GO2 / 'asset' = 목록에만 추가); by default the selected GO2, else the first
  const go2s = useEditor(s => s.project.actors).filter(a => a.robot === 'go2')
  const selGo2 = useEditor(s => s.sel.actorId)
  const [choice, setChoice] = useState<string | null>(null)
  const fallback = (go2s.find(a => a.id === selGo2) ?? go2s[0])?.id ?? 'new'
  const t = choice === 'new' || choice === 'asset' || go2s.some(a => a.id === choice) ? choice! : fallback // a vanished actor falls back
  const target = t === 'new' ? null : t
  const [open, setOpen] = useState<Set<string>>(new Set())
  // a loop block's chosen step value, per block: the 설정 칸 and the right-click menu add the same one (none yet = the smallest)
  const [values, setValues] = useState<Record<string, string>>({})
  const [menu, setMenu] = useState<{ b: Block; x: number; y: number; row: HTMLElement } | null>(null)
  const hits = filterBlocks(query), filtered = !!query.trim()
  const entries: Entry[] = hits.filter(b => !b.folder).map(b => ({ kind: 'block', key: b.id, b, inDir: false }))
  for (const name of GO2_FOLDERS) {
    const bs = hits.filter(b => b.folder === name), o = filtered || open.has(name)
    if (!bs.length) continue
    entries.push({ kind: 'dir', key: `dir:${name}`, name, n: bs.length, open: o })
    if (o) for (const b of bs) entries.push({ kind: 'block', key: b.id, b, inDir: true })
  }
  const shown = entries.flatMap(e => e.kind === 'block' && e.b.kind !== 'empty' ? [e.b.id] : []).join('|') // fixed (drag) and loop (menu value)
  useEffect(() => { for (const id of shown.split('|')) if (id) loadTemplate(id).catch(() => {}) }, [shown]) // a drag fires no click, so load what is shown
  const ids = entries.map(e => e.key)
  const tabStop = focus && ids.includes(focus) ? focus : ids[0]
  const pick = (id: string) => { setSel(id); setFocus(id); setMsg('') }
  const toggle = (name: string, to?: boolean) => setOpen(s => { const n = new Set(s); if (to ?? !n.has(name)) n.add(name); else n.delete(name); return n })
  const goTo = (key: string) => { setFocus(key); treeRef.current?.querySelector<HTMLElement>(`[data-id="${CSS.escape(key)}"]`)?.focus() }

  // 우클릭 메뉴(사용자): 넣을 위치만 고름 — 값은 설정 칸에서 고른 값(없으면 가장 작은 값). The block is picked so the 설정 칸 shows it.
  const stepOf = (b: Block) => { // the value it adds and whether that is the smallest (the default); none while the log loads
    const tp = cachedTemplate(b.id), opts = b.kind === 'loop' && tp ? stepOptions(b, tp.poses) : []
    const o = opts.find(o => o.v === values[b.id]) ?? opts[0]
    return o && { ...o, lowest: o.v === opts[0].v }
  }
  const openMenu = (b: Block, x: number, y: number, row: HTMLElement) => { pick(b.id); setMenu({ b, x, y, row }) }
  const menuHead = (b: Block): string[] => {
    if (b.kind !== 'loop') return [b.label]
    const o = stepOf(b)
    return o ? [`${b.label} · ${o.label}`, ...(o.lowest ? ['최저 값으로 우선 설정'] : [])] : [`${b.label} · 불러오는 중…`]
  }
  const runAdd = async (b: Block, target: AddTarget, front = false) => {
    try {
      const tp = b.kind === 'empty' ? undefined : await loadTemplate(b.id)
      const v = b.kind === 'loop' ? Number(stepOf(b)?.v ?? stepOptions(b, tp!.poses)[0].v) : 0
      const st = getEditor().getState()
      if (target && target !== 'asset' && trackLocked(st.project, target)) { setMsg('잠긴 트랙입니다'); return }
      if (front && target && target !== 'asset') { // 맨 앞에 추가: the same insert as a drop on the first piece's front half (every piece pushed back)
        const track = st.project.sequence.tracks.find(tr => tr.kind === 'motion' && tr.actorId === target), asset = blockAsset(b, tp, v)
        if (!track || !asset) return
        const why = dropAsset(asset, track.id, track.items.length ? Math.min(...track.items.map(i => i.start)) : 0)
        if (why) { setMsg(why); return }
        const s2 = getEditor().getState(), it = s2.project.sequence.tracks.flatMap(tr => tr.items).find(i => i.id === s2.selItem)
        setChoice(target); setMsg(`맨 앞에 추가했습니다: ${(it && s2.project.clips[it.refId]?.name) ?? ''}`)
        return
      }
      const r = addBlock(b, tp, v, target)
      if (!r) { setMsg('추가하지 못했습니다'); return }
      if (r.actorId) { setChoice(r.actorId); setMsg(r.reused ? `목록에 있는 ${r.name}을(를) 붙였습니다` : `추가했습니다: ${r.name}`) }
      else setMsg(r.reused ? `이미 목록에 있습니다: ${r.name} (새로 만들지 않음)` : `목록에 추가했습니다: ${r.name}`)
    } catch (e) { setMsg(`템플릿을 불러오지 못했습니다: ${e instanceof Error ? e.message : e}`) }
  }
  // 로봇마다 이름 한 줄 → 맨 앞 / 맨 뒤 (사용자)
  const menuEntries = (b: Block): MenuEntry[] => [
    ...go2s.map(a => [a.name, [['맨 앞에 추가', () => { runAdd(b, a.id, true) }], ['맨 뒤에 추가', () => { runAdd(b, a.id) }]]] as MenuEntry),
    ['새 GO2 로봇으로 추가', () => { runAdd(b, null) }],
    ['목록에만 추가', () => { runAdd(b, 'asset') }],
  ]

  // ↑↓ the shown rows; on a folder → opens / ← closes; ← on a block in a folder goes to its folder
  const onKey = (e: React.KeyboardEvent, en: Entry) => {
    if (en.kind === 'block' && (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey))) {
      e.preventDefault(); e.stopPropagation()
      const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
      openMenu(en.b, r.left + 8, r.top + 24, e.currentTarget as HTMLElement); return
    }
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault(); e.stopPropagation()
      if (en.kind === 'dir') toggle(en.name, e.key === 'ArrowRight')
      else if (e.key === 'ArrowLeft' && en.b.folder) goTo(`dir:${en.b.folder}`)
      return
    }
    if (en.kind === 'dir' && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); toggle(en.name); return }
    const d = ({ ArrowDown: 1, ArrowUp: -1 } as Record<string, number>)[e.key]
    const n = d && entries[ids.indexOf(en.key) + d]
    if (!n) return
    e.preventDefault(); e.stopPropagation()
    if (n.kind === 'block') pick(n.key)
    goTo(n.key)
  }

  return (
    <>
      <div className="pp-cols" aria-hidden="true"><span>이름</span><span className="pp-col-kind">종류</span></div>
      <div ref={treeRef} role="tree" aria-label="라이브러리" className="pp-tree">
        {entries.map(en => en.kind === 'dir' ? (
          <div key={en.key} role="treeitem" className="pp-row pp-bin" data-kind="blockdir" data-id={en.key} aria-expanded={en.open}
            tabIndex={en.key === tabStop ? 0 : -1} onClick={() => { setFocus(en.key); toggle(en.name) }} onKeyDown={e => onKey(e, en)}>
            <span className="pp-twisty" aria-hidden="true">{en.open ? '▾' : '▸'}</span>
            <span className="pp-name" title={en.name}>{en.name}</span>
            <span className="pp-count">{en.n}</span>
          </div>
        ) : (({ b }) => (
          <div key={b.id} role="treeitem" className={en.inDir ? 'pp-row in' : 'pp-row'} data-kind="block" data-id={b.id} aria-selected={sel === b.id}
            tabIndex={b.id === tabStop ? 0 : -1} onClick={() => pick(b.id)} onKeyDown={e => onKey(e, en)}
            onContextMenu={e => { e.preventDefault(); openMenu(b, e.clientX, e.clientY, e.currentTarget) }}
            draggable={b.kind === 'fixed' || b.kind === 'empty'}
            onDragStart={e => {
              if (b.kind === 'empty') { // the one Empty clip of 목록 (or a new 30-frame one)
                const st = getEditor().getState(), clip = emptyClipFor(st.project.clips, st.defs), have = !!st.project.clips[clip.id]
                e.dataTransfer.setData('application/x-motion-block', b.id); e.dataTransfer.effectAllowed = 'copy'
                setDragged(have ? { kind: 'clip', id: clip.id } : { kind: 'clip', id: clip.id, clip })
                return
              }
              const t = cachedTemplate(b.id)
              if (!t) { e.preventDefault(); return } // not loaded yet: picking the row loads it
              const st = getEditor().getState(), clip = buildBlockClip(b, t.poses, t.fps, 0, st.defs)
              const have = Object.values(st.project.clips).find(c => c.robot === 'go2' && c.name === clip.name) // same block in 목록: reuse it
              e.dataTransfer.setData('application/x-motion-block', b.id)
              e.dataTransfer.effectAllowed = 'copy'
              setDragged(have ? { kind: 'clip', id: have.id } : { kind: 'clip', id: clip.id, clip })
            }}
            onDragEnd={() => setDragged(null)}>
            <span className="pp-name" title={b.label}>{b.label}</span>
            <span className="pp-col-kind">{KIND[b.kind === 'loop' ? b.param : b.kind]}</span>
          </div>
        ))(en))}
      </div>
      {sel && <div className="pp-blk">
        {sel !== 'empty' && <label className="pp-blk-field"><span>붙일 로봇</span>
          <select aria-label="붙일 로봇" value={t} onChange={e => { setChoice(e.target.value); setMsg('') }}>
            {go2s.map(a => <option key={a.id} value={a.id}>{a.name} (트랙 끝에 붙임)</option>)}
            <option value="new">새 GO2 로봇 (0초부터)</option>
            <option value="asset">목록에만 추가 (시퀀스에 놓지 않음)</option>
          </select>
        </label>}
        <Go2BlockPanel key={sel} target={sel === 'empty' ? 'asset' : target} blockId={sel}
          value={values[sel]} onValue={v => setValues(m => ({ ...m, [sel]: v }))} onAdded={(actorId, name, reused) => {
          if (actorId) { setChoice(actorId); setMsg(reused ? `목록에 있는 ${name}을(를) 붙였습니다` : `추가했습니다: ${name}`) }
          else setMsg(reused ? `이미 목록에 있습니다: ${name} (새로 만들지 않음)` : `목록에 추가했습니다: ${name}`)
        }} />
        {msg && <p className="pp-msg" aria-live="polite">{msg}</p>}
      </div>}
      {menu && <RowMenu label="라이브러리" x={menu.x} y={menu.y} head={menuHead(menu.b)} entries={menuEntries(menu.b)}
        close={refocus => { if (refocus) menu.row.focus(); setMenu(null) }} />}
    </>
  )
}
