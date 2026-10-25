import { expect, test, type Page } from '@playwright/test';
import fs from 'node:fs';
import { ProjectSchema } from '../../shared/schema/project';
import { newProjectId } from '../../shared/project/blank';
import './helpers/studio';

test.setTimeout(240_000);
const demo = ProjectSchema.parse(JSON.parse(fs.readFileSync(new URL('../fixtures/demo-project.json', import.meta.url), 'utf8')));
const created: string[] = [];
const ready = (page: Page) => expect(page.getByTestId('play-status')).toHaveText('就绪', { timeout: 180_000 });

test.beforeEach(async ({ page }) => {
  // The editor requests the hub list on mount. Never read the maintainer's own stories in these tests.
  await page.route('**/api/projects', (route) => route.request().method() === 'GET'
    ? route.fulfill({ json: [] }) : route.continue());
});
test.afterEach(async ({ request }) => {
  for (const id of created.splice(0)) {
    expect((await request.delete(`/api/projects/${id}`)).ok()).toBe(true);
    expect((await request.get(`/api/projects/${id}`)).status()).toBe(404);
  }
});

test('放映先保存最新编辑；保存失败停留，保存中禁止重复放映', async ({ page, request }) => {
  const project = ProjectSchema.parse({ ...demo, id: newProjectId(), title: '播放器入口回归（测试副本）' });
  expect((await request.post('/api/projects', { data: project })).ok()).toBe(true);
  created.push(project.id);
  await page.goto(`/editor/${project.id}`);
  await ready(page);
  await expect(page.getByTestId('btn-present')).toBeInViewport();
  await page.getByTestId('insp-tab-project').click();
  await page.getByTestId('insp-project-title').fill('本次放映使用刚编辑的标题');
  await expect(page.getByTestId('save-state')).toHaveText('有未保存的更改');

  const endpoint = `**/api/projects/${project.id}`;
  await page.route(endpoint, (route) => route.request().method() === 'PUT'
    ? route.fulfill({ status: 500, json: { error: '测试保存失败' } }) : route.continue());
  await page.getByTestId('btn-present').click();
  await expect(page.getByTestId('problem')).toContainText('测试保存失败');
  await expect(page).toHaveURL(new RegExp(`/editor/${project.id}$`));
  await expect(page.getByTestId('btn-present')).toBeEnabled();
  await page.unroute(endpoint);

  let saves = 0;
  let releaseSave = () => {};
  const gate = new Promise<void>((resolve) => { releaseSave = resolve; });
  await page.route(endpoint, async (route) => {
    if (route.request().method() === 'PUT') { saves++; await gate; }
    await route.continue();
  });
  await page.getByTestId('btn-present').click();
  await expect(page.getByTestId('btn-present')).toBeDisabled();
  await page.getByTestId('btn-present').evaluate((el) => (el as HTMLButtonElement).click());
  releaseSave();
  await expect(page).toHaveURL(new RegExp(`/play/${project.id}$`));
  await ready(page);
  expect(saves).toBe(1);
  await expect(page.locator('.play-heading h1')).toHaveText('本次放映使用刚编辑的标题');
  expect(await page.evaluate(() => window.__studio.player!.project().title)).toBe('本次放映使用刚编辑的标题');
  await page.getByTestId('play-back').click();
  await expect(page.getByTestId('ws-title')).toHaveText('本次放映使用刚编辑的标题');
});

async function fitted(page: Page, aspect = 16 / 9) {
  await expect.poll(async () => {
    const frame = await page.getByTestId('stage-frame').boundingBox();
    const area = await page.locator('.play-viewport').boundingBox();
    if (!frame || !area || frame.height < 1) return false;
    return Math.abs(frame.width / frame.height / aspect - 1) < .005
      && frame.x >= area.x - 1 && frame.y >= area.y - 1
      && frame.x + frame.width <= area.x + area.width + 1
      && frame.y + frame.height <= area.y + area.height + 1;
  }).toBe(true);
}

test('示例播放器适配窗口，原生全屏铺满且控制层可隐藏、唤回和退出', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto('/play/demo');
  await ready(page);
  await page.evaluate(() => window.__studio.player!.seek(3));
  await expect(page.getByTestId('play-back')).toHaveAttribute('href', '/');
  await expect(page.locator('.topbar')).toHaveCount(0);
  await fitted(page);
  await page.screenshot({ path: '.verify/player-normal-1280x720.png' });

  for (const [width, height] of [[1920, 1080], [900, 1200], [600, 400]] as const) {
    await page.setViewportSize({ width, height });
    await fitted(page);
    for (const id of ['play-toggle', 'play-next', 'play-rate', 'play-auto', 'play-aspect', 'play-fullscreen']) {
      await expect(page.getByTestId(id)).toBeInViewport();
    }
    if (width === 600) await page.screenshot({ path: '.verify/player-small-600x400.png' });
  }
  await page.getByTestId('play-aspect').selectOption({ index: 1 });
  await ready(page);
  await fitted(page, 1920 / 890);
  await page.getByTestId('play-aspect').selectOption({ index: 0 });
  await ready(page);
  await page.evaluate(() => window.__studio.player!.seek(3));
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.getByTestId('play-fullscreen').click();
  await expect.poll(() => page.evaluate(() => document.fullscreenElement?.getAttribute('data-testid'))).toBe('play-page');
  await expect.poll(() => page.locator('.play-viewport').evaluate((el) => {
    const r = el.getBoundingClientRect();
    return Math.abs(r.width - innerWidth) < 1 && Math.abs(r.height - innerHeight) < 1 && r.x === 0 && r.y === 0;
  })).toBe(true);
  await fitted(page);
  await page.mouse.move(50, 100);
  await page.screenshot({ path: '.verify/player-fullscreen-controls-1920x1080.png' });
  // Entering fullscreen must become immersive even before playback starts.
  await expect(page.getByTestId('play-deck')).toBeHidden({ timeout: 8000 });
  await page.mouse.move(60, 120);
  await page.getByTestId('play-toggle').click();
  await expect(page.getByTestId('play-toggle')).toContainText('暂停');
  // A pointer-focused button must not pin the controls open when the pointer stays over it.
  await expect(page.getByTestId('play-deck')).toBeHidden({ timeout: 8000 });
  await page.screenshot({ path: '.verify/player-fullscreen-immersive-1920x1080.png' });
  await page.mouse.move(80, 140);
  await expect(page.getByTestId('play-deck')).toBeVisible();
  await page.keyboard.press('Tab');
  await page.getByTestId('play-fullscreen').focus();
  await page.waitForTimeout(3000); // Keyboard focus must keep the controls available beyond the idle timeout.
  await expect(page.getByTestId('play-deck')).toBeVisible();
  await page.getByTestId('play-toggle').click();
  await expect(page.getByTestId('play-toggle')).toContainText('播放');
  await expect(page.getByTestId('play-deck')).toBeHidden({ timeout: 8000 });
  await page.mouse.move(100, 160);
  await expect(page.getByTestId('play-deck')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect.poll(() => page.evaluate(() => document.fullscreenElement === null)).toBe(true);
  await expect(page.getByTestId('play-deck')).toBeVisible();
  await fitted(page);
  await expect(page.getByTestId('play-back')).toBeInViewport();
});
