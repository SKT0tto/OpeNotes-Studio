/** v0.1.1: aspect fitting, .env hot reload, honest "configured" status, and generation failures that say what went wrong. */
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CatalogService } from '../../server/assets/indexer';
import { directorRoutes } from '../../server/director/routes';
import { LlmCache } from '../../server/llm/cache';
import { FixtureProvider } from '../../server/llm/fixtureProvider';
import { llmRoutes } from '../../server/llm/routes';
import { LlmError, type LlmProvider, type StructuredRequest } from '../../server/llm/provider';
import { LlmSettings, isUsableKey } from '../../server/settings/store';
import { fitAspect } from '../../shared/layout/fitAspect';
import { FIXTURE_DIR, STORY } from './helpers/directorCatalog';
import { cat } from './helpers/directorFlow';

describe('fitAspect: the largest box of the right shape that fits', () => {
  const ratio = (r: { width: number; height: number }) => r.width / r.height;
  it('letterboxes in a tall area and pillarboxes in a wide one, never exceeding the area', () => {
    for (const [w, h] of [[1280, 720], [1440, 900], [1920, 1080], [1366, 768], [900, 1200], [333.3, 777.7], [2400, 300], [37, 800]] as const) {
      for (const a of [16 / 9, 1920 / 890]) {
        const f = fitAspect(w, h, a);
        expect(Math.abs(ratio(f) / a - 1)).toBeLessThan(1e-9);
        expect(f.width).toBeLessThanOrEqual(w + 1e-9);
        expect(f.height).toBeLessThanOrEqual(h + 1e-9);
        // touches at least one edge: as large as it can be
        expect(Math.min(w - f.width, h - f.height)).toBeLessThan(1e-6);
      }
    }
  });
  it('degenerate areas give an empty box', () => {
    expect(fitAspect(0, 500, 16 / 9)).toEqual({ width: 0, height: 0 });
    expect(fitAspect(500, -1, 16 / 9)).toEqual({ width: 0, height: 0 });
    expect(fitAspect(500, 500, 0)).toEqual({ width: 0, height: 0 });
    expect(fitAspect(Number.NaN, 500, 2)).toEqual({ width: 0, height: 0 });
  });
});

describe('LLM settings read .env on every request', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'v011-env-'));
  });
  afterAll(async () => fs.rm(dir, { recursive: true, force: true }));

  it('picks up an edited .env without a restart; the panel and real variables still win', async () => {
    const dotenv = path.join(dir, '.env');
    const s = new LlmSettings({ file: path.join(dir, 's.json'), env: {}, dotEnv: { file: dotenv, base: {} } });
    expect(s.view().status.configured).toBe(false); // no .env yet
    await fs.writeFile(dotenv, 'ANTHROPIC_API_KEY=sk-ant-first-0001\n');
    expect(s.view().status.configured).toBe(true);
    expect(s.view().anthropic).toMatchObject({ hasKey: true, source: 'env', mask: 'sk-…0001' });
    await fs.writeFile(dotenv, 'ANTHROPIC_API_KEY=sk-ant-second-0002\n');
    expect(s.view().anthropic.mask).toBe('sk-…0002');
    await fs.writeFile(dotenv, '# key removed\n');
    expect(s.view().status.configured).toBe(false);
    expect(s.view().anthropic.hasKey).toBe(false);
    // a value saved in the panel beats .env
    await fs.writeFile(dotenv, 'ANTHROPIC_API_KEY=sk-ant-env-0003\n');
    s.patch({ anthropic: { apiKey: 'sk-ant-panel-0004' } });
    expect(s.view().anthropic).toMatchObject({ source: 'file', mask: 'sk-…0004' });
    s.patch({ anthropic: { apiKey: null } });
    expect(s.view().anthropic).toMatchObject({ source: 'env', mask: 'sk-…0003' });
    // a real environment variable beats .env
    const real = new LlmSettings({ file: path.join(dir, 'r.json'), env: {}, dotEnv: { file: dotenv, base: { ANTHROPIC_API_KEY: 'sk-ant-real-0005' } } });
    expect(real.view().anthropic.mask).toBe('sk-…0005');
    // an empty real variable does not shadow .env
    const empty = new LlmSettings({ file: path.join(dir, 'e.json'), env: {}, dotEnv: { file: dotenv, base: { ANTHROPIC_API_KEY: '' } } });
    expect(empty.view().anthropic.mask).toBe('sk-…0003');
  });
});

