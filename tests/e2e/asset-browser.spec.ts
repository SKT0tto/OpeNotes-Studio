import { expect, test, type Page } from '@playwright/test';
import { searchBackgrounds } from '../../shared/catalog/bgUi';
import { bgCategoryOf } from '../../shared/director/bgCategory';
import type { CompactCatalog } from '../../shared/schema/assets';

let catalog: CompactCatalog;
/** What the browser shows by default: decor hidden, duplicate copies folded behind their master. */
const shown = (list: CompactCatalog['backgrounds']) => {
  const base = list.filter((b) => bgCategoryOf(b) !== 'decor');
  const ids = new Set(base.map((b) => b.id));
  return base.filter((b) => !(b.labels?.duplicateOf && ids.has(b.labels.duplicateOf)));
};
test.beforeAll(async ({ request }) => {
  catalog = await (await request.get('/api/catalog')).json();
});

async function open(page: Page) {
  await page.goto('/assets');
  await expect(page.getByTestId('asset-browser')).toBeVisible();
}

test('characters tab lists 25 members plus NPCs, and cards show costume info', async ({ page }) => {
  await open(page);
  const visible = catalog.characters.filter((c) => catalog.models.some((m) => m.characterKey === c.key && m.quality !== 'low'));
  expect(visible.filter((c) => !c.isSub)).toHaveLength(25);
  await expect(page.getByTestId('character-item')).toHaveCount(visible.length);
  await expect(page.getByRole('heading', { name: '配角 / NPC' })).toBeVisible();

  const tomori = page.getByTestId('character-item').filter({ hasText: '高松灯' });
  await tomori.click();
  const expected = catalog.models.filter((m) => m.characterKey === '001' && m.quality !== 'low');
  await expect(page.getByTestId('model-card')).toHaveCount(expected.length);
  const card = page.locator('[data-model-id="001_casual_spring_01"]');
  await expect(card).toContainText('便服 · 春');
  await expect(card).toContainText(/\d+ 动作/);
  if (expected.find((m) => m.id === '001_casual_spring_01')?.preview) await expect(card.locator('img')).toHaveAttribute('loading', 'lazy'); // a library without preview images shows "无预览"
});

test('low-quality toggle reveals _low models', async ({ page }) => {
  await open(page);
  const low = catalog.models.filter((m) => m.quality === 'low');
  expect(low.length).toBeGreaterThan(0);
  const target = low[0]!;
  const name = catalog.characters.find((c) => c.key === target.characterKey)!.name;
  await page.getByTestId('character-item').filter({ hasText: name }).first().click();
  await expect(page.locator(`[data-model-id="${target.id}"]`)).toHaveCount(0);
  await page.getByLabel(/显示低画质/).check();
  await expect(page.locator(`[data-model-id="${target.id}"]`)).toHaveCount(1);
  await page.getByLabel(/显示低画质/).uncheck();
  await expect(page.locator(`[data-model-id="${target.id}"]`)).toHaveCount(0);
});

test('selecting a model lists its motions and expressions', async ({ page }) => {
  await open(page);
  await page.locator('[data-model-id="001_casual_spring_01"]').click();
  const detail = page.getByTestId('model-detail');
  await expect(detail).toContainText('idle01');
  await expect(detail).toContainText('exp_smile01');
  await page.getByTestId('character-item').filter({ hasText: '高松灯' }).click();
  await page.locator('[data-model-id="001_live-mode_live_01"]').click();
  await expect(page.getByTestId('model-detail')).toContainText('该模型没有表情');
});

