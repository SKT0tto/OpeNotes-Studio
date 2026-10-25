import { beforeAll, describe, expect, it } from 'vitest';
import { runAgentTurn, toolSpecs } from '../../server/agent/loop';
import { AGENT_SYSTEM } from '../../server/agent/prompt';
import { loadSandbox, runInSandbox } from '../../server/agent/sandbox';
import { liveDecision } from '../../shared/agent/live';
import { MAX_SCRIPT_FAILURES } from '../../shared/agent/script';
import { planReplay } from '../../shared/agent/replay';
import { clone } from '../../shared/project/mutate';
import { useProject } from '../../web/store/projectStore';
import { call, makeEnv, sceneOf } from './helpers/agentEnv';
import { cat, directedProject } from './helpers/directorFlow';
import { ScriptedProvider, call as toolCall, reply } from './helpers/scriptedProvider';

const P = directedProject();
type Ans = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

beforeAll(async () => { expect(await loadSandbox()).toBe(true); });
const scriptEnv = (project = P) => { const env = makeEnv(project); env.scriptRunner = runInSandbox; return env; };
const run = (env: ReturnType<typeof scriptEnv>, code: string, description = '测试脚本') => call(env, 'run_script', { code, description }) as Ans;

describe('run_script', () => {
  it('runs a script on the snapshot; its ops become ONE group on the card, with the script attached to the first record', () => {
    const env = scriptEnv();
    const r = run(env, `
      // every third dialogue line of scene 3 gets a closer shot
      const ops = [];
      beats(3).filter(b => b.kind === 'dialogue').forEach((b, i) => { if (i % 3 === 0) ops.push(op.setShot(b.beatId, { type: 'cu' }, '每三句拉近')); });
      console.log('ops', ops.length);
      return ops;`, '每隔三句对白拉近');
    const dialogue = sceneOf(env).beats.filter((b) => b.kind === 'dialogue');
    const expected = dialogue.filter((_, i) => i % 3 === 0);
    expect(r.已放入变更集.改动数).toBeLessThanOrEqual(expected.length);
    expect(r.脚本输出).toEqual([`ops ${expected.length}`]);
    expect(env.applied.length).toBeGreaterThan(0);
    for (const rec of env.applied) {
      expect(rec.tool).toBe('run_script');
      expect(rec.group).toMatchObject({ kind: 'script', label: '每隔三句对白拉近' });
    }
    expect(new Set(env.applied.map((x) => x.group!.id)).size).toBe(1);
    expect(env.applied[0]!.group!.script).toContain('i % 3 === 0');
    expect(env.applied.slice(1).every((x) => x.group!.script === undefined)).toBe(true); // the text is stored once, not per record
    expect(env.applied[0]!.op.reason).toBe('每三句拉近');
  });

  it('can insert beats and refer to them in later ops (placeholders become real, unique ids); the reaction shot reads the compiled presence', () => {
    const env = scriptEnv();
    const s0 = sceneOf(env).beats.length;
    const r = run(env, `
      const ops = [];
      const rows = beats(3).filter(b => b.kind === 'dialogue').slice(0, 2);
      rows.forEach(b => {
        const ins = op.insertBeat(b.beatId, { kind: 'silent', text: '', emotion: 'thinking' }, null, '反应镜头');
        ops.push(ins);
        const watcher = visible(b.beatId).filter(c => c !== b.speakerId)[0];
        ops.push(op.setShot(ins.newId, { type: 'cu', focus: [watcher] }));
      });
      return ops;`, '对白后插反应镜头');
    expect(r.错误, JSON.stringify(r)).toBeUndefined();
    expect(sceneOf(env).beats.length).toBe(s0 + 2);
    const ids = sceneOf(env).beats.map((b) => b.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id) => !id.startsWith('$'))).toBe(true);
    const inserted = sceneOf(env).beats.filter((b) => b.kind === 'silent' && b.shot.type === 'cu' && b.emotion === 'thinking' && b.shot.focus.length === 1);
    expect(inserted.length).toBeGreaterThanOrEqual(2);
  });

  it('every returned op goes through the normal check: an invalid op rejects the whole script, nothing is applied, and the model is told what is wrong', () => {
    const env = scriptEnv();
    const before = JSON.stringify(env.sandbox);
    const bad1 = run(env, 'return [op.setShot("s_3b_15", {type: "cu"}), op.setShot("s_3b_16", {type: "bogus"})]');
    expect(bad1.错误[0]).toContain('第 2 个 op');
    expect(bad1.错误[0]).toContain('景别只能取');
    expect(bad1.剩余重试次数).toBe(MAX_SCRIPT_FAILURES - 1);
    expect(bad1.说明).toContain('没有产生任何改动');
    const bad2 = run(env, 'return [{op: "no_such_op"}, 42]');
    expect(bad2.错误.join()).toContain('不是合法的 op');
    expect(bad2.剩余重试次数).toBe(MAX_SCRIPT_FAILURES - 2);
    const bad3 = run(env, 'return [op.raw({op: "shot_set", sceneId: "s_3", beatId: "ghost", set: {type: "cu"}})]');
    expect(bad3.错误[0]).toContain('ghost');
    expect(JSON.stringify(env.sandbox)).toBe(before);
    expect(env.applied).toHaveLength(0);
  });

  it('script mistakes come back as results (syntax, thrown, no return, empty, timeout); after the retry cap the tool refuses', () => {
    const env = scriptEnv();
    expect(run(env, 'let = ;').错误[0]).toContain('脚本出错');
    expect(run(env, 'throw new Error("x")').错误[0]).toContain('x');
    expect(run(env, 'return []').错误[0]).toContain('空数组');
    expect(env.scriptFailures).toBe(3);
    const refused = run(env, 'return [op.setShot("s_3b_15", {type: "cu"})]');
    expect(refused.错误[0]).toContain('不再重试');
    expect(env.applied).toHaveLength(0);

    const env2 = scriptEnv();
    const t = run(env2, 'while (true) {}');
    expect(t.错误[0]).toContain('超时');
    expect(t.剩余重试次数).toBe(2);
    // a fixed script after a failure works (a retry)
    expect(run(env2, 'return [op.setShot("s_3b_15", {type: "cu"})]').已放入变更集).toBeDefined();

    // a run that only looks at the data (console.log, empty result) does not use up a retry; a wrong query() argument says what it wants
    const env3 = scriptEnv();
    const look = run(env3, 'console.log(beats(3).length); return []');
    expect(look.结果).toContain('不计入失败次数');
    expect(look.脚本输出).toEqual([String(P.scenes[2]!.beats.length)]);
    expect(env3.scriptFailures ?? 0).toBe(0);
    expect(run(env3, 'return query("灯")').错误[0]).toContain('需要一个条件对象');
  });

  it('too many ops, or no sandbox at all, are reported', () => {
    const env = scriptEnv();
    expect(run(env, 'return Array.from({length: 450}, () => op.setShot("s_3b_15", {type: "cu"}))').错误[0]).toContain('上限');
    const bare = makeEnv();
    expect((call(bare, 'run_script', { code: 'return []', description: 'x' }) as Ans).错误[0]).toContain('没有脚本沙箱');
  });

  it('locked and hand-made beats go to 「需要你确认」 inside the group instead of being skipped', () => {
    const p = clone(P);
    const s = p.scenes[2]!;
    s.beats[14]!.shot.meta.locked = true;
    s.beats[15]!.shot.meta.source = 'user';
    const env = scriptEnv(p);
    const r = run(env, `return [14, 15, 16].map(i => op.setShot(beats(3)[i].beatId, { type: 'cu' }))`, '三句拉近');
    expect(r.待用户确认.数量).toBe(2);
    expect(env.pending.map((x) => x.status).sort()).toEqual(['needs_confirm', 'needs_unlock']);
    expect(env.pending.every((x) => x.group?.label === '三句拉近')).toBe(true);
    expect(sceneOf(env).beats[14]!.shot.type).toBe(p.scenes[2]!.beats[14]!.shot.type);
  });

  it('a script cannot confirm hand-made content or take locked keys itself, and cannot reuse a beat id of another scene', () => {
    const p = clone(P);
    const s = p.scenes[2]!;
    s.beats[1]!.shot.meta.source = 'user';
    const env = scriptEnv(p);
    const r = run(env, `return [op.raw({ op: 'shot_set', sceneId: 's_3', beatId: '${s.beats[1]!.id}', set: { type: 'ecu' }, overrideUser: true })]`, '强行覆盖');
    expect(r.待用户确认.数量).toBe(1);
    expect(env.pending[0]!.status).toBe('needs_confirm');
    expect((env.pending[0]!.op as { overrideUser?: boolean }).overrideUser).toBeUndefined();
    const other = p.scenes[0]!.beats[0]!.id;
    const env2 = scriptEnv(p);
    const r2 = run(env2, `const a = op.raw({ op: 'beat_insert', sceneId: 's_3', afterBeatId: '${s.beats[0]!.id}', newId: '${other}', beat: { kind: 'narration', text: '$new1 不是 id' } });
      return [a, op.raw({ op: 'shot_set', sceneId: 's_3', beatId: a.newId, set: { type: 'group' } })]`, '插入一句');
    expect(r2.错误, JSON.stringify(r2)).toBeUndefined();
    const ids = env2.sandbox.scenes.flatMap((x) => x.beats.map((b) => b.id));
    expect(new Set(ids).size).toBe(ids.length); // the host gave the new beat a fresh id
    const added = sceneOf(env2).beats[1]!;
    expect(added.id).not.toBe(other);
    expect(added.text).toBe('$new1 不是 id'); // ids are substituted in id fields only, never in text
    expect(added.shot.type).toBe('group'); // the later op followed the new beat, not the other scene's beat
    expect(env2.sandbox.scenes[0]!.beats[0]!.shot.type).toBe(p.scenes[0]!.beats[0]!.shot.type);
  });

  it('the group is one undo step when the card is applied', () => {
    const env = scriptEnv();
    run(env, `return beats(3).filter(b => b.shotType === 'cu').map(b => op.setShot(b.beatId, { type: 'mcu' }))`, '特写改胸像');
    expect(env.applied.length).toBeGreaterThan(5);
    const items = env.applied.map((r) => ({ id: r.id, op: r.op }));
    expect(planReplay(P, items, { genId: 'agent_t', now: 5000 }).accepted).toHaveLength(items.length);
    const st = useProject.getState();
    st.open(clone(P), null);
    expect(st.applyAgentOps(items, 'AI 助手：特写改胸像', 'agent_t').applied).toBe(items.length);
    expect(useProject.getState().undoLabel).toBe('AI 助手：特写改胸像');
    useProject.getState().undo();
    expect(JSON.stringify(useProject.getState().project)).toBe(JSON.stringify(P));
    expect(useProject.getState().canUndo).toBe(false);
  });

  it('a script is never applied by the 「实时」 auto mode, however small', () => {
    const env = scriptEnv();
    run(env, 'return [op.setShot("s_3b_15", {type: "cu"})]');
    expect(env.applied).toHaveLength(1);
    const d = liveDecision({ sceneId: 's_3', applied: env.applied, pending: 0, question: false, unverified: 0, stopped: 'done' });
    expect(d.auto).toBe(false);
    expect(d.reasons.join()).toContain('脚本');
    const env2 = makeEnv();
    call(env2, 'batch_edit', { target: { beatIds: ['s_3b_15'] }, tool: 'set_shot', args: { type: 'cu' } });
    expect(liveDecision({ sceneId: 's_3', applied: env2.applied, pending: 0, question: false, unverified: 0, stopped: 'done' }).auto).toBe(true); // a small batch is like any small edit
  });

  it('the query() helper inside the script means the same as query_beats', () => {
    const env = scriptEnv();
    const direct = (call(env, 'query_beats', { filter: { scenes: [3], speaker: '高松灯', shotType: 'cu' } }) as string).split('\n')[1]!.replace(/^beatIds[^：]*：/, '').split(',');
    const r = run(env, `
      const rows = query({ scenes: [3], speaker: '高松灯', shotType: 'cu' });
      console.log(rows.map(r => r.beatId).join(','));
      return rows.map(r => op.setEmotion(r.beatId, 'sad'));`);
    expect(r.脚本输出[0].split(',')).toEqual(direct);
    expect(run(env, 'return query({ bogus: 1 })').错误[0]).toContain('query 过滤条件有误');
  });
});

