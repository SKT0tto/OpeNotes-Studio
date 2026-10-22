import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LlmCache } from '../../server/llm/cache';
import { runBreakdown } from '../../server/llm/director';
import { FixtureProvider } from '../../server/llm/fixtureProvider';
import { DirectorError } from '../../server/llm/pipeline';
import { LlmError, TruncatedError, zeroUsage, type LlmProvider } from '../../server/llm/provider';
import { runScene, runScenes } from '../../server/llm/sceneRunner';
import { findLockViolations } from '../../shared/project/locks';
import type { Meta, Project } from '../../shared/schema/project';
import { FIXTURE_DIR, STORY, readFixture } from './helpers/directorCatalog';
import { cat, clone, skeleton } from './helpers/directorFlow';

const META = (over: Partial<Meta> = {}): Meta => ({ source: 'user', locked: false, updatedAt: 5, ...over });
let tmp: string;
beforeAll(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'director-'));
});
afterAll(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

const deps = (provider: LlmProvider, cache: LlmCache | null = null) => ({ provider, cache, catalog: cat, now: () => 5000 });
const sceneCalls = (p: FixtureProvider) => p.calls.filter((c) => c.schemaName === 'SceneDirection');

describe('Pass 1 on recorded output', () => {
  it('one call for the whole short text; the project skeleton has the scenes, cast and warnings', async () => {
    const p = new FixtureProvider(FIXTURE_DIR);
    const r = await runBreakdown(deps(p), STORY, '示例', 'g1');
    expect(p.calls.length).toBe(1);
    expect(r.project.scenes.length).toBe(4);
    expect(r.project.source.text).toBe(STORY);
    expect(r.runs[0]).toMatchObject({ pass: 'breakdown', provider: 'fixture', cached: false });
  });

  it('a bad model output is repaired deterministically (warnings) and still gives only real ids', async () => {
    const dir = path.join(tmp, 'bad-breakdown');
    await fs.cp(FIXTURE_DIR, dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'index.json'), JSON.stringify([{ schemaName: 'Breakdown', file: 'breakdown-bad.json' }]));
    const r = await runBreakdown(deps(new FixtureProvider(dir)), STORY, 't', 'g');
    expect(r.warnings.length).toBeGreaterThanOrEqual(5);
    for (const s of r.project.scenes) {
      expect(cat.backgrounds.some((b) => b.id === s.background.assetId)).toBe(true);
      for (const w of Object.values(s.wardrobe)) expect(cat.models.some((m) => m.id === w.modelId)).toBe(true);
    }
  });
});

describe('Pass 2 is one call per scene, not per line', () => {
  let project: Project;
  beforeAll(async () => {
    project = (await runBreakdown(deps(new FixtureProvider(FIXTURE_DIR)), STORY, 't', 'g')).project;
  });

  it('four scenes (about 50 beats) take 5 calls: one per scene, the longest one split to fit the output limit', async () => {
    const p = new FixtureProvider(FIXTURE_DIR);
    const progress: string[] = [];
    const items = await runScenes(deps(p), project, project.scenes.map((s) => s.id), ['scene'], 'g2', 3, (x) => progress.push(`${x.state}:${x.sceneId}`));
    expect(items.every((i) => i.result?.applied)).toBe(true);
    expect(sceneCalls(p).length).toBe(5);
    const beats = items.reduce((n, i) => n + i.result!.scene.beats.length, 0);
    expect(beats).toBeGreaterThan(45);
    expect(sceneCalls(p).length).toBeLessThan(beats / 5);
    expect(progress.filter((x) => x.startsWith('start')).length).toBe(4);
    expect(progress.filter((x) => x.startsWith('done')).length).toBe(4);
    // the merged scenes keep the source text of every paragraph they cover
    for (const it of items) expect(it.result!.scene.beats.every((b) => b.text === '' || STORY.includes(b.text.slice(0, 4)) || b.kind !== 'dialogue')).toBe(true);
  });

  it('a second run hits the cache: no model request at all', async () => {
    const cache = new LlmCache(path.join(tmp, 'cache1'));
    const p1 = new FixtureProvider(FIXTURE_DIR);
    await runBreakdown(deps(p1, cache), STORY, 't', 'g');
    await runScenes(deps(p1, cache), project, project.scenes.map((s) => s.id), ['scene'], 'g2', 3);
    const n = p1.calls.length;
    expect(n).toBe(6);
    const p2 = new FixtureProvider(FIXTURE_DIR);
    const again = await runScenes(deps(p2, cache), project, project.scenes.map((s) => s.id), ['scene'], 'g2', 3);
    const bd = await runBreakdown(deps(p2, cache), STORY, 't', 'g');
    expect(p2.calls.length).toBe(0);
    expect(again.every((i) => i.result!.runs.every((r) => r.cached))).toBe(true);
    expect(bd.runs.every((r) => r.cached)).toBe(true);
  });

  it('a scene that fails does not stop the others and is reported', async () => {
    const real = new FixtureProvider(FIXTURE_DIR);
    const flaky: LlmProvider = { ...real, id: 'openai', model: 'x', maxOutputTokens: real.maxOutputTokens, test: real.test, generateStructured: async (req) => {
      if (JSON.stringify(req.input).includes('"paragraphRange":[19,22]')) throw new LlmError('rate_limit', '429');
      return real.generateStructured(req);
    } };
    const items = await runScenes(deps(flaky), project, project.scenes.map((s) => s.id), ['scene'], 'g', 2);
    expect(items.map((i) => !!i.result)).toEqual([true, true, true, false]);
    expect(items[3]!.error).toMatchObject({ kind: 'rate_limit' });
  });

  it('the model output is validated: invalid ids in the recorded answer never reach the scene', async () => {
    const dir = path.join(tmp, 'bad-scene');
    await fs.cp(FIXTURE_DIR, dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'index.json'), JSON.stringify([{ schemaName: 'SceneDirection', file: 'scene-bad.json' }]));
    // scene-bad.json is the first scene's answer with deliberate errors
    const items = await runScenes(deps(new FixtureProvider(dir)), project, [project.scenes[0]!.id], ['scene'], 'g', 1);
    const r = items[0]!.result;
    if (!r) throw new Error(JSON.stringify(items[0]!.error));
    expect(r.warnings.join('\n')).toContain('不存在');
    for (const t of r.scene.tracks) {
      if (t.channel !== 'motion' || t.target.kind !== 'actor') continue;
      const m = cat.models.find((x) => x.id === r.scene.wardrobe[t.target.castId]!.modelId)!;
      for (const k of t.keys) expect(m.motions.some((x) => x.family === (k.value as { name: string }).name)).toBe(true);
    }
  });
});

