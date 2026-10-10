/** P9: a project can be written from nothing in the editor — cast, scene, lines, a hand-made key — and played, with no AI involved. */
import { expect, test, type APIRequestContext } from '@playwright/test';
import { playing, settled } from './helpers/editor';
import { tab } from './helpers/ui';

test.setTimeout(240_000);

test('blank project: add a character, a scene and lines, put the person on stage, key an expression, save', async ({ page, request }: { page: import('@playwright/test').Page; request: APIRequestContext }) => {
  const errors: string[] = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await page.getByTestId('new-title').fill('从零开始');
  await page.getByTestId('btn-new').click();
  await expect(page.getByTestId('workspace')).toBeVisible();
  const id = /\/editor\/([^/]+)$/.exec(page.url())![1]!;
  try {
    // empty states say what to do, and the timeline shows nothing fake
    await expect(page.getByTestId('outline-empty')).toBeVisible();
    await expect(page.getByTestId('preview-empty')).toBeVisible();
    await tab(page, 'project');
    await expect(page.getByTestId('cast-empty')).toBeVisible();
    const options = await page.getByTestId('cast-pick').locator('option').evaluateAll((o) => o.map((x) => (x as HTMLOptionElement).value).filter(Boolean));
    expect(options.length).toBeGreaterThan(3);
    await page.getByTestId('cast-pick').selectOption(options[0]!);
    await page.getByTestId('cast-add').click();
    await expect(page.getByTestId('cast-name-c_001')).toBeVisible();

    await page.getByTestId('btn-add-scene').click();
    await expect(page.getByTestId('play-status')).toHaveText('就绪', { timeout: 180_000 });
    await expect.poll(async () => (await playing(page)).scenes.length, { timeout: 30_000 }).toBe(1);
    // the character was put on stage by default; type the line and give it a speaker
    await tab(page, 'beat');
    await page.getByTestId('insp-beat-text').fill('你好，这是我写的第一句。');
    await page.getByTestId('btn-add-beat-s_1').click();
    await expect.poll(async () => (await playing(page)).scenes[0]!.beats.length, { timeout: 30_000 }).toBe(2);
    await page.getByTestId('script-text').fill('第二句。');
    await expect.poll(async () => (await playing(page)).scenes[0]!.beats[1]!.text, { timeout: 30_000 }).toBe('第二句。');
    // the first line plays with its text
    const b1 = (await playing(page)).scenes[0]!.beats[0]!.id;
    const t = await page.evaluate((x) => window.__studio.player!.beatStarts()[x]!, b1);
    await page.evaluate((x) => window.__studio.player!.seek(x + 0.5), t);
    await expect.poll(() => page.evaluate(() => window.__studio.player!.state()?.subtitle?.text ?? ''), { timeout: 30_000 }).toContain('你好');

    // an expression key at the playhead from the actor tab
    await tab(page, 'actor');
    await expect(page.getByTestId('insp-actor')).toBeVisible();
    // the expression list fills in when the model has loaded
    const exprOptions = () => page.getByTestId('actor-expression').locator('option').evaluateAll((o) => o.map((x) => (x as HTMLOptionElement).value).filter(Boolean));
    await expect.poll(async () => (await exprOptions()).length, { timeout: 60_000 }).toBeGreaterThan(2);
    const expr = await exprOptions();
    await settled(page);
    // the choice can land while the player is still rebuilding after the previous edit: choose again (a different value, so it is a change) until the key exists
    let pick = 1;
    await expect(async () => {
      await settled(page);
      await page.getByTestId('actor-expression').selectOption(expr[pick++ % expr.length]!);
      expect((await playing(page)).scenes[0]!.tracks.some((tr) => tr.channel === 'expression')).toBe(true);
    }).toPass({ timeout: 60_000, intervals: [500, 1000, 2000] });

    await page.getByTestId('btn-save').click();
    await expect(page.getByTestId('save-state')).toHaveText('已保存');
    await page.reload();
    await expect(page.getByTestId('play-status')).toHaveText('就绪', { timeout: 180_000 });
    const back = await playing(page);
    expect(back.cast).toHaveLength(1);
    expect(back.scenes[0]!.beats).toHaveLength(2);
    expect(back.scenes[0]!.tracks.some((tr) => tr.channel === 'expression')).toBe(true);
    expect(errors.filter((e) => !/Failed to load resource/.test(e))).toEqual([]);
  } finally {
    await request.delete(`/api/projects/${id}`);
  }
});
