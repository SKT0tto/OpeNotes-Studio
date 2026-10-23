import { describe, expect, it } from 'vitest';
import { liveDecision } from '../../shared/agent/live';
import { planReplay, replayInto } from '../../shared/agent/replay';
import type { AgentOp } from '../../shared/agent/ops';
import { clone } from '../../shared/project/mutate';
import { useProject } from '../../web/store/projectStore';
import { History } from '../../web/store/history';
import { directedProject } from './helpers/directorFlow';
import { call, makeEnv, sceneOf } from './helpers/agentEnv';

const P = directedProject();
const S = P.scenes[2]!;
const ctx = { genId: 'agent_t', now: 7000 };
const shot = (i: number, type: string): AgentOp => ({ op: 'shot_set', sceneId: 's_3', beatId: S.beats[i]!.id, set: { type }, reason: 'r' });

describe('planReplay / replayInto', () => {
  it('replays the ops of a proposal on the current project exactly like the sandbox did', () => {
    const env = makeEnv();
    const s = sceneOf(env);
    call(env, 'set_shot', { beatIds: [s.beats[2]!.id, s.beats[3]!.id], adjust: 'tighter', reason: 'r' });
    call(env, 'set_fx', { fromBeatId: s.beats[8]!.id, fx: 'shake', reason: 'r' });
    const plan = planReplay(P, env.applied.map((r) => ({ id: r.id, op: r.op })), { genId: 'agent_t', now: 5000 });
    expect(plan.accepted).toHaveLength(env.applied.length);
    const out = clone(P);
    replayInto(out, plan, { genId: 'agent_t', now: 5000 });
    expect(JSON.stringify(out.scenes)).toBe(JSON.stringify(env.sandbox.scenes));
  });

  it('a bulk effect clear that met a locked effect replays its "unlock and apply" item once the user agrees', () => {
    const env = makeEnv();
    const s = sceneOf(env);
    call(env, 'set_fx', { fromBeatId: s.beats[2]!.id, fx: 'shake', reason: 'r' });
    const k = s.tracks.filter((t) => t.channel === 'fx').flatMap((t) => t.keys)[0]!;
    k.meta.locked = true;
    const base = clone(env.sandbox);
    call(env, 'set_fx', { fromBeatId: s.beats[0]!.id, toBeatId: s.beats.at(-1)!.id, fx: 'none', reason: 'r' });
    expect(env.pending).toHaveLength(1);
    const items = [...env.applied.slice(1), ...env.pending].map((r) => ({ id: r.id, op: r.op }));
    const refuse = planReplay(base, items, ctx);
    expect(refuse.items.at(-1)!.status).toBe('needs_unlock');
    const plan = planReplay(base, items.map((i) => ({ ...i, unlock: true })), ctx);
    const out = clone(base);
    replayInto(out, plan, ctx);
    expect(out.scenes.find((x) => x.id === s.id)!.tracks.flatMap((t) => t.keys as Array<{ id: string }>).some((x) => x.id === k.id)).toBe(false);
  });

  it('one application is one undo step, and undo restores the project exactly', () => {
    const h = new History<typeof P>();
    const items = [shot(2, 'cu'), shot(3, 'cu'), { op: 'timing', sceneId: 's_3', beatIds: [S.beats[2]!.id], set: { 'rhythm.lineGap': 0.5 } } as AgentOp].map((op, id) => ({ id, op }));
    const plan = planReplay(P, items, ctx);
    const next = h.apply(P, (d) => replayInto(d as typeof P, plan, ctx), 'AI 助手：t');
    expect(next.scenes[2]!.beats[2]!.shot.type).toBe('cu');
    expect(next.scenes[2]!.beats[2]!.style.overrides['rhythm.lineGap']).toBe(0.5);
    expect(h.undoLabel).toBe('AI 助手：t');
    const back = h.undo(next);
    expect(JSON.stringify(back)).toBe(JSON.stringify(P));
    expect(h.canUndo).toBe(false);
  });

  it('applying only part of the proposal applies only that part', () => {
    const plan = planReplay(P, [{ id: 1, op: shot(2, 'cu') }, { id: 2, op: shot(3, 'ecu') }].slice(0, 1), ctx);
    const out = clone(P);
    replayInto(out, plan, ctx);
    expect(out.scenes[2]!.beats[2]!.shot.type).toBe('cu');
    expect(out.scenes[2]!.beats[3]!.shot.type).toBe(S.beats[3]!.shot.type);
  });

  it('a target deleted meanwhile is stale, the rest still applies', () => {
    const edited = clone(P);
    edited.scenes[2]!.beats.splice(3, 1);
    const plan = planReplay(edited, [{ id: 1, op: shot(2, 'cu') }, { id: 2, op: shot(3, 'ecu') }], ctx);
    expect(plan.items.map((i) => i.status)).toEqual(['ok', 'stale']);
    expect(plan.items[1]!.reason).toContain('已失效');
    expect(plan.accepted).toHaveLength(1);
  });

  it('a lock added meanwhile asks first; 解锁并应用 opens it in the same step, otherwise nothing changes', () => {
    const locked = clone(P);
    locked.scenes[2]!.beats[2]!.shot.meta.locked = true;
    const ask = planReplay(locked, [{ id: 1, op: shot(2, 'cu') }], ctx);
    expect(ask.items[0]!.status).toBe('needs_unlock');
    expect(ask.accepted).toHaveLength(0);
    const yes = planReplay(locked, [{ id: 1, op: shot(2, 'cu'), unlock: true }], ctx);
    expect(yes.items[0]!.status).toBe('ok');
    const out = clone(locked);
    replayInto(out, yes, ctx);
    expect(out.scenes[2]!.beats[2]!.shot).toMatchObject({ type: 'cu', meta: { locked: false } });
  });

  it('hand-made content needs a confirmation and then stays user-owned', () => {
    const hand = clone(P);
    hand.scenes[2]!.beats[2]!.shot.meta.source = 'user';
    expect(planReplay(hand, [{ id: 1, op: shot(2, 'cu') }], ctx).items[0]!.status).toBe('needs_confirm');
    const yes = planReplay(hand, [{ id: 1, op: shot(2, 'cu'), confirm: true }], ctx);
    const out = clone(hand);
    replayInto(out, yes, ctx);
    expect(out.scenes[2]!.beats[2]!.shot.meta.source).toBe('user');
  });
});

