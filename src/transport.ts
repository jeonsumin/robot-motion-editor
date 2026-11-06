import { editingItem, getEditor, type EditorState } from './store/store'
import { playNow } from './playClock'
import { onHandleArrow } from './layout/useLayout'
import { sortedItems } from './model/sequence'
import { previewRange } from './model/restPose'
import type { Project } from './model/types'
import { saveProject, showProjectHub } from './projectActions'
import { seqFlash } from './timeline/viewState'
import { cancelDrag, dragActive } from './timeline/drag'

export function sequenceEnd(p: Project): number {
  let end = 0
  for (const t of p.sequence.tracks) for (const it of t.items) end = Math.max(end, it.start + it.trimOut - it.trimIn)
  return end
}

// Playback / arrow-key range [lo, hi): in clip view the open piece with its lead-in and 끝 기본자세, In..Out in sequence view if both
// set, else 0..end.
export function playRange(s: Pick<EditorState, 'project' | 'editing'> & Partial<Pick<EditorState, 'clipEdit' | 'defs'>>): [number, number] {
  const e = editingItem(s)
  if (e) return (!s.clipEdit && s.defs && previewRange(s.project, s.defs, e.item.id)) || [e.item.start, e.item.start + e.item.trimOut - e.item.trimIn]
  const { inF, outF } = s.project.sequence
  return inF !== null && outF !== null ? [inF, outF] : [0, sequenceEnd(s.project)]
}

// Item the C key splits: an item under the playhead (strictly inside), preferring the track of the selected item, then the selected actor's, then the top-most. None in clip view.
// `frame` overrides the playhead (the 자르기 button cuts at a typed frame).
export function splitTarget(s: Pick<EditorState, 'project' | 'editing' | 'selItem' | 'sel' | 'frame'> & Partial<Pick<EditorState, 'clipEdit'>>, frame = s.frame): string | null {
  if (s.editing || s.clipEdit) return null
  const tracks = s.project.sequence.tracks
  const hits = tracks.flatMap(t => {
    const it = sortedItems(t).filter(i => frame > i.start && frame < i.start + i.trimOut - i.trimIn).at(-1)
    return it ? [{ t, it }] : []
  })
  const pick = hits.find(h => h.t.items.some(i => i.id === s.selItem))
    ?? hits.find(h => h.t.kind === 'motion' && s.sel.actorId && h.t.actorId === s.sel.actorId) ?? hits[0]
  return pick?.it.id ?? null
}

// Split at the playhead and select the new right-hand piece (same track, starts at the playhead).
export function splitAtPlayhead(ed: Pick<ReturnType<typeof getEditor>, 'getState'>, id: string): boolean {
  const { frame } = ed.getState()
  if (!ed.getState().splitItem(id, frame)) return false
  const s = ed.getState()
  const right = s.project.sequence.tracks.find(t => t.items.some(i => i.id === id))?.items.find(i => i.id !== id && i.start === frame)
  if (right) s.selectItem(right.id)
  return true
}

// 자르기 button: cut at a sequence frame (same target rule as C), move the playhead there. Returns why it could not cut, or null.
export function cutAtFrame(ed: Pick<ReturnType<typeof getEditor>, 'getState'>, frame: number): string | null {
  const s = ed.getState()
  if (s.editing || s.clipEdit) return '시퀀스에서만 자를 수 있습니다'
  const id = splitTarget(s, frame)
  if (!id) return '그 프레임에 자를 조각이 없습니다'
  if (lockedItem(s, id)) return '잠긴 트랙입니다'
  s.setFrame(frame)
  return splitAtPlayhead(ed, id) ? null : '자를 수 없습니다'
}

// Delete/C on an item of a locked track: the store rejects it; say why.
const lockedItem = (s: Pick<EditorState, 'project'>, id: string) => {
  const yes = s.project.sequence.tracks.some(t => t.locked && t.items.some(i => i.id === id))
  if (yes) seqFlash.fn?.('잠긴 트랙입니다', id)
  return yes
}

const typing =(t: EventTarget | null) =>
  t instanceof HTMLElement && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName))

