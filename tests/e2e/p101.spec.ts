/**
 * P10.1 (third acceptance F1-F8) in a real browser: background scale reaches the renderer, locks hold on every edit
 * path, dragging a person in an automatic shot moves them on screen, the wheel needs Alt, insert shots have a target
 * box, edit -> preview latency, Chinese labels / flat lock icons / no clipped labels, the wide play window.
 */
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { beatStart, center, dragBy, openDemoEditor, playing, seekTo, settled, stateOf } from './helpers/editor';
import { tab } from './helpers/ui';

test.describe.configure({ mode: 'serial' });
test.setTimeout(240_000);

let page: Page;
let projectId = '';
const errors: string[] = [];

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(e.message));
  projectId = await openDemoEditor(page, 'P10.1');
});
test.afterAll(async ({ request }: { request: APIRequestContext }) => {
  await page.close();
  await request.delete(`/api/projects/${projectId}`);
});

const undo = () => page.getByTestId('btn-undo').click();
const toast = () => page.getByTestId('toast');
const camera = () => page.evaluate(() => window.__studio.getCamera()!);
const lockOf = (testid: string, row: string) => page.getByTestId(testid).locator('.row', { hasText: row }).locator('button.lock');

test('F1: the background layer is magnified by the style table value (not zoom^0.85), and the field is live', async () => {
  await seekTo(page, (await beatStart(page, 's1b3')) + 0.8); // two-shot
  const c = await camera();
  expect(Math.abs(c.bgViewZoom! / 1.45 - 1)).toBeLessThan(0.03);
  expect(c.zoom).toBeGreaterThan(c.bgViewZoom! * 1.5); // the people are much bigger than the background
  // another table value shows up at once (set through the player, which the editor does for every project change)
  const p = await playing(page);
  const edited = { ...p, style: { ...p.style, overrides: { ...p.style.overrides, 'shots.two_shot.bgZoom': 2.2 } } };
  await page.evaluate((x) => window.__studio.player!.reload(x), edited);
  await settled(page);
  expect(Math.abs((await camera()).bgViewZoom! / 2.2 - 1)).toBeLessThan(0.03);
  await page.evaluate((x) => window.__studio.player!.reload(x), p);
  await settled(page);
  expect(Math.abs((await camera()).bgViewZoom! / 1.45 - 1)).toBeLessThan(0.03);
});

test('F2: a locked costume refuses the change (with an unlock button), also from the inspector scene tab', async () => {
  await seekTo(page, (await beatStart(page, 's1b3')) + 0.8);
  await tab(page, 'scene');
  const sel = page.getByTestId('insp-wardrobe-c_002');
  const before = await sel.inputValue();
  await lockOf('insp-cast-c_002', '服装').click();
  const other = (await sel.locator('option').evaluateAll((o) => o.map((x) => (x as HTMLOptionElement).value))).find((v) => v !== before)!;
  await sel.selectOption(other);
  await expect(toast()).toContainText('已锁定');
  await expect(sel).toHaveValue(before);
  expect((await playing(page)).scenes[0]!.wardrobe.c_002!.modelId).toBe(before);
  await page.getByTestId('toast-action').click(); // 解锁
  await expect(lockOf('insp-cast-c_002', '服装')).toHaveAttribute('aria-pressed', 'false');
  await sel.selectOption(other);
  await expect.poll(async () => (await playing(page)).scenes[0]!.wardrobe.c_002!.modelId, { timeout: 60_000 }).toBe(other);
  await undo();
  await expect.poll(async () => (await playing(page)).scenes[0]!.wardrobe.c_002!.modelId, { timeout: 60_000 }).toBe(before);
});

