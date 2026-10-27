import express from 'express';
import fs from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ONE_OFF, runAgentTurn, toolSpecs } from '../../server/agent/loop';
import { memoryRoutes } from '../../server/agent/memoryRoutes';
import { agentRoutes } from '../../server/agent/routes';
import type { CatalogService } from '../../server/assets/indexer';
import { LlmCache } from '../../server/llm/cache';
import { LlmSettings } from '../../server/settings/store';
import { InMemoryMemories, MemoryStore, directorPreferencesFor, memoryIfOn } from '../../server/agent/memoryStore';
import { AGENT_SYSTEM } from '../../server/agent/prompt';
import { FixtureProvider } from '../../server/llm/fixtureProvider';
import { runScene } from '../../server/llm/sceneRunner';
import { DIRECTOR_PREFERENCE_NOTE, activeMemories, isDontCareMemory, looksLikeGeneralPreference, memoryReviewInstruction, directorMemories, directorPreferences, memoryPromptBlock, type Memory } from '../../shared/agent/memory';
import { FIXTURE_DIR } from './helpers/directorCatalog';
import { cat, directedProject, skeleton } from './helpers/directorFlow';
import { ScriptedProvider, call, reply } from './helpers/scriptedProvider';

const P = directedProject();
const S = P.scenes[2]!;
const b = (i: number) => S.beats[i]!;
const mem = (over: Partial<Memory> & Pick<Memory, 'id' | 'text'>): Memory => ({ scope: 'global', kind: 'camera', enabled: true, origin: 'manual', createdAt: 1, updatedAt: 1, ...over });
const turn = (provider: ScriptedProvider, instruction: string, memory?: InMemoryMemories) =>
  runAgentTurn({ provider, catalog: cat, director: { provider, cache: null, catalog: cat, now: () => 5000 }, now: () => 5000, genId: 'agent_m', ...(memory ? { memory } : {}) },
    { project: P, selection: { sceneId: 's_3', beatId: b(2).id }, instruction });

describe('memory helpers', () => {
  const all = [
    mem({ id: 'g1', text: '少用特写' }),
    mem({ id: 'p1', text: '回忆用雾边', scope: 'project', projectId: P.id, kind: 'fx' }),
    mem({ id: 'p2', text: '别的项目的', scope: 'project', projectId: 'other' }),
    mem({ id: 'g2', text: '关掉的', enabled: false }),
    mem({ id: 'o1', text: '总结写短一点', kind: 'other' }),
  ];
  it('active memories: enabled, this project + global, project first', () => {
    expect(activeMemories(all, P.id).map((m) => m.id)).toEqual(['p1', 'g1', 'o1']);
    expect(activeMemories(all, null).map((m) => m.id)).toEqual(['g1', 'o1']);
  });
  it('the prompt block lists every active memory with its id and the precedence rule; empty without memories', () => {
    const block = memoryPromptBlock(activeMemories(all, P.id));
    for (const id of ['p1', 'g1', 'o1']) expect(block).toContain(`[${id}]`);
    expect(block).not.toContain('别的项目的');
    expect(block).toContain('本项目记忆 > 全局记忆');
    expect(block.indexOf('## 本项目')).toBeLessThan(block.indexOf('## 全局'));
    expect(memoryPromptBlock([])).toBe('');
  });
  it('the director only sees style kinds (not `other`), and nothing at all without them', () => {
    expect(directorMemories(all, P.id).map((m) => m.id)).toEqual(['p1', 'g1']);
    const pref = directorPreferences(directorMemories(all, P.id))!;
    expect(pref.note).toBe(DIRECTOR_PREFERENCE_NOTE);
    expect(pref.items).toEqual(['【本项目】（特效）回忆用雾边', '【全局】（镜头）少用特写']);
    expect(directorPreferences([mem({ id: 'o', text: 'x', kind: 'other' })])).toBeNull();
    expect(directorPreferences([])).toBeNull();
  });
  it('one-off edits are recognised', () => {
    expect(ONE_OFF.test('把 s_3b_12 改成特写')).toBe(true);
    expect(ONE_OFF.test('第3场第2句用特写')).toBe(true);
    expect(ONE_OFF.test('每场第一句用全景')).toBe(false);
    expect(ONE_OFF.test('回忆一律用雾边')).toBe(false);
  });
});

