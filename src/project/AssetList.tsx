import { useEffect, useReducer, useRef, useState } from 'react'
import { importCsvFolder, relinkMedia } from '../importActions'
import { mediaUrl, subscribeMedia } from '../media/registry'
import { getEditor, useEditor } from '../store/store'
import { curveKeyCount } from '../model/itemClip'
import { setDragged } from '../timeline/assetDrop'
import { filterTree, type Row } from './binTree'

const BIN_MOVE = 'application/x-motion-bin-move'

function RenameInput({ name, label, onDone }: { name: string; label: string; onDone: (v: string | null) => void }) {
  const cancelled = useRef(false)
  return (
    <input autoFocus defaultValue={name} aria-label={label}
      onFocus={e => e.currentTarget.select()}
      onBlur={e => onDone(cancelled.current ? null : e.currentTarget.value)}
      onKeyDown={e => {
        e.stopPropagation()
        if (e.key === 'Enter') e.currentTarget.blur()
        else if (e.key === 'Escape') { cancelled.current = true; e.currentTarget.blur() }
      }} />
  )
}

export type Entry = [label: string, run: (() => void) | Entry[]]

// A right-click menu (and its 폴더로 이동 submenu): focus moves in on open; ↑/↓ move, → opens a submenu, Esc/← goes back.
function MenuList({ label, entries, x, y, close, back, head }: { label: string; entries: Entry[]; x: number; y: number; close: () => void; back: () => void; head?: string[] /* dim lines on top, not items */ }) {
  const ref = useRef<HTMLDivElement>(null)
  const [sub, setSub] = useState<{ i: number; x: number; y: number } | null>(null)
  const items = () => [...ref.current!.querySelectorAll<HTMLElement>(':scope > [role=menuitem]')]
  useEffect(() => { items()[0]?.focus() }, [])
  const open = (i: number, el: HTMLElement) => { const r = el.getBoundingClientRect(); setSub({ i, x: r.right, y: r.top }) }
  const onKey = (e: React.KeyboardEvent) => {
    const list = items(), i = list.indexOf(document.activeElement as HTMLElement)
    const d = ({ ArrowDown: 1, ArrowUp: -1 } as Record<string, number>)[e.key]
    if (d) { e.preventDefault(); e.stopPropagation(); list[(i + d + list.length) % list.length]?.focus() }
    else if (e.key === 'ArrowRight' && i >= 0 && Array.isArray(entries[i][1])) { e.preventDefault(); e.stopPropagation(); open(i, list[i]) }
    else if (e.key === 'Escape' || e.key === 'ArrowLeft') { e.preventDefault(); e.stopPropagation(); back() }
    else if (e.key === 'Tab') close()
  }
  const s = sub && entries[sub.i]
  return (
    <div ref={ref} role="menu" aria-label={label} className="tl-menu" style={{ left: x, top: y }} onKeyDown={onKey}>
      {head?.length ? <div className="tl-menu-head" role="presentation">{head.map((h, i) => <div key={i}>{h}</div>)}</div> : null}
      {entries.map(([l, run], i) => Array.isArray(run)
        ? <button key={i} role="menuitem" tabIndex={-1} aria-haspopup="menu" aria-expanded={sub?.i === i} onClick={e => open(i, e.currentTarget)}>{l}<span aria-hidden="true"> ▸</span></button>
        : <button key={i} role="menuitem" tabIndex={-1} onClick={() => { close(); run() }}>{l}</button>)}
      {sub && s && <MenuList label={s[0]} entries={s[1] as Entry[]} x={sub.x} y={sub.y} close={close}
        back={() => { const i = sub.i; setSub(null); items()[i]?.focus() }} />}
    </div>
  )
}

export function RowMenu({ x, y, entries, close, label = '목록', head }: { x: number; y: number; entries: Entry[]; close: (refocus: boolean) => void; label?: string; head?: string[] }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const away = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) close(false) }
    document.addEventListener('pointerdown', away)
    return () => document.removeEventListener('pointerdown', away)
  }, [])
  return <div ref={ref}><MenuList label={label} entries={entries} x={x} y={y} close={() => close(false)} back={() => close(true)} head={head} /></div>
}

