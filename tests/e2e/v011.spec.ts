/**
 * v0.1.1 in a real browser:
 *  1. every canvas host keeps the exact frame shape (16:9, or 2.16:1 on the play page) at any window size, panel layout and zoom
 *  3/4. the AI settings never claim "configured" without a usable key; generation failures say what failed and how to fix it
 *  5. changing a costume never shows a black frame
 */
import fs from 'node:fs';
import { expect, test, type Locator, type Page, type Route } from '@playwright/test';
import { openDemoEditor } from './helpers/editor';
import './helpers/studio';

test.setTimeout(240_000);

const TOL = 0.005;
const R169 = 16 / 9;
const R216 = 1920 / 890;

/** Width / height of a rendered element, and whether it lies inside `within`. */
async function shape(el: Locator) {
  const b = await el.boundingBox();
  expect(b, 'element is rendered').not.toBeNull();
  return { ratio: b!.width / b!.height, box: b! };
}
async function expectRatio(el: Locator, want: number, what: string) {
  const { ratio } = await shape(el);
  expect(Math.abs(ratio / want - 1), `${what}: ${ratio.toFixed(4)} vs ${want.toFixed(4)}`).toBeLessThan(TOL);
}
/** The frame is centred in, and never larger than, the area it is hosted in. */
async function expectFitted(frame: Locator, area: Locator, what: string) {
  const f = (await frame.boundingBox())!;
  const outer = (await area.boundingBox())!;
  // the measured area is the content box: padding is not available to the frame
  const pad = await area.evaluate((el) => {
    const cs = getComputedStyle(el);
    return { l: parseFloat(cs.paddingLeft), r: parseFloat(cs.paddingRight), t: parseFloat(cs.paddingTop), b: parseFloat(cs.paddingBottom) };
  });
  const a = { x: outer.x + pad.l, y: outer.y + pad.t, width: outer.width - pad.l - pad.r, height: outer.height - pad.t - pad.b };
  expect(f.width, `${what}: not wider than its area`).toBeLessThanOrEqual(a.width + 1);
  expect(f.height, `${what}: not taller than its area`).toBeLessThanOrEqual(a.height + 1);
  expect(Math.abs(f.x + f.width / 2 - (a.x + a.width / 2)), `${what}: centred horizontally`).toBeLessThan(2);
  expect(Math.abs(f.y + f.height / 2 - (a.y + a.height / 2)), `${what}: centred vertically`).toBeLessThan(2);
  // one of the two dimensions is used up (letterbox or pillarbox, never a small box)
  expect(Math.min(a.width - f.width, a.height - f.height), `${what}: as large as it can be`).toBeLessThan(2);
}

async function checkEditorShape(page: Page, want = R169) {
  const frame = page.getByTestId('stage-frame');
  await expectRatio(frame, want, 'stage frame');
  await expectRatio(page.getByTestId('play-canvas'), want, 'canvas');
  await expectFitted(frame, page.locator('.viewport'), 'preview');
  // the picture itself is the same shape as the frame (no stretching inside it)
  const px = await page.getByTestId('play-canvas').evaluate((c) => (c as HTMLCanvasElement).width / (c as HTMLCanvasElement).height);
  expect(Math.abs(px / want - 1)).toBeLessThan(TOL);
}

