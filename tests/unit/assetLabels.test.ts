import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import bandsJson from '../../shared/data/bands.json';
import charsJson from '../../shared/data/characters.json';
import { allowedBackgrounds, bgFit, sceneBands } from '../../shared/director/bandFit';
import { breakdownDigest } from '../../shared/director/catalogDigest';
import { catalogLookups, checkContinuity } from '../../shared/director/continuity';
import { lookup, type DirectorCatalog } from '../../shared/director/resources';
import { ruleBreakdown } from '../../shared/director/ruleDirector';
import { splitParagraphs } from '../../shared/director/paragraphs';
import { validateBreakdown } from '../../shared/director/validate';
import { blankProject } from '../../shared/project/blank';
import type { Breakdown } from '../../shared/schema/ai';
import { BgLabelSchema, LabelFileSchema, type BgLabel, type LabelRules } from '../../shared/schema/assetLabels';
import type { BackgroundEntry } from '../../shared/schema/assets';

const FILE = LabelFileSchema.parse(JSON.parse(fs.readFileSync('tests/fixtures/backgrounds.labels.fixture.json', 'utf8')));
const stage = (n: number) => `adv_bkg_stage_${String(n).padStart(6, '0')}`;

const bg = (id: string, label: BgLabel): BackgroundEntry => ({
  id, url: `/x/${id}.png`, width: 10, height: 10, name: label.nameOverride ?? id, aliases: [], kind: 'scene', location: label.location, category: null,
  setting: label.indoor === 'outdoor' ? '室外' : '室内', time: label.time === 'night' ? '夜间' : '日间', weather: null, description: null, tags: [], labels: label,
});
const catalog = (rules: LabelRules = { unknownPolicy: 'avoid' }): DirectorCatalog => ({
  models: charsJson.characters.map((c) => ({
    id: `${c.key}_casual_spring_01`, characterKey: c.key, isSub: false, costume: 'casual_spring_01',
    costumeInfo: { base: 'casual', glasses: false, quality: '', mode: 'adv', still: false, tags: [] }, mode: 'adv', quality: '', still: false, hasPhysics: false, url: '', preview: null,
    textureCount: 0, motions: [], expressions: [], missingFiles: [],
  }) as never),
  backgrounds: Object.entries(FILE.labels).map(([id, l]) => bg(id, l)),
  audio: [],
  characters: charsJson.characters.map((c) => ({ key: c.key, name: c.name, nickname: null, bandKey: c.band, bandName: c.band, role: c.role, color: null, isSub: false, aliases: [], modelIds: [] })),
  bands: bandsJson.bands.map((b) => ({ key: b.key, name: b.name, memberKeys: b.members, formation: b.formation })),
  labelRules: rules,
});
const cat = catalog();
const L = lookup(cat);
const who = (...keys: string[]) => ({ bands: sceneBands(L.characters, keys), cast: keys });
const label = (id: string) => FILE.labels[id]!;

describe('background label file', () => {
  it('has 349 valid labels and the user answers', () => {
    expect(Object.keys(FILE.labels)).toHaveLength(349);
    for (const l of Object.values(FILE.labels)) expect(() => BgLabelSchema.parse(l)).not.toThrow();
    const unknown = Object.values(FILE.labels).filter((l) => l.bands.length === 0);
    expect(unknown.length).toBeGreaterThan(0);
    expect(unknown.every((l) => l.confidence === 'unknown')).toBe(true);
    expect(label(stage(46)).bands).toEqual(['avemujica']);
    expect(label(stage(46)).location).toBe('祥子家');
    for (const id of ['27', '28', stage(22)]) expect(label(id)).toMatchObject({ homeBand: 'dumbrock', exclusive: false, bands: ['generic'] });
    for (const id of ['20', stage(257), stage(320)]) expect(label(id)).toMatchObject({ bands: ['mewtype'], exclusive: true, confidence: 'confirmed' });
    expect(label(stage(320)).stage).toBe(true);
    for (const n of [61, 62, 95, 96]) expect(label(stage(n)).bands).toEqual(['generic']);
    expect(label(stage(313)).owner).toBe('峰月律');
    expect(label(stage(314)).owner).toBe('峰月律');
    expect(label(stage(266))).toMatchObject({ bands: [], owner: null });
    expect(label(stage(267))).toMatchObject({ owner: '仲町阿拉蕾', bands: ['mewtype'], usage: { activity: 'singing', rarity: 'rare' } });
  });

  it('rejects malformed labels', () => {
    expect(() => BgLabelSchema.parse({ ...label(stage(1)), access: 'nope' })).toThrow();
    expect(() => LabelFileSchema.parse({ version: 2, labels: {} })).toThrow();
  });
});

