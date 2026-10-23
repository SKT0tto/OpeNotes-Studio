import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { agentRoutes } from '../../server/agent/routes';
import type { CatalogService } from '../../server/assets/indexer';
import { LlmCache } from '../../server/llm/cache';
import type { FixtureProvider } from '../../server/llm/fixtureProvider';
import { OpenAiCompatProvider } from '../../server/llm/openaiCompat';
import { projectRoutes } from '../../server/projects/routes';
import { LlmSettings } from '../../server/settings/store';
import { ProjectStore } from '../../server/projects/store';
import type { StudioConfig } from '../../server/config';
import { cat, directedProject } from './helpers/directorFlow';
import { ScriptedProvider, call, reply } from './helpers/scriptedProvider';

let tmp: string;
let server: Server;
let base: string;
const P = directedProject();
const beatId = P.scenes[2]!.beats[2]!.id;

async function serve(settings: LlmSettings, extra?: (app: express.Express) => void) {
  const app = express();
  app.use(agentRoutes({ settings, cache: new LlmCache(path.join(tmp, 'cache')), catalog: { get: async () => ({ ...cat, version: 'v-test' }) } as unknown as CatalogService }));
  extra?.(app);
  return new Promise<{ s: Server; base: string }>((r) => {
    const s = app.listen(0, '127.0.0.1', () => r({ s, base: `http://127.0.0.1:${(s.address() as AddressInfo).port}` }));
  });
}
const events = (text: string) => text.split('\n\n').filter(Boolean).map((b) => ({ ev: /^event: (\w+)/m.exec(b)![1]!, data: JSON.parse(/^data: (.*)$/m.exec(b)![1]!) as Record<string, any> })); // eslint-disable-line @typescript-eslint/no-explicit-any

let scripted: ScriptedProvider;
beforeAll(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-routes-'));
  scripted = new ScriptedProvider([]);
  const a = await serve(new LlmSettings({ file: path.join(tmp, 's.json'), env: {}, fixtureProvider: () => scripted as unknown as FixtureProvider }));
  server = a.s;
  base = a.base;
});
afterAll(async () => {
  await new Promise((r) => server.close(r));
  await fs.rm(tmp, { recursive: true, force: true });
});

const turn = (body: unknown) => fetch(`${base}/api/agent/turn`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('POST /api/agent/turn', () => {
  it('rejects a body without a valid project / instruction', async () => {
    expect((await turn({ project: {}, instruction: 'x' })).status).toBe(400);
    expect((await turn({ project: P })).status).toBe(400);
  });

  it('streams status / tool / op events and ends with the proposal (ops, summary, usage)', async () => {
    scripted = new ScriptedProvider([
      reply('', [call('set_shot', { beatIds: [beatId], adjust: 'tighter', reason: '情绪升高' })]),
      reply('', [call('get_beat', { beatId })]),
      reply('镜头推近了。'),
    ]);
    const res = await turn({ project: P, selection: { sceneId: 's_3', beatId }, instruction: '推近一点', history: [{ role: 'user', content: '之前的话' }, { role: 'assistant', content: '好的' }] });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const ev = events(await res.text());
    const names = ev.map((e) => e.ev);
    expect(names).toEqual(expect.arrayContaining(['status', 'tool', 'op', 'usage', 'proposal', 'done']));
    const proposal = ev.find((e) => e.ev === 'proposal')!.data;
    expect(proposal.applied).toHaveLength(1);
    expect(proposal.applied[0].op).toMatchObject({ op: 'shot_set', beatId });
    expect(proposal.summary).toBe('镜头推近了。');
    expect(proposal.usage.inputTokens).toBe(3000);
    expect(proposal.mode).toBe('tools');
    expect(JSON.stringify(ev)).not.toMatch(/sk-[A-Za-z0-9]{20}/);
    expect(scripted.toolRequests[0]!.messages.some((m) => m.content === '之前的话')).toBe(true);
  });

  it('only one turn per project at a time (409 for the second)', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    scripted = new ScriptedProvider([() => { throw new Error('unused'); }]);
    scripted.chatTools = async () => { await gate; return reply('好'); };
    const first = turn({ project: P, selection: { sceneId: 's_3' }, instruction: 'a' });
    await new Promise((r) => setTimeout(r, 150));
    const second = await turn({ project: P, selection: { sceneId: 's_3' }, instruction: 'b' });
    expect(second.status).toBe(409);
    release();
    expect((await first).status).toBe(200);
    await (await first).text().catch(() => '');
  });

  it('reports a failing model as a failed event with a safe message', async () => {
    scripted = new ScriptedProvider([]);
    const ev = events(await (await turn({ project: P, selection: { sceneId: 's_3' }, instruction: 'a' })).text());
    expect(ev.at(-1)!.ev).toBe('failed');
  });

  it('says so when no AI is configured (503), never a fake answer', async () => {
    const bare = await serve(new LlmSettings({ file: path.join(tmp, 'bare.json'), env: {} }));
    const r = await fetch(`${bare.base}/api/agent/turn`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ project: P, instruction: 'x' }) });
    expect(r.status).toBe(503);
    expect((await r.json()).error.kind).toBe('not_configured');
    await new Promise((res) => bare.s.close(res));
  });
});

