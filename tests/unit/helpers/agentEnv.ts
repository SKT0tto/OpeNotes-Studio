import { clone } from '../../../shared/project/mutate';
import { newStats, runTool, type ToolEnv } from '../../../shared/agent/tools';
import type { Project } from '../../../shared/schema/project';
import { cat, directedProject } from './directorFlow';

/** A tool environment over a copy of the recorded, directed example project (scene s_3 = the long café scene, 28 beats). */
export function makeEnv(project: Project = directedProject(), selection: ToolEnv['selection'] = { sceneId: 's_3' }): ToolEnv {
  return { sandbox: clone(project), catalog: cat, selection, genId: 'agent_t', now: () => 5000, applied: [], pending: [], stats: newStats(), seq: { n: 0 } };
}
export const call = (env: ToolEnv, tool: string, args: unknown): Record<string, unknown> | string => {
  const out = runTool(env, tool, args);
  try {
    return JSON.parse(out) as Record<string, unknown>;
  } catch {
    return out;
  }
};
export const sceneOf = (env: ToolEnv, id = 's_3') => env.sandbox.scenes.find((s) => s.id === id)!;
