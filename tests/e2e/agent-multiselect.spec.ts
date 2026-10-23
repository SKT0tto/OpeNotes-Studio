/**
 * The assistant as its own dock next to the script list, and the beat multi-selection that feeds it. The model is never called:
 * /api/agent/turn is answered by Playwright and the request body is inspected.
 */
import { expect, test, type Page } from '@playwright/test';
import { openDemoEditor } from './helpers/editor';

test.describe.configure({ mode: 'serial' });
test.setTimeout(300_000);

let page: Page;
let projectId = '';
const errors: string[] = [];
type Sent = { selection?: { beatId?: string; beatIds?: string[] } };
const beat = (id: string) => page.getByTestId(`outline-beat-${id}`);
const multi = (id: string) => beat(id).getAttribute('data-multi');
const done = 'event: proposal\ndata: ' + JSON.stringify({
  genId: 'agent_ms', summary: '好。', applied: [], pending: [], question: null, unverified: [], claimedWithoutOps: null, stopped: 'done', model: 'mock',
  usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 },
}) + '\n\nevent: done\ndata: {}\n\n';
const mockTurn = async (into: { body: Sent }) => {
  await page.unroute('**/api/agent/turn').catch(() => {});
  await page.route('**/api/agent/turn', async (route) => {
    into.body = route.request().postDataJSON() as Sent;
    await route.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream' }, body: done });
  });
};
const ask = async (text: string) => {
  await page.getByTestId('agent-input').fill(text);
  await page.getByTestId('agent-input').press('Enter');
};

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(e.message));
  projectId = await openDemoEditor(page, 'Agent 多选');
});
test.afterAll(async ({ request }) => {
  await page.close();
  await request.delete(`/api/projects/${projectId}`);
  expect(errors.filter((e) => !/favicon|Failed to load resource/.test(e))).toEqual([]);
});

test('the assistant opens in its own dock; the script list stays visible', async () => {
  await page.locator('body').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('Control+k');
  await expect(page.getByTestId('agent-dock')).toBeVisible();
  await expect(page.getByTestId('outline')).toBeVisible();
  await expect(page.getByTestId('agent-input')).toBeFocused();
  const [list, dock] = await Promise.all([page.getByTestId('left-panel').boundingBox(), page.getByTestId('agent-dock').boundingBox()]);
  expect(list!.x + list!.width).toBeLessThanOrEqual(dock!.x);
  // the close button collapses it, the top-bar button opens it again; the state is remembered
  await page.getByTestId('agent-close').click();
  await expect(page.getByTestId('agent-dock')).toHaveCount(0);
  await page.getByTestId('btn-agent').click();
  await expect(page.getByTestId('agent-dock')).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('studio.agent.open'))).toBe('1');
});

test('Ctrl+click toggles and Shift+click selects a range; the panel shows the context and the request carries the beatIds', async () => {
  await beat('s1b1').click();
  await expect(page.getByTestId('agent-context')).toHaveText('选区：第1场 · 第1句');
  await beat('s1b3').click({ modifiers: ['Control'] });
  await expect(page.getByTestId('agent-context')).toContainText('已选 2 句（第1、3句）');
  expect(await multi('s1b1')).toBe('true');
  expect(await multi('s1b2')).toBeNull();
  expect(await multi('s1b3')).toBe('true');
  await expect(page.getByTestId('insp-multi')).toContainText('已选 2 句');
  await beat('s1b5').click({ modifiers: ['Shift'] }); // from the last clicked beat (3) to 5
  await expect(page.getByTestId('agent-context')).toContainText('第1场 · 已选 3 句（第3–5句）');
  for (const id of ['s1b3', 's1b4', 's1b5']) expect(await multi(id)).toBe('true');
  expect(await multi('s1b1')).toBeNull();
  const sent = { body: {} as Sent };
  await mockTurn(sent);
  await ask('这几句镜头推近一点');
  await expect.poll(() => sent.body.selection?.beatIds).toEqual(['s1b3', 's1b4', 's1b5']);
  expect(sent.body.selection?.beatId).toBe('s1b5');
  await expect(page.getByTestId('agent-card')).toBeVisible();
  // Ctrl+click removes a beat again
  await beat('s1b4').click({ modifiers: ['Control'] });
  await expect(page.getByTestId('agent-context')).toContainText('已选 2 句（第3、5句）');
});

test('the storyboard shares the selection; Esc clears it; a single selection sends no beatIds', async () => {
  await beat('s1b3').click();
  await beat('s1b5').click({ modifiers: ['Control'] });
  await page.getByTestId('view-storyboard').click();
  await expect(page.getByTestId('storyboard')).toBeVisible();
  await expect(page.getByTestId('sb-status')).toHaveText('缩略图已就绪', { timeout: 120_000 }); // generating thumbnails starves headless input
  await page.getByTestId('sb-card-s1b2').click({ modifiers: ['Control'] });
  await expect(page.getByTestId('agent-context')).toContainText('已选 3 句（第2–3、5句）');
  await page.getByTestId('view-preview').click();
  expect(await multi('s1b2')).toBe('true');
  await page.locator('body').click({ position: { x: 5, y: 5 } }); // the page needs the keyboard focus (headless)
  await page.keyboard.press('Escape');
  for (const id of ['s1b2', 's1b3', 's1b5']) await expect(beat(id)).not.toHaveAttribute('data-multi', 'true');
  await expect(page.getByTestId('agent-context')).not.toContainText('已选');
  await expect(page.getByTestId('insp-multi')).toHaveCount(0);
  const sent = { body: {} as Sent };
  await mockTurn(sent);
  await beat('s1b2').click();
  await ask('这一句看镜头');
  await expect.poll(() => sent.body.selection?.beatId).toBe('s1b2');
  expect(sent.body.selection?.beatIds).toBeUndefined();
  await page.unroute('**/api/agent/turn');
});

test('layout: the list, the stage and the assistant fit at 1280x720 and 1920x1080', async () => {
  for (const [w, h, stageMin] of [[1280, 720, 400], [1920, 1080, 520]] as const) {
    await page.setViewportSize({ width: w, height: h });
    await page.waitForTimeout(400);
    const m = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, sh: document.documentElement.scrollHeight, ch: document.documentElement.clientHeight }));
    expect(m.sw).toBeLessThanOrEqual(m.cw);
    expect(m.sh).toBeLessThanOrEqual(m.ch);
    const box = async (id: string) => (await page.getByTestId(id).boundingBox())!;
    const [left, dock, center] = [await box('left-panel'), await box('agent-dock'), (await page.locator('.ws-center').boundingBox())!];
    await expect(page.getByTestId('outline')).toBeVisible();
    await expect(page.getByTestId('agent-input')).toBeVisible();
    expect(center.width).toBeGreaterThanOrEqual(stageMin);
    expect(dock.x + dock.width).toBeLessThanOrEqual(w + 0.5);
    expect(left.x + left.width).toBeLessThanOrEqual(dock.x);
    await expect(page.getByTestId('right-panel')).toBeVisible();
  }
  // a narrow window: the inspector steps aside, the stage stays usable
  await page.setViewportSize({ width: 1000, height: 700 });
  await page.waitForTimeout(400);
  const narrow = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, stage: document.querySelector('.ws-center')!.getBoundingClientRect().width }));
  expect(narrow.sw).toBeLessThanOrEqual(narrow.cw);
  expect(narrow.stage).toBeGreaterThanOrEqual(380);
  await page.setViewportSize({ width: 1440, height: 900 });
});
