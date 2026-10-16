import { describe, expect, it } from 'vitest';
import { arrangeRect, buildStageMap, shiftPlacement, stageArrangement, stageDx } from '../../shared/staging/compactStage';
import { groupHeadTarget, shotTypeChoices, visibleHead, visibleShare, type FramingActor, type ShotType } from '../../shared/staging/framing';
import { placeActor } from '../../shared/staging/ground';
import { solveTravelShot } from '../../shared/staging/travelFraming';
import { defaultGround, viewRect, type BgInfo } from '../../shared/staging/world';
import { OURNOTES_STYLE } from '../../shared/style/ournotes';
import { fakeCalibration } from './helpers/synthetic';

const bg: BgInfo = { width: 2048, height: 1119, ground: defaultGround(2048, 1119) };
const H = Math.min(bg.height, bg.width / (16 / 9));
const fr = OURNOTES_STYLE.framing;
const cal = fakeCalibration('m');

/** Three people in the compact stage, arranged exactly as compile does (stage shift, then size / eye-line arrangement). */
function stage(slots: number[], depths: number[] = slots.map(() => 0.1), yaw = 0) {
  const raw = slots.map((slot, i) => placeActor(cal, { slot, depth: depths[i]! }, bg));
  const meanVis = raw.reduce((q, p) => q + (p.headBox.h * (fr.headChin - fr.headTop)), 0) / raw.length;
  const map = buildStageMap(slots, OURNOTES_STYLE.travel.pitchHeads * meanVis, bg.width / 2);
  const placed = slots.map((slot, i) => shiftPlacement(raw[i]!, stageDx(map, slot, bg)));
  const arr = stageArrangement(
    placed.map((p, i) => ({ id: `p${i}`, head: p.headBox, depth: depths[i]!, visH: p.headBox.h * (fr.headChin - fr.headTop), eyeY: p.headBox.y + p.headBox.h * fr.eyeFrac })),
    fr,
  );
  return placed.map((p, i): FramingActor => {
    const a = arr[`p${i}`]!;
    return { id: `p${i}`, head: arrangeRect(p.headBox, p.headCenter, a), body: arrangeRect(p.bodyBox, p.headCenter, a), yaw };
  });
}
const solve = (type: ShotType, focus: FramingActor[], all: FramingActor[]) => solveTravelShot({ type, focus, all, bg, style: OURNOTES_STYLE });
/** Horizontal distance on screen between two shots' views of one point, as a share of the frame width. */
const shareW = (a: number, b: number, zoom: number) => (Math.abs(a - b) * zoom) / (H * (16 / 9));

