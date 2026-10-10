/**
 * P9 in a real browser: script editing, direct manipulation on the preview (move a person, turn the head, expression,
 * costume, camera), locks, undo / redo, style units and presets, overlays, keyboard, layout at two window sizes.
 * One shared page / project for the preview-driven tests (loading the models takes a while).
 */
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import type { Project } from '../../shared/schema/project';
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
  projectId = await openDemoEditor(page, 'P9 编辑');
});
test.afterAll(async ({ request }: { request: APIRequestContext }) => {
  await page.close();
  await request.delete(`/api/projects/${projectId}`);
});

const actor = async (id: string) => (await stateOf(page)).actors.find((a) => a.castId === id)!;
const undo = () => page.getByTestId('btn-undo').click();

test('moving a person on the preview changes the scene blocking (one undo step) and a locked blocking refuses', async () => {
  await seekTo(page, (await beatStart(page, 's1b3')) + 0.8);
  const before = (await playing(page)).scenes[0]!.blocking.c_002!;
  const hit = page.getByTestId('actor-hit-c_002');
  const c = await center(hit);
  await page.keyboard.down('Shift'); // in an automatic two-shot a plain drag sets the on-screen arrangement; Shift = blocking
  await dragBy(page, { x: c.x, y: c.y }, -120, 12);
  await page.keyboard.up('Shift');
  await expect.poll(async () => (await playing(page)).scenes[0]!.blocking.c_002!.slot, { timeout: 20_000 }).toBeLessThan(before.slot - 0.03);
  const moved = (await playing(page)).scenes[0]!.blocking.c_002!;
  expect(moved.meta.source).toBe('user');
  await expect(page.getByTestId('btn-undo')).toHaveAttribute('title', /调整角色位置/);
  await undo(); // the whole drag is a single step
  await expect.poll(async () => (await playing(page)).scenes[0]!.blocking.c_002!.slot, { timeout: 20_000 }).toBeCloseTo(before.slot, 3);
  await page.getByTestId('btn-redo').click();
  await expect.poll(async () => (await playing(page)).scenes[0]!.blocking.c_002!.slot, { timeout: 20_000 }).toBeCloseTo(moved.slot, 3);

  // lock the blocking in the scene tab: the same drag now does nothing and says why
  await tab(page, 'scene');
  await page.getByTestId('insp-slot-row-c_002').getByTitle('锁定', { exact: true }).click();
  await seekTo(page, (await beatStart(page, 's1b3')) + 0.8);
  const c2 = await center(page.getByTestId('actor-hit-c_002'));
  await page.keyboard.down('Shift');
  await dragBy(page, c2, -90);
  await page.keyboard.up('Shift');
  await expect(page.getByTestId('toast')).toContainText('站位已锁定');
  expect((await playing(page)).scenes[0]!.blocking.c_002!.slot).toBeCloseTo(moved.slot, 3);
  await tab(page, 'scene'); // dragging a person switched the inspector to the actor tab
  await page.getByTestId('insp-slot-row-c_002').getByTitle(/已锁定/).click(); // unlock again
});

