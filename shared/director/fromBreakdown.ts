/** Breakdown (Pass 1, validated) -> a project whose scenes have background, outfits, stage positions and the source text as plain narration. */
import { blankProject } from '../project/blank';
import { newBeat, newSceneId, nextCastId } from '../project/mutate';
import type { Breakdown } from '../schema/ai';
import type { CastMember, Meta, Project, Scene } from '../schema/project';
import { bandFormation, spreadEvenly } from './formation';
import type { Paragraph } from './paragraphs';
import { lookup, type DirectorCatalog } from './resources';

export const baseAiMeta = (genId: string, reason: string | undefined, now: number): Meta => ({ source: 'ai', locked: false, genId, ...(reason ? { reason } : {}), updatedAt: now });
export const aiMeta = baseAiMeta;
export const ruleMeta = (genId: string, reason: string | undefined, now: number): Meta => ({ source: 'rule', locked: false, genId, ...(reason ? { reason } : {}), updatedAt: now });

export interface FromBreakdownInput {
  title: string;
  text: string;
  paragraphs: Paragraph[];
  breakdown: Breakdown;
  catalog: DirectorCatalog;
  genId: string;
  now?: number;
  /** Source stamped on the model's decisions: `ai`, or `rule` for the test-only replay provider (never labelled as AI). */
  decisions?: 'ai' | 'rule';
  /** Start from this project instead of a blank one (its scenes are replaced, cast ids of known characters are kept). */
  base?: Project;
}

export function projectFromBreakdown(inp: FromBreakdownInput): Project {
  const now = inp.now ?? Date.now();
  const aiMeta = (genId: string, reason: string | undefined, at: number): Meta => ({ ...baseAiMeta(genId, reason, at), source: inp.decisions ?? 'ai' });
  const L = lookup(inp.catalog);
  const project: Project = inp.base ? { ...JSON.parse(JSON.stringify(inp.base)) as Project, scenes: [] } : blankProject(inp.title, now);
  project.source = { text: inp.text, format: 'novel' };

  const castOf = new Map<string, CastMember>(project.cast.map((c) => [c.characterKey, c]));
  const ensureCast = (key: string): CastMember => {
    let c = castOf.get(key);
    if (!c) {
      c = { id: nextCastId(project), characterKey: key, displayName: L.characters.get(key)?.name ?? key, meta: aiMeta(inp.genId, '拆解得出的角色', now) };
      castOf.set(key, c);
      project.cast.push(c);
    }
    return c;
  };

  inp.breakdown.scenes.forEach((s, si) => {
    const id = newSceneId(project);
    const castIds = s.presentCast.map((k) => ensureCast(k).id);
    const spots = (s.isPerformance ? bandFormation(inp.catalog, s.band, s.presentCast) : null) ?? Object.fromEntries(Object.entries(spreadEvenly(s.presentCast)));
    const bg = L.backgrounds.get(s.location.backgroundId);
    const first = inp.paragraphs[s.startParagraph];
    const lastP = inp.paragraphs[s.endParagraph];
    const scene: Scene = {
      id,
      title: s.title,
      sourceSpan: { start: first?.start ?? 0, end: lastP?.end ?? 0 },
      meta: aiMeta(inp.genId, s.mood, now),
      brief: { timeOfDay: s.timeOfDay, mood: s.mood, isPerformance: s.isPerformance, band: s.band, ...(s.location.guestOf ? { guestOf: s.location.guestOf } : {}) },
      background: { assetId: s.location.backgroundId, framing: { zoom: 1, offsetX: 0, offsetY: 0 }, meta: aiMeta(inp.genId, s.location.reason, now) },
      wardrobe: Object.fromEntries(s.wardrobe.map((w) => [castOf.get(w.characterKey)!.id, { modelId: w.modelId, meta: aiMeta(inp.genId, w.reason, now) }])),
      blocking: Object.fromEntries(
        s.presentCast.map((k, i) => [castIds[i]!, { slot: spots[k]?.slot ?? 0, depth: spots[k]?.depth ?? 0.3, meta: ruleMeta(inp.genId, s.isPerformance ? '乐队编队' : '均匀站位', now) }]),
      ),
      transitionIn: { kind: si === 0 ? 'cut' : 'scene_black', duration: 0, meta: ruleMeta(inp.genId, undefined, now) },
      ...(bg ? { location: { text: bg.location ?? bg.name, show: true, meta: ruleMeta(inp.genId, undefined, now) } } : {}),
      style: { overrides: {}, meta: ruleMeta(inp.genId, undefined, now) },
      audio: {},
      beats: [],
      tracks: [],
    };
    // The text as plain narration until scene direction replaces it (keeps the project playable after Pass 1).
    for (const p of inp.paragraphs.slice(s.startParagraph, s.endParagraph + 1)) {
      const beat = newBeat(scene, { kind: 'narration', text: p.text });
      beat.sourceOffset = p.start;
      beat.meta = ruleMeta(inp.genId, '原文段落（尚未生成演出）', now);
      beat.shot.meta = ruleMeta(inp.genId, undefined, now);
      beat.style.meta = ruleMeta(inp.genId, undefined, now);
      scene.beats.push(beat);
    }
    project.scenes.push(scene);
  });
  project.updatedAt = now;
  return project;
}
