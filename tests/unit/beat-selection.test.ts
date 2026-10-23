import { describe, expect, it } from 'vitest';
import { projectSummary } from '../../shared/agent/compact';
import { liveDecision } from '../../shared/agent/live';
import { type BeatPick, agentSelection, beatOrder, clearPick, clickBeat, multiContext, multiIds, rangeBeats, rangesText, toggleBeat } from '../../shared/agent/selection';
import { directedProject } from './helpers/directorFlow';

const P = directedProject();
const order = beatOrder(P);
const s1 = P.scenes[0]!.beats.map((b) => b.id);
const s2 = P.scenes[1]!.beats.map((b) => b.id);

describe('beat multi-selection model', () => {
  it('a plain click selects exactly one beat', () => {
    expect(clickBeat(order, { ids: [s1[0]!, s1[1]!], primary: s1[1]! }, s1[3]!)).toEqual({ ids: [s1[3]], primary: s1[3] });
  });
  it('toggle: the primary beat joins first, then beats are added and removed in script order', () => {
    let pick: BeatPick = { ids: [], primary: s1[1]! };
    pick = toggleBeat(order, pick, s1[4]!);
    expect(pick).toEqual({ ids: [s1[1], s1[4]], primary: s1[4] });
    pick = toggleBeat(order, pick, s1[0]!);
    expect(pick.ids).toEqual([s1[0], s1[1], s1[4]]);
    expect(pick.primary).toBe(s1[0]);
    pick = toggleBeat(order, pick, s1[0]!); // removing the primary hands the primary to a remaining beat
    expect(pick.ids).toEqual([s1[1], s1[4]]);
    expect(pick.primary).toBe(s1[4]);
  });
  it('range: from the primary to the clicked beat, both directions, across scenes', () => {
    expect(rangeBeats(order, { ids: [], primary: s1[1]! }, s1[3]!)).toEqual({ ids: s1.slice(1, 4), primary: s1[3] });
    expect(rangeBeats(order, { ids: [], primary: s1[3]! }, s1[1]!).ids).toEqual(s1.slice(1, 4));
    const across = rangeBeats(order, { ids: [], primary: s1.at(-1)! }, s2[1]!);
    expect(across.ids).toEqual([s1.at(-1), s2[0], s2[1]]);
    expect(rangeBeats(order, { ids: [], primary: null }, s1[2]!)).toEqual({ ids: [s1[2]], primary: s1[2] });
  });
  it('clear keeps the primary beat', () => {
    expect(clearPick({ ids: [s1[0]!, s1[1]!], primary: s1[1]! })).toEqual({ ids: [], primary: s1[1] });
  });
  it('multiIds needs two existing beats; unknown ids are dropped', () => {
    expect(multiIds(P, [s1[2]!])).toEqual([]);
    expect(multiIds(P, [s1[3]!, 'nope', s1[1]!])).toEqual([s1[1], s1[3]]);
  });
  it('the context text names the scene, the count and the beat numbers', () => {
    expect(rangesText([3, 4, 5, 6])).toBe('3–6');
    expect(rangesText([1, 3, 4, 8])).toBe('1、3–4、8');
    expect(multiContext(P, s1.slice(2, 6))).toBe('第1场 · 已选 4 句（第3–6句）');
    expect(multiContext(P, [s1[0]!, s1[2]!])).toBe('第1场 · 已选 2 句（第1、3句）');
    expect(multiContext(P, [s1.at(-1)!, s2[0]!])).toMatch(/^已选 2 句（第1场第\d+句；第2场第1句）$/);
    expect(multiContext(P, [s1[0]!])).toBeNull();
  });
});

describe('assistant request payload', () => {
  const sel = { sceneId: P.scenes[0]!.id, beatId: s1[3]!, castId: null };
  it('a multi-selection sends ordered beatIds; a single one sends none', () => {
    expect(agentSelection(P, sel, [s1[3]!, s1[1]!, s1[2]!])).toEqual({ ...sel, beatIds: [s1[1], s1[2], s1[3]] });
    expect(agentSelection(P, sel, [s1[3]!])).toEqual(sel);
    expect('beatIds' in agentSelection(P, sel, [])).toBe(false);
  });
  it('the agent context lists the selected beats with their text', () => {
    const text = projectSummary(P, { ...sel, beatIds: [s1[1]!, s1[2]!] });
    expect(text).toContain('用户多选了 2 句');
    expect(text).toContain(`第2句 ${s1[1]}`);
    expect(text).toContain(`第3句 ${s1[2]}`);
    expect(text).toContain(P.scenes[0]!.beats[1]!.text.slice(0, 6));
    expect(projectSummary(P, sel)).not.toContain('用户多选了');
    expect(projectSummary(P, { ...sel, beatIds: [s1[1]!] })).not.toContain('用户多选了');
  });
  it('live mode accepts changes in every scene of the selection, and nowhere else', () => {
    const op = (sceneId: string) => ({ tool: 'set_shot', op: { op: 'shot_set', sceneId, beatId: 'x', set: {}, reason: 'r' }, warnings: [], overwrote: [] }) as never;
    const base = { pending: 0, question: false, unverified: 0, stopped: 'done' };
    const a = P.scenes[0]!.id;
    const b = P.scenes[1]!.id;
    expect(liveDecision({ ...base, sceneId: a, applied: [op(a), op(b)] }).reasons).toContain('改动不止当前场景');
    expect(liveDecision({ ...base, sceneId: a, selectedScenes: [a, b], applied: [op(a), op(b)] }).auto).toBe(true);
    expect(liveDecision({ ...base, sceneId: a, selectedScenes: [a, b], applied: [op(P.scenes[2]!.id)] }).auto).toBe(false);
  });
});
