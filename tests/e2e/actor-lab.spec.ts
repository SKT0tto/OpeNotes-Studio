import { expect, test, type Page } from '@playwright/test';

const MODEL = '001_casual_spring_01';

async function openLab(page: Page, model = MODEL) {
  const errors: string[] = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`/lab/actor?model=${model}`);
  await expect(page.getByTestId('lab-status')).toContainText('已加载', { timeout: 60_000 });
  return errors;
}

const setSlider = (page: Page, name: string, v: number) =>
  page.evaluate(
    ([n, val]) => {
      const el = document.querySelector<HTMLInputElement>(`[data-testid=slider-${n}]`)!;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, String(val));
      el.dispatchEvent(new Event('input', { bubbles: true }));
    },
    [name, v] as const,
  );

const delta = (page: Page, id: string) =>
  page.evaluate(
    ([m, p]) => {
      const r = (window as unknown as { __studio: { getActorParams(a: string, ids: string[]): Record<string, { applied: number; base: number }> } }).__studio.getActorParams(m!, [p!])[p!]!;
      return r.applied - r.base;
    },
    [MODEL, id],
  );

test('headYaw drives ParamAngleX by the mapped amount and returns to the motion value without drift', async ({ page }) => {
  const errors = await openLab(page);
  const sign = Number(await page.getByTestId('cal-headSign').inputValue());
  expect(sign).not.toBe(0);
  await page.waitForTimeout(500);
  expect(Math.abs(await delta(page, 'ParamAngleX'))).toBeLessThan(1);

  await setSlider(page, 'headYaw', 0.5);
  await page.waitForTimeout(700);
  expect(Math.abs((await delta(page, 'ParamAngleX')) - sign * 15)).toBeLessThan(2);
  expect(Math.abs(await delta(page, 'ParamBodyAngleX'))).toBeLessThan(1); // body untouched
  expect(Math.abs(await delta(page, 'ParamEyeBallX'))).toBeLessThan(0.05); // gaze untouched

  await setSlider(page, 'gazeX', 1);
  await page.waitForTimeout(500);
  expect(Math.abs(await delta(page, 'ParamEyeBallX'))).toBeGreaterThan(0.9);

  // wiggle for a while, then return to zero
  for (let i = 0; i < 20; i++) {
    await setSlider(page, 'headYaw', Math.sin(i) * 0.9);
    await setSlider(page, 'bodyYaw', Math.cos(i) * 0.9);
    await page.waitForTimeout(100);
  }
  await setSlider(page, 'headYaw', 0);
  await setSlider(page, 'bodyYaw', 0);
  await setSlider(page, 'gazeX', 0);
  await page.waitForTimeout(2000);
  expect(Math.abs(await delta(page, 'ParamAngleX'))).toBeLessThan(0.5);
  expect(Math.abs(await delta(page, 'ParamBodyAngleX'))).toBeLessThan(0.5);
  expect(Math.abs(await delta(page, 'ParamEyeBallX'))).toBeLessThan(0.02);
  expect(errors).toEqual([]);
});

test('actors are never flipped', async ({ page }) => {
  await openLab(page);
  const states = await page.evaluate(() => (window as unknown as { __studio: { getRenderState(): Array<{ worldTransform: { a: number; d: number } }> } }).__studio.getRenderState());
  expect(states.length).toBeGreaterThan(0);
  for (const s of states) {
    expect(s.worldTransform.a).toBeGreaterThan(0);
    expect(s.worldTransform.d).toBeGreaterThan(0);
  }
});

test('facing pipeline: desired yaw picks the variant and the residual lands the head near the target', async ({ page }) => {
  await openLab(page);
  const sign = Number(await page.getByTestId('cal-headSign').inputValue());
  await page.getByTestId('facing-family').selectOption('idle01');
  await page.getByTestId('facing-want').fill('0.9');
  await page.getByTestId('facing-apply').click();
  await expect(page.getByTestId('facing-chosen')).toContainText(sign > 0 ? 'idle01_L' : 'idle01_R');
  await page.waitForTimeout(1500);
  const applied = await page.evaluate(
    (m) => (window as unknown as { __studio: { getActorParams(a: string, ids: string[]): Record<string, { applied: number }> } }).__studio.getActorParams(m, ['ParamAngleX']).ParamAngleX!.applied,
    MODEL,
  );
  expect(Math.abs(applied * sign - 0.9 * 30)).toBeLessThan(5);
});
