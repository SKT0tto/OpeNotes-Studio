import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clone } from '../../shared/project/mutate';
import type { Project } from '../../shared/schema/project';
import { postScene } from '../../web/directorApi';
import { DEFAULT_CONTROLS, isDirectedScene, useDirectorRun, usesRule, whoLabel, type RunOptions } from '../../web/editor/panels/directorRun';
import { shownState, turnHistoryText, turnState, undoableStep } from '../../web/editor/panels/ai/genTurn';
import { beatTarget, missingScenes } from '../../web/editor/panels/ai/generateActions';
import { useAgent } from '../../web/store/agentStore';
import { stepIsLive, useProject } from '../../web/store/projectStore';
import { directedProject } from './helpers/directorFlow';
import { answer, env, fakeApi } from './helpers/fakeDirector';

// the assistant store reaches the editor stage's frame grabber, which registers itself on `window`: not needed here
vi.mock('../../web/agentFrames', () => ({ hasFrameGrabber: () => false }));

const json = (v: unknown) => JSON.stringify(v);
const last = () => useDirectorRun.getState().turns.at(-1)!;
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
    // no AI configured: the rule generator, whatever the select says
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

/** The request main's AiPanel built (web/editor/panels/AiPanel.tsx on main, lines 184-227), written out independently of the store. */
function mainRequest(p: { all: boolean; scope: string; beatIds?: string[]; overwrite: boolean; useRule: boolean; useMem: boolean }): unknown {
  const eng = p.useRule ? { engine: 'rule' } : p.useMem ? {} : { useMemories: false };
  if (p.all) return { scopes: ['scene'], overwriteUser: p.overwrite, ...eng };
  return { scopes: [p.scope], ...(p.beatIds ? { beatIds: p.beatIds } : {}), overwriteUser: p.overwrite, ...eng };
}

