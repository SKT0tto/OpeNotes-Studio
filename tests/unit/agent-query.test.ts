import { describe, expect, it } from 'vitest';
import { applyOp } from '../../shared/agent/apply';
import { BeatFilterSchema, buildIndex, queryTable, runQuery, type BeatFilter } from '../../shared/agent/query';
import { clone } from '../../shared/project/mutate';
import { call, makeEnv } from './helpers/agentEnv';
import { directedProject } from './helpers/directorFlow';

const P = directedProject();
const idx = buildIndex(P);
const q = (f: BeatFilter, project = P) => runQuery(project === P ? idx : buildIndex(project), f);
const ids = (f: BeatFilter) => q(f).rows.map((r) => r.beatId);
const all = (pred: (b: (typeof P)['scenes'][number]['beats'][number], si: number, bi: number) => boolean) => P.scenes.flatMap((s, si) => s.beats.flatMap((b, bi) => (pred(b, si, bi) ? [b.id] : [])));

describe('query_beats filter', () => {
  it('an empty filter matches every beat, in script order', () => {
    expect(ids({})).toEqual(all(() => true));
    expect(q({}).problems).toEqual([]);
  });

  it('scene(s) by id or number, and beat-index ranges (global and per scene)', () => {
    expect(ids({ scenes: [3] })).toEqual(P.scenes[2]!.beats.map((b) => b.id));
    expect(ids({ scenes: ['s_1', 2] })).toEqual([...P.scenes[0]!.beats, ...P.scenes[1]!.beats].map((b) => b.id));
    expect(ids({ scenes: [3], beatFrom: 2, beatTo: 4 })).toEqual(P.scenes[2]!.beats.slice(1, 4).map((b) => b.id));
    expect(ids({ ranges: [{ scene: 1, to: 2 }, { scene: 's_3', from: 27 }] })).toEqual([...P.scenes[0]!.beats.slice(0, 2), ...P.scenes[2]!.beats.slice(26)].map((b) => b.id));
    expect(q({ scenes: [9] }).problems[0]).toContain('找不到第 9 场');
    expect(q({ scenes: ['nope'] }).problems[0]).toContain('找不到场景');
  });

  it('speaker (name, castId, none) and cast (speaker or focus)', () => {
    const tomori = all((b) => b.speakerId === 'c_001');
    expect(tomori.length).toBeGreaterThan(3);
    expect(ids({ speaker: '高松灯' })).toEqual(tomori);
    expect(ids({ speaker: 'c_001' })).toEqual(tomori);
    expect(ids({ speaker: ['c_001', '长崎爽世'] })).toEqual(all((b) => b.speakerId === 'c_001' || b.speakerId === 'c_005'));
    expect(ids({ speaker: 'none' })).toEqual(all((b) => !b.speakerId));
    const involved = ids({ cast: 'c_001' });
    expect(involved).toEqual(expect.arrayContaining(tomori));
    expect(involved.length).toBeGreaterThan(tomori.length); // beats where she is only in the shot focus
    expect(q({ speaker: '不存在的人' }).problems[0]).toContain('找不到角色');
  });

  it('kind, text contains / regex / fuzzy, and character counts', () => {
    expect(ids({ kind: 'silent' })).toEqual(all((b) => b.kind === 'silent'));
    expect(ids({ kind: ['dialogue', 'silent'] })).toEqual(all((b) => b.kind === 'dialogue' || b.kind === 'silent'));
    expect(ids({ text: '你们来了' })).toEqual(['s_3b_15']);
    // a needle that is only punctuation is matched as written (it must not become the empty string that matches everything)
    expect(ids({ text: '……' })).toEqual(all((b) => b.text.includes('……')));
    expect(ids({ text: '……' }).length).toBeLessThan(all(() => true).length);
    expect(ids({ textFuzzy: '……' })).toEqual(ids({ text: '……' }));
    expect(ids({ text: '你们来了' })).toEqual(ids({ textRegex: '^你们来了' }));
    expect(ids({ textRegex: '[？?]$' })).toEqual(all((b) => /[？?]$/.test(b.text)));
    // a misremembered quote still finds the line; an unrelated one finds nothing
    expect(ids({ textFuzzy: '就算走丢了也想再' })).toContain('s_3b_24');
    expect(ids({ textFuzzy: '完全无关的一句话abc' })).toEqual([]);
    expect(ids({ charsMin: 20 })).toEqual(all((b) => [...b.text].length >= 20));
    expect(ids({ charsMax: 5, kind: 'dialogue' })).toEqual(all((b) => b.kind === 'dialogue' && [...b.text].length <= 5));
    expect(q({ textRegex: '(a+)+$' }).problems[0]).toContain('正则太复杂');
    expect(q({ textRegex: '(' }).problems[0]).toContain('正则写错了');
    // catastrophic shapes are refused before they reach V8 (whose regex engine cannot be interrupted): the query answers at once
    const t0 = Date.now();
    for (const re of ['^(.|.)*x$', '^(\\S|\\S)*@$', '(\\d){3,}', '.*.*.*.*.*.*@', '(a)\\1', '[^@]*[^@]*[^@]*@']) expect(q({ textRegex: re }).problems[0]).toContain('正则太复杂');
    expect(Date.now() - t0).toBeLessThan(1000);
    for (const re of ['灯.*爱音', '^.{21,}$', '(?:你|我)好?', '[(.)*]+$', '\\(.*\\)']) expect(q({ textRegex: re }).problems).toEqual([]);
  });

  it('emotion, shot type, intent, flow, move and focus', () => {
    expect(ids({ emotion: 'sad' })).toEqual(all((b) => b.emotion === 'sad'));
    expect(ids({ emotion: 'none' })).toEqual(all((b) => !b.emotion));
    expect(ids({ shotType: ['cu', 'ecu'] })).toEqual(all((b) => b.shot.type === 'cu' || b.shot.type === 'ecu'));
    expect(ids({ move: 'static' })).toEqual(all((b) => b.shot.move === 'static'));
    expect(ids({ focusIncludes: '高松灯' })).toEqual(all((b) => b.shot.focus.includes('c_001')));
    expect(ids({ flow: 'cut' })).toEqual(all((b) => b.shot.transition === 'cut'));
    expect(ids({ flow: 'auto' })).toEqual(all((b) => !b.shot.transition));
  });

  it('fx and its parameters, from the compiled effect state', () => {
    const p = clone(P);
    const s = p.scenes[2]!;
    expect(applyOp(p, { op: 'fx_range', sceneId: 's_3', fromBeatId: s.beats[7]!.id, toBeatId: s.beats[9]!.id, fx: 'memory', tone: 'sepia', strength: 0.6 }, { genId: 'g', now: 1 }).ok).toBe(true);
    const f = (x: BeatFilter) => q(x, p).rows.filter((r) => r.sceneId === 's_3').map((r) => r.beatNo);
    expect(f({ fx: 'memory' })).toEqual([8, 9, 10]);
    expect(f({ fx: 'memory', fxTone: 'sepia' })).toEqual([8, 9, 10]);
    expect(f({ fx: 'memory', fxTone: 'cool' })).toEqual([]);
    expect(f({ fx: 'memory', fxStrengthMax: 0.5 })).toEqual([]);
    expect(f({ fx: 'memory', fxStrengthMin: 0.5 })).toEqual([8, 9, 10]);
    expect(f({ fx: 'any' })).toEqual(expect.arrayContaining([8, 9, 10, 11])); // 11 = the anxiety vignette of the recorded direction
    expect(q({ fx: 'none', scenes: [3] }, p).rows.map((r) => r.beatNo)).not.toContain(8);
  });

  it('background and visible-on-screen actor use the compiled presence (an empty-shot background hides everyone)', () => {
    const p = clone(P);
    const s = p.scenes[2]!;
    const bgId = s.background.assetId;
    expect(ids({ background: bgId, scenes: [3] })).toHaveLength(s.beats.length);
    expect(applyOp(p, { op: 'bg_set', sceneId: 's_3', at: s.beats[5]!.id, assetId: 'adv_bkg_stage_000001', purpose: 'insert' }, { genId: 'g', now: 1 }).ok).toBe(true);
    expect(applyOp(p, { op: 'bg_set', sceneId: 's_3', at: s.beats[8]!.id, assetId: bgId, purpose: 'move' }, { genId: 'g', now: 1 }).ok).toBe(true);
    const rows = (x: BeatFilter) => q(x, p).rows.map((r) => r.beatNo);
    expect(rows({ scenes: [3], bgSwitch: true })).toEqual([6, 9]);
    expect(rows({ scenes: [3], background: 'adv_bkg_stage_000001' })).toEqual([6, 7, 8]);
    expect(rows({ scenes: [3], visibleMax: 0 })).toEqual([6, 7, 8]);
    expect(rows({ scenes: [3], visible: '高松灯' })).not.toContain(7);
    expect(rows({ scenes: [3], hidden: '高松灯' })).toEqual([6, 7, 8]);
    expect(rows({ scenes: [3], visible: ['高松灯', '长崎爽世'], beatTo: 6 })).toEqual([1, 2, 3, 4, 5]);
    expect(rows({ scenes: [3], visibleMin: 5 }).length).toBe(s.beats.length - 3);
  });

  it('pause and duration thresholds', () => {
    const p = clone(P);
    const s = p.scenes[2]!;
    expect(applyOp(p, { op: 'timing', sceneId: 's_3', beatIds: [s.beats[2]!.id, s.beats[3]!.id], set: { 'rhythm.lineGap': 1.2 } }, { genId: 'g', now: 1 }).ok).toBe(true);
    const rows = (x: BeatFilter) => q(x, p).rows.map((r) => r.beatNo);
    expect(rows({ scenes: [3], lineGapMin: 1 })).toEqual([3, 4]);
    expect(rows({ scenes: [3], lineGapMax: 0.5, beatTo: 5 })).toEqual([1, 2, 5]);
    const secs = q({ scenes: [3] }, p).rows.map((r) => r.seconds);
    const cut = (Math.max(...secs) + Math.min(...secs)) / 2;
    const long = rows({ scenes: [3], secondsMin: cut });
    expect(long.length).toBeGreaterThan(0);
    expect(long.length).toBeLessThan(secs.length);
    expect(q({ scenes: [3], secondsMin: cut }, p).rows.every((r) => r.seconds >= cut)).toBe(true);
    expect(rows({ scenes: [3], secondsMax: 0.1 })).toEqual([]);
  });

  it('locked and user-edited flags', () => {
    const p = clone(P);
    p.scenes[2]!.beats[3]!.shot.meta.locked = true;
    p.scenes[2]!.beats[5]!.meta.source = 'user';
    p.scenes[2]!.beats[6]!.style.meta.locked = true;
    const rows = (x: BeatFilter) => q(x, p).rows.map((r) => r.beatNo);
    expect(rows({ scenes: [3], locked: true })).toEqual([4, 7]);
    expect(rows({ scenes: [3], userEdited: true })).toEqual([6]);
    expect(rows({ scenes: [3], locked: false, userEdited: false }).length).toBe(p.scenes[2]!.beats.length - 3);
  });

  it('and / or / not combinators nest and compose', () => {
    const tomori = all((b) => b.speakerId === 'c_001');
    expect(ids({ or: [{ speaker: '高松灯' }, { speaker: '长崎爽世' }] })).toEqual(all((b) => b.speakerId === 'c_001' || b.speakerId === 'c_005'));
    expect(ids({ speaker: '高松灯', not: { shotType: ['cu', 'ecu'] } })).toEqual(all((b) => b.speakerId === 'c_001' && b.shot.type !== 'cu' && b.shot.type !== 'ecu'));
    expect(ids({ scenes: [3], and: [{ or: [{ shotType: 'cu' }, { shotType: 'ecu' }] }, { not: { emotion: 'sad' } }] })).toEqual(all((b, si) => si === 2 && (b.shot.type === 'cu' || b.shot.type === 'ecu') && b.emotion !== 'sad'));
    expect(ids({ not: { not: { speaker: '高松灯' } } })).toEqual(tomori);
    // an empty `or` does not match nothing: it is "no condition"
    expect(ids({ speaker: '高松灯', or: [] })).toEqual(tomori);
  });

  it('unknown keys are rejected by the schema (a typo must not silently match everything)', () => {
    expect(BeatFilterSchema.safeParse({ speakr: '灯' }).success).toBe(false);
    expect(BeatFilterSchema.safeParse({ not: { speaker: '灯', bogus: 1 } }).success).toBe(false);
    expect(BeatFilterSchema.safeParse({ and: [{ or: [{ not: { speaker: '灯' } }] }] }).success).toBe(true);
  });
});

