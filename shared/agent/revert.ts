/**
 * 「改回去」: the ops that take a project back from `after` to `before`, for the units an earlier assistant turn changed.
 * Computed by diffing the two projects (not by inverting each op), so it works for every op kind and is exact for the fields the
 * agent edits: beat fields, shot, per-person offsets, rhythm overrides, timeline keys (by key id), entrances / exits / start positions,
 * presence, outfits, scene settings, the opening background and inserted / deleted lines (so also the pieces a split added), and `overflow` through `dialog_expand`.
 * Provenance (`meta.source`) is not restored.
 */
import type { Beat, Project, Scene } from '../schema/project';
import type { AgentOp } from './ops';

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const BEAT_FIELDS = ['text', 'speakerId', 'kind', 'variant', 'emotion', 'cutIn', 'cutInKeepDialog', 'coSpeakers', 'duration'] as const;
const SHOT_FIELDS = ['type', 'focus', 'move', 'dof', 'transition', 'intent', 'insertBox'] as const;

type AnyKey = { id: string; at: { beatId: string; offset: number }; value: unknown; duration: number; ease: string };
type AnyTrack = { id: string; channel: string; target: { kind: string; castId?: string }; keys: AnyKey[] };

/** Ops that turn `after` back into `before` (only scenes present in both; `sceneIds` limits it further). */
export function revertOps(before: Project, after: Project, sceneIds?: string[]): AgentOp[] {
  const ops: AgentOp[] = [];
  for (const sa of after.scenes) {
    if (sceneIds && !sceneIds.includes(sa.id)) continue;
    const sb = before.scenes.find((s) => s.id === sa.id);
    if (!sb) continue;
    ops.push(...sceneRevert(sb, sa));
  }
  return ops;
}

function sceneRevert(sb: Scene, sa: Scene): AgentOp[] {
  const sceneId = sa.id;
  const reason = '改回去';
  const ops: AgentOp[] = [];
  const beforeIds = new Set(sb.beats.map((b) => b.id));
  const afterIds = new Set(sa.beats.map((b) => b.id));

  // presence first (a person removed must exist again before their keys / entrance come back)
  for (const [castId, w] of Object.entries(sb.wardrobe)) if (!sa.wardrobe[castId]) ops.push({ op: 'actor_presence', sceneId, castId, present: true, modelId: w.modelId, slot: sb.blocking[castId]?.slot ?? 0, reason });
  // lines: inserted ones go, deleted ones come back (text / speaker / kind / emotion; their keys come back below)
  // inserted lines go last (their keys are removed first, by id, below)
  const deletes: AgentOp[] = sa.beats.filter((b) => !beforeIds.has(b.id)).map((b) => ({ op: 'beat_delete', sceneId, beatId: b.id, reason }));
  sb.beats.forEach((b, i) => {
    if (afterIds.has(b.id)) return;
    const prev = sb.beats.slice(0, i).reverse().find((x) => afterIds.has(x.id) || ops.some((o) => o.op === 'beat_insert' && o.newId === x.id));
    ops.push({ op: 'beat_insert', sceneId, afterBeatId: prev?.id ?? null, newId: b.id, beat: { kind: (b.kind === 'establishing' ? 'empty' : b.kind) as 'empty', text: b.text, ...(b.speakerId ? { speakerId: b.speakerId } : {}), ...(b.emotion ? { emotion: b.emotion } : {}), ...(b.splitFrom ? { splitFrom: b.splitFrom } : {}) }, reason });
  });
  // the order of the lines that are in both
  const common = sb.beats.filter((b) => afterIds.has(b.id)).map((b) => b.id);
  const nowOrder = sa.beats.filter((b) => beforeIds.has(b.id)).map((b) => b.id);
  if (!same(common, nowOrder)) common.forEach((id, i) => ops.push({ op: 'beat_move', sceneId, beatId: id, afterBeatId: i === 0 ? null : common[i - 1]!, reason }));

  for (const bb of sb.beats) {
    const ba = sa.beats.find((b) => b.id === bb.id);
    if (!ba) continue;
    ops.push(...beatRevert(sceneId, bb, ba, reason));
  }
  // timeline keys, by key id
  const tracksB = sb.tracks as unknown as AnyTrack[];
  const tracksA = sa.tracks as unknown as AnyTrack[];
  const keysOf = (ts: AnyTrack[]) => new Map(ts.flatMap((t) => t.keys.map((k) => [k.id, { t, k }] as const)));
  const kb = keysOf(tracksB);
  const ka = keysOf(tracksA);
  const target = (t: AnyTrack) => (t.target.kind === 'actor' ? { kind: 'actor' as const, castId: t.target.castId! } : { kind: t.target.kind as 'camera' | 'screen' | 'stage' | 'audio' });
  for (const [id, { t, k }] of ka) if (!kb.has(id) && beforeIds.has(k.at.beatId)) ops.push({ op: 'key_set', sceneId, target: target(t), channel: t.channel as never, keyId: id, remove: true, reason });
  for (const [id, { t, k }] of kb) {
    const now = ka.get(id);
    if (!now) ops.push({ op: 'key_set', sceneId, target: target(t), channel: t.channel as never, newKeyId: id, at: { ...k.at }, value: k.value, duration: k.duration, ease: k.ease as never, reason });
    else if (!same(now.k.at, k.at) || !same(now.k.value, k.value) || now.k.duration !== k.duration || now.k.ease !== k.ease) {
      ops.push({ op: 'key_set', sceneId, target: target(t), channel: t.channel as never, keyId: id, at: { ...k.at }, value: k.value, duration: k.duration, ease: k.ease as never, reason });
    }
  }
  // entrances / exits / start positions and outfits of the people who are in both
  for (const [castId, bl] of Object.entries(sb.blocking)) {
    const al = sa.blocking[castId];
    if (!al) continue;
    const set: Record<string, unknown> = {};
    if (!same(bl.enter, al.enter)) set.enter = bl.enter ? { beatId: bl.enter.beatId, side: bl.enter.side } : null;
    if (!same(bl.exit, al.exit)) set.exit = bl.exit ? { beatId: bl.exit.beatId } : null;
    if (bl.slot !== al.slot) set.slot = bl.slot;
    if (bl.depth !== al.depth) set.depth = bl.depth;
    if (Object.keys(set).length) ops.push({ op: 'stage_set', sceneId, castId, ...set, reason } as AgentOp);
    const wb = sb.wardrobe[castId];
    const wa = sa.wardrobe[castId];
    if (wb && wa && wb.modelId !== wa.modelId) ops.push({ op: 'wardrobe_set', sceneId, castId, modelId: wb.modelId, reason });
  }
  for (const castId of Object.keys(sa.wardrobe)) if (!sb.wardrobe[castId]) ops.push({ op: 'actor_presence', sceneId, castId, present: false, reason });
  // scene settings and the opening background
  const set: Record<string, unknown> = {};
  for (const k of ['title', 'cameraSystem', 'mood', 'timeOfDay'] as const) if (!same(sb[k as keyof Scene], sa[k as keyof Scene])) set[k] = sb[k as keyof Scene] ?? (k === 'cameraSystem' ? 'inherit' : '');
  if (!same(sb.transitionIn, sa.transitionIn)) set.transitionIn = { ...sb.transitionIn };
  if (!same(sb.location, sa.location) && sb.location) set.location = { text: sb.location.text, show: sb.location.show };
  if (Object.keys(set).length) ops.push({ op: 'scene_set', sceneId, set, reason } as AgentOp);
  if (sb.background.assetId !== sa.background.assetId) ops.push({ op: 'bg_set', sceneId, at: 'start', assetId: sb.background.assetId, ...(sb.location ? { location: sb.location.text } : {}), reason });
  return [...ops, ...deletes];
}

