/**
 * The dockable layout: every pane is a dock panel. Drag a tab to re-dock it, drag a divider to resize (the stage follows),
 * maximise a panel, presets and 「重置布局」, the layout is remembered per user and a broken saved layout falls back to the default.
 * One shared page / project (loading the models takes a while).
 */
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { openDemoEditor } from './helpers/editor';

test.describe.configure({ mode: 'serial' });
test.setTimeout(240_000);

let page: Page;
let projectId = '';
const errors: string[] = [];
const KEY = 'studio.dock.layout';

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(e.message));
  projectId = await openDemoEditor(page, 'Dock 布局');
});
test.afterAll(async ({ request }: { request: APIRequestContext }) => {
  await page.close();
  await request.delete(`/api/projects/${projectId}`);
  expect(errors.filter((e) => !/favicon|Failed to load resource/.test(e))).toEqual([]);
});

const box = async (testid: string) => (await page.getByTestId(testid).boundingBox())!;
const reload = async () => {
  await page.reload();
  await expect(page.getByTestId('workspace')).toBeVisible();
  await expect(page.getByTestId('play-status')).toHaveText('就绪', { timeout: 180_000 });
};
const stored = () => page.evaluate((k) => localStorage.getItem(k), KEY);
const menu = async (item: string) => {
  await page.getByTestId('btn-layout').click();
  await page.getByTestId(item).click();
};
/** The stage frame is 16:9 and sits inside its area, whatever the dock did. */
async function stageFits() {
  const frame = await box('stage-frame');
  const outer = (await page.locator('.viewport').boundingBox())!;
  const pad = await page.locator('.viewport').evaluate((el) => {
    const cs = getComputedStyle(el);
    return { w: parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight), h: parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom) };
  });
  const area = { width: outer.width - pad.w, height: outer.height - pad.h };
  expect(Math.abs(frame.width / frame.height / (16 / 9) - 1)).toBeLessThan(0.005);
  expect(frame.width).toBeLessThanOrEqual(area.width + 1);
  expect(frame.height).toBeLessThanOrEqual(area.height + 1);
  expect(Math.min(area.width - frame.width, area.height - frame.height)).toBeLessThan(2);
}
async function drag(from: { x: number; y: number }, to: { x: number; y: number }) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 6 });
  await page.mouse.move(to.x, to.y, { steps: 6 });
  await page.mouse.up();
}

test('the default layout: script left, stage centre, inspector right (with the AI panel as a tab behind it), timeline below; the layout is saved', async () => {
  const [left, stage, right, bottom] = [await box('left-panel'), await box('preview'), await box('right-panel'), await box('bottom-panel')];
  expect(left.x + left.width).toBeLessThanOrEqual(stage.x + 1);
  expect(stage.x + stage.width).toBeLessThanOrEqual(right.x + 1);
  expect(bottom.y).toBeGreaterThanOrEqual(stage.y + stage.height - 1);
  await expect(page.getByTestId('dock-tab-storyboard')).toBeVisible(); // the storyboard is a tab next to the preview
  await expect(page.getByTestId('dock-tab-agent').locator('.dock-tab-title')).toHaveText('AI'); // the one AI panel (generation + assistant) is in the layout ...
  await expect(page.getByTestId('agent-dock')).toHaveCount(0); // ... behind the inspector's tab
  await expect(page.getByTestId('dock-tab-inspector')).toBeVisible();
  await expect(page.getByTestId('tab-ai')).toHaveCount(0); // the left group no longer has an AI 导演 tab
  await stageFits();
  await expect.poll(stored).not.toBeNull();
});