describe('the agent loop offers and uses the new tools', () => {
  it('tool specs include query_beats, batch_edit and run_script (run_script only with a sandbox), and the prompt explains when to use them', () => {
    const names = toolSpecs().map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(['query_beats', 'batch_edit', 'run_script']));
    expect(toolSpecs({ frames: false, revert: false, script: false }).map((t) => t.name)).not.toContain('run_script');
    // the JSON schema the model sees for the filter is not recursive
    expect(JSON.stringify(toolSpecs().find((t) => t.name === 'query_beats')!.parameters)).not.toContain('$ref');
    // ... and compact (the nested form spelled out in full would be ~150 KB per tool)
    for (const n of ['query_beats', 'batch_edit']) expect(JSON.stringify(toolSpecs().find((t) => t.name === n)!.parameters).length).toBeLessThan(9000);
    expect(Object.keys((toolSpecs().find((t) => t.name === 'query_beats')!.parameters as { properties: { filter: { properties: object } } }).properties.filter.properties)).toEqual(expect.arrayContaining(['speaker', 'shotType', 'visible', 'and', 'or', 'not']));
    expect(AGENT_SYSTEM).toContain('query_beats');
    expect(AGENT_SYSTEM).toContain('batch_edit');
    expect(AGENT_SYSTEM).toContain('run_script');
    expect(AGENT_SYSTEM).toMatch(/所有 \/ 每个 \/ 整部 \/ 凡是/);
    expect(AGENT_SYSTEM).toContain('每隔三句插一个反应镜头');
  });

  it('query -> batch_edit through the loop is one group on the proposal; a script that fails is fixed and retried', async () => {
    const dir = directedProject();
    const S = dir.scenes[2]!;
    const p = new ScriptedProvider([
      reply('先查', [toolCall('query_beats', { filter: { scenes: [3], shotType: 'cu' }, limit: 3 })]),
      reply('批量', [toolCall('batch_edit', { target: { queryId: 'q1' }, tool: 'set_shot', args: { type: 'mcu' }, reason: '特写太多' })]),
      reply('再查一遍确认', [toolCall('query_beats', { filter: { scenes: [3], shotType: 'cu' } })]),
      reply('把第三场的特写改成了胸像。'),
    ]);
    const r = await runAgentTurn({ provider: p, catalog: cat, director: { provider: p, cache: null, catalog: cat, now: () => 5000 }, now: () => 5000, genId: 'agent_t' },
      { project: dir, selection: { sceneId: 's_3' }, instruction: '第三场所有特写都改成胸像' });
    const cu = S.beats.filter((b) => b.shot.type === 'cu').length;
    expect(r.applied).toHaveLength(cu);
    expect(new Set(r.applied.map((x) => x.group?.id)).size).toBe(1);
    expect(r.applied[0]!.group!.label).toBe(`把 ${cu} 句的景别改成 mcu`);
    expect(r.stopped).toBe('done');
    expect(r.unverified).toEqual([]);
    expect(p.toolRequests[0]!.tools.map((t) => t.name)).toEqual(expect.arrayContaining(['run_script', 'query_beats', 'batch_edit']));
    // the read-back after the batch counted as verification (no extra "please read back" nudge)
    expect(p.toolRequests).toHaveLength(4);

    const p2 = new ScriptedProvider([
      reply('写脚本', [toolCall('run_script', { code: 'return beats(3).map(b => op.setShot(b.beatId, { type: "nonsense" }))', description: '全部改成 nonsense' })]),
      reply('改正', [toolCall('run_script', { code: 'return beats(3).filter(b => b.kind === "dialogue").map(b => op.setTiming([b.beatId], { lineGap: 0.9 }))', description: '对白后停顿 0.9 秒' })]),
      reply('回读', [toolCall('query_beats', { filter: { scenes: [3], lineGapMin: 0.9 } })]),
      reply('给对白句后加了 0.9 秒停顿。'),
    ]);
    const r2 = await runAgentTurn({ provider: p2, catalog: cat, director: { provider: p2, cache: null, catalog: cat, now: () => 5000 }, now: () => 5000, genId: 'agent_t' },
      { project: dir, selection: { sceneId: 's_3' }, instruction: '按台词字数重新分配停顿' });
    expect(p2.toolRequests[1]!.messages.filter((m) => m.role === 'tool').at(-1)!.content).toContain('景别只能取');
    expect(r2.applied.length).toBeGreaterThan(0);
    expect(r2.applied.every((x) => x.group?.kind === 'script' && x.op.op === 'timing')).toBe(true);
    expect(r2.applied[0]!.group!.script).toContain('lineGap: 0.9');
    expect(r2.stats.writeCalls).toBe(2);
    expect(r2.stats.writeFirstTryOk).toBe(1);
  });
});
