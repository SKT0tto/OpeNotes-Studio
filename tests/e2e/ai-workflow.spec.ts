/**
 * P11-P13 in a real browser against the test-mode servers (5373 / 5374): the settings dialog (no key, provider switch,
 * failed connection test), breakdown from a story, scene direction replayed from recorded model output, playback, locks and
 * partial regeneration. The recorded-response provider exists only because the server runs with NODE_ENV=test.
 */
import fs from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { playing, seekTo, settled } from './helpers/editor';
import { aiPop, openAi, tab } from './helpers/ui';

test.use({ baseURL: 'http://127.0.0.1:5373' });
test.describe.configure({ mode: 'serial' });
test.setTimeout(300_000);

const STORY = fs.readFileSync('tests/fixtures/story-short.txt', 'utf8');
let page: Page;
let projectId = '';
const errors: string[] = [];

test.beforeAll(async ({ browser, request }) => {
  await request.put('/api/llm/settings', { data: { provider: 'fixture' } });
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(e.message));
});
test.afterAll(async ({ request }) => {
  await page.close();
  if (projectId) await request.delete(`/api/projects/${projectId}`);
  await request.put('/api/llm/settings', { data: { provider: 'fixture' } });
});

const toast = () => page.getByTestId('toast');
const project = () => playing(page);

test('P11: settings dialog: no key shows the guidance, switching provider works, a failed test explains why', async () => {
  await page.goto('/');
  await page.getByTestId('btn-settings').click();
  await expect(page.getByTestId('settings-dialog')).toBeVisible();
  // the test server offers the replay provider, clearly labelled as not AI
  await expect(page.getByTestId('llm-status')).toContainText('非真实 AI');
  await expect(page.getByTestId('llm-provider').locator('option')).toHaveText(['Claude（Anthropic）', 'OpenAI 兼容（LM Studio / DeepSeek …）', '测试回放（非 AI）']);
  await page.getByTestId('llm-provider').selectOption('anthropic');
  await expect(page.getByTestId('anthropic-key-state')).toHaveText('未配置');
  await page.getByTestId('btn-test-llm').click();
  await expect(page.getByTestId('test-result')).toContainText('连接失败：未配置 AI：Anthropic 缺少 API key');
  await expect(page.getByTestId('llm-status')).toContainText('未配置 AI');
  await page.screenshot({ path: '.verify/p11-e2e-nokey.png' });
  // an OpenAI-compatible address that nobody listens on: a clear reason, not an endless spinner
  await page.getByTestId('llm-provider').selectOption('openai');
  await page.getByTestId('openai-base').fill('http://127.0.0.1:1/v1');
  await page.getByTestId('openai-model').fill('local-model');
  const t0 = Date.now();
  await page.getByTestId('btn-test-llm').click();
  await expect(page.getByTestId('test-result')).toContainText('连接失败：无法连接到 http://127.0.0.1:1/v1');
  expect(Date.now() - t0).toBeLessThan(15_000);
  // the AI entry says what is missing while nothing is configured
  await page.getByTestId('llm-provider').selectOption('anthropic');
  await page.getByTestId('btn-save-llm').click();
  await page.getByTestId('btn-ai-breakdown').click();
  await expect(page.getByTestId('ai-status')).toContainText('未配置');
  await expect(page.getByTestId('ai-breakdown')).toBeDisabled();
  await page.screenshot({ path: '.verify/p12-e2e-ai-unconfigured.png' });
  await page.keyboard.press('Escape');
  // back to the replay provider
  await page.getByTestId('btn-settings').click();
  await page.getByTestId('llm-provider').selectOption('fixture');
  await page.getByTestId('btn-save-llm').click();
  await expect(page.getByTestId('settings-dialog')).toBeHidden();
});