test.describe('editor preview keeps the project frame', () => {
  test.describe.configure({ mode: 'serial' });
  let page: Page;
  let projectId = '';
  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    projectId = await openDemoEditor(page, 'v0.1.1 aspect');
  });
  test.afterAll(async ({ request }) => {
    await page.close();
    await request.delete(`/api/projects/${projectId}`);
  });

  const SIZES = [[1280, 720], [1440, 900], [1920, 1080], [1366, 768], [900, 1200]] as const;
  for (const [w, h] of SIZES) {
    test(`${w}x${h}: 16:9 with both side panels open, each collapsed, and both collapsed`, async () => {
      await page.setViewportSize({ width: w, height: h });
      await page.waitForTimeout(400);
      await checkEditorShape(page);
      await page.screenshot({ path: `.verify/v011-editor-${w}x${h}.png` });
      const left = page.locator('button[title="左栏"]');
      const right = page.locator('button[title="检查器"]');
      await left.click();
      await page.waitForTimeout(300);
      await checkEditorShape(page);
      await right.click();
      await page.waitForTimeout(300);
      await checkEditorShape(page);
      await left.click();
      await page.waitForTimeout(300);
      await checkEditorShape(page);
      await right.click(); // everything open again
      await page.waitForTimeout(300);
      await checkEditorShape(page);
    });
  }

  test('dragging every dock divider (side panels and the timeline) keeps the shape', async () => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const sashes = page.locator('.dock-root .dv-sash');
    const n = await sashes.count();
    expect(n).toBeGreaterThanOrEqual(3); // left | stage | inspector, and the timeline above the bottom
    for (let i = 0; i < n; i++) {
      for (const sign of [1, -1, 1]) {
        const b = (await sashes.nth(i).boundingBox())!;
        const vertical = b.height > b.width; // a vertical divider moves left / right
        const x = b.x + b.width / 2;
        const y = b.y + b.height / 2;
        const d = sign * 140;
        await page.mouse.move(x, y);
        await page.mouse.down();
        await page.mouse.move(x + (vertical ? d / 2 : 0), y + (vertical ? 0 : d / 2), { steps: 4 });
        await page.mouse.move(x + (vertical ? d : 0), y + (vertical ? 0 : d), { steps: 4 });
        await page.mouse.up();
        await page.waitForTimeout(250);
        await checkEditorShape(page);
      }
    }
    await page.screenshot({ path: '.verify/v011-editor-dragged.png' });
  });

  test('browser zoom (device scale 1.25 / 1.5 / 2 at the same CSS width) and odd window sizes', async ({ browser }) => {
    for (const [w, h, dpr] of [[1536, 864, 1.25], [1280, 720, 1.5], [960, 540, 2], [1283, 717, 1], [1001, 937, 1]] as const) {
      const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: dpr });
      const p = await ctx.newPage();
      try {
        await p.goto(`/editor/${projectId}`);
        await expect(p.getByTestId('play-status')).toHaveText('就绪', { timeout: 180_000 });
        await checkEditorShape(p);
        await p.screenshot({ path: `.verify/v011-editor-zoom-${w}x${h}@${dpr}.png` });
      } finally {
        await ctx.close();
      }
    }
  });

  test('storyboard thumbnails are 16:9 at several widths', async () => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.getByTestId('view-storyboard').click();
    await expect(page.getByTestId('storyboard')).toBeVisible();
    const thumbs = page.locator('.sb-thumb');
    await expect(thumbs.first()).toBeVisible();
    for (const [w, h] of [[1440, 900], [1280, 720], [900, 1200]] as const) {
      await page.setViewportSize({ width: w, height: h });
      await page.waitForTimeout(300);
      const n = Math.min(await thumbs.count(), 8);
      for (let i = 0; i < n; i++) await expectRatio(thumbs.nth(i), R169, `thumbnail ${i} at ${w}x${h}`);
    }
    await page.screenshot({ path: '.verify/v011-storyboard.png' });
    await page.getByTestId('view-preview').click();
  });
});

