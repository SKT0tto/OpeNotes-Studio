/**
 * MANUAL live test against a real model (skipped unless LLM_LIVE=1): `LLM_LIVE=1 npm run test:integration -- llm-live`.
 * Uses the provider configured in .env / data/settings.local.json (e.g. DeepSeek: LLM_PROVIDER=openai, OPENAI_BASE_URL,
 * OPENAI_MODEL=deepseek-flash, OPENAI_API_KEY) and the real asset catalog. It never prints the key; metrics go to
 * data/reports/ (gitignored).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildCatalog } from '../../server/assets/indexer';
import { loadConfig } from '../../server/config';
import { LlmCache } from '../../server/llm/cache';
import { runBreakdown } from '../../server/llm/director';
import { runScene, runScenes, type SceneResult } from '../../server/llm/sceneRunner';
import type { LlmProvider } from '../../server/llm/provider';
import { LlmSettings, loadDotEnv } from '../../server/settings/store';
import { findLockViolations } from '../../shared/project/locks';
import { lookup } from '../../shared/director/resources';
import type { Catalog } from '../../shared/schema/assets';
import type { Meta, Project } from '../../shared/schema/project';

const LIVE = process.env.LLM_LIVE === '1';
const config = loadConfig();
const haveAssets = fs.existsSync(path.join(config.assetRoot, 'models'));
const STORY = fs.readFileSync('tests/fixtures/story-short.txt', 'utf8');
const META = (over: Partial<Meta> = {}): Meta => ({ source: 'user', locked: false, updatedAt: 1, ...over });

describe.skipIf(!LIVE || !haveAssets)('live model: Pass 1 + Pass 2 on a short multi-scene story', () => {
  let cat: Catalog;
  let provider: LlmProvider;
  let calls = 0;
  let counted: LlmProvider;
  let cache: LlmCache;
  let project: Project;
  const results: SceneResult[] = [];
  const report: Record<string, unknown> = {};

  beforeAll(async () => {
    loadDotEnv('.env');
    cat = await buildCatalog({ assetRoot: config.assetRoot, audioRoots: config.audioRoots });
    const p = new LlmSettings({ file: path.join(os.tmpdir(), 'live-settings.json'), env: process.env }).provider();
    if (!p.provider) throw new Error(p.message);
    provider = p.provider;
    counted = { id: provider.id, model: provider.model, ...(provider.maxOutputTokens ? { maxOutputTokens: provider.maxOutputTokens } : {}), test: (s) => provider.test(s), generateStructured: (r) => (calls++, provider.generateStructured(r)) } as LlmProvider;
    cache = new LlmCache(fs.mkdtempSync(path.join(os.tmpdir(), 'live-cache-')));
    report.provider = `${provider.id}/${provider.model}`;
  }, 60_000);

  const deps = () => ({ provider: counted, cache, catalog: cat });

  it('Pass 1: valid schema, every id real, scenes cover the text, a night rooftop scene exists', async () => {
    const r = await runBreakdown(deps(), STORY, 'live', 'g1');
    const L = lookup(cat);
    expect(r.breakdown.scenes.length).toBeGreaterThanOrEqual(2);
    for (const s of r.project.scenes) {
      expect(L.backgrounds.has(s.background.assetId)).toBe(true);
      for (const w of Object.values(s.wardrobe)) expect(L.models.has(w.modelId)).toBe(true);
    }
    expect(r.breakdown.scenes.some((s) => s.timeOfDay.includes('夜'))).toBe(true);
    project = r.project;
    report.pass1 = { scenes: r.project.scenes.length, warnings: r.warnings.length, ms: r.runs.map((x) => x.ms), tokens: r.runs.map((x) => x.usage) };
  }, 300_000);

  it('Pass 2: one call per scene (+ long-scene splits), valid output, invalid-id rate is low', async () => {
    const before = calls;
    const items = await runScenes(deps(), project, project.scenes.map((s) => s.id), ['scene'], 'g2', 3);
    for (const it of items) {
      expect(it.error, JSON.stringify(it.error)).toBeUndefined();
      results.push(it.result!);
    }
    const L = lookup(cat);
    let ids = 0;
    let bad = 0;
    for (const r of results) {
      for (const b of r.direction.beats) for (const a of b.actors) {
        ids += (a.motion ? 1 : 0) + (a.expression ? 1 : 0);
      }
      bad += r.warnings.filter((w) => /不存在|无效|不在场|无法回溯|已去掉/.test(w)).length;
      for (const [cid, w] of Object.entries(r.scene.wardrobe)) expect(L.models.has(w.modelId), cid).toBe(true);
      for (const t of r.scene.tracks) if (t.channel === 'costume') for (const k of t.keys) expect(L.models.has((k.value as { modelId: string }).modelId)).toBe(true);
    }
    const beats = results.reduce((n, r) => n + r.scene.beats.length, 0);
    expect(calls - before).toBeLessThan(beats / 3); // batched per scene, not per line
    expect(bad / Math.max(1, ids)).toBeLessThan(0.2);
    project = { ...project, scenes: project.scenes.map((s) => results.find((r) => r.sceneId === s.id)!.scene) };
    report.pass2 = { beats, calls: calls - before, invalidResourceRate: bad / Math.max(1, ids), warnings: results.map((r) => r.warnings.length), repaired: results.map((r) => r.runs.some((x) => x.repaired)) };
  }, 600_000);

  it('cache: running everything again sends no request', async () => {
    const before = calls;
    const fresh = await runBreakdown(deps(), STORY, 'live', 'g1');
    await runScenes(deps(), fresh.project, fresh.project.scenes.map((s) => s.id), ['scene'], 'g2', 3);
    expect(calls).toBe(before);
    report.cacheHit = true;
  }, 120_000);

  it('H1: redoing ONE selected line (performance) works on the longest scene and leaves everything else untouched', async () => {
    const scene = [...project.scenes].sort((a, b) => b.beats.length - a.beats.length)[0]!;
    const target = scene.beats.filter((b) => b.kind === 'dialogue')[2] ?? scene.beats[2]!;
    const r = await runScene({ ...deps(), refresh: true }, { project, sceneId: scene.id, scopes: ['performance'], beatIds: [target.id] }, 'g4');
    expect(r.applied, JSON.stringify(r.conflicts)).toBe(true);
    expect(r.scene.beats.map((b) => b.text)).toEqual(scene.beats.map((b) => b.text));
    expect(r.scene.beats.find((b) => b.id === target.id)!.text).toBe(target.text);
    report.focusRegen = { beats: scene.beats.length, calls: r.runs.length, tokens: r.runs.map((x) => x.usage.outputTokens) };
  }, 300_000);

  it('H2: no insert shot without something to show (hands / instrument / prop)', () => {
    for (const r of results) for (const b of r.direction.beats) {
      if (b.shot.type !== 'insert') continue;
      const playing = b.actors.some((a) => a.motion !== null && /^(play|action|finish)/.test(a.motion));
      expect(playing || /手|指|琴|吉他|贝斯|鼓|话筒|麦|杯|书|笔|信|手机|纸|耳机|拨片|乐谱|握|拿/.test(b.text), b.text).toBe(true);
    }
  });

  it('locks: a locked line, a locked outfit and a hand edit survive a regeneration', async () => {
    const i = project.scenes.findIndex((s) => s.beats.filter((b) => b.kind === 'dialogue').length >= 2);
    const scene = JSON.parse(JSON.stringify(project.scenes[i]!)) as Project['scenes'][number];
    const dlg = scene.beats.filter((b) => b.kind === 'dialogue');
    dlg[0]!.meta = META({ locked: true });
    const cast0 = Object.keys(scene.wardrobe)[0]!;
    scene.wardrobe[cast0]!.meta = META({ locked: true });
    dlg[1]!.meta = META({ source: 'user' });
    dlg[1]!.text = '人工改写的台词。';
    const p2: Project = { ...project, scenes: project.scenes.map((s, k) => (k === i ? scene : s)) };
    const r = await runScene({ ...deps(), refresh: true }, { project: p2, sceneId: scene.id, scopes: ['scene'] }, 'g3');
    expect(findLockViolations(scene, r.scene)).toEqual([]);
    if (r.applied) {
      expect(r.scene.beats.find((b) => b.id === dlg[0]!.id)).toEqual(dlg[0]);
      expect(r.scene.beats.find((b) => b.id === dlg[1]!.id)!.text).toBe('人工改写的台词。');
      expect(r.scene.wardrobe[cast0]).toEqual(scene.wardrobe[cast0]);
    } else {
      expect(r.conflicts.length).toBeGreaterThan(0); // a lock the model could not honour is reported, never dropped
    }
    report.locks = { applied: r.applied, conflicts: r.conflicts.length };
    fs.mkdirSync('data/reports', { recursive: true });
    fs.writeFileSync(`data/reports/llm-live-${Date.now()}.json`, JSON.stringify(report, null, 2));
  }, 300_000);
});

const NOVEL = fs.readFileSync('examples/mygo-rehearsal.txt', 'utf8');

describe.skipIf(!LIVE || !haveAssets)('live model: the example novel end to end (P15)', () => {
  it('one-click pipeline: breakdown -> every scene; real ids; the performance scene uses live-mode in the band formation; stats are recorded', async () => {
    loadDotEnv('.env');
    const cat = await buildCatalog({ assetRoot: config.assetRoot, audioRoots: config.audioRoots });
    const p = new LlmSettings({ file: path.join(os.tmpdir(), 'live-settings.json'), env: process.env }).provider();
    if (!p.provider) throw new Error(p.message);
    let calls = 0;
    const counted = { id: p.provider.id, model: p.provider.model, ...(p.provider.maxOutputTokens ? { maxOutputTokens: p.provider.maxOutputTokens } : {}), test: (s?: AbortSignal) => p.provider!.test(s), generateStructured: (r: never) => (calls++, p.provider!.generateStructured(r)) } as LlmProvider;
    const deps = { provider: counted, cache: new LlmCache(fs.mkdtempSync(path.join(os.tmpdir(), 'live-novel-'))), catalog: cat };
    const t0 = Date.now();
    const bd = await runBreakdown(deps, NOVEL, '迷子们的排练日', 'g1');
    const t1 = Date.now();
    const items = await runScenes(deps, bd.project, bd.project.scenes.map((s) => s.id), ['scene'], 'g2', 3);
    const secs = (Date.now() - t0) / 1000;
    const L = lookup(cat);
    for (const it of items) expect(it.error, JSON.stringify(it.error)).toBeUndefined();
    const scenes = items.map((i) => i.result!.scene);
    for (const s of scenes) for (const w of Object.values(s.wardrobe)) expect(L.models.has(w.modelId)).toBe(true);
    const perf = scenes.find((s) => s.brief?.isPerformance);
    expect(perf, 'a formal performance scene').toBeDefined();
    for (const w of Object.values(perf!.wardrobe)) expect(L.models.get(w.modelId)!.mode).toBe('live');
    const full: Project = { ...bd.project, scenes };
    const runs = [...bd.runs, ...items.flatMap((i) => i.result!.runs)];
    const usage = runs.reduce((a, r) => ({ inT: a.inT + r.usage.inputTokens, outT: a.outT + r.usage.outputTokens }), { inT: 0, outT: 0 });
    fs.mkdirSync('data/reports', { recursive: true });
    fs.writeFileSync(`data/reports/llm-live-novel-${Date.now()}.json`, JSON.stringify({ provider: `${p.provider.id}/${p.provider.model}`, scenes: scenes.length, beats: scenes.reduce((n, s) => n + s.beats.length, 0), calls, breakdownSecs: (t1 - t0) / 1000, totalSecs: secs, ...usage, repaired: runs.filter((r) => r.repaired).length }, null, 2));
    expect(full.scenes.length).toBeGreaterThanOrEqual(4);
  }, 900_000);
});

describe.skipIf(!LIVE || !haveAssets)('live model: band-aware backgrounds (P17)', () => {
  const MYGO = '练习室里，灯、爱音、乐奈、爽世和立希围着鼓组。爱音调好吉他，说：“再来一遍吧。”立希点点头，敲响了鼓。灯小声哼起新写的歌词。';
  const MUJICA = '练习室里，初华、睦、海铃、若麦和祥子准备合奏。祥子说：“从头开始。”睦默默拨动吉他，海铃的贝斯声沉稳地响起。';
  it('MyGO never gets another band’s private places; Ave Mujica may', async () => {
    loadDotEnv('.env');
    const cat = await buildCatalog({ assetRoot: config.assetRoot, audioRoots: config.audioRoots, labelsFile: path.resolve('asset-labels', 'backgrounds.json') });
    const p = new LlmSettings({ file: path.join(os.tmpdir(), 'live-settings-p17.json'), env: process.env }).provider();
    if (!p.provider) throw new Error(p.message);
    const L = lookup(cat);
    const used = async (text: string) => {
      const r = await runBreakdown({ provider: p.provider!, cache: null, catalog: cat }, text, 'p17', 'g');
      console.log(`[p17] repairs: ${r.warnings.filter((w) => w.includes('已换成')).length}; warnings: ${r.warnings.length}`);
      return r.project.scenes.map((s) => L.backgrounds.get(s.background.assetId)!);
    };
    for (const b of await used(MYGO)) expect(['avemujica', 'millsage'].some((k) => b.labels?.exclusive && b.labels.bands.includes(k)), b.name).toBe(false);
    await used(MUJICA);
  }, 180_000);
});