describe('repair: at most one extra LLM call', () => {
  const project = skeleton();
  const sid = project.scenes[0]!.id;
  const good = readFixture<unknown>('scene-0-2-scene.json');
  const fabricated = (() => {
    const d = clone(good) as { beats: Array<{ kind: string; text: string }> };
    d.beats.forEach((b) => {
      if (b.kind === 'dialogue') b.text = '这是一句原文里根本没有的、完全编造出来的台词内容。';
    });
    return d;
  })();

  const scripted = (answers: Array<unknown | Error>) => {
    const calls: Array<{ input: unknown; schemaName: string }> = [];
    const provider: LlmProvider = {
      id: 'openai', model: 'scripted', maxOutputTokens: 8192,
      test: async () => ({ model: 's', latencyMs: 1 }),
      generateStructured: async (req) => {
        calls.push({ input: req.input, schemaName: req.schemaName });
        const a = answers[Math.min(calls.length - 1, answers.length - 1)];
        if (a instanceof Error) throw a;
        const raw = JSON.stringify(a);
        const parsed = req.schema.safeParse(a);
        if (!parsed.success) throw new LlmError('invalid_output', 'schema', { raw, issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) });
        return { data: parsed.data as never, usage: zeroUsage(), raw, warnings: [] };
      },
    };
    return { provider, calls };
  };

  it('a schema violation gets one repair call that carries the previous output and the issue list', async () => {
    const { provider, calls } = scripted([{ nope: true }, good]);
    const r = await runScene(deps(provider), { project, sceneId: sid, scopes: ['scene'] }, 'g');
    expect(calls.length).toBe(2);
    expect(JSON.stringify(calls[1]!.input)).toContain('problems');
    expect(JSON.stringify(calls[1]!.input)).toContain('previousOutput');
    expect(r.runs[0]!.repaired).toBe(true);
    expect(r.applied).toBe(true);
  });

  it('after a repair the good answer is cached under the original request: the next run makes no call at all', async () => {
    const cache = new LlmCache(path.join(tmp, 'cache-repair'));
    const first = scripted([{ nope: true }, good]);
    await runScene(deps(first.provider, cache), { project, sceneId: sid, scopes: ['scene'] }, 'g');
    expect(first.calls.length).toBe(2);
    const second = scripted([{ nope: true }, good]);
    const r = await runScene(deps(second.provider, cache), { project, sceneId: sid, scopes: ['scene'] }, 'g');
    expect(second.calls.length).toBe(0);
    expect(r.runs[0]!.cached).toBe(true);
  });

  it('a structural error (fabricated dialogue) gets one repair call; if it fails again the scene is NOT written', async () => {
    const ok = scripted([fabricated, good]);
    const r = await runScene(deps(ok.provider), { project, sceneId: sid, scopes: ['scene'] }, 'g');
    expect(ok.calls.length).toBe(2);
    expect(r.runs[0]!.repaired).toBe(true);
    const bad = scripted([fabricated, fabricated, good]);
    await expect(runScene(deps(bad.provider), { project, sceneId: sid, scopes: ['scene'] }, 'g')).rejects.toBeInstanceOf(DirectorError);
    expect(bad.calls.length).toBe(2); // never a third call
    expect(project.scenes[0]!.beats.length).toBe(3); // the project is untouched (placeholders)
  });

  it('a truncated answer retries once with the span split in two', async () => {
    const p2 = skeleton();
    const long = p2.scenes[2]!; // 13 paragraphs, directed as 2 spans on a capped provider: use an uncapped one to force the truncation path
    const first = readFixture<{ beats: unknown[] }>('scene-6-12-scene.json');
    const second = readFixture<unknown>('scene-13-18-scene.json');
    const calls: string[] = [];
    const provider: LlmProvider = {
      id: 'openai', model: 'trunc', maxOutputTokens: 16000,
      test: async () => ({ model: 's', latencyMs: 1 }),
      generateStructured: async (req) => {
        const inp = JSON.stringify(req.input);
        const range = /"paragraphRange":\[(\d+),(\d+)\]/.exec(inp)!;
        calls.push(`${range[1]}-${range[2]}`);
        if (range[0]!.includes('[6,18]')) throw new TruncatedError();
        const data = range[1] === '6' ? first : second;
        return { data: req.schema.parse(data) as never, usage: zeroUsage(), raw: '', warnings: [] };
      },
    };
    const r = await runScene(deps(provider), { project: p2, sceneId: long.id, scopes: ['scene'] }, 'g');
    expect(calls).toEqual(['6-18', '6-12', '13-18']);
    expect(r.scene.beats.length).toBe(first.beats.length + readFixture<{ beats: unknown[] }>('scene-13-18-scene.json').beats.length);
  });
});

