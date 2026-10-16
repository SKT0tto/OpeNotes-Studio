/**
 * Editor actions: every change a person makes on the stage, in the timeline, in the script or in the inspector.
 * Each one is a single `applyEdit` (one undo step; drags share a `coalesce` key), stamps `source = user`, respects
 * locks (a locked key / track / unit refuses the edit and says so) and never touches an AI.
 */
import type { EaseName } from '@shared/timeline/easing';
import {
  addKey, anchorAt, clone, absTime, duplicateBeat, ensureTrack, findTrack, insertBeat, insertScene, keyLocked, locateKey, moveBeat, moveKeyTo, moveScene, nextCastId,
  removeBeat, removeKey, removeScene, setActorInScene, storedBeatTimes, userMeta, type AnyKey, type Channel, type TrackTarget,
} from '@shared/project/mutate';
import { stageSlotOf, type StageMap } from '@shared/staging/compactStage';
import { feetToSlotDepth } from '@shared/staging/ground';
import type { Beat, Project, Scene } from '@shared/schema/project';
import type { RuleKey } from '@shared/timeline/types';
import { touch, useProject } from './projectStore';
import { notify, useUi, type ClipKey } from './uiStore';

const proj = (): Project | null => useProject.getState().project;
const sceneIndex = (p: Project, id: string) => p.scenes.findIndex((s) => s.id === id);
const EPS = 0.06;

export type Write = 'ok' | 'locked' | 'none';

/** Absolute time of a key of the current project, or null. */
export function keyAbs(p: Project, sceneId: string, key: { at: { beatId: string; offset: number } }): number | null {
  const i = sceneIndex(p, sceneId);
  return i < 0 ? null : absTime(storedBeatTimes(p, i), key.at);
}

/**
 * Set a channel value at time `t`: updates the key that sits at (or whose transition covers) `t`, otherwise adds one.
 * A new key made while manipulating directly has duration 0 unless `opts.duration` says otherwise.
 */
export function writeKey(sceneId: string, target: TrackTarget, channel: Channel, value: unknown, t: number, opts: { label: string; duration?: number; ease?: EaseName; coalesce?: string }): Write {
  const p = proj();
  if (!p) return 'none';
  const si = sceneIndex(p, sceneId);
  if (si < 0) return 'none';
  const beats = storedBeatTimes(p, si);
  if (!anchorAt(beats, t)) return 'none';
  const scene = p.scenes[si]!;
  const track = findTrack(scene, target, channel);
  const hit = track?.keys.find((k) => {
    const at = absTime(beats, k.at);
    return at !== null && ((Math.abs(at - t) <= EPS) || (k.duration > 0 && t >= at && t <= at + k.duration));
  });
  if (track && (track.meta.locked || hit?.meta.locked)) {
    notify(track.meta.locked ? '这条轨道已锁定，先解锁再修改' : '这个关键帧已锁定，先解锁再修改');
    return 'locked';
  }
  const hitId = hit?.id;
  useProject.getState().applyEdit((d) => {
    const sc = d.scenes[si]!;
    const tr = ensureTrack(sc, target, channel);
    const existing = hitId ? tr.keys.find((k) => k.id === hitId) : undefined;
    const key = existing ?? addKey(sc, tr, anchorAt(beats, t)!, value, { ...(opts.duration !== undefined ? { duration: opts.duration } : {}), ...(opts.ease ? { ease: opts.ease } : {}) });
    key.value = value;
    touch(key.meta);
    touch(tr.meta);
  }, opts.label, opts.coalesce ? { coalesce: opts.coalesce } : {});
  return 'ok';
}

/** Delete keys (locked ones stay and are reported). */
export function deleteKeys(sceneId: string, ids: string[]): number {
  const p = proj();
  if (!p || ids.length === 0) return 0;
  const si = sceneIndex(p, sceneId);
  const scene = p.scenes[si];
  if (!scene) return 0;
  const free = ids.filter((id) => {
    const hit = locateKey(scene, id);
    return hit && !keyLocked(hit.track, hit.key);
  });
  if (free.length < ids.length) notify(free.length === 0 ? '所选关键帧已锁定，无法删除' : `${ids.length - free.length} 个锁定的关键帧被保留`);
  if (free.length === 0) return 0;
  useProject.getState().applyEdit((d) => {
    for (const id of free) removeKey(d.scenes[si]!, id);
  }, free.length === 1 ? '删除关键帧' : `删除 ${free.length} 个关键帧`);
  useUi.getState().set({ keySel: useUi.getState().keySel.filter((k) => !free.includes(k)) });
  return free.length;
}

