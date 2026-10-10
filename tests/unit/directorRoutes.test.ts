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
import { LlmSettings } from '../../server/settings/store';
import type { Project } from '../../shared/schema/project';
import { FIXTURE_DIR, STORY } from './helpers/directorCatalog';
import { cat } from './helpers/directorFlow';

let tmp: string;
let server: Server;
let base: string;
let bareBase: string;
let bareServer: Server;
const post = (b: string, p: string, body: unknown) => fetch(`${b}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

async function serve(settings: LlmSettings): Promise<{ server: Server; base: string }> {
  const app = express();
  app.use(directorRoutes({ settings, cache: new LlmCache(path.join(tmp, 'cache')), catalog: { get: async () => ({ ...cat, version: 'v-test' }) } as unknown as CatalogService }));
  const s = await new Promise<Server>((r) => {
    const x = app.listen(0, '127.0.0.1', () => r(x));
  });
  return { server: s, base: `http://127.0.0.1:${(s.address() as AddressInfo).port}` };
}

beforeAll(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'director-routes-'));
  const fx = new FixtureProvider(FIXTURE_DIR);
  const a = await serve(new LlmSettings({ file: path.join(tmp, 's1.json'), env: {}, fixtureProvider: () => fx }));
  server = a.server;
  base = a.base;
  const b = await serve(new LlmSettings({ file: path.join(tmp, 's2.json'), env: {} }));
  bareServer = b.server;
  bareBase = b.base;
});
afterAll(async () => {
  await new Promise((r) => server.close(r));
  await new Promise((r) => bareServer.close(r));
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('director API', () => {
  it('without a configured provider every endpoint says so (503) and nothing pretends to be AI', async () => {
    for (const [p, body] of [['/api/director/breakdown', { text: STORY }], ['/api/director/scene', { project: {}, sceneId: 's' }]] as const) {
      const r = await post(bareBase, p, body);
      if (p.endsWith('scene')) expect(r.status).toBe(400); // invalid project is rejected first
      else {
        expect(r.status).toBe(503);
        expect((await r.json()).error).toMatchObject({ kind: 'not_configured' });
      }
    }
  });

  it('breakdown returns the validated breakdown, a skeleton project (stamped with the catalog version) and run info', async () => {
    const r = await post(base, '/api/director/breakdown', { text: STORY, title: '示例' });
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.project.catalogVersion).toBe('v-test');
    expect(j.project.scenes.length).toBe(4);
    expect(j.breakdown.scenes.length).toBe(4);
    expect(j.runs[0]).toMatchObject({ provider: 'fixture' });
    // decisions of the replay provider are labelled as rules, never as AI
    expect(j.project.scenes[0].background.meta.source).toBe('rule');
  });

  it('scene: merged scene + intent + report; regeneration with a scope only touches that scope', async () => {
    const bd = await (await post(base, '/api/director/breakdown', { text: STORY })).json();
    const project = bd.project as Project;
    const sid = project.scenes[1]!.id;
    const r = await post(base, '/api/director/scene', { project, sceneId: sid, scopes: ['scene'] });
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.applied).toBe(true);
    expect(j.scene.beats.length).toBeGreaterThan(3);
    expect(j.direction.beats.length).toBe(j.scene.beats.length);
    expect(j.scene.beats[0].meta.source).toBe('rule'); // replay provider
    project.scenes[1] = j.scene;
    const cam = await (await post(base, '/api/director/scene', { project, sceneId: sid, scopes: ['camera'] })).json();
    expect(cam.applied).toBe(true);
    expect(JSON.stringify(cam.scene.tracks)).toBe(JSON.stringify(j.scene.tracks));
    const missing = await post(base, '/api/director/scene', { project, sceneId: 'nope', scopes: ['scene'] });
    expect(missing.status).toBe(400);
  });

  it('scenes streams one progress event per state change and a final done event', async () => {
    const bd = await (await post(base, '/api/director/breakdown', { text: STORY })).json();
    const res = await post(base, '/api/director/scenes', { project: bd.project, scopes: ['scene'], concurrency: 2 });
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const text = await res.text();
    const events = [...text.matchAll(/event: (\w+)\ndata: (.*)\n/g)].map((m) => ({ e: m[1]!, d: JSON.parse(m[2]!) as Record<string, unknown> }));
    expect(events.filter((x) => x.e === 'progress' && x.d.state === 'start').length).toBe(4);
    expect(events.filter((x) => x.e === 'progress' && x.d.state === 'done').length).toBe(4);
    const done = events.find((x) => x.e === 'done')!.d as { items: Array<{ result: { applied: boolean } }> };
    expect(done.items.length).toBe(4);
    expect(done.items.every((i) => i.result.applied)).toBe(true);
  });

  it('rejects malformed requests', async () => {
    expect((await post(base, '/api/director/breakdown', {})).status).toBe(400);
    expect((await post(base, '/api/director/scenes', { project: { nope: 1 } })).status).toBe(400);
  });
});
