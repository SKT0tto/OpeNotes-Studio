import { describe, expect, it } from 'vitest';
import { clone } from '../../shared/project/mutate';
import type { Project } from '../../shared/schema/project';
import type { BatchProgress, BreakdownResponse, SceneResponse } from '../../web/directorApi';
import { applyAndSave, runBreakdown, runOneClick, type OneClickApi } from '../../web/editor/dialogs/oneClickRun';
import { answer } from './helpers/fakeDirector';
import { directedProject } from './helpers/directorFlow';

const json = (v: unknown) => JSON.stringify(v);

/** The first run's project: every scene is only broken down (rule skeleton lines that quote the source paragraph). */
function skeletonProject(): Project {
  const p = clone(directedProject());
  for (const s of p.scenes) for (const b of s.beats) { b.meta.source = 'rule'; b.meta.reason = '原文段落 1'; }
  return p;
}

function fakeApi(project: Project, opts: { failScenes?: string[] } = {}) {
  const calls: Array<{ fn: string; args: unknown[] }> = [];
  const api: OneClickApi = {
    postBreakdown: async (...args) => {
      calls.push({ fn: 'postBreakdown', args });
      return { breakdown: {}, project, warnings: [], runs: [], cached: false } as unknown as BreakdownResponse;
    },
    postScenes: async (proj, options, onProgress) => {
      calls.push({ fn: 'postScenes', args: [options] });
      const only = (options as { sceneIds?: string[] }).sceneIds ?? proj.scenes.map((s) => s.id);
      for (const id of only) {
        const title = proj.scenes.find((s) => s.id === id)!.title;
        if (opts.failScenes?.includes(id)) onProgress({ sceneId: id, title, state: 'error', kind: 'timeout', message: '请求超时' } satisfies BatchProgress);
        else onProgress({ sceneId: id, title, state: 'done', result: answer(proj, id) });
      }
      return [];
    },
    createProject: async (p) => { calls.push({ fn: 'createProject', args: [p.id] }); return { project: p, etag: 'e1' }; },
    saveProject: async (p, etag) => { calls.push({ fn: 'saveProject', args: [etag] }); return { project: p, etag: 'e2' }; },
  };
  return { api, calls };
}

const hooks = () => {
  const got = { stages: [] as string[], progress: [] as BatchProgress[], results: [] as SceneResponse[], plan: null as null | string[] };
  return { got, hooks: {
    onStage: (t: string) => got.stages.push(t), onBreakdown: () => undefined, onCreated: () => undefined,
    onPlan: (_p: Project, todo: string[]) => { got.plan = todo; }, onProgress: (p: BatchProgress) => got.progress.push(p), onResult: (r: SceneResponse) => got.results.push(r),
  } };
};

