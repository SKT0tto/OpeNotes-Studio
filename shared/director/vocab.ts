/** The intent vocabulary of the AI director (everything the model may say) and its fixed numeric meaning. */
import { EMOTION_TAGS } from '../timeline/compile';

export const SLOT_NAMES = ['far_left', 'left', 'center_left', 'center', 'center_right', 'right', 'far_right'] as const;
export type SlotName = (typeof SLOT_NAMES)[number];
/** Horizontal slot -> `blocking.slot` (-1 left .. 1 right). */
export const SLOT_X: Record<SlotName, number> = { far_left: -0.85, left: -0.55, center_left: -0.25, center: 0, center_right: 0.25, right: 0.55, far_right: 0.85 };

export const DEPTH_NAMES = ['front', 'mid', 'back'] as const;
export type DepthName = (typeof DEPTH_NAMES)[number];
/** Depth word -> `blocking.depth` (0 front .. 1 back). */
export const DEPTH_Y: Record<DepthName, number> = { front: 0.08, mid: 0.3, back: 0.6 };

export const EMOTIONS = EMOTION_TAGS as readonly string[] as readonly [string, ...string[]];
/** Shot sizes the AI may use (STYLE_REFERENCE vocabulary; `establishing` is added by compile, not by the model). */
export const AI_SHOT_TYPES = ['group', 'two_shot', 'mcu', 'cu', 'ecu', 'insert'] as const;
/** The travel camera system also has the medium shot `ms` (the original's most common single shot); the classic vocabulary stays as it was. */
export const AI_TRAVEL_SHOT_TYPES = ['group', 'two_shot', 'ms', 'mcu', 'cu', 'ecu', 'insert'] as const;
export const AI_MOVES = ['static', 'push_in', 'pull_out'] as const;
/** Camera-flow intent of a beat (travel camera system only): auto = the program decides, cut = hard cut, move = travel from the previous shot. */
export const AI_SHOT_FLOWS = ['auto', 'cut', 'move'] as const;
export { SHOT_INTENTS, type ShotIntent } from '../staging/shotIntent';
export const AI_KINDS = ['dialogue', 'narration', 'silent'] as const;
export const AI_FX = ['none', 'vignette_anxiety', 'memory', 'dim', 'flash', 'shake', 'daze', 'dutch'] as const;
/** What a model may still write (an old cached answer, a recorded fixture): `memory_glow` is read as `memory` and never produced. */
export const AI_FX_PARSE = [...AI_FX, 'memory_glow'] as const;
/** Effects that are a single event, not a state: they never switch the running vignette / memory / dim off. */
export const ONE_SHOT_FX = ['flash', 'shake'] as const;
/** Cue words that allow a `memory` span (a flashback must be in the text); the rule director uses the narrower RULE_MEMORY_CUE. */
export const MEMORY_CUE = /回忆|闪回|那时|那个时候|那一年|以前|从前(?![排面门方台座])|小时候|年前|当初|当年|曾经|往事|想起|回想|忆起|记得|梦见|旧照|老照片/;
export const RULE_MEMORY_CUE = /回忆起|回想起|想起了|那时候|那个时候|数年前|几年前|多年前|小时候|闪回|当年|当初|从前(?![排面门方台座])/;
/** A paragraph that ends a memory (back to the present). */
export const RULE_MEMORY_END_CUE = /回过神|回到现实|回到现在|回到了现在|梦醒|从回忆|睁开眼|醒了过来|现在的|如今/;
/** The rule director's reaction cue for a short shake, and the inner-voice marker (a bracketed beat). */
export const RULE_SHAKE_CUE = /吓|惊|猛地|拍桌|撞上|撞到|猛然|一颤|哆嗦/;
export const MONOLOGUE_TEXT = /^\s*[（(]/;
/** The longest run of dimmed beats (the original only dims one or two lines of inner voice) and of rule-derived memory beats. */
export const MAX_DIM_BEATS = 4;
export const MAX_RULE_MEMORY_BEATS = 12;
export const AI_TRANSITIONS = ['cut', 'dip_black', 'scene_black'] as const;
export const SPECIAL_ATTENTION = ['camera', 'away', 'down'] as const;

/** Nearest slot name of a numeric slot (for showing an existing blocking back to the model). */
export function slotNameOf(x: number): SlotName {
  return SLOT_NAMES.reduce((best, n) => (Math.abs(SLOT_X[n] - x) < Math.abs(SLOT_X[best] - x) ? n : best), 'center' as SlotName);
}
export function depthNameOf(d: number): DepthName {
  return DEPTH_NAMES.reduce((best, n) => (Math.abs(DEPTH_Y[n] - d) < Math.abs(DEPTH_Y[best] - d) ? n : best), 'mid' as DepthName);
}

/** What an `insert` shot is aimed at (maps to a target box relative to the person; an insert never shows an empty torso). */
/** `scene` = no person: a cut-away to a sky / signal / crossing background (the people are hidden for it). */
export const INSERT_TARGETS = ['hands', 'instrument', 'face_lower', 'scene'] as const;
export type InsertTarget = (typeof INSERT_TARGETS)[number];
export const INSERT_BOX: Record<InsertTarget, { x: number; y: number; w: number; h: number }> = {
  hands: { x: 0.12, y: 0.4, w: 0.76, h: 0.26 },
  instrument: { x: 0.08, y: 0.34, w: 0.84, h: 0.34 },
  face_lower: { x: 0.18, y: 0.08, w: 0.64, h: 0.3 },
  scene: { x: 0.15, y: 0.26, w: 0.7, h: 0.26 },
};
export const AI_BG_TRANSITIONS = ['cut', 'dip_black', 'dip_white', 'crossfade'] as const;
/** Most background moves one scene may have (Pass 1), and the most switches the continuity check tolerates. */
export const MAX_BG_MOVES = 3;
export const MAX_BG_SWITCHES = 6;
