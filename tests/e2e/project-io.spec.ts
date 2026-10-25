import fs from 'node:fs/promises';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { collectRefs } from '../../shared/project/exchange';
import { ProjectSchema, type Project } from '../../shared/schema/project';
import './helpers/studio';
import { tab } from './helpers/ui';

const created: string[] = [];
test.afterEach(async ({ request }: { request: APIRequestContext }) => {
  for (const id of created.splice(0)) await request.delete(`/api/projects/${id}`);
});

async function newFromDemo(page: Page, title: string): Promise<string> {
  await page.goto('/');
  await page.getByTestId('new-title').fill(title);
  await page.getByTestId('btn-from-demo').click();
  await expect(page.getByTestId('workspace')).toBeVisible();
  const id = /\/editor\/([^/]+)$/.exec(page.url())![1]!;
  created.push(id);
  return id;
}
const ready = (page: Page) => expect(page.getByTestId('play-status')).toHaveText('就绪', { timeout: 180_000 });
const saveState = (page: Page) => page.getByTestId('save-state');
const subtitle = (page: Page) => page.evaluate(() => window.__studio.player!.state()?.subtitle?.text ?? null);

test('new project -> edit title -> save -> reload keeps it; undo / redo work', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(e.message));
  const id = await newFromDemo(page, '往返测试');
  await ready(page);
  await expect(saveState(page)).toHaveText('已保存');

  await tab(page, 'project');
  const title = page.getByTestId('insp-project-title');
  await title.fill('改过的标题');
  await expect(saveState(page)).toHaveText('有未保存的更改');
  await expect(page.getByTestId('ws-title')).toHaveText('改过的标题');
  await page.getByTestId('btn-undo').click();
  await expect(page.getByTestId('ws-title')).toHaveText('往返测试');
  await page.getByTestId('btn-redo').click();
  await expect(page.getByTestId('ws-title')).toHaveText('改过的标题');

  await page.getByTestId('btn-save').click();
  await expect(saveState(page)).toHaveText('已保存');
  await page.reload();
  await expect(page.getByTestId('ws-title')).toHaveText('改过的标题');
  const stored = (await (await page.request.get(`/api/projects/${id}`)).json()) as Project;
  expect(stored.title).toBe('改过的标题');
  expect(errors).toEqual([]);
});

test('Ctrl+Z / Ctrl+Shift+Z / Ctrl+S; a typing run is one undo step', async ({ page }) => {
  await newFromDemo(page, '快捷键');
  await tab(page, 'project');
  const title = page.getByTestId('insp-project-title');
  await title.click();
  await page.keyboard.press('End');
  await page.keyboard.type('abc');
  await expect(page.getByTestId('ws-title')).toHaveText('快捷键abc');
  await page.keyboard.press('Control+z');
  await expect(page.getByTestId('ws-title')).toHaveText('快捷键');
  await page.keyboard.press('Control+Shift+z');
  await expect(page.getByTestId('ws-title')).toHaveText('快捷键abc');
  await page.keyboard.press('Control+s');
  await expect(saveState(page)).toHaveText('已保存');
});

test('edits update the preview immediately, and undo restores it', async ({ page }) => {
  await newFromDemo(page, '预览联动');
  await ready(page);
  const b3 = await page.evaluate(() => window.__studio.player!.beatStarts().s1b3!);
  await page.evaluate((t) => window.__studio.player!.seek(t + 0.1), b3);
  await expect.poll(() => subtitle(page)).not.toBeNull();
  const original = (await subtitle(page))!;
  await expect(page.getByTestId('insp-beat-text')).toHaveValue(/.+/);

  await page.getByTestId('insp-beat-text').fill('这是一句被改过的台词。');
  await page.evaluate(() => window.__studio.player!.seek(window.__studio.player!.time()));
  await expect.poll(() => page.evaluate(() => window.__studio.player!.state()?.subtitle?.text ?? ''), { timeout: 20_000 }).toBe('这是一句被改过的台词。');

  await page.getByTestId('btn-undo').click();
  await expect.poll(() => page.evaluate(async () => {
    await window.__studio.player!.seek(window.__studio.player!.time());
    return window.__studio.player!.state()?.subtitle?.text ?? '';
  }), { timeout: 20_000 }).toBe(original);
});

test('changing a scene transition / text speed recompiles: the timeline length follows', async ({ page }) => {
  await newFromDemo(page, '时长联动');
  await ready(page);
  const d0 = await page.evaluate(() => window.__studio.player!.duration());
  await tab(page, 'project');
  await page.getByTestId('insp-cps').fill('2');
  await page.getByTestId('insp-cps').blur();
  await expect.poll(() => page.evaluate(() => window.__studio.player!.duration()), { timeout: 20_000 }).toBeGreaterThan(d0 + 1);
  await page.getByTestId('btn-undo').click();
  await expect.poll(() => page.evaluate(() => window.__studio.player!.duration()), { timeout: 20_000 }).toBeCloseTo(d0, 1);
});

