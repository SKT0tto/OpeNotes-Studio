import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runBreakdown } from '../../server/llm/director';
import { RuleProvider } from '../../server/llm/ruleProvider';
import { runScenes } from '../../server/llm/sceneRunner';
import { SCENE_SYSTEM, SCENE_PROMPT_VERSION, SCENE_TRAVEL_VERSION, scenePromptFor } from '../../server/llm/prompts/sceneDirection';
import { expandScene } from '../../shared/director/expand';
import { AI_FX, AI_FX_PARSE, EMOTIONS } from '../../shared/director/vocab';
import { validateDirection } from '../../shared/director/validate';
import { SceneDirectionSchema, SceneDirectionTravelSchema, type SceneDirection } from '../../shared/schema/ai';
import type { Project } from '../../shared/schema/project';
import { compileProject } from '../../shared/timeline/compile';
import { evaluate } from '../../shared/timeline/evaluate';
import { compileContext, fixtureCatalog } from './helpers/directorCatalog';
import { paragraphs, sceneCtx, skeleton } from './helpers/directorFlow';

describe('prompt scene-4 (fixture) differs from scene-3 only on the fx line and the cutIn line', () => {
  const old = fs.readFileSync(path.resolve('tests/fixtures/prompts/scene-3.system.txt'), 'utf8').replace(/\r\n/g, '\n').split('\n');
  const now = fs.readFileSync(path.resolve('tests/fixtures/prompts/scene-4.system.txt'), 'utf8').replace(/\r\n/g, '\n').split('\n');

  it('same number of lines, and exactly the two lines changed', () => {
    expect(now.length).toBe(old.length);
    const changed = now.filter((l, i) => l !== old[i]);
    expect(changed.length).toBe(2);
    expect(changed.some((l) => l.startsWith('- cutIn：'))).toBe(true);
    expect(changed.some((l) => l.startsWith('- fx：'))).toBe(true);
    const was = old.filter((l, i) => l !== now[i]);
    expect(was.some((l) => l.startsWith('- cutIn：'))).toBe(true);
    expect(was.some((l) => l.startsWith('- fx：'))).toBe(true);
  });

  it('the fx line lists the new vocabulary (memory_glow is no longer offered) and the cutIn line the white dip', () => {
    const fx = now.find((l) => l.startsWith('- fx：'))!;
    for (const k of AI_FX) expect(fx).toContain(k);
    expect(fx).not.toContain('memory_glow');
    expect(fx).toContain('memoryTone');
    expect(now.find((l) => l.startsWith('- cutIn：'))).toContain('dip_white');
    expect(AI_FX).toEqual(['none', 'vignette_anxiety', 'memory', 'dim', 'flash', 'shake', 'daze', 'dutch']);
  });

  it('versions: scene-7 for classic, scene-7+travel-9 for travel', () => {
    expect(SCENE_PROMPT_VERSION).toBe('scene-7');
    expect(SCENE_TRAVEL_VERSION).toBe('scene-7+travel-9');
    expect(scenePromptFor('classic').promptVersion).toBe('scene-7');
    expect(scenePromptFor('travel').promptVersion).toBe('scene-7+travel-9');
  });

  it('an old answer with memory_glow still parses (it is read as memory later), the new words parse in both schemas', () => {
    expect(AI_FX_PARSE).toContain('memory_glow');
    const beat = (fx: string) => ({ keepId: null, paragraph: 0, kind: 'silent', speaker: null, text: '', emotion: EMOTIONS[0], reason: 'r', shot: { type: 'mcu', focus: [], move: 'static', dof: null }, cutIn: 'dip_white', fx, actors: [] });
    for (const fx of [...AI_FX, 'memory_glow']) {
      const raw = { reason: 'r', blocking: [], transitionIn: 'cut', bgm: null, costumeChanges: [], beats: [beat(fx)] };
      expect(SceneDirectionSchema.parse(raw).beats[0]!.fx).toBe(fx);
      expect(SceneDirectionTravelSchema.parse(raw).beats[0]!.cutIn).toBe('dip_white');
    }
  });
});

describe('prompt scene-5 (fixture) differs from scene-4 only by the punctuation-only dialogue rule', () => {
  const old = fs.readFileSync(path.resolve('tests/fixtures/prompts/scene-4.system.txt'), 'utf8').replace(/\r\n/g, '\n').split('\n');
  const now = fs.readFileSync(path.resolve('tests/fixtures/prompts/scene-5.system.txt'), 'utf8').replace(/\r\n/g, '\n').split('\n');
  it('exactly one line added, none changed or removed', () => {
    expect(now.length).toBe(old.length + 1);
    expect(old.filter((l) => !now.includes(l))).toEqual([]);
    expect(now.filter((l) => !old.includes(l)).length).toBe(1);
    expect(now.find((l) => !old.includes(l))).toContain('只有标点的台词也是台词');
  });
});

