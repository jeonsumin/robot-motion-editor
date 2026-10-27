import { test, expect, type Page } from '@playwright/test'

const tracks = (page: Page) => page.evaluate(() =>
  (window as any).__editor.getState().project.sequence.tracks.filter((t: any) => t.kind === 'motion')
    .map((t: any) => t.items.map((i: any) => [i.start, i.trimOut - i.trimIn]))) as Promise<number[][][]>

test('drop: card onto a piece inserts at its nearer edge (front half: before it, pushing it back; back half: after it); empty area makes a new actor', async ({ page }) => {
  await page.addInitScript(() => { delete (window as any).showOpenFilePicker; delete (window as any).showDirectoryPicker })
  const errors: string[] = []
  page.on('pageerror', e => errors.push(String(e)))
  await page.goto('/')
  await expect(page.locator('#stage canvas')).toBeVisible({ timeout: 30000 })
  const joints = await page.evaluate(() => (window as any).__editor.getState().defs.g1.joints.map((j: { name: string }) => j.name) as string[])
  const head = ['frequency(fps)', 'RobotType', 'DOF Number', 'time(ms)', 'position X(m)', 'position Y(m)', 'position Z(m)',
    'quaternion X', 'quaternion Y', 'quaternion Z', 'quaternion W', ...joints].join(',') + ','
  const csv = (n: number) => Buffer.from([head, ...Array.from({ length: n }, (_, i) =>
    [60, 0, 29, Math.round(i * 1000 / 60), (0.01 * i).toFixed(6), '0.000000', '0.790000', '0', '0', '0', '1',
      ...joints.map((_, j) => (0.02 * Math.sin(i / 9 + j)).toFixed(6))].join(',') + ',')].join('\n') + '\n')
  for (const [name, n] of [['a', 120], ['b', 60]] as const) {
    await page.getByRole('button', { name: '메뉴', exact: true }).click()
    const [fc] = await Promise.all([page.waitForEvent('filechooser'), page.getByRole('menuitem', { name: 'CSV 가져오기', exact: true }).click()])
    await fc.setFiles([{ name: `${name}.csv`, mimeType: 'text/csv', buffer: csv(n) }])
    await expect(page.getByText('클립 1개를 가져왔습니다')).toBeVisible()
  }
  expect(await tracks(page)).toEqual([[[0, 120]]]) // second CSV went to the assets only

  const seq = page.locator('.seq-canvas')
  const card = page.locator('.pp-row[data-kind=clip]', { hasText: 'b' }).first()
  const box = (await seq.boundingBox())!
  const xAt = (f: number) => page.evaluate(f => { const tv = (window as any).__tv; return 160 + (f - tv.scrollF) * tv.ppf }, f)
  await card.dragTo(seq, { targetPosition: { x: await xAt(20), y: 24 + 14 } }) // front half of a (0..120): b goes first, a moves back
  expect(await tracks(page)).toEqual([[[60, 120], [0, 60]]])
  await card.dragTo(seq, { targetPosition: { x: await xAt(160), y: 24 + 14 } }) // back half of a (60..180): b after it
  expect(await tracks(page)).toEqual([[[60, 120], [0, 60], [180, 60]]])

  // the track opened its piece lanes (one per piece, by start: 0..60, 60..180, 180..240): a lane drop goes by its piece, not the frame
  const lane = (k: number) => 24 + 28 * (k + 1) + 14 // ruler, track row, then lane k (row 28 px)
  await card.dragTo(seq, { targetPosition: { x: await xAt(220), y: lane(0) } }) // empty part of lane 1, under the third piece: right after the first
  expect(await tracks(page)).toEqual([[[120, 120], [0, 60], [240, 60], [60, 60]]])
  await card.dragTo(seq, { targetPosition: { x: await xAt(20), y: lane(3) } }) // left of the last piece (240..300) in its lane: before it
  expect(await tracks(page)).toEqual([[[120, 120], [0, 60], [300, 60], [60, 60], [240, 60]]])

  await card.dragTo(seq, { targetPosition: { x: 500, y: box.height - 20 } }) // empty area below the tracks
  expect(await tracks(page)).toEqual([[[120, 120], [0, 60], [300, 60], [60, 60], [240, 60]], [[expect.any(Number), 60]]])
  expect(errors).toEqual([])
})
