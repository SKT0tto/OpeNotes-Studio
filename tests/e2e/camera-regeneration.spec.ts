/** The travel notice delegates one camera-only preview to the existing director panel. No real LLM or settings are used. */
import fs from 'node:fs';
import { expect, test } from '@playwright/test';
import type { Project } from '../../shared/schema/project';
import type { SceneOptions } from '../../web/directorApi';
import { beatStart, playing, seekTo, settled } from './helpers/editor';

const demo = JSON.parse(fs.readFileSync('tests/fixtures/demo-project.json', 'utf8')) as Project;
const story = fs.readFileSync('tests/fixtures/story-short.txt', 'utf8');
test.describe.configure({ mode: 'serial' });
test.setTimeout(300_000);

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

type CameraRequest = SceneOptions & { project: Project; sceneId: string };
let projectId = '';
let configured = true;
let settingsFailure = false;
let settingsGate: ReturnType<typeof deferred> | null = null;
let directorGate: ReturnType<typeof deferred> | null = null;
let requests: Array<{ path: string; body: CameraRequest }> = [];

test.beforeEach(async ({ page }) => {
  configured = true;
  settingsFailure = false;
  settingsGate = null;
  directorGate = null;
  requests = [];
  // Install before entering the editor; never read the user's project list or real settings.
  await page.route('**/api/projects', route => route.request().method() === 'GET' ? route.fulfill({ json: [] }) : route.continue());
  await page.route('**/api/llm/settings', async route => {
    if (settingsGate) await settingsGate.promise;
    if (settingsFailure) {
      await route.fulfill({ status: 503, json: { error: 'Fixture settings unavailable' } });
      return;
    }
    await route.fulfill({ json: {
      provider: configured ? 'openai' : null, available: ['anthropic', 'openai'],
      anthropic: { hasKey: false, mask: null, source: null, model: '', baseUrl: '' },
      openai: { hasKey: false, mask: null, source: null, model: 'fixture', baseUrl: '' },
      status: { configured, provider: configured ? 'openai' : null, model: 'fixture', verified: 'none', message: configured ? 'Fixture AI configured' : 'Fixture AI 未配置' },
    } });
  });
  // Every director endpoint is intercepted, including accidentally choosing the all-scenes endpoint.
  await page.route('**/api/director/**', async route => {
    const path = new URL(route.request().url()).pathname;
    const body = route.request().postDataJSON() as CameraRequest;
    requests.push({ path, body });
    if (directorGate) await directorGate.promise;
    if (path !== '/api/director/scene') {
      await route.fulfill({ status: 400, json: { error: { message: 'Unexpected director endpoint' } } });
      return;
    }
    const scene = structuredClone(body.project.scenes.find((s) => s.id === body.sceneId)!);
    const beat = scene.beats[0]!;
    beat.shot.type = beat.shot.type === 'cu' ? 'ms' : 'cu';
    beat.shot.intent = 'reaction';
    const provider = body.engine === 'rule' ? 'rule' : 'fixture';
    await route.fulfill({ json: {
      sceneId: scene.id, scene, applied: true, conflicts: [],
      report: { replacedBeats: [], keptBeats: [], replacedTracks: [], keptTracks: [], protectedKept: [] },
      direction: { reason: 'Fixture camera proposal', beats: [] }, warnings: [], cached: false,
      runs: [{ pass: 'scene', label: 'Fixture', provider, model: 'fixture', cached: false, ms: 1,
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 }, repaired: false, warnings: [] }],
    } });
  });
  const response = await page.request.post('/api/projects', { data: {
    ...demo, id: `p_camera_regen_${Date.now()}`, title: '运镜重新生成 fixture', source: { ...demo.source, text: story },
  } });
  expect(response.ok()).toBe(true);
  projectId = (await response.json()).id;
  await page.goto(`/editor/${projectId}`);
  await expect(page.getByTestId('play-status')).toHaveText('就绪', { timeout: 180_000 });
  expect(requests).toEqual([]);
});

test.afterEach(async ({ page, request }) => {
  settingsGate?.resolve();
  directorGate?.resolve();
  await page.close();
  if (projectId) await request.delete(`/api/projects/${projectId}`);
  projectId = '';
});

test('waits for configured AI, expands the left panel, and previews exactly one current-scene camera request', async ({ page }) => {
  const target = demo.scenes[1]!;
  await seekTo(page, await beatStart(page, target.beats[0]!.id) + 0.05);
  const before = (await playing(page)).scenes;
  await page.getByTitle('左栏', { exact: true }).click();
  await expect(page.getByTestId('left-panel')).toHaveCount(0);
  settingsGate = deferred();
  await page.getByTestId('cam-system-travel').click();
  await expect(page.getByTestId('camera-travel-notice')).toContainText(`本场景：${target.title}`);
  await page.getByTestId('camera-travel-regenerate').click();
  await expect(page.getByTestId('camera-travel-notice')).toHaveCount(0);
  await expect(page.getByTestId('left-panel')).toBeVisible();
  await expect(page.getByTestId('tab-ai')).toHaveClass('active');
  await expect(page.getByTestId('ai-settings-loading')).toBeVisible();
  expect(requests).toEqual([]);
  settingsGate.resolve();
  await expect(page.getByTestId('ai-result')).toHaveAttribute('data-state', 'pending');
  expect(requests).toHaveLength(1);
  const sent = requests[0]!;
  expect(sent.path).toBe('/api/director/scene');
  expect(sent.body.sceneId).toBe(target.id);
  expect(sent.body.scopes).toEqual(['camera']);
  expect(sent.body.project.settings.cameraSystem).toBe('travel');
  expect(sent.body.engine).toBeUndefined(); // configured AI must not silently fall back to rules
  expect(sent.body.beatIds).toBeUndefined();
  expect(sent.body.overwriteUser).toBe(false);
  expect(sent.body.project.scenes).toEqual(before);
  await expect(page.getByTestId('ai-diff-camera')).toBeVisible();
  await expect(page.getByTestId('ai-preview')).toBeChecked();
  await settled(page);
  expect((await playing(page)).scenes).toEqual(before);
  await page.getByTestId('ai-reject').click();
  await page.getByTestId('tab-script').click();
  await page.getByTestId('tab-ai').click();
  await expect(page.getByTestId('ai-settings-loading')).toHaveCount(0);
  await settled(page);
  expect(requests).toHaveLength(1);
});

