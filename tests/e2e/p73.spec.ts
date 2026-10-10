/**
 * P7.3 acceptance in a real browser: continuous playback at 1920 px wide (hard cuts, steady dialogue area, HUD),
 * the smoke vignette, and the inspector fixes (emotion, held shot badge, dof row).
 */
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
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
const display = (page: Page, id: string) => page.evaluate((x) => getComputedStyle(document.querySelector(`[data-testid=${x}]`)!).display, id);

interface Frame { t: number; dialog: string; cam: string; auto: string }

/** Plays from `from` for `seconds` of project time and records every animation frame. */
async function record(page: Page, from: number, seconds: number): Promise<Frame[]> {
  await seek(page, from);
  return page.evaluate(
    ([f, secs]) =>
      new Promise<Frame[]>((resolve) => {
        const out: Frame[] = [];
        const p = window.__studio.player!;
        void p.play();
        const step = () => {
          const t = p.time();
          const c = window.__studio.getCamera();
          out.push({
            t,
            dialog: getComputedStyle(document.querySelector('[data-testid=dialog]')!).display,
            cam: c ? `${c.x.toFixed(3)}|${c.y.toFixed(3)}|${c.zoom.toFixed(4)}` : '',
            auto: getComputedStyle(document.querySelector('[data-testid=hud-auto]')!).display,
          });
          if (t >= (f as number) + (secs as number)) {
            p.pause();
            resolve(out);
          } else requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      }),
    [from, seconds] as const,
  );
}

test('N1 + N2: continuous playback - camera changes are single-frame hard cuts, the dialogue area never blinks between lines', async ({ page }) => {
  const errors = await openDemo(page);
  const b = await starts(page);
  const from = b.s1b3! + 1.0; // after the 0.8 s reframe of c_001 walking in (an entrance, not a cut)
  const to = b.s1b5! + 3; // s1b3, s1b4 (same framing: held), s1b5 (mcu): dialogue the whole way
  const frames = await record(page, from, to - from);
  expect(frames.length).toBeGreaterThan(60);
  // N2: from the first frame of the first line to the end, the dialogue area is always there (also at every line start)
  const inside = frames.filter((f) => f.t >= from && f.t < to);
  expect(inside.filter((f) => f.dialog === 'none').map((f) => f.t.toFixed(3))).toEqual([]);
  expect(inside.filter((f) => f.auto === 'none')).toEqual([]);
  expect(frames.filter((f) => Math.abs(f.t - b.s1b4!) < 0.1).length).toBeGreaterThan(3); // the line change itself was sampled
  // N1: a camera change is one frame; never two changing frames in a row (that would be a slide)
  const changed = frames.slice(1).map((f, i) => f.cam !== frames[i]!.cam);
  expect(changed.some(Boolean)).toBe(true); // s1b5 cuts to a medium close-up
  for (let i = 1; i < changed.length; i++) expect(changed[i]! && changed[i - 1]!, `frame ${i} t=${frames[i]!.t}`).toBe(false);
  const cutAt = frames.find((f, i) => i > 0 && f.cam !== frames[i - 1]!.cam && f.t > b.s1b4!)!;
  expect(Math.abs(cutAt.t - b.s1b5!)).toBeLessThan(0.1);
  expect(errors).toEqual([]);
});

test('N7 + N8: HUD - menu button centre at 0.064H, auto mark follows the dialogue area, menu hides on pure black, the mark turns with the clock', async ({ page }) => {
  await openDemo(page);
  const b = await starts(page);
  await seek(page, b.s1b3! + 2);
  expect(await display(page, 'hud-auto')).toBe('block');
  const cy = await page.evaluate(() => {
    const st = document.querySelector('[data-testid=play-stage]')!.getBoundingClientRect();
    const r = document.querySelector('[data-testid=hud-menu]')!.getBoundingClientRect();
    return (r.top + r.height / 2 - st.top) / st.height;
  });
  expect(Math.abs(cy - 0.064)).toBeLessThan(0.004);
  await seek(page, b['s1:est']! + 0.8); // empty shot: dialogue area hidden, so is the mark
  expect(await display(page, 'hud-auto')).toBe('none');
  expect(await display(page, 'hud-menu')).not.toBe('none');
  // clock-driven rotation: the angle is a function of the project time, and paused it does not turn
  await seek(page, b.s1b3! + 2);
  const angle = () => page.evaluate(() => /rotate\((-?[\d.]+)deg\)/.exec((document.querySelector('[data-testid=hud-auto]') as HTMLElement).style.transform)![1]!);
  const a1 = Number(await angle());
  await page.waitForTimeout(500);
  expect(Number(await angle())).toBe(a1);
  expect(Math.abs(a1 - (((b.s1b3! + 2) * 72) % 360))).toBeLessThan(0.5);
  // pure black between the scenes (lead-in of the scene change): no menu button
  const s2 = await page.evaluate(() => window.__studio.player!.sceneStarts()[1]!);
  await seek(page, s2 + 2.0);
  const tr = (await state(page)).transition!;
  expect(tr.kind).toBe('scene_black');
  expect(tr.seconds).toBeGreaterThanOrEqual(tr.pause + tr.out);
  expect(await display(page, 'hud-menu')).toBe('none');
  await seek(page, b.s2b1! + 1); // the picture is back
  expect(await display(page, 'hud-menu')).not.toBe('none');
});

test('N4: next to a single-person close-up nobody is drawn half-faded or half-cut (non-focus people are fully in or fully out)', async ({ page }) => {
  await openDemo(page);
  const b = await starts(page);
  await seek(page, b.s1b5! + 1);
  const s = await state(page);
  const other = s.actors.find((a) => a.castId === 'c_002')!;
  expect(other.opacity === 0 || other.opacity === 1).toBe(true);
});

test('N9: the anxiety vignette has a smoke texture that the style can switch off', async ({ page }) => {
  await openDemo(page);
  const b = await starts(page);
  const t = b.s2b6! + 3;
  const edge = async () => {
    const png = await page.getByTestId('play-stage').screenshot();
    return page.evaluate(async (b64) => {
      const img = new Image();
      img.src = `data:image/png;base64,${b64}`;
      await img.decode();
      const c = document.createElement('canvas');
      c.width = img.width;
      c.height = img.height;
      const g = c.getContext('2d', { willReadFrequently: true })!;
      g.drawImage(img, 0, 0);
      const vals: number[] = [];
      for (let y = 160; y < 900; y += 24) {
        const d = g.getImageData(0, y, 200, 24).data;
        let s = 0;
        for (let i = 0; i < d.length; i += 4) s += 0.2126 * d[i]! + 0.7152 * d[i + 1]! + 0.0722 * d[i + 2]!;
        vals.push(s / (d.length / 4));
      }
      return vals;
    }, png.toString('base64'));
  };
  await seek(page, t);
  expect((await state(page)).fx.anxiety).toBe(1);
  const on = await edge();
  const project = await page.evaluate(() => window.__studio.player!.project());
  const flat = structuredClone(project);
  flat.style.overrides['fx.anxietySmoke'] = 0;
  await page.evaluate((p) => window.__studio.player!.reload(p), flat);
  await expect.poll(() => page.evaluate(() => window.__studio.player!.busy()), { timeout: 60_000 }).toBe(false);
  await seek(page, t);
  const off = await edge();
  // the smoke is a spatially varying layer: the difference to the flat vignette is not a constant offset
  const d = on.map((v, i) => v - off[i]!);
  const mean = d.reduce((a, v) => a + v, 0) / d.length;
  const sd = Math.sqrt(d.reduce((a, v) => a + (v - mean) ** 2, 0) / d.length);
  expect(Math.abs(mean)).toBeGreaterThan(2);
  expect(sd).toBeGreaterThan(1.5);
});

// ---- editor -------------------------------------------------------------------------------------------------------
const created: string[] = [];
test.afterEach(async ({ request }: { request: APIRequestContext }) => {
  for (const id of created.splice(0)) await request.delete(`/api/projects/${id}`);
});

test('N5 + N6 + N10: inspector shows the held-shot badge (forcing a cut clears it), the emotion field, and a tidy dof row', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.goto('/');
  await page.getByTestId('new-title').fill('P73 检查器');
  await page.getByTestId('btn-from-demo').click();
  await expect(page.getByTestId('workspace')).toBeVisible();
  created.push(/\/editor\/([^/]+)$/.exec(page.url())![1]!);
  await expect(page.getByTestId('play-status')).toHaveText('就绪', { timeout: 180_000 });

  // s1b4 answers in the same two-shot as s1b3: the camera is kept, and the UI says so
  await page.getByTestId('outline-beat-s1b4').click();
  await expect(page.getByTestId('outline-held-s1b4')).toBeVisible();
  await page.getByTestId('insp-tab-shot').click();
  await expect(page.getByTestId('insp-shot-held')).toBeVisible();
  await page.getByTestId('insp-shot-force-cut').click();
  await expect(page.getByTestId('insp-shot-held')).toHaveCount(0);
  await expect(page.getByTestId('outline-held-s1b4')).toHaveCount(0);

  // N6: emotion
  await page.getByTestId('insp-tab-beat').click();
  await expect(page.getByTestId('insp-beat-emotion')).toHaveValue('happy');
  await page.getByTestId('insp-beat-emotion').selectOption('sad');
  await expect(page.getByTestId('insp-beat-emotion')).toHaveValue('sad');
  await expect(page.getByTestId('insp-rule-output')).toContainText('表情');

  await page.getByTestId('insp-tab-shot').click();
  // N10: dof row - the two mode buttons stay on one line inside the panel, the slider is its own row
  await page.getByTestId('insp-shot-dof-manual').click();
  const box = await page.getByTestId('insp-shot-dof-manual').boundingBox();
  const panel = await page.getByTestId('inspector').boundingBox();
  expect(box!.height).toBeLessThan(40);
  expect(box!.x + box!.width).toBeLessThanOrEqual(panel!.x + panel!.width);
  const slider = await page.getByTestId('insp-shot-dof').boundingBox();
  expect(slider).not.toBeNull();
  expect(slider!.x + slider!.width).toBeLessThanOrEqual(panel!.x + panel!.width + 1);
  await page.getByTestId('insp-shot-dof-auto').click();
  await expect(page.getByTestId('insp-shot-dof')).toHaveCount(0);
  expect(errors).toEqual([]);
});
