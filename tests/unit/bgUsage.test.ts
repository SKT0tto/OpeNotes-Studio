import http, { type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../server/app';
import { resolveConfig } from '../../server/config';
import { backgroundUsage } from '../../server/projects/usage';
import { ProjectSchema, type Project } from '../../shared/schema/project';
import demo from '../fixtures/demo-project.json';

const UID = 'user_0123456789ab';
const clone = (): Project => ProjectSchema.parse(structuredClone(demo));
/** Fixture project with `n` scenes copied from the demo, retitled/re-id'd. */
function withBg(id: string, title: string, opts: { start?: number[]; track?: number[] }): Project {
  const p = clone();
  p.id = id;
  p.title = title;
  for (const i of opts.start ?? []) p.scenes[i]!.background.assetId = UID;
  for (const i of opts.track ?? []) {
    const tr = p.scenes[i]!.tracks.find((t) => t.channel === 'background');
    const sc = p.scenes[i]!;
    const key = { id: `kx${i}`, at: { beatId: sc.beats[0]!.id, offset: 0 }, value: { assetId: UID, transition: 'cut', transitionSeconds: 0.5, purpose: 'move' }, duration: 0, ease: 'linear' };
    if (tr && tr.channel === 'background') tr.keys.push(key as never);
    else sc.tracks.push({ id: `tbx${i}`, target: { kind: 'stage' }, channel: 'background', meta: structuredClone(sc.tracks[0]!.meta), keys: [{ ...key, meta: undefined }] } as never);
  }
  return ProjectSchema.parse(p);
}

describe('backgroundUsage', () => {
  it('counts scenes using the id as start background or background-track key, per project', () => {
    const a = withBg('a', '乙项目', { start: [0], track: [0, 1] }); // scene 0 counted once, scene 1 via track
    const b = withBg('b', '甲项目', { track: [2] });
    const c = withBg('c', '未使用', {});
    expect(backgroundUsage([a, b, c], UID)).toEqual([
      { id: 'b', title: '甲项目', scenes: 1 },
      { id: 'a', title: '乙项目', scenes: 2 },
    ]);
    expect(backgroundUsage([c], UID)).toEqual([]);
  });
});

describe('GET /api/import/background/:id/usage', () => {
  let tmp: string;
  let server: Server;
  let base: string;
  beforeAll(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-bgusage-'));
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

  it('reads saved projects and rejects non-uploaded ids', async () => {
    const used = withBg('p_used', '用到了', { start: [1], track: [2] });
    const idle = withBg('p_idle', '没用到', {});
    for (const p of [used, idle]) {
      expect((await fetch(`${base}/api/projects`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(p) })).status).toBe(201);
    }
    const r = await fetch(`${base}/api/import/background/${UID}/usage`);
    expect(await r.json()).toEqual({ projects: [{ id: 'p_used', title: '用到了', scenes: 2 }] });
    expect((await fetch(`${base}/api/import/background/user_ffffffffffff/usage`).then((x) => x.json()))).toEqual({ projects: [] });
    expect((await fetch(`${base}/api/import/background/adv_bkg_stage_000001/usage`)).status).toBe(400);
  });
});