test('head dial writes a head-angle key; a locked key refuses the next drag; expression / costume / gaze edit the person', async () => {
  await seekTo(page, (await beatStart(page, 's1b3')) + 0.8);
  await page.getByTestId('actor-hit-c_002').click({ position: { x: 30, y: 60 } });
  const knob = page.getByTestId('handle-yaw');
  const k0 = await center(knob);
  const yaw0 = (await actor('c_002')).desiredYaw;
  await dragBy(page, k0, 70);
  const angleKey = async () => ((await playing(page)).scenes[0]!.tracks.find((t) => t.channel === 'head' && t.target.kind === 'actor' && t.target.castId === 'c_002')?.keys ?? []).find((k) => (k.value as { mode?: string }).mode === 'angle');
  await expect.poll(async () => (await angleKey())?.id ?? null, { timeout: 20_000 }).not.toBeNull();
  await settled(page);
  expect((await actor('c_002')).desiredYaw).toBeGreaterThan(yaw0 + 0.1);

  // lock it from the actor tab (the head row shows the key's source and lock)
  await tab(page, 'actor');
  await page.getByTestId('insp-actor-controls').getByTestId('actor-row-head').getByTitle('锁定', { exact: true }).click();
  const yawLocked = (await actor('c_002')).desiredYaw;
  const k1 = await center(page.getByTestId('handle-yaw'));
  await dragBy(page, k1, -60);
  await expect(page.getByTestId('toast')).toContainText('已锁定');
  await settled(page);
  expect((await actor('c_002')).desiredYaw).toBeCloseTo(yawLocked, 2);
  // moving the other person leaves the locked head angle alone
  const other = await center(page.getByTestId('actor-hit-c_001'));
  await dragBy(page, other, 40);
  await settled(page);
  expect((await actor('c_002')).desiredYaw).toBeCloseTo(yawLocked, 2);
  await tab(page, 'actor');
  await page.getByTestId('pick-actor-c_002').click(); // dragging the other person selected her
  await page.getByTestId('insp-actor-controls').getByTestId('actor-row-head').getByTitle(/已锁定/).click(); // unlock

  // expression from the quick bar
  const bar = page.getByTestId('quickbar');
  await page.getByTestId('actor-hit-c_002').click({ position: { x: 30, y: 60 } });
  const opts = await bar.getByTestId('actor-expression').locator('option').evaluateAll((o) => o.map((x) => (x as HTMLOptionElement).value).filter(Boolean));
  const cur = (await actor('c_002')).expression;
  const next = opts.find((o) => o !== cur)!;
  await bar.getByTestId('actor-expression').selectOption(next);
  await expect.poll(async () => (await actor('c_002')).expression, { timeout: 20_000 }).toBe(next);

  // costume: the scene wardrobe changes the model that is on stage
  const modelBefore = (await actor('c_002')).modelId;
  const models = await bar.getByTestId('actor-wardrobe').locator('option').evaluateAll((o) => o.map((x) => (x as HTMLOptionElement).value));
  const other2 = models.find((m) => m !== modelBefore)!;
  await bar.getByTestId('actor-wardrobe').selectOption(other2);
  await expect.poll(async () => (await actor('c_002')).modelId, { timeout: 60_000 }).toBe(other2);
  await undo();
  await expect.poll(async () => (await actor('c_002')).modelId, { timeout: 60_000 }).toBe(modelBefore);

  // gaze ring: dragging it writes a gaze key with a direction
  await tab(page, 'actor');
  await page.getByTestId('actor-hit-c_002').click({ position: { x: 30, y: 60 } });
  const g = await center(page.getByTestId('handle-gaze'));
  await dragBy(page, g, 8, -4);
  await expect.poll(async () => (await playing(page)).scenes[0]!.tracks.some((t) => t.channel === 'gaze' && t.target.kind === 'actor' && t.target.castId === 'c_002' && t.keys.some((k) => 'x' in k.value)), { timeout: 20_000 }).toBe(true);
});

test('camera tool: dragging and the wheel make the shot hand-made, restore brings the solver back', async () => {
  await seekTo(page, (await beatStart(page, 's1b5')) + 0.5);
  await tab(page, 'shot');
  await expect(page.getByTestId('cam-state')).toHaveText('自动求解');
  await page.getByTestId('tool-camera').click();
  const box = (await page.getByTestId('stage-overlay').boundingBox())!;
  const zoom0 = (await stateOf(page)).camera.zoom;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, -200);
  await expect(page.getByTestId('cam-state')).toHaveText('手动取景');
  await expect.poll(async () => (await stateOf(page)).camera.zoom, { timeout: 20_000 }).toBeGreaterThan(zoom0 * 1.1);
  const x0 = (await stateOf(page)).camera.x;
  await dragBy(page, { x: box.x + 60, y: box.y + 60 }, 70);
  await expect.poll(async () => (await stateOf(page)).camera.x, { timeout: 20_000 }).toBeLessThan(x0 - 5);
  await undo();
  await undo();
  await expect(page.getByTestId('cam-state')).toHaveText('自动求解');
  await redoAll();
  await page.getByTestId('cam-restore').click();
  await expect(page.getByTestId('cam-state')).toHaveText('自动求解');
  await expect.poll(async () => (await stateOf(page)).camera.zoom, { timeout: 20_000 }).toBeCloseTo(zoom0, 2);
  await page.getByTestId('tool-select').click();
});

async function redoAll() {
  while (await page.getByTestId('btn-redo').isEnabled()) await page.getByTestId('btn-redo').click();
}

