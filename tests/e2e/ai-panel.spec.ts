/**
 * The one chat-first AI panel in a real browser (no model is called: generation uses the rule engine, the assistant's endpoint is not reached):
 * one scrolling stream and one input, no 「导演」 / 「助手」 in it, the composer fully visible at 1440x900 and 1440x620, a generation turn that
 * appears at once (bubble + card), 已应用 -> Ctrl+Z -> 已撤销, typed commands routed to generation, 微调 pre-filling the input, the 「AI」
 * button going back to the inspector's tab instead of closing the panel, and state surviving another tab in front of it.
 */
import fs from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import type { Project } from '../../shared/schema/project';
import { aiPop, mockAiConfigured, openAi, showInspector } from './helpers/ui';

const fixture = JSON.parse(fs.readFileSync('tests/fixtures/ai-generated-project.json', 'utf8')) as Project;
test.describe.configure({ mode: 'serial' });
test.setTimeout(180_000);

let page: Page;
let projectId = '';
const errors: string[] = [];

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(e.message));
  await mockAiConfigured(page);
  projectId = `p_ai_panel_${Date.now()}`;
  const created = await page.request.post('/api/projects', { data: { ...fixture, id: projectId, title: 'AI 面板 e2e' } });
  expect(created.ok()).toBe(true);
  await page.goto(`/editor/${projectId}`);
  await expect(page.getByTestId('workspace')).toBeVisible();
});
test.afterAll(async ({ request }) => {
  await page.close();
  await request.delete(`/api/projects/${projectId}`);
  expect(errors.filter((e) => !/Failed to load resource|favicon/.test(e))).toEqual([]);
});

const inView = async (testId: string) => {
  const [box, dock] = await Promise.all([page.getByTestId(testId).boundingBox(), page.getByTestId('agent-dock').boundingBox()]);
  expect(box).not.toBeNull();
  expect(box!.y).toBeGreaterThanOrEqual(dock!.y - 1);
  expect(box!.y + box!.height).toBeLessThanOrEqual(dock!.y + dock!.height + 1);
};

test('one stream, one input, no 「导演」 / 「助手」; the composer is fully visible at 1440x900 and 1440x620', async () => {
  await openAi(page, { generate: false });
  const panel = page.getByTestId('ai-merged-panel');
  await expect(panel.locator('textarea')).toHaveCount(1);
  await expect(panel.locator('select')).toHaveCount(0); // (the popover is closed)
  const text = await panel.innerText();
  expect(text).not.toMatch(/导演|助手/);
  for (const t of ['agent-input', 'agent-send', 'ai-gen-chip']) await inView(t);
  await page.setViewportSize({ width: 1440, height: 620 });
  await page.waitForTimeout(400);
  for (const t of ['agent-input', 'agent-send', 'ai-gen-chip']) await inView(t);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(400);
});

test('「生成 ▾」: the bubble and a running / finished card appear in the stream; the input never leaves the view', async () => {
  await openAi(page);
  await page.getByTestId('ai-engine').selectOption('rule');
  await page.getByTestId('ai-regen-scene').click();
  await expect(page.getByTestId('ai-user-bubble')).toHaveCount(1);
  await expect(page.getByTestId('ai-card')).toHaveCount(1);
  await expect(page.getByTestId('ai-result')).toHaveCount(1);
  await expect(page.getByTestId('ai-card')).toHaveAttribute('data-state', 'pending');
  await expect(page.getByTestId('ai-origin')).toHaveText('规则');
  await inView('agent-input');
  await expect(page.getByTestId('ai-gen-popover')).toHaveCount(0); // the popover closes when 「生成」 is used
});

test('apply is one undo step; Ctrl+Z turns the card into 已撤销 (and 「撤销这次」 does the same)', async () => {
  await page.getByTestId('ai-accept-all').click();
  await expect(page.getByTestId('ai-card')).toHaveAttribute('data-state', 'applied');
  await expect(page.getByTestId('ai-card-undo')).toBeEnabled();
  await page.locator('body').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('Control+z');
  await expect(page.getByTestId('ai-card')).toHaveAttribute('data-state', 'undone');
  await expect(page.getByTestId('ai-card-state')).toHaveText('已撤销');
  await expect(page.getByTestId('btn-undo')).toBeDisabled(); // exactly one step was made
  // again, this time with the card's own button
  await aiPop(page);
  await page.getByTestId('ai-regen-scene').click();
  await expect(page.getByTestId('ai-result')).toHaveCount(2);
  await page.getByTestId('ai-accept-all').click();
  await page.getByTestId('ai-card-undo').last().click();
  await expect(page.getByTestId('ai-card').last()).toHaveAttribute('data-state', 'undone');
});

