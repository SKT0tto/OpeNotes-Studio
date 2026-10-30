/**
 * What the AI director did, as the assistant remembers it. The director panel (accepting a result) and the one-click generation of the home
 * dialog append a short note; the next assistant turn sends the notes with its conversation history, so 「刚生成的第二场节奏慢一点」
 * can be resolved. Client side only: a note is an ordinary user / assistant pair of the existing history format (`HistoryTurn`), carrying no ops.
 * Pure (no store, no DOM): `agentStore` keeps the list.
 */
import type { PastRun } from '@shared/agent/history';

export interface DirectorNote {
  id: number;
  /** Id of the last assistant run when the note was made: the note sits right after that run in the history and in the chat. */
  after: number;
  text: string;
  at: number;
}

/** Notes kept per project (older ones fall away) and the scenes one note names before it says 「等 N 场」. */
export const MAX_NOTES = 6;
const NAMED_SCENES = 6;

export interface AcceptedScene {
  /** 1-based scene number in the project. */
  no: number;
  title: string;
}

/** 「接受了 第2场「标题」 · 镜头（AI生成，已应用到项目，Ctrl+Z 可撤销）」: one accepted proposal (a scene, a scope, a part). The chat shows it under an 「AI 导演」 tag. */
/** `scopes` are the scope labels as the panel shows them (整个场景, 镜头 …). */
export function directorAcceptText(p: { who: string; scenes: AcceptedScene[]; scopes: string[]; partial?: boolean; onlyBeats?: number }): string {
  const named = p.scenes.slice(0, NAMED_SCENES).map((s) => `第${s.no}场「${s.title}」`).join('、');
  const more = p.scenes.length > NAMED_SCENES ? `等 ${p.scenes.length} 场` : '';
  const scope = p.scopes.join(' / ');
  const part = p.onlyBeats ? `（只有选中的 ${p.onlyBeats} 句）` : p.partial ? '（只接受了部分范围）' : '';
  return `接受了 ${named}${more} · ${scope}${part}（${p.who}生成，已应用到项目，Ctrl+Z 可撤销）`;
}

/** 「一键生成」 from the home dialog: the whole project was generated before the editor opened. */
export function oneClickText(p: { who: string; done: number; total: number; failed: number; warnings: number }): string {
  const rest = p.total - p.done;
  return `一键生成（${p.who}）：整部演出共 ${p.total} 场，已生成 ${p.done} 场${p.failed > 0 ? `，失败 ${p.failed} 场` : rest > 0 ? `，还有 ${rest} 场没生成` : ''}；连续性提示 ${p.warnings} 条`;
}

const ACK = '好的，记下了：这些场景是 AI 导演刚生成的。你之后说“刚生成的第N场…”，指的就是这几场。';

/** The note as one past run of the history: the user turn says what happened, the assistant turn acknowledges it. No changes, nothing to undo here. */
export function noteAsPastRun(n: Pick<DirectorNote, 'text'>): PastRun {
  return { instruction: `【${n.text.split('\n').length > 1 ? 'AI 导演的几次操作' : 'AI 导演'}】${n.text}`, summary: ACK, applied: [], pending: [], appliedIds: [] };
}

/** Appends a note. Notes made without an assistant run in between are one entry (a person accepting four scenes one by one is one memory, not four turns). */
export function appendNote(notes: DirectorNote[], text: string, after: number, id: number, now: number): DirectorNote[] {
  const last = notes.at(-1);
  if (last && last.after === after) {
    const lines = [...last.text.split('\n'), text].slice(-MAX_NOTES);
    return [...notes.slice(0, -1), { ...last, text: lines.join('\n'), at: now }];
  }
  return [...notes, { id, after, text, at: now }].slice(-MAX_NOTES);
}

/** The history entries in order: assistant runs (by id) and notes (right after the run they follow). */
export interface FlowRow<R> {
  order: number;
  run?: R;
  note?: DirectorNote;
}
export function interleave<R extends { id: number }>(runs: R[], notes: DirectorNote[]): Array<FlowRow<R>> {
  const rows: Array<FlowRow<R>> = [...runs.map((run) => ({ order: run.id, run })), ...notes.map((note) => ({ order: note.after + 0.5, note }))];
  return rows.sort((a, b) => a.order - b.order);
}
