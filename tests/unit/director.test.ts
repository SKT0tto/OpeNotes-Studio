import { describe, expect, it } from 'vitest';
import { expandScene, matchBeats } from '../../shared/director/expand';
import { projectFromBreakdown } from '../../shared/director/fromBreakdown';
import { splitParagraphs, traceability } from '../../shared/director/paragraphs';
import { lookup } from '../../shared/director/resources';
import { validateBreakdown, validateDirection, repairMotion, repairExpression } from '../../shared/director/validate';
import { BreakdownSchema, SceneDirectionSchema, type SceneDirection } from '../../shared/schema/ai';
import { ProjectSchema, type Project, type Scene } from '../../shared/schema/project';
import { compileProject } from '../../shared/timeline/compile';
import { STORY, compileContext, fixtureCatalog, readFixture } from './helpers/directorCatalog';

const cat = fixtureCatalog();
const L = lookup(cat);
const paragraphs = splitParagraphs(STORY);
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

const breakdown = BreakdownSchema.parse(readFixture('breakdown-story.json'));
const badBreakdown = BreakdownSchema.parse(readFixture('breakdown-bad.json'));

function skeleton(): Project {
  const v = validateBreakdown(breakdown, { catalog: cat, paragraphCount: paragraphs.length });
  return ProjectSchema.parse(projectFromBreakdown({ title: '示例', text: STORY, paragraphs, breakdown: v.value, catalog: cat, genId: 'g1', now: 1000 }));
}

const SCENE_FILES = ['scene-0-2-scene.json', 'scene-3-5-scene.json', 'scene-6-12-scene.json', 'scene-13-18-scene.json', 'scene-19-22-scene.json'];

/** Directions of the recorded scenes (scene 3 was directed in two spans). */
function recordedDirection(sceneIndex: number): SceneDirection {
  const parts = sceneIndex === 2 ? [SCENE_FILES[2]!, SCENE_FILES[3]!] : [SCENE_FILES[sceneIndex < 2 ? sceneIndex : sceneIndex + 1]!];
  const ds = parts.map((f) => SceneDirectionSchema.parse(readFixture(f)));
  return ds.reduce((a, b) => ({ ...a, beats: [...a.beats, ...b.beats], costumeChanges: [...a.costumeChanges, ...b.costumeChanges.map((c) => ({ ...c, beatIndex: c.beatIndex + a.beats.length }))] }));
}

function sceneCtx(project: Project, scene: Scene) {
  const inScene = paragraphs.filter((p) => p.start >= scene.sourceSpan.start && p.end <= scene.sourceSpan.end);
  return {
    catalog: cat, paragraphs, range: { start: inScene[0]!.index, end: inScene.at(-1)!.index }, isPerformance: !!scene.brief?.isPerformance,
    cast: Object.keys(scene.wardrobe).map((castId) => ({ castId, characterKey: project.cast.find((c) => c.id === castId)!.characterKey, modelId: scene.wardrobe[castId]!.modelId })),
  };
}

describe('paragraphs', () => {
  it('numbers non-empty lines with exact source offsets', () => {
    expect(paragraphs.length).toBe(23);
    for (const p of paragraphs) expect(STORY.slice(p.start, p.end)).toBe(p.text);
    expect(paragraphs.map((p) => p.index)).toEqual(paragraphs.map((_, i) => i));
  });
  it('splits a very long line after sentence ends but not inside quotes', () => {
    const long = `${'他慢慢走过去，'.repeat(20)}说：“你好。再见。”${'她笑了。'.repeat(30)}`;
    const ps = splitParagraphs(long);
    expect(ps.length).toBeGreaterThan(1);
    expect(ps.some((p) => p.text.includes('“你好。再见。”'))).toBe(true);
  });
  it('traceability tells quoted source text from invention', () => {
    expect(traceability('这里……我想换一个说法', paragraphs.find((p) => p.text.includes('换一个说法'))!.text)).toBeGreaterThan(0.9);
    expect(traceability('今天的星空真漂亮啊', paragraphs[0]!.text)).toBeLessThan(0.3);
  });
});

