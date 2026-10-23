import { describe, expect, it } from 'vitest';
import { runAgentTurn, toolSpecs, type AgentEvent } from '../../server/agent/loop';
import { FixtureProvider } from '../../server/llm/fixtureProvider';
import { runScene, runScenes } from '../../server/llm/sceneRunner';
import { clone } from '../../shared/project/mutate';
import { FIXTURE_DIR } from './helpers/directorCatalog';
import { cat, directedProject, skeleton } from './helpers/directorFlow';
import { ScriptedProvider, badRequest, call, reply } from './helpers/scriptedProvider';

const P = directedProject();
const S = P.scenes[2]!;
const b = (i: number) => S.beats[i]!;
const director = (provider: ScriptedProvider | FixtureProvider) => ({ provider, cache: null, catalog: cat, now: () => 5000 });
const turn = (provider: ScriptedProvider, instruction: string, over: { project?: typeof P; selection?: { sceneId?: string; beatId?: string }; limits?: { maxSteps?: number }; emit?: (e: AgentEvent) => void } = {}) =>
  runAgentTurn({ provider, catalog: cat, director: director(provider), now: () => 5000, genId: 'agent_t', ...(over.emit ? { emit: over.emit } : {}) },
    { project: over.project ?? P, selection: over.selection ?? { sceneId: 's_3', beatId: b(2).id }, instruction, ...(over.limits ? { limits: over.limits } : {}) });

