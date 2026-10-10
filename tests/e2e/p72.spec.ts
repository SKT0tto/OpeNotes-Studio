/**
 * P7.2 acceptance in a real browser at 1920x1080: the numbers of STYLE_REFERENCE measured on what is actually
 * on screen (DOM geometry of the dialogue area / banner, pixels, per-frame state), plus style edits reaching the preview.
 */
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import type { Project } from '../../shared/schema/project';
import './helpers/studio';

test.use({ viewport: { width: 1920, height: 1200 } });

async function openDemo(page: Page) {
  const errors: string[] = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/play/demo');
  await page.addStyleTag({ content: '.play-stage{width:1920px !important;max-width:none !important}' });
  await expect(page.getByTestId('play-status')).toHaveText('就绪', { timeout: 180_000 });
  return errors;
}
const starts = (page: Page) => page.evaluate(() => window.__studio.player!.beatStarts());
async function seek(page: Page, t: number) {
  await page.evaluate((x) => window.__studio.player!.seek(x), t);
  await expect.poll(() => page.evaluate(() => window.__studio.player!.busy()), { timeout: 60_000 }).toBe(false);
  await page.waitForTimeout(250);
}
const state = (page: Page) => page.evaluate(() => window.__studio.player!.state()!);
const stage = (page: Page) => page.getByTestId('play-stage');

/** Pixel / region statistics of a PNG buffer, decoded in the page. */
async function analyse<T>(page: Page, png: Buffer, fn: string): Promise<T> {
  return page.evaluate(
    async ([b64, code]) => {
      const img = new Image();
      img.src = `data:image/png;base64,${b64}`;
      await img.decode();
      const c = document.createElement('canvas');
      c.width = img.width;
      c.height = img.height;
      const g = c.getContext('2d', { willReadFrequently: true })!;
      g.drawImage(img, 0, 0);
      const px = (x: number, y: number) => Array.from(g.getImageData(x, y, 1, 1).data);
      const lum = (x: number, y: number, w: number, h: number) => {
        const d = g.getImageData(x, y, w, h).data;
        let s = 0;
        for (let i = 0; i < d.length; i += 4) s += 0.2126 * d[i]! + 0.7152 * d[i + 1]! + 0.0722 * d[i + 2]!;
        return s / (d.length / 4);
      };
      /** Variance of the Laplacian of the luminance: high = sharp / busy, low = blurred. */
      const lap = (x: number, y: number, rw: number, rh: number) => {
        // 4x4 average pooling first: the metric then measures structure at the scale of the blur, not texture noise
        const raw = g.getImageData(x, y, rw, rh).data;
        const w = Math.floor(rw / 4);
        const h = Math.floor(rh / 4);
        const L = new Float32Array(w * h);
        for (let yy = 0; yy < h; yy++) {
          for (let xx = 0; xx < w; xx++) {
            let a = 0;
            for (let dy = 0; dy < 4; dy++) for (let dx = 0; dx < 4; dx++) { const i = ((yy * 4 + dy) * rw + xx * 4 + dx) * 4; a += 0.2126 * raw[i]! + 0.7152 * raw[i + 1]! + 0.0722 * raw[i + 2]!; }
            L[yy * w + xx] = a / 16;
          }
        }
        let s = 0;
        let s2 = 0;
        let n = 0;
        for (let yy = 1; yy < h - 1; yy++) {
          for (let xx = 1; xx < w - 1; xx++) {
            const v = 4 * L[yy * w + xx]! - L[yy * w + xx - 1]! - L[yy * w + xx + 1]! - L[(yy - 1) * w + xx]! - L[(yy + 1) * w + xx]!;
            s += v;
            s2 += v * v;
            n++;
          }
        }
        return s2 / n - (s / n) ** 2;
      };
      return new Function('px', 'lum', 'lap', `return (${code})(px, lum, lap)`)(px, lum, lap);
    },
    [png.toString('base64'), fn] as const,
  ) as Promise<T>;
}