describe('breakdown validation and repair', () => {
  it('the recorded model output is clean: contiguous scenes, only real ids', () => {
    const v = validateBreakdown(breakdown, { catalog: cat, paragraphCount: paragraphs.length });
    expect(v.errors).toEqual([]);
    expect(v.value.scenes.map((s) => [s.startParagraph, s.endParagraph])).toEqual([[0, 2], [3, 5], [6, 18], [19, 22]]);
    for (const s of v.value.scenes) {
      expect(L.backgrounds.has(s.location.backgroundId)).toBe(true);
      for (const w of s.wardrobe) expect(L.models.get(w.modelId)?.characterKey).toBe(w.characterKey);
    }
  });

  it('repairs invented ids deterministically and says so (warnings), never keeping an illegal id', () => {
    const v = validateBreakdown(badBreakdown, { catalog: cat, paragraphCount: paragraphs.length });
    expect(v.errors).toEqual([]);
    const text = v.warnings.join('\n');
    expect(text).toContain('不存在，已换成最相近');
    expect(text).toContain('不属于该角色');
    expect(text).toContain('live-mode');
    expect(text).toContain('已作为未映射角色');
    expect(v.warnings.length).toBeGreaterThanOrEqual(5);
    for (const c of v.value.cast) expect(c.characterKey === null || L.characters.has(c.characterKey)).toBe(true);
    for (const s of v.value.scenes) {
      expect(L.backgrounds.has(s.location.backgroundId)).toBe(true);
      expect(s.presentCast.every((k) => L.characters.has(k))).toBe(true);
      for (const w of s.wardrobe) {
        const m = L.models.get(w.modelId)!;
        expect(m.characterKey).toBe(w.characterKey);
        expect(m.mode === 'live').toBe(s.isPerformance); // live-mode only for formal performances
        expect(m.quality).not.toBe('low');
      }
      expect(new Set(s.wardrobe.map((w) => w.characterKey))).toEqual(new Set(s.presentCast));
    }
  });

  it('the invented background is replaced by the closest one for that place and time', () => {
    const b = clone(breakdown);
    b.scenes[2]!.location.backgroundId = 'ring_cafe_evening';
    b.scenes[2]!.location.reason = 'RiNG 咖啡厅 木地板和吧台';
    const v = validateBreakdown(b, { catalog: cat, paragraphCount: paragraphs.length });
    expect(v.value.scenes[2]!.location.backgroundId).toBe('bg_ring_night');
  });

  it('normalises overlapping / gapped paragraph ranges and clamps to the text', () => {
    const b = clone(breakdown);
    b.scenes[0]!.endParagraph = 4; // overlaps scene 2
    b.scenes[1]!.endParagraph = 4; // gap before scene 3
    b.scenes.at(-1)!.endParagraph = 99;
    const v = validateBreakdown(b, { catalog: cat, paragraphCount: paragraphs.length });
    const r = v.value.scenes.map((s) => [s.startParagraph, s.endParagraph] as [number, number]);
    expect(r[0]![0]).toBe(0);
    expect(r.at(-1)![1]).toBe(22);
    r.slice(1).forEach((x, i) => expect(x![0]).toBe(r[i]![1]! + 1));
  });

  it('reports an unfixable breakdown as a structural error (-> one LLM repair call)', () => {
    const v = validateBreakdown({ cast: [], scenes: [] }, { catalog: cat, paragraphCount: 5 });
    expect(v.errors.length).toBe(1);
  });
});

