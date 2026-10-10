import { describe, expect, it } from 'vitest';
import { FAR_SCALE, SCALE_CLAMP, depthScale, feetToSlotDepth, groundY, placeActor, slotToX } from '../../shared/staging/ground';
import { defaultGround, type BgInfo } from '../../shared/staging/world';
import { fakeCalibration } from './helpers/synthetic';

const bg: BgInfo = { width: 2048, height: 1119, ground: defaultGround(2048, 1119) };
const cal = fakeCalibration('m');

describe('ground / placement', () => {
  it('depth scale goes from 1 (front) to the far scale (back)', () => {
    expect(depthScale(0)).toBe(1);
    expect(depthScale(1)).toBeCloseTo(FAR_SCALE);
    expect(depthScale(2)).toBeCloseTo(FAR_SCALE);
    expect(depthScale(-1)).toBe(1);
  });

  it('far actors stand higher on screen (towards the horizon) but never above it', () => {
    let last = Infinity;
    for (const d of [0, 0.2, 0.5, 0.8, 1]) {
      const y = groundY(d, bg.ground);
      expect(y).toBeLessThan(last);
      expect(y).toBeGreaterThan(bg.ground.horizonY);
      last = y;
    }
    expect(groundY(0, bg.ground)).toBeCloseTo(bg.ground.floorY);
  });

  it('perspective is consistent: distance below the horizon is proportional to body scale', () => {
    const near = placeActor(cal, { slot: 0, depth: 0 }, bg);
    const far = placeActor(cal, { slot: 0, depth: 0.8 }, bg);
    const ratioY = (far.feet.y - bg.ground.horizonY) / (near.feet.y - bg.ground.horizonY);
    const ratioK = far.k / near.k;
    expect(ratioK).toBeCloseTo(ratioY, 6);
  });

  it('the model ground anchor lands exactly on the feet point (no floating, no sinking)', () => {
    for (const depth of [0, 0.3, 0.9]) {
      for (const slot of [-1, -0.3, 0.7]) {
        const p = placeActor(cal, { slot, depth }, bg);
        expect(p.pos.x + cal.ground.x * p.k).toBeCloseTo(p.feet.x, 6);
        expect(p.pos.y + cal.ground.y * p.k).toBeCloseTo(p.feet.y, 6);
        expect(p.bodyBox.y + p.bodyBox.h).toBeCloseTo(p.feet.y, 3); // bounds bottom == ground contact
        expect(p.k).toBeGreaterThan(0);
      }
    }
  });

  it('depth only changes size and position, not proportions', () => {
    const a = placeActor(cal, { slot: 0, depth: 0 }, bg);
    const b = placeActor(cal, { slot: 0, depth: 0.5 }, bg);
    expect(b.headBox.h / b.bodyBox.h).toBeCloseTo(a.headBox.h / a.bodyBox.h, 6);
  });

  it('head size is the target head height unless the per-model clamp (0.75..1.3) bites', () => {
    const p = placeActor(cal, { slot: 0, depth: 0 }, bg);
    expect(p.headBox.h).toBeCloseTo(0.1 * 1119, 0);
    // a model whose head is huge for its body is clamped to 1.3x the full-body based scale
    const odd = { ...cal, totalHeight: cal.totalHeight * 3 };
    const q = placeActor(odd, { slot: 0, depth: 0 }, bg);
    const nominal = (0.6 * 1119) / odd.totalHeight;
    expect(q.k).toBeCloseTo(nominal * SCALE_CLAMP.max, 6);
  });

  it('slots map to the left/right of the background, head centre stays above the feet', () => {
    expect(slotToX(-1, bg)).toBeLessThan(slotToX(0, bg));
    expect(slotToX(1, bg)).toBeGreaterThan(slotToX(0, bg));
    expect(slotToX(0, bg)).toBe(1024);
    const p = placeActor(cal, { slot: 0, depth: 0.3 }, bg);
    expect(p.headCenter.y).toBeLessThan(p.feet.y);
  });
});

describe('feetToSlotDepth', () => {
  it('inverts the feet of placeActor for any slot / depth', () => {
    const bg = { width: 2048, height: 1119, ground: { horizonY: 560, floorY: 1040 } };
    const cal = { ground: { x: 100, y: 700 }, head: { bbox: { x: 0, y: 0, w: 100, h: 120 }, center: { x: 50, y: 60 }, height: 120 }, bounds: { x: 0, y: 0, w: 200, h: 700 }, totalHeight: 700 };
    for (const [slot, depth] of [[-0.6, 0.1], [0, 0.5], [0.8, 0.95], [-1, 0]] as const) {
      const f = placeActor(cal, { slot, depth }, bg).feet;
      const r = feetToSlotDepth(f, bg);
      expect(r.slot).toBeCloseTo(slot, 6);
      expect(r.depth).toBeCloseTo(depth, 6);
    }
    expect(feetToSlotDepth({ x: -500, y: 5000 }, bg)).toEqual({ slot: -1, depth: 0 });
  });
});
