import { expect, test, type Page } from '@playwright/test';
import './helpers/studio';

const TOTO = '001_casual_spring_01';
const TOTO_UNIFORM = '001_school_winter_hs_1st';
const ANON = '002_casual_spring_01';

async function openDemo(page: Page) {
  const errors: string[] = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/play/demo');
  await expect(page.getByTestId('play-status')).toHaveText('就绪', { timeout: 180_000 });
  return errors;
}

async function seek(page: Page, t: number) {
  await page.evaluate((x) => window.__studio.player!.seek(x), t);
  await expect.poll(() => page.evaluate(() => window.__studio.player!.busy()), { timeout: 60_000 }).toBe(false);
  await page.waitForTimeout(300);
}

const state = (page: Page) => page.evaluate(() => window.__studio.player!.state()!);
const angle = (page: Page, id: string) => page.evaluate((m) => window.__studio.getActorParams(m, ['ParamAngleX']).ParamAngleX!.applied, id);

const beatStart = (page: Page, beatId: string) => page.evaluate((id) => window.__studio.player!.beatStarts()[id]!, beatId);

test('plays the demo: dialogue box, speaker plate, typewriter text and no errors', async ({ page }) => {
  const errors = await openDemo(page);
  const d = await page.evaluate(() => window.__studio.player!.duration());
  expect(d).toBeGreaterThan(60);
  await page.getByTestId('play-rate').selectOption('2');
  await page.getByTestId('play-toggle').click();
  await expect.poll(async () => (await state(page)).t, { timeout: 15_000 }).toBeGreaterThan(5);
  await expect(page.getByTestId('dialog')).toBeVisible();
  expect((await state(page)).sceneId).toBe('s1');
  await page.getByTestId('play-toggle').click(); // pause
  const t = await page.evaluate(() => window.__studio.player!.time());
  await page.waitForTimeout(600);
  expect(await page.evaluate(() => window.__studio.player!.time())).toBe(t); // paused really stops the clock
  expect(errors).toEqual([]);
});

test('seek lands on the correct costume, camera, facing and dialogue for any point', async ({ page }) => {
  const errors = await openDemo(page);
  const starts = await page.evaluate(() => window.__studio.player!.sceneStarts());
  expect(starts).toHaveLength(3);

  // scene 1: two people face each other (head yaw opposite), mcu on toto, eyes down
  const b3 = await beatStart(page, 's1b5');
  await seek(page, b3 + 1.0);
  let s = await state(page);
  expect(s.sceneId).toBe('s1');
  expect(s.camera.zoom).toBeGreaterThan(3); // people shots are always close (no full-body framing)
  expect(s.subtitle!.speakerId).toBe('c_001');
  expect(await angle(page, TOTO)).toBeGreaterThan(5);
  // (the partner is hidden for the single-person shot, P7.3 N4: her facing is checked in the two-shot before it)
  const toto = s.actors.find((a) => a.castId === 'c_001')!;
  expect(toto.modelId).toBe(TOTO);
  expect(toto.gaze.y).toBeLessThan(-0.5);
  expect(toto.desiredYaw).toBeGreaterThan(0.5);
  await expect(page.getByTestId('dialog')).toContainText('高松灯');
  await seek(page, (await beatStart(page, 's1b4')) + 1.0);
  expect(await angle(page, TOTO)).toBeGreaterThan(5);
  expect(await angle(page, ANON)).toBeLessThan(-5);

  // scene 2 starts with the scene-change black (the actors are all in the scene, entering later)
  await seek(page, starts[1]! + 0.5);
  s = await state(page);
  expect(s.sceneId).toBe('s2');
  expect(s.transition?.kind).toBe('scene_black');
  expect(s.actors).toHaveLength(3);

  // scene 3: costume change inside the scene
  const sw = await beatStart(page, 's3b4');
  await seek(page, sw - 0.3);
  expect((await state(page)).actors.find((a) => a.castId === 'c_001')!.modelId).toBe(TOTO);
  await seek(page, sw + 0.8);
  s = await state(page);
  expect(s.actors.find((a) => a.castId === 'c_001')!.modelId).toBe(TOTO_UNIFORM);

  // final fade to black
  await seek(page, await page.evaluate(() => window.__studio.player!.duration()));
  expect((await state(page)).fade).toEqual({ color: 'black', alpha: 1 });
  expect(errors).toEqual([]);
});

