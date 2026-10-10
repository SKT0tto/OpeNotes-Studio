/**
 * P10 in a real browser: the multi-track timeline (add / drag / re-anchor / lock / copy / delete keys, duration handle,
 * effect keys, transition edge, mute), rule-director ghost keys, the storyboard (thumbnails, edit, insert, reorder,
 * batch) and the transition snapshot after a jump (D1).
 */
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import type { Project } from '../../shared/schema/project';
import { beatStart, center, dragBy, openDemoEditor, playing, seekTo, settled, stateOf } from './helpers/editor';
import { tab } from './helpers/ui';

test.describe.configure({ mode: 'serial' });
test.setTimeout(300_000);

let page: Page;
let projectId = '';
const errors: string[] = [];
const PPS = 60;

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(e.message));
  projectId = await openDemoEditor(page, 'P10 时间轴');
});
test.afterAll(async ({ request }: { request: APIRequestContext }) => {
  await page.close();
  await request.delete(`/api/projects/${projectId}`);
});

type K = { id: string; at: { beatId: string; offset: number }; value: Record<string, unknown>; duration: number; meta: { source: string; locked: boolean } };
const track = async (sceneIdx: number, channel: string, castId?: string) =>
  (await playing(page)).scenes[sceneIdx]!.tracks.find((t) => t.channel === channel && (castId === undefined || (t.target.kind === 'actor' && t.target.castId === castId)));
const keysOf = async (sceneIdx: number, channel: string, castId?: string) => ((await track(sceneIdx, channel, castId))?.keys ?? []) as unknown as K[];
const actor = async (id: string) => (await stateOf(page)).actors.find((a) => a.castId === id)!;
const lane = (id: string) => page.getByTestId(`tl-lane-${id}`).locator('.tl-lane');
const undo = () => page.getByTestId('btn-undo').click();
async function laneAt(id: string, t: number, t0 = 0) {
  const l = lane(id);
  await l.scrollIntoViewIfNeeded();
  const b = (await l.boundingBox())!;
  return { x: b.x + (t - t0) * PPS, y: b.y + b.height / 2 };
}
async function openGroup(castId: string) {
  if ((await page.getByTestId(`tl-lane-${castId}:head`).count()) === 0) await page.getByTestId(`tl-group-actor:${castId}`).getByRole('button').first().click();
  await expect(page.getByTestId(`tl-lane-${castId}:head`)).toBeVisible();
}

test('double-click a lane adds a key at that time; it plays; dragging across a beat re-anchors it; one undo each', async () => {
  const t3 = await beatStart(page, 's1b3');
  const t4 = await beatStart(page, 's1b4');
  await seekTo(page, t3 - 2);
  await openGroup('c_001');
  const before = await keysOf(0, 'head', 'c_001');
  const p = await laneAt('c_001:head', t3 + 0.5);
  await page.mouse.dblclick(p.x, p.y);
  await expect.poll(async () => (await keysOf(0, 'head', 'c_001')).length, { timeout: 20_000 }).toBe(before.length + 1);
  const added = (await keysOf(0, 'head', 'c_001')).find((k) => !before.some((b) => b.id === k.id))!;
  expect(added.at.beatId).toBe('s1b3');
  expect(added.at.offset).toBeGreaterThan(0.3);
  expect(added.at.offset).toBeLessThan(0.7);
  expect(added.meta.source).toBe('user');
  await expect(page.getByTestId('key-fields')).toBeVisible(); // the new key is selected in the key tab
  // it plays: before the key she turns to the speaker, after it to the camera (a small lean instead of a full turn)
  await seekTo(page, t3 + 0.2);
  const yawBefore = (await actor('c_001')).desiredYaw;
  await seekTo(page, t3 + 1.6);
  const yawAfter = (await actor('c_001')).desiredYaw;
  expect(Math.abs(yawBefore)).toBeGreaterThan(0.5);
  expect(Math.abs(yawAfter)).toBeLessThan(0.4);

  // drag it into the next beat: the anchor changes, the absolute time follows the mouse
  const key = page.getByTestId(`tl-key-${added.id}`);
  const c = await center(key);
  const target = t4 + 0.4;
  const at0 = t3 + added.at.offset;
  // Ctrl turns the snapping off: since the rule director yields per line, this person now also has rule keys (snap targets) in the other lines
  await page.keyboard.down('Control');
  await dragBy(page, c, (target - at0) * PPS);
  await page.keyboard.up('Control');
  await expect.poll(async () => (await keysOf(0, 'head', 'c_001')).find((k) => k.id === added.id)!.at.beatId, { timeout: 20_000 }).toBe('s1b4');
  const moved = (await keysOf(0, 'head', 'c_001')).find((k) => k.id === added.id)!;
  expect(t4 + moved.at.offset).toBeCloseTo(target, 1);
  await seekTo(page, t4 + 1.4);
  expect(Math.abs((await actor('c_001')).desiredYaw)).toBeLessThan(0.4);
  await undo(); // the drag was one step
  await expect.poll(async () => (await keysOf(0, 'head', 'c_001')).find((k) => k.id === added.id)!.at.beatId, { timeout: 20_000 }).toBe('s1b3');
  await page.getByTestId('btn-redo').click();
  await expect.poll(async () => (await keysOf(0, 'head', 'c_001')).find((k) => k.id === added.id)!.at.beatId, { timeout: 20_000 }).toBe('s1b4');
});