describe('OpenAI-compatible function calling over a mock fetch', () => {
  const okBody = (message: unknown, usage = { prompt_tokens: 120, completion_tokens: 40, prompt_cache_hit_tokens: 100 }) => new Response(JSON.stringify({ choices: [{ finish_reason: 'tool_calls', message }], usage }), { status: 200 });

  it('sends tools with tool_choice auto (never required), parses parallel tool_calls and passes reasoning back', async () => {
    const bodies: Array<Record<string, any>> = []; // eslint-disable-line @typescript-eslint/no-explicit-any
    const fakeFetch = (async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return bodies.length === 1
        ? okBody({ content: null, reasoning_content: '想一想', tool_calls: [{ id: 'a', type: 'function', function: { name: 'set_shot', arguments: '{"beatIds":["b1"]}' } }, { id: 'b', type: 'function', function: { name: 'get_beat', arguments: '{"beatId":"b1"}' } }] })
        : new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '完成' } }], usage: { prompt_tokens: 10, completion_tokens: 2 } }), { status: 200 });
    }) as unknown as typeof fetch;
    const p = new OpenAiCompatProvider({ baseUrl: 'http://x.test/v1', apiKey: 'sk-test-secret-key', model: 'm', fetch: fakeFetch, toolsMemory: false, modeMemory: false, retries: 0 });
    const tools = [{ name: 'set_shot', description: 'd', parameters: { type: 'object', properties: {} } }];
    const r1 = await p.chatTools({ messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'u' }], tools, maxTokens: 4000 });
    expect(r1.toolCalls.map((c) => c.name)).toEqual(['set_shot', 'get_beat']);
    expect(r1.reasoning).toBe('想一想');
    expect(r1.usage).toMatchObject({ inputTokens: 120, outputTokens: 40, cacheReadTokens: 100 });
    expect(bodies[0]!.tool_choice).toBe('auto');
    expect(JSON.stringify(bodies[0])).not.toContain('required');
    expect(bodies[0]!.tools[0]).toMatchObject({ type: 'function', function: { name: 'set_shot' } });
    const r2 = await p.chatTools({
      messages: [{ role: 'user', content: 'u' }, { role: 'assistant', content: '', reasoning: r1.reasoning!, toolCalls: r1.toolCalls }, { role: 'tool', content: 'ok', toolCallId: 'a' }, { role: 'tool', content: 'ok', toolCallId: 'b' }],
      tools, maxTokens: 4000,
    });
    expect(r2.text).toBe('完成');
    const assistant = bodies[1]!.messages[1];
    expect(assistant.reasoning_content).toBe('想一想');
    expect(assistant.tool_calls).toHaveLength(2);
    expect(bodies[1]!.messages[2]).toMatchObject({ role: 'tool', tool_call_id: 'a' });
  });

  it('an HTTP 400 is a bad_request (the agent falls back); the refusal is remembered per endpoint and forgotten after a settings change', async () => {
    const memory = new Map<string, number>();
    const fakeFetch = (async () => new Response('{"error":{"message":"tools not supported"}}', { status: 400 })) as unknown as typeof fetch;
    const mk = () => new OpenAiCompatProvider({ baseUrl: 'http://y.test/v1', model: 'm', fetch: fakeFetch, toolsMemory: memory, modeMemory: false, retries: 0 });
    const p = mk();
    expect(p.toolsSupported()).toBe(true);
    await expect(p.chatTools({ messages: [{ role: 'user', content: 'u' }], tools: [], maxTokens: 100 })).rejects.toMatchObject({ kind: 'bad_request' });
    p.noteToolsUnsupported();
    expect(mk().toolsSupported()).toBe(false); // a later provider instance for the same endpoint already knows
    const other = new OpenAiCompatProvider({ baseUrl: 'http://z.test/v1', model: 'm', fetch: fakeFetch, toolsMemory: memory, modeMemory: false });
    expect(other.toolsSupported()).toBe(true);
    const { forgetToolsSupport } = await import('../../server/llm/openaiCompat');
    forgetToolsSupport(undefined, memory);
    expect(mk().toolsSupported()).toBe(true);
  });

  it('never leaks the key in an error', async () => {
    const fakeFetch = (async () => new Response('bad sk-test-secret-key', { status: 401 })) as unknown as typeof fetch;
    const p = new OpenAiCompatProvider({ baseUrl: 'http://x.test/v1', apiKey: 'sk-test-secret-key', model: 'm', fetch: fakeFetch, toolsMemory: false, modeMemory: false, retries: 0 });
    await expect(p.chatTools({ messages: [{ role: 'user', content: 'u' }], tools: [], maxTokens: 10 })).rejects.toSatisfy((e: Error) => !e.message.includes('sk-test-secret-key'));
  });
});

