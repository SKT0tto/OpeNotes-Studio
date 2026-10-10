/**
 * Geometric probe of a loaded model: ground contact, head box ("head unit") and the on-screen
 * direction of ParamAngleX / ParamBodyAngleX / ParamEyeBallX. Pure measurement of drawable
 * vertices after setting parameters and running the core update synchronously; every parameter
 * is restored afterwards, so the probe is invisible to the render loop.
 */
import type { Calibration } from '@shared/schema/calibration';
import type { Live2DActor } from './Live2DActor';

type Pose = Float32Array[]; // vertices (x,y pairs, model-local pixels) per drawable

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const SWEEP = { ParamAngleX: 30, ParamBodyAngleX: 10, ParamEyeBallX: 1 } as const;
/** Drawables moving at least this share of the strongest mover belong to the "moving part" set. */
const MOVER_SHARE = 0.35;

function readPose(actor: Live2DActor): { pose: Pose; visible: boolean[] } {
  const im = actor.internal;
  const core = im.coreModel;
  core.update();
  const n = core.getDrawableCount();
  const pose: Pose = [];
  const visible: boolean[] = [];
  for (let i = 0; i < n; i++) {
    pose.push(im.getDrawableVertices(i));
    visible.push(core.getDrawableDynamicFlagIsVisible(i) && core.getDrawableOpacity(i) > 0.02 && pose[i]!.length > 0);
  }
  return { pose, visible };
}

function rectOf(poses: Array<{ v: Float32Array }>): Rect | null {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const { v } of poses) {
    for (let i = 0; i < v.length; i += 2) {
      x0 = Math.min(x0, v[i]!);
      x1 = Math.max(x1, v[i]!);
      y0 = Math.min(y0, v[i + 1]!);
      y1 = Math.max(y1, v[i + 1]!);
    }
  }
  return Number.isFinite(x0) ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
}

interface Sweep {
  /** Mean vertex displacement magnitude per drawable. */
  mag: number[];
  /** Mean signed x displacement (+ pose minus - pose) per drawable. */
  dx: number[];
  max: number;
}

function sweep(actor: Live2DActor, id: keyof typeof SWEEP, visible: boolean[]): Sweep | null {
  const idx = actor.params.find((p) => p.id === id);
  if (!idx) return null;
  const core = actor.internal.coreModel;
  const amp = Math.min(SWEEP[id], idx.max);
  core.setParameterValueByIndex(idx.index, Math.max(idx.min, -amp));
  const neg = readPose(actor).pose;
  core.setParameterValueByIndex(idx.index, amp);
  const pos = readPose(actor).pose;
  core.setParameterValueByIndex(idx.index, idx.default);
  const mag: number[] = [];
  const dx: number[] = [];
  let max = 0;
  for (let d = 0; d < pos.length; d++) {
    const a = pos[d]!, b = neg[d]!;
    let m = 0, sx = 0;
    const n = Math.min(a.length, b.length) / 2;
    for (let k = 0; k < n; k++) {
      const ddx = a[2 * k]! - b[2 * k]!;
      const ddy = a[2 * k + 1]! - b[2 * k + 1]!;
      m += Math.hypot(ddx, ddy);
      sx += ddx;
    }
    const mm = n > 0 && visible[d] ? m / n : 0;
    mag.push(mm);
    dx.push(n > 0 ? sx / n : 0);
    max = Math.max(max, mm);
  }
  return { mag, dx, max };
}

const movers = (s: Sweep): number[] => s.mag.map((m, i) => (m >= s.max * MOVER_SHARE ? i : -1)).filter((i) => i >= 0);

/** Sign of the displacement-weighted mean x shift of the moving drawables (+1: towards screen-right). */
function signOf(s: Sweep | null): -1 | 0 | 1 {
  if (!s || s.max <= 0.5) return 0;
  let sum = 0;
  for (const i of movers(s)) sum += s.dx[i]! * s.mag[i]!;
  return sum > 0 ? 1 : sum < 0 ? -1 : 0;
}

/** Mean y of the strongest movers of a sweep (the pupils for ParamEyeBallX). */
function centroidY(s: Sweep, base: Pose): number | null {
  let sum = 0, n = 0;
  for (const i of movers(s)) {
    const v = base[i]!;
    for (let k = 1; k < v.length; k += 2) { sum += v[k]!; n++; }
  }
  return n > 0 ? sum / n : null;
}

/** Eyes sit about this fraction of the way from the crown to the chin on these models. */
const EYE_LINE = 0.56;

/** Run the probe. Call with the actor loaded and at least one frame rendered; never mid-frame. */
export function probeModel(actor: Live2DActor, modelId: string): Calibration {
  const core = actor.internal.coreModel;
  const saved = actor.params.map((p) => core.getParameterValueByIndex(p.index));
  try {
    for (const p of actor.params) core.setParameterValueByIndex(p.index, p.default);
    const { pose: base, visible } = readPose(actor);
    const shown = base.map((v, i) => ({ v, i })).filter((e) => visible[e.i]);
    const bounds = rectOf(shown);
    if (!bounds) throw new Error('probe: model has no visible drawables');

    const head = sweep(actor, 'ParamAngleX', visible);
    const body = sweep(actor, 'ParamBodyAngleX', visible);
    const eye = sweep(actor, 'ParamEyeBallX', visible);

    const headSet = head && head.max > 0.5 ? movers(head).map((i) => ({ v: base[i]! })) : [];
    const moverBox = rectOf(headSet) ?? { x: bounds.x + bounds.w * 0.3, y: bounds.y, w: bounds.w * 0.4, h: bounds.h * 0.15 };
    // Long hair / twin tails move with the head and would inflate the box downwards. When the eyes can
    // be located, cut the head off at the chin, estimated from the crown-to-eye distance.
    const eyeY = eye && eye.max > 0.5 ? centroidY(eye, base) : null;
    const chinH = eyeY === null ? Infinity : (eyeY - moverBox.y) / EYE_LINE;
    const headBox = { ...moverBox, h: Math.min(moverBox.h, chinH) };

    return {
      version: 1,
      modelId,
      bounds,
      ground: { x: bounds.x + bounds.w / 2, y: bounds.y + bounds.h },
      totalHeight: bounds.h,
      head: { bbox: headBox, center: { x: headBox.x + headBox.w / 2, y: headBox.y + headBox.h / 2 }, height: headBox.h },
      headSign: signOf(head),
      bodySign: signOf(body),
      eyeSign: signOf(eye),
      hasEyeBallX: eye !== null,
      verified: false,
      probedAt: new Date().toISOString(),
    };
  } finally {
    actor.params.forEach((p, i) => core.setParameterValueByIndex(p.index, saved[i]!));
  }
}
