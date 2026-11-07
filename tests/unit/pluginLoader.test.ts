import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PluginHost } from '../../server/plugins/loader';
import { VoiceFiles, safeVoiceName, voiceFileRoutes } from '../../server/plugins/voiceFiles';

let dir: string;
let servers: Array<{ close(): void }> = [];

const write = (rel: string, content: string) => {
  const f = path.join(dir, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, content);
};
const manifest = (id: string, extra: object = {}) => JSON.stringify({ id, name: `Plugin ${id}`, version: '1.2.3', description: 'd', ...extra });
const GOOD = `export default function register(ctx) {
  ctx.router.get('/hello', (_req, res) => res.json({ id: ctx.id, dataDir: ctx.dataDir, llm: ctx.llm.available() }));
  ctx.router.get('/boom', () => { throw Object.assign(new Error('plugin exploded'), { status: 418 }); });
}`;

async function start(pluginsDir = path.join(dir, 'plugins'), llmOk = false) {
  const logs: string[] = [];
  const host = new PluginHost({
    pluginsDir, dataDir: path.join(dir, 'data'), log: (m) => logs.push(m), voiceFiles: new VoiceFiles(path.join(dir, 'data', 'projects')), cache: null,
    llm: { provider: () => (llmOk ? ({ provider: {} } as never) : { provider: null, message: '未配置 AI' }) },
  });
  await host.loadAll();
  const app = express();
  app.use(host.router);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  servers.push(server);
  return { host, logs, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugins-'));
});
afterEach(() => {
  for (const s of servers) s.close();
  servers = [];
});

describe('plugin loader', () => {
  it('with no plugins folder (or an empty one) there are no plugins and nothing else changes', async () => {
    const none = await start();
    expect(await (await fetch(`${none.base}/api/plugins`)).json()).toEqual([]);
    fs.mkdirSync(path.join(dir, 'plugins'));
    expect((await start()).host.list()).toEqual([]);
  });

  it('loads a plugin: its router is mounted under /api/plugins/<id>/, its web entry is served, server.mjs never is', async () => {
    write('plugins/good/plugin.json', manifest('good'));
    write('plugins/good/server.mjs', GOOD);
    write('plugins/good/web.js', 'export default { activate() {} };');
    write('plugins/good/README.md', 'readme');
    const { base, logs } = await start();
    expect(await (await fetch(`${base}/api/plugins`)).json()).toEqual([{ id: 'good', name: 'Plugin good', version: '1.2.3', description: 'd', web: '/plugins/good/web.js' }]);
    const hello = await (await fetch(`${base}/api/plugins/good/hello`)).json();
    expect(hello).toMatchObject({ id: 'good', llm: { ok: false, message: '未配置 AI' } });
    expect(hello.dataDir.replace(/\\/g, '/')).toMatch(/data\/plugins\/good$/);
    const web = await fetch(`${base}/plugins/good/web.js`);
    expect(web.status).toBe(200);
    expect(await web.text()).toContain('activate');
    for (const f of ['server.mjs', 'plugin.json', 'README.md', '..%2Fplugin.json']) expect((await fetch(`${base}/plugins/good/${f}`)).status).toBe(404);
    expect((await fetch(`${base}/plugins/nope/web.js`)).status).toBe(404);
    expect(logs.join('\n')).toContain('plugin good 1.2.3 loaded');
  });

  it('a plugin that throws on a request answers with its error, not a crash', async () => {
    write('plugins/good/plugin.json', manifest('good'));
    write('plugins/good/server.mjs', GOOD);
    const { base } = await start();
    const res = await fetch(`${base}/api/plugins/good/boom`);
    expect(res.status).toBe(418);
    expect(await res.json()).toEqual({ error: 'plugin exploded' });
    expect((await fetch(`${base}/api/plugins`)).status).toBe(200);
  });

  it('skips a broken plugin (bad manifest, throwing import, no register) and still loads the others', async () => {
    write('plugins/a-badjson/plugin.json', '{ not json');
    write('plugins/b-wrongid/plugin.json', manifest('something-else'));
    write('plugins/c-throws/plugin.json', manifest('c-throws'));
    write('plugins/c-throws/server.mjs', 'throw new Error("import blew up");');
    write('plugins/d-noregister/plugin.json', manifest('d-noregister'));
    write('plugins/d-noregister/server.mjs', 'export const x = 1;');
    write('plugins/e-registerfails/plugin.json', manifest('e-registerfails'));
    write('plugins/e-registerfails/server.mjs', 'export default function register() { throw new Error("register blew up"); }');
    write('plugins/f-missing/plugin.json', manifest('f-missing', { server: 'server.mjs' }));
    write('plugins/z-good/plugin.json', manifest('z-good'));
    write('plugins/z-good/server.mjs', GOOD);
    write('plugins/not-a-plugin/readme.txt', 'no manifest: ignored');
    const { base, host, logs } = await start();
    const byId = Object.fromEntries(host.list().map((p) => [p.id, p]));
    expect(Object.keys(byId).sort()).toEqual(['a-badjson', 'b-wrongid', 'c-throws', 'd-noregister', 'e-registerfails', 'f-missing', 'z-good']);
    expect(byId['a-badjson']!.error).toBeTruthy();
    expect(byId['b-wrongid']!.error).toContain('does not match');
    expect(byId['c-throws']!.error).toContain('import blew up');
    expect(byId['d-noregister']!.error).toContain('register');
    expect(byId['e-registerfails']!.error).toContain('register blew up');
    expect(byId['f-missing']!.error).toBeTruthy();
    expect(byId['z-good']!.error).toBeUndefined();
    expect((await fetch(`${base}/api/plugins/z-good/hello`)).status).toBe(200);
    expect((await fetch(`${base}/api/plugins/c-throws/hello`)).status).toBe(404);
    expect(logs.some((l) => l.includes('c-throws'))).toBe(true);
  });

  it('dev mode prefers src/server.ts and points the browser at the source', async () => {
    write('plugins/dev/plugin.json', manifest('dev'));
    write('plugins/dev/src/web.tsx', '// source');
    write('plugins/dev/web.js', '// built');
    const { host } = await start(path.join(dir, 'plugins'));
    expect(host.list()[0]!.web).toBe('/plugins/dev/web.js');
    const logs: string[] = [];
    const devHost = new PluginHost({ pluginsDir: path.join(dir, 'plugins'), dataDir: path.join(dir, 'data'), log: (m) => logs.push(m), voiceFiles: new VoiceFiles(dir), cache: null, llm: { provider: () => ({ provider: null, message: '' }) }, dev: true });
    await devHost.loadAll();
    expect(devHost.list()[0]!.web).toMatch(/^\/@fs\/.*plugins\/dev\/src\/web\.tsx$/);
  });
});

