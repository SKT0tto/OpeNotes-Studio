/**
 * The AI assistant (agentic mode) in a real browser. The model is never called: /api/agent/turn is answered by Playwright with a recorded
 * event stream (ops are real AgentOps for the demo project), so everything else is the real client: opening the panel with Ctrl+K, the change
 * card, applying part of it, one Ctrl+Z for the whole application, a locked item that asks first, and live mode applying only small changes.
 */
import { expect, test, type Page } from '@playwright/test';
import { openDemoEditor, playing, seekTo, beatStart, settled } from './helpers/editor';
import { tab } from './helpers/ui';

test.describe.configure({ mode: 'serial' });
test.setTimeout(300_000);

let page: Page;
let projectId = '';
const errors: string[] = [];

const rec = (id: number, op: Record<string, unknown>, change: { where: string; field: string; before: string; after: string; beatId: string }, extra: Record<string, unknown> = {}) => ({
  id, tool: 'set_shot', op, status: 'ok', changes: [{ scope: 'camera', ...change }], warnings: [], notes: [], violations: [], overwrote: [], skipped: [], ...extra,
});
const shotOp = (beatId: string, type: string) => ({ op: 'shot_set', sceneId: 's1', beatId, set: { type }, reason: '测试：情绪升高' });
const shotRec = (id: number, beatId: string, type: string, n: number, extra: Record<string, unknown> = {}) => rec(id, shotOp(beatId, type), { where: `第${n}句`, field: '镜头', before: '胸像·1人', after: `${type}·1人`, beatId }, extra);
const zeroUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };

/** The event stream of a finished turn. */
const stream = (p: { applied?: unknown[]; pending?: unknown[]; summary: string; question?: unknown; stopped?: string; verification?: unknown }) => {
  const proposal = {
    genId: 'agent_e2e', summary: p.summary, applied: p.applied ?? [], pending: p.pending ?? [], question: p.question ?? null, unverified: [], claimedWithoutOps: null,
    usage: { ...zeroUsage, inputTokens: 5200, outputTokens: 310 }, regenUsage: zeroUsage, steps: 3, mode: 'tools', stats: {}, stopped: p.stopped ?? 'done', elapsedMs: 900, trace: [], ...(p.verification ? { verification: p.verification } : {}),
  };
  const ev = (n: string, d: unknown) => `event: ${n}\ndata: ${JSON.stringify(d)}\n\n`;
  return ev('status', { type: 'status', text: '正在理解指令…' }) + ev('tool', { type: 'tool', name: 'get_beat', summary: 'get_beat beatId="s1b2"' })
    + ev('usage', { type: 'usage', usage: proposal.usage, total: proposal.usage }) + ev('proposal', proposal) + ev('done', {});
};
const mockTurn = async (body: string) => {
  await page.unroute('**/api/agent/turn').catch(() => {});
  await page.route('**/api/agent/turn', (route) => route.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream' }, body }));
};
const send = async (text: string) => {
  await page.getByTestId('agent-input').fill(text);
  await page.getByTestId('agent-input').press('Enter');
};
const shotTypes = async (ids: string[]) => {
  const p = await playing(page);
  return ids.map((id) => p.scenes[0]!.beats.find((b) => b.id === id)!.shot.type);
};
const undoTitle = () => page.getByTestId('btn-undo').getAttribute('title');

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(e.message));
  projectId = await openDemoEditor(page, 'Agent 面板');
});
test.afterAll(async ({ request }) => {
  await page.close();
  await request.delete(`/api/projects/${projectId}`);
  expect(errors.filter((e) => !/favicon|Failed to load resource/.test(e))).toEqual([]);
});

