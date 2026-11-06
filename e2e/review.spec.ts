import { test, expect, type Page } from '@playwright/test'

// 검수 목록 (§12 · §13 · §14): a CSV whose right wrist flips 2.5 rad at frame 150 (and stays) shows one 로봇 한계 초과 item. Verdicts are saved
// in the project (motion untouched, undoable), 문제 있음 warns on export, 안무여서 놔둠 is listed last and apart in the export.
// The arms swing a little around a pose clear of the torso (no 자가충돌 there); the second test moves the left forearm into it.

// a 300-frame G1 CSV standing in place (legs still, feet planted: no 발 미끄러짐, §16); waist and arms a slow small swing, the arms
// around a clear pose (elbows bent, shoulders a little out); `q(name, i)` overrides a joint
async function importCsv(page: Page, name: string, q: (joint: string, i: number) => number | undefined, x: (i: number) => number = () => 0, z: (i: number) => number = () => 0.78) {
  const joints = await page.evaluate(() => (window as any).__editor.getState().defs.g1.joints.map((j: { name: string }) => j.name) as string[])
  const head = ['frequency(fps)', 'RobotType', 'DOF Number', 'time(ms)', 'position X(m)', 'position Y(m)', 'position Z(m)',
    'quaternion X', 'quaternion Y', 'quaternion Z', 'quaternion W', ...joints].join(',') + ','
  const base = (n: string, j: number, i: number) => /shoulder|elbow/.test(n)
    ? (n.includes('elbow') ? 1.2 : n === 'left_shoulder_roll_joint' ? 0.25 : n === 'right_shoulder_roll_joint' ? -0.25 : 0) + 0.05 * Math.sin(i / 40 + j)
    : /hip|knee|ankle/.test(n) ? 0 : 0.3 * Math.sin(i / 40 + j)
  const csv = Buffer.from([head, ...Array.from({ length: 300 }, (_, i) =>
    [60, 0, 29, Math.round(i * 1000 / 60), x(i).toFixed(6), '0.000000', z(i).toFixed(6), '0', '0', '0', '1',
      ...joints.map((n, j) => (q(n, i) ?? base(n, j, i)).toFixed(6))].join(',') + ',')].join('\n'))
  await page.getByRole('button', { name: '메뉴', exact: true }).click()
  const [fc] = await Promise.all([page.waitForEvent('filechooser'), page.getByRole('menuitem', { name: 'CSV 가져오기', exact: true }).click()])
  await fc.setFiles([{ name: `${name}.csv`, mimeType: 'text/csv', buffer: csv }])
  await expect.poll(() => page.evaluate(() => (window as any).__editor.getState().project.sequence.tracks.some((t: any) => t.items.length))).toBe(true)
}

