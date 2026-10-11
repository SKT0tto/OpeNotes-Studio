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
  shifts: Record<string, { dx: number; dy: number; s: number }>;
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

/** Person-count adaptive size of a group (1 for up to three people, shrinking by `groupShrink` per extra person, never below `groupMinScale`). */
export const groupSizeScale = (n: number, fr: Pick<Framing, 'groupShrink' | 'groupMinScale'>): number => clamp(1 - fr.groupShrink * Math.max(0, n - 3), fr.groupMinScale, 1);

export interface GroupLayoutPerson {
  /** Visible head width in world units after the size scale. */
  w: number;
  back: boolean;
}

/**
 * Face-centre offsets from the first face (world units) of a group left to right: the pitch between neighbours is `groupSpacing`
 * head widths in the same row and `groupRowSpacing` across rows (back row people sit between the front ones), stretched with the
 * window width. Returns the offsets, the total width of the arrangement (outer head edges) and the wide-screen factor applied.
 */
export function groupFaceOffsets(people: GroupLayoutPerson[], fr: Framing, aspect: number = ASPECT): { x: number[]; width: number } {
  const k = 1 + (Math.max(1, aspect / ASPECT) - 1) * fr.groupWideStretch;
  const x = [0];
  for (let i = 1; i < people.length; i++) {
    const a = people[i - 1]!;
    const b = people[i]!;
    const factor = a.back === b.back ? fr.groupSpacing : fr.groupRowSpacing;
    x.push(x[i - 1]! + factor * k * ((a.w + b.w) / 2));
  }
  const first = people[0]!;
  const last = people.at(-1)!;
  return { x, width: x.at(-1)! + first.w / 2 + last.w / 2 };
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
  if (type === 'group' && actors.length >= 3) {
    // Group of three or more: faces are laid out left to right with a spacing in head widths, smaller and in two staggered rows when
    // there are many; the camera zooms out as far as needed so that every head (and its margin) is inside the frame.
    const group = actors.slice().sort((a, b) => a.head.x + a.head.w / 2 - (b.head.x + b.head.w / 2) || b.body.y + b.body.h - (a.body.y + a.body.h));
    const n = group.length;
    const back = groupRows(group, bg, fr);
    const vis = (a: FramingActor) => visibleHead(a, fr).h;
    const refH = Math.max(...group.map(vis));
    const sizeK = groupSizeScale(n, fr);
    // each person's size is pulled towards the common head size (model scale differs), the back row is smaller
    const sc = group.map((a, i) => Math.pow(refH / vis(a), fr.groupSizeEqualize) * (back[i] ? fr.groupBackScale : 1));
    const people = group.map((a, i) => ({ w: a.head.w * sc[i]!, back: back[i]! }));
    const lay = groupFaceOffsets(people, fr, asp);
    const target = clamp((spec.headH * sizeK * H) / refH, MIN_ZOOM, MAX_ZOOM);
    // zoom out until the whole arrangement plus the edge margins fits the window width
    const mv = input.move ?? 'static';
    const moveRoom = mv === 'push_in' || mv === 'pull_out' ? fr.moveZoom : 1;
    const travel = mv === 'pan' ? fr.panShare : mv === 'track' ? fr.panShare * 0.6 : 0;
    const fit = (H * (asp * (1 - 2 * travel) - 2 * fr.groupEdgeMargin - 2 * Math.abs(fr.groupCenterX))) / (lay.width * moveRoom);
    const zoom = clamp(Math.min(target, fit), MIN_ZOOM, MAX_ZOOM);
    const Hv = H / zoom;
    const centreY = group.map((a) => a.head.y + a.head.h / 2);
    const eyes = group.map((a, i) => centreY[i]! + (eyeWorldY(a, fr) - centreY[i]!) * sc[i]!);
    const tops = group.map((a, i) => centreY[i]! + (visibleHead(a, fr).top - centreY[i]!) * sc[i]!);
    const rowMean = (isBack: boolean) => {
      const xs = eyes.filter((_, i) => back[i] === isBack);
      return xs.length > 0 ? xs.reduce((q, e) => q + e, 0) / xs.length : null;
    };
    const frontMean = rowMean(false) ?? rowMean(true)!;
    const backMean = rowMean(true);
    const dy = eyes.map((e, i) => {
      const mean = back[i] ? backMean! : frontMean;
      const aim = frontMean + (back[i] ? fr.groupRowDrop * refH * sizeK : 0) + (e - mean) * (1 - fr.heightEqualize);
      return aim - e;
    });
    let cy = frontMean + (0.5 - spec.eyeY) * Hv;
    cy = headTopFloor(cy, Math.min(...tops.map((t, i) => t + dy[i]!)), Hv, spec.topMargin);
    const faceCx = group.map((a) => a.head.x + a.head.w / 2);
    const rel = lay.x.map((x) => x - lay.width / 2 + people[0]!.w / 2 + fr.groupCenterX * Hv);
    const cx = faceCx.reduce((q, c, i) => q + c - rel[i]!, 0) / n;
    pose = mk(cx, cy, zoom);
    layout = (camX) => Object.fromEntries(group.map((a, i) => [a.id, { dx: camX + rel[i]! - faceCx[i]!, dy: dy[i]!, s: sc[i]! }]));
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
  const res = avoidEdgeCuts(input, pose, actors, safe, layout !== null);
  return { pose: res.pose, shifts: layout ? layout(res.pose.x) : {}, edgeCut: res.edgeCut };
}

/**
 * Which people of a group stand in the back row. With the blocking's depth range (>= groupRowDepthGap) the far half is the back
 * row (a band: drummer behind the vocalist); otherwise groups of `groupStaggerFrom` or more alternate (every second person back).
 */
export function groupRows(group: FramingActor[], bg: BgInfo, fr: Pick<Framing, 'groupRowDepthGap' | 'groupStaggerFrom'>): boolean[] {
  const depth = group.map((a) => feetToSlotDepth({ x: a.body.x + a.body.w / 2, y: a.body.y + a.body.h }, bg).depth);
  const lo = Math.min(...depth);
  const hi = Math.max(...depth);
  if (hi - lo >= fr.groupRowDepthGap) return depth.map((d) => d > lo + (hi - lo) / 2);
  if (group.length >= fr.groupStaggerFrom) return group.map((_, i) => i % 2 === 1);
  return group.map(() => false);
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
