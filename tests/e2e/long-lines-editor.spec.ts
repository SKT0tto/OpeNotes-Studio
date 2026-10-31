/**
 * S7: long lines in the editor, in a real browser (no model is called: the split endpoint answers with the rule splitter, the assistant's
 * endpoint is mocked). The line-count indicator and the 超长 badges, 「自动拆分」 as one undo step, 「展开显示」 in the preview, the
 * 「检查过长台词」 list (all at once / scene by scene), the split section on a generation card and the assistant card's 「拆开」 hint.
 * All text is original. Set S7_SHOTS=1 to also save screenshots (1440x900 and 1440x620) into dev-notes/long-lines/impl-shots.
 */
import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { asksForLineSplit } from '../../shared/agent/asks';
import { fitsDialog } from '../../shared/style/dialogLayout';
import { OURNOTES_STYLE } from '../../shared/style/ournotes';
import type { Project } from '../../shared/schema/project';
import { beatStart, settled } from './helpers/editor';
import { aiPop, mockAiConfigured, openAi, showInspector } from './helpers/ui';

const fixture = JSON.parse(fs.readFileSync('tests/fixtures/ai-generated-project.json', 'utf8')) as Project;
test.describe.configure({ mode: 'serial' });
test.setTimeout(240_000);

const LONG_A = '我跟你说，这次的合宿我已经全部安排好了！民宿、电车票、练习的时间表，连每天晚上吃什么都写好了！……不过，钱的事我还没跟大家商量。';
const LONG_B = '昨天回家的路上，我一直在想今天要怎么跟大家开口，结果走到车站才发现自己把最重要的笔记本落在了排练室里，只好折回去，等我拿到的时候天都已经黑了。';
const LONG_C = '这首歌的最后一段，我想来回唱好几遍，因为我总觉得只唱一遍的话，大家还来不及听懂，那句话就已经被吹散了，所以拜托你们陪我再练一次。';
const LONG_SRC = '“嗯……昨天晚上洗完澡以后突然想到了一句很不错的歌词，可是怎么想都想不出后面该怎么接，一直写到了半夜，最后只好先把前半句记在手机的备忘录里，打算今天再慢慢想。”';
const D = OURNOTES_STYLE.dialog;

const SHOTS = process.env.S7_SHOTS ? 'D:/OurNotesStudio/dev-notes/long-lines/impl-shots' : '';
async function shot(page: Page, name: string, prep?: () => Promise<void>) {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  for (const h of [900, 620]) {
    await page.setViewportSize({ width: 1440, height: h });
    await page.waitForTimeout(500);
    await prep?.();
    await page.screenshot({ path: path.join(SHOTS, `s7-${name}-1440x${h}.png`) });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(300);
}

const errors: string[] = [];
const watch = (page: Page) => {
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(e.message));
};

/** The dialogue beats (with a speaker) of a scene of the fixture, in order. */
const talkers = (p: Project, sceneNo: number) => p.scenes[sceneNo]!.beats.filter((b) => b.kind === 'dialogue' && b.speakerId);

// ---- the editor: indicator, badges, auto split, expand, the check list ---------------------------------------------------