test('P12: breakdown of the story: scenes, locations with reasons, outfits with reasons; a second run is a cache hit', async () => {
  await page.getByTestId('btn-ai-breakdown').click();
  await expect(page.getByTestId('ai-status')).toContainText('非真实 AI');
  await page.getByTestId('ai-title').fill('AI 工作流 e2e');
  await page.getByTestId('ai-source').fill(STORY);
  await page.getByTestId('ai-breakdown').click();
  await expect(page.getByTestId('breakdown-view')).toBeVisible();
  await expect(page.getByTestId('bd-scene')).toHaveCount(4);
  const first = page.getByTestId('bd-scene').first();
  await expect(first).toContainText('背景：');
  await expect(first).toContainText('（'); // the reason is shown next to the location
  await expect(page.getByTestId('bd-scene').nth(3)).toContainText('夜间');
  await page.screenshot({ path: '.verify/p12-breakdown.png' });
  // re-run: served from the cache (marked, and fast)
  await page.getByTestId('ai-rebreak').click();
  await expect(page.getByTestId('breakdown-view')).toBeVisible();
  await page.getByTestId('ai-edit-source').click(); // back to the text (it is on the left, still editable)
  await expect(page.getByTestId('ai-source')).toBeFocused();
  const t0 = Date.now();
  await page.getByTestId('ai-breakdown').click();
  await expect(page.getByTestId('ai-cached')).toBeVisible();
  expect(Date.now() - t0).toBeLessThan(2000);
  await page.getByTestId('ai-create').click();
  await expect(page.getByTestId('workspace')).toBeVisible();
  await expect(page.getByTestId('play-status')).toHaveText('就绪', { timeout: 240_000 });
  projectId = /\/editor\/([^/]+)$/.exec(page.url())![1]!;
  const p = await project();
  expect(p.scenes.length).toBe(4);
  expect(p.source.text).toBe(STORY);
});

test('P13: generate the performance of all scenes from the recorded output; it plays; units are not labelled AI', async () => {
  await openAi(page, { target: 'all' });
  await page.getByTestId('ai-preview').uncheck(); // these tests apply directly; the diff / accept flow has its own test below
  await expect(page.getByTestId('ai-status')).toContainText('非真实 AI');
  const before = await project();
  await page.getByTestId('ai-gen-all').click();
  await expect(page.getByTestId('ai-result')).toHaveCount(4, { timeout: 60_000 });
  await expect(page.getByTestId('ai-progress').locator('[data-state=done]')).toHaveCount(4);
  await settled(page);
  const p = await project();
  const beats = p.scenes.flatMap((s) => s.beats).length;
  expect(beats).toBeGreaterThan(before.scenes.flatMap((s) => s.beats).length);
  expect(beats).toBeGreaterThan(45);
  expect(p.scenes.every((s) => s.tracks.length > 3)).toBe(true);
  // replayed output is a rule-stamped decision, never "AI"
  expect(JSON.stringify(p)).not.toContain('"source":"ai"');
  // every resource id in the generated project exists in the library
  const cat = (await (await page.request.get('/api/catalog')).json()) as { models: Array<{ id: string }>; backgrounds: Array<{ id: string }> };
  const ids = new Set(cat.models.map((m) => m.id));
  for (const s of p.scenes) {
    expect(cat.backgrounds.some((b) => b.id === s.background.assetId)).toBe(true);
    for (const w of Object.values(s.wardrobe)) expect(ids.has(w.modelId)).toBe(true);
  }
  await expect(toast()).toContainText('Ctrl+Z 可撤销');
  // listeners look at speakers, expressions exist, the whole thing plays for 10 s without errors
  const café = p.scenes[2]!;
  expect(café.tracks.some((t) => t.channel === 'gaze' && t.keys.length > 5)).toBe(true);
  expect(café.tracks.some((t) => t.channel === 'expression')).toBe(true);
  await page.getByTestId('outline-beat-' + café.beats[3]!.id).click().catch(() => {});
  await seekTo(page, 40);
  await page.evaluate(() => window.__studio.player!.play());
  await page.waitForTimeout(10_000);
  await page.evaluate(() => window.__studio.player!.pause());
  const st = await page.evaluate(() => window.__studio.player!.state());
  expect(st!.actors.length).toBeGreaterThan(0);
  await page.screenshot({ path: '.verify/p13-generated.png' });
  // one undo step brings the whole run back
  await page.getByTestId('btn-undo').click();
  await expect.poll(async () => (await project()).scenes.flatMap((s) => s.beats).length, { timeout: 60_000 }).toBe(before.scenes.flatMap((s) => s.beats).length);
  await page.getByTestId('btn-redo').click();
  await expect.poll(async () => (await project()).scenes.flatMap((s) => s.beats).length, { timeout: 60_000 }).toBe(beats);
});

