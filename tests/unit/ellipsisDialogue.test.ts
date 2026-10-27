import { describe, expect, it } from 'vitest';
import { runBreakdown } from '../../server/llm/director';
import { RuleProvider } from '../../server/llm/ruleProvider';
import { runScenes } from '../../server/llm/sceneRunner';
import { isPunctuationOnly } from '../../shared/director/punctuationLines';
import { segments } from '../../shared/director/ruleDirector';
import { validateDirection } from '../../shared/director/validate';
import { SceneDirectionSchema, type SceneDirection } from '../../shared/schema/ai';
import { compileProject } from '../../shared/timeline/compile';
import { evaluate } from '../../shared/timeline/evaluate';
import { compileContext, fixtureCatalog } from './helpers/directorCatalog';
import { paragraphs, sceneCtx, skeleton } from './helpers/directorFlow';

// A punctuation-only line ("……") is a real line of dialogue: kind=dialogue, speaker, text as written, dialogue box shown.
const base = fixtureCatalog(['002', '003', '004', '005']);
const nick: Record<string, string> = { '001': '灯', '002': '爱音', '003': '乐奈', '004': '爽世', '005': '立希' };
const cat = { ...base, characters: base.characters.map((c) => ({ ...c, nickname: nick[c.key] ?? null, aliases: nick[c.key] ? [nick[c.key]!] : [] })) };
const NOVEL = ['# 第一章', '教室里很安静。灯低着头，在本子上写着什么。', '“灯，你又在写歌词吗？”爱音从前排转过身来。', '灯：……', '爱音：……！', '“……”灯把本子抱在胸前。', '时间：傍晚', '爱音:——', '“怎么了？”爱音笑着问。'].join('\n\n');

describe('punctuation-only text', () => {
  it('is recognised', () => {
    for (const t of ['……', '…', '——', '！？', '……！', ' … ']) expect(isPunctuationOnly(t)).toBe(true);
    for (const t of ['', '  ', '好……', 'a']) expect(isPunctuationOnly(t)).toBe(false);
  });
});

describe('segments: script-style lines', () => {
  const resolve = (n: string) => (n === '灯' ? '001' : n === '爱音' ? '002' : null);
  it('灯：…… and 灯:…… (full-width and ASCII colon) are dialogue of that character', () => {
    for (const t of ['灯：……', '灯:……']) {
      const s = segments(t, resolve);
      expect(s.map((x) => [x.kind, x.text, x.speakerKey])).toEqual([['dialogue', '……', '001']]);
    }
  });
  it('the part before the colon must be a present cast member: 时间：傍晚 stays narration', () => {
    expect(segments('时间：傍晚', resolve).map((x) => [x.kind, x.text])).toEqual([['narration', '时间：傍晚']]);
    expect(segments('灯：……', undefined).map((x) => x.kind)).toEqual(['narration']);
  });
  it('quoted ““……”” is dialogue as before', () => {
    expect(segments('“……”灯把本子抱在胸前。', resolve).map((x) => [x.kind, x.text])).toEqual([['dialogue', '……'], ['narration', '灯把本子抱在胸前。']]);
  });
  it('灯：「……」 gives one dialogue, without a stray 灯： narration', () => {
    expect(segments('灯：「……」', resolve).map((x) => [x.kind, x.text])).toEqual([['dialogue', '……']]);
  });
});

describe('rule director on ellipsis lines', () => {
  const direct = async (travel: boolean) => {
    const deps = { provider: new RuleProvider(cat), cache: null, catalog: cat, now: () => 7000 };
    const { project } = await runBreakdown(deps, NOVEL, '示例', 'g1');
    if (travel) project.settings.cameraSystem = 'travel';
    const items = await runScenes(deps, project, project.scenes.map((s) => s.id), ['scene'], 'g2', 3);
    return { project, scenes: items.map((i) => i.result!.scene) };
  };
  for (const travel of [false, true]) {
    it(`${travel ? 'travel' : 'classic'}: every ellipsis line is a dialogue beat with the right speaker; 时间：傍晚 stays narration`, async () => {
      const { project, scenes } = await direct(travel);
      const beats = scenes.flatMap((s) => s.beats);
      const castKey = (id: string | null | undefined) => project.cast.find((c) => c.id === id)?.characterKey;
      const dots = beats.filter((b) => isPunctuationOnly(b.text));
      expect(dots.map((b) => [b.kind, b.text, castKey(b.speakerId)])).toEqual([
        ['dialogue', '……', '001'], ['dialogue', '……！', '002'], ['dialogue', '……', '001'], ['dialogue', '——', '002'],
      ]);
      const time = beats.find((b) => b.text.includes('时间'))!;
      expect(time.kind).toBe('narration');
      expect(beats.some((b) => b.kind === 'silent' && b.text === '')).toBe(false);
    });
  }

  it('compile keeps the dialogue box visible for a dialogue beat with text ……', async () => {
    const { project, scenes } = await direct(false);
    const p = { ...project, scenes };
    const c = compileProject(p, compileContext(fixtureCatalog()));
    const sc = c.scenes.find((s) => s.beats.some((b) => b.text === '……'))!;
    const b = sc.beats.find((x) => x.text === '……')!;
    const sub = evaluate(c, b.start + 0.5).subtitle;
    expect(sub?.text).toBe('……');
    expect(sub?.kind).toBe('dialogue');
  });
});

