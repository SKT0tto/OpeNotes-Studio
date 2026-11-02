/** Playback speeds offered in the speed menus (editor preview and play page); anything else is a custom speed. */
export const RATE_PRESETS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4] as const;
export const RATE_MIN = 0.1;
export const RATE_MAX = 8;

/** A typed speed ("1.3", "1.3x", "1.3×", "130%") as a rate within RATE_MIN..RATE_MAX, rounded to 0.05; null when it is not a number. */
export function parseRate(text: string): number | null {
  const t = text.trim().replace(/[x×倍]$/i, '').trim();
  const pct = /%$/.test(t);
  const n = Number(pct ? t.slice(0, -1) : t);
  if (!t || !Number.isFinite(n) || n <= 0) return null;
  const r = pct ? n / 100 : n;
  return Math.min(RATE_MAX, Math.max(RATE_MIN, Math.round(r * 20) / 20));
}

/** "1.25×" without trailing zeros. */
export const formatRate = (r: number): string => `${Number(r.toFixed(2))}×`;

export const isPreset = (r: number): boolean => (RATE_PRESETS as readonly number[]).includes(r);
