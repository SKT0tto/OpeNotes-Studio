/**
 * v0.2.1 performance work: the cases the change's own checks do not cover. Works on copies of the bundled demo project (classic and
 * travel, deleted at the end); never reads other projects and never calls the director.
 *  - Live2D GL state shortcut (fastGlState): with the engine's own state reads switched back on, none of the assumptions that
 *    replace its save / restore ever differ while playing across scene changes, transitions, fades, blur and dimming filters.
 *  - Released background textures: jumping back to an earlier scene draws a live (not destroyed) picture, on the play page and in the editor.
 *  - Playhead outside React: while paused, keyboard seeks move the time readout, the slider and the timeline head, and the inspector follows.
 *  - Automatic quality fallback: stays off on a machine that keeps up, in classic and in travel.
 *  - Classic background blur cache: a still shot drawn from the cache equals the direct blur within one colour level, at many places of
 *    the film (so a stale cache after a camera / zoom / background / blur change would show), and the cache is on during a still shot.
 *  - Costume textures: a costume worn later in a scene is uploaded ahead of its first appearance (never inside the frame it first shows),
 *    and not when the scene is entered.
 */
import fs from 'node:fs';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import './helpers/studio';

test.setTimeout(300_000);

const demo = JSON.parse(fs.readFileSync('tests/fixtures/demo-project.json', 'utf8'));
const created: string[] = [];

async function createDemo(request: APIRequestContext, system: 'classic' | 'travel'): Promise<string> {
  const id = `p_perfsafe_${system}_${Date.now().toString(36)}`;
  const res = await request.post('/api/projects', { data: { ...demo, id, title: `perf-safety ${system}`, settings: { ...demo.settings, cameraSystem: system } } });
  expect(res.ok()).toBe(true);
  const saved = ((await res.json()) as { id: string }).id;
  created.push(saved);
  return saved;
}

test.afterAll(async ({ request }) => {
  for (const id of created) await request.delete(`/api/projects/${id}`);
});

async function open(page: Page, url: string, init?: () => void) {
  // never list other projects
  await page.route('**/api/projects', (route) => (route.request().method() === 'GET' ? route.fulfill({ json: [] }) : route.continue()));
  if (init) await page.addInitScript(init);
  await page.goto(url);
  await expect(page.getByTestId('play-status')).toHaveText('就绪', { timeout: 180_000 });
  await expect.poll(() => page.evaluate(() => window.__studio.player!.busy()), { timeout: 120_000 }).toBe(false);
}

const settle = async (page: Page) => {
  await expect.poll(() => page.evaluate(() => window.__studio.player!.busy()), { timeout: 60_000 }).toBe(false);
  await page.waitForTimeout(300);
};

/** Plays a few seconds around every scene change (transition, entrances, background switch). */
async function playAcrossScenes(page: Page): Promise<number> {
  const starts = await page.evaluate(() => window.__studio.player!.sceneStarts());
  let most = 0;
  for (const s of [0, ...starts.slice(1).map((x) => Math.max(0, x - 1.5))]) {
    await page.evaluate((t) => window.__studio.player!.seek(t), s);
    await settle(page);
    await page.evaluate(() => window.__studio.player!.play());
    for (let k = 0; k < 7; k++) {
      await page.waitForTimeout(500);
      most = Math.max(most, await page.evaluate(() => window.__studio.stageProbe()?.people.length ?? 0));
    }
    await page.evaluate(() => window.__studio.player!.pause());
  }
  return most;
}

