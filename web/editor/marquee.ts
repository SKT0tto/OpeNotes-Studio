/** Marquee (box) selection of beats: the pure parts (rectangles, hit-testing, edge auto-scroll, how the hit set merges into the selection). */
import { sortByOrder, type BeatPick } from '@shared/agent/selection';

export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}
export interface Pt {
  x: number;
  y: number;
}
export interface Item {
  id: string;
  rect: Rect;
}

/** Movement (px) below which a press is still a click, not a drag. */
export const DRAG_THRESHOLD = 4;

export const normRect = (a: Pt, b: Pt): Rect => ({ left: Math.min(a.x, b.x), top: Math.min(a.y, b.y), right: Math.max(a.x, b.x), bottom: Math.max(a.y, b.y) });

/** True when the rectangles overlap or touch (a box that merely grazes an item selects it). */
export const touches = (a: Rect, b: Rect): boolean => a.left <= b.right && a.right >= b.left && a.top <= b.bottom && a.bottom >= b.top;

export const exceedsThreshold = (from: Pt, to: Pt, threshold = DRAG_THRESHOLD): boolean => Math.hypot(to.x - from.x, to.y - from.y) >= threshold;

/** The ids of every item the band touches, in item order. */
export const hitItems = (band: Rect, items: readonly Item[]): string[] => items.filter((it) => touches(band, it.rect)).map((it) => it.id);

/** Scroll step (px per frame, negative = up) while the pointer is within `edge` of the viewport's top / bottom or beyond it; speeds up the further out it is. */
export function autoScrollDelta(pointerY: number, viewTop: number, viewBottom: number, edge = 36, max = 22): number {
  if (pointerY < viewTop + edge) return -Math.min(max, Math.max(2, ((viewTop + edge - pointerY) / edge) * max));
  if (pointerY > viewBottom - edge) return Math.min(max, Math.max(2, ((pointerY - (viewBottom - edge)) / edge) * max));
  return 0;
}

/** Elements a marquee must never start on: the user is working with them (text fields, buttons, selects) or they have their own drag. */
export const NO_MARQUEE_SELECTOR = 'input, textarea, select, button, a, label, [contenteditable=""], [contenteditable="true"], [draggable="true"], .o-edit';

/** The multi-selection while / after dragging a band. `add` keeps the selection the drag started from (Ctrl / Shift). */
export function marqueePick(order: string[], base: BeatPick, hit: string[], add: boolean): BeatPick {
  const start = base.ids.length > 0 ? base.ids : base.primary ? [base.primary] : [];
  const ids = sortByOrder(order, add ? [...start, ...hit] : hit);
  return { ids, primary: base.primary };
}

/** The primary beat once the drag ends: the last touched beat in script order, otherwise it stays. */
export function marqueePrimary(order: string[], pick: BeatPick, hit: string[]): string | null {
  const sorted = sortByOrder(order, hit);
  return sorted.length > 0 ? sorted.at(-1)! : pick.primary;
}
