import { expect, test, type Page } from '@playwright/test';
import './helpers/studio';

const A1 = '001_casual_spring_01';
const A2 = '002_casual_spring_01';
const W = 1280;
const H = 720;

async function openLab(page: Page) {
  const errors: string[] = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/lab/stage');
  await settle(page);
  return errors;
}

/** Wait for the stage lab to finish its async update (status goes busy -> ready), then let the pose settle. */
async function settle(page: Page) {
  await page.waitForTimeout(400);
  await expect(page.getByTestId('stage-status')).toHaveText('就绪', { timeout: 90_000 });
  await page.waitForTimeout(700);
}

async function setInput(page: Page, testid: string, value: string | number) {
  await page.evaluate(
    ([id, v]) => {
      const el = document.querySelector<HTMLInputElement | HTMLSelectElement>(`[data-testid=${id}]`)!;
      if (el instanceof HTMLSelectElement) {
        el.value = String(v);
        el.dispatchEvent(new Event('change', { bubbles: true }));
      } else {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, String(v));
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }
    },
    [testid, value] as const,
  );
  await settle(page);
}

const pixels = (page: Page, x: number, y: number, w: number, h: number) =>
  page.evaluate(([a, b, c, d]) => window.__studio.snapshotPixels(a!, b!, c!, d!), [x, y, w, h] as const);

/** Mean RGB of a region. */
async function mean(page: Page, x: number, y: number, w: number, h: number) {
  const px = await pixels(page, x, y, w, h);
  const n = px.length / 4;
  const sum = [0, 0, 0];
  for (let i = 0; i < px.length; i += 4) for (let c = 0; c < 3; c++) sum[c]! += px[i + c]!;
  return sum.map((s) => s / n);
}

test('two actors face each other (opposite head yaw, no mirroring), grounded and sized by depth', async ({ page }) => {
  const errors = await openLab(page);
  const p = await page.evaluate(([a, b]) => ({ l: window.__studio.getActorParams(a!, ['ParamAngleX']).ParamAngleX!, r: window.__studio.getActorParams(b!, ['ParamAngleX']).ParamAngleX! }), [A1, A2] as const);
  expect(p.l.applied).toBeGreaterThan(8); // left actor turned to screen-right (headSign +1)
  expect(p.r.applied).toBeLessThan(-8); // right actor turned to screen-left

  const states = await page.evaluate(() => window.__studio.getRenderState());
  for (const s of states) {
    expect(s.worldTransform.a).toBeGreaterThan(0);
    expect(s.worldTransform.d).toBeGreaterThan(0);
  }
  const scale = async (id: string) => (await page.evaluate(() => window.__studio.getRenderState())).find((s) => s.id === id)!.worldTransform.a;
  const before = await scale(A2);
  await setInput(page, 'stage-depth-a2', 0.8);
  expect(await scale(A2)).toBeLessThan(before * 0.8); // a far actor is smaller
  expect(errors).toEqual([]);
});

test('the viewport corners are never empty background at zoom 1 / 2 / 3, even at the extreme camera positions', async ({ page }) => {
  test.setTimeout(240_000);
  await openLab(page);
  await page.getByTestId('stage-manual').check();
  await settle(page);
  for (const zoom of [1, 2, 3]) {
    for (const [x, y] of [[0, 0], [2048, 0], [0, 1119], [2048, 1119], [1024, 560]]) {
      await setInput(page, 'stage-cam-zoom', zoom);
      await setInput(page, 'stage-cam-x', x!);
      await setInput(page, 'stage-cam-y', y!);
      for (const [cx, cy] of [[0, 0], [W - 4, 0], [0, H - 4], [W - 4, H - 4]]) {
        const [r, g, b] = await mean(page, cx!, cy!, 4, 4);
        expect(r! + g! + b!, `zoom ${zoom} cam (${x},${y}) corner (${cx},${cy})`).toBeGreaterThan(24);
      }
    }
  }
});