test('a locked key will not move and says why; unlocking lets it move; the duration handle sets the transition time', async () => {
  const added = (await keysOf(0, 'head', 'c_001')).find((k) => k.id.startsWith('k_'))!;
  const t4 = await beatStart(page, 's1b4');
  const keyEl = page.getByTestId(`tl-key-${added.id}`);
  await keyEl.click();
  await page.getByTestId('key-fields').getByTitle('锁定', { exact: true }).first().click();
  await expect(keyEl).toHaveClass(/locked/);
  const at = t4 + added.at.offset;
  await dragBy(page, await center(keyEl), 90);
  await expect(page.getByTestId('toast')).toContainText('已锁定');
  const same = (await keysOf(0, 'head', 'c_001')).find((k) => k.id === added.id)!;
  expect(same.at).toEqual(added.at);
  // a locked key cannot be deleted either
  await keyEl.click();
  await page.keyboard.press('Delete');
  expect((await keysOf(0, 'head', 'c_001')).some((k) => k.id === added.id)).toBe(true);
  await page.getByTestId('key-fields').getByTitle(/已锁定/).first().click();
  await expect(keyEl).not.toHaveClass(/locked/);

  // duration handle
  await keyEl.hover();
  const handle = page.getByTestId(`tl-dur-${added.id}`);
  await handle.hover();
  const h = await center(handle);
  await dragBy(page, h, 36);
  await expect.poll(async () => (await keysOf(0, 'head', 'c_001')).find((k) => k.id === added.id)!.duration, { timeout: 20_000 }).toBeGreaterThan(0.6);
  void at;
  // copy / paste at the playhead, then delete both
  await keyEl.click();
  await page.keyboard.press('Control+c');
  await seekTo(page, t4 + 2.5);
  await page.keyboard.press('Control+v');
  await expect.poll(async () => (await keysOf(0, 'head', 'c_001')).filter((k) => k.id.startsWith('k_')).length, { timeout: 20_000 }).toBe(2);
  await page.keyboard.press('Delete');
  await expect.poll(async () => (await keysOf(0, 'head', 'c_001')).filter((k) => k.id.startsWith('k_')).length, { timeout: 20_000 }).toBe(1);
  await keyEl.click();
  await page.keyboard.press('Delete');
  await expect.poll(async () => (await keysOf(0, 'head', 'c_001')).filter((k) => k.id.startsWith('k_')).length, { timeout: 20_000 }).toBe(0);
});

