import { describe, expect, it } from 'vitest';
import { runBreakdown } from '../../server/llm/director';
import { RuleProvider } from '../../server/llm/ruleProvider';
import { runScenes } from '../../server/llm/sceneRunner';
import { DUPLICATE_PAIRS, advId, duplicateLinks, mergeBgContent, type BgContent } from '../../shared/catalog/importBgContent';
import { autoSelectable, bgCategoryOf, manualSelectable } from '../../shared/director/bgCategory';
import { anchorMoves } from '../../shared/director/bgKeys';
import { breakdownDigest } from '../../shared/director/catalogDigest';
import { catalogLookups, checkContinuity } from '../../shared/director/continuity';
import { lookup } from '../../shared/director/resources';
import { ruleBreakdown } from '../../shared/director/ruleDirector';
import { splitParagraphs } from '../../shared/director/paragraphs';
import { expandScene } from '../../shared/director/expand';
import { validateBreakdown, validateDirection } from '../../shared/director/validate';
import type { Breakdown } from '../../shared/schema/ai';
import { collectRefs, replaceRef } from '../../shared/project/exchange';
import { LabelFileSchema, type LabelFile } from '../../shared/schema/assetLabels';
import type { BackgroundEntry } from '../../shared/schema/assets';
import { compileProject } from '../../shared/timeline/compile';
import { evaluate } from '../../shared/timeline/evaluate';
import { FixtureProvider } from '../../server/llm/fixtureProvider';
import { FIXTURE_DIR, STORY, compileContext } from './helpers/directorCatalog';
import { cat as fixtureCat } from './helpers/directorFlow';
import { LABEL_FILE, labelCatalog, stage } from './helpers/labelCatalog';
import fs from 'node:fs';

const cat = labelCatalog();
const L = lookup(cat);
const entry = (over: Partial<BackgroundEntry> & { id: string }): BackgroundEntry => ({ url: '', width: 10, height: 10, name: over.id, aliases: [], kind: 'scene', location: null, category: null, setting: null, time: null, weather: null, description: null, tags: [], ...over });

describe('bgCategory', () => {
  it('decor is never auto-selectable; insert only for insert; event only for event; duplicates never', () => {
    const mk = (category: string, dup = false) => entry({ id: 'x', labels: { ...LABEL_FILE.labels[stage(12)]!, category: category as never, ...(dup ? { duplicateOf: 'y' } : {}) } });
    for (const use of ['scene', 'insert', 'event'] as const) expect(autoSelectable(mk('decor'), use)).toBe(false);
    expect(autoSelectable(mk('scene'), 'scene')).toBe(true);
    expect(autoSelectable(mk('insert'), 'scene')).toBe(false);
    expect(autoSelectable(mk('insert'), 'insert')).toBe(true);
    expect(autoSelectable(mk('event'), 'scene')).toBe(false);
    expect(autoSelectable(mk('event'), 'event')).toBe(true);
    expect(autoSelectable(mk('scene', true), 'scene')).toBe(false);
  });
  it('manual selection hides decor unless the switch is on', () => {
    const d = entry({ id: '4', kind: 'card' });
    expect(bgCategoryOf(d)).toBe('decor');
    expect(manualSelectable(d, false)).toBe(false);
    expect(manualSelectable(d, true)).toBe(true);
    expect(manualSelectable(entry({ id: '14', kind: 'card' }), false)).toBe(true);
  });
  it('the real label file: 349 entries with title, description and category; category counts match the content pass', () => {
    const labels = Object.values(LABEL_FILE.labels);
    expect(labels).toHaveLength(349);
    for (const l of labels) {
      expect(l.title && l.description && l.category).toBeTruthy();
    }
    const n = (c: string) => labels.filter((l) => l.category === c).length;
    expect([n('scene'), n('insert'), n('decor'), n('event')]).toEqual([302, 19, 23, 5]);
    expect(new Set(labels.map((l) => l.title)).size).toBe(349);
  });
});

