/**
 * The long-line split step of a scene (`DirectorDeps.splitLongLines`): the LineSplit call with a fake provider (first pass, retry, fallback,
 * abort), the soft repair, fixed lines, id stability on regeneration, the diff row, the rule engine, and "flag off = exactly as before".
 * Every line of text in here is original (written for the tests).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { LlmCache } from '../../server/llm/cache';
import { LlmError, zeroUsage, type LlmProvider } from '../../server/llm/provider';
import { FixtureProvider } from '../../server/llm/fixtureProvider';
import { RuleProvider } from '../../server/llm/ruleProvider';
import { runScene, runScenes, type BatchProgress } from '../../server/llm/sceneRunner';
import { SPLIT_SYSTEM } from '../../server/llm/prompts/lineSplit';
import { diffScene } from '../../shared/director/diff';
import { matchBeats } from '../../shared/director/expand';
import { splitParagraphs } from '../../shared/director/paragraphs';
import { splitForDialog } from '../../shared/director/splitLines';
import { applySplitPlans, repairPieces, vagueReason, type PieceDecision } from '../../shared/director/splitPieces';
import type { DirectedBeat, SceneDirection } from '../../shared/schema/ai';
import type { Beat, Project } from '../../shared/schema/project';
import { resolveStyle } from '../../shared/style/ournotes';
import { fitsDialog } from '../../shared/style/dialogLayout';
import { FIXTURE_DIR } from './helpers/directorCatalog';
import { cat, clone, skeleton } from './helpers/directorFlow';

const LONG1 = '我跟你说，这次的合宿我已经全部安排好了！民宿、电车票、练习的时间表，连每天晚上吃什么都写好了！……不过，钱的事我还没跟大家商量。';
const L1A = '我跟你说，这次的合宿我已经全部安排好了！民宿、电车票、练习的时间表，连每天晚上吃什么都写好了！';
const L1B = '……不过，钱的事我还没跟大家商量。';
const LONG2 = '（她说「没事的」的时候，声音一直在抖。我明明听出来了，却什么都没有问……要是那时候我再多说一句就好了。明明我们是最好的朋友，我真没用。）';
const L2A = '（她说「没事的」的时候，声音一直在抖。我明明听出来了，却什么都没有问……）';
const L2B = '（要是那时候我再多说一句就好了。明明我们是最好的朋友，我真没用。）';
const TEXT = ['放学后的教室里，只剩下灯和爱音两个人。', `爱音：“${LONG1}”`, '灯：“嗯。”', LONG2].join('\n');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'linesplit-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

/** One scene over the four paragraphs above, cast c_001 (灯) and c_002 (爱音). */
function project(camera: 'classic' | 'travel' = 'classic'): Project {
  const p = skeleton();
  const paras = splitParagraphs(TEXT);
  const s = clone(p.scenes[0]!);
  s.sourceSpan = { start: paras[0]!.start, end: paras.at(-1)!.end };
  s.beats = [];
  s.tracks = [];
  p.source.text = TEXT;
  p.scenes = [s];
  p.settings = { ...p.settings, cameraSystem: camera };
  return p;
}

const beat = (paragraph: number, kind: 'dialogue' | 'narration', speaker: string | null, text: string) => ({
  keepId: null, paragraph, kind, speaker, text, emotion: 'neutral', reason: 'x',
  shot: { type: 'mcu', focus: speaker ? [speaker] : [], move: 'static', dof: null }, cutIn: 'cut', fx: 'none', actors: [],
});

/** The director's answer: one beat per paragraph; a fixed beat of the request is reproduced with its keepId. */
function sceneAnswer(input: { fixedBeats?: Array<{ keepId: string; paragraph: number; kind: string; speaker: string | null; text: string }> }): unknown {
  const fixed = input.fixedBeats ?? [];
  // a partial regeneration answers with exactly the beats it was given
  if ((input as { mode?: { focusBeatIds?: string[] } }).mode?.focusBeatIds) return { reason: 'r', blocking: [], transitionIn: 'cut', bgm: null, costumeChanges: [], beats: fixed.map((f) => ({ ...beat(f.paragraph, f.kind as 'dialogue', f.speaker, f.text), keepId: f.keepId })) };
  const script = [
    beat(0, 'narration', null, '放学后的教室里，只剩下灯和爱音两个人。'),
    beat(1, 'dialogue', 'c_002', LONG1),
    beat(2, 'dialogue', 'c_001', '嗯。'),
    beat(3, 'dialogue', 'c_001', LONG2),
  ];
  return {
    reason: 'r', blocking: [], transitionIn: 'cut', bgm: null, costumeChanges: [],
    beats: script.map((b) => {
      const f = fixed.find((x) => x.paragraph === b.paragraph);
      return f ? { ...b, keepId: f.keepId, kind: f.kind, speaker: f.speaker, text: f.text } : b;
    }),
  };
}

type SplitHandler = (input: Record<string, unknown>, call: number) => unknown;
interface Call { schemaName: string; input: Record<string, unknown>; system: string }

