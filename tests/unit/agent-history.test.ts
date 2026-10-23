import { describe, expect, it } from 'vitest';
import { applyOp } from '../../shared/agent/apply';
import { agentHistory, selectionText } from '../../shared/agent/history';
import { revertOps } from '../../shared/agent/revert';
import { clone } from '../../shared/project/mutate';
import type { Project } from '../../shared/schema/project';
import { directedProject } from './helpers/directorFlow';
import { call, makeEnv, sceneOf } from './helpers/agentEnv';

/** The project without provenance (meta) and id counters: what 「改回去」 must restore. */
const content = (p: Project) => JSON.parse(JSON.stringify(p, (k, v) => (k === 'meta' || k === 'idSeq' ? undefined : v))) as unknown;

describe('revertOps: 「改回去」 restores exactly what an earlier turn changed', () => {
  it('shot, offset, rhythm, keys, effects, an inserted line, an entrance and scene settings all come back', () => {
    const before = directedProject();
    const env = makeEnv(before);
    const s = sceneOf(env);
    const [b2, b3, b4] = [s.beats[2]!.id, s.beats[3]!.id, s.beats[4]!.id];
    const who = s.beats[3]!.speakerId ?? Object.keys(s.wardrobe)[0]!;
    call(env, 'set_shot', { beatIds: [b2], adjust: 'tighter' });
    call(env, 'nudge_shot', { beatId: b3, castId: who, dxSteps: -2 });
    call(env, 'set_timing', { beatIds: [b3, b4], pace: 'slower' });
    call(env, 'set_actor', { beatId: b3, castId: who, expression: 'exp_smile03', headTilt: 'down' });
    call(env, 'set_fx', { fromBeatId: b2, toBeatId: b4, fx: 'memory', tone: 'warm' });
    call(env, 'edit_structure', { action: 'insert', afterBeatId: b2, kind: 'narration', text: '窗外开始下雨。' });
    call(env, 'edit_beat', { beatId: b4, emotion: 'angry', text: '改过的台词' });
    call(env, 'set_scene', { locationShow: false, transitionKind: 'fade_white' });
    expect(env.applied.length).toBeGreaterThan(6);
    const after = env.sandbox;
    expect(content(after)).not.toEqual(content(before));
    const ops = revertOps(before, after);
    const back = clone(after);
    for (const op of ops) {
      const r = applyOp(back, op, { genId: 'undo', now: 1 });
      expect(r.ok, `${op.op}: ${r.error}`).toBe(true);
    }
    expect(content(back)).toEqual(content(before));
    // nothing changed -> nothing to undo
    expect(revertOps(before, clone(before))).toEqual([]);
  });
});

describe('agentHistory: what the assistant remembers of earlier turns', () => {
  it('names scene, line and beat id of every change, whether it was applied, and carries the undo ops', () => {
    const p = directedProject();
    const env = makeEnv(p);
    const id = sceneOf(env).beats[2]!.id;
    call(env, 'set_shot', { beatIds: [id], adjust: 'tighter' });
    const h = agentHistory([
      { instruction: '这句推近一点', selection: selectionText(p, { sceneId: 's_3', beatId: id }), summary: '推近了一档。', applied: env.applied, pending: [], appliedIds: env.applied.map((r) => r.id), revert: revertOps(p, env.sandbox) },
      { instruction: '加个震动', summary: '加了。', applied: env.applied, pending: [], appliedIds: [] },
    ]);
    expect(h).toHaveLength(4);
    expect(h[0]!.content).toContain(`第3场第3句 ${id}`);
    expect(h[1]!.content).toContain(`s_3 第3句(${id}) 镜头`);
    expect(h[1]!.content).toContain('用户已应用');
    expect(h[1]!.revert?.length).toBeGreaterThan(0);
    expect(h[3]!.content).toContain('用户还没有应用');
    expect(h[3]!.revert).toBeUndefined();
  });
});

describe('revert_turn tool', () => {
  it('undoes the chosen turn, or only one kind of change of it', () => {
    const p = directedProject();
    const env1 = makeEnv(p);
    const id = sceneOf(env1).beats[2]!.id;
    call(env1, 'set_shot', { beatIds: [id], adjust: 'tighter' });
    call(env1, 'set_timing', { beatIds: [id], pace: 'slower' });
    const applied = env1.sandbox;
    const env = makeEnv(applied);
    env.reverts = [{ turnsAgo: 1, instruction: '推近一点，节奏放慢', ops: revertOps(p, applied) }];
    call(env, 'revert_turn', { scopes: ['rhythm'] });
    const b = sceneOf(env).beats[2]!;
    expect(b.style.overrides).toEqual(sceneOf(makeEnv(p)).beats[2]!.style.overrides);
    expect(b.shot.type).toBe(sceneOf(makeEnv(applied)).beats[2]!.shot.type);
    expect(JSON.stringify(call(env, 'revert_turn', { turnsAgo: 2 }))).toContain('错误');
  });
});

describe('pruneRoundTrips: a try that was taken back leaves the card', () => {
  it('drops a move and its reset, keeps everything else, and only when the rest replays to the same project', async () => {
    const { pruneRoundTrips } = await import('../../shared/agent/prune');
    const p = directedProject();
    const env = makeEnv(p);
    const s = sceneOf(env);
    const [b2, b3] = [s.beats[2]!.id, s.beats[3]!.id];
    const who = s.beats[2]!.shot.focus[0] ?? Object.keys(s.wardrobe)[0]!;
    call(env, 'set_shot', { beatIds: [b3], dof: 2 });
    call(env, 'nudge_shot', { beatId: b2, castId: who, dxSteps: 2 });
    call(env, 'nudge_shot', { beatId: b2, castId: who, resetOffset: true });
    expect(env.applied).toHaveLength(3);
    const kept = pruneRoundTrips(p, env.applied, env.sandbox);
    expect(kept.map((r) => r.op.op)).toEqual(['shot_set']);
    // a chain that does not come back is kept whole
    call(env, 'nudge_shot', { beatId: b2, castId: who, dxSteps: -1 });
    expect(pruneRoundTrips(p, env.applied, env.sandbox).filter((r) => r.op.op === 'shot_offset').map((r) => (r.op as { offset: unknown }).offset)).toEqual([{ x: -0.04, y: 0 }]);
  });
});