test('V2: the dialogue area sits where the original puts it (+-6 px at 1080) with the original sizes and colours', async ({ page }) => {
  const errors = await openDemo(page);
  const b = await starts(page);
  await seek(page, b.s1b3! + 3);
  const box = (await stage(page).boundingBox())!;
  expect(Math.round(box.height)).toBe(1080);
  const g = await page.evaluate(() => {
    const root = document.querySelector('[data-testid=dialog]')!;
    const part = (n: string) => root.querySelector(`[data-part=${n}]`) as HTMLElement;
    const st = document.querySelector('[data-testid=play-stage]')!.getBoundingClientRect();
    const r = (n: string) => {
      const q = part(n).getBoundingClientRect();
      return { top: q.top - st.top, left: q.left - st.left, width: q.width, height: q.height, css: getComputedStyle(part(n)) };
    };
    const name = r('name');
    const text = r('text');
    const rule = r('rule');
    return {
      baseline: part('baseline').getBoundingClientRect().bottom - st.top,
      nameLeft: name.left, nameSize: parseFloat(name.css.fontSize), nameColor: name.css.color, nameWeight: name.css.fontWeight,
      ruleTop: rule.top, ruleHeight: rule.height, ruleLeft: rule.left, ruleBg: rule.css.backgroundImage,
      textTop: text.top, textLeft: text.left, textSize: parseFloat(text.css.fontSize), lineHeight: parseFloat(text.css.lineHeight), textColor: text.css.color, textWeight: text.css.fontWeight,
      gradTop: r('gradient').top,
    };
  });
  expect(Math.abs(g.baseline - 835)).toBeLessThanOrEqual(6);
  expect(Math.abs(g.ruleTop - 847)).toBeLessThanOrEqual(6);
  expect(Math.abs(g.textTop - 881)).toBeLessThanOrEqual(6);
  expect(Math.abs(g.gradTop - 756)).toBeLessThanOrEqual(6);
  expect(Math.abs(g.nameLeft - 426)).toBeLessThanOrEqual(6);
  expect(Math.abs(g.ruleLeft - 414)).toBeLessThanOrEqual(6);
  expect(Math.abs(g.nameSize - 32)).toBeLessThanOrEqual(1);
  expect(Math.abs(g.textSize - 34)).toBeLessThanOrEqual(1);
  expect(Math.abs(g.lineHeight - 45)).toBeLessThanOrEqual(1);
  expect(g.ruleHeight).toBeGreaterThanOrEqual(1.5);
  expect(g.ruleHeight).toBeLessThanOrEqual(2.5);
  expect(g.nameColor).toBe('rgb(255, 255, 255)');
  expect(g.textColor).toBe('rgb(255, 255, 255)');
  expect(g.nameWeight).toBe('400');
  expect(g.ruleBg).toContain('rgb(162, 182, 206)'); // #A2B6CE
  // no frame, no rounded panel, no coloured plate: the root has no border or radius
  const frame = await page.evaluate(() => {
    const css = getComputedStyle(document.querySelector('[data-testid=dialog]')!);
    return { border: css.borderTopWidth, radius: css.borderTopLeftRadius };
  });
  expect(frame).toEqual({ border: '0px', radius: '0px' });
  expect(errors).toEqual([]);
});

