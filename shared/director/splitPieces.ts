/**
 * Turning the pieces of a split long line into directed beats (pure, shared by the director's split pass and its tests).
 *
 *  - `repairPieces`: the soft repair of what a model (or the rule splitter) decided for each piece: motion / expression names are
 *    mapped to real ones, an invalid attention or reaction is dropped, at most one piece per line asks for a camera change and it
 *    needs a concrete reason. None of this is an error: the text itself is checked elsewhere (`checkPieces`).
 *  - `applySplitPlans`: the first piece replaces the original beat (its text and, if the plan says so, its emotion; the shot and the
 *    performance stay), the later pieces are continuations: the same speaker, a hard cut, no background switch, no enter / exit, the
 *    held shot (or a deliberate `closer` / `reaction` one), and `splitOf` = the index of the first piece.
 */
import type { DirectedBeat, LineSplit, SceneDirection } from '../schema/ai';
import { SPECIAL_ATTENTION, ONE_SHOT_FX } from './vocab';

export type SplitBy = 'ai' | 'retry' | 'rule';
export type PieceCamera = 'hold' | 'closer' | 'reaction';

export interface PieceActor {
  motion: string | null;
  expression: string | null;
  attention: string | null;
}
/** What is decided for one piece of a split line. */
export interface PieceDecision {
  text: string;
  emotion: string;
  /** Why the cut is here (the reason of the continuation beat). */
  why: string;
  camera: PieceCamera;
  /** With `reaction`: the listener's castId. */
  reactionOf: string | null;
  actor: PieceActor | null;
}
export interface SplitPlan {
  /** Index of the long line in the direction's beats (before any piece is inserted). */
  index: number;
  pieces: PieceDecision[];
  by: SplitBy;
}

type RawPiece = LineSplit['lines'][number]['pieces'][number];

export interface RepairCtx {
  /** The speaker of the line; null for a narration. */
  speaker: string | null;
  /** Who is on stage while the line plays. */
  onStage: ReadonlySet<string>;
  /** The emotion of the original beat (used when a piece has none we know). */
  emotion: string;
  /** The real name for a motion / expression a model asked for (null = none fits). */
  resolveMotion(wanted: string, emotion: string): string | null;
  resolveExpression(wanted: string, emotion: string): string | null;
  /** `第 3 句` or the like, in front of every warning. */
  where: string;
}

/** "需要运镜", "强调" and the like say nothing about the story. */
export function vagueReason(why: string): boolean {
  const t = why.replace(/[\s，。,.！!？?、…：:；;（）()「」]/gu, '');
  return [...t].length < 4 || /^(需要|为了|用于)?(运镜|强调|突出|特写|拉近|收紧|给反应|反应|切镜|换镜头|镜头)$/u.test(t);
}

const cleanWhy = (s: string | undefined): string => (s ?? '').trim().slice(0, 40);

/**
 * Soft repair of the pieces of one line. The first piece keeps the director's camera and performance; for the later ones the
 * performance names are mapped to real ones and the camera intent is checked. Returns the decisions and a warning for every repair.
 */
export function repairPieces(pieces: readonly RawPiece[], texts: readonly string[], ctx: RepairCtx): { pieces: PieceDecision[]; warnings: string[] } {
  const warnings: string[] = [];
  let nonHold = 0;
  const out = pieces.map((p, k): PieceDecision => {
    const n = k + 1;
    const emotion = p.emotion || ctx.emotion;
    const text = texts[k] ?? p.text;
    const why = cleanWhy(p.why);
    if (k === 0) return { text, emotion, why, camera: 'hold', reactionOf: null, actor: null };
    // performance of the speaker
    let actor: PieceActor | null = null;
    if (p.actor && ctx.speaker) {
      const motion = p.actor.motion ? ctx.resolveMotion(p.actor.motion, emotion) : null;
      const expression = p.actor.expression ? ctx.resolveExpression(p.actor.expression, emotion) : null;
      let attention: string | null = p.actor.attention || null;
      if (attention && !((SPECIAL_ATTENTION as readonly string[]).includes(attention) || (ctx.onStage.has(attention) && attention !== ctx.speaker))) {
        warnings.push(`${ctx.where}第 ${n} 段的视线对象「${attention}」不在台上，已去掉`);
        attention = null;
      }
      if (motion || expression || attention) actor = { motion, expression, attention };
    }
    // camera intent: rare, one per line at most, and with a story reason
    let camera: PieceCamera = p.camera;
    let reactionOf: string | null = p.reactionOf ?? null;
    if (camera !== 'hold') {
      let drop: string | null = null;
      if (!ctx.speaker) drop = '旁白没有说话人，镜头保持不变';
      else if (vagueReason(why)) drop = '没有写出具体的故事理由';
      else if (nonHold >= 1) drop = '同一句台词最多一段改变镜头';
      else if (camera === 'reaction' && !(reactionOf && ctx.onStage.has(reactionOf) && reactionOf !== ctx.speaker)) drop = '听者不在台上';
      if (drop) {
        warnings.push(`${ctx.where}第 ${n} 段的镜头意图 ${camera} 被降级为保持：${drop}`);
        camera = 'hold';
      } else nonHold++;
    }
    if (camera !== 'reaction') reactionOf = null;
    return { text, emotion, why, camera, reactionOf, actor };
  });
  return { pieces: out, warnings };
}

