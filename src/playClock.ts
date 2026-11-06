// 재생 fps (user, 수정변동사항.md §8): the data stays 60 fps; only playback runs at `fps` frames per second. Every playback position
// (main transport, clip preview, preview panes) reads this clock instead of performance.now(), so one setting moves them all.
// The clock is "virtual ms at 60 fps": frames elapsed = (playNow() - start) * 60 / 1000, as before. Changing the rate rebases it,
// so a running playback continues from where it is (no jump).

export const DATA_FPS = 60
export const PLAY_FPS_MIN = 1, PLAY_FPS_MAX = 240
export const PLAY_FPS_PRESETS = [1, 5, 15, 30, 60, 120, 240]

let realBase = 0, virtBase = 0, rate = 1 // virtual ms per real ms = fps / 60

/** Virtual playback ms (advances fps/60 times as fast as real time). `real` = performance.now(), injectable for tests. */
export function playNow(real = performance.now()): number {
  return virtBase + (real - realBase) * rate
}

/** Set the playback fps (clamped to an integer 1..240); the clock keeps its current value at the switch. Returns the fps used. */
export function setPlayClockFps(fps: number, real = performance.now()): number {
  const f = clampPlayFps(fps)
  virtBase = playNow(real); realBase = real; rate = f / DATA_FPS
  return f
}

export const clampPlayFps = (fps: number) => Math.min(Math.max(Math.round(Number.isFinite(fps) ? fps : DATA_FPS), PLAY_FPS_MIN), PLAY_FPS_MAX)

/** 직접 입력: an integer 1..240 (spaces and a trailing "fps" allowed), else null. */
export function parsePlayFps(text: string): number | null {
  const m = /^\s*(\d+)\s*(fps)?\s*$/i.exec(text)
  if (!m) return null
  const n = Number(m[1])
  return n >= PLAY_FPS_MIN && n <= PLAY_FPS_MAX ? n : null
}

/** Wall-clock length of `frames` data frames played at `fps`, as m:ss (floored seconds). */
export function playTime(frames: number, fps: number): string {
  const s = Math.floor(Math.max(frames, 0) / Math.max(fps, 1))
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}
