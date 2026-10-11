/** v0.2.0: shots of three or more people are no longer crowded - spacing, no hidden faces, everyone inside the frame. */
import { describe, expect, it } from 'vitest';
import { groupRows, groupSizeScale, solveShotDetailed, visibleHead, type FramingActor } from '../../shared/staging/framing';
import { placeActor } from '../../shared/staging/ground';
import { defaultGround, viewRect, type BgInfo } from '../../shared/staging/world';
import { OURNOTES_STYLE, resolveStyle, type StyleValues } from '../../shared/style/ournotes';
import { fakeCalibration } from './helpers/synthetic';

const bg: BgInfo = { width: 2048, height: 1119, ground: defaultGround(2048, 1119) };
const cal = fakeCalibration('m');
const fr = OURNOTES_STYLE.framing;
const ASPECTS: Array<[string, number]> = [['16:9', 16 / 9], ['2.16:1', 1920 / 890]];

const actor = (id: string, slot: number, depth: number): FramingActor => {
  const p = placeActor(cal, { slot, depth }, bg);
  return { id, head: p.headBox, body: p.bodyBox, yaw: 0 };
};
/** `n` people spread over the stage at nearly one depth (a daily scene) ... */
const line = (n: number, depth = 0.15): FramingActor[] => Array.from({ length: n }, (_, i) => actor(`p${i}`, n === 1 ? 0 : -0.7 + (1.4 * i) / (n - 1), depth + (i % 2) * 0.02));
/** ... or a band: the vocalist front centre, the drummer back centre, the rest at the sides. */
const band = (n: number): FramingActor[] => {
  const xs = [0, -0.55, 0.55, -0.28, 0.28, -0.8];
  const out = [actor('vo', 0, 0), actor('dr', 0, 0.8)];
  for (let i = 0; i < n - 2; i++) out.push(actor(`b${i}`, xs[i + 1]!, 0.1 + (i % 2) * 0.12));
  return out.slice(0, n);
};

/** Faces as the viewer sees them (units of H from the frame centre, y from the top). */
function faces(people: FramingActor[], aspect: number, style: StyleValues = OURNOTES_STYLE, move?: 'push_in' | 'pan') {
  const s = solveShotDetailed({ type: 'group', focus: people, all: people, bg, aspect, style, ...(move ? { move } : {}) });
  const Hv = viewRect(bg, s.pose).h;
  return {
    pose: s.pose,
    list: people
      .map((a) => {
        const sh = s.shifts[a.id]!;
        const w = a.head.w * sh.s;
        const cx = a.head.x + a.head.w / 2 + sh.dx;
        const hc = a.head.y + a.head.h / 2;
        const vh = visibleHead(a, fr);
        const top = hc + (vh.top - hc) * sh.s + sh.dy;
        const bottom = hc + (vh.bottom - hc) * sh.s + sh.dy;
        return { id: a.id, x: (cx - s.pose.x) / Hv, w: w / Hv, left: (cx - w / 2 - s.pose.x) / Hv, right: (cx + w / 2 - s.pose.x) / Hv, top: (top - s.pose.y) / Hv + 0.5, bottom: (bottom - s.pose.y) / Hv + 0.5 };
      })
      .sort((p, q) => p.x - q.x),
  };
}