describe('validation of the new effects', () => {
  const project = skeleton();
  const scene = project.scenes[2]!;
  const ctx = sceneCtx(project, scene);
  const P0 = ctx.range.start;
  const beat = (o: { text?: string; fx?: SceneDirection['beats'][number]['fx']; kind?: 'dialogue' | 'narration'; para?: number; tone?: 'warm' | null } = {}): SceneDirection['beats'][number] => {
    const para = o.para ?? P0;
    const kind = o.kind ?? 'narration';
    return {
      keepId: null, paragraph: para, kind, speaker: kind === 'dialogue' ? ctx.cast[0]!.castId : null, text: o.text ?? paragraphs[para]!.text, emotion: EMOTIONS[0]!, reason: 'r',
      shot: { type: 'mcu', focus: [ctx.cast[0]!.castId], move: 'static', dof: null }, cutIn: 'cut', fx: o.fx ?? 'none', ...(o.tone !== undefined ? { memoryTone: o.tone } : {}), actors: [],
    };
  };
  const dir = (...beats: SceneDirection['beats']): SceneDirection => SceneDirectionSchema.parse({ reason: 'r', blocking: [], transitionIn: 'cut', bgm: null, costumeChanges: [], beats });
  const withText = (text: string) => ({ ...ctx, paragraphs: paragraphs.map((p) => (p.index === P0 ? { ...p, text } : p)) });

  it('a memory without a cue in the text is cancelled with a warning; with a cue it stays (and memory_glow becomes memory)', () => {
    const plain = validateDirection(dir(beat({ fx: 'memory', text: '灯看着窗外。' }), beat({ fx: 'memory', text: '灯看着窗外。' })), withText('灯看着窗外。'));
    expect(plain.value.beats.map((b) => b.fx)).toEqual(['none', 'none']);
    expect(plain.warnings.join('\n')).toContain('没有回忆线索');
    const cue = validateDirection(dir(beat({ fx: 'memory_glow', text: '灯想起了小时候的事。', tone: 'warm' }), beat({ fx: 'memory', text: '灯想起了小时候的事。' })), withText('灯想起了小时候的事。'));
    expect(cue.value.beats.map((b) => b.fx)).toEqual(['memory', 'memory']);
    expect(cue.value.beats[0]!.memoryTone).toBe('warm');
    expect(cue.warnings.filter((w) => w.includes('回忆线索'))).toEqual([]);
  });

  it('dim is only for inner voice or narration, and at most 4 beats in a row', () => {
    const talk = validateDirection(dir(beat({ fx: 'dim', kind: 'dialogue', text: '你好。' })), ctx);
    expect(talk.value.beats[0]!.fx).toBe('none');
    const inner = validateDirection(dir(beat({ fx: 'dim', kind: 'dialogue', text: '（还是写不下去。）' }), beat({ fx: 'dim' })), ctx);
    expect(inner.value.beats.map((b) => b.fx)).toEqual(['dim', 'dim']);
    const run = validateDirection(dir(...Array.from({ length: 6 }, () => beat({ fx: 'dim' }))), ctx);
    expect(run.value.beats.map((b) => b.fx)).toEqual(['dim', 'dim', 'dim', 'dim', 'none', 'dim']);
    expect(run.warnings.join('\n')).toContain('压暗已连续');
  });

  it('a flash straight after a flash is dropped; memoryTone only survives on a memory', () => {
    const v = validateDirection(dir(beat({ fx: 'flash' }), beat({ fx: 'flash' }), beat({ fx: 'none', tone: 'warm' })), ctx);
    expect(v.value.beats.map((b) => b.fx)).toEqual(['flash', 'none', 'none']);
    expect(v.value.beats[2]!.memoryTone).toBeUndefined();
  });
});

