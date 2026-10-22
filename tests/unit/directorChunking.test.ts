import { describe, expect, it } from 'vitest';
import { LlmError, zeroUsage, type LlmProvider } from '../../server/llm/provider';
import { TOKENS_PER_PARA, runScene } from '../../server/llm/sceneRunner';
import { stageSummary, stageTimeline } from '../../shared/director/stage';
import { EMOTIONS } from '../../shared/director/vocab';
import type { SceneDirection } from '../../shared/schema/ai';
import type { Project } from '../../shared/schema/project';
import { cat, paragraphs, skeleton } from './helpers/directorFlow';

/** A scene that covers the whole 23-paragraph story, so spans can be planned freely. */
function longScene(): { project: Project; sceneId: string; castIds: string[] } {
  const project = skeleton();
  const scene = project.scenes[2]!;
  scene.sourceSpan = { start: paragraphs[0]!.start, end: paragraphs.at(-1)!.end };
  return { project, sceneId: scene.id, castIds: Object.keys(scene.wardrobe) };
}

interface Seen { range: [number, number]; input: Record<string, unknown>; maxTokens: number }

/** A provider that answers every paragraph of the request with one silent beat (the second cast member enters in the first beat of the first span). */
function silentProvider(castIds: string[], opts: { outputTokensPerPara?: number; cap?: number; id?: LlmProvider['id'] } = {}) {
  const seen: Seen[] = [];
  const provider: LlmProvider = {
    id: opts.id ?? 'openai', model: 'mock', maxOutputTokens: opts.cap ?? 8192,
    test: async () => ({ model: 'mock', latencyMs: 1 }),
    generateStructured: async (req) => {
      const input = req.input as { scene: { paragraphRange: [number, number] }; paragraphs: Array<{ i: number }> };
      seen.push({ range: input.scene.paragraphRange, input: input as unknown as Record<string, unknown>, maxTokens: req.maxTokens });
      const first = seen.length === 1;
      const d: SceneDirection = {
        reason: 'r', blocking: [], transitionIn: 'cut', bgm: null, costumeChanges: [],
        beats: input.paragraphs.map((p, n) => ({
          keepId: null, paragraph: p.i, kind: 'silent' as const, speaker: null, text: '', emotion: EMOTIONS[0]!, reason: 'x',
          shot: { type: 'mcu' as const, focus: [castIds[0]!], move: 'static' as const, dof: null },
          cutIn: 'cut' as const, fx: 'none' as const,
          actors: first && n === 0 ? [{ castId: castIds[1]!, motion: null, expression: null, attention: null, enter: true, exit: false, move: null }] : [],
        })),
      };
      const usage = { ...zeroUsage(), outputTokens: Math.round((opts.outputTokensPerPara ?? 0) * input.paragraphs.length) };
      return { data: req.schema.parse(d) as never, usage, raw: '', warnings: [] };
    },
  };
  return { provider, seen };
}

const run = (provider: LlmProvider, project: Project, sceneId: string) =>
  runScene({ provider, cache: null, catalog: cat, now: () => 5000 }, { project, sceneId, scopes: ['scene'] }, 'g');

describe('long scenes are cut by the measured cost per paragraph', () => {
  it('starts from the default estimate (450 tokens per paragraph): 14 paragraphs fit an 8192-token call', async () => {
    expect(TOKENS_PER_PARA).toBe(450);
    const { project, sceneId, castIds } = longScene();
    expect(castIds.length).toBeGreaterThanOrEqual(3);
    const { provider, seen } = silentProvider(castIds);
    await run(provider, project, sceneId);
    // 23 paragraphs: two balanced spans of 12 and 11, not the three of 9 the old 700-per-paragraph guess gave
    expect(seen.map((s) => s.range)).toEqual([[0, 11], [12, 22]]);
  });

  it('a call that cost more than guessed makes the following spans smaller', async () => {
    const { project, sceneId, castIds } = longScene();
    const { provider, seen } = silentProvider(castIds, { outputTokensPerPara: 800 });
    await run(provider, project, sceneId);
    expect(seen.map((s) => s.range)).toEqual([[0, 11], [12, 17], [18, 22]]);
  });

  it('a cached re-run plans the same spans as the measured first run (every span hits the cache, no new request)', async () => {
    const { project, sceneId, castIds } = longScene();
    const { provider, seen } = silentProvider(castIds, { outputTokensPerPara: 800 });
    const store = new Map<string, unknown>();
    const cache = { get: async (k: string) => store.get(k) ?? null, set: async (k: string, e: unknown) => void store.set(k, e) } as never;
    const go = () => runScene({ provider, cache, catalog: cat, now: () => 5000 }, { project, sceneId, scopes: ['scene'] }, 'g');
    await go();
    const first = seen.map((s) => s.range);
    expect(first).toEqual([[0, 11], [12, 17], [18, 22]]);
    await go();
    expect(seen.length).toBe(first.length);
  });

  it('the output limit still caps a span (a 4096-token provider: 5 paragraphs per call)', async () => {
    const { project, sceneId, castIds } = longScene();
    const { provider, seen } = silentProvider(castIds, { cap: 4096 });
    await run(provider, project, sceneId);
    expect(Math.max(...seen.map((s) => s.range[1] - s.range[0] + 1))).toBeLessThanOrEqual(5);
    expect(seen.length).toBe(5);
  });

  it('a truncated span is split and the spans after it shrink', async () => {
    const { project, sceneId, castIds } = longScene();
    const inner = silentProvider(castIds);
    let first = true;
    const provider: LlmProvider = { ...inner.provider, generateStructured: async (req) => {
      if (first) { first = false; throw new LlmError('truncated', 'cut'); }
      return inner.provider.generateStructured(req);
    } };
    await run(provider, project, sceneId);
    expect(inner.seen.map((s) => s.range)).toEqual([[0, 5], [6, 11], [12, 17], [18, 22]]);
  });
});

