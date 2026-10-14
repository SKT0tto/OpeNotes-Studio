export interface CoreState {
  licenseAccepted: boolean; licenseUrl: string; downloadPageUrl: string; officialUrl: string; cubismCoreUrl: string; local: boolean; localFileExists: boolean;
}
export interface PlanModel {
  id: string; src: string; status: string; idGuessed: boolean; files: number; bytes: number; motions: number; expressions: number; textures: number;
  normalized: boolean; mocVersion: number | null; warnings: string[]; errors: string[];
}
export interface PlanBackground { id: string; src: string; status: string; bytes: number; width: number | null; height: number | null; labelled: boolean; message?: string }
export interface PlanPack { generatedAt: string; counts: { models: number; backgrounds: number; media: number }; totalBytes: number; listed: number; verified: number; problems: string[] }
export interface ImportPlan {
  media: { files: number; bytes: number; new: number; duplicate: number; conflict: number } | null;
  manifest: 'new' | 'duplicate' | 'conflict' | null;
  pack: PlanPack | null;
  planId: string; source: string; models: PlanModel[]; backgrounds: PlanBackground[]; skipped: Array<{ path: string; reason: string }>;
  errors: Array<{ path: string; message: string }>; warnings: string[]; fileCount: number; totalBytes: number;
}
export interface ImportResult {
  report: {
    imported: { models: string[]; backgrounds: string[] };
    skipped: Array<{ id: string; kind: string; reason: string }>;
    errors: Array<{ id: string; message: string }>;
    bytes: number; files: number;
    totals: { models: number; backgrounds: number; motions: number; expressions: number; media: number };
    manifest: boolean;
  };
  unlabelledBackgrounds: string[];
}
export interface ImportTarget { assetRoot: string; writable: boolean; fromEnv: boolean; maxBytes: number }
export interface SourceInfo { id: string; name: string; policy: string; accepted: boolean; disclaimerVersion: string; disclaimer: string[]; locales: string[] }
export interface ListModel { id: string; label: string; mode: string; low: boolean; have: boolean; url: string }
export interface ListBand { key: string; name: string; characters: Array<{ key: string; name: string; models: ListModel[] }> }
export interface ListBackground { id: string; kind: 'story' | 'card'; name: string | null; have: boolean; labelled: boolean; band: string | null; place: string | null; url: string }
export interface HaneokaList {
  releaseId: string | null; fetchedAt: number; locale: string; bands: ListBand[]; backgrounds: ListBackground[];
  counts: { models: number; modelsMissing: number; backgrounds: number; backgroundsMissing: number };
}

export class ApiError extends Error {
  constructor(message: string, readonly code?: string, readonly status?: number) {
    super(message);
  }
}

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    const b = (await res.json().catch(() => null)) as { error?: string; code?: string } | null;
    throw new ApiError(b?.error ?? `${url}: HTTP ${res.status}`, b?.code, res.status);
  }
  return (await res.json()) as T;
}
const json = (method: string, body?: unknown): RequestInit => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });

export const getCoreState = () => call<CoreState>('/api/setup/core');
export const acceptCoreLicense = () => call<CoreState>('/api/setup/core/accept-license', json('POST'));
export const fetchOfficialCore = () => call<CoreState>('/api/setup/core/fetch', json('POST'));
export const uploadCore = (file: File) => call<CoreState>('/api/setup/core/upload', { method: 'POST', body: file, headers: { 'content-type': 'application/octet-stream' } });
export const resetCore = () => call<CoreState>('/api/setup/core/reset', json('POST'));

export const getImportTarget = () => call<ImportTarget>('/api/import/target');
export const setImportTarget = (path: string) => call<{ saved: boolean; restartRequired: boolean; envOverride: boolean }>('/api/import/target', json('PUT', { path }));
export interface JobState {
  id: string; status: 'running' | 'done' | 'error' | 'cancelled'; phase: string; done: number; total: number; bytes: number;
  error?: string; plan?: ImportPlan; result?: ImportResult;
}
export type JobProgress = (j: JobState) => void;
const startJob = (url: string, init: RequestInit) => call<{ jobId: string }>(url, init).then((r) => r.jobId);

/** Polls a job until it ends; resolves with the final state, throws on error / cancel. */
export async function waitForJob(jobId: string, onProgress?: JobProgress): Promise<JobState> {
  for (;;) {
    const j = await call<JobState>(`/api/import/jobs/${jobId}`);
    onProgress?.(j);
    if (j.status === 'done') return j;
    if (j.status !== 'running') throw new ApiError(j.status === 'cancelled' ? '已取消' : (j.error ?? '导入失败'));
    await new Promise((r) => setTimeout(r, 400));
  }
}
export const cancelJob = (jobId: string) => call<{ ok: boolean }>(`/api/import/jobs/${jobId}`, { method: 'DELETE' });

export const scanImport = (path: string) => startJob('/api/import/scan', json('POST', { path }));
export const uploadImport = (file: File) => startJob('/api/import/upload', { method: 'POST', body: file, headers: { 'x-filename': encodeURIComponent(file.name), 'content-type': 'application/octet-stream' } });
export const replanImport = (planId: string, ids: Record<string, string>) => startJob('/api/import/plan', json('POST', { planId, ids }));
export const runImport = (planId: string, ids: Record<string, string>, overwrite: boolean) => startJob('/api/import/run', json('POST', { planId, ids, overwrite }));
export const uploadBackground = (blob: Blob, filename: string) =>
  call<{ id: string; status: 'new' | 'duplicate'; name: string; width: number; height: number }>('/api/import/background', { method: 'POST', body: blob, headers: { 'x-filename': encodeURIComponent(filename), 'content-type': 'image/png' } });
export const deleteUploadedBackground = (id: string) => call<{ ok: boolean }>(`/api/import/background/${encodeURIComponent(id)}`, { method: 'DELETE' });
export const getBackgroundUsage = (id: string) => call<{ projects: Array<{ id: string; title: string; scenes: number }> }>(`/api/import/background/${encodeURIComponent(id)}/usage`);
export const cancelImport = (planId: string) => call<{ ok: boolean }>(`/api/import/${planId}`, { method: 'DELETE' });

export const getSource = () => call<SourceInfo>('/api/sources/haneoka');
export const acceptSource = (version: string) => call<{ accepted: boolean }>('/api/sources/haneoka/accept', json('POST', { version }));
export const getHaneokaList = (locale: string, refresh = false) => call<{ list: HaneokaList; fromCache: boolean }>(`/api/sources/haneoka/list?locale=${encodeURIComponent(locale)}${refresh ? '&refresh=1' : ''}`);
export async function downloadManifest(sel: { models: string[]; backgrounds: string[]; format: 'md' | 'csv'; locale: string }): Promise<void> {
  const res = await fetch('/api/sources/haneoka/manifest', json('POST', sel));
  if (!res.ok) throw new ApiError(((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? `HTTP ${res.status}`);
  const blob = await res.blob();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `openotes-manifest.${sel.format}`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
