import { describe, expect, it } from 'vitest';
import {
  chooseMotionVariant,
  desiredGaze,
  desiredYaw,
  residualOffset,
  variantsOfFamily,
  yawTowardsCamera,
  type VariantCandidate,
} from '../../shared/staging/facing';
import type { MotionEntry } from '../../shared/schema/assets';

const HEAD = 200;
const nod: VariantCandidate[] = [
  { name: 'mtn_nod01_L', side: 'L', angleX: 22 },
  { name: 'mtn_nod01_C', side: 'C', angleX: 0 },
  { name: 'mtn_nod01_R', side: 'R', angleX: -22 },
];
const A = { x: 500, y: 900 };
const B = { x: 1500, y: 900 };

describe('facing', () => {
  it('A on the left faces right, B on the right faces left, and they pick opposite variants (headSign +1)', () => {
    const ya = desiredYaw(A, B, HEAD);
    const yb = desiredYaw(B, A, HEAD);
    expect(ya).toBeGreaterThan(0.5);
    expect(yb).toBeLessThan(-0.5);
    expect(chooseMotionVariant(nod, ya, 1)?.name).toBe('mtn_nod01_L');
    expect(chooseMotionVariant(nod, yb, 1)?.name).toBe('mtn_nod01_R');
  });

  it('a model with headSign -1 picks the opposite variant for the same intent', () => {
    expect(chooseMotionVariant(nod, 0.9, -1)?.name).toBe('mtn_nod01_R');
  });

  it('is camera independent: only world positions matter', () => {
    const shift = (p: { x: number; y: number }, dx: number) => ({ x: p.x + dx, y: p.y });
    expect(desiredYaw(shift(A, 300), shift(B, 300), HEAD)).toBeCloseTo(desiredYaw(A, B, HEAD), 10);
  });

  it('a target straight ahead gives a frontal pose -> C variant', () => {
    const y = desiredYaw(A, { x: A.x + 5, y: 0 }, HEAD);
    expect(Math.abs(y)).toBeLessThan(0.05);
    expect(chooseMotionVariant(nod, y, 1)?.name).toBe('mtn_nod01_C');
    expect(chooseMotionVariant(nod, yawTowardsCamera(A, null), 1)?.name).toBe('mtn_nod01_C');
  });

  it('turns more for close targets than for distant ones, within 0.6..1', () => {
    const near = desiredYaw(A, { x: A.x + 2 * HEAD, y: 0 }, HEAD);
    const far = desiredYaw(A, { x: A.x + 20 * HEAD, y: 0 }, HEAD);
    expect(near).toBeGreaterThan(far);
    expect(far).toBeCloseTo(0.6, 5);
    expect(near).toBeLessThanOrEqual(1);
  });

  it('looking at the camera leans slightly towards the partner', () => {
    expect(yawTowardsCamera(A, B)).toBeCloseTo(0.15);
    expect(yawTowardsCamera(B, A)).toBeCloseTo(-0.15);
  });

  it('gaze is clamped and signed in screen space', () => {
    expect(desiredGaze(A, B, HEAD).x).toBe(1);
    expect(desiredGaze(B, A, HEAD).x).toBe(-1);
    expect(desiredGaze(A, { x: A.x + HEAD, y: A.y - HEAD }, HEAD).y).toBeGreaterThan(0); // target above -> look up
  });

  it('residual is desired minus nominal, with the body following partially', () => {
    const r = residualOffset({ desiredYaw: 0.9, nominalYaw: 0.73 });
    expect(r.headYaw).toBeCloseTo(0.17);
    expect(r.bodyYaw).toBeCloseTo(0.17 * 0.8);
    expect(residualOffset({ desiredYaw: -3, nominalYaw: 0.5 }).headYaw).toBe(-1);
  });

  it('handles irregular families: single variant, unknown angles, empty list', () => {
    expect(chooseMotionVariant([{ name: 'mtn_ide01', side: null, angleX: null }], 1, 1)).toEqual({ name: 'mtn_ide01', nominalYaw: 0 });
    expect(chooseMotionVariant([], 1, 1)).toBeNull();
  });

  it('variantsOfFamily prefers plain L/C/R over suffixed variants', () => {
    const mk = (name: string, side: 'L' | 'C' | 'R' | null, variant: string, a: number): MotionEntry => ({
      name,
      file: name,
      family: 'check01',
      side,
      variant,
      stats: { duration: 1, fps: 30, loop: false, angleX: { first: a, mean: a }, bodyAngleX: null, eyeBallX: null },
    });
    const list = [mk('mtn_check01_L', 'L', '', 20), mk('mtn_check01_R2', 'R', '2', -20), mk('mtn_check01_R', 'R', '', -20)];
    expect(variantsOfFamily(list, 'check01').map((v) => v.name)).toEqual(['mtn_check01_L', 'mtn_check01_R']);
  });
});
