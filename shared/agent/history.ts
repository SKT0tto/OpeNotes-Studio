/**
 * The conversation the assistant remembers: each earlier turn is the instruction (with what was selected then) and the answer, plus a
 * compact list of what that turn changed and whether the user applied it. That list is what 「刚才那句 / 再来一点 / 改回去」 resolve
 * against, so it names scene, line number and beat id. A turn whose card was applied also carries the ops that undo it (`revert`,
 * see revert.ts): the `revert_turn` tool replays them instead of the model guessing the old values.
 */
import type { AgentOp } from './ops';
import type { OpRecord } from './tools';

export interface PastRun {
  instruction: string;
  /** The selection when it was sent, as text (「第1场第3句 s_1b_11（灯）」 / 「多选 3 句…」). */
  selection?: string | undefined;
  summary: string;
  question?: { question: string; options: string[] } | null | undefined;
  applied: Array<Pick<OpRecord, 'id' | 'op' | 'changes'>>;
  pending: Array<Pick<OpRecord, 'id' | 'op' | 'changes'>>;
  /** Ids of `applied` records the user really applied (the card). */
  appliedIds: number[];
  /** Ops that take the project back to before this run (present once the card was applied). */
  revert?: AgentOp[] | undefined;
}
export interface HistoryTurn {
  role: 'user' | 'assistant';
  content: string;
  revert?: AgentOp[] | undefined;
}

export const HISTORY_RUNS = 4;
const MAX_LINES = 14;

/** The history turns of the last few runs (oldest first). */
export function agentHistory(runs: PastRun[], max = HISTORY_RUNS): HistoryTurn[] {
  const out: HistoryTurn[] = [];
  for (const r of runs.slice(-max)) {
    out.push({ role: 'user', content: r.selection ? `${r.instruction}\n（当时的选区：${r.selection}）` : r.instruction });
    const said = r.question ? `（我问了用户）${r.question.question}` : r.summary;
    const lines = changeLines(r);
    out.push({ role: 'assistant', content: [said, lines].filter(Boolean).join('\n'), ...(r.revert?.length ? { revert: r.revert } : {}) });
  }
  return out.filter((h) => h.content.trim());
}

function changeLines(r: PastRun): string {
  if (r.applied.length === 0 && r.pending.length === 0) return '';
  const applied = new Set(r.appliedIds);
  const nApplied = r.applied.filter((x) => applied.has(x.id)).length;
  const state = nApplied === 0 ? '用户还没有应用（项目里没有这些改动）' : nApplied === r.applied.length ? '用户已应用' : `用户只应用了其中 ${nApplied} 项（标 ✓ 的）`;
  const rows: string[] = [];
  for (const x of r.applied) for (const c of x.changes) rows.push(`- ${applied.has(x.id) && nApplied < r.applied.length ? '✓ ' : ''}${x.op.sceneId} ${c.where}${c.beatId ? `(${c.beatId})` : ''} ${c.field}：${c.before} → ${c.after}`);
  for (const x of r.pending) for (const c of x.changes) rows.push(`- （待用户确认，没有生效）${x.op.sceneId} ${c.where}${c.beatId ? `(${c.beatId})` : ''} ${c.field}：${c.before} → ${c.after}`);
  const shown = rows.slice(0, MAX_LINES);
  return `【这一轮的改动 · ${state}${r.revert?.length ? ' · 可用 revert_turn 精确撤销' : ''}】\n${shown.join('\n')}${rows.length > shown.length ? `\n- …另有 ${rows.length - shown.length} 处` : ''}`;
}

/** The selection as the history shows it: 「第1场 s_1 第3句 s_1b_11（高松灯）」, 「多选 3 句：…」 or 「第2场（未选句子）」. */
export function selectionText(project: { scenes: Array<{ id: string; beats: Array<{ id: string; speakerId?: string | undefined }> }>; cast: Array<{ id: string; displayName: string }> }, sel: { sceneId?: string | null | undefined; beatId?: string | null | undefined; beatIds?: string[] | undefined }): string {
  const name = (id?: string) => (id ? project.cast.find((c) => c.id === id)?.displayName ?? id : '');
  const where = (id: string) => {
    for (const [si, s] of project.scenes.entries()) {
      const bi = s.beats.findIndex((b) => b.id === id);
      if (bi >= 0) { const sp = name(s.beats[bi]!.speakerId); return `第${si + 1}场第${bi + 1}句 ${id}${sp ? `（${sp}）` : ''}`; }
    }
    return id;
  };
  if (sel.beatIds && sel.beatIds.length > 1) return `多选 ${sel.beatIds.length} 句：${sel.beatIds.slice(0, 8).map(where).join('、')}${sel.beatIds.length > 8 ? '…' : ''}`;
  if (sel.beatId) return where(sel.beatId);
  const si = project.scenes.findIndex((s) => s.id === sel.sceneId);
  return si >= 0 ? `第${si + 1}场 ${sel.sceneId}（没有选中句子）` : '无';
}
