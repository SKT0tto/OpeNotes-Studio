import http, { type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../server/app';
import { resolveConfig } from '../../server/config';
import { decodePng, downscale, encodePng } from '../../server/assets/thumbs';
import { loadConfig } from '../../server/config';
import { LabelFileSchema } from '../../shared/schema/assetLabels';

let tmp: string;
let server: Server;
let base: string;
let labelsFile: string;
let sheets: string;
const label = { bands: ['generic'], access: 'public', placeType: 'street', placeName: null, indoor: 'outdoor', time: 'day', stage: false, confidence: 'likely', evidence: 't', location: null, owner: null, exclusive: false, homeBand: null, title: '原标题', description: '一张街景', category: 'scene', tags: ['街道'] };
const send = (method: string, url: string, body?: unknown) => fetch(`${base}${url}`, { method, headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const catalog = async () => (await (await fetch(`${base}/api/catalog`)).json()) as { backgrounds: Array<{ id: string; name: string; description: string | null; category: string | null; tags: string[]; labels?: { title?: string; fixes?: unknown[] } }> };

beforeAll(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-p20-'));
  const assets = path.join(tmp, 'assets');
  await fs.cp(path.resolve('tests/fixtures/fake-assets'), assets, { recursive: true });
  // a real (small) gradient picture instead of the placeholder file of the fixture library
  const data = new Uint8Array(128 * 72 * 4);
  for (let i = 0; i < 128 * 72; i++) data.set([i % 128 * 2, Math.floor(i / 128) * 3, 90, 255], i * 4);
  await fs.writeFile(path.join(assets, 'backgrounds', '1.png'), encodePng({ width: 128, height: 72, data }));
  labelsFile = path.join(tmp, 'labels', 'backgrounds.json');
  sheets = path.join(tmp, 'sheets');
  await fs.mkdir(sheets, { recursive: true });
  const config = resolveConfig({ ASSET_ROOT: assets, DATA_DIR: path.join(tmp, 'data') });
  const { app } = createApp(config, () => {}, { env: { LABELS_FILE: labelsFile, THUMB_SHEET_DIR: sheets } });
  server = await new Promise<Server>((resolve) => {
    const s = http.createServer(app).listen(0, '127.0.0.1', () => resolve(s));
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise((r) => server.close(r));
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('labels: title / description / category reach the catalog', () => {
  it('PATCH makes the catalog name the title, adds tags, category and the review suggestions; invalid fields are rejected by the server', async () => {
    expect((await send('PUT', '/api/asset-labels/backgrounds/1', label)).status).toBe(200);
    let c = (await catalog()).backgrounds.find((b) => b.id === '1')!;
    expect(c).toMatchObject({ name: '原标题', description: '一张街景', category: 'scene' });
    expect(c.tags).toContain('街道');
    expect((await send('PATCH', '/api/asset-labels/backgrounds', { ids: ['1'], patch: { title: '新标题', category: 'decor', fixes: [{ field: 'name', current: '原标题', suggest: '新标题', reason: 'x' }] } })).status).toBe(200);
    c = (await catalog()).backgrounds.find((b) => b.id === '1')!;
    expect(c).toMatchObject({ name: '新标题', category: 'decor' });
    expect(c.labels?.fixes).toHaveLength(1);
    expect((await send('PATCH', '/api/asset-labels/backgrounds', { ids: ['1'], patch: { category: 'logo' } })).status).toBe(400);
    expect((await send('PATCH', '/api/asset-labels/backgrounds', { ids: ['1'], patch: { fixes: [{ nofield: 1 }] } })).status).toBe(400);
    expect(LabelFileSchema.parse(JSON.parse(await fs.readFile(labelsFile, 'utf8'))).labels['1']!.title).toBe('新标题');
  });

  it('the whole file can be read, and restore puts labels back exactly (or removes them)', async () => {
    const file = (await (await send('GET', '/api/asset-labels/backgrounds')).json()) as { labels: Record<string, { title?: string; source: string }> };
    const before = file.labels['1']!;
    await send('PATCH', '/api/asset-labels/backgrounds', { ids: ['1'], patch: { title: '临时' } });
    expect((await send('POST', '/api/asset-labels/backgrounds/restore', { entries: { '1': before, '2': null } })).status).toBe(200);
    const after = (await (await send('GET', '/api/asset-labels/backgrounds')).json()) as typeof file;
    expect(after.labels['1']).toEqual(before);
    expect(after.labels['2']).toBeUndefined();
    expect((await send('POST', '/api/asset-labels/backgrounds/restore', { entries: { '1': { bands: 'x' } } })).status).toBe(400);
  });
});

describe('thumbnails', () => {
  it('a real PNG is decoded and served as a small PNG (cached), the original is not what is sent', async () => {
    const res = await fetch(`${base}/api/thumbs/backgrounds/1?w=64`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    const buf = Buffer.from(await res.arrayBuffer());
    const img = decodePng(buf);
    expect(img).not.toBeNull();
    expect(img!.width).toBeLessThanOrEqual(64);
    const again = await fetch(`${base}/api/thumbs/backgrounds/1?w=64`);
    expect(Buffer.from(await again.arrayBuffer()).equals(buf)).toBe(true);
  });

  it('a missing original is 404; without contact sheets there is no sheet either (the client shows a placeholder card)', async () => {
    expect((await fetch(`${base}/api/thumbs/backgrounds/does-not-exist`)).status).toBe(404);
    expect((await fetch(`${base}/api/thumbs/backgrounds/does-not-exist/sheet`)).status).toBe(404);
    expect((await fetch(`${base}/api/thumbs/backgrounds/..%2Fx`)).status).toBeGreaterThanOrEqual(400);
  });

  it('with a contact sheet the cell is described and the sheet itself is served; names are validated', async () => {
    await fs.writeFile(path.join(sheets, 'sheet-01.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    await fs.writeFile(path.join(sheets, 'sheet-index.json'), JSON.stringify({ gone: { sheet: 'sheet-01.jpg', x: 400, y: 18, w: 400, h: 207, sheetW: 1600, sheetH: 1000 }, bad: { sheet: '../evil.jpg', x: 0, y: 0, w: 1, h: 1, sheetW: 1, sheetH: 1 } }));
    const r = await fetch(`${base}/api/thumbs/backgrounds/gone/sheet`);
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ x: 400, y: 18, w: 400, h: 207, url: '/api/thumbs/sheets/sheet-01.jpg' });
    expect((await fetch(`${base}/api/thumbs/sheets/sheet-01.jpg`)).status).toBe(200);
    expect((await fetch(`${base}/api/thumbs/sheets/..%2Fx.jpg`)).status).toBeGreaterThanOrEqual(400);
    expect((await fetch(`${base}/api/thumbs/sheets/nothing.jpg`)).status).toBe(404);
    expect((await fetch(`${base}/api/thumbs/backgrounds/bad/sheet`)).status).toBe(404);
  });
});

describe('thumbnails of the real library', () => {
  const real = loadConfig();
  const dir = path.join(real.assetRoot, 'backgrounds');
  it('every kind of background PNG of the library decodes, and a downscale keeps the colours', async () => {
    const files = await fs.readdir(dir).catch(() => [] as string[]);
    if (files.length === 0) return;
    for (const f of files.filter((x) => x.endsWith('.png')).slice(0, 6)) {
      const img = decodePng(await fs.readFile(path.join(dir, f)));
      expect(img, f).not.toBeNull();
      const small = downscale(img!, 160);
      expect(small.width).toBe(160);
      const mean = (r: { data: Uint8Array }) => r.data.reduce((a, v, i) => a + (i % 4 === 3 ? 0 : v), 0) / ((r.data.length / 4) * 3);
      expect(Math.abs(mean(small) - mean(img!))).toBeLessThan(3);
    }
  });
});