function beatRevert(sceneId: string, bb: Beat, ba: Beat, reason: string): AgentOp[] {
  const ops: AgentOp[] = [];
  const set: Record<string, unknown> = {};
  for (const f of BEAT_FIELDS) if (!same(bb[f], ba[f])) set[f] = f === 'speakerId' || f === 'emotion' ? bb[f] ?? null : bb[f];
  if (Object.keys(set).length) ops.push({ op: 'beat_set', sceneId, beatId: bb.id, set, reason } as AgentOp);
  // a line shown in full (or not): its own op, because beat_set never writes `overflow`
  if ((bb.overflow === 'expand') !== (ba.overflow === 'expand')) ops.push({ op: 'dialog_expand', sceneId, beatId: bb.id, on: bb.overflow === 'expand', reason });
  const shot: Record<string, unknown> = {};
  for (const f of SHOT_FIELDS) if (!same(bb.shot[f], ba.shot[f])) shot[f] = bb.shot[f] ?? null;
  if (Object.keys(shot).length) ops.push({ op: 'shot_set', sceneId, beatId: bb.id, set: shot, reason } as AgentOp);
  const ob = bb.shot.offsets ?? {};
  const oa = ba.shot.offsets ?? {};
  for (const castId of new Set([...Object.keys(ob), ...Object.keys(oa)])) if (!same(ob[castId], oa[castId])) ops.push({ op: 'shot_offset', sceneId, beatId: bb.id, castId, offset: ob[castId] ? { x: ob[castId]!.x, y: ob[castId]!.y } : null, reason });
  const rb = bb.style.overrides as Record<string, unknown>;
  const ra = ba.style.overrides as Record<string, unknown>;
  const gone = Object.keys(ra).filter((k) => k.startsWith('rhythm.') && !(k in rb));
  const back = Object.fromEntries(Object.entries(rb).filter(([k, v]) => k.startsWith('rhythm.') && typeof v === 'number' && !same(v, ra[k]))) as Record<string, number>;
  if (gone.length) ops.push({ op: 'timing', sceneId, beatIds: [bb.id], set: Object.fromEntries(gone.map((k) => [k, ra[k] as number])), clear: true, reason });
  if (Object.keys(back).length) ops.push({ op: 'timing', sceneId, beatIds: [bb.id], set: back, reason });
  return ops;
}
