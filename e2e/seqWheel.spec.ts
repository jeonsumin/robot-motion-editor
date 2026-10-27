import { test, expect, type Page } from '@playwright/test'

// Sequence wheel (user, 수정변동사항.md §4): a plain wheel moves through time — up = later, down = earlier — and the playhead keeps
// following the pointer (unless 재생헤드 고정); Shift + wheel or a wheel over the track labels scrolls the rows; a sideways
// trackpad swipe scrolls time; Ctrl + wheel zooms.
const boot = async (page: Page) => {
  await page.goto('/')
  await expect(page.locator('#stage canvas')).toBeVisible({ timeout: 30000 })
}
const st = (page: Page) => page.evaluate(() => { const w = window as any; return { scrollF: w.__tv.scrollF as number, frame: w.__editor.getState().frame as number, pinned: w.__editor.getState().playheadPinned as boolean } })

test('sequence wheel: up = later, down = earlier, the playhead follows the pointer; Shift = rows; sideways = time', async ({ page }) => {
  await boot(page)
  await page.evaluate(() => { const s = (window as any).__editor.getState(); s.addActor('g1'); (window as any).__tv.scrollF = 100 })
  const box = (await page.locator('.seq-canvas').boundingBox())!
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.5)
  await expect.poll(async () => (await st(page)).frame).toBeGreaterThan(100) // hover: the playhead is under the pointer
  const a = await st(page)
  await page.mouse.wheel(0, -400) // up
  await expect.poll(async () => (await st(page)).scrollF).toBeGreaterThan(a.scrollF)
  const b = await st(page)
  await expect.poll(async () => (await st(page)).frame).toBe(a.frame + Math.round(b.scrollF - a.scrollF)) // same screen spot, later frame
  await page.mouse.wheel(0, 400) // down: back
  await expect.poll(async () => (await st(page)).scrollF).toBeLessThan(b.scrollF)

  const c = await st(page)
  await page.keyboard.down('Shift'); await page.mouse.wheel(0, 400); await page.keyboard.up('Shift')
  await page.waitForTimeout(100)
  expect((await st(page)).scrollF).toBe(c.scrollF) // Shift: rows, not time
  await page.mouse.wheel(300, 0) // sideways swipe
  await expect.poll(async () => (await st(page)).scrollF).toBeGreaterThan(c.scrollF)
})

// Rows that fit must not move at all on the wheel — not even for one frame (the old code drew them shifted, then snapped back:
// flicker); rows that overflow ease to the end and stop there. The wheel is over the track labels (rows there, not time).
test('sequence wheel over the labels: no one-frame shift when the rows fit; eased scroll that stops at the end', async ({ page }) => {
  await boot(page)
  await page.evaluate(() => (window as any).__editor.getState().addActor('g1'))
  const frames = (dy: number, n = 8) => page.evaluate(async ([dy, n]) => {
    const c = document.querySelector<HTMLCanvasElement>('.seq-canvas')!, r = c.getBoundingClientRect(), out: string[] = []
    await new Promise(res => requestAnimationFrame(() => requestAnimationFrame(res)))
    out.push(c.toDataURL())
    c.dispatchEvent(new WheelEvent('wheel', { deltaY: dy, clientX: r.left + 80, clientY: r.top + r.height * 0.6, bubbles: true, cancelable: true }))
    for (let i = 0; i < n; i++) { await new Promise(res => requestAnimationFrame(res)); out.push(c.toDataURL()) }
    return out
  }, [dy, n] as const)
  await page.evaluate(() => document.fonts.ready) // the canvas redraws once IBM Plex arrives: not a wheel effect
  const fit = await frames(120)
  expect(new Set(fit).size).toBe(1) // nothing moved in any frame

  await page.evaluate(() => { const s = (window as any).__editor.getState(); for (let i = 0; i < 12; i++) s.addActor(i % 2 ? 'go2' : 'g1') }) // rows overflow
  const down = await frames(100000, 40) // far past the end
  expect(new Set(down).size).toBeGreaterThan(2) // eased over several frames
  expect(down.at(-1)).toBe(down.at(-2)) // and settled
  const again = await frames(500, 6) // already at the end: no frame changes
  expect(new Set(again).size).toBe(1)
})

// 재생헤드 고정 (user): ruler / empty-space right-click menu; pinned = the pointer no longer moves the playhead, the wheel moves the
// view (the playhead keeps its frame, so it shifts on screen), a ruler click still moves it; 고정 해제 brings the pointer-follow back.
test('재생헤드 고정: right-click menu; the pointer and the wheel leave the frame; a ruler click moves it; 고정 해제', async ({ page }) => {
  await boot(page)
  await page.evaluate(() => { const s = (window as any).__editor.getState(); s.addActor('g1'); s.setFrame(40); (window as any).__tv.scrollF = 0 })
  const box = (await page.locator('.seq-canvas').boundingBox())!, xAt = (f: number) => page.evaluate(f => { const tv = (window as any).__tv; return 160 + (f - tv.scrollF) * tv.ppf }, f)
  await page.mouse.click(box.x + await xAt(40), box.y + 10, { button: 'right' }) // ruler
  const menu = page.getByRole('menu', { name: '재생헤드' })
  await menu.getByRole('menuitem', { name: '재생헤드 고정' }).click()
  await expect.poll(async () => (await st(page)).pinned).toBe(true)
  await page.mouse.move(box.x + await xAt(150), box.y + box.height * 0.5)
  await page.mouse.move(box.x + await xAt(160), box.y + box.height * 0.5)
  await page.waitForTimeout(150)
  expect((await st(page)).frame).toBe(40) // pinned: the pointer does not move it
  await page.mouse.wheel(0, -400)
  await expect.poll(async () => (await st(page)).scrollF).toBeGreaterThan(0)
  expect((await st(page)).frame).toBe(40) // the view moved, the frame stayed

  await page.evaluate(() => { (window as any).__tv.scrollF = 0 })
  await page.mouse.click(box.x + await xAt(90), box.y + 10) // a ruler click still moves it, and it stays pinned there
  await page.mouse.move(box.x + await xAt(130), box.y + box.height * 0.5)
  await page.waitForTimeout(150)
  expect(await st(page)).toMatchObject({ frame: 90, pinned: true })

  await page.mouse.click(box.x + await xAt(200), box.y + box.height - 60, { button: 'right' }) // empty space
  await menu.getByRole('menuitem', { name: '고정 해제' }).click()
  await page.mouse.move(box.x + await xAt(120), box.y + box.height * 0.5)
  await expect.poll(async () => (await st(page)).frame).toBe(120)
  expect((await st(page)).pinned).toBe(false)
})
