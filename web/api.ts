import type { Calibration } from '@shared/schema/calibration';
import type { GroundOverride } from '@shared/schema/ground';
import type { CompactCatalog, ModelEntry } from '@shared/schema/assets';

export interface Health {
  ok: boolean;
  version: string;
  assetRoot:
    | { ok: true; path: string; models: number; backgrounds: number }
    | { ok: false; path: string; error: string };
  audioRoots: Array<{ path: string; ok: boolean }>;
  cubismCoreUrl: string;
  catalog: { state: 'indexing' } | { state: 'ready'; ms: number } | { state: 'error'; error: string };
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `${url}: HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}

export const fetchHealth = () => getJson<Health>('/api/health');
export const fetchCatalog = () => getJson<CompactCatalog>('/api/catalog');
export const fetchModel = (id: string) => getJson<ModelEntry>(`/api/catalog/models/${encodeURIComponent(id)}`);

export async function fetchCalibration(modelId: string): Promise<Calibration | null> {
  const res = await fetch(`/api/calibration/${encodeURIComponent(modelId)}`);
  if (!res.ok) throw new Error(`calibration: HTTP ${res.status}`);
  return (await res.json()) as Calibration | null;
}

export async function saveCalibration(c: Calibration): Promise<Calibration> {
  const res = await fetch(`/api/calibration/${encodeURIComponent(c.modelId)}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(c),
  });
  if (!res.ok) throw new Error(`calibration save: HTTP ${res.status}`);
  return (await res.json()) as Calibration;
}

export async function fetchBackgroundGround(id: string): Promise<GroundOverride | null> {
  return getJson<GroundOverride | null>(`/api/backgrounds/${encodeURIComponent(id)}/ground`);
}

export async function saveBackgroundGround(id: string, g: GroundOverride): Promise<GroundOverride> {
  const res = await fetch(`/api/backgrounds/${encodeURIComponent(id)}/ground`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(g),
  });
  if (!res.ok) throw new Error(`ground save: HTTP ${res.status}`);
  return (await res.json()) as GroundOverride;
}
