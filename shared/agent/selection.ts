/**
 * The beat multi-selection of the editor (script list and storyboard share it) as pure functions, and the selection the AI assistant is given.
 * `primary` is the last clicked beat (the inspector shows it); `ids` is the multi-selection. A selection of one beat is just the primary.
 */
import type { Project } from '../schema/project';

export interface BeatPick {
  /** The multi-selection (any order). */
  ids: string[];
  /** The last clicked beat. */
  primary: string | null;
}
export interface PickMods {
  toggle?: boolean;
  range?: boolean;
}

/** All beat ids of the project in script order. */
export const beatOrder = (project: Pick<Project, 'scenes'>): string[] => project.scenes.flatMap((s) => s.beats.map((b) => b.id));

/** Ctrl/Cmd+click: add the beat, or remove it when it is already selected. The previous primary beat joins the selection when there was none. */
export function toggleBeat(order: string[], cur: BeatPick, id: string): BeatPick {
  const base = cur.ids.length > 0 ? cur.ids : cur.primary ? [cur.primary] : [];
  if (base.includes(id)) {
    const rest = sortByOrder(order, base.filter((x) => x !== id));
    return { ids: rest, primary: rest.length > 0 ? (cur.primary && rest.includes(cur.primary) ? cur.primary : rest.at(-1)!) : id };
  }
  return { ids: sortByOrder(order, [...base, id]), primary: id };
}

/** Shift+click: everything from the primary beat to the clicked one (across scenes, in script order). Without a primary it selects just the beat. */
export function rangeBeats(order: string[], cur: BeatPick, id: string): BeatPick {
  const a = cur.primary ? order.indexOf(cur.primary) : -1;
  const b = order.indexOf(id);
  if (a < 0 || b < 0) return { ids: [id], primary: id };
  const [lo, hi] = a <= b ? [a, b] : [b, a];
  return { ids: order.slice(lo, hi + 1), primary: id };
}

export const clearPick = (cur: BeatPick): BeatPick => ({ ids: [], primary: cur.primary });

/** One click on a beat with the modifier keys held. */
export function clickBeat(order: string[], cur: BeatPick, id: string, mods: PickMods = {}): BeatPick {
  if (mods.range) return rangeBeats(order, cur, id);
  if (mods.toggle) return toggleBeat(order, cur, id);
  return { ids: [id], primary: id };
}

export function sortByOrder(order: string[], ids: string[]): string[] {
  const pos = new Map(order.map((id, i) => [id, i]));
  return [...new Set(ids)].filter((id) => pos.has(id)).sort((x, y) => pos.get(x)! - pos.get(y)!);
}

/** The ids the assistant should treat as "these lines": the multi-selection in script order, only when it holds at least two existing beats. */
export function multiIds(project: Pick<Project, 'scenes'>, ids: string[]): string[] {
  const r = sortByOrder(beatOrder(project), ids);
  return r.length >= 2 ? r : [];
}

/** "3–6" / "1、3–4、8": 1-based beat numbers of a scene as compact ranges. */
export function rangesText(nos: number[]): string {
  const sorted = [...new Set(nos)].sort((a, b) => a - b);
  const out: string[] = [];
  for (let i = 0; i < sorted.length; ) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j]! + 1) j++;
    out.push(j > i ? `${sorted[i]}–${sorted[j]}` : String(sorted[i]));
    i = j + 1;
  }
  return out.join('、');
}

/** 「第2场 · 已选 4 句（第3–6句）」; null when the selection is a single beat. */
export function multiContext(project: Pick<Project, 'scenes'>, ids: string[]): string | null {
  const sel = multiIds(project, ids);
  if (sel.length === 0) return null;
  const set = new Set(sel);
  const parts = project.scenes.map((s, si) => ({ no: si + 1, nos: s.beats.flatMap((b, bi) => (set.has(b.id) ? [bi + 1] : [])) })).filter((p) => p.nos.length > 0);
  if (parts.length === 1) return `第${parts[0]!.no}场 · 已选 ${sel.length} 句（第${rangesText(parts[0]!.nos)}句）`;
  return `已选 ${sel.length} 句（${parts.map((p) => `第${p.no}场第${rangesText(p.nos)}句`).join('；')}）`;
}

export interface AgentSelectionPayload {
  sceneId: string | null;
  beatId: string | null;
  castId: string | null;
  /** Present only for a multi-selection of at least two beats, in script order. */
  beatIds?: string[];
}
/** The `selection` of an assistant request. A single selection has no `beatIds`. */
export function agentSelection(project: Pick<Project, 'scenes'>, sel: { sceneId: string | null; beatId: string | null; castId: string | null }, ids: string[]): AgentSelectionPayload {
  const m = multiIds(project, ids);
  return { sceneId: sel.sceneId, beatId: sel.beatId, castId: sel.castId, ...(m.length > 0 ? { beatIds: m } : {}) };
}