test('V2: bottom edge pixel is the deep purple #140C24 (+-10) over black; nothing is left when the area is hidden; the HUD has a 108 px menu button', async ({ page }) => {
  await openDemo(page);
  const b = await starts(page);
  await page.evaluate(() => { (document.querySelector('[data-testid=play-canvas]') as HTMLElement).style.visibility = 'hidden'; });
  await seek(page, b.s1b3! + 3);
  const withDialog = await analyse<number[]>(page, await stage(page).screenshot(), '(px) => px(300, 1076)');
  expect(Math.abs(withDialog[0]! - 0x14)).toBeLessThanOrEqual(10);
  expect(Math.abs(withDialog[1]! - 0x0c)).toBeLessThanOrEqual(10);
  expect(Math.abs(withDialog[2]! - 0x24)).toBeLessThanOrEqual(10);
  const top = await analyse<number[]>(page, await stage(page).screenshot(), '(px) => px(300, 740)'); // above the gradient: still black
  expect(top.slice(0, 3)).toEqual([0, 0, 0]);
  await seek(page, b['s1:est']! + 0.8); // establishing shot: dialogue area hidden
  const hidden = await analyse<number[]>(page, await stage(page).screenshot(), '(px) => px(300, 1076)');
  expect(hidden.slice(0, 3)).toEqual([0, 0, 0]);
  const menu = await page.evaluate(() => {
    const st = document.querySelector('[data-testid=play-stage]')!.getBoundingClientRect();
    const r = document.querySelector('[data-testid=hud-menu]')!.getBoundingClientRect();
    return { d: r.width, cx: st.right - (r.left + r.width / 2), cy: r.top + r.height / 2 - st.top };
  });
  expect(Math.abs(menu.d - 108)).toBeLessThanOrEqual(2);
  expect(Math.abs(menu.cx - 0.135 * 1080)).toBeLessThanOrEqual(3);
  expect(Math.abs(menu.cy - 0.064 * 1080)).toBeLessThanOrEqual(4); // N7: 0.064H is the circle centre
});

test('V4: the place banner is a 58 px bar centred at 540 px, #7F9BEA at 0.75, and plays 0.25 s in / 1.9 s hold / 0.2 s out', async ({ page }) => {
  await openDemo(page);
  const b = await starts(page);
  const t0 = b['s2:est']! + 0.9 + 0.9; // after the fade-in and the 0.9 s delay (scene_black)
  const rect = () => page.evaluate(() => {
    const el = document.querySelector('[data-testid=location-banner]') as HTMLElement;
    const st = document.querySelector('[data-testid=play-stage]')!.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    return { shown: getComputedStyle(el).display !== 'none', cy: r.top + r.height / 2 - st.top, h: r.height, w: r.width, opacity: Number(getComputedStyle(el).opacity), bg: getComputedStyle(el).backgroundImage, text: el.textContent };
  });
  await seek(page, t0 + 1.0);
  const hold = await rect();
  expect(hold.shown).toBe(true);
  expect(hold.text).toBe('车库练习室');
  expect(Math.abs(hold.cy - 540)).toBeLessThanOrEqual(6);
  expect(Math.abs(hold.h - 58)).toBeLessThanOrEqual(3);
  expect(hold.opacity).toBe(1);
  expect(hold.bg).toContain('rgba(127, 155, 234, 0.75)');
  await seek(page, t0 - 0.05);
  expect((await rect()).shown).toBe(false);
  await seek(page, t0 + 0.05);
  expect((await rect()).opacity).toBeLessThan(0.9);
  await seek(page, t0 + 0.25 + 1.9 + 0.2 + 0.05);
  expect((await rect()).shown).toBe(false);
  // seeking into the middle of the animation shows the same frame as sequential time would (pure function of time)
  await seek(page, t0 + 0.12);
  const a = await rect();
  await seek(page, t0 + 2.0);
  await seek(page, t0 + 0.12);
  expect(await rect()).toEqual(a);
});

