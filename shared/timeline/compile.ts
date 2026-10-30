/**
 * compile: Project (intent level) -> CompiledProject (absolute time, real resources, solved camera poses).
 * Pure: the same project + context always gives the same result. It never invents resources: a motion / expression the
 * actor's CURRENT model does not have is mapped to the closest one that it does have (with a warning), and every actor on
 * stage always has an idle loop to fall back to.
 */
import type { Calibration } from '../schema/calibration';
import { cameraSystemOf, type Channel, type MemoryEdge, type MemoryTone, type Project, type Scene, type Track } from '../schema/project';
import { chooseMotionVariant, desiredGaze, desiredYaw, nominalScreenYaw, variantsOfFamily, yawTowardsCamera } from '../staging/facing';
import { cameraMove, normalizeShotType, solveShotDetailed, visibleHead, type CameraMove, type FramingActor, type InsertBox, type ShotType } from '../staging/framing';
import { placeActor, type Placement } from '../staging/ground';
import { arrangeRect, buildStageMap, shiftPlacement, stageArrangement, stageDx, type StageMap } from '../staging/compactStage';
import { driftEnd, pushAbout, settleStart } from '../staging/travel';
import { solveTravelShot } from '../staging/travelFraming';
import { defaultGround, viewWorldHeight, type BgInfo, type CameraPose, type Pt } from '../staging/world';
import { clamp, lerp, type EaseName } from './easing';
import { EMOTION_GESTURE, familyOfName, idleFamilyOf, isLiveSet, isLoopFamily, mapExpressionName, mapMotionFamily, pickReaction } from './motionMap';
import { DIP_WHITE, SHAKE_SECONDS, FLASH_PEAK, FLASH_RISE, FLASH_SECONDS, MEMORY_DEFAULT_EDGE, MEMORY_DEFAULT_TONE } from './fxParams';
import { clipOverlaps, lastBefore, sampleKeys } from './sample';
import type { StyleValues } from '../style/ournotes';
import { evaluate } from './evaluate';
import { EMPTY_KINDS, TEXT_KINDS, sceneTimes, type SceneTime } from './time';
import { SHOT_RANK, aiCutHonoured, decideTravel, hashSeed, type TravelShotInfo } from './travelPolicy';
import type {
  BgSegment, CameraKey, CompileContext, CompiledActor, CompiledBeat, CompiledProject, CompiledScene, ExprEvent, FadeKey, GazeKey, MemoryLookKey, ModelKey, ShakeWindow, MotionEvent, NumKey, PosKey, RuleKey, UiStyle,
} from './types';

/** Glide length used when a beat asks for `transition: 'glide'` while the style's glideSeconds is 0. */
const DEFAULT_GLIDE = 0.5;
/// Re-pick the idle variant when the wanted yaw is this far from what the current variant bakes in.
const RESELECT_YAW_GAP = 0.55;
const FRAMING_YAW_LOOKAHEAD = 0.5;
/** Longest cross-fade of a person who is inside the frame and still has to appear / disappear during a travel move (the original: 0.2 s). */
const TRAVEL_FADE_MAX = 0.2;

type KeyOf<C extends Channel> = Extract<Track, { channel: C }>['keys'][number];
type Timed<C extends Channel> = { k: KeyOf<C>; at: number };

interface Work {
  castId: string;
  initialModelId: string;
  initialPos: { slot: number; depth: number };
  models: ModelKey[];
  position: PosKey[];
  /** Spans in which the actor is off stage (before entering, empty shots, after exiting). */
  away: Interval[];
  /** Side the actor slides in from when it appears. */
  side: 'left' | 'right' | 'none';
}

export function compileProject(project: Project, ctx: CompileContext): CompiledProject {
  const warnings: string[] = [];
  const times = sceneTimes(project);
  const bgm: CompiledProject['bgm'] = [];
  const se: CompiledProject['se'] = [];
  const fx: CompiledProject['fx'] = { anxiety: [], glow: [], roll: [] };
  const memory: NumKey[] = [];
  const dim: NumKey[] = [];
  const shake: ShakeWindow[] = [];
  const daze: NumKey[] = [];
  const blink: NumKey[] = [];
  const memoryLook: Array<{ at: number; tone?: MemoryTone | undefined; edge?: MemoryEdge | undefined }> = [];
  let fade: FadeKey[] = [];

  const scenes = project.scenes.map((scene, index) => {
    const out = compileScene(project, scene, index, times[index]!, ctx, warnings, fade);
    if (scene.audio.bgm) bgm.push({ at: times[index]!.start, assetId: scene.audio.bgm.assetId, volume: scene.audio.bgm.volume });
    const abs = absoluteTime(scene, times[index]!, warnings);
    for (const { k, at } of collect(scene, 'bgm', (t) => t.target.kind === 'audio', abs)) bgm.push({ at, assetId: k.value.assetId, volume: k.value.volume });
    for (const { k, at } of collect(scene, 'se', (t) => t.target.kind === 'audio', abs)) se.push({ at, assetId: k.value.assetId, volume: k.value.volume });
    for (const { k, at } of collect(scene, 'fade', (t) => t.target.kind === 'screen', abs)) {
      fade.push({ at, duration: k.duration, ease: k.ease, alpha: k.value.alpha, color: k.value.color });
    }
    for (const { k, at } of collect(scene, 'fx', (t) => t.target.kind === 'screen', abs)) {
      const base = { at, duration: k.duration, ease: k.ease };
      if (k.value.fx === 'vignette_anxiety') fx.anxiety.push({ ...base, value: k.value.strength });
      else if (k.value.fx === 'memory_glow') fx.glow.push({ ...base, value: k.value.strength });
      else if (k.value.fx === 'memory') {
        memory.push({ ...base, value: k.value.strength });
        memoryLook.push({ at, tone: k.value.tone, edge: k.value.edge });
      } else if (k.value.fx === 'flash') {
        // a flash is a white fade: up in FLASH_RISE, then down over the rest of the key (no new compiled array, no new evaluate field)
        const total = k.duration > 0 ? k.duration : FLASH_SECONDS;
        const rise = Math.min(FLASH_RISE, total);
        fade.push(
          { at, duration: rise, ease: 'outQuad', alpha: FLASH_PEAK * k.value.strength, color: 'white' },
          { at: at + rise, duration: Math.max(0, total - rise), ease: 'outQuad', alpha: 0, color: 'white' },
        );
      } else if (k.value.fx === 'daze') {
        daze.push({ ...base, value: k.value.strength });
        blink.push({ ...base, value: k.value.variant === 'blink' ? k.value.strength : 0 });
      } else if (k.value.fx === 'shake') shake.push({ start: at, seconds: k.duration > 0 ? k.duration : SHAKE_SECONDS, strength: k.value.strength });
      else if (k.value.fx === 'dim') dim.push({ ...base, value: k.value.strength });
      else fx.roll.push({ ...base, value: k.value.roll });
    }
    return out;
  });
  bgm.sort((a, b) => a.at - b.at);
  se.sort((a, b) => a.at - b.at);
  fade = clipOverlaps(fade);
  const fxOut: CompiledProject['fx'] = { anxiety: clipOverlaps(fx.anxiety), glow: clipOverlaps(fx.glow), roll: clipOverlaps(fx.roll) };
  // the new effects add their arrays only when a key uses them: a project without them compiles to exactly the old object
  if (memory.length > 0) {
    fxOut.memory = clipOverlaps(memory);
    fxOut.memoryLook = resolveMemoryLook(memoryLook);
  }
  if (dim.length > 0) fxOut.dim = clipOverlaps(dim);
  if (daze.length > 0) {
    fxOut.daze = clipOverlaps(daze);
    // the eyelid curve exists only when some daze key asks for the blink variant
    if (blink.some((k) => k.value > 0)) fxOut.blink = clipOverlaps(blink);
  }
  if (shake.length > 0) fxOut.shake = shake.sort((a, b) => a.start - b.start);
  return { duration: times.at(-1)?.end ?? 0, scenes, bgm, se, fade, fx: fxOut, warnings };
}

/** A memory key without its own tone / edge (typically the one that switches it off) keeps the look of the key before it, so the fade-out looks like the effect. */
function resolveMemoryLook(keys: Array<{ at: number; tone?: MemoryTone | undefined; edge?: MemoryEdge | undefined }>): MemoryLookKey[] {
  let tone: MemoryTone = MEMORY_DEFAULT_TONE;
  let edge: MemoryEdge = MEMORY_DEFAULT_EDGE;
  return [...keys].sort((a, b) => a.at - b.at).map((k) => {
    tone = k.tone ?? tone;
    edge = k.edge ?? edge;
    return { at: k.at, tone, edge };
  });
}

function absoluteTime(scene: Scene, st: SceneTime, warnings: string[]) {
  const beats = new Map(st.beats.map((b) => [b.beatId, b]));
  return (at: { beatId: string; offset: number }): number | null => {
    const b = beats.get(at.beatId);
    if (!b) {
      warnings.push(`scene ${scene.id}: key references unknown beat "${at.beatId}" (dropped)`);
      return null;
    }
    return b.start + at.offset;
  };
}

