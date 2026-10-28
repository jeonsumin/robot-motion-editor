import { test, expect, type Page } from '@playwright/test'

// GO2 blocks live in the 목록 panel's 라이브러리 tab (spec 2026-10-16-project-panel-design.md §5).
const boot = async (page: Page) => {
  await page.goto('/')
  await expect(page.locator('#stage canvas')).toBeVisible({ timeout: 30000 })
}
const addGo2 = (page: Page) => page.evaluate(() => {
  const ed = (window as any).__editor
  ed.getState().addActor('go2') // the app starts empty
  const a = ed.getState().project.actors.at(-1)
  ed.getState().select(a.id)
  return a.id as string
})
const trackItems = (page: Page, actorId: string) => page.evaluate(id => {
  const p = (window as any).__editor.getState().project
  return p.sequence.tracks.find((t: any) => t.actorId === id).items
    .map((i: any) => ({ start: i.start, len: i.trimOut - i.trimIn, name: p.clips[i.refId].name }))
    .sort((a: any, b: any) => a.start - b.start)
}, actorId)
const clipCount = (page: Page) => page.evaluate(() => Object.keys((window as any).__editor.getState().project.clips).length)
const actors = (page: Page) => page.evaluate(() => (window as any).__editor.getState().project.actors.map((a: any) => ({ id: a.id, robot: a.robot })))
const library = async (page: Page) => { // the tab, with the real-log folder (the original blocks) opened
  await page.getByRole('tab', { name: '라이브러리' }).click()
  const tree = page.getByRole('tree', { name: '라이브러리' }), real = tree.locator('[data-id="dir:리얼데이터"]')
  if (await real.getAttribute('aria-expanded') !== 'true') await real.click()
  return tree
}
const row = (page: Page, label: string) => page.locator('.pp-row[data-kind=block]').filter({ has: page.locator('.pp-name', { hasText: new RegExp(`^${label}$`) }) })
const add = (page: Page) => page.getByRole('button', { name: '추가', exact: true })

test('GO2 selected → 라이브러리 adds Move then Stretch at the track end', async ({ page }) => {
  await boot(page)
  const id = await addGo2(page)
  const before = await trackItems(page, id), end0 = Math.max(0, ...before.map(i => i.start + i.len))
  const tree = await library(page)
  await expect(tree.locator('.pp-row[data-kind=block]')).toHaveCount(16) // Empty + the 15 real-log blocks; the other folders stay folded
  await expect(row(page, 'Move forward').locator('.pp-col-kind')).toHaveText('거리')
  await expect(row(page, 'Rotate').locator('.pp-col-kind')).toHaveText('각도')
  await expect(row(page, 'Stretch').locator('.pp-col-kind')).toHaveText('고정')

  await expect(row(page, 'Empty').locator('.pp-col-kind')).toHaveText('길이')
  await row(page, 'Move forward').click()
  await expect(page.getByLabel('붙일 로봇')).toHaveValue(id) // the selected GO2
  await page.getByRole('button', { name: '값' }).click() // only reachable distances are listed
  await page.getByRole('option', { name: '2.39 m (2걸음)' }).click()
  await expect(page.getByText(/실제 .*m \(\d+회\)/)).toBeVisible()
  await add(page).click()
  await expect.poll(async () => (await trackItems(page, id)).length).toBe(before.length + 1)
  const move = (await trackItems(page, id)).at(-1)!
  expect(move.start).toBe(end0)
  expect(move.name).toMatch(/^Move_/)

  await row(page, 'Stretch').click()
  await expect(page.getByLabel('값')).toHaveCount(0)
  await add(page).click()
  await expect.poll(async () => (await trackItems(page, id)).length).toBe(before.length + 2)
  expect((await trackItems(page, id)).at(-1)).toMatchObject({ start: move.start + move.len, name: 'Stretch' })

  // the made clips are in the 모션 tab
  await page.getByRole('tab', { name: '모션(CSV)' }).click()
  await expect(page.locator('.pp-row[data-kind=clip] .pp-name', { hasText: 'Stretch' })).toBeVisible()
  await expect(page.locator('.pp-row[data-kind=clip] .pp-name', { hasText: /^Move_/ })).toBeVisible()
})

