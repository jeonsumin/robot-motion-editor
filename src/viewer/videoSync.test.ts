import { describe, expect, test } from 'vitest'
import { syncAction } from './videoSync'

const v = (currentTime: number, paused: boolean) => ({ currentTime, paused })
describe('syncAction', () => {
  test('playing within 2 frames does not seek', () => expect(syncAction({ seconds: 1 }, v(1 + 1 / 60, false), true)).toEqual({ kind: 'none', play: true }))
  test('playing drift > 2 frames seeks', () => expect(syncAction({ seconds: 1 }, v(1.1, false), true)).toEqual({ kind: 'seek', t: 1, play: true }))
  test('paused scrub seeks precisely', () => expect(syncAction({ seconds: 2 }, v(1.99, true), false)).toEqual({ kind: 'seek', t: 2, play: false }))
  test('paused and aligned does nothing', () => expect(syncAction({ seconds: 2 }, v(2, true), false)).toEqual({ kind: 'none', play: false }))
})

// 재생 fps: the playing tolerance grows with the rate (the playhead moves several frames per refresh), slow rates keep 2 frames
test('syncAction: playing tolerance scales with the playback rate', () => {
  expect(syncAction({ seconds: 1 }, v(1 + 5 / 60, false), true, 4)).toEqual({ kind: 'none', play: true }) // 240 fps: within 8 frames
  expect(syncAction({ seconds: 1 }, v(1 + 9 / 60, false), true, 4)).toEqual({ kind: 'seek', t: 1, play: true })
  expect(syncAction({ seconds: 1 }, v(1 + 3 / 60, false), true, 0.5)).toEqual({ kind: 'seek', t: 1, play: true }) // 30 fps: still 2 frames
})
