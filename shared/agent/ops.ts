/**
 * AgentOp: the concretised, deterministic edit an agent turn produces. The model only talks to tools (intent level, no coordinates);
 * the server resolves every tool call to ops with absolute values, validates them (`check.ts`) and applies them to a sandbox
 * (`apply.ts`). The client replays the same ops with the same pure function inside one `applyEdit`.
 *
 * A small number of generic, schema-driven ops cover every field the editor exposes:
 *   beat_set / beat_insert / beat_delete / beat_move / beat_split / beat_merge   text, speaker, kind, emotion, duration, cut-in, structure
 *   beat_split_pieces / dialog_expand                                           a too-long line cut into consecutive beats of the same speaker / shown in full (only when the user asked)
 *   shot_set / shot_offset                                                      size, focus, move, dof, intent, flow, insert box, per-person offsets
 *   key_set / key_shift                                                         ANY timeline key (motion, expression, head, body, gaze, position, costume, camera, fx, fade, background ...)
 *   fx_range                                                                    an effect over a span of beats (memory enters through white)
 *   actor_presence / stage_set / wardrobe_set                                   who is in the scene, enter / exit, start position, outfit
 *   timing                                                                      rhythm overrides of beats (its own lockable unit: beat.style)
 *   bg_set / scene_set / lock_set
 */
import { z } from 'zod';
import { AI_FX } from '../director/vocab';
import { BG_PURPOSES, BG_TRANSITIONS, DAZE_VARIANTS, EaseSchema, MEMORY_EDGES, MEMORY_TONES } from '../schema/project';

const Id = z.string().min(1);
const Ref = { sceneId: Id };
const common = { reason: z.string().max(200).optional(), overrideUser: z.boolean().optional() };

export const BEAT_KINDS = ['dialogue', 'narration', 'action', 'pause', 'silent', 'empty'] as const;
export const SHOT_SET = z.object({
  type: z.string().optional(),
  focus: z.array(Id).optional(),
  move: z.enum(['static', 'push_in', 'pull_out', 'pan', 'track', 'shake']).optional(),
  dof: z.number().int().min(0).max(6).nullable().optional(),
  /** Raw `shot.transition`; null = automatic (flow cut = 'cut', move = 'travel'). */
  transition: z.enum(['cut', 'glide', 'travel']).nullable().optional(),
  intent: z.string().nullable().optional(),
  insertBox: z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1), w: z.number().min(0.05).max(1), h: z.number().min(0.05).max(1) }).nullable().optional(),
}).strict();

const TrackTargetSchema = z.union([z.object({ kind: z.literal('actor'), castId: Id }), z.object({ kind: z.enum(['camera', 'screen', 'stage', 'audio']) })]);
export const KEY_CHANNELS = ['motion', 'expression', 'head', 'body', 'gaze', 'position', 'opacity', 'costume', 'camera', 'fx', 'fade', 'background'] as const;

