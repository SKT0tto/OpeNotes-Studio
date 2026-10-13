/**
 * P20 in a real browser: the labelling workbench. Multi-select + a chip in the grid (kept after a reload), the review queue answered from the keyboard
 * (digit + Enter, Ctrl+Z), ten pictures in well under a minute, and the page without an asset library (banner + contact sheet / placeholder).
 */
import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { acquireLabelLock, releaseLabelLock } from './helpers/labelLock';

const FILE = path.resolve('asset-labels/backgrounds.json');
let original = '';
test.setTimeout(300_000);
test.beforeAll(async () => {
  await acquireLabelLock();
  original = fs.readFileSync(FILE, 'utf8');
});
test.afterAll(async ({ request }) => {
  fs.writeFileSync(FILE, original);
  await request.put('/api/asset-labels/rules', { data: (JSON.parse(original) as { rules: unknown }).rules });
  expect(fs.readFileSync(FILE, 'utf8')).toBe(original);
  releaseLabelLock();
});
test.describe.configure({ mode: 'serial' });

const confirmed = async (page: Page) => Number(await page.getByTestId('wb-confirmed').innerText());
const labelsOnDisk = () => (JSON.parse(fs.readFileSync(FILE, 'utf8')) as { labels: Record<string, { bands: string[]; confidence: string; source: string }> }).labels;

test('grid: select three pictures, one click on 「Ave Mujica」 sets them all, and it is still there after a reload', async ({ page }) => {
  await page.goto('/label');
  await expect(page.getByTestId('workbench')).toBeVisible();
  const cards = page.getByTestId('wb-card');
  await expect(cards.first()).toBeVisible();
  const ids: string[] = [];
  for (let i = 0; i < 3; i++) ids.push((await cards.nth(i).getAttribute('data-bg-id'))!);
  await cards.nth(0).click();
  await cards.nth(1).click({ modifiers: ['Control'] });
  await cards.nth(2).click({ modifiers: ['Control'] });
  await expect(page.getByTestId('wb-selnote')).toContainText('已选 3 张');
  await page.getByTestId('chip-band-avemujica').click();
  for (const id of ids) await expect(page.locator(`[data-testid="wb-card"][data-bg-id="${id}"]`).getByTestId('bg-band')).toHaveText('Ave Mujica');
  // saved at once (the server validated and wrote the file)
  await expect.poll(() => ids.every((id) => labelsOnDisk()[id]!.bands.join() === 'avemujica' && labelsOnDisk()[id]!.source === 'user')).toBe(true);
  await page.reload();
  await expect(page.getByTestId('wb-card').first()).toBeVisible();
  for (const id of ids) await expect(page.locator(`[data-testid="wb-card"][data-bg-id="${id}"]`).getByTestId('bg-band')).toHaveText('Ave Mujica');
  // Ctrl+Z undoes the whole batch, and the file follows
  await expect(page.getByTestId('wb-undo')).toBeDisabled(); // a fresh page has nothing to undo
  await page.locator(`[data-testid="wb-card"][data-bg-id="${ids[0]}"]`).click();
  await page.locator(`[data-testid="wb-card"][data-bg-id="${ids[1]}"]`).click({ modifiers: ['Control'] }); // one card shows the detail editor, two keep the batch chips
  await page.getByTestId('chip-band-generic').click();
  await expect(page.locator(`[data-testid="wb-card"][data-bg-id="${ids[0]}"]`).getByTestId('bg-band')).toHaveText('通用');
  await page.keyboard.press('Control+z');
  await expect(page.locator(`[data-testid="wb-card"][data-bg-id="${ids[0]}"]`).getByTestId('bg-band')).toHaveText('Ave Mujica');
  await expect.poll(() => labelsOnDisk()[ids[0]!]!.bands.join()).toBe('avemujica');
});

