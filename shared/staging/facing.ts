/**
 * Facing resolution. Everything here is pure and camera independent: positions are WORLD
 * coordinates (never screen coordinates), so panning/zooming the camera cannot change who faces whom.
 *
 * Screen yaw `u` is normalised to [-1, 1]: +1 = facing screen-right as far as ParamAngleX's range
 * allows (30 degrees), 0 = frontal, -1 = facing screen-left.
 */
import type { MotionEntry } from '../schema/assets';

export const HEAD_ANGLE_RANGE = 30;
export const BODY_ANGLE_RANGE = 10;
/** Share of the head residual that the body follows (body range is a third of the head range). */
export const BODY_FOLLOW = 0.8;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const smoothstep = (e0: number, e1: number, x: number) => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};

export interface WorldPoint {
  x: number;
  y: number;
}

/**
 * Yaw needed to face `target` from `self`. `headUnit` is the head height in world units
 * (distances are measured in heads so the result does not depend on the world scale).
 * Closer targets get a stronger turn (1.0 -> 0.6 as the distance grows); a target almost straight
 * ahead fades to a frontal pose.
 */
export function desiredYaw(self: WorldPoint, target: WorldPoint, headUnit: number): number {
  const dx = target.x - self.x;
  const heads = Math.abs(dx) / Math.max(headUnit, 1e-6);
  const base = 1 - 0.4 * smoothstep(2, 10, heads);
  const ahead = smoothstep(0.15, 0.9, heads);
  return Math.sign(dx) * base * ahead;
}

/** Looking at the camera: frontal, with a slight lean (0.15) towards the conversation partner. */
export function yawTowardsCamera(self: WorldPoint, partner: WorldPoint | null): number {
  if (!partner) return 0;
  return 0.15 * Math.sign(partner.x - self.x);
}

/** Eye gaze (screen-space, -1..1) towards a target; mirrors the original LookTarget (0.2 per head-ish unit, clamped). */
export function desiredGaze(self: WorldPoint, target: WorldPoint, headUnit: number): { x: number; y: number } {
  const u = Math.max(headUnit, 1e-6);
  return { x: clamp(((target.x - self.x) / u) * 0.2, -1, 1), y: clamp((-(target.y - self.y) / u) * 0.2, -1, 1) };
}

export interface VariantCandidate {
  /** Raw motion name (what the engine plays). */
  name: string;
  side: 'L' | 'C' | 'R' | null;
  /** Nominal (time-weighted mean) ParamAngleX of the motion, degrees; null when unknown. */
  angleX: number | null;
}

/** Screen yaw a motion bakes in: its mean ParamAngleX seen through the model's calibrated head sign. */
export function nominalScreenYaw(angleX: number | null, headSign: number): number {
  return clamp((headSign * (angleX ?? 0)) / HEAD_ANGLE_RANGE, -1, 1);
}

export interface VariantChoice {
  name: string;
  nominalYaw: number;
}

/**
 * Pick the variant of one motion family whose baked-in yaw is closest to the desired screen yaw.
 * Ties and unknown angles prefer the centre variant. Returns null for an empty list.
 */
export function chooseMotionVariant(
  candidates: readonly VariantCandidate[],
  desiredYawScreen: number,
  headSign: number,
): VariantChoice | null {
  let best: (VariantChoice & { score: number }) | null = null;
  for (const c of candidates) {
    const nominalYaw = nominalScreenYaw(c.angleX, headSign);
    const score = Math.abs(nominalYaw - desiredYawScreen) + (c.side === 'C' ? -1e-6 : 0);
    if (!best || score < best.score) best = { name: c.name, nominalYaw, score };
  }
  return best ? { name: best.name, nominalYaw: best.nominalYaw } : null;
}

/** Candidates of one family from a model's indexed motions (e.g. `nod01` -> nod01_L/_C/_R). */
export function variantsOfFamily(motions: readonly MotionEntry[], family: string): VariantCandidate[] {
  const all = motions.filter((m) => m.family === family);
  const sided = all.filter((m) => m.side !== null && m.variant === '');
  return (sided.length > 0 ? sided : all).map((m) => ({
    name: m.name,
    side: m.side,
    angleX: m.stats?.angleX?.mean ?? null,
  }));
}

export interface ResidualInput {
  desiredYaw: number;
  nominalYaw: number;
  /** Mean ParamBodyAngleX / ParamEyeBallX of the chosen motion (for nominal body/eye), optional. */
  gaze?: { x: number; y: number };
}
export interface ResidualIntents {
  headYaw: number;
  bodyYaw: number;
  gazeX: number;
  gazeY: number;
}

/**
 * Additive residual (in ParamOverride intent units) that turns the chosen variant's baked-in yaw
 * into the desired one. The body follows the head by BODY_FOLLOW.
 */
export function residualOffset(input: ResidualInput): ResidualIntents {
  const head = clamp(input.desiredYaw - input.nominalYaw, -1, 1);
  return { headYaw: head, bodyYaw: clamp(head * BODY_FOLLOW, -1, 1), gazeX: input.gaze?.x ?? 0, gazeY: input.gaze?.y ?? 0 };
}
