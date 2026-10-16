/**
 * The camera system switch in the top toolbar (经典 | 运镜): one click, undoable, shows the travel segments on the timeline and in the shot
 * inspector; a scene that deviates from the project gets a chip. Works on a copy of the bundled demo project (deleted at the end).
 */
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import fs from 'node:fs';
const demo = JSON.parse(fs.readFileSync('tests/fixtures/demo-project.json', 'utf8'));
import { beatStart, center, dragBy, playing, seekTo, settled, stateOf } from './helpers/editor';

test.describe.configure({ mode: 'serial' });
test.setTimeout(300_000);

let page: Page;
let projectId = '';
const errors: string[] = [];
const directorRequests: string[] = [];

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(e.message));
  // EditorApp eagerly requests the hub list even on a direct URL. Never access private projects.
  await page.route('**/api/projects', route => route.request().method() === 'GET' ? route.fulfill({ json: [] }) : route.continue());
  // Fail closed if a mode switch ever starts generation; this test never calls an LLM.
  await page.route('**/api/director/**', async route => {
    directorRequests.push(route.request().url());
    await route.fulfill({ status: 500, json: { error: 'Unexpected director request' } });
  });
  const response = await page.request.post('/api/projects', { data: { ...demo, id: `p_camera_${Date.now()}`, title: '镜头系统开关' } });
  expect(response.ok()).toBe(true);
  projectId = (await response.json()).id;
  await page.goto(`/editor/${projectId}`);
  await expect(page.getByTestId('play-status')).toHaveText('就绪', { timeout: 180_000 });
});
test.afterAll(async ({ request }: { request: APIRequestContext }) => {
  await page.close();
  await request.delete(`/api/projects/${projectId}`);
});

const travelOn = () => page.getByTestId('cam-system-travel');
const classicOn = () => page.getByTestId('cam-system-classic');
const travelNotice = () => page.getByTestId('camera-travel-notice');

test('the switch sits in the top toolbar, defaults to classic and is one undo step', async () => {
  await expect(page.getByTestId('cam-system')).toBeVisible();
  await expect(classicOn()).toHaveAttribute('aria-checked', 'true');
  await expect(travelOn()).toHaveAttribute('aria-checked', 'false');
  await expect(page.getByTestId('btn-undo')).toBeDisabled();
  await expect(page.locator('[data-testid^="tl-travel-"]')).toHaveCount(0);

  const originalScenes = (await playing(page)).scenes;
  await expect(travelNotice()).toHaveCount(0);
  await travelOn().click();
  await expect(travelOn()).toHaveAttribute('aria-checked', 'true');
  await expect(travelNotice()).toBeVisible();
  await expect(travelNotice()).toContainText('切换不会重新设计分镜');
  await expect(travelNotice()).toContainText('这个项目没有原文');
  await expect(page.getByTestId('camera-travel-regenerate')).toBeDisabled();
  await expect(page.getByTestId('camera-travel-regenerate-reason')).toContainText('没有原文');
  await page.getByTestId('camera-travel-notice-dismiss').click();
  await expect(travelNotice()).toHaveCount(0);
  await travelOn().click();
  await expect(travelNotice()).toHaveCount(0);
  await expect(page.getByTestId('btn-undo')).toBeEnabled();
  expect((await playing(page)).settings.cameraSystem).toBe('travel');
  expect((await playing(page)).scenes).toEqual(originalScenes);
  expect(directorRequests).toEqual([]);

  // the first shot of the scene settles into its framing: the shot inspector says so and the timeline shows the segment
  const first = (await playing(page)).scenes[0]!.beats[0]!.id;
  await page.getByTestId('insp-tab-shot').click();
  await page.getByTestId(`tl-shot-${first}`).click();
  await expect(page.getByTestId('insp-shot-travel')).toBeVisible({ timeout: 30_000 });
  await expect.poll(() => page.locator('[data-testid^="tl-travel-"]').count(), { timeout: 30_000 }).toBeGreaterThan(0);

  await page.getByTestId('btn-undo').click();
  await expect(classicOn()).toHaveAttribute('aria-checked', 'true');
  await expect.poll(() => page.locator('[data-testid^="tl-travel-"]').count(), { timeout: 30_000 }).toBe(0);
  expect((await playing(page)).settings.cameraSystem).toBeUndefined();
  await expect(page.getByTestId('btn-undo')).toBeDisabled();
  await expect(travelNotice()).toHaveCount(0);
  await page.getByTestId('btn-redo').click();
  await expect(travelOn()).toHaveAttribute('aria-checked', 'true');
  await expect(travelNotice()).toHaveCount(0);
  await settled(page);
  expect((await playing(page)).scenes).toEqual(originalScenes);
  expect(directorRequests).toEqual([]);
  await page.getByTestId('btn-undo').click();
  await expect(classicOn()).toHaveAttribute('aria-checked', 'true');
  await settled(page);
});