test('F2: a locked line refuses text edits in the inspector and the script panel, and refuses deletion; unlocking always works', async () => {
  await page.getByTestId('outline-beat-s1b3').click();
  const text0 = (await playing(page)).scenes[0]!.beats.find((b) => b.id === 's1b3')!.text;
  await tab(page, 'beat');
  await lockOf('insp-beat', '类型').click();
  await page.getByTestId('insp-beat-text').fill('不该被写入');
  await expect(toast()).toContainText('已锁定');
  await expect(page.getByTestId('insp-beat-text')).toHaveValue(text0);
  await page.getByTestId('script-text').fill('也不该被写入');
  await expect(page.getByTestId('script-text')).toHaveValue(text0);
  expect((await playing(page)).scenes[0]!.beats.find((b) => b.id === 's1b3')!.text).toBe(text0);
  await page.getByTestId('script-del-beat').click();
  await expect(toast()).toContainText('无法删除');
  expect((await playing(page)).scenes[0]!.beats.some((b) => b.id === 's1b3')).toBe(true);
  await page.getByTestId('toast-action').click();
  await expect(lockOf('insp-beat', '类型')).toHaveAttribute('aria-pressed', 'false');
  await page.getByTestId('insp-beat-text').fill('现在可以了');
  await expect.poll(async () => (await playing(page)).scenes[0]!.beats.find((b) => b.id === 's1b3')!.text, { timeout: 20_000 }).toBe('现在可以了');
  await page.getByTestId('insp-beat-text').blur();
  await undo();
});

test('F2: deleting a line that carries a locked key is refused', async () => {
  await seekTo(page, (await beatStart(page, 's1b3')) + 0.8);
  await page.getByTestId('outline-beat-s1b3').click();
  await page.getByTestId('actor-hit-c_002').click({ position: { x: 30, y: 60 } });
  const bar = page.getByTestId('quickbar');
  const cur = (await stateOf(page)).actors.find((a) => a.castId === 'c_002')!.expression;
  const next = (await bar.getByTestId('actor-expression').locator('option').evaluateAll((o) => o.map((x) => (x as HTMLOptionElement).value).filter(Boolean))).find((v) => v !== cur)!;
  await bar.getByTestId('actor-expression').selectOption(next);
  await page.waitForTimeout(1000);
  await expect.poll(async () => (await playing(page)).scenes[0]!.tracks.some((t) => t.channel === 'expression' && t.keys.some((k) => k.at.beatId === 's1b3')), { timeout: 20_000 }).toBe(true);
  await tab(page, 'actor');
  await page.getByTestId('insp-actor-controls').locator('.row', { hasText: '表情' }).first().locator('button.lock').click();
  await page.getByTestId('outline-beat-s1b3').click();
  await page.getByTestId('script-del-beat').click();
  await expect(toast()).toContainText('无法删除');
  expect((await playing(page)).scenes[0]!.beats.some((b) => b.id === 's1b3')).toBe(true);
  await page.getByTestId('toast-action').click();
  await page.getByTestId('script-del-beat').click();
  await expect.poll(async () => (await playing(page)).scenes[0]!.beats.some((b) => b.id === 's1b3'), { timeout: 20_000 }).toBe(false);
  await undo();
  await expect.poll(async () => (await playing(page)).scenes[0]!.beats.some((b) => b.id === 's1b3'), { timeout: 20_000 }).toBe(true);
});

test('F3 / F4: dragging a person in an automatic two-shot moves them on screen; the bare wheel edits nothing, Alt+wheel changes the depth', async () => {
  await seekTo(page, (await beatStart(page, 's1b3')) + 0.8);
  await page.getByTestId('actor-hit-c_002').click({ position: { x: 30, y: 60 } });
  await expect(page.getByTestId('stage-hint')).toContainText('画面位置');
  const head = page.locator('.head-box');
  const x0 = (await center(head)).x;
  const c = await center(page.getByTestId('actor-hit-c_002'));
  await page.mouse.move(c.x, c.y);
  await page.mouse.down();
  await page.mouse.move(c.x - 150, c.y, { steps: 6 });
  await page.mouse.move(c.x - 300, c.y, { steps: 6 });
  await settled(page);
  const mid = (await center(head)).x;
  expect(Math.abs(mid - x0)).toBeGreaterThan(250); // follows the hand during the drag
  await page.mouse.up();
  await settled(page);
  expect(Math.abs((await center(head)).x - x0)).toBeGreaterThan(250); // and stays there
  const off = (await playing(page)).scenes[0]!.beats.find((b) => b.id === 's1b3')!.shot.offsets?.c_002;
  expect(off).toBeTruthy();
  await undo();
  await settled(page);

  // F4: bare wheel over a person = no edit; Alt + wheel = depth
  const p0 = JSON.stringify(await playing(page));
  const c2 = await center(page.getByTestId('actor-hit-c_002'));
  await page.mouse.move(c2.x, c2.y);
  await page.mouse.wheel(0, 240);
  await page.waitForTimeout(600);
  expect(JSON.stringify(await playing(page))).toBe(p0);
  await page.keyboard.down('Alt');
  await page.mouse.wheel(0, 240);
  await page.keyboard.up('Alt');
  await expect(toast()).toContainText('纵深');
  await expect.poll(async () => JSON.stringify(await playing(page)), { timeout: 20_000 }).not.toBe(p0);
  await undo();
});

