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
export const AI_FX = ['none', 'vignette_anxiety', 'memory_glow', 'dutch'] as const;
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
export const AI_BG_TRANSITIONS = ['cut', 'dip_black', 'crossfade'] as const;
/** Most background moves one scene may have (Pass 1), and the most switches the continuity check tolerates. */
export const MAX_BG_MOVES = 3;
export const MAX_BG_SWITCHES = 6;
/** Text that gives an insert something to show (hands, gestures, props, instruments). */
export const INSERT_HINT = /手|指|掌|拳|握|攥|拿|捏|抱着|琴|吉他|贝斯|鼓|键盘|话筒|麦克风|拨片|琴弦|琴键|杯|书|笔|信|手机|票|门把|纸|耳机|线缆|乐谱/;