describe('project skeleton from the breakdown', () => {
  const p = skeleton();
  it('creates cast, scenes, outfits, backgrounds and plain narration beats for every paragraph', () => {
    expect(p.scenes.length).toBe(4);
    expect(p.cast.map((c) => c.characterKey).sort()).toEqual(['001', '002', '003', '004', '005']);
    expect(p.scenes.flatMap((s) => s.beats).length).toBe(paragraphs.length);
    expect(p.scenes[3]!.brief).toMatchObject({ timeOfDay: '夜间', isPerformance: false });
    for (const s of p.scenes) expect(s.meta.source).toBe('ai');
    expect(p.scenes[1]!.wardrobe[p.cast.find((c) => c.characterKey === '003')!.id]!.meta.reason).toBeTruthy();
  });
  it('offsets of the beats point into the source text', () => {
    for (const b of p.scenes.flatMap((s) => s.beats)) expect(STORY.startsWith(b.text, b.sourceOffset!)).toBe(true);
  });
  it('a formal performance gets the band formation: vocalist front centre, drummer at the back', () => {
    const perf = clone(breakdown);
    const s = perf.scenes[2]!;
    s.isPerformance = true;
    s.band = 'MyGO!!!!!';
    s.wardrobe = s.wardrobe.map((w) => ({ ...w, modelId: `${w.characterKey}_live-mode_live_01` }));
    const v = validateBreakdown(perf, { catalog: cat, paragraphCount: paragraphs.length });
    expect(v.errors).toEqual([]);
    const pp = projectFromBreakdown({ title: 'x', text: STORY, paragraphs, breakdown: v.value, catalog: cat, genId: 'g' });
    const idOf = (k: string) => pp.cast.find((c) => c.characterKey === k)!.id;
    const bl = pp.scenes[2]!.blocking;
    expect(bl[idOf('001')]).toMatchObject({ slot: 0, depth: 0 });
    expect(bl[idOf('005')]!.depth).toBeGreaterThan(0.5);
    expect(bl[idOf('002')]!.slot).toBeLessThan(0);
    expect(bl[idOf('004')]!.slot).toBeGreaterThan(0);
  });
});

