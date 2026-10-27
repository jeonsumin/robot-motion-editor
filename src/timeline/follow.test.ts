import { expect, test } from 'vitest'
import { followTarget, wheelFrames } from './follow'

const V = 300, END = 3000 // visible frames, content end

test('play: inside the window before the right margin -> no change', () => {
  expect(followTarget(100, 0, V, END, 'play')).toBeNull()
  expect(followTarget(254, 0, V, END, 'play')).toBeNull()
})
test('play: past the right margin keeps the playhead at the margin', () => {
  expect(followTarget(300, 0, V, END, 'play')).toBe(45) // 300 - 0.85*300
  expect(followTarget(1000, 700, V, END, 'play')).toBeCloseTo(745)
})
test('play: past the left edge scrolls back, never below 0', () => {
  expect(followTarget(500, 800, V, END, 'play')).toBeCloseTo(455)
  expect(followTarget(10, 800, V, END, 'play')).toBe(0)
})
test('jump: visible playhead -> no change', () => {
  expect(followTarget(290, 0, V, END, 'jump')).toBeNull()
})
test('jump: outside puts the playhead at 30% from the left', () => {
  expect(followTarget(2000, 0, V, END, 'jump')).toBeCloseTo(1910)
  expect(followTarget(500, 1000, V, END, 'jump')).toBeCloseTo(410)
})
test('jump: near 0 -> scrollF 0', () => {
  expect(followTarget(20, 1000, V, END, 'jump')).toBe(0)
})
test('clamps to contentEnd - 0.85*visible', () => {
  expect(followTarget(2990, 0, V, END, 'jump')).toBeCloseTo(3000 - 255)
  expect(followTarget(2990, 0, V, END, 'play')).toBeCloseTo(2990 - 255)
})
test('content shorter than window -> 0', () => {
  expect(followTarget(500, 50, V, 100, 'jump')).toBe(0)
})

test('wheelFrames: up = later, down = earlier; a sideways swipe keeps its direction; lines become px', () => {
  expect(wheelFrames({ deltaX: 0, deltaY: -100, deltaMode: 0 }, 4)).toBe(25)
  expect(wheelFrames({ deltaX: 0, deltaY: 100, deltaMode: 0 }, 4)).toBe(-25)
  expect(wheelFrames({ deltaX: 80, deltaY: 10, deltaMode: 0 }, 4)).toBe(20)
  expect(wheelFrames({ deltaX: 0, deltaY: -3, deltaMode: 1 }, 4)).toBe(30)
})
