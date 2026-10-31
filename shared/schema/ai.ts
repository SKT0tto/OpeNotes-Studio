/** Output schemas of the two AI passes. Intent only: no coordinates, no file names, only ids the server offered. */
import { z } from 'zod';
import { MEMORY_TONES } from './project';
import { AI_BG_TRANSITIONS, AI_FX_PARSE, AI_KINDS, AI_MOVES, AI_SHOT_FLOWS, SHOT_INTENTS, AI_SHOT_TYPES, AI_TRANSITIONS, AI_TRAVEL_SHOT_TYPES, DEPTH_NAMES, EMOTIONS, INSERT_TARGETS, SLOT_NAMES } from '../director/vocab';

/** A place change inside a scene: from `paragraph` on the story is at `backgroundId`. */
export const BgMoveSchema = z.object({ paragraph: z.number().int(), backgroundId: z.string(), reason: z.string(), transition: z.enum(AI_BG_TRANSITIONS) });
export type BgMove = z.infer<typeof BgMoveSchema>;

// ---- Pass 1: breakdown ------------------------------------------------------------------------------------------
export const BreakdownSchema = z.object({
  cast: z.array(z.object({ nameInText: z.string(), characterKey: z.string().nullable(), evidence: z.string() })),
  scenes: z.array(
    z.object({
      title: z.string(),
      /** Paragraph numbers (inclusive) of the input. */
      startParagraph: z.number().int(),
      endParagraph: z.number().int(),
      location: z.object({ backgroundId: z.string(), reason: z.string(), /** characterKey of the host when the scene is a visit to someone's home ("去爱音家"); otherwise null. */ guestOf: z.string().nullable().optional() }),
      timeOfDay: z.string(),
      /** characterKeys on stage. */
      presentCast: z.array(z.string()),
      wardrobe: z.array(z.object({ characterKey: z.string(), modelId: z.string(), reason: z.string() })),
      mood: z.string(),
      isPerformance: z.boolean(),
      band: z.string().nullable(),
      /** Place changes INSIDE the scene that the text states outright ("走出校门" "回到房间"); empty / absent when the scene stays in one place. At most 3. */
      moves: z.array(BgMoveSchema).optional(),
    }),
  ),
});
export type Breakdown = z.infer<typeof BreakdownSchema>;

// ---- Pass 2: scene direction ------------------------------------------------------------------------------------
const Slot = z.enum(SLOT_NAMES);
const Depth = z.enum(DEPTH_NAMES);

export const SceneDirectionSchema = z.object({
  /** Short rationale of the whole scene's direction. */
  reason: z.string(),
  blocking: z.array(z.object({ castId: z.string(), slot: Slot, depth: Depth })),
  transitionIn: z.enum(AI_TRANSITIONS),
  bgm: z.string().nullable(),
  beats: z.array(
    z.object({
      /** Id of an existing fixed beat this one reproduces (locked / hand-made beats and partial regeneration); null for new beats. */
      keepId: z.string().nullable(),
      paragraph: z.number().int(),
      kind: z.enum(AI_KINDS),
      speaker: z.string().nullable(),
      text: z.string(),
      emotion: z.enum(EMOTIONS),
      reason: z.string(),
      shot: z.object({ type: z.enum(AI_SHOT_TYPES), focus: z.array(z.string()), move: z.enum(AI_MOVES), dof: z.number().int().nullable(), insertTarget: z.enum(INSERT_TARGETS).nullable().optional() }),
      cutIn: z.enum(['cut', 'dip_black', 'dip_white']),
      /** Switch the background at this beat: only a background of this scene's set (start, moves, insert candidates). null = keep. */
      bg: z.object({ backgroundId: z.string(), transition: z.enum(AI_BG_TRANSITIONS) }).nullable().optional(),
      fx: z.enum(AI_FX_PARSE),
      /** Only read when fx = memory: the grade of the memory (cool = default, warm = long ago). */
      memoryTone: z.enum(MEMORY_TONES).nullable().optional(),
      /** Strength of a one-shot shake (0..1, default 0.5); the rule director's reaction shake is a small 0.3. */
      fxStrength: z.number().min(0).max(1).nullable().optional(),
      actors: z.array(
        z.object({
          castId: z.string(),
          motion: z.string().nullable(),
          expression: z.string().nullable(),
          /** castId | camera | away | down */
          attention: z.string().nullable(),
          enter: z.boolean(),
          exit: z.boolean(),
          move: Slot.nullable(),
        }),
      ),
    }),
  ),
  costumeChanges: z.array(z.object({ beatIndex: z.number().int(), castId: z.string(), modelId: z.string(), reason: z.string() })),
});
/** Travel camera system: the same direction plus the `shot.flow` intent. A classic answer (no flow) satisfies it as well. */
const SceneBeat = SceneDirectionSchema.shape.beats.element;
const TravelShot = SceneBeat.shape.shot.extend({
  type: z.enum(AI_TRAVEL_SHOT_TYPES),
  /** A word that is not a flow (models write `continue` here, which is an intent) means `auto`; it must not cost a repair call. */
  flow: z.enum(AI_SHOT_FLOWS).nullable().optional().catch('auto'),
  intent: z.enum(SHOT_INTENTS).nullable().optional(),
});
export const SceneDirectionTravelSchema = SceneDirectionSchema.extend({ beats: z.array(SceneBeat.extend({ shot: TravelShot })) });
type ModelDirection = z.infer<typeof SceneDirectionTravelSchema>;
/**
 * One beat of a direction. `splitOf` is set by the long-line split step on the later pieces of a line it cut: the index (in the same
 * `beats` array) of the first piece. It is not part of the model's schema; `expandScene` turns it into `Beat.splitFrom`.
 */
export type DirectedBeat = ModelDirection['beats'][number] & { splitOf?: number | undefined };
export type SceneDirection = Omit<ModelDirection, 'beats'> & { beats: DirectedBeat[] };

// ---- Long-line split: the second, small call (one per scene) that cuts lines that do not fit the dialogue area ----------------
export const SPLIT_CAMERAS = ['hold', 'closer', 'reaction'] as const;
export const LineSplitSchema = z.object({
  lines: z.array(
    z.object({
      id: z.string(),
      pieces: z.array(
        z.object({
          /** The piece of the original text, verbatim. */
          text: z.string(),
          /** Why the cut is here (<= 20 characters); required for a piece that is not 'hold'. */
          why: z.string(),
          emotion: z.enum(EMOTIONS),
          /** The first piece keeps the director's camera and ignores this. A word that is not a camera intent means hold. */
          camera: z.enum(SPLIT_CAMERAS).catch('hold'),
          /** With camera = reaction: the listener's castId. */
          reactionOf: z.string().nullable().optional(),
          /** The speaker's performance in this piece (ignored for the first piece); null = no change. */
          actor: z.object({ motion: z.string().nullable(), expression: z.string().nullable(), attention: z.string().nullable() }).nullable().optional(),
        }),
      ),
    }),
  ),
});
export type LineSplit = z.infer<typeof LineSplitSchema>;