describe('bgFit', () => {
  it('generic and unlabelled backgrounds are open to everyone', () => {
    expect(bgFit(undefined, who('001'))).toBe('ok');
    expect(bgFit(label(stage(61)), who('001', '006'))).toBe('ok');
  });

  it('exclusive band spaces reject other bands (MyGO may not use Ave Mujica places or Win-Wing)', () => {
    for (const id of ['18', stage(64), stage(65), '17', stage(47)]) expect(bgFit(label(id), who('001', '002')), id).toBe('no');
    expect(bgFit(label('18'), who('006', '009'))).toBe('ok');
    expect(bgFit(label('18'), who('001', '006'))).toBe('no'); // mixed scene: every band must fit
  });

  it("a private home needs a resident on stage: Anon's house only when Anon is there", () => {
    expect(bgFit(label(stage(81)), who('002', '004'))).toBe('ok');
    expect(bgFit(label(stage(81)), who('001', '004'))).toBe('no');
    expect(bgFit(label(stage(81)), { ...who('001', '004'), guestOf: '002' })).toBe('ok'); // a visit
    expect(bgFit(label(stage(81)), who('006', '007'))).toBe('no');
  });

  it('Roarin Nest is open to every band', () => {
    expect(bgFit(label('28'), who('001'))).toBe('ok');
    expect(bgFit(label('28'), who('006'))).toBe('ok');
  });

  it('unknown ownership follows the configurable policy', () => {
    const u = label(stage(12));
    expect(u.bands).toEqual([]);
    expect(bgFit(u, who('001'))).toBe('fallback');
    expect(bgFit(u, who('001'), { unknownPolicy: 'allow' })).toBe('ok');
    expect(bgFit(u, who('001'), { unknownPolicy: 'forbid' })).toBe('no');
  });

  it('usage conditions (267: rarely, only when Arale is low and singing)', () => {
    const l = label(stage(267));
    const w = who('011');
    expect(bgFit(l, w)).toBe('no');
    expect(bgFit(l, { ...w, mood: '低落', text: '她一个人唱歌' })).toBe('ok');
    expect(bgFit(l, { ...w, mood: '低落', text: '她在发呆' })).toBe('no');
    expect(bgFit(l, { ...who('012'), mood: '低落', text: '唱歌' })).toBe('no'); // Arale not there
  });
});

describe('allowedBackgrounds', () => {
  it('unknown labels are not candidates; performances need stages that fit', () => {
    const { ok, fallback } = allowedBackgrounds(cat.backgrounds, who('001', '002'));
    expect(ok.some((b) => b.labels!.bands.length === 0)).toBe(false);
    expect(fallback.length).toBeGreaterThan(0);
    expect(ok.some((b) => ['avemujica', 'millsage'].includes(b.labels!.bands[0]!) && b.labels!.exclusive)).toBe(false);
    const perf = allowedBackgrounds(cat.backgrounds, who('001', '002'), { performance: true }).ok;
    expect(perf.length).toBeGreaterThan(0);
    expect(perf.every((b) => b.labels!.stage)).toBe(true);
    expect(perf.some((b) => b.labels!.bands[0] === 'avemujica')).toBe(false);
    const mew = allowedBackgrounds(cat.backgrounds, who('011', '012'), { performance: true }).ok.map((b) => b.id);
    expect(mew).toContain(stage(320));
    expect(allowedBackgrounds(cat.backgrounds, who('001'), { performance: true }).ok.map((b) => b.id)).not.toContain(stage(320));
  });
});