function fake(split: SplitHandler | Error, opts: { id?: LlmProvider['id']; signal?: AbortSignal } = {}) {
  const calls: Call[] = [];
  let splitCalls = 0;
  const provider: LlmProvider = {
    id: opts.id ?? 'openai', model: 'mock', maxOutputTokens: 16000,
    test: async () => ({ model: 'mock', latencyMs: 1 }),
    generateStructured: async (req) => {
      const input = req.input as Record<string, unknown>;
      calls.push({ schemaName: req.schemaName, input, system: req.system });
      let out: unknown;
      if (req.schemaName === 'LineSplit') {
        splitCalls++;
        if (split instanceof Error) throw split;
        out = split(input, splitCalls);
        if (out instanceof Error) throw out;
      } else out = sceneAnswer(input as never);
      const raw = JSON.stringify(out);
      const parsed = req.schema.safeParse(out);
      if (!parsed.success) throw new LlmError('invalid_output', 'schema', { raw, issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) });
      return { data: parsed.data as never, usage: zeroUsage(), raw, warnings: [] };
    },
  };
  return { provider, calls, splitCalls: () => calls.filter((c) => c.schemaName === 'LineSplit') };
}

const piece = (text: string, over: Record<string, unknown> = {}) => ({ text, why: '情绪转折', emotion: 'neutral', camera: 'hold', reactionOf: null, actor: null, ...over });
const GOOD: SplitHandler = () => ({
  lines: [
    { id: 'L1', pieces: [piece(L1A, { emotion: 'happy' }), piece(L1B, { emotion: 'shy', why: '得意说完，心虚地坦白', actor: { motion: 'sad01', expression: 'exp_sad01', attention: 'down' } })] },
    { id: 'L2', pieces: [piece(L2A, { emotion: 'sad' }), piece(L2B, { emotion: 'sad', camera: 'closer', why: '停顿后转为自责', actor: { motion: null, expression: 'exp_sad01', attention: 'down' } })] },
  ],
});

const run = (provider: LlmProvider, p: Project, over: Record<string, unknown> = {}) =>
  runScene({ provider, cache: null, catalog: cat, now: () => 5000, splitLongLines: true, ...over }, { project: p, sceneId: p.scenes[0]!.id, scopes: ['scene'] }, 'g');

const style = (p: Project) => resolveStyle(p.style, p.scenes[0]!.style).values.dialog;
const texts = (bs: readonly Beat[]) => bs.map((b) => b.text);

describe('the corpus used here really is too long', () => {
  it('the two long lines are over the default two lines, the rest is not', () => {
    const st = style(project());
    expect(fitsDialog(LONG1, st).over).toBe(true);
    expect(fitsDialog(LONG2, st).over).toBe(true);
    for (const t of [L1A, L1B, L2A, L2B, '嗯。']) expect(fitsDialog(t, st).over).toBe(false);
  });
});