test.describe('play page and labs', () => {
  for (const [w, h] of [[1280, 720], [1366, 768], [1920, 1080], [900, 1200], [600, 400]] as const) {
    test(`/play/demo at ${w}x${h}: 16:9 and the 2.16:1 wide frame, controls always reachable`, async ({ browser }) => {
      const ctx = await browser.newContext({ viewport: { width: w, height: h } });
      const page = await ctx.newPage();
      try {
        await page.goto('/play/demo');
        await expect(page.getByTestId('play-status')).toHaveText('就绪', { timeout: 180_000 });
        const frame = page.getByTestId('stage-frame');
        const area = page.locator('.play-viewport');
        await expectRatio(frame, R169, 'play frame 16:9');
        await expectRatio(page.getByTestId('play-canvas'), R169, 'play canvas 16:9');
        await expectFitted(frame, area, 'play 16:9');
        await expect(page.getByTestId('play-toggle')).toBeInViewport();
        await page.screenshot({ path: `.verify/v011-play-${w}x${h}.png` });
        await page.getByTestId('play-aspect').selectOption({ index: 1 });
        await expect(page.getByTestId('play-status')).toHaveText('就绪', { timeout: 180_000 });
        await expectRatio(frame, R216, 'play frame 2.16:1');
        await expectRatio(page.getByTestId('play-canvas'), R216, 'play canvas 2.16:1');
        await expectFitted(frame, area, 'play 2.16:1');
        await expect(page.getByTestId('play-toggle')).toBeInViewport();
        await page.screenshot({ path: `.verify/v011-play-wide-${w}x${h}.png` });
        // resize live (window drag): still exact
        await page.setViewportSize({ width: Math.round(w * 0.8), height: Math.round(h * 0.9) });
        await page.waitForTimeout(300);
        await expectRatio(frame, R216, 'play frame after resize');
        await expectFitted(frame, area, 'play after resize');
      } finally {
        await ctx.close();
      }
    });
  }

  for (const [w, h] of [[1280, 720], [900, 1200]] as const) {
    test(`Stage Lab and Actor Lab canvases keep their shape at ${w}x${h}`, async ({ browser }) => {
      const ctx = await browser.newContext({ viewport: { width: w, height: h } });
      const page = await ctx.newPage();
      try {
        await page.goto('/lab/stage');
        await expect(page.getByTestId('stage-status')).toHaveText('就绪', { timeout: 120_000 });
        await expectRatio(page.getByTestId('stage-frame'), R169, 'stage lab frame');
        await expectRatio(page.getByTestId('stage-canvas').locator('canvas'), R169, 'stage lab canvas');
        await page.screenshot({ path: `.verify/v011-stagelab-${w}x${h}.png` });
        await page.goto('/lab/actor');
        await expect(page.getByTestId('lab-canvas').locator('canvas')).toBeVisible({ timeout: 120_000 });
        await expectRatio(page.getByTestId('stage-frame'), 560 / 760, 'actor lab frame');
        await expectRatio(page.getByTestId('lab-canvas').locator('canvas'), 560 / 760, 'actor lab canvas');
        await page.screenshot({ path: `.verify/v011-actorlab-${w}x${h}.png` });
      } finally {
        await ctx.close();
      }
    });
  }
});