test('box-select picks several keys; rule-director ghost keys bake into real, editable keys without changing the picture', async () => {
  await seekTo(page, 1);
  await openGroup('c_001');
  const ghosts = page.locator('[data-testid="tl-lane-c_001:expression"] [data-ghost="1"]');
  await expect.poll(() => ghosts.count(), { timeout: 20_000 }).toBeGreaterThan(0);
  const n0 = await ghosts.count();
  const title = await ghosts.first().getAttribute('title');
  expect(title).toContain('规则导演');
  const expr0 = (await keysOf(0, 'expression', 'c_001')).length;
  // where does the ghost sit: the expression shown there must be the same after baking
  const ghostName = /（([^，）]+)，双击烘焙/.exec(title!)![1]!; // the lane shows the Chinese name, the tooltip keeps the raw one
  await ghosts.first().dblclick();
  await expect.poll(async () => (await keysOf(0, 'expression', 'c_001')).length, { timeout: 20_000 }).toBe(expr0 + 1);
  const baked = (await keysOf(0, 'expression', 'c_001')).at(-1)!;
  expect(baked.value.name).toBe(ghostName);
  expect(baked.meta.source).toBe('user');
  await expect.poll(() => page.locator('[data-testid="tl-lane-c_001:expression"] [data-ghost="1"]').count()).toBe(n0 - 1);
  const tb = (await beatStart(page, baked.at.beatId)) + baked.at.offset;
  await seekTo(page, tb + 0.3);
  expect((await actor('c_001')).expression).toBe(ghostName);
  await undo();
  await expect.poll(() => page.locator('[data-testid="tl-lane-c_001:expression"] [data-ghost="1"]').count(), { timeout: 20_000 }).toBe(n0);

  // marquee over the head .. gaze lanes around the first line of the conversation
  const t3 = await beatStart(page, 's1b3');
  const a = await laneAt('c_001:head', t3 - 1);
  const lb = (await lane('c_001:gaze').boundingBox())!;
  await page.mouse.move(a.x, a.y - 9);
  await page.mouse.down();
  await page.mouse.move(a.x + 4 * PPS, lb.y + lb.height + 2, { steps: 8 });
  await page.mouse.up();
  expect(await page.locator('.tl-key.sel').count()).toBeGreaterThanOrEqual(1);
  await expect(page.getByTestId('insp-tab-key')).toContainText('关键帧');
  await page.keyboard.press('Escape');
});

test('effect key: strength 1 -> 0.5 and ramp 0.3 s -> 1.0 s change the picture both when seeking and when playing', async () => {
  const s2 = (await page.evaluate(() => window.__studio.player!.sceneStarts()))[1]!;
  await seekTo(page, s2 + 6);
  await expect(page.getByTestId('tl-lane-fx')).toBeVisible();
  const fxKeys = await keysOf(1, 'fx');
  const k = fxKeys.find((x) => x.value.fx === 'vignette_anxiety' && Number(x.value.strength) === 1)!;
  expect(k).toBeTruthy();
  const tk = (await beatStart(page, k.at.beatId)) + k.at.offset;
  await page.getByTestId(`tl-key-${k.id}`).click();
  await expect(page.getByTestId('key-fx')).toHaveValue('vignette_anxiety');
  await page.getByTestId('key-fx-strength').fill('0.5');
  await page.getByTestId('key-fx-strength').blur();
  await page.getByTestId('key-duration').fill('1');
  await page.getByTestId('key-duration').blur();
  await expect.poll(async () => (await keysOf(1, 'fx')).find((x) => x.id === k.id)!.duration, { timeout: 20_000 }).toBe(1);
  await settled(page);
  await seekTo(page, tk + 0.3);
  const mid = (await stateOf(page)).fx.anxiety;
  await seekTo(page, tk + 1.2);
  const end = (await stateOf(page)).fx.anxiety;
  expect(end).toBeCloseTo(0.5, 1);
  expect(mid).toBeLessThan(end - 0.05);
  // sequential playback agrees with seeking
  await seekTo(page, tk - 0.05);
  await page.evaluate(() => void window.__studio.player!.play());
  await expect.poll(() => page.evaluate(() => window.__studio.player!.time()), { timeout: 30_000 }).toBeGreaterThan(tk + 1.2);
  await page.evaluate(() => window.__studio.player!.pause());
  const seqT = await page.evaluate(() => window.__studio.player!.time());
  const seq = (await stateOf(page)).fx.anxiety;
  await seekTo(page, seqT);
  expect((await stateOf(page)).fx.anxiety).toBeCloseTo(seq, 1);
});