describe('LineSplit with a fake model', () => {
  it('first answer passes: the lines are cut, the pieces are continuations of the first piece, one done result', async () => {
    const p = project();
    const f = fake(GOOD);
    const starts: number[] = [];
    const r = await runScene({ provider: f.provider, cache: null, catalog: cat, now: () => 5000, splitLongLines: true }, { project: p, sceneId: p.scenes[0]!.id, scopes: ['scene'] }, 'g', { onSplitStart: (n) => starts.push(n) });
    expect(starts).toEqual([2]);
    expect(f.splitCalls()).toHaveLength(1);
    expect(f.calls.filter((c) => c.schemaName !== 'LineSplit')).toHaveLength(1);
    const bs = r.scene.beats;
    expect(texts(bs)).toEqual(['放学后的教室里，只剩下灯和爱音两个人。', L1A, L1B, '嗯。', L2A, L2B]);
    expect(bs[2]!.splitFrom).toBe(bs[1]!.id);
    expect(bs[5]!.splitFrom).toBe(bs[4]!.id);
    expect(bs[1]!.splitFrom).toBeUndefined();
    // same speaker and kind as the line they were cut from, a hard cut, nothing the director never writes
    expect(bs[2]!.speakerId).toBe('c_002');
    expect(bs[5]!.speakerId).toBe('c_001');
    expect(bs.every((b) => b.cutIn === 'cut' && b.overflow === undefined && !('overflow' in b))).toBe(true);
    for (const b of bs) expect(fitsDialog(b.text, style(p)).over).toBe(false);
    expect(r.splits).toHaveLength(2);
    expect(r.splits![0]).toMatchObject({ beatId: bs[1]!.id, pieceBeatIds: [bs[2]!.id], by: 'ai' });
    expect(r.splits![0]!.pieces.map((x) => x.why)).toEqual(['情绪转折', '得意说完，心虚地坦白']);
    expect(r.runs.map((x) => x.pass)).toEqual(['scene', 'split']);
    expect(r.warnings.filter((w) => w.includes('第'))).toEqual([]);
    // the second piece's performance became keys on it; the closer piece asks for a tighter shot
    const exprKeys = (r.scene.tracks as Array<{ channel: string; keys: Array<{ at: { beatId: string }; value: { name: string } }> }>).filter((t) => t.channel === 'expression').flatMap((t) => t.keys);
    expect(exprKeys.some((k) => k.at.beatId === bs[2]!.id && k.value.name === 'exp_sad01')).toBe(true);
    expect(bs[5]!.shot.type).toBe('cu');
    expect(bs[4]!.shot.type).toBe('mcu');
    expect(bs[2]!.shot.type).toBe(bs[1]!.shot.type);
    expect(bs[2]!.shot.move).toBe('static');
  });

  it('the request: the model gets the measured lines, min / max pieces, the speaker\'s real lists, the wrapper', async () => {
    const f = fake(GOOD);
    await run(f.provider, project());
    const req = f.splitCalls()[0]!;
    expect(req.system).toBe(SPLIT_SYSTEM);
    const input = req.input as { box: { maxLines: number; charsPerLine: number }; lines: Array<Record<string, unknown>>; cast: Array<{ castId: string; expressions: string[]; motions: string[] }> };
    expect(input.box).toMatchObject({ maxLines: 2, charsPerLine: 31 });
    expect(input.lines.map((l) => l.id)).toEqual(['L1', 'L2']);
    expect(input.lines[0]).toMatchObject({ speaker: 'c_002', text: LONG1, measuredLines: 3, minPieces: 2, maxPieces: 3, wrapped: null });
    expect(input.lines[1]).toMatchObject({ speaker: 'c_001', wrapped: '（）' });
    expect(input.lines[0]!.before).toEqual([{ speaker: null, text: '放学后的教室里，只剩下灯和爱音两个人。' }]);
    const c002 = input.cast.find((c) => c.castId === 'c_002')!;
    expect(c002.expressions).toContain('exp_sad01');
    expect(c002.motions).toContain('sad01');
  });

  it('pieces of one answer are checked: a repaired wrapper is not an error', async () => {
    const f = fake(() => ({
      lines: [
        { id: 'L1', pieces: [piece(L1A), piece(L1B)] },
        // the model forgot the brackets on the second piece: put back by the checker
        { id: 'L2', pieces: [piece(L2A), piece(L2B.slice(1, -1))] },
      ],
    }));
    const r = await run(f.provider, project());
    expect(f.splitCalls()).toHaveLength(1);
    expect(texts(r.scene.beats).slice(-2)).toEqual([L2A, L2B]);
    expect(r.splits!.map((s) => s.by)).toEqual(['ai', 'ai']);
  });

  it('a wrong answer is retried ONCE with only the failing line and the problem text; the retry is accepted', async () => {
    const f = fake((_i, n) => (n === 1
      ? { lines: [{ id: 'L1', pieces: [piece(L1A + '的'), piece(L1B)] }, { id: 'L2', pieces: [piece(L2A), piece(L2B)] }] }
      : { lines: [{ id: 'L1', pieces: [piece(L1A), piece(L1B)] }] }));
    const r = await run(f.provider, project());
    expect(f.splitCalls()).toHaveLength(2);
    const retry = f.splitCalls()[1]!.input as { originalInput: { lines: Array<{ id: string }> }; problems: string[]; previousOutput: string };
    expect(retry.originalInput.lines.map((l) => l.id)).toEqual(['L1']);
    expect(retry.problems.join('\n')).toMatch(/L1：拼接后与原文不同/);
    expect(retry.previousOutput).toContain('L1');
    expect(retry.previousOutput).not.toContain(L2B);
    expect(r.splits!.map((s) => s.by)).toEqual(['retry', 'ai']);
    expect(r.runs.find((x) => x.pass === 'split')!.repaired).toBe(true);
    expect(texts(r.scene.beats)).toContain(L1B);
  });

  it('a line that fails twice is cut by punctuation with a warning; the scene completes', async () => {
    const f = fake((_i, n) => ({ lines: [{ id: 'L1', pieces: [piece(n === 1 ? '乱写的' : L1A.slice(0, 5)), piece(L1B)] }, { id: 'L2', pieces: [piece(L2A), piece(L2B)] }].filter((x) => n === 1 || x.id === 'L1') }));
    const r = await run(f.provider, project());
    expect(f.splitCalls()).toHaveLength(2);
    const want = splitForDialog(LONG1, style(project()), 'normal').pieces;
    expect(texts(r.scene.beats).slice(1, 1 + want.length)).toEqual(want);
    expect(r.splits![0]!.by).toBe('rule');
    expect(r.splits![1]!.by).toBe('ai');
    expect(r.warnings.some((w) => w.includes('AI 拆分两次不合格，已按标点拆分') && w.includes('第 2 句'))).toBe(true);
    expect(r.applied).toBe(true);
  });

  it('a line cut into too many pieces is a problem (min + 1 at most)', async () => {
    const four = [L1A.slice(0, 20), L1A.slice(20, 45), L1A.slice(45), L1B];
    const f = fake((_i, n) => ({ lines: [{ id: 'L1', pieces: (n === 1 ? four : [L1A, L1B]).map((t) => piece(t)) }, { id: 'L2', pieces: [piece(L2A), piece(L2B)] }].filter((x) => n === 1 || x.id === 'L1') }));
    const r = await run(f.provider, project());
    expect((f.splitCalls()[1]!.input as { problems: string[] }).problems.join('')).toContain('最多');
    expect(r.splits![0]!.by).toBe('retry');
  });

  it('a call that fails (network) cuts the whole scene by punctuation with one warning per line; no abort', async () => {
    const f = fake(new LlmError('network', '连不上'));
    const r = await run(f.provider, project());
    expect(f.splitCalls()).toHaveLength(1);
    expect(r.splits!.map((s) => s.by)).toEqual(['rule', 'rule']);
    expect(r.warnings.filter((w) => w.includes('长句拆分调用失败（连不上），已按标点拆分'))).toHaveLength(2);
    for (const b of r.scene.beats) expect(fitsDialog(b.text, style(project())).over).toBe(false);
    expect(r.applied).toBe(true);
  });

  it('malformed output is retried once like a wrong answer, then falls back', async () => {
    const f = fake(() => ({ nonsense: true }));
    const r = await run(f.provider, project());
    expect(f.splitCalls()).toHaveLength(2);
    expect(r.splits!.map((s) => s.by)).toEqual(['rule', 'rule']);
  });

  it('an abort is rethrown (LlmError aborted, an AbortError, an aborted signal), never turned into a fallback', async () => {
    await expect(run(fake(new LlmError('aborted', '已取消')).provider, project())).rejects.toMatchObject({ kind: 'aborted' });
    const abortErr = Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
    await expect(run(fake(abortErr).provider, project())).rejects.toMatchObject({ name: 'AbortError' });
    const ctl = new AbortController();
    const f = fake(() => { ctl.abort(); return new Error('socket hang up'); });
    await expect(run(f.provider, project(), { signal: ctl.signal })).rejects.toThrow();
    // an abort during the retry too
    const g = fake((_i, n) => (n === 1 ? { lines: [{ id: 'L1', pieces: [piece('坏的')] }, { id: 'L2', pieces: [piece(L2A), piece(L2B)] }] } : new LlmError('aborted', '已取消')));
    await expect(run(g.provider, project())).rejects.toMatchObject({ kind: 'aborted' });
  });

  it('a cut-off answer is asked again for each half of the lines', async () => {
    const f = fake((input, n) => {
      const ids = (input.lines as Array<{ id: string }>).map((l) => l.id);
      if (n === 1) return new LlmError('truncated', '截断');
      return { lines: ids.map((id) => (id === 'L1' ? { id, pieces: [piece(L1A), piece(L1B)] } : { id, pieces: [piece(L2A), piece(L2B)] })) };
    });
    const r = await run(f.provider, project());
    expect(f.splitCalls().map((c) => (c.input.lines as unknown[]).length)).toEqual([2, 1, 1]);
    expect(r.splits!.map((s) => s.by)).toEqual(['ai', 'ai']);
  });

  it('the repaired answer also answers the original request: the second run asks nothing', async () => {
    const cache = new LlmCache(path.join(tmp, 'c1'));
    const f = fake((_i, n) => (n === 1
      ? { lines: [{ id: 'L1', pieces: [piece('坏')] }, { id: 'L2', pieces: [piece(L2A), piece(L2B)] }] }
      : { lines: [{ id: 'L1', pieces: [piece(L1A), piece(L1B)] }] }));
    const first = await run(f.provider, project(), { cache });
    expect(f.splitCalls()).toHaveLength(2);
    const g = fake(new Error('must not be called'));
    const second = await run(g.provider, project(), { cache });
    expect(g.calls).toHaveLength(0);
    expect(texts(second.scene.beats)).toEqual(texts(first.scene.beats));
    expect(second.runs.every((x) => x.cached)).toBe(true);
  });
});