export const AgentOpSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('beat_set'), ...Ref, beatId: Id, ...common, set: z.object({
    text: z.string().optional(), speakerId: Id.nullable().optional(), kind: z.enum(BEAT_KINDS).optional(), variant: z.enum(['normal', 'monologue', 'offscreen']).optional(),
    emotion: z.string().nullable().optional(), cutIn: z.enum(['cut', 'dip_black', 'dip_white']).optional(), cutInKeepDialog: z.boolean().optional(),
    coSpeakers: z.array(Id).optional(), duration: z.object({ mode: z.enum(['auto', 'fixed']), seconds: z.number().min(0).max(120) }).optional(),
  }).strict() }),
  z.object({ op: z.literal('beat_insert'), ...Ref, afterBeatId: Id.nullable(), newId: Id, ...common, beat: z.object({ kind: z.enum(BEAT_KINDS), text: z.string(), speakerId: Id.optional(), emotion: z.string().optional() }) }),
  z.object({ op: z.literal('beat_delete'), ...Ref, beatId: Id, ...common }),
  z.object({ op: z.literal('beat_move'), ...Ref, beatId: Id, afterBeatId: Id.nullable(), ...common }),
  z.object({ op: z.literal('beat_split'), ...Ref, beatId: Id, at: z.number().int().min(1), newId: Id, ...common }),
  z.object({ op: z.literal('beat_merge'), ...Ref, beatId: Id, ...common }),
  /** The assistant's own cut of a line that does not fit the dialogue area: `pieces` (2-4, verbatim from the text) and one new id per later piece. The later pieces get `splitFrom` = the first piece. */
  z.object({ op: z.literal('beat_split_pieces'), ...Ref, beatId: Id, pieces: z.array(z.object({ text: z.string().min(1), emotion: z.string().optional() })).min(2).max(4), newIds: z.array(Id).min(1).max(3), ...common }),
  /** `on` = show the whole line (`Beat.overflow = 'expand'`); false clears it. Only when the user asked (CheckCtx.allowDialogExpand). */
  z.object({ op: z.literal('dialog_expand'), ...Ref, beatId: Id, on: z.boolean(), ...common }),
  z.object({ op: z.literal('shot_set'), ...Ref, beatId: Id, ...common, set: SHOT_SET }),
  z.object({ op: z.literal('shot_offset'), ...Ref, beatId: Id, castId: Id, offset: z.object({ x: z.number().min(-2).max(2), y: z.number().min(-2).max(2) }).nullable(), ...common }),
  z.object({ op: z.literal('key_set'), ...Ref, target: TrackTargetSchema, channel: z.enum(KEY_CHANNELS), keyId: Id.optional(), newKeyId: Id.optional(), at: z.object({ beatId: Id, offset: z.number().min(-10).max(60) }).optional(), value: z.unknown().optional(), duration: z.number().min(0).max(30).optional(), ease: EaseSchema.optional(), remove: z.boolean().optional(), ...common }),
  z.object({ op: z.literal('key_shift'), ...Ref, keyId: Id, seconds: z.number().min(-30).max(30), ...common }),
  z.object({ op: z.literal('fx_range'), ...Ref, fromBeatId: Id, toBeatId: Id, fx: z.enum(AI_FX), tone: z.enum(MEMORY_TONES).optional(), edge: z.enum(MEMORY_EDGES).optional(), variant: z.enum(DAZE_VARIANTS).optional(), strength: z.number().min(0).max(1).optional(), roll: z.number().min(-30).max(30).optional(), includeProtected: z.boolean().optional(), ...common }),
  z.object({ op: z.literal('actor_presence'), ...Ref, castId: Id, present: z.boolean(), modelId: Id.optional(), slot: z.number().min(-1).max(1).optional(), ...common }),
  z.object({ op: z.literal('stage_set'), ...Ref, castId: Id, ...common,
    enter: z.object({ beatId: Id, side: z.enum(['left', 'right', 'none']).default('none') }).nullable().optional(), exit: z.object({ beatId: Id }).nullable().optional(),
    slot: z.number().min(-1).max(1).optional(), depth: z.number().min(0).max(1).optional() }),
  z.object({ op: z.literal('wardrobe_set'), ...Ref, castId: Id, modelId: Id, ...common }),
  z.object({ op: z.literal('timing'), ...Ref, beatIds: z.array(Id).min(1).max(120), ...common, set: z.record(z.string(), z.number()), clear: z.boolean().optional() }),
  z.object({ op: z.literal('bg_set'), ...Ref, at: z.union([z.literal('start'), Id]), assetId: Id.nullable(), transition: z.enum(BG_TRANSITIONS).optional(), transitionSeconds: z.number().min(0).max(3).optional(), purpose: z.enum(BG_PURPOSES).optional(), location: z.string().optional(), ...common }),
  z.object({ op: z.literal('scene_set'), ...Ref, ...common, set: z.object({
    title: z.string().min(1).optional(), cameraSystem: z.enum(['inherit', 'classic', 'travel']).optional(), mood: z.string().optional(), timeOfDay: z.string().optional(),
    transitionIn: z.object({ kind: z.enum(['cut', 'fade_black', 'fade_white', 'crossfade', 'wipe', 'dip_black', 'scene_black']), duration: z.number().min(0).max(10) }).optional(),
    location: z.object({ text: z.string().optional(), show: z.boolean().optional() }).optional(),
  }).strict() }),
  z.object({ op: z.literal('lock_set'), ...Ref, unit: z.enum(['scene', 'beat', 'shot', 'rhythm', 'wardrobe', 'blocking', 'track', 'key']), beatId: Id.optional(), castId: Id.optional(), trackId: Id.optional(), keyId: Id.optional(), locked: z.boolean().optional(), lockedFields: z.array(z.string()).nullable().optional(), ...common }),
]);
export type AgentOp = z.infer<typeof AgentOpSchema>;
export type OpName = AgentOp['op'];

export type AgentScope = 'camera' | 'performance' | 'costume' | 'staging' | 'fx' | 'background' | 'structure' | 'rhythm' | 'lock';
export const AGENT_SCOPE_LABEL: Record<AgentScope, string> = { camera: '镜头', performance: '表演', costume: '服装', staging: '站位 / 进出场', fx: '特效', background: '背景', structure: '台词 / 场景', rhythm: '节奏', lock: '锁定' };

/** What the op is about, for grouping in the change card (and for the live-mode filter). */
export function scopeOf(op: AgentOp): AgentScope {
  switch (op.op) {
    case 'shot_set': case 'shot_offset': return 'camera';
    case 'beat_set': {
      const k = Object.keys(op.set);
      if (k.length > 0 && k.every((x) => x === 'emotion')) return 'performance';
      if (k.length > 0 && k.every((x) => x === 'cutIn' || x === 'cutInKeepDialog')) return 'camera';
      if (k.length > 0 && k.every((x) => x === 'duration')) return 'rhythm';
      return 'structure';
    }
    case 'beat_insert': case 'beat_delete': case 'beat_move': case 'beat_split': case 'beat_split_pieces': case 'dialog_expand': case 'beat_merge': case 'scene_set': return 'structure';
    case 'key_shift': return 'performance';
    case 'key_set': return op.channel === 'camera' ? 'camera' : op.channel === 'fx' || op.channel === 'fade' ? 'fx' : op.channel === 'background' ? 'background' : op.channel === 'costume' ? 'costume' : op.channel === 'position' || op.channel === 'opacity' ? 'staging' : 'performance';
    case 'fx_range': return 'fx';
    case 'actor_presence': case 'stage_set': return 'staging';
    case 'wardrobe_set': return 'costume';
    case 'timing': return 'rhythm';
    case 'bg_set': return 'background';
    case 'lock_set': return 'lock';
  }
}

/** Op kinds the 「实时」 auto-apply never takes: entrances, exits, background and structure changes, locks. */
export function liveForbidden(op: AgentOp): boolean {
  if (op.op === 'bg_set' || op.op === 'actor_presence' || op.op === 'beat_insert' || op.op === 'beat_delete' || op.op === 'beat_split' || op.op === 'beat_split_pieces' || op.op === 'dialog_expand' || op.op === 'beat_merge' || op.op === 'beat_move' || op.op === 'lock_set') return true;
  if (op.op === 'stage_set') return op.enter !== undefined || op.exit !== undefined;
  if (op.op === 'key_set') return op.channel === 'background' || op.channel === 'opacity';
  return false;
}
