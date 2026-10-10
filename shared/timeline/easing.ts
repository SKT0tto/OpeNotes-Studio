export const EASE_NAMES = ['linear', 'inQuad', 'outQuad', 'inOutQuad', 'inOutSine', 'outCubic'] as const;
export type EaseName = (typeof EASE_NAMES)[number];

const FNS: Record<EaseName, (t: number) => number> = {
  linear: (t) => t,
  inQuad: (t) => t * t,
  outQuad: (t) => 1 - (1 - t) * (1 - t),
  inOutQuad: (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2),
  inOutSine: (t) => -(Math.cos(Math.PI * t) - 1) / 2,
  outCubic: (t) => 1 - Math.pow(1 - t, 3),
};

/** Eased progress for t in [0,1] (clamped). */
export function ease(name: EaseName, t: number): number {
  return FNS[name](Math.min(1, Math.max(0, t)));
}

export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