describe('expand: the new effects become keys', () => {
  const project = skeleton();
  const scene = project.scenes[2]!;
  const ctx = sceneCtx(project, scene);
  const P0 = ctx.range.start;
  const beat = (i: number, fx: SceneDirection['beats'][number]['fx'], extra: Record<string, unknown> = {}): SceneDirection['beats'][number] => ({
    keepId: null, paragraph: P0, kind: 'narration', speaker: null, text: `第${i}句。`, emotion: EMOTIONS[0]!, reason: 'r',
    shot: { type: 'mcu', focus: [ctx.cast[0]!.castId], move: 'static', dof: null }, cutIn: 'cut', fx, actors: [], ...extra,
  });
  const expand = (...beats: SceneDirection['beats']) => expandScene({ base: scene, direction: SceneDirectionSchema.parse({ reason: 'r', blocking: [], transitionIn: 'cut', bgm: null, costumeChanges: [], beats }), paragraphs, genId: 'g', now: 1 }).scene;
  const keys = (s: ReturnType<typeof expand>, channel: 'fx' | 'fade') => s.tracks.filter((t) => t.channel === channel).flatMap((t) => t.keys.map((k) => ({ beat: s.beats.findIndex((b) => b.id === k.at.beatId), offset: k.at.offset, duration: k.duration, value: k.value as Record<string, unknown> })));

  it('a memory in the middle enters and leaves through white; a memory at the start dissolves in', () => {
    const s = expand(beat(0, 'none'), beat(1, 'memory', { memoryTone: 'warm', cutIn: 'dip_black' }), beat(2, 'memory'), beat(3, 'none', { cutIn: 'dip_white' }));
    expect(keys(s, 'fx').map((k) => [k.beat, k.offset, k.duration, k.value.fx, k.value.strength, k.value.tone])).toEqual([[1, 0, 0, 'memory', 1, 'warm'], [3, 0, 0, 'memory', 0, undefined]]);
    expect(keys(s, 'fade').map((k) => [k.beat, k.offset, k.duration, k.value.alpha])).toEqual([[1, -0.8, 0.8, 1], [1, 0.2, 1, 0], [3, -0.8, 0.8, 1], [3, 0.5, 1, 0]]);
    // the white covers the change: the beats at the boundary do not dip by themselves
    expect(s.beats.map((b) => b.cutIn)).toEqual(['cut', 'cut', 'cut', 'cut']);
    const first = expand(beat(0, 'memory'), beat(1, 'none'));
    expect(keys(first, 'fx')[0]).toMatchObject({ beat: 0, duration: 0.5, value: { fx: 'memory', strength: 1 } });
    expect(keys(first, 'fade').filter((k) => k.beat === 0)).toEqual([]);
  });

  it('flash and shake are events: the running dim is not switched off by them, and dim eases 0.5 s in and out', () => {
    const s = expand(beat(0, 'dim'), beat(1, 'flash'), beat(2, 'shake', { fxStrength: 0.3 }), beat(3, 'dim'), beat(4, 'none'));
    expect(keys(s, 'fx').map((k) => [k.beat, k.value.fx, k.value.strength, k.duration])).toEqual([[0, 'dim', 1, 0.5], [1, 'flash', 1, 0.8], [2, 'shake', 0.3, 0.5], [4, 'dim', 0, 0.5]]);
    const plain = expand(beat(0, 'shake'));
    expect(keys(plain, 'fx')[0]!.value.strength).toBe(0.5);
  });

  it('the generated keys compile: memory under white, one memory curve, the white clears', () => {
    const s = expand(beat(0, 'none'), beat(1, 'memory'), beat(2, 'memory'), beat(3, 'none'));
    const p = { ...project, scenes: project.scenes.map((x) => (x.id === scene.id ? s : x)) } as Project;
    const c = compileProject(p, compileContext(fixtureCatalog()));
    const cs = c.scenes.find((x) => x.id === scene.id)!;
    const startOf = (i: number) => cs.beats.find((b) => b.id === s.beats[i]!.id)!.start;
    const t1 = startOf(1);
    expect(evaluate(c, t1 - 0.01).fx.memory).toBe(0);
    expect(evaluate(c, t1).fx.memory).toBe(1);
    expect(evaluate(c, t1).fade.alpha).toBeGreaterThan(0.99);
    expect(evaluate(c, t1 + 1.3).fade.alpha).toBe(0);
    expect(evaluate(c, startOf(3) + 0.1).fx.memory).toBe(0);
  });
});