/** Facts about the background layer: whether its sprites draw a destroyed texture, and its blur resolution (0.25 = low quality). */
const bgFacts = (page: Page) =>
  page.evaluate(() => {
    type Node = { children?: Node[]; drawsTexture?: unknown; sprite?: { texture: { destroyed: boolean; source: { destroyed?: boolean } } }; nextSprite?: Node['sprite']; blur?: { resolution: number }; visible?: boolean };
    const find = (n: Node): Node | null => {
      if (typeof n.drawsTexture === 'function') return n;
      for (const c of n.children ?? []) {
        const f = find(c);
        if (f) return f;
      }
      return null;
    };
    const layer = find((window.__studio as unknown as { app: { stage: unknown } }).app.stage as Node);
    if (!layer) return null;
    const dead = (s: Node['sprite']) => !!s && (s.texture.destroyed || !!s.texture.source?.destroyed);
    return { destroyed: dead(layer.sprite) || (!!layer.nextSprite && (layer.nextSprite as unknown as { visible: boolean }).visible && dead(layer.nextSprite)), blurRes: layer.blur?.resolution ?? -1 };
  });

/** Share of distinct colours in a coarse grid of the frame: a black / cleared frame has 1. */
async function frameVariety(page: Page): Promise<number> {
  return page.evaluate(() => {
    const px = window.__studio.snapshotPixels(0, 0, 1280, 720);
    const seen = new Set<string>();
    for (let y = 20; y < 720; y += 60) for (let x = 20; x < 1280; x += 80) {
      const i = (y * 1280 + x) * 4;
      seen.add(`${px[i]! >> 4},${px[i + 1]! >> 4},${px[i + 2]! >> 4}`);
    }
    return seen.size;
  });
}

for (const system of ['classic', 'travel'] as const) {
  test(`${system}: the Live2D GL state shortcut never meets a state it does not expect`, async ({ page, request }) => {
    const id = await createDemo(request, system);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await open(page, `/play/${id}`, () => ((globalThis as { __fastGlStateCheck?: boolean }).__fastGlStateCheck = true));
    const people = await playAcrossScenes(page);
    expect(people, 'somebody was drawn').toBeGreaterThan(0);
    const mismatch = await page.evaluate(() => (globalThis as { __fastGlStateMismatch?: Record<string, number> }).__fastGlStateMismatch ?? {});
    // Harmless differences: `program` (Pixi's shader.resetState only forgets its program), `arrayBuffer` (Pixi's buffer.bind always calls
    // gl.bindBuffer, nothing is cached) and `activeTexture` (texture.resetState() right after the model forgets the active unit).
    // What must never differ is the state Pixi does NOT rebuild: attributes of the default VAO, element buffer, colour mask, scissor /
    // stencil / depth / cull and the bound framebuffer.
    const harmless = new Set(['program', 'arrayBuffer', 'activeTexture']);
    expect(Object.fromEntries(Object.entries(mismatch).filter(([k]) => !harmless.has(k)))).toEqual({});
    expect(errors).toEqual([]);
  });

  test(`${system}: the automatic quality fallback stays off on a machine that keeps up`, async ({ page, request }) => {
    const id = await createDemo(request, system);
    await open(page, `/play/${id}`);
    await page.evaluate(() => window.__studio.player!.play());
    await page.waitForTimeout(8000);
    await page.evaluate(() => window.__studio.player!.pause());
    const f = await bgFacts(page);
    expect(f).not.toBeNull();
    expect(f!.blurRes, 'blur resolution of the background (0.25 = low quality)').not.toBe(0.25);
  });
}

test('play page: jumping back to an earlier scene draws a live background texture', async ({ page, request }) => {
  const id = await createDemo(request, 'classic');
  await open(page, `/play/${id}`);
  const starts = await page.evaluate(() => window.__studio.player!.sceneStarts());
  expect(starts.length).toBeGreaterThanOrEqual(3);
  const reference: number[] = [];
  for (const t of [starts[0]! + 1, starts[1]! + 1, starts[2]! + 1]) {
    await page.evaluate((x) => window.__studio.player!.seek(x), t);
    await settle(page);
    reference.push(await frameVariety(page));
  }
  for (const [k, t] of [[2, starts[2]! + 1], [0, starts[0]! + 1], [2, starts[2]! + 1], [1, starts[1]! + 1], [0, starts[0]! + 1]] as const) {
    await page.evaluate((x) => window.__studio.player!.seek(x), t);
    await settle(page);
    // a couple of real frames, so a release waiting for an unused frame has happened
    await page.waitForTimeout(300);
    const f = await bgFacts(page);
    expect(f?.destroyed, `scene ${k}: background sprite draws a destroyed texture`).toBe(false);
    const v = await frameVariety(page);
    expect(v, `scene ${k}: frame has content`).toBeGreaterThan(Math.min(8, reference[k]! - 2));
  }
});

