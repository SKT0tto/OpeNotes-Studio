import { beforeEach, describe, expect, it, vi } from 'vitest';
import { agentHistory } from '../../shared/agent/history';
import { clone } from '../../shared/project/mutate';
import type { Project } from '../../shared/schema/project';
import type { AgentProposal, TurnBody } from '../../web/agentApi';
import { appendNote, directorAcceptText, interleave, MAX_NOTES, noteAsPastRun, oneClickText, type DirectorNote } from '../../web/store/agentNotes';
import { useAgent } from '../../web/store/agentStore';
import { useProject } from '../../web/store/projectStore';
import { directedProject } from './helpers/directorFlow';

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

describe('director notes: pure helpers', () => {
  it('an accepted result reads as one short line: scene, scope, who, how to undo', () => {
    const t = directorAcceptText({ who: 'AI', scenes: [{ no: 2, title: '放学后' }], scopes: ['镜头'] });
    expect(t).toBe('接受了 第2场「放学后」 · 镜头（AI生成，已应用到项目，Ctrl+Z 可撤销）');
    expect(directorAcceptText({ who: '规则', scenes: [{ no: 1, title: 'a' }], scopes: ['整个场景'], partial: true })).toContain('只接受了部分范围');
    expect(directorAcceptText({ who: 'AI', scenes: [{ no: 1, title: 'a' }], scopes: ['镜头'], onlyBeats: 1 })).toContain('只有选中的 1 句');
    const many = directorAcceptText({ who: 'AI', scenes: Array.from({ length: 9 }, (_, i) => ({ no: i + 1, title: `s${i + 1}` })), scopes: ['整个场景'] });
    expect(many).toContain('等 9 场');
    expect(many).not.toContain('第9场');
  });
  it('the one-click generation says how many scenes there are, how many were made and what is left', () => {
    expect(oneClickText({ who: 'AI', done: 4, total: 4, failed: 0, warnings: 2 })).toBe('一键生成（AI）：整部演出共 4 场，已生成 4 场；连续性提示 2 条');
    expect(oneClickText({ who: 'AI', done: 3, total: 4, failed: 1, warnings: 0 })).toContain('失败 1 场');
    expect(oneClickText({ who: '规则', done: 3, total: 4, failed: 0, warnings: 0 })).toContain('还有 1 场没生成');
  });
  it('a note is an ordinary user / assistant pair of the history format, with no changes and nothing to undo', () => {
    const h = agentHistory([noteAsPastRun({ text: '接受了 第2场「x」 · 镜头（AI生成，已应用到项目，Ctrl+Z 可撤销）' })]);
    expect(h).toHaveLength(2);
    expect(h[0]).toMatchObject({ role: 'user' });
    expect(h[0]!.content).toContain('第2场');
    expect(h[0]!.content.startsWith('【AI 导演】接受了')).toBe(true);
    expect(h[1]).toMatchObject({ role: 'assistant' });
    expect(h[1]!.revert).toBeUndefined();
    expect(h[1]!.content).not.toContain('这一轮的改动');
  });
  it('notes made without an assistant run in between are one entry; a run in between starts a new one; old ones fall away', () => {
    let n: DirectorNote[] = [];
    n = appendNote(n, 'a', 0, 1, 10);
    n = appendNote(n, 'b', 0, 2, 11);
    expect(n).toHaveLength(1);
    expect(n[0]!.text).toBe('a\nb');
    n = appendNote(n, 'c', 1, 3, 12);
    expect(n.map((x) => x.text)).toEqual(['a\nb', 'c']);
    for (let i = 0; i < 20; i++) n = appendNote(n, `x${i}`, 5 + i, 10 + i, 20 + i);
    expect(n.length).toBeLessThanOrEqual(MAX_NOTES);
    const crowded = Array.from({ length: 20 }, (_, i) => `l${i}`).reduce((acc, t) => appendNote(acc, t, 99, 1, 1), [] as DirectorNote[]);
    expect(crowded[0]!.text.split('\n').length).toBeLessThanOrEqual(MAX_NOTES);
  });
  it('a note sits right after the run it followed', () => {
    const rows = interleave([{ id: 1 }, { id: 2 }, { id: 3 }], [{ id: 1, after: 2, text: 'n', at: 0 }, { id: 2, after: 0, text: 'first', at: 0 }]);
    expect(rows.map((r) => (r.note ? `note:${r.note.text}` : `run:${r.run!.id}`))).toEqual(['note:first', 'run:1', 'run:2', 'note:n', 'run:3']);
  });
});

