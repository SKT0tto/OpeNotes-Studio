/**
 * compile: Project (intent level) -> CompiledProject (absolute time, real resources, solved camera poses).
 * Pure: the same project + context always gives the same result. It never invents resources: an unknown motion
 * is dropped with a warning (callers/validators decide how to repair).
 */
import type { Calibration } from '../schema/calibration';
import type { Channel, Project, Scene, Track } from '../schema/project';
import { chooseMotionVariant, desiredGaze, desiredYaw, nominalScreenYaw, variantsOfFamily, yawTowardsCamera } from '../staging/facing';
import { cameraMove, normalizeShotType, solveShotDetailed, type FramingActor, type InsertBox, type ShotType } from '../staging/framing';
import { placeActor, type Placement } from '../staging/ground';
import { defaultGround, type BgInfo, type CameraPose } from '../staging/world';
import { clamp, lerp } from './easing';
import { clipOverlaps, lastBefore, sampleKeys } from './sample';
import type { StyleValues } from '../style/ournotes';
import { EMPTY_KINDS, TEXT_KINDS, sceneTimes, type SceneTime } from './time';
import type {
  CameraKey, CompileContext, CompiledActor, CompiledBeat, CompiledProject, CompiledScene, ExprEvent, FadeKey, GazeKey, ModelKey, MotionEvent, NumKey, PosKey, RuleKey, UiStyle,
} from './types';

/** Glide length used when a beat asks for `transition: 'glide'` while the style's glideSeconds is 0. */
const DEFAULT_GLIDE = 0.5;
const SHOT_RANK: Record<ShotType, number> = { establishing: 0, group: 1, two_shot: 2, mcu: 3, cu: 4, ecu: 5, insert: 6 };
/// Re-pick the idle variant when the wanted yaw is this far from what the current variant bakes in.
const RESELECT_YAW_GAP = 0.55;
const FRAMING_YAW_LOOKAHEAD = 0.5;

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
      else fx.roll.push({ ...base, value: k.value.roll });
    }
    return out;
  });
  bgm.sort((a, b) => a.at - b.at);
  se.sort((a, b) => a.at - b.at);
  fade = clipOverlaps(fade);
  return { duration: times.at(-1)?.end ?? 0, scenes, bgm, se, fade, fx: { anxiety: clipOverlaps(fx.anxiety), glow: clipOverlaps(fx.glow), roll: clipOverlaps(fx.roll) }, warnings };
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
export const EMOTION_GESTURE: Record<string, string[]> = {
  happy: ['smile01', 'nod01', 'smile02'],
  sad: ['sad01', 'cry01'],
  angry: ['angry01'],
  surprised: ['surprised01', 'question01'],
  shy: ['kime01', 'smile02'],
  thinking: ['thinking01', 'check01', 'question01'],
  serious: ['serious01', 'nod02'],
  neutral: ['nod01', 'look01', 'check01', 'nod02'],
};

/** Emotion tags the rule director understands (the `emotion` field of a beat). */
export const EMOTION_TAGS = Object.keys(EMOTION_EXPR);

