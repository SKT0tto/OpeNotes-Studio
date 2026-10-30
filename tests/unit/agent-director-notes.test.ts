import { beforeEach, describe, expect, it, vi } from 'vitest';
import { agentHistory } from '../../shared/agent/history';
import { clone } from '../../shared/project/mutate';
import type { Project } from '../../shared/schema/project';
import type { AgentProposal, TurnBody } from '../../web/agentApi';
import { DEFAULT_CONTROLS, useDirectorRun } from '../../web/editor/panels/directorRun';
import { generateEntry, skeletonEntry, breakdownEntry } from '../../web/editor/dialogs/oneClickRun';
import { noteAsPastRun, oneClickText } from '../../web/store/agentNotes';
import { useAgent } from '../../web/store/agentStore';
import { nextOrder, useAiFlow } from '../../web/store/aiFlow';
import { useProject } from '../../web/store/projectStore';
import { directedProject } from './helpers/directorFlow';
import { env, fakeApi } from './helpers/fakeDirector';

vi.mock('../../web/agentFrames', () => ({ hasFrameGrabber: () => false }));
const turns: TurnBody[] = [];
vi.mock('../../web/agentApi', async (orig) => {
  const real = await orig<typeof import('../../web/agentApi')>();
  const zero = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
  return {
    ...real,
    postSnapshot: async () => undefined,
    postAgentTurn: async (body: TurnBody): Promise<AgentProposal> => {
      turns.push(structuredClone(body));
      return { genId: 'g', summary: `已处理：${body.instruction}`, applied: [], pending: [], question: null, unverified: [], claimedWithoutOps: null, usage: zero, regenUsage: zero, steps: 1, mode: 'tools', stats: {}, stopped: 'done', elapsedMs: 1, trace: [] } as unknown as AgentProposal;
    },
  };
});

describe('what the AI did outside the assistant is told as plain history', () => {
  it('the one-click generation says how many scenes there are, how many were made and what is left', () => {
    expect(oneClickText({ who: 'AI', done: 4, total: 4, failed: 0, warnings: 2 })).toBe('一键生成（AI）：整部演出共 4 场，已生成 4 场；连续性提示 2 条');
    expect(oneClickText({ who: 'AI', done: 3, total: 4, failed: 1, warnings: 0 })).toContain('失败 1 场');
    expect(oneClickText({ who: '规则', done: 3, total: 4, failed: 0, warnings: 0 })).toContain('还有 1 场没生成');
  });
  it('a note is an ordinary user / assistant pair of the history format, with no changes and nothing to undo', () => {
    const h = agentHistory([noteAsPastRun({ text: 'AI生成了 第2场「x」 · 镜头（已应用到项目，Ctrl+Z 可撤销）' })]);
    expect(h).toHaveLength(2);
    expect(h[0]).toMatchObject({ role: 'user' });
    expect(h[0]!.content).toContain('第2场');
    expect(h[0]!.content.startsWith('【AI 生成】')).toBe(true);
    expect(h[0]!.content).not.toMatch(/导演|助手/);
    expect(h[1]).toMatchObject({ role: 'assistant' });
    expect(h[1]!.revert).toBeUndefined();
    expect(h[1]!.content).not.toContain('这一轮的改动');
  });
});

