/**
 * Shot solver: turns a shot intent (type + focus actors) into a concrete camera pose, deterministically.
 * Everything is in world units (see world.ts). Sizes come from the style preset (shared/style/ournotes.ts):
 * head height share of the frame, eye-line height, minimum head-top margin, look-room and background zoom.
 * The original never shows full bodies: the smallest people shot is a group at head height 0.40H.
 */
import { OURNOTES_STYLE, type StyleShotKey, type StyleValues } from '../style/ournotes';
import { clamp } from '../timeline/easing';
import { feetToSlotDepth } from './ground';
import { ASPECT, MAX_ZOOM, MIN_ZOOM, clampCamera, clampZoom, viewRect, viewWorldHeight, type BgFraming, type BgInfo, type CameraPose, type Rect } from './world';

export const SHOT_TYPES = ['establishing', 'group', 'two_shot', 'mcu', 'cu', 'ecu', 'insert'] as const;
export type ShotType = (typeof SHOT_TYPES)[number];
/** Pre-P7.2 names, still accepted in stored projects: closeup->cu, bust|medium->mcu, wide->group (with people). */
export const LEGACY_SHOT_TYPES = ['closeup', 'bust', 'medium', 'wide'] as const;
export const ALL_SHOT_TYPES = [...SHOT_TYPES, ...LEGACY_SHOT_TYPES] as const;
export type AnyShotType = (typeof ALL_SHOT_TYPES)[number];
export const CAMERA_MOVES = ['static', 'push_in', 'pull_out', 'pan', 'track', 'shake'] as const;
export type CameraMove = (typeof CAMERA_MOVES)[number];

const LEGACY_MAP: Record<(typeof LEGACY_SHOT_TYPES)[number], ShotType> = { closeup: 'cu', bust: 'mcu', medium: 'mcu', wide: 'group' };
export const normalizeShotType = (t: AnyShotType): { type: ShotType; legacy: boolean } =>
  (LEGACY_SHOT_TYPES as readonly string[]).includes(t) ? { type: LEGACY_MAP[t as keyof typeof LEGACY_MAP], legacy: true } : { type: t as ShotType, legacy: false };

export interface FramingActor {
  id: string;
  head: Rect;
  body: Rect;
  /** Desired facing, screen space (+1 = towards screen-right). Single-person shots leave room in front of the face. */
  yaw: number;
}

/** Defaults of the bystander edge test (the live values come from the style: framing.edgeMin / edgeMax). */
export const EDGE_MIN = OURNOTES_STYLE.framing.edgeMin;
export const EDGE_MAX = OURNOTES_STYLE.framing.edgeMax;

/**
 * What of a person can show up at the frame edge: head plus chest in height, and horizontally the model's own width
 * together with the hair / sleeve spread around the head box (long hair reaches far beyond the calibrated head).
 */
const visibleBox = (a: FramingActor, f: Pick<Framing, 'chestHeads' | 'hairSpread'>): Rect => {
  const x0 = Math.min(a.body.x, a.head.x - a.head.w * f.hairSpread);
  const x1 = Math.max(a.body.x + a.body.w, a.head.x + a.head.w * (1 + f.hairSpread));
  return { x: x0, y: a.head.y, w: x1 - x0, h: a.head.h * f.chestHeads };
};

/** Target box of an `insert` shot, relative to the person's bounding box (head + body): x / y of the top-left corner, w / h, all 0..1. */
export interface InsertBox {
  x: number;
  y: number;
  w: number;
  h: number;
}
/** Where an insert looks when the author drew no box: the hands / chest area. */
export const DEFAULT_INSERT_BOX: InsertBox = { x: 0.15, y: 0.26, w: 0.7, h: 0.26 };

export interface SolveInput {
  insertBox?: InsertBox;
  type: ShotType;
  /** Focus actors, speaker first. An empty list means "nobody in particular" and `all` is used. */
  focus: FramingActor[];
  all?: FramingActor[];
  bg: BgInfo;
  framing?: BgFraming;
  style?: StyleValues;
  /** The camera move of the shot; a group leaves room for it (zoom-in / pan travel) so nobody is cut at the end of the move. */
  move?: CameraMove;
  /** Window aspect (width / height); default 16:9. A wider frame spreads two-shots and groups over its width (faces stay proportional to H). */
  aspect?: number;
}

