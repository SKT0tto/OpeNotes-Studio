import http, { type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../server/app';
import { resolveConfig } from '../../server/config';
import { LabelFileSchema } from '../../shared/schema/assetLabels';

let tmp: string;
let server: Server;
let base: string;
let labelsFile: string;
const label = { bands: ['mygo'], access: 'private', placeType: 'home', placeName: null, indoor: 'indoor', time: 'day', stage: false, confidence: 'confirmed', evidence: 't', location: null, owner: null, exclusive: true, homeBand: null };
const json = (method: string, url: string, body: unknown) => fetch(`${base}${url}`, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const catalog = async () => (await (await fetch(`${base}/api/catalog`)).json()) as { version: string; backgrounds: Array<{ id: string; name: string; labels?: { bands: string[]; source: string } }> };

beforeAll(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-labels-'));
  const assets = path.join(tmp, 'assets');
  await fs.cp(path.resolve('tests/fixtures/fake-assets'), assets, { recursive: true });
  labelsFile = path.join(tmp, 'labels', 'backgrounds.json');
  const config = resolveConfig({ ASSET_ROOT: assets, DATA_DIR: path.join(tmp, 'data') });
  const { app } = createApp(config, () => {}, { env: { LABELS_FILE: labelsFile } });
  server = await new Promise<Server>((resolve) => {
    const s = http.createServer(app).listen(0, '127.0.0.1', () => resolve(s));
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise((r) => server.close(r));
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('asset label API', () => {
  it('PUT / PATCH change the catalog version and labels; invalid bodies are 400', async () => {
    const v0 = (await catalog()).version;
    expect((await json('PUT', '/api/asset-labels/backgrounds/1', label)).status).toBe(200);
    const c1 = await catalog();
    expect(c1.version).not.toBe(v0);
    expect(c1.backgrounds.find((b) => b.id === '1')!.labels).toMatchObject({ bands: ['mygo'], source: 'user' });
    expect((await json('PATCH', '/api/asset-labels/backgrounds', { ids: ['1', '2'], patch: { ...label, bands: ['generic'], exclusive: false } })).status).toBe(200);
    const c2 = await catalog();
    expect(c2.version).not.toBe(c1.version);
    expect(c2.backgrounds.map((b) => b.labels?.bands)).toEqual([['generic'], ['generic']]);
    expect((await json('PUT', '/api/asset-labels/backgrounds/1', { ...label, access: 'nope' })).status).toBe(400);
    expect((await json('PATCH', '/api/asset-labels/backgrounds', { ids: ['1'], patch: { confidence: 'maybe' } })).status).toBe(400);
    expect((await json('PATCH', '/api/asset-labels/backgrounds', { ids: ['zzz'], patch: { bands: [] } })).status).toBe(400); // a new label needs every field
    expect(LabelFileSchema.parse(JSON.parse(await fs.readFile(labelsFile, 'utf8'))).labels['1']!.bands).toEqual(['generic']);
  });

  it('concurrent PUTs never fail and keep the file valid', async () => {
    const rs = await Promise.all(Array.from({ length: 12 }, (_, i) => json('PUT', `/api/asset-labels/backgrounds/${i % 2 === 0 ? 1 : 2}`, { ...label, evidence: `e${i}` })));
    expect(await Promise.all(rs.map((r) => r.clone().text())), "bodies").toEqual(Array(12).fill('{"ok":true}'));
    expect(() => LabelFileSchema.parse(JSON.parse(fs_read(labelsFile)))).not.toThrow();
  });

  it('stats count by confidence and band', async () => {
    const s = (await (await fetch(`${base}/api/asset-labels/backgrounds/stats`)).json()) as { total: number; confidence: { confirmed: number }; bands: Record<string, number> };
    expect(s.total).toBe(2);
    expect(s.confidence.confirmed).toBe(2);
    expect(s.bands.mygo).toBe(2);
  });
});

import { readFileSync } from 'node:fs';
const fs_read = (p: string) => readFileSync(p, 'utf8');
