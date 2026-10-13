/**
 * P20 in a real browser: the 背景 lane of the timeline. Add a background switch (double-click the lane, pick a picture), see the picture change
 * while the people stay where they are, drag the key, change its transition (crossfade shows two layers), delete it, undo.
 */
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { beatStart, center, dragBy, openDemoEditor, playing, seekTo, stateOf } from './helpers/editor';

test.describe.configure({ mode: 'serial' });
test.setTimeout(300_000);

let page: Page;
let projectId = '';
const errors: string[] = [];
const PPS = 60;

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(e.message));
  projectId = await openDemoEditor(page, 'P20 背景轨道');
});
test.afterAll(async ({ request }: { request: APIRequestContext }) => {
  await page.close();
  await request.delete(`/api/projects/${projectId}`);
});

type K = { id: string; at: { beatId: string; offset: number }; value: { assetId: string; transition: string; purpose: string; transitionSeconds: number }; meta: { source: string } };
const bgKeys = async () => ((await playing(page)).scenes[0]!.tracks.find((t) => t.channel === 'background')?.keys ?? []) as unknown as K[];
const startBg = async () => (await playing(page)).scenes[0]!.background.assetId;
const px = () => page.evaluate(() => window.__studio.snapshotPixels(0, 0, 320, 120));
const heads = async () => (await page.evaluate(() => window.__studio.getActorScreenBoxes())).map((b) => ({ id: b.castId, x: b.head.x, y: b.head.y, w: b.head.w }));
const diff = (a: number[], b: number[]) => a.reduce((s, v, i) => s + Math.abs(v - (b[i] ?? 0)), 0) / a.length;

async function addSwitchAt(t: number, query: string) {
  const lane = page.getByTestId('tl-lane-bg').locator('.tl-lane');
  await lane.scrollIntoViewIfNeeded();
  const b = (await lane.boundingBox())!;
  await page.mouse.dblclick(b.x + t * PPS, b.y + b.height - 3);
  await expect(page.getByTestId('bg-picker')).toBeVisible();
  await page.getByTestId('picker-search').fill(query);
  await expect(page.getByTestId('picker-card').first()).toBeVisible();
  const card = page.getByTestId('picker-card').first();
  const id = (await card.getAttribute('data-bg-id'))!;
  await card.click();
  return id;
}

test('the 背景 lane shows the start background as a fixed block; double-click adds a switch via the picker, and the picture changes at that time', async () => {
  const start = await startBg();
  await expect(page.getByTestId('tl-bgseg-first')).toBeVisible();
  const t3 = await beatStart(page, 's1b3');
  await seekTo(page, t3 + 0.9); // after the camera glide of the line, before the switch
  const pixBefore = await px();
  const headsBefore = await heads();
  const picked = await addSwitchAt(t3 + 1.0, '夜 卧室');
  expect(picked).not.toBe(start);
  await expect.poll(async () => (await bgKeys()).length, { timeout: 20_000 }).toBe(1);
  const key = (await bgKeys())[0]!;
  expect(key).toMatchObject({ value: { assetId: picked, transition: 'cut', purpose: 'move' }, meta: { source: 'user' } });
  expect(key.at.beatId).toBe('s1b3');
  await expect(page.getByTestId('tl-bgseg')).toHaveCount(1);
  await expect(page.getByTestId('key-bg')).toBeVisible(); // the new key is open in the inspector

  // before the key the old picture, after it the new one
  await seekTo(page, t3 + 0.3);
  expect((await stateOf(page)).background.assetId).toBe(start);
  await seekTo(page, t3 + 1.4);
  expect((await stateOf(page)).background.assetId).toBe(picked);
  const pixAfter = await px();
  expect(diff(pixBefore, pixAfter)).toBeGreaterThan(8); // the screen really shows another picture
  // ... and the people did not move (same beat, same camera): head boxes within a pixel
  const headsAfter = await heads();
  expect(headsAfter.map((h) => h.id)).toEqual(headsBefore.map((h) => h.id));
  for (const [i, h] of headsAfter.entries()) {
    expect(Math.abs(h.x - headsBefore[i]!.x)).toBeLessThanOrEqual(1.5);
    expect(Math.abs(h.y - headsBefore[i]!.y)).toBeLessThanOrEqual(1.5);
  }
});

