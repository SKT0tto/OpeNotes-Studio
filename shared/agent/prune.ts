/**
 * A turn may try something, look at it, and take it back (move someone, capture a frame, reset the offset). Those round trips are noise
 * on the change card ("偏移 无 → 0.08", "偏移 0.08 → 无"). This drops the records whose every change ends where it started, but only when
 * replaying what is left on the original project gives exactly the same result as the sandbox (provenance aside); otherwise nothing is dropped.
 */
import { clone } from '../project/mutate';
import type { Project } from '../schema/project';
import { planReplay, replayInto } from './replay';
import type { OpRecord } from './tools';

const content = (p: Project) => JSON.stringify(p, (k, v) => (k === 'meta' || k === 'idSeq' ? undefined : v));

export function pruneRoundTrips(original: Project, applied: OpRecord[], sandbox: Project): OpRecord[] {
  const chains = new Map<string, Array<{ rec: OpRecord; before: string; after: string }>>();
  for (const rec of applied) for (const c of rec.changes) {
    const k = `${rec.op.sceneId}|${c.where}|${c.field}`;
    (chains.get(k) ?? chains.set(k, []).get(k)!).push({ rec, before: c.before, after: c.after.replace(/（时间\/过渡）$/, '') });
  }
  // per unit: the changes from the first one up to the last that lands back on the starting value cancel out
  const cancelled = new Map<OpRecord, number>();
  for (const list of chains.values()) {
    let j = -1;
    for (let i = 1; i < list.length; i++) if (list[i]!.after === list[0]!.before) j = i;
    for (let i = 0; i <= j; i++) cancelled.set(list[i]!.rec, (cancelled.get(list[i]!.rec) ?? 0) + 1);
  }
  const drop = new Set(applied.filter((rec) => rec.changes.length > 0 && cancelled.get(rec) === rec.changes.length));
  if (drop.size === 0) return applied;
  const kept = applied.filter((r) => !drop.has(r));
  const ctx = { genId: 'prune', now: 0 };
  const out = clone(original);
  replayInto(out, planReplay(original, kept.map((r) => ({ id: r.id, op: r.op })), ctx), ctx);
  return content(out) === content(sandbox) ? kept : applied;
}
