import { describe, expect, it } from 'vitest';
import { parallaxAt, softLimit, travelBgPose, type TravelBgModel } from '../../shared/staging/travelBg';
import { bgView, defaultGround, NO_FRAMING, viewWorldHeight, type BgFraming, type BgInfo, type CameraPose } from '../../shared/staging/world';

const bg: BgInfo = { width: 2048, height: 1119, ground: defaultGround(2048, 1119) };
const A = 16 / 9;
const m: TravelBgModel = { sigma: 1, scale: 0.33, zoomMax: 3.2, ref: { x: 1024, y: 560 } };
/** Head share at which the card model gives exactly 0.75 (a two-shot's is 0.39). */
const S75 = 1 / 3;
const view = (cam: CameraPose, framing: BgFraming = NO_FRAMING, model = m, aspect = A, share = S75) => {
  const p = travelBgPose(cam, model, bg, framing, aspect, share);
  return { p, v: bgView(bg, { ...cam, ...p }, framing, aspect) };
};

describe('travel background model', () => {
  it('bgZoom = scale * zoom * parallax / 0.75, clamped to 1..zoomMax', () => {
    expect(travelBgPose({ x: 1024, y: 560, zoom: 1 }, m, bg, NO_FRAMING, A, S75).bgZoom).toBe(1);
    expect(travelBgPose({ x: 1024, y: 560, zoom: 6 }, m, bg, NO_FRAMING, A, S75).bgZoom).toBeCloseTo(1.98, 9);
    expect(travelBgPose({ x: 1024, y: 560, zoom: 14 }, m, bg, NO_FRAMING, A, S75).bgZoom).toBe(3.2);
    // the same zoom at a larger head share magnifies the picture less
    expect(travelBgPose({ x: 1024, y: 560, zoom: 8 }, m, bg, NO_FRAMING, A, 0.7).bgZoom).toBeLessThan(travelBgPose({ x: 1024, y: 560, zoom: 8 }, m, bg, NO_FRAMING, A, 0.3).bgZoom);
  });

  it('parallaxAt follows the card model: a two-shot about 0.72, a close-up about 0.59, an extreme close-up about 0.5', () => {
    expect(parallaxAt(0, 1)).toBe(1);
    expect(parallaxAt(0.39, 1)).toBeGreaterThanOrEqual(0.7);
    expect(parallaxAt(0.39, 1)).toBeLessThanOrEqual(0.75);
    expect(parallaxAt(0.7, 1)).toBeGreaterThanOrEqual(0.55);
    expect(parallaxAt(0.7, 1)).toBeLessThanOrEqual(0.62);
    expect(parallaxAt(0.95, 1)).toBeLessThan(0.52);
    expect(parallaxAt(0.5, 2)).toBeGreaterThan(parallaxAt(0.5, 1));
  });

  it('a sideways move at a fixed zoom shifts the background by exactly parallaxAt(s) times the people (inside the linear zone)', () => {
    for (const [zoom, share] of [[6, 0.31], [8, 0.52], [9, 0.7]] as const) {
      const a = view({ x: 1000, y: 560, zoom }, NO_FRAMING, m, A, share);
      const b = view({ x: 1040, y: 560, zoom }, NO_FRAMING, m, A, share);
      const peopleScreen = 40 * zoom;
      const bgScreen = (b.v.cx - a.v.cx) * a.v.zoom;
      expect(bgScreen / peopleScreen).toBeCloseTo(parallaxAt(share, 1), 9);
    }
    const other = { ...m, sigma: 2 };
    const a = view({ x: 1000, y: 560, zoom: 6 }, NO_FRAMING, other, A, 0.5);
    const b = view({ x: 1040, y: 560, zoom: 6 }, NO_FRAMING, other, A, 0.5);
    expect(((b.v.cx - a.v.cx) * a.v.zoom) / (40 * 6)).toBeCloseTo(parallaxAt(0.5, 2), 9);
  });

  it('pushing in (the head share grows with the zoom) magnifies the picture less and less per unit of zoom; a close-up stays below 2.6', () => {
    const head = 0.07; // share of the frame height per unit of zoom: mcu (zoom 7.4) 0.52, cu (10) 0.70
    let prev = Infinity;
    for (let zoom = 3; zoom <= 13; zoom += 0.5) {
      const r = travelBgPose({ x: 1024, y: 560, zoom }, m, bg, NO_FRAMING, A, head * zoom).bgZoom / zoom;
      if (r * zoom > 1) expect(r).toBeLessThanOrEqual(prev + 1e-12);
      prev = Math.min(prev, r);
    }
    expect(travelBgPose({ x: 1024, y: 560, zoom: 10 }, m, bg, NO_FRAMING, A, 0.7).bgZoom).toBeLessThanOrEqual(2.6);
  });

  it('the picture is centred when the camera is at the reference', () => {
    const { v } = view({ x: 1024, y: 560, zoom: 6 });
    expect(v.cx).toBeCloseTo(1024, 9);
    expect(v.cy).toBeCloseTo(560, 9);
  });

  it('the background view always lies inside the picture (1000 random poses, several framings and aspects)', () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
    for (let i = 0; i < 1000; i++) {
      const cam: CameraPose = { x: -400 + rnd() * 2900, y: -200 + rnd() * 1500, zoom: 1 + rnd() * 12 };
      const framing: BgFraming = i % 3 === 0 ? { zoom: 1 + rnd() * 0.5, offsetX: (rnd() - 0.5) * 100, offsetY: (rnd() - 0.5) * 60 } : NO_FRAMING;
      const aspect = [A, 2.16, 1.4][i % 3]!;
      const { v, p } = view(cam, framing, m, aspect, rnd() * 1.2);
      const hw = (viewWorldHeight(bg) * aspect) / v.zoom / 2;
      const hh = viewWorldHeight(bg) / v.zoom / 2;
      expect(v.cx - hw).toBeGreaterThanOrEqual(-1e-6);
      expect(v.cx + hw).toBeLessThanOrEqual(bg.width + 1e-6);
      expect(v.cy - hh).toBeGreaterThanOrEqual(-1e-6);
      expect(v.cy + hh).toBeLessThanOrEqual(bg.height + 1e-6);
      // the soft limit already did the covering: the hard clamp inside bgView is a no-op
      expect(v.cx).toBeCloseTo(p.bgX + framing.offsetX, 9);
    }
  });

  it('is continuous in cam.x over the whole range: the numeric derivative never jumps', () => {
    const zoom = 6;
    const g = (parallaxAt(S75, m.sigma) * zoom) / Math.max((m.scale * zoom * parallaxAt(S75, m.sigma)) / 0.75, 1);
    let prev: number | null = null;
    let prevD: number | null = null;
    for (let x = -300; x <= 2400; x += 0.05) {
      const bx = travelBgPose({ x, y: 560, zoom }, m, bg, NO_FRAMING, A, S75).bgX;
      if (prev !== null) {
        const d = bx - prev;
        if (prevD !== null) expect(Math.abs(d - prevD)).toBeLessThan(1e-3 * g + 1e-6);
        prevD = d;
      }
      prev = bx;
    }
  });

  it('softLimit is the identity in the middle, C1 at the knee, monotonic and bounded', () => {
    expect(softLimit(500, 0, 1000)).toBe(500);
    const knee = 500 - 500 * 0.3;
    const eps = 1e-6;
    const left = (softLimit(knee, 0, 1000) - softLimit(knee - eps, 0, 1000)) / eps;
    const right = (softLimit(1000 - knee + eps, 0, 1000) - softLimit(1000 - knee, 0, 1000)) / eps;
    expect(left).toBeCloseTo(1, 4);
    expect(right).toBeCloseTo(1, 4);
    let prev = -Infinity;
    for (let x = -5000; x <= 6000; x += 7) {
      const y = softLimit(x, 0, 1000);
      expect(y).toBeGreaterThanOrEqual(prev);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(1000);
      prev = y;
    }
    expect(softLimit(3, 10, 10)).toBe(10);
  });
});