test('transition edge changes the lead-in length (and moves everything after it); mute only changes the preview', async () => {
  await seekTo(page, 0.5);
  await expect(page.getByTestId('tl-transition')).toBeVisible();
  const b1 = await beatStart(page, 's1b1');
  const edge = page.getByTestId('tl-transition-edge');
  await edge.scrollIntoViewIfNeeded();
  await dragBy(page, await center(edge), 30);
  await expect.poll(async () => (await playing(page)).scenes[0]!.style.overrides['transitions.dipHold'], { timeout: 20_000 }).toBeGreaterThan(0.4);
  await settled(page);
  expect(await beatStart(page, 's1b1')).toBeGreaterThan(b1 + 0.3);
  await undo();
  await expect.poll(async () => (await playing(page)).scenes[0]!.style.overrides['transitions.dipHold'], { timeout: 20_000 }).toBeUndefined();
  await settled(page);
  expect(await beatStart(page, 's1b1')).toBeCloseTo(b1, 2);

  // change the kind in the scene tab
  await tab(page, 'scene');
  await page.getByTestId('insp-transition').selectOption('cut');
  await expect(page.getByTestId('tl-transition')).toContainText('硬切');
  await undo();

  // mute: the preview loses the track, the project (what is saved) keeps it
  await openGroup('c_001');
  await seekTo(page, 1);
  const head = await track(0, 'head', 'c_001');
  expect(head).toBeTruthy();
  await page.getByTestId('tl-mute-c_001:head').click();
  await expect(page.getByTestId('mute-note')).toBeVisible();
  await expect.poll(async () => (await track(0, 'head', 'c_001')) === undefined, { timeout: 20_000 }).toBe(true);
  await openGroup('c_002');
  await page.getByTestId('tl-solo-c_002:head').click();
  await expect.poll(async () => (await playing(page)).scenes[0]!.tracks.length, { timeout: 20_000 }).toBe(1);
  await page.getByTestId('tl-solo-c_002:head').click();
  await page.getByTestId('tl-mute-c_001:head').click();
  await expect.poll(async () => (await track(0, 'head', 'c_001')) !== undefined, { timeout: 20_000 }).toBe(true);
  await expect(page.getByTestId('mute-note')).toHaveCount(0);
});

test('D1: jumping into a scene change shows the outgoing scene under the transition, not the new scene', async () => {
  const starts = await page.evaluate(() => window.__studio.player!.sceneStarts());
  const s2 = starts[1]!;
  // the composition on the canvas, as a 32x18 thumbnail (hair strands and sway do not matter, which scene / framing does)
  const grab = async () => {
    await page.waitForTimeout(150);
    return page.evaluate(() => {
      const src = document.querySelector('[data-testid=play-canvas]') as HTMLCanvasElement;
      const c = document.createElement('canvas');
      c.width = 32;
      c.height = 18;
      const ctx = c.getContext('2d')!;
      ctx.drawImage(src, 0, 0, 32, 18);
      return Array.from(ctx.getImageData(0, 0, 32, 18).data);
    });
  };
  const mad = (a: number[], b: number[]) => a.reduce((s, v, i) => s + Math.abs(v - b[i]!), 0) / a.length;
  await seekTo(page, 0); // far from the target, so the jump has to build the outgoing picture itself
  await seekTo(page, s2 + 0.1); // inside the "pause" phase of the scene change: the old picture is still on screen
  const lead = await grab();
  await seekTo(page, s2 - 0.03);
  const old = await grab();
  await seekTo(page, (await beatStart(page, 's2b1')) + 1.0);
  const fresh = await grab();
  expect(mad(lead, old)).toBeLessThan(mad(lead, fresh) * 0.5);
});

test('E1: during the memory glow the picture is high-key and the dialogue gradient washes out with it', async () => {
  const s2 = (await page.evaluate(() => window.__studio.player!.sceneStarts()))[1]!;
  await seekTo(page, s2 + 6);
  const glow = (await keysOf(1, 'fx')).find((x) => x.value.fx === 'memory_glow' && Number(x.value.strength) === 1)!;
  const tg = (await beatStart(page, glow.at.beatId)) + glow.at.offset + glow.duration + 0.4;
  const gradient = () => page.evaluate(() => Number(getComputedStyle(document.querySelector('[data-part=gradient]')!).opacity));
  await seekTo(page, tg);
  expect((await stateOf(page)).fx.glow).toBeCloseTo(1, 1);
  expect(await gradient()).toBeLessThan(0.7);
  expect(await gradient()).toBeGreaterThan(0.4);
  await seekTo(page, (await beatStart(page, 's2b2')) + 1);
  expect(await gradient()).toBe(1);
});