describe('scene direction validation and repair', () => {
  const project = skeleton();
  const scene = project.scenes[0]!;
  const ctx = sceneCtx(project, scene);

  it('the recorded scene directions are usable as they are (the model really did well, modulo a few repairs)', () => {
    for (let i = 0; i < 4; i++) {
      const s = project.scenes[i]!;
      const v = validateDirection(recordedDirection(i), sceneCtx(project, s));
      expect(v.errors, s.title).toEqual([]);
    }
  });

  it('repairs invalid motions / expressions / speakers / paragraphs / shots, with a warning for each', () => {
    const bad = SceneDirectionSchema.parse(readFixture('scene-bad.json'));
    const v = validateDirection(bad, ctx);
    expect(v.errors).toEqual([]);
    const text = v.warnings.join('\n');
    for (const needle of ['动作', '表情', '说话人', '段落号', '演员', 'BGM', '换装']) expect(text, needle).toContain(needle);
    const d = v.value;
    const ids = new Set(ctx.cast.map((c) => c.castId));
    for (const b of d.beats) {
      expect(b.paragraph).toBeGreaterThanOrEqual(ctx.range.start);
      expect(b.paragraph).toBeLessThanOrEqual(ctx.range.end);
      if (b.kind === 'dialogue') expect(ids.has(b.speaker!)).toBe(true);
      for (const a of b.actors) {
        expect(ids.has(a.castId)).toBe(true);
        const m = L.models.get(ctx.cast.find((c) => c.castId === a.castId)!.modelId)!;
        if (a.motion) expect(m.motions.some((x) => x.family === a.motion)).toBe(true);
        if (a.expression) expect(m.expressions.some((x) => x.name === a.expression)).toBe(true);
      }
      expect(['group', 'two_shot', 'mcu', 'cu', 'ecu', 'insert']).toContain(b.shot.type);
      for (const f of b.shot.focus) expect(ids.has(f)).toBe(true);
    }
    expect(d.bgm).toBeNull();
    for (const c of d.costumeChanges) expect(L.models.get(c.modelId)!.characterKey).toBe(ctx.cast.find((x) => x.castId === c.castId)!.characterKey);
  });

  it('motion / expression repair: same family, then emotion table, else dropped; live-mode has no expressions', () => {
    const m = L.models.get('001_casual_spring_01')!;
    expect(repairMotion(m, 'mtn_nod01_L', 'happy')).toBe('nod01');
    expect(repairMotion(m, 'nod07', 'happy')).toBe('nod01');
    expect(repairMotion(m, 'zzz99', 'happy')).toBe('smile01');
    expect(repairMotion(m, 'zzz99', 'no-such-emotion')).toBeNull();
    expect(repairExpression(m, 'smile01', 'happy')).toBe('exp_smile01');
    expect(repairExpression(m, 'exp_smile09', 'happy')).toBe('exp_smile01');
    expect(repairExpression(m, 'exp_nonsense', 'sad')).toBe('exp_sad01');
    const live = L.models.get('001_live-mode_live_01')!;
    expect(repairExpression(live, 'exp_smile01', 'happy')).toBeNull();
    expect(repairMotion(live, 'nod01', 'happy')).toBe('play01_01');
  });

  it('fabricated dialogue is a structural error (-> one LLM repair call)', () => {
    const d = clone(recordedDirection(0));
    d.beats.forEach((b) => {
      if (b.kind === 'dialogue') b.text = '这是一句原文里根本没有的、完全编造出来的台词内容。';
    });
    expect(validateDirection(d, ctx).errors.join()).toContain('无法回溯到原文');
  });

  it('beats the model only reproduces from the project (keepId: locked / hand-written text) are exempt from the source check', () => {
    const d = clone(recordedDirection(0));
    const ids = new Set<string>();
    d.beats.forEach((b, i) => {
      if (b.kind === 'dialogue') {
        b.text = '人工改写的、原文里没有的话。';
        b.keepId = `s_1b_${i}`;
        ids.add(b.keepId);
      }
    });
    const v = validateDirection(d, { ...ctx, fixedBeatIds: ids });
    expect(v.errors).toEqual([]);
    expect(v.value.beats.filter((b) => b.keepId !== null).length).toBe(ids.size);
  });

  it('a live-mode scene cannot switch to an everyday outfit mid-scene', () => {
    const d = clone(recordedDirection(0));
    d.costumeChanges = [{ beatIndex: 1, castId: ctx.cast[0]!.castId, modelId: `${ctx.cast[0]!.characterKey}_school_winter_hs_1st`, reason: 'x' }, { beatIndex: 99, castId: ctx.cast[0]!.castId, modelId: `${ctx.cast[0]!.characterKey}_casual_spring_01`, reason: 'x' }];
    const v = validateDirection(d, ctx);
    expect(v.value.costumeChanges.every((c) => c.beatIndex <= d.beats.length - 1)).toBe(true);
    const perf = validateDirection(d, { ...ctx, isPerformance: true });
    expect(perf.value.costumeChanges.length).toBe(0);
  });
});