test('a scene that differs from the project shows a chip; the chip opens the scene page', async () => {
  await travelOn().click();
  await expect(travelNotice()).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(travelNotice()).toHaveCount(0);
  await expect(page.getByTestId('cam-system-scene-override')).toHaveCount(0);
  await page.getByTestId('insp-tab-scene').click();
  await page.getByTestId('insp-scene-camera-system').selectOption('classic');
  await expect(page.getByTestId('cam-system-scene-override')).toBeVisible();
  await expect(page.getByTestId('cam-system-scene-override')).toContainText('经典');
  await expect(travelOn()).toHaveAttribute('title', /1 个场景单独设置/);
  await page.getByTestId('insp-tab-beat').click();
  await page.getByTestId('cam-system-scene-override').click();
  await expect(page.getByTestId('insp-scene')).toBeVisible();
  // the project page shows the system read-only
  await page.getByTestId('insp-tab-project').click();
  await expect(page.getByTestId('insp-camera-system')).toContainText('运镜');
  await seekTo(page, 0.5);
  const scenesWithOverride = (await playing(page)).scenes;
  await classicOn().click();
  await expect(travelNotice()).toHaveCount(0);
  await travelOn().click();
  await expect(travelNotice()).toBeVisible();
  await expect(travelNotice()).toContainText('仍遵循场景设置');
  await travelNotice().getByRole('button', { name: '关闭', exact: true }).click();
  await expect(travelNotice()).toHaveCount(0);
  await settled(page);
  expect((await playing(page)).scenes).toEqual(scenesWithOverride);
  expect(directorRequests).toEqual([]);
  expect(errors).toEqual([]);
});

