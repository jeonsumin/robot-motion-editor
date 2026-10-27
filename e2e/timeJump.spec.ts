import { test, expect } from '@playwright/test'

// 시간·프레임 입력해서 이동 (user, 수정변동사항.md §5): click the current time in the timeline header, type a frame number or
// m:ss.ff, Enter moves the playhead there (clamped to 0..end, the view follows); a bad entry says so; Esc cancels; works while pinned.
test('time jump: frame number or m:ss.ff; clamp; bad entry; Esc; pinned stays pinned; the view follows', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('#stage canvas')).toBeVisible({ timeout: 30000 })
  await page.evaluate(() => { const s = (window as any).__editor.getState(); s.addActor('g1'); s.addActor('g1'); s.setFrame(10); s.setPlayheadPinned(true) })
  const st = () => page.evaluate(() => { const s = (window as any).__editor.getState(), tv = (window as any).__tv; return { frame: s.frame as number, pinned: s.playheadPinned as boolean, scrollF: tv.scrollF as number } })
  const end = await page.evaluate(() => { const p = (window as any).__editor.getState().project; return Math.max(...p.sequence.tracks.flatMap((t: any) => t.items.map((i: any) => i.start + i.trimOut - i.trimIn))) })
  const open = page.getByRole('button', { name: '시간 입력해서 이동' }), input = page.getByLabel('이동할 프레임 또는 시간')

  await open.click()
  await expect(input).toHaveValue('00:00.10') // starts with the current time, selected
  await input.fill('60'); await input.press('Enter')
  await expect.poll(st).toMatchObject({ frame: 60, pinned: true })
  await expect(input).toHaveCount(0)

  await open.click(); await input.fill('00:01.30'); await input.press('Enter')
  await expect.poll(async () => (await st()).frame).toBe(90)

  await open.click(); await input.fill('abc'); await input.press('Enter')
  await expect(page.getByText('프레임 번호 또는 분:초.프레임으로 입력하세요')).toBeVisible()
  await input.press('Escape')
  await expect(input).toHaveCount(0)
  expect((await st()).frame).toBe(90)

  await open.click(); await input.fill('999999'); await input.press('Enter') // past the end: the end
  await expect.poll(async () => (await st()).frame).toBe(end)

  // far off screen: the view moves so the playhead shows
  await page.evaluate(() => { (window as any).__tv.ppf = 20; (window as any).__tv.scrollF = 0 })
  await open.click(); await input.fill(String(end - 5)); await input.press('Enter')
  await expect.poll(async () => (await st()).scrollF, { timeout: 3000 }).toBeGreaterThan(end - 5 - 2000 / 20)
})
