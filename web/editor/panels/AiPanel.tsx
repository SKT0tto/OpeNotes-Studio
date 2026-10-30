/**
 * 「AI」: the one AI panel. On top the 「生成」 section (the AI director: regenerate scenes, scope, diff preview, accept / reject, continuity
 * check; collapsible), below it the assistant chat (one instruction = one change card). The two keep their own engines and their own
 * undo steps; they share the panel, the selection, the AI settings and the memory switch, and the assistant is told what the director
 * generated (see `store/agentNotes.ts`).
 */
import { AgentPanel } from './AgentPanel';
import { DirectorSection } from './DirectorSection';
import type { CameraGenerationRequest } from './directorRun';

export function AiPanel({ visible = true, onFocusBeat, cameraRequest = null }: { visible?: boolean; onFocusBeat: (sceneId: string, beatId: string | undefined) => void; cameraRequest?: CameraGenerationRequest | null }) {
  // dockview keeps a panel's React tree alive while its tab is behind another one: nothing is rendered (or recomputed on every edit, like the
  // continuity check) until the tab is in front. What matters survives in the stores: the run, the options, the draft, the notes.
  if (!visible) return null;
  return (
    <div className="ai-merged" data-testid="ai-merged-panel">
      <DirectorSection cameraRequest={cameraRequest} onFocusBeat={onFocusBeat} />
      <AgentPanel onFocusBeat={onFocusBeat} />
    </div>
  );
}
