/**
 * State of the AI assistant panel (not part of the project): the conversation, the change cards, the 「实时」 switch, the cost hint and the
 * pre-run snapshot. Applying a card goes through `useProject.applyAgentOps`, which is one `applyEdit` = one undo step.
 */
import { create } from 'zustand';
import type { OpRecord } from '@shared/agent/tools';
import { agentHistory, selectionText } from '@shared/agent/history';
import { liveDecision } from '@shared/agent/live';
import type { AgentOp } from '@shared/agent/ops';
import { revertOps } from '@shared/agent/revert';
import { agentSelection } from '@shared/agent/selection';
import type { ReplayItem, PlannedItem } from '@shared/agent/replay';
import { clone } from '@shared/project/mutate';
import type { Project } from '@shared/schema/project';
import { AgentApiError, postAgentTurn, postSnapshot, type AgentProposal, type AgentStreamEvent, type Usage } from '../agentApi';
import { hasFrameGrabber } from '../agentFrames';
import { useProject } from './projectStore';
import { notify, useUi } from './uiStore';
import { useMemories } from '../memoryApi';
import { appendNote, interleave, noteAsPastRun, type DirectorNote } from './agentNotes';

export interface CardItem {
  id: number;
  record: OpRecord;
  /** applied = the model's sandbox accepted it; pending = it needs the user (lock / hand-made content). */
  origin: 'applied' | 'pending';
  state: 'open' | 'applied' | 'skipped' | 'stale';
  checked: boolean;
  /** Last reason this item could not be applied. */
  reason?: string;
}
export interface RunItem {
  id: number;
  instruction: string;
  sceneId: string | null;
  status: 'running' | 'done' | 'failed' | 'cancelled';
  progress: string[];
  error?: string;
  proposal?: AgentProposal;
  items: CardItem[];
  /** Why the live mode did not apply this run by itself. */
  liveNote?: string;
  /** undo label of the last application of this card (to enable 「撤销这次」 only while it is still the top of the undo stack). */
  appliedLabel?: string;
  rejected?: boolean;
  /** Tokens of this instruction (running while it streams). */
  usage: Usage;
  /** The selection when it was sent, as the assistant's history shows it. */
  selectionText?: string;
  /** The project just before this card was first applied, and the ops that undo what was applied since (「改回去」 in a later turn). */
  preApply?: Project;
  revert?: AgentOp[];
  /** Pictures sent with the instruction (thumbnails for the conversation). */
  attachments?: AgentAttachment[];
  /** What the user did with the memory cards of this run (index into proposal.memory). */
  memoryDone?: Record<number, 'saved' | 'dismissed' | 'removed'>;
}
/** A picture the user attached (a video arrives as a few frames, each its own attachment with the time in its label). */
export interface AgentAttachment {
  dataUrl: string;
  label: string;
}

const zero = (): Usage => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 });
const add = (a: Usage, b: Usage): Usage => ({ inputTokens: a.inputTokens + b.inputTokens, outputTokens: a.outputTokens + b.outputTokens, cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens, cacheCreationTokens: a.cacheCreationTokens + b.cacheCreationTokens });

interface AgentState {
  projectId: string | null;
  runs: RunItem[];
  /** What the AI director did since (accepted results, a one-click generation): sent with the conversation history, shown in the chat. */
  notes: DirectorNote[];
  /** The text being typed (kept here so that switching to another tab of the dock and back does not lose it). */
  draft: string;
  running: boolean;
  live: boolean;
  /** Tokens spent in this session (this project, since the panel was opened). */
  session: Usage;
  /** The project as it was before the first run of this session. */
  snapshot: { project: Project; at: number } | null;
  /** Bumped by Ctrl+K: the input focuses itself. */
  focusTick: number;
  bindProject(id: string | null): void;
  setDraft(text: string): void;
  /** The AI director's result was accepted (or a whole project was generated): the assistant remembers it. */
  noteDirector(text: string): void;
  /** Same for a project that is not open yet (the home dialog's one-click generation); it is delivered when that project is bound. */
  queueDirectorNote(projectId: string, text: string): void;
  setLive(on: boolean): void;
  send(instruction: string, attachments?: AgentAttachment[]): Promise<void>;
  cancel(): void;
  applyItems(runId: number, ids: number[], opts?: { unlock?: boolean; confirm?: boolean }): void;
  toggle(runId: number, itemId: number, checked: boolean): void;
  toggleMany(runId: number, itemIds: number[], checked: boolean): void;
  reject(runId: number): void;
  skip(runId: number, itemId: number): void;
  undoRun(runId: number): void;
  restoreSnapshot(): void;
  focusInput(): void;
  decideMemory(runId: number, index: number, d: 'saved' | 'dismissed' | 'removed'): void;
}