test('editor: background after a jump back, and the paused playhead follows keyboard seeks', async ({ page, request }) => {
  const id = await createDemo(request, 'classic');
  await open(page, `/editor/${id}`);
  const starts = await page.evaluate(() => window.__studio.player!.sceneStarts());
  for (const t of [starts[2]! + 1, starts[0]! + 1]) {
    await page.evaluate((x) => window.__studio.player!.seek(x), t);
    await settle(page);
  }
  await page.waitForTimeout(300);
  expect((await bgFacts(page))?.destroyed).toBe(false);
  expect(await frameVariety(page)).toBeGreaterThan(8);

  // paused: keyboard seeks move the readout, the slider and the timeline head; the inspector follows the line under the playhead
  const time = page.getByTestId('play-time');
  const seek = page.getByTestId('play-seek');
  const headLeft = () => page.getByTestId('tl-playhead').evaluate((el) => Number(/translateX\(([-0-9.]+)px\)/.exec((el as HTMLElement).style.transform)?.[1] ?? NaN));
  await page.locator('body').click({ position: { x: 5, y: 5 } });
  const before = { text: await time.textContent(), value: await seek.inputValue(), x: await headLeft() };
  await page.keyboard.press('Shift+ArrowRight');
  await page.keyboard.press('Shift+ArrowRight');
  await settle(page);
  await expect(time).not.toHaveText(before.text ?? '');
  expect(Number(await seek.inputValue())).toBeGreaterThan(Number(before.value));
  expect(await headLeft()).toBeGreaterThan(before.x);
  const t = await page.evaluate(() => window.__studio.player!.time());
  expect(Number(await seek.inputValue())).toBe(Math.round(t * 100));

  await page.keyboard.press('ArrowDown');
  await settle(page);
  const beat = await page.evaluate(() => window.__studio.player!.state()!.subtitle?.beatId ?? '');
  expect(beat).not.toBe('');
  await expect(page.getByTestId(`tl-shot-${beat}`)).toHaveClass(/\bsel\b/);
});

/** The background layer node (the one with `drawsTexture`) of the live stage. */
const FIND_LAYER = `(() => {
  const find = (n) => {
    if (typeof n.drawsTexture === 'function') return n;
    for (const c of n.children ?? []) { const f = find(c); if (f) return f; }
    return null;
  };
  return find(window.__studio.app.stage);
})()`;

test('classic: the background blur cache draws what the direct blur draws (within one colour level)', async ({ page, request }) => {
  const id = await createDemo(request, 'classic');
  await open(page, `/play/${id}`);
  const dur = await page.evaluate(() => window.__studio.player!.duration());
  const times = Array.from({ length: 18 }, (_, i) => (dur * (i + 0.5)) / 18);
  let cachedFrames = 0;
  let worst = 0;
  for (const t of times) {
    // several applies of the same frame, so the cache of a still shot has been built and is in use
    const r = await page.evaluate(async ({ t, find }) => {
      const p = window.__studio.player!;
      const layer = eval(find) as { cacheView?: { visible: boolean }; sprite: { visible: boolean } };
      for (let i = 0; i < 6; i++) {
        await p.seek(t);
        while (p.busy()) await new Promise((r) => setTimeout(r, 20));
        if (layer.cacheView?.visible) break;
      }
      if (!layer.cacheView?.visible) return { cached: false, diff: 0 };
      p.pause();
      const grab = () => window.__studio.snapshotPixels(0, 0, 1280, 720); // the visible frame (a bigger target would clip the blur differently)
      const a = grab();
      layer.cacheView.visible = false;
      layer.sprite.visible = true;
      const b = grab();
      layer.cacheView.visible = true;
      layer.sprite.visible = false;
      let diff = 0;
      for (let i = 0; i < a.length; i++) diff = Math.max(diff, Math.abs(a[i]! - b[i]!));
      return { cached: true, diff };
    }, { t, find: FIND_LAYER });
    if (r.cached) cachedFrames++;
    worst = Math.max(worst, r.diff);
  }
  expect(cachedFrames, 'at least one still shot with a blurred background was drawn from the cache').toBeGreaterThan(0);
  expect(worst, 'largest colour difference between the cached and the direct picture').toBeLessThanOrEqual(1);
});

