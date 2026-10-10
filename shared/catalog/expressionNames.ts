/** Expression name parsing (raw names are always kept). */

export interface ExpressionName {
  raw: string;
  /** `exp_bsmile02` -> family `bsmile`, index 2. */
  family: string;
  index: number | null;
}

export function parseExpressionName(raw: string): ExpressionName {
  const stem = raw.startsWith('exp_') ? raw.slice(4) : raw;
  const m = /^(.*?)(\d+)$/.exec(stem);
  if (!m) return { raw, family: stem, index: null };
  return { raw, family: m[1]!, index: Number(m[2]) };
}
