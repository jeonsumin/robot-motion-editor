// The only module that touches file APIs. Swap this file when wrapping in Tauri/Electron.
type Picker = (o: { mode: 'readwrite' }) => Promise<FileSystemDirectoryHandle>

export async function pickDirectory(): Promise<FileSystemDirectoryHandle | null> {
  const pick = (window as unknown as { showDirectoryPicker?: Picker }).showDirectoryPicker
  if (!pick) return null
  try {
    return await pick.call(window, { mode: 'readwrite' })
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') return null
    throw e
  }
}

export async function writeTextFiles(
  dir: FileSystemDirectoryHandle | null,
  files: { name: string; text: string }[],
): Promise<void> {
  for (const { name, text } of files) {
    if (dir) {
      const w = await (await dir.getFileHandle(name, { create: true })).createWritable()
      await w.write(text)
      await w.close()
    } else downloadBlob(name, new Blob([text], { type: /\.json$/i.test(name) ? 'application/json' : 'text/csv' }))
  }
}

export function downloadBlob(name: string, blob: Blob) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 0)
}

type OpenPicker = (o: { multiple: boolean; types: { accept: Record<string, string[]> }[] }) => Promise<FileSystemFileHandle[]>

export async function openFiles(accept: string, mime: Record<string, string[]>, multiple: boolean): Promise<File[]> {
  const pick = (window as unknown as { showOpenFilePicker?: OpenPicker }).showOpenFilePicker
  if (typeof pick === 'function') {
    try {
      const hs = await pick.call(window, { multiple, types: [{ accept: mime }] })
      return await Promise.all(hs.map(h => h.getFile()))
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') return []
      throw e
    }
  }
  return new Promise(resolve => {
    const input = document.createElement('input')
    input.type = 'file'; input.accept = accept; input.multiple = multiple; input.hidden = true
    let done = false
    const finish = (files: File[]) => {
      if (done) return
      done = true
      input.remove()
      window.removeEventListener('focus', onFocus)
      resolve(files)
    }
    // Cancel: the `cancel` event, or window focus returning with no change event (older browsers).
    const onFocus = () => setTimeout(() => finish([]), 1000)
    input.addEventListener('change', () => finish([...(input.files ?? [])]))
    input.addEventListener('cancel', () => finish([]))
    window.addEventListener('focus', onFocus)
    document.body.appendChild(input)
    input.click()
  })
}

export async function openTextFiles(accept: string, multiple: boolean): Promise<{ name: string; text: string }[]> {
  const files = await openFiles(accept, { 'text/plain': accept.split(',') }, multiple)
  return Promise.all(files.map(async f => ({ name: f.name, text: await f.text() })))
}

// Opaque to callers: a FileSystemFileHandle when the browser has one, else null.
export type SaveHandle = unknown
type SavePicker = (o: { suggestedName: string; types: { description: string; accept: Record<string, string[]> }[] }) => Promise<FileSystemFileHandle>
const aborted = (e: unknown) => e instanceof DOMException && e.name === 'AbortError'

export async function saveTextFile(text: string, suggested: string, handle: SaveHandle | null):
  Promise<{ handle: SaveHandle | null; name: string } | null> {
  const write = async (h: FileSystemFileHandle) => {
    const w = await h.createWritable()
    try { await w.write(text) } catch (e) { await w.abort().catch(() => {}); throw e }
    await w.close()
    return { handle: h, name: h.name }
  }
  if (handle) {
    try { return await write(handle as FileSystemFileHandle) } catch (e) {
      if (!(e instanceof DOMException && e.name === 'NotAllowedError')) throw e // permission lost: fall through to the picker
    }
  }
  const pick = (window as unknown as { showSaveFilePicker?: SavePicker }).showSaveFilePicker
  if (typeof pick === 'function') {
    try {
      return await write(await pick.call(window, { suggestedName: suggested, types: [{ description: 'Motion project', accept: { 'application/json': ['.mproj'] } }] }))
    } catch (e) {
      if (aborted(e)) return null
      throw e
    }
  }
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }))
  const a = document.createElement('a')
  a.href = url
  a.download = suggested
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 0)
  return { handle: null, name: suggested }
}

