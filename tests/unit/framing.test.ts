import { describe, expect, it } from 'vitest';
import {
  EDGE_MAX, EDGE_MIN, cameraMove, eyeWorldY, headScreenMetrics, normalizeShotType, solveShot, solveShotDetailed, visibleShare, type FramingActor, type ShotType,
} from '../../shared/staging/framing';
import { placeActor } from '../../shared/staging/ground';
import { ASPECT, bgView, defaultGround, viewRect, viewWorldHeight, type BgInfo } from '../../shared/staging/world';
import { OURNOTES_STYLE } from '../../shared/style/ournotes';
import { fakeCalibration } from './helpers/synthetic';

const bg: BgInfo = { width: 2048, height: 1119, ground: defaultGround(2048, 1119) };
const cal = fakeCalibration('m');
const actor = (id: string, slot: number, depth: number, yaw = 0): FramingActor => {
  const p = placeActor(cal, { slot, depth }, bg);
  return { id, head: p.headBox, body: p.bodyBox, yaw };
};
const S = OURNOTES_STYLE.shots;
const FR = OURNOTES_STYLE.framing;
const H = viewWorldHeight(bg);

// Two people standing the way the demo does it: faces ~0.94H apart on a two-shot.
const A = actor('a', -0.15, 0.08);
const B = actor('b', 0.15, 0.1);
const C = actor('c', 0.02, 0.6);