describe('validateDirection: silent beat carrying a punctuation-only line becomes dialogue', () => {
  const project = skeleton();
  const scene = project.scenes[2]!;
  const ctx = sceneCtx(project, scene);
  const P0 = ctx.range.start;
  const [a, b] = ctx.cast;
  const nameOf = (castId: string) => cat.characters.find((c) => c.key === ctx.cast.find((x) => x.castId === castId)!.characterKey)!;
  const beat = (o: { kind: 'dialogue' | 'silent' | 'narration'; text: string; para?: number; speaker?: string | null; focus?: string[] }): SceneDirection['beats'][number] => ({
    keepId: null, paragraph: o.para ?? P0, kind: o.kind, speaker: o.speaker ?? null, text: o.text, emotion: 'neutral' as never, reason: 'r',
    shot: { type: 'mcu', focus: o.focus ?? [], move: 'static', dof: null }, cutIn: 'cut', fx: 'none', actors: [],
  } as SceneDirection['beats'][number]);
  const dir = (...beats: SceneDirection['beats']) => SceneDirectionSchema.parse({ reason: 'r', blocking: [], transitionIn: 'cut', bgm: null, costumeChanges: [], beats });
  const withText = (text: string) => ({ ...ctx, catalog: cat, paragraphs: paragraphs.map((p) => (p.index === P0 ? { ...p, text } : p)) });

  it('a quoted “……” with one focus person: speaker = the focus, text kept', () => {
    const v = validateDirection(dir(beat({ kind: 'silent', text: '', focus: [a!.castId] })), withText('“……”她没有回答。'));
    expect(v.value.beats[0]).toMatchObject({ kind: 'dialogue', speaker: a!.castId, text: '……' });
    expect(v.warnings.join('\n')).toContain('已改为');
  });

  it('script style names the speaker: the named character wins over the focus', () => {
    const n = nameOf(b!.castId);
    const name = n.nickname ?? n.name;
    const v = validateDirection(dir(beat({ kind: 'silent', text: '', focus: [a!.castId] })), withText(`${name}：……`));
    expect(v.value.beats[0]).toMatchObject({ kind: 'dialogue', speaker: b!.castId, text: '……' });
  });

  it('no speaker to resolve (no name, two focus people): left silent with a warning', () => {
    const v = validateDirection(dir(beat({ kind: 'silent', text: '', focus: [a!.castId, b!.castId] })), withText('“……”'));
    expect(v.value.beats[0]!.kind).toBe('silent');
    expect(v.warnings.join('\n')).toContain('找不到说话人');
  });

  it('a dialogue beat that already carries the line is left alone, and a real silent reaction is not touched', () => {
    const v = validateDirection(dir(beat({ kind: 'dialogue', text: '……', speaker: a!.castId, focus: [a!.castId] }), beat({ kind: 'silent', text: '', focus: [b!.castId] })), withText('“……”她没有回答。'));
    expect(v.value.beats.map((x) => x.kind)).toEqual(['dialogue', 'silent']);
    const plain = validateDirection(dir(beat({ kind: 'silent', text: '', focus: [a!.castId] })), withText('她低下头，没有回答。'));
    expect(plain.value.beats[0]!.kind).toBe('silent');
  });

  it('a line the model left out altogether (folded into narration) is put back when the text names the speaker', () => {
    const n = nameOf(b!.castId);
    const name = n.nickname ?? n.name;
    const v = validateDirection(dir(beat({ kind: 'narration', text: `${name}缩了缩肩膀。`, focus: [] })), withText(`“——”${name}缩了缩肩膀。`));
    expect(v.value.beats.map((x) => [x.kind, x.text])).toEqual([['dialogue', '——'], ['narration', `${name}缩了缩肩膀。`]]);
    expect(v.value.beats[0]).toMatchObject({ speaker: b!.castId });
    expect(v.value.beats[0]!.shot.focus).toEqual([b!.castId]);
    // unnamed: left alone
    const un = validateDirection(dir(beat({ kind: 'narration', text: '她缩了缩肩膀。', focus: [] })), withText('“——”她缩了缩肩膀。'));
    expect(un.value.beats.map((x) => x.kind)).toEqual(['narration']);
  });
});
