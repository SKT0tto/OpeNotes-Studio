/**
 * v0.1.4 group shots (three or more people), PLAN P19-B: big tight heads like the original, faces never covered and always inside the
 * frame, bodies may overlap and leave the frame, one row, centred, equal pitch, similar sizes, nobody shown full-body.
 */
import { describe, expect, it } from 'vitest';
import { cameraMove, groupHeadTarget, groupPitchHeads, solveShotDetailed, visibleHead } from '../../shared/staging/framing';
import { viewRect } from '../../shared/staging/world';
import { OURNOTES_STYLE, resolveStyle } from '../../shared/style/ournotes';
import { ASPECTS, actorOf, band, bg, calWithHead, expectedHead, line, maxFaceOcclusion, measureGroup } from './helpers/groupMeasure';

const fr = OURNOTES_STYLE.framing;
const mean = (xs: number[]) => xs.reduce((q, x) => q + x, 0) / xs.length;
/** Head width over visible head height of the synthetic model (the plan's headW/headH). */
const R = (() => {
  const a = line(1)[0]!;
  return a.head.w / visibleHead(a, fr).h;
})();

// Table of PLAN P19-B (tolerance +-0.015; the wide-frame rows are the target, the 16:9 rows follow from the faces fitting the frame).
const PLAN_TABLE: Record<string, Record<number, { head: number; pitch: number }>> = {
  '16:9': { 3: { head: 0.41, pitch: 0.59 }, 4: { head: 0.35, pitch: 0.48 }, 5: { head: 0.29, pitch: 0.37 }, 6: { head: 0.25, pitch: 0.3 } },
  '2.16:1': { 3: { head: 0.41, pitch: 0.59 }, 4: { head: 0.365, pitch: 0.5 }, 5: { head: 0.325, pitch: 0.42 }, 6: { head: 0.29, pitch: 0.35 } },
};

describe('group defaults', () => {
  it('head target 0.41 / 0.365 / 0.325 / 0.29 for 3-6 people, pitch 1.45 -> 1.21 heads', () => {
    [0.41, 0.365, 0.325, 0.29].forEach((v, i) => expect(groupHeadTarget(i + 3, fr)).toBeCloseTo(v, 2));
    expect([3, 4, 5, 6].map((n) => +groupPitchHeads(n, fr).toFixed(2))).toEqual([1.45, 1.37, 1.29, 1.21]);
    expect(groupPitchHeads(40, fr)).toBe(fr.groupPitchMin);
    expect(groupHeadTarget(40, fr)).toBe(fr.groupHeadMin);
  });
});

