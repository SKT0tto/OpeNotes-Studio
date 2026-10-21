import type { Calibration } from '../schema/calibration';
import type { MotionEntry } from '../schema/assets';
import type { Transition } from '../schema/project';
import type { BgFraming, BgInfo, CameraPose, GroundParams } from '../staging/world';
import type { ShotType } from '../staging/framing';
import type { StageMap } from '../staging/compactStage';
import type { TravelBgModel } from '../staging/travelBg';
import type { StyleValues } from '../style/ournotes';
import type { EaseName } from './easing';
import type { TransitionTiming } from './time';

/** Everything compile needs from the outside world, as plain data (no network, no engine). */
export interface CompileContext {
  models: Record<string, { motions: MotionEntry[]; expressions: string[] }>;
  calibrations: Record<string, Calibration>;
  /** Window aspect (width / height) the project is compiled for; default 16:9. Wider frames re-lay two-shots and groups over the width. */
  aspect?: number;
  backgrounds: Record<string, { width: number; height: number; ground?: GroundParams; setting?: string | null; /** Mean luminance 0..1; dark backgrounds get extra blur. */ luma?: number }>;
}

interface TimedKey {
  /** Absolute project time (seconds). */
  at: number;
  duration: number;
  ease: EaseName;
}
export interface NumKey extends TimedKey {
  value: number;
}
export interface PosKey extends TimedKey {
  slot: number;
  depth: number;
}
/** Gaze: `w`=1 aims at an absolute screen direction `dir` (relative to the head), `w`=0 uses the literal x. */
export interface GazeKey extends TimedKey {
  w: number;
  dir: number;
  x: number;
  y: number;
}
export type TravelKind = 'distance' | 'lateral' | 'regroup' | 'settle' | 'reframe' | 'drift' | 'cutDrift';
/** Travel segment info of a camera key (travel camera system only). */
export interface CameraTravel {
  kind: TravelKind;
  /** Screen anchor (world coordinates). With an anchor the segment is interpolated by `travelPose`, otherwise by `blendPose`. */
  anchor?: { x: number; y: number };
}
export interface CameraKey extends TimedKey {
  pose: CameraPose;
  travel?: CameraTravel;
}
export interface FadeKey extends TimedKey {
  alpha: number;
  color: 'black' | 'white';
}
export interface MotionEvent {
  at: number;
  /** Exact motion name as in model3.json. */
  name: string;
  loop: boolean;
  /** Screen yaw baked into the chosen variant. */
  nominalYaw: number;
  /** Seconds the motion runs (for one-shots). */
  length: number;
}
export interface ExprEvent {
  at: number;
  name: string | null;
}
export interface ModelKey {
  at: number;
  modelId: string;
}

/** A key the rule director made on its own, in the shape a real track key would have (so it can be baked into one). */
export interface RuleKey {
  channel: 'expression' | 'motion' | 'head';
  beatId: string;
  offset: number;
  at: number;
  value: unknown;
  duration: number;
}

export interface CompiledActor {
  castId: string;
  initialModelId: string;
  initialPos: { slot: number; depth: number };
  models: ModelKey[];
  position: PosKey[];
  opacity: NumKey[];
  /** 1 = on stage, 0 = away (enter / exit / empty beats); multiplies `opacity`. */
  presence: NumKey[];
  /** Horizontal slide-in offset in stage heights (H), eases to 0. */
  slide: NumKey[];
  /** Per-shot arrangement offset in world units (two-shot / group layout), eases with the camera key of the shot. */
  shiftX: NumKey[];
  shiftY: NumKey[];
  /** Scale about the head centre (1 = natural); evens out the head sizes of a two-shot. */
  shiftS: NumKey[];
  /** Draw order inside a group of three or more (larger = in front, 0 = by blocking depth). */
  shiftZ?: NumKey[];
  /** 0 while the edge rule hides this person for a single-person shot, else 1. */
  shotVisible: NumKey[];
  /** Desired absolute screen yaw of the head (-1..1). */
  yaw: NumKey[];
  /** Optional separate body yaw; absent = body follows the head. */
  bodyYaw: NumKey[];
  gaze: GazeKey[];
  motions: MotionEvent[];
  expressions: ExprEvent[];
  /** What the rule director added for this actor (not backed by a track key). */
  ruleKeys: RuleKey[];
}

/** The slice of the resolved style the player and the HUD need while a beat is on screen. */
export type UiStyle = Pick<StyleValues, 'dialog' | 'hud' | 'location' | 'stage' | 'fx' | 'performance'>;

export interface CompiledBeat {
  id: string;
  kind: 'dialogue' | 'narration' | 'action' | 'pause' | 'establishing' | 'silent' | 'empty';
  variant: 'normal' | 'monologue' | 'offscreen';
  coSpeakers: string[];
  /** True when the minimum-shot-length rule kept the previous camera instead of cutting. */
  shotHeld: boolean;
  ui: UiStyle;
  speakerId: string | null;
  text: string;
  start: number;
  end: number;
  textEnd: number;
  cps: number;
  focus: string[];
  shotType: ShotType;
  dof: number;
  /** Travel scenes only: how the camera changes into this beat (editor display). */
  camTravel?: { kind: TravelKind | 'cut' | 'glide'; seconds: number; ease?: string; reason?: string };
}