describe('first run: the requests of the dialog are the ones it always made', () => {
  const signal = new AbortController().signal;
  it('先分场看看 / 重新分场: postBreakdown(text, title, refresh, undefined, engine), the title defaulting to 未命名项目', async () => {
    const f = fakeApi(skeletonProject());
    await runBreakdown({ text: '正文', title: ' 我的故事 ', refresh: false, engine: undefined }, f.api);
    await runBreakdown({ text: '正文', title: '', refresh: true, engine: 'rule' }, f.api);
    expect(f.calls.map((c) => json(c.args))).toEqual([
      json(['正文', '我的故事', false, undefined, undefined]),
      json(['正文', '未命名项目', true, undefined, 'rule']),
    ]);
  });
  it('分场并生成全部: breakdown (refresh false, the run\'s signal, the engine) -> create -> postScenes { scopes, sceneIds, engine } for the scenes not directed yet', async () => {
    const p = skeletonProject();
    const f = fakeApi(p);
    const h = hooks();
    const out = await runOneClick({ text: '正文', title: '', engine: 'rule', useMem: true, local: null, retry: new Set(), signal }, h.hooks, f.api);
    expect(out.aborted).toBe(false);
    expect(f.calls.map((c) => c.fn)).toEqual(['postBreakdown', 'createProject', 'postScenes']);
    expect(f.calls[0]!.args[0]).toBe('正文');
    expect(f.calls[0]!.args[1]).toBe('未命名项目');
    expect(f.calls[0]!.args[2]).toBe(false);
    expect(f.calls[0]!.args[3]).toBe(signal);
    expect(f.calls[0]!.args[4]).toBe('rule');
    expect(json(f.calls[2]!.args[0])).toBe(json({ scopes: ['scene'], sceneIds: p.scenes.map((s) => s.id), engine: 'rule' }));
    expect(h.got.results).toHaveLength(p.scenes.length);
  });
  it('AI engine: no engine key; memory off adds useMemories:false (and never together with the rule engine)', async () => {
    const p = skeletonProject();
    const a = fakeApi(p);
    await runOneClick({ text: 't', title: 't', engine: undefined, useMem: true, local: null, retry: new Set(), signal }, hooks().hooks, a.api);
    expect(json(a.calls[2]!.args[0])).toBe(json({ scopes: ['scene'], sceneIds: p.scenes.map((s) => s.id) }));
    const b = fakeApi(p);
    await runOneClick({ text: 't', title: 't', engine: undefined, useMem: false, local: null, retry: new Set(), signal }, hooks().hooks, b.api);
    expect(json(b.calls[2]!.args[0])).toBe(json({ scopes: ['scene'], sceneIds: p.scenes.map((s) => s.id), useMemories: false }));
    const c = fakeApi(p);
    await runOneClick({ text: 't', title: 't', engine: 'rule', useMem: false, local: null, retry: new Set(), signal }, hooks().hooks, c.api);
    expect(json(c.calls[2]!.args[0])).toBe(json({ scopes: ['scene'], sceneIds: p.scenes.map((s) => s.id), engine: 'rule' }));
  });
  it('resume after a cancel or failure: no second breakdown, only the scenes that are not directed (and the failed ones)', async () => {
    const p = clone(directedProject()); // every scene is directed
    const failed = p.scenes[1]!.id;
    const f = fakeApi(p);
    const h = hooks();
    await runOneClick({ text: 't', title: 't', engine: 'rule', useMem: true, local: { project: p, etag: 'e1' }, retry: new Set([failed]), signal }, h.hooks, f.api);
    expect(f.calls.map((c) => c.fn)).toEqual(['postScenes']);
    expect(json(f.calls[0]!.args[0])).toBe(json({ scopes: ['scene'], sceneIds: [failed], engine: 'rule' }));
    expect(h.got.plan).toEqual([failed]);
  });
  it('nothing left to do: no request at all', async () => {
    const p = clone(directedProject());
    const f = fakeApi(p);
    await runOneClick({ text: 't', title: 't', engine: 'rule', useMem: true, local: { project: p, etag: 'e1' }, retry: new Set(), signal }, hooks().hooks, f.api);
    expect(f.calls).toEqual([]);
  });
  it('a cancel while generating is reported as aborted (what finished is kept), any other failure throws', async () => {
    const p = skeletonProject();
    const f = fakeApi(p);
    f.api.postScenes = async () => { throw Object.assign(new Error('aborted'), { name: 'AbortError' }); };
    const out = await runOneClick({ text: 't', title: 't', engine: 'rule', useMem: true, local: null, retry: new Set(), signal }, hooks().hooks, f.api);
    expect(out.aborted).toBe(true);
    f.api.postScenes = async () => { throw new Error('boom'); };
    await expect(runOneClick({ text: 't', title: 't', engine: 'rule', useMem: true, local: null, retry: new Set(), signal }, hooks().hooks, f.api)).rejects.toThrow('boom');
  });
  it('what finished is applied through the lock merge and saved with the project\'s etag', async () => {
    const p = skeletonProject();
    const f = fakeApi(p);
    const results = [answer(p, p.scenes[0]!.id)];
    const saved = await applyAndSave({ project: p, etag: 'e1' }, results, f.api);
    expect(saved.etag).toBe('e2');
    expect(f.calls.at(-1)).toEqual({ fn: 'saveProject', args: ['e1'] });
  });
});
