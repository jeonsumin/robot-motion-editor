import { test, expect, type Page } from '@playwright/test'

// GO2 발 걸음 이음매 (§19): the piece menu shows the boundary's state and its own switch; the project default is one switch.
// Two pieces standing still: wide stance, then narrow stance (each foot ~11 cm in) — with it on the feet step instead of gliding.
const build = (page: Page) => page.evaluate(async () => {
  const { parseCsvPoses, posesToClip } = await import('/src/export/importCsv.ts')
  const s = (window as any).__editor.getState()
  const hold = async (file: string, id: string) => {
    const text = await (await fetch(`/go2-blocks/${encodeURI(file)}`)).text()
    const { robot, fps, poses } = parseCsvPoses(text, s.defs, 60), last = poses[poses.length - 1]
    return { ...posesToClip(Array.from({ length: 120 }, () => structuredClone(last)), fps, robot, s.defs, id), id }
  }
  s.appendClip(null, await hold('기본 자세/007_넓게_서기.csv', 'wide'))
  const actor = (window as any).__editor.getState().project.actors.at(-1).id
  const ib = (window as any).__editor.getState().appendClip(actor, await hold('기본 자세/008_좁게_서기.csv', 'narrow'))
  return { actor, ib }
})
const item = (page: Page, id: string) => page.evaluate(id => {
  const p = (window as any).__editor.getState().project
  return { step: p.sequence.tracks.flatMap((t: any) => t.items).find((i: any) => i.id === id).step ?? null, stepSeam: p.stepSeam ?? null }
}, id)

test('발 걸음 이음매: off by default; the project switch and the piece switch from the piece menu; its state in the menu', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', e => errors.push(String(e)))
  await page.goto('/')
  await expect(page.locator('#stage canvas')).toBeVisible({ timeout: 30000 })
  const { ib } = await build(page)
  const open = page.getByRole('button', { name: /클립 목록$/ }).first()
  if (await open.getAttribute('aria-expanded') !== 'true') await open.click()
  const cv = page.locator('.seq-canvas'), box = (await cv.boundingBox())!, rowY = (n: number) => box.y + 24 + 28 * n + 14
  const menu = page.getByRole('menu', { name: '클립' })
  const openMenu = async () => { await page.mouse.click(box.x + 80, rowY(2), { button: 'right' }); await expect(menu).toBeVisible() }

  // off: the menu says so; the project default turns it on for every boundary
  await openMenu()
  await expect(menu.locator('.tl-menu-sep')).toContainText('발 걸음 이음매 (이 조각 시작)')
  await expect(menu.locator('.tl-menu-sep')).toContainText('꺼짐')
  await menu.getByRole('menuitemcheckbox', { name: '발 걸음 이음매 기본값 (프로젝트)' }).click()
  await expect.poll(() => item(page, ib)).toEqual({ step: null, stepSeam: true })
  await openMenu()
  await expect(menu.locator('.tl-step.ok')).toHaveText('발 걸음 이음매 적용')
  await expect(menu.locator('.tl-menu-sep')).toContainText('발 4개를 대각 두 발씩 들어 옮김')
  await expect(menu.getByRole('menuitemradio', { name: '기본값 따르기 (켜짐)' })).toHaveAttribute('aria-checked', 'true')
  // hover help on the lane says the same
  await page.keyboard.press('Escape')
  await page.mouse.move(box.x + 80, rowY(2))
  await expect.poll(() => cv.getAttribute('title')).toContain('발 걸음 이음매: 발 걸음 이음매 적용')

  // this piece off, one undo back
  await openMenu()
  await menu.getByRole('menuitemradio', { name: '끄기' }).click()
  await expect.poll(() => item(page, ib)).toEqual({ step: false, stepSeam: true })
  await openMenu()
  await expect(menu.locator('.tl-menu-sep')).toContainText('꺼짐')
  await page.keyboard.press('Escape')
  await page.evaluate(() => (window as any).__editor.getState().undo())
  await expect.poll(() => item(page, ib)).toEqual({ step: null, stepSeam: true })

  // 전이 조각 넣기 (adds time, only from the menu): the menu says how much later the piece starts; one undo takes it out
  const starts = () => page.evaluate(() => (window as any).__editor.getState().project.sequence.tracks.find((t: any) => t.kind === 'motion').items
    .map((i: any) => i.start).sort((a: number, b: number) => a - b))
  const s0 = await starts()
  await openMenu()
  const add = menu.getByRole('menuitem', { name: /^전이 조각 넣기 — 뒤 조각 [\d.]+초 밀림$/ })
  const sec = Number((await add.textContent())!.match(/([\d.]+)초/)![1])
  await add.click()
  await expect.poll(starts).toEqual([s0[0], s0[1], s0[1] + Math.round(sec * 60)])
  await expect(page.locator('.seq-msg')).toContainText(`전이 조각 ${sec.toFixed(1)}초를 넣고`)
  await page.evaluate(() => (window as any).__editor.getState().undo())
  await expect.poll(starts).toEqual(s0)
  expect(errors).toEqual([])
})
