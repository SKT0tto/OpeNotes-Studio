import type { ScopeName } from '@shared/director/scope';
import type { Breakdown, SceneDirection } from '@shared/schema/ai';
import type { Project, Scene } from '@shared/schema/project';

export interface RunInfo {
  pass: 'breakdown' | 'scene' | 'split';
  label: string;
  provider: string;
  model: string;
  cached: boolean;
  ms: number;
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number };
  repaired: boolean;
  warnings: string[];
}
export interface BreakdownResponse {
  breakdown: Breakdown;
  project: Project;
  warnings: string[];
  runs: RunInfo[];
  /** Long lines that were cut into consecutive lines (absent when none were). */
  splits?: Array<{ beatId: string; pieceBeatIds: string[]; by: 'ai' | 'retry' | 'rule'; pieces: Array<{ text: string; why: string }> }>;
  cached: boolean;
}
export interface MergeConflict { kind: string; label: string }
export interface SceneResponse {
  sceneId: string;
  scene: Scene;
  applied: boolean;
  conflicts: MergeConflict[];
  report: { replacedBeats: string[]; keptBeats: string[]; replacedTracks: string[]; keptTracks: string[]; protectedKept: string[] };
  direction: SceneDirection;
  warnings: string[];
  runs: RunInfo[];
  /** Long lines that were cut into consecutive lines (absent when none were). */
  splits?: Array<{ beatId: string; pieceBeatIds: string[]; by: 'ai' | 'retry' | 'rule'; pieces: Array<{ text: string; why: string }> }>;
  cached: boolean;
}
export interface BatchItem { sceneId: string; result?: SceneResponse; error?: { kind: string; message: string } }
export interface BatchProgress { sceneId: string; title: string; state: 'start' | 'done' | 'error'; /** With `start`: the scene is cutting `count` long lines (its second step). */ phase?: 'split'; count?: number; message?: string; kind?: string; cached?: boolean; result?: SceneResponse }

/** A failed AI request: `kind` (not_configured, auth, network, truncated, repair_failed, ...) and a message safe to show. */
export class DirectorApiError extends Error {
  constructor(public readonly kind: string, message: string, public readonly problems: string[] = []) {
    super(message);
  }
}

async function failure(res: Response): Promise<DirectorApiError> {
  const body = (await res.json().catch(() => null)) as { error?: { kind?: string; message?: string; problems?: string[] } } | null;
  return new DirectorApiError(body?.error?.kind ?? 'server', body?.error?.message ?? `HTTP ${res.status}`, body?.error?.problems ?? []);
}

const postJson = (url: string, body: unknown, signal?: AbortSignal) =>
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), ...(signal ? { signal } : {}) });

export async function postBreakdown(text: string, title: string, refresh = false, signal?: AbortSignal, engine?: 'rule'): Promise<BreakdownResponse> {
  const res = await postJson('/api/director/breakdown', { text, title, refresh, ...(engine ? { engine } : {}) }, signal);
  if (!res.ok) throw await failure(res);
  return (await res.json()) as BreakdownResponse;
}

/** useMemories=false: generate without the user's saved style preferences (experimental memory; default: with them). */
export interface SceneOptions { scopes: ScopeName[]; beatIds?: string[]; overwriteUser?: boolean; refresh?: boolean; engine?: 'rule'; useMemories?: boolean }

export async function postScene(project: Project, sceneId: string, o: SceneOptions, signal?: AbortSignal): Promise<SceneResponse> {
  const res = await postJson('/api/director/scene', { project, sceneId, ...o }, signal);
  if (!res.ok) throw await failure(res);
  return (await res.json()) as SceneResponse;
}

/** All scenes (2-3 at a time on the server); `onProgress` fires as scenes start / finish. */
export async function postScenes(project: Project, o: SceneOptions & { sceneIds?: string[] }, onProgress: (p: BatchProgress) => void, signal?: AbortSignal): Promise<BatchItem[]> {
  const res = await postJson('/api/director/scenes', { project, ...o }, signal);
  if (!res.ok || !res.body) throw await failure(res);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let items: BatchItem[] | null = null;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const ev = /^event: (\w+)/m.exec(block)?.[1];
      const data = /^data: (.*)$/m.exec(block)?.[1];
      if (!ev || !data) continue;
      const json = JSON.parse(data) as unknown;
      if (ev === 'progress') onProgress(json as BatchProgress);
      else if (ev === 'done') items = (json as { items: BatchItem[] }).items;
      else if (ev === 'failed') throw new DirectorApiError('server', (json as { message: string }).message);
    }
  }
  if (!items) throw new DirectorApiError('server', '连接中断，没有收到结果');
  return items;
}
