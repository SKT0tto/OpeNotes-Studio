import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clone } from '../../shared/project/mutate';
import type { Project } from '../../shared/schema/project';
import { postScene, type SceneResponse } from '../../web/directorApi';
import { DEFAULT_CONTROLS, useDirectorRun, usesRule, whoLabel, type DirectorApi, type DirectorEnv } from '../../web/editor/panels/directorRun';
import { useAgent } from '../../web/store/agentStore';
import { useProject } from '../../web/store/projectStore';
import { directedProject } from './helpers/directorFlow';

// the assistant store reaches the editor stage's frame grabber, which registers itself on `window`: not needed here
vi.mock('../../web/agentFrames', () => ({ hasFrameGrabber: () => false }));

const env: DirectorEnv = { configured: true, provider: 'openai', catalog: null };
const zeroUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };

/** The server's answer for one scene: the scene with its first line's shot changed, as a recorded response. */
function answer(project: Project, sceneId: string, cached = false): SceneResponse {
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

interface Call { sceneId: string; options: unknown }
/** A fake director: records the options of every request; `gate` holds the answers back until it is opened. */
function fakeApi(gate?: Promise<void>) {
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
      for (const s of project.scenes) onProgress({ sceneId: s.id, title: s.title, state: 'done', result: answer(project, s.id) });
      return [];
    },
  };
  return { api, calls, batches };
}

const json = (v: unknown) => JSON.stringify(v);
let project: Project;
beforeEach(() => {
  project = directedProject();
  useProject.getState().open(clone(project), null);
  useProject.getState().select({ sceneId: project.scenes[1]!.id, beatId: project.scenes[1]!.beats[2]!.id });
  useDirectorRun.getState().unbind();
  useDirectorRun.setState({ controls: { ...DEFAULT_CONTROLS } });
  useAgent.getState().bindProject(null);
  useAgent.getState().bindProject(project.id);
});
afterEach(() => {
  useDirectorRun.getState().unbind();
});

describe('requests are byte-identical to what the AI director panel always sent', () => {
  it('one scene: scopes, overwriteUser, and nothing else (no refresh, no engine, no useMemories)', async () => {
    const { api, calls } = fakeApi();
    await useDirectorRun.getState().run(false, {}, env, api);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.sceneId).toBe(project.scenes[1]!.id);
    expect(json(calls[0]!.options)).toBe('{"scopes":["scene"],"overwriteUser":false}');
  });
  it('a scope, only the selected line, overwrite on: the same keys in the same order', async () => {
    const { api, calls } = fakeApi();
    useDirectorRun.getState().setControls({ scope: 'camera', onlyBeat: true, overwriteUser: true });
    await useDirectorRun.getState().run(false, {}, env, api);
    expect(json(calls[0]!.options)).toBe(`{"scopes":["camera"],"beatIds":["${project.scenes[1]!.beats[2]!.id}"],"overwriteUser":true}`);
  });
  it('memory off adds useMemories:false; the rule engine adds engine:rule (and never useMemories)', async () => {
    const a = fakeApi();
    useDirectorRun.getState().setControls({ useMem: false });
    await useDirectorRun.getState().run(false, {}, env, a.api);
    expect(json(a.calls[0]!.options)).toBe('{"scopes":["scene"],"overwriteUser":false,"useMemories":false}');
    useDirectorRun.getState().unbind();
    const b = fakeApi();
    useDirectorRun.getState().setControls({ engine: 'rule' });
    await useDirectorRun.getState().run(false, {}, env, b.api);
    expect(json(b.calls[0]!.options)).toBe('{"scopes":["scene"],"overwriteUser":false,"engine":"rule"}');
    // no AI configured: the rule director, whatever the select says
    useDirectorRun.getState().unbind();
    const c = fakeApi();
    useDirectorRun.getState().setControls({ engine: 'ai' });
    await useDirectorRun.getState().run(false, {}, { ...env, configured: false }, c.api);
    expect(json(c.calls[0]!.options)).toBe('{"scopes":["scene"],"overwriteUser":false,"engine":"rule"}');
  });
  it('all scenes and several scenes (the camera request) keep their shapes', async () => {
    const a = fakeApi();
    await useDirectorRun.getState().run(true, {}, env, a.api);
    expect(json(a.batches[0])).toBe('{"scopes":["scene"],"overwriteUser":false}');
    useDirectorRun.getState().unbind();
    const b = fakeApi();
    const ids = [project.scenes[0]!.id, project.scenes[2]!.id];
    await useDirectorRun.getState().run(false, { sceneIds: ids, scope: 'camera', preview: true, overwriteUser: false, onlyBeat: false, engine: 'ai' }, env, b.api);
    expect(b.calls.map((x) => x.sceneId)).toEqual(ids);
    for (const x of b.calls) expect(json(x.options)).toBe('{"scopes":["camera"],"overwriteUser":false}');
  });
  it('the bytes on the wire are the old ones: JSON of { project, sceneId, ...options }', async () => {
    const bodies: string[] = [];
    vi.stubGlobal('fetch', async (_url: string, init: { body: string }) => {
      bodies.push(init.body);
      return { ok: true, json: async () => answer(project, project.scenes[1]!.id) };
    });
    try {
      await useDirectorRun.getState().run(false, {}, env, { postScene, postScenes: fakeApi().api.postScenes });
    } finally {
      vi.unstubAllGlobals();
    }
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toBe(JSON.stringify({ project, sceneId: project.scenes[1]!.id, scopes: ['scene'], overwriteUser: false }));
  });
});

