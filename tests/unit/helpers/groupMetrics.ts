import { placeActor } from '../../../shared/staging/ground';
import { viewWorldHeight, type BgInfo } from '../../../shared/staging/world';
import { OURNOTES_STYLE } from '../../../shared/style/ournotes';
import type { Calibration } from '../../../shared/schema/calibration';
import { evaluate } from '../../../shared/timeline/evaluate';
import type { CompileContext, CompiledProject } from '../../../shared/timeline/types';

/** What a viewer sees of one person in a shot, in units of the frame height H, x from the frame centre. */
export interface FaceOnScreen {
  id: string;
  /** Face centre x (units of H from the frame centre). */
  x: number;
  /** Visible head box: hair top to chin and the head width. */
  left: number;
  right: number;
  top: number;
  bottom: number;
  /** Visible head height / H. */
  headH: number;
  /** Model hair / sleeves reach (like the framing's bystander box). */
  hairLeft: number;
  hairRight: number;
}

export interface GroupMetrics {
  faces: FaceOnScreen[];
  /** Frame width in units of H. */
  frameW: number;
  /** Smallest horizontal distance between neighbouring face centres, in head widths of the smaller of the two. */
  minSpacingHeads: number;
  /** Smallest horizontal distance between neighbouring face centres (units of H). */
  minSpacing: number;
  /** Largest share of one visible head box that another person's visible head box covers (0..1). */
  maxHeadOverlap: number;
  /** Smallest distance of any head box to the frame's left / right edge (negative = cut off), units of H. */
  edgeMargin: number;
  /** Distance of the highest head top to the frame top (negative = head cut off). */
  topMargin: number;
}

const area = (r: { left: number; right: number; top: number; bottom: number }) => Math.max(0, r.right - r.left) * Math.max(0, r.bottom - r.top);

/** Face geometry of the people on stage at project time `t`, measured the way the stage draws them (shifts included). */
export function groupMetricsAt(c: CompiledProject, ctx: CompileContext, bgOf: (assetId: string) => BgInfo, t: number, aspect: number, ids?: string[]): GroupMetrics {
  const st = evaluate(c, t);
  const bg = bgOf(st.background.assetId);
  const H = viewWorldHeight(bg);
  const Hv = H / st.camera.zoom;
  const fr = OURNOTES_STYLE.framing;
  const faces: FaceOnScreen[] = [];
  for (const a of st.actors) {
    if (a.opacity < 0.5) continue;
    if (ids && !ids.includes(a.castId)) continue;
    const cal = ctx.calibrations[a.modelId] as Calibration;
    const pl = placeActor(cal, { slot: a.slot, depth: a.depth }, bg);
    const hc = pl.headCenter;
    const k = a.shiftS;
    const box = { x: hc.x + (pl.headBox.x - hc.x) * k + a.shiftX + a.slideH * H, y: hc.y + (pl.headBox.y - hc.y) * k + a.shiftY, w: pl.headBox.w * k, h: pl.headBox.h * k };
    const cx = box.x + box.w / 2;
    const top = box.y + box.h * fr.headTop;
    const bottom = box.y + box.h * fr.headChin;
    const sx = (x: number) => (x - st.camera.x) / Hv;
    const sy = (y: number) => (y - st.camera.y) / Hv + 0.5;
    faces.push({
      id: a.castId, x: sx(cx), left: sx(box.x), right: sx(box.x + box.w), top: sy(top), bottom: sy(bottom), headH: (bottom - top) / Hv,
      hairLeft: sx(box.x - box.w * fr.hairSpread), hairRight: sx(box.x + box.w * (1 + fr.hairSpread)),
    });
  }
  faces.sort((p, q) => p.x - q.x);
  let minSpacing = Infinity;
  let minSpacingHeads = Infinity;
  let maxHeadOverlap = 0;
  for (let i = 0; i < faces.length; i++) {
    for (let j = i + 1; j < faces.length; j++) {
      const p = faces[i]!;
      const q = faces[j]!;
      const inter = { left: Math.max(p.left, q.left), right: Math.min(p.right, q.right), top: Math.max(p.top, q.top), bottom: Math.min(p.bottom, q.bottom) };
      const ov = area(inter) / Math.min(area(p) || 1, area(q) || 1);
      maxHeadOverlap = Math.max(maxHeadOverlap, ov);
    }
    if (i + 1 < faces.length) {
      const d = faces[i + 1]!.x - faces[i]!.x;
      minSpacing = Math.min(minSpacing, d);
      const w = Math.min(faces[i]!.right - faces[i]!.left, faces[i + 1]!.right - faces[i + 1]!.left);
      minSpacingHeads = Math.min(minSpacingHeads, d / w);
    }
  }
  const half = aspect / 2;
  return {
    faces, frameW: aspect, minSpacing, minSpacingHeads, maxHeadOverlap,
    edgeMargin: faces.length ? Math.min(...faces.map((f) => Math.min(f.left + half, half - f.right))) : 0,
    topMargin: faces.length ? Math.min(...faces.map((f) => f.top)) : 0,
  };
}
