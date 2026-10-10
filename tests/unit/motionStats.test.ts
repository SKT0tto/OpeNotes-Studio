import { describe, expect, it } from 'vitest';
import { computeMotionStats, curvePoints, paramStat } from '../../server/assets/motionStats';

describe('curvePoints', () => {
  it('reads linear, stepped and bezier end points', () => {
    // start (0,1); linear to (1,3); bezier to (2,5); stepped to (3,5); inverse-stepped to (4,0)
    const seg = [0, 1, 0, 1, 3, 1, 1.2, 3, 1.5, 4, 2, 5, 2, 3, 5, 3, 4, 0];
    expect(curvePoints(seg)).toEqual([[0, 1], [1, 3], [2, 5], [3, 5], [4, 0]]);
  });
  it('tolerates truncated data', () => {
    expect(curvePoints([0, 1, 1, 0.5, 2])).toEqual([[0, 1]]);
    expect(curvePoints([])).toEqual([]);
  });
});

describe('paramStat', () => {
  it('computes first value and time-weighted mean', () => {
    expect(paramStat([0, 0, 0, 2, 10])).toEqual({ first: 0, mean: 5 });
    expect(paramStat([0, 7])).toEqual({ first: 7, mean: 7 });
    expect(paramStat(undefined)).toBeNull();
  });
});

describe('computeMotionStats', () => {
  it('extracts meta and the three orientation parameters', () => {
    const s = computeMotionStats({
      Meta: { Duration: 6, Fps: 30, Loop: false },
      Curves: [
        { Id: 'ParamAngleX', Segments: [0, 22, 0, 6, 22] },
        { Id: 'ParamEyeBallX', Segments: [0, -0.2, 0, 6, -0.2] },
        { Id: 'ParamBreath', Segments: [0, 1, 0, 6, 1] },
      ],
    });
    expect(s).toMatchObject({ duration: 6, fps: 30, loop: false, angleX: { first: 22, mean: 22 }, bodyAngleX: null });
    expect(s.eyeBallX?.first).toBeCloseTo(-0.2);
  });
});