test('travel editor: offsets, Shift blocking, locks, manual camera, timeline keys and undo', async () => {
  await page.getByTestId('insp-tab-scene').click();
  await page.getByTestId('insp-scene-camera-system').selectOption('inherit');
  // an explicit scene switch from classic to travel, on an undirected scene, opens the notice
  await expect(travelNotice()).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(travelNotice()).toHaveCount(0);
  const start = await beatStart(page, 's1b3');
  await seekTo(page, start + 2);
  const base = (await playing(page)).scenes[0]!;
  const slot = base.blocking.c_002!.slot;
  await dragBy(page, await center(page.getByTestId('actor-hit-c_002')), 35, 0);
  await expect.poll(async () => (await playing(page)).scenes[0]!.beats.find(b => b.id === 's1b3')!.shot.offsets?.c_002?.x ?? 0).not.toBe(0);
  expect((await playing(page)).scenes[0]!.blocking.c_002!.slot).toBe(slot);
  await page.getByTestId('btn-undo').click();
  await settled(page);
  await page.keyboard.down('Shift');
  await dragBy(page, await center(page.getByTestId('actor-hit-c_002')), -65, 0);
  await page.keyboard.up('Shift');
  await expect.poll(async () => (await playing(page)).scenes[0]!.blocking.c_002!.slot).toBeLessThan(slot);
  await page.getByTestId('btn-undo').click();
  await settled(page);
  await page.getByTestId('insp-tab-scene').click();
  await page.getByTestId('insp-slot-row-c_002').getByTitle('锁定', { exact: true }).click();
  await page.keyboard.down('Shift');
  await dragBy(page, await center(page.getByTestId('actor-hit-c_002')), -45, 0);
  await page.keyboard.up('Shift');
  await expect(page.getByTestId('toast')).toContainText('站位已锁定');
  expect((await playing(page)).scenes[0]!.blocking.c_002!.slot).toBe(slot);
  await page.getByTestId('insp-tab-scene').click();
  await page.getByTestId('insp-slot-row-c_002').getByTitle(/已锁定/).click();
  await page.getByTestId('insp-tab-shot').click();
  await page.getByTestId('off-x-c_002').fill('0.08');
  await page.getByTestId('off-x-c_002').blur();
  await expect.poll(async () => (await playing(page)).scenes[0]!.beats.find(b => b.id === 's1b3')!.shot.offsets?.c_002?.x).toBe(0.08);
  await page.getByTestId('btn-undo').click();
  await settled(page);
  await page.getByTestId('tool-camera').click();
  const box = (await page.getByTestId('stage-overlay').boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, -150);
  await expect(page.getByTestId('cam-state')).toHaveText('手动取景');
  await settled(page);
  const keys = (await playing(page)).scenes[0]!.tracks.filter(t => t.channel === 'camera').flatMap(t => t.keys);
  const key = keys.find(k => k.at.beatId === 's1b3' && 'manual' in k.value)!;
  expect(key).toBeTruthy();
  await page.getByTestId('tl-key-' + key.id).click();
  await expect(page.getByTestId('key-fields')).toBeVisible();
  await page.getByTestId('key-duration').fill('0.4');
  await page.getByTestId('key-duration').blur();
  await page.getByTestId('key-ease').selectOption('outQuad');
  await expect.poll(async () => (await playing(page)).scenes[0]!.tracks.filter(t => t.channel === 'camera').flatMap(t => t.keys).find(k => k.id === key.id)!.ease).toBe('outQuad');
  await seekTo(page, start + 2);
  expect(Number.isFinite((await stateOf(page)).camera.zoom)).toBe(true);
  await page.getByTestId('insp-tab-shot').click();
  await page.getByTestId('cam-restore').click();
  await expect(page.getByTestId('cam-state')).toHaveText('自动求解');
  await page.getByTestId('tool-select').click();
  expect(errors).toEqual([]);
});

test('travel narrative intent is editable, undoable, field-lockable and persists after save/reload', async () => {
  await travelOn().click();
  await page.getByTestId('insp-tab-scene').click();
  await page.getByTestId('insp-scene-camera-system').selectOption('inherit');
  const beatId = 's1b3';
  await page.getByTestId(`tl-shot-${beatId}`).click();
  await page.getByTestId('insp-tab-shot').click();
  const intent = page.getByTestId('insp-shot-intent');
  const before = await intent.inputValue();
  const next = before === 'reaction' ? 'release' : 'reaction';
  await intent.selectOption(next);
  await expect(intent).toHaveValue(next);
  await page.getByTestId('btn-undo').click();
  await expect(intent).toHaveValue(before);
  await intent.selectOption(next);
  await page.getByTestId('fieldlock-intent').click();
  await expect(page.getByTestId('fieldlock-intent')).toHaveAttribute('aria-pressed', 'true');
  await page.getByTestId('btn-save').click();
  await expect(page.getByTestId('save-state')).toHaveText('已保存');
  await page.reload();
  await expect(page.getByTestId('play-status')).toHaveText('就绪', { timeout: 180_000 });
  await expect(travelNotice()).toHaveCount(0);
  await page.getByTestId(`tl-shot-${beatId}`).click();
  await page.getByTestId('insp-tab-shot').click();
  await expect(page.getByTestId('insp-shot-intent')).toHaveValue(next);
  await expect(page.getByTestId('fieldlock-intent')).toHaveAttribute('aria-pressed', 'true');
  const saved = (await playing(page)).scenes[0]!.beats.find((b) => b.id === beatId)!;
  expect(saved.shot.intent).toBe(next);
  expect(saved.shot.meta.lockedFields).toContain('intent');
  expect(errors).toEqual([]);
});

