import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';

// The dev server reads the committed label file; put it back byte for byte afterwards and make the server reload it.
const FILE = path.resolve('asset-labels/backgrounds.json');
let original = '';
test.beforeAll(() => {
  original = fs.readFileSync(FILE, 'utf8');
});
test.afterAll(async ({ request }) => {
  fs.writeFileSync(FILE, original);
  const rules = (JSON.parse(original) as { rules: unknown }).rules;
  await request.put('/api/asset-labels/rules', { data: rules });
  expect(fs.readFileSync(FILE, 'utf8')).toBe(original);
});
test.describe.configure({ mode: 'serial' });

async function open(page: Page) {
  await page.goto('/assets');
  await page.getByRole('tab', { name: /^背景/ }).click();
  await expect(page.getByTestId('bg-cards')).toBeVisible();
}

test('filter by band, relabel three backgrounds as generic in one batch, persist, undo', async ({ page }) => {
  await open(page);
  await page.getByTestId('bg-filter-band').selectOption('avemujica');
  const cards = page.getByTestId('bg-card');
  const n = await cards.count();
  expect(n).toBeGreaterThan(3);
  await expect(page.getByTestId('bg-band').first()).toContainText('Ave Mujica');
  const ids: string[] = [];
  for (let i = 0; i < 3; i++) ids.push((await cards.nth(i).getAttribute('data-bg-id'))!);
  await cards.nth(0).click();
  await cards.nth(2).click({ modifiers: ['Shift'] });
  await expect(page.getByTestId('label-editor')).toContainText('3 张');
  await page.getByTestId('le-band-avemujica').uncheck();
  await page.getByTestId('le-band-generic').check();
  await page.getByTestId('le-save').click();
  // those three left the Ave Mujica filter
  await expect(cards).toHaveCount(n - 3);
  await page.getByTestId('bg-filter-band').selectOption('');
  for (const id of ids) await expect(page.locator(`[data-bg-id="${id}"]`).getByTestId('bg-band')).toHaveText('通用');

  // persisted across a reload
  await page.reload();
  await page.getByRole('tab', { name: /^背景/ }).click();
  await page.getByTestId('bg-filter-band').selectOption('generic');
  for (const id of ids) await expect(page.locator(`[data-bg-id="${id}"]`)).toHaveCount(1);
});

test('unknown / pending backgrounds can be filtered out', async ({ page }) => {
  await open(page);
  await page.getByTestId('bg-filter-unknown').check();
  const n = await page.getByTestId('bg-card').count();
  expect(n).toBeGreaterThan(0);
  await expect(page.getByTestId('bg-card').first().getByTestId('bg-conf')).toBeVisible();
});

test('undo restores the previous labels', async ({ page }) => {
  await open(page);
  await page.getByTestId('bg-filter-band').selectOption('mewtype');
  const first = page.getByTestId('bg-card').first();
  const id = (await first.getAttribute('data-bg-id'))!;
  await first.click();
  await page.getByTestId('le-band-mewtype').uncheck();
  await page.getByTestId('le-band-generic').check();
  await page.getByTestId('le-save').click();
  await page.getByTestId('bg-filter-band').selectOption('');
  await expect(page.locator(`[data-bg-id="${id}"]`).getByTestId('bg-band')).toHaveText('通用');
  await page.getByTestId('le-undo').click();
  await expect(page.locator(`[data-bg-id="${id}"]`).getByTestId('bg-band')).not.toHaveText('通用');
});
