/** Output schemas of the two AI passes. Intent only: no coordinates, no file names, only ids the server offered. */
import { z } from 'zod';
import { AI_FX, AI_KINDS, AI_MOVES, AI_SHOT_TYPES, AI_TRANSITIONS, DEPTH_NAMES, EMOTIONS, INSERT_TARGETS, SLOT_NAMES } from '../director/vocab';

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
      cutIn: z.enum(['cut', 'dip_black']),
      fx: z.enum(AI_FX),
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
export type SceneDirection = z.infer<typeof SceneDirectionSchema>;
export type DirectedBeat = SceneDirection['beats'][number];
