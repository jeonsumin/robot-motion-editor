import { test, expect, type Page } from '@playwright/test'

// GO2 걷기 블록 1차 (§20): 라이브러리 › 걷기 (가상) adds a made walk at the track end; the inspector of a selected 걷기 piece
// changes it (시간 ⇄ 속도, the later pieces move); the bar says what it does and its state; the stage shows path, ring and heading.
const boot = async (page: Page) => {
  await page.goto('/')
  await expect(page.locator('#stage canvas')).toBeVisible({ timeout: 30000 })
}
const items = (page: Page, actor: string) => page.evaluate(id => {
  const p = (window as any).__editor.getState().project
  return p.sequence.tracks.find((t: any) => t.actorId === id).items.map((i: any) => ({ id: i.id, start: i.start, len: i.trimOut - i.trimIn, walk: i.walk ?? null }))
    .sort((a: any, b: any) => a.start - b.start)
}, actor)

test('걷기 (가상): add from the library, change it in the inspector, its state on the bar and the stage', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', e => errors.push(String(e)))
  await boot(page) // the app starts empty: the walk makes a new GO2

  // library row under Empty, its panel
  await page.getByRole('tab', { name: '라이브러리' }).click()
  const row = page.locator('.pp-row[data-kind=walk]')
  await expect(row.locator('.pp-name')).toHaveText('걷기 (가상)')
  await row.click()
  const panel = page.locator('.pp-blk')
  await expect(panel.getByRole('combobox', { name: '붙일 로봇' }).locator('option')).toHaveText(['새 GO2 로봇 (0초부터)']) // no 목록에만 추가
  await panel.getByRole('spinbutton', { name: '도착 X' }).fill('1.5')
  await panel.getByRole('spinbutton', { name: '도착 Y' }).fill('0.5')
  await panel.getByRole('spinbutton', { name: '도착 Y' }).press('Enter')
  await panel.getByRole('spinbutton', { name: '시간' }).fill('3')
  await panel.getByRole('spinbutton', { name: '시간' }).press('Enter')
  await expect(panel.locator('.wk-tone')).toContainText('정상')
  await expect(panel.locator('[role=note]')).toContainText('출발점에서')
  await panel.getByRole('button', { name: '추가', exact: true }).click()
  await expect(panel.locator('.pp-msg')).toContainText('걷기를 추가했습니다')
  const actor = await page.evaluate(() => (window as any).__editor.getState().project.actors.at(-1).id as string)
  await expect(panel.getByRole('combobox', { name: '붙일 로봇' }).locator('option')).toHaveCount(2) // now that GO2 (트랙 끝) too
  let its = await items(page, actor)
  expect(its).toHaveLength(1)
  expect(its[0]).toMatchObject({ start: 0, len: 180, walk: { to: [1.5, 0.5], face: 'keep' } })

  // the robot ends on the target (stage)
  const at = (f: number) => page.evaluate(([id, f]) => { const s = (window as any).__editor.getState(); s.setFrame(f); return (window as any).__stage.entries().get(id).dot.position.toArray() }, [actor, f] as const)
  const end = await at(179)
  expect(end[0]).toBeCloseTo(1.5, 2); expect(end[1]).toBeCloseTo(0.5, 2)

  // a piece after it: the walk's time in the inspector pushes it back; one undo
  await page.evaluate(id => { const s = (window as any).__editor.getState(); s.addWalk(id, { to: [2.5, 0.5], face: 'audience' }, 120) }, actor)
  its = await items(page, actor)
  await page.evaluate(([a, id]) => { const s = (window as any).__editor.getState(); s.selectItem(id); s.select(a); s.setFrame(0) }, [actor, its[0].id] as const)
  const insp = page.locator('.insp')
  await expect(insp.getByRole('heading', { name: '걷기 조각' })).toBeVisible()
  await insp.getByRole('spinbutton', { name: '시간' }).fill('4')
  await insp.getByRole('spinbutton', { name: '시간' }).press('Enter')
  await expect(insp.locator('.insp-hint[role=status]')).toContainText('뒤 조각이 1.0초 밀렸습니다')
  expect((await items(page, actor)).map(i => [i.start, i.len])).toEqual([[0, 240], [240, 120]])
  // speed instead of time: 0.5 m/s over the distance
  const dist = await page.evaluate(() => Math.hypot(1.5, 0.5))
  await insp.getByRole('spinbutton', { name: '속도' }).fill('0.5')
  await insp.getByRole('spinbutton', { name: '속도' }).press('Enter')
  await expect.poll(async () => (await items(page, actor))[0].len).toBe(Math.round(dist / 0.5 * 60))
  await page.evaluate(() => { (window as any).__editor.getState().undo(); (window as any).__editor.getState().undo() })
  expect((await items(page, actor)).map(i => [i.start, i.len])).toEqual([[0, 180], [180, 120]])

  // too fast (§22 안정성 우선): not applied — the reasons and 최소 시간으로 (only when pressed; the piece after it moves)
  await insp.getByRole('spinbutton', { name: '시간' }).fill('0.8')
  await insp.getByRole('spinbutton', { name: '시간' }).press('Enter')
  const refusedBox = insp.getByRole('alert')
  await expect(refusedBox).toContainText('적용하지 않았습니다 — 한계 초과가 됩니다')
  await expect(refusedBox.locator('.wk-why.bad').first()).toBeVisible()
  expect((await items(page, actor)).map(i => [i.start, i.len])).toEqual([[0, 180], [180, 120]])
  await expect(insp.getByRole('spinbutton', { name: '시간' })).toHaveValue('3') // the box shows the piece again
  const fix = refusedBox.getByRole('button', { name: /^최소 시간 [\d.]+초로( 하고 적용)? — 뒤 조각 [\d.]+초 (밀림|당겨짐)$/ })
  const minF = Math.round(Number((await fix.textContent())!.match(/최소 시간 ([\d.]+)초/)![1]) * 60)
  expect(minF).toBeLessThan(180)
  await fix.click()
  await expect.poll(async () => (await items(page, actor)).map(i => [i.start, i.len])).toEqual([[0, minF], [minF, 120]])
  await expect(insp.locator('.wk-tone')).not.toContainText('한계 초과')
  await page.evaluate(() => (window as any).__editor.getState().undo())
  expect((await items(page, actor)).map(i => [i.start, i.len])).toEqual([[0, 180], [180, 120]])

  // the bar: label and state in the lane help
  const open = page.getByRole('button', { name: /클립 목록$/ }).first()
  if (await open.getAttribute('aria-expanded') !== 'true') await open.click()
  const cv = page.locator('.seq-canvas'), box = (await cv.boundingBox())!
  await page.mouse.move(box.x + 80, box.y + 24 + 28 + 14)
  await expect.poll(() => cv.getAttribute('title')).toContain('걷기: 정상')

  // the stage: dashed path, target ring, heading arrow while it is selected
  const guide = () => page.evaluate(() => { const g = (window as any).__stage.walkGuide(); return { on: g.visible, n: g.children.length } })
  await expect.poll(guide).toEqual({ on: true, n: 3 })
  await page.evaluate(() => (window as any).__editor.getState().selectItem(null))
  await expect.poll(async () => (await guide()).on).toBe(false)

  // made, not edited: no trim from the front, no cut, no 기본자세
  const refused = await page.evaluate(id => {
    const s = (window as any).__editor.getState()
    return [s.trimItem(id, 'in', 10), s.setRestPose(id, 'prepend'), s.setRestTail(id, true)]
  }, its[0].id)
  expect(refused).toEqual([false, false, false])
  expect(errors).toEqual([])
})

