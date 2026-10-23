/** Applies a click on a beat to the shared beat multi-selection (`ui.cards` + the primary `selection.beatId`); the script list and the storyboard both use it. */
import { beatOrder, clickBeat, multiIds, type PickMods } from '@shared/agent/selection';
import { useProject } from './projectStore';
import { useUi } from './uiStore';

/** Returns true when the click was a plain one (the caller then also seeks the playhead). */
export function pickBeat(sceneId: string, beatId: string, mods: PickMods): boolean {
  const { project, selection } = useProject.getState();
  if (!project) return false;
  const next = clickBeat(beatOrder(project), { ids: useUi.getState().cards, primary: selection.beatId }, beatId, mods);
  const owner = project.scenes.find((s) => s.beats.some((b) => b.id === next.primary))?.id ?? sceneId;
  useProject.getState().select({ sceneId: owner, beatId: next.primary });
  useUi.getState().set({ cards: next.ids });
  return !mods.range && !mods.toggle;
}

export const modsOf = (e: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }): PickMods => ({ toggle: (e.ctrlKey || e.metaKey) && !e.shiftKey, range: e.shiftKey });

/** The multi-selection as the assistant sees it (at least two existing beats, script order), or []. */
export function selectedBeatIds(): string[] {
  const project = useProject.getState().project;
  return project ? multiIds(project, useUi.getState().cards) : [];
}