describe('digest', () => {
  const d = breakdownDigest(cat);
  const ids = new Set(d.split('\n').map((l) => l.split('｜')[0]!));
  const section = (title: string) => {
    const lines = d.split('\n');
    const i = lines.findIndex((l) => l.startsWith(`## ${title}`));
    if (i < 0) return [];
    const out: string[] = [];
    for (let k = i + 1; k < lines.length && lines[k] !== ''; k++) out.push(lines[k]!.split('｜')[0]!);
    return out;
  };
  it('lists no decor, logos, plain colours, UI shots or duplicate copies in the story table', () => {
    const story = new Set(section('背景'));
    for (const n of [...Array(13).keys()].map((i) => String(i + 1))) expect(story.has(n), n).toBe(false);
    for (const n of [212, 213, 214, 215, 216, 217, 218, 318, 319, 333]) expect(story.has(stage(n)), String(n)).toBe(false);
    for (const [copy] of duplicateLinks()) expect(story.has(copy), copy).toBe(false);
    expect(ids.has('4')).toBe(false);
  });
  it('cut-away candidates and special pictures are separate tables; the digest is byte-stable', () => {
    const ins = section('插入镜头候选');
    expect(ins).toHaveLength(19);
    expect(ins).toContain(stage(204));
    expect(section('背景')).not.toContain(stage(204));
    expect(section('特殊画面')).toEqual([stage(102), stage(243), stage(256), stage(327)]);
    expect(breakdownDigest(labelCatalog())).toBe(d);
  });
});

// dev-notes/ is a local folder (not in the repository): without the content pass only the committed result can be checked
const CONTENT_FILE = 'dev-notes/bg-content.json';
describe.skipIf(!fs.existsSync(CONTENT_FILE))('import of the content pass', () => {
  const content = JSON.parse(fs.readFileSync(CONTENT_FILE, 'utf8')) as BgContent;
  it('is idempotent and never touches the ownership the user confirmed', () => {
    const before = LabelFileSchema.parse(JSON.parse(fs.readFileSync('asset-labels/backgrounds.json', 'utf8')));
    // start from the file as it was before the import: strip the content fields
    const stripped: LabelFile = JSON.parse(JSON.stringify(before));
    for (const [id, l] of Object.entries(stripped.labels)) {
      if (content[id]?.isNew) delete stripped.labels[id];
      else for (const k of ['title', 'description', 'tags', 'category', 'duplicateOf', 'fixes', 'fixesImported'] as const) delete l[k];
    }
    const once = JSON.parse(JSON.stringify(stripped)) as LabelFile;
    const s1 = mergeBgContent(once, content, '2026-10-13');
    expect(s1.added).toBe(8);
    expect(s1.fixesQueued).toBe(37);
    expect(Object.keys(once.labels)).toHaveLength(349);
    for (const [id, l] of Object.entries(once.labels)) {
      expect(l.title && l.category && l.description, id).toBeTruthy();
      const old = stripped.labels[id];
      if (old?.source === 'user') for (const k of ['bands', 'owner', 'residents', 'placeName', 'location', 'exclusive', 'access', 'stage'] as const) expect(l[k], `${id}.${k}`).toEqual(old[k]);
      if (old) for (const k of ['bands', 'owner', 'residents', 'placeName', 'location'] as const) expect(l[k], `${id}.${k}`).toEqual(old[k]);
    }
    const twice = JSON.parse(JSON.stringify(once)) as LabelFile;
    const s2 = mergeBgContent(twice, content, '2026-10-13');
    expect(s2).toMatchObject({ updated: 0, added: 0, fixesQueued: 0, duplicatesLinked: 0 });
    expect(twice).toEqual(once);
  });
  it('fixes are suggestions only: the fields they talk about are not changed', () => {
    const f = LABEL_FILE.labels[stage(39)]!;
    expect(f.fixes?.length).toBeGreaterThan(0);
    expect(f.placeType).toBe('cafe');
    expect(LABEL_FILE.labels[stage(81)]!.owner).toBe('千早爱音');
  });
  it('the committed file matches what the importer produces', () => {
    const s = JSON.parse(JSON.stringify(LABEL_FILE)) as LabelFile;
    expect(mergeBgContent(s, content).updated).toBe(0);
  });
  it('duplicate pairs resolve to catalog ids', () => {
    expect(DUPLICATE_PAIRS).toHaveLength(18);
    const links = new Map(duplicateLinks());
    expect(links.get('23')).toBe(advId('001'));
    expect(links.get(advId('333'))).toBe(advId('217'));
    for (const [copy, master] of links) {
      expect(LABEL_FILE.labels[copy], copy).toBeDefined();
      expect(LABEL_FILE.labels[master], master).toBeDefined();
    }
  });
});

