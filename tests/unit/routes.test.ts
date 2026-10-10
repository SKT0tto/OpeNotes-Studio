import http, { type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../server/app';
import { resolveConfig } from '../../server/config';

let tmp: string;
let server: Server;
let base: string;

beforeAll(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-routes-'));
  const assets = path.join(tmp, 'assets');
  await fs.cp(path.resolve('tests/fixtures/fake-assets'), assets, { recursive: true });
  await fs.writeFile(path.join(tmp, 'secret.txt'), 'secret');
  const audio = path.join(tmp, 'audio');
  await fs.mkdir(audio);
  await fs.writeFile(path.join(audio, 'a b.wav'), '0123456789');
  const config = resolveConfig({ ASSET_ROOT: assets, AUDIO_ROOTS: audio, DATA_DIR: path.join(tmp, 'data') });
  const { app } = createApp(config);
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise((r) => server.close(r));
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('API', () => {
  it('health reports the asset root and catalog state', async () => {
    const h = await (await fetch(`${base}/api/health`)).json();
    expect(h).toMatchObject({ ok: true, assetRoot: { ok: true, models: 4, backgrounds: 2 }, audioRoots: [{ ok: true }] });
    expect(typeof h.version).toBe('string');
  });

  it('health reports an unreadable asset root with a reason', async () => {
    const { app } = createApp(resolveConfig({ ASSET_ROOT: path.join(tmp, 'missing'), DATA_DIR: path.join(tmp, 'data2') }));
    const s = await new Promise<Server>((resolve) => {
      const x = app.listen(0, '127.0.0.1', () => resolve(x));
    });
    try {
      const h = await (await fetch(`http://127.0.0.1:${(s.address() as AddressInfo).port}/api/health`)).json();
      expect(h.assetRoot.ok).toBe(false);
      expect(h.assetRoot.error).toMatch(/ENOENT/);
    } finally {
      await new Promise((r) => s.close(r));
    }
  });

  it('serves the compact catalog and full model entries', async () => {
    const cat = await (await fetch(`${base}/api/catalog`)).json();
    expect(cat.models).toHaveLength(4);
    expect(cat.models[0]).toHaveProperty('motionCount');
    expect(cat.models[0]).not.toHaveProperty('motions');
    const full = await (await fetch(`${base}/api/catalog/models/001_casual_spring_01`)).json();
    expect(full.motions.length).toBeGreaterThan(5);
    expect((await fetch(`${base}/api/catalog/models/nope`)).status).toBe(404);
  });
});

describe('read-only asset serving', () => {
  it('serves files, including names with spaces and Range requests', async () => {
    const res = await fetch(`${base}/assets/models/001_casual_spring_01/model3.json`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toContain('max-age');
    expect((await fetch(`${base}/assets/models/001_casual_spring_01/motions/mtn_haruhikage01_C%20.motion3.json`)).status).toBe(200);
    const range = await fetch(`${base}/audio/0/a%20b.wav`, { headers: { Range: 'bytes=2-5' } });
    expect(range.status).toBe(206);
    expect(await range.text()).toBe('2345');
  });

  it('rejects path traversal and unknown paths', async () => {
    // fetch() normalises "..", so send the raw request line ourselves
    const raw = (p: string) => new Promise<{ status: number; body: string }>((resolve, reject) => {
      http.get(`${base}${p}`, { path: p }, (res) => {
        let body = '';
        res.on('data', (d) => (body += d));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      }).on('error', reject);
    });
    for (const p of ['/assets/../secret.txt', '/assets/%2e%2e/secret.txt', '/assets/..%5csecret.txt', '/assets/models/%2e%2e/%2e%2e/secret.txt', '/audio/0/../secret.txt', '/audio/0/%2e%2e/secret.txt']) {
      const res = await raw(p);
      expect([400, 404], p).toContain(res.status);
      expect(res.body, p).not.toBe('secret');
    }
    expect((await raw('/assets/..%5csecret.txt')).status).toBe(400);
    expect((await raw('/audio/0/%2e%2e/secret.txt')).status).toBe(400);
    expect((await fetch(`${base}/assets/models/none/model3.json`)).status).toBe(404);
    expect((await fetch(`${base}/assets/models`)).status).toBe(404);
    expect((await fetch(`${base}/audio/5/x.wav`)).status).toBe(404);
  });

  it('does not write into the asset root', async () => {
    const before = await fs.readdir(path.join(tmp, 'assets'));
    await fetch(`${base}/api/catalog`);
    expect(await fs.readdir(path.join(tmp, 'assets'))).toEqual(before);
  });
});

describe('calibration API', () => {
  const cal = {
    version: 1,
    modelId: 'm_1',
    bounds: { x: 0, y: 0, w: 10, h: 100 },
    ground: { x: 5, y: 100 },
    totalHeight: 100,
    head: { bbox: { x: 2, y: 0, w: 6, h: 15 }, center: { x: 5, y: 7 }, height: 15 },
    headSign: 1,
    bodySign: 1,
    eyeSign: 0,
    hasEyeBallX: false,
    verified: false,
    probedAt: '2026-01-01T00:00:00Z',
  };
  const put = (id: string, body: unknown) =>
    fetch(`${base}/api/calibration/${id}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  it('returns null before calibration, then round-trips a PUT', async () => {
    expect(await (await fetch(`${base}/api/calibration/m_1`)).json()).toBeNull();
    expect((await put('m_1', cal)).status).toBe(200);
    expect(await (await fetch(`${base}/api/calibration/m_1`)).json()).toMatchObject({ headSign: 1, verified: false });
    expect((await put('m_1', { ...cal, verified: true })).status).toBe(200);
    expect(await (await fetch(`${base}/api/calibration/m_1`)).json()).toMatchObject({ verified: true });
  });

  it('rejects bad ids, mismatched ids and malformed bodies', async () => {
    expect((await fetch(`${base}/api/calibration/..%2Fx`)).status).toBeGreaterThanOrEqual(400);
    expect((await put('m_2', cal)).status).toBe(400);
    expect((await put('m_1', { ...cal, headSign: 2 })).status).toBe(400);
  });
});

describe('background ground API', () => {
  const put = (id: string, body: unknown) =>
    fetch(`${base}/api/backgrounds/${id}/ground`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  it('returns null without an override, round-trips a PUT and deletes it again', async () => {
    expect(await (await fetch(`${base}/api/backgrounds/bg_1/ground`)).json()).toBeNull();
    expect((await put('bg_1', { horizonY: 500, floorY: 1000 })).status).toBe(200);
    expect(await (await fetch(`${base}/api/backgrounds/bg_1/ground`)).json()).toEqual({ horizonY: 500, floorY: 1000 });
    expect(await (await fetch(`${base}/api/backgrounds/bg_1/ground`, { method: 'DELETE' })).json()).toBeNull();
    expect(await (await fetch(`${base}/api/backgrounds/bg_1/ground`)).json()).toBeNull();
  });

  it('rejects bad ids and impossible ground lines', async () => {
    expect((await put('bg_1', { horizonY: 900, floorY: 100 })).status).toBe(400);
    expect((await put('bg_1', { horizonY: 'x' })).status).toBe(400);
    expect((await fetch(`${base}/api/backgrounds/..%2Fx/ground`)).status).toBeGreaterThanOrEqual(400);
  });
});
