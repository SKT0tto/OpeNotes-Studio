/**
 * evaluate(compiled, t) -> RenderState. A pure function of (compiled, t): no hidden state, so seeking to any time
 * gives exactly what sequential playback would show at that time.
 */
import { BODY_FOLLOW } from '../staging/facing';
import type { CameraPose } from '../staging/world';
import { stageDx } from '../staging/compactStage';
import { travelPose } from '../staging/travel';
import { travelBgPose } from '../staging/travelBg';
import { bgView, viewWorldHeight } from '../staging/world';
import { clamp, ease, lerp } from './easing';
import { MEMORY_DEFAULT_EDGE, MEMORY_DEFAULT_TONE, SHAKE_AMPLITUDE, SHAKE_DECAY } from './fxParams';
import { lastBefore, sampleKeys, sampleNum } from './sample';
import { TEXT_KINDS } from './time';
import type { ActorRender, CameraKey, CompiledActor, CompiledProject, CompiledScene, RenderState, SubtitleRender } from './types';

/** Original game's blur radius per depth-of-field level 0..6 (pixels at 720p); level 0 is a crisp background. */
export const DOF_BLUR = [0, 1, 1.8, 3.5, 5.5, 8, 11] as const;
/** Blur of out-of-focus actors relative to the background's, scaled by their depth distance from the focus. */
const ACTOR_BLUR_SHARE = 0.35;
const ACTOR_BLUR_DEPTH_SPAN = 0.4;
const NOMINAL_FADE = 0.45;

export const dofBlur = (level: number) => DOF_BLUR[clamp(Math.round(level), 0, 6)]!;
/**
 * Travel scenes: the depth-of-field level eases over a whole camera move (1.3-2.3 s), so the blur is interpolated between the table
 * steps; rounding (dofBlur) would make the background and the neighbours pop in visible steps half way through the move.
 */
export const dofBlurSmooth = (level: number) => {
  const l = clamp(level, 0, 6);
  const i = Math.min(5, Math.floor(l));
  return lerp(DOF_BLUR[i]!, DOF_BLUR[i + 1]!, l - i);
};

/**
 * Background circle of confusion of the travel camera at head share s (px at 720p; aperture scales it). Zero up to a two-shot, light at
 * MCU (s 0.52: about 1.5), strong at CU (0.70: about 5), capped for ECU. The head share is the distance to the focused row in disguise.
 */
export const travelBgBlur = (s: number, aperture: number, from = 0.42) => Math.min(9, aperture * 22 * Math.pow(Math.max(0, s - from), 1.17));
/** Aperture and start of the blur for a depth-of-field mode ("strong" blurs from the two-shot on, twice as hard). */
export const travelDofParams = (mode: string, aperture: number) => (mode === 'off' ? { A: 0, from: 0.42 } : mode === 'strong' ? { A: 2 * aperture, from: 0.3 } : { A: aperture, from: 0.42 });
/** Head share of the frame (visible head height x zoom / frame height) of the travel shot at time t. */
const headShare = (s: CompiledScene, tr: NonNullable<CompiledScene['travel']>, t: number, zoom: number) => (sampleNum(tr.focusHead, t, 0) * zoom) / viewWorldHeight(s.bg);
/** Background blur of a travel scene at t: the author's level when the shot has one, else from the head share. */
function travelBlurAt(s: CompiledScene, tr: NonNullable<CompiledScene['travel']>, t: number, zoom: number): number {
  const manual = sampleNum(tr.dofManual, t, -1);
  if (manual >= 0) return dofBlurSmooth(manual);
  const { A, from } = travelDofParams(tr.dof.mode, tr.dof.aperture);
  return travelBgBlur(headShare(s, tr, t, zoom), A, from);
}

const logLerp = (a: number, b: number, e: number) => Math.exp(lerp(Math.log(a), Math.log(b), e));
const blendPose = (a: CameraPose, b: CameraPose, e: number): CameraPose => ({
  x: lerp(a.x, b.x, e),
  y: lerp(a.y, b.y, e),
  zoom: logLerp(a.zoom, b.zoom, e), // zoom interpolates in log space (constant perceived speed)
  ...(a.roll !== undefined || b.roll !== undefined ? { roll: lerp(a.roll ?? 0, b.roll ?? 0, e) } : {}),
  ...(a.bgZoom !== undefined || b.bgZoom !== undefined ? { bgZoom: logLerp(a.bgZoom ?? Math.pow(a.zoom, 0.85), b.bgZoom ?? Math.pow(b.zoom, 0.85), e) } : {}),
});