describe('「换一版」', () => {
  it('is the only request that carries refresh:true (last key); the plain re-run stays cache-friendly', async () => {
    const { api, calls } = fakeApi();
    await useDirectorRun.getState().run(false, {}, env, api);
    await useDirectorRun.getState().run(false, { refresh: true }, env, api);
    await useDirectorRun.getState().run(false, {}, env, api);
    expect(calls.map((c) => json(c.options))).toEqual([
      '{"scopes":["scene"],"overwriteUser":false}',
      '{"scopes":["scene"],"overwriteUser":false,"refresh":true}',
      '{"scopes":["scene"],"overwriteUser":false}',
    ]);
  });
  it('also reaches the all-scenes and several-scenes requests', async () => {
    const { api, calls, batches } = fakeApi();
    await useDirectorRun.getState().run(true, { refresh: true }, env, api);
    expect(json(batches[0])).toBe('{"scopes":["scene"],"overwriteUser":false,"refresh":true}');
    await useDirectorRun.getState().run(false, { sceneIds: [project.scenes[0]!.id], refresh: true }, env, api);
    expect(json(calls[0]!.options)).toBe('{"scopes":["scene"],"overwriteUser":false,"refresh":true}');
  });
});

describe('the run state is in the store: it survives the panel going away', () => {
  it('a result that arrives while no panel is mounted is still there afterwards, unaccepted and not applied', async () => {
    let open!: () => void;
    const gate = new Promise<void>((r) => { open = r; });
    const { api } = fakeApi(gate);
    const running = useDirectorRun.getState().run(false, {}, env, api);
    expect(useDirectorRun.getState().busy).toBe(true);
    // (the panel unmounts here: nothing of the run lives in it)
    open();
    await running;
    const s = useDirectorRun.getState();
    expect(s.busy).toBe(false);
    const card = s.cards[project.scenes[1]!.id]!;
    expect(card.state).toBe('pending');
    expect(card.diff.items.length).toBeGreaterThan(0);
    expect(useProject.getState().project).toEqual(project); // nothing applied before the person accepts
  });
  it('a second run is refused while one is running', async () => {
    let open!: () => void;
    const gate = new Promise<void>((r) => { open = r; });
    const { api, calls } = fakeApi(gate);
    const first = useDirectorRun.getState().run(false, {}, env, api);
    await useDirectorRun.getState().run(false, {}, env, api);
    expect(calls).toHaveLength(1);
    open();
    await first;
  });
  it('cancel stops the request and keeps nothing half-done', async () => {
    const gate = new Promise<void>(() => {});
    const { api } = fakeApi(gate);
    const running = useDirectorRun.getState().run(false, {}, env, api);
    useDirectorRun.getState().cancel();
    await running;
    const s = useDirectorRun.getState();
    expect(s.busy).toBe(false);
    expect(Object.keys(s.cards)).toEqual([]);
    expect(s.log.at(-1)!.text).toBe('已取消');
  });
  it('leaving the project aborts a running request, and its late answer never reaches the next project', async () => {
    let open!: () => void;
    const gate = new Promise<void>((r) => { open = r; });
    const { api } = fakeApi(gate);
    useDirectorRun.getState().bindProject(project.id);
    const running = useDirectorRun.getState().run(false, {}, env, api);
    expect(useDirectorRun.getState().busy).toBe(true);
    useDirectorRun.getState().bindProject('p_other');
    expect(useDirectorRun.getState().busy).toBe(false);
    open();
    await running;
    const s = useDirectorRun.getState();
    expect(s.cards).toEqual({});
    expect(s.log).toEqual([]);
    expect(s.projectId).toBe('p_other');
  });
  it('the options survive a reset and a hidden panel, but not another project (「覆盖我手改过的内容」 must not carry over)', () => {
    useDirectorRun.getState().bindProject(project.id);
    useDirectorRun.getState().setControls({ scope: 'fx', preview: false, overwriteUser: true });
    useDirectorRun.getState().reset();
    expect(useDirectorRun.getState().controls).toMatchObject({ scope: 'fx', preview: false, overwriteUser: true });
    useDirectorRun.getState().bindProject('p_other');
    expect(useDirectorRun.getState().controls).toEqual(DEFAULT_CONTROLS);
    useDirectorRun.getState().setControls({ overwriteUser: true });
    useDirectorRun.getState().unbind();
    expect(useDirectorRun.getState().controls).toEqual(DEFAULT_CONTROLS);
  });
});