test('P13: locks and edits survive "regenerate scene"; a camera-only rerun leaves performance, outfits and stage alone', async () => {
  const p0 = await project();
  const i = 1;
  const scene = p0.scenes[i]!;
  const dlg = scene.beats.filter((b) => b.kind === 'dialogue');
  const locked = dlg[0]!;
  const edited = dlg[1]!;
  // select the scene's first dialogue line, lock it (type lock) and the first actor's outfit
  await page.getByTestId('tab-script').click();
  await page.getByTestId(`outline-beat-${locked.id}`).click();
  await tab(page, 'beat');
  await page.getByTestId('insp-beat').locator('.row', { hasText: '类型' }).locator('button.lock').click();
  const castId = Object.keys(scene.wardrobe)[0]!;
  await tab(page, 'scene');
  await page.getByTestId('insp-cast-' + castId).locator('.row', { hasText: '服装' }).locator('button.lock').click();
  // edit another line by hand (its emotion) and its text
  await page.getByTestId(`outline-beat-${edited.id}`).click();
  await tab(page, 'beat');
  await page.getByTestId('insp-beat-text').fill('我自己改的台词。');
  await page.getByTestId('insp-beat-text').blur();
  await settled(page);
  const before = await project();
  const bs = before.scenes[i]!;
  expect(bs.beats.find((b) => b.id === locked.id)!.meta.locked).toBe(true);
  expect(bs.wardrobe[castId]!.meta.locked).toBe(true);

  // regenerate the whole scene
  await openAi(page);
  await page.getByTestId('ai-preview').uncheck(); // these tests apply directly; the diff / accept flow has its own test below
  await page.getByTestId('ai-scope').selectOption('scene');
  await page.getByTestId('ai-regen-scene').click();
  await expect(page.getByTestId('ai-result').last()).toBeVisible();
  await settled(page);
  const after = (await project()).scenes[i]!;
  expect(after.beats.find((b) => b.id === locked.id)).toEqual(bs.beats.find((b) => b.id === locked.id));
  expect(after.wardrobe[castId]).toEqual(bs.wardrobe[castId]);
  expect(after.beats.find((b) => b.id === edited.id)!.text).toBe('我自己改的台词。');
  await expect(page.getByTestId('ai-kept').last()).toBeVisible();
  await page.screenshot({ path: '.verify/p13-regen-locks.png' });

  // camera only: nothing but shots change
  const mid = (await project()).scenes[i]!;
  await aiPop(page);
  await page.getByTestId('ai-scope').selectOption('camera');
  await page.getByTestId('ai-regen-scene').click();
  await expect(page.getByTestId('toast')).toContainText('镜头');
  await settled(page);
  const cam = (await project()).scenes[i]!;
  expect(JSON.stringify(cam.tracks)).toBe(JSON.stringify(mid.tracks));
  expect(JSON.stringify(cam.wardrobe)).toBe(JSON.stringify(mid.wardrobe));
  expect(JSON.stringify(cam.blocking)).toBe(JSON.stringify(mid.blocking));
  expect(cam.beats.map((b) => [b.id, b.text, b.emotion])).toEqual(mid.beats.map((b) => [b.id, b.text, b.emotion]));
  expect(cam.beats.find((b) => b.id === locked.id)).toEqual(mid.beats.find((b) => b.id === locked.id));
  // the whole run is one undo step
  await page.getByTestId('btn-undo').click();
  await settled(page);
  expect(JSON.stringify((await project()).scenes[i])).toBe(JSON.stringify(mid));
});

