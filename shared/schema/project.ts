import { z } from 'zod';
import { EASE_NAMES } from '../timeline/easing';
import { ALL_SHOT_TYPES, CAMERA_MOVES } from '../staging/framing';

/** Provenance + lock of every editable unit (PLAN 1.1). Omitted in hand-written fixtures -> defaults. */
export const MetaSchema = z
  .object({
    source: z.enum(['ai', 'rule', 'user', 'default']),
    locked: z.boolean(),
    genId: z.string().optional(),
    reason: z.string().optional(),
    /** Field-level locks (beat: text/speakerId/kind/duration/emotion/cutIn; shot: type/focus/move/dof/offsets). `locked` locks everything. */
    lockedFields: z.array(z.string()).optional(),
    updatedAt: z.number(),
  })
  .default({ source: 'default', locked: false, updatedAt: 0 });
export type Meta = z.infer<typeof MetaSchema>;

/**
 * Reserved style-preset layer: project = global preset, Scene.style = scene override,
 * Beat.style = shot/beat override. Values are keyed by style-field path and resolve beat > scene > project > preset;
 * nothing reads them until the style system lands.
 */
export const StyleSchema = z
  .object({ preset: z.string().optional(), overrides: z.record(z.string(), z.unknown()).default({}), meta: MetaSchema })
  .default({ overrides: {}, meta: { source: 'default', locked: false, updatedAt: 0 } });
export type StyleLayer = z.infer<typeof StyleSchema>;

const Id = z.string().min(1);
export const EaseSchema = z.enum(EASE_NAMES);
export const ShotTypeSchema = z.enum(ALL_SHOT_TYPES);
export const CameraMoveSchema = z.enum(CAMERA_MOVES);

export const CastMemberSchema = z.object({
  id: Id,
  characterKey: Id,
  displayName: z.string(),
  meta: MetaSchema,
});

export const ShotSchema = z.object({
  type: ShotTypeSchema,
  focus: z.array(Id),
  move: CameraMoveSchema.default('static'),
  /** Depth-of-field level 0..6 (original game's blur table). Absent = the style table's value for the shot size. */
  dof: z.number().int().min(0).max(6).optional(),
  /** How the camera changes into this beat: hard cut (the original's default) or a short glide. Absent = decided by the style (`performance.glideSeconds` > 0 glides). */
  transition: z.enum(['cut', 'glide']).optional(),
  /** Hand offsets of single people inside this shot, in stage heights (x right, y down), added to the automatic arrangement. */
  /** Target of an `insert` shot: a box relative to the person's bounding box (see framing.ts InsertBox). */
  insertBox: z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1), w: z.number().min(0.05).max(1), h: z.number().min(0.05).max(1) }).optional(),
  offsets: z.record(Id, z.object({ x: z.number().min(-2).max(2), y: z.number().min(-2).max(2) })).optional(),
  meta: MetaSchema,
});

export const BeatSchema = z.object({
  id: Id,
  /**
   * establishing = empty-scene shot (no people, dialogue hidden); silent = reaction beat with the dialogue hidden;
   * empty = people fade out, background only.
   */
  kind: z.enum(['dialogue', 'narration', 'action', 'pause', 'establishing', 'silent', 'empty']),
  /** normal | monologue (text wrapped in brackets) | offscreen (name shown as "<name>的声音"). */
  variant: z.enum(['normal', 'monologue', 'offscreen']).default('normal'),
  speakerId: Id.optional(),
  /** Extra speakers that talk together with `speakerId` (name plate "A & B"). */
  coSpeakers: z.array(Id).default([]),
  /** How the picture changes into this beat: hard cut, or a short dip to black (optionally keeping the dialogue). */
  cutIn: z.enum(['cut', 'dip_black']).default('cut'),
  cutInKeepDialog: z.boolean().default(false),
  text: z.string().default(''),
  sourceOffset: z.number().optional(),
  duration: z.object({ mode: z.enum(['auto', 'fixed']), seconds: z.number().min(0) }).default({ mode: 'auto', seconds: 0 }),
  emotion: z.string().optional(),
  shot: ShotSchema,
  style: StyleSchema,
  meta: MetaSchema,
});

