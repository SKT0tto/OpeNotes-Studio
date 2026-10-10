import { describe, expect, it } from 'vitest';
import { expandScene } from '../../shared/director/expand';
import { mergeLocks } from '../../shared/director/mergeLocks';
import { SCOPES, resolveScope } from '../../shared/director/scope';
import { validateDirection } from '../../shared/director/validate';
import { findLockViolations } from '../../shared/project/locks';
import type { Meta, Project, Scene } from '../../shared/schema/project';
import { clone, directedProject, paragraphs, recordedDirection, sceneCtx } from './helpers/directorFlow';

const META = (over: Partial<Meta> = {}): Meta => ({ source: 'user', locked: false, updatedAt: 5, ...over });
const base = directedProject();
const SI = 2; // the long café scene
const old = (): Scene => clone(base.scenes[SI]!);
/** A "regeneration": the same direction expanded again on top of the existing scene, with a different genId so ai units differ from the old ones. */
const fresh = (s: Scene, tweak?: (d: ReturnType<typeof recordedDirection>) => void): Scene => {
  const d = clone(validateDirection(recordedDirection(SI), sceneCtx(base, s)).value);
  d.beats.forEach((b) => {
    b.shot.type = b.shot.type === 'mcu' ? 'cu' : 'mcu';
    b.emotion = b.emotion === 'neutral' ? 'happy' : 'neutral';
  });
  tweak?.(d);
  return expandScene({ base: s, direction: d, paragraphs, genId: 'g9', now: 9000 }).scene;
};

const castOf = (s: Scene) => Object.keys(s.wardrobe);
const keyIdsOf = (s: Scene) => s.tracks.flatMap((t) => t.keys.map((k) => k.id));

describe('scope table', () => {
  it('is the single mapping: camera = camera track + shot fields, performance = five channels + emotion', () => {
    expect(SCOPES.camera.tracks).toEqual(['camera']);
    expect(SCOPES.camera.beatFields).toEqual(['shot', 'cutIn', 'cutInKeepDialog']);
    expect(SCOPES.performance.tracks).toEqual(['motion', 'expression', 'head', 'body', 'gaze']);
    expect(SCOPES.costume).toMatchObject({ sceneFields: ['wardrobe'], tracks: ['costume'] });
    expect(SCOPES.staging).toMatchObject({ sceneFields: ['blocking'], tracks: ['position', 'opacity'] });
    expect(SCOPES.fx.tracks).toEqual(['fx', 'fade']);
    expect(resolveScope(['scene']).structure).toBe(true);
    expect(resolveScope(['camera', 'fx']).tracks.size).toBe(3);
  });
});