test('P13: a field lock keeps one field (the text) while "overwrite my edits" regenerates the rest', async () => {
  const i = 1;
  const p0 = await project();
  const dlg = p0.scenes[i]!.beats.filter((b) => b.kind === 'dialogue');
  const keep = dlg[2]!;
  const redo = dlg[1]!; // hand-edited in the previous test: replaced when overwriting user edits
  expect(redo.text).toBe('我自己改的台词。');
  await page.getByTestId('tab-script').click();
  await page.getByTestId(`outline-beat-${keep.id}`).click();
  await tab(page, 'beat');
  await page.getByTestId('insp-beat-text').fill('只锁文字的台词。');
  await page.getByTestId('insp-beat-text').blur();
  await page.getByTestId('fieldlock-text').click();
  await expect(page.getByTestId('fieldlock-text')).toHaveAttribute('aria-pressed', 'true');
  // the gate refuses edits of the locked field only
  await page.getByTestId('insp-beat-text').fill('不该写入');
  await expect(page.getByTestId('toast')).toContainText('文本');
  await expect(page.getByTestId('insp-beat-text')).toHaveValue('只锁文字的台词。');
  await page.getByTestId('insp-beat-emotion').selectOption('angry'); // another field of the same line is free
  await settled(page);
  await openAi(page);
  await page.getByTestId('ai-preview').uncheck(); // these tests apply directly; the diff / accept flow has its own test below
  await page.getByTestId('ai-scope').selectOption('scene');
  await page.getByTestId('ai-overwrite').check();
  await page.getByTestId('ai-regen-scene').click();
  await expect(page.getByTestId('toast')).toContainText('生成：');
  await settled(page);
  const after = (await project()).scenes[i]!;
  const k = after.beats.find((b) => b.id === keep.id)!;
  expect(k.text).toBe('只锁文字的台词。');
  expect(k.meta.lockedFields).toEqual(['text']);
  expect(k.emotion).not.toBe('angry'); // not locked: regenerated
  expect(after.beats.find((b) => b.id === redo.id)!.text).not.toBe('我自己改的台词。'); // overwriteUser replaced it
  await aiPop(page);
  await page.getByTestId('ai-overwrite').uncheck();
  await page.screenshot({ path: '.verify/p13-field-lock.png' });
});

test('P14: a proposal is a diff first: nothing changes until accepted; reject keeps the project; accept is one undo step; the rule engine is labelled as rule', async () => {
  const i = 1;
  const p0 = await project();
  const b0 = p0.scenes[i]!.beats.filter((b) => b.kind === 'dialogue')[2]!;
  await page.getByTestId('tab-script').click();
  await page.getByTestId(`outline-beat-${b0.id}`).click();
  await tab(page, 'shot');
  await page.getByTestId('insp-shot-type').selectOption('ecu');
  await settled(page);
  const edited = JSON.stringify((await project()).scenes[i]);
  await openAi(page);
  await page.getByTestId('ai-preview').check(); // the options are kept while the panel is hidden: the earlier tests switched the preview off
  await page.getByTestId('ai-scope').selectOption('camera');
  await page.getByTestId('ai-overwrite').check();
  await page.getByTestId('ai-regen-scene').click();
  await expect(page.getByTestId('ai-result').last()).toHaveAttribute('data-state', 'pending');
  await expect(page.getByTestId('ai-diff-camera')).toBeVisible();
  await page.getByTestId('ai-diff-camera').locator('summary').click();
  await expect(page.getByTestId('ai-diff-camera')).toContainText('大特写');
  // the proposal changes nothing by itself, and no other scope is offered
  expect(JSON.stringify((await project()).scenes[i])).toBe(edited);
  await expect(page.getByTestId('ai-diff-performance')).toHaveCount(0);
  await page.getByTestId('ai-reject').click();
  await expect(page.getByTestId('ai-result').last()).toHaveAttribute('data-state', 'rejected');
  expect(JSON.stringify((await project()).scenes[i])).toBe(edited);
  // again, accept: applied through the lock-enforcing merge, as ONE undo step
  await aiPop(page);
  await page.getByTestId('ai-regen-scene').click();
  await expect(page.getByTestId('ai-accept-all')).toBeVisible();
  await page.getByTestId('ai-accept-all').click();
  await expect(page.getByTestId('ai-result').last()).toHaveAttribute('data-state', 'accepted');
  await settled(page);
  const after = (await project()).scenes[i]!;
  expect(after.beats.find((b) => b.id === b0.id)!.shot.type).not.toBe('ecu');
  await page.getByTestId('btn-undo').click();
  await settled(page);
  expect(JSON.stringify((await project()).scenes[i])).toBe(edited);
  await aiPop(page);
  await page.getByTestId('ai-overwrite').uncheck();

  // the rule director: explicit, labelled "规则（非 AI）", works without any model
  await page.getByTestId('ai-engine').selectOption('rule');
  await expect(page.getByTestId('ai-rule-hint')).toContainText('不是 AI');
  await page.getByTestId('ai-scope').selectOption('camera');
  await page.getByTestId('ai-regen-scene').click();
  await expect(page.getByTestId('ai-origin').last()).toHaveText('规则');
  await expect(page.getByTestId('ai-rule-note')).toContainText('规则生成（非 AI）');
  await page.screenshot({ path: '.verify/p14-diff-rule.png' });
  await page.getByTestId('ai-reject').click();
  await aiPop(page);
  await page.getByTestId('ai-engine').selectOption('ai');
  await page.getByTestId('ai-menu').click(); // ⋯ → the continuity check of the whole project
  await page.getByTestId('ai-continuity-toggle').click();
  await expect(page.getByTestId('ai-continuity')).toBeVisible();
});