function collect<C extends Channel>(scene: Scene, channel: C, match: (t: Track) => boolean, abs: (a: { beatId: string; offset: number }) => number | null): Array<Timed<C>> {
  const out: Array<Timed<C>> = [];
  for (const tr of scene.tracks) {
    if (tr.channel !== channel || !match(tr)) continue;
    for (const k of tr.keys) {
      const at = abs(k.at);
      if (at !== null) out.push({ k: k as KeyOf<C>, at });
    }
  }
  return out.sort((a, b) => a.at - b.at);
}

const uiOf = (v: StyleValues): UiStyle => ({ dialog: v.dialog, hud: v.hud, location: v.location, stage: v.stage, fx: v.fx, performance: v.performance });

/** Expression / gesture families the rule director picks from, per emotion tag (first available wins, rotating). */
export const EMOTION_EXPR: Record<string, string[]> = {
  happy: ['exp_smile01', 'exp_smile02', 'exp_bsmile01', 'exp_smile03'],
  sad: ['exp_sad01', 'exp_sad02', 'exp_cry01'],
  angry: ['exp_angry01', 'exp_serious01'],
  surprised: ['exp_surprised01', 'exp_surprised02'],
  shy: ['exp_shy01', 'exp_smile01'],
  thinking: ['exp_serious01', 'exp_thinking01', 'exp_idle02'],
  serious: ['exp_serious01', 'exp_serious02'],
  neutral: ['exp_idle01'],
};
export { EMOTION_GESTURE };

/** Emotion tags the rule director understands (the `emotion` field of a beat). */
export const EMOTION_TAGS = Object.keys(EMOTION_EXPR);

type Interval = [number, number];
export const hashStr = hashSeed;
const isIdleName = (name: string) => /^(mtn_)?idle/i.test(name);
const mergeIntervals = (xs: Interval[]): Interval[] => {
  const out: Interval[] = [];
  for (const x of [...xs].sort((a, b) => a[0] - b[0])) {
    const last = out.at(-1);
    if (last && x[0] <= last[1] + 1e-9) last[1] = Math.max(last[1], x[1]);
    else out.push([x[0], x[1]]);
  }
  return out;
};

