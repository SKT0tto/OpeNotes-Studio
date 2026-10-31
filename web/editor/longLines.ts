/**
 * Long dialogue lines in the editor (pure): which lines do not fit the dialogue area, the 「2/2 行」 indicator, the hint for 「展开显示」, and the
 * ops that cut lines into pieces (one `beat_split_pieces` per split, all in one list so that they replay as ONE undo step).
 */
import { beatLineInfo, type BeatLineInfo } from '@shared/agent/lines';
import type { AgentOp } from '@shared/agent/ops';
import { freeBeatIds } from '@shared/agent/tools';
import type { ReplayItem } from '@shared/agent/replay';
import type { Beat, Project, Scene } from '@shared/schema/project';
import { expandPlan } from '@shared/style/dialogLayout';

/** What the server's split-lines endpoint decided for one scene (`web/directorApi.ts`). */
export interface SplitPlan {
  beatId: string;
  by: 'ai' | 'retry' | 'rule';
  pieces: Array<{ text: string; emotion?: string; why?: string; camera?: 'closer' | 'reaction'; reactionOf?: string; motion?: string; expression?: string; attention?: string }>;
}

export interface LongRow {
  sceneId: string;
  sceneNo: number;
  beatId: string;
  beatNo: number;
  text: string;
  lines: number;
  max: number;
  /** Locked (the splitter leaves it alone). */
  locked: boolean;
}

/** The over-long lines (more lines than the dialogue area has, not expanded) of one scene or of the whole project. */
export function overLongRows(project: Project, sceneId?: string): LongRow[] {
  const out: LongRow[] = [];
  project.scenes.forEach((s, si) => {
    if (sceneId && s.id !== sceneId) return;
    s.beats.forEach((b, bi) => {
      const info = beatLineInfo(project, s, b);
      if (info?.over) out.push({ sceneId: s.id, sceneNo: si + 1, beatId: b.id, beatNo: bi + 1, text: b.text, lines: info.lines, max: info.max, locked: b.meta.locked || (b.meta.lockedFields?.length ?? 0) > 0 });
    });
  });
  return out;
}

export interface LineIndicator {
  /** 「2/2 行」 */
  text: string;
  /** More lines than the area has and not expanded: the viewer loses text. */
  warn: boolean;
  expanded: boolean;
}

/** The indicator of the selected line, or null for a beat that shows no text. */
export function lineIndicator(info: BeatLineInfo | null): LineIndicator | null {
  if (!info) return null;
  return { text: `${info.lines}/${info.max} 行`, warn: info.over, expanded: info.expanded };
}

/** The hint under 「展开显示」: how the dialogue box takes `lines` lines. */
export function expandHint(lines: number, max: number): string {
  if (lines <= max) return `${lines} 行：对话框放得下，不需要展开`;
  const p = expandPlan(lines);
  if (p.scroll) return `${lines} 行：最多显示 ${p.visible} 行，其余随打字滚动`;
  return p.shiftUp > 0 ? `${lines} 行：对话框会向上长` : `${lines} 行：对话框会向下长`;
}

/** The beat as the editor tags it in lists: a continuation of a split line. */
export const isContinuation = (b: Pick<Beat, 'splitFrom'>): boolean => b.splitFrom !== undefined;

/**
 * One `beat_split_pieces` op per split plan, with fresh ids (`freeBeatIds`, which must not repeat inside the batch: ids taken for one split are
 * reserved while the next is planned). Splits whose beat is gone or that have fewer than two pieces are dropped.
 */
export function splitOps(project: Project, sceneId: string, splits: SplitPlan[], reason = '自动拆分长句'): AgentOp[] {
  const scene = project.scenes.find((s) => s.id === sceneId);
  if (!scene) return [];
  const work: Scene = { ...scene, beats: [...scene.beats], idSeq: { ...(scene.idSeq ?? {}) } };
  const ops: AgentOp[] = [];
  for (const sp of splits) {
    if (!work.beats.some((b) => b.id === sp.beatId) || sp.pieces.length < 2) continue;
    const pieces = sp.pieces.slice(0, 4);
    const newIds = freeBeatIds(work, pieces.length - 1);
    // reserve the ids so that the next split of this batch takes others
    for (const id of newIds) work.beats.push({ id } as Beat);
    ops.push({ op: 'beat_split_pieces', sceneId, beatId: sp.beatId, pieces: pieces.map((p) => ({ text: p.text, ...(p.emotion ? { emotion: p.emotion } : {}), ...(p.why ? { why: p.why } : {}), ...(p.camera ? { camera: p.camera } : {}), ...(p.reactionOf ? { reactionOf: p.reactionOf } : {}), ...(p.motion ? { motion: p.motion } : {}), ...(p.expression ? { expression: p.expression } : {}), ...(p.attention ? { attention: p.attention } : {}) })), newIds, reason } as AgentOp);
  }
  return ops;
}

/**
 * Ops as replay items (ids from 1). The person pressed the button on these very lines, so cutting a line they edited by hand is confirmed
 * (`confirm`: the text stays, it is only cut); a LOCKED line still asks (needs_unlock) and is left alone.
 */
export function replayItems(ops: AgentOp[]): ReplayItem[] {
  return ops.map((op, i) => ({ id: i + 1, op, confirm: true }));
}

/** Scenes (ids, in order) that have at least one over-long line. */
export const scenesWithLong = (rows: LongRow[]): string[] => [...new Set(rows.map((r) => r.sceneId))];

const infoCache = new WeakMap<Beat, { project: unknown; scene: unknown; info: BeatLineInfo | null }>();
/** `beatLineInfo`, remembered per beat object (immer keeps untouched beats identical) so that a long script is not re-laid-out on every render. */
export function cachedLineInfo(project: Project, scene: Scene, beat: Beat): BeatLineInfo | null {
  const hit = infoCache.get(beat);
  if (hit && hit.project === project.style && hit.scene === scene.style) return hit.info;
  const info = beatLineInfo(project, scene, beat);
  infoCache.set(beat, { project: project.style, scene: scene.style, info });
  return info;
}