describe('expand: intent -> beats and tracks', () => {
  const project = skeleton();
  const idx = 2;
  const scene = project.scenes[idx]!;
  const dir = validateDirection(recordedDirection(idx), sceneCtx(project, scene)).value;
  const run = (base: Scene = scene, direction: SceneDirection = dir) => expandScene({ base, direction, paragraphs, genId: 'g2', now: 2000 });
  const out = run().scene;

  it('every directed beat becomes a beat with the model decisions as source=ai', () => {
    expect(out.beats.length).toBe(dir.beats.length);
    out.beats.forEach((b, i) => {
      expect(b.meta.source).toBe('ai');
      expect(b.emotion).toBe(dir.beats[i]!.emotion);
      expect(b.shot.type).toBe(dir.beats[i]!.shot.type);
    });
    expect(ProjectSchema.safeParse({ ...project, scenes: [out] }).success).toBe(true);
  });

  it('speaker looks at the addressee and listeners look back (head + gaze keys) in every dialogue beat', () => {
    const trackOf = (castId: string, ch: string) => out.tracks.find((t) => t.channel === ch && t.target.kind === 'actor' && t.target.castId === castId);
    const dialogue = out.beats.filter((b) => b.kind === 'dialogue');
    expect(dialogue.length).toBeGreaterThan(5);
    for (const b of dialogue) {
      const sp = b.speakerId!;
      const gazeOf = (c: string) => trackOf(c, 'gaze')?.keys.filter((k) => k.at.beatId === b.id) ?? [];
      expect(gazeOf(sp).length, `speaker gaze ${b.text}`).toBeGreaterThan(0);
      const others = (b.shot.focus.length > 0 ? b.shot.focus : Object.keys(scene.wardrobe)).filter((c) => c !== sp);
      for (const o of others) {
        const keys = gazeOf(o);
        expect(keys.length, `listener ${o}`).toBeGreaterThan(0);
        expect(keys.some((k) => (k.value as { target?: string }).target === sp || (k.value as { target?: string }).target !== undefined)).toBe(true);
      }
    }
  });

  it('the default derived keys are source=rule; explicit attention / motion / expression are source=ai', () => {
    const plain = clone(dir);
    plain.beats.forEach((b) => b.actors.forEach((a) => (a.attention = null)));
    const derived = run({ ...scene }, plain).scene.tracks.flatMap((t) => t.keys.map((k) => ({ ch: t.channel, k })));
    expect(derived.filter((x) => x.ch === 'gaze' || x.ch === 'head').every((x) => x.k.meta.source === 'rule')).toBe(true);
    expect(derived.some((x) => x.ch === 'gaze')).toBe(true);
    const keys = out.tracks.flatMap((t) => t.keys.map((k) => ({ ch: t.channel, k })));
    for (const x of keys.filter((y) => y.ch === 'motion' || y.ch === 'expression')) expect(x.k.meta.source).toBe('ai');
  });

  it('never uses a motion or expression the model does not have, and nothing mirrors an actor', () => {
    for (const t of out.tracks) {
      if (t.target.kind !== 'actor') continue;
      const m = L.models.get(scene.wardrobe[t.target.castId]!.modelId)!;
      for (const k of t.keys) {
        if (t.channel === 'motion') expect(m.motions.some((x) => x.family === (k.value as { name: string }).name)).toBe(true);
        if (t.channel === 'expression') expect(m.expressions.some((x) => x.name === (k.value as { name: string }).name)).toBe(true);
      }
    }
    expect(JSON.stringify(out)).not.toMatch(/flip|mirror|scaleX|"scale"/);
  });

  it('is deterministic: the same input expands to identical ids and content', () => {
    expect(JSON.stringify(run().scene)).toBe(JSON.stringify(run().scene));
  });

  it('ids follow the editor rule: monotonic <scene>b_<n> / tr_<n> / k_<n>, never reusing an existing id', () => {
    const beatNums = out.beats.map((b) => Number(b.id.replace(`${scene.id}b_`, '')));
    expect(beatNums.every((n) => Number.isInteger(n))).toBe(true);
    expect(new Set(out.beats.map((b) => b.id)).size).toBe(out.beats.length);
    const keyIds = out.tracks.flatMap((t) => t.keys.map((k) => k.id));
    expect(new Set(keyIds).size).toBe(keyIds.length);
    expect(keyIds.every((k) => /^k_\d+$/.test(k))).toBe(true);
    expect(out.tracks.every((t) => /^tr_\d+$/.test(t.id))).toBe(true);
    // expanding on top of a scene that already has these ids reuses matched beats and never hands out a used id again
    const again = run(out).scene;
    expect(again.beats.map((b) => b.id)).toEqual(out.beats.map((b) => b.id));
    const oldKeys = new Set(keyIds);
    const newKeys = again.tracks.flatMap((t) => t.keys.map((k) => k.id));
    expect(newKeys.every((k) => !oldKeys.has(k))).toBe(true);
    expect(Math.min(...newKeys.map((k) => Number(k.slice(2))))).toBeGreaterThan(Math.max(...keyIds.map((k) => Number(k.slice(2)))));
  });

  it('beats the model marks with keepId keep that id and the matching heuristic pairs the rest by paragraph + speaker + ordinal', () => {
    const old = out.beats;
    const redo = clone(dir);
    redo.beats[3]!.keepId = old[3]!.id;
    const m = matchBeats(old, redo.beats, paragraphs);
    expect(m.filter(Boolean).length).toBe(old.length);
    expect(m[3]).toBe(old[3]!.id);
  });

  it('a compiled result plays: the whole story has no compile warnings that point at illegal resources', () => {
    const scenes = project.scenes.map((s, i) => expandScene({ base: s, direction: validateDirection(recordedDirection(i), sceneCtx(project, s)).value, paragraphs, genId: 'g2', now: 2000 }).scene);
    const full = ProjectSchema.parse({ ...project, scenes });
    const compiled = compileProject(full, compileContext(cat));
    expect(compiled.duration).toBeGreaterThan(60);
    const bad = compiled.warnings.filter((w) => /unknown|no motion|dropped|absent/.test(w));
    expect(bad).toEqual([]);
  });

  it('performance scenes: formation positions are kept and live-mode actors play their instrument motion', () => {
    const perfScene = clone(scene);
    perfScene.brief = { timeOfDay: '夜间', mood: '', isPerformance: true, band: 'MyGO!!!!!' };
    for (const c of Object.keys(perfScene.wardrobe)) perfScene.wardrobe[c]!.modelId = `${project.cast.find((x) => x.id === c)!.characterKey}_live-mode_live_01`;
    const r = expandScene({ base: perfScene, direction: dir, paragraphs, genId: 'g', now: 1, playMotionOf: () => 'play01_01' });
    for (const [c, b] of Object.entries(perfScene.blocking)) expect(r.scene.blocking[c]).toMatchObject({ slot: b.slot, depth: b.depth });
    const first = r.scene.beats[0]!.id;
    for (const c of Object.keys(perfScene.wardrobe)) {
      const t = r.scene.tracks.find((x) => x.channel === 'motion' && x.target.kind === 'actor' && x.target.castId === c);
      expect(t?.keys.some((k) => k.at.beatId === first && (k.value as { name: string }).name === 'play01_01')).toBe(true);
    }
  });
});

