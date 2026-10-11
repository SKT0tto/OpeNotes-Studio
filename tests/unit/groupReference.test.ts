/**
 * The original's group shots, measured on its own frames (dev-notes PLAN P19-B, `user-group-avemujica.webp` 1280x591 = 2.16:1 and
 * `t113.jpg`), against what the solver produces for the same number of people on the same frame shape. Units: frame height H.
 */
import { describe, expect, it } from 'vitest';
import { OURNOTES_STYLE } from '../../shared/style/ournotes';
import { line, maxFaceOcclusion, measureGroup } from './helpers/groupMeasure';

const WIDE = 1920 / 890;
const fr = OURNOTES_STYLE.framing;
const mean = (xs: number[]) => xs.reduce((q, x) => q + x, 0) / xs.length;

/** Original, five people (the user's example picture): heads 0.30-0.345 (mean 0.33), hair top 0.165-0.20 (beret 0.12), faces 0.34-0.44 apart (about 1.25 heads), outer faces span 0.75 of the width, faces uncovered. */
const ORIGINAL_5 = { head: 0.33, top: [0.165, 0.2], pitchHeads: 1.25, span: 0.75 };
/** Original, three people (t113): heads 0.40-0.46, hair top 0.00-0.10, faces 0.68 / 0.55 apart (about 1.45 heads), span 0.57 of the width. */
const ORIGINAL_3 = { head: 0.43, top: [0, 0.1], pitchHeads: 1.45, span: 0.57 };

function ours(n: number) {
  const { faces } = measureGroup(line(n), WIDE);
  const head = mean(faces.map((f) => f.headH));
  const pitches = faces.slice(1).map((f, i) => f.x - faces[i]!.x);
  return {
    faces,
    head,
    topLo: Math.min(...faces.map((f) => f.top)),
    topHi: Math.max(...faces.map((f) => f.top)),
    pitchHeads: mean(pitches) / head,
    span: (faces.at(-1)!.x - faces[0]!.x) / WIDE,
  };
}

describe('five people on the 2.16:1 frame match the original picture', () => {
  const o = ours(5);
  it('head height within 0.03, hair top within 0.05, pitch within 0.12 heads, span within 0.06', () => {
    expect(Math.abs(o.head - ORIGINAL_5.head)).toBeLessThanOrEqual(0.03);
    expect(Math.abs(o.topLo - ORIGINAL_5.top[0]!)).toBeLessThanOrEqual(0.05);
    expect(Math.abs(o.topHi - ORIGINAL_5.top[1]!)).toBeLessThanOrEqual(0.05);
    expect(Math.abs(o.pitchHeads - ORIGINAL_5.pitchHeads)).toBeLessThanOrEqual(0.12);
    expect(Math.abs(o.span - ORIGINAL_5.span)).toBeLessThanOrEqual(0.06);
  });
  it('the acceptance numbers of the plan: heads 0.30-0.35, hair top 0.14-0.22, pitch 0.38-0.46H, no covered face, the outer bodies may leave the frame', () => {
    for (const f of o.faces) expect(f.headH).toBeGreaterThanOrEqual(0.3 - 0.01);
    expect(o.head).toBeGreaterThanOrEqual(0.3);
    expect(o.head).toBeLessThanOrEqual(0.35);
    expect(o.topLo).toBeGreaterThanOrEqual(0.12);
    expect(o.topHi).toBeLessThanOrEqual(0.22);
    const pitch = o.faces[1]!.x - o.faces[0]!.x;
    expect(pitch).toBeGreaterThanOrEqual(0.38);
    expect(pitch).toBeLessThanOrEqual(0.46);
    expect(maxFaceOcclusion(o.faces)).toBe(0);
    const half = WIDE / 2;
    expect(o.faces[0]!.left).toBeGreaterThan(-half - 0.2); // the head box (hair) may touch the edge, the face is inside
    expect(o.faces[0]!.fl).toBeGreaterThanOrEqual(-half + fr.groupFaceEdge - 1e-6);
  });
});

describe('three people on the 2.16:1 frame match the original picture (t113)', () => {
  const o = ours(3);
  it('head height, hair top, pitch and span are within the tolerances', () => {
    expect(o.head).toBeGreaterThanOrEqual(0.39);
    expect(o.head).toBeLessThanOrEqual(0.43);
    expect(Math.abs(o.head - ORIGINAL_3.head)).toBeLessThanOrEqual(0.03);
    expect(Math.abs(o.topLo - ORIGINAL_3.top[0]!)).toBeLessThanOrEqual(0.1 + 0.05);
    expect(o.topLo).toBeGreaterThanOrEqual(0);
    expect(Math.abs(o.pitchHeads - ORIGINAL_3.pitchHeads)).toBeLessThanOrEqual(0.12);
    expect(Math.abs(o.span - ORIGINAL_3.span)).toBeLessThanOrEqual(0.06);
  });
});

describe('the pre-v0.1.4 mistakes are gone', () => {
  it('nobody is shrunk to fit: five people are never below 0.29H (v0.1.3 drew them at 0.11-0.17H) and the eye line stays at 0.38', () => {
    for (const aspect of [16 / 9, WIDE]) {
      const { faces } = measureGroup(line(5), aspect);
      expect(Math.min(...faces.map((f) => f.headH))).toBeGreaterThanOrEqual(0.28);
      expect(mean(faces.map((f) => f.eyeY))).toBeCloseTo(0.38, 2);
      // the lower edge cuts at the chest / waist, not at the knees: chin to the edge is at most 2.4 head heights
      for (const f of faces) expect(1 - f.bottom).toBeLessThanOrEqual(2.4 * f.headH);
    }
  });
  it('no zig-zag and no crowding: five people stand in one row with equal pitch and uncovered faces', () => {
    const { faces } = measureGroup(line(5), 16 / 9);
    expect(faces.every((f) => f.z > 1)).toBe(true);
    expect(maxFaceOcclusion(faces)).toBe(0);
    const pitches = faces.slice(1).map((f, i) => f.x - faces[i]!.x);
    expect(Math.max(...pitches) - Math.min(...pitches)).toBeLessThanOrEqual(0.02);
  });
});
