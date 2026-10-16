/**
 * Two-plane background model of the travel camera system. The background pose is a pure function of the camera pose, so seeking is
 * trivially consistent and there is no chain state. The people are cards on a plane and the camera is a perspective camera: the
 * background moves by D / (D + gap) of what the people do, and with the head share of the frame s proportional to 1 / D that is
 * 1 / (1 + s / sigma). So the parallax and the background magnification follow the shot size: a close-up magnifies the picture less
 * than a wide shot does, and the picture's centre follows the camera, softly limited so it always covers the viewport.
 */
import { clamp } from '../timeline/easing';
import { viewWorldHeight, type BgFraming, type BgInfo, type CameraPose, type Pt } from './world';

/** Written to CompiledScene.travel.bg. */
export interface TravelBgModel {
  /** Distance scale of the card model: parallax = 1 / (1 + s / sigma) at head share s (the original: about 1). */
  sigma: number;
  /** Background magnification = scale * camera zoom * parallax / 0.75. */
  scale: number;
  zoomMax: number;
  /** Camera centre at which the picture is centred (world coordinates). */
  ref: Pt;
}

/**
 * C1-continuous soft clamp to [lo, hi]: the identity in the middle 70% (knee = 30% of the half range at each end), then an exponential
 * approach that never reaches the bound, so the derivative is continuous and the background never stalls suddenly.
 */
export function softLimit(x: number, lo: number, hi: number, knee = 0.3): number {
  if (hi <= lo) return (lo + hi) / 2;
  const k = Math.max(1e-9, ((hi - lo) / 2) * knee);
  const a = lo + k;
  const b = hi - k;
  if (x < a) return a - k * (1 - Math.exp(-(a - x) / k));
  if (x > b) return b + k * (1 - Math.exp(-(x - b) / k));
  return x;
}

/** Card model: background shift / people shift = D / (D + gap); with the head share s proportional to 1 / D that is 1 / (1 + s / sigma). */
export const parallaxAt = (s: number, sigma: number) => 1 / (1 + Math.max(0, s) / Math.max(1e-6, sigma));
/** The parallax at which the background magnifies exactly `scale` times the camera zoom (the two-shot's). */
const PARALLAX_REF = 0.75;

/** Camera pose -> background pose (bgZoom, bgX, bgY where bgX/bgY are usable directly as the pose fields: the view centre without framing.offset). */
export function travelBgPose(cam: CameraPose, m: TravelBgModel, bg: BgInfo, framing: BgFraming, aspect: number, s: number): { bgZoom: number; bgX: number; bgY: number } {
  const H = viewWorldHeight(bg);
  const p = parallaxAt(s, m.sigma);
  const bgZoom = clamp((m.scale * cam.zoom * p) / PARALLAX_REF, 1, Math.max(1, m.zoomMax));
  // the same viewport zoom as bgView: framing zoom on top, and wide windows magnify just enough to cover
  const v = Math.max(bgZoom * Math.max(1, framing.zoom), (H * aspect) / bg.width);
  const g = (p * cam.zoom) / v;
  const hw = (H * aspect) / v / 2;
  const hh = H / v / 2;
  const cx = softLimit(m.ref.x + framing.offsetX + g * (cam.x - m.ref.x), hw, Math.max(hw, bg.width - hw));
  const cy = softLimit(m.ref.y + framing.offsetY + g * (cam.y - m.ref.y), hh, Math.max(hh, bg.height - hh));
  return { bgZoom, bgX: cx - framing.offsetX, bgY: cy - framing.offsetY };
}
