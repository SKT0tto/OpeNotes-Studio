import { describe, expect, it } from 'vitest';
import {
  absTime, addKey, anchorAt, duplicateBeat, ensureTrack, findTrack, insertBeat, insertScene, keyLocked, keyTimes, locateKey, moveBeat, moveKeyTo, moveScene, nextCastId,
  removeBeat, removeKey, removeScene, setActorInScene, storedBeatTimes,
} from '../../shared/project/mutate';
import { compileProject } from '../../shared/timeline/compile';
import { miniProject, MINI_CTX } from './helpers/synthetic';

describe('time anchoring', () => {
  const p = miniProject();
  const beats = storedBeatTimes(p, 0);

  it('lists the stored beats with consecutive times', () => {
    expect(beats.map((b) => b.beatId)).toEqual(['b1', 'b2', 'b3']);
    expect(beats[1]!.start).toBeCloseTo(beats[0]!.end, 6);
  });

  it('anchors inside a beat, across a boundary, before the first and after the last beat', () => {
    const mid = (beats[1]!.start + beats[1]!.end) / 2;
    expect(anchorAt(beats, mid)).toEqual({ beatId: 'b2', offset: expect.closeTo(mid - beats[1]!.start, 3) });
    expect(anchorAt(beats, beats[2]!.start)!.beatId).toBe('b3');
    expect(anchorAt(beats, beats[2]!.start - 0.001)!.beatId).toBe('b2');
    expect(anchorAt(beats, -1)).toEqual({ beatId: 'b1', offset: expect.closeTo(-1 - beats[0]!.start, 3) });
    expect(anchorAt(beats, beats[2]!.end + 2)!.beatId).toBe('b3');
    expect(anchorAt([], 3)).toBeNull();
  });

  it('absTime inverts anchorAt', () => {
    for (const t of [0.4, 2.2, 5.1]) expect(absTime(beats, anchorAt(beats, t)!)).toBeCloseTo(t, 2);
  });
});

describe('keys', () => {
  it('re-anchors a key to the next beat when dragged across the boundary and keeps its absolute time', () => {
    const p = miniProject();
    const beats = storedBeatTimes(p, 0);
    const scene = p.scenes[0]!;
    const tr = ensureTrack(scene, { kind: 'actor', castId: 'a' }, 'expression');
    const k = addKey(scene, tr, { beatId: 'b1', offset: 0.5 }, { name: 'exp_smile01' });
    expect(moveKeyTo(scene, k.id, beats, beats[1]!.start + 0.25)).toBe(true);
    expect(locateKey(scene, k.id)!.key.at).toEqual({ beatId: 'b2', offset: 0.25 });
    expect(keyTimes(scene, beats)[0]!.at).toBeCloseTo(beats[1]!.start + 0.25, 3);
  });

  it('creates one track per target+channel, ids stay unique, delete removes only that key', () => {
    const p = miniProject();
    const scene = p.scenes[0]!;
    const t1 = ensureTrack(scene, { kind: 'actor', castId: 'a' }, 'head');
    expect(ensureTrack(scene, { kind: 'actor', castId: 'a' }, 'head')).toBe(t1);
    const t2 = ensureTrack(scene, { kind: 'actor', castId: 'b' }, 'head');
    expect(t2.id).not.toBe(t1.id);
    const k1 = addKey(scene, t1, { beatId: 'b1', offset: 0 }, { mode: 'angle', yaw: 0.5 });
    const k2 = addKey(scene, t2, { beatId: 'b1', offset: 0 }, { mode: 'angle', yaw: -0.5 });
    expect(k1.id).not.toBe(k2.id);
    expect(removeKey(scene, k1.id)).toBe(true);
    expect(findTrack(scene, { kind: 'actor', castId: 'b' }, 'head')!.keys).toHaveLength(1);
    expect(removeKey(scene, 'nope')).toBe(false);
  });

  it('a key is protected by its own or its track lock', () => {
    const p = miniProject();
    const scene = p.scenes[0]!;
    const tr = ensureTrack(scene, { kind: 'camera' }, 'camera');
    const k = addKey(scene, tr, { beatId: 'b1', offset: 0 }, { manual: { x: 1, y: 2, zoom: 2 } });
    expect(keyLocked(tr, k)).toBe(false);
    k.meta.locked = true;
    expect(keyLocked(tr, k)).toBe(true);
    k.meta.locked = false;
    tr.meta.locked = true;
    expect(keyLocked(tr, k)).toBe(true);
  });

  it('a key made by the helpers compiles: the head key turns the actor and the schema accepts it', () => {
    const p = miniProject();
    const scene = p.scenes[0]!;
    const tr = ensureTrack(scene, { kind: 'actor', castId: 'a' }, 'head');
    addKey(scene, tr, { beatId: 'b2', offset: 0.2 }, { mode: 'angle', yaw: 0.8 }, { duration: 0.3 });
    const c = compileProject(p, MINI_CTX);
    const a = c.scenes[0]!.actors.find((x) => x.castId === 'a')!;
    expect(a.yaw.some((k) => k.value === 0.8)).toBe(true);
  });
});