describe('soft repair of what the model decided', () => {
  it('unknown motion / expression names become real ones (or go), an attention that is not on stage goes', async () => {
    const f = fake(() => ({
      lines: [
        { id: 'L1', pieces: [piece(L1A), piece(L1B, { actor: { motion: 'dance99', expression: 'exp_laugh77', attention: 'c_009' } })] },
        { id: 'L2', pieces: [piece(L2A), piece(L2B)] },
      ],
    }));
    const p = project();
    const r = await run(f.provider, p);
    const m = cat.models.find((x) => x.id === p.scenes[0]!.wardrobe['c_002']!.modelId)!;
    const keys = (r.scene.tracks as Array<{ channel: string; target: { kind: string; castId?: string }; keys: Array<{ at: { beatId: string }; value: { name: string } }> }>)
      .filter((t) => t.target.castId === 'c_002').flatMap((t) => t.keys.map((k) => ({ channel: t.channel, ...k })));
    const onPiece = keys.filter((k) => k.at.beatId === r.scene.beats[2]!.id);
    for (const k of onPiece.filter((x) => x.channel === 'motion')) expect(m.motions.map((x) => x.family)).toContain(k.value.name);
    for (const k of onPiece.filter((x) => x.channel === 'expression')) expect(m.expressions.map((x) => x.name)).toContain(k.value.name);
    expect(r.warnings.some((w) => w.includes('c_009') && w.includes('不在台上'))).toBe(true);
  });

  const ctx = { speaker: 'c_002', onStage: new Set(['c_001', 'c_002']), emotion: 'happy', resolveMotion: (w: string) => w, resolveExpression: (w: string) => w, where: '第 2 句' };
  const raw = (camera: string, why: string, reactionOf: string | null = null) => ({ text: 'x', why, emotion: 'sad' as const, camera: camera as 'hold', reactionOf, actor: null });

  it('a reaction whose listener is not on stage (or is the speaker) becomes hold, with a warning', () => {
    const a = repairPieces([raw('hold', ''), raw('reaction', '坦白后对方愣住', 'c_009')], ['a', 'b'], ctx);
    expect(a.pieces[1]!.camera).toBe('hold');
    expect(a.pieces[1]!.reactionOf).toBeNull();
    expect(a.warnings.join()).toContain('听者不在台上');
    expect(repairPieces([raw('hold', ''), raw('reaction', '坦白后对方愣住', 'c_002')], ['a', 'b'], ctx).pieces[1]!.camera).toBe('hold');
    expect(repairPieces([raw('hold', ''), raw('reaction', '坦白后对方愣住', 'c_001')], ['a', 'b'], ctx).pieces[1]).toMatchObject({ camera: 'reaction', reactionOf: 'c_001' });
  });

  it('a non-hold piece needs a concrete reason, and a line gets at most one', () => {
    expect(vagueReason('需要运镜')).toBe(true);
    expect(vagueReason('强调')).toBe(true);
    expect(vagueReason('停顿后说出真心话')).toBe(false);
    const a = repairPieces([raw('hold', ''), raw('closer', '强调'), raw('closer', '哽咽着说出真话')], ['a', 'b', 'c'], ctx);
    expect(a.pieces.map((x) => x.camera)).toEqual(['hold', 'hold', 'closer']);
    const b = repairPieces([raw('hold', ''), raw('closer', '哽咽着说出真话'), raw('closer', '终于哭了出来')], ['a', 'b', 'c'], ctx);
    expect(b.pieces.map((x) => x.camera)).toEqual(['hold', 'closer', 'hold']);
    expect(b.warnings.join()).toContain('最多一段');
  });

  it('the first piece keeps the camera and performance, and a narration never changes the camera', () => {
    const a = repairPieces([{ ...raw('closer', '哽咽着说出真话'), actor: { motion: 'nod01', expression: null, attention: null } }, raw('closer', '哽咽着说出真话')], ['a', 'b'], { ...ctx, speaker: null });
    expect(a.pieces.map((x) => x.camera)).toEqual(['hold', 'hold']);
    expect(a.pieces[0]!.actor).toBeNull();
  });
});

