import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runBreakdown } from '../../server/llm/director';
import { RuleProvider } from '../../server/llm/ruleProvider';
import { runScene, runScenes } from '../../server/llm/sceneRunner';
import { checkContinuity } from '../../shared/director/continuity';
import { diffScene } from '../../shared/director/diff';
import { mergeLocks } from '../../shared/director/mergeLocks';
import { chunkParagraphs, detectChapters, splitParagraphs } from '../../shared/director/paragraphs';
import { segments } from '../../shared/director/ruleDirector';
import { findLockViolations } from '../../shared/project/locks';
import { compileProject } from '../../shared/timeline/compile';
import { line, measureGroup } from './helpers/groupMeasure';
import { faceLayout } from '../../shared/staging/framing';
import { OURNOTES_STYLE } from '../../shared/style/ournotes';
import { STORY, compileContext, fixtureCatalog } from './helpers/directorCatalog';

const base = fixtureCatalog(['002', '003', '004', '005']);
// the fixture characters have no aliases: give them the nicknames a novel uses
const nick: Record<string, string> = { '001': '灯', '002': '爱音', '003': '乐奈', '004': '爽世', '005': '立希' };
const cat = { ...base, characters: base.characters.map((c) => ({ ...c, nickname: nick[c.key] ?? null, aliases: nick[c.key] ? [nick[c.key]!] : [] })) };
const NOVEL = fs.readFileSync(path.resolve('examples/mygo-rehearsal.txt'), 'utf8');
const deps = (cache = null) => ({ provider: new RuleProvider(cat), cache, catalog: cat, now: () => 7000 });

describe('rule director (the no-key fallback)', () => {
  it('recognises quoted speech and the narration around it', () => {
    const s = segments('“灯，快点。”爱音站在门口，一脸着急。');
    expect(s.map((x) => [x.kind, x.text])).toEqual([['dialogue', '灯，快点。'], ['narration', '爱音站在门口，一脸着急。']]);
    expect(s[0]!.after.startsWith('爱音')).toBe(true);
  });

  it('breaks the example novel into chapters, picks real ids, and labels everything `rule`, never `ai`', async () => {
    const r = await runBreakdown(deps(), STORY, '示例', 'g1');
    expect(r.project.scenes.length).toBeGreaterThanOrEqual(2);
    expect(r.runs[0]).toMatchObject({ provider: 'rule', model: 'rule-director', cached: false });
    const sources = new Set<string>();
    for (const s of r.project.scenes) {
      sources.add(s.meta.source);
      sources.add(s.background.meta.source);
      for (const w of Object.values(s.wardrobe)) {
        sources.add(w.meta.source);
        expect(cat.models.some((m) => m.id === w.modelId)).toBe(true);
      }
      expect(cat.backgrounds.some((b) => b.id === s.background.assetId)).toBe(true);
    }
    expect([...sources]).toEqual(['rule']);
  });

  it('directs every scene: dialogue gets the named speaker, shots follow a rhythm, source is rule, locks are untouched', async () => {
    const d = deps();
    const { project } = await runBreakdown(d, STORY, '示例', 'g1');
    const items = await runScenes(d, project, project.scenes.map((s) => s.id), ['scene'], 'g2', 3);
    expect(items.every((i) => i.result?.applied)).toBe(true);
    const first = items[0]!.result!.scene;
    const dialogue = first.beats.filter((b) => b.kind === 'dialogue');
    expect(dialogue.length).toBeGreaterThanOrEqual(2);
    expect(dialogue.every((b) => !!b.speakerId)).toBe(true);
    expect(new Set(first.beats.map((b) => b.shot.type)).size).toBeGreaterThan(1);
    for (const b of first.beats) expect(b.meta.source).toBe('rule');
    for (const t of first.tracks) for (const k of t.keys) expect(k.meta.source).toBe('rule');
    // playable: compiles without invalid resources
    const compiled = { ...project, scenes: items.map((i) => i.result!.scene) };
    const out = compileProject(compiled, compileContext(cat));
    expect(out.warnings.filter((w) => /unknown|missing|not found/i.test(w))).toEqual([]);
  });

  it('a locked beat survives a rule regeneration unchanged (and is handed back via keepId)', async () => {
    const d = deps();
    const { project } = await runBreakdown(d, STORY, '示例', 'g1');
    const sc = project.scenes[0]!;
    const r1 = await runScene(d, { project, sceneId: sc.id, scopes: ['scene'] }, 'g2');
    const directed = { ...project, scenes: project.scenes.map((s) => (s.id === sc.id ? r1.scene : s)) };
    const target = r1.scene.beats.find((b) => b.kind === 'dialogue')!;
    target.shot = { ...target.shot, type: 'ecu', meta: { ...target.shot.meta, locked: true, source: 'user' } };
    const r2 = await runScene(d, { project: directed, sceneId: sc.id, scopes: ['camera'] }, 'g3');
    const kept = r2.scene.beats.find((b) => b.id === target.id)!;
    expect(kept.shot.type).toBe('ecu');
    expect(findLockViolations(directed, { ...directed, scenes: directed.scenes.map((s) => (s.id === sc.id ? r2.scene : s)) })).toEqual([]);
  });
});