// Save one CSV: save picker when available, else a plain download. false = the user cancelled.
export async function saveCsvFile(name: string, text: string): Promise<boolean> {
  const pick = (window as unknown as { showSaveFilePicker?: SavePicker }).showSaveFilePicker
  if (typeof pick === 'function') {
    try {
      const w = await (await pick.call(window, { suggestedName: name, types: [{ description: 'CSV', accept: { 'text/csv': ['.csv'] } }] })).createWritable()
      try { await w.write(text) } catch (e) { await w.abort().catch(() => {}); throw e }
      await w.close()
      return true
    } catch (e) {
      if (aborted(e)) return false
      throw e
    }
  }
  await writeTextFiles(null, [{ name, text }])
  return true
}

type DirPicker = (o: { mode: 'read' }) => Promise<FileSystemDirectoryHandle>
type DirEntries = { values(): AsyncIterable<FileSystemHandle> }

/** Every file under a folder the user picks (subfolders too), sorted by path. null = cancelled. */
export async function openFolder(): Promise<{ name: string; files: File[] } | null> {
  const pick = (window as unknown as { showDirectoryPicker?: DirPicker }).showDirectoryPicker
  if (typeof pick === 'function') {
    let dir: FileSystemDirectoryHandle
    try { dir = await pick.call(window, { mode: 'read' }) } catch (e) { if (aborted(e)) return null; throw e }
    const files: [string, File][] = []
    const walk = async (d: FileSystemDirectoryHandle, at: string): Promise<void> => {
      for await (const h of (d as unknown as DirEntries).values()) {
        if (h.kind === 'file') files.push([at + h.name, await (h as FileSystemFileHandle).getFile()])
        else await walk(h as FileSystemDirectoryHandle, `${at}${h.name}/`)
      }
    }
    await walk(dir, '')
    return { name: dir.name, files: files.sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true })).map(f => f[1]) }
  }
  return new Promise(resolve => { // no picker API: a folder <input>
    const input = document.createElement('input')
    input.type = 'file'; input.webkitdirectory = true; input.hidden = true
    input.addEventListener('change', () => {
      const files = [...(input.files ?? [])].sort((a, b) => a.webkitRelativePath.localeCompare(b.webkitRelativePath, undefined, { numeric: true }))
      input.remove()
      resolve(files.length ? { name: files[0].webkitRelativePath.split('/')[0], files } : null)
    })
    input.addEventListener('cancel', () => { input.remove(); resolve(null) })
    document.body.appendChild(input)
    input.click()
  })
}

export const objectUrl = (file: File) => URL.createObjectURL(file)
export const revokeUrl = (url: string) => URL.revokeObjectURL(url)

export const openMediaFiles = (multiple: boolean) => openFiles('video/*', { 'video/*': [] }, multiple)

// Project hub (server/hub.mjs): one server folder of *.mproj (older *.motion.json still listed). null = no hub server (static hosting, offline).
export interface HubEntry { name: string; mtime: number; size: number }
const hubUrl = (name: string) => `/api/projects/${encodeURIComponent(name)}`
const isJson = (r: Response) => r.headers.get('Content-Type')?.includes('json')

export async function hubList(): Promise<HubEntry[] | null> {
  try { const r = await fetch('/api/projects'); return r.ok && isJson(r) ? await r.json() : null } catch { return null }
}
export async function hubRead(name: string): Promise<{ text: string; mtime: number }> {
  const r = await fetch(hubUrl(name))
  if (!r.ok) throw new Error(r.status === 404 ? '서버에 파일이 없습니다' : `서버 오류 ${r.status}`)
  return { text: await r.text(), mtime: Number(r.headers.get('X-Mtime')) }
}
/** create: fail when the name exists. base: fail when the server file changed since that mtime. */
export async function hubWrite(name: string, text: string, o: { create?: boolean; base?: number } = {}):
  Promise<{ mtime: number } | { error: 'exists' | 'conflict' }> {
  const q = o.create ? '?create=1' : o.base !== undefined ? `?base=${o.base}` : ''
  const r = await fetch(hubUrl(name) + q, { method: 'PUT', body: text, headers: { 'Content-Type': 'application/json' } })
  const b = await r.json().catch(() => ({}))
  if (r.status === 409) return { error: b.error === 'exists' ? 'exists' : 'conflict' }
  if (!r.ok) throw new Error(b.error ?? `서버 오류 ${r.status}`)
  return b
}