// ---- channel values (intent level) -------------------------------------------------------------------------
const TurnTarget = z.union([
  z.object({ mode: z.literal('target'), target: Id }), // CastId | 'camera' | 'away'
  z.object({ mode: z.literal('angle'), yaw: z.number().min(-1).max(1), pitch: z.number().min(-1).max(1).optional() }),
]);
const GazeValue = z.union([
  z.object({ target: Id }), // CastId | 'camera' | 'down' | 'away'
  z.object({ x: z.number().min(-1).max(1), y: z.number().min(-1).max(1) }),
]);
const CameraValue = z.union([
  z.object({ shot: ShotTypeSchema, focus: z.array(Id) }),
  z.object({ manual: z.object({ x: z.number(), y: z.number(), zoom: z.number(), bgZoom: z.number().min(1).max(12).optional(), roll: z.number().min(-30).max(30).optional() }) }),
]);

/** Emotion effects (STYLE_REFERENCE section 6). `strength` 0..1 fades the effect; `roll` (degrees, signed) is the Dutch angle. */
export const FX_KINDS = ['vignette_anxiety', 'memory_glow', 'dutch'] as const;
const FxValue = z.object({ fx: z.enum(FX_KINDS), strength: z.number().min(0).max(1).default(1), roll: z.number().min(-30).max(30).default(0) });

const Key = <V extends z.ZodType>(value: V) =>
  z.object({
    id: Id,
    at: z.object({ beatId: Id, offset: z.number().default(0) }),
    value,
    duration: z.number().min(0).default(0),
    ease: EaseSchema.default('inOutQuad'),
    meta: MetaSchema,
  });

/**
 * Background track (P20): from this key on the scene shows another background. `scene.background` stays the start background.
 * purpose: move = the story changes place (people stay), insert = cut-away shot (people hidden until the next key), time = same place, other hour.
 */
export const BG_PURPOSES = ['move', 'insert', 'time'] as const;
export const BG_TRANSITIONS = ['cut', 'dip_black', 'crossfade'] as const;
const BackgroundSwitchValue = z.object({
  assetId: Id,
  framing: z.object({ zoom: z.number().min(1), offsetX: z.number(), offsetY: z.number() }).optional(),
  transition: z.enum(BG_TRANSITIONS).default('cut'),
  transitionSeconds: z.number().min(0).max(3).default(0.5),
  purpose: z.enum(BG_PURPOSES).default('move'),
});
export type BackgroundSwitch = z.infer<typeof BackgroundSwitchValue>;

const actorTarget = z.object({ kind: z.literal('actor'), castId: Id });
const track = <C extends string, T extends z.ZodType, V extends z.ZodType>(channel: C, target: T, value: V) =>
  z.object({ id: Id, target, channel: z.literal(channel), meta: MetaSchema, keys: z.array(Key(value)) });

export const TrackSchema = z.union([
  track('motion', actorTarget, z.object({ name: z.string() })),
  track('expression', actorTarget, z.object({ name: z.string().nullable() })),
  track('head', actorTarget, TurnTarget),
  track('body', actorTarget, TurnTarget),
  track('gaze', actorTarget, GazeValue),
  track('position', actorTarget, z.object({ slot: z.number().min(-1).max(1), depth: z.number().min(0).max(1) })),
  track('opacity', actorTarget, z.number().min(0).max(1)),
  track('costume', actorTarget, z.object({ modelId: Id })),
  track('camera', z.object({ kind: z.literal('camera') }), CameraValue),
  track('bgm', z.object({ kind: z.literal('audio') }), z.object({ assetId: Id.nullable(), volume: z.number().min(0).max(1).default(0.6) })),
  track('se', z.object({ kind: z.literal('audio') }), z.object({ assetId: Id, volume: z.number().min(0).max(1).default(0.8) })),
  track('fade', z.object({ kind: z.literal('screen') }), z.object({ color: z.enum(['black', 'white']), alpha: z.number().min(0).max(1) })),
  track('fx', z.object({ kind: z.literal('screen') }), FxValue),
  track('background', z.object({ kind: z.literal('stage') }), BackgroundSwitchValue),
]);
export type Track = z.infer<typeof TrackSchema>;
export type Channel = Track['channel'];