describe('the assistant is told what the director did', () => {
  let project: Project;
  beforeEach(() => {
    turns.length = 0;
    project = directedProject();
    useProject.getState().open(clone(project), null);
    useProject.getState().select({ sceneId: project.scenes[1]!.id, beatId: null });
    useAgent.getState().bindProject(null);
    useAgent.getState().bindProject(project.id);
  });

  it('the next instruction carries the note in its history, before the turns that came after it', async () => {
    useAgent.getState().noteDirector('接受了 第2场「放学后」 · 整个场景（AI生成，已应用到项目，Ctrl+Z 可撤销）');
    await useAgent.getState().send('刚生成的第二场节奏慢一点');
    expect(turns).toHaveLength(1);
    const h1 = turns[0]!.history;
    expect(h1).toHaveLength(2);
    expect(h1[0]!.role).toBe('user');
    expect(h1[0]!.content).toContain('第2场「放学后」');
    expect(h1[1]!.role).toBe('assistant');
    // the second instruction: the note, then the first instruction and its answer
    await useAgent.getState().send('再慢一点');
    const h2 = turns[1]!.history;
    expect(h2.map((x) => x.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(h2[0]!.content).toContain('第2场「放学后」');
    expect(h2[2]!.content.startsWith('刚生成的第二场节奏慢一点')).toBe(true);
  });
  it('a note made after a run follows that run in the history', async () => {
    await useAgent.getState().send('这句推近');
    useAgent.getState().noteDirector('接受了 第1场「a」 · 镜头（AI生成，已应用到项目，Ctrl+Z 可撤销）');
    await useAgent.getState().send('好');
    const h = turns[1]!.history;
    expect(h[0]!.content.startsWith('这句推近')).toBe(true);
    expect(h[2]!.content).toContain('第1场「a」');
  });
  it('with no notes the history is exactly the old one (no extra turns)', async () => {
    await useAgent.getState().send('这句推近');
    expect(turns[0]!.history).toEqual([]);
    await useAgent.getState().send('再近');
    expect(turns[1]!.history.map((x) => x.role)).toEqual(['user', 'assistant']);
    expect(turns[1]!.history[0]!.content.startsWith('这句推近')).toBe(true);
  });
  it('a note for a project that is not open yet (the home dialog) arrives when that project opens, and not before', () => {
    useAgent.getState().queueDirectorNote('p_new', '一键生成（AI）：整部演出共 4 场，已生成 4 场；连续性提示 0 条');
    expect(useAgent.getState().notes).toEqual([]);
    useAgent.getState().bindProject('p_new');
    expect(useAgent.getState().notes).toHaveLength(1);
    expect(useAgent.getState().notes[0]!.text).toContain('一键生成');
    // delivered once
    useAgent.getState().bindProject(project.id);
    useAgent.getState().bindProject('p_new');
    expect(useAgent.getState().notes).toEqual([]);
  });
  it('notes belong to their project: another project starts without them', () => {
    useAgent.getState().noteDirector('x');
    expect(useAgent.getState().notes).toHaveLength(1);
    useAgent.getState().bindProject('p_other');
    expect(useAgent.getState().notes).toEqual([]);
  });
  it('the draft survives (it lives in the store); another project starts empty', () => {
    useAgent.getState().setDraft('第二场再');
    expect(useAgent.getState().draft).toBe('第二场再');
    useAgent.getState().bindProject('p_other');
    expect(useAgent.getState().draft).toBe('');
  });
});