test('no GO2: 추가 makes one at 0 s, the next appends to it', async ({ page }) => {
  await boot(page)
  await library(page)
  await row(page, 'Stretch').click()
  await expect(page.getByLabel('붙일 로봇')).toHaveValue('new')
  await add(page).click()
  await expect(page.locator('.pp-blk')).toContainText('추가했습니다: Stretch')
  await expect.poll(async () => (await actors(page)).map(a => a.robot)).toEqual(['go2'])
  const id = (await actors(page))[0].id
  await row(page, 'Sit').click()
  await expect(add(page)).toBeEnabled()
  await add(page).click()
  await expect.poll(async () => (await trackItems(page, id)).map(i => i.name)).toEqual(['Stretch', 'Sit'])
  const [a, b] = await trackItems(page, id)
  expect(a.start).toBe(0)
  expect(b.start).toBe(a.len)
  expect((await actors(page)).length).toBe(1)
  await expect(page.getByLabel('붙일 로봇')).toHaveValue(id) // now appends to the new GO2

  // 목록에만 추가: the clip goes to the asset list only, the sequence stays as it was; the same block is never made twice
  const clipNames = () => page.evaluate(() => Object.values((window as any).__editor.getState().project.clips).map((c: any) => c.name).sort())
  await page.getByLabel('붙일 로봇').selectOption('asset')
  await row(page, 'Stretch').click()
  await add(page).click()
  await expect(page.locator('.pp-blk')).toContainText('이미 목록에 있습니다: Stretch')
  expect(await clipNames()).toEqual(['Sit', 'Stretch'])
  await row(page, 'Rotate').click()
  await page.getByRole('button', { name: '값' }).click()
  await page.getByRole('option', { name: '좌 168° (1걸음)' }).click()
  await expect(page.locator('.pp-why')).toContainText('가장 작은 값은 168°') // why the list starts at 168°
  await add(page).click()
  await expect(page.locator('.pp-blk')).toContainText('목록에 추가했습니다: Rotate_168deg')
  await add(page).click()
  await expect(page.locator('.pp-blk')).toContainText('이미 목록에 있습니다: Rotate_168deg')
  expect(await clipNames()).toEqual(['Rotate_168deg', 'Sit', 'Stretch'])
  expect((await trackItems(page, id)).map(i => i.name)).toEqual(['Stretch', 'Sit'])
  await page.getByLabel('붙일 로봇').selectOption(id) // onto the robot: the 목록 clip is appended, no copy
  await add(page).click()
  await expect(page.locator('.pp-blk')).toContainText('목록에 있는 Rotate_168deg을(를) 붙였습니다')
  await expect.poll(async () => (await trackItems(page, id)).map(i => i.name)).toEqual(['Stretch', 'Sit', 'Rotate_168deg'])
  expect(await clipNames()).toEqual(['Rotate_168deg', 'Sit', 'Stretch'])
})

test('loop blocks list only the values the log can make (whole steps), smallest first; the filter narrows the list', async ({ page }) => {
  await boot(page)
  await addGo2(page)
  await library(page)
  await row(page, 'Rotate').click()
  const pick = page.getByRole('button', { name: '값' }), list = page.getByRole('listbox', { name: '값 목록' }), opts = list.getByRole('option')
  await expect(pick).toHaveText(/좌 168° \(1걸음\)/) // the smallest by default
  await pick.click()
  await expect(opts.first()).toHaveText('좌 168° (1걸음)')
  expect(await opts.allTextContents()).toContain('우 146° (1걸음)')
  expect(await list.evaluate(el => el.clientHeight)).toBeLessThanOrEqual(220) // a short scrolling list, not a tall native popup
  await page.keyboard.press('Escape')
  await expect(list).toHaveCount(0)
  await row(page, 'Move forward').click()
  await expect(page.getByRole('button', { name: '값' })).toHaveText(/1\.77 m \(1걸음\)/)
  await expect(add(page)).toBeEnabled()
  await row(page, 'Empty').click() // no log, no length field, no 붙일 로봇: always 30 frames into 목록
  await expect(page.locator('.pp-blk').getByLabel('붙일 로봇')).toHaveCount(0)
  await expect(page.locator('.pp-blk input')).toHaveCount(0)
  await expect(add(page)).toBeEnabled()
  await page.getByLabel('필터').fill('flip')
  await expect(page.locator('.pp-row[data-kind=block]')).toHaveCount(4)
  await expect(page.getByText('4 항목', { exact: true })).toBeVisible() // the panel's count (folder rows show their own)
})