test('V4: a dip to black lasts 0.6-0.8 s with pure black frames in the middle (30 fps sampling of what is on screen)', async ({ page }) => {
  await openDemo(page);
  const b = await starts(page);
  const t = b.s1b7!; // cutIn dip_black
  const samples: Array<{ at: number; lum: number }> = [];
  for (let i = -18; i <= 24; i++) {
    const at = t + i / 30;
    await seek(page, at);
    const shot = await stage(page).screenshot();
    samples.push({ at, lum: await analyse<number>(page, shot, '(px, lum) => lum(0, 0, 1500, 700)') });
  }
  const dark = samples.filter((s) => s.lum < 40);
  const pure = samples.filter((s) => s.lum < 1.5);
  expect(pure.length).toBeGreaterThanOrEqual(3);
  const span = dark.at(-1)!.at - dark[0]!.at;
  expect(span).toBeGreaterThanOrEqual(0.3); // brightness thresholds cut the fade ramps short; the exact 0.65 s is asserted on the state below
  expect(span).toBeLessThanOrEqual(0.8);
  const alpha: number[] = [];
  for (let i = -18; i <= 24; i++) {
    await seek(page, t + i / 30);
    alpha.push((await state(page)).fade.alpha);
  }
  const lit = alpha.map((a, i) => (a > 0.001 ? i : -1)).filter((i) => i >= 0);
  const secs = (lit.at(-1)! - lit[0]! + 1) / 30;
  expect(secs).toBeGreaterThanOrEqual(0.6);
  expect(secs).toBeLessThanOrEqual(0.8);
});

test('V6: a person entering fades in over 6 +-1 frames and slides in 0.04H; the dialogue starts with the fade', async ({ page }) => {
  await openDemo(page);
  const b = await starts(page);
  const t = b.s1b3!; // 灯 enters (from the left)
  const ops: number[] = [];
  let slide0 = 0;
  for (let i = -3; i <= 12; i++) {
    await seek(page, t + i / 30);
    const a = (await state(page)).actors.find((x) => x.castId === 'c_001')!;
    ops.push(a.opacity);
    if (i === 0) slide0 = a.slideH;
  }
  expect(ops[0]).toBe(0);
  expect(ops.at(-1)).toBe(1);
  const mid = ops.filter((o) => o > 0.001 && o < 0.999).length;
  expect(mid).toBeGreaterThanOrEqual(5);
  expect(mid).toBeLessThanOrEqual(7);
  expect(slide0).toBeCloseTo(-0.04, 2);
});

test('V5 / V1: close-ups blur the background more (Laplacian variance cu < 0.4 x mcu); the establishing shot is sharp', async ({ page }) => {
  await openDemo(page);
  const b = await starts(page);
  const energy = async (t: number) => {
    await seek(page, t);
    return analyse<number>(page, await stage(page).screenshot(), '(px, lum, lap) => lap(20, 120, 360, 520)');
  };
  const est = await energy(b['s1:est']! + 0.8);
  const mcu = await energy(b.s1b1! + 3);
  const cu = await energy(b.s1b7! + 3);
  expect(cu, `est=${est} mcu=${mcu} cu=${cu}`).toBeLessThan(mcu * 0.4);
  expect(mcu).toBeLessThan(est);
  expect((await state(page)).background.blur).toBeGreaterThan(5);
});

test('V5: actors are multiplied by 0.92 (pixels within 10% of the untinted ones, and not identical)', async ({ page }) => {
  await openDemo(page);
  const b = await starts(page);
  const t = b.s1b3! + 3;
  const meanActor = async () => {
    await seek(page, t);
    return analyse<number>(page, await stage(page).screenshot(), '(px, lum) => lum(1500, 600, 120, 60)'); // her plaid dress, right actor
  };
  const base = await meanActor();
  const project = await page.evaluate(() => window.__studio.player!.project());
  const flat = structuredClone(project) as Project;
  flat.style.overrides['stage.actorTint'] = 1;
  await page.evaluate((p) => window.__studio.player!.reload(p), flat);
  await expect.poll(() => page.evaluate(() => window.__studio.player!.busy()), { timeout: 60_000 }).toBe(false);
  const untinted = await meanActor();
  expect(untinted).toBeGreaterThan(base);
  expect(Math.abs(base / untinted - 0.92)).toBeLessThan(0.03);
  expect(Math.abs(1 - base / untinted)).toBeLessThanOrEqual(0.1);
});