const scene = (over: Partial<Breakdown['scenes'][number]> & { bg: string }): Breakdown['scenes'][number] => {
  const { bg: id, ...rest } = over;
  return {
    title: '练习', startParagraph: 0, endParagraph: 0, location: { backgroundId: id, reason: '练习室' }, timeOfDay: '日间',
    presentCast: ['001', '002'], wardrobe: [], mood: '平静', isPerformance: false, band: null, ...rest,
  };
};

describe('validateBreakdown background repair', () => {
  const fix = (s: Breakdown['scenes'][number]) => {
    const keys = s.presentCast;
    s.wardrobe = keys.map((k) => ({ characterKey: k, modelId: `${k}_casual_spring_01`, reason: 'x' }));
    return validateBreakdown({ cast: [], scenes: [s] }, { catalog: cat, paragraphCount: 1 });
  };

  it('MyGO in an Ave Mujica place is moved to a compliant background, with a warning', () => {
    for (const n of ['18', stage(64), '17']) {
      const r = fix(scene({ bg: n }));
      const nb = r.value.scenes[0]!.location.backgroundId;
      expect(nb).not.toBe(n);
      expect(bgFit(label(nb), who('001', '002'))).toBe('ok');
      expect(r.warnings.some((w) => w.includes('已换成') && w.includes(nb))).toBe(true);
      expect(fix(scene({ bg: n })).value.scenes[0]!.location.backgroundId).toBe(nb); // deterministic
    }
  });

  it("Anon's house is kept when Anon is there, replaced when she is not", () => {
    expect(fix(scene({ bg: stage(81), presentCast: ['002', '004'] })).value.scenes[0]!.location.backgroundId).toBe(stage(81));
    const r = fix(scene({ bg: stage(81), presentCast: ['001', '004'] }));
    expect(r.value.scenes[0]!.location.backgroundId).not.toBe(stage(81));
    expect(fix(scene({ bg: stage(81), presentCast: ['001', '004'], location: { backgroundId: stage(81), reason: '去爱音家', guestOf: '002' } })).value.scenes[0]!.location.backgroundId).toBe(stage(81));
  });

  it('a performance needs a stage that fits the band (exclusive respected)', () => {
    const r = fix(scene({ bg: stage(12), presentCast: ['001', '002', '003'], isPerformance: true, band: 'mygo' }));
    const nb = L.backgrounds.get(r.value.scenes[0]!.location.backgroundId)!;
    expect(nb.labels!.stage).toBe(true);
    expect(bgFit(nb.labels, who('001', '002', '003'))).toBe('ok');
    const mew = fix(scene({ bg: stage(320), presentCast: ['001', '002'], isPerformance: true, band: 'mygo' }));
    expect(mew.value.scenes[0]!.location.backgroundId).not.toBe(stage(320));
    expect(fix(scene({ bg: stage(320), presentCast: ['011', '012'], isPerformance: true, band: 'mewtype' })).value.scenes[0]!.location.backgroundId).toBe(stage(320));
  });

  it('unknown ownership is kept but flagged', () => {
    const r = fix(scene({ bg: stage(12) }));
    expect(r.value.scenes[0]!.location.backgroundId).toBe(stage(12));
    expect(r.warnings.some((w) => w.includes('主人不明'))).toBe(true);
  });
});

describe('digest', () => {
  const d = breakdownDigest(cat);
  it('has band and stage columns and never lists unknown or rare backgrounds', () => {
    expect(d).toContain('背景（id｜标题｜地点｜室内外｜时间｜乐队｜舞台｜画面内容）');
    const row = d.split('\n').find((l) => l.startsWith(`${stage(64)}｜`))!;
    expect(row).toContain('Ave Mujica专属');
    expect(row.split('｜')[6]).toBe('否');
    expect(d.split('\n').some((l) => l.startsWith(`${stage(12)}｜`))).toBe(false);
    expect(d.split('\n').some((l) => l.startsWith(`${stage(267)}｜`))).toBe(false);
    expect(d.split('\n').some((l) => l.startsWith(`${stage(81)}｜`) && l.includes('爱音家'))).toBe(true);
  });
  it('is byte-stable', () => {
    expect(breakdownDigest(catalog())).toBe(d);
  });
  it('lists unknown backgrounds when the policy allows them', () => {
    expect(breakdownDigest(catalog({ unknownPolicy: 'allow' })).split('\n').some((l) => l.startsWith(`${stage(12)}｜`))).toBe(true);
  });
});

