/**
 * Pure edit helpers on a project (or an Immer draft of it): time anchoring, track / key CRUD, beat / scene CRUD.
 * No DOM, no engine, no randomness: ids are monotonic `<prefix>_<n>` (never reused after a delete), so the same edit gives the same result.
 * Every helper that creates or changes a unit stamps `meta.source = 'user'`; nothing here locks anything by itself.
 */
import type { EaseName } from '../timeline/easing';
import { sceneTimes } from '../timeline/time';
import type { Beat, CastMember, Meta, Project, Scene, Track } from '../schema/project';

export type Anchor = { beatId: string; offset: number };
export type TrackTarget = Track['target'];
export type Channel = Track['channel'];
/** A key of any track, with its value untyped (the schema validates the value on save). */
export interface AnyKey {
  id: string;
  at: Anchor;
  value: unknown;
  duration: number;
  ease: EaseName;
  meta: Meta;
}
type AnyTrack = Omit<Track, 'keys'> & { keys: AnyKey[] };

/** Deep copy of plain data or of an Immer draft (structuredClone cannot copy proxies). */
export const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

export const userMeta = (now = Date.now()): Meta => ({ source: 'user', locked: false, updatedAt: now });

export interface IdHolder {
  idSeq?: Record<string, number> | undefined;
}

/**
 * Ids are monotonic per prefix: one more than the largest number ever issued (`holder.idSeq`) or still present, so an
 * id that was deleted is never handed out again (merging AI results and locks by id depends on this).
 */
export const nextId = (prefix: string, used: Iterable<string>, holder: IdHolder, pad = 0): string => {
  let max = holder.idSeq?.[prefix] ?? 0;
  const head = `${prefix}_`;
  for (const id of used) {
    if (!id.startsWith(head)) continue;
    const n = Number(id.slice(head.length));
    if (Number.isInteger(n) && n > max) max = n;
  }
  const n = max + 1;
  (holder.idSeq ??= {})[prefix] = n;
  return `${head}${pad ? String(n).padStart(pad, '0') : n}`;
};

export const sameTarget = (a: TrackTarget, b: TrackTarget): boolean =>
  a.kind === b.kind && (a.kind !== 'actor' || (b.kind === 'actor' && a.castId === b.castId));

// ---- time anchoring ----------------------------------------------------------------------------------------
/** Absolute start / end times of the stored beats of a scene (the automatic establishing shot is not one of them). */
export function storedBeatTimes(project: Pick<Project, 'scenes' | 'settings' | 'style'>, sceneIndex: number): Array<{ beatId: string; start: number; end: number }> {
  const st = sceneTimes(project)[sceneIndex];
  const scene = project.scenes[sceneIndex];
  if (!st || !scene) return [];
  const stored = new Set(scene.beats.map((b) => b.id));
  return st.beats.filter((b) => stored.has(b.beatId)).map((b) => ({ beatId: b.beatId, start: b.start, end: b.end }));
}

/**
 * The (beat, offset) anchor of an absolute time inside a scene. Before the first stored beat it is a negative offset
 * of the first beat, after the last one an offset past its end; null when the scene has no stored beats.
 */
export function anchorAt(beats: Array<{ beatId: string; start: number; end: number }>, t: number): Anchor | null {
  if (beats.length === 0) return null;
  const first = beats[0]!;
  if (t < first.start) return { beatId: first.beatId, offset: round(t - first.start) };
  const hit = beats.find((b) => t >= b.start - 1e-9 && t < b.end - 1e-9) ?? beats.at(-1)!;
  return { beatId: hit.beatId, offset: round(t - hit.start) };
}

export const absTime = (beats: Array<{ beatId: string; start: number }>, at: Anchor): number | null => {
  const b = beats.find((x) => x.beatId === at.beatId);
  return b ? b.start + at.offset : null;
};

const round = (v: number) => Math.round(v * 1000) / 1000;

// ---- tracks and keys ---------------------------------------------------------------------------------------
export function findTrack(scene: Scene, target: TrackTarget, channel: Channel): AnyTrack | undefined {
  return (scene.tracks as unknown as AnyTrack[]).find((t) => t.channel === channel && sameTarget(t.target, target));
}

export function ensureTrack(scene: Scene, target: TrackTarget, channel: Channel): AnyTrack {
  const found = findTrack(scene, target, channel);
  if (found) return found;
  const used = new Set(scene.tracks.map((t) => t.id));
  const track = { id: nextId('tr', used, scene), target, channel, meta: userMeta(), keys: [] } as unknown as AnyTrack;
  (scene.tracks as unknown as AnyTrack[]).push(track);
  return track;
}

