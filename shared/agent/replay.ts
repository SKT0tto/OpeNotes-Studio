/**
 * Replaying a proposal on the project the user has NOW. The server only returns ops; the browser plans them here (so a target that was
 * deleted or locked in the meantime is reported as stale / needs-the-user instead of failing the whole set) and then applies the accepted ones
 * to an Immer draft inside ONE `applyEdit`, which makes the whole application a single undo step.
 */
import { findLockViolations, getByPath, type Seg } from '../project/locks';
import { clone } from '../project/mutate';
import type { Meta, Project } from '../schema/project';
import { applyOp, type ApplyCtx, type Change } from './apply';
import { checkOp } from './check';
import { scopeOf, type AgentOp, type AgentScope } from './ops';

export interface ReplayItem {
  id: number;
  op: AgentOp;
  /** The user chose 「解锁并应用」 for this item. */
  unlock?: boolean | undefined;
  /** The user chose to overwrite hand-made content. */
  confirm?: boolean | undefined;
}
export type ReplayStatus = 'ok' | 'needs_unlock' | 'needs_confirm' | 'stale';
export interface PlannedItem {
  id: number;
  op: AgentOp;
  scope: AgentScope;
  status: ReplayStatus;
  /** Why the item is stale / needs the user. */
  reason: string;
  changes: Change[];
  warnings: string[];
  /** Locked units this item touches (to unlock when the user agrees). */
  lockPaths: Seg[][];
  lockLabels: string[];
  overwrote: string[];
  skipped: string[];
}
export interface ReplayPlan {
  items: PlannedItem[];
  /** Items that will be applied, in order. */
  accepted: PlannedItem[];
}

export function planReplay(project: Project, items: ReplayItem[], ctx: ApplyCtx): ReplayPlan {
  const work = clone(project);
  const out: PlannedItem[] = [];
  for (const it of items) {
    const op = it.confirm ? ({ ...it.op, overrideUser: true } as AgentOp) : it.op;
    const base = { id: it.id, op, scope: scopeOf(op), changes: [] as Change[], warnings: [] as string[], lockPaths: [] as Seg[][], lockLabels: [] as string[], overwrote: [] as string[], skipped: [] as string[] };
    const r = checkOp(work, op, {});
    if (r.status === 'invalid') {
      out.push({ ...base, status: 'stale', reason: `已失效：${r.problems[0] ?? '目标已变化'}` });
      continue;
    }
    const sim = clone(work);
    const ap = applyOp(sim, r.op, ctx);
    const viol = findLockViolations(work, sim);
    const lockPaths = viol.map((v) => v.path);
    const lockLabels = viol.map((v) => v.label);
    const common = { ...base, op: r.op, changes: ap.changes, warnings: r.warnings, lockPaths, lockLabels, overwrote: ap.overwrote, skipped: ap.skipped };
    if (viol.length > 0 && !it.unlock) {
      out.push({ ...common, status: 'needs_unlock', reason: `「${lockLabels[0]}」已锁定` });
      continue;
    }
    // opening a lock on purpose also accepts overwriting what is behind it (a person's own locked edit)
    const accepted = op.overrideUser === true || (it.unlock === true && viol.length > 0);
    if (ap.overwrote.length > 0 && !accepted) {
      out.push({ ...common, status: 'needs_confirm', reason: `会覆盖你手改过的：${ap.overwrote[0]}` });
      continue;
    }
    for (const p of lockPaths) unlock(work, p);
    const finalOp = accepted ? ({ ...r.op, overrideUser: true } as AgentOp) : r.op;
    applyOp(work, finalOp, ctx);
    out.push({ ...common, op: finalOp, status: 'ok', reason: '' });
  }
  return { items: out, accepted: out.filter((i) => i.status === 'ok') };
}

function unlock(root: unknown, path: Seg[]): void {
  const u = getByPath(root, path) as { meta?: Meta } | undefined;
  if (u?.meta) {
    u.meta.locked = false;
    delete u.meta.lockedFields;
  }
}

/** Apply a plan to a draft (or a copy). Locks the user agreed to open are opened first, in the same edit. */
export function replayInto(draft: Project, plan: ReplayPlan, ctx: ApplyCtx): void {
  for (const it of plan.accepted) {
    for (const p of it.lockPaths) unlock(draft, p);
    applyOp(draft, it.op, ctx);
  }
}
