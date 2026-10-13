/* global window */
/**
 * v0.1.5 verification screenshots (not shipped): the labelling workbench, the asset-browser cards, the timeline's 背景 lane and the picture
 * changing while playing. Writes .verify/v015-*.png. Needs the dev server on 5273 (npm run dev). Usage: node scripts/verify/v015-shots.mjs
 */
import fs from 'node:fs';
import { chromium } from '@playwright/test';

const BASE = process.env.BASE ?? 'http://127.0.0.1:5273';
fs.mkdirSync('.verify', { recursive: true });
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const shot = (name) => page.screenshot({ path: `.verify/v015-${name}.png` });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

// 1. workbench: grid and queue
await page.goto(`${BASE}/label`);
await page.getByTestId('wb-card').first().waitFor();
await page.waitForTimeout(2500);
await page.locator('[data-testid="wb-card"]').nth(0).click();
await page.locator('[data-testid="wb-card"]').nth(1).click({ modifiers: ['Control'] });
await shot('workbench-grid');
await page.getByTestId('wb-tab-queue').click();
await page.getByTestId('wbq-side').waitFor();
await page.waitForTimeout(2500);
await shot('workbench-queue');
// the queue on a picture that carries a review suggestion
await page.getByTestId('wb-tab-grid').click();
await page.getByTestId('wb-search').fill('拉面店吧台');
await page.getByTestId('wb-card').first().dblclick();
await page.getByTestId('wbq-fix').first().waitFor();
await page.waitForTimeout(1500);
await shot('workbench-queue-suggestion');

// 2. browser cards (search 夜 卧室)
await page.goto(`${BASE}/assets`);
await page.getByRole('tab', { name: /^背景/ }).click();
await page.getByTestId('bg-cards').waitFor();
await page.getByLabel('搜索背景').fill('夜 卧室');
await page.waitForTimeout(2500);
await shot('browser-cards');

// 3. editor: a scene with two background switches, the timeline lane, and the picture while playing
await page.goto(`${BASE}/`);
await page.getByTestId('new-title').fill('v015 截图');
await page.getByTestId('btn-from-demo').click();
await page.getByTestId('workspace').waitFor();
await page.getByTestId('play-status').filter({ hasText: '就绪' }).waitFor({ timeout: 180_000 });
const projectId = /\/editor\/([^/]+)$/.exec(page.url())[1];
const beat = (id) => page.evaluate((x) => window.__studio.player.beatStarts()[x], id);
const seek = async (t) => {
  await page.evaluate((x) => window.__studio.player.seek(x), t);
  await page.waitForFunction(() => !window.__studio.player.busy());
  await page.waitForTimeout(500);
};
const addSwitch = async (t, query, transition) => {
  const lane = page.getByTestId('tl-lane-bg').locator('.tl-lane');
  await lane.scrollIntoViewIfNeeded();
  const b = await lane.boundingBox();
  await page.mouse.dblclick(b.x + t * 60, b.y + b.height - 3);
  await page.getByTestId('picker-search').fill(query);
  await page.getByTestId('picker-card').first().waitFor();
  await page.waitForTimeout(1500);
  await shot('picker');
  await page.getByTestId('picker-card').first().click();
  await page.waitForTimeout(1200);
  if (transition) await page.getByTestId('key-bg-transition').selectOption(transition);
  await page.waitForTimeout(800);
};
const t3 = await beat('s1b3');
const t6 = t3 + 3.5 - 0.5;
await addSwitch(t3 + 0.5, '夜 卧室', 'crossfade');
await addSwitch(t6 + 0.5, 'RiNG', 'dip_black');
await seek(t3 + 0.2);
await shot('timeline-bg-track');
await seek(t3 + 0.2);
await shot('play-before');
await seek(t3 + 0.5 + 0.5);
await shot('play-crossfade-mid');
await seek(t3 + 0.5 + 2.2);
await shot('play-after');
await seek(t6 + 1.5);
await shot('play-second-switch');
await page.request.delete(`${BASE}/api/projects/${projectId}`);
console.log('page errors:', errors.length ? errors : 'none');
await browser.close();