test.describe('costume change never blanks the preview', () => {
  test('no all-black frame while the wardrobe changes (and again on undo)', async ({ browser, request }) => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const id = await openDemoEditor(page, 'v0.1.1 costume');
    try {
      await page.evaluate(() => window.__studio.player!.seek(1.0));
      await expect.poll(() => page.evaluate(() => window.__studio.player!.busy()), { timeout: 60_000 }).toBe(false);
      await page.getByTestId('insp-tab-scene').click();
      const sel = page.getByTestId('insp-wardrobe-c_002');
      const before = await sel.inputValue();
      const other = (await sel.locator('option').evaluateAll((o) => o.map((x) => (x as HTMLOptionElement).value))).find((v) => v !== before)!;
      // sample the canvas every animation frame: a frame is "black" when nothing but black pixels is on it
      await page.evaluate(() => {
        const w = window as unknown as { __frames: { n: number; black: number; min: number }; __stop?: boolean };
        w.__frames = { n: 0, black: 0, min: 255 };
        w.__stop = false;
        const probe = document.createElement('canvas');
        probe.width = 32;
        probe.height = 18;
        const ctx = probe.getContext('2d', { willReadFrequently: true })!;
        const tick = () => {
          const c = document.querySelector<HTMLCanvasElement>('[data-testid=play-canvas]');
          if (c) {
            ctx.drawImage(c, 0, 0, 32, 18);
            const d = ctx.getImageData(0, 0, 32, 18).data;
            let sum = 0;
            for (let i = 0; i < d.length; i += 4) sum += d[i]! + d[i + 1]! + d[i + 2]!;
            const mean = sum / (32 * 18 * 3);
            w.__frames.n++;
            w.__frames.min = Math.min(w.__frames.min, mean);
            if (mean < 2) w.__frames.black++;
          }
          if (!w.__stop) requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
      const modelOf = () => page.evaluate(() => window.__studio.player!.project().scenes[0]!.wardrobe.c_002!.modelId);
      await sel.selectOption(other);
      await expect.poll(modelOf, { timeout: 60_000 }).toBe(other);
      await expect.poll(() => page.evaluate(() => window.__studio.player!.busy()), { timeout: 60_000 }).toBe(false);
      await page.waitForTimeout(800);
      await page.getByTestId('btn-undo').click();
      await expect.poll(modelOf, { timeout: 60_000 }).toBe(before);
      await expect.poll(() => page.evaluate(() => window.__studio.player!.busy()), { timeout: 60_000 }).toBe(false);
      await page.waitForTimeout(800);
      const f = await page.evaluate(() => {
        const w = window as unknown as { __frames: { n: number; black: number; min: number }; __stop?: boolean };
        w.__stop = true;
        return w.__frames;
      });
      expect(f.n, 'frames were sampled').toBeGreaterThan(30);
      expect(f.black, `black frames during costume change (darkest mean ${f.min.toFixed(1)})`).toBe(0);
      await page.screenshot({ path: '.verify/v011-costume.png' });
    } finally {
      await page.close();
      await request.delete(`/api/projects/${id}`);
    }
  });
});

// ---- AI status and failures (test-mode servers 5373 / 5374) ---------------------------------------------------
test.describe('AI settings and generation failures', () => {
  test.use({ baseURL: 'http://127.0.0.1:5373' });
  test.describe.configure({ mode: 'serial' });
  const STORY = fs.readFileSync('tests/fixtures/story-short.txt', 'utf8');
  let page: Page;
  // These tests never change the shared test server's settings (other specs run against it in parallel): the settings API is
  // mocked where a key is needed, and generation uses the rule engine.
  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  });
  const made: string[] = [];
  test.afterEach(async () => {
    // the one-click flow saves a project: remember it so it can be removed
    const id = await page.getByTestId('full-view').getAttribute('data-project', { timeout: 500 }).catch(() => null);
    if (id) made.push(id);
  });
  test.afterAll(async ({ request }) => {
    await page.close();
    for (const id of made) await request.delete(`/api/projects/${id}`);
  });

  const view = (over: Record<string, unknown>) => ({
    provider: 'anthropic', available: ['anthropic', 'openai'],
    anthropic: { hasKey: false, mask: null, source: null, model: 'claude-sonnet-5-5', baseUrl: '' },
    openai: { hasKey: false, mask: null, source: null, model: '', baseUrl: '' },
    status: { configured: false, provider: 'anthropic', model: null, verified: 'none', message: '未配置 AI：Anthropic 缺少 API key（请在设置中填写，或设置环境变量 ANTHROPIC_API_KEY）' },
    ...over,
  });

  test('a placeholder key is "not configured"; a real-looking key is "filled in, not verified" until a connection test; a failing test says so', async () => {
    let current = view({});
    await page.route('**/api/llm/settings', (r) => r.fulfill({ json: current }));
    await page.route('**/api/llm/test', async (r) => {
      current = view({
        anthropic: { hasKey: true, mask: 'sk-…0001', source: 'file', model: 'claude-sonnet-5-5', baseUrl: '' },
        status: { configured: true, provider: 'anthropic', model: 'claude-sonnet-5-5', verified: 'failed', message: '已填写配置，但最近一次调用失败（API key 无效或无权限（HTTP 401））：Claude · claude-sonnet-5-5。请检查 API key / 地址后点「测试连接」' },
      });
      await r.fulfill({ json: { ok: false, provider: 'anthropic', model: 'claude-sonnet-5-5', error: { kind: 'auth', message: 'API key 无效或无权限（HTTP 401）' } } });
    });
    await page.goto('/');
    await page.getByTestId('btn-settings').click();
    await expect(page.getByTestId('llm-status')).toContainText('未配置 AI');
    await expect(page.getByTestId('llm-status')).toHaveAttribute('data-verified', 'none');
    await expect(page.getByTestId('anthropic-key-state')).toHaveText('未配置');
    await page.screenshot({ path: '.verify/v011-settings-placeholder.png' });
    await page.keyboard.press('Escape');

    current = view({
      anthropic: { hasKey: true, mask: 'sk-…0001', source: 'file', model: 'claude-sonnet-5-5', baseUrl: '' },
      status: { configured: true, provider: 'anthropic', model: 'claude-sonnet-5-5', verified: 'untested', message: '已填写配置，尚未验证：Claude · claude-sonnet-5-5（点「测试连接」确认 key 可用）' },
    });
    await page.route('**/api/llm/settings', (r) => (r.request().method() === 'PUT' ? r.fulfill({ json: current }) : r.fallback()));
    await page.getByTestId('btn-settings').click();
    await expect(page.getByTestId('llm-status')).toHaveAttribute('data-verified', 'untested');
    await expect(page.getByTestId('llm-status')).toContainText('尚未验证');
    await expect(page.getByTestId('anthropic-key-state')).toContainText('已填写 key');
    await page.getByTestId('btn-test-llm').click();
    await expect(page.getByTestId('test-result')).toContainText('连接失败');
    await expect(page.getByTestId('llm-status')).toHaveAttribute('data-verified', 'failed');
    await expect(page.getByTestId('llm-status')).toContainText('最近一次调用失败');
    await page.screenshot({ path: '.verify/v011-settings-failed.png' });
    await page.keyboard.press('Escape');
    await page.unroute('**/api/llm/settings');
    await page.unroute('**/api/llm/test');
  });

  async function openDialogWithStory() {
    await page.goto('/');
    await page.getByTestId('btn-ai-breakdown').click();
    await page.getByTestId('ai-title').fill('失败演示');
    await page.getByTestId('ai-source').fill(STORY);
    await page.getByTestId('ai-engine').selectOption('rule');
  }
  const sse = (events: Array<[string, unknown]>) => events.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join('');

  test('401 on the first call: a clear error with the fix, never "all scenes generated" or a continuity pass', async () => {
    await page.route('**/api/director/breakdown', (r: Route) =>
      r.fulfill({ status: 502, contentType: 'application/json', body: JSON.stringify({ error: { kind: 'auth', message: 'API key 无效或无权限（HTTP 401）：invalid x-api-key' } }) }));
    await openDialogWithStory();
    await page.getByTestId('ai-full').click();
    await expect(page.getByTestId('ai-error')).toContainText('API key 无效或无权限');
    await expect(page.getByTestId('full-fix')).toContainText('API key 无效或未配置 → 打开 AI 设置');
    await expect(page.getByTestId('full-stage')).toContainText('生成失败');
    await expect(page.getByTestId('full-stage')).not.toContainText('全部场景已生成');
    await expect(page.getByTestId('full-done')).toHaveCount(0);
    await expect(page.getByText('连续性检查：未发现问题')).toHaveCount(0);
    await page.screenshot({ path: '.verify/v011-gen-401.png' });
    await page.getByTestId('full-open-settings').click();
    await expect(page.getByTestId('settings-dialog')).toBeVisible();
    await page.keyboard.press('Escape');
    await page.unroute('**/api/director/breakdown');
  });

  test('401 on every scene after a good breakdown: every scene is listed as failed, with the fix and a retry', async () => {
    await page.route('**/api/director/scenes', async (r: Route) => {
      const sceneIds = (JSON.parse(r.request().postData()!) as { project: { scenes: Array<{ id: string; title: string }> } }).project.scenes;
      await r.fulfill({
        status: 200, contentType: 'text/event-stream',
        body: sse([
          ...sceneIds.flatMap((s) => [['progress', { sceneId: s.id, title: s.title, state: 'start' }], ['progress', { sceneId: s.id, title: s.title, state: 'error', kind: 'auth', message: 'API key 无效或无权限（HTTP 401）' }]] as Array<[string, unknown]>),
          ['done', { items: sceneIds.map((s) => ({ sceneId: s.id, error: { kind: 'auth', message: 'API key 无效或无权限（HTTP 401）' } })) }],
        ]),
      });
    });
    await openDialogWithStory();
    await page.getByTestId('ai-full').click();
    await expect(page.getByTestId('full-failures')).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId('full-failed-scene').first()).toContainText('API key 无效或无权限');
    await expect(page.getByTestId('full-stage')).toContainText('0 个场景成功');
    await expect(page.getByTestId('full-fix')).toContainText('打开 AI 设置');
    await expect(page.getByTestId('full-resume')).toContainText('重试失败场景');
    await expect(page.getByTestId('full-done')).toHaveCount(0);
    await page.screenshot({ path: '.verify/v011-gen-all-failed.png' });
    await page.unroute('**/api/director/scenes');
  });

  test('partial failure: successes and failures are listed separately, and retrying runs only the failed scenes', async () => {
    let failIds: string[] = [];
    await page.route('**/api/director/scenes', async (r: Route) => {
      const real = await r.fetch();
      const text = await real.text();
      const blocks = text.split('\n\n').filter(Boolean);
      const body = JSON.parse(r.request().postData()!) as { project: { scenes: Array<{ id: string }> } };
      failIds = body.project.scenes.slice(1, 3).map((s) => s.id); // the 2nd and 3rd scene "time out" (of 4)
      const out = blocks.flatMap((b) => {
        const ev = /^event: (\w+)/m.exec(b)![1]!;
        const data = JSON.parse(/^data: (.*)$/m.exec(b)![1]!) as { sceneId?: string; title?: string; state?: string; items?: Array<{ sceneId: string }> };
        if (ev === 'progress' && data.sceneId && failIds.includes(data.sceneId)) {
          return data.state === 'start' ? [b] : [`event: progress\ndata: ${JSON.stringify({ sceneId: data.sceneId, title: data.title, state: 'error', kind: 'timeout', message: '请求超时（120 秒无响应）' })}`];
        }
        if (ev === 'done') return [`event: done\ndata: ${JSON.stringify({ items: (data.items ?? []).filter((i) => !failIds.includes(i.sceneId)) })}`];
        return [b];
      });
      await r.fulfill({ status: 200, contentType: 'text/event-stream', body: `${out.join('\n\n')}\n\n` });
    });
    await openDialogWithStory();
    await page.getByTestId('ai-full').click();
    await expect(page.getByTestId('full-failures')).toBeVisible({ timeout: 120_000 });
    await expect(page.getByTestId('full-failed-scene')).toHaveCount(2);
    await expect(page.getByTestId('full-failed-scene').first()).toContainText('请求超时');
    await expect(page.getByTestId('full-succeeded')).toContainText('已成功');
    await expect(page.getByTestId('full-stage')).toContainText(/\d+ 个场景成功，2 个失败/);
    await expect(page.getByTestId('full-done')).toHaveCount(0);
    await expect(page.getByTestId('full-resume')).toContainText('重试失败场景（2）');
    await page.screenshot({ path: '.verify/v011-gen-partial.png' });
    // retry: only the two failed scenes are sent, and now everything is reported as done
    await page.unroute('**/api/director/scenes');
    const sent = page.waitForRequest((q) => q.url().endsWith('/api/director/scenes'));
    await page.getByTestId('full-resume').click();
    const req = await sent;
    expect((JSON.parse(req.postData()!) as { sceneIds: string[] }).sceneIds.sort()).toEqual([...failIds].sort());
    await expect(page.getByTestId('full-done')).toBeVisible({ timeout: 120_000 });
    await expect(page.getByTestId('full-stage')).toContainText('全部场景已生成');
    await expect(page.getByTestId('full-failures')).toHaveCount(0);
    await page.screenshot({ path: '.verify/v011-gen-retried.png' });
  });
});