test('resizing a divider resizes the stage (the canvas keeps its shape)', async () => {
  const before = (await page.locator('.viewport').boundingBox())!;
  const frameBefore = await box('stage-frame');
  const sashes = page.locator('.dock-root .dv-sash');
  // the vertical divider between the script panel and the stage: drag it right
  const count = await sashes.count();
  let moved = false;
  for (let i = 0; i < count; i++) {
    const b = (await sashes.nth(i).boundingBox())!;
    if (b.height > b.width && Math.abs(b.x - (await box('left-panel')).x - (await box('left-panel')).width) < 6) {
      await drag({ x: b.x + b.width / 2, y: b.y + b.height / 2 }, { x: b.x + b.width / 2 + 220, y: b.y + b.height / 2 });
      moved = true;
      break;
    }
  }
  expect(moved).toBe(true);
  await page.waitForTimeout(300);
  const after = (await page.locator('.viewport').boundingBox())!;
  expect(after.width).toBeLessThan(before.width - 100);
  await stageFits();
  const frameAfter = await box('stage-frame');
  expect(frameAfter.width).toBeLessThan(frameBefore.width);
  // the canvas has its own pixel size (no blur: it is scaled by CSS only)
  const px = await page.getByTestId('play-canvas').evaluate((c) => ({ w: (c as HTMLCanvasElement).width, h: (c as HTMLCanvasElement).height }));
  expect(px.w / px.h).toBeCloseTo(16 / 9, 2);
  // the timeline divider: drag it up, the stage gets shorter and the frame follows
  for (let i = 0; i < count; i++) {
    const b = (await sashes.nth(i).boundingBox())!;
    if (b.width > b.height && b.width > 800) {
      await drag({ x: b.x + b.width / 2, y: b.y + b.height / 2 }, { x: b.x + b.width / 2, y: b.y + b.height / 2 - 120 });
      break;
    }
  }
  await page.waitForTimeout(300);
  await stageFits();
  expect((await box('stage-frame')).height).toBeLessThan(frameAfter.height);
});

test('dock the AI panel to another side by dragging its tab; it survives a reload', async () => {
  await page.locator('body').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('Control+k');
  await expect(page.getByTestId('agent-dock')).toBeVisible();
  const stage0 = await box('preview');
  expect((await box('agent-dock')).x).toBeGreaterThan(stage0.x); // comes to the front of the right group (the inspector's tab goes behind it)
  await expect(page.getByTestId('right-panel')).toHaveCount(0);
  // drag the assistant's tab onto the left edge of the script panel
  const tab = (await page.getByTestId('dock-tab-agent').boundingBox())!;
  const left = await box('left-panel');
  await drag({ x: tab.x + tab.width / 3, y: tab.y + tab.height / 2 }, { x: left.x + 12, y: left.y + left.height / 2 });
  await expect.poll(async () => (await box('agent-dock')).x, { timeout: 10_000 }).toBeLessThan((await box('left-panel')).x);
  await stageFits();
  await expect.poll(async () => (await stored()) ?? '').toContain('"agent"');
  await page.waitForTimeout(500); // the layout is saved a moment after the change
  await reload();
  await expect(page.getByTestId('agent-dock')).toBeVisible();
  expect((await box('agent-dock')).x).toBeLessThan((await box('left-panel')).x);
  expect((await box('left-panel')).x).toBeLessThan((await box('preview')).x);
});

test('a panel can be closed and brought back from the layout menu; the stage and the timeline cannot be closed', async () => {
  await page.getByTestId('dock-close-inspector').click();
  await expect(page.getByTestId('right-panel')).toHaveCount(0);
  await expect(page.getByTestId('btn-layout')).toBeVisible();
  await page.getByTestId('btn-layout').click();
  await expect(page.getByTestId('layout-toggle-stage')).toBeDisabled();
  await expect(page.getByTestId('layout-toggle-timeline')).toBeDisabled();
  await page.getByTestId('layout-toggle-inspector').check();
  await expect(page.getByTestId('right-panel')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('dock-close-stage')).toHaveCount(0);
  await stageFits();
});

test('maximise a panel temporarily, then restore', async () => {
  const left = await box('left-panel');
  await page.getByTestId('dock-max-stage').click();
  await expect(page.getByTestId('left-panel')).toBeHidden();
  const max = await box('preview');
  expect(max.width).toBeGreaterThan(left.width + 400);
  await stageFits();
  await page.getByTestId('dock-max-stage').click();
  await expect(page.getByTestId('left-panel')).toBeVisible();
  await stageFits();
});

test('the storyboard tab and the 预览 / 分镜 buttons stay in step', async () => {
  await page.getByTestId('view-storyboard').click();
  await expect(page.getByTestId('storyboard')).toBeVisible();
  await expect(page.getByTestId('dock-tab-storyboard')).toBeVisible();
  await page.getByTestId('dock-tab-stage').click();
  await expect(page.getByTestId('view-preview')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('storyboard')).toHaveCount(0);
  await stageFits();
});

