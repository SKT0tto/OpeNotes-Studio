/** Narrative travel policy: motivation, real camera geometry and time; independent of identifiers. */
import type { ShotIntent } from '../staging/shotIntent';
import type { ShotType } from '../staging/framing';
import type { CameraPose, Pt } from '../staging/world';
import type { StyleValues } from '../style/ournotes';
import { clamp, type EaseName } from './easing';
import type { TravelKind } from './types';

export const SHOT_RANK: Record<ShotType, number> = { establishing: 0, group: 1, two_shot: 2, ms: 2.5, mcu: 3, cu: 4, ecu: 5, insert: 6 };

type MoveKind = Exclude<TravelKind, 'drift' | 'cutDrift'>;
export type TravelDecision =
  | { kind: 'cut'; warn?: string; reason: string }
  | { kind: 'glide'; reason: string }
  | { kind: MoveKind; seconds: number; ease: EaseName; land?: number; reason: string };

export interface TravelShotInfo {
  type: ShotType;
  /** The people the shot is about (a two-shot: the pair; a group: everybody on stage). */
  ids: string[];
  bgSeg: number;
  /** The static solution of the shot. */
  pose: CameraPose;
  /** Mean head centre of `ids` (world). */
  anchor: Pt;
  /** Slot rank (0 = leftmost) of each of `ids` among the people on stage; absent when unknown. */
  ranks?: number[];
  /** Who speaks in this shot's beat (null for none); absent when unknown. */
  speaker?: string | null;
}

export type Density = 'original' | 'less' | 'more' | 'off';

export interface TravelInput {
  cutIn: 'cut' | 'dip_black';
  move: string;
  userTransition: 'cut' | 'glide' | 'travel' | undefined;
  /** The previous shot that set a new camera (not held). */
  prev: TravelShotInfo | null;
  cur: TravelShotInfo;
  /** The previous beat was empty, this is the scene's first beat, or the background changes here. */
  afterEmpty: boolean;
  /** A real entrance (blocking.enter) happens at this beat. */
  trueEnter: boolean;
  /** Seconds from this beat to the next real shot change (held beats included), or the end of the scene / background segment. */
  span: number;
  /** Distance of neighbouring people on the compact stage, world units (0 outside the travel stage). */
  pitch: number;
  aspect: number;
  /** World height of the frame at zoom 1. */
  H: number;
  tv: StyleValues['travel'];
  intent?: ShotIntent;
  /** Provenance of the transition field, not of the whole shot. AI move requests cannot override narrative rules. */
  transitionSource?: 'user' | 'ai';
  /** Consecutive automatic moves without a stable viewing interval. */
  consecutiveMoves?: number;
  /** Actual legacy glide length, supplied by compile for manual-key safety. */
  glideSeconds?: number;
  /** Retained for callers of old projects; never used to choose a camera. */
  seed?: string;
  /** True when a manual camera key lies inside a move of this length starting at the beat. */
  manualIn?: (seconds: number) => boolean;
}

const MOVABLE: ShotType[] = ['group', 'two_shot', 'ms', 'mcu', 'cu', 'ecu'];
const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));
const intersects = (a: string[], b: string[]) => a.some((x) => b.includes(x));
/** murmur3 fmix32: neighbouring ids map to unrelated values. */
export const mix32 = (h: number) => {
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
};
/** Hash -> [0, 1). */
export const unitOf = (h: number) => mix32(h) / 4294967296;
/** String -> 32 bit hash (the same one compile.ts uses for its per-beat draws); `unitOf` mixes it so neighbouring ids decorrelate. */
export const hashSeed = (s: string) => [...s].reduce((a, c) => (a * 31 + c.codePointAt(0)!) >>> 0, 7);
/** A move may take at most this share of the time the shot is held. */
const MAX_BEAT_SHARE = 0.6;
/** A shot held shorter than this (after the share) does not move. */
const MIN_MOVE_SECONDS = 0.5;
/** Sideways distance in people: up to 1.25 neighbours, up to 2.25 one person in between, further apart beyond. */
export const ADJACENT_PEOPLE = 1.25;
export const SKIP_ONE_PEOPLE = 2.25;

export interface MoveGeometry {
  /** Sideways distance of the two static solutions in frame widths (as seen at the landing zoom). */
  d: number;
  /** Zoom ratio cur / prev. */
  r: number;
}
export function moveGeometry(prev: TravelShotInfo, cur: TravelShotInfo, H: number, aspect: number): MoveGeometry {
  return { d: (Math.abs(cur.pose.x - prev.pose.x) * cur.pose.zoom) / (H * aspect), r: cur.pose.zoom / prev.pose.zoom };
}

