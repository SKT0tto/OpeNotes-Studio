import { expect, test } from '@playwright/test';
import { CalibrationSchema } from '../../shared/schema/calibration';

test('probe of 001: head unit, ground, signs and L/R demo agree', async ({ page, request }) => {
  const errors: string[] = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.goto('/lab/actor?model=001_casual_spring_01');
  await expect(page.getByTestId('lab-status')).toContainText('已加载', { timeout: 60_000 });
  await page.getByTestId('cal-reprobe').click();
  await expect.poll(async () => (await (await request.get('/api/calibration/001_casual_spring_01')).json())?.verified, { timeout: 10_000 }).toBe(false);

  const cal = CalibrationSchema.parse(await (await request.get('/api/calibration/001_casual_spring_01')).json());
  const ratio = cal.head.height / cal.totalHeight;
  expect(ratio).toBeGreaterThan(0.1);
  expect(ratio).toBeLessThan(0.2);
  expect(cal.ground.y).toBeCloseTo(cal.bounds.y + cal.bounds.h, 3);
  expect(cal.head.bbox.y).toBeLessThan(cal.bounds.y + cal.bounds.h * 0.2); // head is at the top
  expect(cal.headSign).not.toBe(0);
  expect(cal.hasEyeBallX).toBe(true);

  await page.getByTestId('cal-demo').click();
  const demos = page.getByTestId('demos');
  await expect(demos).toContainText('mtn_idle01_R', { timeout: 15_000 });
  const expected = cal.headSign > 0 ? ['画面右', '画面左'] : ['画面左', '画面右'];
  await expect(demos).toContainText(`mtn_idle01_L：ParamAngleX 均值 22.04 → 计算面向${expected[0]}`);
  await expect(demos).toContainText(`→ 计算面向${expected[1]}`);
  expect(errors).toEqual([]);
});

test('model without head axes is calibrated with zero signs and flagged', async ({ page, request }) => {
  await page.goto('/lab/actor?model=sub_bota_casual_spring_01_still');
  await expect(page.getByTestId('lab-status')).toContainText('已加载', { timeout: 60_000 });
  await expect(page.getByText('无眼球轴')).toBeVisible();
  const cal = CalibrationSchema.parse(await (await request.get('/api/calibration/sub_bota_casual_spring_01_still')).json());
  expect([cal.headSign, cal.bodySign, cal.eyeSign]).toEqual([0, 0, 0]);
});