describe('listener turns yield per line (compile)', () => {
  it('an AI head key in one line only suppresses the rule director in that line', async () => {
    const { miniProject } = await import('./helpers/synthetic');
    const { fakeContext } = await import('./helpers/synthetic');
    const base = miniProject({ style: { 'performance.ruleDirector': true } });
    const scene = base.scenes[0]!;
    const compiledOf = (p: Project) => compileProject(p, fakeContext(['mA', 'mB'], ['bg1']));
    const without = compiledOf(base).scenes[0]!;
    const turnsB = without.actors.find((a) => a.castId === 'b')!.ruleKeys.filter((k) => k.channel === 'head');
    expect(turnsB.length).toBeGreaterThan(0);
    // b gets a hand head key inside the beat that a speaks first
    const firstA = scene.beats.find((b) => b.speakerId === 'a')!;
    const hand = clone(base);
    hand.scenes[0]!.tracks.push({ id: 't1', target: { kind: 'actor', castId: 'b' }, channel: 'head', meta: { source: 'user', locked: false, updatedAt: 0 }, keys: [{ id: 'k1', at: { beatId: firstA.id, offset: 0.1 }, value: { mode: 'angle', yaw: 0.3 }, duration: 0, ease: 'inOutQuad', meta: { source: 'user', locked: false, updatedAt: 0 } }] } as never);
    const withHand = compiledOf(hand).scenes[0]!.actors.find((a) => a.castId === 'b')!.ruleKeys.filter((k) => k.channel === 'head');
    expect(withHand.some((k) => k.beatId === firstA.id)).toBe(false);
    // the other lines keep their rule turns
    expect(withHand.length).toBe(turnsB.length - turnsB.filter((k) => k.beatId === firstA.id).length);
    expect(withHand.length).toBeGreaterThan(0);
  });
});