/** Sideways distance between two shots in people (1 = neighbours). A person taken out of the previous shot counts as a neighbour at most. */
export function lateralPeople(prev: TravelShotInfo, cur: TravelShotInfo, pitch: number): number {
  if (sameSet(prev.ids, cur.ids)) return 0;
  if (pitch <= 0) return 1;
  const lat = Math.abs(cur.anchor.x - prev.anchor.x) / pitch;
  return cur.ids.every((id) => prev.ids.includes(id)) ? Math.min(lat, 1) : lat;
}

/**
 * Seconds a move takes: the median of the original's moves of this type (MyGO scripts, analysis section 3) times the tempo setting. The
 * length of the line does not matter; the caller caps the result by how long the shot is held.
 */
export function moveSeconds(kind: 'distance' | 'regroup' | 'lateral', prev: TravelShotInfo, cur: TravelShotInfo, lat: number, tv: StyleValues['travel'], geo?: MoveGeometry): number {
  let base: number;
  if (kind === 'distance') {
    const push = cur.pose.zoom > prev.pose.zoom;
    const twoSteps = Math.abs(SHOT_RANK[cur.type] - SHOT_RANK[prev.type]) > 1.2;
    base = push ? (twoSteps ? 1.5 : 1.3) : twoSteps ? 1.5 : 1.0;
  } else if (kind === 'regroup') {
    base = cur.ids.length > prev.ids.length ? 1.0 : 1.2;
  } else {
    base = lat <= ADJACENT_PEOPLE ? 1.0 : lat <= SKIP_ONE_PEOPLE ? 1.2 : 1.3;
  }
  // The original's durations spread from 0.5 s to 2 s (IQR 1.0-1.5): a short hop is quick, a long sweep or a big push-pull is slow.
  // `size` is 1 for a typical move (about 0.35 frame widths sideways, or a zoom ratio of 1.6).
  if (geo) base *= moveSizeFactor(geo);
  return clamp(base * tv.tempo, 0.4, tv.moveMax);
}
/** Duration factor of a move by its size: 1 at a typical move, quicker for a hop, slower for a sweep or a big push / pull. */
export function moveSizeFactor(geo: MoveGeometry): number {
  const size = clamp(Math.max(geo.d / MOVE_TYPICAL_D, Math.abs(Math.log(geo.r)) / Math.log(MOVE_TYPICAL_R)), MOVE_SIZE_MIN, MOVE_SIZE_MAX);
  return MOVE_SIZE_BASE + (1 - MOVE_SIZE_BASE) * size;
}
const MOVE_TYPICAL_D = 0.25;
const MOVE_TYPICAL_R = 1.5;
const MOVE_SIZE_MIN = 0.1;
const MOVE_SIZE_MAX = 2.4;
const MOVE_SIZE_BASE = 0.2;

const INTENT_TEXT: Record<ShotIntent, string> = {
  continue: '延续观看', exchange: '交接注意', emphasis: '强调焦点', reaction: '观察反应',
  reveal: '揭示新焦点', release: '舒缓并交代关系', rupture: '叙事断裂',
};

/** Stage neighbours: some differing person of the two shots stands exactly next to one of the other shot by slot rank (people on stage only). */
export function stageNeighbours(prev: TravelShotInfo, cur: TravelShotInfo): boolean {
  if (!prev.ranks || !cur.ranks || sameSet(prev.ids, cur.ids)) return false;
  return cur.ids.some((c, ci) => !prev.ids.includes(c) && prev.ids.some((p, pi) => !cur.ids.includes(p) && Math.abs(cur.ranks![ci]! - prev.ranks![pi]!) === 1));
}

/** Existing projects infer conservatively from structure, never from the prose reason or IDs. */
export function inferTravelIntent(prev: TravelShotInfo | null, cur: TravelShotInfo): ShotIntent {
  if (!prev) return 'reveal';
  const ratio = cur.pose.zoom / prev.pose.zoom;
  if (sameSet(prev.ids, cur.ids)) return ratio > 1.03 ? 'emphasis' : ratio < 1 / 1.03 ? 'release' : 'continue';
  if (cur.ids.length > prev.ids.length && intersects(prev.ids, cur.ids) && ratio < 1 / 1.03) return 'release';
  // A close-up where the speaker changes is a handoff; a reaction is a silent listener (or the same speaker staying).
  if (cur.type === 'cu' || cur.type === 'ecu') {
    const listener = cur.speaker != null && !cur.ids.includes(cur.speaker);
    const speakerChanges = cur.speaker != null && prev.speaker !== undefined && cur.speaker !== prev.speaker;
    return listener || !speakerChanges ? 'reaction' : 'exchange';
  }
  return 'exchange';
}