test('export, delete, import gives the identical project; a missing background is listed and can be replaced', async ({ page }, info) => {
  // the example project's BGM lives in the audio library: a library without audio lists it as missing on import (that flow has its own test)
  const catalog = (await (await page.request.get('/api/catalog')).json()) as { audio: Array<{ id: string }> };
  test.skip(collectRefs(ProjectSchema.parse(JSON.parse(await fs.readFile('tests/fixtures/demo-project.json', 'utf8')))).audio.some((a) => !catalog.audio.some((x) => x.id === a)), 'the example project needs its BGM in the asset library');
  const id = await newFromDemo(page, '导出导入');
  await ready(page);
  const original = (await (await page.request.get(`/api/projects/${id}`)).json()) as Project;

  const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('btn-export').click()]);
  const file = info.outputPath('export.ournotes.json');
  await download.saveAs(file);
  const envelope = JSON.parse(await fs.readFile(file, 'utf8')) as { format: string; refs: { backgrounds: string[] }; project: Project };
  expect(envelope.format).toBe('openotes-project');
  expect(envelope.refs.backgrounds).toContain('adv_bkg_stage_000153');

  await page.getByTestId('btn-projects').click();
  await page.getByTestId('hub-all').click(); // the full project list lives in the 全部项目 overlay
  page.once('dialog', (d) => void d.accept());
  await page.locator(`[data-project-id="${id}"]`).getByTestId('btn-delete').click();
  await expect(page.locator(`[data-project-id="${id}"]`)).toHaveCount(0);
  await page.getByTestId('import-file').setInputFiles(file);
  await expect(page.getByTestId('import-ok')).toBeVisible();
  await page.getByTestId('import-confirm').click();
  await expect(page.getByTestId('workspace')).toBeVisible();
  const back = (await (await page.request.get(`/api/projects/${id}`)).json()) as Project;
  expect(back).toEqual(original);

  // a file that points at a background the library does not have
  envelope.project.id = `${id}-missing`;
  envelope.project.scenes[0]!.background.assetId = 'adv_bkg_does_not_exist';
  created.push(envelope.project.id);
  const bad = info.outputPath('missing.ournotes.json');
  await fs.writeFile(bad, JSON.stringify(envelope));
  await page.getByTestId('btn-projects').click();
  await page.getByTestId('import-file').setInputFiles(bad);
  await expect(page.getByTestId('import-missing')).toBeVisible();
  await expect(page.getByTestId('missing-row')).toHaveCount(1);
  await expect(page.getByTestId('missing-row')).toContainText('adv_bkg_does_not_exist');
  await page.getByRole('combobox', { name: /替换 adv_bkg_does_not_exist/ }).selectOption('adv_bkg_stage_000001');
  await page.getByTestId('import-confirm').click();
  await expect(page.getByTestId('workspace')).toBeVisible();
  const fixed = (await (await page.request.get(`/api/projects/${envelope.project.id}`)).json()) as Project;
  expect(fixed.scenes[0]!.background.assetId).toBe('adv_bkg_stage_000001');
});

test('importing garbage reports the reason instead of crashing', async ({ page }, info) => {
  await page.goto('/');
  const f = info.outputPath('garbage.json');
  await fs.writeFile(f, '{"hello": 1}');
  await page.getByTestId('import-file').setInputFiles(f);
  await expect(page.getByTestId('import-error')).toContainText('schema');
  await expect(page.getByTestId('import-confirm')).toHaveCount(0);
});

test('home: start cards, project cards with a cover and counts, search, batch delete', async ({ page }) => {
  const a = await newFromDemo(page, '首页甲');
  await page.getByTestId('btn-projects').click();
  const b = await newFromDemo(page, '首页乙');
  await page.getByTestId('btn-projects').click();
  for (const t of ['btn-ai-breakdown', 'btn-new', 'btn-from-demo', 'btn-import']) await expect(page.getByTestId(t)).toBeVisible();
  await expect(page.getByTestId('hub-continue')).toBeVisible();
  await expect(page.getByTestId('recent-item').first()).toBeVisible();
  await page.getByTestId('hub-all').click(); // search, grid and batch delete live in the 全部项目 overlay
  const card = page.locator(`[data-project-id="${a}"]`);
  await expect(card).toContainText('首页甲');
  await expect(card).toContainText('3 场景');
  await expect(card.locator('.proj-cover')).toHaveCSS('background-image', /url\(/);
  await page.getByTestId('hub-search').fill('首页乙');
  await expect(page.getByTestId('project-item')).toHaveCount(1);
  await page.getByTestId('hub-search').fill('不存在的名字');
  await expect(page.getByTestId('hub-no-match')).toBeVisible();
  await page.getByTestId('hub-search').fill('首页');
  await page.getByTestId('hub-manage').click();
  await page.locator(`[data-project-id="${a}"] .proj-card`).click();
  await page.locator(`[data-project-id="${b}"] .proj-card`).click();
  page.once('dialog', (d) => void d.accept());
  await page.getByTestId('hub-delete-picked').click();
  await expect(page.locator(`[data-project-id="${a}"]`)).toHaveCount(0);
  await expect(page.locator(`[data-project-id="${b}"]`)).toHaveCount(0);
  created.length = 0;
});