test('Ctrl+K opens the AI assistant panel and focuses the input; the context chip shows the selection', async () => {
  await page.locator('body').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('Control+k');
  await expect(page.getByTestId('agent-panel')).toBeVisible();
  await expect(page.getByTestId('btn-agent')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('outline')).toBeVisible(); // the script list stays visible next to the assistant
  await expect(page.getByTestId('agent-input')).toBeFocused();
  await expect(page.getByTestId('agent-context')).toContainText('第1场');
  await expect(page.getByTestId('agent-live')).not.toBeChecked(); // off by default
  // pressed again while typing it closes the panel; the open state is remembered
  await page.keyboard.press('Control+k');
  await expect(page.getByTestId('agent-panel')).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem('studio.agent.open'))).toBe('0');
  await page.keyboard.press('Control+k');
  await expect(page.getByTestId('agent-panel')).toBeVisible();
  await expect(page.getByTestId('agent-input')).toBeFocused();
  expect(await page.evaluate(() => localStorage.getItem('studio.agent.open'))).toBe('1');
});

test('an instruction produces a card; applying part of it is one undo step', async () => {
  const before = await shotTypes(['s1b1', 's1b2', 's1b5']);
  await mockTurn(stream({
    summary: '把前两句和第五句的镜头推近了一档。',
    applied: [shotRec(1, 's1b1', 'cu', 1), shotRec(2, 's1b2', 'cu', 2), shotRec(3, 's1b5', 'ecu', 5)],
  }));
  await send('这一段镜头都推近一点');
  await expect(page.getByTestId('agent-user')).toHaveText('这一段镜头都推近一点');
  const card = page.getByTestId('agent-card');
  await expect(card).toBeVisible();
  await expect(page.getByTestId('agent-card-title')).toContainText('第1场 · 3 项修改');
  await expect(page.getByTestId('agent-said')).toContainText('推近了一档');
  await expect(page.getByTestId('agent-row')).toHaveCount(3);
  await expect(page.getByTestId('agent-row').first()).toContainText('胸像·1人');
  await expect(page.getByTestId('agent-row').first()).toContainText('cu·1人');
  await expect(page.getByTestId('agent-cost')).toContainText('本条 5510');
  // nothing is applied before the user says so
  expect(await shotTypes(['s1b1', 's1b2', 's1b5'])).toEqual(before);
  // untick the last one, apply the selection
  await page.getByTestId('agent-row').nth(2).getByRole('checkbox').uncheck();
  await expect(page.getByTestId('agent-apply-sel')).toContainText('(2)');
  await page.getByTestId('agent-apply-sel').click();
  await expect(page.getByTestId('agent-applied')).toContainText('已应用 2 项');
  await expect.poll(() => shotTypes(['s1b1', 's1b2', 's1b5']), { timeout: 20_000 }).toEqual(['cu', 'cu', before[2]]);
  const p = await playing(page);
  expect(p.scenes[0]!.beats[0]!.shot.meta).toMatchObject({ source: 'ai', genId: 'agent_e2e' });
  expect(await undoTitle()).toContain('AI：这一段镜头都推近一点');
  // ONE Ctrl+Z undoes both
  await page.locator('body').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('Control+z');
  await expect.poll(() => shotTypes(['s1b1', 's1b2', 's1b5']), { timeout: 20_000 }).toEqual(before);
  await expect(page.getByTestId('btn-undo')).toBeDisabled();
});

