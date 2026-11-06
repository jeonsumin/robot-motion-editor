import { expect, test } from 'vitest'
import { clampPlayFps, parsePlayFps, playNow, playTime, setPlayClockFps } from './playClock'

// 재생 fps: one playback clock, "virtual ms at 60 fps"; a rate change keeps the current value (no jump)
test('playNow runs at fps/60 and a rate change continues from the same value', () => {
  setPlayClockFps(60, 1000)
  const a = playNow(1000)
  expect(playNow(2000) - a).toBe(1000) // 60 fps: real time
  setPlayClockFps(30, 2000)
  expect(playNow(2000)).toBe(a + 1000) // no jump at the switch
  expect(playNow(3000) - playNow(2000)).toBe(500) // half speed: 1 s real = 30 data frames
  setPlayClockFps(1, 3000)
  expect((playNow(4000) - playNow(3000)) * 60 / 1000).toBeCloseTo(1) // 1 fps: one frame a second
  setPlayClockFps(240, 4000)
  expect((playNow(5000) - playNow(4000)) * 60 / 1000).toBeCloseTo(240)
  setPlayClockFps(60)
})
test('clamp / parse / playTime', () => {
  expect([clampPlayFps(0), clampPlayFps(500), clampPlayFps(29.6), clampPlayFps(NaN)]).toEqual([1, 240, 30, 60])
  expect([parsePlayFps('30'), parsePlayFps(' 1 '), parsePlayFps('240fps'), parsePlayFps('12 FPS')]).toEqual([30, 1, 240, 12])
  for (const bad of ['', '0', '241', '1.5', '-3', 'abc', '2x']) expect(parsePlayFps(bad)).toBeNull()
  expect([playTime(25033, 60), playTime(25033, 30), playTime(60, 1), playTime(0, 5)]).toEqual(['06:57', '13:54', '01:00', '00:00'])
})
