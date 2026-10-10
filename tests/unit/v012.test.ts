/** v0.1.2: nobody on stage is ever frozen (idle for every model, one-shots return to idle, bystanders react, ids are re-mapped not dropped). */
import { describe, expect, it } from 'vitest';
import type { MotionEntry } from '../../shared/schema/assets';
import { compileProject } from '../../shared/timeline/compile';
import { evaluate } from '../../shared/timeline/evaluate';
import { canon, familyOfName, gesturePool, idleFamilyOf, idleNameOf, isLiveSet, isLoopFamily, mapExpressionName, mapMotionFamily, pickReaction } from '../../shared/timeline/motionMap';
import { EMOTION_EXPR } from '../../shared/timeline/compile';
import type { CompileContext, CompiledActor } from '../../shared/timeline/types';
import { fakeCalibration, fakeModel, miniProject } from './helpers/synthetic';

const entry = (name: string, duration = 3): MotionEntry => {
  const m = /^mtn_(.+?)_([LCR])$/.exec(name);
  return { name, file: `motions/${name}.motion3.json`, family: m ? m[1]! : name.replace(/^mtn_/, ''), side: (m?.[2] as 'L' | 'C' | 'R' | undefined) ?? null, variant: '', stats: { duration, fps: 30, loop: false, angleX: null, bodyAngleX: null, eyeBallX: null } };
};
const everyday = fakeModel().motions;
/** What a real live-mode model offers: no side variants, `idle_01`, and instrument motions. */
const liveMotions = ['mtn_action_01', 'mtn_finish_01', 'mtn_idle_01', 'mtn_play01_01', 'mtn_play01_02', 'mtn_play02_01'].map((n) => entry(n, n.includes('play') ? 10.65 : n.includes('idle') ? 4 : 4.98));

describe('motion names and idle selection', () => {
  it('parses families the way model3.json names them, and treats idle01 / idle_01 alike', () => {
    expect(familyOfName('mtn_nod01_L')).toBe('nod01');
    expect(familyOfName('mtn_idle_01')).toBe('idle_01');
    expect(familyOfName('nod01')).toBe('nod01');
    expect(canon('mtn_idle_01')).toBe(canon('idle01'));
    expect(isLoopFamily('idle_01') && isLoopFamily('idle01') && isLoopFamily('play01_01')).toBe(true);
    expect(isLoopFamily('nod01') || isLoopFamily('action_01') || isLoopFamily('finish_01')).toBe(false);
  });

  it('every model has an idle: idle01 for everyday models, idle_01 for live-mode, the first idle else, null only without one', () => {
    expect(idleFamilyOf(everyday)).toBe('idle01');
    expect(idleFamilyOf(liveMotions)).toBe('idle_01');
    expect(idleFamilyOf([entry('mtn_idle03_C'), entry('mtn_idle02_C'), entry('mtn_nod01_C')])).toBe('idle02');
    expect(idleFamilyOf([entry('mtn_nod01_C')])).toBeNull();
    expect(idleNameOf(['mtn_nod01_L', 'mtn_idle01_R', 'mtn_idle01_C'])).toBe('mtn_idle01_C');
    expect(idleNameOf(['mtn_idle_01', 'mtn_play01_01'])).toBe('mtn_idle_01');
    expect(idleNameOf(['mtn_nod01_L'])).toBeNull();
    expect(isLiveSet(liveMotions)).toBe(true);
    expect(isLiveSet(everyday)).toBe(false);
    expect(gesturePool(liveMotions)).toEqual(['action_01', 'finish_01', 'play01_01', 'play01_02', 'play02_01']);
  });
});

