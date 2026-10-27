import { test, expect } from '@playwright/test'
import { importSynthetic } from './synth'

// Right-drag on the sequence opens a 구간 프리뷰 pane that loops that span on its own clock (user); the main playhead, playback and
// In/Out are untouched. ✕ or a right-click on the ruler closes it; a plain right-click still opens the item menu.
test('right-drag opens a looping 구간 프리뷰; main playback untouched; ✕ / ruler right-click close it', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', e => errors.push(String(e)))
  await page.addInitScript(() => { delete (window as any).showOpenFilePicker })
  await page.goto('/')
  await expect(page.locator('#stage canvas')).toBeVisible({ timeout: 30000 })
  await importSynthetic(page, 'lp')
  const cv = page.locator('.seq-canvas'), box = (await cv.boundingBox())!
  const xAt = (f: number) => page.evaluate(f => { const tv = (window as any).__tv; return 160 + (f - tv.scrollF) * tv.ppf }, f)
  const st = () => page.evaluate(() => { const s = (window as any).__editor.getState(); return { span: s.spanPreview, io: [s.project.sequence.inF, s.project.sequence.outF], playing: s.playing } })
  await page.evaluate(() => (window as any).__editor.getState().setFrame(10))

  const y = box.y + 24 + 14, drag = async (a: number, b: number) => {
    await page.mouse.move(box.x + await xAt(a), y); await page.mouse.down({ button: 'right' })
    await page.mouse.move(box.x + await xAt((a + b) / 2), y, { steps: 4 }); await page.mouse.move(box.x + await xAt(b), y, { steps: 4 })
    await page.mouse.up({ button: 'right' })
  }
  await drag(60, 120)
  await expect.poll(st).toEqual({ span: [60, 121], io: [null, null], playing: false })
  await expect(page.getByRole('menu', { name: '클립' })).toHaveCount(0) // a drag opens no menu
  const pane = page.getByRole('region', { name: '구간 프리뷰' })
  await expect(pane).toContainText('구간 프리뷰 · F60–120')

  // the pane loops the span by itself: its robot keeps moving while the sequence is stopped
  const pose = () => page.evaluate(() => { const w = window as any, a = w.__editor.getState().project.actors[0].id
    return w.__stages.span.entries().get(a).rig.jointPivots.left_knee_joint.quaternion.toArray().join() })
  const p0 = await pose()
  await expect.poll(pose).not.toBe(p0)
  expect((await st()).playing).toBe(false)

  await pane.getByRole('button', { name: '구간 프리뷰 닫기' }).click()
  await expect(pane).toHaveCount(0)
  expect((await st()).span).toBeNull()
  await drag(30, 90)
  await expect.poll(async () => (await st()).span).toEqual([30, 91])
  await page.mouse.click(box.x + await xAt(200), box.y + 10, { button: 'right' }) // ruler right-click: its menu closes it
  await page.getByRole('menu', { name: '재생헤드' }).getByRole('menuitem', { name: '구간 프리뷰 닫기' }).click()
  await expect.poll(async () => (await st()).span).toBeNull()
  expect(errors).toEqual([])
})
