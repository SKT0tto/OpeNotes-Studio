import { cameraMove, groupHeadTarget, groupPitchHeads, solveShotDetailed, visibleHead, type CameraMove, type FramingActor } from '../../../shared/staging/framing';
import { placeActor } from '../../../shared/staging/ground';
import { defaultGround, viewRect, type BgInfo } from '../../../shared/staging/world';
import { OURNOTES_STYLE, type StyleValues } from '../../../shared/style/ournotes';
import type { Calibration } from '../../../shared/schema/calibration';
import { fakeCalibration } from './synthetic';

export const bg: BgInfo = { width: 2048, height: 1119, ground: defaultGround(2048, 1119) };
export const ASPECTS: Array<[string, number]> = [['16:9', 16 / 9], ['2.16:1', 1920 / 890]];

/** Calibration whose head is `k` times bigger than the default one (same body): models differ in head size. */
export function calWithHead(id: string, k: number, wide = 1): Calibration {
  const c = fakeCalibration(id);
  return { ...c, head: { ...c.head, bbox: { x: c.head.bbox.x - (c.head.bbox.w * (k * wide - 1)) / 2, y: c.head.bbox.y - (c.head.bbox.h * (k - 1)) / 2, w: c.head.bbox.w * k * wide, h: c.head.bbox.h * k }, height: c.head.height * k } };
}

export const actorOf = (id: string, slot: number, depth: number, cal: Calibration = fakeCalibration('m')): FramingActor => {
  const p = placeActor(cal, { slot, depth }, bg);
  return { id, head: p.headBox, body: p.bodyBox, yaw: 0 };
};
/** `n` people spread over the stage at nearly one depth (a daily scene) ... */
export const line = (n: number, depth = 0.15, cals?: Calibration[]): FramingActor[] =>
  Array.from({ length: n }, (_, i) => actorOf(`p${i}`, n === 1 ? 0 : -0.7 + (1.4 * i) / (n - 1), depth + (i % 2) * 0.02, cals?.[i]));
/** ... or a band: the vocalist front centre, the drummer back centre, the rest at the sides. */
export const band = (n: number): FramingActor[] => {
  const xs = [0, -0.55, 0.55, -0.28, 0.28, -0.8];
  const out = [actorOf('vo', 0, 0), actorOf('dr', 0, 0.8)];
  for (let i = 0; i < n - 2; i++) out.push(actorOf(`b${i}`, xs[i + 1]!, 0.1 + (i % 2) * 0.12));
  return out.slice(0, n);
};

export interface Face {
  id: string;
  /** Face centre x (units of H from the frame centre). */
  x: number;
  /** Visible head box: hair top to chin. */
  left: number;
  right: number;
  top: number;
  bottom: number;
  headH: number;
  eyeY: number;
  /** Face box (centre share of the head width, from the chin up 75% of the head). */
  fl: number;
  fr: number;
  ft: number;
  fb: number;
  z: number;
  scale: number;
}

/** A group solved and measured the way the viewer sees it (units of H, x from the frame centre, y from the top). */
export function measureGroup(people: FramingActor[], aspect: number, style: StyleValues = OURNOTES_STYLE, move?: CameraMove, focus: FramingActor[] = people) {
  const fr = style.framing;
  const s = solveShotDetailed({ type: 'group', focus, all: people, bg, aspect, style, ...(move ? { move } : {}) });
  const Hv = viewRect(bg, s.pose).h;
  const faces: Face[] = people
    .map((a) => {
      const sh = s.shifts[a.id]!;
      const w = a.head.w * sh.s;
      const cx = a.head.x + a.head.w / 2 + sh.dx;
      const hc = a.head.y + a.head.h / 2;
      const vh = visibleHead(a, fr);
      const top = hc + (vh.top - hc) * sh.s + sh.dy;
      const bottom = hc + (vh.bottom - hc) * sh.s + sh.dy;
      const eye = hc + (a.head.y + a.head.h * fr.eyeFrac - hc) * sh.s + sh.dy;
      const X = (v: number) => (v - s.pose.x) / Hv;
      const Y = (v: number) => (v - s.pose.y) / Hv + 0.5;
      const faceW = w * fr.groupFaceShare;
      return {
        id: a.id, x: X(cx), left: X(cx - w / 2), right: X(cx + w / 2), top: Y(top), bottom: Y(bottom), headH: (bottom - top) / Hv, eyeY: Y(eye),
        fl: X(cx - faceW / 2), fr: X(cx + faceW / 2), ft: Y(bottom - 0.75 * (bottom - top)), fb: Y(bottom), z: sh.z ?? 0, scale: sh.s,
      };
    })
    .sort((p, q) => p.x - q.x);
  return { solution: s, faces, pose: s.pose, Hv };
}

/** Largest share of the smaller face box covered by another face box (0 = no face is covered by anybody). */
export function maxFaceOcclusion(faces: Face[]): number {
  let worst = 0;
  for (let i = 0; i < faces.length; i++) {
    for (let j = i + 1; j < faces.length; j++) {
      const p = faces[i]!;
      const q = faces[j]!;
      const w = Math.min(p.fr, q.fr) - Math.max(p.fl, q.fl);
      const h = Math.min(p.fb, q.fb) - Math.max(p.ft, q.ft);
      if (w <= 0 || h <= 0) continue;
      worst = Math.max(worst, (w * h) / Math.min((p.fr - p.fl) * (p.fb - p.ft), (q.fr - q.fl) * (q.fb - q.ft)));
    }
  }
  return worst;
}

/** Expected visible head height (share of H) for `n` people on a frame of `aspect`: target, limited by the faces fitting the frame (see PLAN P19-B). */
export function expectedHead(n: number, aspect: number, headWOverH: number, style: StyleValues = OURNOTES_STYLE): number {
  const fr = style.framing;
  const fit = (aspect / 2 - fr.groupFaceEdge) / (((n - 1) / 2) * groupPitchHeads(n, fr) + (fr.groupFaceShare / 2) * headWOverH);
  return Math.max(fr.groupHeadMin, Math.min(groupHeadTarget(n, fr), fit));
}

export { cameraMove };