test('presets: 「AI 工作」 puts the script, the stage and the AI panel side by side; 「重置布局」 restores the default (the AI panel behind the inspector tab)', async () => {
  await menu('layout-preset-ai-work');
  await expect(page.getByTestId('agent-dock')).toBeVisible();
  const [left, stage, agent] = [await box('left-panel'), await box('preview'), await box('agent-dock')];
  expect(left.x + left.width).toBeLessThanOrEqual(stage.x + 1);
  expect(stage.x + stage.width).toBeLessThanOrEqual(agent.x + 1);
  await expect(page.getByTestId('right-panel')).toBeHidden(); // the inspector is a background tab of the assistant's group
  await stageFits();
  await page.screenshot({ path: '.verify/dock-ai-work.png' });
  await menu('layout-reset');
  await expect(page.getByTestId('right-panel')).toBeVisible();
  await expect(page.getByTestId('agent-dock')).toHaveCount(0);
  const [l2, s2, r2, b2] = [await box('left-panel'), await box('preview'), await box('right-panel'), await box('bottom-panel')];
  expect(l2.x + l2.width).toBeLessThanOrEqual(s2.x + 1);
  expect(s2.x + s2.width).toBeLessThanOrEqual(r2.x + 1);
  expect(b2.y).toBeGreaterThanOrEqual(s2.y + s2.height - 1);
  await expect(page.getByTestId('dock-tab-agent')).toBeVisible(); // still in the layout: one click on its tab brings it to the front
  await stageFits();
  await page.waitForTimeout(500);
  await reload();
  expect((await box('left-panel')).x).toBeLessThan((await box('preview')).x);
});

test('a layout saved before the AI panel was one panel (version 1, no AI panel) still loads; the AI panel is added back behind the inspector', async () => {
  await page.evaluate((k) => {
    type Node = { type: string; data: { views: string[]; activeView?: string } | Node[] };
    const saved = JSON.parse(localStorage.getItem(k)!) as { v: number; layout: { panels: Record<string, unknown>; grid: { root: Node } } };
    saved.v = 1;
    delete saved.layout.panels.agent;
    const visit = (n: Node): void => {
      if (n.type === 'leaf') {
        const d = n.data as { views: string[]; activeView?: string };
        d.views = d.views.filter((v) => v !== 'agent');
        if (d.activeView === 'agent') d.activeView = d.views[0]!;
      } else (n.data as Node[]).forEach(visit);
    };
    visit(saved.layout.grid.root);
    localStorage.setItem(k, JSON.stringify(saved));
  }, KEY);
  await reload();
  await expect(page.getByTestId('left-panel')).toBeVisible();
  await expect(page.getByTestId('dock-tab-agent').locator('.dock-tab-title')).toHaveText('AI');
  await expect(page.getByTestId('right-panel')).toBeVisible();
  await stageFits();
  // written back as the current version (and the AI panel opens from its tab)
  await expect.poll(async () => (JSON.parse((await stored()) ?? '{}') as { v?: number }).v).toBe(2);
  await page.getByTestId('dock-tab-agent').locator('.dock-tab-title').click(); // the title, not the tab's ✕
  await expect(page.getByTestId('agent-dock')).toBeVisible();
  await page.getByTestId('dock-tab-inspector').locator('.dock-tab-title').click();
  await expect(page.getByTestId('right-panel')).toBeVisible();
});

test('a broken or outdated saved layout falls back to the default; blocked storage does not break the editor', async () => {
  for (const bad of ['not json', '{"v":1,"layout":{"grid":{}}}', JSON.stringify({ v: 1, layout: { grid: { root: { type: 'leaf', data: { views: ['ghost'], id: 'x' } }, width: 800, height: 600, orientation: 'HORIZONTAL' }, panels: { ghost: { id: 'ghost', contentComponent: 'ghost' } } } })]) {
    await page.evaluate(([k, v]) => localStorage.setItem(k!, v!), [KEY, bad]);
    await reload();
    await expect(page.getByTestId('left-panel')).toBeVisible();
    await expect(page.getByTestId('preview')).toBeVisible();
    await expect(page.getByTestId('bottom-panel')).toBeVisible();
    await stageFits();
  }
  // storage that throws on every access
  await page.addInitScript(() => {
    const boom = () => {
      throw new Error('blocked');
    };
    Object.defineProperty(window, 'localStorage', { get: boom, configurable: true });
  });
  await page.reload();
  await expect(page.getByTestId('workspace')).toBeVisible();
  await expect(page.getByTestId('play-status')).toHaveText('就绪', { timeout: 180_000 });
  await expect(page.getByTestId('left-panel')).toBeVisible();
  await stageFits();
});