test('M1: a result whose lines differ from the scene can still be accepted for chosen scopes only (lines stay as they are)', async () => {
  const i = 1;
  await page.getByTestId('tab-script').click();
  const before = (await project()).scenes[i]!;
  const gone = before.beats[1]!;
  await page.getByTestId(`outline-beat-${before.beats[3]!.id}`).click();
  await tab(page, 'shot');
  await page.getByTestId('insp-shot-type').selectOption('ecu'); // a camera difference the proposal will want to undo
  await settled(page);
  await page.getByTestId(`outline-beat-${gone.id}`).click();
  await page.getByTestId('script-del-beat').first().click();
  await settled(page);
  const cut = (await project()).scenes[i]!;
  expect(cut.beats[2]!.shot.type).toBe('ecu');
  expect(cut.beats.length).toBe(before.beats.length - 1);
  await openAi(page);
  await page.getByTestId('ai-scope').selectOption('scene');
  await page.getByTestId('ai-overwrite').check();
  await page.getByTestId('ai-regen-scene').click();
  await expect(page.getByTestId('ai-result').last()).toHaveAttribute('data-state', 'pending');
  await expect(page.getByTestId('ai-diff-structure')).toBeVisible();
  await expect(page.getByTestId('ai-check-structure')).toBeDisabled();
  await expect(page.getByTestId('ai-check-camera')).toBeEnabled();
  for (const s of ['performance', 'costume', 'staging', 'fx']) {
    const c = page.getByTestId(`ai-check-${s}`);
    if (await c.count()) await c.uncheck();
  }
  await expect(page.getByTestId('ai-check-camera')).toBeChecked();
  await page.getByTestId('ai-accept-sel').click();
  await expect(page.getByTestId('ai-result').last()).toHaveAttribute('data-state', 'accepted');
  await settled(page);
  const after = (await project()).scenes[i]!;
  expect(after.beats.map((b) => b.text)).toEqual(cut.beats.map((b) => b.text)); // the line list is untouched
  expect(after.beats[2]!.shot.type).not.toBe('ecu'); // ... while the chosen scope (camera) was applied
  await page.getByTestId('btn-undo').click();
  await settled(page);
  expect(JSON.stringify((await project()).scenes[i])).toBe(JSON.stringify(cut));
  await aiPop(page);
  await page.getByTestId('ai-overwrite').uncheck();
});

test('P15: one click from an imported novel (rule engine, no key): project, all scenes, plays, continuity list', async () => {
  await page.goto('/');
  await page.getByTestId('btn-ai-breakdown').click();
  await page.getByTestId('ai-file').setInputFiles('examples/mygo-rehearsal.txt');
  await expect(page.getByTestId('ai-source-info')).toContainText('检测到 5 个章节标题');
  await page.getByTestId('ai-engine').selectOption('rule');
  await page.getByTestId('ai-full').click();
  await expect(page.getByTestId('full-done')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('full-stats')).toContainText('规则');
  await expect(page.getByTestId('full-stats')).toContainText('输入 0 / 输出 0');
  await page.screenshot({ path: '.verify/p15-e2e-full.png' });
  const id = (await page.getByTestId('full-view').getAttribute('data-project'))!;
  const p = (await (await page.request.get(`/api/projects/${id}`)).json()) as import('../../shared/schema/project').Project;
  try {
    expect(p.scenes.length).toBeGreaterThanOrEqual(5);
    expect(p.scenes.every((s) => s.beats.length > 3 && s.tracks.length > 0)).toBe(true);
    expect(JSON.stringify(p)).not.toContain('"source":"ai"');
    await page.getByTestId('full-edit').click();
    await expect(page.getByTestId('workspace')).toBeVisible();
    await expect(page.getByTestId('play-status')).toHaveText('就绪', { timeout: 180_000 });
    await page.evaluate(() => window.__studio.player!.play());
    await page.waitForTimeout(8_000);
    await page.evaluate(() => window.__studio.player!.pause());
  } finally {
    await page.request.delete(`/api/projects/${id}`);
  }
});

test('no console errors', () => {
  expect(errors.filter((e) => !/Failed to load resource/.test(e))).toEqual([]);
});