/** One step tighter, speaker alone (a `closer` continuation). */
export const TIGHTER: Partial<Record<DirectedBeat['shot']['type'], DirectedBeat['shot']['type']>> = { group: 'mcu', two_shot: 'mcu', ms: 'mcu', mcu: 'cu', cu: 'ecu', ecu: 'ecu' };

const CONTINUOUS_FX_BLOCK = new Set<string>(ONE_SHOT_FX);

/**
 * `closer`: the closer continuation just before (null when there is none). A `hold` piece after it keeps that tighter framing: going
 * back to the head's framing would be a push and a return with no reason in the story.
 */
function continuation(head: DirectedBeat, p: PieceDecision, travel: boolean, headIndex: number, closer: DirectedBeat | null = null): DirectedBeat {
  const dialogue = head.kind === 'dialogue' && !!head.speaker;
  const hs = p.camera === 'hold' && closer ? closer.shot : head.shot;
  let shot: DirectedBeat['shot'] = { ...hs, focus: [...hs.focus], move: 'static', dof: hs.dof };
  let intent: NonNullable<DirectedBeat['shot']['intent']> = 'continue';
  let flow: NonNullable<DirectedBeat['shot']['flow']> = 'auto';
  if (p.camera === 'closer' && dialogue && hs.type !== 'insert' && TIGHTER[hs.type]) {
    shot = { ...hs, type: TIGHTER[hs.type]!, focus: [head.speaker!], move: 'static', dof: null, insertTarget: null };
    intent = 'emphasis';
  } else if (p.camera === 'reaction' && dialogue && p.reactionOf) {
    shot = { ...hs, type: 'cu', focus: [p.reactionOf], move: 'static', dof: null, insertTarget: null };
    intent = 'reaction';
    flow = 'cut';
  }
  if (travel) {
    shot.intent = intent;
    shot.flow = flow;
  } else {
    delete shot.intent;
    delete shot.flow;
  }
  const actors: DirectedBeat['actors'] = p.actor && head.speaker
    ? [{ castId: head.speaker, motion: p.actor.motion, expression: p.actor.expression, attention: p.actor.attention, enter: false, exit: false, move: null }]
    : [];
  const fx = CONTINUOUS_FX_BLOCK.has(head.fx) ? 'none' : head.fx;
  const out: DirectedBeat = {
    keepId: null, paragraph: head.paragraph, kind: head.kind, speaker: head.speaker, text: p.text, emotion: p.emotion as DirectedBeat['emotion'],
    reason: p.why || '长句续行', shot, cutIn: 'cut', fx, actors, splitOf: headIndex,
  };
  if (head.memoryTone !== undefined) out.memoryTone = head.memoryTone;
  return out;
}

/**
 * Insert the pieces of the planned lines into a direction. Returns a new direction (the input is not touched). `costumeChanges` follow
 * the beats they belong to; `splitOf` of every continuation is the index of its first piece in the new beat list.
 */
export function applySplitPlans(d: SceneDirection, plans: readonly SplitPlan[], opts: { travel: boolean }): SceneDirection {
  if (plans.length === 0) return d;
  const byIndex = new Map(plans.map((p) => [p.index, p]));
  const beats: DirectedBeat[] = [];
  const newIndex: number[] = [];
  d.beats.forEach((b, i) => {
    newIndex[i] = beats.length;
    const plan = byIndex.get(i);
    if (!plan || plan.pieces.length < 2) {
      beats.push(b);
      return;
    }
    const first = plan.pieces[0]!;
    const head: DirectedBeat = { ...b, text: first.text, emotion: first.emotion as DirectedBeat['emotion'] };
    beats.push(head);
    let closer: DirectedBeat | null = null;
    for (const p of plan.pieces.slice(1)) {
      const c = continuation(head, p, opts.travel, newIndex[i]!, closer);
      if (p.camera === 'closer' && c.shot.type !== head.shot.type) closer = c;
      else if (p.camera === 'reaction') closer = null;
      beats.push(c);
    }
  });
  return { ...d, beats, costumeChanges: d.costumeChanges.map((c) => ({ ...c, beatIndex: newIndex[c.beatIndex] ?? c.beatIndex })) };
}
