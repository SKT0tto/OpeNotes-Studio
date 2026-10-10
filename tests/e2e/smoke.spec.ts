import { expect, test } from '@playwright/test';

test('page loads, shows ASSET_ROOT health, no console errors', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(e.message));

  await page.goto('/assets');
  await expect(page.getByRole('heading', { name: 'OpeNotes Studio' })).toBeVisible();
  await expect(page.getByTestId('health')).toContainText('ASSET_ROOT: OK');
  await expect(page.getByTestId('health')).toContainText(/\d+ models \/ \d+ backgrounds/);
  await expect(page.getByTestId('asset-browser')).toBeVisible();
  expect(errors).toEqual([]);
});

test('unreadable ASSET_ROOT is reported with a clear error', async ({ page }) => {
  await page.route('**/api/health', async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    body.assetRoot = { ok: false, path: 'X:/missing', error: 'ENOENT: no such file or directory' };
    await route.fulfill({ response: res, json: body });
  });
  await page.goto('/');
  await expect(page.getByTestId('health')).toContainText('ASSET_ROOT 不可用');
  await expect(page.getByTestId('health')).toContainText('ENOENT');
  await expect(page.getByTestId('asset-browser')).toHaveCount(0);
});
