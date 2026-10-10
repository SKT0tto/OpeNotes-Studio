import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { buildZip, type ZipEntry } from '../unit/helpers/zipBuilder';
import { writeSitePackage, writePng } from '../unit/helpers/sitePackage';

// First-run server (see playwright.config.ts): empty library, isolated config files, mocked Haneoka index.
test.use({ baseURL: 'http://127.0.0.1:5375' });
const API = 'http://127.0.0.1:5376';

async function packageZip(): Promise<Buffer> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ons-e2e-pkg-'));
  try {
    await writeSitePackage(tmp, '001_casual_spring_01', 6);
    await writePng(path.join(tmp, 'bgs', 'adv_bkg_stage_000001.png'));
    await writePng(path.join(tmp, 'bgs', 'unknown_name.png'));
    const entries: ZipEntry[] = [];
    const walk = async (d: string) => {
      for (const e of await fs.readdir(d, { withFileTypes: true })) {
        const abs = path.join(d, e.name);
        if (e.isDirectory()) await walk(abs);
        else entries.push({ name: path.relative(tmp, abs).split(path.sep).join('/'), data: await fs.readFile(abs) });
      }
    };
    await walk(tmp);
    return buildZip(entries);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

test.beforeAll(async () => {
  for (const p of ['e2e-lib', 'e2e-lib-data', 'e2e-vendor', 'e2e-config.json', 'e2e-setup.local.json']) await fs.rm(path.join('data-test', p), { recursive: true, force: true });
});

test('first run: import a site-style zip, skip duplicates, confirm the disclaimer, build a manifest, install a Core', async ({ page, request }) => {
  await page.goto('/');
  await expect(page.getByTestId('setup-wizard')).toBeVisible();
  await expect(page.getByTestId('assets-status')).toContainText('还是空的');

  // zip -> plan -> import
  const buffer = await packageZip();
  await page.getByTestId('import-zip').setInputFiles({ name: 'site-pack.zip', mimeType: 'application/zip', buffer });
  await expect(page.getByTestId('import-plan')).toBeVisible();
  await expect(page.getByTestId('plan-models')).toContainText('001_casual_spring_01');
  await expect(page.getByTestId('import-summary')).toContainText('动作 6');
  await expect(page.getByTestId('plan-backgrounds')).toContainText('adv_bkg_stage_000001');
  await expect(page.getByTestId('plan-backgrounds')).toContainText('无法识别');
  await page.getByTestId('import-run').click();
  await expect(page.getByTestId('report-summary')).toContainText('模型 1');
  await expect(page.getByTestId('report-summary')).toContainText('动作 6');

  // the catalog sees all 6 motions (a site-style model3.json would index as 1)
  const model = (await (await request.get(`${API}/api/catalog/models/001_casual_spring_01`)).json()) as { motions: unknown[] };
  expect(model.motions).toHaveLength(6);

  // importing the same package again changes nothing
  await page.getByRole('button', { name: '继续导入其他素材' }).click();
  await page.getByTestId('import-zip').setInputFiles({ name: 'site-pack.zip', mimeType: 'application/zip', buffer });
  await expect(page.getByTestId('plan-models')).toContainText('已存在（相同）');
  await expect(page.getByTestId('import-run')).toBeDisabled();

  // Haneoka: blocked on the server until the disclaimer is accepted
  expect((await request.get(`${API}/api/sources/haneoka/list`)).status()).toBe(403);
  await page.getByTestId('tab-haneoka').click();
  await expect(page.getByTestId('disclaimer')).toBeVisible();
  await expect(page.getByTestId('disclaimer-accept')).toBeDisabled();
  await page.getByTestId('disclaimer-text').evaluate((el) => (el.scrollTop = el.scrollHeight));
  await expect(page.getByTestId('disclaimer-accept')).toBeEnabled();
  await page.getByTestId('disclaimer-accept').click();
  await expect(page.getByTestId('hk-counts')).toContainText('5 个模型');
  await page.getByTestId('hk-models').locator('summary', { hasText: '高松灯' }).click();
  await page.getByTestId('pick-model-001_live-mode_live_01').check();
  await page.getByTestId('pick-bg-adv_bkg_stage_000002').check();
  await page.getByTestId('hk-make').click();
  const links = await page.getByTestId('hk-manifest').locator('a').evaluateAll((as) => as.map((a) => (a as HTMLAnchorElement).href));
  expect(links).toHaveLength(2);
  for (const l of links) expect(l).toMatch(/^https:\/\/haneoka\.org\/intl\/zh-CN\/(live2d|assets)\//);
  const csv = await request.post(`${API}/api/sources/haneoka/manifest`, { data: { models: ['001_live-mode_live_01'], backgrounds: [], format: 'csv' } });
  expect(await csv.text()).toContain('001_live-mode_live_01');

  // Core: needs the licence; a non-Core file is refused, a Core-shaped file is installed
  await page.getByTestId('wizard-step-0').click();
  await expect(page.getByTestId('core-pick')).toBeDisabled();
  await page.getByTestId('core-agree').locator('input').check();
  await page.getByTestId('core-file').setInputFiles({ name: 'bad.js', mimeType: 'text/javascript', buffer: Buffer.from('alert(1)') });
  await expect(page.getByTestId('core-error')).toContainText('不是 Live2D Cubism Core');
  const fake = '/* Live2D Cubism Core (test double) */ window.Live2DCubismCore={Version:{csmGetLatestMocVersion:()=>6,csmGetVersion:()=>1}};';
  await page.getByTestId('core-file').setInputFiles({ name: 'live2dcubismcore.min.js', mimeType: 'text/javascript', buffer: Buffer.from(`${fake}/* csmGetLatestMocVersion */`) });
  await expect(page.getByTestId('core-status')).toContainText('本地副本');
  const core = (await (await request.get(`${API}/api/setup/core`)).json()) as { local: boolean };
  expect(core.local).toBe(true);

  // 完成 -> the hub, now with a library
  await page.getByTestId('wizard-done').click();
  await expect(page.getByTestId('hub')).toBeVisible();
  await expect(page.getByTestId('env-assets')).toContainText('1 个模型');
});