test('a locked item asks first; 解锁并应用 opens the lock and applies in one step', async () => {
  await seekTo(page, (await beatStart(page, 's1b5')) + 0.3);
  await tab(page, 'shot');
  await page.locator('.ws-right button.lock').first().click(); // lock the shot of the selected line
  await expect.poll(async () => (await playing(page)).scenes[0]!.beats.find((b) => b.id === 's1b5')!.shot.meta.locked, { timeout: 20_000 }).toBe(true);
  const before = await shotTypes(['s1b1', 's1b5']);
  const pendingOp = shotOp('s1b5', 'ecu');
  await mockTurn(stream({
    summary: '第一句已推近；第五句的镜头被锁定，需要你确认。',
    applied: [shotRec(1, 's1b1', 'cu', 1)],
    pending: [rec(2, pendingOp, { where: '第5句', field: '镜头', before: '近景·1人', after: 'ecu·1人', beatId: 's1b5' }, { status: 'needs_unlock', violations: ['这句的镜头'] })],
  }));
  await page.keyboard.press('Control+k');
  await send('把第一句和第五句都推近');
  await expect(page.getByTestId('agent-pending')).toBeVisible();
  await expect(page.getByTestId('agent-pending')).toContainText('需要你确认');
  await expect(page.getByTestId('agent-pending')).toContainText('锁定');
  // "apply all" takes only the sure part
  await page.getByTestId('agent-card').last().getByTestId('agent-apply-all').click();
  await expect.poll(() => shotTypes(['s1b1', 's1b5']), { timeout: 20_000 }).toEqual(['cu', before[1]]);
  await expect(page.getByTestId('agent-pending')).toBeVisible();
  // the locked one: explicit unlock + apply
  await page.getByTestId('agent-unlock-apply').click();
  await expect.poll(() => shotTypes(['s1b1', 's1b5']), { timeout: 20_000 }).toEqual(['cu', 'ecu']);
  const b5 = (await playing(page)).scenes[0]!.beats.find((b) => b.id === 's1b5')!;
  expect(b5.shot.meta.locked).toBe(false);
  // that last application is a single step: one Ctrl+Z puts the lock and the old shot back
  await page.locator('body').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('Control+z');
  await expect.poll(async () => (await playing(page)).scenes[0]!.beats.find((b) => b.id === 's1b5')!.shot.meta.locked, { timeout: 20_000 }).toBe(true);
  expect((await shotTypes(['s1b5']))[0]).toBe(before[1]);
});

test('live mode applies only small changes of the current scene by itself', async () => {
  await page.keyboard.press('Control+k');
  await page.getByTestId('agent-live').check();
  await expect(page.getByTestId('agent-live')).toBeChecked();
  await seekTo(page, (await beatStart(page, 's1b2')) + 0.3);
  const before = await shotTypes(['s1b2']);
  await mockTurn(stream({ summary: '第二句推近。', applied: [shotRec(1, 's1b2', 'ecu', 2)] }));
  await send('第二句推近');
  await expect(page.getByTestId('toast')).toContainText('已应用 1 项');
  await expect.poll(() => shotTypes(['s1b2']), { timeout: 20_000 }).toEqual(['ecu']);
  expect(before).not.toEqual(['ecu']);
  // the toast has an undo button
  await page.getByTestId('toast-action').click();
  await expect.poll(() => shotTypes(['s1b2']), { timeout: 20_000 }).toEqual(before);
  // an entrance is not small: the card is shown instead, nothing applied
  const enter = { op: 'stage_set', sceneId: 's1', castId: 'c_002', enter: { beatId: 's1b3', side: 'left' }, reason: '进场' };
  await mockTurn(stream({
    summary: '让爱音在第三句进场。',
    applied: [rec(1, enter, { where: '第3句', field: '进场（千早爱音）', before: '第1句进场', after: '第3句进场（左侧）', beatId: 's1b3' }, { tool: 'set_entrance' })],
  }));
  await send('让爱音在这里进场');
  await expect(page.getByTestId('agent-live-note').last()).toContainText('不满足实时条件');
  await expect(page.getByTestId('agent-live-note').last()).toContainText('进出场');
  const p = await playing(page);
  expect(p.scenes[0]!.blocking.c_002!.enter!.beatId).toBe('s1b1');
  // more than 6 ops is not small either
  const many = ['s1b1', 's1b2', 's1b3', 's1b4', 's1b5', 's1b7'].map((id, i) => shotRec(i + 1, id, 'ecu', i + 1)).concat(shotRec(9, 's1b2', 'cu', 2));
  await mockTurn(stream({ summary: '全部推近。', applied: many }));
  await send('整场推近');
  await expect(page.getByTestId('agent-live-note').last()).toContainText('超过 6 项');
  await page.getByTestId('agent-live').uncheck();
  await settled(page);
});