const scene = (over: Partial<Breakdown['scenes'][number]> & { bg: string }): Breakdown['scenes'][number] => {
  const { bg: id, ...rest } = over;
  return {
    title: '放学路上', startParagraph: 0, endParagraph: 6, location: { backgroundId: id, reason: '学校' }, timeOfDay: '日间',
    presentCast: ['001', '002'], wardrobe: [], mood: '平静', isPerformance: false, band: null, ...rest,
  };
};
const fix = (s: Breakdown['scenes'][number]) => {
  s.wardrobe = s.presentCast.map((k) => ({ characterKey: k, modelId: `${k}_casual_spring_01`, reason: 'x' }));
  return validateBreakdown({ cast: [], scenes: [s] }, { catalog: cat, paragraphCount: 7 });
};

describe('validation: decor / insert / moves', () => {
  it('a decor start background (the MyGO logo, id 4) is replaced by a compliant story background, with a warning', () => {
    const r = fix(scene({ bg: '4' }));
    const nb = r.value.scenes[0]!.location.backgroundId;
    expect(nb).not.toBe('4');
    expect(autoSelectable(L.backgrounds.get(nb)!, 'scene')).toBe(true);
    expect(r.warnings.some((w) => w.includes('装饰素材') && w.includes('已换成'))).toBe(true);
    expect(fix(scene({ bg: '4' })).value.scenes[0]!.location.backgroundId).toBe(nb);
  });
  it('an insert picture as the start background is replaced as well; so is a duplicate copy', () => {
    expect(fix(scene({ bg: stage(204) })).value.scenes[0]!.location.backgroundId).not.toBe(stage(204));
    const r = fix(scene({ bg: '23' }));
    expect(r.value.scenes[0]!.location.backgroundId).not.toBe('23');
  });
  it('moves: decor and band conflicts are repaired, one per paragraph, no repeat of the shown place, capped at 3', () => {
    const base = scene({ bg: stage(150) });
    const move = (paragraph: number, backgroundId: string) => ({ paragraph, backgroundId, reason: '走过去', transition: 'cut' as const });
    const r = fix({
      ...base,
      moves: [move(1, '4'), move(1, stage(92)), move(2, stage(64)), move(3, stage(92)), move(4, stage(150)), move(5, stage(150)), move(6, stage(204)), move(99, stage(40))],
    });
    const moves = r.value.scenes[0]!.moves!;
    expect(moves.length).toBeLessThanOrEqual(3);
    for (const m of moves) {
      const b = L.backgrounds.get(m.backgroundId)!;
      expect(autoSelectable(b, 'scene'), m.backgroundId).toBe(true);
      expect(m.paragraph).toBeGreaterThanOrEqual(0);
      expect(m.paragraph).toBeLessThanOrEqual(6);
    }
    expect(new Set(moves.map((m) => m.paragraph)).size).toBe(moves.length);
    for (let i = 1; i < moves.length; i++) expect(moves[i]!.backgroundId).not.toBe(moves[i - 1]!.backgroundId);
    expect(r.warnings.some((w) => w.includes('移动') && w.includes('装饰素材'))).toBe(true);
    expect(r.warnings.some((w) => w.includes('合并'))).toBe(true);
    expect(fix({ ...base, moves: base.moves ?? [move(1, '4'), move(1, stage(92)), move(2, stage(64)), move(3, stage(92)), move(4, stage(150)), move(5, stage(150)), move(6, stage(204)), move(99, stage(40))] }).value.scenes[0]!.moves).toEqual(moves);
  });
  it('a band conflict in a move is replaced (Ave Mujica home for MyGO)', () => {
    const r = fix({ ...scene({ bg: stage(150) }), moves: [{ paragraph: 2, backgroundId: stage(64), reason: '去祥子家', transition: 'cut' }] });
    const m = r.value.scenes[0]!.moves?.[0];
    expect(m?.backgroundId).not.toBe(stage(64));
    expect(r.warnings.some((w) => w.includes('已换成'))).toBe(true);
  });
});

