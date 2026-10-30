/**
 * Which agent edits change the PICTURE (and so must be looked at after the edit), and the shape of the verification the change card shows.
 * Pure: the loop (server/agent/loop.ts) uses it to force a capture_frames call; the card reads `Verification`.
 */
import type { Project } from '../schema/project';
import { beatLineInfo } from './lines';
import type { AgentOp } from './ops';

/** Key channels that change what is on screen. Motion / expression / gaze are performance details and are not re-checked by picture. */
const PICTURE_CHANNELS = new Set(['position', 'opacity', 'head', 'body', 'camera', 'background', 'fx', 'fade', 'costume']);

/** Shot, offset, move, dof, actor slot / depth / facing / head tilt / enter / exit / presence, background, fx, camera keys, costume, camera system. Not text, rhythm, emotion, labels or locks. */
export function changesPicture(op: AgentOp): boolean {
  switch (op.op) {
    case 'shot_set': case 'shot_offset': case 'fx_range': case 'actor_presence': case 'stage_set': case 'wardrobe_set': case 'bg_set': return true;
    case 'key_set': return PICTURE_CHANNELS.has(op.channel);
    case 'beat_set': return op.set.cutIn !== undefined || op.set.cutInKeepDialog !== undefined;
    case 'scene_set': return op.set.cameraSystem !== undefined;
    default: return false;
  }
}

/** The beats an op touches, as far as the op itself says. */
export function opBeatIds(op: AgentOp): string[] {
  const ids: string[] = [];
  const o = op as unknown as Record<string, unknown>;
  for (const k of ['beatId', 'fromBeatId', 'toBeatId']) if (typeof o[k] === 'string') ids.push(o[k] as string);
  if (op.op === 'bg_set' && op.at !== 'start') ids.push(op.at);
  if (op.op === 'key_set' && op.at) ids.push(op.at.beatId);
  if (op.op === 'stage_set') { if (op.enter) ids.push(op.enter.beatId); if (op.exit) ids.push(op.exit.beatId); }
  return ids;
}

/** Does the op set up a movement (camera move, or a camera key), so that one frame is not enough to judge it? */
export function involvesMove(op: AgentOp): boolean {
  if (op.op === 'shot_set') return !!op.set.move && op.set.move !== 'static';
  if (op.op === 'key_set') return op.channel === 'camera' || op.channel === 'position';
  if (op.op === 'stage_set') return !!op.enter || !!op.exit || op.slot !== undefined;
  return false;
}

/** A line that does not fit the dialogue area (and is not expanded). */
export interface LongLine {
  sceneId: string;
  beatId: string;
  /** 1-based position in its scene. */
  beatNo: number;
  lines: number;
  max: number;
}

/** Lines that are too long in `after` and were not (or were fewer lines) in `before`: what a turn newly broke, for the card's hint. */
export function newLongLines(before: Project, after: Project): LongLine[] {
  const was = new Map<string, number>();
  for (const s of before.scenes) for (const b of s.beats) { const i = beatLineInfo(before, s, b); if (i?.over) was.set(b.id, i.lines); }
  const out: LongLine[] = [];
  for (const s of after.scenes) s.beats.forEach((b, k) => {
    const i = beatLineInfo(after, s, b);
    if (i?.over && (was.get(b.id) ?? 0) < i.lines) out.push({ sceneId: s.id, beatId: b.id, beatNo: k + 1, lines: i.lines, max: i.max });
  });
  return out;
}

export type VerificationStatus =
  | 'none' // no picture-changing edit: nothing to check
  | 'verified' // captured after the last picture edit
  | 'fixed' // the check found a problem and the assistant changed it again, then looked again
  | 'unchecked' // the assistant did not (or could not) get a look at the last picture edit
  | 'unavailable'; // no vision: could not look at all

export interface Verification {
  status: VerificationStatus;
  /** Frames captured after the last picture edit (thumbnails on the card). */
  frames: Array<{ label: string; dataUrl: string }>;
  /** Times the loop asked the model for a check by itself. */
  forced: number;
}

export const NO_VERIFICATION: Verification = { status: 'none', frames: [], forced: 0 };

export const VERIFICATION_LINE: Record<Exclude<VerificationStatus, 'none'>, string> = {
  verified: '已截图核对 ✓',
  fixed: '核对发现问题并已修正',
  unchecked: '没能截图核对最后一次改动',
  unavailable: '无法看图，未核对',
};
