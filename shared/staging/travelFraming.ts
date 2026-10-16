/** Static travel framing. The compact world stays continuous; two-shots use the classic screen arrangement, interpolated by compile. */
import { OURNOTES_STYLE, type StyleShotKey } from '../style/ournotes';
import { clamp } from '../timeline/easing';
import { eyeWorldY, groupHeadTarget, headTopFloor, solveShotDetailed, visibleHead, type FramingActor, type ShotSolution, type SolveInput } from './framing';
import { ASPECT, MAX_ZOOM, MIN_ZOOM, clampZoom, viewWorldHeight, type CameraPose, type Pt } from './world';

export interface TravelSolveInput extends SolveInput {
  /** Camera centre of an empty stage (default: the middle of the picture). */
  ref?: Pt;
}

export function solveTravelShot(input: TravelSolveInput): ShotSolution {
  const { type, bg } = input;
  const sv = input.style ?? OURNOTES_STYLE;
  const fr = sv.framing;
  const spec = sv.shots[type as StyleShotKey];
  const H = viewWorldHeight(bg);
  const asp = input.aspect ?? ASPECT;
  const W = H * asp;
  const focusActors = input.focus.length > 0 ? input.focus : (input.all ?? []);
  const actors: FramingActor[] = type === 'group' ? [...focusActors, ...(input.all ?? []).filter((o) => !focusActors.some((f) => f.id === o.id))] : focusActors;
  const mk = (x: number, y: number, zoom: number): CameraPose => ({ x, y, zoom: clampZoom(zoom) });
  const done = (pose: CameraPose): ShotSolution => ({ pose, shifts: {}, edgeCut: [] });
  const cxOf = (a: FramingActor) => a.head.x + a.head.w / 2;

  if (type === 'establishing' || actors.length === 0) {
    const ref = input.ref ?? { x: bg.width / 2, y: bg.height / 2 };
    return done(mk(ref.x, ref.y, 1));
  }
  if (type === 'insert') {
    const { pose } = solveShotDetailed({ ...input, move: undefined });
    const { bgZoom: _drop, ...rest } = pose;
    void _drop;
    return done(rest);
  }

  if (type === 'two_shot' && actors.length >= 2) {
    // Use the same face spacing and size as classic, without moving the camera to avoid hidden bystanders.
    const pair = actors.slice(0, 2);
    const result = solveShotDetailed({ ...input, focus: pair, all: pair, move: undefined });
    const { bgZoom: _drop, ...pose } = result.pose;
    void _drop;
    return { ...result, pose };
  }

  if (type === 'group' && actors.length >= 2) {
    const n = actors.length;
    const meanHead = actors.reduce((s, a) => s + visibleHead(a, fr).h, 0) / n;
    const xs = actors.map(cxOf);
    const mid = (Math.min(...xs) + Math.max(...xs)) / 2;
    const faceHalf = (a: FramingActor) => (fr.groupFaceShare * a.head.w) / 2;
    const reach = Math.max(...actors.map((a) => Math.abs(cxOf(a) - mid) + faceHalf(a)));
    const eyeY = fr.groupEyeY;
    const chinDrop = actors.reduce((s, a) => s + visibleHead(a, fr).bottom - eyeWorldY(a, fr), 0) / n;
    // v7: a travel group has the classic head height for its size (the people stand at the classic pitch, so the picture looks the same)
    const target = groupHeadTarget(n, fr);
    let zoom = Math.min((target * H) / meanHead, ((asp / 2 - fr.groupFaceEdge - Math.abs(fr.groupCenterX)) * H) / Math.max(1e-6, reach));
    zoom = Math.max(zoom, (fr.groupHeadMin * H) / meanHead);
    zoom = Math.max(zoom, (H * (1 - eyeY)) / (2.4 * meanHead + chinDrop));
    zoom = clamp(zoom, MIN_ZOOM, MAX_ZOOM);
    const Hv = H / zoom;
    const meanEye = actors.reduce((s, a) => s + eyeWorldY(a, fr), 0) / n;
    let cy = meanEye + (0.5 - eyeY) * Hv;
    cy = headTopFloor(cy, Math.min(...actors.map((a) => visibleHead(a, fr).top)), Hv, Math.max(0, spec.topMargin));
    return done(mk(mid - fr.groupCenterX * Hv, cy, zoom));
  }

  // single person (mcu / cu / ecu, or a one-person two-shot / group): the classic single-person framing without the edge rules
  const a = actors[0]!;
  const zoom = clamp((spec.headH * H) / visibleHead(a, fr).h, MIN_ZOOM, MAX_ZOOM);
  const Hv = H / zoom;
  let cy = eyeWorldY(a, fr) + (0.5 - spec.eyeY) * Hv;
  cy = headTopFloor(cy, visibleHead(a, fr).top, Hv, spec.topMargin);
  const lead = clamp(a.yaw, -1, 1) * spec.lookRoom * (W / zoom);
  return done(mk(cxOf(a) + lead, cy, zoom));
}
