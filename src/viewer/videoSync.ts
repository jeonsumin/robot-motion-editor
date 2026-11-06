/** Browsers play <video> only between 0.0625x and 16x: below that (재생 fps < 3.75) the video is paused and seeked frame by frame. */
export const MIN_VIDEO_RATE = 0.0625

export type SyncAction = { kind: 'seek'; t: number; play: boolean } | { kind: 'none'; play: boolean }

// Pure: what to do with the <video> so it matches the playhead's media time. `rate` = 재생 fps / 60: faster playback moves the
// playhead several frames per screen refresh, so the playing tolerance grows with it (no seek storm).
export function syncAction(target: { seconds: number }, video: { currentTime: number; paused: boolean }, playing: boolean, rate = 1): SyncAction {
  const tol = playing ? 2 * Math.max(1, rate) / 60 : 0.5 / 60
  return Math.abs(video.currentTime - target.seconds) > tol
    ? { kind: 'seek', t: target.seconds, play: playing }
    : { kind: 'none', play: playing }
}