describe('locks through the whole server pipeline', () => {
  it('regenerating a scene keeps locked / person-edited content; the camera-only rerun leaves performance, outfits and stage alone', async () => {
    const p = new FixtureProvider(FIXTURE_DIR);
    const project = (await runBreakdown(deps(p), STORY, 't', 'g')).project;
    // first generation of scene 2 (index 1)
    const sid = project.scenes[1]!.id;
    const first = (await runScene(deps(p), { project, sceneId: sid, scopes: ['scene'] }, 'g2')).scene;
    project.scenes[1] = first;
    // a person locks the camera of the first dialogue line, the first actor's outfit, and edits another line
    const dlg = first.beats.filter((b) => b.kind === 'dialogue');
    dlg[0]!.shot.meta = META({ locked: true });
    const cast0 = Object.keys(first.wardrobe)[0]!;
    first.wardrobe[cast0]!.meta = META({ locked: true });
    dlg[1]!.text = '我自己改的台词。';
    dlg[1]!.meta = META({ source: 'user' });
    const before = clone(project);
    const regen = await runScene(deps(p), { project, sceneId: sid, scopes: ['scene'], overwriteUser: false }, 'g3');
    expect(regen.applied).toBe(true);
    expect(findLockViolations(before.scenes[1], regen.scene)).toEqual([]);
    expect(regen.scene.beats.find((b) => b.id === dlg[0]!.id)!.shot).toEqual(dlg[0]!.shot);
    expect(regen.scene.wardrobe[cast0]).toEqual(first.wardrobe[cast0]);
    expect(regen.scene.beats.find((b) => b.id === dlg[1]!.id)!.text).toBe('我自己改的台词。');

    // camera only
    const cam = await runScene(deps(p), { project, sceneId: sid, scopes: ['camera'] }, 'g4');
    expect(cam.applied).toBe(true);
    expect(JSON.stringify(cam.scene.tracks)).toBe(JSON.stringify(first.tracks));
    expect(JSON.stringify(cam.scene.wardrobe)).toBe(JSON.stringify(first.wardrobe));
    expect(JSON.stringify(cam.scene.blocking)).toBe(JSON.stringify(first.blocking));
    cam.scene.beats.forEach((b, i) => {
      expect(b.text).toBe(first.beats[i]!.text);
      expect(b.emotion).toBe(first.beats[i]!.emotion);
    });
    expect(cam.scene.beats.find((b) => b.id === dlg[0]!.id)!.shot).toEqual(dlg[0]!.shot); // still locked
    const calls = sceneCalls(p);
    expect(calls.at(-1)!.input).toContain('"scopes":["camera"]');
    expect(calls.at(-1)!.input).toContain('"fixedBeats"');
  });
});