describe('camera of the continuations', () => {
  it('classic: no intent / flow on any piece; travel: hold = continue / auto, closer = emphasis, reaction = reaction / cut', async () => {
    const f = fake(() => ({
      lines: [
        { id: 'L1', pieces: [piece(L1A), piece(L1B, { camera: 'reaction', reactionOf: 'c_001', why: '坦白让灯愣住' })] },
        { id: 'L2', pieces: [piece(L2A), piece(L2B, { camera: 'closer', why: '停顿后转为自责' })] },
      ],
    }));
    const t = await run(f.provider, project('travel'));
    const bs = t.direction.beats;
    expect(bs.map((b) => b.splitOf)).toEqual([undefined, undefined, 1, undefined, undefined, 4]);
    expect(bs[2]!.shot).toMatchObject({ type: 'cu', focus: ['c_001'], intent: 'reaction', flow: 'cut', move: 'static' });
    expect(bs[5]!.shot).toMatchObject({ type: 'cu', focus: ['c_001'], intent: 'emphasis', flow: 'auto' });
    const hold = await run(fake(GOOD).provider, project('travel'));
    expect(hold.direction.beats[2]!.shot).toMatchObject({ type: 'mcu', intent: 'continue', flow: 'auto', move: 'static' });
    const c = await run(fake(GOOD).provider, project('classic'));
    for (const b of c.direction.beats.filter((x) => x.splitOf !== undefined)) {
      expect(b.shot.intent).toBeUndefined();
      expect(b.shot.flow).toBeUndefined();
    }
  });

  it('a cut-in dip and a one-shot fx stay on the first piece; a memory carries on', () => {
    const base = beat(1, 'dialogue', 'c_002', 'x') as unknown as DirectedBeat;
    const d = { reason: '', blocking: [], transitionIn: 'cut', bgm: null, costumeChanges: [{ beatIndex: 1, castId: 'c_002', modelId: 'm', reason: '' }], beats: [{ ...base, fx: 'flash', cutIn: 'dip_black' }, { ...base, fx: 'memory', cutIn: 'dip_white' }, { ...base }] } as unknown as SceneDirection;
    const pieces = (n: number): PieceDecision[] => Array.from({ length: n }, (_, k) => ({ text: `t${k}`, emotion: 'neutral', why: '长句续行', camera: 'hold', reactionOf: null, actor: null }));
    const out = applySplitPlans(d, [{ index: 0, pieces: pieces(2), by: 'rule' }, { index: 1, pieces: pieces(3), by: 'rule' }], { travel: false });
    expect(out.beats.map((b) => [b.fx, b.cutIn])).toEqual([['flash', 'dip_black'], ['none', 'cut'], ['memory', 'dip_white'], ['memory', 'cut'], ['memory', 'cut'], ['none', 'cut']]);
    expect(out.beats.map((b) => b.splitOf)).toEqual([undefined, 0, undefined, 2, 2, undefined]);
    // the costume change belongs to the beat it was on, now at index 2
    expect(out.costumeChanges[0]!.beatIndex).toBe(2);
  });
});