test.describe('editor', () => {
  let page: Page;
  let projectId = '';
  let ids: { a: string; b: string; c: string; ok: string };

  test.beforeAll(async ({ browser, request }) => {
    page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    watch(page);
    await mockAiConfigured(page);
    const p = JSON.parse(JSON.stringify(fixture)) as Project;
    const s3 = talkers(p, 2);
    const s2 = talkers(p, 1);
    s3[0]!.text = LONG_A;
    s3[1]!.text = LONG_B;
    s2[0]!.text = LONG_C;
    for (const b of [s3[0]!, s3[1]!, s2[0]!]) { b.variant = 'normal'; delete (b as { overflow?: string }).overflow; }
    ids = { a: s3[0]!.id, b: s3[1]!.id, c: s2[0]!.id, ok: s3[2]!.id };
    projectId = `p_s7_edit_${Date.now()}`;
    const created = await request.post('/api/projects', { data: { ...p, id: projectId, title: '长台词 e2e' } });
    expect(created.ok()).toBe(true);
    await page.goto(`/editor/${projectId}`);
    await expect(page.getByTestId('workspace')).toBeVisible();
    await expect(page.getByTestId('play-status')).toHaveText('就绪', { timeout: 180_000 });
  });
  test.afterAll(async ({ request }) => {
    await page.close();
    await request.delete(`/api/projects/${projectId}`);
  });

  const pick = async (id: string) => {
    await page.getByTestId(`outline-beat-${id}`).click();
    await showInspector(page);
    await expect(page.getByTestId('insp-beat')).toBeVisible();
  };
  const undoN = async (n: number) => {
    for (let i = 0; i < n; i++) await page.getByTestId('btn-undo').click();
  };
  const rowsOnScreen = async (id: string, chars: number) => {
    const start = await beatStart(page, id);
    await page.evaluate((x) => window.__studio.player!.seek(x), start + chars / 10 + 0.8);
    await expect.poll(() => page.evaluate(() => window.__studio.player!.busy()), { timeout: 60_000 }).toBe(false);
    await page.waitForTimeout(300);
    return page.evaluate(() => (document.querySelector('[data-testid=dialog] [data-part=text]') as HTMLElement).textContent!.split('\n'));
  };

  test('the selected line shows 「n/2 行」, warns when it is too long and lists the badge in the script; a fitting line does not warn', async () => {
    await pick(ids.a);
    const lines = fitsDialog(LONG_A, D, 'normal').lines;
    expect(lines).toBeGreaterThan(D.maxLines);
    await expect(page.getByTestId('insp-line-count')).toHaveText(`${lines}/${D.maxLines} 行`);
    await expect(page.getByTestId('insp-line-meter')).toHaveAttribute('data-over', 'true');
    await expect(page.getByTestId('insp-long-badge')).toBeVisible();
    await expect(page.getByTestId('insp-auto-split')).toBeEnabled();
    await expect(page.getByTestId(`outline-long-${ids.a}`)).toBeVisible();
    await expect(page.getByTestId(`outline-long-${ids.b}`)).toBeVisible();
    await expect(page.getByTestId(`outline-long-${ids.ok}`)).toHaveCount(0);
    await expect(page.getByTestId('btn-check-long')).toContainText('· 3');
    await expect(page.getByTestId('insp-expand-hint')).toContainText(`${lines} 行`);
    await shot(page, 'inspector-indicator');
    await pick(ids.ok);
    await expect(page.getByTestId('insp-line-meter')).toHaveAttribute('data-over', 'false');
    await expect(page.getByTestId('insp-auto-split')).toHaveCount(0);
  });

  test('「展开显示」 shows its hint, marks the line, and the preview draws every line; switching it off cuts back to two', async () => {
    await pick(ids.a);
    const lines = fitsDialog(LONG_A, D, 'normal').lines;
    expect(await rowsOnScreen(ids.a, [...LONG_A].length)).toHaveLength(D.maxLines);
    await page.getByTestId('insp-expand').check();
    await expect(page.getByTestId('insp-expand-hint')).toHaveText(lines <= 3 ? `${lines} 行：对话框会向下长` : `${lines} 行：对话框会向上长`);
    await expect(page.getByTestId('insp-expanded-badge')).toBeVisible();
    await expect(page.getByTestId('insp-line-meter')).toHaveAttribute('data-over', 'false'); // expanded = shown in full, not a warning any more
    await expect(page.getByTestId(`outline-expanded-${ids.a}`)).toBeVisible();
    await expect(page.getByTestId(`outline-long-${ids.a}`)).toHaveCount(0);
    await expect(page.getByTestId('btn-check-long')).toContainText('· 2');
    await settled(page);
    expect(await rowsOnScreen(ids.a, [...LONG_A].length)).toHaveLength(lines);
    await shot(page, 'expand-toggle');
    await page.getByTestId('insp-expand').uncheck();
    await expect(page.getByTestId(`outline-long-${ids.a}`)).toBeVisible();
    await settled(page);
    expect(await rowsOnScreen(ids.a, [...LONG_A].length)).toHaveLength(D.maxLines);
    // the two toggles above were two edits of their own; back to the start
  });

  test('「自动拆分」 cuts the line into continuations in one step, and one undo brings the line back', async () => {
    await pick(ids.a);
    await shot(page, 'autosplit-before');
    const count = await page.locator('[data-beat-id]').count();
    await page.getByTestId('insp-auto-split').click();
    await expect(page.getByTestId(`outline-long-${ids.a}`)).toHaveCount(0);
    await expect(page.locator('[data-testid^="outline-cont-"]').first()).toBeVisible();
    const added = (await page.locator('[data-beat-id]').count()) - count;
    expect(added).toBeGreaterThanOrEqual(1);
    await expect(page.locator('[data-testid^="outline-cont-"]')).toHaveCount(added);
    await expect(page.getByTestId('btn-check-long')).toContainText('· 2');
    await expect(page.getByTestId('btn-undo')).toBeEnabled();
    await shot(page, 'autosplit-after');
    // a continuation says what it is in the inspector
    await page.locator('[data-testid^="outline-cont-"]').first().click();
    await showInspector(page);
    await expect(page.getByTestId('insp-continuation')).toBeVisible();
    // the pieces fit
    await expect(page.getByTestId('insp-line-meter')).toHaveAttribute('data-over', 'false');
    const before = await page.getByTestId('btn-undo').getAttribute('title');
    expect(before).toContain('自动拆分长句');
    await undoN(1);
    await expect(page.getByTestId(`outline-long-${ids.a}`)).toBeVisible();
    await expect(page.locator('[data-testid^="outline-cont-"]')).toHaveCount(0);
    expect(await page.locator('[data-beat-id]').count()).toBe(count);
  });

  test('「检查过长台词」 lists the lines per scene; nothing changes until a button is used; 「逐场拆分」 is one undo step per scene, 「全部拆分」 one in all', async () => {
    const count = await page.locator('[data-beat-id]').count();
    await page.getByTestId('btn-check-long').click();
    const dlg = page.getByTestId('long-lines-dialog');
    await expect(dlg).toBeVisible();
    await expect(page.getByTestId('long-row')).toHaveCount(3);
    await expect(page.getByTestId('long-summary')).toContainText('2 个场景里有 3 句');
    expect(await page.locator('[data-beat-id]').count()).toBe(count);
    await shot(page, 'check-list');
    // scene by scene
    await page.getByTestId('long-split-each').click();
    await expect(page.getByTestId('long-empty')).toBeVisible();
    await expect(page.getByTestId('btn-check-long')).not.toContainText('·');
    await page.keyboard.press('Escape');
    await expect(dlg).toHaveCount(0);
    await undoN(1);
    await expect(page.getByTestId('btn-check-long')).toContainText('· 2');
    await undoN(1);
    await expect(page.getByTestId('btn-check-long')).toContainText('· 3');
    expect(await page.locator('[data-beat-id]').count()).toBe(count);
    // everything at once
    await page.getByTestId('btn-check-long').click();
    await page.getByTestId('long-split-all').click();
    await expect(page.getByTestId('long-empty')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('long-lines-dialog')).toHaveCount(0);
    expect(await page.locator('[data-beat-id]').count()).toBeGreaterThan(count);
    await undoN(1);
    await expect(page.getByTestId('btn-check-long')).toContainText('· 3');
    expect(await page.locator('[data-beat-id]').count()).toBe(count);
  });

  test('an assistant turn that left long lines shows 「有 N 句台词超过两行」 and 「拆开」 sends an explicit split request', async () => {
    const zero = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
    const p = (await page.evaluate(() => window.__studio.player!.project())) as Project;
    const longs = [ids.b, ids.c].map((id) => {
      const sc = p.scenes.find((s) => s.beats.some((b) => b.id === id))!;
      return { sceneId: sc.id, beatId: id, beatNo: sc.beats.findIndex((b) => b.id === id) + 1, lines: 3, max: 2 };
    });
    const proposal = { genId: 'agent_e2e', summary: '把节奏调快了一点。', applied: [], pending: [], question: null, unverified: [], claimedWithoutOps: null, usage: zero, regenUsage: zero, steps: 1, mode: 'tools', stats: {}, stopped: 'done', elapsedMs: 100, trace: [], longLines: longs };
    const ev = (n: string, d: unknown) => `event: ${n}\ndata: ${JSON.stringify(d)}\n\n`;
    let sent = '';
    await page.route('**/api/agent/turn', async (route) => {
      sent = (route.request().postDataJSON() as { instruction: string }).instruction;
      await route.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream' }, body: ev('proposal', proposal) + ev('done', {}) });
    });
    await openAi(page, { generate: false });
    await page.getByTestId('agent-input').fill('节奏再快一点');
    await page.getByTestId('agent-input').press('Enter');
    const hint = page.getByTestId('agent-longlines');
    await expect(hint).toBeVisible();
    await expect(hint).toContainText('有 2 句台词超过两行');
    await shot(page, 'assistant-hint');
    await page.getByTestId('agent-longlines-split').click();
    await expect.poll(() => sent).toMatch(/拆开/);
    expect(asksForLineSplit(sent)).toBe(true);
    expect(sent).toContain('第3场');
  });
});