describe('voice files (core)', () => {
  it('accepts only plain audio names', () => {
    expect(safeVoiceName('b1-0123abcd.wav')).toBe(true);
    expect(safeVoiceName('take 1.mp3')).toBe(false);
    for (const bad of ['../x.wav', 'a/b.wav', '..wav', 'x.exe', '.hidden.wav', 'a..b.wav', 'project.json']) expect(safeVoiceName(bad)).toBe(false);
  });
  it('writes, reads, lists, removes and serves a project voice file', async () => {
    const files = new VoiceFiles(path.join(dir, 'projects'));
    await files.write('p1', 'line1-aaaaaaaa.wav', new Uint8Array([1, 2, 3]));
    await files.write('p1', 'hand.mp3', new Uint8Array([9]));
    expect((await files.list('p1')).sort()).toEqual(['hand.mp3', 'line1-aaaaaaaa.wav']);
    expect([...(await files.read('p1', 'line1-aaaaaaaa.wav'))!]).toEqual([1, 2, 3]);
    expect(await files.read('p1', 'nope.wav')).toBeNull();
    await expect(files.write('p1', '../evil.wav', new Uint8Array())).rejects.toThrow();
    await expect(files.write('../p1', 'a.wav', new Uint8Array())).rejects.toThrow();
    const app = express();
    app.use(voiceFileRoutes(files));
    const server = app.listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    servers.push(server);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const ok = await fetch(`${base}/api/projects/p1/voice/hand.mp3`);
    expect(ok.status).toBe(200);
    expect(ok.headers.get('content-type')).toContain('audio/mpeg');
    expect((await fetch(`${base}/api/projects/p1/voice/..%2Fproject.json`)).status).toBe(400);
    expect((await fetch(`${base}/api/projects/p1/voice/gone.wav`)).status).toBe(404);
    await files.remove('p1', 'hand.mp3');
    expect(await files.list('p1')).toEqual(['line1-aaaaaaaa.wav']);
  });
});
