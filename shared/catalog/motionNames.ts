/** Motion name parsing. Raw names are always kept; parsing is best-effort. */

export interface MotionName {
  raw: string;
  /** Normalised name (percent-decoding applied, trimmed). */
  name: string;
  /** e.g. `nod01` for `mtn_nod01_L`; irregular names keep their whole stem. */
  family: string;
  side: 'L' | 'C' | 'R' | null;
  /** Suffix digits after the side (`R2` -> "2") or trailing tag (`omit`). */
  variant: string;
}

function decode(raw: string): string {
  try {
    return decodeURIComponent(raw).trim();
  } catch {
    return raw.trim();
  }
}

const SIDE_RE = /^(.+?)_([LCR])(\d*)(?:_(.+))?$/;

export function parseMotionName(raw: string): MotionName {
  const name = decode(raw);
  const stem = name.startsWith('mtn_') ? name.slice(4) : name;
  const m = SIDE_RE.exec(stem);
  if (!m) return { raw, name, family: stem, side: null, variant: '' };
  return {
    raw,
    name,
    family: m[1]!,
    side: m[2] as 'L' | 'C' | 'R',
    variant: [m[3], m[4]].filter(Boolean).join('_'),
  };
}
