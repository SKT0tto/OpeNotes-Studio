/**
 * The one definition of "what a regeneration scope covers". The merge of AI results (mergeLocks) and the editor's
 * partial regeneration / diff view both read this table, so they cannot disagree.
 */
import type { Channel } from '../schema/project';

export interface ScopeSpec {
  /** Track channels whose keys are replaced. */
  tracks: readonly Channel[];
  /** Fields of the beat that are replaced. */
  beatFields?: readonly string[];
  /** Fields of the scene that are replaced (per-actor records such as `wardrobe` / `blocking` are merged per cast id). */
  sceneFields?: readonly string[];
}

export const SCOPES = {
  camera: { tracks: ['camera'], beatFields: ['shot', 'cutIn', 'cutInKeepDialog'] },
  performance: { tracks: ['motion', 'expression', 'head', 'body', 'gaze'], beatFields: ['emotion'] },
  costume: { sceneFields: ['wardrobe'], tracks: ['costume'] },
  staging: { sceneFields: ['blocking'], tracks: ['position', 'opacity'] },
  fx: { tracks: ['fx', 'fade'] },
  background: { tracks: ['background'] },
} as const satisfies Record<string, ScopeSpec>;

/** `scene` = the whole direction of a scene, including the beat list itself (text, speakers, order), transition and music. */
export type ScopeName = keyof typeof SCOPES | 'scene';
export const SCOPE_NAMES: readonly ScopeName[] = ['scene', ...(Object.keys(SCOPES) as Array<keyof typeof SCOPES>)];
export const SCOPE_LABEL: Record<ScopeName, string> = { scene: '整个场景', camera: '镜头', performance: '表演（动作·表情·视线）', costume: '服装', staging: '站位', fx: '特效', background: '场景内背景切换' };

export interface ResolvedScope {
  /** Beat list / text / speaker / order / transition / bgm are regenerated too. */
  structure: boolean;
  tracks: Set<Channel>;
  beatFields: Set<string>;
  sceneFields: Set<string>;
}

/** Union of the named scopes (`scene` includes everything). */
export function resolveScope(names: readonly ScopeName[]): ResolvedScope {
  const all = names.includes('scene');
  const list: ScopeName[] = all ? (Object.keys(SCOPES) as Array<keyof typeof SCOPES>) : names.filter((n) => n !== 'scene');
  const r: ResolvedScope = { structure: all, tracks: new Set(), beatFields: new Set(), sceneFields: new Set() };
  for (const n of list) {
    const spec: ScopeSpec = SCOPES[n as keyof typeof SCOPES];
    spec.tracks.forEach((c) => r.tracks.add(c));
    spec.beatFields?.forEach((f) => r.beatFields.add(f));
    spec.sceneFields?.forEach((f) => r.sceneFields.add(f));
  }
  return r;
}

/** Fields of a beat that make up its text structure (protected by `source: user`, replaced only by the `scene` scope). */
export const BEAT_STRUCTURE_FIELDS = ['kind', 'variant', 'speakerId', 'coSpeakers', 'text', 'sourceOffset', 'duration'] as const;
