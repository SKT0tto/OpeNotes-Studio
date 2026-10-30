/**
 * A generation turn: one 「生成」 request as the AI panel's stream shows it (the 「你」 bubble, then one card with progress and one section per
 * scene). Types and pure helpers only; the state and the requests are in `../directorRun.ts`. The card state shown to the person is derived
 * from the project's undo stack (`live`), so that Ctrl+Z turns 「已应用」 into 「已撤销」 with nothing to keep in sync.
 */
import { SCOPE_LABEL, type ScopeName } from '@shared/director/scope';
import type { DiffScope, SceneDiff } from '@shared/director/diff';
import type { BatchProgress, SceneResponse } from '../../../directorApi';

export type Engine = 'ai' | 'rule';
export interface LogLine { at: number; kind: 'info' | 'error'; text: string }

export interface RunOptions {
  sceneId?: string;
  /** Several scenes, one sequential request each (camera regenerate for all). */
  sceneIds?: string[];
  /** Several scenes in one batch request (`postScenes` with `sceneIds`, 3 at a time): the scenes that are not generated yet. */
  batchIds?: string[];
  scope?: ScopeName;
  preview?: boolean;
  overwriteUser?: boolean;
  onlyBeat?: boolean;
  /** These lines (of one scene) instead of the selected one; implies `onlyBeat`. */
  beatIds?: string[];
  engine?: Engine;
  /** 「换一版」: ask for a new answer instead of the cached one for the same input (the request's `refresh` flag). */
  refresh?: boolean;
  /** The words of the 「你」 bubble when the person typed the command (the composer routed it to generation). */
  userText?: string;
}

export type CardState = 'pending' | 'accepted' | 'rejected';
export interface Card {
  sceneId: string;
  title: string;
  result: SceneResponse;
  diff: SceneDiff;
  /** Scopes of the request (what the run was allowed to change). */
  scopes: string[];
  state: CardState;
  checked: DiffScope[];
  /** The undo step that applied it. */
  stepId?: number;
}

export type ShownState = 'pending' | 'accepted' | 'rejected' | 'undone';
/** What the person sees for one scene: applied results whose undo step is gone read 「已撤销」. */
export const shownState = (c: Card, live: (stepId: number) => boolean): ShownState =>
  c.state === 'accepted' ? (c.stepId !== undefined && !live(c.stepId) ? 'undone' : 'accepted') : c.state;

export interface GenTurn {
  id: number;
  /** Position in the stream (`store/aiFlow.ts`). */
  order: number;
  /** The words of the 「你」 bubble. */
  userText: string;
  /** Set when the composer routed a typed command here (the original words): the bubble offers 「改成发给 AI」. */
  routed?: string;
  who: string;
  label: string;
  scopes: ScopeName[];
  beatIds?: string[];
  overwrite: boolean;
  all: boolean;
  /** The request as it was resolved, to run it again (「换一版」, a typed 「换一版」). */
  request: RunOptions;
  sceneIds: string[];
  status: 'running' | 'done' | 'failed' | 'cancelled';
  preview: boolean;
  progress: Record<string, BatchProgress>;
  total: number;
  cards: Record<string, Card>;
  log: LogLine[];
  error: string | null;
  /** Undo steps made by applying results of this turn, newest last. */
  steps: Array<{ stepId: number; sceneIds: string[] }>;
}

export type TurnState = 'running' | 'failed' | 'cancelled' | 'empty' | 'pending' | 'applied' | 'partial' | 'undone' | 'rejected' | 'conflict';

export function turnState(t: GenTurn, live: (stepId: number) => boolean): TurnState {
  if (t.status === 'running') return 'running';
  const cards = Object.values(t.cards);
  if (cards.length === 0) return t.status === 'failed' ? 'failed' : t.status === 'cancelled' ? 'cancelled' : 'empty';
  const shown = cards.map((c) => shownState(c, live));
  const all = (s: ShownState) => shown.every((x) => x === s);
  if (all('accepted')) return 'applied';
  if (all('undone')) return 'undone';
  if (all('rejected')) return 'rejected';
  if (all('pending')) return cards.every((c) => !c.result.applied) ? 'conflict' : 'pending';
  return 'partial';
}

export const TURN_STATE_LABEL: Record<TurnState, string> = {
  running: '生成中', failed: '失败', cancelled: '已取消', empty: '没有结果', pending: '待确认', applied: '已应用', partial: '部分应用', undone: '已撤销', rejected: '已拒绝', conflict: '未应用：锁定冲突',
};

/** The undo step of this turn that 「撤销这次」 would revert: its newest step, and only while that one is on top of the undo stack. */
export function undoableStep(t: GenTurn, topId: number | null): number | null {
  const last = t.steps.at(-1);
  return last && topId !== null && last.stepId === topId ? last.stepId : null;
}

export interface SceneRef { no: number; title: string }

/**
 * The assistant's history line for a finished generation turn: what was generated, and what became of it (applied, partly, undone, rejected,
 * not applied yet). Told to the model as it is NOW, so 「把刚才那个撤了」 and 「刚生成的第二场」 both resolve.
 */
export function turnHistoryText(t: GenTurn, ref: (sceneId: string) => SceneRef | null, live: (stepId: number) => boolean): string | null {
  if (t.status === 'running' || t.status === 'failed' || t.status === 'cancelled') return null;
  const cards = Object.values(t.cards);
  if (cards.length === 0) return null;
  const refs = (list: Card[]) => list.flatMap((c) => { const r = ref(c.sceneId); return r ? [r] : []; }).sort((a, b) => a.no - b.no);
  const name = (list: SceneRef[]) => {
    const named = list.slice(0, 6).map((s) => `第${s.no}场「${s.title}」`).join('、');
    return `${named}${list.length > 6 ? `等 ${list.length} 场` : ''}`;
  };
  const scope = t.scopes.map((s) => SCOPE_LABEL[s]).join(' / ');
  const beats = t.beatIds ? `（只有选中的 ${t.beatIds.length} 句）` : '';
  const state = turnState(t, live);
  const head = `${t.who}生成了 ${name(refs(cards))} · ${scope}${beats}`;
  switch (state) {
    case 'applied': return `${head}（已应用到项目，Ctrl+Z 可撤销）`;
    case 'undone': return `${head}（已撤销，项目里没有这次的改动）`;
    case 'rejected': return `${head}（用户拒绝了，没有应用）`;
    case 'conflict': return `${head}（锁定冲突，没有应用）`;
    case 'pending': return `${head}（尚未应用，等待用户确认）`;
    default: {
      const applied = cards.filter((c) => shownState(c, live) === 'accepted');
      const undone = cards.filter((c) => shownState(c, live) === 'undone');
      const rest = cards.length - applied.length;
      return `${head}（部分应用：已应用 ${name(refs(applied)) || '0 场'}${undone.length > 0 ? `，${undone.length} 场已撤销` : ''}${rest - undone.length > 0 ? `，${rest - undone.length} 场尚未应用` : ''}）`;
    }
  }
}
