/**
 * P20-0: merge the content pass (title / description / category / tags per background, plus review suggestions) into the label file.
 * Pure and idempotent. It fills the content fields only: bands / owner / residents / placeName / location of an entry are never touched
 * for `source: 'user'` entries, and review `fixes` are stored as pending suggestions - they are never applied to a field.
 */
import { BgLabelSchema, BG_CATEGORIES, type BgCategory, type BgFix, type BgLabel, type LabelFile } from '../schema/assetLabels';

export interface BgContentEntry {
  title: string;
  description: string;
  category: BgCategory;
  tags: string[];
  fixes?: BgFix[] | null;
  isNew?: boolean;
  suggestedLabel?: Record<string, unknown>;
}
export type BgContent = Record<string, BgContentEntry>;

/** Pairs (a, b) of the review's duplicate table. A numeric id 1..28 is the copy of the adv id; for two adv ids the higher one is the copy. */
export const DUPLICATE_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['23', '001'], ['24', '004'], ['25', '010'], ['27', '024'], ['26', '027'], ['19', '049'], ['18', '064'], ['17', '072'], ['16', '146'],
  ['14', '153'], ['15', '177'], ['147', '219'], ['20', '257'], ['21', '259'], ['112', '276'], ['22', '277'], ['311', '312'], ['217', '333'],
];
export const advId = (n: string) => `adv_bkg_stage_${n.padStart(6, '0')}`;

/** [copy, master] pairs resolved to catalog ids. */
export function duplicateLinks(): Array<[string, string]> {
  return DUPLICATE_PAIRS.map(([a, b]) => {
    const numeric = /^\d+$/.test(a) && Number(a) >= 1 && Number(a) <= 28 && a.length <= 2;
    return numeric ? ([a, advId(b)] as [string, string]) : ([advId(b), advId(a)] as [string, string]);
  });
}

export interface ImportSummary {
  total: number;
  updated: number;
  added: number;
  fixesQueued: number;
  duplicatesLinked: number;
  userUntouched: number;
  changed: string[];
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export function mergeBgContent(file: LabelFile, content: BgContent, now = new Date().toISOString().slice(0, 10)): ImportSummary {
  const sum: ImportSummary = { total: Object.keys(content).length, updated: 0, added: 0, fixesQueued: 0, duplicatesLinked: 0, userUntouched: 0, changed: [] };
  for (const [id, c] of Object.entries(content)) {
    if (!BG_CATEGORIES.includes(c.category)) throw new Error(`bg ${id}: bad category ${String(c.category)}`);
    let label = file.labels[id];
    if (!label) {
      if (!c.suggestedLabel) throw new Error(`bg ${id}: no label and no suggestedLabel`);
      label = BgLabelSchema.parse({ source: 'draft', updatedAt: now, ...c.suggestedLabel });
      file.labels[id] = label;
      sum.added++;
    }
    const before = JSON.stringify(label);
    label.title = c.title;
    label.description = c.description;
    label.category = c.category;
    label.tags = [...c.tags];
    const pending = (c.fixes ?? []).filter((f) => f.suggest || f.question);
    const prev = label.fixes ?? [];
    // keep fixes the user already handled out of the queue: a fix removed from the label stays removed (matched by field + suggestion)
    if (prev.length === 0 && pending.length > 0 && !label.fixesImported) {
      label.fixes = pending.map((f) => ({ ...f }));
      sum.fixesQueued += pending.length;
    }
    if (pending.length > 0 || label.fixes) label.fixesImported = true;
    if (label.source === 'user') sum.userUntouched++;
    if (JSON.stringify(label) !== before) {
      sum.updated++;
      sum.changed.push(id);
    }
  }
  for (const [copy, master] of duplicateLinks()) {
    const a = file.labels[copy];
    const b = file.labels[master];
    if (!a || !b) continue;
    // only a true duplicate of the same ownership: never relate two differently owned places
    if (!same([...a.bands].sort(), [...b.bands].sort()) || (a.owner ?? null) !== (b.owner ?? null)) continue;
    if (a.duplicateOf !== master) {
      a.duplicateOf = master;
      sum.duplicatesLinked++;
    }
  }
  return sum;
}

export const isPendingFix = (f: BgFix) => !!(f.suggest || f.question);
export type { BgLabel };