export function startTransport(): () => void {
  const ed = getEditor()
  let raf = 0, t0 = 0, f0 = 0, was = false, last = 0
  let pt0 = 0, pf0 = 0, pwas = false, plast = 0 // the clip preview's own clock, looping over its piece

  const tick = () => {
    const s = ed.getState()
    if (s.playing) {
      const [lo, hi] = playRange(s)
      const now = playNow() // 재생 fps: the playback clock, not wall time
      if (!was || hi <= lo || s.frame !== last || s.frame < lo || s.frame >= hi) { // start, scrubbed, or range moved away
        t0 = now; f0 = s.frame >= hi || s.frame < lo ? lo : s.frame }
      let f = f0 + Math.floor((now - t0) * 60 / 1000) // from start time, so no drift accumulates
      if (hi > lo && f >= hi) { t0 = now; f0 = lo; f = lo }
      if (f !== s.frame) s.setFrame(f)
      last = f
    }
    was = s.playing
    const pr = s.previewPlaying && s.itemPreview ? previewRange(s.project, s.defs, s.itemPreview) : null
    if (pr && pr[1] > pr[0]) {
      const [lo, hi] = pr, now = playNow()
      if (!pwas || s.previewFrame !== plast || s.previewFrame < lo || s.previewFrame >= hi) { pt0 = now; pf0 = s.previewFrame >= hi || s.previewFrame < lo ? lo : s.previewFrame }
      let f = pf0 + Math.floor((now - pt0) * 60 / 1000)
      if (f >= hi) { pt0 = now; pf0 = lo; f = lo }
      if (f !== s.previewFrame) s.setPreviewFrame(f)
      plast = f
    }
    pwas = !!pr
    raf = requestAnimationFrame(tick)
  }
  raf = requestAnimationFrame(tick)

  // Space always plays/pauses the sequence, whatever has focus (a button, the menu, a panel); only text fields and form
  // controls keep it. Capture phase, so no button, menu or panel handler sees it first.
  const onSpace = (e: KeyboardEvent) => {
    if (e.key !== ' ' || e.ctrlKey || e.metaKey || e.altKey || typing(e.target)) return
    e.preventDefault(); e.stopPropagation() // also stops a focused button's own click; focus stays where it was
    if (!e.repeat) { const s = ed.getState(); s.setPlaying(!s.playing) }
  }
  const onKey = (e: KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && !e.altKey && ['s', 'o'].includes(e.key.toLowerCase())) { // file shortcuts work everywhere
      e.preventDefault()
      if (!e.repeat) { if (e.key.toLowerCase() === 's') saveProject(e.shiftKey); else showProjectHub() }
      return
    }
    if (typing(e.target) || e.altKey || (e.target instanceof Element && e.target.closest('[role=menu]'))) return // menus own their keys
    if (onHandleArrow(e)) return // resize handles own their arrow keys
    // panel rows own Delete/Backspace and the plain editing keys; undo and arrows still pass through
    if (e.target instanceof Element && e.target.closest('#project') && !e.ctrlKey && !e.metaKey && ['Delete', 'Backspace', 'Escape', 'c', 'i', 'o', 'm'].includes(e.key.length === 1 ? e.key.toLowerCase() : e.key)) return
    const s = ed.getState()
    const step = (n: number) => {
      e.preventDefault()
      if (s.editing || s.clipEdit) { const [lo, hi] = playRange(s); s.setFrame(Math.min(Math.max(s.frame + n, lo), hi - 1)) }
      else s.setFrame(Math.min(Math.max(s.frame + n, 0), sequenceEnd(s.project)))
    }
    if (e.ctrlKey || e.metaKey) {
      const k = e.key.toLowerCase()
      if (k === 'z' && !e.shiftKey) { e.preventDefault(); if (!cancelDrag()) s.undo() } // mid-drag: cancel that drag only
      else if (k === 'z' || k === 'y') { e.preventDefault(); if (!dragActive()) s.redo() }
      return
    }
    if (e.key === 'ArrowLeft') step(e.shiftKey ? -10 : -1)
    else if (e.key === 'ArrowRight') step(e.shiftKey ? 10 : 1)
    else if (e.key === 'Escape') {
      if (e.defaultPrevented || (e.target as Element | null)?.closest?.('dialog[open]')) return
      if (s.clipEdit) s.closeClipEdit() // 클립 편집 → back to the sequence
      else if (s.editing) s.closeItem()
    }
    else if (s.clipEdit && ['i', 'o', 'm', 'c', 'delete'].includes(e.key.toLowerCase())) return // sequence keys: not in 클립 편집
    else if (e.key === 'Delete') { if (!s.editing && s.selItem) { e.preventDefault(); if (!lockedItem(s, s.selItem)) s.deleteItem(s.selItem) } }
    else if (e.key.toLowerCase() === 'i') s.setIn(Math.max(s.frame, 0))
    else if (e.key.toLowerCase() === 'o') s.setOut(Math.max(s.frame, 0))
    else if (e.key.toLowerCase() === 'm') s.addMarker(Math.max(s.frame, 0))
    else if (e.key.toLowerCase() === 'c') {
      const id = splitTarget(s)
      if (id && !lockedItem(s, id)) splitAtPlayhead(ed, id)
    }
    else if ((s.editing || s.clipEdit) && e.key === 'Tab' && e.target instanceof Element && e.target.closest('#timeline')) {
      e.preventDefault(); s.setView(s.view === 'tracks' ? 'graph' : 'tracks')
      // the focused canvas is unmounted by the switch; refocus the new one so Tab keeps toggling
      requestAnimationFrame(() => document.querySelector<HTMLElement>('#timeline canvas')?.focus())
    }
  }
  window.addEventListener('keydown', onSpace, true)
  window.addEventListener('keydown', onKey)
  return () => { cancelAnimationFrame(raf); window.removeEventListener('keydown', onSpace, true); window.removeEventListener('keydown', onKey) }
}