describe('mergeLocks: whole scene regeneration', () => {
  it('replaces unlocked AI content and changes it', () => {
    const o = old();
    const r = mergeLocks(o, fresh(o), { scopes: ['scene'] });
    expect(r.applied).toBe(true);
    expect(r.scene.beats.map((b) => b.id)).toEqual(o.beats.map((b) => b.id)); // ids are stable
    expect(JSON.stringify(r.scene.beats)).not.toBe(JSON.stringify(o.beats));
    expect(r.scene.beats.some((b, i) => b.shot.type !== o.beats[i]!.shot.type)).toBe(true);
  });

  it('keeps locked beats, locked tracks, locked keys, locked wardrobe and locked transition exactly', () => {
    const o = old();
    const lockedBeat = o.beats.find((b) => b.kind === 'dialogue')!;
    lockedBeat.meta = META({ locked: true, source: 'user' });
    lockedBeat.text += '（人工改过）';
    const camera = o.tracks.find((t) => t.channel === 'gaze')!;
    camera.meta = META({ locked: true });
    const motion = o.tracks.find((t) => t.channel === 'motion')!;
    const lockedKey = motion.keys[0]!;
    lockedKey.meta = META({ locked: true });
    const wcast = castOf(o)[0]!;
    o.wardrobe[wcast]!.meta = META({ locked: true });
    o.wardrobe[wcast]!.modelId = o.wardrobe[wcast]!.modelId.replace('school_winter_hs_1st', 'casual_spring_01');
    o.transitionIn.meta = META({ locked: true });
    const before = clone(o);
    const r = mergeLocks(o, fresh(o), { scopes: ['scene'] });
    expect(r.applied).toBe(true);
    const out = r.scene;
    expect(out.beats.find((b) => b.id === lockedBeat.id)).toEqual(before.beats.find((b) => b.id === lockedBeat.id));
    expect(out.tracks.find((t) => t.id === camera.id)).toEqual(before.tracks.find((t) => t.id === camera.id));
    expect(out.tracks.find((t) => t.id === motion.id)!.keys.find((k) => k.id === lockedKey.id)).toEqual(lockedKey);
    expect(out.wardrobe[wcast]).toEqual(before.wardrobe[wcast]);
    expect(out.transitionIn).toEqual(before.transitionIn);
    expect(findLockViolations(before, out)).toEqual([]);
    expect(r.report.protectedKept.length).toBeGreaterThan(0);
  });

  it('a person-edited (source=user, unlocked) line keeps its text but its camera and performance are still regenerated', () => {
    const o = old();
    const b = o.beats.find((x) => x.kind === 'dialogue')!;
    b.meta = META({ source: 'user' });
    b.text = '人工改写的台词。';
    const r = mergeLocks(o, fresh(o), { scopes: ['scene'] });
    const nb = r.scene.beats.find((x) => x.id === b.id)!;
    expect(nb.text).toBe('人工改写的台词。');
    expect(nb.meta.source).toBe('user');
    expect(nb.shot.type).not.toBe(b.shot.type); // the shot was not protected
    // ... unless the person touched the shot too
    const o2 = old();
    const b2 = o2.beats.find((x) => x.kind === 'dialogue')!;
    b2.shot.meta = META({ source: 'user' });
    const r2 = mergeLocks(o2, fresh(o2), { scopes: ['scene'] });
    expect(r2.scene.beats.find((x) => x.id === b2.id)!.shot).toEqual(b2.shot);
  });

  it('overwriteUser replaces user-edited content, but never locked content', () => {
    const o = old();
    const [a, b] = o.beats.filter((x) => x.kind === 'dialogue');
    a!.meta = META({ source: 'user' });
    a!.text = '人工';
    b!.meta = META({ source: 'user', locked: true });
    b!.text = '锁定的人工';
    const r = mergeLocks(o, fresh(o), { scopes: ['scene'], overwriteUser: true });
    expect(r.scene.beats.find((x) => x.id === a!.id)!.text).not.toBe('人工');
    expect(r.scene.beats.find((x) => x.id === b!.id)!.text).toBe('锁定的人工');
  });

  it('field locks: a locked text / shot.type survives, the other fields of the unit are regenerated', () => {
    const o = old();
    const b = o.beats.find((x) => x.kind === 'dialogue')!;
    b.meta = META({ source: 'ai', lockedFields: ['text', 'emotion'] });
    b.shot.meta = META({ source: 'ai', lockedFields: ['type'] });
    const f = fresh(o, (d) => {
      const i = o.beats.indexOf(b);
      d.beats[i]!.text = '被模型改写的文本';
      d.beats[i]!.shot.move = 'push_in';
    });
    const r = mergeLocks(o, f, { scopes: ['scene'] });
    const nb = r.scene.beats.find((x) => x.id === b.id)!;
    expect(nb.text).toBe(b.text);
    expect(nb.emotion).toBe(b.emotion);
    expect(nb.shot.type).toBe(b.shot.type);
    expect(nb.shot.move).toBe('push_in'); // not locked: regenerated
    expect(nb.meta.lockedFields).toEqual(['text', 'emotion']); // the lock itself survives
    expect(nb.shot.meta.lockedFields).toEqual(['type']);
  });

  it('reports a conflict and keeps the old scene when a locked beat has no counterpart in the new direction', () => {
    const o = old();
    const lockedBeat = o.beats[4]!;
    lockedBeat.meta = META({ locked: true });
    const f = fresh(o, (d) => {
      d.beats = d.beats.filter((_, i) => i !== 4);
    });
    // make sure the lost beat really has no match (no keepId, other paragraph/ordinal)
    f.beats = f.beats.filter((b) => b.id !== lockedBeat.id);
    const r = mergeLocks(o, f, { scopes: ['scene'] });
    expect(r.applied).toBe(false);
    expect(r.conflicts[0]!.kind).toBe('locked_beat_missing');
    expect(r.scene).toBe(o);
  });

  it('a hand-made unlocked beat the model does not know stays where it was', () => {
    const o = old();
    const extra = clone(o.beats[3]!);
    extra.id = `${o.id}b_99`;
    extra.text = '人工插入的一句。';
    extra.meta = META({ source: 'user' });
    o.beats.splice(4, 0, extra);
    const r = mergeLocks(o, fresh(o), { scopes: ['scene'] });
    const ids = r.scene.beats.map((b) => b.id);
    expect(ids).toContain(extra.id);
    expect(ids.indexOf(extra.id)).toBe(ids.indexOf(o.beats[3]!.id) + 1);
  });

  it('a locked key whose beat disappears is a conflict, never silently dropped', () => {
    const o = old();
    const lastBeat = o.beats.at(-1)!;
    const tr = o.tracks.find((t) => t.channel === 'gaze')!;
    tr.keys.push({ id: 'k_900', at: { beatId: lastBeat.id, offset: 0.2 }, value: { target: 'down' }, duration: 0, ease: 'inOutQuad', meta: META({ locked: true }) } as never);
    const f = fresh(o, (d) => {
      d.beats.pop();
    });
    f.beats.pop();
    const r = mergeLocks(o, f, { scopes: ['scene'] });
    expect(r.applied).toBe(false);
    expect(r.conflicts.length).toBeGreaterThan(0);
  });
});

