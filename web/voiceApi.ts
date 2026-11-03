import type { Project } from '@shared/schema/project';
import type { VoiceJobView, VoiceScope, VoiceSettings, VoiceSettingsPatch } from '@shared/schema/voice';

async function failure(res: Response): Promise<Error> {
  const body = (await res.json().catch(() => null)) as { error?: string } | null;
  return new Error(body?.error ?? `HTTP ${res.status}`);
}
const json = (method: string, body: unknown): RequestInit => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

export async function fetchVoiceSettings(): Promise<VoiceSettings> {
  const res = await fetch('/api/voice/settings');
  if (!res.ok) throw await failure(res);
  return (await res.json()) as VoiceSettings;
}
export async function saveVoiceSettings(patch: VoiceSettingsPatch): Promise<VoiceSettings> {
  const res = await fetch('/api/voice/settings', json('PUT', patch));
  if (!res.ok) throw await failure(res);
  return (await res.json()) as VoiceSettings;
}
export async function testVoiceConnection(endpoint: string): Promise<{ ok: boolean; message: string }> {
  const res = await fetch('/api/voice/test', json('POST', { endpoint }));
  if (!res.ok) throw await failure(res);
  return (await res.json()) as { ok: boolean; message: string };
}
/** A short test sentence in one character's voice (the profile must be saved first). */
export async function previewVoice(characterKey: string, text?: string): Promise<Blob> {
  const res = await fetch('/api/voice/preview', json('POST', { characterKey, ...(text ? { text } : {}) }));
  if (!res.ok) throw await failure(res);
  return res.blob();
}
export async function startVoiceJob(project: Project, scope: VoiceScope, opts: { retranslate?: boolean; force?: boolean } = {}): Promise<string> {
  const res = await fetch('/api/voice/jobs', json('POST', { project, scope, ...opts }));
  if (!res.ok) throw await failure(res);
  return ((await res.json()) as { id: string }).id;
}
export async function getVoiceJob(id: string): Promise<VoiceJobView> {
  const res = await fetch(`/api/voice/jobs/${encodeURIComponent(id)}`);
  if (!res.ok) throw await failure(res);
  return (await res.json()) as VoiceJobView;
}
export async function cancelVoiceJob(id: string): Promise<void> {
  await fetch(`/api/voice/jobs/${encodeURIComponent(id)}/cancel`, { method: 'POST' });
}
export const voiceFileUrl = (projectId: string, file: string) => `/api/projects/${encodeURIComponent(projectId)}/voice/${encodeURIComponent(file)}`;