describe('rule director: place changes inside a scene', () => {
  const NOVEL = '放学后，灯和爱音一起走出校门。\n她们沿着街道走，来到车站前，灯停下了脚步。\n“明天见。”爱音挥了挥手。\n之后灯回到爱音的房间，爱音躺在床上看着天花板。';
  it('one scene with the school gate, the station and Anon’s room; all compliant, no decor', () => {
    const b = ruleBreakdown(cat, splitParagraphs(NOVEL), { minScene: 99 });
    expect(b.scenes).toHaveLength(1);
    const s = b.scenes[0]!;
    const ids = [s.location.backgroundId, ...(s.moves ?? []).map((m) => m.backgroundId)];
    expect(ids).toHaveLength(3);
    expect(s.moves!.map((m) => m.paragraph)).toEqual([1, 3]);
    expect(L.backgrounds.get(ids[0]!)!.name).toContain('校门');
    expect(L.backgrounds.get(ids[1]!)!.tags.join('')).toContain('车站');
    expect(L.backgrounds.get(ids[2]!)!.name).toContain('爱音家');
    for (const id of ids) expect(autoSelectable(L.backgrounds.get(id)!, 'scene')).toBe(true);
    const v = validateBreakdown(b, { catalog: cat, paragraphCount: 4 });
    expect(v.value.scenes[0]!.moves).toHaveLength(2);
  });
  it('a text without place words produces no move', () => {
    const b = ruleBreakdown(cat, splitParagraphs('灯看着爱音。\n“你好。”爱音说。\n两人都沉默了一会儿。'), { minScene: 99 });
    expect(b.scenes[0]!.moves).toBeUndefined();
  });
  it('the whole rule pipeline writes background keys, compiles, and switches the picture while playing', async () => {
    const d = { provider: new RuleProvider(cat), cache: null, catalog: cat, now: () => 7000 };
    const r = await runBreakdown(d, NOVEL, '放学', 'g1');
    const project = r.project;
    const sc = project.scenes[0]!;
    expect(sc.brief?.moves).toHaveLength(2);
    expect(sc.tracks.filter((t) => t.channel === 'background')[0]!.keys).toHaveLength(2);
    const items = await runScenes(d, project, [sc.id], ['scene'], 'g2', 1);
    const directed = items[0]!.result!.scene;
    const keys = directed.tracks.filter((t) => t.channel === 'background').flatMap((t) => t.keys);
    expect(keys).toHaveLength(2);
    expect(keys.every((k) => k.meta.source === 'rule')).toBe(true);
    const full = { ...project, scenes: [directed] };
    const compiled = compileProject(full, compileContext(cat));
    const segs = compiled.scenes[0]!.bgSegments;
    expect(segs).toHaveLength(3);
    expect(segs.every((g, i) => i === 0 || g.start > segs[i - 1]!.start)).toBe(true);
    for (const g of segs) expect(autoSelectable(L.backgrounds.get(g.assetId)!, 'scene')).toBe(true);
    expect(evaluate(compiled, segs[2]!.start + 0.2).background.assetId).toBe(segs[2]!.assetId);
    expect(checkContinuity(full, catalogLookups(cat)).filter((w) => w.kind.startsWith('bg_switch'))).toEqual([]);
  });
});

describe('anchorMoves', () => {
  it('lands on the first beat at or after the paragraph; several in one paragraph take successive beats; the last wins when beats run out', () => {
    expect(anchorMoves([{ paragraph: 2 }, { paragraph: 9 }], [0, 0, 1, 2, 2]).map((a) => a.index)).toEqual([3, 4]);
    expect(anchorMoves([{ paragraph: 2, n: 1 }, { paragraph: 2, n: 2 }], [1, 2, 2, 3]).map((a) => a.index)).toEqual([1, 2]);
    const r = anchorMoves([{ paragraph: 2, n: 1 }, { paragraph: 2, n: 2 }], [1, 2, 3]);
    expect(r).toHaveLength(1);
    expect(r[0]!.move.n).toBe(2);
  });
});