describe('the rule director (travel only) derives memory, dim and shake', () => {
  const cat = (() => {
    const base = fixtureCatalog(['002', '003', '004', '005']);
    const nick: Record<string, string> = { '001': '灯', '002': '爱音', '003': '乐奈', '004': '爽世', '005': '立希' };
    return { ...base, characters: base.characters.map((c) => ({ ...c, nickname: nick[c.key] ?? null, aliases: nick[c.key] ? [nick[c.key]!] : [] })) };
  })();
  const NOVEL = ['# 第一章', '教室里很安静。灯低着头，在本子上写着什么。', '“灯，你又在写歌词吗？”爱音从前排转过身来。', '灯想起了小时候一个人坐在教室里的那个下午。', '那时候她总是一个人，窗外下着雨。', '“没有人跟我说话。”灯轻轻地说。', '灯回过神来，爱音正看着她。', '（……还是写不下去。）', '“怎么了？”爱音吓了一跳。'].join('\n\n');
  const direct = async (travel: boolean) => {
    const deps = { provider: new RuleProvider(cat), cache: null, catalog: cat, now: () => 7000 };
    const { project } = await runBreakdown(deps, NOVEL, '示例', 'g1');
    if (travel) project.settings.cameraSystem = 'travel';
    const items = await runScenes(deps, project, project.scenes.map((s) => s.id), ['scene'], 'g2', 3);
    return items.map((i) => i.result!.scene);
  };
  const fxOf = (s: Awaited<ReturnType<typeof direct>>[number]) => {
    const beatIndex = new Map(s.beats.map((b, i) => [b.id, i]));
    return s.tracks.filter((t) => t.channel === 'fx').flatMap((t) => t.keys.map((k) => ({ beat: beatIndex.get(k.at.beatId)!, fx: (k.value as { fx: string }).fx, strength: (k.value as { strength: number }).strength })));
  };

  it('travel: memory from the cue paragraph to the "back to now" one, dim on the bracketed thought, a small shake on the fright', async () => {
    const scenes = await direct(true);
    const keys = scenes.flatMap(fxOf);
    expect(keys.filter((k) => k.fx === 'memory' && k.strength === 1).length).toBe(1);
    expect(keys.filter((k) => k.fx === 'memory' && k.strength === 0).length).toBe(1);
    expect(keys.filter((k) => k.fx === 'dim' && k.strength === 1).length).toBe(1);
    const shake = keys.filter((k) => k.fx === 'shake');
    expect(shake.length).toBe(1);
    expect(shake[0]!.strength).toBe(0.3);
    const s = scenes.find((x) => fxOf(x).some((k) => k.fx === 'memory'))!;
    const on = fxOf(s).find((k) => k.fx === 'memory' && k.strength === 1)!;
    const off = fxOf(s).find((k) => k.fx === 'memory' && k.strength === 0)!;
    expect(s.beats[on.beat]!.text).toContain('想起了小时候');
    expect(s.beats[off.beat]!.text).toContain('回过神来');
  });

  it('classic: the same novel gets no new effect at all (the rule output stays as it was)', async () => {
    const keys = (await direct(false)).flatMap(fxOf);
    expect(keys).toEqual([]);
  });
});

describe('prompt scene-6 differs from scene-5 only on the insert lines', () => {
  const old = fs.readFileSync(path.resolve('tests/fixtures/prompts/scene-5.system.txt'), 'utf8').replace(/\r\n/g, '\n').split('\n');
  // the frozen scene-6 text (tests/fixtures/prompts/scene-6.system.txt); scene-7 adds one line to it (next block)
  const now = fs.readFileSync(path.resolve('tests/fixtures/prompts/scene-6.system.txt'), 'utf8').split('\n');
  it('same number of lines; the type line and the insert line changed', () => {
    expect(now.length).toBe(old.length);
    const changed = now.filter((l, i) => l !== old[i]);
    expect(changed.length).toBe(2);
    expect(changed.some((l) => l.startsWith('- insert 只用于'))).toBe(true);
    expect(SCENE_SYSTEM).not.toContain('hands');
    expect(SCENE_SYSTEM).not.toContain('face_lower');
  });
});

describe('prompt scene-7 differs from scene-6 only by the long-line rule', () => {
  const six = fs.readFileSync(path.resolve('tests/fixtures/prompts/scene-6.system.txt'), 'utf8').split('\n');
  const seven = SCENE_SYSTEM.split('\n');
  it('exactly one added line, at the end of the beats section; every other line is byte-identical', () => {
    expect(seven.length).toBe(six.length + 1);
    const added = seven.filter((l) => !six.includes(l));
    expect(added).toHaveLength(1);
    expect(added[0]).toContain('对话框最多显示两行');
    expect(added[0]).toContain('不要为了放进对话框而删字');
    expect(seven.filter((l) => six.includes(l))).toEqual(six);
    expect(seven[seven.indexOf(added[0]!) - 1]).toMatch(/^- 一个场景只调用一次/);
  });
});