test('검수 목록 finds a held joint flip, takes a verdict and jumps to it', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', e => errors.push(String(e)))
  await page.addInitScript(() => { delete (window as any).showOpenFilePicker; delete (window as any).showSaveFilePicker }) // file input / plain download: Playwright sees them
  await page.goto('/')
  await expect(page.locator('#stage canvas')).toBeVisible({ timeout: 30000 })
  await importCsv(page, 'flip', (n, i) => (n === 'right_wrist_roll_joint' ? (i >= 150 ? 1.25 : -1.25) + 0.3 * Math.sin(i / 40) : undefined))
  const before = await page.evaluate(() => JSON.stringify((window as any).__editor.getState().project))

  await page.getByRole('button', { name: '⚠ 검수 목록' }).click()
  const dlg = page.getByRole('dialog', { name: '검수 목록' })
  await expect(dlg).toBeVisible()
  const items = dlg.locator('.rv-item')
  await expect(items).toHaveCount(1)
  await expect(items.first()).toContainText('로봇 한계 초과')
  await expect(items.first()).toContainText('오른팔')
  await expect(items.first()).toContainText('f150')
  await expect(dlg.locator('.rv-title')).toContainText('f150')
  await expect(dlg.locator('.rv-title')).toContainText('CSV 151행')
  await expect(dlg.locator('.rv-chart rect')).toHaveCount(25) // 앞뒤 12프레임
  await expect(dlg.locator('.rv-view canvas')).toHaveCount(1)

  await dlg.getByRole('button', { name: '◀ 1' }).click()
  await expect(dlg.locator('.rv-title')).toContainText('f149')
  await dlg.getByRole('button', { name: '최악 프레임' }).click()
  await expect(dlg.locator('.rv-title')).toContainText('f150')

  // 문제 있음: saved in the project (motion untouched), the item moves to its group, the same button again clears it
  await dlg.getByRole('button', { name: '문제 있음', exact: true }).click()
  await expect(dlg.locator('.rv-count')).toHaveText('미처리 0 · 문제 1 · 안무 0 / 전체 1')
  await expect(dlg.locator('.rv-group.bad')).toHaveText('문제 있음 (미해결) 1')
  await expect(items.first()).toContainText('문제 있음')
  const proj = () => page.evaluate(() => (window as any).__editor.getState().project)
  const clipId = (await proj()).sequence.tracks.find((t: any) => t.items.length).items[0].refId
  expect((await proj()).review).toMatchObject([{ clipId, from: 150, to: 150, kind: 'limit', verdict: 'bad' }])
  const { review: _r, ...rest } = await proj()
  expect(JSON.stringify({ ...rest })).toBe(JSON.stringify(JSON.parse(before))) // only the verdict was added
  await dlg.getByRole('button', { name: '문제 있음', exact: true }).click()
  await expect(dlg.locator('.rv-count')).toHaveText('미처리 1 · 문제 0 · 안무 0 / 전체 1')
  expect((await proj()).review).toBeUndefined()
  await dlg.getByRole('button', { name: '문제 있음', exact: true }).click()

  // 판정 기록 내보내기: one row per found item with the verdict
  const [dl] = await Promise.all([page.waitForEvent('download'), dlg.getByRole('button', { name: '판정 기록 내보내기' }).click()])
  // (name `flip_검수기록.csv`: headless Chromium reports a non-ASCII download name as "download", so it is not checked here)
  const rec = (await (await import('node:fs/promises')).readFile(await dl.path())).toString('utf8').replace(/^\uFEFF/, '').trim().split('\n')
  expect(rec).toHaveLength(2)
  expect(rec[1]).toContain('로봇 한계 초과,150,150,150,151')
  expect(rec[1]).toContain(',아니오,,,문제 있음,') // the wrist (±1.55 at most) never reaches its limit ±1.97; no 겹친 부위 / 깊이 for a jump
  await dlg.getByRole('button', { name: '타임라인에서 보기' }).click()
  await expect(dlg).toBeHidden()
  expect(await page.evaluate(() => (window as any).__editor.getState().frame)).toBe(150)

  // 내보내기: an open 문제 있음 shows as 검수 미해결
  await page.getByRole('button', { name: '메뉴', exact: true }).click()
  await page.getByRole('menuitem', { name: '내보내기', exact: true }).click()
  const exp = page.getByRole('dialog', { name: '내보내기' })
  await expect(exp.getByRole('list', { name: '경고' })).toContainText('검수 미해결')
  await exp.getByRole('button', { name: '닫기' }).click()

  // 안무여서 놔둠: not a problem any more, listed last as 안무로 둔 지점; the export lists its speed warning apart
  await page.getByRole('button', { name: '⚠ 검수 목록' }).click() // reopen: the verdict is kept, the 3D view comes back
  await expect(dlg.locator('.rv-view canvas')).toHaveCount(1)
  await expect(dlg.locator('.rv-count')).toHaveText('미처리 0 · 문제 1 · 안무 0 / 전체 1')
  await dlg.getByRole('button', { name: '안무여서 놔둠', exact: true }).click()
  await expect(dlg.locator('.rv-count')).toHaveText('미처리 0 · 문제 0 · 안무 1 / 전체 1')
  await expect(dlg.locator('.rv-group.ok')).toHaveText('안무로 둔 지점 1')
  await expect(items.first()).toContainText('안무여서 놔둠')
  await dlg.getByRole('button', { name: '다시 검사' }).click() // found again, still 안무
  await expect(dlg.locator('.rv-count')).toHaveText('미처리 0 · 문제 0 · 안무 1 / 전체 1')
  await page.keyboard.press('Escape')
  await expect(dlg).toBeHidden()
  expect(await dlg.locator('.rv-view canvas').count()).toBe(0) // the window's own 3D view is freed on close
  await page.getByRole('button', { name: '메뉴', exact: true }).click()
  await page.getByRole('menuitem', { name: '내보내기', exact: true }).click()
  await expect(exp.locator('.exp-ok summary')).toContainText('안무로 둔 지점')
  await expect(exp.getByText('검수 미해결')).toHaveCount(0)
  await expect(exp.locator('ul[aria-label="경고"] li', { hasText: 'jointVelocity · 150 · right_wrist_roll' })).toHaveCount(0)
  await expect(exp.locator('ul[aria-label="안무로 둔 지점"] li', { hasText: 'jointVelocity · 150 · right_wrist_roll' })).toHaveCount(1)
  await exp.getByRole('button', { name: '닫기' }).click()

  // saved: a reopened project keeps the verdict; Ctrl+Z takes it back
  const reopened = await page.evaluate(async () => {
    const { parseProject, serializeProject } = await import('/src/model/projectFile.ts')
    const s = (window as any).__editor.getState()
    return parseProject(serializeProject(s.project), s.defs).review
  })
  expect(reopened).toMatchObject([{ clipId, from: 150, to: 150, verdict: 'ok' }])
  await page.keyboard.press('Control+z')
  expect((await proj()).review).toMatchObject([{ verdict: 'bad' }])
  expect(errors).toEqual([])
})