describe('mapping an id the model does not have', () => {
  const m = everyday; // idle01 nod01 smile01 surprised01 thinking01
  it('prefers the family itself, then the same kind, then a keyword category, then the emotion, then any mild gesture', () => {
    expect(mapMotionFamily(m, 'mtn_nod01_C')).toBe('nod01');
    expect(mapMotionFamily(m, 'nod07')).toBe('nod01');
    expect(mapMotionFamily(m, 'laugh_loudly', 'sad')).toBe('smile01'); // keyword beats emotion
    expect(mapMotionFamily(m, 'zzz', 'surprised')).toBe('surprised01');
    expect(mapMotionFamily(m, 'zzz', 'no-such-emotion', 'x')).toMatch(/^(nod01|smile01|thinking01|surprised01)$/); // still a real gesture
    expect(mapMotionFamily(m, 'unknown-thing')).not.toBeNull();
  });

  it('is deterministic, and different actors asking for the same unknown id are spread over the gestures', () => {
    expect(mapMotionFamily(m, 'zzz', 'neutral', 'a')).toBe(mapMotionFamily(m, 'zzz', 'neutral', 'a'));
    const picks = new Set(['a', 'b', 'c', 'd', 'e', 'f'].map((s) => mapMotionFamily(m, 'zzz', 'no-such-emotion', s)));
    expect(picks.size).toBeGreaterThan(1);
  });

  it('never returns an idle for a directed gesture, an idle request gives the idle, a live-mode model maps to its instrument motions', () => {
    expect(mapMotionFamily(m, 'idle01')).toBe('idle01');
    expect(gesturePool(m)).not.toContain('idle01');
    expect(mapMotionFamily(liveMotions, 'nod01', 'happy')).toBe('play01_01');
    expect(mapMotionFamily(liveMotions, 'play02', 'happy')).toBe('play02_01');
    expect(mapMotionFamily([entry('mtn_idle01_C')], 'nod01')).toBeNull(); // nothing but an idle: the caller keeps the idle
  });

  it('expressions: same family, keyword, emotion, else the neutral one; null for models without expressions', () => {
    const names = ['exp_idle01', 'exp_smile01', 'exp_sad01', 'exp_serious01'];
    expect(mapExpressionName(names, 'exp_smile09', 'neutral', EMOTION_EXPR)).toBe('exp_smile01');
    expect(mapExpressionName(names, 'cry_hard', 'neutral', EMOTION_EXPR)).toBe('exp_sad01');
    expect(mapExpressionName(names, 'zzz', 'angry', EMOTION_EXPR)).toBe('exp_serious01');
    expect(mapExpressionName(names, 'zzz', 'nope', EMOTION_EXPR)).toBe('exp_idle01');
    expect(mapExpressionName([], 'exp_smile01', 'happy', EMOTION_EXPR)).toBeNull();
  });

  it('bystander reactions rotate through the emotion list, avoid the previous one, and never touch musicians', () => {
    const a = pickReaction(m, 'happy', 0)!;
    const b = pickReaction(m, 'happy', 1, a)!;
    expect(a).not.toBe(b);
    expect(gesturePool(m)).toContain(a);
    expect(pickReaction(liveMotions, 'happy', 0)).toBeNull();
    expect(pickReaction([entry('mtn_idle01_C')], 'happy', 0)).toBeNull();
  });
});

type Raw = Record<string, unknown>;
const mk = (motions: MotionEntry[]) => ({ motions, expressions: ['exp_smile01', 'exp_sad01'] });
const ctxOf = (models: Record<string, ReturnType<typeof mk>>): CompileContext => ({
  models,
  calibrations: Object.fromEntries(Object.keys(models).map((id) => [id, fakeCalibration(id)])),
  backgrounds: { bg1: { width: 2048, height: 1119 } },
});
const long = (id: string, speaker: string, shotFocus: string[], emotion: string, seconds: number): Raw => ({
  id, kind: 'dialogue', speakerId: speaker, text: '这是一句比较长的台词，用来撑出足够的时长。', emotion, duration: { mode: 'fixed', seconds },
  shot: { type: 'two_shot', focus: shotFocus, move: 'static', dof: 0 },
});
const key = (id: string, beatId: string, offset: number, value: unknown) => ({ id, at: { beatId, offset }, value, duration: 0, ease: 'inOutQuad' });
const actorOf = (c: ReturnType<typeof compileProject>, id: string): CompiledActor => c.scenes[0]!.actors.find((x) => x.castId === id)!;

/** The activity invariant: from the start of the scene on, at every time the actor's current motion is a loop or has not run out yet. */
function expectAlwaysActive(c: ReturnType<typeof compileProject>, who: string[]): void {
  const sc = c.scenes[0]!;
  for (const id of who) {
    const a = actorOf(c, id);
    expect(a.motions.length, `${id} has motions`).toBeGreaterThan(0);
    expect(a.motions[0]!.loop, `${id} starts in a loop`).toBe(true);
    for (let t = sc.start; t < sc.end; t += 0.1) {
      const ev = [...a.motions].filter((m) => m.at <= t + 1e-9).at(-1)!;
      expect(ev.loop || t < ev.at + ev.length + 1e-6, `${id} @${t.toFixed(1)} (${ev.name})`).toBe(true);
    }
  }
}