export interface ShotSolution {
  pose: CameraPose;
  /** Multi-person shots arrange the faces on the screen positions of the original: per-actor world offset (cut-safe, blocking untouched). */
  shifts: Record<string, { dx: number; dy: number; s: number; /** Draw order inside a group: larger = in front (absent = by blocking depth). */ z?: number }>;
  /** Groups of three or more: camera moves are kept this small (framing.groupMoveZoom / groupPanShare). */
  moveLimits?: { moveZoom: number; panShare: number };
  /** Ids of bystanders that stay cut by the frame edge although no acceptable shift was found. */
  edgeCut: string[];
}

export const solveShot = (input: SolveInput): CameraPose => solveShotDetailed(input).pose;

const area = (r: Rect) => Math.max(0, r.w) * Math.max(0, r.h);
const overlap = (a: Rect, b: Rect): Rect => {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  return { x, y, w: Math.min(a.x + a.w, b.x + b.w) - x, h: Math.min(a.y + a.h, b.y + b.h) - y };
};

type Framing = StyleValues['framing'];

/** Share (0..1) of a person's head + upper body (including hair spread) that lies inside the camera's view. */
export function visibleShare(a: FramingActor, bg: BgInfo, pose: CameraPose, f: Framing = OURNOTES_STYLE.framing, shift = { dx: 0, dy: 0 }, aspect: number = ASPECT): number {
  const b = visibleBox(a, f);
  const box = { ...b, x: b.x + shift.dx, y: b.y + shift.dy };
  return area(overlap(box, viewRect(bg, pose, aspect))) / area(box);
}

/** Eye line of an actor in world y. */
export const eyeWorldY = (a: FramingActor, f: Pick<Framing, 'eyeFrac'> | number) => a.head.y + a.head.h * (typeof f === 'number' ? f : f.eyeFrac);

/** The visible head (hair top to chin) inside the calibrated head box, in world y. */
export const visibleHead = (a: FramingActor, f: Pick<Framing, 'headTop' | 'headChin'>) => {
  const top = a.head.y + a.head.h * f.headTop;
  return { top, bottom: a.head.y + a.head.h * f.headChin, h: a.head.h * (f.headChin - f.headTop) };
};

/** Where (share of the frame, from the top) the visible head top / chin / eyes end up for a pose; used by tests and the overlay. */
export function headScreenMetrics(a: FramingActor, bg: BgInfo, pose: CameraPose, f: Framing = OURNOTES_STYLE.framing) {
  const v = viewRect(bg, pose);
  const vh = visibleHead(a, f);
  return {
    headH: vh.h / v.h,
    top: (vh.top - v.y) / v.h,
    chin: (vh.bottom - v.y) / v.h,
    eyeY: (eyeWorldY(a, f) - v.y) / v.h,
    centerX: (a.head.x + a.head.w / 2 - (v.x + v.w / 2)) / v.h, // in units of H
  };
}

/**
 * Keep bystanders from being cut in half by the frame: shift the camera sideways (at most 15% of the viewport
 * width, focus heads staying horizontally safe) so they are either out of frame or fully in. Returns the ids that
 * remain cut when neither works. Focus people may be cut by the edge (shoulders), that is the original's look.
 * `pinned` focus people are placed by screen position (multi-person layout) and follow the camera, so they stay safe.
 */
function avoidEdgeCuts(input: SolveInput, pose: CameraPose, focus: FramingActor[], safe: number, pinned: boolean): { pose: CameraPose; edgeCut: string[] } {
  const { bg } = input;
  const fr = (input.style ?? OURNOTES_STYLE).framing;
  const others = (input.all ?? []).filter((a) => !focus.some((f) => f.id === a.id));
  const asp = input.aspect ?? ASPECT;
  const share = (a: FramingActor, p: CameraPose) => visibleShare(a, bg, p, fr, undefined, asp);
  const cut = (p: CameraPose) => others.filter((a) => {
    const f = share(a, p);
    return f > fr.edgeMin && f < fr.edgeMax;
  });
  const initial = cut(pose);
  if (initial.length === 0) return { pose, edgeCut: [] };

  const W = (viewWorldHeight(bg) * asp) / pose.zoom;
  const headsSafe = (p: CameraPose) => {
    if (pinned) return true;
    const v = viewRect(bg, p, asp);
    return focus.every((a) => a.head.x >= v.x + v.w * safe && a.head.x + a.head.w <= v.x + v.w * (1 - safe));
  };
  const steps = [...Array(15).keys()].map((i) => (i + 1) * 0.01 * W);
  const tryShifts = (accept: (p: CameraPose) => boolean): CameraPose | null => {
    for (const d of steps) {
      for (const sign of [-1, 1]) {
        const p = { ...pose, x: pose.x + sign * d };
        if (headsSafe(p) && accept(p)) return p;
      }
    }
    return null;
  };
  // 1) push the cut bystanders out of the frame, 2) otherwise bring them in completely.
  const out = tryShifts((p) => cut(p).length === 0 && initial.every((a) => share(a, p) <= fr.edgeMin));
  const found = out ?? tryShifts((p) => cut(p).length === 0);
  return found ? { pose: found, edgeCut: [] } : { pose, edgeCut: initial.map((a) => a.id) };
}