describe('query_beats tool', () => {
  it('returns a queryId, the count, the beat ids and a compact table; large results are truncated but kept whole under the queryId', () => {
    const env = makeEnv();
    const out = call(env, 'query_beats', { filter: { scenes: [3], kind: 'dialogue' }, limit: 5 }) as string;
    const dialogue = P.scenes[2]!.beats.filter((b) => b.kind === 'dialogue');
    expect(out).toContain('queryId=q1');
    expect(out).toContain(`命中 ${dialogue.length} 句`);
    expect(out).toContain('表格只列前 5 句');
    expect(out.split('\n').filter((l) => /^3-\d+\|/.test(l))).toHaveLength(5);
    expect(env.queries!.get('q1')!.map((r) => r.beatId)).toEqual(dialogue.map((b) => b.id));
    expect(env.applied).toHaveLength(0); // read-only
  });

  it('a filter the tool cannot understand is an error, not a wrong answer', () => {
    const env = makeEnv();
    expect((call(env, 'query_beats', { filter: { speaker: '路人甲' } }) as { 错误: string[] }).错误[0]).toContain('找不到角色');
    expect((call(env, 'query_beats', { filter: { speakr: 'x' } }) as { 错误: string[] }).错误[0]).toContain('speakr');
  });

  it('the compact table marks locks and hand edits', () => {
    const p = clone(P);
    p.scenes[2]!.beats[1]!.meta.locked = true;
    const t = queryTable(p, buildIndex(p).rows.filter((r) => r.sceneNo === 3).slice(0, 3), 10);
    expect(t.split('\n').find((l) => l.startsWith('3-2|'))).toMatch(/\|锁$/);
  });
});
