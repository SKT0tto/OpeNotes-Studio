/**
 * Additive head / body / gaze overlay on top of whatever the motion is doing.
 *
 * Injection point: the engine calls `updateFocus()` after
 * `saveParameters()` (motion + expression already applied) and before physics, and ends the
 * frame with `loadParameters()`. Adding here therefore (1) lets hair physics react to the turn
 * and (2) never accumulates across frames, because the saved motion values are restored.
 *
 * No Pixi / Cubism imports: the core model is reached through the small `ParamAccess` interface.
 */
import { BODY_ANGLE_RANGE, HEAD_ANGLE_RANGE } from '@shared/staging/facing';
import type { AxisSigns } from '@shared/schema/calibration';

export interface OverrideIntents {
  /** Screen-space intents, -1..1. Positive = towards screen-right / up. */
  headYaw: number;
  bodyYaw: number;
  gazeX: number;
  gazeY: number;
}
export const ZERO_INTENTS: OverrideIntents = { headYaw: 0, bodyYaw: 0, gazeX: 0, gazeY: 0 };

export interface ParamAccess {
  /** Index of an EXISTING parameter id, or -1. Must never create parameters. */
  indexOf(id: string): number;
  get(index: number): number;
  set(index: number, value: number): void;
  min(index: number): number;
  max(index: number): number;
}

export interface ParamDelta {
  id: string;
  delta: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
export const clampIntent = (v: number) => clamp(Number.isFinite(v) ? v : 0, -1, 1);

/**
 * Map screen-space intents to parameter-unit deltas using the model's calibrated axis signs.
 * An axis with sign 0 (e.g. no ParamEyeBallX) produces no delta.
 */
export function mapIntents(i: OverrideIntents, signs: AxisSigns): ParamDelta[] {
  const out: ParamDelta[] = [];
  if (signs.headSign !== 0) out.push({ id: 'ParamAngleX', delta: signs.headSign * clampIntent(i.headYaw) * HEAD_ANGLE_RANGE });
  if (signs.bodySign !== 0) out.push({ id: 'ParamBodyAngleX', delta: signs.bodySign * clampIntent(i.bodyYaw) * BODY_ANGLE_RANGE });
  if (signs.eyeSign !== 0) out.push({ id: 'ParamEyeBallX', delta: signs.eyeSign * clampIntent(i.gazeX) });
  out.push({ id: 'ParamEyeBallY', delta: clampIntent(i.gazeY) });
  return out;
}

/** current + delta, clamped to the parameter's real range (never pushes a value that is already outside further out). */
export function addClamped(current: number, delta: number, min: number, max: number): number {
  return clamp(current + delta, Math.min(min, current), Math.max(max, current));
}

const easeInOutQuad = (t: number) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
const KEYS = ['headYaw', 'bodyYaw', 'gazeX', 'gazeY'] as const;

export class ParamOverride {
  private from: OverrideIntents = { ...ZERO_INTENTS };
  private to: OverrideIntents = { ...ZERO_INTENTS };
  private cur: OverrideIntents = { ...ZERO_INTENTS };
  private elapsed = 0;
  private duration = 0;
  private ids = new Map<string, number>();

  constructor(
    private readonly access: ParamAccess,
    public signs: AxisSigns,
  ) {}

  get current(): Readonly<OverrideIntents> {
    return this.cur;
  }

  /** Ease from the present intents to `target` over `durationSec` (InOutQuad). 0 = immediate. */
  setTarget(target: Partial<OverrideIntents>, durationSec = 0.4): void {
    this.from = { ...this.cur };
    this.to = { ...this.to };
    for (const k of KEYS) if (target[k] !== undefined) this.to[k] = clampIntent(target[k]);
    this.elapsed = 0;
    this.duration = Math.max(0, durationSec);
    if (this.duration === 0) this.cur = { ...this.to };
  }

  /** Advance the easing; called once per frame with the frame delta (seconds). */
  step(dt: number): void {
    if (this.duration === 0 || this.elapsed >= this.duration) return;
    this.elapsed = Math.min(this.duration, this.elapsed + Math.max(0, dt));
    const e = easeInOutQuad(this.elapsed / this.duration);
    for (const k of KEYS) this.cur[k] = this.from[k] + (this.to[k] - this.from[k]) * e;
  }

  /** Add the current overlay onto the live parameter values. Only existing parameters are touched. */
  apply(): void {
    for (const { id, delta } of mapIntents(this.cur, this.signs)) {
      if (delta === 0) continue;
      let idx = this.ids.get(id);
      if (idx === undefined) {
        idx = this.access.indexOf(id);
        this.ids.set(id, idx);
      }
      if (idx < 0) continue;
      this.access.set(idx, addClamped(this.access.get(idx), delta, this.access.min(idx), this.access.max(idx)));
    }
  }
}
