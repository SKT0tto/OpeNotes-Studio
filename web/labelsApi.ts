import type { BgLabel, BgLabelPatch } from '@shared/schema/assetLabels';

async function send(method: string, url: string, body: unknown): Promise<void> {
  const res = await fetch(url, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) {
    const e = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(e?.error ?? `HTTP ${res.status}`);
  }
}

/** Merge `patch` into the labels of `ids` (server validates and writes asset-labels/backgrounds.json). */
export const patchLabels = (ids: string[], patch: BgLabelPatch) => send('PATCH', '/api/asset-labels/backgrounds', { ids, patch });
/** Replace one label (used by undo). */
export const putLabel = (id: string, label: BgLabel) => {
  const rest: Partial<BgLabel> = { ...label };
  delete rest.source;
  delete rest.updatedAt;
  return send('PUT', `/api/asset-labels/backgrounds/${encodeURIComponent(id)}`, rest);
};