describe('every option combination sends exactly what main sent', () => {
  const bools = [false, true];
  it('postScene / postScenes parameters (JSON) for target x scope x only-line x overwrite x engine x configured x memory x preview', async () => {
    const beatId = project.scenes[1]!.beats[2]!.id;
    let n = 0;
    for (const all of bools) for (const scope of ['scene', 'camera', 'fx'] as const) for (const onlyBeat of bools) for (const overwrite of bools)
      for (const engine of ['ai', 'rule'] as const) for (const configured of bools) for (const useMem of bools) for (const preview of bools) {
        const f = fakeApi();
        useDirectorRun.getState().unbind();
        useDirectorRun.getState().setControls({ scope, onlyBeat, overwriteUser: overwrite, engine, useMem, preview });
        await useDirectorRun.getState().run(all, {}, { ...env, configured }, f.api);
        const want = mainRequest({ all, scope, ...(onlyBeat && !all ? { beatIds: [beatId] } : {}), overwrite, useRule: engine === 'rule' || !configured, useMem });
        const got = all ? f.batches[0] : f.calls[0]!.options;
        expect(json(got)).toBe(json(want));
        n++;
      }
    expect(n).toBe(2 * 3 * 2 * 2 * 2 * 2 * 2 * 2);
  });
  it('「换一版」 is the same request plus refresh:true as its last key, for one scene, all scenes, several scenes', async () => {
    const f = fakeApi();
    await useDirectorRun.getState().run(false, { refresh: true }, env, f.api);
    expect(json(f.calls[0]!.options)).toBe('{"scopes":["scene"],"overwriteUser":false,"refresh":true}');
    await useDirectorRun.getState().run(true, { refresh: true }, env, f.api);
    expect(json(f.batches[0])).toBe('{"scopes":["scene"],"overwriteUser":false,"refresh":true}');
    await useDirectorRun.getState().run(false, { sceneIds: [project.scenes[0]!.id], refresh: true }, env, f.api);
    expect(json(f.calls[1]!.options)).toBe('{"scopes":["scene"],"overwriteUser":false,"refresh":true}');
  });
  it('the plain re-run stays cache-friendly (no refresh key)', async () => {
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
  it("a card's 换一版 repeats its own request (same target, scope, engine) with refresh", async () => {
    const f = fakeApi();
    useDirectorRun.getState().setControls({ scope: 'camera' });
    await useDirectorRun.getState().run(false, {}, env, f.api);
    const turn = last();
    await useDirectorRun.getState().run(turn.all, { ...turn.request, refresh: true }, env, f.api);
    expect(f.calls.map((c) => json(c.options))).toEqual(['{"scopes":["camera"],"overwriteUser":false}', '{"scopes":["camera"],"overwriteUser":false,"refresh":true}']);
    expect(f.calls[1]!.sceneId).toBe(project.scenes[1]!.id);
  });
});

describe('「还没生成的场景」 and 「选中的句子」 (several lines)', () => {
  it('missing scenes: only the scenes that are not directed, in one batch request with sceneIds', async () => {
    const p = clone(project);
    // scene 0 and 2 are only broken down (rule skeleton lines quoting the source paragraph)
    for (const i of [0, 2]) for (const b of p.scenes[i]!.beats) { b.meta.source = 'rule'; b.meta.reason = '原文段落 1'; }
    useProject.getState().open(p, null);
    const want = [p.scenes[0]!.id, p.scenes[2]!.id];
    expect(missingScenes(p)).toEqual(want);
    expect(isDirectedScene(p.scenes[1]!)).toBe(true);
    const f = fakeApi();
    await useDirectorRun.getState().run(false, { batchIds: want }, env, f.api);
    expect(json(f.batches[0])).toBe(`{"scopes":["scene"],"sceneIds":${json(want)},"overwriteUser":false}`);
    expect(last().sceneIds).toEqual(want);
    expect(Object.keys(last().cards)).toEqual(want);
  });
  it('several lines of one scene go as beatIds of that scene; lines of two scenes fall back to the one selected line', () => {
    const s = project.scenes[1]!;
    const ids = [s.beats[0]!.id, s.beats[1]!.id, s.beats[3]!.id];
    expect(beatTarget(project, useProject.getState().selection, ids)).toEqual({ sceneId: s.id, beatIds: ids });
    const mixed = [s.beats[0]!.id, project.scenes[2]!.beats[0]!.id];
    expect(beatTarget(project, useProject.getState().selection, mixed)).toEqual({ sceneId: s.id, beatIds: [s.beats[2]!.id] });
  });
});

describe('the run state is in the store: it survives the panel going away', () => {
  it('a result that arrives while no panel is mounted is still there afterwards, unaccepted and not applied', async () => {
    let open!: () => void;
    const gate = new Promise<void>((r) => { open = r; });
    const { api } = fakeApi(gate);
    const running = useDirectorRun.getState().run(false, {}, env, api);
    expect(useDirectorRun.getState().busy).toBe(true);
    expect(last().status).toBe('running'); // the turn (the 「你」 bubble and the card) exists from the first moment
    expect(last().userText).toContain('第2场');
    // (the panel unmounts here: nothing of the run lives in it)
    open();
    await running;
    const s = useDirectorRun.getState();
    expect(s.busy).toBe(false);
    const turn = last();
    expect(turn.status).toBe('done');
    const card = turn.cards[project.scenes[1]!.id]!;
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
    expect(Object.keys(last().cards)).toEqual([]);
    expect(last().status).toBe('cancelled');
    expect(last().log.at(-1)!.text).toBe('已取消');
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
    expect(s.turns).toEqual([]);
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
  it('turns accumulate in the order they happened (one stream), each with its own cards', async () => {
    const { api } = fakeApi();
    await useDirectorRun.getState().run(false, {}, env, api);
    await useDirectorRun.getState().run(true, {}, env, api);
    const t = useDirectorRun.getState().turns;
    expect(t).toHaveLength(2);
    expect(t[0]!.order).toBeLessThan(t[1]!.order);
    expect(Object.keys(t[0]!.cards)).toHaveLength(1);
    // the cards of an all-scenes turn are in scene order whatever order the answers came in
    expect(Object.keys(t[1]!.cards)).toEqual(project.scenes.map((s) => s.id));
  });
});

describe('accepting', () => {
  it('applies the scene through the lock-merge as one undo step, and rejecting applies nothing', async () => {
    const { api } = fakeApi();
    const id = project.scenes[1]!.id;
    await useDirectorRun.getState().run(false, {}, env, api);
    useDirectorRun.getState().reject(last().id, id);
    expect(last().cards[id]!.state).toBe('rejected');
    expect(useProject.getState().project).toEqual(project);
    await useDirectorRun.getState().run(false, {}, env, api);
    useDirectorRun.getState().accept(last().id, id, true);
    expect(last().cards[id]!.state).toBe('accepted');
    const after = useProject.getState().project!;
    expect(after.scenes[1]!.beats[0]!.shot.type).not.toBe(project.scenes[1]!.beats[0]!.shot.type);
    expect(useProject.getState().undoLabel).toContain('应用');
    useProject.getState().undo();
    expect(useProject.getState().project!.scenes[1]!.beats[0]!.shot.type).toBe(project.scenes[1]!.beats[0]!.shot.type);
    expect(useProject.getState().canUndo).toBe(false); // exactly one step
  });
  it('without a preview the result is applied straight away, still one undo step', async () => {
    const { api } = fakeApi();
    useDirectorRun.getState().setControls({ preview: false });
    await useDirectorRun.getState().run(false, {}, env, api);
    expect(last().cards[project.scenes[1]!.id]!.state).toBe('accepted');
    useProject.getState().undo();
    expect(useProject.getState().canUndo).toBe(false);
  });
  it('accepting several scenes at once is one undo step', async () => {
    const { api } = fakeApi();
    await useDirectorRun.getState().run(true, {}, env, api);
    useDirectorRun.getState().acceptAll(last().id);
    expect(last().steps).toHaveLength(1);
    expect(last().steps[0]!.sceneIds).toHaveLength(project.scenes.length);
    useProject.getState().undo();
    expect(useProject.getState().canUndo).toBe(false);
  });
  it('a partial accept (only the ticked scopes) goes through the same lock merge, as one step', async () => {
    const { api } = fakeApi();
    const id = project.scenes[1]!.id;
    await useDirectorRun.getState().run(false, {}, env, api);
    const card = last().cards[id]!;
    expect(card.checked).toContain('camera');
    useDirectorRun.getState().accept(last().id, id, false);
    expect(last().cards[id]!.state).toBe('accepted');
    expect(last().steps).toHaveLength(1);
  });
});

describe('「已撤销」: the card state and what the assistant is told follow the undo stack', () => {
  const ref = (sid: string) => { const i = project.scenes.findIndex((s) => s.id === sid); return i < 0 ? null : { no: i + 1, title: project.scenes[i]!.title }; };
  it('Ctrl+Z after applying: the card reads 已撤销, the step is gone, the history line says so', async () => {
    const { api } = fakeApi();
    const id = project.scenes[1]!.id;
    await useDirectorRun.getState().run(false, {}, env, api);
    useDirectorRun.getState().accept(last().id, id, true);
    expect(turnState(last(), stepIsLive)).toBe('applied');
    expect(shownState(last().cards[id]!, stepIsLive)).toBe('accepted');
    expect(turnHistoryText(last(), ref, stepIsLive)).toContain('已应用到项目');
    expect(undoableStep(last(), useProject.getState().undoId)).not.toBeNull();
    useProject.getState().undo(); // Ctrl+Z
    expect(turnState(last(), stepIsLive)).toBe('undone');
    expect(shownState(last().cards[id]!, stepIsLive)).toBe('undone');
    expect(turnHistoryText(last(), ref, stepIsLive)).toContain('已撤销');
    expect(turnHistoryText(last(), ref, stepIsLive)).not.toContain('已应用到项目');
    expect(undoableStep(last(), useProject.getState().undoId)).toBeNull();
    useProject.getState().redo(); // and back
    expect(turnState(last(), stepIsLive)).toBe('applied');
  });
  it('the 「撤销这次」 button undoes the newest application only while it is the top of the undo stack', async () => {
    const { api } = fakeApi();
    const id = project.scenes[1]!.id;
    await useDirectorRun.getState().run(false, {}, env, api);
    const turnId = last().id;
    useDirectorRun.getState().accept(turnId, id, true);
    // another edit on top: the card cannot undo it blindly
    useProject.getState().applyEdit((d) => { d.title = 'x'; }, '改标题');
    useDirectorRun.getState().undo(turnId);
    expect(turnState(last(), stepIsLive)).toBe('applied');
    useProject.getState().undo();
    useDirectorRun.getState().undo(turnId);
    expect(turnState(last(), stepIsLive)).toBe('undone');
    expect(useProject.getState().canUndo).toBe(false);
  });
  it('history lines: pending, partly applied, then undone', async () => {
    const { api } = fakeApi();
    await useDirectorRun.getState().run(true, {}, env, api);
    const turn = last();
    expect(turnHistoryText(turn, ref, stepIsLive)).toContain('尚未应用');
    useDirectorRun.getState().accept(turn.id, project.scenes[0]!.id, true);
    expect(turnHistoryText(last(), ref, stepIsLive)).toContain('部分应用');
    useProject.getState().undo();
    expect(turnHistoryText(last(), ref, stepIsLive)).toContain('部分应用');
    useDirectorRun.getState().rejectAll(turn.id);
    useDirectorRun.getState().acceptAll(turn.id);
    expect(turnState(last(), stepIsLive)).toBe('partial');
  });
  it('a rejected turn reads 已拒绝 in the history', async () => {
    const { api } = fakeApi();
    await useDirectorRun.getState().run(false, {}, env, api);
    useDirectorRun.getState().reject(last().id, project.scenes[1]!.id);
    expect(turnHistoryText(last(), ref, stepIsLive)).toContain('用户拒绝了');
  });
  it('a running or cancelled turn is not in the history', async () => {
    const gate = new Promise<void>(() => {});
    const { api } = fakeApi(gate);
    const running = useDirectorRun.getState().run(false, {}, env, api);
    expect(turnHistoryText(last(), () => null, stepIsLive)).toBeNull();
    useDirectorRun.getState().cancel();
    await running;
    expect(turnHistoryText(last(), () => null, stepIsLive)).toBeNull();
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

describe('a typed command routed to generation', () => {
  it('keeps the typed words as the bubble, and discarding the turn removes it (and stops it when it is running)', async () => {
    const gate = new Promise<void>(() => {});
    const { api } = fakeApi(gate);
    const opts: RunOptions = { userText: '重新生成这一场' };
    const running = useDirectorRun.getState().run(false, opts, env, api);
    expect(last().routed).toBe('重新生成这一场');
    expect(last().userText).toBe('重新生成这一场');
    useDirectorRun.getState().discard(last().id);
    await running;
    expect(useDirectorRun.getState().turns).toEqual([]);
    expect(useDirectorRun.getState().busy).toBe(false);
  });
});