describe('the project store: applyAgentOps', () => {
  it('is one undo step with the lock gate bypassed only for items the user unlocked', () => {
    const st = useProject.getState();
    st.open(clone(P), null);
    const r = st.applyAgentOps([{ id: 1, op: shot(2, 'cu') }, { id: 2, op: shot(3, 'cu') }], 'AI 助手：测试', 'agent_t');
    expect(r.applied).toBe(2);
    expect(useProject.getState().undoLabel).toBe('AI 助手：测试');
    useProject.getState().undo();
    expect(JSON.stringify(useProject.getState().project)).toBe(JSON.stringify(P));
    expect(useProject.getState().canUndo).toBe(false);
    // a locked shot: refused without the unlock decision
    const locked = clone(P);
    locked.scenes[2]!.beats[2]!.shot.meta.locked = true;
    useProject.getState().open(locked, null);
    expect(useProject.getState().applyAgentOps([{ id: 1, op: shot(2, 'cu') }], 'x', 'g').applied).toBe(0);
    expect(useProject.getState().project!.scenes[2]!.beats[2]!.shot.type).toBe(S.beats[2]!.shot.type);
    expect(useProject.getState().applyAgentOps([{ id: 1, op: shot(2, 'cu'), unlock: true }], 'y', 'g').applied).toBe(1);
    expect(useProject.getState().project!.scenes[2]!.beats[2]!.shot.meta.locked).toBe(false);
    useProject.getState().undo();
    expect(useProject.getState().project!.scenes[2]!.beats[2]!.shot.meta.locked).toBe(true);
  });
});

describe('live mode', () => {
  const rec = (op: AgentOp, extra: Partial<{ tool: string; warnings: string[]; overwrote: string[] }> = {}) => ({ tool: 'set_shot', op, warnings: [], overwrote: [], ...extra });
  const base = { sceneId: 's_3', pending: 0, question: false, unverified: 0, stopped: 'done' };
  it('takes a small change set of the current scene', () => {
    expect(liveDecision({ ...base, applied: [rec(shot(2, 'cu')), rec(shot(3, 'cu'))] })).toEqual({ auto: true, reasons: [] });
  });
  it('refuses more than 6 ops, other scenes, entrances / exits / backgrounds, locks, hand-made content, repairs, questions and unfinished runs', () => {
    const many = Array.from({ length: 7 }, (_, i) => rec(shot(i, 'cu')));
    const why = (x: Partial<Parameters<typeof liveDecision>[0]>) => liveDecision({ ...base, applied: [rec(shot(2, 'cu'))], ...x });
    expect(liveDecision({ ...base, applied: many }).auto).toBe(false);
    expect(why({ applied: [rec({ ...shot(2, 'cu'), sceneId: 's_2' } as AgentOp)] }).reasons.join()).toContain('当前场景');
    expect(why({ applied: [rec({ op: 'stage_set', sceneId: 's_3', castId: 'c_001', enter: null })] }).reasons.join()).toContain('进出场');
    expect(why({ applied: [rec({ op: 'bg_set', sceneId: 's_3', at: 'start', assetId: 'x' })] }).auto).toBe(false);
    expect(why({ applied: [rec({ op: 'lock_set', sceneId: 's_3', unit: 'beat', beatId: 'a' })] }).auto).toBe(false);
    expect(why({ pending: 1 }).reasons.join()).toContain('锁定');
    expect(why({ applied: [rec(shot(2, 'cu'), { overwrote: ['x'] })] }).reasons.join()).toContain('手改');
    expect(why({ applied: [rec(shot(2, 'cu'), { warnings: ['已改'] })] }).reasons.join()).toContain('修正');
    expect(why({ applied: [rec(shot(2, 'cu'), { tool: 'regenerate_scene_camera' })] }).auto).toBe(false);
    expect(why({ question: true }).auto).toBe(false);
    expect(why({ stopped: 'steps' }).auto).toBe(false);
    expect(why({ sceneId: null }).auto).toBe(false);
  });
});

describe('unlocking a hand-locked unit', () => {
  it('opening the lock of something the user made also accepts the overwrite, and it stays user-owned', () => {
    const p = clone(P);
    const sh = p.scenes[2]!.beats[2]!.shot;
    sh.meta.locked = true;
    sh.meta.source = 'user';
    const plan = planReplay(p, [{ id: 1, op: shot(2, 'cu'), unlock: true }], ctx);
    expect(plan.items[0]!.status).toBe('ok');
    const out = clone(p);
    replayInto(out, plan, ctx);
    expect(out.scenes[2]!.beats[2]!.shot.meta).toMatchObject({ locked: false, source: 'user' });
  });
});
