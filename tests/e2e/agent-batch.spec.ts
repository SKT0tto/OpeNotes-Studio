/**
 * The AI assistant's batch and script cards in a real browser. The model is never called: /api/agent/turn is answered by Playwright with a
 * recorded event stream whose ops are real AgentOps for the demo project (as in agent.spec.ts). What is checked is the card: a batch of many
 * edits is ONE collapsed line ("把 N 句的景别改成 cu") that expands into per-beat rows, locked members wait under 「需要你确认」 as a group,
 * a script group carries its source in a collapsible 「AI 写的脚本」, and applying either is one undo step.
 */
import { expect, test, type Page } from '@playwright/test';
import { openDemoEditor, playing } from './helpers/editor';

test.describe.configure({ mode: 'serial' });
test.setTimeout(300_000);

let page: Page;
let projectId = '';
let beatIds: string[] = [];
const errors: string[] = [];

const zeroUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
type Group = { id: string; kind: 'batch' | 'script'; label: string; script?: string };
const shotRec = (id: number, beatId: string, n: number, type: string, group?: Group, extra: Record<string, unknown> = {}) => ({
  id, tool: group?.kind === 'script' ? 'run_script' : 'batch_edit', op: { op: 'shot_set', sceneId: 's1', beatId, set: { type }, reason: '测试' }, status: 'ok',
  changes: [{ scope: 'camera', where: `第${n}句`, field: '镜头', before: '胸像·1人', after: `${type}·1人`, beatId }], warnings: [], notes: [], violations: [], overwrote: [], skipped: [],
  ...(group ? { group } : {}), ...extra,
});
const stream = (p: { applied?: unknown[]; pending?: unknown[]; summary: string }) => {
  const proposal = {
    genId: 'agent_e2e', summary: p.summary, applied: p.applied ?? [], pending: p.pending ?? [], question: null, unverified: [], claimedWithoutOps: null,
    usage: { ...zeroUsage, inputTokens: 5200, outputTokens: 310 }, regenUsage: zeroUsage, steps: 3, mode: 'tools', stats: {}, stopped: 'done', elapsedMs: 900, trace: [],
  };
  const ev = (n: string, d: unknown) => `event: ${n}\ndata: ${JSON.stringify(d)}\n\n`;
  return ev('status', { type: 'status', text: '正在理解指令…' }) + ev('usage', { type: 'usage', usage: proposal.usage, total: proposal.usage }) + ev('proposal', proposal) + ev('done', {});
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

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(e.message));
  projectId = await openDemoEditor(page, 'Agent 批量卡片');
  beatIds = (await playing(page)).scenes[0]!.beats.map((b) => b.id);
  expect(beatIds.length).toBeGreaterThanOrEqual(6);
  await page.locator('body').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('Control+k');
  await expect(page.getByTestId('agent-panel')).toBeVisible();
});
test.afterAll(async ({ request }) => {
  await page.close();
  await request.delete(`/api/projects/${projectId}`);
  expect(errors.filter((e) => !/favicon|Failed to load resource/.test(e))).toEqual([]);
});

test('a batch is ONE collapsed line that expands into per-beat rows; the locked members wait as a group', async () => {
  const n = beatIds.length - 2;
  const group: Group = { id: 'batch1', kind: 'batch', label: `把 ${n} 句的景别改成 ecu` };
  const members = beatIds.slice(0, n);
  const lockedIds = beatIds.slice(n);
  const before = await shotTypes(beatIds);
  await mockTurn(stream({
    summary: `命中 ${beatIds.length} 句，改了 ${n} 句，2 句被锁定等你确认。`,
    applied: members.map((id, i) => shotRec(i + 1, id, i + 1, 'ecu', group)),
    pending: lockedIds.map((id, i) => shotRec(100 + i, id, n + i + 1, 'ecu', group, { status: 'needs_unlock', violations: ['这句的镜头'] })),
  }));
  await send('把这一场所有镜头都改成大特写');

  const card = page.getByTestId('agent-card').last();
  await expect(card).toBeVisible();
  // collapsed: one summary line, no per-beat rows yet
  const batch = card.getByTestId('agent-batch');
  await expect(batch).toHaveCount(1);
  await expect(batch.getByTestId('agent-batch-label')).toHaveText(group.label);
  await expect(batch.getByTestId('agent-batch-count')).toHaveText(`${n} 项`);
  await expect(batch).not.toHaveAttribute('open', '');
  await expect(card.getByTestId('agent-row')).toHaveCount(0);
  await expect(card.getByTestId('agent-script')).toHaveCount(0);
  // the locked part is grouped too, with group-wide buttons
  const pend = card.getByTestId('agent-pending-batch');
  await expect(pend).toHaveCount(1);
  await expect(pend).toContainText(`${group.label}：2 项被锁定`);
  await expect(card.getByTestId('agent-pending-row')).toHaveCount(0);
  await pend.locator('summary').click();
  await expect(card.getByTestId('agent-pending-row')).toHaveCount(2);
  await expect(pend.getByTestId('agent-unlock-apply-all')).toBeVisible();
  // expand the batch: one row per beat
  await batch.locator('summary .agent-batch-label').click();
  await expect(card.getByTestId('agent-row')).toHaveCount(n);
  await expect(card.getByTestId('agent-row').first()).toContainText('ecu·1人');
  // the group checkbox ticks and unticks all rows
  await expect(card.getByTestId('agent-apply-sel')).toContainText(`(${n})`);
  await batch.getByTestId('agent-batch-check').uncheck();
  await expect(card.getByTestId('agent-apply-sel')).toContainText('(0)');
  await expect(card.getByTestId('agent-row').first().getByRole('checkbox')).not.toBeChecked();
  await batch.getByTestId('agent-batch-check').check();
  await expect(card.getByTestId('agent-apply-sel')).toContainText(`(${n})`);
  // one row off: the group box is mixed
  await card.getByTestId('agent-row').nth(1).getByRole('checkbox').uncheck();
  expect(await batch.getByTestId('agent-batch-check').evaluate((el: HTMLInputElement) => el.indeterminate)).toBe(true);
  await card.getByTestId('agent-row').nth(1).getByRole('checkbox').check();
  // nothing is applied before the user says so
  expect(await shotTypes(beatIds)).toEqual(before);
  // apply the sure part: one step; the locked ones are untouched
  await card.getByTestId('agent-apply-all').click();
  await expect.poll(() => shotTypes(members), { timeout: 20_000 }).toEqual(members.map(() => 'ecu'));
  expect(await shotTypes(lockedIds)).toEqual(before.slice(n));
  await expect(card.getByTestId('agent-applied')).toContainText(`已应用 ${n} 项`);
  await expect(card.getByTestId('agent-pending')).toBeVisible();
  await page.locator('body').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('Control+z');
  await expect.poll(() => shotTypes(beatIds), { timeout: 20_000 }).toEqual(before);
  await expect(page.getByTestId('btn-undo')).toBeDisabled();
});