type Interval = [number, number];
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
  const bgRaw = ctx.backgrounds[scene.background.assetId];
  if (!bgRaw) throw new Error(`scene ${scene.id}: unknown background "${scene.background.assetId}"`);
  const bg: BgInfo = { width: bgRaw.width, height: bgRaw.height, ground: bgRaw.ground ?? defaultGround(bgRaw.width, bgRaw.height, bgRaw.setting) };
  const framing = scene.background.framing;
  const abs = absoluteTime(scene, st, warnings);
  const list = st.list;
  const sceneV = st.sceneStyle.values;
  const beatIndex = new Map(list.map((b, i) => [b.id, i]));
  const luma = bgRaw.luma;

  const calOf = (modelId: string): Calibration => {
    const c = ctx.calibrations[modelId];
    if (!c) throw new Error(`scene ${scene.id}: model "${modelId}" has no calibration (probe it first)`);
    return c;
  };

  // Spans of empty shots (establishing / empty beats): everybody fades out for the whole run.
  const emptyRuns = mergeIntervals(list.flatMap((b, i): Interval[] => (EMPTY_KINDS.includes(b.kind) ? [[i === 0 ? st.start : st.beats[i]!.start, st.beats[i]!.end]] : [])));
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
  const placeAt = (w: Work, t: number): Placement => placeActor(calOf(modelAt(w, t)), posAt(w, t), bg);
  const nearestPartner = (w: Work, t: number): Work | null => {
    const me = placeAt(w, t).headCenter.x;
    let best: Work | null = null;
    let bestD = Infinity;
    for (const o of works) {
      if (o === w) continue;
      const d = Math.abs(placeAt(o, t).headCenter.x - me);
      if (d < bestD) {
        best = o;
        bestD = d;
      }
    }
    return best;
  };

  const yawFor = (w: Work, v: { mode: 'target'; target: string } | { mode: 'angle'; yaw: number }, t: number): number => {
    if (v.mode === 'angle') return v.yaw;
    const self = placeAt(w, t);
    const partner = nearestPartner(w, t);
    if (v.target === 'camera') return yawTowardsCamera(self.headCenter, partner ? placeAt(partner, t).headCenter : null);
    if (v.target === 'away') return partner ? -Math.sign(placeAt(partner, t).headCenter.x - self.headCenter.x) * 0.7 : 0.7;
    const other = works.find((o) => o.castId === v.target && o !== w);
    if (!other) {
      warnings.push(`scene ${scene.id}: ${w.castId} turns towards unknown/absent "${v.target}" (facing camera instead)`);
      return yawTowardsCamera(self.headCenter, partner ? placeAt(partner, t).headCenter : null);
    }
    return desiredYaw(self.headCenter, placeAt(other, t).headCenter, self.headUnit);
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
          ? desiredYaw(placeAt(w, st.start).headCenter, placeAt(partner0, st.start).headCenter, placeAt(w, st.start).headUnit)
          : 0;
    const yaw = clipOverlaps<NumKey>([{ at: st.start, duration: 0, ease: 'linear', value: initialYaw }, ...headKeys]);
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
    const resolveMotion = (modelId: string, name: string, wantYaw: number): MotionEvent | null => {
      const entry = ctx.models[modelId];
      const cal = calOf(modelId);
      if (!entry) return null;
      const exact = entry.motions.find((m) => m.name === name);
      let motion = exact;
      let nominal = exact ? nominalScreenYaw(exact.stats?.angleX?.mean ?? null, cal.headSign) : 0;
      if (!motion) {
        const family = name.replace(/^mtn_/, '');
        const pick = chooseMotionVariant(variantsOfFamily(entry.motions, family), wantYaw, cal.headSign);
        motion = pick ? entry.motions.find((m) => m.name === pick.name) : undefined;
        nominal = pick?.nominalYaw ?? 0;
      }
      if (!motion) return null;
      return { at: 0, name: motion.name, loop: motion.family.startsWith('idle'), nominalYaw: nominal, length: motion.stats?.duration ?? 3 };
    };
    const idleAt = (t: number): MotionEvent | null => {
      const ev = resolveMotion(modelAt(w, t), 'idle01', yawAt(t));
      return ev ? { ...ev, at: t } : null;
    };

    const explicit: MotionEvent[] = [];
    const first = idleAt(st.start);
    if (first) explicit.push(first);
    else warnings.push(`scene ${scene.id}: ${w.castId} (${w.initialModelId}) has no idle01 motion`);
    for (const m of w.models) {
      const ev = idleAt(m.at);
      if (ev) explicit.push(ev);
    }
    const motionKeys = collect(scene, 'motion', mine, abs);
    for (const { k, at } of motionKeys) {
      const ev = resolveMotion(modelAt(w, at), k.value.name, yawAt(at));
      if (ev) explicit.push({ ...ev, at });
      else warnings.push(`scene ${scene.id}: ${w.castId} (${modelAt(w, at)}) has no motion "${k.value.name}" (dropped)`);
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
        const ev = fam ? resolveMotion(modelAt(w, bt.start), fam, yawAt(bt.start)) : null;
        if (ev && fam) {
          lastFamily = fam;
          explicit.push({ ...ev, at: bt.start + 0.15 });
          ruleKeys.push({ channel: 'motion', beatId: b.id, offset: 0.15, at: bt.start + 0.15, duration: 0, value: { name: fam } });
        }
      }
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
      if (!cur || !cur.loop || yk.duration === 0) continue;
      const want = yawAt(te);
      if (Math.abs(want - cur.nominalYaw) <= RESELECT_YAW_GAP) continue;
      const alt = resolveMotion(modelAt(w, te), 'idle01', want);
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
        warnings.push(`scene ${scene.id}: ${w.castId} (${modelAt(w, at)}) has no expression "${k.value.name}" (dropped)`);
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
      presence: clipOverlaps(presence), slide: clipOverlaps(slide), shiftX: [], shiftY: [], shiftS: [], shotVisible: [], yaw, bodyYaw, gaze, motions, expressions, ruleKeys,
    };
  });

  // ---- beats, camera, depth of field ----------------------------------------------------------------------
  const H = Math.min(bg.height, bg.width / (16 / 9));
  const frameActor = (w: Work, t: number): FramingActor => {
    const p = placeAt(w, t);
    // The facing a moment after the cut (head turns lag the cut slightly) decides on which side the look-room goes.
    return { id: w.castId, head: p.headBox, body: p.bodyBox, yaw: yawFns.get(w.castId)?.(t + FRAMING_YAW_LOOKAHEAD) ?? 0 };
  };
  const inScene = new Set(works.map((w) => w.castId));
  const beats: CompiledBeat[] = [];
  const camera: CameraKey[] = [];
  const shakes: CompiledScene['shakes'] = [];
  const dof: NumKey[] = [];
  const focus: CompiledScene['focus'] = [];
  const hiddenDialog: Interval[] = [];

  const poseFull = (type: ShotType, ids: string[], t: number, v: StyleValues, insertBox?: InsertBox) => {
    const all = works.filter((w) => presentAt(w, t + 1e-6) || ids.includes(w.castId)).map((w) => frameActor(w, t));
    const chosen = ids.map((id) => all.find((a) => a.id === id) ?? (works.some((w) => w.castId === id) ? frameActor(works.find((w) => w.castId === id)!, t) : undefined)).filter((a): a is FramingActor => !!a);
    const { pose, edgeCut, shifts } = solveShotDetailed({ type, focus: chosen.length > 0 ? chosen : all, all, bg, framing, style: v, aspect: ctx.aspect ?? 16 / 9, ...(insertBox ? { insertBox } : {}) });
    // The original never shows half of another person at the edge: in a single-person shot an unavoidable intruder is hidden for the shot.
    const hide = chosen.length === 1 ? edgeCut : [];
    if (edgeCut.length > 0) warnings.push(`scene ${scene.id}: edge-cut at ${t.toFixed(2)}s, ${edgeCut.join(',')} is cut by the frame edge (${type})${hide.length > 0 ? ', hidden for this shot' : ''}`);
    return { pose, shifts, hide };
  };
  const poseOf = (type: ShotType, ids: string[], t: number, v: StyleValues): CameraPose => poseFull(type, ids, t, v).pose;
  /** Per-actor screen arrangement keys of a shot (multi-person layout, bystanders hidden by the edge rule). */
  const shiftKeys = new Map<string, { x: NumKey[]; y: NumKey[]; s: NumKey[]; vis: NumKey[] }>(works.map((w) => [w.castId, { x: [], y: [], s: [], vis: [] }]));
  const pushShift = (at: number, duration: number, ease: NumKey['ease'], shifts: Record<string, { dx: number; dy: number; s: number }>, hide: string[]) => {
    for (const [id, k] of shiftKeys) {
      const sh = shifts[id] ?? { dx: 0, dy: 0, s: 1 };
      k.x.push({ at, duration, ease, value: sh.dx });
      k.y.push({ at, duration, ease, value: sh.dy });
      k.s.push({ at, duration, ease, value: sh.s });
      k.vis.push({ at, duration: 0, ease: 'linear', value: hide.includes(id) ? 0 : 1 });
    }
  };

  let prevShot: { type: ShotType; ids: string[] } | null = null;
  let prevCamAt = -Infinity;
  let prevMove = 'static';
  list.forEach((beat, i) => {
    const bt = st.beats[i]!;
    const v = st.styles[i]!.values;
    const asked = beat.shot.focus.length > 0 ? beat.shot.focus : beat.speakerId ? [beat.speakerId] : [];
    const ids = asked.filter((id) => inScene.has(id));
    if (ids.length < asked.length) warnings.push(`scene ${scene.id} beat ${beat.id}: focus references actors not in the scene (ignored)`);
    const norm = normalizeShotType(beat.shot.type);
    if (beat.shot.type === 'wide') warnings.push(`scene ${scene.id} beat ${beat.id}: "wide" is not used by the original (no full-body shots); treated as "group"`);
    let type = EMPTY_KINDS.includes(beat.kind) && beat.kind === 'establishing' ? ('establishing' as ShotType) : norm.type;
    let shotIds = ids;

    // minimum shot length: a short line keeps the previous camera instead of cutting (unless the author set the shot by hand)
    const entering = works.some((w) => w.away.some(([, b]) => Math.abs(b - bt.start) < 1e-6));
    const userShot = beat.shot.meta.locked || beat.shot.meta.source === 'user';
    // A closer size, another focus or a camera move is a deliberate choice of the author and is never swallowed.
    const sameFocus = prevShot !== null && prevShot.ids.length === ids.length && prevShot.ids.every((x) => ids.includes(x));
    const closer = prevShot !== null && SHOT_RANK[type] > SHOT_RANK[prevShot.type];
    let held =
      i > 0 && v.rhythm.enforceMinShot && !entering && !userShot && TEXT_KINDS.includes(beat.kind) && beat.cutIn === 'cut' &&
      beat.shot.move === 'static' && sameFocus && !closer &&
      prevShot !== null && prevShot.type !== 'establishing' && bt.start - prevCamAt < v.rhythm.minShotSeconds;
    // the same framing again (e.g. the partner answers in the same two-shot) is no new shot: no cut, no new camera key
    const same = i > 0 && !entering && !userShot && prevShot !== null && prevShot.type === type && prevShot.type !== 'establishing' && beat.cutIn === 'cut' && prevMove === 'static' && beat.shot.move === 'static' &&
      prevShot.ids.length === ids.length && prevShot.ids.every((x) => ids.includes(x)) && beat.kind !== 'establishing' && !held;
    if (same) held = true;
    if (held && prevShot) {
      type = prevShot.type;
      shotIds = prevShot.ids;
    } else {
      prevShot = { type, ids };
      prevCamAt = bt.start;
      prevMove = beat.shot.move;
    }

    const dur = bt.end - bt.start;
    const dofLevel = beat.shot.dof ?? Math.min(6, v.shots[type].dof + (type !== 'establishing' && luma !== undefined && luma < v.framing.darkLuma ? v.framing.darkDofBonus : 0));
    beats.push({
      id: beat.id, kind: beat.kind, variant: beat.variant, coSpeakers: beat.coSpeakers, shotHeld: held, ui: uiOf(v),
      speakerId: beat.speakerId ?? null, text: beat.text, start: bt.start, end: bt.end, textEnd: bt.textEnd, cps: v.rhythm.textSpeedCps, focus: shotIds,
      shotType: type, dof: dofLevel,
    });
    if (!held) {
      const solved = poseFull(type, shotIds, bt.start, v, beat.shot.insertBox);
      const base = solved.pose;
      const { from, to } = cameraMove(base, beat.shot.move, bg, v.framing, ctx.aspect ?? 16 / 9);
      const reframe = entering && shotIds.length >= 2;
      const gs = v.performance.glideSeconds;
      const wantsGlide = (beat.shot.transition ?? (gs > 0 ? 'glide' : 'cut')) === 'glide';
      const glideLen = reframe ? v.performance.reframeSeconds : wantsGlide ? (gs > 0 ? gs : DEFAULT_GLIDE) : 0;
      const glide = i === 0 || beat.cutIn === 'dip_black' ? 0 : Math.min(glideLen, dur / 2);
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
    }

    // dialogue area visibility and the dip between two shots
    if (EMPTY_KINDS.includes(beat.kind) || beat.kind === 'silent') hiddenDialog.push([i === 0 ? st.start : bt.start, bt.end]);
    if (i > 0 && beat.cutIn === 'dip_black') {
      const d = v.transitions;
      const mid = bt.start - d.dipHold / 2;
      fadeOut.push(
        { at: mid - d.dipOut, duration: d.dipOut, ease: 'inOutSine', alpha: 1, color: 'black' },
        { at: mid + d.dipHold, duration: d.dipIn, ease: 'inOutSine', alpha: 0, color: 'black' },
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
  if (list.length === 0) camera.push({ at: st.start, duration: 0, ease: 'linear', pose: poseOf('establishing', [], st.start, sceneV) });

  for (const { k, at } of collect(scene, 'camera', (t) => t.target.kind === 'camera', abs)) {
    const pose = 'manual' in k.value ? k.value.manual : poseOf(normalizeShotType(k.value.shot).type, k.value.focus.filter((id) => inScene.has(id)), at, sceneV);
    camera.push({ at, duration: k.duration, ease: k.ease, pose });
  }

  const loc = scene.location;
  const location = loc?.show && loc.text ? { text: loc.text, start: st.contentStart + st.timing.fadeIn + sceneV.location.delay } : null;

  return {
    index, id: scene.id, title: scene.title, start: st.start, contentStart: st.contentStart, end: st.end,
    bgAssetId: scene.background.assetId, framing, bg, transitionIn: { kind: scene.transitionIn.kind, duration: scene.transitionIn.duration },
    timing: st.timing, ui: uiOf(sceneV), hiddenDialog, location,
    actors: actors.map((a) => {
      const k = shiftKeys.get(a.castId)!;
      return { ...a, shiftX: clipOverlaps(k.x), shiftY: clipOverlaps(k.y), shiftS: clipOverlaps(k.s), shotVisible: clipOverlaps(k.vis) };
    }), beats, camera: clipOverlaps(camera), shakes, dof: clipOverlaps(dof), focus,
  };
}
