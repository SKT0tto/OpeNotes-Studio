import type { BackgroundEntry } from '../schema/assets';

export interface BackgroundFilter {
  kind?: string;
  setting?: string;
  time?: string;
  query?: string;
}

function blob(b: BackgroundEntry): string {
  return [b.id, b.name, ...b.aliases, b.location, b.category, b.kind, b.setting, b.time, b.weather, b.description, ...b.tags]
    .filter(Boolean)
    .join('\n')
    .toLowerCase();
}

const blobCache = new WeakMap<BackgroundEntry, string>();

/** Every whitespace-separated query term must appear somewhere in the entry's text fields. */
export function filterBackgrounds(list: readonly BackgroundEntry[], f: BackgroundFilter): BackgroundEntry[] {
  const terms = (f.query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  return list.filter((b) => {
    if (f.kind && b.kind !== f.kind) return false;
    if (f.setting && b.setting !== f.setting) return false;
    if (f.time && b.time !== f.time) return false;
    if (terms.length === 0) return true;
    let text = blobCache.get(b);
    if (text === undefined) blobCache.set(b, (text = blob(b)));
    return terms.every((t) => text.includes(t));
  });
}

export function distinct(values: ReadonlyArray<string | null>): string[] {
  return [...new Set(values.filter((v): v is string => !!v))].sort();
}