describe('groups of three or more are not crowded', () => {
  for (const [name, aspect] of ASPECTS) {
    for (const n of [3, 4, 5, 6]) {
      for (const [kind, make] of [['daily', line], ['band', band]] as const) {
        it(`${n} people (${kind}) at ${name}: faces keep their distance, no face is covered, everybody is inside the frame`, () => {
          const { list } = faces(make(n), aspect);
          expect(list).toHaveLength(n);
          for (let i = 0; i + 1 < list.length; i++) {
            const a = list[i]!;
            const b = list[i + 1]!;
            // neighbouring face centres are at least a head width apart (the settings put them 1.15-1.55 apart) ...
            expect(b.x - a.x, `${a.id}->${b.id}`).toBeGreaterThanOrEqual(fr.groupRowSpacing * 0.9 * Math.min(a.w, b.w));
            // ... so that no head box touches another one
            expect(b.left, `${a.id}|${b.id}`).toBeGreaterThanOrEqual(a.right - 1e-6);
          }
          const half = aspect / 2;
          for (const f of list) {
            expect(f.left, `${f.id} left edge`).toBeGreaterThanOrEqual(-half + fr.groupEdgeMargin - 1e-6);
            expect(f.right, `${f.id} right edge`).toBeLessThanOrEqual(half - fr.groupEdgeMargin + 1e-6);
            expect(f.top, `${f.id} hair top`).toBeGreaterThanOrEqual(0);
            expect(f.bottom, `${f.id} chin above the dialogue gradient`).toBeLessThan(OURNOTES_STYLE.dialog.gradientY0 + 0.02);
          }
        });
      }
    }
  }

  it('more people are drawn smaller, never below the floor, and wide frames use the width', () => {
    const heads = [3, 4, 5, 6].map((n) => faces(line(n), 16 / 9).list[0]!.w);
    expect(heads[1]!).toBeLessThan(heads[0]! + 1e-9);
    expect(heads[3]!).toBeLessThan(heads[1]!);
    expect(groupSizeScale(3, fr)).toBe(1);
    expect(groupSizeScale(40, fr)).toBe(fr.groupMinScale);
    const narrow = faces(line(5), 16 / 9).list;
    const wide = faces(line(5), 1920 / 890).list;
    const span = (l: typeof narrow) => l.at(-1)!.right - l[0]!.left;
    expect(span(wide)).toBeGreaterThan(span(narrow));
  });

  it('in a band the drummer stays behind and between the front people, and the vocalist keeps the front', () => {
    const { list } = faces(band(5), 16 / 9);
    const vo = list.find((f) => f.id === 'vo')!;
    const dr = list.find((f) => f.id === 'dr')!;
    expect(dr.top).toBeGreaterThan(vo.top + 0.05); // lower on screen = further back
    expect(dr.w).toBeLessThan(vo.w);
    const left = list.filter((f) => f.x < dr.x).length;
    expect(left).toBeGreaterThanOrEqual(1);
    expect(list.length - 1 - left).toBeGreaterThanOrEqual(1);
  });

  it('without depth in the blocking, groups of four or more alternate between two rows', () => {
    const flat = line(5, 0.2).map((a) => ({ ...a }));
    const rows = groupRows(flat.slice().sort((a, b) => a.head.x - b.head.x), bg, { ...fr, groupRowDepthGap: 0.9 });
    expect(rows).toEqual([false, true, false, true, false]);
    expect(groupRows(flat.slice(0, 3), bg, { ...fr, groupRowDepthGap: 0.9 })).toEqual([false, false, false]);
  });

  it('keeps everybody in the frame at the end of a camera move (push-in / pan)', () => {
    for (const move of ['push_in', 'pan'] as const) {
      const { list } = faces(line(5), 16 / 9, OURNOTES_STYLE, move);
      const zoomK = move === 'push_in' ? fr.moveZoom : 1;
      const half = 16 / 9 / 2;
      for (const f of list) {
        expect(Math.abs(f.left) * zoomK).toBeLessThanOrEqual(half + 1e-6);
        expect(Math.abs(f.right) * zoomK).toBeLessThanOrEqual(half + 1e-6);
      }
    }
  });

  it('the spacing, rows and shrink are style values: global, scene and shot layers reach the solver', () => {
    const people = line(5);
    const resolve = (o: Record<string, number>, s?: Record<string, number>, b?: Record<string, number>) =>
      resolveStyle({ overrides: o }, s ? { overrides: s } : null, b ? { overrides: b } : null).values;
    const tight = faces(people, 16 / 9, resolve({ 'framing.groupSpacing': 0.8, 'framing.groupRowSpacing': 0.6, 'framing.groupStaggerFrom': 12, 'framing.groupMinScale': 1 })).list;
    const loose = faces(people, 16 / 9, resolve({ 'framing.groupStaggerFrom': 12 }, { 'framing.groupSpacing': 2 }, { 'framing.groupSpacing': 2.2 })).list;
    const d = (l: typeof tight) => (l.at(-1)!.x - l[0]!.x) / l[0]!.w;
    expect(d(loose)).toBeGreaterThan(d(tight));
    const flat = faces(people, 16 / 9, resolve({ 'framing.groupBackScale': 1, 'framing.groupRowDrop': 0, 'framing.groupStaggerFrom': 3 })).list;
    const drop = faces(people, 16 / 9, resolve({ 'framing.groupRowDrop': 0.8, 'framing.groupStaggerFrom': 3 })).list;
    const spread = (l: typeof flat) => Math.max(...l.map((f) => f.top)) - Math.min(...l.map((f) => f.top));
    expect(spread(drop)).toBeGreaterThan(spread(flat));
  });
});

describe('a group shot shows everybody on stage', () => {
  it('a person who is present but not in the focus is arranged with the others and keeps clear of every face', () => {
    const people = line(4);
    const [named, bystander] = [people.slice(0, 3), people[3]!];
    const s = solveShotDetailed({ type: 'group', focus: named, all: people, bg });
    expect(s.shifts[bystander.id], 'bystander is laid out').toBeDefined();
    const Hv = viewRect(bg, s.pose).h;
    const boxes = people.map((a) => {
      const sh = s.shifts[a.id]!;
      const cx = (a.head.x + a.head.w / 2 + sh.dx - s.pose.x) / Hv;
      return { left: cx - (a.head.w * sh.s) / 2 / Hv, right: cx + (a.head.w * sh.s) / 2 / Hv, x: cx };
    }).sort((p, q) => p.x - q.x);
    for (let i = 0; i + 1 < boxes.length; i++) expect(boxes[i + 1]!.left).toBeGreaterThanOrEqual(boxes[i]!.right - 1e-6);
  });
});

