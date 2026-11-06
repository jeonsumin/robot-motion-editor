import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { importSynthetic } from './synth'
import { unzip } from './unzip'

// RL 학습용 내보내기 (RL팀, 수정변동사항.md §10): a separate option, the usual export unchanged. Original coordinates (무대 배치 left out),
// no 기본자세, an edits.json beside each CSV (1-based inclusive rows, header excluded, + the CSV's name and SHA-256).
test('RL 학습용: 클립 편집 RL 학습용 저장 = CSV + edits.json; 내보내기 창 option = the piece without 기본자세 + its edits.json', async ({ page }) => {
  await page.addInitScript(() => { delete (window as any).showOpenFilePicker; delete (window as any).showSaveFilePicker; delete (window as any).showDirectoryPicker })
  await page.goto('/')
  await expect(page.locator('#stage canvas')).toBeVisible({ timeout: 30000 })
  await importSynthetic(page, 'rl')
  const ids = await page.evaluate(() => { const s = (window as any).__editor.getState(), t = s.project.sequence.tracks.find((t: any) => t.items.length)
    s.setPlacement(t.actorId, { x: 4, y: 2 }); return { actor: t.actorId as string, clip: t.items[0].refId as string } })

  // 클립 편집: edit the knee around frame 100, then RL 학습용 저장 → two downloads
  await page.evaluate(({ clip }) => { const s = (window as any).__editor.getState(); s.openClipEdit(clip); s.setFrame(100); s.setValue('__clip_actor__', 'left_knee_joint', 1.2) }, ids)
  const bar = page.getByRole('group', { name: '클립 편집' })
  await expect(bar).toContainText('수정 키')
  const dl: { name: string; text: string }[] = []
  page.on('download', async d => dl.push({ name: d.suggestedFilename(), text: readFileSync((await d.path())!, 'utf8') }))
  await bar.getByRole('button', { name: 'RL 학습용 저장' }).click()
  await expect.poll(() => dl.length).toBe(2)
  const csv = dl.find(f => f.name.endsWith('.csv'))!, json = JSON.parse(dl.find(f => f.name.endsWith('.edits.json'))!.text)
  expect(json).toMatchObject({ source_csv: csv.name, fps: 60, frame_index: '1-based, inclusive, header 제외' })
  expect(json.sha256).toMatch(/^[0-9a-f]{64}$/)
  expect(json.ranges.some(([a, b]: number[]) => a <= 101 && 101 <= b)).toBe(true) // frame 100 = row 101
  const row = (n: number) => csv.text.split('\n')[n].split(',')
  expect(Number(row(150)[4])).toBeCloseTo(0.01 * 149, 5) // root x as imported: no move to the origin, no 무대 배치 (+4 m)
  await expect(bar).toContainText('edits.json을 내려받았습니다')

  // 내보내기 창: the usual export (with 기본자세 lead-in) vs RL 학습용 (the piece's own rows only)
  await bar.getByRole('button', { name: '시퀀스로' }).click()
  await page.evaluate(() => { const s = (window as any).__editor.getState(), t = s.project.sequence.tracks.find((t: any) => t.items.length); s.splitItem(t.items[0].id, 150) })
  await page.getByRole('button', { name: '메뉴', exact: true }).click()
  await page.getByRole('menuitem', { name: '내보내기', exact: true }).click()
  const dlg = page.getByRole('dialog', { name: '내보내기' })
  await dlg.getByRole('checkbox', { name: '물리 검증 건너뛰기' }).check()
  await dlg.getByRole('checkbox', { name: /RL 학습용/ }).check()
  dl.length = 0
  const [z] = await Promise.all([page.waitForEvent('download'), dlg.getByRole('button', { name: 'G1 내보내기' }).click()])
  const files = unzip(new Uint8Array(readFileSync((await z.path())!)))
  expect(files.map(f => f.name).sort()).toEqual(['Untitled-G1-1.csv', 'Untitled-G1-1.edits.json', 'Untitled-G1-2.csv', 'Untitled-G1-2.edits.json'])
  const rows = (n: string) => files.find(f => f.name === n)!.text.split('\n').length - 1
  expect([rows('Untitled-G1-1.csv'), rows('Untitled-G1-2.csv')]).toEqual([150, 150]) // own frames only: no 기본자세 rows
  const j2 = JSON.parse(files.find(f => f.name === 'Untitled-G1-1.edits.json')!.text)
  expect(j2.source_csv).toBe('Untitled-G1-1.csv')
  expect(j2.ranges.some(([a, b]: number[]) => a <= 101 && 101 <= b)).toBe(true)
  await expect(dlg.getByRole('status')).toContainText('CSV 2개와 edits.json 2개')
})