test('script editor: edit, add, copy, reorder, delete a line and add / remove a scene; every step undoes', async () => {
  const p0 = await playing(page);
  const ids = () => page.evaluate(() => window.__studio.player!.project().scenes[0]!.beats.map((b) => b.id));
  await page.getByTestId('outline-beat-s1b3').click();
  await page.getByTestId('script-text').fill('改过的台词。');
  await expect.poll(async () => (await playing(page)).scenes[0]!.beats.find((b) => b.id === 's1b3')!.text, { timeout: 20_000 }).toBe('改过的台词。');
  await page.getByTestId('script-add-beat').click();
  await expect.poll(async () => (await ids()).length, { timeout: 20_000 }).toBe(p0.scenes[0]!.beats.length + 1);
  const added = (await ids())[(await ids()).indexOf('s1b3') + 1]!;
  await page.getByTestId('script-copy-beat').click();
  await expect.poll(async () => (await ids()).length).toBe(p0.scenes[0]!.beats.length + 2);
  // drag the first line below the second
  await page.getByTestId('outline-item-s1b1').dragTo(page.getByTestId('outline-item-s1b3'));
  await expect.poll(async () => (await ids()).indexOf('s1b1'), { timeout: 20_000 }).toBeGreaterThan(1);
  await page.getByTestId(`outline-beat-${added}`).click();
  await page.getByTestId('script-del-beat').click();
  await expect.poll(async () => (await ids()).includes(added), { timeout: 20_000 }).toBe(false);
  // scenes
  const nScenes = p0.scenes.length;
  await page.getByTestId('btn-add-scene').click();
  await expect.poll(async () => (await playing(page)).scenes.length, { timeout: 60_000 }).toBe(nScenes + 1);
  const newScene = (await playing(page)).scenes.at(-1)!;
  await page.getByTestId(`btn-del-scene-${newScene.id}`).click();
  await expect.poll(async () => (await playing(page)).scenes.length, { timeout: 60_000 }).toBe(nScenes);
  // undo everything back to the start of this test
  for (let i = 0; i < 7; i++) if (await page.getByTestId('btn-undo').isEnabled()) await undo();
  await expect.poll(async () => JSON.stringify((await playing(page)).scenes[0]!.beats.map((b) => [b.id, b.text])), { timeout: 30_000 }).toBe(JSON.stringify(p0.scenes[0]!.beats.map((b) => [b.id, b.text])));
});

test('style: px@1080 display, copy / paste value, saved presets round-trip, project default from a lower layer', async () => {
  await tab(page, 'style');
  const proj = page.getByTestId('insp-style-project');
  await proj.getByRole('button', { name: /风格预设（全局）/ }).click();
  await page.getByTestId('insp-style-group-project-对话区').getByRole('button', { name: '对话区' }).click();
  const input = page.getByTestId('style-input-project-dialog.nameSize');
  const h = Number(await input.inputValue());
  await page.getByTestId('style-unit-px').click();
  const px = Number(await input.inputValue());
  expect(px).toBeCloseTo(h * 1080, 0);
  await input.fill('40');
  await input.blur();
  await expect(page.getByTestId('style-project-dialog.nameSize')).toHaveClass(/own/);
  await page.getByTestId('style-unit-h').click();
  expect(Number(await input.inputValue())).toBeCloseTo(40 / 1080, 3);
  // save as a preset, reset the layer, apply it back
  await page.getByTestId('preset-saveas-project').click();
  await page.getByTestId('preset-name').fill('大号名字');
  await page.getByTestId('preset-confirm').click();
  await page.getByTestId('insp-style-reset-project').click();
  await expect(page.getByTestId('style-project-dialog.nameSize')).not.toHaveClass(/own/);
  await page.getByTestId('preset-apply-project').click();
  await expect(page.getByTestId('style-project-dialog.nameSize')).toHaveClass(/own/);
  // context menu: copy value
  await page.getByTestId('style-project-dialog.nameSize').click({ button: 'right' });
  await expect(page.getByTestId('style-ctx')).toBeVisible();
  await page.getByRole('menuitem', { name: '复制值' }).click();
  await page.getByTestId('insp-style-reset-project').click();
  await page.evaluate(() => localStorage.removeItem('studio.stylePresets'));
});