describe('agent loop with function calling (mock provider)', () => {
  it('reads, writes through tools, verifies by reading back, and summarises; the project itself is not touched', async () => {
    const p = new ScriptedProvider([
      reply('先看看这一句', [call('get_beat', { beatId: b(2).id })]),
      reply('推近一档', [call('set_shot', { beatIds: [b(2).id], adjust: 'tighter', reason: '情绪升高' })]),
      reply('回读确认', [call('get_beat', { beatId: b(2).id })]),
      reply('把第3句的镜头推近了一档（mcu→cu）。'),
    ]);
    const events: AgentEvent[] = [];
    const before = JSON.stringify(P);
    const r = await turn(p, '这里镜头推近一点', { emit: (e) => events.push(e) });
    expect(r.stopped).toBe('done');
    expect(r.mode).toBe('tools');
    expect(r.applied).toHaveLength(1);
    expect(r.applied[0]!.op).toMatchObject({ op: 'shot_set', beatId: b(2).id, set: { type: 'cu' } });
    expect(r.applied[0]!.changes[0]).toMatchObject({ after: expect.stringContaining('近景') as string });
    expect(r.summary).toContain('推近');
    expect(r.unverified).toEqual([]);
    expect(r.usage.inputTokens).toBe(4000);
    expect(r.stats).toMatchObject({ writeCalls: 1, writeFirstTryOk: 1, badArgs: 0 });
    expect(events.filter((e) => e.type === 'op')).toHaveLength(1);
    expect(events.some((e) => e.type === 'tool' && e.name === 'set_shot')).toBe(true);
    expect(JSON.stringify(P)).toBe(before);
    expect(p.toolRequests[0]!.tools.map((t) => t.name)).toEqual(expect.arrayContaining(['set_shot', 'get_beat', 'regenerate_scene_camera']));
    expect(p.toolRequests[0]!.messages[0]!.role).toBe('system');
    expect(p.toolRequests[1]!.messages.at(-1)).toMatchObject({ role: 'tool' });
  });

  it('feeds invalid ids back to the model, which corrects itself; first-try validity is counted', async () => {
    const p = new ScriptedProvider([
      reply('', [call('set_shot', { beatIds: ['s_3b_999'], type: 'cu' })]),
      reply('', [call('set_shot', { beatIds: [b(2).id], type: 'ms' })]),
      reply('', [call('set_shot', { beatIds: [b(2).id], type: 'cu', reason: 'r' })]),
      reply('', [call('get_beat', { beatId: b(2).id })]),
      reply('已改成近景。'),
    ]);
    const r = await turn(p, '改成近景');
    expect(r.applied).toHaveLength(1);
    expect(r.stats.writeCalls).toBe(3);
    expect(r.stats.writeFirstTryOk).toBe(1);
    expect(p.toolRequests[1]!.messages.filter((m) => m.role === 'tool').map((m) => m.content).join('\n')).toContain('s_3b_999');
    expect(p.toolRequests[2]!.messages.filter((m) => m.role === 'tool').at(-1)!.content).toContain('景别只能取');
  });

  it('makes the model verify: stopping right after a write triggers a read-back request', async () => {
    const p = new ScriptedProvider([
      reply('', [call('set_timing', { beatIds: [b(2).id], pace: 'slower', reason: 'r' })]),
      reply('好了。'),
      reply('', [call('get_beat', { beatId: b(2).id })]),
      reply('这句节奏放慢了。'),
    ]);
    const r = await turn(p, '这句放慢');
    expect(r.summary).toBe('这句节奏放慢了。');
    expect(p.toolRequests[1]!.messages.at(-1)).toMatchObject({ role: 'tool' });
    expect(p.toolRequests[2]!.messages.at(-1)).toMatchObject({ role: 'user', content: expect.stringContaining('回读') as string });
  });

  it('locked content ends as pending (needs the user); nothing is applied, and the model is told', async () => {
    const locked = clone(P);
    locked.scenes[2]!.beats[2]!.shot.meta.locked = true;
    const p = new ScriptedProvider([
      reply('', [call('set_shot', { beatIds: [b(2).id], type: 'cu', reason: 'r' })]),
      reply('这一句的镜头被锁定了，需要你确认解锁后才能改。'),
    ]);
    const r = await turn(p, '把它改成特写', { project: locked });
    expect(r.applied).toHaveLength(0);
    expect(r.pending).toHaveLength(1);
    expect(r.pending[0]!.status).toBe('needs_unlock');
    expect(p.toolRequests[1]!.messages.at(-1)!.content).toContain('待用户确认');
  });

  it('a hand-made unit the user named is overwritten only with overwriteManual, and then applies', async () => {
    const hand = clone(P);
    hand.scenes[2]!.beats[2]!.shot.meta.source = 'user';
    const p = new ScriptedProvider([
      reply('', [call('set_shot', { beatIds: [b(2).id], type: 'two_shot', overwriteManual: true, reason: '用户点名' })]),
      reply('', [call('get_beat', { beatId: b(2).id })]),
      reply('已按你的要求改成双人。'),
    ]);
    const r = await turn(p, '这句我手改过，帮我换成双人', { project: hand });
    expect(r.pending).toHaveLength(0);
    expect(r.applied[0]!.op).toMatchObject({ overrideUser: true });
  });

  it('ask_user ends the turn with a clarifying question and no guess', async () => {
    const p = new ScriptedProvider([reply('', [call('find_beats', { speaker: '灯' }), call('ask_user', { question: '灯有好几句，是哪一句？', options: ['第8句', '第9句'] })])]);
    const events: AgentEvent[] = [];
    const r = await turn(p, '灯那句加个回忆', { emit: (e) => events.push(e) });
    expect(r.stopped).toBe('ask');
    expect(r.question).toEqual({ question: '灯有好几句，是哪一句？', options: ['第8句', '第9句'] });
    expect(r.applied).toHaveLength(0);
    expect(events.some((e) => e.type === 'ask')).toBe(true);
  });

  it('a model that only talks about a change is pushed once to use tools, and a claim without ops is reported', async () => {
    const p = new ScriptedProvider([reply('我会把这一句的镜头推近。'), reply('我已经把镜头推近了。')]);
    const r = await turn(p, '推近');
    expect(p.toolRequests).toHaveLength(2);
    expect(r.applied).toHaveLength(0);
    expect(r.claimedWithoutOps).toContain('推近');
  });

  it('an impossible request makes no ops and claims nothing', async () => {
    const p = new ScriptedProvider([reply('动作列表里没有飞起来这种动作，做不到。你可以试试跳跃一类的动作。')]);
    const r = await turn(p, '让爱音飞起来');
    expect(r.applied).toHaveLength(0);
    expect(r.pending).toHaveLength(0);
    expect(r.claimedWithoutOps).toBeNull();
  });

  it('has only a safety ceiling on steps, no token cap', async () => {
    const p = new ScriptedProvider(Array.from({ length: 10 }, () => reply('', [call('get_scene', {})])));
    const r = await turn(p, '随便', { limits: { maxSteps: 3 } });
    expect(r.stopped).toBe('steps');
    expect(r.steps).toBe(3);
    expect(Math.min(...p.toolRequests.map((q) => q.maxTokens))).toBeGreaterThanOrEqual(8000);
  });

  it('a tool call with broken JSON arguments is reported to the model, not thrown', async () => {
    const p = new ScriptedProvider([reply('', [{ id: 'x', name: 'set_shot', arguments: '{"beatIds": [' }]), reply('参数有问题，没有改。')]);
    const r = await turn(p, 'x');
    expect(r.stats.badArgs).toBe(1);
    expect(p.toolRequests[1]!.messages.at(-1)!.content).toContain('不是合法的 JSON');
  });

  it('the tool specs carry no coordinate fields', () => {
    const text = JSON.stringify(toolSpecs());
    for (const bad of ['"x"', '"zoom"', 'worldX', 'pixel']) expect(text).not.toContain(bad);
  });
});