describe('travel framing', () => {
  const people = stage([-0.25, 0, 0.25]);
  const cx = (a: FramingActor) => a.head.x + a.head.w / 2;

  it('a single mcu has the style head height, and no solution carries shifts, edge cuts or a background zoom', () => {
    for (const type of ['mcu', 'cu', 'ecu'] as const) {
      const s = solve(type, [people[1]!], people);
      const vh = visibleHead(people[1]!, fr).h;
      expect(vh / (H / s.pose.zoom)).toBeCloseTo(OURNOTES_STYLE.shots[type].headH, 6);
      expect(s.shifts).toEqual({});
      expect(s.edgeCut).toEqual([]);
      expect(s.pose.bgZoom).toBeUndefined();
    }
  });

  it('a medium shot (ms) has the style head height and the person stands off centre by the look room, neighbours still in frame', () => {
    const facing = stage([-0.25, 0, 0.25], undefined, 1);
    const s = solve('ms', [facing[1]!], facing);
    const vh = visibleHead(facing[1]!, fr).h;
    expect(vh / (H / s.pose.zoom)).toBeCloseTo(OURNOTES_STYLE.shots.ms.headH, 6);
    expect(OURNOTES_STYLE.shots.ms.lookRoom).toBeCloseTo(0.18, 9);
    // looking towards screen-right: the camera sits right of the head, the head is left of the centre by lookRoom * view width
    const off = ((cx(facing[1]!) - s.pose.x) * s.pose.zoom) / (H * (16 / 9));
    expect(off).toBeCloseTo(-OURNOTES_STYLE.shots.ms.lookRoom, 6);
    expect(s.shifts).toEqual({});
    // the next person to the right is inside the view
    const view = viewRect(bg, s.pose);
    expect(cx(facing[2]!)).toBeGreaterThan(view.x);
    expect(cx(facing[2]!)).toBeLessThan(view.x + view.w);
  });

  it('moving the camera from one neighbour to the next is 0.3-0.5 W at mcu and 0.4-0.7 W at cu', () => {
    const m0 = solve('mcu', [people[0]!], people).pose;
    const m1 = solve('mcu', [people[1]!], people).pose;
    expect(shareW(m0.x, m1.x, m1.zoom)).toBeGreaterThanOrEqual(0.3);
    expect(shareW(m0.x, m1.x, m1.zoom)).toBeLessThanOrEqual(0.5);
    const c0 = solve('cu', [people[0]!], people).pose;
    const c1 = solve('cu', [people[1]!], people).pose;
    expect(shareW(c0.x, c1.x, c1.zoom)).toBeGreaterThanOrEqual(0.4);
    expect(shareW(c0.x, c1.x, c1.zoom)).toBeLessThanOrEqual(0.7);
  });

  it('neighbours half in the frame of a single mcu are kept: no camera shift, no edge cut, partly visible', () => {
    const s = solve('mcu', [people[1]!], people);
    const left = visibleShare(people[0]!, bg, s.pose, fr);
    const right = visibleShare(people[2]!, bg, s.pose, fr);
    expect(Math.max(left, right)).toBeGreaterThan(0.05);
    expect(Math.min(left, right)).toBeLessThan(0.7);
    expect(s.pose.x).toBeCloseTo(cx(people[1]!), 6);
    expect(s.edgeCut).toEqual([]);
  });

  it('look room moves the camera against the facing', () => {
    const facing = stage([-0.25, 0, 0.25], undefined, 1);
    const s = solve('mcu', [facing[1]!], facing);
    expect(s.pose.x).toBeGreaterThan(cx(facing[1]!));
  });

  it('a two-shot is symmetric about the midpoint and both faces are inside the frame', () => {
    const s = solve('two_shot', [people[0]!, people[1]!], people);
    expect(s.pose.x).toBeCloseTo((cx(people[0]!) + cx(people[1]!)) / 2, 6);
    const v = viewRect(bg, s.pose);
    for (const p of [people[0]!, people[1]!]) {
      expect(cx(p) - p.head.w * 0.35).toBeGreaterThan(v.x);
      expect(cx(p) + p.head.w * 0.35).toBeLessThan(v.x + v.w);
    }
    const centres = [people[0]!, people[1]!].map(p => cx(p) + s.shifts[p.id]!.dx);
    expect((centres[1]! - centres[0]!) * s.pose.zoom / H).toBeCloseTo(2 * fr.twoShotFaceX, 9);
  });

  it('a two-shot arranges even distant faces at the classic spacing without shrinking', () => {
    const far = stage([-0.9, 0.9]);
    const near = solve('two_shot', [people[0]!, people[1]!], people);
    const wide = solve('two_shot', [far[0]!, far[1]!], far);
    // the compact stage keeps the two apart by one pitch whatever their slots, so both fit the target size
    expect(wide.pose.zoom).toBeCloseTo(near.pose.zoom, 1);
    const crammed = people.map((p, i) => ({ ...p, head: { ...p.head, x: p.head.x + (i === 2 ? 900 : 0) } }));
    const s = solve('two_shot', [crammed[0]!, crammed[2]!], crammed);
    const v = viewRect(bg, s.pose);
    for (const p of [crammed[0]!, crammed[2]!]) {
      expect(cx(p) + s.shifts[p.id]!.dx - p.head.w * 0.35).toBeGreaterThan(v.x);
      expect(cx(p) + s.shifts[p.id]!.dx + p.head.w * 0.35).toBeLessThan(v.x + v.w);
    }
    const centres = [crammed[0]!, crammed[2]!].map(p => cx(p) + s.shifts[p.id]!.dx);
    expect((centres[1]! - centres[0]!) * s.pose.zoom / H).toBeCloseTo(2 * fr.twoShotFaceX, 9);
    expect(s.pose.zoom).toBeCloseTo(near.pose.zoom, 9);
  });

  it('a group frames every face and centres on them', () => {
    const five = stage([-0.5, -0.25, 0, 0.25, 0.5]);
    for (const set of [people, five]) {
      const s = solve('group', [set[0]!], set);
      const v = viewRect(bg, s.pose);
      for (const p of set) {
        expect(cx(p) - p.head.w * 0.35).toBeGreaterThan(v.x);
        expect(cx(p) + p.head.w * 0.35).toBeLessThan(v.x + v.w);
      }
      const mid = (Math.min(...set.map(cx)) + Math.max(...set.map(cx))) / 2;
      expect(s.pose.x).toBeCloseTo(mid, 6);
      expect(s.shifts).toEqual({});
    }
  });

  it('establishing / nobody: zoom 1 at the reference', () => {
    expect(solveTravelShot({ type: 'establishing', focus: [], bg, ref: { x: 700, y: 500 } }).pose).toEqual({ x: 700, y: 500, zoom: 1 });
    expect(solveTravelShot({ type: 'mcu', focus: [], bg }).pose).toEqual({ x: 1024, y: 559.5, zoom: 1 });
  });

  it('a travel group has the classic head height of its size (v7), larger than a medium shot for three people', () => {
    const fh = (a: FramingActor, zoom: number) => visibleHead(a, fr).h / (H / zoom);
    const g = solve('group', [people[0]!], people);
    const ms = solve('ms', [people[1]!], people);
    expect(fh(people[0]!, g.pose.zoom)).toBeCloseTo(groupHeadTarget(3, fr), 2);
    expect(ms.pose.zoom / g.pose.zoom).toBeLessThan(1);
    // the classic group solver is untouched
    expect(OURNOTES_STYLE.framing.groupHead3).toBe(0.41);
  });

  it('insert is the classic insert without edge cuts or a background zoom', () => {
    const s = solve('insert', [people[1]!], people);
    expect(s.edgeCut).toEqual([]);
    expect(s.shifts).toEqual({});
    expect(s.pose.bgZoom).toBeUndefined();
    expect(s.pose.zoom).toBeGreaterThan(1);
  });
});

describe('shot sizes offered in the editor', () => {
  it('ms only in travel scenes (or when the value already is ms); a legacy value stays selectable', () => {
    expect(shotTypeChoices(true)).toContain('ms');
    expect(shotTypeChoices(false)).not.toContain('ms');
    expect(shotTypeChoices(false, 'mcu')).toEqual(['establishing', 'group', 'two_shot', 'mcu', 'cu', 'ecu', 'insert']);
    expect(shotTypeChoices(false, 'ms')).toContain('ms');
    expect(shotTypeChoices(false, 'bust')[0]).toBe('bust');
  });
});