test('template 404 shows error, project unchanged', async ({ page }) => {
  await page.route('**/go2-blocks/*/stretch.csv', r => r.fulfill({ status: 404, body: '' }))
  await boot(page)
  await addGo2(page)
  const n = await clipCount(page)
  await library(page)
  await row(page, 'Stretch').click()
  await expect(page.getByRole('alert')).toContainText('템플릿을 불러오지 못했습니다')
  await expect(add(page)).toBeDisabled()
  expect(await clipCount(page)).toBe(n)
})

test('a fixed block dragged to empty timeline space makes a GO2 actor and clip', async ({ page }) => {
  await boot(page)
  await library(page)
  await row(page, 'Stretch').click() // loads the template
  await expect(add(page)).toBeEnabled()
  const seq = page.locator('.seq-canvas'), box = (await seq.boundingBox())!
  await row(page, 'Stretch').dragTo(seq, { targetPosition: { x: 300, y: box.height - 20 } })
  await expect.poll(async () => (await actors(page)).map(a => a.robot)).toEqual(['go2'])
  const items = await trackItems(page, (await actors(page))[0].id)
  expect(items.map(i => i.name)).toEqual(['Stretch'])
  expect(await clipCount(page)).toBe(1)
  await expect(row(page, 'Move forward')).not.toHaveAttribute('draggable', 'true')
})

test('a fixed block drags to the timeline without picking its row first', async ({ page }) => {
  await boot(page)
  await library(page)
  const seq = page.locator('.seq-canvas'), box = (await seq.boundingBox())!
  // the template preloads in the background: retry the drag until it takes
  await expect(async () => {
    await row(page, 'Stretch').dragTo(seq, { targetPosition: { x: 300, y: box.height - 20 } })
    expect((await actors(page)).map(a => a.robot)).toEqual(['go2'])
  }).toPass()
  expect(await clipCount(page)).toBe(1)
})

test('Empty: 추가 puts one 30-frame clip in 목록; dragged twice, both pieces share it; a piece end drags it longer', async ({ page }) => {
  await boot(page)
  await library(page)
  await row(page, 'Empty').click()
  await add(page).click()
  await expect(page.locator('.pp-msg')).toHaveText('목록에 추가했습니다: Empty_30f')
  await add(page).click()
  await expect(page.locator('.pp-msg')).toContainText('이미 목록에 있습니다')
  expect(await clipCount(page)).toBe(1)
  expect(await actors(page)).toEqual([]) // nothing on the sequence
  const seq = page.locator('.seq-canvas'), box = (await seq.boundingBox())!
  await row(page, 'Empty').dragTo(seq, { targetPosition: { x: 300, y: box.height - 20 } })
  await expect.poll(async () => (await actors(page)).length).toBe(1)
  await row(page, 'Empty').dragTo(seq, { targetPosition: { x: 300, y: box.height - 20 } }) // empty space again: a second GO2
  await expect.poll(async () => (await actors(page)).length).toBe(2)
  expect(await clipCount(page)).toBe(1) // both pieces use the one Empty clip
  const [g1, g2] = (await actors(page)).map(a => a.id)
  expect([...await trackItems(page, g1), ...await trackItems(page, g2)].map(i => [i.name, i.len])).toEqual([['Empty_30f', 30], ['Empty_30f', 30]])
  const ok = await page.evaluate(id => { const s = (window as any).__editor.getState(); return s.trimItem(s.project.sequence.tracks.find((t: any) => t.actorId === id).items[0].id, 'out', 45) }, g1)
  expect(ok).toBe(true)
  expect([(await trackItems(page, g1))[0].len, (await trackItems(page, g2))[0].len]).toEqual([75, 30])
})

test('라이브러리 folders: folded by default, open on click, a name filter opens the folders it hits; a folder block adds like a fixed one', async ({ page }) => {
  await boot(page)
  await page.getByRole('tab', { name: '라이브러리' }).click()
  const tree = page.getByRole('tree', { name: '라이브러리' }), dir = (n: string) => tree.locator(`[data-id="dir:${n}"]`)
  await expect(tree.locator('[data-kind=blockdir] .pp-name')).toHaveText(['기본 자세', '리얼데이터', '앉기_엎드리기', '일어서기_제스처'])
  await expect(tree.locator('.pp-row[data-kind=block]')).toHaveCount(1) // Empty only
  await dir('앉기_엎드리기').click()
  await expect(dir('앉기_엎드리기')).toHaveAttribute('aria-expanded', 'true')
  await expect(row(page, '앉기')).toBeVisible()
  await dir('앉기_엎드리기').press('ArrowLeft')
  await expect(dir('앉기_엎드리기')).toHaveAttribute('aria-expanded', 'false')

  await page.getByLabel('필터').fill('스핑크스')
  await expect(tree.locator('[data-kind=blockdir]')).toHaveCount(1)
  await expect(row(page, '스핑크스')).toBeVisible()
  await row(page, '스핑크스').click()
  await page.getByLabel('붙일 로봇').selectOption('asset')
  await add(page).click()
  await expect.poll(() => page.evaluate(() => Object.values((window as any).__editor.getState().project.clips).some((c: any) => c.name === '스핑크스' && c.robot === 'go2'))).toBe(true)
})

