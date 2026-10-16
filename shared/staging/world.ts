/**
 * World space: units are background pixels, origin at the background's top-left, y down.
 * The camera is a 2D orthographic camera (centre + zoom). At zoom 1 the viewport shows `viewWorldHeight`
 * world units vertically (the whole background height for 16:9 backgrounds).
 *
 * Actors live in world space and are scaled by the full camera zoom. The background is a separate layer that
 * only follows the camera with parallax (zoom^BG_PARALLAX), so a close-up never magnifies it as much as people,
 * and its centre is clamped so the viewport is always fully covered by background pixels.
 */
import { clamp } from '../timeline/easing';

export const ASPECT = 16 / 9;
export const BG_PARALLAX = 0.85;
export const MIN_ZOOM = 1;
export const MAX_ZOOM = 14;

export interface Pt {
  x: number;
  y: number;
}
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface CameraPose {
  x: number;
  y: number;
  zoom: number;
  /** Background magnification; absent = parallax `zoom^BG_PARALLAX` (legacy / lab). Set by the shot solver from the style table. */
  bgZoom?: number;
  /** Manual camera roll (degrees); added to the emotion Dutch roll. */
  roll?: number;
  /** Only inside a travel segment: the background view centre (world coordinates, without framing.offset). Absent = the camera centre. */
  bgX?: number;
  bgY?: number;
}
export interface GroundParams {
  /** World y of the horizon (vanishing line). */
  horizonY: number;
  /** World y where the feet of a depth-0 (front) actor touch the floor. */
  floorY: number;
}
export interface BgInfo {
  width: number;
  height: number;
  ground: GroundParams;
}
/** Extra user framing of a scene's background (Scene.background.framing). */
export interface BgFraming {
  zoom: number;
  offsetX: number;
  offsetY: number;
}
export const NO_FRAMING: BgFraming = { zoom: 1, offsetX: 0, offsetY: 0 };

export function defaultGround(width: number, height: number, setting?: string | null): GroundParams {
  const outdoors = setting === '室外';
  return { horizonY: height * (outdoors ? 0.46 : 0.5), floorY: height * 0.93 };
}

/** World height visible at zoom 1 (largest 16:9 window that fits inside the background). */
export function viewWorldHeight(bg: Pick<BgInfo, 'width' | 'height'>): number {
  return Math.min(bg.height, bg.width / ASPECT);
}

export const clampZoom = (z: number) => clamp(Number.isFinite(z) ? z : 1, MIN_ZOOM, MAX_ZOOM);

/** Pixels per world unit at zoom 1. */
export function baseScale(bg: Pick<BgInfo, 'width' | 'height'>, viewportH: number): number {
  return viewportH / viewWorldHeight(bg);
}

export const bgZoom = (zoom: number, framing: BgFraming = NO_FRAMING, explicit?: number) =>
  (explicit !== undefined ? Math.max(1, explicit) : Math.pow(clampZoom(zoom), BG_PARALLAX)) * Math.max(1, framing.zoom);

/** Background view: world point at the viewport centre and zoom of the background layer. */
export function bgView(bg: BgInfo, cam: CameraPose, framing: BgFraming = NO_FRAMING, aspect: number = ASPECT): { cx: number; cy: number; zoom: number } {
  // A wider window than 16:9 needs more of the picture: magnify just enough that the background still covers it.
  const zoom = Math.max(bgZoom(cam.zoom, framing, cam.bgZoom), (viewWorldHeight(bg) * aspect) / bg.width);
  const hw = (viewWorldHeight(bg) * aspect) / zoom / 2;
  const hh = viewWorldHeight(bg) / zoom / 2;
  return {
    cx: clamp((cam.bgX ?? cam.x) + framing.offsetX, hw, Math.max(hw, bg.width - hw)),
    cy: clamp((cam.bgY ?? cam.y) + framing.offsetY, hh, Math.max(hh, bg.height - hh)),
    zoom,
  };
}

/** Camera centre clamped to what the background layer can cover (used by the shot solver). */
export function clampCamera(bg: BgInfo, cam: CameraPose, framing: BgFraming = NO_FRAMING, aspect: number = ASPECT): CameraPose {
  const zoom = clampZoom(cam.zoom);
  const v = bgView(bg, { ...cam, zoom }, framing, aspect);
  return { x: v.cx - framing.offsetX, y: v.cy - framing.offsetY, zoom, ...(cam.bgZoom !== undefined ? { bgZoom: cam.bgZoom } : {}), ...(cam.roll !== undefined ? { roll: cam.roll } : {}) };
}

/** World rectangle covered by the viewport for the ACTOR layer. */
export function viewRect(bg: BgInfo, cam: CameraPose, aspect: number = ASPECT): Rect {
  const h = viewWorldHeight(bg) / cam.zoom;
  const w = h * aspect;
  return { x: cam.x - w / 2, y: cam.y - h / 2, w, h };
}

export function worldToScreen(bg: BgInfo, cam: CameraPose, viewportH: number, p: Pt): Pt {
  const s = baseScale(bg, viewportH) * cam.zoom;
  return { x: (p.x - cam.x) * s + (viewportH * ASPECT) / 2, y: (p.y - cam.y) * s + viewportH / 2 };
}

export function screenToWorld(bg: BgInfo, cam: CameraPose, viewportH: number, p: Pt): Pt {
  const s = baseScale(bg, viewportH) * cam.zoom;
  return { x: (p.x - (viewportH * ASPECT) / 2) / s + cam.x, y: (p.y - viewportH / 2) / s + cam.y };
}