export function newKeyId(scene: Scene): string {
  const used = new Set(scene.tracks.flatMap((t) => t.keys.map((k) => k.id)));
  return nextId('k', used, scene);
}

export function addKey(scene: Scene, track: AnyTrack, at: Anchor, value: unknown, opts: { duration?: number; ease?: EaseName } = {}): AnyKey {
  const key: AnyKey = { id: newKeyId(scene), at: { beatId: at.beatId, offset: round(at.offset) }, value, duration: opts.duration ?? 0, ease: opts.ease ?? 'inOutQuad', meta: userMeta() };
  track.keys.push(key);
  return key;
}

export const locateKey = (scene: Scene, keyId: string): { track: AnyTrack; key: AnyKey } | null => {
  for (const track of scene.tracks as unknown as AnyTrack[]) {
    const key = track.keys.find((k) => k.id === keyId);
    if (key) return { track, key };
  }
  return null;
};

/** A key is protected when it or its track is locked. */
export const keyLocked = (track: { meta: Meta }, key: { meta: Meta }): boolean => track.meta.locked || key.meta.locked;

export function removeKey(scene: Scene, keyId: string): boolean {
  const hit = locateKey(scene, keyId);
  if (!hit) return false;
  hit.track.keys.splice(hit.track.keys.indexOf(hit.key), 1);
  return true;
}

/** Re-anchor a key to an absolute time (the anchor beat changes when the key crosses a beat boundary). */
export function moveKeyTo(scene: Scene, keyId: string, beats: Array<{ beatId: string; start: number; end: number }>, t: number): boolean {
  const hit = locateKey(scene, keyId);
  const a = anchorAt(beats, t);
  if (!hit || !a) return false;
  hit.key.at = a;
  return true;
}

/** Keys of all tracks with their absolute times, sorted by time. */
export function keyTimes(scene: Scene, beats: Array<{ beatId: string; start: number }>): Array<{ track: AnyTrack; key: AnyKey; at: number }> {
  const out: Array<{ track: AnyTrack; key: AnyKey; at: number }> = [];
  for (const track of scene.tracks as unknown as AnyTrack[]) {
    for (const key of track.keys) {
      const at = absTime(beats, key.at);
      if (at !== null) out.push({ track, key, at });
    }
  }
  return out.sort((a, b) => a.at - b.at);
}

// ---- beats -------------------------------------------------------------------------------------------------
export function newBeat(scene: Scene, init: Partial<Pick<Beat, 'kind' | 'text' | 'speakerId'>> = {}): Beat {
  const used = new Set(scene.beats.map((b) => b.id));
  const id = nextId(`${scene.id}b`, used, scene);
  const speaker = init.speakerId ?? Object.keys(scene.wardrobe)[0];
  return {
    id, kind: init.kind ?? 'dialogue', variant: 'normal', coSpeakers: [], cutIn: 'cut', cutInKeepDialog: false, text: init.text ?? '',
    duration: { mode: 'auto', seconds: 0 },
    shot: { type: 'mcu', focus: [], move: 'static', meta: userMeta() },
    style: { overrides: {}, meta: userMeta() }, meta: userMeta(),
    ...((init.kind ?? 'dialogue') === 'dialogue' && speaker ? { speakerId: speaker } : {}),
  };
}

/** Insert a beat after `afterBeatId` (null = at the start). Returns the new beat. */
export function insertBeat(scene: Scene, afterBeatId: string | null, init: Partial<Pick<Beat, 'kind' | 'text' | 'speakerId'>> = {}): Beat {
  const beat = newBeat(scene, init);
  const i = afterBeatId === null ? -1 : scene.beats.findIndex((b) => b.id === afterBeatId);
  scene.beats.splice(i + 1, 0, beat);
  return beat;
}

/** A copy of a beat right after it (new id, keys are not copied). */
export function duplicateBeat(scene: Scene, beatId: string): Beat | null {
  const i = scene.beats.findIndex((b) => b.id === beatId);
  if (i < 0) return null;
  const src = scene.beats[i]!;
  const copy: Beat = { ...clone(src), id: newBeat(scene).id, meta: userMeta() };
  scene.beats.splice(i + 1, 0, copy);
  return copy;
}