describe('"configured" means a usable key', () => {
  it('placeholders and blanks are not keys', () => {
    for (const k of [undefined, null, '', '   ', 'sk-ant-...', 'sk-ant-…', '<your key>', 'your_api_key', 'changeme', 'has space']) expect(isUsableKey(k)).toBe(false);
    for (const k of ['sk-ant-api03-abcdefghijkl', 'sk-ant-xxxxxxxxxxxx', 'abc123456']) expect(isUsableKey(k)).toBe(true);
  });

  it('an empty / placeholder key is reported as not configured, with the reason', () => {
    const none = new LlmSettings({ file: '/nonexistent/x.json', env: { ANTHROPIC_API_KEY: 'sk-ant-...' } });
    expect(none.view().status).toMatchObject({ configured: false, verified: 'none' });
    expect(none.view().anthropic.hasKey).toBe(false);
    expect(none.provider().provider).toBeNull();
    const blank = new LlmSettings({ file: '/nonexistent/x.json', env: { ANTHROPIC_API_KEY: '  ', LLM_PROVIDER: 'anthropic' } });
    expect(blank.view().status.configured).toBe(false);
    // a hosted OpenAI-compatible endpoint needs a key; a local one does not
    const hosted = new LlmSettings({ file: '/nonexistent/x.json', env: { LLM_PROVIDER: 'openai', OPENAI_BASE_URL: 'https://api.deepseek.com', OPENAI_MODEL: 'm' } });
    expect(hosted.view().status.configured).toBe(false);
    expect(hosted.view().status.message).toContain('需要 API key');
    const local = new LlmSettings({ file: '/nonexistent/x.json', env: { LLM_PROVIDER: 'openai', OPENAI_BASE_URL: 'http://localhost:1234/v1', OPENAI_MODEL: 'm' } });
    expect(local.view().status.configured).toBe(true);
  });

  it('a key that exists but was never tried is "untested"; the last real call decides ok / failed, and editing the key resets it', () => {
    const dir = path.join(os.tmpdir(), `v011-verified-${process.pid}`);
    const s = new LlmSettings({ file: path.join(dir, 's.json'), env: { ANTHROPIC_API_KEY: 'sk-ant-abcdefgh-0001' } });
    expect(s.view().status).toMatchObject({ configured: true, verified: 'untested' });
    s.noteResult(false, 'API key 无效');
    expect(s.view().status).toMatchObject({ configured: true, verified: 'failed' });
    expect(s.view().status.message).toContain('API key 无效');
    s.noteResult(true);
    expect(s.view().status).toMatchObject({ configured: true, verified: 'ok' });
    s.patch({ anthropic: { apiKey: 'sk-ant-another-0002' } });
    expect(s.view().status.verified).toBe('untested');
  });

  it('POST /api/llm/test records the outcome in the status line', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'v011-test-'));
    const fetch401 = (async () => new Response('{"error":"bad key"}', { status: 401 })) as unknown as typeof fetch;
    const settings = new LlmSettings({ file: path.join(dir, 's.json'), env: { LLM_PROVIDER: 'openai', OPENAI_BASE_URL: 'http://api.example/v1', OPENAI_MODEL: 'm', OPENAI_API_KEY: 'sk-bad-key-000001' }, fetch: fetch401 });
    const app = express();
    app.use(llmRoutes(settings));
    const server = await new Promise<Server>((r) => {
      const x = app.listen(0, '127.0.0.1', () => r(x));
    });
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const t = await (await fetch(`${base}/api/llm/test`, { method: 'POST' })).json();
      expect(t).toMatchObject({ ok: false, error: { kind: 'auth' } });
      const v = await (await fetch(`${base}/api/llm/settings`)).json();
      expect(v.status).toMatchObject({ configured: true, verified: 'failed' });
      expect(JSON.stringify(v)).not.toContain('sk-bad-key-000001');
    } finally {
      await new Promise((r) => server.close(r));
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe('generation failures are reported, never hidden', () => {
  let tmp: string;
  const servers: Server[] = [];
  const post = (b: string, p: string, body: unknown) => fetch(`${b}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const events = (text: string) => [...text.matchAll(/event: (\w+)\ndata: (.*)\n/g)].map((m) => ({ e: m[1]!, d: JSON.parse(m[2]!) as Record<string, unknown> }));

  async function serve(settings: LlmSettings) {
    const app = express();
    app.use(directorRoutes({ settings, cache: new LlmCache(path.join(tmp, 'cache')), catalog: { get: async () => ({ ...cat, version: 'v-test' }) } as unknown as CatalogService }));
    const s = await new Promise<Server>((r) => {
      const x = app.listen(0, '127.0.0.1', () => r(x));
    });
    servers.push(s);
    return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
  }
  /** A fixture-backed project skeleton to run scenes on. */
  let project: unknown;
  const openaiSettings = (fetchMock: typeof fetch, name: string) =>
    new LlmSettings({ file: path.join(tmp, `${name}.json`), env: { LLM_PROVIDER: 'openai', OPENAI_BASE_URL: 'http://api.example/v1', OPENAI_MODEL: 'm', OPENAI_API_KEY: 'sk-test-key-000001' }, fetch: fetchMock });

  beforeAll(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'v011-fail-'));
    const fx = new FixtureProvider(FIXTURE_DIR);
    const base = await serve(new LlmSettings({ file: path.join(tmp, 'fx.json'), env: {}, fixtureProvider: () => fx }));
    project = (await (await post(base, '/api/director/breakdown', { text: STORY })).json()).project;
  });
  afterAll(async () => {
    for (const s of servers) await new Promise((r) => s.close(r));
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('401 on the breakdown: an error with kind "auth" (HTTP 502), and the settings panel flips to "failed"', async () => {
    const settings = openaiSettings((async () => new Response('{"error":{"message":"Incorrect API key"}}', { status: 401 })) as unknown as typeof fetch, 'a401');
    const base = await serve(settings);
    const r = await post(base, '/api/director/breakdown', { text: STORY });
    expect(r.status).toBe(502);
    const j = await r.json();
    expect(j.error.kind).toBe('auth');
    expect(j.error.message).toContain('API key');
    expect(JSON.stringify(j)).not.toContain('sk-test-key-000001');
    expect(settings.view().status).toMatchObject({ configured: true, verified: 'failed' });
  });

  it('401 on every scene: each scene ends in an error item with kind "auth"; no scene result is invented', async () => {
    const settings = openaiSettings((async () => new Response('unauthorized', { status: 401 })) as unknown as typeof fetch, 'b401');
    const base = await serve(settings);
    const res = await post(base, '/api/director/scenes', { project, scopes: ['scene'] });
    const ev = events(await res.text());
    const errors = ev.filter((x) => x.e === 'progress' && x.d.state === 'error');
    expect(errors.length).toBe(4);
    expect(errors.every((x) => x.d.kind === 'auth')).toBe(true);
    expect(ev.filter((x) => x.e === 'progress' && x.d.state === 'done').length).toBe(0);
    const done = ev.find((x) => x.e === 'done')!.d as { items: Array<{ result?: unknown; error?: { kind: string } }> };
    expect(done.items.every((i) => !i.result && i.error?.kind === 'auth')).toBe(true);
    expect(settings.view().status.verified).toBe('failed');
  });

  it('timeouts are reported as kind "timeout"', async () => {
    const timeout = (async () => {
      throw Object.assign(new Error('The operation was aborted'), { name: 'TimeoutError' });
    }) as unknown as typeof fetch;
    const base = await serve(openaiSettings(timeout, 'tmo'));
    const r = await post(base, '/api/director/breakdown', { text: STORY });
    expect(r.status).toBe(502);
    expect((await r.json()).error).toMatchObject({ kind: 'timeout' });
  });

  it('partial failure: the scenes that worked are returned, the failed ones are listed with their reason, and a retry covers only those', async () => {
    const fx = new FixtureProvider(FIXTURE_DIR);
    let failing = true;
    const flaky: LlmProvider = {
      id: 'fixture', model: fx.model, maxOutputTokens: fx.maxOutputTokens,
      test: () => fx.test(),
      generateStructured: async <T,>(req: StructuredRequest<T>) => {
        const input = JSON.stringify(req.input);
        if (failing && req.schemaName === 'SceneDirection' && /"paragraphRange":\[(?:6|13)/.test(input)) throw new LlmError('timeout', '请求超时（120 秒无响应）');
        return fx.generateStructured(req);
      },
    };
    const base = await serve(new LlmSettings({ file: path.join(tmp, 'flaky.json'), env: {}, fixtureProvider: () => flaky }));
    const first = events(await (await post(base, '/api/director/scenes', { project, scopes: ['scene'] })).text());
    const failedIds = first.filter((x) => x.e === 'progress' && x.d.state === 'error').map((x) => x.d.sceneId as string);
    const okIds = first.filter((x) => x.e === 'progress' && x.d.state === 'done').map((x) => x.d.sceneId as string);
    expect(failedIds.length).toBeGreaterThan(0);
    expect(okIds.length).toBeGreaterThan(0);
    expect(failedIds.length + okIds.length).toBe(4);
    for (const x of first.filter((e) => e.e === 'progress' && e.d.state === 'error')) expect(x.d).toMatchObject({ kind: 'timeout', message: expect.stringContaining('超时') });
    // the retry sends only the failed scenes and now succeeds
    failing = false;
    const retry = events(await (await post(base, '/api/director/scenes', { project, scopes: ['scene'], sceneIds: failedIds })).text());
    expect(retry.filter((x) => x.e === 'progress' && x.d.state === 'done').map((x) => x.d.sceneId).sort()).toEqual([...failedIds].sort());
    expect(retry.filter((x) => x.e === 'progress' && x.d.state === 'error').length).toBe(0);
  });
});