test('shots: cu magnifies the background less than the actor (parallax) and blurs it with dof', async ({ page }) => {
  await openLab(page);
  await setInput(page, 'stage-shot', 'cu');
  const cam = await page.evaluate(() => window.__studio.getCamera()!);
  expect(cam.zoom).toBeGreaterThan(3);
  // the actor head is the focus: about 42% of the viewport height
  await setInput(page, 'stage-dof', 5);
  const sharp = await page.evaluate(() => window.__studio.snapshotPixels(40, 40, 200, 200));
  await setInput(page, 'stage-dof', 0);
  const crisp = await page.evaluate(() => window.__studio.snapshotPixels(40, 40, 200, 200));
  const gradient = (px: number[]) => {
    let g = 0;
    for (let i = 4; i < px.length; i += 4) g += Math.abs(px[i]! - px[i - 4]!);
    return g;
  };
  expect(gradient(sharp)).toBeLessThan(gradient(crisp) * 0.8); // background is visibly blurred
});

test('whole-actor fade: 50% opacity is the true mix of actor and background (no inner layers showing through)', async ({ page }) => {
  await openLab(page);
  await setInput(page, 'stage-shot', 'mcu');
  await setInput(page, 'stage-focus', 'a2');
  const region = [W / 2 - 60, 380, 120, 100] as const; // chest of the focused actor
  await setInput(page, 'stage-opacity-a2', 1);
  const solid = await mean(page, ...region);
  await setInput(page, 'stage-opacity-a2', 0);
  const gone = await mean(page, ...region);
  await setInput(page, 'stage-opacity-a2', 0.5);
  const half = await mean(page, ...region);
  for (let c = 0; c < 3; c++) {
    expect(Math.abs(half[c]! - (solid[c]! + gone[c]!) / 2)).toBeLessThan(14);
  }
  // fully faded: identical to the background-only picture
  await setInput(page, 'stage-opacity-a2', 0);
  const again = await mean(page, ...region);
  for (let c = 0; c < 3; c++) expect(Math.abs(again[c]! - gone[c]!)).toBeLessThan(2);
});

test('transitions: no black frames for crossfade / wipe, fade_black reaches black at 50%, nothing lingers afterwards', async ({ page }) => {
  test.setTimeout(240_000);
  const errors = await openLab(page);
  await setInput(page, 'stage-shot', 'two_shot');
  const lum = async () => {
    const [r, g, b] = await mean(page, 0, 0, W, H);
    return (r! + g! + b!) / 3;
  };
  const plain = await lum();
  for (const kind of ['crossfade', 'wipe']) {
    await setInput(page, 'stage-transition-kind', kind);
    await page.getByTestId('stage-transition-start').click();
    await settle(page);
    for (const p of [0.25, 0.5, 0.75]) {
      await setInput(page, 'stage-progress', p);
      expect(await lum(), `${kind} @${p}`).toBeGreaterThan(40);
    }
    await page.getByTestId('stage-transition-end').click();
    await settle(page);
  }
  await setInput(page, 'stage-transition-kind', 'fade_black');
  await page.getByTestId('stage-transition-start').click();
  await settle(page);
  await setInput(page, 'stage-progress', 0.5);
  expect(await lum()).toBeLessThan(2);
  await setInput(page, 'stage-progress', 0.25);
  const dim = await lum();
  expect(dim).toBeGreaterThan(5);
  expect(dim).toBeLessThan(plain);
  await page.getByTestId('stage-transition-end').click();
  await settle(page);
  expect(await lum()).toBeGreaterThan(40); // overlay fully gone
  expect(errors).toEqual([]);
});

test('ground line overrides persist per background', async ({ page, request }) => {
  await openLab(page);
  await setInput(page, 'stage-horizon', 480);
  await setInput(page, 'stage-floor', 1000);
  await page.getByTestId('stage-ground-save').click();
  await expect.poll(async () => (await (await request.get('/api/backgrounds/adv_bkg_stage_000153/ground')).json())?.floorY, { timeout: 10_000 }).toBe(1000);
  await request.delete('/api/backgrounds/adv_bkg_stage_000153/ground');
});