let seq = 0;
let noteSeq = 0;
let ctl: AbortController | null = null;
/** Notes for projects that are not open yet, by project id. */
const queued = new Map<string, string[]>();
const LIVE_KEY = (id: string) => `openotes.agent.live.${id}`;
const readLive = (id: string | null): boolean => {
  if (!id) return false;
  try { return localStorage.getItem(LIVE_KEY(id)) === '1'; } catch { return false; }
};
const writeLive = (id: string | null, on: boolean): void => {
  if (!id) return;
  try { localStorage.setItem(LIVE_KEY(id), on ? '1' : '0'); } catch { /* storage may be blocked */ }
};

const SCOPE_NAME: Record<string, string> = { camera: '镜头', performance: '表演', costume: '服装', staging: '站位', fx: '特效', background: '背景', structure: '台词/场景', rhythm: '节奏', lock: '锁定' };
export const scopeName = (s: string): string => SCOPE_NAME[s] ?? s;

export const useAgent = create<AgentState>((set, get) => {
  const patchRun = (id: number, f: (r: RunItem) => RunItem) => set((s) => ({ runs: s.runs.map((r) => (r.id === id ? f(r) : r)) }));

  const doApply = (runId: number, ids: number[], opts: { unlock?: boolean; confirm?: boolean } = {}): void => {
    const run = get().runs.find((r) => r.id === runId);
    if (!run) return;
    const chosen = run.items.filter((i) => ids.includes(i.id) && (i.state === 'open' || i.state === 'stale'));
    if (chosen.length === 0) return;
    const items: ReplayItem[] = chosen.map((i) => ({ id: i.id, op: i.record.op, unlock: opts.unlock === true, confirm: opts.confirm === true }));
    const label = `AI 助手：${[...run.instruction].slice(0, 16).join('')}`;
    const before = useProject.getState().project;
    const { plan, applied } = useProject.getState().applyAgentOps(items, label, run.proposal?.genId ?? `agent_${runId}`);
    const after = useProject.getState().project;
    // what undoes this card so far: from the project before its first application to now, in the scenes it touches
    const preApply = run.preApply ?? (applied > 0 && before ? clone(before) : undefined);
    const scenes = [...new Set(run.items.map((i) => i.record.op.sceneId))];
    const revert = preApply && after ? revertOps(preApply, after, scenes) : run.revert;
    const byId = new Map<number, PlannedItem>(plan.items.map((p) => [p.id, p]));
    patchRun(runId, (r) => ({
      ...r,
      ...(applied > 0 ? { appliedLabel: label, ...(preApply ? { preApply } : {}), ...(revert ? { revert } : {}) } : {}),
      items: r.items.map((i) => {
        const p = byId.get(i.id);
        if (!p) return i;
        if (p.status === 'ok') return applied > 0 ? { ...i, state: 'applied', checked: false } : i;
        if (p.status === 'stale') return { ...i, state: 'stale', checked: false, reason: p.reason };
        return { ...i, state: 'open', reason: p.reason };
      }),
    }));
    const stale = plan.items.filter((p) => p.status === 'stale').length;
    const asks = plan.items.filter((p) => p.status === 'needs_unlock' || p.status === 'needs_confirm').length;
    if (applied === 0 && (stale > 0 || asks > 0)) notify(asks > 0 ? '有改动需要你先确认（锁定 / 手改内容）' : '这些改动已经失效，没有应用', 'warn');
    else if (stale > 0 || asks > 0) notify(`已应用 ${applied} 项；${stale + asks} 项没有应用`, 'info');
  };

  return {
    projectId: null,
    runs: [],
    notes: [],
    draft: '',
    running: false,
    live: false,
    session: zero(),
    snapshot: null,
    focusTick: 0,

    bindProject(id) {
      if (get().projectId === id) return;
      ctl?.abort();
      const waiting = id ? queued.get(id) ?? [] : [];
      if (id) queued.delete(id);
      const notes = waiting.reduce<DirectorNote[]>((n, text) => appendNote(n, text, seq, ++noteSeq, Date.now()), []);
      set({ projectId: id, runs: [], notes, draft: '', running: false, session: zero(), snapshot: null, live: readLive(id) });
    },

    setDraft(text) {
      set({ draft: text });
    },

    noteDirector(text) {
      const t = text.trim();
      if (!t || !get().projectId) return;
      set((s) => ({ notes: appendNote(s.notes, t, seq, ++noteSeq, Date.now()) }));
    },

    queueDirectorNote(projectId, text) {
      if (!projectId || !text.trim()) return;
      if (get().projectId === projectId) return get().noteDirector(text);
      queued.set(projectId, [...(queued.get(projectId) ?? []), text.trim()].slice(-6));
    },

    setLive(on) {
      writeLive(get().projectId, on);
      set({ live: on });
    },

    decideMemory(runId, index, d) {
      patchRun(runId, (r) => ({ ...r, memoryDone: { ...r.memoryDone, [index]: d } }));
    },

    focusInput() {
      set((s) => ({ focusTick: s.focusTick + 1 }));
    },

    async send(instruction, attachments = []) {
      const text = instruction.trim();
      const project = useProject.getState().project;
      if (!text || !project || get().running) return;
      const sel = agentSelection(project, useProject.getState().selection, useUi.getState().cards);
      const id = ++seq;
      // what the assistant remembers: instruction + selection then, its answer, what that turn changed, whether it was applied, how to undo it
      // (the director's notes are turns of their own, placed right after the run they followed)
      const history = agentHistory(interleave(get().runs.filter((r) => r.status === 'done' && r.proposal), get().notes).map((row) => row.note ? noteAsPastRun(row.note) : {
        instruction: row.run!.instruction, selection: row.run!.selectionText, summary: row.run!.proposal!.summary, question: row.run!.proposal!.question,
        applied: row.run!.proposal!.applied, pending: row.run!.proposal!.pending, appliedIds: row.run!.items.filter((i) => i.state === 'applied').map((i) => i.id), revert: row.run!.revert,
      }));
      // the pre-run snapshot: in memory (once per session) and in the server's history (every run, bounded there)
      if (!get().snapshot) set({ snapshot: { project: clone(project), at: Date.now() } });
      if (useProject.getState().etag) void postSnapshot(project);
      const run: RunItem = { id, instruction: text, sceneId: sel.sceneId, status: 'running', progress: ['正在连接…'], items: [], usage: zero(), selectionText: selectionText(project, sel), ...(attachments.length ? { attachments } : {}) };
      set((s) => ({ runs: [...s.runs, run], running: true }));
      ctl = new AbortController();
      const onEvent = (e: AgentStreamEvent) => {
        patchRun(id, (r) => {
          if (e.type === 'status') return { ...r, progress: [...r.progress.slice(-30), e.text] };
          if (e.type === 'tool') return { ...r, progress: [...r.progress.slice(-30), e.summary] };
          if (e.type === 'usage') return { ...r, usage: e.total };
          if (e.type === 'ask') return { ...r, progress: [...r.progress, `提问：${e.question}`] };
          if (e.type === 'memory') {
            void useMemories.getState().load(project.id);
            return { ...r, progress: [...r.progress.slice(-30), e.event.action === 'proposed' ? `建议记住：${e.event.proposal.text}` : `${e.event.action === 'forgotten' ? '忘掉' : '记住'}：${e.event.memory.text}`] };
          }
          return r;
        });
      };
      try {
        const proposal = await postAgentTurn({ project, selection: sel, instruction: text, history, ...(attachments.length ? { attachments } : {}), canCapture: hasFrameGrabber() }, onEvent, ctl.signal);
        const items: CardItem[] = [
          ...proposal.applied.map((record) => ({ id: record.id, record, origin: 'applied' as const, state: 'open' as const, checked: true })),
          ...proposal.pending.map((record) => ({ id: record.id, record, origin: 'pending' as const, state: 'open' as const, checked: false })),
        ];
        set((s) => ({ session: add(s.session, proposal.usage) }));
        const decision = liveDecision({ sceneId: sel.sceneId, selectedScenes: sel.beatIds ? project.scenes.filter((s) => s.beats.some((b) => sel.beatIds!.includes(b.id))).map((s) => s.id) : undefined, applied: proposal.applied, pending: proposal.pending.length, question: !!proposal.question, unverified: proposal.unverified.length, stopped: proposal.stopped });
        patchRun(id, (r) => ({ ...r, status: 'done', proposal, items, usage: proposal.usage, ...(get().live && !decision.auto && proposal.applied.length > 0 ? { liveNote: `不满足实时条件：${decision.reasons.join('；')}` } : {}) }));
        if (get().live && decision.auto) {
          doApply(id, proposal.applied.map((r) => r.id));
          const run2 = get().runs.find((r) => r.id === id);
          const n = run2?.items.filter((i) => i.state === 'applied').length ?? 0;
          if (n > 0) notify(`已应用 ${n} 项`, 'info', { label: '撤销', run: () => get().undoRun(id) });
        }
      } catch (e) {
        const aborted = (e as Error).name === 'AbortError';
        patchRun(id, (r) => ({ ...r, status: aborted ? 'cancelled' : 'failed', error: aborted ? '已取消' : e instanceof AgentApiError && e.kind === 'not_configured' ? `需要 AI 模型：${e.message}` : (e as Error).message }));
      } finally {
        ctl = null;
        set({ running: false });
      }
    },

    cancel() {
      ctl?.abort();
    },

    applyItems(runId, ids, opts) {
      doApply(runId, ids, opts);
    },

    toggle(runId, itemId, checked) {
      patchRun(runId, (r) => ({ ...r, items: r.items.map((i) => (i.id === itemId ? { ...i, checked } : i)) }));
    },

    toggleMany(runId, itemIds, checked) {
      const ids = new Set(itemIds);
      patchRun(runId, (r) => ({ ...r, items: r.items.map((i) => (ids.has(i.id) ? { ...i, checked } : i)) }));
    },

    reject(runId) {
      patchRun(runId, (r) => ({ ...r, rejected: true, items: r.items.map((i) => (i.state === 'open' || i.state === 'stale' ? { ...i, state: 'skipped', checked: false } : i)) }));
    },

    skip(runId, itemId) {
      patchRun(runId, (r) => ({ ...r, items: r.items.map((i) => (i.id === itemId ? { ...i, state: 'skipped', checked: false } : i)) }));
    },

    undoRun(runId) {
      const run = get().runs.find((r) => r.id === runId);
      const st = useProject.getState();
      if (!run?.appliedLabel || st.undoLabel !== run.appliedLabel) return;
      st.undo();
      patchRun(runId, (r) => {
        const { appliedLabel: _drop, preApply: _p, revert: _r, ...rest } = r;
        void _drop;
        void _p;
        void _r;
        return { ...rest, items: r.items.map((i) => (i.state === 'applied' ? { ...i, state: 'open', checked: true } : i)) };
      });
    },

    restoreSnapshot() {
      const snap = get().snapshot;
      const st = useProject.getState();
      if (!snap || !st.project) return;
      const restore = clone(snap.project);
      st.applyEdit((d) => {
        d.title = restore.title;
        d.scenes = restore.scenes as typeof d.scenes;
        d.cast = restore.cast as typeof d.cast;
        d.style = restore.style as typeof d.style;
        d.settings = restore.settings as typeof d.settings;
        d.idSeq = restore.idSeq as typeof d.idSeq;
      }, '恢复到 AI 助手开始前', { bypassLocks: true });
      st.seal();
      notify('已恢复到 AI 助手开始前（可撤销）', 'info');
    },
  };
});