describe('compile: always an idle, always active', () => {
  it('a live-mode model (idle_01, no side variants) idles, plays on, and returns to idle after a one-shot', () => {
    const ctx = ctxOf({ mA: mk(liveMotions), mB: mk(liveMotions) });
    const tracks = [
      { id: 't1', target: { kind: 'actor', castId: 'a' }, channel: 'motion', keys: [key('k1', 'b1', 0.1, { name: 'play01_01' }), key('k2', 'b3', 0.1, { name: 'finish_01' })] },
    ];
    const c = compileProject(miniProject({ tracks, style: { 'performance.ruleDirector': true } }), ctx);
    expect(c.warnings.filter((w) => /no idle/.test(w))).toEqual([]);
    const a = actorOf(c, 'a');
    expect(a.motions[0]!.name).toBe('mtn_idle_01');
    expect(a.motions.find((m) => m.name === 'mtn_play01_01')!.loop).toBe(true); // keeps playing until something else is keyed
    const fin = a.motions.find((m) => m.name === 'mtn_finish_01')!;
    expect(fin.loop).toBe(false);
    const back = a.motions.find((m) => m.at > fin.at)!;
    expect(back.name).toBe('mtn_idle_01');
    expect(back.at).toBeCloseTo(fin.at + fin.length);
    // the actor without any key is just idling, and musicians get no gesture reactions
    expect(actorOf(c, 'b').motions.map((m) => m.name)).toEqual(['mtn_idle_01']);
    expectAlwaysActive(c, ['a', 'b']);
  });

  it('after the last directed motion a live-mode actor ends in a loop, never in a frozen pose', () => {
    const ctx = ctxOf({ mA: mk(liveMotions), mB: mk(liveMotions) });
    const tracks = [{ id: 't1', target: { kind: 'actor', castId: 'b' }, channel: 'motion', keys: [key('k1', 'b1', 0.1, { name: 'action_01' })] }];
    const c = compileProject(miniProject({ tracks }), ctx);
    expectAlwaysActive(c, ['a', 'b']);
    expect(actorOf(c, 'b').motions.at(-1)!.name).toBe('mtn_idle_01');
  });

  it('a model whose idle is idle02 only still idles', () => {
    const odd = [entry('mtn_idle02_C'), entry('mtn_nod01_C')];
    const c = compileProject(miniProject(), ctxOf({ mA: mk(odd), mB: mk(odd) }));
    expect(actorOf(c, 'a').motions[0]!.name).toBe('mtn_idle02_C');
    expectAlwaysActive(c, ['a', 'b']);
  });

  it('an unknown motion id is mapped for the model the actor wears at that moment; a costume change remaps instead of dropping', () => {
    const noThinking = mk(everyday.filter((m) => m.family !== 'thinking01'));
    const ctx = ctxOf({ mA: mk(everyday), mB: mk(everyday), mA2: noThinking });
    const tracks = [
      { id: 'c', target: { kind: 'actor', castId: 'a' }, channel: 'costume', keys: [key('kc', 'b2', 0, { modelId: 'mA2' })] },
      { id: 'm', target: { kind: 'actor', castId: 'a' }, channel: 'motion', keys: [key('k1', 'b1', 0.3, { name: 'thinking01' }), key('k2', 'b3', 0.3, { name: 'thinking01' })] },
    ];
    const c = compileProject(miniProject({ tracks }), ctx);
    const a = actorOf(c, 'a');
    const sc = c.scenes[0]!;
    const before = a.motions.find((m) => Math.abs(m.at - (sc.beats[0]!.start + 0.3)) < 1e-6)!;
    const after = a.motions.find((m) => Math.abs(m.at - (sc.beats[2]!.start + 0.3)) < 1e-6)!;
    expect(before.name).toContain('thinking01'); // exists in the first outfit
    expect(after.name).not.toContain('thinking01'); // the second outfit does not have it ...
    expect(noThinking.motions.some((m) => m.name === after.name)).toBe(true); // ... so it became a real gesture of that outfit
    expect(c.warnings.some((w) => /thinking01.*mapped to/.test(w))).toBe(true);
    expectAlwaysActive(c, ['a', 'b']);
  });
});

