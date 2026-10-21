import { describe, expect, it } from 'vitest';
import { GOVERNOR, QualityGovernor } from '../../web/engine/QualityGovernor';

/** Feed `seconds` of frames of the given interval and work time; returns the number of state changes. */
function run(g: QualityGovernor, seconds: number, dtMs: number, workMs: number, active = true): number {
  let changes = 0;
  for (let t = 0; t < seconds * 1000; t += dtMs) if (g.sample(workMs, dtMs, active)) changes++;
  return changes;
}

describe('QualityGovernor', () => {
  it('stays off on a machine that keeps up', () => {
    const g = new QualityGovernor();
    run(g, 60, 16.7, 8);
    expect(g.low).toBe(false);
  });

  it('does not engage on a 30 fps cap or a slow vsync: the interval is long, the work is not', () => {
    const g = new QualityGovernor();
    run(g, 120, 33.3, 6);
    expect(g.low).toBe(false);
  });

  it('engages only after sustained over-budget work, not after one slow spell', () => {
    const g = new QualityGovernor();
    run(g, 3, 33, 30);
    expect(g.low).toBe(false); // less than two windows
    run(g, 2, 16.7, 6); // a good window breaks the streak
    run(g, 3, 33, 30);
    expect(g.low).toBe(false);
    run(g, 6, 33, 30);
    expect(g.low).toBe(true);
  });

  it('ignores stalls and non-travel scenes', () => {
    const g = new QualityGovernor();
    run(g, 60, 33, 30, false);
    expect(g.low).toBe(false);
    for (let i = 0; i < 400; i++) g.sample(40, 500, true); // tab-switch stalls
    expect(g.low).toBe(false);
  });

  it('recovers after a sustained period of headroom, and not before', () => {
    const g = new QualityGovernor();
    run(g, 10, 33, 30);
    expect(g.low).toBe(true);
    run(g, (GOVERNOR.RECOVER_WINDOWS * GOVERNOR.WINDOW_MS) / 1000 - 2, 16.7, 5);
    expect(g.low).toBe(true);
    run(g, 4, 16.7, 12); // above the headroom: the streak restarts
    run(g, 6, 16.7, 5);
    expect(g.low).toBe(true);
    run(g, 6, 16.7, 5);
    expect(g.low).toBe(false);
  });

  it('waits longer each time it comes back soon after a recovery', () => {
    const g = new QualityGovernor();
    const cycle = () => {
      run(g, 10, 33, 30); // engage
      expect(g.low).toBe(true);
      let s = 0;
      while (g.low && s < 400) {
        run(g, 1, 16.7, 5);
        s++;
      }
      return s;
    };
    const first = cycle();
    const second = cycle();
    expect(first).toBeLessThanOrEqual(12);
    expect(second).toBeGreaterThan(first * 1.5);
  });
});