/** Screen x (share of H, from the frame centre) of the faces of a two-person shot (or a lone person), left to right. */
export function faceLayout(_type: 'two_shot' | 'group', n: number, fr: Framing, aspect: number = ASPECT): number[] {
  // wider than 16:9: the same arrangement, stretched over the extra width (the original re-lays its multi-person shots per screen width)
  const k = Math.max(1, aspect / ASPECT);
  if (n <= 1) return [0];
  return [-fr.twoShotFaceX * k, fr.twoShotFaceX * k];
}

export function solveShotDetailed(input: SolveInput): ShotSolution {
  const { type, bg } = input;
  const sv = input.style ?? OURNOTES_STYLE;
  const spec = sv.shots[type as StyleShotKey];
  const fr = sv.framing;
  const safe = sv.framing.safeX;
  const H = viewWorldHeight(bg);
  const asp = input.aspect ?? ASPECT;
  const W = H * asp;
  const focusActors = input.focus.length > 0 ? input.focus : (input.all ?? []);
  // A group shot shows everybody on stage: people who are present but not named in the focus are arranged with the others (otherwise one of them stands half behind a neighbour).
  const actors = type === 'group' ? [...focusActors, ...(input.all ?? []).filter((o) => !focusActors.some((f) => f.id === o.id))] : focusActors;
  const mk = (x: number, y: number, zoom: number): CameraPose => ({ x, y, zoom: clampZoom(zoom), bgZoom: spec.bgZoom });

  if (type === 'establishing' || actors.length === 0) {
    return { pose: clampCamera(bg, mk(bg.width / 2, bg.height / 2, 1), input.framing, asp), shifts: {}, edgeCut: [] };
  }

  let pose: CameraPose;
  let layout: ((camX: number) => ShotSolution['shifts']) | null = null;
  let moveLimits: ShotSolution['moveLimits'];
  if (type === 'group' && actors.length >= 3) {
    const g = solveGroup(actors, input, spec, mk);
    pose = g.pose;
    layout = g.layout;
    moveLimits = g.moveLimits;
  } else if ((type === 'two_shot' || type === 'group') && actors.length >= 2) {
    const group = (type === 'group' ? actors : actors.slice(0, 2)).slice().sort((a, b) => a.head.x + a.head.w / 2 - (b.head.x + b.head.w / 2));
    const vis = (a: FramingActor) => visibleHead(a, fr).h;
    const refH = type === 'group' ? Math.max(...group.map(vis)) : group.reduce((s, a) => s + vis(a), 0) / group.length;
    // Head height is the target: people are arranged on screen by shifting them, so no fit-to-frame shrinking.
    const zoom = clamp((spec.headH * H) / refH, MIN_ZOOM, MAX_ZOOM);
    const Hv = H / zoom;
    const faceX = faceLayout(type, group.length, fr, asp);
    // Two-shot: both heads end up the same size (people of different model scale are scaled about their head centre).
    const sc = group.map((a) => (type === 'two_shot' ? Math.pow(refH / vis(a), fr.sizeEqualize) : 1));
    const centreY = group.map((a) => a.head.y + a.head.h / 2);
    const eyes = group.map((a, i) => centreY[i]! + (eyeWorldY(a, fr) - centreY[i]!) * sc[i]!);
    const tops = group.map((a, i) => centreY[i]! + (visibleHead(a, fr).top - centreY[i]!) * sc[i]!);
    const meanEye = eyes.reduce((s, e) => s + e, 0) / eyes.length;
    const dy = eyes.map((e) => fr.heightEqualize * (meanEye - e));
    let cy = meanEye + (0.5 - spec.eyeY) * Hv;
    cy = headTopFloor(cy, Math.min(...tops.map((t, i) => t + dy[i]!)), Hv, spec.topMargin);
    const faceCx = group.map((a) => a.head.x + a.head.w / 2);
    const cx = faceCx.reduce((s, c, i) => s + c - faceX[i]! * Hv, 0) / group.length;
    pose = mk(cx, cy, zoom);
    layout = (camX) => Object.fromEntries(group.map((a, i) => [a.id, { dx: camX + faceX[i]! * Hv - faceCx[i]!, dy: dy[i]!, s: sc[i]! }]));
  } else if (type === 'insert') {
    // Body-part insert: the camera frames the author's box (relative to the person's bounding box); the face may leave the frame.
    const a = actors[0]!;
    const bx = Math.min(a.body.x, a.head.x);
    const by = Math.min(a.body.y, a.head.y);
    const bw = Math.max(a.body.x + a.body.w, a.head.x + a.head.w) - bx;
    const bh = Math.max(a.body.y + a.body.h, a.head.y + a.head.h) - by;
    const b = input.insertBox ?? DEFAULT_INSERT_BOX;
    const rect = { x: bx + b.x * bw, y: by + b.y * bh, w: Math.max(1, b.w * bw), h: Math.max(1, b.h * bh) };
    const zoom = clamp(Math.min(H / rect.h, W / rect.w), MIN_ZOOM, MAX_ZOOM);
    pose = mk(rect.x + rect.w / 2, rect.y + rect.h / 2, zoom);
  } else {
    const a = actors[0]!;
    const zoom = clamp((spec.headH * H) / visibleHead(a, fr).h, MIN_ZOOM, MAX_ZOOM);
    const Hv = H / zoom;
    let cy = eyeWorldY(a, fr) + (0.5 - spec.eyeY) * Hv;
    cy = headTopFloor(cy, visibleHead(a, fr).top, Hv, spec.topMargin);
    // Look-room: the head sits on the side opposite to where it looks.
    const lead = clamp(a.yaw, -1, 1) * spec.lookRoom * (W / zoom);
    pose = mk(a.head.x + a.head.w / 2 + lead, cy, zoom);
  }
  // A group of three or more is arranged by its faces only (hair and bodies may leave the frame, nobody is shrunk to avoid that).
  if (moveLimits) return { pose, shifts: layout!(pose.x), moveLimits, edgeCut: [] };
  const res = avoidEdgeCuts(input, pose, actors, safe, layout !== null);
  return { pose: res.pose, shifts: layout ? layout(res.pose.x) : {}, edgeCut: res.edgeCut };
}

