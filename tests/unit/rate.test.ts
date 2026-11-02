import { describe, expect, it } from 'vitest';
import { RATE_MAX, RATE_MIN, formatRate, isPreset, parseRate } from '../../web/ui/rate';

describe('playback speed menu', () => {
  it('reads typed speeds in the usual forms, rounded to 0.05 and clamped', () => {
    expect(parseRate('1.3')).toBe(1.3);
    expect(parseRate(' 1.3x ')).toBe(1.3);
    expect(parseRate('1.3×')).toBe(1.3);
    expect(parseRate('2倍')).toBe(2);
    expect(parseRate('130%')).toBe(1.3);
    expect(parseRate('1.33')).toBe(1.35);
    expect(parseRate('20')).toBe(RATE_MAX);
    expect(parseRate('0.01')).toBe(RATE_MIN);
  });
  it('refuses what is not a speed', () => {
    for (const t of ['', 'abc', '0', '-1', 'x']) expect(parseRate(t)).toBeNull();
  });
  it('formats without trailing zeros and knows its presets', () => {
    expect(formatRate(1.25)).toBe('1.25×');
    expect(formatRate(2)).toBe('2×');
    expect(isPreset(1.5)).toBe(true);
    expect(isPreset(1.3)).toBe(false);
  });
});