test('the transition can be changed: crossfade draws two layers in between; dip to black rides on the fade channel', async () => {
  const k = (await bgKeys())[0]!;
  const t3 = await beatStart(page, 's1b3');
  await page.getByTestId('key-bg-transition').selectOption('crossfade');
  await expect.poll(async () => (await bgKeys())[0]!.value.transition, { timeout: 20_000 }).toBe('crossfade');
  await expect(page.getByTestId('key-bg-seconds')).toBeVisible();
  const at = t3 + k.at.offset;
  await seekTo(page, at + 0.4);
  const mid = (await stateOf(page)).background;
  expect(mid.next?.alpha ?? 0).toBeGreaterThan(0.05);
  expect(mid.next?.assetId).toBe(k.value.assetId);
  await seekTo(page, at + 2.5);
  expect((await stateOf(page)).background.next).toBeUndefined();
  await page.getByTestId('key-bg-transition').selectOption('dip_black');
  await expect.poll(async () => (await bgKeys())[0]!.value.transition, { timeout: 20_000 }).toBe('dip_black');
  await seekTo(page, at - 0.01);
  expect((await stateOf(page)).fade.alpha).toBeGreaterThan(0.5);
  await page.getByTestId('key-bg-transition').selectOption('cut');
  await expect.poll(async () => (await bgKeys())[0]!.value.transition, { timeout: 20_000 }).toBe('cut');
});

test('drag the key to another time; undo puts it back; the Inspector button adds a second switch at the playhead; Delete removes it', async () => {
  const k0 = (await bgKeys())[0]!;
  const t3 = await beatStart(page, 's1b3');
  const at0 = t3 + k0.at.offset;
  const keyEl = page.getByTestId(`tl-key-${k0.id}`);
  const c = await center(keyEl);
  await page.keyboard.down('Control');
  await dragBy(page, c, 0.8 * PPS);
  await page.keyboard.up('Control');
  await expect.poll(async () => {
    const k = (await bgKeys())[0]!;
    return Math.round((((await beatStart(page, k.at.beatId)) + k.at.offset) - at0) * 10) / 10;
  }, { timeout: 20_000 }).toBeGreaterThan(0.4);
  await page.getByTestId('btn-undo').click();
  await expect.poll(async () => {
    const k = (await bgKeys())[0]!;
    return Math.abs(((await beatStart(page, k.at.beatId)) + k.at.offset) - at0) < 0.06;
  }, { timeout: 20_000 }).toBe(true);

  // second switch from the inspector's scene tab at the playhead
  const t5 = await beatStart(page, 's1b5');
  await seekTo(page, t5 + 0.2);
  await page.getByTestId('insp-tab-scene').click();
  await page.getByTestId('insp-bg-switch').click();
  await page.getByTestId('picker-search').fill('RiNG');
  const pick2 = page.getByTestId('picker-card').first();
  const id2 = (await pick2.getAttribute('data-bg-id'))!;
  await pick2.click();
  await expect.poll(async () => (await bgKeys()).length, { timeout: 20_000 }).toBe(2);
  expect((await bgKeys()).find((k) => k.value.assetId === id2)).toBeTruthy();
  await page.getByTestId('insp-tab-scene').click();
  await expect(page.getByTestId('insp-bg-seg')).toHaveCount(3);

  // delete the second one: select it on the lane and press Delete
  const added = (await bgKeys()).find((k) => k.value.assetId === id2)!;
  await page.getByTestId(`tl-key-${added.id}`).click();
  await page.keyboard.press('Delete');
  await expect.poll(async () => (await bgKeys()).length, { timeout: 20_000 }).toBe(1);
  await page.getByTestId('btn-undo').click();
  await expect.poll(async () => (await bgKeys()).length, { timeout: 20_000 }).toBe(2);
});

test('the picker hides decor unless the switch is on, and asks before a decor picture is used', async () => {
  const lane = page.getByTestId('tl-lane-bg').locator('.tl-lane');
  const b = (await lane.boundingBox())!;
  const t9 = await beatStart(page, 's1b2');
  await page.mouse.dblclick(b.x + t9 * PPS, b.y + b.height - 3);
  await expect(page.getByTestId('bg-picker')).toBeVisible();
  await page.getByTestId('picker-search').fill('logo');
  await expect(page.getByText('没有匹配的背景')).toBeVisible();
  await page.getByTestId('picker-show-decor').check();
  const card = page.getByTestId('picker-card').first();
  await expect(card).toBeVisible();
  await card.click();
  await expect(page.getByTestId('picker-decor-confirm')).toBeVisible();
  await page.getByRole('button', { name: '取消' }).click();
  await page.getByTestId('picker-close').click();
  await page.getByTestId('picker-show-decor').count(); // (closed)
  await expect(page.getByTestId('bg-picker')).toHaveCount(0);
  expect(errors.filter((e) => !/favicon|ResizeObserver/.test(e))).toEqual([]);
});