function compileScene(project: Project, scene: Scene, index: number, st: SceneTime, ctx: CompileContext, warnings: string[], fadeOut: FadeKey[]): CompiledScene {
  const bgInfoOf = (id: string): BgInfo | null => {
    const raw = ctx.backgrounds[id];
    return raw ? { width: raw.width, height: raw.height, ground: raw.ground ?? defaultGround(raw.width, raw.height, raw.setting) } : null;
  };
  if (!bgInfoOf(scene.background.assetId)) throw new Error(`scene ${scene.id}: unknown background "${scene.background.assetId}"`);
  const framing = scene.background.framing;
  const abs = absoluteTime(scene, st, warnings);

  // ---- background track (P20): segments in time order -------------------------------------------------------
  const bgSegments: BgSegment[] = [{ start: st.start, end: st.end, assetId: scene.background.assetId, bg: bgInfoOf(scene.background.assetId)!, framing, transition: 'cut', transitionSeconds: 0, purpose: 'move', keyId: null }];
  for (const { k, at } of collect(scene, 'background', (t) => t.target.kind === 'stage', abs)) {
    const info = bgInfoOf(k.value.assetId);
    if (!info) {
      warnings.push(`scene ${scene.id}: background key ${k.id} uses unknown background "${k.value.assetId}" (dropped)`);
      continue;
    }
    const prev = bgSegments.at(-1)!;
    const seg: BgSegment = {
      start: Math.max(at, st.start), end: st.end, assetId: k.value.assetId, bg: info, framing: k.value.framing ?? framing,
      transition: k.value.transition, transitionSeconds: k.value.transitionSeconds, purpose: k.value.purpose, keyId: k.id,
    };
    if (Math.abs(prev.start - seg.start) < 1e-6 && bgSegments.length > 1) bgSegments[bgSegments.length - 1] = seg; // two keys at one instant: the later wins
    else if (Math.abs(prev.start - seg.start) < 1e-6) bgSegments[0] = { ...seg, transition: 'cut', transitionSeconds: 0, keyId: seg.keyId };
    else bgSegments.push(seg);
  }
  bgSegments.forEach((sg, i) => { sg.end = bgSegments[i + 1]?.start ?? st.end; });
  // The world (camera, ground, people) belongs to the first full-size background: a 256 px plain picture never decides the size of the stage,
  // and a later background of another size is fitted over the same world, so nobody jumps when the picture changes.
  const worldSeg = bgSegments.find((sg) => sg.bg.width >= 512) ?? bgSegments[0]!;
  const bg: BgInfo = worldSeg.bg;
  const bgAt = (t: number) => [...bgSegments].reverse().find((sg) => sg.start <= t + 1e-9) ?? bgSegments[0]!;
  const lumaAt = (t: number) => ctx.backgrounds[bgAt(t).assetId]?.luma;
  // cut-away shots show an empty stage: everybody fades out for the length of the segment
  const insertRuns: Array<[number, number]> = bgSegments.filter((sg, i) => i > 0 && sg.purpose === 'insert').map((sg) => [sg.start, sg.end]);
  const list = st.list;
  const sceneV = st.sceneStyle.values;
  const beatIndex = new Map(list.map((b, i) => [b.id, i]));
  // ---- travel camera system (only travel scenes; classic never reads any of this) ---------------------------------
  const travel = cameraSystemOf(project, scene) === 'travel';
  const tv = sceneV.travel;
  const asp = ctx.aspect ?? 16 / 9;
  const segIndexAt = (t: number) => bgSegments.indexOf(bgAt(t));

  const calOf = (modelId: string): Calibration => {
    const c = ctx.calibrations[modelId];
    if (!c) throw new Error(`scene ${scene.id}: model "${modelId}" has no calibration (probe it first)`);
    return c;
  };

  // Spans of empty shots (establishing / empty beats): everybody fades out for the whole run.
  const emptyRuns = mergeIntervals([...list.flatMap((b, i): Interval[] => (EMPTY_KINDS.includes(b.kind) ? [[i === 0 ? st.start : st.beats[i]!.start, st.beats[i]!.end]] : [])), ...insertRuns]);
  const presentAt = (w: { away: Interval[] }, t: number) => !w.away.some(([a, b]) => t >= a - 1e-9 && t < b - 1e-9);

  // ---- actors: model + position timelines ---------------------------------------------------------------
  const works: Work[] = Object.keys(scene.wardrobe).map((castId) => {
    const w = scene.wardrobe[castId]!;
    const b: Scene['blocking'][string] = scene.blocking[castId] ?? (warnings.push(`scene ${scene.id}: ${castId} has no blocking (centred)`), { slot: 0, depth: 0.3, meta: scene.meta });
    const mine = (t: Track) => t.target.kind === 'actor' && t.target.castId === castId;
    const position = clipOverlaps(
      collect(scene, 'position', mine, abs).map(({ k, at }): PosKey => ({ at, duration: k.duration, ease: k.ease, slot: k.value.slot, depth: k.value.depth })),
    );
    const models = collect(scene, 'costume', mine, abs).map(({ k, at }): ModelKey => ({ at, modelId: k.value.modelId }));
    for (const m of models) calOf(m.modelId);
    const away: Interval[] = [...emptyRuns];
    const beatAt = (id: string, what: string): number | null => {
      const bi = beatIndex.get(id);
      if (bi === undefined) {
        warnings.push(`scene ${scene.id}: ${castId} ${what} references unknown beat "${id}" (ignored)`);
        return null;
      }
      return st.beats[bi]!.start;
    };
    if (b.enter) {
      const at = beatAt(b.enter.beatId, 'enter');
      if (at !== null) away.push([st.start, at]);
    }
    if (b.exit) {
      const at = beatAt(b.exit.beatId, 'exit');
      if (at !== null) away.push([at, Infinity]);
    }
    const side = b.enter ? b.enter.side : b.slot < 0 ? 'left' : 'right';
    return { castId, initialModelId: w.modelId, initialPos: { slot: b.slot, depth: b.depth }, models, position, away: mergeIntervals(away), side };
  });
  for (const w of works) calOf(w.initialModelId);

  const modelAt = (w: Work, t: number) => lastBefore(w.models, t)?.modelId ?? w.initialModelId;
  const posAt = (w: Work, t: number) =>
    sampleKeys(w.position, t, w.initialPos, (k) => ({ slot: k.slot, depth: k.depth }), (a, b, e) => ({ slot: lerp(a.slot, b.slot, e), depth: lerp(a.depth, b.depth, e) }));
  const placeAtClassic = (w: Work, t: number): Placement => placeActor(calOf(modelAt(w, t)), posAt(w, t), bg);
  // Travel scenes: everybody stands on the compact stage (set below, before the first use). Classic keeps the very same object.
  let stage: StageMap | null = null;
  const placeAt = (w: Work, t: number): Placement => {
    const p = placeAtClassic(w, t);
    return stage ? shiftPlacement(p, stageDx(stage, posAt(w, t).slot, bg)) : p;
  };
  let arr: Record<string, { dy: number; s: number }> = {};
  /** Distance of neighbouring people on the compact stage (world units); 0 outside the travel stage. */
  let pitchWorld = 0;
  if (travel) {
    const fr0 = sceneV.framing;
    const visH = (w: Work) => placeAtClassic(w, st.start).headBox.h * (fr0.headChin - fr0.headTop);
    const meanVis = works.length > 0 ? works.reduce((q, w) => q + visH(w), 0) / works.length : 0;
    pitchWorld = tv.pitchHeads * meanVis;
    stage = buildStageMap(works.flatMap((w) => [w.initialPos.slot, ...w.position.map((k) => k.slot)]), pitchWorld, bg.width / 2);
    arr = stageArrangement(
      works.map((w) => {
        const p = placeAt(w, st.start);
        return { id: w.castId, head: p.headBox, depth: w.initialPos.depth, visH: visH(w), eyeY: p.headBox.y + p.headBox.h * fr0.eyeFrac };
      }),
      fr0,
    );
  }
  // Facing uses the authored blocking in both systems: compact-stage spacing must not change the settled pose or look-room.
  const nearestPartner = (w: Work, t: number): Work | null => {
    const me = placeAtClassic(w, t).headCenter.x;
    let best: Work | null = null;
    let bestD = Infinity;
    for (const o of works) {
      if (o === w) continue;
      const d = Math.abs(placeAtClassic(o, t).headCenter.x - me);
      if (d < bestD) {
        best = o;
        bestD = d;
      }
    }
    return best;
  };

  const yawFor = (w: Work, v: { mode: 'target'; target: string } | { mode: 'angle'; yaw: number }, t: number): number => {
    if (v.mode === 'angle') return v.yaw;
    const self = placeAtClassic(w, t);
    const partner = nearestPartner(w, t);
    // 'auto' = the default facing (towards the nearest partner); used by a head key that only sets the pitch
    if (v.target === 'auto') return partner ? desiredYaw(self.headCenter, placeAtClassic(partner, t).headCenter, self.headUnit) : 0;
    if (v.target === 'camera') return yawTowardsCamera(self.headCenter, partner ? placeAtClassic(partner, t).headCenter : null);
    if (v.target === 'away') return partner ? -Math.sign(placeAtClassic(partner, t).headCenter.x - self.headCenter.x) * 0.7 : 0.7;
    const other = works.find((o) => o.castId === v.target && o !== w);
    if (!other) {
      warnings.push(`scene ${scene.id}: ${w.castId} turns towards unknown/absent "${v.target}" (facing camera instead)`);
      return yawTowardsCamera(self.headCenter, partner ? placeAtClassic(partner, t).headCenter : null);
    }
    return desiredYaw(self.headCenter, placeAtClassic(other, t).headCenter, self.headUnit);
  };

  const yawFns = new Map<string, (t: number) => number>();
  const actors: CompiledActor[] = works.map((w) => {
    const mine = (t: Track) => t.target.kind === 'actor' && t.target.castId === w.castId;
    const ruleKeys: RuleKey[] = [];
    const opacity = clipOverlaps(collect(scene, 'opacity', mine, abs).map(({ k, at }): NumKey => ({ at, duration: k.duration, ease: k.ease, value: k.value })));

    // on / off stage: fade out when leaving, fade in (and slide) when entering. The camera never sees a half-faded entrance as "empty".
    const perf0 = sceneV.performance;
    const presence: NumKey[] = [{ at: st.start, duration: 0, ease: 'linear', value: presentAt(w, st.start) ? 1 : 0 }];
    const slide: NumKey[] = [{ at: st.start, duration: 0, ease: 'linear', value: 0 }];
    for (const [a, b] of w.away) {
      if (a > st.start + 1e-9) presence.push({ at: a, duration: perf0.exitSeconds, ease: 'outQuad', value: 0 });
      if (Number.isFinite(b)) {
        presence.push({ at: b, duration: perf0.enterSeconds, ease: 'linear', value: 1 });
        if (w.side !== 'none') {
          slide.push({ at: b, duration: 0, ease: 'linear', value: (w.side === 'left' ? -1 : 1) * perf0.enterSlide });
          slide.push({ at: b, duration: perf0.enterSeconds, ease: 'outQuad', value: 0 });
        }
      }
    }

    // facing
    const partner0 = nearestPartner(w, st.start);
    const headKeys = collect(scene, 'head', mine, abs).map(({ k, at }): NumKey => ({ at, duration: k.duration, ease: k.ease, value: yawFor(w, k.value, at) }));
    // Rule director: a listener turns to the speaker a moment after the line starts, unless a hand / AI head key of this
    // actor lies inside that line's time span (the rule yields per line, so editing one line keeps the others).
    if (works.length > 1) {
      const handAts = headKeys.map((h) => h.at);
      list.forEach((b, i) => {
        const ps = st.styles[i]!.values.performance;
        const span = st.beats[i]!;
        if (handAts.some((a) => a >= span.start - 1e-6 && a < span.end - 1e-6)) return;
        if (!ps.ruleDirector || !TEXT_KINDS.includes(b.kind) || !b.speakerId || b.speakerId === w.castId || !works.some((o) => o.castId === b.speakerId)) return;
        const at = st.beats[i]!.start + ps.listenerTurnDelay;
        headKeys.push({ at, duration: 0.3, ease: 'inOutSine', value: yawFor(w, { mode: 'target', target: b.speakerId }, at) });
        ruleKeys.push({ channel: 'head', beatId: b.id, offset: ps.listenerTurnDelay, at, duration: 0.3, value: { mode: 'target', target: b.speakerId } });
      });
      headKeys.sort((a, b) => a.at - b.at);
    }
    // Before anything is keyed an actor faces its nearest partner; a head key placed at the very start of the
    // content replaces that default already during the transition lead-in (no pop when the first line starts).
    const lead = headKeys[0];
    const initialYaw =
      lead && lead.at <= st.contentStart + 1e-6
        ? lead.value
        : partner0
          ? desiredYaw(placeAtClassic(w, st.start).headCenter, placeAtClassic(partner0, st.start).headCenter, placeAtClassic(w, st.start).headUnit)
          : 0;
    const yaw = clipOverlaps<NumKey>([{ at: st.start, duration: 0, ease: 'linear', value: initialYaw }, ...headKeys]);
    // head pitch (低头): only when some head key of this actor sets one, so every other compile stays as it was
    const pitchSrc = collect(scene, 'head', mine, abs).map(({ k, at }): NumKey => ({ at, duration: k.duration, ease: k.ease, value: (k.value as { pitch?: number }).pitch ?? 0 }));
    const pitch = pitchSrc.some((k) => k.value !== 0) ? clipOverlaps<NumKey>([{ at: st.start, duration: 0, ease: 'linear', value: 0 }, ...pitchSrc]) : undefined;
    const bodyYaw = clipOverlaps(collect(scene, 'body', mine, abs).map(({ k, at }): NumKey => ({ at, duration: k.duration, ease: k.ease, value: yawFor(w, k.value, at) })));
    const yawAt = (t: number) => sampleKeys(yaw, t, initialYaw, (k) => k.value, lerp);
    yawFns.set(w.castId, yawAt);

    const gaze = clipOverlaps<GazeKey>([
      { at: st.start, duration: 0, ease: 'linear', w: 0, dir: 0, x: 0, y: 0 },
      ...collect(scene, 'gaze', mine, abs).map(({ k, at }): GazeKey => {
        const base = { at, duration: k.duration, ease: k.ease };
        const v = k.value;
        if ('x' in v) return { ...base, w: 0, dir: 0, x: v.x, y: v.y };
        const self = placeAt(w, at);
        const partner = nearestPartner(w, at);
        // Absolute direction 0 = the lens: evaluate subtracts the head's own turn, so eyes can meet the camera while the head faces a partner.
        if (v.target === 'camera') return { ...base, w: 1, dir: 0, x: 0, y: 0 };
        if (v.target === 'down') return { ...base, w: 0, dir: 0, x: 0, y: -0.7 };
        if (v.target === 'away') return { ...base, w: 0, dir: 0, x: partner ? -Math.sign(placeAt(partner, at).headCenter.x - self.headCenter.x) * 0.8 : 0.8, y: 0.1 };
        const other = works.find((o) => o.castId === v.target && o !== w);
        if (!other) {
          warnings.push(`scene ${scene.id}: ${w.castId} looks at unknown/absent "${v.target}" (ignored)`);
          return { ...base, w: 0, dir: 0, x: 0, y: 0 };
        }
        const oc = placeAt(other, at).headCenter;
        const g = desiredGaze(self.headCenter, oc, self.headUnit);
        return { ...base, w: 1, dir: desiredYaw(self.headCenter, oc, self.headUnit), x: 0, y: clamp(g.y, -0.5, 0.5) };
      }),
    ]);

    // motions ---------------------------------------------------------------------------------------------
    const emotionAt = (t: number): string => {
      const i = st.beats.findIndex((b) => t >= b.start - 1e-6 && t < b.end - 1e-6);
      return (i >= 0 ? list[i]!.emotion : undefined) ?? 'neutral';
    };
    /** Resolve a wanted name against ONE model: the exact motion, another variant of its family, else the closest family the model has. */
    const resolveMotion = (modelId: string, name: string, wantYaw: number, emotion = 'neutral', salt = ''): { ev: MotionEvent; mapped: boolean } | null => {
      const entry = ctx.models[modelId];
      const cal = calOf(modelId);
      if (!entry) return null;
      const exact = entry.motions.find((m) => m.name === name);
      let motion = exact;
      let nominal = exact ? nominalScreenYaw(exact.stats?.angleX?.mean ?? null, cal.headSign) : 0;
      let mapped = false;
      if (!motion) {
        let variants = variantsOfFamily(entry.motions, familyOfName(name));
        if (variants.length === 0) {
          const fam = mapMotionFamily(entry.motions, name, emotion, `${w.castId}:${salt}`);
          variants = fam ? variantsOfFamily(entry.motions, fam) : [];
          mapped = variants.length > 0;
        }
        const pick = chooseMotionVariant(variants, wantYaw, cal.headSign);
        motion = pick ? entry.motions.find((m) => m.name === pick.name) : undefined;
        nominal = pick?.nominalYaw ?? 0;
      }
      if (!motion) return null;
      return { ev: { at: 0, name: motion.name, loop: isLoopFamily(motion.family), nominalYaw: nominal, length: motion.stats?.duration ?? 3 }, mapped };
    };
    /** The looping idle of the model the actor wears at `t` (`idle01`, or `idle_01` for live-mode models); null only for a model without any idle. */
    const idleAt = (t: number): MotionEvent | null => {
      const model = modelAt(w, t);
      const fam = idleFamilyOf(ctx.models[model]?.motions ?? []);
      const r = fam ? resolveMotion(model, fam, yawAt(t)) : null;
      return r ? { ...r.ev, at: t } : null;
    };

    const explicit: MotionEvent[] = [];
    const first = idleAt(st.start);
    if (first) explicit.push(first);
    else warnings.push(`scene ${scene.id}: ${w.castId} (${w.initialModelId}) has no idle motion`);
    for (const m of w.models) {
      const ev = idleAt(m.at);
      if (ev) explicit.push(ev);
    }
    const motionKeys = collect(scene, 'motion', mine, abs);
    for (const { k, at } of motionKeys) {
      const model = modelAt(w, at);
      const r = resolveMotion(model, k.value.name, yawAt(at), emotionAt(at), k.value.name);
      if (!r) {
        warnings.push(`scene ${scene.id}: ${w.castId} (${model}) has no motion "${k.value.name}" (dropped)`);
        continue;
      }
      if (r.mapped) warnings.push(`scene ${scene.id}: ${w.castId} (${model}) has no motion "${k.value.name}" (mapped to ${r.ev.name})`);
      explicit.push({ ...r.ev, at });
    }
    // Rule director: the speaker changes pose every `gestureEvery` lines, preferring families that fit the beat's emotion.
    const speaks = list
      .map((b, i) => ({ b, i, bt: st.beats[i]! }))
      .filter((x) => TEXT_KINDS.includes(x.b.kind) && (x.b.speakerId === w.castId || x.b.coSpeakers.includes(w.castId)));
    {
      let n = 0;
      let lastFamily = '';
      for (const { b, i, bt } of speaks) {
        const ps = st.styles[i]!.values.performance;
        if (!ps.ruleDirector) continue;
        n++;
        if (n % ps.gestureEvery !== 0 || motionKeys.some((m) => m.at >= bt.start - 1e-6 && m.at < bt.end)) continue;
        const have = new Set((ctx.models[modelAt(w, bt.start)]?.motions ?? []).map((m) => m.family));
        const cands = (EMOTION_GESTURE[b.emotion ?? 'neutral'] ?? EMOTION_GESTURE.neutral!).filter((f) => have.has(f) && f !== lastFamily);
        const fam = cands[(n >> 1) % Math.max(1, cands.length)];
        const r = fam ? resolveMotion(modelAt(w, bt.start), fam, yawAt(bt.start)) : null;
        if (r && fam) {
          lastFamily = fam;
          explicit.push({ ...r.ev, at: bt.start + 0.15 });
          ruleKeys.push({ channel: 'motion', beatId: b.id, offset: 0.15, at: bt.start + 0.15, duration: 0, value: { name: fam } });
        }
      }
    }
    // Rule director: bystanders are not statues. While somebody else speaks (or the shot is a silent reaction), an actor that has
    // been still for `listenerReactGap` seconds makes a small reaction (nod, glance, shy smile ...) chosen from the line's emotion.
    // Hand-made / AI motion keys inside the line win; musicians (live-mode) keep playing; no AI call is involved and nothing is
    // written into the project.
    {
      explicit.sort((a, b) => a.at - b.at);
      let lastFamily = '';
      let rot = hashStr(w.castId);
      list.forEach((b, i) => {
        const ps = st.styles[i]!.values.performance;
        const bt = st.beats[i]!;
        if (!ps.ruleDirector || !ps.listenerReact || ps.listenerReactGap <= 0) return;
        if (EMPTY_KINDS.includes(b.kind) || b.speakerId === w.castId || b.coSpeakers.includes(w.castId)) return;
        if (!presentAt(w, bt.start) || bt.end - bt.start < 1) return;
        if (motionKeys.some((m) => m.at >= bt.start - 1e-6 && m.at < bt.end)) return;
        const gap = ps.listenerReactGap;
        // a different moment for each bystander, so nobody reacts in unison
        const jitter = (hashStr(`${w.castId}:${i}`) % 5) * 0.25;
        for (let at = bt.start + Math.max(0.6, ps.listenerTurnDelay + 0.3) + jitter; at < bt.end - 1; at += gap) {
          const model = modelAt(w, at);
          const mo = ctx.models[model]?.motions ?? [];
          if (isLiveSet(mo) || !presentAt(w, at)) break;
          const lastShot = explicit.filter((e) => !e.loop && e.at <= at).at(-1);
          const nextEv = explicit.find((e) => e.at > at);
          if ((lastShot && at - lastShot.at < gap) || (nextEv && nextEv.at - at < 1.2)) continue;
          const fam = pickReaction(mo, b.emotion ?? 'neutral', rot++, lastFamily);
          const r = fam ? resolveMotion(model, fam, yawAt(at)) : null;
          if (r && fam) {
            lastFamily = fam;
            explicit.push({ ...r.ev, at });
            explicit.sort((x, y) => x.at - y.at);
            ruleKeys.push({ channel: 'motion', beatId: b.id, offset: Math.round((at - bt.start) * 1000) / 1000, at, duration: 0, value: { name: fam } });
          }
        }
      });
    }
    explicit.sort((a, b) => a.at - b.at);
    // one-shots fall back to idle when they finish (unless something else starts first)
    let motions: MotionEvent[] = [...explicit];
    explicit.forEach((ev, i) => {
      if (ev.loop) return;
      const end = ev.at + ev.length;
      if ((explicit[i + 1]?.at ?? Infinity) > end) {
        const back = idleAt(end);
        if (back) motions.push(back);
      }
    });
    motions.sort((a, b) => a.at - b.at);
    // a big change of facing swaps the idle variant so the residual stays small
    for (const yk of yaw) {
      const te = yk.at + yk.duration;
      const cur = lastBefore(motions, te);
      if (!cur || !cur.loop || yk.duration === 0 || !isIdleName(cur.name)) continue;
      const want = yawAt(te);
      if (Math.abs(want - cur.nominalYaw) <= RESELECT_YAW_GAP) continue;
      const alt = idleAt(te);
      if (alt && alt.name !== cur.name) {
        const at = yk.at + yk.duration * 0.35;
        motions = motions.filter((m) => m.at !== at);
        motions.push({ ...alt, at });
        motions.sort((a, b) => a.at - b.at);
      }
    }

    // expressions -----------------------------------------------------------------------------------------
    const exprKeys = collect(scene, 'expression', mine, abs);
    const expressions: ExprEvent[] = [];
    for (const { k, at } of exprKeys) {
      const have = ctx.models[modelAt(w, at)]?.expressions ?? [];
      if (k.value.name !== null && !have.includes(k.value.name)) {
        const near = mapExpressionName(have, k.value.name, emotionAt(at), EMOTION_EXPR);
        warnings.push(`scene ${scene.id}: ${w.castId} (${modelAt(w, at)}) has no expression "${k.value.name}" (${near ? `mapped to ${near}` : 'dropped'})`);
        if (near) expressions.push({ at, name: near });
        continue;
      }
      expressions.push({ at, name: k.value.name });
    }
    // Rule director: a new expression at the start of each line, from the beat's emotion tag.
    {
      let n = 0;
      for (const { b, i, bt } of speaks) {
        const ps = st.styles[i]!.values.performance;
        if (!ps.ruleDirector || !ps.exprAtLineStart) continue;
        n++;
        if (exprKeys.some((e) => e.at >= bt.start - 1e-6 && e.at < bt.end)) continue;
        const have = ctx.models[modelAt(w, bt.start)]?.expressions ?? [];
        const cands = (EMOTION_EXPR[b.emotion ?? 'neutral'] ?? EMOTION_EXPR.neutral!).filter((e) => have.includes(e));
        const name = cands[n % Math.max(1, cands.length)];
        const prev = lastBefore(expressions, bt.start)?.name ?? null;
        if (name && name !== prev) {
          expressions.push({ at: bt.start, name });
          ruleKeys.push({ channel: 'expression', beatId: b.id, offset: 0, at: bt.start, duration: 0, value: { name } });
          expressions.sort((x, y) => x.at - y.at);
        }
      }
    }
    for (const m of w.models) {
      const cur = lastBefore(expressions, m.at);
      if (cur?.name) expressions.push({ at: m.at, name: (ctx.models[m.modelId]?.expressions ?? []).includes(cur.name) ? cur.name : null });
    }
    expressions.sort((a, b) => a.at - b.at);

    return {
      castId: w.castId, initialModelId: w.initialModelId, initialPos: w.initialPos, models: w.models, position: w.position, opacity,
      presence: clipOverlaps(presence), slide: clipOverlaps(slide), shiftX: [], shiftY: [], shiftS: [], shiftZ: [], shotVisible: [], yaw, ...(pitch ? { pitch } : {}), bodyYaw, gaze, motions, expressions, ruleKeys,
    };
  });

  // ---- beats, camera, depth of field ----------------------------------------------------------------------
  const H = Math.min(bg.height, bg.width / (16 / 9));
  const frameActor = (w: Work, t: number): FramingActor => {
    const p = placeAt(w, t);
    // The facing a moment after the cut (head turns lag the cut slightly) decides on which side the look-room goes.
    const yaw = yawFns.get(w.castId)?.(t + FRAMING_YAW_LOOKAHEAD) ?? 0;
    // Travel: the solver sees the final arrangement (heads of one size, eyes on one line), the same boxes the renderer will draw.
    const a = travel ? arr[w.castId] : undefined;
    return a ? { id: w.castId, head: arrangeRect(p.headBox, p.headCenter, a), body: arrangeRect(p.bodyBox, p.headCenter, a), yaw } : { id: w.castId, head: p.headBox, body: p.bodyBox, yaw };
  };
  const inScene = new Set(works.map((w) => w.castId));
  const beats: CompiledBeat[] = [];
  const camera: CameraKey[] = [];
  const shakes: CompiledScene['shakes'] = [];
  const dof: NumKey[] = [];
  /** Travel scenes: mean visible head height (world) of the shot's people, eased with the camera (the head share of the frame sets the blur). */
  const focusHead: NumKey[] = [];
  /** Travel scenes: the author's depth-of-field level of the shot, -1 = automatic. */
  const dofManual: NumKey[] = [];
  const focus: CompiledScene['focus'] = [];
  const hiddenDialog: Interval[] = [];

  // The scene's reference camera centre: the group solution of the people on stage at the start of the content (the background is centred there).
  let travelRef: Pt = { x: bg.width / 2, y: bg.height / 2 };
  if (travel && works.length > 0) {
    const here = works.filter((w) => presentAt(w, st.contentStart + 1e-6));
    const fa = (here.length > 0 ? here : works).map((w) => frameActor(w, st.contentStart));
    const g = solveTravelShot({ type: 'group', focus: fa, all: fa, bg, framing, style: sceneV, aspect: asp }).pose;
    travelRef = { x: g.x, y: g.y };
  }
  const poseFull = (type: ShotType, ids: string[], t: number, v: StyleValues, insertBox?: InsertBox, move?: CameraMove) => {
    const all = works.filter((w) => presentAt(w, t + 1e-6) || ids.includes(w.castId)).map((w) => frameActor(w, t));
    const chosen = ids.map((id) => all.find((a) => a.id === id) ?? (works.some((w) => w.castId === id) ? frameActor(works.find((w) => w.castId === id)!, t) : undefined)).filter((a): a is FramingActor => !!a);
    if (travel) {
      const { pose, shifts } = solveTravelShot({ type, focus: chosen.length > 0 ? chosen : all, all, bg, framing, style: v, aspect: asp, ref: travelRef, ...(insertBox ? { insertBox } : {}) });
      // Background endpoints use the classic shot on the original blocking. Camera motion and compact-stage
      // geometry must not change the settled crop.
      const classicAll = all.map((a) => {
        const p = placeAtClassic(works.find((w) => w.castId === a.id)!, t);
        return { ...a, head: p.headBox, body: p.bodyBox };
      });
      const classicFocus = chosen.map((a) => classicAll.find((c) => c.id === a.id)!);
      const classic = solveShotDetailed({ type, focus: classicFocus, all: classicAll, bg, framing, style: v, aspect: asp, ...(insertBox ? { insertBox } : {}), ...(move ? { move } : {}) }).pose;
      return { pose: { ...pose, bgZoom: classic.bgZoom, bgX: classic.x, bgY: classic.y }, shifts, hide: [] as string[], moveLimits: undefined as { moveZoom: number; panShare: number } | undefined };
    }
    const { pose, edgeCut, shifts, moveLimits } = solveShotDetailed({ type, focus: chosen.length > 0 ? chosen : all, all, bg, framing, style: v, aspect: asp, ...(insertBox ? { insertBox } : {}), ...(move ? { move } : {}) });
    // The original never shows half of another person at the edge: in a single-person shot an unavoidable intruder is hidden for the shot.
    const hide = chosen.length === 1 ? edgeCut : [];
    if (edgeCut.length > 0) warnings.push(`scene ${scene.id}: edge-cut at ${t.toFixed(2)}s, ${edgeCut.join(',')} is cut by the frame edge (${type})${hide.length > 0 ? ', hidden for this shot' : ''}`);
    return { pose, shifts, hide, moveLimits };
  };
  const poseOf = (type: ShotType, ids: string[], t: number, v: StyleValues): CameraPose => poseFull(type, ids, t, v).pose;
  /** Per-actor screen arrangement keys of a shot (multi-person layout, bystanders hidden by the edge rule). */
  const shiftKeys = new Map<string, { x: NumKey[]; y: NumKey[]; s: NumKey[]; z: NumKey[]; vis: NumKey[] }>(works.map((w) => [w.castId, { x: [], y: [], s: [], z: [], vis: [] }]));
  /** Travel moves: visibility changes that happen during a camera move (resolved against the real picture once the scene is assembled). */
  const pendingVis: Array<{ id: string; index: number; at: number; len: number; from: number; to: number }> = [];
  const pushShift = (at: number, duration: number, ease: NumKey['ease'], shifts: Record<string, { dx: number; dy: number; s: number; z?: number }>, hide: string[], visDuration = 0, visEase: NumKey['ease'] = 'linear') => {
    for (const [id, k] of shiftKeys) {
      const sh = shifts[id] ?? { dx: 0, dy: 0, s: 1 };
      k.x.push({ at, duration, ease, value: sh.dx });
      k.y.push({ at, duration, ease, value: sh.dy });
      k.s.push({ at, duration, ease, value: sh.s });
      k.z.push({ at, duration: 0, ease: 'linear', value: ('z' in sh ? sh.z : 0) ?? 0 });
      k.vis.push({ at, duration: visDuration, ease: visEase, value: hide.includes(id) ? 0 : 1 });
    }
  };

  let prevShot: { type: ShotType; ids: string[] } | null = null;
  let prevCamAt = -Infinity;
  let prevMove = 'static';
  let prevTravel: TravelShotInfo | null = null;
  let autoMoveRun = 0;
  let autoMoveEnd = -Infinity;
  let prevKeyAt = -Infinity;
  // manual camera keys, read quietly (collect()/absoluteTime() would repeat the warnings) so a travel segment never runs across one
  const manualCamAt: number[] = travel
    ? scene.tracks
        .filter((t) => t.channel === 'camera' && t.target.kind === 'camera')
        .flatMap((t) =>
          (t.keys as Array<{ at: { beatId: string; offset: number } }>).flatMap((k) => {
            const bi = beatIndex.get(k.at.beatId);
            return bi === undefined ? [] : [st.beats[bi]!.start + k.at.offset];
          }),
        )
    : [];
  const trueEnterAt = (t: number) =>
    works.some((w) => {
      const e = scene.blocking[w.castId]?.enter;
      const bi = e ? beatIndex.get(e.beatId) : undefined;
      return bi !== undefined && Math.abs(st.beats[bi]!.start - t) < 1e-6;
    });
  /** Mean (arranged) head centre of the people in a shot: the point the travel keeps on its screen line. */
  const anchorOf = (ids: string[], t: number, fallback: CameraPose) => {
    const pts = ids.flatMap((id) => {
      const w = works.find((x) => x.castId === id);
      if (!w) return [];
      const h = frameActor(w, t).head;
      return [{ x: h.x + h.w / 2, y: h.y + h.h / 2 }];
    });
    return pts.length === 0 ? { x: fallback.x, y: fallback.y } : { x: pts.reduce((a, p) => a + p.x, 0) / pts.length, y: pts.reduce((a, p) => a + p.y, 0) / pts.length };
  };
  /** The people a shot is about: a group shows everybody on stage, a two-shot the pair, the single sizes (and inserts) the first named person. */
  const shotPeople = (type: ShotType, shotIds: string[], t: number): string[] => {
    if (type === 'establishing') return [];
    if (type === 'group') return [...new Set([...shotIds, ...works.filter((w) => presentAt(w, t + 1e-6)).map((w) => w.castId)])];
    return type === 'two_shot' ? shotIds.slice(0, 2) : shotIds.slice(0, 1);
  };
  type ListBeat = (typeof list)[number];
  /** The shot a beat asks for (type, and the people named, restricted to those in the scene). */
  const shotOf = (beat: ListBeat) => {
    const asked = beat.shot.focus.length > 0 ? beat.shot.focus : beat.speakerId ? [beat.speakerId] : [];
    const ids = asked.filter((id) => inScene.has(id));
    const type = EMPTY_KINDS.includes(beat.kind) && beat.kind === 'establishing' ? ('establishing' as ShotType) : normalizeShotType(beat.shot.type).type;
    return { asked, ids, type };
  };
  /** Does this beat keep the camera of the previous shot (a short line, or the very same framing again)? Pure in its arguments. */
  const holdsShot = (beat: ListBeat, i: number, start: number, v: StyleValues, type: ShotType, ids: string[], prevShot: { type: ShotType; ids: string[] } | null, prevCamAt: number, prevMove: string): boolean => {
    // minimum shot length: a short line keeps the previous camera instead of cutting (unless the author set the shot by hand)
    const entering = works.some((w) => w.away.some(([, b]) => Math.abs(b - start) < 1e-6));
    const userShot = beat.shot.meta.locked || beat.shot.meta.source === 'user';
    const manualTransition = beat.shot.transition !== undefined && (!['ai', 'rule'].includes(beat.shot.meta.source) || beat.shot.meta.locked || beat.shot.meta.lockedFields?.includes('transition'));
    // A generated move/reveal is a proposal: unchanged focus and a wider shot still obey
    // the minimum viewing time. A deliberate cut or a user's choice must remain visible.
    const aiCut = beat.shot.transition === 'cut' && !manualTransition;
    // An AI flow=cut is a suggestion (honoured for a reaction, a rupture, or a change of person into cu / ecu); a user's / locked cut is absolute.
    if (travel && (manualTransition || beat.shot.intent === 'reaction' || beat.shot.intent === 'rupture' || (aiCut && aiCutHonoured(beat.shot.intent, prevShot, { type, ids })))) return false;
    // A closer size, another focus or a camera move is a deliberate choice of the author and is never swallowed.
    const sameFocus = prevShot !== null && prevShot.ids.length === ids.length && prevShot.ids.every((x) => ids.includes(x));
    const closer = prevShot !== null && SHOT_RANK[type] > SHOT_RANK[prevShot.type];
    const held =
      i > 0 && v.rhythm.enforceMinShot && !entering && !userShot && TEXT_KINDS.includes(beat.kind) && beat.cutIn === 'cut' &&
      beat.shot.move === 'static' && sameFocus && !closer &&
      prevShot !== null && prevShot.type !== 'establishing' && start - prevCamAt < v.rhythm.minShotSeconds;
    // the same framing again (e.g. the partner answers in the same two-shot) is no new shot: no cut, no new camera key
    const same = i > 0 && !entering && !userShot && prevShot !== null && prevShot.type === type && prevShot.type !== 'establishing' && beat.cutIn === 'cut' && prevMove === 'static' && beat.shot.move === 'static' &&
      prevShot.ids.length === ids.length && prevShot.ids.every((x) => ids.includes(x)) && beat.kind !== 'establishing' && !held;
    // a continuation of a split line keeps the camera exactly as its head left it, also after the head's push / pull (which `same` would
    // call a new shot); a hand-set shot, a closer size, another focus, a move or a dip all still count as the author's choice
    const head = i > 0 ? list[i - 1] : undefined;
    const continues =
      beat.splitFrom !== undefined && head !== undefined && (head.id === beat.splitFrom || head.splitFrom === beat.splitFrom) &&
      !entering && !userShot && TEXT_KINDS.includes(beat.kind) && beat.cutIn === 'cut' && beat.shot.move === 'static' && sameFocus &&
      prevShot !== null && prevShot.type === type && prevShot.type !== 'establishing';
    return held || same || continues;
  };
  /** Travel, medium shots: speakers of beat i and of the following beats that keep its shot (who is in the conversation of this shot). */
  const heldSpeakers = (i: number, type: ShotType, ids: string[]): string[] => {
    const out = new Set<string>();
    const add = (b: ListBeat) => { if (TEXT_KINDS.includes(b.kind)) { if (b.speakerId) out.add(b.speakerId); for (const c of b.coSpeakers) out.add(c); } };
    add(list[i]!);
    const seg0 = segIndexAt(st.beats[i]!.start);
    const ps = { type, ids };
    const pAt = st.beats[i]!.start;
    const pMv = list[i]!.shot.move;
    for (let j = i + 1; j < list.length; j++) {
      const sj = st.beats[j]!.start;
      if (segIndexAt(sj) !== seg0) break;
      const o = shotOf(list[j]!);
      if (!holdsShot(list[j]!, j, sj, st.styles[j]!.values, o.type, o.ids, ps, pAt, pMv)) break;
      add(list[j]!);
    }
    return [...out];
  };
  /** Travel: seconds from beat i until the next real shot change (beats that keep the camera do not end it), a background change or the scene's end. */
  const spanFrom = (i: number, type: ShotType, ids: string[]): number => {
    const t0 = st.beats[i]!.start;
    const seg0 = segIndexAt(t0);
    const ps = { type, ids };
    const pAt = t0;
    const pMv = list[i]!.shot.move;
    for (let j = i + 1; j < list.length; j++) {
      const sj = st.beats[j]!.start;
      if (segIndexAt(sj) !== seg0) return sj - t0;
      const o = shotOf(list[j]!);
      if (!holdsShot(list[j]!, j, sj, st.styles[j]!.values, o.type, o.ids, ps, pAt, pMv)) return sj - t0;
    }
    return Math.max(0, st.end - t0);
  };
  list.forEach((beat, i) => {
    const bt = st.beats[i]!;
    const v = st.styles[i]!.values;
    const { asked, ids, type: shotType0 } = shotOf(beat);
    if (ids.length < asked.length) warnings.push(`scene ${scene.id} beat ${beat.id}: focus references actors not in the scene (ignored)`);
    if (beat.shot.type === 'wide') warnings.push(`scene ${scene.id} beat ${beat.id}: "wide" is not used by the original (no full-body shots); treated as "group"`);
    let type = shotType0;
    let shotIds = ids;

    const entering = works.some((w) => w.away.some(([, b]) => Math.abs(b - bt.start) < 1e-6));
    const held = holdsShot(beat, i, bt.start, v, type, ids, prevShot, prevCamAt, prevMove);
    if (held && prevShot) {
      type = prevShot.type;
      shotIds = prevShot.ids;
    } else {
      prevShot = { type, ids };
      prevCamAt = bt.start;
      prevMove = beat.shot.move;
    }

    const dur = bt.end - bt.start;
    const dofLevel = beat.shot.dof ?? Math.min(6, v.shots[type].dof + (type !== 'establishing' && lumaAt(bt.start) !== undefined && lumaAt(bt.start)! < v.framing.darkLuma ? v.framing.darkDofBonus : 0));
    const cb: CompiledBeat = {
      id: beat.id, kind: beat.kind, variant: beat.variant, coSpeakers: beat.coSpeakers, shotHeld: held, ui: uiOf(v),
      speakerId: beat.speakerId ?? null, text: beat.text, start: bt.start, end: bt.end, textEnd: bt.textEnd, cps: v.rhythm.textSpeedCps, focus: shotIds,
      shotType: type, dof: dofLevel,
      ...(beat.overflow === 'expand' ? { expand: true as const } : {}),
    };
    beats.push(cb);
    let travelBeat: CompiledBeat['camTravel'] | undefined;
    if (!held) {
      const solved = poseFull(type, shotIds, bt.start, v, beat.shot.insertBox, beat.shot.move);
      const base = solved.pose;
      const { from, to } = cameraMove(base, beat.shot.move, bg, solved.moveLimits ? { ...v.framing, ...solved.moveLimits } : v.framing, ctx.aspect ?? 16 / 9);
      if (travel && (beat.shot.move === 'pan' || beat.shot.move === 'track')) {
        // Explicit shot motion carries the background along from its classic crop as well.
        from.bgX = (base.bgX ?? base.x) + from.x - base.x;
        to.bgX = (base.bgX ?? base.x) + to.x - base.x;
      }
      if (!travel) {
        const reframe = entering && shotIds.length >= 2;
        const gs = v.performance.glideSeconds;
        const wantsGlide = ((beat.shot.transition === 'travel' ? undefined : beat.shot.transition) ?? (gs > 0 ? 'glide' : 'cut')) === 'glide';
        const glideLen = reframe ? v.performance.reframeSeconds : wantsGlide ? (gs > 0 ? gs : DEFAULT_GLIDE) : 0;
        const glide = i === 0 || beat.cutIn !== 'cut' ? 0 : Math.min(glideLen, dur / 2);
        camera.push({ at: i === 0 ? st.start : bt.start, duration: glide, ease: reframe ? 'outCubic' : 'inOutSine', pose: from });
        // hand offsets of single people (Beat.shot.offsets) ride on top of the automatic arrangement
        const shifts = { ...solved.shifts };
        for (const [id, off] of Object.entries(beat.shot.offsets ?? {})) {
          const cur = shifts[id] ?? { dx: 0, dy: 0, s: 1 };
          shifts[id] = { dx: cur.dx + off.x * H, dy: cur.dy + off.y * H, s: cur.s };
        }
        pushShift(i === 0 ? st.start : bt.start, glide, reframe ? 'outCubic' : 'inOutSine', shifts, solved.hide);
        if (beat.shot.move !== 'static' && beat.shot.move !== 'shake') {
          camera.push({ at: bt.start + glide, duration: Math.max(0, dur - glide), ease: 'inOutSine', pose: to });
        }
        if (beat.shot.move === 'shake') shakes.push({ start: bt.start, end: bt.end, amp: v.framing.shakeAmplitude * H });
        dof.push({ at: i === 0 ? st.start : bt.start, duration: i === 0 ? 0 : Math.min(glide, 0.4), ease: 'inOutSine', value: dofLevel });
        focus.push({ at: i === 0 ? st.start : bt.start, ids: shotIds });
      } else {
        const people = shotPeople(type, shotIds, bt.start);
        const F = anchorOf(people, bt.start, from);
        const onStage = works.filter((w) => presentAt(w, bt.start + 1e-6)).sort((a, b) => posAt(a, bt.start).slot - posAt(b, bt.start).slot).map((w) => w.castId);
        const ranks = people.map((id) => onStage.indexOf(id));
        const curInfo: TravelShotInfo = { type, ids: people, bgSeg: segIndexAt(bt.start), pose: from, anchor: F, ...(ranks.every((r) => r >= 0) ? { ranks } : {}), speaker: beat.speakerId ?? null };
        const isEmptyBeat = EMPTY_KINDS.includes(beat.kind);
        const inInsert = insertRuns.some(([x, y]) => bt.start >= x - 1e-9 && bt.start < y - 1e-9);
        const span = spanFrom(i, type, shotIds);
        const afterEmpty = i === 0 || EMPTY_KINDS.includes(list[i - 1]!.kind) || segIndexAt(bt.start) !== segIndexAt(bt.start - 1e-3);
        let dec = decideTravel({
          cutIn: beat.cutIn, move: beat.shot.move, userTransition: beat.shot.transition, intent: beat.shot.intent ?? (afterEmpty ? 'reveal' : undefined),
          transitionSource: !['ai', 'rule'].includes(beat.shot.meta.source) || beat.shot.meta.locked || beat.shot.meta.lockedFields?.includes('transition') ? 'user' : 'ai',
          consecutiveMoves: bt.start - autoMoveEnd >= Math.max(2, v.rhythm.minShotSeconds) ? 0 : autoMoveRun, prev: prevTravel, cur: curInfo,
          afterEmpty, trueEnter: trueEnterAt(bt.start), glideSeconds: Math.min(v.performance.glideSeconds > 0 ? v.performance.glideSeconds : DEFAULT_GLIDE, dur / 2), span, pitch: pitchWorld, aspect: asp, H, tv,
          manualIn: (seconds) => manualCamAt.some((m) => m >= prevKeyAt - 1e-9 && m < bt.start + seconds),
        });
        // empty shots and cut-away (insert) segments never travel
        if (isEmptyBeat || inInsert) dec = { kind: 'cut', reason: '硬切：空镜/插入' };
        else if ((dec.kind === 'settle' || dec.kind === 'reframe') && manualCamAt.some((m) => m >= prevKeyAt - 1e-9 && m < bt.start + (dec as { seconds: number }).seconds)) dec = { kind: 'cut', warn: '运镜段内有手动相机关键帧，已改为硬切', reason: '硬切：运镜段内有手动相机关键帧' };
        if (dec.kind === 'cut' && dec.warn) warnings.push(`scene ${scene.id} beat ${beat.id}: ${dec.warn}`);
        const at0 = i === 0 ? st.start : bt.start;
        // Compose the shot arrangement with the scene arrangement; user offsets remain additive.
        const shifts: Record<string, { dx: number; dy: number; s: number }> = {};
        for (const w of works) {
          const a = arr[w.castId] ?? { dy: 0, s: 1 };
          const off = beat.shot.offsets?.[w.castId];
          const shot = solved.shifts[w.castId] ?? { dx: 0, dy: 0, s: 1 };
          shifts[w.castId] = { dx: shot.dx + (off?.x ?? 0) * H, dy: a.dy * shot.s + shot.dy + (off?.y ?? 0) * H, s: a.s * shot.s };
        }
        let len = 0;
        let easeName: EaseName = 'inOutSine';
        switch (dec.kind) {
          case 'cut':
            camera.push({ at: at0, duration: 0, ease: 'inOutSine', pose: from });
            break;
          case 'glide': {
            const gs = v.performance.glideSeconds;
            len = i === 0 || beat.cutIn !== 'cut' ? 0 : Math.min(gs > 0 ? gs : DEFAULT_GLIDE, dur / 2);
            camera.push({ at: at0, duration: len, ease: 'inOutSine', pose: from });
            break;
          }
          case 'reframe':
            len = dec.seconds;
            easeName = dec.ease;
            camera.push({ at: bt.start, duration: len, ease: easeName, pose: from, travel: { kind: 'reframe' } });
            break;
          case 'distance':
          case 'lateral':
          case 'regroup':
            len = dec.seconds;
            easeName = dec.ease;
            // a sideways move between equal sizes lands a little closer, and the following lines keep that camera
            camera.push({ at: bt.start, duration: len, ease: easeName, pose: dec.land ? pushAbout(from, F, dec.land) : from, travel: { kind: dec.kind, anchor: F } });
            break;
          case 'settle': {
            len = dec.seconds;
            easeName = dec.ease;
            const pre = settleStart(from, F, tv.settleZoom);
            camera.push({ at: at0, duration: 0, ease: 'linear', pose: pre });
            camera.push({ at: bt.start, duration: len, ease: easeName, pose: from, travel: { kind: 'settle', anchor: F } });
            break;
          }
        }
        // settle: people stand in the final arrangement from the start; the others tween the arrangement together with the camera
        // Tight shots (mcu and closer) show only their people: the others fade out as the camera starts, and fade in again when it widens
        // (the original's characterOut / characterIn, 0.2 s, issued with the move). Medium shots and two-shots keep their speakers (v7: the closer stage would crowd a two-shot with bystanders); groups keep everybody.
        let hide = (type === 'mcu' || type === 'cu' || type === 'ecu') && tv.neighbours === 'original' ? works.filter((w) => !people.includes(w.castId)).map((w) => w.castId) : [];
        if ((type === 'ms' || type === 'two_shot') && tv.neighbours === 'original') {
          // Keep the current conversation only. Retaining the previous pair crowds the compact stage with three people.
          const keep = new Set<string>([...people, ...heldSpeakers(i, type, shotIds)]);
          // A two-shot of people who do not stand next to each other keeps the ones between them in frame: the middle is never empty.
          if (type === 'two_shot' && people.length === 2) {
            const sx = people.map((id) => posAt(works.find((w) => w.castId === id)!, bt.start).slot);
            const [lo, hi] = [Math.min(...sx), Math.max(...sx)];
            for (const w of works) if (!keep.has(w.castId) && presentAt(w, bt.start)) { const sl = posAt(w, bt.start).slot; if (sl > lo + 1e-6 && sl < hi - 1e-6) keep.add(w.castId); }
          }
          hide = works.filter((w) => !keep.has(w.castId)).map((w) => w.castId);
        }
        const fades = dec.kind === 'distance' || dec.kind === 'lateral' || dec.kind === 'regroup' || dec.kind === 'reframe';
        const visBefore = new Map([...shiftKeys].map(([id, k]) => [id, k.vis.at(-1)?.value ?? 1]));
        pushShift(at0, dec.kind === 'settle' ? 0 : len, easeName, shifts, hide);
        // A move lets people leave / enter by the camera carrying them out of / into the frame: when the visibility switches is decided below.
        if (fades && len > 0 && i > 0) {
          for (const [id, k] of shiftKeys) {
            const to = hide.includes(id) ? 0 : 1;
            if (visBefore.get(id) !== to) pendingVis.push({ id, index: k.vis.length - 1, at: at0, len, from: visBefore.get(id) ?? 1, to });
          }
        }
        if (beat.shot.move !== 'static' && beat.shot.move !== 'shake') {
          camera.push({ at: bt.start + len, duration: Math.max(0, dur - len), ease: 'inOutSine', pose: to });
        }
        if (beat.shot.move === 'shake') shakes.push({ start: bt.start, end: bt.end, amp: v.framing.shakeAmplitude * H });
        // an empty shot with its own push_in / pull_out / shake keeps that move (a drift key at the same time would clip it to a jump)
        if (isEmptyBeat && beat.shot.move === 'static' && tv.driftShare > 0 && bt.end - at0 >= tv.driftMinSeconds) {
          const sign = 1; // Stable screen direction, independent of scene/beat identifiers.
          camera.push({ at: at0, duration: bt.end - at0, ease: 'inOutSine', pose: driftEnd(from, sign, tv.driftShare, tv.driftZoom, bg, asp), travel: { kind: 'drift' } });
          travelBeat = { kind: 'drift', seconds: bt.end - at0, reason: '空镜慢漂' };
        } else {
          travelBeat = { kind: dec.kind, seconds: len, ...(len > 0 && dec.kind !== 'cut' && dec.kind !== 'glide' ? { ease: easeName } : {}), reason: dec.reason };
        }
        const moves = dec.kind === 'distance' || dec.kind === 'lateral' || dec.kind === 'regroup' || dec.kind === 'reframe';
        const dofSeconds = dec.kind === 'glide' ? Math.min(len, 0.4) : moves ? len : 0;
        dof.push({ at: at0, duration: i === 0 ? 0 : dofSeconds, ease: moves ? easeName : 'inOutSine', value: dofLevel });
        focus.push({ at: at0, ids: people });
        const heads = people.flatMap((id) => {
          const w = works.find((x) => x.castId === id);
          return w ? [visibleHead(frameActor(w, bt.start), v.framing).h] : [];
        });
        focusHead.push({ at: at0, duration: moves && i > 0 ? len : 0, ease: moves ? easeName : 'linear', value: heads.length > 0 ? heads.reduce((q, h) => q + h, 0) / heads.length : 0 });
        dofManual.push({ at: at0, duration: 0, ease: 'linear', value: beat.shot.dof ?? -1 });
        // the camera the next shot change starts from (a landing push or a following camera move included)
        const manualTransition = beat.shot.transition !== undefined && (!['ai', 'rule'].includes(beat.shot.meta.source) || beat.shot.meta.locked || beat.shot.meta.lockedFields?.includes('transition'));
        const autoMotion = !manualTransition && len > 0 && dec.kind !== 'glide';
        if (autoMotion) {
          autoMoveRun = bt.start - autoMoveEnd >= Math.max(2, v.rhythm.minShotSeconds) ? 1 : autoMoveRun + 1;
          autoMoveEnd = bt.start + len;
        } else if (dec.kind === 'cut') autoMoveRun = 0;
        prevTravel = { ...curInfo, pose: camera.at(-1)!.pose };
        prevKeyAt = bt.start;
      }
    }

    if (travel && travelBeat) cb.camTravel = travelBeat;

    // dialogue area visibility and the dip between two shots
    if (EMPTY_KINDS.includes(beat.kind) || beat.kind === 'silent') hiddenDialog.push([i === 0 ? st.start : bt.start, bt.end]);
    if (i > 0 && beat.cutIn !== 'cut') {
      // dip_white (into / out of a memory, a strong light) is a longer, softer dip through white with its own fixed timing
      const white = beat.cutIn === 'dip_white';
      const d = white ? { dipOut: DIP_WHITE.out, dipHold: DIP_WHITE.hold, dipIn: DIP_WHITE.in } : v.transitions;
      const mid = bt.start - d.dipHold / 2;
      const color = white ? 'white' : 'black';
      fadeOut.push(
        { at: mid - d.dipOut, duration: d.dipOut, ease: 'inOutSine', alpha: 1, color },
        { at: mid + d.dipHold, duration: d.dipIn, ease: 'inOutSine', alpha: 0, color },
      );
      if (!beat.cutInKeepDialog) hiddenDialog.push([mid - d.dipOut, mid + d.dipHold + d.dipIn]);
    }
  });
  if (st.timing.black) {
    hiddenDialog.push([st.start, st.contentStart]);
    if (st.timing.fadeIn > 0) {
      fadeOut.push({ at: st.contentStart, duration: 0, ease: 'linear', alpha: 1, color: 'black' }, { at: st.contentStart, duration: st.timing.fadeIn, ease: 'linear', alpha: 0, color: 'black' });
    }
  }
  // background switches that dip through black ride on the project's fade channel (the picture changes at the darkest moment)
  bgSegments.forEach((sg, i) => {
    if (i === 0 || (sg.transition !== 'dip_black' && sg.transition !== 'dip_white') || sg.transitionSeconds <= 0) return;
    const color = sg.transition === 'dip_white' ? 'white' : 'black';
    const half = Math.min(sg.transitionSeconds / 2, Math.max(0, sg.start - st.start));
    if (half <= 0) return;
    fadeOut.push({ at: sg.start - half, duration: half, ease: 'inOutSine', alpha: 1, color }, { at: sg.start, duration: sg.transitionSeconds / 2, ease: 'inOutSine', alpha: 0, color });
    hiddenDialog.push([sg.start - half, sg.start + sg.transitionSeconds / 2]);
  });
  if (list.length === 0) camera.push({ at: st.start, duration: 0, ease: 'linear', pose: poseOf('establishing', [], st.start, sceneV) });

  for (const { k, at } of collect(scene, 'camera', (t) => t.target.kind === 'camera', abs)) {
    const pose = 'manual' in k.value ? k.value.manual : poseOf(normalizeShotType(k.value.shot).type, k.value.focus.filter((id) => inScene.has(id)), at, sceneV);
    camera.push({ at, duration: k.duration, ease: k.ease, pose });
  }

  const loc = scene.location;
  const location = loc?.show && loc.text ? { text: loc.text, start: st.contentStart + st.timing.fadeIn + sceneV.location.delay } : null;

  const buildActors = () =>
    actors.map((a) => {
      const k = shiftKeys.get(a.castId)!;
      return { ...a, shiftX: clipOverlaps(k.x), shiftY: clipOverlaps(k.y), shiftS: clipOverlaps(k.s), shiftZ: clipOverlaps(k.z), shotVisible: clipOverlaps(k.vis) };
    });
  /**
   * Travel: people who leave or enter the picture during a camera move do it with the camera, not with a cross-fade (two half-transparent
   * copies of a person look like a ghost). The visibility switches while the person is fully outside the frame; only a person who is inside the
   * frame at the start of the move and must still appear / disappear gets a quick fade (at most TRAVEL_FADE_MAX seconds, at the start).
   */
  const timeVisibility = (scene0: CompiledScene, pending: typeof pendingVis) => {
    const fake = { duration: scene0.end + 1, scenes: [scene0], fade: [], fx: { anxiety: [], glow: [], roll: [] }, bgm: [] } as unknown as CompiledProject;
    const half = asp / 2;
    const Hs = viewWorldHeight(bg);
    const N = 24;
    const fadeLen = Math.min(tv.fadeSeconds, TRAVEL_FADE_MAX);
    const onScreen = (id: string, t: number): boolean => {
      const rs = evaluate(fake, t);
      const a = rs.actors.find((x) => x.castId === id);
      if (!a) return false;
      const pl = placeActor(calOf(a.modelId), { slot: a.slot, depth: a.depth }, bg);
      const hc = pl.headCenter;
      const b = pl.bodyBox;
      const x = hc.x + (b.x - hc.x) * a.shiftS + a.shiftX + a.slideH * Hs;
      const w = b.w * a.shiftS;
      const Hv = Hs / rs.camera.zoom;
      const left = (x - rs.camera.x) / Hv;
      const right = (x + w - rs.camera.x) / Hv;
      return right > -half && left < half;
    };
    for (const pv of pending) {
      const keys = shiftKeys.get(pv.id)!.vis;
      const times = Array.from({ length: N + 1 }, (_, j) => pv.at + (pv.len * j) / N);
      const on = times.map((t) => onScreen(pv.id, t));
      let key: NumKey;
      if (pv.to === 0) {
        // leaving: switch once the person is out of the frame for good
        let j = N + 1;
        while (j > 0 && !on[j - 1]) j--;
        key = j <= N ? { at: times[j]!, duration: 0, ease: 'linear', value: 0 } : { at: pv.at, duration: Math.min(fadeLen, pv.len), ease: 'linear', value: 0 };
      } else {
        // entering: switch just before the person comes into the frame
        const j = on.indexOf(true);
        key = j < 0 ? { at: pv.at, duration: 0, ease: 'linear', value: 1 } : j === 0 ? { at: pv.at, duration: Math.min(fadeLen, pv.len), ease: 'linear', value: 1 } : { at: times[j - 1]!, duration: 0, ease: 'linear', value: 1 };
      }
      keys[pv.index] = key;
    }
  };
  const out: CompiledScene = {
    index, id: scene.id, title: scene.title, start: st.start, contentStart: st.contentStart, end: st.end,
    bgAssetId: scene.background.assetId, framing, bg, bgSegments, transitionIn: { kind: scene.transitionIn.kind, duration: scene.transitionIn.duration },
    timing: st.timing, ui: uiOf(sceneV), hiddenDialog, location,
    actors: buildActors(), beats, camera: clipOverlaps(camera), shakes, dof: clipOverlaps(dof), focus,
    ...(travel && stage
      ? {
          cameraSystem: 'travel' as const,
          travel: {
            version: 12 as const, aspect: asp, stage, bg: { sigma: tv.parallaxSigma, scale: tv.bgScale, zoomMax: tv.bgZoomMax, ref: travelRef },
            focusHead: clipOverlaps(focusHead), dofManual: clipOverlaps(dofManual), dof: { mode: tv.dofMode, aperture: tv.aperture, depthSpan: tv.depthSpan },
          },
        }
      : {}),
  };
  if (travel && stage && pendingVis.length > 0) {
    timeVisibility(out, pendingVis);
    out.actors = buildActors();
  }
  return out;
}
