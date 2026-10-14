import { useEffect, useState } from 'react';
import type { CompactCatalog } from '@shared/schema/assets';
import type { CatalogIds } from '@shared/project/exchange';
import { fetchCatalog } from '../api';

let cached: Promise<CompactCatalog> | null = null;
const listeners = new Set<(c: CompactCatalog) => void>();

/** Refetch the catalog (after an upload) and update every mounted useCatalog(). */
export async function reloadCatalog(): Promise<CompactCatalog> {
  const p = fetchCatalog();
  cached = p;
  const c = await p;
  for (const fn of listeners) fn(c);
  return c;
}

/** Forget the cached catalog (after labels were edited) so the next mount refetches it. */
export const resetCatalogCache = () => {
  cached = null;
};

/** The compact asset catalog, fetched once per page load. */
export function useCatalog(): CompactCatalog | null {
  const [catalog, setCatalog] = useState<CompactCatalog | null>(null);
  useEffect(() => {
    let live = true;
    const on = (c: CompactCatalog) => live && setCatalog(c);
    listeners.add(on);
    (cached ??= fetchCatalog()).then(
      (c) => live && setCatalog(c),
      () => {
        cached = null;
      },
    );
    return () => {
      live = false;
      listeners.delete(on);
    };
  }, []);
  return catalog;
}

export const idsOf = (c: CompactCatalog): CatalogIds => ({
  models: new Set(c.models.map((m) => m.id)),
  backgrounds: new Set(c.backgrounds.map((b) => b.id)),
  audio: new Set(c.audio.map((a) => a.id)),
});
