import fs from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../server/app';
import { resolveConfig } from '../../server/config';
import {
  HANEOKA_DISCLAIMER_VERSION, HANEOKA_PATHS, HaneokaFormatError, HaneokaSource, buildList, buildManifestItems, manifestCsv, manifestMarkdown, parseCards, parseModels,
} from '../../server/assets/sources/haneoka';
import { buildZip } from './helpers/zipBuilder';

const fx = async (name: string) => JSON.parse(await fs.readFile(path.resolve('tests/fixtures/sources/haneoka', name), 'utf8')) as unknown;

/** A fetch mock that serves the synthetic fixtures and counts / records requests. Nothing here touches the network. */
function mockHaneoka() {
  const calls: Array<{ url: string; ua: string; inm: string | null }> = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    calls.push({ url, ua: headers.get('user-agent') ?? '', inm: headers.get('if-none-match') });
    const key = url.includes('story-assets') ? 'story.json' : url.includes('/api/v1/backgrounds') ? 'cards.json' : url.includes('/api/v1/live2d') ? 'live2d.json' : null;
    if (!key) return new Response('nope', { status: 404 });
    const etag = `"etag-${key}"`;
    if (headers.get('if-none-match') === etag) return new Response(null, { status: 304 });
    return new Response(JSON.stringify(await fx(key)), { status: 200, headers: { etag, 'x-haneoka-release-id': 'r-fake', 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { f, calls };
}

let tmp: string;
beforeAll(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ons-sources-'));
});
afterAll(() => fs.rm(tmp, { recursive: true, force: true }));

describe('Haneoka adapter', () => {
  it('maps ids, groups by band and character, hides nothing but marks low models and what is already local', async () => {
    const data = { fetchedAt: 1, releaseId: 'r-fake', models: parseModels(await fx('live2d.json')), story: [{ id: 'adv_bkg_stage_000001' }, { id: 'adv_bkg_stage_000002' }], cards: parseCards(await fx('cards.json')) };
    expect(data.cards.map((c) => [c.id, c.stem])).toEqual([['1', 'bg_fake_01'], ['2', 'bg_fake_02']]);
    const list = buildList(data, { models: new Set(['001_casual_spring_01']), backgrounds: new Set(['1']) }, null, { locale: 'zh-CN' });
    expect(list.bands.map((b) => b.key)).toEqual(['mygo', 'avemujica', '__npc']);
    const tomori = list.bands[0]!.characters[0]!;
    expect(tomori.name).toBe('高松灯');
    expect(tomori.models.map((m) => [m.id, m.have, m.low])).toEqual([['001_casual_spring_01', true, false], ['001_casual_spring_01_low', false, true], ['001_live-mode_live_01', false, false]]);
    expect(tomori.models[0]!.url).toBe('https://haneoka.org/intl/zh-CN/live2d/001_casual_spring_01/');
    expect(list.counts).toMatchObject({ models: 5, modelsMissing: 4, backgrounds: 4, backgroundsMissing: 3 });
    expect(list.backgrounds.find((b) => b.id === '2')!.url).toBe('https://haneoka.org/intl/zh-CN/backgrounds/2/');
  });

  it('manifests contain page links only: no media URLs, no direct file paths', async () => {
    const data = { fetchedAt: 1, releaseId: 'r-fake', models: parseModels(await fx('live2d.json')), story: [{ id: 'adv_bkg_stage_000001' }], cards: parseCards(await fx('cards.json')) };
    const list = buildList(data, { models: new Set(), backgrounds: new Set() }, null);
    const items = buildManifestItems(list, { models: ['006_school_winter_hs', '001_casual_spring_01'], backgrounds: ['adv_bkg_stage_000001', '2'] });
    expect(items).toHaveLength(4);
    const text = manifestMarkdown(items, list) + manifestCsv(items) + JSON.stringify(items);
    expect(text).not.toMatch(/\/runtime\/|\/assets\/intl|\.moc3|\.png\)|model3\.json|\/api\//);
    for (const i of items) expect(i.pageUrl).toMatch(/^https:\/\/haneoka\.org\/intl\/en\/(live2d|backgrounds|assets)\//);
  });

  it('is manual-only: the source has no way to plan or fetch media', () => {
    const src = new HaneokaSource({ cacheFile: path.join(tmp, 'x.json'), version: '0' });
    for (const name of ['planFiles', 'download', 'fetchFile', 'downloadFile']) expect((src as unknown as Record<string, unknown>)[name]).toBeUndefined();
    expect(Object.values(HANEOKA_PATHS).every((p) => p.startsWith('/api/v1/'))).toBe(true);
  });

  it('makes at most 3 serial requests with a descriptive UA, records the release id, caches, and revalidates with ETags', async () => {
    const { f, calls } = mockHaneoka();
    let now = 1_000_000;
    const src = new HaneokaSource({ cacheFile: path.join(tmp, 'c1', 'cache.json'), version: '9.9.9', fetch: f, now: () => now });
    const first = await src.load();
    expect(first.fromCache).toBe(false);
    expect(calls).toHaveLength(3);
    expect(calls[0]!.url).toBe('https://haneoka.org/api/v1/live2d');
    expect(calls[1]!.url).toBe('https://haneoka.org/api/v1/story-assets/views/backgrounds');
    expect(calls[2]!.url).toBe('https://haneoka.org/api/v1/backgrounds');
    expect(calls.every((c) => /^OpeNotesStudio\/9\.9\.9 \(\+https:\/\/github\.com\/SKT0tto\/OpeNotes-Studio\)$/.test(c.ua))).toBe(true);
    expect(first.data.releaseId).toBe('r-fake');

    now += 3600_000; // within 24 h: zero requests
    expect((await src.load()).fromCache).toBe(true);
    expect(calls).toHaveLength(3);

    now += 25 * 3600_000; // stale: conditional requests, 304 keeps the cache
    const again = await src.load();
    expect(again.fromCache).toBe(false);
    expect(calls).toHaveLength(6);
    expect(calls.slice(3).every((c) => c.inm?.startsWith('"etag-'))).toBe(true);
    expect(again.data.models).toHaveLength(5);
  });

  it('fails clearly (and without partial cache) when the index format changes', async () => {
    expect(() => parseModels([])).toThrow(HaneokaFormatError);
    expect(() => parseModels({ a: { nope: 1 } })).toThrow(HaneokaFormatError);
    expect(() => parseCards({ entries: {} })).toThrow(HaneokaFormatError);
    const f = (async () => new Response('{"x":1}', { status: 200 })) as unknown as typeof fetch;
    const src = new HaneokaSource({ cacheFile: path.join(tmp, 'c2', 'cache.json'), version: '0', fetch: f });
    await expect(src.load()).rejects.toThrow(HaneokaFormatError);
    expect(await src.readCache()).toBeNull();
  });
});

describe('source gate and setup routes', () => {
  let server: Server;
  let base: string;
  let calls: ReturnType<typeof mockHaneoka>['calls'];
  let vendor: string;
  const post = (p: string, body?: unknown, raw?: Buffer) =>
    fetch(`${base}${p}`, raw ? { method: 'POST', body: new Uint8Array(raw), headers: { 'content-type': 'application/octet-stream' } } : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });

  beforeAll(async () => {
    const root = path.join(tmp, 'app');
    vendor = path.join(root, 'vendor');
    await fs.mkdir(path.join(root, 'assets'), { recursive: true });
    const mock = mockHaneoka();
    calls = mock.calls;
    const config = resolveConfig({ ASSET_ROOT: path.join(root, 'assets') }, {}, root);
    const official = 'Live2D Cubism Core\n/* csmGetLatestMocVersion */';
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).startsWith('https://cubism.live2d.com/')) return new Response(official);
      return mock.f(input, init);
    }) as typeof fetch;
    const { app } = createApp(config, () => {}, { env: { SETUP_FILE: path.join(root, 'setup.json'), LABELS_FILE: path.join(root, 'none.json') }, fetch: fetchImpl });
    server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise((r) => server.close(r)));

  it('returns 403 disclaimer_required for every data route until the current version is confirmed', async () => {
    for (const res of [await fetch(`${base}/api/sources/haneoka/list`), await post('/api/sources/haneoka/manifest', { models: [] })]) {
      expect(res.status).toBe(403);
      expect((await res.json()).code).toBe('disclaimer_required');
    }
    expect(calls).toHaveLength(0);
    expect((await post('/api/sources/haneoka/accept', { version: 'old' })).status).toBe(409);
    expect((await post('/api/sources/haneoka/accept', { version: HANEOKA_DISCLAIMER_VERSION })).status).toBe(200);
    const list = await (await fetch(`${base}/api/sources/haneoka/list?locale=ja`)).json();
    expect(list.list.counts.models).toBe(5);
    expect(list.list.locale).toBe('ja');
    expect(calls).toHaveLength(3);
    await fetch(`${base}/api/sources/haneoka/list`); // cached
    expect(calls).toHaveLength(3);
    const csv = await post('/api/sources/haneoka/manifest', { models: ['001_casual_spring_01'], backgrounds: ['1'], format: 'csv' });
    expect(csv.headers.get('content-type')).toContain('text/csv');
    expect(await csv.text()).toContain('/live2d/001_casual_spring_01/');
    const status = await (await fetch(`${base}/api/sources/haneoka`)).json();
    expect(status).toMatchObject({ policy: 'manual-only', accepted: true });
  });

  it('Core: requires the licence, rejects non-Core files, installs an official-looking file and updates the config', async () => {
    expect((await post('/api/setup/core/upload', undefined, Buffer.from('x'))).status).toBe(403);
    expect((await post('/api/setup/core/fetch')).status).toBe(403);
    await post('/api/setup/core/accept-license');
    const bad = await post('/api/setup/core/upload', undefined, Buffer.from('console.log(1)'));
    expect(bad.status).toBe(400);
    const nopeFile = await post('/api/setup/core/upload', undefined, Buffer.alloc(3 * 1024 * 1024));
    expect([400, 413]).toContain(nopeFile.status);
    const ok = await post('/api/setup/core/upload', undefined, Buffer.from('/* Live2D Cubism Core */ var a="csmGetLatestMocVersion";'));
    expect(ok.status).toBe(200);
    expect((await ok.json()).local).toBe(true);
    expect(await fs.readFile(path.join(vendor, 'live2dcubismcore.min.js'), 'utf8')).toContain('csmGetLatestMocVersion');
    expect(JSON.parse(await fs.readFile(path.join(tmp, 'app', 'studio.config.json'), 'utf8')).cubismCoreUrl).toBe('/vendor/live2dcubismcore.min.js');
    expect((await (await fetch(`${base}/api/health`)).json()).cubismCoreUrl).toBe('/vendor/live2dcubismcore.min.js');
    expect((await fetch(`${base}/vendor/live2dcubismcore.min.js`)).status).toBe(200);
    const reset = await (await post('/api/setup/core/reset')).json();
    expect(reset.local).toBe(false);
    const fetched = await post('/api/setup/core/fetch');
    expect(fetched.status).toBe(200);
  });

  it('import routes: scan a zip, import it, a second import is all duplicates', async () => {
    const files = [
      { name: 'pack/001_casual_spring_01/model3.json', data: JSON.stringify({ Version: 3, FileReferences: { Moc: 'model.moc3', Textures: ['/runtime/x/t0.png'], Motions: { Motion: [{ File: 'motions/a.motion3.json' }, { File: 'motions/b.motion3.json' }] } } }) },
      { name: 'pack/001_casual_spring_01/model.moc3', data: Buffer.concat([Buffer.from('MOC3'), Buffer.from([5, 0, 0, 0])]) },
      { name: 'pack/001_casual_spring_01/motions/a.motion3.json', data: '{}' },
      { name: 'pack/001_casual_spring_01/motions/b.motion3.json', data: '{}' },
      { name: 'pack/tex/t0.png', data: await fs.readFile('tests/fixtures/fake-assets/backgrounds/1.png') },
    ];
    const waitJob = async (jobId: string) => {
      for (let i = 0; i < 200; i++) {
        const j = await (await fetch(`${base}/api/import/jobs/${jobId}`)).json();
        if (j.status !== 'running') return j;
        await new Promise((r) => setTimeout(r, 25));
      }
      throw new Error('job timeout');
    };
    const upload = async (body: Buffer, headers: Record<string, string> = {}) => {
      const up = await fetch(`${base}/api/import/upload`, { method: 'POST', body: new Uint8Array(body), headers });
      expect(up.status).toBe(200);
      return waitJob((await up.json()).jobId);
    };
    const first = await upload(buildZip(files), { 'x-filename': 'pack.zip' });
    expect(first.status).toBe('done');
    const plan = first.plan;
    expect(plan.models[0]).toMatchObject({ id: '001_casual_spring_01', status: 'new', motions: 2, normalized: true });
    const runStart = await (await post('/api/import/run', { planId: plan.planId })).json();
    const run = await waitJob(runStart.jobId);
    expect(run.status).toBe('done');
    expect(run.result.report.imported.models).toEqual(['001_casual_spring_01']);
    const cat = await (await fetch(`${base}/api/catalog`)).json();
    expect(JSON.stringify(cat)).toContain('001_casual_spring_01');
    expect((await post('/api/import/run', { planId: plan.planId })).status).toBe(404); // session consumed
    expect((await upload(buildZip(files))).plan.models[0].status).toBe('duplicate');
    const evil = await upload(buildZip([{ name: '../x', data: 'y' }]));
    expect(evil.status).toBe('error');
    expect(evil.error).toMatch(/不安全|无法处理/);
  });

  it('upload background: content-derived id, sidecar name + tag, duplicate is a no-op, delete only own', async () => {
    const png = await fs.readFile('tests/fixtures/fake-assets/backgrounds/1.png');
    const put = (body: Buffer | string, name = '我的 教室.png') => fetch(`${base}/api/import/background`, { method: 'POST', body: new Uint8Array(Buffer.from(body)), headers: { 'x-filename': encodeURIComponent(name), 'content-type': 'image/png' } });
    const first = await put(png);
    expect(first.status).toBe(200);
    const a = await first.json();
    expect(a).toMatchObject({ status: 'new', name: '我的 教室' });
    expect(a.id).toMatch(/^user_[0-9a-f]{12}$/);
    const bg = ((await (await fetch(`${base}/api/catalog`)).json()) as { backgrounds: Array<{ id: string; name: string; tags: string[] }> }).backgrounds.find((b) => b.id === a.id);
    expect(bg).toMatchObject({ name: '我的 教室' });
    expect(bg!.tags).toContain('用户上传');
    const again = await (await put(png, 'other.png')).json();
    expect(again).toMatchObject({ status: 'duplicate', id: a.id, name: '我的 教室' });
    expect((await put('not a png')).status).toBe(400);
    expect((await fetch(`${base}/api/import/background/1`, { method: 'DELETE' })).status).toBe(400);
    expect((await fetch(`${base}/api/import/background/${a.id}`, { method: 'DELETE' })).status).toBe(200);
    const after = (await (await fetch(`${base}/api/catalog`)).json()) as { backgrounds: Array<{ id: string }> };
    expect(after.backgrounds.some((b) => b.id === a.id)).toBe(false);
    expect((await fetch(`${base}/api/import/background/${a.id}`, { method: 'DELETE' })).status).toBe(404);
  });
});
