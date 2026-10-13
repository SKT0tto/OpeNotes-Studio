/**
 * P20-2: ONE place that says which background may be picked by whom. decor (logo, plain colour, UI screenshots) is never chosen
 * automatically; insert (sky, signal, crossing ...) only for insert shots; event (dream, virtual stage) only with a textual cue;
 * a duplicate copy is never chosen (its master is).
 */
import { BG_CATEGORIES, type BgCategory } from '../schema/assetLabels';
import type { BackgroundEntry } from '../schema/assets';

export type BgUse = 'scene' | 'insert' | 'event';
export type CategorisedBg = Pick<BackgroundEntry, 'id' | 'kind'> & { labels?: BackgroundEntry['labels'] | undefined; category?: string | null | undefined };

/** The category of a background: the label's, else the entry's, else inferred (card 1..13 = decor, everything else = scene). */
export function bgCategoryOf(b: CategorisedBg): BgCategory {
  const c = b.labels?.category ?? b.category;
  if (c && (BG_CATEGORIES as readonly string[]).includes(c)) return c as BgCategory;
  if (b.kind === 'card' && /^\d+$/.test(b.id) && Number(b.id) >= 1 && Number(b.id) <= 13) return 'decor';
  return 'scene';
}

export const isDuplicateCopy = (b: CategorisedBg): boolean => !!b.labels?.duplicateOf;

/** Automatic selection (AI candidates, validation repair, rule director). */
export function autoSelectable(b: CategorisedBg, use: BgUse = 'scene'): boolean {
  if (isDuplicateCopy(b)) return false;
  const c = bgCategoryOf(b);
  if (c === 'decor') return false;
  if (c === 'insert') return use === 'insert';
  if (c === 'event') return use === 'event';
  return true;
}

/** Manual selection in the editor: decor only when the "show decor" switch is on. */
export function manualSelectable(b: CategorisedBg, showDecor: boolean): boolean {
  return showDecor || bgCategoryOf(b) !== 'decor';
}

/** Cue words in the story that allow an `event` background (dream, memory, virtual space ...). */
export const EVENT_CUE = /梦|回忆|幻觉|幻想|虚拟|异世界|舞台剧|闪回|恍惚/;
