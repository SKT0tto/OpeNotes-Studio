import { describe, expect, it } from 'vitest';
import { findBeats } from '../../shared/agent/compact';
import { directedProject } from './helpers/directorFlow';

describe('find_beats: a quote remembered slightly wrong still finds its line', () => {
  it('falls back to an approximate match, best first', () => {
    const p = directedProject();
    const b = p.scenes[2]!.beats.find((x) => [...x.text].length >= 8 && x.kind === 'dialogue')!;
    const chars = [...b.text.replace(/[「」“”…。，、！？!?,.\s]/g, '')];
    const misquote = [...chars.slice(0, 3), ...chars.slice(4, 9)].join(''); // one character dropped
    const r = findBeats(p, { text: misquote });
    expect(r[0]?.beatId).toBe(b.id);
    expect(r[0]?.approx).toBeGreaterThan(0.7);
    expect(findBeats(p, { text: '完全不存在的一句话啊' })).toEqual([]);
  });
});

describe('scene table: what blurs or shifts the picture is visible', () => {
  it('shows depth of field and per-person offsets next to the shot size', async () => {
    const { sceneTable } = await import('../../shared/agent/compact');
    const p = directedProject();
    const b = p.scenes[2]!.beats[2]!;
    b.shot.dof = 6;
    b.shot.offsets = { [b.shot.focus[0] ?? 'c_001']: { x: 0.7, y: 0 } };
    const row = sceneTable(p, 's_3').split('\n').find((l) => l.includes(b.id))!;
    expect(row).toContain(`${b.shot.type}·景深6·偏移(`);
    expect(row).toContain('+0.7');
  });
});
