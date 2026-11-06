import { useEffect, useRef } from 'react'
import { mediaUrl, subscribeMedia } from '../media/registry'
import { videoTimeAt, videoTrack } from '../model/video'
import { getEditor, useEditor } from '../store/store'
import { MIN_VIDEO_RATE, syncAction } from './videoSync'

// Single muted <video> kept on the playhead's media time. Visible only via CSS class (mode); hidden + paused when no target.
export default function VideoOverlay() {
  const ref = useRef<HTMLVideoElement>(null)
  const mode = useEditor(s => s.videoMode), opacity = useEditor(s => s.videoOpacity)

  useEffect(() => {
    const v = ref.current!, store = getEditor()
    const run = () => {
      const s = store.getState()
      const t = s.videoMode === 'off' || videoTrack(s.project)?.hidden ? null : videoTimeAt(s.project, s.frame)
      const url = t && mediaUrl(t.mediaId)
      // split keeps its slot (visibility) so the 3D canvas width stays put; overlay/off use display none
      const keep = s.videoMode === 'split'
      v.style.display = !t || !url ? (keep ? '' : 'none') : ''
      v.style.visibility = !t || !url ? 'hidden' : ''
      if (!t || !url) { v.pause(); return }
      if (v.getAttribute('src') !== url) { v.src = url; return } // loadedmetadata re-runs sync
      if (v.readyState < 1) return
      const rate = s.playFps / 60, live = s.playing && rate >= MIN_VIDEO_RATE // 재생 fps: same speed; too slow for <video> = seek per frame
      if (live && v.playbackRate !== rate) v.playbackRate = rate
      const a = syncAction(t, v, live, rate)
      if (a.kind === 'seek') v.currentTime = a.t
      if (a.play) { if (v.paused) v.play().catch(() => {}) } else if (!v.paused) v.pause()
    }
    run()
    v.addEventListener('loadedmetadata', run)
    const un1 = store.subscribe((s, p) => {
      if (s.frame !== p.frame || s.playing !== p.playing || s.project !== p.project || s.editing !== p.editing || s.videoMode !== p.videoMode || s.playFps !== p.playFps) run()
    })
    const un2 = subscribeMedia(run)
    return () => { v.pause(); v.removeEventListener('loadedmetadata', run); un1(); un2() }
  }, [])

  return <video ref={ref} muted playsInline preload="auto" className={mode === 'off' ? '' : mode} style={mode === 'overlay' ? { opacity } : undefined} />
}