test('overlays, reference frame and the keyboard', async () => {
  await page.getByTestId('overlay-safe').click();
  await page.getByTestId('overlay-thirds').click();
  await page.getByTestId('overlay-eyeLine').click();
  await expect(page.getByTestId('stage-overlay').locator('.eyeband')).toHaveCount(1);
  await expect(page.getByTestId('stage-overlay').locator('.guide')).toHaveCount(2 + 4);
  // reference image
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  await page.getByTestId('ref-file').setInputFiles({ name: 'ref.png', mimeType: 'image/png', buffer: png });
  await expect(page.getByTestId('ref-image')).toBeVisible();
  await page.getByTestId('ref-opacity').fill('0.3');
  await page.getByTestId('ref-diff').click();
  await expect(page.getByTestId('ref-image')).toHaveCSS('mix-blend-mode', 'difference');
  await page.getByTestId('ref-clear').click();
  await expect(page.getByTestId('ref-image')).toHaveCount(0);
  for (const k of ['safe', 'thirds', 'eyeLine']) await page.getByTestId(`overlay-${k}`).click();

  // keyboard: space plays / pauses, K pauses, arrows step, ? opens the sheet, Escape closes it
  await page.locator('body').click({ position: { x: 5, y: 5 } });
  await seekTo(page, 5);
  await page.keyboard.press('Space');
  await expect.poll(() => page.evaluate(() => window.__studio.player!.time()), { timeout: 20_000 }).toBeGreaterThan(5.3);
  await page.keyboard.press('k');
  const t = await page.evaluate(() => window.__studio.player!.time());
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => window.__studio.player!.time())).toBeCloseTo(t, 1);
  await page.keyboard.press('ArrowRight');
  await expect.poll(() => page.evaluate(() => window.__studio.player!.time()), { timeout: 20_000 }).toBeCloseTo(t + 1 / 30, 1);
  await page.keyboard.press('ArrowDown');
  await expect.poll(() => page.evaluate(() => window.__studio.player!.time()), { timeout: 20_000 }).toBeGreaterThan(t + 0.05);
  await page.keyboard.press('?');
  await expect(page.getByTestId('help-sheet')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('help-sheet')).toHaveCount(0);
});

test('layout: no horizontal overflow and every panel inside the window at 1440x900 and 1920x1080', async () => {
  for (const [w, h] of [[1440, 900], [1920, 1080]] as const) {
    await page.setViewportSize({ width: w, height: h });
    await page.waitForTimeout(400);
    for (const view of ['view-preview']) {
      await page.getByTestId(view).click();
      const m = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, sh: document.documentElement.scrollHeight, ch: document.documentElement.clientHeight }));
      expect(m.sw).toBeLessThanOrEqual(m.cw);
      expect(m.sh).toBeLessThanOrEqual(m.ch);
    }
    for (const id of ['left-panel', 'right-panel', 'bottom-panel', 'preview']) {
      const b = (await page.getByTestId(id).boundingBox())!;
      expect(b.x).toBeGreaterThanOrEqual(0);
      expect(b.x + b.width).toBeLessThanOrEqual(w + 0.5);
      expect(b.y + b.height).toBeLessThanOrEqual(h + 0.5);
    }
    // no text control sticks out of the inspector
    const over = await page.evaluate(() => {
      const panel = document.querySelector('[data-testid=right-panel]')!.getBoundingClientRect();
      return [...document.querySelectorAll('[data-testid=right-panel] select, [data-testid=right-panel] input, [data-testid=right-panel] button')].filter((e) => e.getBoundingClientRect().right > panel.right + 1).length;
    });
    expect(over).toBe(0);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
});

test('no console errors, and the edits survive saving and reopening', async () => {
  const p = (await playing(page)) as Project;
  await tab(page, 'project');
  await page.getByTestId('insp-project-title').fill('P9 保存');
  await page.getByTestId('btn-save').click();
  await expect(page.getByTestId('save-state')).toHaveText('已保存');
  await page.reload();
  await expect(page.getByTestId('ws-title')).toHaveText('P9 保存');
  await expect(page.getByTestId('play-status')).toHaveText('就绪', { timeout: 180_000 });
  expect((await playing(page)).scenes.length).toBe(p.scenes.length);
  expect(errors.filter((e) => !/Failed to load resource/.test(e))).toEqual([]);
});