/** Move keys to absolute times (each re-anchors to the beat it lands in). With `copy`, new keys are made instead. */
export function moveKeys(sceneId: string, moves: Array<{ id: string; t: number }>, copy = false, coalesce?: string): number {
  const p = proj();
  const si = p ? sceneIndex(p, sceneId) : -1;
  if (!p || si < 0) return 0;
  const scene = p.scenes[si]!;
  const beats = storedBeatTimes(p, si);
  const ok = moves.filter((m) => {
    const hit = locateKey(scene, m.id);
    return hit && (copy || !keyLocked(hit.track, hit.key));
  });
  if (ok.length < moves.length) notify('锁定的关键帧不能移动');
  if (ok.length === 0) return 0;
  const created: string[] = [];
  useProject.getState().applyEdit((d) => {
    const sc = d.scenes[si]!;
    for (const m of ok) {
      if (!copy) {
        moveKeyTo(sc, m.id, beats, m.t);
        const hit = locateKey(sc, m.id);
        if (hit) touch(hit.key.meta);
        continue;
      }
      const hit = locateKey(sc, m.id);
      const a = anchorAt(beats, m.t);
      if (!hit || !a) continue;
      const k = addKey(sc, hit.track, a, clone(hit.key.value), { duration: hit.key.duration, ease: hit.key.ease });
      created.push(k.id);
    }
  }, copy ? '复制关键帧' : ok.length === 1 ? '移动关键帧' : `移动 ${ok.length} 个关键帧`, coalesce ? { coalesce } : {});
  if (created.length > 0) useUi.getState().set({ keySel: created });
  return ok.length;
}

/** Edit fields of one key (value / duration / ease). */
export function patchKey(sceneId: string, keyId: string, patch: Partial<Pick<AnyKey, 'value' | 'duration' | 'ease'>>, label: string, coalesce?: string): Write {
  const p = proj();
  const si = p ? sceneIndex(p, sceneId) : -1;
  const hit = p && si >= 0 ? locateKey(p.scenes[si]!, keyId) : null;
  if (!hit) return 'none';
  if (keyLocked(hit.track, hit.key)) {
    notify('这个关键帧已锁定，先解锁再修改');
    return 'locked';
  }
  useProject.getState().applyEdit((d) => {
    const h = locateKey(d.scenes[si]!, keyId);
    if (!h) return;
    Object.assign(h.key, patch);
    touch(h.key.meta);
  }, label, coalesce ? { coalesce: `${keyId}.${coalesce}` } : {});
  return 'ok';
}

export function lockKey(sceneId: string, keyId: string, locked: boolean): void {
  const p = proj();
  const si = p ? sceneIndex(p, sceneId) : -1;
  if (si < 0) return;
  useProject.getState().applyEdit((d) => {
    const h = locateKey(d.scenes[si]!, keyId);
    if (h) h.key.meta.locked = locked;
  }, locked ? '锁定关键帧' : '解锁关键帧');
}

export function lockTrack(sceneId: string, trackId: string, locked: boolean): void {
  const p = proj();
  const si = p ? sceneIndex(p, sceneId) : -1;
  if (si < 0) return;
  useProject.getState().applyEdit((d) => {
    const tr = d.scenes[si]!.tracks.find((t) => t.id === trackId);
    if (tr) tr.meta.locked = locked;
  }, locked ? '锁定轨道' : '解锁轨道');
}