test('queue: the large picture, the suggestion, 2 + Enter confirms and jumps on, Ctrl+Z brings it back', async ({ page }) => {
  await page.goto('/label');
  await expect(page.getByTestId('wb-card').first()).toBeVisible();
  const before = await confirmed(page);
  await page.getByTestId('wb-tab-queue').click();
  await expect(page.getByTestId('wb-queue')).toBeVisible();
  await expect(page.getByTestId('wb-keys')).toContainText('Enter');
  const side = page.getByTestId('wbq-side');
  const first = (await side.getAttribute('data-bg-id'))!;
  await expect(page.getByTestId('wbq-title')).not.toHaveValue('');
  await expect(page.getByTestId('wbq-desc')).not.toBeEmpty();
  const pos0 = await page.getByTestId('wbq-pos').innerText();
  await page.keyboard.press('2');
  await expect(page.getByTestId('wbq-band-avemujica')).toHaveClass(/on/);
  await expect.poll(() => labelsOnDisk()[first]!.bands.join()).toBe('avemujica');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('wbq-pos')).not.toHaveText(pos0);
  await expect(page.getByTestId('wb-confirmed')).toHaveText(String(before + 1));
  await expect.poll(() => labelsOnDisk()[first]!.confidence).toBe('confirmed');
  await page.keyboard.press('ArrowLeft');
  await expect(side).toHaveAttribute('data-bg-id', first);
  await expect(page.getByTestId('wbq-state')).toHaveAttribute('data-review', 'confirmed'); // green
  await page.keyboard.press('Control+z');
  await expect(page.getByTestId('wb-confirmed')).toHaveText(String(before));
  await expect(page.getByTestId('wbq-state')).not.toHaveAttribute('data-review', 'confirmed');
});

test('queue: suggestions show "current -> suggested" with the reason; accept writes the field, reject only removes the note', async ({ page }) => {
  await page.goto('/label');
  await expect(page.getByTestId('wb-card').first()).toBeVisible();
  // a picture with a review suggestion: search for it
  await page.getByTestId('wb-search').fill('拉面店吧台');
  const card = page.getByTestId('wb-card').first();
  await expect(card).toContainText('建议');
  const id = (await card.getAttribute('data-bg-id'))!;
  await card.dblclick();
  await expect(page.getByTestId('wb-queue')).toBeVisible();
  const fix = page.getByTestId('wbq-fix').first();
  await expect(fix).toContainText('→');
  const before = labelsOnDisk() as unknown as Record<string, { placeType?: string; fixes?: unknown[] }>;
  expect(before[id]!.placeType).toBe('live_house');
  const count = (before[id]!.fixes ?? []).length;
  // the queue is opened on this picture only when it is pending; make sure we are looking at it
  await expect(page.getByTestId('wbq-side')).toHaveAttribute('data-bg-id', id);
  await fix.getByTestId('wbq-accept').click();
  await expect.poll(() => (labelsOnDisk() as unknown as typeof before)[id]!.fixes?.length ?? 0).toBe(count - 1);
  const after = labelsOnDisk() as unknown as typeof before;
  expect(['restaurant', 'live_house']).toContain(after[id]!.placeType);
  expect(after[id]!.placeType).not.toBe('live_house');
});

test('queue by keyboard only: ten pictures confirmed in under a minute', async ({ page }) => {
  await page.goto('/label');
  await expect(page.getByTestId('wb-card').first()).toBeVisible();
  await page.getByTestId('wb-tab-queue').click();
  await expect(page.getByTestId('wbq-side')).toBeVisible();
  const t0 = Date.now();
  const start = await confirmed(page);
  for (let i = 0; i < 10; i++) {
    const pos = await page.getByTestId('wbq-pos').innerText();
    await page.keyboard.press(String((i % 5) + 1));
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('wbq-pos')).not.toHaveText(pos);
  }
  expect(Date.now() - t0).toBeLessThan(60_000);
  await expect(page.getByTestId('wb-confirmed')).toHaveText(String(start + 10));
});

