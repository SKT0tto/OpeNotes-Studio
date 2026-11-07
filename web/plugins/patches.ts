/** The one thing a plugin may write into the project: the `voice` of beats, as a single undo step. */
import type { VoicePatch } from '@shared/plugins/api';
import { useProject } from '../store/projectStore';

export function applyBeatVoice(patches: VoicePatch[], label: string, opts: { coalesce?: string } = {}): number {
  const st = useProject.getState();
  if (!st.project || patches.length === 0) return 0;
  let changed = 0;
  const ok = st.applyEdit((d) => {
    for (const p of patches) {
      const beat = d.scenes.find((s) => s.id === p.sceneId)?.beats.find((b) => b.id === p.beatId);
      if (!beat) continue;
      if (p.voice === null) delete beat.voice;
      else beat.voice = { ...p.voice };
      changed++;
    }
  }, label, { bypassLocks: true, ...(opts.coalesce ? { coalesce: opts.coalesce } : {}) });
  if (!opts.coalesce) st.seal();
  return ok ? changed : 0;
}