/** Add a key of a track at time t with a ready value (used by the timeline's double click). */
export function addKeyAt(sceneId: string, target: TrackTarget, channel: Channel, value: unknown, t: number, duration: number, ease: EaseName = 'inOutQuad'): string | null {
  const p = proj();
  const si = p ? sceneIndex(p, sceneId) : -1;
  if (!p || si < 0) return null;
  const a = anchorAt(storedBeatTimes(p, si), t);
  if (!a) return null;
  const tr0 = findTrack(p.scenes[si]!, target, channel);
  if (tr0?.meta.locked) {
    notify('这条轨道已锁定，先解锁再添加关键帧');
    return null;
  }
  let id = '';
  useProject.getState().applyEdit((d) => {
    const sc = d.scenes[si]!;
    const tr = ensureTrack(sc, target, channel);
    id = addKey(sc, tr, a, value, { duration, ease }).id;
  }, '添加关键帧');
  return id;
}

/** Turn what the rule director did on its own into real keys (they are then yours: editable, lockable, draggable). */
export function bakeRuleKeys(sceneId: string, castId: string, keys: RuleKey[]): void {
  const p = proj();
  const si = p ? sceneIndex(p, sceneId) : -1;
  if (si < 0 || keys.length === 0) return;
  useProject.getState().applyEdit((d) => {
    const sc = d.scenes[si]!;
    for (const rk of keys) {
      const tr = ensureTrack(sc, { kind: 'actor', castId }, rk.channel);
      addKey(sc, tr, { beatId: rk.beatId, offset: rk.offset }, structuredClone(rk.value), { duration: rk.duration, ease: 'inOutSine' });
    }
  }, keys.length === 1 ? '烘焙规则导演关键帧' : `烘焙 ${keys.length} 个规则导演关键帧`);
}

export function copyKeys(sceneId: string, ids: string[]): number {
  const p = proj();
  const si = p ? sceneIndex(p, sceneId) : -1;
  if (!p || si < 0) return 0;
  const scene = p.scenes[si]!;
  const beats = storedBeatTimes(p, si);
  const items = ids.flatMap((id) => {
    const h = locateKey(scene, id);
    const at = h ? absTime(beats, h.key.at) : null;
    return h && at !== null ? [{ h, at }] : [];
  });
  if (items.length === 0) return 0;
  const t0 = Math.min(...items.map((x) => x.at));
  const clip: ClipKey[] = items.map(({ h, at }) => ({ target: structuredClone(h.track.target), channel: h.track.channel, dt: at - t0, key: { value: structuredClone(h.key.value), duration: h.key.duration, ease: h.key.ease } }));
  useUi.getState().set({ clip });
  notify(`已复制 ${clip.length} 个关键帧`, 'info');
  return clip.length;
}

export function pasteKeys(sceneId: string, t: number): number {
  const clip = useUi.getState().clip;
  const p = proj();
  const si = p ? sceneIndex(p, sceneId) : -1;
  if (!p || si < 0 || clip.length === 0) return 0;
  const beats = storedBeatTimes(p, si);
  const scene = p.scenes[si]!;
  const usable = clip.filter((c) => {
    const tr = findTrack(scene, c.target, c.channel);
    return !tr?.meta.locked && (c.target.kind !== 'actor' || !!scene.wardrobe[c.target.castId]);
  });
  if (usable.length === 0) {
    notify('目标轨道已锁定或角色不在本场景');
    return 0;
  }
  const created: string[] = [];
  useProject.getState().applyEdit((d) => {
    const sc = d.scenes[si]!;
    for (const c of usable) {
      const a = anchorAt(beats, t + c.dt);
      if (!a) continue;
      created.push(addKey(sc, ensureTrack(sc, c.target, c.channel), a, structuredClone(c.key.value), { duration: c.key.duration, ease: c.key.ease }).id);
    }
  }, `粘贴 ${usable.length} 个关键帧`);
  useUi.getState().set({ keySel: created });
  return created.length;
}

// ---- people on stage -----------------------------------------------------------------------------------
/**
 * Move a person: the latest position key at / before `t` when there is one, otherwise the scene's starting blocking.
 * `feet` is the target world point of the feet.
 */
export function placeActorAt(sceneId: string, castId: string, feet: { x: number; y: number }, bg: { width: number; ground: { horizonY: number; floorY: number } }, t: number, stage?: StageMap): Write {
  const sd = feetToSlotDepth(feet, bg);
  // travel scenes: the feet x is a position on the compact stage, not on the classic slot scale
  return setSlotDepth(sceneId, castId, stage ? { slot: stageSlotOf(stage, feet.x), depth: sd.depth } : sd, t);
}

