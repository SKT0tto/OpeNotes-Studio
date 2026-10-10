/**
 * Intent -> scene. Deterministic: the same direction + base scene always gives the same beats, tracks and ids.
 * Decisions the model made carry `source: 'ai'`; keys derived from them by rule (who looks at whom, when listeners react)
 * carry `source: 'rule'`. Ids follow the editor's rule (monotonic `<prefix>_<n>`, shared `idSeq`), and a beat that matches an
 * existing one (by `keepId`, else by paragraph + speaker + ordinal, else by text) keeps its id, so merges can go by id.
 */
import { nextId, type IdHolder } from '../project/mutate';
import type { DirectedBeat, SceneDirection } from '../schema/ai';
import type { Beat, Meta, Scene, Track } from '../schema/project';
import { aiMeta, ruleMeta } from './fromBreakdown';
import { offsetInParagraph, type Paragraph } from './paragraphs';
import { DEPTH_Y, INSERT_BOX, SLOT_X } from './vocab';

export interface ExpandInput {
  base: Scene;
  direction: SceneDirection;
  paragraphs: Paragraph[];
  genId: string;
  now: number;
  /** The instrument-playing motion family of an actor's live-mode outfit (performance scenes). */
  /** Source stamped on the model's decisions (`rule` for the test-only replay provider). */
  decisions?: 'ai' | 'rule' | undefined;
  playMotionOf?: ((castId: string) => string | null) | undefined;
}

type AnyTrack = Track & { keys: Array<{ id: string; at: { beatId: string; offset: number }; value: unknown; duration: number; ease: string; meta: Meta }> };

const hash = (s: string) => [...s].reduce((a, c) => (a * 31 + c.codePointAt(0)!) >>> 0, 7);
const targetKey = (t: Track['target']) => (t.kind === 'actor' ? `actor:${t.castId}` : t.kind);

export function paragraphOfOffset(paras: readonly Paragraph[], offset: number | undefined): number {
  if (offset === undefined) return -1;
  return paras.find((p) => offset >= p.start && offset <= p.end)?.index ?? -1;
}

/** Which existing beat each directed beat reproduces: by keepId, then paragraph + speaker + ordinal, then identical text. */
export function matchBeats(oldBeats: readonly Beat[], directed: readonly DirectedBeat[], paras: readonly Paragraph[]): Array<string | null> {
  const claimed = new Set<string>();
  const out: Array<string | null> = directed.map((b) => {
    if (b.keepId && oldBeats.some((o) => o.id === b.keepId)) {
      claimed.add(b.keepId);
      return b.keepId;
    }
    return null;
  });
  const ordKey = (para: number, speaker: string | null | undefined, seen: Map<string, number>) => {
    const k = `${para}|${speaker ?? '-'}`;
    const n = seen.get(k) ?? 0;
    seen.set(k, n + 1);
    return `${k}|${n}`;
  };
  const oldByKey = new Map<string, string>();
  const seenOld = new Map<string, number>();
  for (const o of oldBeats) oldByKey.set(ordKey(paragraphOfOffset(paras, o.sourceOffset), o.speakerId, seenOld), o.id);
  const seenNew = new Map<string, number>();
  directed.forEach((b, i) => {
    const k = ordKey(b.paragraph, b.speaker, seenNew);
    if (out[i] !== null) return;
    const id = oldByKey.get(k);
    if (id && !claimed.has(id)) {
      out[i] = id;
      claimed.add(id);
    }
  });
  directed.forEach((b, i) => {
    if (out[i] !== null || !b.text) return;
    const o = oldBeats.find((x) => !claimed.has(x.id) && x.text === b.text);
    if (o) {
      out[i] = o.id;
      claimed.add(o.id);
    }
  });
  return out;
}