// 자가충돌 (§14): the left forearm eases into the torso (frames 100–130), stays, eases out (160–190): one 자가충돌 item, no jump.
// The overlapping parts are painted red instead of the ghost; the chart is the depth in mm; verdicts work like the jumps'.
test('검수 목록 finds a forearm in the torso as 자가충돌', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', e => errors.push(String(e)))
  await page.addInitScript(() => { delete (window as any).showOpenFilePicker; delete (window as any).showSaveFilePicker })
  await page.goto('/')
  await expect(page.locator('#stage canvas')).toBeVisible({ timeout: 30000 })
  const k = (i: number) => (i < 100 ? 0 : i < 130 ? (i - 100) / 30 : i < 160 ? 1 : i < 190 ? (190 - i) / 30 : 0) // 0 = clear, 1 = in
  await importCsv(page, 'elbow', (n, i) => n === 'left_shoulder_roll_joint' ? 0.25 - 0.55 * k(i) : n === 'left_shoulder_yaw_joint' ? -0.8 * k(i)
    : n === 'left_elbow_joint' ? 1.57 : undefined)
  await page.getByRole('button', { name: '⚠ 검수 목록' }).click()
  const dlg = page.getByRole('dialog', { name: '검수 목록' }), items = dlg.locator('.rv-item')
  await expect(items).toHaveCount(1)
  await expect(items.first()).toContainText('자가충돌')
  await expect(items.first()).toContainText('왼아래팔×몸통 관통')
  await expect(dlg.getByRole('button', { name: /^자가충돌 1$/ })).toBeVisible() // its filter
  await expect(dlg.locator('.rv-legend')).toContainText('빨강 = 겹친 부위')
  await expect(dlg.locator('.rv-legend')).not.toContainText('주황 = 직전')
  await expect(dlg.getByRole('button', { name: '겹쳐 보기' })).toBeDisabled()
  await expect(dlg.locator('.rv-chart-head')).toContainText('관통 깊이(mm)')
  await dlg.getByRole('button', { name: '문제 있음', exact: true }).click()
  expect((await page.evaluate(() => (window as any).__editor.getState().project.review))).toMatchObject([{ kind: 'collision', verdict: 'bad' }])
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: '메뉴', exact: true }).click()
  await page.getByRole('menuitem', { name: '내보내기', exact: true }).click()
  const exp = page.getByRole('dialog', { name: '내보내기' })
  await expect(exp.getByRole('list', { name: '경고' })).toContainText('검수 미해결') // still overlapping: open
  await exp.getByRole('button', { name: '닫기' }).click()
  expect(errors).toEqual([])
})

// 발 미끄러짐 (§16): the robot glides 10 cm/s from frame 150 with both feet down: one 경고 per foot, the foot painted red, the chart in
// cm/s; a verdict is kept per family (발 미끄러짐).
test('검수 목록 finds feet gliding over the floor as 발 미끄러짐', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', e => errors.push(String(e)))
  await page.addInitScript(() => { delete (window as any).showOpenFilePicker; delete (window as any).showSaveFilePicker })
  await page.goto('/')
  await expect(page.locator('#stage canvas')).toBeVisible({ timeout: 30000 })
  await importCsv(page, 'glide', () => undefined, i => (i < 150 ? 0 : (i - 150) * 0.1 / 60))
  await page.getByRole('button', { name: '⚠ 검수 목록' }).click()
  const dlg = page.getByRole('dialog', { name: '검수 목록' }), items = dlg.locator('.rv-item')
  await expect(dlg.getByRole('button', { name: /^발 미끄러짐 2$/ })).toBeVisible()
  await dlg.getByRole('button', { name: /^발 미끄러짐 2$/ }).click()
  await expect(items).toHaveCount(2)
  await expect(items.first()).toContainText('미끄러짐 · 체중')
  await expect(items.first().locator('.rv-lv')).toHaveText('경고')
  await expect(items.first()).toContainText('f150~f298')
  await expect(dlg.locator('.rv-legend')).toContainText('빨강 = 미끄러지는 발')
  await expect(dlg.locator('.rv-chart-head')).toContainText('cm/s')
  await dlg.getByRole('button', { name: '문제 있음', exact: true }).click()
  expect(await page.evaluate(() => (window as any).__editor.getState().project.review)).toMatchObject([{ kind: 'footSlip', verdict: 'bad' }])
  expect(errors).toEqual([])
})