test('우클릭 메뉴: 위치만 고름 — 로봇 ▸ 맨 앞 / 맨 뒤, 목록에만; 값은 설정 칸 값(처음엔 가장 작은 값)', async ({ page }) => {
  await boot(page)
  const id = await addGo2(page)
  const n0 = (await trackItems(page, id)).length // a new actor comes with its starter piece
  await library(page)
  const menu = page.getByRole('menu', { name: '라이브러리' })
  // Stretch at the track end, twice (two pieces 0..L, L..2L)
  for (const _ of [0, 1]) {
    await row(page, 'Stretch').click({ button: 'right' })
    await expect(menu.locator('.tl-menu-head')).toHaveText('Stretch')
    await menu.getByRole('menuitem', { name: 'GO2 #1' }).click()
    await page.getByRole('menuitem', { name: '맨 뒤에 추가' }).click()
  }
  await expect.poll(async () => (await trackItems(page, id)).length).toBe(n0 + 2)
  const [a, b] = (await trackItems(page, id)).slice(n0)
  expect([a.name, b.name, b.start]).toEqual(['Stretch', 'Stretch', a.start + a.len])

  // Rotate: the head shows the value it adds — the smallest at first, then the one picked in the 설정 칸
  await row(page, 'Rotate').click({ button: 'right' })
  await expect(menu.locator('.tl-menu-head')).toContainText(/Rotate · 좌 \d+° \(1걸음\)/)
  await expect(menu.locator('.tl-menu-head')).toContainText('최저 값으로 우선 설정')
  await page.keyboard.press('Escape')
  await expect(menu).toHaveCount(0)
  await page.getByRole('button', { name: '값' }).click()
  await page.getByRole('option', { name: /\(2걸음\)/ }).first().click()
  await row(page, 'Rotate').click({ button: 'right' })
  await expect(menu.locator('.tl-menu-head')).toContainText('(2걸음)')
  await expect(menu.locator('.tl-menu-head')).not.toContainText('최저 값')

  // 맨 앞에 추가: before the first piece, every piece pushed back by the clip length
  const all0 = await trackItems(page, id)
  await menu.getByRole('menuitem', { name: 'GO2 #1' }).click()
  await page.getByRole('menuitem', { name: '맨 앞에 추가' }).click()
  await expect.poll(async () => (await trackItems(page, id)).length).toBe(n0 + 3)
  const all = await trackItems(page, id), rot = all[0]
  expect(rot).toMatchObject({ start: all0[0].start, name: expect.stringMatching(/^Rotate_/) })
  expect(all.slice(1).map(i => i.start)).toEqual(all0.map(i => i.start + rot.len))
  await expect(page.getByText(/맨 앞에 추가했습니다: Rotate_/)).toBeVisible()

  // 목록에만 추가: the same block is not made twice
  await row(page, 'Hello').click({ button: 'right' })
  await menu.getByRole('menuitem', { name: '목록에만 추가' }).click()
  await expect(page.getByText(/목록에 추가했습니다: Hello/)).toBeVisible()
  expect((await trackItems(page, id)).length).toBe(n0 + 3)
})