test('the notice never opens when every scene already has travel direction, nor on reload, undo or redo', async () => {
  const directed = structuredClone(demo);
  for (const s of directed.scenes) s.beats[0].shot.intent = 'reaction';
  const created = await page.request.post('/api/projects', { data: { ...directed, id: `p_camera_dir_${Date.now()}`, title: '已设计运镜' } });
  expect(created.ok()).toBe(true);
  const id = (await created.json()).id as string;
  try {
    await page.goto(`/editor/${id}`);
    await expect(page.getByTestId('play-status')).toHaveText('就绪', { timeout: 180_000 });
    await expect(travelNotice()).toHaveCount(0);
    await travelOn().click();
    await expect(travelOn()).toHaveAttribute('aria-checked', 'true');
    await expect(travelNotice()).toHaveCount(0);
    await page.getByTestId('btn-undo').click();
    await page.getByTestId('btn-redo').click();
    await expect(travelOn()).toHaveAttribute('aria-checked', 'true');
    await expect(travelNotice()).toHaveCount(0);
    await page.getByTestId('btn-save').click();
    await expect(page.getByTestId('save-state')).toHaveText('已保存');
    await page.reload();
    await expect(page.getByTestId('play-status')).toHaveText('就绪', { timeout: 180_000 });
    await expect(travelNotice()).toHaveCount(0);
    await travelOn().click(); // already travel
    await expect(travelNotice()).toHaveCount(0);
    expect(directorRequests).toEqual([]);
  } finally {
    await page.request.delete(`/api/projects/${id}`);
  }
});

test('the notice offers both buttons when some scenes are undirected; a directed scene switched per scene stays quiet', async () => {
  const mixed = structuredClone(demo);
  mixed.scenes[0].beats[0].shot.intent = 'reaction';
  const created = await page.request.post('/api/projects', { data: { ...mixed, id: `p_camera_mix_${Date.now()}`, title: '部分运镜' } });
  expect(created.ok()).toBe(true);
  const id = (await created.json()).id as string;
  try {
    await page.goto(`/editor/${id}`);
    await expect(page.getByTestId('play-status')).toHaveText('就绪', { timeout: 180_000 });
    // per-scene switch on a directed scene: no notice; on an undirected scene: notice
    await page.getByTestId('insp-tab-scene').click();
    await page.getByTestId('insp-scene-camera-system').selectOption('travel');
    await expect(travelNotice()).toHaveCount(0);
    await page.getByTestId('insp-scene-camera-system').selectOption('inherit');
    await travelOn().click();
    await expect(travelNotice()).toBeVisible();
    await expect(page.getByTestId('camera-travel-regenerate')).toBeVisible();
    await expect(page.getByTestId('camera-travel-regenerate-all')).toContainText('重新生成全部场景镜头（2 场）');
    await expect(page.getByTestId('camera-travel-regenerate-all')).toBeDisabled(); // no source text, no AI director
    await page.getByTestId('camera-travel-notice-dismiss').click();
    await expect(travelNotice()).toHaveCount(0);
    // the directed scene overridden to classic and back to the project's travel: still directed, no notice
    await page.getByTestId('insp-scene-camera-system').selectOption('classic');
    await expect(travelNotice()).toHaveCount(0);
    await page.getByTestId('insp-scene-camera-system').selectOption('inherit');
    await expect(travelNotice()).toHaveCount(0);
    expect(directorRequests).toEqual([]);
  } finally {
    await page.request.delete(`/api/projects/${id}`);
  }
});