test('background search and filters', async ({ page }) => {
  await open(page);
  await page.getByRole('tab', { name: /背景/ }).click();
  const total = catalog.backgrounds.length;
  await expect(page.getByTestId('bg-count')).toContainText(`命中 ${shown(catalog.backgrounds).length} / ${total}`);

  const expected = shown(searchBackgrounds(catalog.backgrounds, 'RiNG 夜间'));
  expect(expected.length).toBeGreaterThan(0);
  await page.getByLabel('搜索背景').fill('RiNG 夜间');
  await expect(page.getByTestId('bg-count')).toContainText(`命中 ${expected.length} /`);
  const first = page.getByTestId('bg-card').first();
  await expect(first.getByTestId('bg-title')).toContainText('RiNG');
  await expect(first.getByTestId('bg-time')).toContainText('夜');

  await page.getByLabel('搜索背景').fill('');
  await page.getByTestId('bg-chips-category').getByRole('button', { name: '插入镜头' }).click();
  const inserts = shown(catalog.backgrounds.filter((b) => bgCategoryOf(b) === 'insert')).length;
  await expect(page.getByTestId('bg-count')).toContainText(`命中 ${inserts} /`);
  await page.getByTestId('bg-chips-category').getByRole('button', { name: '全部' }).click();
  await page.getByTestId('bg-chips-time').getByRole('button', { name: '夜间' }).click();
  const night = shown(catalog.backgrounds.filter((b) => b.time === '夜间')).length;
  await expect(page.getByTestId('bg-count')).toContainText(`命中 ${night} /`);
  await page.getByLabel('搜索背景').fill('不存在的地点xyz');
  await expect(page.getByText('没有匹配的背景')).toBeVisible();
});

test('background cards: title, description, badges; decor and duplicate copies are hidden until asked for', async ({ page }) => {
  await open(page);
  await page.getByRole('tab', { name: /背景/ }).click();
  const card = page.getByTestId('bg-card').first();
  await expect(card.getByTestId('bg-title')).not.toBeEmpty();
  await expect(card.getByTestId('bg-desc')).not.toBeEmpty();
  await expect(card.getByTestId('bg-band').first()).toBeVisible();
  // the MyGO logo (id 4) is decor: hidden by default, shown with the switch
  await page.getByLabel('搜索背景').fill('logo');
  await expect(page.getByText('没有匹配的背景')).toBeVisible();
  await page.getByTestId('bg-show-decor').check();
  await expect(page.getByTestId('bg-card').first().getByTestId('bg-category')).toContainText('装饰');
  await page.getByTestId('bg-show-decor').uncheck();
  // 夜 卧室 / RiNG / 信号灯 find the right pictures
  await page.getByLabel('搜索背景').fill('夜 卧室');
  await expect(page.getByTestId('bg-card').first()).toContainText(/卧室|房间/);
  await page.getByLabel('搜索背景').fill('信号灯');
  await expect(page.getByTestId('bg-card').first().getByTestId('bg-title')).toContainText('信号灯');
  // folded copies: "同一画面 ×2" unfolds the copy
  await page.getByLabel('搜索背景').fill('');
  const count = async () => Number(/命中 (\d+)/.exec(await page.getByTestId('bg-count').innerText())![1]);
  await expect(page.getByTestId('bg-dup').first()).toBeVisible();
  const before = await count();
  await page.getByTestId('bg-unfold').check();
  await expect.poll(count).toBeGreaterThan(before);
});

test('background list pages in 60 at a time', async ({ page }) => {
  await open(page);
  await page.getByRole('tab', { name: /背景/ }).click();
  await expect(page.getByTestId('bg-card')).toHaveCount(60);
  await page.getByRole('button', { name: /显示更多/ }).click();
  await expect(page.getByTestId('bg-card')).toHaveCount(120);
});

test('audio tab lists the library and plays', async ({ page }) => {
  test.skip(catalog.audio.length === 0, 'this asset library has no audio');
  await open(page);
  await page.getByRole('tab', { name: /音频/ }).click();
  const items = page.getByTestId('audio-item');
  await expect(items).toHaveCount(catalog.audio.length);
  const audio = items.first().locator('audio');
  await audio.evaluate((el: HTMLAudioElement) => el.play());
  await expect.poll(() => audio.evaluate((el: HTMLAudioElement) => el.currentTime)).toBeGreaterThan(0);
  expect(await audio.evaluate((el: HTMLAudioElement) => el.paused)).toBe(false);
  await audio.evaluate((el: HTMLAudioElement) => el.pause());
});
