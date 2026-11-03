/**
 * The GPT-SoVITS voice-over plugin on the client: its settings (loaded from the server), and the one running voice job.
 * A job runs on the server; this store starts it, polls its progress, and applies the finished lines to the open project as ONE undo step
 * (a cancelled job applies the lines that were done). The server never writes project.json.
 */
import { create } from 'zustand';
import type { VoiceJobView, VoiceScope, VoiceSettings, VoiceSettingsPatch } from '@shared/schema/voice';
import { cancelVoiceJob, fetchVoiceSettings, getVoiceJob, saveVoiceSettings, startVoiceJob } from '../voiceApi';
import { useProject } from './projectStore';
import { notify } from './uiStore';

export interface ActiveJob {
  id: string | null;
  projectId: string;
  scope: VoiceScope;
  view: VoiceJobView | null;
  /** The request is on its way (no job id yet). */
  starting: boolean;
}

interface VoiceState {
  settings: VoiceSettings | null;
  loadError: string | null;
  job: ActiveJob | null;
  load(): Promise<VoiceSettings | null>;
  save(patch: VoiceSettingsPatch): Promise<VoiceSettings>;
  run(scope: VoiceScope, opts?: { retranslate?: boolean; force?: boolean }): Promise<void>;
  cancel(): void;
}

/** Writes a finished job's lines into the project (one undo step, locks do not apply to a generated sound). Returns how many beats changed. */
export function applyVoiceResults(view: VoiceJobView, projectId: string, label: string): number {
  const st = useProject.getState();
  if (!st.project || st.project.id !== projectId || view.results.length === 0) return 0;
  const ok = st.applyEdit((d) => {
    for (const r of view.results) {
      const beat = d.scenes.find((s) => s.id === r.sceneId)?.beats.find((b) => b.id === r.beatId);
      if (beat) beat.voice = { ...r.voice };
    }
  }, label, { bypassLocks: true });
  st.seal();
  return ok ? view.results.length : 0;
}

export const useVoice = create<VoiceState>((set, get) => ({
  settings: null,
  loadError: null,
  job: null,

  async load() {
    try {
      const settings = await fetchVoiceSettings();
      set({ settings, loadError: null });
      return settings;
    } catch (e) {
      set({ loadError: (e as Error).message });
      return null;
    }
  },

  async save(patch) {
    const settings = await saveVoiceSettings(patch);
    set({ settings, loadError: null });
    return settings;
  },

  async run(scope, opts = {}) {
    const project = useProject.getState().project;
    if (!project || jobRunning(get().job)) return;
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
        const n = applyVoiceResults(view, job.projectId, label);
        const fails = view.errors.length;
        if (view.state === 'failed') notify(`配音失败：${view.error ?? view.message}`, 'warn');
        else if (view.state === 'cancelled') notify(n > 0 ? `已取消，已完成的 ${n} 句保留（可撤销）` : '已取消', 'info');
        else notify(fails > 0 ? `配音完成，${fails} 句失败：${view.errors[0]!.message}` : `配音完成：${view.total} 句${n > 0 ? '（可撤销）' : ''}`, fails > 0 ? 'warn' : 'info');
        // keep the last view for a moment so the panel can list the failures
        set({ job: { ...job, id: null, starting: false, view } });
        return;
      }
    } catch (e) {
      notify(`配音失败：${(e as Error).message}`, 'warn');
      set({ job: null });
    }
  },

  cancel() {
    const id = get().job?.id;
    if (id) void cancelVoiceJob(id);
  },
}));

/** A job that is starting or running (a finished one stays in the store, id null, so the panel can list its failures). */
export const jobRunning = (j: ActiveJob | null): boolean => !!j && (j.starting || j.id !== null);
