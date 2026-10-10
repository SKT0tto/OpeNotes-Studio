/** Stage arrangement of the people in a scene, decided by deterministic code from the director's intent. */
import type { DirectorCatalog } from './resources';

export interface Spot {
  slot: number;
  depth: number;
}

/** Bandmates of a formal performance: the band's formation (vocalist front centre, drummer at the back ...); others fill the sides. */
export function bandFormation(cat: DirectorCatalog, band: string | null, keys: readonly string[]): Record<string, Spot> | null {
  const byMajority = (): string | null => {
    const count = new Map<string, number>();
    for (const k of keys) {
      const b = cat.characters.find((c) => c.key === k)?.bandKey;
      if (b) count.set(b, (count.get(b) ?? 0) + 1);
    }
    return [...count.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  };
  const def = cat.bands.find((b) => b.key === band || b.name === band) ?? cat.bands.find((b) => b.key === byMajority());
  if (!def) return null;
  const out: Record<string, Spot> = {};
  const rest: string[] = [];
  for (const k of keys) {
    const f = def.formation.find((x) => x.key === k);
    if (f) out[k] = { slot: f.x, depth: f.depth };
    else rest.push(k);
  }
  rest.forEach((k, i) => {
    out[k] = { slot: i % 2 === 0 ? -0.85 : 0.85, depth: 0.7 };
  });
  return out;
}

/** Evenly spread people across the stage, left to right in the given order. */
export function spreadEvenly(ids: readonly string[], depth = 0.3): Record<string, Spot> {
  const out: Record<string, Spot> = {};
  ids.forEach((id, i) => {
    out[id] = { slot: ids.length === 1 ? 0 : -0.5 + (1 * i) / (ids.length - 1), depth };
  });
  return out;
}