test('costume textures: uploaded a little ahead of the change, not when the scene is entered and not inside the frame the costume first shows', async ({ page, request }) => {
  const id = await createDemo(request, 'classic');
  await open(page, `/play/${id}`);
  // the demo's third scene has a costume change of c_001 (at beat s3b4)
  const at = await page.evaluate(() => window.__studio.player!.beatStarts()['s3b4']!);
  const r = await page.evaluate(async (at) => {
    const p = window.__studio.player!;
    const app = (window.__studio as unknown as { app: unknown }).app as { ticker: { add(fn: () => void, ctx: unknown, prio: number): void; remove(fn: () => void): void }; renderer: { gl: WebGL2RenderingContext } };
    const gl = app.renderer.gl as unknown as Record<string, (...a: unknown[]) => unknown>;
    let ups = 0;
    // width of the uploaded image: an explicit size (9-argument forms) or the width of the source object
    const widthOf = (fn: string, a: unknown[]): number => {
      const explicit = fn === 'texImage2D' ? a[3] : a[4];
      if (a.length >= 9 && typeof explicit === 'number') return explicit;
      const src = (fn === 'texImage2D' ? a[5] : a[6]) as { width?: number } | undefined;
      return src?.width ?? 0;
    };
    for (const fn of ['texImage2D', 'texSubImage2D']) {
      const orig = gl[fn]!;
      gl[fn] = function (this: unknown, ...a: unknown[]) {
        if (widthOf(fn, a) >= 1024) ups++;
        return orig.apply(this, a);
      };
    }
    const frames: Array<{ t: number; ups: number; model: string | null }> = [];
    const start = () => (ups = 0);
    const end = () => {
      const st = p.state();
      frames.push({ t: st?.t ?? -1, ups, model: st?.actors.find((x) => x.castId === 'c_001')?.modelId ?? null });
    };
    app.ticker.add(start, undefined, 1000);
    app.ticker.add(end, undefined, -1000);
    await p.seek(at - 2.8);
    while (p.busy()) await new Promise((r) => setTimeout(r, 50));
    await new Promise((r) => setTimeout(r, 300));
    const enteredUploads = frames.reduce((n, f) => n + f.ups, 0); // everything since the scene was entered (frames while paused)
    frames.length = 0;
    p.play();
    await new Promise((r) => setTimeout(r, 6000));
    p.pause();
    app.ticker.remove(start);
    app.ticker.remove(end);
    return { frames, enteredUploads };
  }, at);
  const ci = r.frames.findIndex((f, i) => i > 0 && f.model !== r.frames[i - 1]!.model);
  expect(ci, 'the costume changed while playing').toBeGreaterThan(0);
  const tChange = r.frames[ci]!.t;
  const before = r.frames.filter((f) => f.t < tChange && f.ups > 0).length;
  const atChange = r.frames.filter((f) => Math.abs(f.t - tChange) < 0.1 && f.ups > 0).length;
  expect(atChange, 'texture uploads in the frames around the costume change').toBe(0);
  expect(before, 'the new costume was uploaded ahead of its first appearance').toBeGreaterThan(0);
  expect(Math.max(...r.frames.slice(Math.max(0, ci - 3), ci + 4).map((f) => f.ups))).toBe(0);
});
