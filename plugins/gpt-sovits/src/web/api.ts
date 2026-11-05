import type { HostApi } from '../../../../shared/plugins/api';
import type { Project } from '../../../../shared/schema/project';
import type { MatchCharacter, MatchResult } from '../match/match';
import type { VoiceJobView, VoiceScope, VoiceSettings, VoiceSettingsPatch } from '../schema';

export const PLUGIN_ID = 'gpt-sovits';

let hostRef: HostApi | null = null;
export const setHost = (h: HostApi) => void (hostRef = h);
export const host = (): HostApi => {
  if (!hostRef) throw new Error('plugin not activated');
  return hostRef;
};

async function failure(res: Response): Promise<Error> {
  const body = (await res.json().catch(() => null)) as { error?: string } | null;
  return new Error(body?.error ?? `HTTP ${res.status}`);
}
const call = (path: string, init?: RequestInit) => host().fetchPlugin(PLUGIN_ID, path, init);
const json = (method: string, body: unknown): RequestInit => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

export async function fetchVoiceSettings(): Promise<VoiceSettings> {
  const res = await call('settings');
  if (!res.ok) throw await failure(res);
  return (await res.json()) as VoiceSettings;
}
export async function saveVoiceSettings(patch: VoiceSettingsPatch): Promise<VoiceSettings> {
  const res = await call('settings', json('PUT', patch));
  if (!res.ok) throw await failure(res);
  return (await res.json()) as VoiceSettings;
}
export async function testVoiceConnection(endpoint: string): Promise<{ ok: boolean; message: string }> {
  const res = await call('test', json('POST', { endpoint }));
  if (!res.ok) throw await failure(res);
  return (await res.json()) as { ok: boolean; message: string };
}
/** A short test sentence in one character's voice (the profile must be saved first). */
export async function previewVoice(characterKey: string, text?: string): Promise<Blob> {
  const res = await call('preview', json('POST', { characterKey, ...(text ? { text } : {}) }));
  if (!res.ok) throw await failure(res);
  return res.blob();
}
export async function startVoiceJob(project: Project, scope: VoiceScope, opts: { retranslate?: boolean; force?: boolean; regenerate?: boolean; overwriteEdited?: boolean } = {}): Promise<string> {
  const res = await call('jobs', json('POST', { project, scope, ...opts }));
  if (!res.ok) throw await failure(res);
  return ((await res.json()) as { id: string }).id;
}
export async function getVoiceJob(id: string): Promise<VoiceJobView> {
  const res = await call(`jobs/${encodeURIComponent(id)}`);
  if (!res.ok) throw await failure(res);
  return (await res.json()) as VoiceJobView;
}
export async function cancelVoiceJob(id: string): Promise<void> {
  await call(`jobs/${encodeURIComponent(id)}/cancel`, { method: 'POST' });
}
/** A reference clip of the latest scan (the server plays only files inside the scanned folders). */
export async function previewRef(file: string): Promise<Blob> {
  const res = await call(`ref-audio?path=${encodeURIComponent(file)}`);
  if (!res.ok) throw await failure(res);
  return res.blob();
}
export async function requestMatch(characters: MatchCharacter[], sovitsRoot: string, refDirs: string[]): Promise<MatchResult> {
  const res = await call('match', json('POST', { characters, sovitsRoot, refDirs }));
  if (!res.ok) throw await failure(res);
  return (await res.json()) as MatchResult;
}