describe('continuity of background switches', () => {
  it('flags decor, band conflicts, too many switches and a decor start background', async () => {
    const d = { provider: new RuleProvider(cat), cache: null, catalog: cat, now: () => 7000 };
    const { project } = await runBreakdown(d, '灯和爱音在教室里说话。\n“你好。”爱音说。\n“嗯。”灯点头。', 'x', 'g1');
    const sc = project.scenes[0]!;
    const beatId = sc.beats[0]!.id;
    const key = (id: string, assetId: string) => ({ id, at: { beatId, offset: 0 }, value: { assetId, transition: 'cut' as const, transitionSeconds: 0.5, purpose: 'move' as const }, duration: 0, ease: 'inOutQuad' as const, meta: { source: 'user' as const, locked: false, updatedAt: 0 } });
    const meta = { source: 'user' as const, locked: false, updatedAt: 0 };
    const withKeys = (assets: string[], start = sc.background.assetId) => ({
      ...project,
      scenes: [{ ...sc, background: { ...sc.background, assetId: start }, tracks: [{ id: 'tb', target: { kind: 'stage' as const }, channel: 'background' as const, meta, keys: assets.map((a, i) => key(`k${i}`, a)) }] }],
    });
    const kinds = (p: ReturnType<typeof withKeys>) => checkContinuity(p, catalogLookups(cat)).map((w) => w.kind);
    expect(kinds(withKeys([stage(150)]))).not.toContain('bg_switch_decor');
    expect(kinds(withKeys(['4']))).toContain('bg_switch_decor');
    expect(kinds(withKeys([stage(64)]))).toContain('bg_switch_band_conflict');
    expect(kinds(withKeys([...Array(7)].map((_, i) => (i % 2 ? stage(150) : stage(151)))))).toContain('bg_switch_too_many');
    expect(kinds(withKeys([], '4'))).toContain('bg_start_category');
  });
});

describe('recorded model output: the replayed example novel', () => {
  it('no scene starts on, or switches to, a decor / insert picture; the scene with a stated place change has a move key that survives scene direction', async () => {
    const d = { provider: new FixtureProvider(FIXTURE_DIR), cache: null, catalog: fixtureCat, now: () => 5000 };
    const r = await runBreakdown(d, STORY, '示例', 'g1');
    const withMoves = r.project.scenes.filter((sc) => (sc.brief?.moves?.length ?? 0) > 0);
    expect(withMoves).toHaveLength(1);
    const items = await runScenes(d, r.project, r.project.scenes.map((sc) => sc.id), ['scene'], 'g2', 3);
    for (const sc of r.project.scenes) {
      const directed = items.find((i) => i.sceneId === sc.id)!.result!.scene;
      const ids = [directed.background.assetId, ...directed.tracks.filter((t) => t.channel === 'background').flatMap((t) => t.keys.map((k) => k.value.assetId))];
      for (const id of ids) expect(autoSelectable(lookup(fixtureCat).backgrounds.get(id)!, 'scene'), id).toBe(true);
      if (sc.id === withMoves[0]!.id) {
        const keys = directed.tracks.filter((t) => t.channel === 'background').flatMap((t) => t.keys);
        expect(keys.length).toBeGreaterThanOrEqual(1);
        expect(keys[0]!.value.purpose).toBe('move');
        expect(keys[0]!.meta.source).toBe('rule'); // the replay provider is never labelled as AI
      }
    }
  });
});

