import { useEffect, useState } from 'react';
import type { CompactCatalog } from '@shared/schema/assets';
import type { CatalogIds } from '@shared/project/exchange';
import { fetchCatalog } from '../api';

let cached: Promise<CompactCatalog> | null = null;

/** Forget the cached catalog (after labels were edited) so the next mount refetches it. */
export const resetCatalogCache = () => {
  cached = null;
};

/** The compact asset catalog, fetched once per page load. */
export function useCatalog(): CompactCatalog | null {
  const [catalog, setCatalog] = useState<CompactCatalog | null>(null);
  useEffect(() => {
    let live = true;
    (cached ??= fetchCatalog()).then(
      (c) => live && setCatalog(c),
      () => {
        cached = null;
      },
    );
    return () => {
      live = false;
    };
  }, []);
  return catalog;
}

export const idsOf = (c: CompactCatalog): CatalogIds => ({
  models: new Set(c.models.map((m) => m.id)),
  backgrounds: new Set(c.backgrounds.map((b) => b.id)),
  audio: new Set(c.audio.map((a) => a.id)),
});