/** Set a person's slot / depth at time `t` (position key at / before `t`, else the scene's starting blocking). */
export function setSlotDepth(sceneId: string, castId: string, at: { slot: number; depth: number }, t: number): Write {
  const p = proj();
  const si = p ? sceneIndex(p, sceneId) : -1;
  if (!p || si < 0) return 'none';
  const scene = p.scenes[si]!;
  const rounded = { slot: Math.round(Math.min(1, Math.max(-1, at.slot)) * 1000) / 1000, depth: Math.round(Math.min(1, Math.max(0, at.depth)) * 1000) / 1000 };
  const beats = storedBeatTimes(p, si);
  const track = findTrack(scene, { kind: 'actor', castId }, 'position');
  const latest = track?.keys
    .map((k) => ({ k, at: absTime(beats, k.at) ?? Infinity }))
    .filter((x) => x.at <= t + EPS)
    .sort((a, b) => b.at - a.at)[0];
  if (latest) return writeKey(sceneId, { kind: 'actor', castId }, 'position', rounded, latest.at, { label: '调整角色位置', coalesce: `pos.${castId}` });
  const bl = scene.blocking[castId];
  if (!bl) return 'none';
  if (bl.meta.locked) {
    notify('这个角色的站位已锁定，先解锁再调整');
    return 'locked';
  }
  useProject.getState().applyEdit((d) => {
    const b = d.scenes[si]!.blocking[castId];
    if (!b) return;
    b.slot = rounded.slot;
    b.depth = rounded.depth;
    touch(b.meta);
  }, '调整角色位置', { coalesce: `pos.${castId}` });
  return 'ok';
}

/** Where the person stands at `t` (position key or blocking) — the start of a drag. */
export function positionAt(p: Project, sceneId: string, castId: string, t: number): { slot: number; depth: number } | null {
  const si = sceneIndex(p, sceneId);
  const scene = p.scenes[si];
  if (!scene) return null;
  const beats = storedBeatTimes(p, si);
  const track = findTrack(scene, { kind: 'actor', castId }, 'position');
  const latest = track?.keys
    .map((k) => ({ v: k.value as { slot: number; depth: number }, at: absTime(beats, k.at) ?? Infinity }))
    .filter((x) => x.at <= t + EPS)
    .sort((a, b) => b.at - a.at)[0];
  if (latest) return latest.v;
  const b = scene.blocking[castId];
  return b ? { slot: b.slot, depth: b.depth } : null;
}

// ---- script: scenes and lines ------------------------------------------------------------------------
export function addBeatAfter(sceneId: string, afterBeatId: string | null, init: Partial<Pick<Beat, 'kind' | 'text' | 'speakerId'>> = {}): string | null {
  const p = proj();
  const si = p ? sceneIndex(p, sceneId) : -1;
  if (si < 0) return null;
  let id = '';
  useProject.getState().applyEdit((d) => {
    id = insertBeat(d.scenes[si]!, afterBeatId, init).id;
  }, '添加台词');
  useProject.getState().select({ sceneId, beatId: id });
  return id;
}

export function deleteBeat(sceneId: string, beatId: string): void {
  const p = proj();
  const si = p ? sceneIndex(p, sceneId) : -1;
  const scene = p?.scenes[si];
  if (!scene) return;
  if (scene.beats.length <= 1) {
    notify('场景至少要保留一句台词，可以改为空镜或停顿');
    return;
  }
  const i = scene.beats.findIndex((b) => b.id === beatId);
  const nextSel = scene.beats[i + 1]?.id ?? scene.beats[i - 1]?.id ?? null;
  if (useProject.getState().applyEdit((d) => void removeBeat(d.scenes[si]!, beatId), '删除台词')) useProject.getState().select({ beatId: nextSel });
}

export function copyBeat(sceneId: string, beatId: string): void {
  const p = proj();
  const si = p ? sceneIndex(p, sceneId) : -1;
  if (si < 0) return;
  let id: string | null = null;
  useProject.getState().applyEdit((d) => {
    id = duplicateBeat(d.scenes[si]!, beatId)?.id ?? null;
  }, '复制台词');
  if (id) useProject.getState().select({ beatId: id });
}

