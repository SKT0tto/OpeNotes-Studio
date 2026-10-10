import { useEffect, useState } from 'react';
import type { ModelEntry } from '@shared/schema/assets';
import { fetchModel } from '../api';

const cache = new Map<string, Promise<ModelEntry>>();

/** The model entry (fetched once and cached) for code that is not a component. */
export function loadModel(modelId: string): Promise<ModelEntry> {
  let p = cache.get(modelId);
  if (!p) cache.set(modelId, (p = fetchModel(modelId)));
  p.catch(() => cache.delete(modelId));
  return p;
}

/** Full model entry (motions, expressions) of a model id, fetched once. */
export function useModelEntry(modelId: string | null | undefined): ModelEntry | null {
  const [entry, setEntry] = useState<{ id: string; model: ModelEntry } | null>(null);
  useEffect(() => {
    if (!modelId) return;
    let live = true;
    loadModel(modelId).then(
      (m) => live && setEntry({ id: modelId, model: m }),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [modelId]);
  return entry && entry.id === modelId ? entry.model : null;
}
