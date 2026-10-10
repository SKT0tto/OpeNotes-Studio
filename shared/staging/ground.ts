/**
 * Actor placement: slot/depth -> world position, scale and boxes.
 * Perspective model: the ground at depth d lies at horizon + (floor - horizon) * scale(d), so feet of far actors
 * rise towards the horizon in proportion to how much smaller they are (no floating, no sinking).
 */
import type { Calibration } from '../schema/calibration';
import { clamp, lerp } from '../timeline/easing';
import { viewWorldHeight, type BgInfo, type GroundParams, type Pt, type Rect } from './world';

/** Head height of a depth-0 actor as a share of the zoom-1 viewport height. */
export const HEAD_FRAC = 0.1;
/** Full-body height (share of viewport) used to bound per-model head scaling. */
export const BODY_FRAC = 0.6;
export const FAR_SCALE = 0.6;
/** Slots -1..1 map to this share of the background width around the centre. */
export const SLOT_SPAN = 0.76;
export const SCALE_CLAMP = { min: 0.75, max: 1.3 };

export const depthScale = (depth: number) => lerp(1, FAR_SCALE, clamp(depth, 0, 1));
export const slotToX = (slot: number, bg: Pick<BgInfo, 'width'>) => bg.width * (0.5 + clamp(slot, -1, 1) * (SLOT_SPAN / 2));
export const groundY = (depth: number, g: GroundParams) => g.horizonY + (g.floorY - g.horizonY) * depthScale(depth);

export interface Placement {
  /** World point where the feet touch the ground. */
  feet: Pt;
  /** Container scale: world units per model pixel (always > 0, never flipped). */
  k: number;
  /** Container position (world) such that the model's ground anchor lands on `feet`. */
  pos: Pt;
  headBox: Rect;
  headCenter: Pt;
  bodyBox: Rect;
  /** Head height in world units. */
  headUnit: number;
  depth: number;
}

const toWorld = (r: Rect, pos: Pt, k: number): Rect => ({ x: pos.x + r.x * k, y: pos.y + r.y * k, w: r.w * k, h: r.h * k });

export function placeActor(
  cal: Pick<Calibration, 'ground' | 'head' | 'bounds' | 'totalHeight'>,
  at: { slot: number; depth: number },
  bg: BgInfo,
  heightFactor = 1,
): Placement {
  const H = viewWorldHeight(bg);
  const sc = depthScale(at.depth) * heightFactor;
  const headK = (HEAD_FRAC * H * sc) / cal.head.height;
  const nominalK = (BODY_FRAC * H * sc) / cal.totalHeight;
  const k = clamp(headK, nominalK * SCALE_CLAMP.min, nominalK * SCALE_CLAMP.max);
  const feet = { x: slotToX(at.slot, bg), y: groundY(at.depth, bg.ground) };
  const pos = { x: feet.x - cal.ground.x * k, y: feet.y - cal.ground.y * k };
  const headBox = toWorld(cal.head.bbox, pos, k);
  return {
    feet,
    k,
    pos,
    headBox,
    headCenter: { x: headBox.x + headBox.w / 2, y: headBox.y + headBox.h / 2 },
    bodyBox: toWorld(cal.bounds, pos, k),
    headUnit: headBox.h,
    depth: at.depth,
  };
}

/** Inverse of the feet position of `placeActor`: the slot / depth whose feet land on a world point (clamped to the stage). */
export function feetToSlotDepth(feet: Pt, bg: Pick<BgInfo, 'width' | 'ground'>): { slot: number; depth: number } {
  const slot = clamp(((feet.x / bg.width) - 0.5) / (SLOT_SPAN / 2), -1, 1);
  const span = bg.ground.floorY - bg.ground.horizonY;
  const scale = span > 0 ? (feet.y - bg.ground.horizonY) / span : 1;
  const depth = clamp((1 - scale) / (1 - FAR_SCALE), 0, 1);
  return { slot, depth };
}