describe('fixed lines are never cut', () => {
  const generate = async () => {
    const p = project();
    const f = fake(GOOD);
    const r = await run(f.provider, p);
    return { p: { ...p, scenes: [r.scene] } as Project, r };
  };

  it('a locked, a hand-made and an expanded line are given to the model as fixed and are left as they are', async () => {
    const { p } = await generate();
    const s = p.scenes[0]!;
    // the first long line was edited by hand (and so can stay long), the second is locked, a third copy is expanded
    const head1 = s.beats[1]!;
    const head2 = s.beats[4]!;
    for (const [mode, target] of [['user', head1], ['locked', head2], ['expand', head1]] as const) {
      const q = clone(p);
      const b = q.scenes[0]!.beats.find((x) => x.id === target.id)!;
      b.text = target === head1 ? LONG1 : LONG2;
      if (mode === 'user') b.meta = { ...b.meta, source: 'user' };
      if (mode === 'locked') b.meta = { ...b.meta, locked: true };
      if (mode === 'expand') b.overflow = 'expand';
      // the pieces after it would be regenerated as well; drop them so the paragraph is plain
      q.scenes[0]!.beats = q.scenes[0]!.beats.filter((x) => x.splitFrom !== b.id);
      const f = fake(GOOD);
      const r = await run(f.provider, q);
      const kept = r.scene.beats.find((x) => x.id === b.id)!;
      expect(kept.text).toBe(b.text);
      expect(kept.splitFrom).toBeUndefined();
      if (mode === 'expand') expect(kept.overflow).toBe('expand');
      // the other long line is still cut; the fixed one is not in the model's request
      const asked = f.splitCalls()[0]!.input as { lines: Array<{ text: string }> };
      expect(asked.lines.map((l) => l.text)).toEqual([target === head1 ? LONG2 : LONG1]);
      const fixed = (f.calls.find((c) => c.schemaName !== 'LineSplit')!.input as { fixedBeats: Array<{ keepId: string }> }).fixedBeats;
      expect(fixed.map((x) => x.keepId)).toContain(b.id);
    }
  });

  it('when every long line is fixed there is no second call at all', async () => {
    const { p } = await generate();
    const q = clone(p);
    for (const i of [1, 4]) {
      const b = q.scenes[0]!.beats[i]!;
      b.text = i === 1 ? LONG1 : LONG2;
      b.meta = { ...b.meta, locked: true };
    }
    q.scenes[0]!.beats = q.scenes[0]!.beats.filter((x) => x.splitFrom === undefined);
    const f = fake(new Error('must not be called'));
    const r = await run(f.provider, q);
    expect(f.splitCalls()).toHaveLength(0);
    expect(r.splits).toBeUndefined();
  });

  it('a locked continuation keeps pointing at its first piece', async () => {
    const { p } = await generate();
    const q = clone(p);
    const piece2 = q.scenes[0]!.beats[2]!;
    piece2.meta = { ...piece2.meta, locked: true };
    const r = await run(fake(GOOD).provider, q);
    const again = r.scene.beats.find((b) => b.id === piece2.id)!;
    expect(again.splitFrom).toBe(q.scenes[0]!.beats[1]!.id);
  });
});

