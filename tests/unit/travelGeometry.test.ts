import { describe, expect, it } from 'vitest';
import { driftEnd, pushAbout, settleStart, travelPose } from '../../shared/staging/travel';
import { defaultGround, viewWorldHeight, type BgInfo, type CameraPose } from '../../shared/staging/world';
import type { CameraTravel } from '../../shared/timeline/types';

type Pt2 = { x: number; y: number };
const bg: BgInfo = { width: 2048, height: 1119, ground: defaultGround(2048, 1119) };
const A = 16 / 9;
const a: CameraPose = { x: 900, y: 560, zoom: 1.4 };
const b: CameraPose = { x: 1000, y: 540, zoom: 2.2 };
const F = { x: 950, y: 500 };
const tr: CameraTravel = { kind: 'distance', anchor: F };
const screen = (p: Pt2, cam: CameraPose) => ({ x: (p.x - cam.x) * cam.zoom, y: (p.y - cam.y) * cam.zoom });

describe('travel geometry', () => {
  it('endpoints equal the two static poses and carry no background fields', () => {
    const p0 = travelPose(a, b, 0, tr);
    const p1 = travelPose(a, b, 1, tr);
    for (const k of ['x', 'y', 'zoom'] as const) {
      expect(p0[k]).toBeCloseTo(a[k], 9);
      expect(p1[k]).toBeCloseTo(b[k], 9);
    }
    expect(p0.bgX).toBeUndefined();
    expect(p0.bgZoom).toBeUndefined();
  });

  it('the anchor moves on a straight line on screen', () => {
    const s0 = screen(F, a);
    const s1 = screen(F, b);
    for (const e of [0.2, 0.5, 0.8]) {
      const s = screen(F, travelPose(a, b, e, tr));
      expect(s.x).toBeCloseTo(s0.x + (s1.x - s0.x) * e, 6);
      expect(s.y).toBeCloseTo(s0.y + (s1.y - s0.y) * e, 6);
    }
  });

  it('settleStart keeps the anchor in place and pulls back by k (no clamping)', () => {
    const k = 1.06;
    const mid: CameraPose = { x: 1024, y: 560, zoom: 2 };
    const Fm = { x: 1030, y: 560 };
    const q = settleStart(mid, Fm, k);
    expect(q.zoom).toBeCloseTo(mid.zoom / k, 9);
    const m0 = screen(Fm, mid);
    const m1 = screen(Fm, q);
    expect(m1.x).toBeCloseTo(m0.x, 6);
    expect(m1.y).toBeCloseTo(m0.y, 6);
    const edge = settleStart({ x: 20, y: 560, zoom: 2 }, { x: 20, y: 560 }, k);
    expect(edge.x).toBeCloseTo(20, 9);
  });

  it('pushAbout keeps the anchor in place and is undone by the inverse factor', () => {
    const q = pushAbout(a, F, 1.1);
    expect(q.zoom).toBeCloseTo(a.zoom * 1.1, 9);
    expect(screen(F, q).x).toBeCloseTo(screen(F, a).x, 6);
    expect(screen(F, q).y).toBeCloseTo(screen(F, a).y, 6);
    const back = pushAbout(q, F, 1 / 1.1);
    for (const f of ['x', 'y', 'zoom'] as const) expect(back[f]).toBeCloseTo(a[f], 9);
  });

  it('driftEnd moves sideways by share of the frame width and pushes in', () => {
    const e = driftEnd({ x: 1024, y: 560, zoom: 1 }, 1, 0.04, 1.04, bg, A);
    expect(e.zoom).toBeCloseTo(1.04, 9);
    expect(e.x - 1024).toBeCloseTo(0.04 * viewWorldHeight(bg) * A, 9);
    expect(driftEnd({ x: 1024, y: 560, zoom: 1 }, -1, 0.04, 1.04, bg, A).x).toBeLessThan(1024);
  });
});