export interface LocationBanner {
  text: string;
  start: number;
}

/** One stretch of a scene with one background (P20). Segment 0 is the scene's start background; the others come from `background` track keys. */
export interface BgSegment {
  start: number;
  end: number;
  assetId: string;
  /** The picture's own size (the world of the scene is the base background's, see `CompiledScene.bg`). */
  bg: BgInfo;
  framing: BgFraming;
  transition: 'cut' | 'dip_black' | 'crossfade';
  transitionSeconds: number;
  purpose: 'move' | 'insert' | 'time';
  /** Track key that made this segment (null for the start background). */
  keyId: string | null;
}

export interface CompiledScene {
  index: number;
  id: string;
  title: string;
  start: number;
  contentStart: number;
  end: number;
  /** Start background (= `bgSegments[0].assetId`). */
  bgAssetId: string;
  framing: BgFraming;
  /** World of the scene: camera, ground and people are solved against this size and stay put when the background changes. */
  bg: BgInfo;
  /** Backgrounds in time order; always at least one. */
  bgSegments: BgSegment[];
  transitionIn: Pick<Transition, 'kind' | 'duration'>;
  timing: TransitionTiming;
  ui: UiStyle;
  /** Time spans in which the dialogue area is hidden (empty shots, dips, scene changes). */
  hiddenDialog: Array<[number, number]>;
  location: LocationBanner | null;
  actors: CompiledActor[];
  beats: CompiledBeat[];
  camera: CameraKey[];
  shakes: Array<{ start: number; end: number; amp: number }>;
  dof: NumKey[];
  focus: Array<{ at: number; ids: string[] }>;
  /** Set to 'travel' in travel scenes only. */
  cameraSystem?: 'travel';
  /** Travel scenes only: the data evaluate needs to derive the background pose, the compact stage and the depth of field (version 8). */
  travel?: {
    version: 12;
    aspect: number;
    stage: StageMap;
    bg: TravelBgModel;
    /** Mean visible head height of the shot's people (world units), eased with the camera. */
    focusHead: NumKey[];
    /** The author's depth-of-field level per shot (-1 = automatic from the head share). */
    dofManual: NumKey[];
    dof: { mode: string; aperture: number; depthSpan: number };
  };
}

export interface CompiledProject {
  duration: number;
  scenes: CompiledScene[];
  bgm: Array<{ at: number; assetId: string | null; volume: number }>;
  se: Array<{ at: number; assetId: string; volume: number }>;
  fade: FadeKey[];
  /** Emotion effects on the screen: strengths 0..1 and the Dutch roll in degrees. */
  fx: { anxiety: NumKey[]; glow: NumKey[]; roll: NumKey[] };
  /** Non-fatal problems (missing motion, unknown beat id, ...). Compile never invents resources. */
  warnings: string[];
}

// ---- evaluate output ---------------------------------------------------------------------------------------
export interface ActorRender {
  castId: string;
  modelId: string;
  slot: number;
  depth: number;
  opacity: number;
  /** Environment multiply colour (0..1) and slide-in offset (stage heights). */
  tint: number;
  slideH: number;
  /** Shot arrangement offset in world units (x, y). */
  shiftX: number;
  shiftY: number;
  shiftS: number;
  /** Draw order inside a group (larger = in front); 0 = by blocking depth. */
  shiftZ: number;
  /** Extra blur (pixels at 720p) for actors out of focus. */
  blur: number;
  motion: { name: string; loop: boolean; elapsed: number; eventAt: number } | null;
  expression: string | null;
  /** Overlay intents (-1..1, screen space) to hand to ParamOverride. */
  head: number;
  body: number;
  gaze: { x: number; y: number };
  /** Absolute yaw the head is meant to have (for debugging / assertions). */
  desiredYaw: number;
  talking: boolean;
  /** 0..1 pseudo lip-sync value for ParamMouthOpenY while text is being shown. */
  mouth: number;
}

export interface SubtitleRender {
  beatId: string;
  kind: CompiledBeat['kind'];
  variant: CompiledBeat['variant'];
  coSpeakers: string[];
  speakerId: string | null;
  text: string;
  visibleChars: number;
  totalChars: number;
}

export interface RenderState {
  t: number;
  sceneIndex: number;
  sceneId: string;
  background: {
    assetId: string;
    framing: BgFraming;
    blur: number;
    /** Size of this picture; the layer fits it over the scene's world (cover). */
    src: { width: number; height: number };
    /** Second layer while a crossfade runs. */
    next?: { assetId: string; framing: BgFraming; alpha: number; src: { width: number; height: number } };
  };
  camera: CameraPose;
  actors: ActorRender[];
  subtitle: SubtitleRender | null;
  transition: { kind: Transition['kind']; progress: number; seconds: number; pause: number; out: number; hold: number } | null;
  fade: { color: 'black' | 'white'; alpha: number };
  /** Style of the beat on screen (dialogue area, HUD, banner, effects). */
  ui: UiStyle;
  location: { text: string; phase: 'in' | 'hold' | 'out'; progress: number } | null;
  fx: { anxiety: number; glow: number; roll: number };
  audio: { bgm: { assetId: string; volume: number } | null };
}