/**
 * Camera at time t. Without `travel` info a key behaves exactly as `sampleKeys(keys, t, initial, k => k.pose, blendPose)` does
 * (same loop, same order of tests); an anchored travel key interpolates around its anchor instead.
 */
export function sampleCamera(keys: readonly CameraKey[], t: number, initial: CameraPose): CameraPose {
  let cur = initial;
  for (const k of keys) {
    if (t < k.at) return cur;
    if (k.duration > 0 && t < k.at + k.duration) {
      const e = ease(k.ease, (t - k.at) / k.duration);
      return k.travel?.anchor ? travelPose(cur, k.pose, e, k.travel) : blendPose(cur, k.pose, e);
    }
    cur = k.pose;
  }
  return cur;
}

/** Travel backgrounds interpolate classic endpoints independently of the compact actor camera.
 * The card model contributes only the nonlinear residual inside a move; it is zero at both endpoints.
 * Manual camera fields use the same interpretation as classic and never get overwritten by the card model.
 */
function travelCamera(s: CompiledScene, tr: NonNullable<CompiledScene['travel']>, cam: CameraPose, x: number, y: number, framing: CompiledScene['framing'], share: number, t: number): CameraPose {
  const endpoint = (p: CameraPose) => {
    const v = bgView(s.bg, p, framing, tr.aspect);
    return { bgZoom: p.bgZoom ?? Math.pow(p.zoom, 0.85), bgX: v.cx - framing.offsetX, bgY: v.cy - framing.offsetY };
  };
  let prev = s.camera[0]?.pose ?? cam;
  let b = endpoint(prev);
  for (const k of s.camera) {
    if (t < k.at) break;
    if (k.duration > 0 && t < k.at + k.duration) {
      const e = ease(k.ease, (t - k.at) / k.duration);
      const target = endpoint(k.pose);
      b = { bgZoom: logLerp(b.bgZoom, target.bgZoom, e), bgX: lerp(b.bgX, target.bgX, e), bgY: lerp(b.bgY, target.bgY, e) };
      if (k.travel) {
        const current = travelBgPose(cam, tr.bg, s.bg, framing, tr.aspect, share);
        const start = travelBgPose(prev, tr.bg, s.bg, framing, tr.aspect, headShare(s, tr, k.at, prev.zoom));
        const end = travelBgPose(k.pose, tr.bg, s.bg, framing, tr.aspect, headShare(s, tr, k.at + k.duration, k.pose.zoom));
        b.bgX += current.bgX - lerp(start.bgX, end.bgX, e);
        b.bgY += current.bgY - lerp(start.bgY, end.bgY, e);
      }
      break;
    }
    prev = k.pose;
    b = endpoint(prev);
  }
  return { x, y, zoom: cam.zoom, ...b, bgX: b.bgX + (x - cam.x), bgY: b.bgY + (y - cam.y) };
}

function memoryAt(c: CompiledProject, t: number): Pick<RenderState['fx'], 'memory' | 'memoryTone' | 'memoryEdge'> {
  const look = lastBefore(c.fx.memoryLook ?? [], t);
  return { memory: sampleNum(c.fx.memory ?? [], t, 0), memoryTone: look?.tone ?? MEMORY_DEFAULT_TONE, memoryEdge: look?.edge ?? MEMORY_DEFAULT_EDGE };
}

export function sceneIndexAt(c: CompiledProject, t: number): number {
  let idx = 0;
  c.scenes.forEach((s, i) => {
    if (s.start <= t) idx = i;
  });
  return idx;
}

const smooth = (x: number) => x * x * (3 - 2 * x);
const srcOf = (b: { width: number; height: number }) => ({ width: b.width, height: b.height });