// ---- generation: the split section on the result card -----------------------------------------------------------------

test.describe('generation card', () => {
  let page: Page;
  let projectId = '';

  test.beforeAll(async ({ browser, request }) => {
    page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    watch(page);
    await mockAiConfigured(page);
    const p = JSON.parse(JSON.stringify(fixture)) as Project;
    p.source.text = p.source.text.replace('“嗯……昨天晚上想到了一句，可是后面接不上。”', LONG_SRC);
    projectId = `p_s7_gen_${Date.now()}`;
    const created = await request.post('/api/projects', { data: { ...p, id: projectId, title: '长句拆分 e2e' } });
    expect(created.ok()).toBe(true);
    await page.goto(`/editor/${projectId}`);
    await expect(page.getByTestId('workspace')).toBeVisible();
    await expect(page.getByTestId('play-status')).toHaveText('就绪', { timeout: 180_000 });
  });
  test.afterAll(async ({ request }) => {
    await page.close();
    await request.delete(`/api/projects/${projectId}`);
  });

  test('a result that cut long lines has a collapsible 「长句拆分 N」 section (original → pieces, who split it, why); applying it is one step', async () => {
    await page.getByTestId('outline-scene-s_1').click();
    await openAi(page);
    await page.getByTestId('ai-engine').selectOption('rule');
    await page.getByTestId('ai-regen-scene').click();
    await expect(page.getByTestId('ai-result')).toHaveCount(1);
    const section = page.getByTestId('ai-splits');
    await expect(section).toBeVisible();
    await expect(page.getByTestId('ai-splits-count')).toHaveText('1');
    await expect(page.getByTestId('ai-origin')).toHaveCount(1); // still one source badge on the card
    await section.locator('summary').click();
    const one = page.getByTestId('ai-split').first();
    await expect(one).toContainText('规则拆分');
    await expect(one).toContainText('昨天晚上洗完澡以后');
    expect(await one.getByTestId('ai-split-piece').count()).toBeGreaterThanOrEqual(2);
    await expect(one.getByTestId('ai-split-piece').first()).toContainText('长句续行');
    // the composer is still fully inside the dock
    const [box, dock] = await Promise.all([page.getByTestId('agent-input').boundingBox(), page.getByTestId('agent-dock').boundingBox()]);
    expect(box!.y + box!.height).toBeLessThanOrEqual(dock!.y + dock!.height + 1);
    await shot(page, 'generation-splits', () => one.scrollIntoViewIfNeeded());
    await page.getByTestId('ai-accept-all').click();
    await expect(page.getByTestId('ai-card')).toHaveAttribute('data-state', 'applied');
    await expect(page.locator('[data-testid^="outline-cont-"]').first()).toBeVisible();
    await expect(page.getByTestId('btn-check-long')).not.toContainText('·');
    await page.locator('body').click({ position: { x: 5, y: 5 } });
    await page.keyboard.press('Control+z');
    await expect(page.getByTestId('ai-card')).toHaveAttribute('data-state', 'undone');
    await expect(page.locator('[data-testid^="outline-cont-"]')).toHaveCount(0);
    await aiPop(page).catch(() => {});
  });
});

test.afterAll(() => {
  expect(errors.filter((e) => !/favicon|Failed to load resource/.test(e))).toEqual([]);
});