test('seeking to a time reproduces the frame that sequential playback showed there', async ({ page }) => {
  await openDemo(page);
  const b4 = await beatStart(page, 's1b4');
  const t = b4 + 1.3;
  await seek(page, t - 1.5);
  await page.getByTestId('play-toggle').click();
  await expect.poll(() => page.evaluate(() => window.__studio.player!.time()), { timeout: 15_000 }).toBeGreaterThan(t);
  await page.getByTestId('play-toggle').click();
  const played = await state(page);
  expect(played.t).toBeGreaterThanOrEqual(t);
  await seek(page, 3);
  await seek(page, played.t);
  expect(await state(page)).toEqual(played);
  await seek(page, 25);
  await seek(page, played.t);
  expect(await state(page)).toEqual(played);
  expect(Math.sign(await angle(page, TOTO))).toBe(1);
  expect(Math.sign(await angle(page, ANON))).toBe(-1);
});

test('manual advance: playback holds at the end of each line until the user clicks; a click first finishes the text', async ({ page }) => {
  await openDemo(page);
  const b2 = await beatStart(page, 's1b3');
  await page.getByTestId('play-auto').uncheck();
  await seek(page, b2 + 0.2);
  await page.getByTestId('play-rate').selectOption('4');
  await page.getByTestId('play-toggle').click();
  await page.waitForTimeout(3500);
  const s = await state(page);
  expect(s.subtitle!.beatId).toBe('s1b3'); // held at the end of the line
  expect(s.subtitle!.visibleChars).toBe(s.subtitle!.totalChars);
  const held = await page.evaluate(() => window.__studio.player!.time());
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => window.__studio.player!.time())).toBe(held);
  await page.getByTestId('play-stage').click();
  await expect.poll(async () => (await state(page)).subtitle?.beatId, { timeout: 10_000 }).toBe('s1b4');
  await page.getByTestId('play-toggle').click(); // pause
  await seek(page, (await beatStart(page, 's1b5')) + 0.3);
  const typing = (await state(page)).subtitle!;
  expect(typing.visibleChars).toBeLessThan(typing.totalChars);
  await page.getByTestId('play-next').click();
  await expect
    .poll(async () => {
      const x = (await state(page)).subtitle!;
      return x.visibleChars === x.totalChars;
    })
    .toBe(true);
});

test('no actor is ever mirrored', async ({ page }) => {
  await openDemo(page);
  for (const t of [2, 7, 14, 22, 26]) {
    await seek(page, t);
    const rs = await page.evaluate(() => window.__studio.getRenderState());
    expect(rs.length).toBeGreaterThan(0);
    for (const r of rs) {
      expect(r.worldTransform.a).toBeGreaterThan(0);
      expect(r.worldTransform.d).toBeGreaterThan(0);
    }
  }
});

test('unknown project ids say so instead of pretending', async ({ page }) => {
  await page.goto('/play/nope');
  await expect(page.getByTestId('play-error')).toContainText('不存在', { timeout: 30_000 });
});

test('seeking into the middle of a one-shot motion shows the pose sequential playback reaches (M2)', async ({ page }) => {
  const errors = await openDemo(page);
  const ids = ['ParamAngleX', 'ParamAngleY', 'ParamBodyAngleX'];
  const base = () => page.evaluate(([m, p]) => {
    const v = window.__studio.getActorParams(m!, p as string[]);
    return Object.values(v).map((x) => x.base);
  }, [TOTO, ids] as const);
  const b5 = await beatStart(page, 's1b5'); // toto starts a one-shot gesture here (rule director)
  await seek(page, b5 - 0.2);
  await page.evaluate(() => window.__studio.player!.play());
  await page.waitForFunction((x) => window.__studio.player!.time() >= x, b5 + 1.5);
  const sequential = await page.evaluate(([m, p]) => {
    window.__studio.player!.pause();
    const v = window.__studio.getActorParams(m!, p as string[]);
    return { t: window.__studio.player!.time(), v: Object.values(v).map((x) => x.base) };
  }, [TOTO, ids] as const);
  // an unrelated seek first, so the actor is not already at that pose
  await seek(page, b5 - 1);
  await seek(page, sequential.t);
  const jumped = await base();
  jumped.forEach((v, i) => expect(Math.abs(v - sequential.v[i]!)).toBeLessThan(3));
  expect(errors).toEqual([]);
});