describe('agent snapshots in the project history', () => {
  it('writes agent-*.json next to the history, keeps the newest 10, and does not touch project.json or the normal history budget', async () => {
    const dir = path.join(tmp, 'projects');
    const store = new ProjectStore(dir);
    const created = await store.create(P);
    for (let i = 0; i < 12; i++) await store.snapshot(P.id, { ...P, title: `快照 ${i}` });
    const files = await fs.readdir(path.join(dir, P.id, 'history'));
    expect(files.filter((f) => f.startsWith('agent-'))).toHaveLength(10);
    expect((await store.get(P.id)).etag).toBe(created.etag);
    // 25 normal saves: the normal history still keeps its own 20, snapshots are untouched
    let etag = created.etag;
    for (let i = 0; i < 22; i++) etag = (await store.save(P.id, { ...P, title: `v${i}` }, etag)).etag;
    const after = await fs.readdir(path.join(dir, P.id, 'history'));
    expect(after.filter((f) => f.startsWith('agent-'))).toHaveLength(10);
    expect(after.filter((f) => !f.startsWith('agent-'))).toHaveLength(20);
    await expect(store.snapshot('no_such', { ...P, id: 'no_such' })).rejects.toThrow();
    await expect(store.snapshot(P.id, { ...P, id: 'other' })).rejects.toThrow();
  });

  it('POST /api/projects/:id/snapshot', async () => {
    const dir = path.join(tmp, 'projects2');
    const cfg = { dataDir: dir.replace(/projects2$/, 'd2') } as StudioConfig;
    const app = express();
    app.use(projectRoutes(cfg));
    const s = await new Promise<Server>((r) => { const x = app.listen(0, '127.0.0.1', () => r(x)); });
    const b = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
    const j = { 'content-type': 'application/json' };
    expect((await fetch(`${b}/api/projects`, { method: 'POST', headers: j, body: JSON.stringify(P) })).status).toBe(201);
    const r = await fetch(`${b}/api/projects/${P.id}/snapshot`, { method: 'POST', headers: j, body: JSON.stringify(P) });
    expect(r.status).toBe(201);
    expect((await r.json()).name).toMatch(/^agent-/);
    expect((await fetch(`${b}/api/projects/${P.id}/snapshot`, { method: 'POST', headers: j, body: JSON.stringify({ nope: 1 }) })).status).toBe(400);
    await new Promise((res) => s.close(res));
  });
});