test('도착 위치를 무대에서: 찍기 (라이브러리 · 인스펙터, Esc 취소) and the selected walk\'s ring dragged (one undo)', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', e => errors.push(String(e)))
  await boot(page)
  const at = (x: number, y: number) => page.evaluate(([x, y]) => (window as any).__stage.screenOf(x, y) as [number, number], [x, y] as const)

  // 라이브러리: 찍기, the floor clicked → 도착 X / Y; the button turns off
  await page.getByRole('tab', { name: '라이브러리' }).click()
  await page.locator('.pp-row[data-kind=walk]').click()
  const panel = page.locator('.pp-blk'), btn = panel.getByRole('button', { name: '무대에서 찍기' })
  await btn.click()
  await expect(panel.locator('.wk-pick')).toHaveAttribute('aria-pressed', 'true')
  let [x, y] = await at(0.8, 0.4)
  await page.mouse.move(x - 20, y); await page.mouse.move(x, y)
  await expect.poll(() => page.evaluate(() => (window as any).__stage.walkPickShown())).toBe(true)
  await expect(page.locator('.wk-pick-tag')).toContainText(/^X 0\.(79|80|81) · Y 0\.(39|40|41) m · 출발점에서/)
  await page.mouse.click(x, y)
  await expect.poll(async () => Math.hypot(Number(await panel.getByRole('spinbutton', { name: '도착 X' }).inputValue()) - 0.8,
    Number(await panel.getByRole('spinbutton', { name: '도착 Y' }).inputValue()) - 0.4)).toBeLessThanOrEqual(0.03) // whole pixels: ±1 cm
  const picked = [Number(await panel.getByRole('spinbutton', { name: '도착 X' }).inputValue()), Number(await panel.getByRole('spinbutton', { name: '도착 Y' }).inputValue())]
  await expect(panel.locator('.wk-pick')).toHaveAttribute('aria-pressed', 'false')
  expect(await page.evaluate(() => (window as any).__stage.walkPickShown())).toBe(false)
  // Esc cancels without a change
  await btn.click(); [x, y] = await at(0.2, -0.6); await page.mouse.move(x, y)
  await page.keyboard.press('Escape')
  await expect(panel.locator('.wk-pick')).toHaveAttribute('aria-pressed', 'false')
  await page.mouse.click(x, y)
  await expect(panel.getByRole('spinbutton', { name: '도착 X' })).toHaveValue(String(picked[0]))
  await panel.getByRole('button', { name: '추가', exact: true }).click()
  const actor = await page.evaluate(() => (window as any).__editor.getState().project.actors.at(-1).id as string)
  const walkOfIt = () => page.evaluate(() => { const p = (window as any).__editor.getState().project; return p.sequence.tracks.flatMap((t: any) => t.items).find((i: any) => i.walk) })
  const id = (await walkOfIt()).id
  expect((await walkOfIt()).walk.to).toEqual(picked)

  // 인스펙터: 찍기 on the selected piece — one undo back
  await page.evaluate(([a, id]) => { const s = (window as any).__editor.getState(); s.selectItem(id); s.select(a); s.setFrame(0) }, [actor, id] as const)
  const insp = page.locator('.insp')
  await insp.getByRole('button', { name: '무대에서 찍기' }).click();
  [x, y] = await at(1.2, -0.3)
  await page.mouse.move(x, y); await page.mouse.click(x, y)
  await expect.poll(async () => { const t = (await walkOfIt()).walk.to; return Math.hypot(t[0] - 1.2, t[1] + 0.3) <= 0.03 }).toBe(true)
  expect(await page.evaluate(() => (window as any).__editor.getState().sel.actorId)).toBe(actor) // the click did not deselect
  await page.evaluate(() => (window as any).__editor.getState().undo())
  expect((await walkOfIt()).walk.to).toEqual(picked)

  // the ring of the selected walk dragged: one change on release, one undo; the camera did not move
  await expect.poll(() => page.evaluate(() => (window as any).__stage.walkGuide().visible)).toBe(true)
  const cam0 = await page.evaluate(() => (window as any).__stage.camera.position.toArray())
  const [rx, ry] = await at(picked[0], picked[1]), [tx, ty] = await at(1.1, 0.3)
  await page.mouse.move(rx, ry); await page.mouse.down()
  await page.mouse.move((rx + tx) / 2, (ry + ty) / 2); await page.mouse.move(tx, ty)
  expect((await walkOfIt()).walk.to).toEqual(picked) // nothing until release
  await page.mouse.up()
  await expect.poll(async () => { const t = (await walkOfIt()).walk.to; return Math.hypot(t[0] - 1.1, t[1] - 0.3) <= 0.03 }).toBe(true) // (mouse on whole pixels: a cm or two at this zoom)
  expect(await page.evaluate(() => (window as any).__stage.camera.position.toArray())).toEqual(cam0)
  await page.evaluate(() => (window as any).__editor.getState().undo())
  expect((await walkOfIt()).walk.to).toEqual(picked)
  expect(errors).toEqual([])
})