describe('beats and scenes', () => {
  it('inserts, duplicates, moves and removes beats; ids stay unique and keys follow their beat', () => {
    const p = miniProject();
    const scene = p.scenes[0]!;
    const tr = ensureTrack(scene, { kind: 'actor', castId: 'a' }, 'expression');
    const key = addKey(scene, tr, { beatId: 'b3', offset: 0 }, { name: 'exp_smile01' });
    const nb = insertBeat(scene, 'b1', { text: 'new' });
    expect(scene.beats.map((b) => b.id)).toEqual(['b1', nb.id, 'b2', 'b3']);
    expect(new Set(scene.beats.map((b) => b.id)).size).toBe(4);
    const dup = duplicateBeat(scene, 'b2')!;
    expect(scene.beats[scene.beats.indexOf(scene.beats.find((b) => b.id === 'b2')!) + 1]!.id).toBe(dup.id);
    expect(moveBeat(scene, 'b3', 0)).toBe(true);
    expect(scene.beats[0]!.id).toBe('b3');
    expect(locateKey(scene, key.id)!.key.at.beatId).toBe('b3');
    expect(removeBeat(scene, 'b3')).toBe(true);
    expect(locateKey(scene, key.id)).toBeNull();
  });

  it('removing a beat moves enter / exit markers to a neighbour', () => {
    const p = miniProject();
    const scene = p.scenes[0]!;
    scene.blocking.a!.enter = { beatId: 'b2', side: 'left' };
    scene.blocking.a!.exit = { beatId: 'b3' };
    removeBeat(scene, 'b2');
    expect(scene.blocking.a!.enter!.beatId).toBe('b3');
    removeBeat(scene, 'b3');
    expect(scene.blocking.a!.exit!.beatId).toBe('b1');
  });

  it('adds scenes after the chosen one, inheriting stage setup; reorders and removes; the result still compiles', () => {
    const p = miniProject();
    const added = insertScene(p, 's1', { backgroundId: 'bg1', modelOf: () => 'mA' });
    expect(p.scenes.map((s) => s.id)).toEqual(['s1', added.id]);
    expect(Object.keys(added.wardrobe)).toEqual(['a', 'b']);
    expect(added.beats).toHaveLength(1);
    expect(compileProject(p, MINI_CTX).scenes).toHaveLength(2);
    expect(moveScene(p, added.id, 0)).toBe(true);
    expect(p.scenes[0]!.id).toBe(added.id);
    expect(removeScene(p, added.id)).toBe(true);
    expect(p.scenes).toHaveLength(1);
  });

  it('the first scene of a project takes its actors from the cast; actors can be added to and removed from a scene', () => {
    const p = miniProject();
    p.scenes = [];
    const s = insertScene(p, null, { backgroundId: 'bg1', modelOf: () => 'mA' });
    expect(Object.keys(s.blocking)).toEqual(['a', 'b']);
    expect(s.blocking.a!.slot).toBeLessThan(s.blocking.b!.slot);
    setActorInScene(s, 'b', false, 'mB');
    expect(Object.keys(s.wardrobe)).toEqual(['a']);
    setActorInScene(s, 'b', true, 'mB', 0.5);
    expect(s.blocking.b!.slot).toBe(0.5);
    expect(nextCastId(p)).toBe('c_001');
    expect(nextCastId(p)).toBe('c_002'); // ids are never handed out twice
  });
});
