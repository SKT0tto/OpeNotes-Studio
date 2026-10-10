import { describe, expect, it } from 'vitest';
import {
  ASPECT, BG_PARALLAX, bgView, clampCamera, defaultGround, screenToWorld, viewRect, viewWorldHeight, worldToScreen, type BgInfo,
} from '../../shared/staging/world';

const bg = (w: number, h: number): BgInfo => ({ width: w, height: h, ground: defaultGround(w, h) });
const BGS = [bg(2048, 1119), bg(1600, 900), bg(2048, 1300)];

describe('world space', () => {
  it('viewport height is the largest 16:9 window inside the background', () => {
    expect(viewWorldHeight(bg(1600, 900))).toBeCloseTo(900);
    expect(viewWorldHeight(bg(2048, 1119))).toBeCloseTo(1119);
    expect(viewWorldHeight(bg(2048, 1300))).toBeCloseTo(2048 / ASPECT, 5);
  });

  it('world <-> screen round-trips for any camera', () => {
    for (const b of BGS) {
      for (const cam of [{ x: 300, y: 400, zoom: 1 }, { x: 1500, y: 700, zoom: 2.7 }, { x: 40, y: 1000, zoom: 5.5 }]) {
        for (const p of [{ x: 0, y: 0 }, { x: 640, y: 360 }, { x: 1280, y: 720 }]) {
          const w = screenToWorld(b, cam, 720, p);
          const back = worldToScreen(b, cam, 720, w);
          expect(back.x).toBeCloseTo(p.x, 6);
          expect(back.y).toBeCloseTo(p.y, 6);
        }
      }
    }
  });

  it('the camera centre maps to the screen centre', () => {
    const p = worldToScreen(BGS[0]!, { x: 900, y: 500, zoom: 3 }, 720, { x: 900, y: 500 });
    expect(p).toEqual({ x: 640, y: 360 });
  });

  it('background view always covers the viewport (clamped), at every zoom and camera position', () => {
    for (const b of BGS) {
      for (const zoom of [1, 1.5, 2, 3, 4.2, 6]) {
        for (const x of [-500, 0, 700, 1024, 2048, 4000]) {
          for (const y of [-500, 0, 500, 1119, 3000]) {
            const v = bgView(b, { x, y, zoom });
            const h = viewWorldHeight(b) / v.zoom;
            const w = h * ASPECT;
            expect(v.cx - w / 2).toBeGreaterThanOrEqual(-1e-6);
            expect(v.cx + w / 2).toBeLessThanOrEqual(b.width + 1e-6);
            expect(v.cy - h / 2).toBeGreaterThanOrEqual(-1e-6);
            expect(v.cy + h / 2).toBeLessThanOrEqual(b.height + 1e-6);
          }
        }
      }
    }
  });

  it('the background magnifies less than the actors (parallax)', () => {
    for (const zoom of [1.5, 3, 6]) {
      const v = bgView(BGS[0]!, { x: 1024, y: 560, zoom });
      expect(v.zoom).toBeCloseTo(Math.pow(zoom, BG_PARALLAX));
      expect(v.zoom).toBeLessThan(zoom);
    }
    expect(bgView(BGS[0]!, { x: 1024, y: 560, zoom: 1 }).zoom).toBe(1);
  });

  it('user framing zoom/offset are applied and still clamped', () => {
    const v = bgView(BGS[0]!, { x: 1024, y: 560, zoom: 1 }, { zoom: 1.5, offsetX: 5000, offsetY: -5000 });
    expect(v.zoom).toBeCloseTo(1.5);
    const w = (viewWorldHeight(BGS[0]!) * ASPECT) / 1.5;
    expect(v.cx + w / 2).toBeLessThanOrEqual(2048 + 1e-6);
    expect(v.cy - viewWorldHeight(BGS[0]!) / 1.5 / 2).toBeGreaterThanOrEqual(-1e-6);
  });

  it('clampCamera clamps zoom and keeps the camera inside what the background can cover', () => {
    const c = clampCamera(BGS[0]!, { x: -999, y: 99999, zoom: 0.2 });
    expect(c.zoom).toBe(1);
    const r = viewRect(BGS[0]!, c);
    expect(r.x).toBeGreaterThanOrEqual(-1e-6);
    expect(r.y + r.h).toBeLessThanOrEqual(1119 + 1e-6);
  });
});