export function expandScene(inp: ExpandInput): { scene: Scene; warnings: string[] } {
  const { base, direction: d, paragraphs, genId, now } = inp;
  const warnings: string[] = [];
  const scene: Scene = JSON.parse(JSON.stringify(base)) as Scene;
  const holder: IdHolder = scene;
  const oldBeats = base.beats;
  const oldTracks = base.tracks as AnyTrack[];
  scene.beats = [];
  scene.tracks = [];
  const castIds = Object.keys(base.wardrobe);
  const ai = (reason?: string): Meta => ({ ...aiMeta(genId, reason, now), source: inp.decisions ?? 'ai' });
  const rule = (reason?: string) => ruleMeta(genId, reason, now);

  // ids: never collide with anything the base scene had, even beats / keys that are about to disappear
  const usedBeat = new Set(oldBeats.map((b) => b.id));
  const usedTrack = new Set(oldTracks.map((t) => t.id));
  const usedKey = new Set(oldTracks.flatMap((t) => t.keys.map((k) => k.id)));

  // ---- beats ----------------------------------------------------------------------------------------------
  const matched = matchBeats(oldBeats, d.beats, paragraphs);
  const beatIds: string[] = d.beats.map((_, i) => matched[i] ?? nextId(`${scene.id}b`, usedBeat, holder));
  beatIds.forEach((id) => usedBeat.add(id));
  d.beats.forEach((b, i) => {
    const para = paragraphs[b.paragraph];
    const beat: Beat = {
      id: beatIds[i]!,
      kind: b.kind,
      variant: 'normal',
      coSpeakers: [],
      cutIn: b.cutIn,
      cutInKeepDialog: false,
      text: b.text,
      ...(para ? { sourceOffset: para.start + (b.kind === 'dialogue' ? offsetInParagraph(b.text, para.text) : 0) } : {}),
      duration: { mode: 'auto', seconds: 0 },
      emotion: b.emotion,
      shot: { type: b.shot.type, focus: b.shot.focus, move: b.shot.move, ...(b.shot.dof !== null ? { dof: b.shot.dof } : {}), ...(b.shot.type === 'insert' ? { insertBox: INSERT_BOX[b.shot.insertTarget ?? 'hands'] } : {}), meta: ai(b.reason) },
      style: { overrides: {}, meta: rule() },
      meta: ai(b.reason),
      ...(b.kind === 'dialogue' && b.speaker ? { speakerId: b.speaker } : {}),
    };
    scene.beats.push(beat);
  });

  // ---- tracks ---------------------------------------------------------------------------------------------
  const trackOf = (target: Track['target'], channel: Track['channel']): AnyTrack => {
    const found = (scene.tracks as AnyTrack[]).find((t) => t.channel === channel && targetKey(t.target) === targetKey(target));
    if (found) return found;
    const reuse = oldTracks.find((t) => t.channel === channel && targetKey(t.target) === targetKey(target));
    const id = reuse && !scene.tracks.some((t) => t.id === reuse.id) ? reuse.id : nextId('tr', usedTrack, holder);
    usedTrack.add(id);
    const t = { id, target, channel, meta: ai(), keys: [] } as unknown as AnyTrack;
    (scene.tracks as AnyTrack[]).push(t);
    return t;
  };
  const key = (castId: string | null, channel: Track['channel'], beatIndex: number, offset: number, value: unknown, meta: Meta, duration = 0, ease = 'inOutQuad') => {
    const target = castId === null ? (channel === 'fx' || channel === 'fade' ? { kind: 'screen' as const } : { kind: 'camera' as const }) : { kind: 'actor' as const, castId };
    const tr = trackOf(target as Track['target'], channel);
    const id = nextId('k', usedKey, holder);
    usedKey.add(id);
    tr.keys.push({ id, at: { beatId: beatIds[beatIndex]!, offset: Math.round(offset * 1000) / 1000 }, value, duration, ease, meta });
  };

  const present = new Set(castIds);
  const live = !!scene.brief?.isPerformance;
  let lastFx: SceneDirection['beats'][number]['fx'] = 'none';
  const blocking = d.blocking.reduce<Record<string, { slot: number; depth: number }>>((m, b) => ((m[b.castId] = { slot: SLOT_X[b.slot], depth: DEPTH_Y[b.depth] }), m), {});
  const enters = new Map<string, { beatId: string; side: 'left' | 'right' }>();
  const exits = new Map<string, { beatId: string }>();

  d.beats.forEach((b, bi) => {
    const beatId = beatIds[bi]!;
    const speaker = b.kind === 'dialogue' && b.speaker && present.has(b.speaker) ? b.speaker : null;
    const focus = b.shot.focus.filter((c) => present.has(c));
    // everybody else on stage reacts to the speaker; the speaker addresses the nearest of the people in focus (else on stage)
    const others = castIds.filter((c) => c !== speaker);
    const nearest = (pool: string[]) => [...pool].sort((x, y) => Math.abs(slotOf(x) - slotOf(speaker!)) - Math.abs(slotOf(y) - slotOf(speaker!)))[0] ?? null;
    const explicit = new Map(b.actors.map((a) => [a.castId, a]));
    const slotOf = (c: string) => blocking[c]?.slot ?? base.blocking[c]?.slot ?? 0;
    const turn = (castId: string, target: string, headAt: number, gazeAt: number, meta: Meta) => {
      if (target === 'down') {
        key(castId, 'gaze', bi, gazeAt, { target: 'down' }, meta);
        return;
      }
      key(castId, 'head', bi, headAt, { mode: 'target', target }, meta, 0.3, 'inOutSine');
      key(castId, 'gaze', bi, gazeAt, { target }, meta);
    };

    // speaker looks at the addressee
    if (speaker) {
      const a = explicit.get(speaker);
      const inFocus = others.filter((c) => focus.includes(c));
      const addressee = a?.attention ?? nearest(inFocus.length > 0 ? inFocus : others);
      if (addressee) turn(speaker, addressee, 0, 0.1, a?.attention ? ai(b.reason) : rule('说话人看向听者'));
    }
    // listeners react a moment later; a few look down / away when the emotion calls for it
    for (const c of others) {
      const a = explicit.get(c);
      const delay = 0.2 + 0.1 * (hash(`${c}:${bi}`) % 3);
      const target = a?.attention ?? speaker;
      if (!target) continue;
      turn(c, target, delay, delay + 0.15, a?.attention ? ai(b.reason) : rule('听者转向说话人'));
      if (!a?.attention && speaker && hash(`${c}~${bi}`) % 4 === 0 && ['sad', 'shy', 'thinking'].includes(b.emotion)) key(c, 'gaze', bi, delay + 0.8, { target: 'down' }, rule('情绪：视线下移'));
    }
    // explicit attention of actors that are neither speaker nor listener of this shot
    for (const a of b.actors) {
      if (a.attention && a.castId !== speaker && !others.includes(a.castId)) turn(a.castId, a.attention, 0.15, 0.25, ai(b.reason));
    }
    for (const a of b.actors) {
      if (a.motion) key(a.castId, 'motion', bi, 0.05, { name: a.motion }, ai(b.reason));
      if (a.expression) key(a.castId, 'expression', bi, 0, { name: a.expression }, ai(b.reason));
      if (a.move) key(a.castId, 'position', bi, 0, { slot: SLOT_X[a.move], depth: blocking[a.castId]?.depth ?? base.blocking[a.castId]?.depth ?? 0.3 }, ai(b.reason), 0.8, 'inOutQuad');
      if (a.enter) enters.set(a.castId, { beatId, side: slotOf(a.castId) < 0 ? 'left' : 'right' });
      if (a.exit) exits.set(a.castId, { beatId });
    }
    // performance: everybody plays their instrument from the first beat unless told otherwise
    if (live && bi === 0) {
      for (const c of castIds) {
        const play = inp.playMotionOf?.(c);
        if (explicit.get(c)?.motion || !play) continue;
        key(c, 'motion', 0, 0.05, { name: play }, rule('演奏动作'));
      }
    }
    // emotion effects fade in with the beat that asks for them and out when it changes
    if (b.fx !== lastFx) {
      if (lastFx !== 'none') key(null, 'fx', bi, 0, { fx: lastFx, strength: 0, roll: 0 }, ai(), 0.4);
      if (b.fx !== 'none') key(null, 'fx', bi, 0, { fx: b.fx, strength: 1, roll: b.fx === 'dutch' ? 6 : 0 }, ai(b.reason), 0.5);
      lastFx = b.fx;
    }
  });
  if (lastFx !== 'none') key(null, 'fx', d.beats.length - 1, 4, { fx: lastFx, strength: 0, roll: 0 }, ai(), 0.6);

  for (const c of d.costumeChanges) key(c.castId, 'costume', c.beatIndex, 0, { modelId: c.modelId }, ai(c.reason));

  // drop tracks that ended up without keys (never a locked one: there is none yet in a fresh scene)
  scene.tracks = scene.tracks.filter((t) => t.keys.length > 0);

  // ---- blocking, transition, music --------------------------------------------------------------------------
  for (const c of castIds) {
    const prev = base.blocking[c];
    const pos = live ? prev : blocking[c] ?? prev;
    scene.blocking[c] = {
      slot: pos?.slot ?? 0,
      depth: pos?.depth ?? 0.3,
      ...(enters.has(c) ? { enter: { ...enters.get(c)! } } : {}),
      ...(exits.has(c) ? { exit: { ...exits.get(c)! } } : {}),
      meta: live ? rule('乐队编队') : blocking[c] ? ai(d.reason) : (prev?.meta ?? rule()),
    };
  }
  scene.transitionIn = { kind: d.transitionIn, duration: 0, meta: ai(d.reason) };
  if (d.bgm) scene.audio = { ...scene.audio, bgm: { assetId: d.bgm, volume: 0.5, meta: ai(d.reason) } };
  if (d.beats.length === 0) warnings.push('方向里没有任何节拍');
  return { scene, warnings };
}
