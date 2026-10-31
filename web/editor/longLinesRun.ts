/**
 * 「自动拆分」 / 「检查过长台词 → 全部拆分」: ask the server where to cut the long lines (`/api/director/split-lines`, AI when a model is set up,
 * the rule splitter otherwise; nothing is applied there), then replay the answer as `beat_split_pieces` ops inside ONE `applyEdit`
 * (`applyAgentOps`), so a whole batch is one undo step. Nothing here runs by itself: old projects only change when the person clicks.
 */
import { create } from 'zustand';
import { postSplitLines, DirectorApiError } from '../directorApi';
import { useProject } from '../store/projectStore';
import { notify } from '../store/uiStore';
import { overLongRows, replayItems, splitOps, type SplitPlan } from './longLines';

export interface SplitSummary {
  /** Lines that were cut. */
  lines: number;
  /** Beats made by the cuts (the new continuation lines). */
  added: number;
  /** Lines the splitter or the replay left alone (locked, no good cut, changed meanwhile). */
  skipped: number;
  by: 'ai' | 'rule' | null;
  /** Undo steps made. */
  steps: number;
  error?: string;
}

interface SplitRunState {
  busy: boolean;
  /** Line being worked on (`beatId`), a scene (`scene:<id>`) or the project (`all`). */
  target: string | null;
  last: SplitSummary | null;
}
export const useSplitRun = create<SplitRunState>(() => ({ busy: false, target: null, last: null }));

export interface SplitRequest {
  /** Scenes to look at, in order. */
  sceneIds: string[];
  /** Only these lines (of the one scene). */
  beatIds?: string[];
  /** One undo step for everything (default) or one per scene. */
  oneStep?: boolean;
  target: string;
}

export async function splitLongLines(req: SplitRequest): Promise<SplitSummary> {
  const run = useSplitRun.getState();
  if (run.busy) return { lines: 0, added: 0, skipped: 0, by: null, steps: 0 };
  useSplitRun.setState({ busy: true, target: req.target });
  const sum: SplitSummary = { lines: 0, added: 0, skipped: 0, by: null, steps: 0 };
  const label = '自动拆分长句';
  const genId = `longline_${Date.now().toString(36)}`;
  try {
    const plans: Array<{ sceneId: string; splits: SplitPlan[] }> = [];
    for (const sceneId of req.sceneIds) {
      const project = useProject.getState().project;
      if (!project) break;
      const wanted = overLongRows(project, sceneId).filter((r) => !req.beatIds || req.beatIds.includes(r.beatId));
      if (wanted.length === 0) continue;
      const r = await postSplitLines(project, sceneId, wanted.map((w) => w.beatId));
      sum.skipped += r.skipped.length;
      // who cut them: the rule splitter is also the fallback of a model call that failed, so say AI only when a model really decided one
      if (r.splits.length > 0) sum.by = r.splits.some((s) => s.by !== 'rule') || sum.by === 'ai' ? 'ai' : 'rule';
      plans.push({ sceneId, splits: r.splits.map((s) => ({ beatId: s.beatId, by: s.by, pieces: s.pieces })) });
    }
    // ids are taken from the project as it is NOW (it may have been edited while the requests ran)
    const groups = req.oneStep === false ? plans.map((p) => [p]) : [plans];
    for (const g of groups) {
      const project = useProject.getState().project;
      if (!project) break;
      const ops = g.flatMap((p) => splitOps(project, p.sceneId, p.splits));
      if (ops.length === 0) continue;
      const { plan, applied } = useProject.getState().applyAgentOps(replayItems(ops), label, genId);
      if (applied > 0) sum.steps += 1;
      for (const it of plan.accepted) {
        sum.lines += 1;
        if (it.op.op === 'beat_split_pieces') sum.added += it.op.newIds.length;
      }
      sum.skipped += plan.items.length - plan.accepted.length;
    }
  } catch (e) {
    sum.error = e instanceof DirectorApiError || e instanceof Error ? e.message : '拆分失败';
  } finally {
    useSplitRun.setState({ busy: false, target: null, last: sum });
  }
  report(sum);
  return sum;
}

/** The toast after a split: what happened, and how to take it back. */
export function report(s: SplitSummary): void {
  if (s.error) return void notify(`自动拆分失败：${s.error}`, 'warn');
  if (s.lines === 0) return void notify(s.skipped > 0 ? `没有拆开：${s.skipped} 句已锁定、已展开或找不到合适的断点` : '没有需要拆的台词', 'warn');
  const how = s.by === 'rule' ? '规则' : 'AI';
  const undo = s.steps > 1 ? `Ctrl+Z 逐场撤销（${s.steps} 步）` : 'Ctrl+Z 一步撤销';
  notify(`${how}拆开了 ${s.lines} 句台词，新增 ${s.added} 句${s.skipped > 0 ? `；${s.skipped} 句没拆` : ''} · ${undo}`, 'info', s.steps === 1 ? { label: '撤销', run: () => useProject.getState().undo() } : undefined);
}