export function reorderBeat(sceneId: string, beatId: string, toIndex: number): void {
  const p = proj();
  const si = p ? sceneIndex(p, sceneId) : -1;
  if (si < 0) return;
  useProject.getState().applyEdit((d) => void moveBeat(d.scenes[si]!, beatId, toIndex), '调整台词顺序');
}

export function addSceneAfter(afterSceneId: string | null, backgroundId: string, modelOf: (castId: string) => string | null): string | null {
  const p = proj();
  if (!p) return null;
  let id = '';
  useProject.getState().applyEdit((d) => {
    id = insertScene(d as Project, afterSceneId ?? d.scenes.at(-1)?.id ?? null, { backgroundId, modelOf: (c) => modelOf(c.id) }).id;
  }, '添加场景');
  const sc = useProject.getState().project?.scenes.find((s) => s.id === id);
  useProject.getState().select({ sceneId: id, beatId: sc?.beats[0]?.id ?? null });
  return id;
}

export function deleteScene(sceneId: string): void {
  const p = proj();
  if (!p) return;
  const i = sceneIndex(p, sceneId);
  const next = p.scenes[i + 1] ?? p.scenes[i - 1];
  if (useProject.getState().applyEdit((d) => void removeScene(d as Project, sceneId), '删除场景')) useProject.getState().select({ sceneId: next?.id ?? null, beatId: next?.beats[0]?.id ?? null });
}

export function reorderScene(sceneId: string, toIndex: number): void {
  useProject.getState().applyEdit((d) => void moveScene(d as Project, sceneId, toIndex), '调整场景顺序');
}

export function addCast(characterKey: string, displayName: string): string {
  let id = '';
  useProject.getState().applyEdit((d) => {
    id = nextCastId(d);
    d.cast.push({ id, characterKey, displayName, meta: userMeta() });
  }, `添加角色 ${displayName}`);
  return id;
}

export function toggleActorInScene(sceneId: string, castId: string, present: boolean, modelId: string | null): void {
  const p = proj();
  const si = p ? sceneIndex(p, sceneId) : -1;
  if (si < 0) return;
  if (present && !modelId) {
    notify('这个角色没有可用的服装模型');
    return;
  }
  useProject.getState().applyEdit((d) => setActorInScene(d.scenes[si]! as Scene, castId, present, modelId ?? '', 0), present ? '角色入场景' : '角色移出场景');
}

/** Shot of a beat (type / move / focus / ...), stamped as a user shot so the minimum-shot rule leaves it alone. */
export function editShot(sceneId: string, beatId: string, label: string, fn: (shot: Beat['shot']) => void, coalesce?: string, allowLocked = false): Write {
  const p = proj();
  const si = p ? sceneIndex(p, sceneId) : -1;
  const cur = p?.scenes[si]?.beats.find((x) => x.id === beatId);
  if (!cur) return 'none';
  if (cur.shot.meta.locked && !allowLocked) {
    notify('这句的镜头已锁定，先解锁再修改');
    return 'locked';
  }
  useProject.getState().applyEdit((d) => {
    const b = d.scenes[si]!.beats.find((x) => x.id === beatId);
    if (!b) return;
    fn(b.shot);
    touch(b.shot.meta);
  }, label, coalesce ? { coalesce: `${beatId}.${coalesce}` } : {});
  return 'ok';
}

/** The manual camera key of a beat (offset 0 on the camera track), if any. */
export function manualCameraKey(scene: Scene, beatId: string) {
  const tr = findTrack(scene, { kind: 'camera' }, 'camera');
  return tr?.keys.find((k) => k.at.beatId === beatId && Math.abs(k.at.offset) < 1e-6 && 'manual' in (k.value as object));
}