describe('compile: bystanders react (rule director, no AI)', () => {
  const beats = [long('l1', 'a', ['a', 'b'], 'happy', 14), long('l2', 'b', ['a', 'b'], 'thinking', 12), long('l3', 'a', ['a', 'b'], 'sad', 9)];
  const run = (style: Raw = {}, tracks: Raw[] = []) => compileProject(miniProject({ style: { 'performance.ruleDirector': true, ...style }, beats, tracks }), { ...ctxOf({ mA: mk(everyday), mB: mk(everyday) }) });

  /** One-shot motions of `id` that start inside line `i` (b listens during lines 0 and 2). */
  const listening = (c: ReturnType<typeof compileProject>, id: string, i: number) => {
    const sc = c.scenes[0]!;
    return actorOf(c, id).motions.filter((m) => !m.loop && m.at >= sc.beats[i]!.start && m.at < sc.beats[i]!.end);
  };

  it('a listener who has been still for the gap makes small reactions during long lines, spaced apart and varied', () => {
    const c = run();
    const first = listening(c, 'b', 0);
    expect(first.length).toBeGreaterThanOrEqual(2); // a 14 s line, 5 s gap
    for (let i = 1; i < first.length; i++) expect(first[i]!.at - first[i - 1]!.at).toBeGreaterThanOrEqual(5 - 1e-6);
    expect(new Set([...first, ...listening(c, 'b', 2)].map((m) => m.name.replace(/_[LCR]$/, ''))).size).toBeGreaterThan(1);
    // the happy line gets friendly reactions
    expect(first.every((m) => /nod|smile/.test(m.name))).toBe(true);
    expectAlwaysActive(c, ['a', 'b']);
  });

  it('the speaker is not a bystander on their own line, and the two do not react in unison', () => {
    const c = run({ 'performance.gestureEvery': 6 });
    const aOnOwn = listening(c, 'a', 0);
    expect(aOnOwn).toHaveLength(0); // gestureEvery 6: no speaker gesture, and a speaker is never "listening"
    const bAts = actorOf(c, 'b').motions.filter((m) => !m.loop).map((m) => m.at);
    const aAts = actorOf(c, 'a').motions.filter((m) => !m.loop).map((m) => m.at);
    expect(bAts.some((t) => aAts.some((u) => Math.abs(t - u) < 1e-6))).toBe(false);
  });

  it('can be switched off, and yields to a motion key on that actor inside the line', () => {
    for (const off of [{ 'performance.listenerReact': false }, { 'performance.ruleDirector': false }, { 'performance.listenerReactGap': 0 }]) {
      const c = run(off);
      expect(listening(c, 'b', 0).length + listening(c, 'b', 2).length).toBe(0);
    }
    const keyed = run({}, [{ id: 't', target: { kind: 'actor', castId: 'b' }, channel: 'motion', keys: [key('k', 'l1', 1, { name: 'smile01' })] }]);
    const inLine1 = listening(keyed, 'b', 0);
    expect(inLine1).toHaveLength(1);
    expect(inLine1[0]!.name).toContain('smile01');
  });

  it('is deterministic and adds nothing to the project (only compiled events)', () => {
    const p = miniProject({ style: { 'performance.ruleDirector': true }, beats });
    const before = JSON.stringify(p);
    const ctx = ctxOf({ mA: mk(everyday), mB: mk(everyday) });
    const one = compileProject(p, ctx);
    const two = compileProject(p, ctx);
    expect(JSON.stringify(one)).toBe(JSON.stringify(two));
    expect(JSON.stringify(p)).toBe(before);
  });

  it('evaluate reports the reaction as the actor\'s current motion while it plays', () => {
    const c = run();
    const react = actorOf(c, 'b').motions.find((m) => !m.loop)!;
    const st = evaluate(c, react.at + 0.3);
    expect(st.actors.find((x) => x.castId === 'b')!.motion!.name).toBe(react.name);
  });
});

describe('timeline: reaction keys are listed as ghost keys with unique ids', () => {
  it('several rule keys of one actor in one line never share a key id (React keys must be unique)', async () => {
    const { buildGroups } = await import('../../web/editor/timeline/lanes');
    const p = miniProject({ style: { 'performance.ruleDirector': true }, beats: [long('l1', 'a', ['a', 'b'], 'happy', 20), long('l2', 'b', ['a', 'b'], 'sad', 6)] });
    const c = compileProject(p, ctxOf({ mA: mk(everyday), mB: mk(everyday) }));
    const groups = buildGroups(p, p.scenes[0]!, 0, c.scenes[0]);
    const ids = groups.flatMap((g) => g.lanes.flatMap((l) => l.keys.map((k) => k.id)));
    const ghosts = ids.filter((i) => i.startsWith('ghost:'));
    expect(ghosts.filter((i) => i.includes(':motion:')).length).toBeGreaterThan(2);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('server: a short-lived Windows file lock does not become a 500', () => {
  it('rename / read retry on EPERM, EBUSY and EACCES, and give up on real errors', async () => {
    const fsp = (await import('node:fs/promises')).default;
    const { renameRetry, readTextRetry } = await import('../../server/util/fsRetry');
    const { vi } = await import('vitest');
    const locked = (code: string) => Object.assign(new Error(code), { code });
    const rename = vi.spyOn(fsp, 'rename').mockRejectedValueOnce(locked('EPERM')).mockRejectedValueOnce(locked('EBUSY')).mockResolvedValue(undefined);
    await expect(renameRetry('a', 'b')).resolves.toBeUndefined();
    expect(rename).toHaveBeenCalledTimes(3);
    rename.mockReset().mockRejectedValue(locked('ENOENT'));
    await expect(renameRetry('a', 'b')).rejects.toMatchObject({ code: 'ENOENT' });
    expect(rename).toHaveBeenCalledTimes(1);
    rename.mockRestore();
    const read = vi.spyOn(fsp, 'readFile').mockRejectedValueOnce(locked('EACCES')).mockResolvedValue('ok' as never);
    await expect(readTextRetry('x')).resolves.toBe('ok');
    read.mockRestore();
  });
});