describe('ids stay put when a scene is generated again', () => {
  it('the same answer twice: every id, including those of the continuations, is the same', async () => {
    const p = project();
    const a = await run(fake(GOOD).provider, p);
    const q = { ...p, scenes: [a.scene] } as Project;
    const b = await run(fake(GOOD).provider, q);
    expect(b.scene.beats.map((x) => x.id)).toEqual(a.scene.beats.map((x) => x.id));
    expect(b.scene.beats.map((x) => x.splitFrom)).toEqual(a.scene.beats.map((x) => x.splitFrom));
  });

  it('one more piece: only the new one has a new id, the ordinary lines after it keep theirs', async () => {
    const p = project();
    const two = await run(fake(GOOD).provider, p);
    const third = [L1A.slice(0, 20), L1A.slice(20), L1B];
    const q = { ...p, scenes: [two.scene] } as Project;
    const three = await run(fake(() => ({ lines: [{ id: 'L1', pieces: third.map((t) => piece(t)) }, { id: 'L2', pieces: [piece(L2A), piece(L2B)] }] })).provider, q);
    const old = two.scene.beats;
    const now = three.scene.beats;
    expect(now).toHaveLength(old.length + 1);
    // beats: narration, head, piece, piece(new), 嗯, head2, piece2
    expect(now[0]!.id).toBe(old[0]!.id);
    expect(now[1]!.id).toBe(old[1]!.id);
    expect(now[2]!.id).toBe(old[2]!.id);
    expect(old.map((b) => b.id)).not.toContain(now[3]!.id);
    expect(now[3]!.splitFrom).toBe(old[1]!.id);
    expect(now.slice(4).map((b) => b.id)).toEqual(old.slice(3).map((b) => b.id));
    // and back to two: the surplus piece goes, the others keep their ids
    const back = await run(fake(GOOD).provider, { ...p, scenes: [three.scene] } as Project);
    expect(back.scene.beats.map((b) => b.id)).toEqual(old.map((b) => b.id));
  });

  it('matchBeats: continuations do not take part in the paragraph / speaker count, and are found by first piece + number', () => {
    const paras = splitParagraphs('甲\n乙\n丙');
    const mk = (id: string, para: number, speaker: string, extra: Partial<Beat> = {}): Beat => ({
      id, kind: 'dialogue', variant: 'normal', coSpeakers: [], cutIn: 'cut', cutInKeepDialog: false, text: id, sourceOffset: paras[para]!.start, duration: { mode: 'auto', seconds: 0 },
      shot: { type: 'mcu', focus: [], move: 'static', meta: { source: 'ai', locked: false } }, style: { overrides: {}, meta: { source: 'rule', locked: false } }, meta: { source: 'ai', locked: false }, speakerId: speaker, ...extra,
    } as Beat);
    const old = [mk('A', 0, 'x'), mk('A2', 0, 'x', { splitFrom: 'A' }), mk('A3', 0, 'x', { splitFrom: 'A' }), mk('B', 0, 'x'), mk('C', 1, 'y')];
    const d = (paragraph: number, speaker: string, text: string, splitOf?: number) => ({ ...(beat(paragraph, 'dialogue', speaker, text) as object), ...(splitOf !== undefined ? { splitOf } : {}) }) as unknown as DirectedBeat;
    // A cut into three again, B and C as before
    expect(matchBeats(old, [d(0, 'x', 'a'), d(0, 'x', 'a2', 0), d(0, 'x', 'a3', 0), d(0, 'x', 'b'), d(1, 'y', 'c')], paras)).toEqual(['A', 'A2', 'A3', 'B', 'C']);
    // A cut into four: the fourth is new, B and C keep their ids
    expect(matchBeats(old, [d(0, 'x', 'a'), d(0, 'x', 'a2', 0), d(0, 'x', 'a3', 0), d(0, 'x', 'a4', 0), d(0, 'x', 'b'), d(1, 'y', 'c')], paras)).toEqual(['A', 'A2', 'A3', null, 'B', 'C']);
    // A cut into two: A3 is gone, B and C keep their ids
    expect(matchBeats(old, [d(0, 'x', 'a'), d(0, 'x', 'a2', 0), d(0, 'x', 'b'), d(1, 'y', 'c')], paras)).toEqual(['A', 'A2', 'B', 'C']);
    // an old project that was never cut: the first piece takes the old id, the pieces are new
    expect(matchBeats([mk('A', 0, 'x'), mk('B', 0, 'x')], [d(0, 'x', 'a'), d(0, 'x', 'a2', 0), d(0, 'x', 'b')], paras)).toEqual(['A', null, 'B']);
    // text match never claims an old continuation for an ordinary line
    expect(matchBeats([mk('A', 0, 'x'), mk('A2', 0, 'x', { splitFrom: 'A', text: 'zz' })], [d(0, 'x', 'a'), d(2, 'z', 'zz')], paras)).toEqual(['A', null]);
  });
});

describe('the change card: one row for a cut line', () => {
  it('diffScene groups the first piece and the new pieces into 拆成 N 句', async () => {
    const p = project();
    const r = await run(fake(GOOD).provider, p);
    void r;
    // the scene as it was before the split (the long lines whole), generated again with the split on: the ids of the lines that were there stay
    const before = await run(fake(GOOD).provider, p, { splitLongLines: false });
    const again = await run(fake(GOOD).provider, { ...p, scenes: [before.scene] } as Project);
    const diff = diffScene(before.scene, again.scene, (id) => id);
    const rows = diff.items.filter((i) => i.field.startsWith('拆成'));
    expect(rows.map((x) => x.field)).toEqual(['拆成 2 句', '拆成 2 句']);
    expect(rows[0]!.where).toBe('第2句');
    expect(rows[0]!.before.startsWith('我跟你说')).toBe(true);
    expect(rows[0]!.after).toContain('｜');
    expect(diff.items.some((i) => i.field === '新增台词')).toBe(false);
    expect(diff.items.filter((i) => i.field === '台词')).toHaveLength(0);
    expect(diff.structural).toBe(true);
  });

  it('a line that is new together with its pieces is shown as the new lines they are', async () => {
    const p = project();
    const r = await run(fake(GOOD).provider, p);
    const diff = diffScene({ ...r.scene, beats: [] , tracks: [] }, r.scene);
    expect(diff.items.filter((i) => i.field === '新增台词')).toHaveLength(r.scene.beats.length);
  });
});

