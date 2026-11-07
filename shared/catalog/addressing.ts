/**
 * How characters address each other and themselves (`shared/data/addressing.json`, from the 称呼一览 of public character pages).
 * Notation of a cell: `A→B` changed over the story (B is the current form), `A/B` = A to 睦 / B to Mortis (the part before the first `/` is
 * the persona used here; `-` = none), `A、B` = several forms in use at once (the first is the default). `use` overrides the default of a pair.
 * Unknown speaker or pair: null / [] (never a guess).
 */
import data from '../data/addressing.json';

interface Person {
  self?: string;
  to?: Record<string, string>;
  use?: Record<string, string>;
  external?: Record<string, string>;
}
const PEOPLE = data.people as unknown as Record<string, Person>;

/** `私（わたくし）` -> `わたくし`: a form with a reading is spoken as the reading. */
function normalize(form: string): string {
  const t = form.trim();
  const m = /^(.*?)[（(]([^）)]+)[）)]$/.exec(t);
  return m?.[2] ? m[2].trim() : t;
}

/** The persona part of a cell (before the first `/`), its last `→` step, split on `、`. */
function defaultOf(cell: string | undefined): string | null {
  if (!cell) return null;
  const persona = cell.split('/')[0]!.trim();
  if (!persona || persona === '-') return null;
  const step = persona.split('→').pop()!;
  const first = step.split('、')[0]!.trim();
  return first && first !== '-' ? normalize(first) : null;
}

function allOf(cell: string | undefined): string[] {
  if (!cell) return [];
  const out: string[] = [];
  for (const raw of cell.split(/[→/、]/)) {
    const f = raw.trim();
    if (!f || f === '-') continue;
    const n = normalize(f);
    if (n && !out.includes(n)) out.push(n);
  }
  return out;
}

/** The default form `from` uses for `to` (character keys), or null. */
export function addressForm(from: string, to: string): string | null {
  const p = PEOPLE[from];
  if (!p) return null;
  const used = p.use?.[to];
  if (used) return normalize(used);
  return defaultOf(p.to?.[to]);
}

/** Every form in that cell, for reference. */
export function addressForms(from: string, to: string): string[] {
  const p = PEOPLE[from];
  return p ? allOf(p.to?.[to]) : [];
}

/** Forms listed next to others with `、` in the persona part of the cell (used at the same time as the default); the default itself is left out. */
export function addressAlternatives(from: string, to: string): string[] {
  const cell = PEOPLE[from]?.to?.[to];
  if (!cell) return [];
  const def = addressForm(from, to);
  const out: string[] = [];
  for (const step of cell.split('/')[0]!.split('→')) {
    const group = step.split('、').map((s) => s.trim()).filter((s) => s && s !== '-');
    if (group.length < 2) continue;
    for (const g of group) {
      const n = normalize(g);
      if (n !== def && !out.includes(n)) out.push(n);
    }
  }
  return out;
}

/** The default first-person word of a character, or null. */
export function selfForm(key: string): string | null {
  return defaultOf(PEOPLE[key]?.self);
}

/** Every first-person form of a character. */
export function selfForms(key: string): string[] {
  return allOf(PEOPLE[key]?.self);
}