describe('the assistant is told what generation did, as it is now', () => {
  let project: Project;
  const history = (n: number) => turns[n]!.history;
  beforeEach(() => {
    turns.length = 0;
    project = directedProject();
    useProject.getState().open(clone(project), null);
    useProject.getState().select({ sceneId: project.scenes[1]!.id, beatId: null });
    useDirectorRun.getState().unbind();
    useDirectorRun.setState({ controls: { ...DEFAULT_CONTROLS } });
    useAgent.getState().bindProject(null);
    useAgent.getState().bindProject(project.id);
    useAiFlow.getState().unbind();
    useAiFlow.getState().bind(project.id);
  });

  it('an applied generation turn is in the next instruction\'s history, before the turns that came after it', async () => {
    const { api } = fakeApi();
    await useDirectorRun.getState().run(false, {}, env, api);
    useDirectorRun.getState().accept(useDirectorRun.getState().turns[0]!.id, project.scenes[1]!.id, true);
    await useAgent.getState().send('刚生成的第二场节奏慢一点');
    const h1 = history(0);
    expect(h1).toHaveLength(2);
    expect(h1[0]!.content).toContain(`第2场「${project.scenes[1]!.title}」`);
    expect(h1[0]!.content).toContain('已应用到项目');
    await useAgent.getState().send('再慢一点');
    const h2 = history(1);
    expect(h2.map((x) => x.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(h2[2]!.content.startsWith('刚生成的第二场节奏慢一点')).toBe(true);
  });
  it('a pending result is told as not applied yet; after Ctrl+Z an applied one is told as undone', async () => {
    const { api } = fakeApi();
    await useDirectorRun.getState().run(false, {}, env, api);
    await useAgent.getState().send('这一场怎么样');
    expect(history(0)[0]!.content).toContain('尚未应用');
    const t = useDirectorRun.getState().turns[0]!;
    useDirectorRun.getState().accept(t.id, project.scenes[1]!.id, true);
    await useAgent.getState().send('好');
    expect(history(1)[0]!.content).toContain('已应用到项目');
    useProject.getState().undo(); // Ctrl+Z
    await useAgent.getState().send('嗯');
    const h = history(2);
    expect(h[0]!.content).toContain('已撤销');
    expect(h[0]!.content).not.toContain('已应用到项目');
  });
  it('a generation made after an assistant turn follows it, by order', async () => {
    await useAgent.getState().send('这句推近');
    const { api } = fakeApi();
    await useDirectorRun.getState().run(false, {}, env, api);
    await useAgent.getState().send('好');
    const h = history(1);
    expect(h[0]!.content.startsWith('这句推近')).toBe(true);
    expect(h[2]!.content).toContain('尚未应用');
  });
  it('with nothing generated the history is exactly the old one (no extra turns)', async () => {
    await useAgent.getState().send('这句推近');
    expect(history(0)).toEqual([]);
    await useAgent.getState().send('再近');
    expect(history(1).map((x) => x.role)).toEqual(['user', 'assistant']);
    expect(history(1)[0]!.content.startsWith('这句推近')).toBe(true);
  });
  it('the first-run dialog\'s cards are handed over by project id: nothing before the project opens, delivered once, in order, and the panel is asked to come forward', async () => {
    const a = breakdownEntry({ who: '规则', userText: '分场并生成整部演出', scenes: ['a', 'b'], cast: 3, warnings: 0 });
    const b = generateEntry({ who: '规则', done: 2, total: 2, failed: 0, warnings: 1, notes: ['连续性：x'] });
    useAiFlow.getState().queue('p_new', [a, b]);
    expect(useAiFlow.getState().entries).toEqual([]);
    useAiFlow.getState().bind('p_new');
    expect(useAiFlow.getState().entries.map((e) => e.kind)).toEqual(['breakdown', 'generate']);
    expect(useAiFlow.getState().reveal).toBe(true);
    expect(a.order).toBeLessThan(b.order);
    // strict mode: unbound and bound again in the same tick, the cards are still there
    useAiFlow.getState().unbind();
    useAiFlow.getState().bind('p_new');
    expect(useAiFlow.getState().entries).toHaveLength(2);
    await new Promise((r) => setTimeout(r, 5));
    useAiFlow.getState().bind(project.id);
    useAiFlow.getState().bind('p_new');
    expect(useAiFlow.getState().entries).toEqual([]); // delivered once
    expect(useAiFlow.getState().reveal).toBe(false);
  });
  it('the handed-over cards are in the assistant\'s history (what the dialog did), then later turns', async () => {
    useAiFlow.getState().queue('p_h', [breakdownEntry({ who: 'AI', userText: '先分场看看', scenes: ['a', 'b', 'c'], cast: 2, warnings: 0 }), skeletonEntry({ who: 'AI', scenes: 3 })]);
    useProject.getState().open(clone({ ...project, id: 'p_h' }), null);
    useAgent.getState().bindProject('p_h');
    useAiFlow.getState().bind('p_h');
    await useAgent.getState().send('把第一场改一下');
    const h = history(0);
    expect(h).toHaveLength(4);
    expect(h[0]!.content).toContain('分场');
    expect(h[2]!.content).toContain('已建 3 场骨架');
    expect(h.map((x) => x.content).join('\n')).not.toMatch(/导演|助手/);
  });
  it('the review path leaves a skeleton card with the 「生成全部场景」 action', () => {
    const e = skeletonEntry({ who: '规则', scenes: 5 });
    expect(e.canGenerateAll).toBe(true);
    expect(e.title).toContain('5 场骨架');
    expect(e.summary).toContain('还没生成演出');
  });
  it('the stream order is one counter: runs, turns and entries never share a position', () => {
    const a = nextOrder();
    const b = nextOrder();
    expect(b).toBeGreaterThan(a);
  });
  it('the draft, the pictures and the memory view live in the store (a hidden panel keeps them); another project starts empty', () => {
    useAgent.getState().setDraft('第二场再');
    useAgent.getState().setAttachments([{ dataUrl: 'data:image/png;base64,AA', label: 'a' }]);
    useAgent.getState().setMemoryView(true);
    expect(useAgent.getState().draft).toBe('第二场再');
    expect(useAgent.getState().attachments).toHaveLength(1);
    expect(useAgent.getState().memoryView).toBe(true);
    useAgent.getState().bindProject('p_other');
    expect(useAgent.getState().draft).toBe('');
    expect(useAgent.getState().attachments).toEqual([]);
    expect(useAgent.getState().memoryView).toBe(false);
  });
});
