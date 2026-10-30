import { describe, expect, it } from 'vitest';
import {
  DEFAULT_BACKGROUND_PREFS, DIM_MAX, hubImageUrl, parseBackgroundPrefs, resolveHubBackground, serializeBackgroundPrefs,
} from '../../web/editor/hubBackgroundLogic';

const bgs = [{ id: 'bg_a', url: '/a.png' }, { id: 'bg_b', url: '/b.png' }];

describe('background prefs', () => {
  it('falls back to 自动 on missing or broken data', () => {
    for (const raw of [null, '', 'nope', '42', 'null', '[1]', '{"mode":"weird"}']) expect(parseBackgroundPrefs(raw)).toEqual(DEFAULT_BACKGROUND_PREFS);
  });
  it('round-trips each mode', () => {
    for (const p of [{ mode: 'auto', dim: 0 }, { mode: 'gradient', dim: 0.3 }, { mode: 'image', dim: 0.1 }, { mode: 'asset', asset: 'bg_a', dim: 0.5 }] as const) {
      expect(parseBackgroundPrefs(serializeBackgroundPrefs(p))).toEqual(p);
    }
  });
  it('an asset choice without a valid id becomes 自动, keeping the dim', () => {
    expect(parseBackgroundPrefs('{"mode":"asset","dim":0.2}')).toEqual({ mode: 'auto', dim: 0.2 });
    expect(parseBackgroundPrefs('{"mode":"asset","asset":"../../etc/passwd"}')).toEqual({ mode: 'auto', dim: 0 });
  });
  it('clamps and repairs the dim', () => {
    expect(parseBackgroundPrefs('{"mode":"auto","dim":9}').dim).toBe(DIM_MAX);
    expect(parseBackgroundPrefs('{"mode":"auto","dim":-1}').dim).toBe(0);
    expect(parseBackgroundPrefs('{"mode":"auto","dim":"x"}').dim).toBe(0);
  });
});

describe('resolveHubBackground', () => {
  const p = (mode: 'auto' | 'asset' | 'image' | 'gradient', asset?: string) => ({ mode, ...(asset ? { asset } : {}), dim: 0 });
  it('自动 and 纯色 do not look at the sources', () => {
    expect(resolveHubBackground(p('auto'), null, null)).toEqual({ kind: 'auto' });
    expect(resolveHubBackground(p('gradient'), bgs, { exists: true })).toEqual({ kind: 'gradient' });
  });
  it('picks the library background, or falls back to 自动 when it is gone', () => {
    expect(resolveHubBackground(p('asset', 'bg_b'), bgs, null)).toEqual({ kind: 'asset', url: '/b.png' });
    expect(resolveHubBackground(p('asset', 'bg_zzz'), bgs, null)).toEqual({ kind: 'auto' });
  });
  it('waits (gradient, no url) while the catalogue is loading', () => {
    expect(resolveHubBackground(p('asset', 'bg_a'), null, null)).toEqual({ kind: 'asset', url: null });
  });
  it('uses the personal picture with a cache-busting version, or falls back to 自动 when the file is gone', () => {
    expect(resolveHubBackground(p('image'), bgs, { exists: true, version: '123' })).toEqual({ kind: 'image', url: hubImageUrl({ exists: true, version: '123' }) });
    expect(hubImageUrl({ exists: true, version: '123' })).toBe('/api/hub/background/image?v=123');
    expect(resolveHubBackground(p('image'), bgs, { exists: false })).toEqual({ kind: 'auto' });
    expect(resolveHubBackground(p('image'), bgs, null)).toEqual({ kind: 'image', url: null });
  });
});