/** The picture(s) on screen at `t`: a hard cut (or a dip, which rides on the fade channel) shows one; a crossfade shows the old one with the new on top. */
export function backgroundAt(s: CompiledScene, t: number, cam?: CameraPose): RenderState['background'] {
  const segs = s.bgSegments;
  let i = 0;
  segs.forEach((sg, k) => {
    if (sg.start <= t + 1e-9) i = k;
  });
  const cur = segs[i]!;
  const level = sampleNum(s.dof, t, 0);
  const blur = s.travel ? (cam ? travelBlurAt(s, s.travel, t, cam.zoom) : dofBlurSmooth(level)) : dofBlur(level);
  const prev = segs[i - 1];
  if (prev && cur.transition === 'crossfade' && cur.transitionSeconds > 0 && t < cur.start + cur.transitionSeconds) {
    const alpha = smooth(clamp((t - cur.start) / cur.transitionSeconds, 0, 1));
    return { assetId: prev.assetId, framing: prev.framing, blur, src: srcOf(prev.bg), next: { assetId: cur.assetId, framing: cur.framing, alpha, src: srcOf(cur.bg) } };
  }
  return { assetId: cur.assetId, framing: cur.framing, blur, src: srcOf(cur.bg) };
}

function evalActor(s: CompiledScene, a: CompiledActor, t: number, ctxBeat: SceneBeat, zoom: number): ActorRender {
  const model = lastBefore(a.models, t)?.modelId ?? a.initialModelId;
  const pos = sampleKeys(a.position, t, a.initialPos, (k) => ({ slot: k.slot, depth: k.depth }), (p, q, e) => ({ slot: lerp(p.slot, q.slot, e), depth: lerp(p.depth, q.depth, e) }));
  const desired = sampleNum(a.yaw, t, 0);
  const ev = lastBefore(a.motions, t);
  // The previous variant's baked-in yaw fades into the new one's while the motion cross-fades.
  const idx = ev ? a.motions.indexOf(ev) : -1;
  const prevNominal = idx > 0 ? a.motions[idx - 1]!.nominalYaw : (ev?.nominalYaw ?? 0);
  const nominal = ev ? lerp(prevNominal, ev.nominalYaw, clamp((t - ev.at) / NOMINAL_FADE, 0, 1)) : 0;
  const head = clamp(desired - nominal, -1, 1);
  const body = a.bodyYaw.length > 0 ? clamp((sampleNum(a.bodyYaw, t, desired) - nominal) * BODY_FOLLOW, -1, 1) : clamp(head * BODY_FOLLOW, -1, 1);
  const g = sampleKeys(a.gaze, t, { w: 0, dir: 0, x: 0, y: 0 }, (k) => ({ w: k.w, dir: k.dir, x: k.x, y: k.y }), (p, q, e) => ({
    w: lerp(p.w, q.w, e), dir: lerp(p.dir, q.dir, e), x: lerp(p.x, q.x, e), y: lerp(p.y, q.y, e),
  }));
  // Eyes ride on the head: a gaze aimed at an absolute direction only needs the part the head did not cover.
  const gazeX = clamp(g.w * (g.dir - desired) * 0.7 + (1 - g.w) * g.x, -1, 1);

  const talking = ctxBeat.beat !== null && ctxBeat.beat.speakerId === a.castId && t >= ctxBeat.beat.start && t < ctxBeat.beat.textEnd;
  const gain = (ctxBeat.beat?.ui ?? s.ui).performance.mouthGain;
  const mouth = talking ? Math.min(1, (0.12 + 0.6 * Math.abs(Math.sin(((t - ctxBeat.beat!.start) * ctxBeat.beat!.cps) * Math.PI * 0.8))) * gain) : 0;
  const ui = ctxBeat.beat?.ui ?? s.ui;
  const speaking = ctxBeat.beat !== null && ctxBeat.beat.speakerId !== null && TEXT_KINDS.includes(ctxBeat.beat.kind);
  const isSpeaker = ctxBeat.beat !== null && (ctxBeat.beat.speakerId === a.castId || ctxBeat.beat.coSpeakers.includes(a.castId));
  const tint = ui.stage.actorTint * (speaking && !isSpeaker ? 1 - ui.stage.listenerDim : 1);

  let blur = 0;
  const level = sampleNum(s.dof, t, 0);
  const focusIds = lastBefore(s.focus, t)?.ids ?? [];
  if (s.travel) {
    // Travel: people in the focused row are sharp; one that stands in front of or behind it blurs like the background, in proportion to the
    // depth difference. (Nobody is blurred because of who they are.)
    const bg = travelBlurAt(s, s.travel, t, zoom);
    if (bg > 0 && focusIds.length > 0 && !focusIds.includes(a.castId)) {
      const depths = s.actors.filter((o) => focusIds.includes(o.castId)).map((o) => sampleKeys(o.position, t, o.initialPos.depth, (k) => k.depth, lerp));
      const focusDepth = depths.length > 0 ? depths.reduce((x, y) => x + y, 0) / depths.length : pos.depth;
      blur = bg * clamp(Math.abs(pos.depth - focusDepth) / s.travel.dof.depthSpan, 0, 1);
    }
  } else if (level >= 1.5 && focusIds.length > 0 && !focusIds.includes(a.castId)) {
    const depths = s.actors.filter((o) => focusIds.includes(o.castId)).map((o) => sampleKeys(o.position, t, o.initialPos.depth, (k) => k.depth, lerp));
    const focusDepth = depths.length > 0 ? depths.reduce((x, y) => x + y, 0) / depths.length : pos.depth;
    blur = dofBlur(level) * ACTOR_BLUR_SHARE * clamp(Math.abs(pos.depth - focusDepth) / ACTOR_BLUR_DEPTH_SPAN, 0, 1);
  }
  const shiftX = sampleNum(a.shiftX, t, 0);
  return {
    castId: a.castId,
    modelId: model,
    slot: pos.slot,
    depth: pos.depth,
    opacity: sampleNum(a.opacity, t, 1) * sampleNum(a.presence, t, 1) * sampleNum(a.shotVisible, t, 1),
    tint,
    slideH: sampleNum(a.slide, t, 0),
    // travel: the compact stage moves everybody from the slot position to the stage position
    shiftX: s.travel ? shiftX + stageDx(s.travel.stage, pos.slot, s.bg) : shiftX,
    shiftY: sampleNum(a.shiftY, t, 0),
    shiftS: sampleNum(a.shiftS, t, 1),
    shiftZ: sampleNum(a.shiftZ ?? [], t, 0),
    blur,
    motion: ev ? { name: ev.name, loop: ev.loop, elapsed: t - ev.at, eventAt: ev.at } : null,
    expression: lastBefore(a.expressions, t)?.name ?? null,
    head,
    ...(a.pitch ? { headPitch: clamp(sampleNum(a.pitch, t, 0), -1, 1) } : {}),
    body,
    gaze: { x: gazeX, y: clamp(g.y, -1, 1) },
    desiredYaw: desired,
    talking,
    mouth,
  };
}