test('a typed command that is exactly a generation action goes to generation, with a one-click way back to 「发给 AI」', async () => {
  const turns = await page.getByTestId('ai-turn').count();
  await page.getByTestId('agent-input').fill('重新生成这一场');
  await page.getByTestId('agent-input').press('Enter');
  await expect(page.getByTestId('ai-turn')).toHaveCount(turns + 1);
  await expect(page.getByTestId('ai-user-bubble').last()).toHaveText('重新生成这一场');
  await expect(page.getByTestId('ai-route-undo')).toBeVisible();
  // not routed: more than the command (goes to the assistant, which is not reached here: no card of ours appears)
  await expect(page.getByTestId('ai-result').last()).toBeVisible();
});

test('微调 pre-fills 「第N场：」 in the input and focuses it; nothing is sent', async () => {
  await page.getByTestId('ai-refine-assistant').last().click();
  await expect(page.getByTestId('agent-input')).toHaveValue(/^第\d+场：$/);
  await expect(page.getByTestId('agent-input')).toBeFocused();
  await page.getByTestId('agent-input').fill('');
});

test('the 「AI」 button goes back to the inspector tab instead of closing the panel; the layout does not change', async () => {
  await openAi(page, { generate: false });
  const before = await page.getByTestId('agent-dock').boundingBox();
  await page.getByTestId('btn-agent').click();
  await expect(page.getByTestId('right-panel')).toBeVisible();
  await expect(page.getByTestId('dock-tab-agent')).toHaveCount(1); // the panel is still in the layout
  await page.getByTestId('btn-agent').click();
  await expect(page.getByTestId('agent-dock')).toBeVisible();
  expect(await page.getByTestId('agent-dock').boundingBox()).toEqual(before);
});

test('draft, cards and options survive another tab in front of the AI panel', async () => {
  await openAi(page, { generate: false });
  await page.getByTestId('agent-input').fill('草稿还在');
  const results = await page.getByTestId('ai-result').count();
  await showInspector(page);
  await expect(page.getByTestId('ai-merged-panel')).toHaveCount(0);
  await page.getByTestId('dock-tab-agent').locator('.dock-tab-title').click();
  await expect(page.getByTestId('agent-input')).toHaveValue('草稿还在');
  await expect(page.getByTestId('ai-result')).toHaveCount(results);
  await aiPop(page);
  await expect(page.getByTestId('ai-engine')).toHaveValue('rule');
  await page.keyboard.press('Escape');
});

test('without an AI model: one line at the top, rule generation works, free text cannot be sent (with the reason), typed generation commands still can', async () => {
  await page.unroute('**/api/llm/settings');
  await page.route('**/api/llm/settings', (route) => route.request().method() === 'GET'
    ? route.fulfill({ json: {
      provider: null, available: ['anthropic', 'openai'],
      anthropic: { hasKey: false, mask: null, source: null, model: '', baseUrl: '' },
      openai: { hasKey: false, mask: null, source: null, model: '', baseUrl: '' },
      vision: { hasKey: false, mask: null, source: null, mode: 'auto', model: '', baseUrl: '' },
      status: { configured: false, provider: null, model: null, verified: 'none', message: '未配置 AI' },
    } })
    : route.fallback());
  await page.reload();
  await expect(page.getByTestId('workspace')).toBeVisible();
  await openAi(page, { generate: false });
  await expect(page.getByTestId('ai-noai-banner')).toBeVisible();
  await page.getByTestId('agent-input').fill('这一场节奏慢一点');
  await expect(page.getByTestId('agent-send')).toBeDisabled();
  await expect(page.getByTestId('ai-send-reason')).toContainText('改写需要 AI 模型');
  await page.getByTestId('agent-input').fill('生成全部场景');
  await expect(page.getByTestId('agent-send')).toBeEnabled();
  await page.getByTestId('agent-input').press('Enter');
  await expect(page.getByTestId('ai-origin').first()).toHaveText('规则');
  await expect(page.getByTestId('ai-accept-batch')).toBeVisible({ timeout: 60_000 });
});
