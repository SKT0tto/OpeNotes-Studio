import { expect, type Page } from '@playwright/test';
import type { Project } from '../../../shared/schema/project';
import './studio';

/** Opens the editor on a fresh copy of the demo project; returns its id. */
export async function openDemoEditor(page: Page, title: string): Promise<string> {
  await page.goto('/');
  await page.getByTestId('new-title').fill(title);
  await page.getByTestId('btn-from-demo').click();
  await expect(page.getByTestId('workspace')).toBeVisible();
  await expect(page.getByTestId('play-status')).toHaveText('就绪', { timeout: 180_000 });
  return /\/editor\/([^/]+)$/.exec(page.url())![1]!;
}

export const seekTo = async (page: Page, t: number) => {
  await page.evaluate((x) => window.__studio.player!.seek(x), t);
  await expect.poll(() => page.evaluate(() => window.__studio.player!.busy()), { timeout: 60_000 }).toBe(false);
  await page.waitForTimeout(300);
};
export const beatStart = (page: Page, id: string) => page.evaluate((x) => window.__studio.player!.beatStarts()[x]!, id);
/** The project the preview is playing (the editor pushes every edit into it, debounced). */
export const playing = (page: Page) => page.evaluate(() => window.__studio.player!.project()) as Promise<Project>;
export const stateOf = (page: Page) => page.evaluate(() => window.__studio.player!.state()!);
/** Waits until the preview has picked up the latest edit (the player's project changed by reference and is idle). */
export async function settled(page: Page) {
  await page.waitForTimeout(500);
  await expect.poll(() => page.evaluate(() => window.__studio.player!.busy()), { timeout: 60_000 }).toBe(false);
}
export async function dragBy(page: Page, from: { x: number; y: number }, dx: number, dy = 0) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + dx / 2, from.y + dy / 2, { steps: 5 });
  await page.mouse.move(from.x + dx, from.y + dy, { steps: 5 });
  await page.mouse.up();
}
export const center = async (loc: import('@playwright/test').Locator) => {
  const b = (await loc.boundingBox())!;
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
};