describe('chapters and chunking', () => {
  it('detects 第X章 / markdown headings', () => {
    const ch = detectChapters(splitParagraphs(NOVEL));
    expect(ch.length).toBeGreaterThanOrEqual(5);
    expect(ch.map((c) => c.title)).toContain('第一章　铃声之后');
    const book = ['# 书名', '## 第一章 A', '正文', '## 第二章 B', '正文'].join('\n\n');
    expect(detectChapters(splitParagraphs(book)).map((c) => c.title)).toEqual(['第一章 A', '第二章 B']);
  });
  it('cuts a long text before a chapter heading instead of in the middle of a chapter', () => {
    const body = (n: number) => Array.from({ length: n }, () => '这是一段普通的正文。'.repeat(8)).join('\n\n');
    const paras = splitParagraphs(`# 第一章 开始\n\n${body(30)}\n\n# 第二章 继续\n\n${body(30)}`);
    const chunks = chunkParagraphs(paras, 3000);
    const second = chunks.find((c) => c.some((p) => p.text.includes('第二章')))!;
    expect(second[0]!.text).toContain('第二章');
  });
});

describe('diff view and continuity', () => {
  it('diff lists what a camera-only regeneration changes and nothing else', async () => {
    const d = deps();
    const { project } = await runBreakdown(d, STORY, '示例', 'g1');
    const sc = project.scenes[0]!;
    const r1 = await runScene(d, { project, sceneId: sc.id, scopes: ['scene'] }, 'g2');
    const proj1 = { ...project, scenes: project.scenes.map((s) => (s.id === sc.id ? r1.scene : s)) };
    // hand-made change to the camera, then a rule regeneration of the camera scope
    const edited = JSON.parse(JSON.stringify(r1.scene)) as typeof r1.scene;
    edited.beats[1]!.shot.type = 'ecu';
    const r2 = await runScene(d, { project: { ...proj1, scenes: proj1.scenes.map((s) => (s.id === sc.id ? edited : s)) }, sceneId: sc.id, scopes: ['camera'], overwriteUser: true }, 'g3');
    const diff = diffScene(edited, r2.scene);
    expect(diff.structural).toBe(false);
    expect(Object.keys(diff.counts)).toEqual(['camera']);
    // accepting only some scopes = re-merging with fewer scopes: nothing outside them changes
    const part = mergeLocks(edited, r2.scene, { scopes: ['performance'] });
    expect(part.scene.beats.map((b) => b.shot.type)).toEqual(edited.beats.map((b) => b.shot.type));
  });

  it('continuity: absent speaker, undirected scenes and unexplained costume changes are reported with a location', async () => {
    const d = deps();
    const { project } = await runBreakdown(d, STORY, '示例', 'g1');
    expect(checkContinuity(project).some((w) => w.kind === 'undirected')).toBe(true);
    const p = JSON.parse(JSON.stringify(project)) as typeof project;
    const s1 = p.scenes[1]!;
    const some = Object.keys(p.scenes[0]!.wardrobe)[0]!;
    s1.wardrobe[some] = { modelId: 'x_other', meta: { source: 'user', locked: false, updatedAt: 1 } };
    s1.beats[0]!.kind = 'dialogue';
    s1.beats[0]!.speakerId = 'c_nobody';
    const w = checkContinuity(p);
    expect(w.find((x) => x.kind === 'costume_change')?.sceneId).toBe(s1.id);
    expect(w.find((x) => x.kind === 'speaker_absent')?.beatId).toBe(s1.beats[0]!.id);
  });
});

describe('wide frame (2.16:1)', () => {
  it('spreads two-shots and groups over the extra width and keeps 16:9 unchanged', () => {
    const fr = OURNOTES_STYLE.framing;
    const wideAsp = 1920 / 890;
    expect(faceLayout('two_shot', 2, fr)).toEqual([-fr.twoShotFaceX, fr.twoShotFaceX]);
    expect(faceLayout('two_shot', 2, fr, wideAsp)[1]).toBeCloseTo(fr.twoShotFaceX * (wideAsp / (16 / 9)), 5);
    // groups (v0.1.4): the pitch is in head heights and never stretches with the window; the wider frame lets the heads grow to their target
    const narrow = measureGroup(line(5), 16 / 9).faces;
    const wide = measureGroup(line(5), wideAsp).faces;
    expect(wide[0]!.headH).toBeGreaterThan(narrow[0]!.headH);
    expect((wide[1]!.x - wide[0]!.x) / wide[0]!.headH).toBeCloseTo((narrow[1]!.x - narrow[0]!.x) / narrow[0]!.headH, 2);
  });
});