// 무대 이탈 (§18): the robot walks out to x = 3.5 m (stage 10 × 6 m: the 객석 edge at x = 3). Listed with how far; the guide suggests
// the 배치 change (nothing moved: set by hand) and no verdict is taken.
test('검수 목록 finds a piece past the stage edge as 무대 이탈 and suggests the 배치 change', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', e => errors.push(String(e)))
  await page.addInitScript(() => { delete (window as any).showOpenFilePicker; delete (window as any).showSaveFilePicker })
  await page.goto('/')
  await expect(page.locator('#stage canvas')).toBeVisible({ timeout: 30000 })
  await importCsv(page, 'walkout', () => undefined, i => 3.5 * i / 299)
  const place = () => page.evaluate(() => JSON.stringify((window as any).__editor.getState().project.actors.map((a: any) => a.placement)))
  const before = await place()
  await page.getByRole('button', { name: '⚠ 검수 목록' }).click()
  const dlg = page.getByRole('dialog', { name: '검수 목록' }), items = dlg.locator('.rv-item')
  await dlg.getByRole('button', { name: /^무대 이탈 1$/ }).click()
  await expect(items).toHaveCount(1)
  await expect(items.first()).toContainText('객석 쪽 경계를')
  const guide = dlg.getByLabel('배치 추천')
  await expect(guide).toContainText('옮기면 이 조각은 무대 안')
  await expect(guide).toContainText('인스펙터 배치')
  await expect(dlg.locator('.rv-chart-head')).toContainText('경계를 넘은 거리(cm')
  await expect(dlg.getByRole('button', { name: '문제 있음', exact: true })).toBeDisabled()
  await expect(dlg.getByRole('button', { name: '안무여서 놔둠', exact: true })).toBeDisabled()
  expect(await place()).toBe(before) // nothing moved
  expect(errors).toEqual([])
})

// 추천대로 고치기 (§17): knees bent, glides 10 cm/s with its feet down from frame 170, then rises off the floor at 200. The guide offers the fix;
// applying it puts the leg change in the piece's 수정 층 (the clip untouched), the check finds no 발 미끄러짐 any more, Ctrl+Z brings it back.
test('검수 목록 fixes a foot slide as recommended (추천대로 고치기)', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', e => errors.push(String(e)))
  await page.addInitScript(() => { delete (window as any).showOpenFilePicker; delete (window as any).showSaveFilePicker })
  await page.goto('/')
  await expect(page.locator('#stage canvas')).toBeVisible({ timeout: 30000 })
  const sm = (u: number) => (u <= 0 ? 0 : u >= 1 ? 1 : u * u * (3 - 2 * u))
  const bent: Record<string, number> = { hip_pitch: -0.3, knee: 0.6, ankle_pitch: -0.3 } // knees bent: room to reach back
  await importCsv(page, 'glidelift', n => bent[n.replace(/^(left|right)_|_joint$/g, '')], i => Math.max(0, Math.min(i, 200) - 170) * 0.1 / 60, i => 0.74 + 0.08 * sm((i - 200) / 12))
  const clip = () => page.evaluate(() => { const p = (window as any).__editor.getState().project; return JSON.stringify(p.clips) })
  const before = await clip()
  await page.getByRole('button', { name: '⚠ 검수 목록' }).click()
  const dlg = page.getByRole('dialog', { name: '검수 목록' }), items = dlg.locator('.rv-item')
  await dlg.getByRole('button', { name: /^발 미끄러짐 2$/ }).click()
  await items.first().click()
  const guide = dlg.getByLabel('개선 가이드')
  await expect(guide).toContainText('발을 떼는')
  await expect(guide).toContainText('고친 모습(초록)')
  await expect(dlg.locator('.rv-inset')).toBeVisible()
  await guide.getByRole('button', { name: '추천대로 고치기' }).click()
  await expect(dlg.locator('.rv-msg')).toContainText('미끄러짐을 고쳤습니다')
  await expect(dlg.getByRole('button', { name: /^발 미끄러짐 1$/ })).toBeVisible() // the other foot is left
  expect(await clip()).toBe(before) // the clip itself untouched: the change is in the piece's 수정 층
  expect(await page.evaluate(() => Object.keys((window as any).__editor.getState().project.sequence.tracks.find((t: any) => t.items.length).items[0].offset ?? {}).length)).toBe(6)
  await page.keyboard.press('Escape')
  await page.keyboard.press('Control+z')
  expect(await page.evaluate(() => (window as any).__editor.getState().project.sequence.tracks.find((t: any) => t.items.length).items[0].offset)).toBeUndefined()
  await page.getByRole('button', { name: '⚠ 검수 목록' }).click()
  await expect(dlg.getByRole('button', { name: /^발 미끄러짐 2$/ })).toBeVisible()
  expect(errors).toEqual([])
})
