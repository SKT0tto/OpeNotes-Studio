/**
 * Marquee (box) selection of beats: drag on the left gutter / empty space of the script list (or the storyboard) and every beat the
 * band touches joins the shared multi-selection; Ctrl / Shift adds; text fields keep their own text selection; Esc clears;
 * the assistant panel shows how many are selected.
 */
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { openDemoEditor } from './helpers/editor';

test.describe.configure({ mode: 'serial' });
test.setTimeout(240_000);

let page: Page;
let projectId = '';
const errors: string[] = [];

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(e.message));
  projectId = await openDemoEditor(page, '框选');
  await page.locator('body').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('Control+k'); // the assistant shows the selection
  await expect(page.getByTestId('agent-dock')).toBeVisible();
  await page.locator('body').click({ position: { x: 5, y: 5 } });
});
test.afterAll(async ({ request }: { request: APIRequestContext }) => {
  await page.close();
  await request.delete(`/api/projects/${projectId}`);
  expect(errors.filter((e) => !/favicon|Failed to load resource/.test(e))).toEqual([]);
});

const item = (id: string) => page.getByTestId(`outline-item-${id}`);
const selected = () => page.locator('[data-testid^=outline-beat-][data-multi=true]').evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')!.replace('outline-beat-', '')));
const gutterX = async () => (await page.getByTestId('script-editor').boundingBox())!.x + 6;
const rowBox = async (id: string) => (await item(id).boundingBox())!;

/** Drag from (x, y1) to (x, y2) with optional modifiers held. */
async function band(x: number, y1: number, y2: number, mods: Array<'Control' | 'Shift'> = [], xEnd = x) {
  for (const m of mods) await page.keyboard.down(m);
  await page.mouse.move(x, y1);
  await page.mouse.down();
  await page.mouse.move(x, (y1 + y2) / 2, { steps: 5 });
  await page.mouse.move(xEnd, y2, { steps: 5 });
  const during = await page.getByTestId('marquee-band').count();
  await page.mouse.up();
  for (const m of mods) await page.keyboard.up(m);
  return during;
}

test('dragging down the left gutter selects the beats it touches; the assistant shows the count', async () => {
  // line 1 is open in the editor: collapse the list to one selected beat first
  await page.getByTestId('outline-beat-s1b1').click();
  const [a, c] = [await rowBox('s1b2'), await rowBox('s1b4')];
  const during = await band(await gutterX(), a.y + 4, c.y + c.height - 4);
  expect(during).toBe(1); // the rubber band was drawn
  await expect(page.getByTestId('marquee-band')).toHaveCount(0);
  expect(await selected()).toEqual(['s1b2', 's1b3', 's1b4']);
  await expect(page.getByTestId('agent-context')).toContainText('已选 3 句');
  await expect(page.getByTestId('insp-multi')).toContainText('已选 3 句');
});

test('Ctrl (or Shift) while dragging adds to the selection; a plain drag replaces it', async () => {
  const s5 = await rowBox('s1b5');
  await band(await gutterX(), s5.y + 3, s5.y + s5.height - 3, ['Control']);
  expect(await selected()).toEqual(['s1b2', 's1b3', 's1b4', 's1b5']);
  await expect(page.getByTestId('agent-context')).toContainText('已选 4 句');
  // a plain drag over lines 1-2 replaces it
  const [r1, r2] = [await rowBox('s1b1'), await rowBox('s1b2')];
  await band(await gutterX(), r1.y + 3, r2.y + r2.height - 3);
  expect(await selected()).toEqual(['s1b1', 's1b2']);
  // Shift adds too, and works together with Ctrl+click
  const r4 = await rowBox('s1b4');
  await band(await gutterX(), r4.y + 3, r4.y + r4.height - 3, ['Shift']);
  expect(await selected()).toEqual(['s1b1', 's1b2', 's1b4']);
  await page.getByTestId('outline-beat-s1b3').click({ modifiers: ['Control'] });
  expect(await selected()).toEqual(['s1b1', 's1b2', 's1b3', 's1b4']);
  await expect(page.getByTestId('agent-context')).toContainText('已选 4 句');
});