test('hovering a card row only highlights its beat; clicking it selects (and live instructions use the selection the user made)', async () => {
  await page.keyboard.press('Control+k');
  await seekTo(page, (await beatStart(page, 's1b1')) + 0.2);
  await expect(page.getByTestId('agent-context')).toContainText('第1句');
  const mine = (await page.getByTestId('agent-context').textContent()) ?? '';
  await mockTurn(stream({ summary: '第五句推近。', applied: [shotRec(1, 's1b5', 'ecu', 5)] }));
  await send('第五句推近');
  const row = page.getByTestId('agent-row').last();
  await expect(row).toBeVisible();
  await row.hover();
  await expect(page.getByTestId('agent-panel')).toHaveAttribute('data-hover-beat', 's1b5');
  await page.waitForTimeout(500);
  await expect(page.getByTestId('agent-context')).toHaveText(mine); // the selection did not move
  await page.mouse.move(5, 5);
  await expect(page.getByTestId('agent-panel')).not.toHaveAttribute('data-hover-beat', /.+/);
  // a live-style instruction sent while hovering still carries the selection the user made
  let sent: { selection?: { beatId?: string } } = {};
  await page.unroute('**/api/agent/turn').catch(() => {});
  await page.route('**/api/agent/turn', async (route) => {
    sent = route.request().postDataJSON() as typeof sent;
    await route.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream' }, body: stream({ summary: '好。' }) });
  });
  await row.hover();
  await send('她看镜头');
  await expect.poll(() => sent.selection?.beatId).toBe('s1b1');
  // clicking selects
  await row.click({ position: { x: 60, y: 8 } });
  await expect(page.getByTestId('agent-context')).toContainText('第5句');
});

test('a failed turn shows the reason; a clarifying question offers options', async () => {
  await page.unroute('**/api/agent/turn').catch(() => {});
  await page.route('**/api/agent/turn', (route) => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { kind: 'not_configured', message: '未配置 AI' } }) }));
  await send('随便');
  await expect(page.getByTestId('agent-error').last()).toContainText('需要 AI 模型');
  await mockTurn(stream({ summary: '灯有两句，是哪一句？', question: { question: '灯有两句，是哪一句？', options: ['第1句', '第2句'] } }));
  await send('灯那句加回忆');
  await expect(page.getByTestId('agent-question')).toContainText('灯有两句');
  await expect(page.getByTestId('agent-option')).toHaveCount(2);
});

test('the card says the picture edits were checked against screenshots; thumbnails enlarge on click', async () => {
  const px = 'data:image/svg+xml;utf8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="160" height="90"><rect width="160" height="90" fill="#8a6"/></svg>');
  await mockTurn(stream({
    summary: '第二句推近成了近景，截图核对过。',
    applied: [shotRec(1, 's1b2', 'cu', 2)],
    verification: { status: 'verified', forced: 1, frames: [{ label: '第1场第2句（中间）', dataUrl: px }, { label: '第1场第2句（后段）', dataUrl: px }] },
  }));
  await send('第二句推近一点');
  const v = page.getByTestId('agent-verify').last();
  await expect(v).toContainText('已截图核对 ✓');
  await expect(v.getByTestId('agent-thumb')).toHaveCount(2);
  await v.getByTestId('agent-thumb').first().click();
  await expect(page.getByTestId('agent-lightbox')).toBeVisible();
  await expect(page.getByTestId('agent-lightbox')).toContainText('第1场第2句（中间）');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('agent-lightbox')).toHaveCount(0);
  // vision unavailable: an honest line, no thumbnails
  await mockTurn(stream({ summary: '推近了。', applied: [shotRec(1, 's1b3', 'cu', 3)], verification: { status: 'unavailable', forced: 0, frames: [] } }));
  await send('第三句推近一点');
  await expect(page.getByTestId('agent-verify').last()).toContainText('无法看图，未核对');
  await expect(page.getByTestId('agent-verify').last().getByTestId('agent-thumb')).toHaveCount(0);
});