describe('JSON action protocol (endpoints without function calling)', () => {
  it('is used when the endpoint refuses tools on the first request, and the refusal is remembered', async () => {
    const p = new ScriptedProvider([badRequest()], [
      { say: '推近', calls: [{ name: 'set_shot', args: { beatIds: [b(2).id], adjust: 'tighter', reason: 'r' } }], done: false },
      { say: '回读', calls: [{ name: 'get_beat', args: { beatId: b(2).id } }], done: false },
      { say: '镜头推近了一档。', calls: [], done: true },
    ]);
    const r = await turn(p, '推近一点');
    expect(r.mode).toBe('json');
    expect(p.unsupportedNoted).toBe(1);
    expect(p.toolsSupported()).toBe(false);
    expect(r.applied).toHaveLength(1);
    expect(r.summary).toBe('镜头推近了一档。');
    expect(p.structuredRequests[0]!.system).toContain('JSON 动作协议');
    expect(JSON.stringify(p.structuredRequests[1]!.input)).toContain('工具结果 set_shot');
    const p2 = new ScriptedProvider([], [{ say: '无需修改。', calls: [], done: true }]);
    p2.noteToolsUnsupported();
    const r2 = await turn(p2, '随便看看');
    expect(r2.mode).toBe('json');
    expect(p2.toolRequests).toHaveLength(0);
  });

  it('works for a provider that has no chatTools at all', async () => {
    const p = new ScriptedProvider([], [{ say: '完成', calls: [], done: true }], false);
    const r = await turn(p, 'x');
    expect(r.mode).toBe('json');
    expect(r.summary).toBe('完成');
  });
});

describe('regenerate_scene_camera reuses the camera scope of runScene', () => {
  it('turns the new shots into shot ops, sends the guidance to the model, and allows one call per turn', async () => {
    const fp = new FixtureProvider(FIXTURE_DIR);
    const dd = { provider: fp, cache: null, catalog: cat, now: () => 5000 };
    const sk = skeleton();
    const items = await runScenes(dd, sk, sk.scenes.map((s) => s.id), ['scene'], 'g', 2);
    sk.scenes = sk.scenes.map((s) => items.find((i) => i.sceneId === s.id)!.result!.scene);
    const sid = sk.scenes[1]!.id;
    for (const bt of sk.scenes[1]!.beats) { bt.shot.type = 'group'; bt.shot.focus = []; }
    const brain = new ScriptedProvider([
      reply('', [call('regenerate_scene_camera', { sceneId: sid, guidance: '多用双人镜头，少用特写' })]),
      reply('', [call('get_scene', { sceneId: sid })]),
      reply('已按你的倾向重新设计了镜头。'),
    ]);
    const r = await runAgentTurn({ provider: brain, catalog: cat, director: dd, now: () => 5000, genId: 'agent_t' }, { project: sk, selection: { sceneId: sid }, instruction: '第二场多用双人，少点特写' });
    expect(r.applied.length).toBeGreaterThan(0);
    expect(r.applied.every((x) => x.op.op === 'shot_set' || x.op.op === 'beat_set')).toBe(true);
    expect(r.applied.every((x) => x.tool === 'regenerate_scene_camera')).toBe(true);
    // only beats whose framing changes (every beat was a focus-less group): no intent / flow re-rolls on unchanged framing
    expect(r.applied.every((x) => x.op.op !== 'shot_set' || x.op.set.type !== 'group' || (x.op.set.focus?.length ?? 0) > 0)).toBe(true);
    const lastScene = fp.calls.filter((c) => c.schemaName === 'SceneDirection').at(-1)!;
    expect(lastScene.input).toContain('多用双人镜头，少用特写');
    expect(lastScene.input).toContain('"scopes":["camera"]');
    const again = new ScriptedProvider([
      reply('', [call('regenerate_scene_camera', { sceneId: sid, guidance: 'a' })]),
      reply('', [call('regenerate_scene_camera', { sceneId: sid, guidance: 'b' })]),
      reply('', [call('get_scene', {})]),
      reply('完成'),
    ]);
    await runAgentTurn({ provider: again, catalog: cat, director: { ...dd, provider: new FixtureProvider(FIXTURE_DIR) }, now: () => 5000 }, { project: sk, selection: { sceneId: sid }, instruction: 'x' });
    expect(again.toolRequests[2]!.messages.filter((m) => m.role === 'tool')[1]!.content).toContain('本轮已经重导过一次');
  });

  it('the scene prompt input is byte-identical when no guidance is used (classic cache keys stay)', async () => {
    const fp1 = new FixtureProvider(FIXTURE_DIR);
    const fp2 = new FixtureProvider(FIXTURE_DIR);
    const sk = skeleton();
    await runScene({ provider: fp1, cache: null, catalog: cat, now: () => 5000 }, { project: sk, sceneId: sk.scenes[0]!.id, scopes: ['scene'] }, 'g');
    await runScene({ provider: fp2, cache: null, catalog: cat, now: () => 5000 }, { project: sk, sceneId: sk.scenes[0]!.id, scopes: ['scene'], guidance: undefined }, 'g');
    expect(fp1.calls[0]!.input).toBe(fp2.calls[0]!.input);
    expect(fp1.calls[0]!.input).not.toContain('guidance');
  });
});
