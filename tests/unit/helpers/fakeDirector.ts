import { clone } from '../../../shared/project/mutate';
import type { Project } from '../../../shared/schema/project';
import type { SceneResponse } from '../../../web/directorApi';
import type { DirectorApi, DirectorEnv } from '../../../web/editor/panels/directorRun';

export const env: DirectorEnv = { configured: true, provider: 'openai', catalog: null };
export const zeroUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };

/** The server's answer for one scene: the scene with its first line's shot changed, as a recorded response. */
export function answer(project: Project, sceneId: string, cached = false): SceneResponse {
  const scene = clone(project.scenes.find((s) => s.id === sceneId)!);
  const beat = scene.beats[0]!;
  beat.shot.type = beat.shot.type === 'cu' ? 'ms' : 'cu';
  return {
    sceneId, scene, applied: true, conflicts: [],
    report: { replacedBeats: [], keptBeats: [], replacedTracks: [], keptTracks: [], protectedKept: [] },
    direction: { reason: 'test', beats: [], costumeChanges: [] } as unknown as SceneResponse['direction'],
    warnings: [], cached,
    runs: [{ pass: 'scene', label: 't', provider: 'openai', model: 'm', cached, ms: 5, usage: zeroUsage, repaired: false, warnings: [] }],
  };
}

export interface Call { sceneId: string; options: unknown }
/** A fake director: records the options of every request; `gate` holds the answers back until it is opened. */
export function fakeApi(gate?: Promise<void>) {
  const calls: Call[] = [];
  const batches: unknown[] = [];
  const api: DirectorApi = {
    postScene: async (project, sceneId, options, signal) => {
      calls.push({ sceneId, options });
      if (gate) await Promise.race([gate, new Promise((_, rej) => signal?.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' }))))]);
      if (signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      return answer(project, sceneId);
    },
    postScenes: async (project, options, onProgress) => {
      batches.push(options);
      const only = (options as { sceneIds?: string[] }).sceneIds;
      for (const s of project.scenes) if (!only || only.includes(s.id)) onProgress({ sceneId: s.id, title: s.title, state: 'done', result: answer(project, s.id) });
      return [];
    },
  };
  return { api, calls, batches };
}