describe('the next span gets the context of the spans before it', () => {
  it('the first span has none; the later ones carry two source paragraphs, the last 3 beats and who is on stage', async () => {
    const { project, sceneId, castIds } = longScene();
    const { provider, seen } = silentProvider(castIds);
    await run(provider, project, sceneId);
    expect(seen[0]!.input.continuation).toBeUndefined();
    const c = seen[1]!.input.continuation as { note: string; contextParagraphs: Array<{ i: number }>; previousBeats: unknown[]; onStage: string[]; notYetSeen: string[]; exited: string[] };
    expect(c.contextParagraphs.map((p) => p.i)).toEqual([10, 11]);
    expect(c.previousBeats.length).toBe(3);
    expect(c.note).toContain('只读');
    // the second cast member entered in the first beat; the third was never mentioned
    expect(c.onStage.join()).toContain(castIds[1]);
    expect(c.notYetSeen.join()).toContain(castIds[2]);
    expect(c.notYetSeen.join()).not.toContain(castIds[0]);
    expect(c.exited).toEqual([]);
    // the context paragraphs are not part of the span to direct
    expect((seen[1]!.input.paragraphs as Array<{ i: number }>)[0]!.i).toBe(12);
  });

  it('the same carry is sent to rule providers harmlessly: the first-span input is identical to a scene without carry support', async () => {
    const { project, sceneId, castIds } = longScene();
    const { provider, seen } = silentProvider(castIds, { id: 'rule', cap: 1_000_000 });
    await run(provider, project, sceneId);
    expect(seen.length).toBe(1);
    expect(Object.keys(seen[0]!.input)).not.toContain('continuation');
  });
});

describe('stage helper', () => {
  const act = (castId: string, o: { enter?: boolean; exit?: boolean } = {}) => ({ castId, motion: null, expression: null, attention: null, enter: !!o.enter, exit: !!o.exit, move: null });
  const beat = (speaker: string | null, focus: string[], actors: ReturnType<typeof act>[] = []) => ({ speaker, shot: { focus }, actors }) as never;
  it('away until the entering beat, away from the exiting beat on', () => {
    const beats = [beat('a', ['a']), beat('a', ['a'], [act('b', { enter: true })]), beat('b', ['b'], [act('a', { exit: true })]), beat('b', ['b'])];
    const t = stageTimeline(beats, ['a', 'b', 'c']);
    expect(t.map((s) => [...s].join(''))).toEqual(['ac', 'abc', 'bc', 'bc']);
  });
  it('a group shot has shown everybody on stage, even with an empty focus (not "unseen", so not told to enter later)', () => {
    const group = (focus: string[]) => ({ speaker: null, shot: { type: 'group', focus }, actors: [] }) as never;
    expect(stageSummary([group([]), beat('a', ['a'])], ['a', 'b', 'c']).notYetSeen).toEqual([]);
    expect(stageSummary([beat('a', ['a']), group(['a'])], ['a', 'b', 'c']).notYetSeen).toEqual([]);
    // somebody who is not on stage is not in the group shot
    expect(stageSummary([group([])], ['a', 'b', 'c'], new Set(['c'])).notYetSeen).toEqual(['c']);
  });

  it('summary: unseen people and the ones who left', () => {
    const beats = [beat('a', ['a']), beat('b', ['b'], [act('b', { enter: true }), act('a', { exit: true })])];
    expect(stageSummary(beats, ['a', 'b', 'c'])).toEqual({ onStage: ['b', 'c'], notYetSeen: ['c'], exited: ['a'] });
  });
});