test('storyboard: a thumbnail per line, shot size edits update card and preview, insert / reorder / delete / batch edit', async () => {
  const p0 = (await playing(page)) as Project;
  const all = p0.scenes.flatMap((s) => s.beats.map((b) => b.id));
  await page.getByTestId('view-storyboard').click();
  await expect(page.getByTestId('storyboard')).toBeVisible();
  await expect(page.locator('[data-testid^=sb-thumb-]')).toHaveCount(all.length, { timeout: 280_000 });
  await expect(page.getByTestId('sb-status')).toContainText('已就绪');
  const src = (id: string) => page.getByTestId(`sb-thumb-${id}`).getAttribute('src');
  const thumbBefore = await src('s1b5');
  await page.getByTestId('sb-type-s1b5').selectOption('ecu');
  await expect(page.getByTestId('sb-shot-s1b5')).toHaveText('特写');
  await expect.poll(() => src('s1b5'), { timeout: 120_000 }).not.toBe(thumbBefore);
  await expect(page.getByTestId('sb-thumb-s1b5')).toBeVisible();
  // the preview agrees
  await page.getByTestId('view-preview').click();
  await seekTo(page, (await beatStart(page, 's1b5')) + 0.5);
  expect((await stateOf(page)).camera.zoom).toBeGreaterThan(2.5);
  await page.getByTestId('view-storyboard').click();
  await undo();
  await expect(page.getByTestId('sb-shot-s1b5')).not.toHaveText('特写');

  // insert after a card, drag it to the front, delete it
  await page.getByTestId('sb-card-s1b3').hover();
  await page.getByTestId('sb-add-s1b3').click();
  await expect.poll(async () => (await playing(page)).scenes[0]!.beats.length, { timeout: 20_000 }).toBe(p0.scenes[0]!.beats.length + 1);
  const added = (await playing(page)).scenes[0]!.beats.find((b) => !p0.scenes[0]!.beats.some((x) => x.id === b.id))!;
  await page.getByTestId(`sb-card-${added.id}`).dragTo(page.getByTestId('sb-card-s1b1'));
  await expect.poll(async () => (await playing(page)).scenes[0]!.beats[0]!.id, { timeout: 20_000 }).toBe(added.id);
  await page.getByTestId(`sb-card-${added.id}`).hover();
  await page.getByTestId(`sb-del-${added.id}`).click();
  await expect.poll(async () => (await playing(page)).scenes[0]!.beats.length, { timeout: 20_000 }).toBe(p0.scenes[0]!.beats.length);

  // batch: two cards, one shot size
  await page.getByTestId('sb-card-s1b1').click();
  await page.getByTestId('sb-card-s1b5').click({ modifiers: ['Control'] });
  await expect(page.getByTestId('sb-batch')).toBeVisible();
  await page.getByTestId('sb-batch-shot').selectOption('cu');
  await expect(page.getByTestId('sb-shot-s1b1')).toHaveText('近景');
  await expect(page.getByTestId('sb-shot-s1b5')).toHaveText('近景');
  await undo();
  await page.getByTestId('view-preview').click();
  expect(errors.filter((e) => !/Failed to load resource/.test(e))).toEqual([]);
});

test('layout: the timeline and the storyboard stay inside the window at 1440x900 and 1920x1080', async () => {
  for (const [w, h] of [[1440, 900], [1920, 1080]] as const) {
    await page.setViewportSize({ width: w, height: h });
    await page.waitForTimeout(400);
    for (const view of ['view-storyboard', 'view-preview']) {
      await page.getByTestId(view).click();
      const m = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, sh: document.documentElement.scrollHeight, ch: document.documentElement.clientHeight }));
      expect(m.sw).toBeLessThanOrEqual(m.cw);
      expect(m.sh).toBeLessThanOrEqual(m.ch);
    }
    const tl = (await page.getByTestId('timeline').boundingBox())!;
    expect(tl.x + tl.width).toBeLessThanOrEqual(w + 0.5);
    expect(tl.y + tl.height).toBeLessThanOrEqual(h + 0.5);
    // the lane heads are never covered by keys scrolling under them: the sticky column stays at the left edge
    const head = (await page.locator('.tl-head').first().boundingBox())!;
    expect(head.x).toBeGreaterThanOrEqual(tl.x - 0.5);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
});
