import { test, expect, type Page } from '@playwright/test'

// 관절 패널 개편 (spec 2026-10-19-pose-panel-design.md §2): the whole robot in the inspector — 몸통 (무대 위치 · 자세) rows,
// every part with a header, 기본 서기로, 네 발/두 발 위치 고정; the clip-view key row deletes a whole pose (§1).
const boot = async (page: Page) => {
  await page.goto('/')
  await expect(page.locator('#stage canvas')).toBeVisible({ timeout: 30000 })
}
const add = (page: Page, robot: 'g1' | 'go2') => page.evaluate(robot => {
  const ed = (window as any).__editor
  ed.getState().addActor(robot)
  const a = ed.getState().project.actors.at(-1)
  ed.getState().select(a.id, null)
  return a.id as string
}, robot)

test('GO2: parts in FR FL RR RL order, body rows, 무대 X + undo, 기본 서기로, foot lock disables joints', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', e => errors.push(String(e)))
  await boot(page)
  const id = await add(page, 'go2')
  const panel = page.getByRole('group', { name: '관절 패널' })
  await expect(panel).toBeVisible()
  await expect(panel.locator('.jp-part')).toHaveText(['오른앞 (FR)', '왼앞 (FL)', '오른뒤 (RR)', '왼뒤 (RL)'])
  await expect(panel.locator('input[type=range]')).toHaveCount(18)
  await expect(panel.locator('.jp-row', { hasText: '고관절' })).toHaveCount(4)

  const bodyX = () => page.evaluate(id => (window as any).__editor.getState().poseAt(id).body.x as number, id)
  const x0 = await bodyX()
  const num = panel.getByRole('spinbutton', { name: '무대 X 숫자' })
  await num.fill('0.5'); await num.press('Enter')
  await expect.poll(bodyX).toBeCloseTo(0.5, 3)
  await page.keyboard.press('Control+z') // Enter blurred the input
  await expect.poll(bodyX).toBeCloseTo(x0, 3)

  // 기본 서기로: joints = rest.q
  await page.evaluate(id => { const s = (window as any).__editor.getState(); s.editPose(id, { FL_calf_joint: -1.2, FR_thigh_joint: 1.1 }) }, id)
  await panel.getByRole('button', { name: '기본 서기로' }).click()
  const diff = await page.evaluate(id => { const s = (window as any).__editor.getState(), p = s.poseAt(id)
    return Math.max(...p.q.map((x: number, i: number) => Math.abs(x - p.def.rest.q[i]))) }, id)
  expect(diff).toBeLessThan(1e-3)

  // 네 발 위치 고정 → joint rows and 기본 서기로 disabled
  const lock = panel.getByRole('button', { name: '네 발 위치 고정' })
  await lock.click()
  await expect(lock).toHaveAttribute('aria-pressed', 'true')
  await expect(panel.getByRole('slider', { name: 'FL_calf_joint 슬라이더' })).toBeDisabled()
  await expect(panel.getByRole('button', { name: '기본 서기로' })).toBeDisabled()
  await expect(panel.getByRole('slider', { name: '무대 X 슬라이더' })).toBeEnabled()
  await num.fill('4'); await num.press('Enter') // too far for the legs: refused, 안내
  await expect(panel.getByRole('status')).toHaveText('네 발을 고정한 채 더 움직일 수 없습니다')
  await expect.poll(bodyX).toBeCloseTo(x0, 3)
  await expect(num).toHaveValue(x0.toFixed(3)) // the box shows the unchanged value, not the refused 4
  // 바닥 밀착 → 높이 disabled
  await panel.getByRole('checkbox', { name: '바닥 밀착 (높이 자동)' }).check()
  await expect(panel.getByRole('slider', { name: '높이 슬라이더' })).toBeDisabled()
  // 체중 이동 (§18): the body 2 cm along its heading, the feet held (also with 네 발 위치 고정 off), one undo per click
  await lock.click()
  await expect(lock).toHaveAttribute('aria-pressed', 'false')
  await panel.getByRole('button', { name: '기본 서기로' }).click()
  const feet = () => page.evaluate(id => { const s = (window as any).__editor.getState(), p = s.poseAt(id); return { x: p.body.x as number, q: p.q as number[] } }, id)
  const a = await feet()
  await panel.getByRole('group', { name: '체중 이동' }).getByRole('button', { name: '▲ 앞' }).click()
  await expect.poll(async () => (await feet()).x - a.x).toBeCloseTo(0.02, 3) // facing +x: 앞 = +x
  expect(Math.max(...(await feet()).q.map((v, i) => Math.abs(v - a.q[i])))).toBeGreaterThan(0.005) // the legs bent to keep the feet
  await page.keyboard.press('Control+z')
  await expect.poll(async () => (await feet()).x).toBeCloseTo(a.x, 4)
  expect(errors).toEqual([])
})

test('G1: part headers from RobotDef.groups, 두 발 위치 고정', async ({ page }) => {
  await boot(page)
  await add(page, 'g1')
  const panel = page.getByRole('group', { name: '관절 패널' })
  await expect(panel.locator('.jp-part')).toHaveText(['왼다리', '오른다리', '허리', '왼팔', '오른팔'])
  await expect(panel.getByRole('button', { name: '두 발 위치 고정' })).toBeVisible()
})

test('clip view key row: Delete on one ◆ removes every channel key at that frame, the other frame stays', async ({ page }) => {
  await boot(page)
  const id = await add(page, 'go2')
  await page.evaluate(id => {
    const w = window as any, s = w.__editor.getState(), it = s.project.sequence.tracks.find((t: any) => t.actorId === id).items[0]
    s.openItem(it.id); s.setView('tracks'); s.select(id, null)
    s.setFrame(30); s.keyPose(id); s.setFrame(90); s.keyPose(id)
    w.__tv.ppf = 4; w.__tv.scrollF = 0
  }, id)
  const keysAt = () => page.evaluate(id => {
    const s = (window as any).__editor.getState(), it = s.project.sequence.tracks.find((t: any) => t.actorId === id).items[0]
    const at = (f: number) => Object.values(it.offset ?? {}).filter((c: any) => c.keys.some((k: any) => k.f === f)).length
    return [at(30), at(90)]
  }, id)
  const n = 6 + 12
  expect(await keysAt()).toEqual([n, n])
  const cv = page.locator('.track-canvas')
  const box = (await cv.boundingBox())!
  await page.mouse.click(box.x + 160 + 30 * 4, box.y + 24 + 10)
  await expect.poll(() => page.evaluate(() => (window as any).__editor.getState().sel.keys.length)).toBe(n)
  await page.keyboard.press('Delete')
  await expect.poll(keysAt).toEqual([0, n])
})
