/**
 * What the 「生成」 actions of the AI panel (the popover's button, the suggestion chip, a typed command) do: resolve the target from the
 * panel's options and the current selection, then call `useDirectorRun.run`. The scene / all-scenes requests are exactly the ones the AI
 * director panel always sent; 「选中的句子」 with several lines of one scene and 「还没生成的场景」 are the only new shapes (same fields).
 */
import { multiIds } from '@shared/agent/selection';
import type { Project } from '@shared/schema/project';
import type { Selection } from '../../../store/projectStore';
import { isDirectedScene, useDirectorRun, type DirectorEnv, type RunOptions } from '../directorRun';

/** The lines the 「选中的句子」 target acts on: the multi-selection when it lies in one scene, else the one selected line. */
export function beatTarget(project: Project, selection: Selection, picked: string[]): { sceneId: string; beatIds: string[] } | null {
  const multi = multiIds(project, picked);
  if (multi.length > 0) {
    const scenes = project.scenes.filter((s) => s.beats.some((b) => multi.includes(b.id)));
    if (scenes.length === 1) return { sceneId: scenes[0]!.id, beatIds: multi };
  }
  const scene = project.scenes.find((s) => s.id === selection.sceneId);
  if (scene && selection.beatId && scene.beats.some((b) => b.id === selection.beatId)) return { sceneId: scene.id, beatIds: [selection.beatId] };
  return null;
}

/** The scenes that are only broken down (no generated line yet). */
export const missingScenes = (project: Project): string[] => project.scenes.filter((s) => !isDirectedScene(s)).map((s) => s.id);

/** Run the generation the popover is set to (the target in `controls`). */
export function startGenerate(project: Project, selection: Selection, picked: string[], env: DirectorEnv, refresh = false): Promise<void> {
  const d = useDirectorRun.getState();
  const { target, onlyBeat } = d.controls;
  const fresh: RunOptions = refresh ? { refresh: true } : {};
  if (target === 'all') return d.run(true, fresh, env);
  if (target === 'missing') {
    const todo = missingScenes(project);
    return todo.length > 0 ? d.run(false, { batchIds: todo, ...fresh }, env) : Promise.resolve();
  }
  if (onlyBeat) {
    const t = beatTarget(project, selection, picked);
    if (t && t.beatIds.length > 1) return d.run(false, { sceneId: t.sceneId, beatIds: t.beatIds, ...fresh }, env);
  }
  return d.run(false, fresh, env);
}
