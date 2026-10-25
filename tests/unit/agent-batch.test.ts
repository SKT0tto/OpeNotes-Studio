import { describe, expect, it } from 'vitest';
import { agentHistory } from '../../shared/agent/history';
import { planReplay } from '../../shared/agent/replay';
import { clone } from '../../shared/project/mutate';
import { useProject } from '../../web/store/projectStore';
import { call, makeEnv, sceneOf } from './helpers/agentEnv';
import { directedProject } from './helpers/directorFlow';

const P = directedProject();
const cuIds = P.scenes[2]!.beats.filter((b) => b.shot.type === 'cu').map((b) => b.id);
type Ans = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

describe('batch_edit', () => {
  it('applies one template to every beat a query matched, as ONE labelled group; the table cut does not limit the batch', () => {
    const env = makeEnv();
    const q = call(env, 'query_beats', { filter: { scenes: [3], shotType: 'cu' }, limit: 3 }) as string;
    expect(q).toContain(`命中 ${cuIds.length} 句`);
    expect(cuIds.length).toBeGreaterThan(5);
    const r = call(env, 'batch_edit', { target: { queryId: 'q1' }, tool: 'set_shot', args: { type: 'mcu' }, reason: '特写太多' }) as Ans;
    expect(r.已放入变更集.涉及句数).toBe(cuIds.length);
    expect(env.applied).toHaveLength(cuIds.length);
    for (const id of cuIds) expect(sceneOf(env).beats.find((b) => b.id === id)!.shot.type).toBe('mcu');
    const groups = new Set(env.applied.map((x) => x.group?.id));
    expect(groups.size).toBe(1);
    expect(env.applied[0]!.group).toMatchObject({ kind: 'batch', label: `把 ${cuIds.length} 句的景别改成 mcu` });
    expect(env.applied.every((x) => x.op.op === 'shot_set' && x.op.reason === '特写太多')).toBe(true);
    expect(env.stats.writeCalls).toBe(1);
  });

  it('works from a filter or an explicit id list, and refuses a wrong template once (nothing applied)', () => {
    const env = makeEnv();
    const a = call(env, 'batch_edit', { target: { filter: { scenes: [3], speaker: '高松灯' } }, tool: 'edit_beat', args: { emotion: 'sad' } }) as Ans;
    const tomori = sceneOf(env).beats.filter((b) => b.speakerId === 'c_001');
    expect(a.命中).toBe(`${tomori.length} 句`);
    expect(tomori.every((b) => b.emotion === 'sad')).toBe(true);
    expect(env.applied[0]!.group!.label).toMatch(/^把 \d+ 句的情绪改成 sad$/);

    const b = call(env, 'batch_edit', { target: { beatIds: [sceneOf(env).beats[0]!.id, sceneOf(env).beats[1]!.id] }, tool: 'set_shot', args: { type: 'group' } }) as Ans;
    expect(b.已放入变更集.涉及句数).toBeLessThanOrEqual(2);

    const n = env.applied.length;
    const bad = call(env, 'batch_edit', { target: { filter: { scenes: [3] } }, tool: 'set_shot', args: { type: 'nonsense' } }) as Ans;
    expect(bad.错误[0]).toContain('景别只能取');
    expect(bad.说明).toContain('没有开始');
    expect(env.applied).toHaveLength(n);
    expect((call(env, 'batch_edit', { target: { filter: { scenes: [3] }, queryId: 'q1' }, tool: 'set_shot', args: { type: 'cu' } }) as Ans).错误[0]).toContain('只能给一个');
    expect((call(env, 'batch_edit', { target: { queryId: 'q9' }, tool: 'set_shot', args: { type: 'cu' } }) as Ans).错误[0]).toContain('没有 queryId');
    expect((call(env, 'batch_edit', { target: { filter: { speaker: '路人甲' } }, tool: 'set_shot', args: { type: 'cu' } }) as Ans).错误.join()).toContain('找不到角色');
    expect((call(env, 'batch_edit', { target: { filter: { scenes: [3] } }, tool: 'set_shot', args: { beatIds: ['x'], type: 'cu' } }) as Ans).错误[0]).toContain('不要写 beatIds');
    expect((call(env, 'batch_edit', { target: { filter: { scenes: [3], speaker: 'none', kind: 'pause' } }, tool: 'set_shot', args: { type: 'cu' } }) as Ans).结果).toContain('没有命中');
  });

  it('locked and hand-made beats become 「需要你确认」 entries of the same group, never a silent skip; the others still change', () => {
    const p = clone(P);
    const s = p.scenes[2]!;
    const lockedId = s.beats.find((b) => b.shot.type === 'cu')!.id;
    s.beats.find((b) => b.id === lockedId)!.shot.meta.locked = true;
    const handId = s.beats.filter((b) => b.shot.type === 'cu')[1]!.id;
    s.beats.find((b) => b.id === handId)!.shot.meta.source = 'user';
    const env = makeEnv(p);
    const r = call(env, 'batch_edit', { target: { filter: { scenes: [3], shotType: 'cu' } }, tool: 'set_shot', args: { type: 'mcu' } }) as Ans;
    expect(r.待用户确认.数量).toBe(2);
    expect(r.待用户确认.锁定).toBe(1);
    expect(r.待用户确认.覆盖手改).toBe(1);
    expect(env.pending.map((x) => x.status).sort()).toEqual(['needs_confirm', 'needs_unlock']);
    expect(env.applied).toHaveLength(cuIds.length - 2);
    expect(new Set([...env.applied, ...env.pending].map((x) => x.group?.id)).size).toBe(1);
    // the sandbox keeps both as they were
    expect(sceneOf(env).beats.find((b) => b.id === lockedId)!.shot.type).toBe('cu');
    expect(sceneOf(env).beats.find((b) => b.id === handId)!.shot.type).toBe('cu');
    // the group label counts the beats that really change
    expect(env.applied[0]!.group!.label).toBe(`把 ${cuIds.length - 2} 句的景别改成 mcu`);
    // an explicit overwriteManual (the user named the hand-made beat) lets the hand-made one through
    const env2 = makeEnv(p);
    call(env2, 'batch_edit', { target: { filter: { scenes: [3], shotType: 'cu' } }, tool: 'set_shot', args: { type: 'mcu', overwriteManual: true } });
    expect(env2.pending.map((x) => x.status)).toEqual(['needs_unlock']);
  });

  it('a raw op template cannot confirm hand-made content by itself (overrideUser / includeProtected are dropped)', () => {
    const p = clone(P);
    const handId = p.scenes[2]!.beats.filter((b) => b.shot.type === 'cu')[1]!.id;
    p.scenes[2]!.beats.find((b) => b.id === handId)!.shot.meta.source = 'user';
    for (const args of [{ op: { op: 'shot_set', set: { type: 'mcu' }, overrideUser: true } }]) {
      const env = makeEnv(p);
      call(env, 'batch_edit', { target: { beatIds: [handId] }, ...args });
      expect(env.applied).toHaveLength(0);
      expect(env.pending.map((x) => x.status)).toEqual(['needs_confirm']);
    }
  });

  it('works with a raw op template; timing ops come out as one op per scene chunk', () => {
    const env = makeEnv();
    const a = call(env, 'batch_edit', { target: { filter: { scenes: [3], kind: 'dialogue' } }, op: { op: 'beat_set', set: { emotion: 'serious' } }, label: '对白全部严肃' }) as Ans;
    expect(a.已放入变更集.涉及句数).toBeGreaterThan(5);
    expect(env.applied[0]!.group!.label).toBe('对白全部严肃');
    const before = env.applied.length;
    call(env, 'batch_edit', { target: { filter: { scenes: [3], kind: 'dialogue' } }, tool: 'set_timing', args: { gapSteps: 2 } });
    const timing = env.applied.slice(before);
    expect(timing.every((x) => x.op.op === 'timing')).toBe(true);
    expect(timing.length).toBeLessThanOrEqual(2);
    expect(timing.flatMap((x) => (x.op as { beatIds: string[] }).beatIds).length).toBe(sceneOf(env).beats.filter((b) => b.kind === 'dialogue').length);
    expect((call(env, 'batch_edit', { target: { beatIds: [sceneOf(env).beats[0]!.id] }, op: { op: 'scene_set', set: {} } }) as Ans).错误[0]).toContain('不支持');
    expect((call(env, 'batch_edit', { target: { beatIds: [sceneOf(env).beats[0]!.id] }, op: { op: 'shot_set', set: { type: 'bogus' } } }) as Ans).错误).toBeDefined();
  });

  it('set_fx joins consecutive beats into ranges (dim at most 4 in a row)', () => {
    const env = makeEnv();
    const s = sceneOf(env);
    const ids = s.beats.slice(2, 9).map((b) => b.id); // 7 consecutive
    call(env, 'batch_edit', { target: { beatIds: [...ids, s.beats[12]!.id] }, tool: 'set_fx', args: { fx: 'dim' } });
    const ranges = env.applied.filter((x) => x.op.op === 'fx_range').map((x) => { const o = x.op as { fromBeatId: string; toBeatId: string }; return [s.beats.findIndex((b) => b.id === o.fromBeatId) + 1, s.beats.findIndex((b) => b.id === o.toBeatId) + 1]; });
    expect(ranges).toEqual([[3, 6], [7, 9], [13, 13]]);
  });

  it('a template that needs a person (set_actor / nudge_shot) must say who', () => {
    const env = makeEnv();
    const r = call(env, 'batch_edit', { target: { filter: { scenes: [3], speaker: '高松灯' } }, tool: 'nudge_shot', args: { dxSteps: -1 } }) as Ans;
    expect(r.错误[0]).toContain('castId');
  });

  it('more than 400 beats is refused with advice', () => {
    const big = clone(P);
    const s = big.scenes[2]!;
    const base = [...s.beats];
    for (let i = 0; i < 20; i++) for (const b of base) s.beats.push({ ...clone(b), id: `${b.id}_x${i}` });
    const env = makeEnv(big);
    expect((call(env, 'batch_edit', { target: { filter: {} }, tool: 'set_shot', args: { type: 'mcu' } }) as Ans).错误[0]).toContain('最多 400');
  });

  it('the whole group is one undo step; the history shows it as one line', () => {
    const env = makeEnv();
    call(env, 'batch_edit', { target: { filter: { scenes: [3], shotType: 'cu' } }, tool: 'set_shot', args: { type: 'mcu' } });
    call(env, 'edit_beat', { beatId: sceneOf(env).beats[0]!.id, emotion: 'sad', reason: 'x' });
    const items = env.applied.map((r) => ({ id: r.id, op: r.op }));
    const plan = planReplay(P, items, { genId: 'agent_t', now: 5000 });
    expect(plan.accepted).toHaveLength(env.applied.length);
    const st = useProject.getState();
    st.open(clone(P), null);
    const out = st.applyAgentOps(items, 'AI 助手：特写太多', 'agent_t');
    expect(out.applied).toBe(items.length);
    expect(useProject.getState().undoLabel).toBe('AI 助手：特写太多');
    useProject.getState().undo();
    expect(JSON.stringify(useProject.getState().project)).toBe(JSON.stringify(P));
    expect(useProject.getState().canUndo).toBe(false);

    const hist = agentHistory([{ instruction: '特写太多', summary: '改了', applied: env.applied, pending: [], appliedIds: env.applied.map((r) => r.id) }]);
    const text = hist.at(-1)!.content;
    expect(text).toContain(`批量「把 ${cuIds.length} 句的景别改成 mcu」：${cuIds.length} 句：${cuIds[0]}`);
    expect(text.split('\n').length).toBeLessThan(6);
  });
});
