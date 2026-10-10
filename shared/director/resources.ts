/** Lookups on the asset catalog used by the director: only ids that exist are ever accepted or written. */
import { costumeLabel } from '../catalog/costume';
import type { BackgroundEntry, Catalog, ModelEntry } from '../schema/assets';

export type DirectorCatalog = Pick<Catalog, 'models' | 'backgrounds' | 'characters' | 'bands' | 'audio'> & Partial<Pick<Catalog, 'labelRules'>>;

export interface Lookup {
  models: Map<string, ModelEntry>;
  backgrounds: Map<string, BackgroundEntry>;
  audio: Set<string>;
  characters: Map<string, DirectorCatalog['characters'][number]>;
  modelsOf: Map<string, ModelEntry[]>;
}

export function lookup(cat: DirectorCatalog): Lookup {
  const modelsOf = new Map<string, ModelEntry[]>();
  for (const m of cat.models) {
    const l = modelsOf.get(m.characterKey) ?? [];
    l.push(m);
    modelsOf.set(m.characterKey, l);
  }
  return {
    models: new Map(cat.models.map((m) => [m.id, m])),
    backgrounds: new Map(cat.backgrounds.map((b) => [b.id, b])),
    audio: new Set(cat.audio.map((a) => a.id)),
    characters: new Map(cat.characters.map((c) => [c.key, c])),
    modelsOf,
  };
}

/** Costumes the AI may pick: drop `_low` twins, stills and (unless asked) live-mode models. */
export const selectable = (m: ModelEntry, opts: { live?: boolean } = {}): boolean =>
  m.quality !== 'low' && !m.still && (opts.live ? m.mode === 'live' : m.mode === 'adv');

/** Deterministic default outfit of a character: casual (spring first), no glasses variant, lowest id. */
export function defaultModel(L: Lookup, characterKey: string, opts: { live?: boolean } = {}): ModelEntry | null {
  const list = (L.modelsOf.get(characterKey) ?? []).filter((m) => selectable(m, opts));
  if (list.length === 0) return null;
  const rank = (m: ModelEntry) => {
    const c = m.costumeInfo;
    return (c.base === 'casual' ? 0 : c.base === 'school' ? 3 : c.base === 'live' ? 1 : 6) + (c.season === 'spring' ? 0 : 1) + (c.glasses ? 2 : 0) + (c.tags.length > 0 ? 1 : 0);
  };
  return [...list].sort((a, b) => rank(a) - rank(b) || (a.id < b.id ? -1 : 1))[0]!;
}

export const modelLabel = (m: ModelEntry): string => costumeLabel(m.costumeInfo);

const grams = (s: string): Set<string> => {
  const t = [...s.toLowerCase().replace(/[\s\p{P}]/gu, '')];
  const out = new Set<string>();
  for (let i = 0; i < t.length; i++) {
    out.add(t[i]!);
    if (i + 1 < t.length) out.add(t[i]! + t[i + 1]!);
  }
  return out;
};

const bgText = (b: BackgroundEntry) => [b.name, b.location, b.category, b.setting, b.time, b.description, ...b.aliases, ...b.tags].filter(Boolean).join(' ');

/** Backgrounds ranked by overlap with `query` text; `prefer.setting` / `prefer.time` break ties (e.g. 夜间 / 室内). */
export function rankBackgrounds(bgs: readonly BackgroundEntry[], query: string, prefer: { setting?: string; time?: string } = {}): BackgroundEntry[] {
  const q = grams(query);
  const score = (b: BackgroundEntry) => {
    let hit = 0;
    for (const g of grams(bgText(b))) if (q.has(g)) hit += g.length;
    const pre = (v: string | null, want?: string) => (want && v && (v.includes(want) || want.includes(v)) ? 3 : 0);
    return hit + pre(b.setting, prefer.setting) + pre(b.time, prefer.time);
  };
  return bgs.map((b) => ({ b, s: score(b) })).sort((x, y) => y.s - x.s || (x.b.id < y.b.id ? -1 : 1)).map((x) => x.b);
}