interface SceneBeat {
  beat: CompiledScene['beats'][number] | null;
}

function locationAt(s: CompiledScene, t: number): RenderState['location'] {
  const loc = s.location;
  if (!loc) return null;
  const l = s.ui.location;
  const e = t - loc.start;
  if (e < 0 || e >= l.slideIn + l.hold + l.slideOut) return null;
  if (e < l.slideIn) return { text: loc.text, phase: 'in', progress: l.slideIn > 0 ? e / l.slideIn : 1 };
  if (e < l.slideIn + l.hold) return { text: loc.text, phase: 'hold', progress: 1 };
  return { text: loc.text, phase: 'out', progress: l.slideOut > 0 ? (e - l.slideIn - l.hold) / l.slideOut : 1 };
}

export function evaluate(c: CompiledProject, tIn: number): RenderState {
  const t = clamp(tIn, 0, c.duration);
  const si = sceneIndexAt(c, t);
  const s = c.scenes[si];
  if (!s) throw new Error('evaluate: project has no scenes');

  const beat = s.beats.find((b) => t >= b.start && t < b.end) ?? (t >= s.end ? s.beats.at(-1) ?? null : null);
  const cam = sampleCamera(s.camera, t, s.camera[0]?.pose ?? { x: s.bg.width / 2, y: s.bg.height / 2, zoom: 1 });
  let { x, y } = cam;
  for (const sh of s.shakes) {
    if (t >= sh.start && t < sh.end) {
      const fade = Math.min(1, (t - sh.start) / 0.15, (sh.end - t) / 0.15);
      x += Math.sin(t * 61.3) * sh.amp * fade / cam.zoom;
      y += Math.sin(t * 47.9 + 1.3) * sh.amp * fade / cam.zoom;
    }
  }

  // the shake effect: a short decaying jolt of the camera (same sine pair as the beat-long shake, deterministic in t)
  for (const w of c.fx.shake ?? []) {
    if (t < w.start || t >= w.start + w.seconds) continue;
    const a = (w.strength * SHAKE_AMPLITUDE * viewWorldHeight(s.bg) * Math.exp((-SHAKE_DECAY * (t - w.start)) / w.seconds)) / cam.zoom;
    x += Math.sin(t * 61.3) * a;
    y += Math.sin(t * 47.9 + 1.3) * a;
  }

  let subtitle: SubtitleRender | null = null;
  const hidden = s.hiddenDialog.some(([a, b]) => t >= a && t < b);
  if (beat && beat.text.length > 0 && TEXT_KINDS.includes(beat.kind) && t >= beat.start && !hidden) {
    const total = [...beat.text].length;
    subtitle = {
      beatId: beat.id, kind: beat.kind, variant: beat.variant, coSpeakers: beat.coSpeakers, speakerId: beat.speakerId, text: beat.text, totalChars: total,
      visibleChars: Math.min(total, Math.floor((t - beat.start) * beat.cps)),
      ...(beat.expand ? { expand: true as const } : {}),
    };
  }

  const background = backgroundAt(s, t, cam);
  const inLead = t < s.contentStart && s.transitionIn.kind !== 'cut' && (s.transitionIn.duration > 0 || s.timing.black);
  const fadeA = sampleKeys(c.fade, t, { alpha: 0, color: 'black' as 'black' | 'white' }, (k) => ({ alpha: k.alpha, color: k.color }), (p, q, e) => ({ alpha: lerp(p.alpha, q.alpha, e), color: q.color }));
  const bgm = lastBefore(c.bgm, t);

  return {
    t,
    sceneIndex: si,
    sceneId: s.id,
    background,
    camera: s.travel ? travelCamera(s, s.travel, cam, x, y, background.framing, headShare(s, s.travel, t, cam.zoom), t) : { x, y, zoom: cam.zoom, ...(cam.bgZoom !== undefined ? { bgZoom: cam.bgZoom } : {}), ...(cam.bgX !== undefined && cam.bgY !== undefined ? { bgX: cam.bgX + (x - cam.x), bgY: cam.bgY + (y - cam.y) } : {}) },
    actors: s.actors.map((a) => evalActor(s, a, t, { beat }, cam.zoom)),
    subtitle,
    transition: inLead
      ? {
          kind: s.transitionIn.kind,
          progress: clamp((t - s.start) / Math.max(1e-6, s.timing.lead), 0, 1),
          seconds: t - s.start, pause: s.timing.pause, out: s.timing.out, hold: s.timing.hold,
        }
      : null,
    ui: (beat ?? null)?.ui ?? s.ui,
    location: locationAt(s, t),
    fx: {
      anxiety: sampleNum(c.fx.anxiety, t, 0), glow: sampleNum(c.fx.glow, t, 0), roll: sampleNum(c.fx.roll, t, 0) + (cam.roll ?? 0),
      // the effects of v0.4 only appear in a project that uses them (the golden of the old projects hashes this object)
      ...(c.fx.memory ? memoryAt(c, t) : {}),
      ...(c.fx.dim ? { dim: sampleNum(c.fx.dim, t, 0) } : {}),
      ...(c.fx.daze ? { daze: sampleNum(c.fx.daze, t, 0) } : {}),
      ...(c.fx.blink ? { blink: sampleNum(c.fx.blink, t, 0) } : {}),
    },
    fade: fadeA,
    audio: { bgm: bgm && bgm.assetId ? { assetId: bgm.assetId, volume: bgm.volume } : null },
  };
}