describe('V1 shot ladder (STYLE_REFERENCE section 1)', () => {
  it.each(['mcu', 'cu', 'ecu'] as const)('%s: head height is the target share of the frame (+-8%) and the eye line lands on the target (+-0.03H)', (type) => {
    const a = actor('s', 0, 0.1);
    const pose = solveShot({ type, focus: [a], bg });
    const m = headScreenMetrics(a, bg, pose);
    expect(Math.abs(m.headH / S[type].headH - 1)).toBeLessThan(0.08);
    expect(Math.abs(m.eyeY - S[type].eyeY)).toBeLessThan(0.03);
  });

  it('mcu keeps a head-top margin of >= 0.02H; cu / ecu may leave the frame at the top', () => {
    const a = actor('s', 0, 0.1);
    expect(headScreenMetrics(a, bg, solveShot({ type: 'mcu', focus: [a], bg })).top).toBeGreaterThanOrEqual(S.mcu.topMargin - 1e-6);
    expect(headScreenMetrics(a, bg, solveShot({ type: 'cu', focus: [a], bg })).top).toBeLessThan(0.02);
    expect(headScreenMetrics(a, bg, solveShot({ type: 'ecu', focus: [a], bg })).top).toBeLessThan(-0.1);
  });

  it('two_shot: head height ~0.39H, eyes at ~0.37H, top margin >= 0.04H, faces ~0.94H apart', () => {
    const pose = solveShot({ type: 'two_shot', focus: [A, B], bg });
    const ma = headScreenMetrics(A, bg, pose);
    const mb = headScreenMetrics(B, bg, pose);
    for (const m of [ma, mb]) {
      expect(Math.abs(m.headH / S.two_shot.headH - 1)).toBeLessThan(0.1);
      expect(Math.abs(m.eyeY - S.two_shot.eyeY)).toBeLessThan(0.04);
      expect(m.top).toBeGreaterThanOrEqual(S.two_shot.topMargin - 0.01);
    }
    expect(Math.abs(mb.centerX - ma.centerX)).toBeGreaterThan(0.8);
    expect(Math.abs(mb.centerX - ma.centerX)).toBeLessThan(1.1);
  });

  it('group: the front row has head height ~0.40H, the back row is smaller (depth) and everybody is inside the frame', () => {
    const pose = solveShot({ type: 'group', focus: [A, C, B], bg });
    const mc = headScreenMetrics(C, bg, pose);
    const ma = headScreenMetrics(A, bg, pose);
    expect(Math.abs(ma.headH / S.group.headH - 1)).toBeLessThan(0.12);
    expect(mc.headH / ma.headH).toBeLessThan(0.85);
    const v = viewRect(bg, pose);
    for (const a of [A, B, C]) {
      expect(a.head.x).toBeGreaterThan(v.x);
      expect(a.head.x + a.head.w).toBeLessThan(v.x + v.w);
    }
  });

  it('no people shot is wider than a group: the front head is >= 0.3H (no full-body / knee shots)', () => {
    for (const type of ['group', 'two_shot', 'mcu', 'cu', 'ecu'] as const) {
      const pose = solveShot({ type, focus: type === 'group' ? [A, B, C] : type === 'two_shot' ? [A, B] : [A], bg });
      expect(headScreenMetrics(A, bg, pose).headH).toBeGreaterThan(0.3);
    }
  });

  it('shot sizes are ordered two_shot / group < mcu < cu < ecu', () => {
    const z = (type: ShotType) => solveShot({ type, focus: [A, B], bg }).zoom;
    expect(z('group')).toBeLessThan(z('mcu'));
    expect(z('two_shot')).toBeLessThan(z('mcu'));
    expect(z('mcu')).toBeLessThan(z('cu'));
    expect(z('cu')).toBeLessThan(z('ecu'));
  });

  it('every size comes from the style table: overriding headH moves the zoom', () => {
    const base = solveShot({ type: 'mcu', focus: [A], bg });
    const style = structuredClone(OURNOTES_STYLE);
    style.shots.mcu.headH = 0.8;
    const big = solveShot({ type: 'mcu', focus: [A], bg, style });
    expect(big.zoom / base.zoom).toBeCloseTo(0.8 / 0.52, 1);
  });

  it('establishing shows the whole background un-zoomed and the background zoom follows the shot (1.45x two-shot, >=2.5x cu)', () => {
    const est = solveShot({ type: 'establishing', focus: [], all: [A, B], bg });
    expect(est.zoom).toBe(1);
    expect(est.bgZoom).toBe(1);
    expect(solveShot({ type: 'two_shot', focus: [A, B], bg }).bgZoom).toBeCloseTo(1.45);
    expect(solveShot({ type: 'cu', focus: [A], bg }).bgZoom).toBeGreaterThanOrEqual(2.5);
  });

  it('the visible background never leaves the background image, whatever the shot', () => {
    const edge = [actor('l', -1, 0), actor('r', 1, 0.9)];
    for (const type of ['establishing', 'group', 'two_shot', 'mcu', 'cu', 'ecu'] as const) {
      for (const focus of [[edge[0]!], [edge[1]!], edge]) {
        const cam = solveShot({ type, focus, all: edge, bg });
        const v = bgView(bg, cam);
        const h = H / v.zoom;
        const w = h * ASPECT;
        expect(v.cx - w / 2).toBeGreaterThanOrEqual(-1e-6);
        expect(v.cx + w / 2).toBeLessThanOrEqual(bg.width + 1e-6);
        expect(v.cy - h / 2).toBeGreaterThanOrEqual(-1e-6);
        expect(v.cy + h / 2).toBeLessThanOrEqual(bg.height + 1e-6);
      }
    }
  });

  it('a single person asked for a two_shot / group degrades to a mcu-sized shot; the result is deterministic', () => {
    const one = solveShot({ type: 'two_shot', focus: [A], bg });
    expect(Math.abs(headScreenMetrics(A, bg, one).headH - S.two_shot.headH)).toBeLessThan(0.05);
    expect(solveShot({ type: 'mcu', focus: [A], bg })).toEqual(solveShot({ type: 'mcu', focus: [A], bg }));
  });

  it('legacy names map to the new ladder', () => {
    expect(normalizeShotType('closeup').type).toBe('cu');
    expect(normalizeShotType('bust').type).toBe('mcu');
    expect(normalizeShotType('medium').type).toBe('mcu');
    expect(normalizeShotType('wide')).toEqual({ type: 'group', legacy: true });
    expect(normalizeShotType('ecu')).toEqual({ type: 'ecu', legacy: false });
  });

  it('eye line helper uses the style eye fraction', () => {
    expect(eyeWorldY(A, FR)).toBeCloseTo(A.head.y + A.head.h * FR.eyeFrac);
  });
});