/** One tab's list (모션 or 영상): folders, filter, selection, drag (to the timeline or into a folder), rename, right-click menu. */
export default function AssetList({ tab, query, setQuery }: { tab: 'clip' | 'media'; query: string; setQuery: (q: string) => void }) {
  const ed = getEditor()
  const project = useEditor(s => s.project), clipEdit = useEditor(s => s.clipEdit)
  const [, bump] = useReducer((n: number) => n + 1, 0)
  useEffect(() => subscribeMedia(bump), []) // re-render when a url is (un)set

  const [open, setOpen] = useState<ReadonlySet<string>>(new Set())
  const [sel, setSel] = useState<ReadonlySet<string>>(new Set())
  const [anchor, setAnchor] = useState<string | null>(null)
  const [focus, setFocus] = useState<string | null>(null)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [over, setOver] = useState<string | null>(null) // drop target while moving rows: a folder id, or '' = top level
  const [menu, setMenu] = useState<{ id: string; x: number; y: number; row: HTMLElement } | null>(null)
  const [msg, setMsg] = useState<{ text: string; t: number } | null>(null) // a new t restarts the 3 s timer
  useEffect(() => { if (!msg) return; const t = setTimeout(() => setMsg(null), 3000); return () => clearTimeout(t) }, [msg])
  const say = (text: string) => setMsg({ text, t: performance.now() })
  const treeRef = useRef<HTMLDivElement>(null)

  const items = tab === 'clip' ? Object.values(project.clips) : project.media
  const bins = (project.bins ?? []).filter(b => b.tab === tab)
  const { rows } = filterTree(items, bins, query, open)
  const rowId = (r: Row) => r.kind === 'bin' ? r.bin.id : r.id
  const ids = rows.map(rowId)
  const binOf = new Map(bins.map(b => [b.id, b]))
  const itemOf = new Map(items.map(it => [it.id, it]))
  const selItems = ids.filter(id => sel.has(id) && itemOf.has(id))
  const tabStop = focus && ids.includes(focus) ? focus : ids[0]

  const focusRow = (id: string) => { setFocus(id); treeRef.current?.querySelector<HTMLElement>(`[data-id="${id}"]`)?.focus() }
  const pick = (id: string, e: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }) => {
    setFocus(id)
    if (e.shiftKey && anchor && ids.includes(anchor)) {
      const [a, b] = [ids.indexOf(anchor), ids.indexOf(id)].sort((x, y) => x - y)
      setSel(new Set(ids.slice(a, b + 1)))
    } else if (e.ctrlKey || e.metaKey) {
      const s = new Set(sel); if (!s.delete(id)) s.add(id); setSel(s); setAnchor(id)
    } else { setSel(new Set([id])); setAnchor(id) }
  }
  const setOpenBin = (id: string, on: boolean) => { const s = new Set(open); if (on) s.add(id); else s.delete(id); setOpen(s) }
  const moving = (id: string) => sel.has(id) && selItems.length ? selItems : [id]
  const del = (id: string) => {
    const s = ed.getState()
    if (binOf.has(id)) s.deleteBin(id)
    else if (tab === 'clip') { if (!s.deleteClip(id)) say('시퀀스에서 쓰는 클립은 삭제할 수 없습니다') }
    else if (!s.deleteMedia(id)) say('시퀀스에서 쓰는 영상은 삭제할 수 없습니다')
  }
  const rename = (id: string, v: string | null) => {
    setRenaming(null)
    if (v != null) {
      if (binOf.has(id)) ed.getState().renameBin(id, v)
      else if (v.trim() && !ed.getState().setClip(id, { name: v })) say('잠긴 트랙입니다')
    }
    setTimeout(() => { if (document.activeElement === document.body) focusRow(id) })
  }
  const newBin = () => {
    const id = ed.getState().addBin(tab, selItems)
    if (!selItems.length) setQuery('') // an empty folder is hidden while filtering, so its rename input would never mount
    setOpenBin(id, true); setSel(new Set([id])); setAnchor(id); setFocus(id); setRenaming(id)
  }

  const entries = (id: string): Entry[] => {
    const s = ed.getState()
    if (binOf.has(id)) return [['이름 변경', () => setRenaming(id)], ['삭제', () => del(id)]]
    const move: Entry = ['폴더로 이동', [['(최상위)', () => s.moveToBin(moving(id), null)], ...bins.map((b): Entry => [b.name, () => s.moveToBin(moving(id), b.id)])]]
    return tab === 'clip'
      ? [['클립 편집', () => s.openClipEdit(id)], ['이름 변경', () => setRenaming(id)], move, ['삭제', () => del(id)]]
      : [move, ['삭제', () => del(id)]]
  }

  const onKey = (e: React.KeyboardEvent<HTMLElement>, r: Row) => {
    if (e.target !== e.currentTarget) return
    if (e.key.startsWith('Arrow')) e.stopPropagation() // never reaches the transport
    const id = rowId(r), i = ids.indexOf(id)
    const go = (j: number) => { const n = ids[j]; if (n) { e.preventDefault(); e.stopPropagation(); setSel(new Set([n])); setAnchor(n); focusRow(n) } }
    if (e.key === 'ArrowDown') go(i + 1)
    else if (e.key === 'ArrowUp') go(i - 1)
    else if (e.key === 'ArrowRight' && r.kind === 'bin' && !r.open) { e.preventDefault(); e.stopPropagation(); setOpenBin(id, true) }
    else if (e.key === 'ArrowLeft' && r.kind === 'bin' && r.open) { e.preventDefault(); e.stopPropagation(); setOpenBin(id, false) }
    else if (e.key === 'ArrowLeft' && r.kind === 'item' && r.depth === 1) { const b = itemOf.get(id)?.bin; if (b) go(ids.indexOf(b)) }
    else if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) {
      e.preventDefault(); e.stopPropagation()
      const b = e.currentTarget.getBoundingClientRect()
      setMenu({ id, x: b.left + 8, y: b.top + 24, row: e.currentTarget })
    } else if (e.key === 'Delete') {
      e.stopPropagation(); del(id)
      const next = ids[i + 1] ?? ids[i - 1] // focus would fall to body once the row is gone
      setTimeout(() => { if (!treeRef.current?.querySelector(`[data-id="${id}"]`) && next) focusRow(next) })
    }
    else if ((e.key === 'Enter' || e.key === 'F2') && (r.kind === 'bin' || tab === 'clip')) { e.preventDefault(); e.stopPropagation(); setRenaming(id) }
  }

  // Rows dragged inside the panel move into a folder (dropped on a folder row or one of its items) or to the top level (anywhere else).
  const target = (e: React.DragEvent): string => {
    const row = (e.target as HTMLElement).closest<HTMLElement>('.pp-row')
    const id = row?.dataset.id
    return !id ? '' : binOf.has(id) ? id : itemOf.get(id)?.bin ?? ''
  }
  const binDrop = {
    onDragOver: (e: React.DragEvent) => { if (e.dataTransfer.types.includes(BIN_MOVE)) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; setOver(target(e)) } },
    onDragLeave: (e: React.DragEvent) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(null) },
    onDrop: (e: React.DragEvent) => {
      const raw = e.dataTransfer.getData(BIN_MOVE)
      if (!raw) return
      e.preventDefault(); setOver(null)
      ed.getState().moveToBin(JSON.parse(raw) as string[], target(e) || null)
    },
  }

  const sec = (f: number) => `${(f / 60).toFixed(2)}s`
  const uses = (id: string) => project.sequence.tracks.reduce((n, t) => n + t.items.filter(i => i.refId === id).length, 0)
  const cells = (id: string) => {
    if (tab === 'media') {
      const m = project.media.find(m => m.id === id)!, off = mediaUrl(id) == null
      return <>
        <span className="pp-name" title={m.name}>{m.name}</span>
        <span className="pp-col-len">{sec(m.durationF)}</span>
        <span className="pp-col-state">{off && <><span className="pp-off">오프라인</span>
          <button aria-label={`${m.name} 다시 연결`} onClick={e => { e.stopPropagation(); void relinkMedia(m) }}>다시 연결</button></>}</span>
      </>
    }
    const c = project.clips[id], k = curveKeyCount(c.offset)
    return <>
      {renaming === id
        ? <RenameInput name={c.name} label="클립 이름 변경" onDone={v => rename(id, v)} />
        : <span className="pp-name" title={k ? `${c.name}\n수정됨 · 수정 키 ${k}개` : c.name}>
            {k > 0 && <span className="pp-mod" aria-label="수정됨">● </span>}{c.name}</span>}
      <span className="pp-col-robot">{c.robot.toUpperCase()}</span>
      <span className="pp-col-len">{sec(c.length)}</span>
      <span className="pp-col-uses">{uses(id)}</span>
    </>
  }

  return (
    <>
      {tab === 'clip' && !items.length && <p className="pp-dim">메뉴 ▸ CSV 가져오기 또는 CSV 파일을 여기로 끌어다 놓으세요</p>}
      <div className="pp-cols" aria-hidden="true">
        <span>이름</span>{tab === 'clip' ? <><span className="pp-col-robot">로봇</span><span className="pp-col-len">길이</span><span className="pp-col-uses">사용</span></>
          : <><span className="pp-col-len">길이</span><span className="pp-col-state">상태</span></>}
      </div>
      <div ref={treeRef} role="tree" aria-label={tab === 'clip' ? '모션 목록' : '영상 목록'} aria-multiselectable="true"
        className={over === '' ? 'pp-tree over' : 'pp-tree'} {...binDrop}>
        {rows.map(r => {
          const id = rowId(r), common = {
            role: 'treeitem', 'data-id': id, 'aria-selected': sel.has(id), 'aria-level': r.depth + 1,
            tabIndex: id === tabStop ? 0 : -1,
            onClick: (e: React.MouseEvent) => pick(id, e),
            onKeyDown: (e: React.KeyboardEvent<HTMLElement>) => onKey(e, r),
            onContextMenu: (e: React.MouseEvent<HTMLElement>) => {
              e.preventDefault(); if (!sel.has(id)) pick(id, { ctrlKey: false, metaKey: false, shiftKey: false })
              setMenu({ id, x: e.clientX, y: e.clientY, row: e.currentTarget })
            },
          }
          if (r.kind === 'bin') return (
            <div key={id} {...common} className={over === id ? 'pp-row pp-bin over' : 'pp-row pp-bin'} data-kind="bin" aria-expanded={r.open}
              draggable={tab === 'clip' && renaming !== id}
              onDragStart={e => { // a folder dragged to the timeline places all its clips
                const kids = items.filter(it => it.bin === id).map(it => it.id)
                if (!kids.length) { e.preventDefault(); return }
                e.dataTransfer.setData('application/x-motion-clip', kids[0])
                e.dataTransfer.effectAllowed = 'copy'
                setDragged({ kind: 'clip', id: kids[0] }, kids)
              }}
              onDragEnd={() => setDragged(null)}
              onDoubleClick={() => { if (renaming !== id) setOpenBin(id, !r.open) }}>
              <span className="pp-twisty" aria-hidden="true" onClick={e => { e.stopPropagation(); setOpenBin(id, !r.open) }}>{r.open ? '▾' : '▸'}</span>
              {renaming === id
                ? <RenameInput name={r.bin.name} label="폴더 이름 변경" onDone={v => rename(id, v)} />
                : <span className="pp-name" title={r.bin.name}>{r.bin.name}</span>}
            </div>
          )
          return (
            <div key={id} {...common} className={'pp-row' + (r.depth ? ' in' : '') + (clipEdit === id ? ' editing' : '')} data-kind={tab}
              draggable={renaming !== id}
              onDragStart={e => {
                e.dataTransfer.setData(`application/x-motion-${tab}`, id)
                e.dataTransfer.setData(BIN_MOVE, JSON.stringify(moving(id)))
                e.dataTransfer.effectAllowed = 'copyMove'
                setDragged({ kind: tab, id }, tab === 'clip' ? moving(id) : [])
              }}
              onDragEnd={() => { setDragged(null); setOver(null) }}
              onDoubleClick={() => { if (tab === 'clip' && renaming !== id) ed.getState().openClipEdit(id) }}>
              {cells(id)}
            </div>
          )
        })}
      </div>
      <div className="pp-tools">
        <button onClick={newBin}>새 폴더</button>
        {tab === 'clip' && <button onClick={() => void importCsvFolder()} title="고른 폴더의 CSV를 모두 같은 이름의 목록 폴더로 가져옵니다(타임라인에는 놓지 않음). 폴더를 타임라인으로 끌면 클립마다 조각으로 이어 붙습니다">폴더 가져오기</button>}
        {tab === 'clip' && <button disabled={selItems.length !== 1} title="고른 모션을 비교 프리뷰에 나란히 재생 (타임라인에는 추가하지 않음)"
          onClick={() => ed.getState().openComparePane(selItems[0])}>⇄ 비교</button>}
      </div>
      {menu && <RowMenu x={menu.x} y={menu.y} entries={entries(menu.id)} close={refocus => { if (refocus) menu.row.focus(); setMenu(null) }} />}
      {msg && <p className="pp-msg">{msg.text}</p>}
    </>
  )
}