/** The intent the geometry of a move really shows (null when it shows none). */
function geometryIntent(prev: TravelShotInfo, cur: TravelShotInfo, r: number): ShotIntent | null {
  if (sameSet(prev.ids, cur.ids)) return r > 1.03 ? 'emphasis' : r < 1 / 1.03 ? 'release' : null;
  if (cur.ids.some((id) => !prev.ids.includes(id)) && cur.ids.length > prev.ids.length && intersects(prev.ids, cur.ids)) return r < 1 / 1.03 ? 'release' : 'reveal';
  return 'exchange';
}
const STRUCTURAL: ShotType[] = ['group', 'two_shot', 'ms'];

/** May an AI-suggested hard cut stand? Reaction / rupture, or a different person entering a close-up (cu / ecu). */
export function aiCutHonoured(intent: ShotIntent | undefined, prev: { ids: string[] } | null, cur: { type: ShotType; ids: string[] }): boolean {
  if (intent === 'reaction' || intent === 'rupture') return true;
  return (cur.type === 'cu' || cur.type === 'ecu') && (!prev || !sameSet(prev.ids, cur.ids));
}

export function decideTravel(i: TravelInput): TravelDecision {
  const { cur, prev, tv, userTransition } = i;
  const density = tv.density as Density;
  const intent = i.intent ?? inferTravelIntent(prev, cur);
  let intentUsed: ShotIntent = intent;
  let rewritten = false;
  const motivation = INTENT_TEXT[intent];
  const manual = i.transitionSource !== 'ai';
  const forced = manual && userTransition === 'travel';
  const cut = (why: string, warn = false): TravelDecision => ({ kind: 'cut', reason: `硬切：${motivation}；${why}`, ...((forced || warn) ? { warn: `运镜不可行，已改为硬切：${why}` } : {}) });
  if (cur.type === 'establishing' || cur.type === 'insert' || cur.ids.length === 0) return cut('空镜/插入');
  // An explicit user / locked cut is absolute. An AI `flow=cut` is a suggestion: it is honoured as a hard cut only for a reaction, a
  // rupture, or a change of person into a close-up; otherwise the structural rules below decide.
  if (userTransition === 'cut' && (manual || aiCutHonoured(intent, prev, cur))) return { kind: 'cut', reason: `${manual ? '用户' : 'AI'}指定硬切：${motivation}` };
  if (i.cutIn === 'dip_black') return cut('黑场分隔，重新建立观看');
  if (i.afterEmpty) {
    // Establish the space once. Continue/reaction/rupture never get a decorative push after a cut.
    if (i.move === 'static' && density !== 'off' && intent === 'reveal' && i.span >= 2) {
      if (i.manualIn?.(Math.min(tv.settleSeconds, i.span * MAX_BEAT_SHARE))) return cut('运镜段内有手动相机关键帧', true);
      return { kind: 'settle', seconds: Math.min(tv.settleSeconds, i.span * MAX_BEAT_SHARE), ease: tv.ease as EaseName, reason: `收势：${motivation}，场首轻推后稳定观看` };
    }
    return cut(density === 'off' ? '运镜密度为关' : '场首/空镜之后建立稳定观看');
  }
  if (!prev) return cut('没有上一个镜头');
  if (!MOVABLE.includes(prev.type) || !MOVABLE.includes(cur.type)) return cut('前后镜头不是人物景别');
  if (prev.bgSeg !== cur.bgSeg) return cut('跨背景');
  const geo = moveGeometry(prev, cur, i.H, i.aspect);
  const maxD = forced ? Math.max(tv.maxTravelW, 1) : tv.maxTravelW;
  if (geo.d > maxD) return cut(`横移 ${geo.d.toFixed(2)} 屏宽，太远`);
  if (geo.r > tv.maxZoomRatio || geo.r < 1 / tv.maxZoomRatio) return cut('推拉比例太大');
  const kind = sameSet(prev.ids, cur.ids) ? 'distance' : intersects(prev.ids, cur.ids) ? 'regroup' : 'lateral';
  if (kind === 'distance' && Math.abs(SHOT_RANK[prev.type] - SHOT_RANK[cur.type]) > tv.maxSizeSteps) return cut('景别相差太大');
  const yChange = Math.abs(cur.pose.y - prev.pose.y) * cur.pose.zoom / i.H;
  if (geo.d < 1e-3 && yChange < 1e-3 && Math.abs(Math.log(geo.r)) < 1e-3) return cut('前后机位相同');
  if (i.span * MAX_BEAT_SHARE < MIN_MOVE_SECONDS) return cut(`镜头只停留 ${i.span.toFixed(1)} s`);

  const lat = lateralPeople(prev, cur, i.pitch);
  const reframe = i.trueEnter && cur.ids.length >= 2;
  const seconds = Math.min(reframe ? tv.reframeSeconds : moveSeconds(kind, prev, cur, lat, tv, geo), i.span * MAX_BEAT_SHARE);
  if (i.manualIn?.(userTransition === 'glide' && manual ? (i.glideSeconds ?? seconds) : seconds)) return cut('运镜段内有手动相机关键帧', true);
  if (userTransition === 'glide' && manual) return { kind: 'glide', reason: `用户指定缓切：${motivation}` };
  if (!forced) {
    if (density === 'off') return cut('运镜密度为关');
    if (intent === 'reaction' || intent === 'rupture') return cut('切开观看，让反应或断裂直接呈现');
    if ((i.consecutiveMoves ?? 0) >= (density === 'less' ? 1 : 2)) return cut('连续运动后留出稳定观看时间');
    // Landing on a group, two-shot or medium shot with the same or a neighbouring person moves by default. When the intent label
    // contradicts the geometry, the reason is rewritten from the geometry instead of rejecting the move.
    const near = lat <= ADJACENT_PEOPLE && geo.d <= (density === 'more' ? 0.9 : 0.65);
    // Stage neighbours (adjacent by slot rank) may hand over regardless of measured spacing; only the maxTravelW cap above applies.
    const neighbours = stageNeighbours(prev, cur);
    let geoIntent = STRUCTURAL.includes(cur.type) && (near || neighbours) ? geometryIntent(prev, cur, geo.r) : null;
    if (!near && geoIntent !== 'exchange') geoIntent = null;
    const labelOk =
      intent === 'continue' ? false
        : intent === 'emphasis' ? geo.r > 1.03 && intersects(prev.ids, cur.ids)
          : intent === 'release' ? geo.r < 1 / 1.03
            : intent === 'reveal' ? cur.ids.some((id) => !prev.ids.includes(id))
              : !sameSet(prev.ids, cur.ids);
    const framingChanged = cur.type !== prev.type || !sameSet(prev.ids, cur.ids);
    if (geoIntent && !labelOk && (intent !== 'continue' || framingChanged)) {
      if (density === 'less' && geoIntent === 'exchange') return cut('较少运镜：交接注意用切，保留强调/揭示/舒缓');
      intentUsed = geoIntent;
      rewritten = true;
    } else {
      if (intent === 'continue') return cut('保持稳定，不为延续增加运动');
      if (intent === 'emphasis' && (geo.r <= 1.03 || !intersects(prev.ids, cur.ids))) return cut('强调需要同一焦点真实推近');
      if (intent === 'release' && geo.r >= 1 / 1.03) return cut('舒缓需要真实拉远');
      if (intent === 'reveal' && !cur.ids.some((id) => !prev.ids.includes(id))) return cut('没有新增可见焦点');
      if ((intent === 'exchange' || intent === 'reveal') && !(intent === 'exchange' && neighbours) && (lat > ADJACENT_PEOPLE || geo.d > (density === 'more' ? 0.9 : 0.65))) return cut('交接距离太远，直接切到新焦点');
      if (intent === 'exchange' && sameSet(prev.ids, cur.ids)) return cut('焦点没有交接');
      // Less keeps only deliberate pushes/pulls/reveals. More admits a wider adjacent transfer,
      // but cannot invent a motivation or exceed the same geometry and rhythm safeguards.
      if (density === 'less' && intent === 'exchange') return cut('较少运镜：交接注意用切，保留强调/揭示/舒缓');
    }
  }
  const dir = geo.r > 1.03 ? '推近' : geo.r < 1 / 1.03 ? '拉远' : geo.d > 1e-3 ? (cur.pose.x > prev.pose.x ? '向右横移' : '向左横移') : '纵向重构图';
  const reason = rewritten
    ? `运镜：${INTENT_TEXT[intentUsed]}，${dir}（按机位改写理由，原意图「${motivation}」与几何不符）${i.trueEnter ? '，入场重构图' : ''}`
    : `${forced ? '用户指定运镜' : '运镜'}：${motivation}，${dir}${i.trueEnter ? '，入场重构图' : ''}`;
  const land = kind === 'lateral' && prev.type === cur.type && i.move === 'static' && cur.type !== 'ecu' && tv.landPush > 1 ? tv.landPush : undefined;
  return { kind: reframe ? 'reframe' : kind, seconds, ease: (kind === 'distance' ? tv.ease : tv.moveEase) as EaseName, ...(land ? { land } : {}), reason };
}