/** Hand-set camera of one line: a `manual` key at the line's start (a hard cut to that framing). */
export function setManualCamera(sceneId: string, beatId: string, pose: { x: number; y: number; zoom: number; bgZoom?: number; roll?: number }, label: string, coalesce?: string): Write {
  const p = proj();
  const si = p ? sceneIndex(p, sceneId) : -1;
  const scene = p?.scenes[si];
  if (!scene) return 'none';
  const tr = findTrack(scene, { kind: 'camera' }, 'camera');
  const have = manualCameraKey(scene, beatId);
  if (tr?.meta.locked || have?.meta.locked) {
    notify(have?.meta.locked ? '这个镜头关键帧已锁定，先解锁再修改' : '镜头轨道已锁定，先解锁再修改');
    return 'locked';
  }
  const round = (v: number) => Math.round(v * 100) / 100;
  const value = { manual: { x: round(pose.x), y: round(pose.y), zoom: Math.round(pose.zoom * 1000) / 1000, ...(pose.bgZoom !== undefined ? { bgZoom: Math.round(pose.bgZoom * 1000) / 1000 } : {}), ...(pose.roll ? { roll: round(pose.roll) } : {}) } };
  const haveId = have?.id;
  useProject.getState().applyEdit((d) => {
    const sc = d.scenes[si]!;
    const track = ensureTrack(sc, { kind: 'camera' }, 'camera');
    const key = haveId ? track.keys.find((k) => k.id === haveId)! : addKey(sc, track, { beatId, offset: 0 }, value, { duration: 0 });
    key.value = value;
    touch(key.meta);
    touch(track.meta);
  }, label, coalesce ? { coalesce: `cam.${beatId}.${coalesce}` } : {});
  return 'ok';
}

export function clearManualCamera(sceneId: string, beatId: string): void {
  const p = proj();
  const si = p ? sceneIndex(p, sceneId) : -1;
  const scene = p?.scenes[si];
  const have = scene ? manualCameraKey(scene, beatId) : undefined;
  if (!have) return;
  if (have.meta.locked) {
    notify('这个镜头关键帧已锁定，先解锁再恢复自动');
    return;
  }
  useProject.getState().applyEdit((d) => void removeKey(d.scenes[si]!, have.id), '恢复自动镜头');
}

/** The key of a track at (or whose transition covers) time `t`, with its absolute time. */
export function keyNear(p: Project, sceneId: string, target: TrackTarget, channel: Channel, t: number) {
  const si = sceneIndex(p, sceneId);
  const scene = p.scenes[si];
  if (!scene) return null;
  const beats = storedBeatTimes(p, si);
  const track = findTrack(scene, target, channel);
  if (!track) return null;
  for (const key of track.keys) {
    const at = absTime(beats, key.at);
    if (at !== null && (Math.abs(at - t) <= EPS || (key.duration > 0 && t >= at && t <= at + key.duration))) return { track, key, at };
  }
  return null;
}

/** Edit one line (stamped as a user edit; respects the line's lock). */
export function editBeat(sceneId: string, beatId: string, label: string, fn: (b: Beat) => void, coalesce?: string): Write {
  const p = proj();
  const si = p ? sceneIndex(p, sceneId) : -1;
  const b = p?.scenes[si]?.beats.find((x) => x.id === beatId);
  if (!b) return 'none';
  if (b.meta.locked) {
    notify('这句台词已锁定，先解锁再修改');
    return 'locked';
  }
  useProject.getState().applyEdit((d) => {
    const x = d.scenes[si]!.beats.find((y) => y.id === beatId);
    if (!x) return;
    fn(x as Beat);
    touch(x.meta);
  }, label, coalesce ? { coalesce: `${beatId}.${coalesce}` } : {});
  return 'ok';
}

/** Edit a scene. Locks are enforced by the store's gate: the scene's own lock covers its title only. */
export function editScene(sceneId: string, label: string, fn: (s: Scene) => void, coalesce?: string): void {
  const p = proj();
  const si = p ? sceneIndex(p, sceneId) : -1;
  if (si < 0) return;
  useProject.getState().applyEdit((d) => {
    const s = d.scenes[si]!;
    const before = s.title;
    fn(s as Scene);
    if (s.title !== before) touch(s.meta);
  }, label, coalesce ? { coalesce: `${sceneId}.${coalesce}` } : {});
}

/** Select a person (stage click, timeline group, inspector): the actor tab shows them and their timeline lanes open. */
export function selectActor(castId: string, showTab = true): void {
  useProject.getState().select({ castId });
  const ui = useUi.getState();
  ui.set({ openGroups: { ...ui.openGroups, [`actor:${castId}`]: true }, ...(showTab ? { inspectorTab: 'actor' as const } : {}) });
}