test('F3: the camera tool on the establishing shot says there is nothing to edit instead of changing line 1', async () => {
  await seekTo(page, (await page.evaluate(() => window.__studio.player!.beatStarts()['s1:est']!)) + 0.5);
  const p0 = JSON.stringify(await playing(page));
  await page.getByTestId('tool-camera').click();
  const box = (await page.getByTestId('stage-overlay').boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, -300);
  await expect(toast()).toContainText('空镜头');
  await dragBy(page, { x: box.x + 80, y: box.y + 80 }, 60);
  expect(JSON.stringify(await playing(page))).toBe(p0);
  await page.getByTestId('tool-select').click();
});

test('F5: an insert shot has a target box that the camera follows', async () => {
  await seekTo(page, (await beatStart(page, 's1b3')) + 0.8);
  await page.getByTestId('outline-beat-s1b3').click();
  await seekTo(page, (await beatStart(page, 's1b3')) + 2.5); // past the entrance glide of this shot
  await tab(page, 'shot');
  await page.getByTestId('insp-shot-type').selectOption('insert');
  await expect(page.getByTestId('insp-insert-y')).toBeVisible();
  await expect.poll(async () => (await playing(page)).scenes[0]!.beats.find((b) => b.id === 's1b3')!.shot.type, { timeout: 20_000 }).toBe('insert');
  await settled(page);
  const a = await camera();
  await page.getByTestId('insp-insert-y').fill('0.2');
  await page.getByTestId('insp-insert-y').blur();
  await expect.poll(async () => (await camera()).y, { timeout: 20_000 }).toBeLessThan(a.y - 2);
  for (const k of ['w', 'h']) {
    await page.getByTestId(`insp-insert-${k}`).fill('0.1');
    await page.getByTestId(`insp-insert-${k}`).blur();
  }
  await expect.poll(async () => (await camera()).zoom, { timeout: 20_000 }).toBeGreaterThan(a.zoom * 1.5);
  await page.screenshot({ path: '.verify/p101-insert.png' });
  for (let i = 0; i < 4; i++) await undo();
});

test('F7: choosing an expression shows in the preview in well under 120 ms', async () => {
  await seekTo(page, (await beatStart(page, 's1b3')) + 0.8);
  await page.getByTestId('actor-hit-c_002').click({ position: { x: 30, y: 60 } });
  const bar = page.getByTestId('quickbar');
  const opts = await bar.getByTestId('actor-expression').locator('option').evaluateAll((o) => o.map((x) => (x as HTMLOptionElement).value).filter(Boolean));
  const times: number[] = [];
  for (let i = 0; i < 4; i++) {
    const cur = (await stateOf(page)).actors.find((a) => a.castId === 'c_002')!.expression;
    const next = opts.filter((o) => o !== cur)[i % 3]!;
    await page.evaluate(() => {
      const w = window as unknown as { __lat?: Promise<number> };
      const sel = document.querySelector('[data-testid="quickbar"] [data-testid="actor-expression"]') as HTMLSelectElement;
      w.__lat = new Promise((resolve) => {
        sel.addEventListener('change', () => {
          const t0 = performance.now();
          const tick = () => {
            const a = window.__studio.player!.state()!.actors.find((x) => x.castId === 'c_002');
            if (a && a.expression === sel.value) resolve(performance.now() - t0);
            else if (performance.now() - t0 > 3000) resolve(3000);
            else requestAnimationFrame(tick);
          };
          tick();
        }, { once: true, capture: true });
      });
    });
    await bar.getByTestId('actor-expression').selectOption(next);
    times.push(await page.evaluate(() => (window as unknown as { __lat: Promise<number> }).__lat));
    await settled(page);
  }
  console.log('expression -> preview ms', times.map((t) => Math.round(t)).join(' '));
  const sorted = [...times].sort((a, b) => a - b);
  expect(sorted[Math.floor(sorted.length / 2)]!).toBeLessThan(120);
  for (let i = 0; i < 4; i++) await undo();
});