describe('rule director', () => {
  it('a MyGO rehearsal never lands in an Ave Mujica place', () => {
    const paras = splitParagraphs('灯和爱音在练习室里排练。\n“再来一遍。”爱音说。\n立希点点头，练习室里响起鼓声。');
    const c = { ...cat, characters: cat.characters.map((x) => ({ ...x, nickname: x.name.slice(-1) === '灯' ? '灯' : x.key === '002' ? '爱音' : x.key === '005' ? '立希' : null })) };
    const b = ruleBreakdown(c, paras);
    for (const s of b.scenes) {
      const l = L.backgrounds.get(s.location.backgroundId)!.labels!;
      expect(bgFit(l, who(...s.presentCast)), s.location.backgroundId).toBe('ok');
      expect(l.bands.length).toBeGreaterThan(0);
    }
  });
});

describe('continuity', () => {
  it('flags manual conflicts, unknown owners and non-stage performances', () => {
    const p = blankProject('t', 1);
    p.cast.push({ id: 'c1', characterKey: '001', displayName: '灯', meta: { source: 'user', locked: false, updatedAt: 1 } } as never);
    const meta = { source: 'user', locked: false, updatedAt: 1 } as never;
    const mk = (assetId: string, perf = false) => ({
      id: 's', title: '场景', meta, brief: { timeOfDay: '', mood: '', isPerformance: perf, band: null }, background: { assetId, framing: { zoom: 1, offsetX: 0, offsetY: 0 }, meta },
      wardrobe: { c1: { modelId: '001_casual_spring_01', meta } }, blocking: {}, beats: [], tracks: [],
    }) as never;
    const lk = catalogLookups(cat as never);
    const kinds = (assetId: string, perf?: boolean) => { p.scenes = [mk(assetId, perf)]; return checkContinuity(p, lk).map((w) => w.kind); };
    expect(kinds(stage(18))).toContain('bg_band_conflict');
    expect(kinds(stage(12))).toContain('bg_unknown_owner');
    expect(kinds(stage(61), true)).toContain('bg_not_stage');
    expect(kinds(stage(61))).toEqual([]);
  });
});

describe('example novel through the rule director', () => {
  it('every scene background is legal for MyGO and continuity shows no band conflict', async () => {
    const { runBreakdown } = await import('../../server/llm/director');
    const { RuleProvider } = await import('../../server/llm/ruleProvider');
    const nick: Record<string, string> = { '001': '灯', '002': '爱音', '003': '乐奈', '004': '爽世', '005': '立希' };
    const c = { ...cat, characters: cat.characters.map((x) => ({ ...x, nickname: nick[x.key] ?? null, aliases: nick[x.key] ? [nick[x.key]!] : [] })) };
    const novel = fs.readFileSync('examples/mygo-rehearsal.txt', 'utf8');
    const r = await runBreakdown({ provider: new RuleProvider(c), cache: null, catalog: c, now: () => 1 }, novel, 'x', 'g');
    expect(r.project.scenes.length).toBeGreaterThan(0);
    for (const s of r.project.scenes) {
      const keys = Object.keys(s.wardrobe).map((id) => r.project.cast.find((m) => m.id === id)!.characterKey);
      expect(bgFit(label(s.background.assetId), who(...keys)), `${s.title} ${s.background.assetId}`).toBe('ok');
    }
    const bad = checkContinuity(r.project, catalogLookups(c as never)).filter((w) => w.kind.startsWith('bg_'));
    expect(bad).toEqual([]);
  });
});
