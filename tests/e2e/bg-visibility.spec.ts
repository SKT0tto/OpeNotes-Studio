/**
 * A background change at a mid-scene line keeps the people on screen, made by hand (timeline 背景 lane) in classic and in travel, and made by
 * the AI assistant (a recorded bg_set op, the model is never called). Only an explicit empty shot (purpose insert) hides them.
 */
import { expect, test, type Page } from '@playwright/test';
import { beatStart, openDemoEditor, playing, seekTo, settled, stateOf } from './helpers/editor';

test.describe.configure({ mode: 'serial' });
test.setTimeout(300_000);

let page: Page;
let projectId = '';
const errors: string[] = [];
const PPS = 60;
let picked = '';

const midOf = async (id: string) => {
  const p = await playing(page);
  const beats = p.scenes[0]!.beats;
  const i = beats.findIndex((b) => b.id === id);
  const a = await beatStart(page, id);
  const b = i + 1 < beats.length ? await beatStart(page, beats[i + 1]!.id) : a + 2;
  return (a + b) / 2;
};
/** Cast ids the viewer sees at time t (presence x opacity x shot visibility, as rendered). */
const visibleAt = async (t: number) => {
  await seekTo(page, t);
  return (await stateOf(page)).actors.filter((a) => a.opacity > 0.5).map((a) => a.castId).sort();
};
type K = { at: { beatId: string }; value: { assetId: string; purpose: string } };
const bgKeys = async () => ((await playing(page)).scenes[0]!.tracks.find((t) => t.channel === 'background')?.keys ?? []) as unknown as K[];
const travel = () => page.getByTestId('cam-system-travel');
const classic = () => page.getByTestId('cam-system-classic');
/** Switch the project to travel (closing the one-time notice) or back to classic. */
const toTravel = async () => {
  await travel().click();
  await expect(travel()).toHaveAttribute('aria-checked', 'true');
  const notice = page.getByTestId('camera-travel-notice-dismiss');
  if (await notice.isVisible().catch(() => false)) await notice.click();
  await settled(page);
};
const toClassic = async () => {
  await classic().click();
  await expect(classic()).toHaveAttribute('aria-checked', 'true');
  await settled(page);
};

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(e.message));
  projectId = await openDemoEditor(page, '换背景后人物可见');
});
test.afterAll(async ({ request }) => {
  await page.close();
  await request.delete(`/api/projects/${projectId}`);
  expect(errors.filter((e) => !/favicon|Failed to load resource/.test(e))).toEqual([]);
});

test('by hand: a switch at line 3 changes the picture and keeps the same people on screen, in classic and in travel', async () => {
  const t3 = await midOf('s1b3');
  const baseClassic = await visibleAt(t3);
  expect(baseClassic.length).toBeGreaterThan(0);
  await toTravel();
  const baseTravel = await visibleAt(t3);
  expect(baseTravel.length).toBeGreaterThan(0);
  await toClassic();

  const lane = page.getByTestId('tl-lane-bg').locator('.tl-lane');
  await lane.scrollIntoViewIfNeeded();
  const box = (await lane.boundingBox())!;
  await page.mouse.dblclick(box.x + ((await beatStart(page, 's1b3')) + 0.05) * PPS, box.y + box.height - 3);
  await expect(page.getByTestId('bg-picker')).toBeVisible();
  await page.getByTestId('picker-search').fill('夜 卧室');
  const card = page.getByTestId('picker-card').first();
  await expect(card).toBeVisible();
  picked = (await card.getAttribute('data-bg-id'))!;
  await card.click();
  await expect.poll(async () => (await bgKeys()).length, { timeout: 20_000 }).toBe(1);
  expect((await bgKeys())[0]!.value).toMatchObject({ assetId: picked, purpose: 'move' });
  await settled(page);

  const t3b = await midOf('s1b3');
  expect(await visibleAt(t3b)).toEqual(baseClassic);
  expect((await stateOf(page)).background.assetId).toBe(picked);
  await toTravel();
  expect(await visibleAt(t3b)).toEqual(baseTravel);
  expect((await stateOf(page)).background.assetId).toBe(picked);
  await toClassic();
});

test('by the assistant: an applied bg_set at line 5 (default purpose) keeps the people on screen', async () => {
  const t5 = await midOf('s1b5');
  const base = await visibleAt(t5);
  expect(base.length).toBeGreaterThan(0);
  const zero = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
  const op = { op: 'bg_set', sceneId: 's1', at: 's1b5', assetId: picked, transition: 'cut', reason: '测试：换到别处' };
  const record = { id: 1, tool: 'set_background', op, status: 'ok', changes: [{ scope: 'background', where: '第5句', field: '背景切换', before: '无', after: picked, beatId: 's1b5' }], warnings: [], notes: [], violations: [], overwrote: [], skipped: [] };
  const proposal = { genId: 'agent_e2e_bg', summary: '第5句换了背景，人物都还在画面上。', applied: [record], pending: [], question: null, unverified: [], claimedWithoutOps: null, usage: zero, regenUsage: zero, steps: 2, mode: 'tools', stats: {}, stopped: 'done', elapsedMs: 500, trace: [] };
  const ev = (n: string, d: unknown) => `event: ${n}\ndata: ${JSON.stringify(d)}\n\n`;
  await page.route('**/api/agent/turn', (route) => route.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream' }, body: ev('proposal', proposal) + ev('done', {}) }));
  await page.locator('body').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('Control+k');
  await expect(page.getByTestId('agent-panel')).toBeVisible();
  await page.getByTestId('agent-input').fill('第五句换个背景');
  await page.getByTestId('agent-input').press('Enter');
  await expect(page.getByTestId('agent-card')).toBeVisible();
  await page.getByTestId('agent-card').last().getByTestId('agent-apply-all').click();
  await expect.poll(async () => (await bgKeys()).some((k) => k.at.beatId === 's1b5' && k.value.assetId === picked && k.value.purpose === 'move'), { timeout: 20_000 }).toBe(true);
  await settled(page);
  const t5b = await midOf('s1b5');
  expect(await visibleAt(t5b)).toEqual(base);
  expect((await stateOf(page)).background.assetId).toBe(picked);
});