test('F8: Chinese labels, flat lock icons, no clipped transition label, the timeline scrolls to the selected person', async () => {
  await seekTo(page, (await beatStart(page, 's1b3')) + 0.8);
  const timeline = page.getByTestId('bottom-panel');
  const t = await timeline.innerText();
  for (const raw of ['establishing', 'silent', 'two_shot', 'mcu', 'exp_', 'mtn_', 'dof ']) expect(t, `timeline shows ${raw}`).not.toContain(raw);
  expect(await page.getByTestId('workspace').innerText()).not.toMatch(/🔒|🔓/);
  // a lock button is an svg icon
  await tab(page, 'beat');
  await expect(lockOf('insp-beat', '类型').locator('svg.lock-icon')).toBeVisible();
  // transition block: either the full label fits or it shows the glyph with a tooltip, never a clipped fragment
  const tr = page.getByTestId('tl-transition');
  const label = (await tr.innerText()).trim();
  expect(['◐', '硬切'].includes(label) || /^[一-龥]{2,}/.test(label)).toBe(true);
  expect(await tr.getAttribute('title')).toContain('转场');
  // selecting a person opens and scrolls to their group
  await page.getByTestId('actor-hit-c_002').click({ position: { x: 30, y: 60 } });
  const group = page.getByTestId('tl-group-actor:c_002');
  await expect(group).toBeVisible();
  const g = (await group.boundingBox())!;
  const tb = (await timeline.boundingBox())!;
  expect(g.y).toBeGreaterThanOrEqual(tb.y - 2);
  expect(g.y).toBeLessThan(tb.y + tb.height);
  // storyboard: short Chinese names only
  await page.getByTestId('view-storyboard').click();
  const sb = await page.getByTestId('sb-type-s1b1').innerText();
  expect(sb).not.toMatch(/two_shot|establishing|mcu|\bcu\b/);
  expect(await page.getByTestId('workspace').innerText()).not.toMatch(/🔒|🔓/);
  await page.screenshot({ path: '.verify/p101-storyboard.png' });
  await page.getByTestId('view-preview').click();
  await page.screenshot({ path: '.verify/p101-editor.png' });
});

test('E4: the play page has a wide frame option and fits the window', async ({ browser }) => {
  const p = await browser.newPage({ viewport: { width: 1920, height: 890 } });
  await p.goto('/play/demo');
  await expect(p.getByTestId('play-status')).toHaveText('就绪', { timeout: 180_000 });
  const r0 = (await p.getByTestId('play-stage').boundingBox())!;
  expect(r0.width / r0.height).toBeCloseTo(16 / 9, 1);
  await p.getByTestId('play-aspect').selectOption({ label: '宽画幅 2.16:1' });
  await expect(p.getByTestId('play-status')).toHaveText('就绪', { timeout: 180_000 });
  const r1 = (await p.getByTestId('play-stage').boundingBox())!;
  expect(r1.width / r1.height).toBeCloseTo(1920 / 890, 1);
  expect(r1.width).toBeGreaterThan(r0.width);
  await p.evaluate(() => window.__studio.player!.seek(8.8));
  await p.waitForTimeout(2500);
  await p.screenshot({ path: '.verify/p101-play-wide.png' });
  const canvas = (await p.getByTestId('play-canvas').boundingBox())!;
  expect(canvas.width / canvas.height).toBeCloseTo(1920 / 890, 1);
  await p.close();
});

test('no console errors', () => {
  expect(errors.filter((e) => !/Failed to load resource/.test(e))).toEqual([]);
});
