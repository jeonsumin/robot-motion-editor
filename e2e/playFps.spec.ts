import { test, expect } from '@playwright/test'

// 재생 fps (user, 수정변동사항.md §8): frames per second the playback runs at; data stays 60 fps. Presets + 직접 입력 (1~240),
// not 60 = orange + the wall-clock playback time beside it.
test('재생 fps: presets, the playback speed follows, 직접 입력 checks 1~240, playback time shows off 60', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('#stage canvas')).toBeVisible({ timeout: 30000 })
  await page.evaluate(() => { const ed = (window as any).__editor; ed.getState().addActor('g1'); const p = ed.getState().project, c = Object.values(p.clips)[0] as any
    const a = p.actors[0].id; for (let i = 1; i < 30; i++) ed.getState().addItem(a, c.id, i * c.length) }) // a long sequence to play through
  const btn = page.getByRole('button', { name: /^재생 \d+fps/ }), menu = page.getByRole('menu', { name: '재생 fps' })
  const st = () => page.evaluate(() => { const s = (window as any).__editor.getState(); return { frame: s.frame as number, fps: s.playFps as number } })
  const advance = async (ms: number) => { // frames played in `ms` of real time
    await page.evaluate(() => { const s = (window as any).__editor.getState(); s.setFrame(0); s.setPlaying(true) })
    const a = (await st()).frame; await page.waitForTimeout(ms)
    const b = (await st()).frame; await page.evaluate(() => (window as any).__editor.getState().setPlaying(false))
    return b - a
  }
  await expect(btn).toHaveText(/재생 60fps/)
  await expect(page.locator('.tl-playtime')).toHaveCount(0)

  await btn.click()
  await expect(menu.getByRole('menuitemradio')).toHaveText(['1fps', '5fps', '15fps', '30fps', '✓60fps (원래 속도)', '120fps', '240fps'])
  await menu.getByRole('menuitemradio', { name: '30fps' }).click()
  await expect(btn).toHaveText(/재생 30fps/)
  await expect(btn).toHaveClass(/on/)
  const end = await page.evaluate(() => { const p = (window as any).__editor.getState().project; return Math.max(...p.sequence.tracks.flatMap((t: any) => t.items.map((i: any) => i.start + i.trimOut - i.trimIn))) })
  const mmss = (s: number) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
  await expect(page.locator('.tl-playtime')).toHaveText(`재생 00:00 / ${mmss(Math.floor(end / 30))}`)
  const n30 = await advance(1000)
  expect(n30).toBeGreaterThan(18); expect(n30).toBeLessThan(42) // ~30 frames a second

  await btn.click(); await menu.getByRole('menuitemradio', { name: '1fps' }).click()
  const n1 = await advance(2100)
  expect(n1).toBeGreaterThanOrEqual(1); expect(n1).toBeLessThanOrEqual(3) // one frame a second

  // 직접 입력: out of range → message; 12 → used and listed at the end, checked
  await btn.click(); await menu.getByRole('menuitem', { name: '직접 입력…' }).click()
  const input = page.getByLabel('초당 재생 프레임 수')
  await input.fill('300'); await input.press('Enter')
  await expect(page.getByText('1~240 사이 정수로 입력하세요')).toBeVisible()
  await input.fill('12'); await input.press('Enter')
  await expect(btn).toHaveText(/재생 12fps/)
  expect((await st()).fps).toBe(12)
  await btn.click()
  await expect(menu.getByRole('menuitemradio').last()).toHaveText('✓12fps')
  await page.keyboard.press('Escape')
  await expect(menu).toHaveCount(0)

  await btn.click(); await menu.getByRole('menuitemradio', { name: '60fps (원래 속도)' }).click()
  await expect(btn).not.toHaveClass(/on/)
  await expect(page.locator('.tl-playtime')).toHaveCount(0)
})
