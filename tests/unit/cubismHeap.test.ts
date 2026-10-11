import { describe, expect, it } from 'vitest';
import { clampCubismMemoryMB, DEFAULT_CUBISM_MEMORY_MB, MAX_CUBISM_MEMORY_MB, MIN_CUBISM_MEMORY_MB, staleModelIds } from '../../shared/cubismHeap';
import { resolveConfig } from '../../server/config';

describe('Cubism Core heap size', () => {
  it('defaults to 256 MB and never below the 64 MB floor', () => {
    expect(DEFAULT_CUBISM_MEMORY_MB).toBeGreaterThanOrEqual(256);
    expect(clampCubismMemoryMB(undefined)).toBe(256);
    expect(clampCubismMemoryMB('abc')).toBe(256);
    expect(clampCubismMemoryMB(NaN)).toBe(256);
    expect(clampCubismMemoryMB(8)).toBe(MIN_CUBISM_MEMORY_MB);
    expect(clampCubismMemoryMB(100000)).toBe(MAX_CUBISM_MEMORY_MB);
    expect(clampCubismMemoryMB(512)).toBe(512);
    expect(clampCubismMemoryMB('384')).toBe(384);
  });

  it('is configurable: environment beats studio.config.json beats the default', () => {
    expect(resolveConfig({}, {}).cubismMemoryMB).toBe(256);
    expect(resolveConfig({}, { cubismMemoryMB: 128 }).cubismMemoryMB).toBe(128);
    expect(resolveConfig({ CUBISM_MEMORY_MB: '512' }, { cubismMemoryMB: 128 }).cubismMemoryMB).toBe(512);
    expect(resolveConfig({ CUBISM_MEMORY_MB: '' }, { cubismMemoryMB: 128 }).cubismMemoryMB).toBe(128);
    expect(resolveConfig({ CUBISM_MEMORY_MB: '5' }).cubismMemoryMB).toBe(64);
  });
});

describe('staleModelIds', () => {
  const heapA = {};
  const heapB = {};
  it('is empty while every model shares the newest heap', () => {
    expect(staleModelIds([])).toEqual([]);
    expect(staleModelIds([{ id: 'a', seq: 1, token: heapA }, { id: 'b', seq: 2, token: heapA }])).toEqual([]);
  });
  it('reports every model created before a heap re-allocation', () => {
    const entries = [
      { id: 'a', seq: 1, token: heapA },
      { id: 'b', seq: 2, token: heapA },
      { id: 'c', seq: 3, token: heapB },
      { id: 'd', seq: 4, token: heapB },
    ];
    expect(staleModelIds(entries)).toEqual(['a', 'b']);
  });
  it('judges by creation order, not by the order the list is given in or models finished loading', () => {
    const entries = [
      { id: 'late-finisher', seq: 1, token: heapA },
      { id: 'new', seq: 5, token: heapB },
    ];
    expect(staleModelIds([...entries].reverse())).toEqual(['late-finisher']);
  });
  it('ignores models without a heap view', () => {
    expect(staleModelIds([{ id: 'a', seq: 1, token: null }, { id: 'b', seq: 2, token: heapA }])).toEqual([]);
    expect(staleModelIds([{ id: 'a', seq: 1, token: null }])).toEqual([]);
  });
});