test('a script group shows its source in a collapsible 「AI 写的脚本」 and applies as one step', async () => {
  const code = `// 每隔三句拉近一档\nconst ops = [];\nbeats(1).forEach((b, i) => { if (i % 3 === 0) ops.push(op.setShot(b.beatId, { type: 'cu' })); });\nreturn ops;`;
  const picked = beatIds.filter((_, i) => i % 3 === 0);
  const group: Group = { id: 'script1', kind: 'script', label: '每隔三句拉近一档', script: code };
  const before = await shotTypes(picked);
  await mockTurn(stream({
    summary: '写了一段脚本，每隔三句把镜头拉近到近景。',
    applied: picked.map((id, i) => shotRec(200 + i, id, beatIds.indexOf(id) + 1, 'cu', i === 0 ? group : { id: group.id, kind: 'script', label: group.label })),
  }));
  await send('每隔三句拉近一档');
  const card = page.getByTestId('agent-card').last();
  const batch = card.getByTestId('agent-batch');
  await expect(batch).toHaveCount(1);
  await expect(batch).toHaveAttribute('data-kind', 'script');
  await expect(batch.getByTestId('agent-batch-label')).toHaveText('每隔三句拉近一档');
  await expect(batch).toContainText('AI 写的脚本');
  // collapsed by default; opening the group reveals a second, still collapsed, source block
  await expect(batch).not.toHaveAttribute('open', '');
  await batch.locator('summary .agent-batch-label').click();
  const script = card.getByTestId('agent-script');
  await expect(script).toBeVisible();
  await expect(script).not.toHaveAttribute('open', '');
  await expect(card.getByTestId('agent-script-code')).toBeHidden();
  await script.locator('summary').click();
  await expect(card.getByTestId('agent-script-code')).toBeVisible();
  await expect(card.getByTestId('agent-script-code')).toContainText('beats(1).forEach');
  await expect(card.getByTestId('agent-script-code')).toContainText('每隔三句拉近一档');
  await script.locator('summary').click();
  await expect(card.getByTestId('agent-script-code')).toBeHidden();
  await expect(card.getByTestId('agent-row')).toHaveCount(picked.length);
  // apply: one undo step
  await card.getByTestId('agent-apply-all').click();
  await expect.poll(() => shotTypes(picked), { timeout: 20_000 }).toEqual(picked.map(() => 'cu'));
  await page.locator('body').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('Control+z');
  await expect.poll(() => shotTypes(picked), { timeout: 20_000 }).toEqual(before);
});

test('the locked part of a batch can be skipped as a whole, or unlocked and applied in one click (one undo step)', async () => {
  const lockedIds = beatIds.slice(0, 3);
  const group: Group = { id: 'batch2', kind: 'batch', label: '把 3 句的景别改成 ecu' };
  await mockTurn(stream({
    summary: '三句都锁着。',
    pending: lockedIds.map((id, i) => shotRec(300 + i, id, i + 1, 'ecu', group, { status: 'needs_unlock', violations: ['这句的镜头'] })),
  }));
  const before = await shotTypes(lockedIds);
  await send('前三句改成大特写');
  const card = page.getByTestId('agent-card').last();
  await card.getByTestId('agent-pending-batch').locator('summary').click();
  await expect(card.getByTestId('agent-pending-row')).toHaveCount(3);
  await card.getByTestId('agent-skip-all').click();
  await expect(card.getByTestId('agent-pending-batch')).toHaveCount(0);
  expect(await shotTypes(lockedIds)).toEqual(before);
  // again, this time unlock + apply the whole group at once
  await mockTurn(stream({
    summary: '三句都锁着。',
    pending: lockedIds.map((id, i) => shotRec(400 + i, id, i + 1, 'ecu', group, { status: 'needs_unlock', violations: ['这句的镜头'] })),
  }));
  await send('前三句改成大特写，解锁也行');
  const card2 = page.getByTestId('agent-card').last();
  await card2.getByTestId('agent-pending-batch').locator('summary').click();
  await card2.getByTestId('agent-unlock-apply-all').click();
  await expect.poll(() => shotTypes(lockedIds), { timeout: 20_000 }).toEqual(lockedIds.map(() => 'ecu'));
  await page.locator('body').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('Control+z');
  await expect.poll(() => shotTypes(lockedIds), { timeout: 20_000 }).toEqual(before);
});