describe('MemoryStore (file)', () => {
  let dir: string;
  beforeAll(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mem-')); });
  afterAll(async () => { await fs.rm(dir, { recursive: true, force: true }); });

  it('adds, edits, switches, deletes; writes valid JSON atomically; dedupes the same sentence', async () => {
    const st = new MemoryStore(path.join(dir, 'a', 'memories.json'), () => 42);
    expect((await st.read()).memories).toEqual([]);
    const a = await st.add({ text: '少用特写', scope: 'global', kind: 'camera' });
    const again = await st.add({ text: '少用特写', scope: 'global', kind: 'camera' });
    expect(again.id).toBe(a.id);
    const p = await st.add({ text: '灯说话时镜头别晃', scope: 'project', projectId: 'p_1', castId: 'c_1', castName: '灯', kind: 'camera' });
    await st.update(p.id, { enabled: false, text: '灯说话时不要晃镜头' });
    const moved = await st.update(p.id, { scope: 'global' });
    expect(moved).toMatchObject({ scope: 'global', text: '灯说话时不要晃镜头', enabled: false });
    expect(moved.projectId).toBeUndefined();
    expect(moved.castId).toBeUndefined();
    await st.remove(a.id);
    const raw = JSON.parse(await fs.readFile(st.file, 'utf8')) as { memories: Memory[]; enabled: boolean };
    expect(raw.enabled).toBe(true);
    expect(raw.memories.map((m) => m.id)).toEqual([p.id]);
    expect((await fs.readdir(path.dirname(st.file))).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('rejects invalid memories; parallel writes all land', async () => {
    const st = new MemoryStore(path.join(dir, 'b.json'));
    await expect(st.add({ text: 'x', scope: 'project' })).rejects.toThrow();
    await expect(st.add({ text: '', scope: 'global' })).rejects.toThrow();
    await Promise.all(Array.from({ length: 8 }, (_, i) => st.add({ text: `偏好 ${i}`, scope: 'global' })));
    expect((await st.read()).memories).toHaveLength(8);
  });

  it('a broken file is kept aside, not overwritten silently', async () => {
    const f = path.join(dir, 'c.json');
    await fs.writeFile(f, '{ broken', 'utf8');
    const st = new MemoryStore(f, () => 7);
    expect((await st.read()).memories).toEqual([]);
    expect(await fs.readFile(`${f}.broken-7`, 'utf8')).toBe('{ broken');
  });

  it('the global switch turns the agent memory and the director preferences off', async () => {
    const st = new MemoryStore(path.join(dir, 'd.json'));
    await st.add({ text: '少用特写', scope: 'global', kind: 'camera' });
    expect(await memoryIfOn(st)).toBe(st);
    expect(await directorPreferencesFor(st, 'p')).not.toBeNull();
    await st.setEnabled(false);
    expect(await memoryIfOn(st)).toBeUndefined();
    expect(await directorPreferencesFor(st, 'p')).toBeNull();
  });
});

describe('agent loop with memory', () => {
  it('without memory (absent or switched off) the system prompt and the tools are exactly as before', async () => {
    const p = new ScriptedProvider([reply('好的。')]);
    await turn(p, '你好');
    expect(p.toolRequests[0]!.messages[0]!.content).toBe(AGENT_SYSTEM);
    expect(p.toolRequests[0]!.tools.map((t) => t.name)).not.toContain('remember');
    expect(toolSpecs({ frames: true, revert: true, script: true }).map((t) => t.name)).not.toContain('forget');
  });

  it('injects every active memory after the stable prompt and offers the memory tools', async () => {
    const store = new InMemoryMemories({ memories: [mem({ id: 'm_a', text: '回忆一律用雾边', kind: 'fx' }), mem({ id: 'm_b', text: '本项目少用特写', scope: 'project', projectId: P.id })] });
    const p = new ScriptedProvider([reply('好的。')]);
    await turn(p, '你好', store);
    const sys = p.toolRequests[0]!.messages[0]!.content;
    expect(sys.startsWith(AGENT_SYSTEM)).toBe(true);
    expect(sys).toContain('# 长期记忆');
    expect(sys).toContain('[m_a]（特效）回忆一律用雾边');
    expect(sys).toContain('[m_b]');
    expect(p.toolRequests[0]!.tools.map((t) => t.name)).toEqual(expect.arrayContaining(['remember', 'forget', 'list_memories']));
  });

  it('remember(stated) saves (with kind and scope), reports a memory event, and is not mistaken for a claimed edit', async () => {
    const store = new InMemoryMemories();
    const p = new ScriptedProvider([
      reply('', [call('remember', { text: '回忆特效一律用雾边（edge=fog）', how: 'stated', kind: 'fx', scope: 'global' })]),
      reply('记住了：以后加回忆效果都用雾边，已为你设置好。'),
    ]);
    const r = await turn(p, '记住：回忆一律用雾边', store);
    expect(store.file.memories).toHaveLength(1);
    expect(store.file.memories[0]).toMatchObject({ scope: 'global', kind: 'fx', origin: 'stated' });
    expect(r.memory).toMatchObject([{ action: 'saved' }]);
    expect(r.claimedWithoutOps).toBeNull();
    expect(r.applied).toEqual([]);
  });

  it('remember(inferred) only proposes; nothing is stored', async () => {
    const store = new InMemoryMemories();
    const p = new ScriptedProvider([
      reply('', [call('remember', { text: '推近最多到 mcu', how: 'inferred', kind: 'camera', why: '你两次把特写拉回胸像' })]),
      reply('要不要记住「推近最多到 mcu」？'),
    ]);
    const r = await turn(p, '又太近了，拉远', store);
    expect(store.file.memories).toEqual([]);
    expect(r.memory).toMatchObject([{ action: 'proposed', proposal: { text: '推近最多到 mcu', kind: 'camera', scope: 'global', why: '你两次把特写拉回胸像' } }]);
  });

  it('a one-off edit is refused as a memory; a character makes it a project memory; forget and replaces work', async () => {
    const store = new InMemoryMemories({ memories: [mem({ id: 'm_old', text: '回忆用雾边', kind: 'fx' }), mem({ id: 'm_x', text: '别的项目', scope: 'project', projectId: 'zz' })] });
    const tomori = P.cast[0]!;
    const p = new ScriptedProvider([
      reply('', [call('remember', { text: `把 ${b(2).id} 改成特写`, how: 'stated', kind: 'camera' })]),
      reply('', [call('remember', { text: '说话时镜头别晃', how: 'stated', kind: 'camera', castId: tomori.id })]),
      reply('', [call('remember', { text: '回忆改用色带', how: 'stated', kind: 'fx', replaces: 'm_old' })]),
      reply('', [call('forget', { id: 'm_x' })]),
      reply('完成。'),
    ]);
    const r = await turn(p, 'x', store);
    const tools = p.toolRequests.slice(1).map((q) => q.messages.at(-1)!.content);
    expect(tools[0]).toContain('一次性编辑');
    expect(tools[3]).toContain('没有这条记忆');
    expect(store.file.memories.map((m) => [m.id, m.text, m.scope])).toEqual([
      ['m_old', '回忆改用色带', 'global'], ['m_x', '别的项目', 'project'], [expect.any(String), '说话时镜头别晃', 'project'],
    ]);
    expect(store.file.memories[2]).toMatchObject({ projectId: P.id, castId: tomori.id, castName: tomori.displayName });
    expect(r.memory.map((e) => e.action)).toEqual(['saved', 'updated']);
  });

  it('forget removes a visible memory', async () => {
    const store = new InMemoryMemories({ memories: [mem({ id: 'm_f', text: '少用特写' })] });
    const p = new ScriptedProvider([reply('', [call('list_memories', {})]), reply('', [call('forget', { id: 'm_f' })]), reply('已忘掉。')]);
    const r = await turn(p, '忘掉少用特写那条', store);
    expect(p.toolRequests[1]!.messages.at(-1)!.content).toContain('m_f');
    expect(store.file.memories).toEqual([]);
    expect(r.memory).toMatchObject([{ action: 'forgotten', memory: { id: 'm_f' } }]);
  });
});

describe('director preferences', () => {
  const sceneCall = (fp: FixtureProvider) => fp.calls.find((c) => c.schemaName === 'SceneDirection')!.input;
  it('the scene input is byte-identical with no preferences (null / undefined / only `other` kinds)', async () => {
    const sk = skeleton();
    const inputs: string[] = [];
    for (const preferences of [undefined, null, directorPreferences([mem({ id: 'o', text: '总结短一点', kind: 'other' })])]) {
      const fp = new FixtureProvider(FIXTURE_DIR);
      await runScene({ provider: fp, cache: null, catalog: cat, now: () => 5000, preferences }, { project: sk, sceneId: sk.scenes[0]!.id, scopes: ['scene'] }, 'g');
      inputs.push(sceneCall(fp));
    }
    expect(new Set(inputs).size).toBe(1);
    expect(inputs[0]).not.toContain('preferences');
  });
  it('style memories reach the scene input with the reasonableness note', async () => {
    const sk = skeleton();
    const fp = new FixtureProvider(FIXTURE_DIR);
    const preferences = directorPreferences([mem({ id: 'g', text: '少用特写' })]);
    await runScene({ provider: fp, cache: null, catalog: cat, now: () => 5000, preferences }, { project: sk, sceneId: sk.scenes[0]!.id, scopes: ['scene'] }, 'g');
    const input = sceneCall(fp);
    expect(input).toContain('"preferences"');
    expect(input).toContain('【全局】（镜头）少用特写');
    expect(input).toContain('以合理性为准');
  });
});

describe('/api/memories', () => {
  let tmp: string;
  let server: Server;
  let base: string;
  beforeAll(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'memr-'));
    const app = express();
    app.use(memoryRoutes(new MemoryStore(path.join(tmp, 'memories.json'))));
    await new Promise<void>((r) => { server = app.listen(0, '127.0.0.1', () => r()); });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await new Promise((r) => server.close(r));
    await fs.rm(tmp, { recursive: true, force: true });
  });
  const j = async (method: string, url: string, body?: unknown) => {
    const res = await fetch(`${base}${url}`, { method, headers: { 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: res.status, body: await res.json() as Record<string, any> }; // eslint-disable-line @typescript-eslint/no-explicit-any
  };
  it('lists per project, adds, patches, deletes, switches the system off', async () => {
    const g = await j('POST', '/api/memories', { text: '少用特写', scope: 'global', kind: 'camera' });
    const p = await j('POST', '/api/memories', { text: '这部节奏慢一点', scope: 'project', projectId: 'p_a', kind: 'pacing' });
    await j('POST', '/api/memories', { text: '别的', scope: 'project', projectId: 'p_b' });
    expect((await j('GET', '/api/memories?projectId=p_a')).body.memories.map((m: Memory) => m.text)).toEqual(['少用特写', '这部节奏慢一点']);
    expect((await j('PATCH', `/api/memories/${p.body.memory.id}`, { enabled: false })).body.memory.enabled).toBe(false);
    expect((await j('PATCH', '/api/memories/nope', { enabled: false })).status).toBe(404);
    expect((await j('POST', '/api/memories', { text: 'x', scope: 'project' })).status).toBe(400);
    expect((await j('DELETE', `/api/memories/${g.body.memory.id}`)).status).toBe(200);
    expect((await j('PUT', '/api/memories-enabled', { on: false })).body.enabled).toBe(false);
    expect((await j('GET', '/api/memories')).body).toMatchObject({ enabled: false });
    expect((await j('GET', '/api/memories')).body.memories).toHaveLength(2);
  });
});

describe('POST /api/agent/turn with the memory switch', () => {
  it('switched off: the request to the model is byte-identical to a server without memory', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'memt-'));
    const store = new MemoryStore(path.join(tmp, 'memories.json'));
    await store.add({ text: '少用特写', scope: 'global', kind: 'camera' });
    let scripted = new ScriptedProvider([]);
    const settings = new LlmSettings({ file: path.join(tmp, 's.json'), env: {}, fixtureProvider: () => scripted as unknown as FixtureProvider });
    const catalog = { get: async () => ({ ...cat, version: 'v-test' }) } as unknown as CatalogService;
    const serve = async (memory?: MemoryStore) => {
      const app = express();
      app.use(agentRoutes({ settings, cache: new LlmCache(path.join(tmp, 'cache')), catalog, ...(memory ? { memory } : {}) }));
      const s = await new Promise<Server>((r) => { const x = app.listen(0, '127.0.0.1', () => r(x)); });
      return { s, base: `http://127.0.0.1:${(s.address() as AddressInfo).port}` };
    };
    const ask = async (memory?: MemoryStore) => {
      scripted = new ScriptedProvider([reply('好的。')]);
      const { s, base } = await serve(memory);
      await (await fetch(`${base}/api/agent/turn`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ project: P, selection: { sceneId: 's_3' }, instruction: '你好' }) })).text();
      await new Promise((r) => s.close(r));
      return JSON.stringify(scripted.toolRequests[0]);
    };
    const plain = await ask();
    const on = await ask(store);
    await store.setEnabled(false);
    const off = await ask(store);
    expect(on).not.toBe(plain);
    expect(on).toContain('少用特写');
    expect(off).toBe(plain);
    await fs.rm(tmp, { recursive: true, force: true });
  });
});

