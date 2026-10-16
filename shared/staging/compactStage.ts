/**
 * Compact stage of the travel camera system: the people stand in one tight row (neighbours about `pitchHeads` head heights apart) whatever
 * slots the director picked, so a camera move from one speaker to the next stays inside one continuous space. Pure functions only.
 */
import type { StyleValues } from '../style/ournotes';
import { clamp } from '../timeline/easing';
import { slotToX, type Placement } from './ground';
import type { BgInfo, Rect } from './world';

/** Piecewise linear slot -> world x map (strictly increasing). Written to CompiledScene.travel.stage. */
export interface StageMap {
  /** Distinct used slots, ascending. */
  slots: number[];
  /** World x of each slot. */
  xs: number[];
  /** World units per slot unit outside the used range (and for a single slot). */
  slope: number;
}

/** The slot distance the AI vocabulary uses between neighbours (vocab.ts: about 0.25-0.3). */
export const CANON_SLOT_GAP = 0.3;

/**
 * Used slots (deduplicated at 1e-3, sorted) -> neighbours `pitchWorld * clamp(gap / 0.3, 0.5, 1)` apart, the whole row centred on `centreX`.
 * A rank map rather than a linear squeeze: two people at far_left / far_right still stand one pitch apart.
 */
export function buildStageMap(usedSlots: number[], pitchWorld: number, centreX: number): StageMap {
  const sorted = [...usedSlots].filter(Number.isFinite).sort((a, b) => a - b);
  const slots: number[] = [];
  for (const s of sorted) if (slots.length === 0 || s - slots.at(-1)! > 1e-3) slots.push(s);
  if (slots.length === 0) slots.push(0);
  const raw = [0];
  for (let i = 1; i < slots.length; i++) raw.push(raw[i - 1]! + pitchWorld * clamp((slots[i]! - slots[i - 1]!) / CANON_SLOT_GAP, 0.5, 1));
  const mid = raw.at(-1)! / 2;
  return { slots, xs: raw.map((x) => centreX + x - mid), slope: pitchWorld / CANON_SLOT_GAP };
}

/** World x of a slot (monotonic, continuous; linear extension with `slope` outside the used range). */
export function stageX(m: StageMap, slot: number): number {
  const n = m.slots.length;
  if (slot <= m.slots[0]!) return m.xs[0]! + (slot - m.slots[0]!) * m.slope;
  if (slot >= m.slots[n - 1]!) return m.xs[n - 1]! + (slot - m.slots[n - 1]!) * m.slope;
  let i = 1;
  while (m.slots[i]! < slot) i++;
  const f = (slot - m.slots[i - 1]!) / (m.slots[i]! - m.slots[i - 1]!);
  return m.xs[i - 1]! + f * (m.xs[i]! - m.xs[i - 1]!);
}

/** Inverse of `stageX` (used by the editor drag handles). */
export function stageSlotOf(m: StageMap, x: number): number {
  const n = m.slots.length;
  if (x <= m.xs[0]!) return m.slots[0]! + (x - m.xs[0]!) / m.slope;
  if (x >= m.xs[n - 1]!) return m.slots[n - 1]! + (x - m.xs[n - 1]!) / m.slope;
  let i = 1;
  while (m.xs[i]! < x) i++;
  const f = (x - m.xs[i - 1]!) / (m.xs[i]! - m.xs[i - 1]!);
  return m.slots[i - 1]! + f * (m.slots[i]! - m.slots[i - 1]!);
}

/** How far the compact stage moves a slot away from where `placeActor` would put it. */
export const stageDx = (m: StageMap, slot: number, bg: Pick<BgInfo, 'width'>) => stageX(m, slot) - slotToX(slot, bg);

const moveRect = (r: Rect, dx: number): Rect => ({ ...r, x: r.x + dx });

/** A placement moved sideways by dx (every x of it). Returns the same object for dx = 0. */
export function shiftPlacement(p: Placement, dx: number): Placement {
  if (dx === 0) return p;
  return {
    ...p,
    feet: { x: p.feet.x + dx, y: p.feet.y },
    pos: { x: p.pos.x + dx, y: p.pos.y },
    headBox: moveRect(p.headBox, dx),
    headCenter: { x: p.headCenter.x + dx, y: p.headCenter.y },
    bodyBox: moveRect(p.bodyBox, dx),
  };
}

export interface StageActor {
  id: string;
  head: Rect;
  depth: number;
  /** Visible head height (hair top to chin) in world units. */
  visH: number;
  /** World y of the eyes. */
  eyeY: number;
}

/**
 * The scene-wide arrangement: head sizes pulled together (framing.sizeEqualize) and eye lines pulled together for the front row
 * (framing.heightEqualize). Scaling is about the head centre, `dy` is added afterwards (the same convention as the shot shifts).
 */
export function stageArrangement(actors: StageActor[], fr: Pick<StyleValues['framing'], 'sizeEqualize' | 'heightEqualize' | 'groupDepthGap'>): Record<string, { dy: number; s: number }> {
  if (actors.length === 0) return {};
  const ref = actors.reduce((q, a) => q + a.visH, 0) / actors.length;
  const lo = Math.min(...actors.map((a) => a.depth));
  const eyes = new Map(
    actors.map((a) => {
      const s = Math.pow(ref / a.visH, fr.sizeEqualize);
      const cy = a.head.y + a.head.h / 2;
      return [a.id, { s, eye: cy + (a.eyeY - cy) * s }] as const;
    }),
  );
  const front = actors.filter((a) => a.depth - lo < fr.groupDepthGap);
  const meanEye = front.reduce((q, a) => q + eyes.get(a.id)!.eye, 0) / front.length;
  const inFront = new Set(front.map((a) => a.id));
  return Object.fromEntries(actors.map((a) => [a.id, { s: eyes.get(a.id)!.s, dy: inFront.has(a.id) ? fr.heightEqualize * (meanEye - eyes.get(a.id)!.eye) : 0 }]));
}

/** A box scaled by `s` about the point c, then moved down by dy. */
export function arrangeRect(r: Rect, c: { x: number; y: number }, a: { dy: number; s: number }): Rect {
  return { x: c.x + (r.x - c.x) * a.s, y: c.y + (r.y - c.y) * a.s + a.dy, w: r.w * a.s, h: r.h * a.s };
}
