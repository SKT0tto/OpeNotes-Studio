/**
 * What the AI did outside the assistant's own turns, as the assistant remembers it: a generation turn (applied, partly applied, undone, rejected,
 * not applied yet) and the first-run dialog's one-click generation. Each becomes one user / assistant pair of the existing history format
 * (`HistoryTurn`) carrying no ops, so 「刚生成的第二场节奏慢一点」 and 「把刚才生成的撤掉」 can be resolved. Pure (no store, no DOM).
 */
import type { PastRun } from '@shared/agent/history';

/** 「一键生成」 from the home dialog: the whole project was generated before the editor opened. */
export function oneClickText(p: { who: string; done: number; total: number; failed: number; warnings: number }): string {
  const rest = p.total - p.done;
  return `一键生成（${p.who}）：整部演出共 ${p.total} 场，已生成 ${p.done} 场${p.failed > 0 ? `，失败 ${p.failed} 场` : rest > 0 ? `，还有 ${rest} 场没生成` : ''}；连续性提示 ${p.warnings} 条`;
}

const ACK = '好的，记下了：这些场景是 AI 刚生成的。你之后说“刚生成的第N场…”，指的就是这几场。';

/** The text as one past run of the history: the user turn says what happened, the assistant turn acknowledges it. No changes, nothing to undo here. */
export function noteAsPastRun(n: { text: string }): PastRun {
  return { instruction: `【AI 生成】${n.text}`, summary: ACK, applied: [], pending: [], appliedIds: [] };
}