describe('groups of three or more look like the original', () => {
  for (const [name, aspect] of ASPECTS) {
    for (const n of [3, 4, 5, 6]) {
      for (const [kind, make] of [['daily', line], ['band', band]] as const) {
        it(`${n} people (${kind}) at ${name}: head size, pitch, no covered face, faces inside, centred, not full-body`, () => {
          const people = make(n);
          const { faces, solution } = measureGroup(people, aspect);
          expect(faces).toHaveLength(n);
          const front = faces.filter((f) => f.z > 1); // z = 1 marks the back row
          const m = front.length;
          // head size: the formula, and the table of the plan
          const head = mean(front.map((f) => f.headH));
          const exp = expectedHead(Math.max(3, m), aspect, R);
          const backRow = faces.length > m; // a back person between two front faces needs a wider pitch (its face must not touch theirs)
          if (!backRow) expect(head, 'mean front head height').toBeGreaterThan(exp - 0.006);
          expect(head).toBeLessThan(exp + 0.006);
          if (kind === 'daily') {
            const row = PLAN_TABLE[name]![n]!;
            expect(Math.abs(head - row.head), `plan table ${name} ${n}`).toBeLessThanOrEqual(0.02);
          }
          // equal pitch between neighbouring front faces, of the right size
          const pitches = front.slice(1).map((f, i) => f.x - front[i]!.x);
          expect(Math.max(...pitches) - Math.min(...pitches), 'pitch spread').toBeLessThanOrEqual(0.02);
          expect(mean(pitches) / head, 'pitch in head heights').toBeGreaterThan(groupPitchHeads(Math.max(3, m), fr) * 0.97);
          if (!backRow) expect(mean(pitches) / head).toBeLessThan(groupPitchHeads(Math.max(3, m), fr) * 1.03);
          // faces: nobody covered, everybody fully inside the frame (hair and bodies may leave it)
          expect(maxFaceOcclusion(faces), 'covered face').toBe(0);
          const half = aspect / 2;
          for (const f of faces) {
            expect(f.fl, `${f.id} face left`).toBeGreaterThanOrEqual(-half + fr.groupFaceEdge - 1e-6);
            expect(f.fr, `${f.id} face right`).toBeLessThanOrEqual(half - fr.groupFaceEdge + 1e-6);
            expect(f.top, `${f.id} hair top`).toBeGreaterThanOrEqual(-1e-6);
            expect(1 - f.bottom, `${f.id} no full body: chin to the lower edge`).toBeLessThanOrEqual(2.4 * f.headH + 1e-6);
          }
          // centred: the outer faces average to the frame centre
          expect(Math.abs((front[0]!.x + front.at(-1)!.x) / 2), 'group centre').toBeLessThanOrEqual(0.02);
          // eye lines of the front row (pulled together) and a head size spread of at most 10%
          const eyes = front.map((f) => f.eyeY);
          expect(Math.max(...eyes) - Math.min(...eyes), 'eye line spread').toBeLessThanOrEqual(0.04);
          expect(solution.edgeCut).toEqual([]);
        });
      }
    }
  }

  it('the eye line of the front row is groupEyeY and the hair of the tallest stays inside the frame', () => {
    for (const [, aspect] of ASPECTS) {
      const { faces } = measureGroup(line(5), aspect);
      expect(mean(faces.map((f) => f.eyeY))).toBeCloseTo(fr.groupEyeY, 2);
      expect(Math.min(...faces.map((f) => f.top))).toBeGreaterThanOrEqual(0);
    }
  });

  it('different head sizes are pulled together: smallest / biggest head >= 0.90 (centre person x1.04)', () => {
    // heads of other widths, and people standing at different depths (the nearer one is drawn bigger by the blocking)
    const cals = [0.96, 1.04, 1.0, 0.98, 1.02].map((k, i) => calWithHead(`m${i}`, k, i === 1 ? 1.3 : 1));
    const depths = [0.0, 0.2, 0.05, 0.15, 0.1];
    const people = depths.map((d, i) => actorOf(`p${i}`, -0.7 + 0.35 * i, d, cals[i]));
    for (const [, aspect] of ASPECTS) {
      const { faces } = measureGroup(people, aspect);
      const hs = faces.map((f) => f.headH);
      expect(Math.min(...hs) / Math.max(...hs)).toBeGreaterThanOrEqual(0.9);
      expect(maxFaceOcclusion(faces)).toBe(0);
      const eyes = faces.map((f) => f.eyeY);
      expect(Math.max(...eyes) - Math.min(...eyes)).toBeLessThanOrEqual(0.04);
    }
  });

  it('the middle person of an odd row is x1.04 and in front; the draw order falls off towards the sides', () => {
    const { faces } = measureGroup(line(5), 1920 / 890);
    const mid = faces[2]!;
    expect(mid.headH / faces[1]!.headH).toBeGreaterThan(1.02);
    expect(mid.headH / faces[1]!.headH).toBeLessThan(1.06);
    expect(faces.map((f) => f.z)).toEqual([80, 90, 100, 90, 80]);
    const even = measureGroup(line(4), 1920 / 890).faces.map((f) => f.scale);
    expect(Math.max(...even) / Math.min(...even), 'no centre person in an even row').toBeLessThan(1.02);
  });

  it('without depth in the blocking there is one row, whatever the number of people (no zig-zag)', () => {
    for (const n of [4, 5, 6]) {
      const { faces } = measureGroup(line(n), 16 / 9);
      expect(new Set(faces.map((f) => f.z > 1)).size).toBe(1);
      const eyes = faces.map((f) => f.eyeY);
      expect(Math.max(...eyes) - Math.min(...eyes)).toBeLessThanOrEqual(0.02);
    }
  });

  it('wide frames keep the head sizes and only add width: the pitch does not stretch with the aspect', () => {
    const narrow = measureGroup(line(4), 16 / 9).faces;
    const wide = measureGroup(line(4), 1920 / 890).faces;
    const span = (l: typeof narrow) => l.at(-1)!.x - l[0]!.x;
    expect(span(wide)).toBeGreaterThan(span(narrow) * 0.99);
    expect(wide[0]!.headH).toBeGreaterThanOrEqual(narrow[0]!.headH - 1e-6);
    // pitch in heads is the same, only the head is bigger
    const pitchHeads = (l: typeof narrow) => (l[1]!.x - l[0]!.x) / l[0]!.headH;
    expect(pitchHeads(wide)).toBeCloseTo(pitchHeads(narrow), 2);
  });

  it('never smaller than groupHeadMin, however many people (the rest stand behind)', () => {
    for (const n of [7, 9, 12]) {
      for (const [, aspect] of ASPECTS) {
        const { faces } = measureGroup(line(n), aspect);
        expect(faces).toHaveLength(n);
        const front = faces.filter((f) => f.z > 1);
        const back = faces.filter((f) => f.z === 1);
        expect(front.length).toBe(fr.groupFrontCrowded);
        expect(back.length).toBe(n - front.length);
        expect(Math.min(...front.map((f) => f.headH))).toBeGreaterThanOrEqual(fr.groupHeadMin - 0.005);
        // behind the front row: lower, smaller, standing between two front faces
        for (const b of back) {
          expect(b.headH).toBeLessThan(front[0]!.headH);
          expect(b.eyeY).toBeGreaterThan(mean(front.map((f) => f.eyeY)));
        }
      }
    }
  });

  it('beyond five people the focus people stay in the front row', () => {
    const people = line(8);
    const focus = [people[7]!, people[0]!, people[3]!];
    const { faces } = measureGroup(people, 1920 / 890, OURNOTES_STYLE, undefined, focus);
    for (const f of focus) expect(faces.find((x) => x.id === f.id)!.z, f.id).toBeGreaterThan(1);
  });
});

