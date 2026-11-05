/**
 * Client state of the plugin: its settings (loaded from the server), and the one running voice job.
 * A job runs on the server; this store starts it, polls its progress, and applies the finished lines to the open project as ONE undo step
 * through the studio's `applyBeatVoice` (a cancelled job applies the lines that were done; a line that was not finished keeps the recording it had). The server never writes project.json.
 */
import { useSyncExternalStore } from 'react';
import type { VoiceJobView, VoiceScope, VoiceSettings, VoiceSettingsPatch } from '../schema';
import { cancelVoiceJob, fetchVoiceSettings, getVoiceJob, host, saveVoiceSettings, startVoiceJob } from './api';

export interface ActiveJob {
  id: string | null;
  projectId: string;
  scope: VoiceScope;
  view: VoiceJobView | null;
  /** What the person asked for: a plain generation, a new version of one line, or a new version after retranslating it. */
  mode: 'generate' | 'regenerate' | 'retranslate';
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

export interface RunOptions { retranslate?: boolean; force?: boolean; regenerate?: boolean; overwriteEdited?: boolean; /** Undo-step label (default: by scope). */ label?: string }

/** Plays a version of a line once (a new version is played right away so the person hears it); a new play stops the previous one. */
let playing: HTMLAudioElement | null = null;
export async function playVersion(projectId: string, file: string): Promise<void> {
  const h = host();
  playing?.pause();
  const a = new Audio(h.voice.fileUrl(projectId, file));
  a.volume = h.voice.getVolume();
  playing = a;
  await a.play();
}

/** Runs a job to the end and returns its final state (null when it could not start). */
export async function runJob(scope: VoiceScope, opts: RunOptions = {}): Promise<VoiceJobView | null> {
  const h = host();
  const project = h.getStudio().project;
  if (!project || jobRunning(state.job)) return null;
  const { label: customLabel, ...request } = opts;
  const job: ActiveJob = { id: null, projectId: project.id, scope, view: null, starting: true, mode: opts.regenerate ? (opts.retranslate ? 'retranslate' : 'regenerate') : 'generate' };
  set({ job });
  const label = customLabel ?? (scope.kind === 'beat' ? '生成这一句配音' : scope.kind === 'scene' ? '生成本场景配音' : '生成整个项目配音');
  try {
    job.id = await startVoiceJob(project, scope, request);
    set({ job: { ...job, starting: false } });
    for (;;) {
      await new Promise((r) => setTimeout(r, 600));
      const view = await getVoiceJob(job.id);
      set({ job: { ...job, starting: false, view } });
      if (view.state === 'running') continue;
      const cur = h.getStudio().project;
      const n = cur && cur.id === job.projectId ? h.applyBeatVoice(view.results.map((r) => ({ sceneId: r.sceneId, beatId: r.beatId, voice: r.voice })), label) : 0;
      const fails = view.errors.length;
      const warns = view.warnings.length;
      const made = view.completed;
      if (view.state === 'failed') h.notify(`配音失败：${view.error ?? view.message}${made > 0 ? `（已完成的 ${made} 句保留，可撤销）` : '（原有的配音都没动）'}`, 'warn');
      else if (view.state === 'cancelled') h.notify(made > 0 ? `已取消：已完成 ${made} 句，保留（可撤销）；其余句子保持原样` : '已取消：原有的配音都没动', 'info');
      else {
        const parts = [`配音完成：已完成 ${made} 句${n > 0 ? '（可撤销）' : ''}`];
        if (view.retries > 0) parts.push(`疑似漏字重试 ${view.retries} 次`);
        if (fails > 0) parts.push(`${fails} 句失败：${view.errors[0]!.message}`);
        if (warns > 0) parts.push(`${warns} 句可能没读完，请试听（检查器里有提示）`);
        h.notify(parts.join('；'), fails > 0 || warns > 0 ? 'warn' : 'info');
      }
      set({ job: { ...job, id: null, starting: false, view } });
      return view;
    }
  } catch (e) {
    h.notify(`配音失败：${(e as Error).message}`, 'warn');
    set({ job: null });
    return null;
  }
}

export function cancelJob(): void {
  const id = state.job?.id;
  if (id) void cancelVoiceJob(id);
}
