import http, { type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../server/app';
import { resolveConfig } from '../../server/config';
import { MAX_HISTORY } from '../../server/projects/store';
import { blankProject } from '../../shared/project/blank';
import { collectRefs, exportEnvelope, findMissing, parseImport, replaceRef } from '../../shared/project/exchange';
import { ProjectSchema } from '../../shared/schema/project';
import demo from '../fixtures/demo-project.json';

let tmp: string;
let server: Server;
let base: string;

beforeAll(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-projects-'));
  const assets = path.join(tmp, 'assets');
  await fs.cp(path.resolve('tests/fixtures/fake-assets'), assets, { recursive: true });
  const { app } = createApp(resolveConfig({ ASSET_ROOT: assets, DATA_DIR: path.join(tmp, 'data') }));
  server = await new Promise<Server>((resolve) => {
    const s: http.Server = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise((r) => server.close(r));
  await fs.rm(tmp, { recursive: true, force: true });
});

const post = (body: unknown) => fetch(`${base}/api/projects`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) });
const put = (id: string, body: unknown, etag?: string) =>
  fetch(`${base}/api/projects/${id}`, { method: 'PUT', headers: { 'content-type': 'application/json', ...(etag ? { 'if-match': etag } : {}) }, body: JSON.stringify(body) });

describe('projects API', () => {
  it('creates, lists, loads and deletes a project', async () => {
    const p = blankProject('第一个项目');
    const created = await post(p);
    expect(created.status).toBe(201);
    expect(created.headers.get('etag')).toBeTruthy();
    expect((await post(p)).status).toBe(409);
    const list = (await (await fetch(`${base}/api/projects`)).json()) as Array<{ id: string; title: string }>;
    expect(list.some((x) => x.id === p.id && x.title === '第一个项目')).toBe(true);
    const got = await fetch(`${base}/api/projects/${p.id}`);
    expect(await got.json()).toEqual(p);
    expect((await fetch(`${base}/api/projects/${p.id}`, { method: 'DELETE' })).status).toBe(204);
    expect((await fetch(`${base}/api/projects/${p.id}`)).status).toBe(404);
  });

  it('rejects invalid JSON, schema violations and unsafe ids', async () => {
    expect((await post('{not json')).status).toBe(400);
    const bad = await post({ ...blankProject('x'), settings: { aspect: '4:3' } });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toMatch(/invalid project/);
    expect((await post({ ...blankProject('x'), id: '../evil' })).status).toBe(400);
    expect((await fetch(`${base}/api/projects/..%2Fx`)).status).toBeGreaterThanOrEqual(400);
  });

  it('saves with If-Match: a stale or missing version is refused and nothing is overwritten', async () => {
    const p = blankProject('v1');
    const etag1 = (await post(p)).headers.get('etag')!;
    const r2 = await put(p.id, { ...p, title: 'v2' }, etag1);
    expect(r2.status).toBe(200);
    const etag2 = r2.headers.get('etag')!;
    expect(etag2).not.toBe(etag1);
    expect((await put(p.id, { ...p, title: 'stale' }, etag1)).status).toBe(412);
    expect((await put(p.id, { ...p, title: 'nomatch' })).status).toBe(412);
    expect((await put(p.id, { ...p, id: 'other' }, etag2)).status).toBe(400);
    expect(((await (await fetch(`${base}/api/projects/${p.id}`)).json()) as { title: string }).title).toBe('v2');
  });

  it('keeps the previous versions in history/, at most 20', async () => {
    const p = blankProject('h0');
    let etag = (await post(p)).headers.get('etag')!;
    const total = MAX_HISTORY + 5;
    for (let i = 1; i <= total; i++) etag = (await put(p.id, { ...p, title: `h${i}` }, etag)).headers.get('etag')!;
    const dir = path.join(tmp, 'data', 'projects', p.id, 'history');
    const files = (await fs.readdir(dir)).sort();
    expect(files).toHaveLength(MAX_HISTORY);
    const oldest = JSON.parse(await fs.readFile(path.join(dir, files[0]!), 'utf8')) as { title: string };
    const newest = JSON.parse(await fs.readFile(path.join(dir, files.at(-1)!), 'utf8')) as { title: string };
    expect(oldest.title).toBe(`h${total - MAX_HISTORY}`);
    expect(newest.title).toBe(`h${total - 1}`);
  });
});

describe('export / import', () => {
  const project = ProjectSchema.parse(demo);

  it('an exported file imports back to an identical project', () => {
    const text = JSON.stringify(exportEnvelope(project, 'cat-1'), null, 1);
    const back = parseImport(text);
    expect(back).toMatchObject({ ok: true, catalogVersion: 'cat-1' });
    if (back.ok) expect(back.project).toEqual(project);
  });

  it('still imports files exported under the old format id', () => {
    const legacy = { ...exportEnvelope(project, 'cat-1'), format: 'ournotes-project' };
    expect(parseImport(JSON.stringify(legacy))).toMatchObject({ ok: true });
  });

  it('accepts a bare project, rejects garbage with a reason', () => {
    expect(parseImport(JSON.stringify(project)).ok).toBe(true);
    expect(parseImport('nope')).toMatchObject({ ok: false, error: expect.stringContaining('JSON') });
    expect(parseImport('{"schemaVersion":1}')).toMatchObject({ ok: false, error: expect.stringContaining('schema') });
  });

  it('lists missing resources and can replace them', () => {
    const refs = collectRefs(project);
    expect(refs.backgrounds).toContain('adv_bkg_stage_000153');
    expect(refs.models).toContain('001_school_winter_hs_1st');
    const have = { models: new Set(refs.models), backgrounds: new Set(refs.backgrounds.filter((b) => b !== 'adv_bkg_stage_000153')), audio: new Set(refs.audio) };
    expect(findMissing(project, have)).toEqual([{ kind: 'background', id: 'adv_bkg_stage_000153' }]);
    const fixed = replaceRef(project, 'background', 'adv_bkg_stage_000153', 'adv_bkg_stage_000001');
    have.backgrounds.add('adv_bkg_stage_000001');
    expect(findMissing(fixed, have)).toEqual([]);
    expect(project.scenes[0]!.background.assetId).toBe('adv_bkg_stage_000153'); // original untouched
    const swapped = replaceRef(project, 'model', '001_school_winter_hs_1st', '001_casual_spring_01');
    expect(collectRefs(swapped).models).not.toContain('001_school_winter_hs_1st');
  });
});
