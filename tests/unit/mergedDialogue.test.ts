/** Dialogue beats that swallowed narration (「台词＋叙述＋台词」 in one beat): detection and the deterministic split. All text is original. */
import { describe, expect, it } from 'vitest';
import { splitMerged, splitMergedDialogue, stripQuotes } from '../../shared/director/mergedDialogue';
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

describe('splitMergedDialogue: speech tags and spoken lines that start with a quoted word', () => {
  const kinds = (t: string, src?: string) => splitMergedDialogue(t, src)?.map((p) => `${p.kind}:${p.text}`) ?? null;
  it('U1: a line that starts with a quoted word is never split, with or without the source', () => {
    for (const line of ['「『春日影』……还有『碧天伴走』，我们都要练。」', '「“随便你”和“没关系”，这两句话有什么区别？」', '“随便你”和“没关系”，这两句话有什么区别？', '『春日影』……还有『碧天伴走』，我们都要练。']) {
      expect(splitMergedDialogue(line)).toBeNull();
      expect(splitMergedDialogue(line, `“${line}”`)).toBeNull();
    }
    expect(stripQuotes('「『春日影』……还有『碧天伴走』，我们都要练。」')).toBe('『春日影』……还有『碧天伴走』，我们都要练。');
    expect(stripQuotes('“你好”')).toBe('你好');
    expect(stripQuotes('「“A”和“B”」')).toBe('“A”和“B”');
    expect(stripQuotes('你好”')).toBe('你好');
  });
  it('a complete leading quote is split only when the source shows the narration outside every quote', () => {
    const t = '“我们再来一遍，”立希说，“这次从副歌开始。”';
    expect(splitMergedDialogue(t)).toBeNull();
    expect(splitMergedDialogue(t, '“我们再来一遍，”立希说，“这次从副歌开始。”')).not.toBeNull();
    expect(splitMergedDialogue(t, '“我们再来一遍，立希说，这次从副歌开始。”')).toBeNull();
  });
  it('U2: a speech tag is dropped, leaving the two dialogue beats', () => {
    for (const [tag, first, second] of [['立希说，', '我们再来一遍，', '这次从副歌开始。'], ['素世笑着说，', '好啊，', '我也想试试。'], ['爱音小声问，', '真的可以吗，', '我怕弹错。'], ['灯问。', '你们累了吗，', '那就休息一下。']] as const) {
      const src = `“${first}”${tag}“${second}”`;
      const r = splitMerged(src, src);
      expect(r?.pieces.map((p) => `${p.kind}:${p.text}`)).toEqual([`dialogue:${first}`, `dialogue:${second}`]);
      expect(r?.droppedTags).toEqual([tag]);
    }
    // the stray-closer shape too (outer quotes already off)
    expect(kinds('我们再来一遍，”立希说，“这次从副歌开始。')).toEqual(['dialogue:我们再来一遍，', 'dialogue:这次从副歌开始。']);
  });
  it('a tag followed by an action stays as narration', () => {
    const src = '“抱歉，我来晚了。”爽世抱着贝斯走进来，环顾了一圈，“老师留我说了几句。”';
    expect(kinds(src, src)).toEqual(['dialogue:抱歉，我来晚了。', 'narration:爽世抱着贝斯走进来，环顾了一圈。', 'dialogue:老师留我说了几句。']);
    const src2 = '“好。”立希说着，抬手敲了敲鼓面，“开始吧。”';
    expect(kinds(src2, src2)?.[1]).toBe('narration:立希说着，抬手敲了敲鼓面。');
  });
  it('S2: a narration that ends in a comma ends in a full stop', () => {
    expect(kinds('抱歉。”爱音伸出手，又在半路停住，“算了。')?.[1]).toBe('narration:爱音伸出手，又在半路停住。');
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

  it('U1/U2 through the validator: quoted-word lines stay whole, a speech tag disappears', () => {
    const quotedWord = '『春日影』……还有『碧天伴走』，我们都要练。';
    const tagged = '“我们再来一遍，”立希说，“这次从副歌开始。”';
    const ctx2 = { ...base, paragraphs: base.paragraphs.map((p) => (p.index === P0 ? { ...p, text: `「${quotedWord}」${tagged}` } : p)) };
    const v = validateDirection(dir([mk(quotedWord), mk(tagged)]), ctx2);
    expect(v.errors).toEqual([]);
    expect(v.value.beats.map((b) => [b.kind, b.text])).toEqual([['dialogue', quotedWord], ['dialogue', '我们再来一遍，'], ['dialogue', '这次从副歌开始。']]);
    expect(v.warnings.some((w) => w.includes('去掉说话标签'))).toBe(true);
  });

  it('beats that reproduce a fixed beat (keepId) are never touched', () => {
    const v = validateDirection(dir([mk(MERGED, { keepId: 'kept' })]), { ...ctxP, fixedBeatIds: new Set(['kept']) });
    expect(v.value.beats).toHaveLength(1);
  });
});