/** Target visible head height (share of H) of a group of `n` people on a wide frame (3: groupHead3, then x groupHeadDecay per person, floor groupHeadMin). */
export const groupHeadTarget = (n: number, fr: Pick<Framing, 'groupHead3' | 'groupHeadDecay' | 'groupHeadMin'>): number =>
  Math.max(fr.groupHeadMin, fr.groupHead3 * Math.pow(fr.groupHeadDecay, Math.max(0, n - 3)));

/** Distance between neighbouring face centres in head heights for a group of `n` people. */
export const groupPitchHeads = (n: number, fr: Pick<Framing, 'groupPitch3' | 'groupPitchStep' | 'groupPitchMin'>): number =>
  Math.max(fr.groupPitchMin, fr.groupPitch3 - fr.groupPitchStep * Math.max(0, n - 3));

/**
 * Group of three or more, laid out like the original: big, tight heads; faces never covered and fully inside the frame; bodies
 * may overlap and leave the frame at the sides; one row, centred, equal pitch, similar sizes, the middle person a touch bigger and in front.
 * A back row exists only for a real depth difference in the blocking (a band's drummer) or beyond `groupOneRowMax` people, and its
 * people stand between two front faces.
 */
function solveGroup(
  actors: FramingActor[],
  input: SolveInput,
  spec: StyleValues['shots'][StyleShotKey],
  mk: (x: number, y: number, zoom: number) => CameraPose,
): { pose: CameraPose; layout: (camX: number) => ShotSolution['shifts']; moveLimits: NonNullable<ShotSolution['moveLimits']> } {
  const { bg } = input;
  const fr = (input.style ?? OURNOTES_STYLE).framing;
  const asp = input.aspect ?? ASPECT;
  const H = viewWorldHeight(bg);
  const cxOf = (a: FramingActor) => a.head.x + a.head.w / 2;
  const vis = (a: FramingActor) => visibleHead(a, fr).h;

  // ---- rows
  const depth = new Map(actors.map((a) => [a.id, feetToSlotDepth({ x: a.body.x + a.body.w / 2, y: a.body.y + a.body.h }, bg).depth] as const));
  const lo = Math.min(...depth.values());
  let front = actors.filter((a) => depth.get(a.id)! - lo < fr.groupDepthGap);
  if (front.length < 2) front = actors.slice();
  let overflow = false;
  if (front.length > fr.groupOneRowMax) {
    // focus people first (the caller lists them first), then the ones nearest to the middle of the group
    const mid = actors.reduce((q, a) => q + cxOf(a), 0) / actors.length;
    const rank = new Map(actors.map((a, i) => [a.id, i] as const));
    const focusN = Math.min(input.focus.length, actors.length);
    const prio = (a: FramingActor) => (rank.get(a.id)! < focusN ? rank.get(a.id)! - 1e6 : Math.abs(cxOf(a) - mid));
    front = front.slice().sort((p, q) => prio(p) - prio(q)).slice(0, fr.groupFrontCrowded);
    overflow = true;
  }
  const inFront = new Set(front.map((a) => a.id));
  const byX = (p: FramingActor, q: FramingActor) => cxOf(p) - cxOf(q) || depth.get(p.id)! - depth.get(q.id)!;
  front = front.slice().sort(byX);
  const back = actors.filter((a) => !inFront.has(a.id)).sort(byX);
  const m = front.length;
  const nEff = Math.max(3, m);

  // ---- sizes: pulled towards one common head size; the middle person of an odd row is a touch bigger
  const ref = Math.max(...actors.map(vis));
  const centreIdx = m % 2 === 1 ? (m - 1) / 2 : -1;
  const backScale = overflow ? fr.groupOverflowScale : fr.groupBackScale;
  const backDrop = overflow ? fr.groupOverflowDrop : fr.groupBackDrop;
  const scOf = (a: FramingActor, boost: number) => Math.pow(ref / vis(a), fr.groupSizeEqualize) * boost;
  const sc = new Map<string, number>();
  front.forEach((a, j) => sc.set(a.id, scOf(a, j === centreIdx ? fr.groupCenterBoost : 1)));
  back.forEach((a) => sc.set(a.id, scOf(a, backScale)));
  const meanHead = front.reduce((q, a) => q + vis(a) * sc.get(a.id)!, 0) / m;

  // ---- screen x (world offsets from the group centre): equal pitch in the front row, back people in the gaps between front faces
  const faceW = (a: FramingActor) => fr.groupFaceShare * a.head.w * sc.get(a.id)!;
  let pitchW = groupPitchHeads(nEff, fr) * meanHead;
  // a back person stands half a pitch from both neighbours: wide enough that its face does not touch theirs
  if (back.length > 0) pitchW = Math.max(pitchW, Math.max(...front.map(faceW)) + Math.max(...back.map(faceW)));
  const x = new Map<string, number>();
  front.forEach((a, j) => x.set(a.id, (j - (m - 1) / 2) * pitchW));
  if (back.length > 0) {
    const gaps = Array.from({ length: m - 1 }, (_, k) => (k + 0.5 - (m - 1) / 2) * pitchW).sort((p, q) => Math.abs(p) - Math.abs(q) || p - q);
    const used = back.map((_, i) => gaps[i % gaps.length]!).sort((p, q) => p - q);
    back.forEach((a, i) => x.set(a.id, used[i]!));
  }

  // ---- zoom: the target head height, limited so that every face fits (with the small room a capped camera move needs)
  const mv = input.move ?? 'static';
  const limits = { moveZoom: Math.min(fr.moveZoom, fr.groupMoveZoom), panShare: Math.min(fr.panShare, fr.groupPanShare) };
  const moveRoom = mv === 'push_in' || mv === 'pull_out' ? limits.moveZoom : 1;
  const travel = mv === 'pan' ? limits.panShare : mv === 'track' ? limits.panShare * 0.6 : 0;
  const all = [...front, ...back];
  const reach = Math.max(...all.map((a) => Math.abs(x.get(a.id)!) + faceW(a) / 2));
  const avail = asp / 2 - fr.groupFaceEdge - travel * asp - Math.abs(fr.groupCenterX);
  const eyeY = fr.groupEyeY;
  const chinDrop = front.reduce((q, a) => q + (visibleHead(a, fr).bottom - eyeWorldY(a, fr)) * sc.get(a.id)!, 0) / m;
  const target = groupHeadTarget(nEff, fr);
  let zoom = Math.min((target * H) / meanHead, (H * avail) / (reach * moveRoom));
  zoom = Math.max(zoom, (fr.groupHeadMin * H) / meanHead); // never smaller than the floor, whatever the frame
  zoom = Math.max(zoom, (H * (1 - eyeY)) / (2.4 * meanHead + chinDrop)); // the lower edge cuts at the chest / waist, never lower
  zoom = clamp(zoom, MIN_ZOOM, MAX_ZOOM);
  const Hv = H / zoom;

  // ---- eye lines: the front row on one common line (pulled together), back people a little lower
  const centreY = new Map(all.map((a) => [a.id, a.head.y + a.head.h / 2] as const));
  const eye = new Map(all.map((a) => [a.id, centreY.get(a.id)! + (eyeWorldY(a, fr) - centreY.get(a.id)!) * sc.get(a.id)!] as const));
  const top = new Map(all.map((a) => [a.id, centreY.get(a.id)! + (visibleHead(a, fr).top - centreY.get(a.id)!) * sc.get(a.id)!] as const));
  const mean = (list: FramingActor[]) => list.reduce((q, a) => q + eye.get(a.id)!, 0) / list.length;
  const frontMean = mean(front);
  const backMean = back.length > 0 ? mean(back) : 0;
  const dy = new Map(
    all.map((a) => {
      const isBack = !inFront.has(a.id);
      const aim = frontMean + (isBack ? backDrop * Hv : 0) + (eye.get(a.id)! - (isBack ? backMean : frontMean)) * (1 - fr.groupHeightEqualize);
      return [a.id, aim - eye.get(a.id)!] as const;
    }),
  );
  let cy = frontMean + (0.5 - eyeY) * Hv;
  cy = headTopFloor(cy, Math.min(...all.map((a) => top.get(a.id)! + dy.get(a.id)!)), Hv, Math.max(0, spec.topMargin));

  const faceCx = new Map(all.map((a) => [a.id, cxOf(a)] as const));
  const off = fr.groupCenterX * Hv;
  const cx = all.reduce((q, a) => q + faceCx.get(a.id)! - x.get(a.id)! - off, 0) / all.length;
  const z = (a: FramingActor) => (inFront.has(a.id) ? 100 - Math.round(Math.abs(front.indexOf(a) - (m - 1) / 2) * 10) : 1);
  return {
    pose: mk(cx, cy, zoom),
    moveLimits: limits,
    layout: (camX) => Object.fromEntries(all.map((a) => [a.id, { dx: camX + x.get(a.id)! + off - faceCx.get(a.id)!, dy: dy.get(a.id)!, s: sc.get(a.id)!, z: z(a) }])),
  };
}