test('Esc clears the selection; a press that does not move is just a click', async () => {
  await page.keyboard.press('Escape');
  expect(await selected()).toEqual([]);
  const r = await rowBox('s1b2');
  await page.mouse.click(await gutterX(), r.y + 6); // no drag: no band, nothing selected
  expect(await selected()).toEqual([]);
  await expect(page.getByTestId('marquee-band')).toHaveCount(0);
});

test('text selection inside an editable field still works (no marquee starts there)', async () => {
  await page.getByTestId('outline-beat-s1b1').click();
  const ta = page.getByTestId('script-text');
  await expect(ta).toBeVisible();
  await expect(ta).not.toHaveValue('');
  const b = (await ta.boundingBox())!;
  await page.mouse.move(b.x + 6, b.y + 10);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width - 10, b.y + 12, { steps: 6 });
  expect(await page.getByTestId('marquee-band').count()).toBe(0);
  await page.mouse.up();
  const sel = await ta.evaluate((el) => (el as HTMLTextAreaElement).selectionEnd - (el as HTMLTextAreaElement).selectionStart);
  expect(sel).toBeGreaterThan(0);
  expect(await selected()).toEqual([]);
});

test('dragging past the edge of the list auto-scrolls and keeps selecting', async () => {
  await page.keyboard.press('Escape');
  const scroller = page.getByTestId('script-editor').locator('xpath=..');
  expect(await scroller.evaluate((el) => el.scrollTop)).toBe(0);
  const first = await rowBox('s1b1');
  const view = (await scroller.boundingBox())!;
  const x = await gutterX();
  await page.mouse.move(x, first.y + 3);
  await page.mouse.down();
  await page.mouse.move(x, view.y + view.height / 2, { steps: 5 });
  await page.mouse.move(x, view.y + view.height - 4, { steps: 5 });
  await expect.poll(() => scroller.evaluate((el) => el.scrollTop), { timeout: 10_000 }).toBeGreaterThan(80);
  await page.waitForTimeout(600);
  await page.mouse.up();
  const total = await page.locator('[data-testid^=outline-beat-]').count();
  const n = (await selected()).length;
  expect(n).toBeGreaterThan(5);
  expect(n).toBeLessThanOrEqual(total);
  await expect(page.getByTestId('agent-context')).toContainText(`已选 ${n} 句`);
  await page.keyboard.press('Escape');
  await scroller.evaluate((el) => void (el.scrollTop = 0));
});

test('the storyboard cards can be box-selected too, into the same selection', async () => {
  await page.getByTestId('view-storyboard').click();
  await expect(page.getByTestId('storyboard')).toBeVisible();
  const [c1, c2] = [(await page.getByTestId('sb-card-s1b1').boundingBox())!, (await page.getByTestId('sb-card-s1b2').boundingBox())!];
  const inner = (await page.locator('.sb-inner').boundingBox())!;
  expect(Math.abs(c1.y - c2.y)).toBeLessThan(4); // the first two cards share a row
  // start in the left margin of the first row, sweep across the first two cards
  await page.mouse.move(inner.x + 5, c1.y + 20);
  await page.mouse.down();
  await page.mouse.move(inner.x + 30, c1.y + 30, { steps: 4 });
  await page.mouse.move(c2.x + c2.width / 2, c2.y + 40, { steps: 8 });
  expect(await page.getByTestId('marquee-band').count()).toBe(1);
  await page.mouse.up();
  const ids = await page.locator('[data-testid^=sb-card-].sel').evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')!.replace('sb-card-', '')));
  expect(ids).toEqual(expect.arrayContaining(['s1b1', 's1b2']));
  const count = ids.length;
  await expect(page.getByTestId('agent-context')).toContainText(`已选 ${count} 句`);
  await page.keyboard.press('Escape');
  await page.getByTestId('view-preview').click();
});
