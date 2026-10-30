/** Dialogue beats that swallowed narration (「台词＋叙述＋台词」 in one beat): detection and the deterministic split. All text is original. */
import { describe, expect, it } from 'vitest';
import { splitMergedDialogue } from '../../shared/director/mergedDialogue';
import { validateDirection } from '../../shared/director/validate';
import { SceneDirectionSchema, type SceneDirection } from '../../shared/schema/ai';
import { EMOTIONS } from '../../shared/director/vocab';
import { sceneCtx, skeleton } from './helpers/directorFlow';

describe('splitMergedDialogue', () => {
  it('cuts 「”…“」 into dialogue / narration / dialogue', () => {
    expect(splitMergedDialogue('抱歉，我来晚了。”她抱着琴包走进来，气喘吁吁。“路上耽误了一会儿。')).toEqual([
      { kind: 'dialogue', text: '抱歉，我来晚了。' }, { kind: 'narration', text: '她抱着琴包走进来，气喘吁吁。' }, { kind: 'dialogue', text: '路上耽误了一会儿。' },
    ]);
  });
  it('also works with 」…「 and with several narrations', () => {
    expect(splitMergedDialogue('你好」他笑了笑「再见」风吹过走廊「走吧')?.map((p) => p.kind)).toEqual(['dialogue', 'narration', 'dialogue', 'narration', 'dialogue']);
    expect(splitMergedDialogue('好」她点头「嗯')?.map((p) => p.text)).toEqual(['好', '她点头', '嗯']);
  });
  it('leaves honest text alone: plain lines, a quoted phrase inside speech, a dangling closing quote', () => {
    for (const t of ['我今天不太舒服。', '他说“好”，我说“不”', '她说「好」，又说「不」。', '『今天』和『明天』都可以', '没事的」', '好吧。“', '你说“好”之后」']) expect(splitMergedDialogue(t)).toBeNull();
  });
});

describe('validateDirection: merged dialogue', () => {
  const project = skeleton();
  const scene = project.scenes[2]!;
  const base = sceneCtx(project, scene);
  const A = base.cast[0]!.castId;
  const P0 = base.range.start;
  const MERGED = '抱歉，我来晚了。”她抱着琴包走进来，气喘吁吁。“路上耽误了一会儿。';
  // the source paragraph holds all the text used below, so every line traces back to it
  const ctxP = { ...base, paragraphs: base.paragraphs.map((p) => (p.index === P0 ? { ...p, text: `“${MERGED}”第二句。今天也请多关照。他说“好”，我说“不”后面。` } : p)) };
  const mk = (text: string, extra: Partial<SceneDirection['beats'][number]> = {}): SceneDirection['beats'][number] => ({
    keepId: null, paragraph: P0, kind: 'dialogue', speaker: A, text, emotion: EMOTIONS[0]!, reason: 'r',
    shot: { type: 'mcu', focus: [A], move: 'static', dof: null }, cutIn: 'cut', fx: 'none', actors: [], ...extra,
  });
  const dir = (beats: SceneDirection['beats'], costume: SceneDirection['costumeChanges'] = []): SceneDirection =>
    SceneDirectionSchema.parse({ reason: 'r', blocking: [], transitionIn: 'cut', bgm: null, costumeChanges: costume, beats });

  it('splits it into dialogue / narration / dialogue with a Chinese warning, nothing dropped, no error', () => {
    const v = validateDirection(dir([mk(MERGED), mk('第二句。')]), ctxP);
    expect(v.errors).toEqual([]);
    expect(v.value.beats.map((b) => b.kind)).toEqual(['dialogue', 'narration', 'dialogue', 'dialogue']);
    expect(v.value.beats.map((b) => b.speaker)).toEqual([A, null, A, A]);
    expect(v.value.beats.slice(0, 3).map((b) => b.text)).toEqual(['抱歉，我来晚了。', '她抱着琴包走进来，气喘吁吁。', '路上耽误了一会儿。']);
    expect(v.warnings.some((w) => w.includes('夹着叙述') && w.includes('第 1 句'))).toBe(true);
  });

  it('the first piece keeps the acting and the cut, the others cut in plain; costume changes move along', () => {
    const b = mk(MERGED, { cutIn: 'dip_black', fx: 'flash', actors: [{ castId: A, motion: null, expression: null, attention: null, enter: true, exit: false, move: null }] });
    const v = validateDirection(dir([b, mk('后面。')], [{ beatIndex: 1, castId: A, modelId: base.cast[0]!.modelId, reason: 'x' }]), ctxP);
    const [p1, p2, p3] = v.value.beats;
    expect([p1!.cutIn, p1!.fx, p1!.actors.length]).toEqual(['dip_black', 'flash', 1]);
    for (const p of [p2!, p3!]) expect([p.cutIn, p.fx, p.actors.length, p.keepId]).toEqual(['cut', 'none', 0, null]);
    expect(v.value.costumeChanges.every((c) => c.beatIndex === 3 || v.warnings.some((w) => w.includes('换装')))).toBe(true);
  });

  it('a normal direction is untouched (same beats, no such warning)', () => {
    const d = dir([mk('今天也请多关照。'), mk('他说“好”，我说“不”')]);
    const v = validateDirection(d, ctxP);
    expect(v.value.beats).toHaveLength(2);
    expect(v.warnings.some((w) => w.includes('夹着叙述'))).toBe(false);
  });

  it('beats that reproduce a fixed beat (keepId) are never touched', () => {
    const v = validateDirection(dir([mk(MERGED, { keepId: 'kept' })]), { ...ctxP, fixedBeatIds: new Set(['kept']) });
    expect(v.value.beats).toHaveLength(1);
  });
});