describe('general preference safety net', () => {
  it('looksLikeGeneralPreference: general style statements yes, ordinary edits / withdrawals / questions no', () => {
    for (const t of ['对话中不要一直使用双人，参考原作适当插入单人看镜头', '一般不要连续用特写', '回忆段落参考原作加雾边', '特写少用一点', '别总用双人'])
      expect(looksLikeGeneralPreference(t), t).toBe(true);
    for (const t of ['这句用特写', '把第3句改成特写', '这场不要一直用双人', '这段都用双人', '选中的这句多用点推近', '以后别管双人单人的事了', '算了，那条不用了', '为什么总是用双人？', '', '把灯的表情改成开心'])
      expect(looksLikeGeneralPreference(t), t).toBe(false);
  });

  it('isDontCareMemory: only pure "don\'t care / go with the flow" texts', () => {
    for (const t of ['双人和单人顺其自然，不用管', '不用管双人单人的事', '镜头随意'])
      expect(isDontCareMemory(t), t).toBe(true);
    for (const t of ['对话中少用双人，适当插入单人', '回忆特效用雾边（memory edge=fog）', '少用特写，最多到 mcu'])
      expect(isDontCareMemory(t), t).toBe(false);
  });

  it('remember rejects a "go with the flow" text and points to forget', async () => {
    const store = new InMemoryMemories({ memories: [mem({ id: 'm_f', text: '少用双人' })] });
    const p = new ScriptedProvider([
      reply('', [call('remember', { text: '双人单人顺其自然，不用管', how: 'stated', kind: 'camera', replaces: 'm_f' })]),
      reply('', [call('forget', { id: 'm_f' })]),
      reply('已忘掉。'),
    ]);
    const r = await turn(p, '以后别管双人单人的事了', store);
    expect(p.toolRequests[1]!.messages.at(-1)!.content).toContain('forget');
    expect(store.file.memories).toEqual([]);
    expect(r.memory).toMatchObject([{ action: 'forgotten' }]);
  });

  it('a general preference: a write before remember is refused once, then remember saves and nothing is edited', async () => {
    const store = new InMemoryMemories();
    const p = new ScriptedProvider([
      reply('', [call('shot_set', { beatId: b(2).id, type: 'cu', reason: 'x' })]),
      reply('', [call('remember', { text: '对话中少用双人，参考原作适当插入单人镜头', how: 'stated', kind: 'camera' })]),
      reply('记住了。要不要按偏好检查本场？'),
    ]);
    const r = await turn(p, '对话中不要一直使用双人，参考原作适当插入单人看镜头', store);
    expect(p.toolRequests[1]!.messages.at(-1)!.content).toContain('remember');
    expect(r.applied).toEqual([]);
    expect(store.file.memories).toHaveLength(1);
  });

  it('a general preference: ask_user before remember is refused once (no need to ask where)', async () => {
    const store = new InMemoryMemories();
    const p = new ScriptedProvider([
      reply('', [call('ask_user', { question: '指哪一段？' })]),
      reply('', [call('remember', { text: '回忆段落参考原作加雾边', how: 'stated', kind: 'fx' })]),
      reply('记住了。'),
    ]);
    const r = await turn(p, '回忆段落参考原作加雾边', store);
    expect(r.question).toBeNull();
    expect(store.file.memories).toHaveLength(1);
  });

  it('a general preference with no tool calls is nudged once to remember; an ordinary edit is not', async () => {
    const store = new InMemoryMemories();
    const p = new ScriptedProvider([
      reply('好的。'),
      reply('', [call('remember', { text: '一般不要连续用特写', how: 'stated', kind: 'camera' })]),
      reply('记住了。'),
    ]);
    await turn(p, '一般不要连续用特写', store);
    expect(store.file.memories).toHaveLength(1);
    const q = new ScriptedProvider([reply('好的。')]);
    await turn(q, '这句用特写', new InMemoryMemories());
    expect(q.toolRequests).toHaveLength(1);
  });

  it('the review instruction is preference-neutral (no "emotional peak is exempt")', () => {
    const t = memoryReviewInstruction(2);
    expect(t).not.toContain('按偏好改反而不合理（例如情绪顶点那一句）');
    expect(t).toContain('情绪顶点');
    expect(t).toContain('不要为了满足偏好把所有句子都改掉');
  });
});
