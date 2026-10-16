/**
 * Pure geometry of the travel camera system: anchored interpolation between two static solutions, the settle start pose,
 * the landing push-in and the empty-shot drift end pose. Nothing here reads a project; compile.ts decides where each is used.
 * The background is not handled here: it is derived from the camera pose (travelBg.ts).
 */
import { viewWorldHeight, type BgInfo, type CameraPose, type Pt } from './world';
import { lerp } from '../timeline/easing';
import type { CameraTravel } from '../timeline/types';

const logLerp = (a: number, b: number, e: number) => Math.exp(lerp(Math.log(a), Math.log(b), e));

/**
 * Interpolation around the anchor F: zoom moves in log space and F's screen offset is interpolated linearly, so F travels in a
 * straight line on screen. e=0 gives a, e=1 gives b.
 */
export function travelPose(a: CameraPose, b: CameraPose, e: number, tr: CameraTravel): CameraPose {
  const F = tr.anchor!;
  const z = logLerp(a.zoom, b.zoom, e);
  const sx = lerp((F.x - a.x) * a.zoom, (F.x - b.x) * b.zoom, e);
  const sy = lerp((F.y - a.y) * a.zoom, (F.y - b.y) * b.zoom, e);
  const out: CameraPose = { x: F.x - sx / z, y: F.y - sy / z, zoom: z };
  if (a.roll !== undefined || b.roll !== undefined) out.roll = lerp(a.roll ?? 0, b.roll ?? 0, e);
  return out;
}

/** The pose enlarged by k about F (F keeps its place on screen); not clamped. k > 1 pushes in, k < 1 pulls out. */
export function pushAbout(pose: CameraPose, F: Pt, k: number): CameraPose {
  const zoom = pose.zoom * k;
  return { ...pose, zoom, x: F.x - ((F.x - pose.x) * pose.zoom) / zoom, y: F.y - ((F.y - pose.y) * pose.zoom) / zoom };
}

/** Settle start: keep F where it is on screen and pull the pose back by k. */
export const settleStart = (pose: CameraPose, F: Pt, k: number): CameraPose => pushAbout(pose, F, 1 / k);

/** Drift end of an empty shot: sideways by share * frame width (direction sign), pushed in by zk. */
export function driftEnd(pose: CameraPose, sign: 1 | -1, share: number, zk: number, bg: BgInfo, aspect: number): CameraPose {
  const W = (viewWorldHeight(bg) * aspect) / pose.zoom;
  return { ...pose, x: pose.x + sign * share * W, zoom: pose.zoom * zk };
}