describe('cameraMove', () => {
  const base = solveShot({ type: 'mcu', focus: [A], bg });
  it('push_in ends tighter, pull_out starts tighter, static does not move', () => {
    expect(cameraMove(base, 'push_in', bg).to.zoom).toBeGreaterThan(base.zoom);
    expect(cameraMove(base, 'push_in', bg).from).toEqual(base);
    expect(cameraMove(base, 'pull_out', bg).from.zoom).toBeGreaterThan(base.zoom);
    expect(cameraMove(base, 'pull_out', bg).to).toEqual(base);
    expect(cameraMove(base, 'static', bg)).toEqual({ from: base, to: base });
  });
  it('pan and track move sideways in opposite directions without changing zoom', () => {
    const pan = cameraMove(base, 'pan', bg);
    const track = cameraMove(base, 'track', bg);
    expect(pan.to.x).toBeGreaterThan(pan.from.x);
    expect(track.to.x).toBeLessThan(track.from.x);
    expect(pan.to.zoom).toBe(base.zoom);
  });
});

describe('look-room and bystanders (M1)', () => {
  it('a single-person shot puts the head on the side opposite to its gaze (mcu 0.04..0.15 of the width, cu stays near the centre)', () => {
    for (const [yaw, side] of [[1, -1], [-1, 1]] as const) {
      const a = actor('a', 0, 0.1, yaw);
      const frac = (type: ShotType) => {
        const v = viewRect(bg, solveShot({ type, focus: [a], bg }));
        return (a.head.x + a.head.w / 2 - v.x) / v.w;
      };
      expect(Math.abs(frac('mcu') - 0.5)).toBeGreaterThan(0.04);
      expect(Math.abs(frac('mcu') - 0.5)).toBeLessThan(0.15);
      expect(Math.sign(frac('mcu') - 0.5)).toBe(side);
      expect(Math.abs(frac('cu') - 0.5)).toBeLessThan(0.07); // SR: CU / ECU are centred within 0.05H
    }
  });

  it('no bystander is left cut in half by the frame (or the shot reports edge-cut)', () => {
    let tried = 0;
    for (const slot of [-0.5, -0.35, -0.2, 0, 0.2, 0.35, 0.5]) {
      for (const gap of [0.18, 0.3, 0.45, 0.6]) {
        for (const type of ['mcu', 'cu', 'two_shot'] as const) {
          const a = actor('a', slot, 0.1, 0.8);
          const b = actor('b', Math.min(1, slot + gap), 0.12, -0.8);
          const { pose, edgeCut } = solveShotDetailed({ type, focus: [a], all: [a, b], bg });
          const f = visibleShare(b, bg, pose);
          tried++;
          if (edgeCut.length === 0) expect(f <= EDGE_MIN || f >= EDGE_MAX, `${type} slot ${slot} gap ${gap} f=${f}`).toBe(true);
          else expect(edgeCut).toEqual(['b']);
        }
      }
    }
    expect(tried).toBeGreaterThan(80);
  });
});

describe('F5 insert shot target box', () => {
  const box = (b: { x: number; y: number; w: number; h: number }) => solveShot({ type: 'insert', focus: [A], bg, insertBox: b });
  it('the camera centres on the box and zooms to fit it; a smaller or higher box moves / zooms the camera', () => {
    const a = box({ x: 0.2, y: 0.5, w: 0.6, h: 0.3 });
    const up = box({ x: 0.2, y: 0.1, w: 0.6, h: 0.3 });
    const small = box({ x: 0.2, y: 0.5, w: 0.3, h: 0.15 });
    expect(up.y).toBeLessThan(a.y);
    expect(small.zoom).toBeGreaterThan(a.zoom * 1.5);
    expect(a.bgZoom).toBe(S.insert.bgZoom);
    expect(Number.isFinite(a.zoom)).toBe(true);
  });
  it('without a box a default (chest / hands) target is used', () => {
    expect(solveShot({ type: 'insert', focus: [A], bg }).zoom).toBeGreaterThan(1);
  });
});

describe('E4 wide window', () => {
  it('a wider window magnifies the background just enough to stay covered, 16:9 is unchanged', () => {
    const cam = { x: 1024, y: 560, zoom: 1 };
    expect(bgView(bg, cam).zoom).toBe(1);
    const wide = bgView(bg, cam, undefined, 1920 / 890);
    expect(wide.zoom).toBeGreaterThanOrEqual(1);
    expect(viewWorldHeight(bg) * (1920 / 890) / wide.zoom).toBeLessThanOrEqual(bg.width + 1e-6);
  });
});