/** Lower the head on screen when its top would be closer to the upper edge than `margin` (share of the frame). */
function headTopFloor(cy: number, headTop: number, Hv: number, margin: number): number {
  const top = (headTop - (cy - Hv / 2)) / Hv;
  return top < margin ? cy - (margin - top) * Hv : cy;
}

/** Start and end pose of a camera move around a solved base pose. */
export function cameraMove(base: CameraPose, move: CameraMove, bg: BgInfo, f: Pick<Framing, 'moveZoom' | 'panShare'> = OURNOTES_STYLE.framing, aspect: number = ASPECT): { from: CameraPose; to: CameraPose } {
  const W = (viewWorldHeight(bg) * aspect) / base.zoom;
  const zoomed: CameraPose = { ...base, zoom: clampZoom(base.zoom * f.moveZoom), ...(base.bgZoom !== undefined ? { bgZoom: base.bgZoom * Math.sqrt(f.moveZoom) } : {}) };
  switch (move) {
    case 'push_in':
      return { from: base, to: zoomed };
    case 'pull_out':
      return { from: zoomed, to: base };
    case 'pan':
      return { from: { ...base, x: base.x - W * f.panShare }, to: { ...base, x: base.x + W * f.panShare } };
    case 'track':
      return { from: { ...base, x: base.x + W * f.panShare * 0.6 }, to: { ...base, x: base.x - W * f.panShare * 0.6 } };
    default:
      return { from: base, to: base };
  }
}