export const TransitionSchema = z.object({
  kind: z.enum(['cut', 'fade_black', 'fade_white', 'crossfade', 'wipe', 'dip_black', 'scene_black']),
  duration: z.number().min(0),
  meta: MetaSchema,
});
export type Transition = z.infer<typeof TransitionSchema>;

export const SceneSchema = z.object({
  id: Id,
  title: z.string(),
  sourceSpan: z.object({ start: z.number(), end: z.number() }).default({ start: 0, end: 0 }),
  meta: MetaSchema,
  background: z.object({
    assetId: Id,
    framing: z.object({ zoom: z.number().min(1), offsetX: z.number(), offsetY: z.number() }).default({ zoom: 1, offsetX: 0, offsetY: 0 }),
    meta: MetaSchema,
  }),
  wardrobe: z.record(Id, z.object({ modelId: Id, meta: MetaSchema })),
  blocking: z.record(
    Id,
    z.object({
      slot: z.number().min(-1).max(1),
      depth: z.number().min(0).max(1),
      /** Not on stage until this beat; then fades in (and slides in from `side`). */
      enter: z.object({ beatId: Id, side: z.enum(['left', 'right', 'none']).default('none') }).optional(),
      /** Fades out at the start of this beat and stays away. */
      exit: z.object({ beatId: Id }).optional(),
      meta: MetaSchema,
    }),
  ),
  transitionIn: TransitionSchema,
  /** Place-name banner shown over the establishing shot after a scene change. */
  location: z.object({ text: z.string(), show: z.boolean().default(true), meta: MetaSchema }).optional(),
  style: StyleSchema,
  audio: z.object({
    bgm: z.object({ assetId: Id, volume: z.number().min(0).max(1), meta: MetaSchema }).optional(),
    ambience: z.object({ assetId: Id, volume: z.number().min(0).max(1), meta: MetaSchema }).optional(),
  }).default({}),
  /** What the director knows about the scene (set by the AI breakdown; read by scene direction). */
  brief: z.object({ moves: z.array(z.object({ paragraph: z.number().int(), backgroundId: Id, reason: z.string().default(''), transition: z.enum(['cut', 'dip_black', 'crossfade']).default('cut') })).optional(), timeOfDay: z.string().default(''), mood: z.string().default(''), isPerformance: z.boolean().default(false), band: z.string().nullable().default(null), guestOf: z.string().nullable().optional() }).optional(),
  beats: z.array(BeatSchema),
  tracks: z.array(TrackSchema).default([]),
  /** Highest id number ever issued per prefix (beats, tracks, keys): ids of deleted units are never reused. */
  idSeq: z.record(z.string(), z.number().int()).optional(),
});

export const ProjectSchema = z.object({
  schemaVersion: z.literal(1),
  id: Id,
  title: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
  catalogVersion: z.string().default(''),
  settings: z.object({
    aspect: z.literal('16:9'),
    fps: z.number().int().positive(),
    textSpeedCps: z.number().positive(),
    defaultLineGap: z.number().min(0),
  }),
  source: z.object({ text: z.string(), format: z.enum(['novel', 'script']) }),
  cast: z.array(CastMemberSchema),
  scenes: z.array(SceneSchema),
  style: StyleSchema,
  generation: z.object({ runs: z.array(z.unknown()) }).default({ runs: [] }),
  /** Highest id number ever issued per prefix (scenes, cast). */
  idSeq: z.record(z.string(), z.number().int()).optional(),
});
export type Project = z.infer<typeof ProjectSchema>;
export type Scene = z.infer<typeof SceneSchema>;
export type Beat = z.infer<typeof BeatSchema>;
export type CastMember = z.infer<typeof CastMemberSchema>;
