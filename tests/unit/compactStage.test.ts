import { describe, expect, it } from 'vitest';
import { arrangeRect, buildStageMap, shiftPlacement, stageArrangement, stageDx, stageSlotOf, stageX } from '../../shared/staging/compactStage';
import { placeActor, slotToX } from '../../shared/staging/ground';
import { defaultGround, type BgInfo } from '../../shared/staging/world';
import { OURNOTES_STYLE } from '../../shared/style/ournotes';
import { fakeCalibration } from './helpers/synthetic';

const bg: BgInfo = { width: 2048, height: 1119, ground: defaultGround(2048, 1119) };

describe('compact stage', () => {
  const m = buildStageMap([-0.8, -0.25, 0, 0.25, 0.9, 0.2504], 150, 1024);

  it('merges slots closer than 1e-3 and centres the row', () => {
    expect(m.slots).toEqual([-0.8, -0.25, 0, 0.25, 0.9]);
    expect((m.xs[0]! + m.xs.at(-1)!) / 2).toBeCloseTo(1024, 9);
  });

  it('stageX is monotonic and continuous, also outside the used range', () => {
    let prev = stageX(m, -2);
    for (let s = -2; s <= 2; s += 0.001) {
      const x = stageX(m, s);
      expect(x).toBeGreaterThan(prev - 1e-12);
      expect(x - prev).toBeLessThan(m.slope * 0.0011 + 1e-9);
      prev = x;
    }
  });

  it('neighbours with a canonical gap stand exactly one pitch apart; wide gaps do not widen it', () => {
    expect(stageX(m, 0) - stageX(m, -0.25)).toBeCloseTo(150 * (0.25 / 0.3), 9);
    expect(stageX(m, 0.9) - stageX(m, 0.25)).toBeCloseTo(150, 9);
    const wide = buildStageMap([-1, -0.3, 0.3, 1], 150, 1000);
    expect(wide.xs[1]! - wide.xs[0]!).toBeCloseTo(150, 9);
    expect(wide.xs[2]! - wide.xs[1]!).toBeCloseTo(150, 9);
  });

  it('two people at far left / far right still stand one pitch apart', () => {
    const two = buildStageMap([-0.9, 0.9], 150, 1024);
    expect(two.xs[1]! - two.xs[0]!).toBeCloseTo(150, 9);
  });

  it('the inverse round-trips', () => {
    for (let s = -1.5; s <= 1.5; s += 0.037) expect(Math.abs(stageSlotOf(m, stageX(m, s)) - s)).toBeLessThan(1e-9);
    const one = buildStageMap([0.4], 150, 900);
    expect(stageX(one, 0.4)).toBe(900);
    expect(stageSlotOf(one, 900)).toBeCloseTo(0.4, 12);
    expect(buildStageMap([], 150, 900).xs).toEqual([900]);
  });

  it('stageDx is the offset to the classic position; shiftPlacement moves every x and keeps the object for 0', () => {
    const cal = fakeCalibration('m');
    const p = placeActor(cal, { slot: 0.25, depth: 0.1 }, bg);
    const dx = stageDx(m, 0.25, bg);
    expect(dx).toBeCloseTo(stageX(m, 0.25) - slotToX(0.25, bg), 9);
    const q = shiftPlacement(p, dx);
    expect(q.feet.x).toBeCloseTo(stageX(m, 0.25), 9);
    expect(q.headCenter.x - p.headCenter.x).toBeCloseTo(dx, 9);
    expect(q.bodyBox.x - p.bodyBox.x).toBeCloseTo(dx, 9);
    expect(q.headBox.y).toBe(p.headBox.y);
    expect(shiftPlacement(p, 0)).toBe(p);
  });

  it('stageArrangement brings head sizes and the front-row eye lines together', () => {
    const fr = OURNOTES_STYLE.framing;
    const mk = (id: string, h: number, depth: number, y: number) => ({ id, head: { x: 0, y, w: h, h }, depth, visH: h * 0.88, eyeY: y + h * 0.59 });
    const actors = [mk('a', 100, 0.1, 400), mk('b', 118, 0.1, 380), mk('c', 90, 0.8, 440)];
    const arr = stageArrangement(actors, fr);
    const sizes = actors.map((a) => a.visH * arr[a.id]!.s);
    expect(Math.min(...sizes) / Math.max(...sizes)).toBeGreaterThanOrEqual(0.9);
    const eye = (a: (typeof actors)[number]) => {
      const cy = a.head.y + a.head.h / 2;
      return cy + (a.eyeY - cy) * arr[a.id]!.s + arr[a.id]!.dy;
    };
    expect(Math.abs(eye(actors[0]!) - eye(actors[1]!))).toBeLessThan(Math.abs(actors[0]!.eyeY - actors[1]!.eyeY));
    expect(arr.c!.dy).toBe(0);
    const r = arrangeRect({ x: 0, y: 0, w: 10, h: 20 }, { x: 5, y: 10 }, { s: 2, dy: 3 });
    expect(r).toEqual({ x: -5, y: -7, w: 20, h: 40 });
    expect(stageArrangement([], fr)).toEqual({});
  });
});