test('V7: anxiety vignette darkens + desaturates the edges, memory glow splits colours, Dutch angle keeps every corner covered', async ({ page }) => {
  const errors = await openDemo(page);
  const b = await starts(page);
  const t = b.s2b6! + 3;
  await seek(page, t);
  expect((await state(page)).fx.anxiety).toBe(1);
  const on = await analyse<{ corner: number; centre: number }>(page, await stage(page).screenshot(), '(px, lum) => ({ corner: lum(0, 0, 160, 160), centre: lum(860, 200, 200, 200) })');
  const project = await page.evaluate(() => window.__studio.player!.project());
  const plain = structuredClone(project) as Project;
  for (const s of plain.scenes) s.tracks = s.tracks.filter((tr) => tr.channel !== 'fx');
  await page.evaluate((p) => window.__studio.player!.reload(p), plain);
  await expect.poll(() => page.evaluate(() => window.__studio.player!.busy()), { timeout: 60_000 }).toBe(false);
  await seek(page, t);
  expect((await state(page)).fx).toEqual({ anxiety: 0, glow: 0, roll: 0 });
  const off = await analyse<{ corner: number; centre: number }>(page, await stage(page).screenshot(), '(px, lum) => ({ corner: lum(0, 0, 160, 160), centre: lum(860, 200, 200, 200) })');
  expect(on.corner).toBeLessThan(off.corner * 0.6);

  // back to the original: glow + roll
  await page.evaluate((p) => window.__studio.player!.reload(p), project);
  await expect.poll(() => page.evaluate(() => window.__studio.player!.busy()), { timeout: 60_000 }).toBe(false);
  await seek(page, b.s2b7! + 2);
  const s = await state(page);
  expect(s.fx.glow).toBe(1);
  expect(s.fx.roll).toBe(10);
  const shot = await stage(page).screenshot();
  const corners = await analyse<number[][]>(page, shot, '(px) => [px(2, 2), px(1917, 2), px(2, 1077), px(1917, 1077)]');
  for (const c of corners) expect(c[0]! + c[1]! + c[2]!).toBeGreaterThan(30); // never the black clear colour
  await seek(page, b.s2b8! + 2);
  expect((await state(page)).fx.roll).toBe(-10); // directions alternate
  expect(errors).toEqual([]);
});

test('V6/V8: a style edit reaches the preview at once (dialogue name size) and the style layers resolve in order', async ({ page, request }: { page: Page; request: APIRequestContext }) => {
  await page.goto('/');
  await page.getByTestId('new-title').fill('风格联动');
  await page.getByTestId('btn-from-demo').click();
  await expect(page.getByTestId('workspace')).toBeVisible();
  const id = /\/editor\/([^/]+)$/.exec(page.url())![1]!;
  try {
    await expect(page.getByTestId('play-status')).toHaveText('就绪', { timeout: 180_000 });
    const b = await starts(page);
    await seek(page, b.s1b3! + 3);
    const size = () => page.evaluate(() => parseFloat(getComputedStyle(document.querySelector('[data-part=name]')!).fontSize));
    const before = await size();
    await page.getByTestId('insp-tab-style').click();
    // project layer: open the style section, the dialogue group, and set the name size
    await page.getByTestId('insp-style-project').getByRole('button', { name: /风格预设（全局）/ }).click();
    await page.getByTestId('insp-style-group-project-对话区').getByRole('button', { name: '对话区' }).click();
    const input = page.getByTestId('style-input-project-dialog.nameSize');
    await input.fill('0.05');
    await input.blur();
    await expect.poll(size, { timeout: 15_000 }).toBeGreaterThan(before * 1.4);
    await expect(page.getByTestId('style-project-dialog.nameSize')).toHaveClass(/own/);
    // inherited value is labelled with its origin; resetting brings the preset value back
    await page.getByRole('button', { name: /恢复继承 名字字号/ }).click();
    await expect.poll(size, { timeout: 15_000 }).toBeCloseTo(before, 0);
  } finally {
    await request.delete(`/api/projects/${id}`);
  }
});
