/**
 * Client state of the plugin: its settings (loaded from the server), and the one running voice job.
 * A job runs on the server; this store starts it, polls its progress, and applies the finished lines to the open project as ONE undo step
 * through the studio's `applyBeatVoice` (a cancelled job applies the lines that were done). The server never writes project.json.
 */
import { useSyncExternalStore } from 'react';
import type { VoiceJobView, VoiceScope, VoiceSettings, VoiceSettingsPatch } from '../schema';
import { cancelVoiceJob, fetchVoiceSettings, getVoiceJob, host, saveVoiceSettings, startVoiceJob } from './api';

export interface ActiveJob {
  id: string | null;
  projectId: string;
  scope: VoiceScope;
  view: VoiceJobView | null;
  /** The request is on its way (no job id yet). */
  starting: boolean;
}
export interface VoiceState {
  settings: VoiceSettings | null;
  loadError: string | null;
  job: ActiveJob | null;
}

let state: VoiceState = { settings: null, loadError: null, job: null };
const listeners = new Set<() => void>();
const set = (patch: Partial<VoiceState>) => {
  state = { ...state, ...patch };
  for (const fn of listeners) fn();
};
export const getVoiceState = (): VoiceState => state;
export const useVoice = <T,>(select: (s: VoiceState) => T): T =>
  useSyncExternalStore((fn) => (listeners.add(fn), () => void listeners.delete(fn)), () => select(state));

export const jobRunning = (j: ActiveJob | null): boolean => !!j && (j.starting || j.id !== null);

export async function loadSettings(): Promise<VoiceSettings | null> {
  try {
    const settings = await fetchVoiceSettings();
    set({ settings, loadError: null });
    return settings;
  } catch (e) {
    set({ loadError: (e as Error).message });
    return null;
  }
}

export async function saveSettings(patch: VoiceSettingsPatch): Promise<VoiceSettings> {
  const settings = await saveVoiceSettings(patch);
  set({ settings, loadError: null });
  return settings;
}

export async function runJob(scope: VoiceScope, opts: { retranslate?: boolean; force?: boolean } = {}): Promise<void> {
  const h = host();
  const project = h.getStudio().project;
  if (!project || jobRunning(state.job)) return;
  const job: ActiveJob = { id: null, projectId: project.id, scope, view: null, starting: true };
  set({ job });
  const label = scope.kind === 'beat' ? '生成这一句配音' : scope.kind === 'scene' ? '生成本场景配音' : '生成整个项目配音';
  try {
    job.id = await startVoiceJob(project, scope, opts);
    set({ job: { ...job, starting: false } });
    for (;;) {
      await new Promise((r) => setTimeout(r, 600));
      const view = await getVoiceJob(job.id);
      set({ job: { ...job, starting: false, view } });
      if (view.state === 'running') continue;
      const cur = h.getStudio().project;
      const n = cur && cur.id === job.projectId ? h.applyBeatVoice(view.results.map((r) => ({ sceneId: r.sceneId, beatId: r.beatId, voice: r.voice })), label) : 0;
      const fails = view.errors.length;
      if (view.state === 'failed') h.notify(`配音失败：${view.error ?? view.message}`, 'warn');
      else if (view.state === 'cancelled') h.notify(n > 0 ? `已取消，已完成的 ${n} 句保留（可撤销）` : '已取消', 'info');
      else h.notify(fails > 0 ? `配音完成，${fails} 句失败：${view.errors[0]!.message}` : `配音完成：${view.total} 句${n > 0 ? '（可撤销）' : ''}`, fails > 0 ? 'warn' : 'info');
      set({ job: { ...job, id: null, starting: false, view } });
      return;
    }
  } catch (e) {
    h.notify(`配音失败：${(e as Error).message}`, 'warn');
    set({ job: null });
  }
}

export function cancelJob(): void {
  const id = state.job?.id;
  if (id) void cancelVoiceJob(id);
}