describe('a band', () => {
  for (const [name, aspect] of ASPECTS) {
    it(`at ${name}: the vocalist is the nearest to the centre; with enough depth the drummer stands behind, between two front faces`, () => {
      for (const n of [3, 4, 5, 6]) {
        const { faces } = measureGroup(band(n), aspect);
        const vo = faces.find((f) => f.id === 'vo')!;
        const dr = faces.find((f) => f.id === 'dr')!;
        expect(Math.min(...faces.map((f) => Math.abs(f.x))), `${n}: someone is at the centre`).toBeGreaterThanOrEqual(0);
        const front = faces.filter((f) => f.id !== 'dr');
        expect(Math.abs(vo.x), `${n}: vocalist nearest to the centre`).toBeLessThanOrEqual(Math.min(...front.map((f) => Math.abs(f.x))) + 1e-9);
        expect(dr.z).toBe(1);
        expect(dr.eyeY).toBeGreaterThan(vo.eyeY + 0.03); // lower = further back
        expect(dr.headH).toBeLessThan(vo.headH);
        const left = front.filter((f) => f.x < dr.x).length;
        expect(left).toBeGreaterThanOrEqual(1);
        expect(front.length - left).toBeGreaterThanOrEqual(1);
        expect(maxFaceOcclusion(faces)).toBe(0);
      }
    });
  }

  it('a drummer who is not behind (small depth difference) stands in the same row', () => {
    const people = band(5).map((a) => (a.id === 'dr' ? actorOf('dr', 0.1, 0.25) : a));
    const { faces } = measureGroup(people, 16 / 9);
    expect(faces.every((f) => f.z > 1)).toBe(true);
  });
});

describe('camera moves of a group stay small and keep the faces in the frame', () => {
  const cases: Array<['push_in' | 'pull_out' | 'pan' | 'track']> = [['push_in'], ['pull_out'], ['pan'], ['track']];
  for (const [move] of cases) {
    for (const [name, aspect] of ASPECTS) {
      it(`${move} at ${name}`, () => {
        const people = line(5);
        const still = measureGroup(people, aspect);
        const moved = measureGroup(people, aspect, OURNOTES_STYLE, move);
        const limits = moved.solution.moveLimits!;
        expect(limits.moveZoom).toBeLessThanOrEqual(1.05);
        expect(limits.panShare).toBeLessThanOrEqual(0.03);
        // head size loses at most 5% to make room
        expect(moved.faces[0]!.headH / still.faces[0]!.headH).toBeGreaterThanOrEqual(0.95 - 1e-6);
        // both ends of the move: faces inside the frame
        const { from, to } = cameraMove(moved.pose, move, bg, { ...fr, ...limits }, aspect);
        for (const pose of [from, to]) {
          const Hv = viewRect(bg, pose, aspect).h;
          const vw = viewRect(bg, pose, aspect).w;
          const centre = viewRect(bg, pose, aspect).x + vw / 2;
          for (const f of moved.faces) {
            // face edges in world x, relative to the moved camera
            const fcx = moved.pose.x + f.x * moved.Hv;
            const fw = (f.fr - f.fl) * moved.Hv;
            expect((fcx - fw / 2 - centre) / Hv, `${f.id} left @${move}`).toBeGreaterThanOrEqual(-aspect / 2 + fr.groupFaceEdge - 1e-6);
            expect((fcx + fw / 2 - centre) / Hv, `${f.id} right @${move}`).toBeLessThanOrEqual(aspect / 2 - fr.groupFaceEdge + 1e-6);
          }
        }
      });
    }
  }
});