describe('Pass 2: background switches of the beats', () => {
  const TEXT = '灯和爱音在教室里说话。\n“你好。”爱音说。\n“嗯。”灯点头。\n两人抬头看了看窗外。\n“走吧。”爱音说。';
  const setup = async () => {
    const d = { provider: new RuleProvider(cat), cache: null, catalog: cat, now: () => 7000 };
    const { project } = await runBreakdown(d, TEXT, 'x', 'g1');
    const sc = project.scenes[0]!;
    const res = (await runScenes(d, project, [sc.id], ['scene'], 'g2', 1))[0]!.result!;
    const paragraphs = splitParagraphs(TEXT);
    const ctx = (allowed: string[]) => ({
      catalog: cat, paragraphs, range: { start: 0, end: paragraphs.length - 1 }, isPerformance: false,
      cast: Object.entries(sc.wardrobe).map(([castId, w]) => ({ castId, characterKey: project.cast.find((c) => c.id === castId)!.characterKey, modelId: w.modelId })),
      backgrounds: { start: sc.background.assetId, allowed: new Set([sc.background.assetId, ...allowed]), scope: { title: sc.title, reason: '', mood: '', timeOfDay: '白天', isPerformance: false, presentCast: ['001', '002'] } },
    });
    return { project, sc, dir: res.direction, ctx };
  };
  const other = stage(150);
  const sky = stage(204);

  it('decor / unknown / outside-the-set backgrounds are dropped with a warning; a repeat of the shown picture is dropped', async () => {
    const { sc, dir, ctx } = await setup();
    const d = JSON.parse(JSON.stringify(dir)) as typeof dir;
    d.beats[0]!.bg = { backgroundId: '4', transition: 'cut' };
    d.beats[1]!.bg = { backgroundId: 'nope', transition: 'cut' };
    d.beats[2]!.bg = { backgroundId: other, transition: 'dip_black' };
    d.beats[3]!.bg = { backgroundId: other, transition: 'cut' };
    d.beats[4]!.bg = { backgroundId: stage(92), transition: 'cut' };
    const v = validateDirection(d, ctx([other]));
    expect(v.value.beats.slice(0, 5).map((b) => b.bg?.backgroundId ?? null)).toEqual([null, null, other, null, null]);
    expect(v.value.beats.slice(5).every((b) => !b.bg)).toBe(true);
    const text = v.warnings.join('\n');
    expect(text).toContain('装饰素材');
    expect(text).toContain('不存在');
    expect(text).toContain('已经是背景');
    expect(text).toContain('不在本场景的背景集合');
    expect(sc.background.assetId).not.toBe(other);
    // deterministic
    expect(validateDirection(d, ctx([other])).value).toEqual(v.value);
  });

  it('a cut-away picture needs an insert shot without a person; it hides the people for one beat and returns at the next', async () => {
    const { project, sc, dir, ctx } = await setup();
    const d = JSON.parse(JSON.stringify(dir)) as typeof dir;
    d.beats[1]!.bg = { backgroundId: sky, transition: 'cut' };
    const bad = validateDirection(d, ctx([sky]));
    expect(bad.value.beats[1]!.bg).toBeUndefined();
    expect(bad.warnings.join('')).toContain('插入镜头背景');
    d.beats[1]!.shot = { type: 'insert', focus: [], move: 'static', dof: null, insertTarget: 'scene' };
    const ok = validateDirection(d, ctx([sky]));
    expect(ok.value.beats[1]!.bg?.backgroundId).toBe(sky);
    expect(ok.value.beats[1]!.shot).toMatchObject({ type: 'group', focus: [], insertTarget: null });
    const { scene } = expandScene({ base: sc, direction: ok.value, paragraphs: splitParagraphs(TEXT), genId: 'g', now: 1, decisions: 'rule', isInsertBg: (id) => id === sky });
    const keys = scene.tracks.filter((t) => t.channel === 'background').flatMap((t) => t.keys);
    expect(keys.map((k) => [k.at.beatId, k.value.assetId, k.value.purpose])).toEqual([[scene.beats[1]!.id, sky, 'insert'], [scene.beats[2]!.id, sc.background.assetId, 'move']]);
    const compiled = compileProject({ ...project, scenes: [scene] }, compileContext(cat));
    const cs = compiled.scenes[0]!;
    expect(cs.bgSegments.map((g) => g.purpose)).toEqual(['move', 'insert', 'move']);
    const bt = (i: number) => cs.beats.find((b) => b.id === scene.beats[i]!.id)!;
    const mid = evaluate(compiled, bt(1).start + 0.5);
    expect(mid.background.assetId).toBe(sky);
    expect(mid.actors.every((a) => a.opacity === 0 || a.opacity === 1)).toBe(true);
    expect(cs.actors.every((a) => a.presence.some((k) => k.value === 0 && Math.abs(k.at - bt(1).start) < 1e-6))).toBe(true);
  });
});

describe('project exchange knows the background track', () => {
  it('collects the pictures of the switches and replaces them when a missing one is mapped', async () => {
    const d = { provider: new RuleProvider(cat), cache: null, catalog: cat, now: () => 7000 };
    const { project } = await runBreakdown(d, '放学后，灯和爱音一起走出校门。\n她们沿着街道走，来到车站前，灯停下了脚步。\n“明天见。”爱音挥了挥手。', 'x', 'g1');
    const moveBg = project.scenes[0]!.brief!.moves![0]!.backgroundId;
    expect(collectRefs(project).backgrounds).toContain(moveBg);
    const next = replaceRef(project, 'background', moveBg, stage(92));
    expect(next.scenes[0]!.tracks.flatMap((t) => (t.channel === 'background' ? t.keys.map((k) => k.value.assetId) : []))).toContain(stage(92));
    expect(next.scenes[0]!.tracks.flatMap((t) => (t.channel === 'background' ? t.keys.map((k) => k.value.assetId) : []))).not.toContain(moveBg);
  });
});