describe('the flag off is exactly what it was', () => {
  const strip = (r: Awaited<ReturnType<typeof run>>) => JSON.stringify({ scene: r.scene, direction: r.direction, warnings: r.warnings, report: r.report, runs: r.runs.map((x) => ({ ...x, ms: 0 })) });

  it('flag off (absent / false) gives identical output and sends no LineSplit; the scene request is the same with the flag on', async () => {
    const p = project();
    const absent = fake(GOOD);
    const a = await runScene({ provider: absent.provider, cache: null, catalog: cat, now: () => 5000 }, { project: p, sceneId: p.scenes[0]!.id, scopes: ['scene'] }, 'g');
    const off = fake(GOOD);
    const b = await run(off.provider, p, { splitLongLines: false });
    const on = fake(GOOD);
    await run(on.provider, p);
    expect(strip(a)).toBe(strip(b));
    expect(absent.splitCalls()).toHaveLength(0);
    expect(off.splitCalls()).toHaveLength(0);
    expect(a.splits).toBeUndefined();
    expect(a.scene.beats.every((x) => x.splitFrom === undefined && !('overflow' in x))).toBe(true);
    // the long lines are still whole
    expect(texts(a.scene.beats)).toContain(LONG1);
    // the director's own request is byte-identical with the flag on
    const sceneReq = (f: ReturnType<typeof fake>) => JSON.stringify(f.calls.filter((c) => c.schemaName !== 'LineSplit').map((c) => [c.schemaName, c.system, c.input]));
    expect(sceneReq(on)).toBe(sceneReq(absent));
  });

  it('regenerating only some beats or only the camera never cuts, flag on', async () => {
    const p = project();
    const first = await run(fake(GOOD).provider, p, { splitLongLines: false });
    const q = { ...p, scenes: [first.scene] } as Project;
    const f = fake(new Error('must not be called'));
    const r = await runScene({ provider: f.provider, cache: null, catalog: cat, now: () => 5000, splitLongLines: true }, { project: q, sceneId: q.scenes[0]!.id, scopes: ['camera'] }, 'g');
    expect(f.splitCalls()).toHaveLength(0);
    expect(r.scene.beats.every((b) => b.splitFrom === undefined)).toBe(true);
    const r2 = await runScene({ provider: f.provider, cache: null, catalog: cat, now: () => 5000, splitLongLines: true }, { project: q, sceneId: q.scenes[0]!.id, scopes: ['performance'], beatIds: [q.scenes[0]!.beats[1]!.id] }, 'g');
    expect(f.splitCalls()).toHaveLength(0);
    expect(r2.scene.beats.every((b) => b.splitFrom === undefined)).toBe(true);
  });
});

describe('the rule engine with the flag on', () => {
  it('cuts the long lines by punctuation without any model call or warning, and everything fits', async () => {
    const p = project();
    const provider = new RuleProvider(cat);
    const r = await runScene({ provider, cache: null, catalog: cat, now: () => 5000, splitLongLines: true }, { project: p, sceneId: p.scenes[0]!.id, scopes: ['scene'] }, 'g');
    for (const b of r.scene.beats) expect(fitsDialog(b.text, style(p)).over).toBe(false);
    expect(r.scene.beats.some((b) => b.splitFrom !== undefined)).toBe(true);
    expect(r.runs.every((x) => x.pass === 'scene')).toBe(true);
    expect(r.scene.beats.every((b) => !('overflow' in b))).toBe(true);
    for (const s of r.splits ?? []) expect(s.by).toBe('rule');
    // the cut text is the original text, in order
    const spoken = r.scene.beats.filter((b) => b.kind === 'dialogue').map((b) => b.text).join('');
    expect(spoken.startsWith(LONG1.slice(0, 20))).toBe(true);
    expect(spoken).toContain('不过，钱的事我还没跟大家商量。');
    // and the same text without the flag is whole
    const whole = await runScene({ provider, cache: null, catalog: cat, now: () => 5000 }, { project: p, sceneId: p.scenes[0]!.id, scopes: ['scene'] }, 'g');
    expect(whole.scene.beats.some((b) => b.splitFrom !== undefined)).toBe(false);
  });
});

describe('progress stream', () => {
  it('a scene with long lines sends a second start event with phase split and the count; scenes without send none', async () => {
    const p = project();
    const f = fake(GOOD);
    const seen: BatchProgress[] = [];
    const items = await runScenes({ provider: f.provider, cache: null, catalog: cat, now: () => 5000, splitLongLines: true }, p, [p.scenes[0]!.id], ['scene'], 'g', 1, (x) => seen.push({ ...x, result: undefined }));
    expect(items[0]!.result?.applied).toBe(true);
    expect(seen.map((x) => [x.state, x.phase ?? null, x.count ?? null])).toEqual([['start', null, null], ['start', 'split', 2], ['done', null, null]]);
    const off: BatchProgress[] = [];
    await runScenes({ provider: fake(GOOD).provider, cache: null, catalog: cat, now: () => 5000 }, p, [p.scenes[0]!.id], ['scene'], 'g', 1, (x) => off.push(x));
    expect(off.map((x) => x.state)).toEqual(['start', 'done']);
  });
});

describe('the recorded-response provider has no LineSplit recording', () => {
  it('it refuses the call (bad_request), so a scene with a long line is cut by punctuation with a warning, never fails', async () => {
    const fx = new FixtureProvider(FIXTURE_DIR);
    await expect(fx.generateStructured({ system: '', input: { lines: [] }, schema: (await import('../../shared/schema/ai')).LineSplitSchema, schemaName: 'LineSplit', maxTokens: 100 })).rejects.toMatchObject({ kind: 'bad_request' });
    // the same through the scene: a model whose LineSplit call is refused like the fixture's
    const f = fake(new LlmError('bad_request', '没有可回放的录制响应：LineSplit'), { id: 'fixture' });
    const r = await run(f.provider, project());
    expect(r.splits!.map((s) => s.by)).toEqual(['rule', 'rule']);
    expect(r.warnings.filter((w) => w.includes('长句拆分调用失败（没有可回放的录制响应：LineSplit），已按标点拆分'))).toHaveLength(2);
    expect(r.applied).toBe(true);
  });
});