describe('mergeLocks: partial regeneration', () => {
  const diffKeys = (a: Scene, b: Scene) => (Object.keys(a) as Array<keyof Scene>).filter((k) => k !== 'idSeq').filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]));

  it('scope camera changes only beat.shot / cut-in and the camera track', () => {
    const o = old();
    const r = mergeLocks(o, fresh(o), { scopes: ['camera'] });
    expect(r.applied).toBe(true);
    expect(diffKeys(o, r.scene)).toEqual(['beats']);
    r.scene.beats.forEach((b, i) => {
      const ob = o.beats[i]!;
      expect({ ...b, shot: 0, meta: 0 }).toEqual({ ...ob, shot: 0, meta: 0 });
    });
    expect(r.scene.beats.some((b, i) => b.shot.type !== o.beats[i]!.shot.type)).toBe(true);
    expect(JSON.stringify(r.scene.tracks)).toBe(JSON.stringify(o.tracks));
  });

  it('scope performance replaces motion / expression / head / gaze keys and the emotion, nothing else', () => {
    const o = old();
    const r = mergeLocks(o, fresh(o), { scopes: ['performance'] });
    r.scene.beats.forEach((b, i) => expect(b.shot).toEqual(o.beats[i]!.shot));
    expect(r.scene.beats.some((b, i) => b.emotion !== o.beats[i]!.emotion)).toBe(true);
    expect(JSON.stringify(r.scene.blocking)).toBe(JSON.stringify(o.blocking));
    expect(JSON.stringify(r.scene.wardrobe)).toBe(JSON.stringify(o.wardrobe));
    const chan = (s: Scene, c: string) => JSON.stringify(s.tracks.filter((t) => t.channel === c));
    for (const c of ['costume', 'position', 'opacity', 'fx', 'camera']) expect(chan(r.scene, c)).toBe(chan(o, c));
    expect(chan(r.scene, 'gaze')).not.toBe(chan(o, 'gaze'));
  });

  it('beatIds limit the regeneration to those lines; keys of other lines are untouched', () => {
    const o = old();
    const target = o.beats.filter((b) => b.kind === 'dialogue').slice(2, 4).map((b) => b.id);
    const r = mergeLocks(o, fresh(o), { scopes: ['scene'], beatIds: target });
    r.scene.beats.forEach((b, i) => {
      const ob = o.beats[i]!;
      if (target.includes(b.id)) expect(b.shot.type).not.toBe(ob.shot.type);
      else expect(b).toEqual(ob);
    });
    const outside = (s: Scene) => JSON.stringify(s.tracks.map((t) => [t.id, t.keys.filter((k) => !target.includes(k.at.beatId))]));
    expect(outside(r.scene)).toBe(outside(o));
  });

  it('a locked track or locked key survives every scope; a protected key suppresses new keys of that line on its track', () => {
    const o = old();
    const track = o.tracks.find((t) => t.channel === 'gaze' && t.keys.length > 3)!;
    const k = track.keys[2]!;
    k.meta = META({ locked: true });
    const r = mergeLocks(o, fresh(o), { scopes: ['performance'] });
    const nk = r.scene.tracks.find((t) => t.id === track.id)!.keys;
    expect(nk.find((x) => x.id === k.id)).toEqual(k);
    expect(nk.filter((x) => x.at.beatId === k.at.beatId).length).toBe(track.keys.filter((x) => x.at.beatId === k.at.beatId && x.meta.locked).length || 1);
    const o2 = old();
    const lockedTrack = o2.tracks.find((t) => t.channel === 'motion')!;
    lockedTrack.meta = META({ locked: true });
    for (const scope of ['performance', 'scene'] as const) {
      const r2 = mergeLocks(o2, fresh(o2), { scopes: [scope] });
      expect(r2.scene.tracks.find((t) => t.id === lockedTrack.id)).toEqual(lockedTrack);
    }
  });

  it('the lock gate: for every scope and a heavily locked scene, nothing locked ever differs', () => {
    const o = old();
    o.beats.forEach((b, i) => {
      if (i % 3 === 0) b.meta = META({ locked: true });
      if (i % 3 === 1) b.shot.meta = META({ locked: true });
    });
    o.tracks.forEach((t, i) => {
      if (i % 4 === 0) t.meta = META({ locked: true });
      t.keys.forEach((k, j) => {
        if (j % 5 === 0) k.meta = META({ locked: true });
      });
    });
    for (const [n, w] of Object.entries(o.wardrobe)) if (n.endsWith('1')) w.meta = META({ locked: true });
    for (const scope of ['scene', 'camera', 'performance', 'costume', 'staging', 'fx'] as const) {
      const r = mergeLocks(o, fresh(o), { scopes: [scope] });
      expect(findLockViolations(o, r.scene), scope).toEqual([]);
      if (r.applied) expect(keyIdsOf(r.scene).length).toBeGreaterThan(0);
    }
  });
});

describe('ids across merges', () => {
  it('regenerating twice never reuses an id that was ever issued, and idSeq keeps growing', () => {
    let s = old();
    const issued = new Set(keyIdsOf(s));
    let maxSeq = s.idSeq?.k ?? 0;
    for (let n = 0; n < 3; n++) {
      s = mergeLocks(s, fresh(s), { scopes: ['scene'] }).scene;
      const ids = keyIdsOf(s);
      expect(new Set(ids).size).toBe(ids.length);
      expect(s.idSeq!.k!).toBeGreaterThanOrEqual(maxSeq);
      maxSeq = s.idSeq!.k!;
      for (const id of ids) issued.add(id);
    }
    expect(issued.size).toBeGreaterThan(keyIdsOf(old()).length);
    const project: Project = { ...base, scenes: base.scenes.map((x, i) => (i === SI ? s : x)) };
    expect(project.scenes[SI]!.beats.length).toBe(old().beats.length);
  });
});
