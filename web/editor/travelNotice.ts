/** When the 「已切换到运镜模式」 notice may open: only right after an explicit switch to travel that leaves scenes without travel direction. */
import { scenesNeedingTravelDirection } from '@shared/director/travelDirection';
import { useProject } from '../store/projectStore';
import { useUi } from '../store/uiStore';

/** Call right after the user's own edit. `sceneId` limits the check to one scene (a per-scene switch); null checks every travel scene. */
export function openTravelNoticeIfNeeded(sceneId: string | null): void {
  const project = useProject.getState().project;
  if (!project) return;
  const needing = scenesNeedingTravelDirection(project).filter((s) => sceneId === null || s.id === sceneId);
  if (needing.length > 0) useUi.getState().set({ travelNotice: { projectId: project.id } });
}
