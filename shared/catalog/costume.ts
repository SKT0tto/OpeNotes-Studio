/** Costume-string parsing. Operates on model ids / costume strings, never on files. */

export type CostumeBase = 'casual' | 'school' | 'roomwear' | 'live' | 'suits' | 'virtual' | 'other';

export interface CostumeInfo {
  base: CostumeBase;
  season?: 'spring' | 'summer' | 'winter';
  school?: 'hs' | 'jhs';
  grade?: 1 | 2 | 3;
  glasses: boolean;
  quality: '' | 'low';
  mode: 'adv' | 'live';
  still: boolean;
  /** Remaining descriptive tokens (hairdown, hat, mask, silhouette, arbeit, ...). */
  tags: string[];
}

/** First tokens of the costume part of a model id; used to split `sub_<name>_<costume>`. */
const COSTUME_START = new Set([
  'casual', 'school', 'live', 'live-mode', 'roomwear', 'suits', 'virtual', 'arbeit', 'caretaker',
  'detective', 'idol', 'birthday2627', 'child', 'soundonly', 'jhs', 'sweat', '01',
]);

export interface ModelIdParts {
  characterKey: string;
  costume: string;
  isSub: boolean;
}

/** `001_casual_spring_01` -> key 001; `sub_a_ko_school_winter_hs` -> key sub_a_ko. */
export function splitModelId(id: string): ModelIdParts {
  const tokens = id.split('_');
  if (tokens[0] === 'sub') {
    let i = 2;
    while (i < tokens.length && !COSTUME_START.has(tokens[i]!)) i++;
    if (i >= tokens.length) i = Math.min(2, tokens.length);
    return { characterKey: tokens.slice(0, i).join('_'), costume: tokens.slice(i).join('_'), isSub: true };
  }
  return { characterKey: tokens[0] ?? id, costume: tokens.slice(1).join('_'), isSub: false };
}

const BASES: Record<string, CostumeBase> = {
  casual: 'casual', school: 'school', roomwear: 'roomwear', live: 'live', 'live-mode': 'live',
  suits: 'suits', virtual: 'virtual',
};

export function parseCostume(costume: string): CostumeInfo {
  let tokens = costume.split('_').filter(Boolean);
  const info: CostumeInfo = { base: 'other', glasses: false, quality: '', mode: 'adv', still: false, tags: [] };

  if (tokens[tokens.length - 1] === 'low') {
    info.quality = 'low';
    tokens = tokens.slice(0, -1);
  }
  if (tokens[tokens.length - 1] === 'still') {
    info.still = true;
    tokens = tokens.slice(0, -1);
  }
  if (tokens[0] === 'live-mode') info.mode = 'live';

  let baseSet = false;
  for (const tok of tokens) {
    if (tok in BASES) {
      // 'live-mode_live_01': the second 'live' repeats the base, it is not a tag.
      if (!baseSet) info.base = BASES[tok]!;
      baseSet = true;
    } else if (tok === 'spring' || tok === 'summer' || tok === 'winter') info.season = tok;
    else if (tok === 'hs' || tok === 'jhs') {
      info.school = tok;
      // NPC middle-schoolers appear as `jhs_casual_...`: base comes from the next token.
    } else if (/^[123](st|nd|rd)$/.test(tok)) info.grade = Number(tok[0]) as 1 | 2 | 3;
    else if (tok === 'glasses') info.glasses = true;
    else if (/^\d+$/.test(tok) || tok === 'live-mode') continue;
    else info.tags.push(tok);
  }
  if (info.base === 'other' && info.school && tokens.includes('casual')) info.base = 'casual';
  return info;
}

/** Short human label, e.g. "school · winter · hs · 1st · glasses". */
export function costumeLabel(info: CostumeInfo): string {
  const parts: string[] = [info.base === 'other' ? (info.tags[0] ?? 'other') : info.base];
  if (info.season) parts.push(info.season);
  if (info.school) parts.push(info.school);
  if (info.grade) parts.push(`${info.grade}年`);
  if (info.glasses) parts.push('glasses');
  for (const t of info.base === 'other' ? info.tags.slice(1) : info.tags) parts.push(t);
  if (info.still) parts.push('still');
  return parts.join(' · ');
}