describe('a span that is not the scene\'s last does not close the scene', () => {
  /** A provider whose every span ends with a closing pull-back: group + release (+ pull_out). */
  function closingProvider(castIds: string[]) {
    const { provider, seen } = silentProvider(castIds, { outputTokensPerPara: 0 });
    const wrapped: LlmProvider = { ...provider, generateStructured: async (req) => {
      const r = await provider.generateStructured(req);
      const d = JSON.parse(JSON.stringify(r.data)) as SceneDirection;
      const last = d.beats.at(-1)!;
      last.shot = { ...last.shot, type: 'group', focus: [], move: 'pull_out', intent: 'release', flow: 'move' };
      return { ...r, data: req.schema.parse(d) as never };
    } };
    return { provider: wrapped, seen };
  }
  const travel = (p: Project) => { p.settings = { ...p.settings, cameraSystem: 'travel' }; for (const s of p.scenes) delete (s as { cameraSystem?: unknown }).cameraSystem; return p; };

  it('every non-final span is told that the scene continues; the final one is not', async () => {
    const { project, sceneId, castIds } = longScene();
    const { provider, seen } = silentProvider(castIds, { outputTokensPerPara: 800 });
    await run(provider, travel(project), sceneId);
    expect(seen.length).toBe(3);
    const notes = seen.map((s) => s.input.sceneContinues as { note: string; nextParagraph: number } | undefined);
    expect(notes[0]!.nextParagraph).toBe(12);
    expect(notes[0]!.note).toContain('不是整个场景的结尾');
    expect(notes[1]!.nextParagraph).toBe(18);
    expect(notes[2]).toBeUndefined();
  });

  it('a single-span scene has no such field (classic and travel inputs of a short scene are unchanged)', async () => {
    const { project, sceneId, castIds } = longScene();
    const { provider, seen } = silentProvider(castIds, { id: 'rule', cap: 1_000_000 });
    await run(provider, travel(project), sceneId);
    expect(Object.keys(seen[0]!.input)).not.toContain('sceneContinues');
  });

  it('the classic system prompt, schema and prompt version are untouched', async () => {
    const { project, sceneId, castIds } = longScene();
    const reqs: Array<{ system: string; schemaName: string }> = [];
    const { provider } = silentProvider(castIds);
    const spy: LlmProvider = { ...provider, generateStructured: async (req) => { reqs.push({ system: req.system, schemaName: req.schemaName }); return provider.generateStructured(req); } };
    await run(spy, project, sceneId);
    const { SCENE_SYSTEM } = await import('../../server/llm/prompts/sceneDirection');
    expect(new Set(reqs.map((r) => r.system))).toEqual(new Set([SCENE_SYSTEM]));
    expect(new Set(reqs.map((r) => r.schemaName))).toEqual(new Set(['SceneDirection']));
  });

  it('travel: a release / pull_out on the last beat of a non-final span is downgraded with a reason; the final span keeps its release', async () => {
    const { project, sceneId, castIds } = longScene();
    const { provider } = closingProvider(castIds);
    const res = await run(provider, travel(project), sceneId);
    const beats = res.direction.beats;
    const ends = [11].map((p) => beats.findLast((b) => b.paragraph === p)!);
    for (const e of ends) {
      expect(e.shot.intent).not.toBe('release');
      expect(e.shot.flow).toBe('auto');
      expect(e.shot.move).toBe('static');
      expect(e.reason).toContain('场景还在继续');
    }
    expect(beats.at(-1)!.shot.intent).toBe('release');
    const w = res.warnings.filter((x) => x.includes('场景在后面还会继续'));
    expect(w.length).toBe(1);
    expect(w[0]).toContain('release');
  });

  it('classic: the guard does not touch anything (there is no intent in the classic schema)', async () => {
    const { project, sceneId, castIds } = longScene();
    const { provider } = silentProvider(castIds, { outputTokensPerPara: 800 });
    const res = await run(provider, project, sceneId);
    expect(res.warnings.some((x) => x.includes('场景在后面还会继续'))).toBe(false);
  });
});

describe('downgradeChunkEnd', () => {
  const b = (focus: string[], type: string, o: Record<string, unknown> = {}) => ({ keepId: null, reason: 'r', shot: { type, focus, move: 'static', intent: 'continue', flow: 'auto', ...o } }) as never;
  it('release on a person other than the previous one becomes exchange; a locked beat is left alone', async () => {
    const { downgradeChunkEnd } = await import('../../shared/director/intentNormalize');
    const beats = [b(['a'], 'mcu'), b(['b'], 'ms', { intent: 'release', flow: 'cut' })];
    const w = downgradeChunkEnd(beats, { where: (i) => `#${i}` });
    expect((beats[1] as never as { shot: { intent: string; flow: string } }).shot).toMatchObject({ intent: 'exchange', flow: 'auto' });
    expect(w.length).toBe(1);
    const locked = [b(['a'], 'group', { intent: 'release' })] as never[];
    expect(downgradeChunkEnd(locked, { skip: () => true, where: String })).toEqual([]);
    expect((locked[0] as never as { shot: { intent: string } }).shot.intent).toBe('release');
  });
});