test('overrides stale panel controls and cannot start a second generation while busy', async ({ page }) => {
  await page.getByTestId('tab-ai').click();
  await expect(page.getByTestId('ai-status')).toContainText('configured');
  await page.getByTestId('ai-preview').uncheck();
  await page.getByTestId('ai-overwrite').check();
  await page.getByTestId('ai-only-beat').check();
  await page.getByTestId('ai-engine').selectOption('rule');
  const before = (await playing(page)).scenes;
  directorGate = deferred();
  await page.getByTestId('cam-system-travel').click();
  await page.getByTestId('camera-travel-regenerate').click();
  await expect.poll(() => requests.length).toBe(1);
  await expect(page.getByTestId('ai-scope')).toHaveValue('camera');
  await expect(page.getByTestId('ai-engine')).toHaveValue('ai');
  await expect(page.getByTestId('ai-preview')).toBeChecked();
  await expect(page.getByTestId('ai-overwrite')).not.toBeChecked();
  await expect(page.getByTestId('ai-only-beat')).not.toBeChecked();
  expect(requests[0]!.body.scopes).toEqual(['camera']);
  expect(requests[0]!.body.beatIds).toBeUndefined();
  expect(requests[0]!.body.overwriteUser).toBe(false);
  expect(requests[0]!.body.engine).toBeUndefined();
  await page.getByTestId('cam-system-classic').click();
  await page.getByTestId('cam-system-travel').click();
  await expect(page.getByTestId('camera-travel-regenerate')).toBeDisabled();
  await expect(page.getByTestId('camera-travel-regenerate-reason')).toContainText('正在生成');
  await page.getByTestId('camera-travel-notice-dismiss').click();
  directorGate.resolve();
  await expect(page.getByTestId('ai-result')).toHaveAttribute('data-state', 'pending');
  await settled(page);
  expect(requests).toHaveLength(1);
  expect((await playing(page)).scenes).toEqual(before);
});

test('unconfigured AI explicitly falls back to the rule director', async ({ page }) => {
  configured = false;
  await page.getByTestId('cam-system-travel').click();
  await expect(page.getByTestId('camera-travel-notice')).toContainText('未配置 AI 时使用规则导演（非 AI）');
  await page.getByTestId('camera-travel-regenerate').click();
  await expect(page.getByTestId('ai-result')).toHaveAttribute('data-state', 'pending');
  expect(requests).toHaveLength(1);
  expect(requests[0]!.body.engine).toBe('rule');
  expect(requests[0]!.body.scopes).toEqual(['camera']);
  await expect(page.getByTestId('ai-rule-hint')).toBeVisible();
  await expect(page.getByTestId('ai-origin')).toHaveText('规则');
});

test('settings failure ends the queued request and permits retry without silently generating', async ({ page }) => {
  settingsFailure = true;
  await page.getByTestId('cam-system-travel').click();
  await page.getByTestId('camera-travel-regenerate').click();
  await expect(page.getByTestId('ai-settings-error')).toContainText('读取 AI 设置失败');
  await expect(page.getByTestId('ai-regen-scene')).toBeDisabled();
  expect(requests).toEqual([]);
  settingsFailure = false;
  await page.getByTestId('ai-settings-retry').click();
  await expect(page.getByTestId('ai-status')).toContainText('configured');
  await expect(page.getByTestId('ai-regen-scene')).toBeEnabled();
  await settled(page);
  expect(requests).toEqual([]);
  await page.getByTestId('ai-regen-scene').click();
  await expect(page.getByTestId('ai-result')).toHaveAttribute('data-state', 'pending');
  expect(requests).toHaveLength(1);
  expect(requests[0]!.body.scopes).toEqual(['camera']);
});

test('leaving the panel cancels an unconsumed request and returning does not replay it', async ({ page }) => {
  settingsGate = deferred();
  await page.getByTestId('cam-system-travel').click();
  await page.getByTestId('camera-travel-regenerate').click();
  await expect(page.getByTestId('ai-settings-loading')).toBeVisible();
  await page.getByTestId('tab-script').click();
  settingsGate.resolve();
  await page.getByTestId('tab-ai').click();
  await expect(page.getByTestId('ai-status')).toContainText('configured');
  await settled(page);
  expect(requests).toEqual([]);
});