describe('group style values', () => {
  const resolve = (o: Record<string, number>, s?: Record<string, number>, b?: Record<string, number>) =>
    resolveStyle({ overrides: o }, s ? { overrides: s } : null, b ? { overrides: b } : null);

  it('pitch, head size and eye line are style values: global, scene and shot layers reach the solver', () => {
    const people = line(4);
    const base = measureGroup(people, 1920 / 890).faces;
    const tight = measureGroup(people, 1920 / 890, resolve({ 'framing.groupPitch3': 1.3 }).values).faces;
    const tighter = measureGroup(people, 1920 / 890, resolve({ 'framing.groupPitch3': 2 }, { 'framing.groupPitch3': 1.3 }, { 'framing.groupPitch3': 1.2 }).values).faces;
    const pitch = (l: typeof base) => l[1]!.x - l[0]!.x;
    expect(pitch(tight)).toBeLessThan(pitch(base));
    expect(pitch(tighter)).toBeLessThan(pitch(tight));
    const high = measureGroup(people, 1920 / 890, resolve({ 'framing.groupEyeY': 0.3 }).values).faces;
    expect(mean(high.map((f) => f.eyeY))).toBeCloseTo(0.3, 2);
    const small = measureGroup(people, 1920 / 890, resolve({ 'framing.groupHead3': 0.3 }).values).faces;
    expect(small[0]!.headH).toBeLessThan(base[0]!.headH);
  });

  it('the pre-v0.1.4 group fields are gone: stored overrides are ignored and reported, not an error', () => {
    const r = resolve({ 'framing.groupSpacing': 1.2, 'framing.groupStaggerFrom': 3, 'framing.groupEdgeMargin': 0.2, 'framing.groupShrink': 0.2, 'framing.groupPitch3': 1.3 });
    expect(r.issues.sort()).toEqual(['project: framing.groupEdgeMargin', 'project: framing.groupShrink', 'project: framing.groupSpacing', 'project: framing.groupStaggerFrom']);
    expect(r.values.framing.groupPitch3).toBe(1.3);
    expect('groupSpacing' in r.values.framing).toBe(false);
  });
});

describe('a group shot shows everybody on stage', () => {
  it('a person who is present but not in the focus is arranged with the others and keeps clear of every face', () => {
    const people = line(4);
    const [named, bystander] = [people.slice(0, 3), people[3]!];
    const s = solveShotDetailed({ type: 'group', focus: named, all: people, bg });
    expect(s.shifts[bystander.id], 'bystander is laid out').toBeDefined();
    const { faces } = measureGroup(people, 16 / 9, OURNOTES_STYLE, undefined, named);
    expect(faces).toHaveLength(4);
    expect(maxFaceOcclusion(faces)).toBe(0);
  });

  it('two people asked for as a group are still the two-shot (unchanged rules)', () => {
    const two = line(2);
    const s = solveShotDetailed({ type: 'group', focus: two, all: two, bg });
    expect(s.moveLimits).toBeUndefined();
    const Hv = viewRect(bg, s.pose).h;
    const x = (a: (typeof two)[number]) => (s.shifts[a.id]!.dx + a.head.x + a.head.w / 2 - s.pose.x) / Hv;
    expect(x(two[0]!)).toBeCloseTo(-fr.twoShotFaceX, 3);
    expect(x(two[1]!)).toBeCloseTo(fr.twoShotFaceX, 3);
  });
});