test('라이브러리 미리보기: 우클릭 ▸ 미리보기 → own looping pane; nothing enters the project; follows the 설정 칸 value; ✕ closes', async ({ page }) => {
  await boot(page)
  await addGo2(page)
  await library(page)
  const p0 = await page.evaluate(() => { const w = window as any; w.__p0 = w.__editor.getState().project; return w.__editor.getState().dirty })
  const menu = page.getByRole('menu', { name: '라이브러리' }), pane = page.getByRole('region', { name: '라이브러리 미리보기' })

  await row(page, 'Stretch').click({ button: 'right' })
  await expect(menu.getByRole('menuitem').first()).toHaveText('미리보기')
  await menu.getByRole('menuitem', { name: '미리보기' }).click()
  await expect(pane).toContainText('라이브러리 미리보기 · Stretch')
  const pose = () => page.evaluate(() => { const h = (window as any).__stages?.['library-preview']
    return h ? Object.values(([...h.entries().values()][0] as any).rig.jointPivots).map((p: any) => p.quaternion.toArray().join()).join('|') : '' })
  await expect.poll(pose).not.toBe('')
  const a = await pose()
  await expect.poll(pose).not.toBe(a) // it plays on its own loop (the sequence is stopped)
  expect(await page.evaluate(() => (window as any).__editor.getState().playing)).toBe(false)

  // a loop block: the value the 설정 칸 holds, and the pane follows a new value
  await row(page, 'Rotate').click({ button: 'right' })
  await menu.getByRole('menuitem', { name: '미리보기' }).click()
  await expect(pane).toContainText(/라이브러리 미리보기 · Rotate_\d+deg/)
  const n1 = await pane.locator('.pane-title span').textContent()
  await page.getByRole('button', { name: '값' }).click()
  await page.getByRole('option', { name: /\(2걸음\)/ }).first().click()
  await expect.poll(() => pane.locator('.pane-title span').textContent()).not.toBe(n1)

  // nothing went into the project
  expect(await page.evaluate(([d0]) => { const s = (window as any).__editor.getState(); return s.project === (window as any).__p0 && s.dirty === d0 }, [p0])).toBe(true)
  await pane.getByRole('button', { name: '라이브러리 미리보기 닫기' }).click()
  await expect(pane).toHaveCount(0)
  expect(await page.evaluate(() => (window as any).__editor.getState().blockPreview)).toBeNull()
})

test('고쳐서 추가: the previewed block goes into 목록 as <name>_수정 and opens in 클립 편집; 추가 취소 takes it out again', async ({ page }) => {
  await boot(page)
  await addGo2(page)
  await library(page)
  const pane = page.getByRole('region', { name: '라이브러리 미리보기' })
  await row(page, 'Hello').click({ button: 'right' })
  await page.getByRole('menu', { name: '라이브러리' }).getByRole('menuitem', { name: '미리보기' }).click()
  await expect(pane).toContainText('라이브러리 미리보기 · Hello')
  const n0 = await clipCount(page)

  await pane.getByRole('button', { name: '고쳐서 추가' }).click()
  await expect(pane).toHaveCount(0) // the preview closes: editing moves to the main view
  const edit = page.getByRole('group', { name: '클립 편집' })
  await expect(edit).toContainText('Hello_수정')
  const s1 = await page.evaluate(() => { const s = (window as any).__editor.getState(), c = s.project.clips[s.clipEdit]; return { name: c?.name, robot: c?.robot, draft: s.clipEditDraft === s.clipEdit, tracks: s.project.sequence.tracks.map((t: any) => t.items.length) } })
  expect(s1).toMatchObject({ name: 'Hello_수정', robot: 'go2', draft: true })
  expect(await clipCount(page)).toBe(n0 + 1)

  // a second one takes the next free name
  await edit.getByRole('button', { name: '시퀀스로' }).click()
  await row(page, 'Hello').click({ button: 'right' })
  await page.getByRole('menu', { name: '라이브러리' }).getByRole('menuitem', { name: '미리보기' }).click()
  await pane.getByRole('button', { name: '고쳐서 추가' }).click()
  await expect(edit).toContainText('Hello_수정_2')
  expect(await clipCount(page)).toBe(n0 + 2)

  // 추가 취소: out of 목록 and out of 클립 편집; the first one (left with 시퀀스로) stays
  await edit.getByRole('button', { name: '추가 취소' }).click()
  await expect(edit).toHaveCount(0)
  expect(await clipCount(page)).toBe(n0 + 1)
  const names = await page.evaluate(() => Object.values((window as any).__editor.getState().project.clips).map((c: any) => c.name))
  expect(names).toContain('Hello_수정')
  expect(names).not.toContain('Hello_수정_2')
  // a clip opened the usual way (목록 double-click) has no 추가 취소
  await page.getByRole('tab', { name: '모션(CSV)' }).click()
  await page.locator('.pp-row[data-kind=clip]', { hasText: 'Hello_수정' }).first().dblclick()
  await expect(edit).toBeVisible()
  await expect(edit.getByRole('button', { name: '추가 취소' })).toHaveCount(0)
})