/** Delete a beat: its keys go with it, and enter / exit markers that pointed at it move to the next beat (or vanish). */
export function removeBeat(scene: Scene, beatId: string): boolean {
  const i = scene.beats.findIndex((b) => b.id === beatId);
  if (i < 0) return false;
  const next = scene.beats[i + 1]?.id ?? scene.beats[i - 1]?.id;
  scene.beats.splice(i, 1);
  for (const track of scene.tracks as unknown as AnyTrack[]) track.keys = track.keys.filter((k) => k.at.beatId !== beatId);
  for (const bl of Object.values(scene.blocking)) {
    if (bl.enter?.beatId === beatId) {
      if (next) bl.enter.beatId = next;
      else delete bl.enter;
    }
    if (bl.exit?.beatId === beatId) {
      if (next) bl.exit.beatId = next;
      else delete bl.exit;
    }
  }
  return true;
}

export function moveBeat(scene: Scene, beatId: string, toIndex: number): boolean {
  const i = scene.beats.findIndex((b) => b.id === beatId);
  if (i < 0) return false;
  const j = Math.max(0, Math.min(scene.beats.length - 1, toIndex));
  if (i === j) return false;
  const [b] = scene.beats.splice(i, 1);
  scene.beats.splice(j, 0, b!);
  return true;
}

// ---- scenes and cast ---------------------------------------------------------------------------------------
export function newSceneId(project: Pick<Project, 'scenes' | 'idSeq'>): string {
  return nextId('s', project.scenes.map((s) => s.id), project);
}

/**
 * Add a scene after `afterSceneId` (null = at the end). It starts from the previous scene's background, wardrobe and
 * blocking when there is one, otherwise from `defaults`; a single starter line is added so the scene can play.
 */
export function insertScene(project: Project, afterSceneId: string | null, defaults: { backgroundId: string; modelOf: (c: CastMember) => string | null }): Scene {
  const i = afterSceneId === null ? project.scenes.length - 1 : project.scenes.findIndex((s) => s.id === afterSceneId);
  const prev = project.scenes[i];
  const id = newSceneId(project);
  const wardrobe: Scene['wardrobe'] = {};
  const blocking: Scene['blocking'] = {};
  if (prev) {
    for (const [cid, w] of Object.entries(prev.wardrobe)) wardrobe[cid] = { modelId: w.modelId, meta: userMeta() };
    for (const [cid, b] of Object.entries(prev.blocking)) blocking[cid] = { slot: b.slot, depth: b.depth, meta: userMeta() };
  } else {
    const present = project.cast.filter((c) => defaults.modelOf(c));
    present.forEach((c, n) => {
      wardrobe[c.id] = { modelId: defaults.modelOf(c)!, meta: userMeta() };
      blocking[c.id] = { slot: present.length === 1 ? 0 : -0.5 + n / Math.max(1, present.length - 1), depth: 0.3, meta: userMeta() };
    });
  }
  const scene: Scene = {
    id, title: `场景 ${project.scenes.length + 1}`, sourceSpan: { start: 0, end: 0 }, meta: userMeta(),
    background: { assetId: prev?.background.assetId ?? defaults.backgroundId, framing: { zoom: 1, offsetX: 0, offsetY: 0 }, meta: userMeta() },
    wardrobe, blocking, transitionIn: { kind: prev ? 'scene_black' : 'cut', duration: 0, meta: userMeta() },
    style: { overrides: {}, meta: userMeta() }, audio: {}, beats: [], tracks: [],
  };
  scene.beats.push(newBeat(scene, { text: '新的台词。' }));
  project.scenes.splice(i + 1, 0, scene);
  return scene;
}

export function removeScene(project: Project, sceneId: string): boolean {
  const i = project.scenes.findIndex((s) => s.id === sceneId);
  if (i < 0) return false;
  project.scenes.splice(i, 1);
  return true;
}

export function moveScene(project: Project, sceneId: string, toIndex: number): boolean {
  const i = project.scenes.findIndex((s) => s.id === sceneId);
  if (i < 0) return false;
  const j = Math.max(0, Math.min(project.scenes.length - 1, toIndex));
  if (i === j) return false;
  const [s] = project.scenes.splice(i, 1);
  project.scenes.splice(j, 0, s!);
  return true;
}

export function nextCastId(project: Pick<Project, 'cast' | 'idSeq'>): string {
  return nextId('c', project.cast.map((c) => c.id), project, 3);
}

/** Put a cast member on stage in a scene (or take them off). Their lines in the scene are kept; a missing speaker just renders without a face. */
export function setActorInScene(scene: Scene, castId: string, present: boolean, modelId: string, slot = 0): void {
  if (!present) {
    delete scene.wardrobe[castId];
    delete scene.blocking[castId];
    scene.tracks = scene.tracks.filter((t) => !(t.target.kind === 'actor' && t.target.castId === castId));
    return;
  }
  scene.wardrobe[castId] ??= { modelId, meta: userMeta() };
  scene.blocking[castId] ??= { slot, depth: 0.3, meta: userMeta() };
}