describe('accepting', () => {
  it('applies the scene through the lock-merge as one undo step, and rejecting applies nothing', async () => {
    const { api } = fakeApi();
    const id = project.scenes[1]!.id;
    await useDirectorRun.getState().run(false, {}, env, api);
    useDirectorRun.getState().reject(id);
    expect(useDirectorRun.getState().cards[id]!.state).toBe('rejected');
    expect(useProject.getState().project).toEqual(project);
    await useDirectorRun.getState().run(false, {}, env, api);
    useDirectorRun.getState().accept(id, true);
    expect(useDirectorRun.getState().cards[id]!.state).toBe('accepted');
    const after = useProject.getState().project!;
    expect(after.scenes[1]!.beats[0]!.shot.type).not.toBe(project.scenes[1]!.beats[0]!.shot.type);
    expect(useProject.getState().undoLabel).toContain('接受');
    useProject.getState().undo();
    expect(useProject.getState().project!.scenes[1]!.beats[0]!.shot.type).toBe(project.scenes[1]!.beats[0]!.shot.type);
    expect(useProject.getState().canUndo).toBe(false); // exactly one step
  });
  it('without a preview the result is applied straight away, still one undo step', async () => {
    const { api } = fakeApi();
    useDirectorRun.getState().setControls({ preview: false });
    await useDirectorRun.getState().run(false, {}, env, api);
    expect(useDirectorRun.getState().cards[project.scenes[1]!.id]!.state).toBe('accepted');
    useProject.getState().undo();
    expect(useProject.getState().canUndo).toBe(false);
  });
  it('accepting tells the assistant: a short note with the scene, the scope and who made it', async () => {
    const { api } = fakeApi();
    await useDirectorRun.getState().run(false, { scope: 'camera' }, env, api);
    expect(useAgent.getState().notes).toEqual([]); // a proposal that is only previewed is not news yet
    useDirectorRun.getState().accept(project.scenes[1]!.id, true);
    const notes = useAgent.getState().notes;
    expect(notes).toHaveLength(1);
    expect(notes[0]!.text).toContain(`第2场「${project.scenes[1]!.title}」`);
    expect(notes[0]!.text).toContain('镜头');
    expect(notes[0]!.text).toContain('AI生成');
    expect(notes[0]!.text).toContain('Ctrl+Z');
  });
  it('rejecting adds no note', async () => {
    const { api } = fakeApi();
    await useDirectorRun.getState().run(false, {}, env, api);
    useDirectorRun.getState().reject(project.scenes[1]!.id);
    expect(useAgent.getState().notes).toEqual([]);
  });
  it('accepting several scenes at once is one note naming all of them', async () => {
    const { api } = fakeApi();
    await useDirectorRun.getState().run(true, {}, env, api);
    useDirectorRun.getState().acceptAll();
    const notes = useAgent.getState().notes;
    expect(notes).toHaveLength(1);
    for (let i = 0; i < project.scenes.length; i++) expect(notes[0]!.text).toContain(`第${i + 1}场`);
    useProject.getState().undo();
    expect(useProject.getState().canUndo).toBe(false);
  });
});

describe('who made it', () => {
  it('labels the engine the way the panel always did', () => {
    expect(whoLabel(true, 'openai')).toBe('规则');
    expect(whoLabel(false, 'fixture')).toBe('回放');
    expect(whoLabel(false, 'anthropic')).toBe('AI');
    expect(usesRule('rule', true)).toBe(true);
    expect(usesRule('ai', false)).toBe(true);
    expect(usesRule('ai', true)).toBe(false);
  });
});
