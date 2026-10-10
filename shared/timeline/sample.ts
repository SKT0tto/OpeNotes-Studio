import { ease, lerp, type EaseName } from './easing';

interface Timed {
  at: number;
  duration: number;
  ease: EaseName;
}

/**
 * Sample a list of "go to value over `duration` starting at `at`" keys (sorted by `at`).
 * Before the first key the value is `initial`; each key starts from the previous key's final value.
 */
export function sampleKeys<K extends Timed, V>(keys: readonly K[], t: number, initial: V, valueOf: (k: K) => V, blend: (a: V, b: V, e: number) => V): V {
  let cur = initial;
  for (const k of keys) {
    if (t < k.at) return cur;
    const v = valueOf(k);
    if (k.duration > 0 && t < k.at + k.duration) return blend(cur, v, ease(k.ease, (t - k.at) / k.duration));
    cur = v;
  }
  return cur;
}

export const sampleNum = <K extends Timed & { value: number }>(keys: readonly K[], t: number, initial: number) =>
  sampleKeys(keys, t, initial, (k) => k.value, lerp);

/** Last event whose `at` <= t (events sorted by `at`), or null. */
export function lastBefore<E extends { at: number }>(events: readonly E[], t: number): E | null {
  let found: E | null = null;
  for (const e of events) {
    if (e.at <= t) found = e;
    else break;
  }
  return found;
}

/** Keys must not overlap: clip each key's duration to the start of the next one. */
export function clipOverlaps<K extends Timed>(keys: K[]): K[] {
  const sorted = [...keys].sort((a, b) => a.at - b.at);
  return sorted.map((k, i) => {
    const next = sorted[i + 1];
    return next && k.at + k.duration > next.at ? { ...k, duration: Math.max(0, next.at - k.at) } : k;
  });
}