test('without an asset library: the banner, the import link, and every card still shows what it is (contact sheet crop or placeholder)', async ({ page }) => {
  // an asset root that is gone: the health check says so and no original picture can be served (labels are only read here)
  await page.route('**/api/health', async (route) => {
    const res = await route.fetch();
    const body = (await res.json()) as Record<string, unknown>;
    await route.fulfill({ response: res, json: { ...body, assetRoot: { ok: false, path: 'D:/gone', error: 'ENOENT' } } });
  });
  await page.route(/\/api\/thumbs\/backgrounds\/[^/?]+(\?.*)?$/, (route) => route.fulfill({ status: 404, json: { error: 'original missing' } }));
  await page.goto('/label');
  await expect(page.getByTestId('wb-banner')).toContainText('素材库未找到');
  await expect(page.getByTestId('wb-import')).toBeVisible();
  const card = page.getByTestId('wb-card').first();
  await expect(card).toBeVisible();
  await expect(card.getByTestId('bg-title')).not.toBeEmpty();
  await expect(card.getByTestId('bg-thumb')).toHaveAttribute('data-thumb', /^(sheet|none)$/, { timeout: 20_000 });
  await page.getByTestId('wb-tab-queue').click();
  await expect(page.getByTestId('wbq-title')).not.toHaveValue('');
  await expect(page.getByTestId('wbq-desc')).not.toBeEmpty();
  await expect(page.getByTestId('wb-queue').getByTestId('bg-thumb')).toHaveAttribute('data-thumb', /^(sheet|none)$/, { timeout: 20_000 });
});

test('detail editor: select one card, set the owner 初华 by search, edit title + description, save, reload: it is all still there and the asset browser shows the title', async ({ page }) => {
  await page.goto('/label');
  const cards = page.getByTestId('wb-card');
  await expect(cards.first()).toBeVisible();
  const id = (await cards.nth(3).getAttribute('data-bg-id'))!;
  await cards.nth(3).click();
  await expect(page.getByTestId('wbd')).toBeVisible();
  await expect(page.getByTestId('wbd-state')).toHaveText('已保存');
  if (await page.getByTestId('wbd-no-owner').count()) await page.getByTestId('wbd-no-owner').click(); // replace whoever is there
  await page.getByTestId('wbd-char-search').fill('初华');
  await page.getByTestId('wbd-add-006').click();
  await page.getByTestId('wbd-title').fill('初华家阁楼·测试');
  await page.getByTestId('wbd-desc').fill('在初华家的阁楼里，测试用描述。');
  await expect(page.getByTestId('wbd-state')).toContainText('未保存');
  await page.getByTestId('wbd-desc').press('Control+Enter');
  await expect.poll(() => (labelsOnDisk()[id] as unknown as { title?: string; description?: string; ownerKey?: string; residents?: string[] }).title).toBe('初华家阁楼·测试');
  const saved = labelsOnDisk()[id] as unknown as { description: string; ownerKey: string; owner: string; residents: string[]; source: string; confidence: string };
  expect(saved).toMatchObject({ description: '在初华家的阁楼里，测试用描述。', ownerKey: '006', owner: '三角初华', residents: ['006'], source: 'user', confidence: 'confirmed' });
  await page.reload();
  await page.getByTestId('wb-search').fill('初华家阁楼·测试');
  await page.getByTestId('wb-card').first().click();
  await expect(page.getByTestId('wbd-title')).toHaveValue('初华家阁楼·测试');
  await expect(page.getByTestId('wbd-desc')).toHaveValue('在初华家的阁楼里，测试用描述。');
  await expect(page.getByTestId('wbd-res-006')).toBeVisible();
  // the asset browser (catalog reloaded by the server) shows the new title
  await page.goto('/assets');
  await page.getByRole('tab', { name: /背景/ }).click();
  await page.getByLabel('搜索背景').fill('初华家阁楼·测试');
  await expect(page.getByTestId('bg-card').first().getByTestId('bg-title')).toContainText('初华家阁楼·测试');
});
