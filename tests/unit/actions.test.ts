import { beforeEach, describe, expect, it } from 'vitest';
import { absTime, findTrack, locateKey, storedBeatTimes } from '../../shared/project/mutate';
import type { Project } from '../../shared/schema/project';
import { buildStageMap } from '../../shared/staging/compactStage';
import { compileProject } from '../../shared/timeline/compile';
import {
  addBeatAfter, bakeRuleKeys, clearManualCamera, copyKeys, deleteBeat, deleteKeys, editBeat, editShot, keyNear, lockKey, lockTrack, manualCameraKey, moveKeys, pasteKeys, patchKey,
  placeActorAt, reorderBeat, setManualCamera, setSlotDepth, writeKey,
} from '../../web/store/actions';
import { useProject } from '../../web/store/projectStore';
import { useUi } from '../../web/store/uiStore';
import { MINI_CTX, miniProject } from './helpers/synthetic';

const st = () => useProject.getState();
const proj = () => st().project as Project;
const A = { kind: 'actor', castId: 'a' } as const;
const toastText = () => useUi.getState().toast?.text ?? '';

beforeEach(() => {
  st().open(miniProject(), 'etag');
  useUi.getState().set({ toast: null, keySel: [], clip: [] });
});

describe('writeKey / locks / undo (applyEdit rules)', () => {
  it('creates the track and key on first write, stamps them as user edits, and updates the same key later', () => {
    expect(writeKey('s1', A, 'expression', { name: 'exp_smile01' }, 1.0, { label: 'x' })).toBe('ok');
    const tr = findTrack(proj().scenes[0]!, A, 'expression')!;
    expect(tr.keys).toHaveLength(1);
    expect(tr.meta.source).toBe('user');
    expect(tr.keys[0]!.meta.source).toBe('user');
    expect(tr.keys[0]!.meta.locked).toBe(false);
    writeKey('s1', A, 'expression', { name: 'exp_sad01' }, 1.02, { label: 'x' });
    const tr2 = findTrack(proj().scenes[0]!, A, 'expression')!;
    expect(tr2.keys).toHaveLength(1);
    expect(tr2.keys[0]!.value).toEqual({ name: 'exp_sad01' });
    writeKey('s1', A, 'expression', { name: 'exp_shy01' }, 3.0, { label: 'x' });
    expect(findTrack(proj().scenes[0]!, A, 'expression')!.keys).toHaveLength(2);
  });

  it('is undone as one step and redone', () => {
    writeKey('s1', A, 'head', { mode: 'angle', yaw: 0.2 }, 1, { label: '转头', coalesce: 'h' });
    writeKey('s1', A, 'head', { mode: 'angle', yaw: 0.4 }, 1, { label: '转头', coalesce: 'h' });
    writeKey('s1', A, 'head', { mode: 'angle', yaw: 0.6 }, 1, { label: '转头', coalesce: 'h' });
    st().seal();
    expect(st().undoLabel).toBe('转头');
    st().undo();
    expect(findTrack(proj().scenes[0]!, A, 'head')).toBeUndefined();
    st().redo();
    expect(findTrack(proj().scenes[0]!, A, 'head')!.keys[0]!.value).toEqual({ mode: 'angle', yaw: 0.6 });
  });

  it('a locked key and a locked track refuse writes, moves, patches and deletes (and say so)', () => {
    writeKey('s1', A, 'head', { mode: 'angle', yaw: 0.2 }, 1, { label: 'x' });
    const key = findTrack(proj().scenes[0]!, A, 'head')!.keys[0]!;
    lockKey('s1', key.id, true);
    expect(locateKey(proj().scenes[0]!, key.id)!.key.meta.locked).toBe(true);
    expect(writeKey('s1', A, 'head', { mode: 'angle', yaw: -1 }, 1, { label: 'x' })).toBe('locked');
    expect(toastText()).toContain('已锁定');
    expect(patchKey('s1', key.id, { duration: 2 }, 'x')).toBe('locked');
    expect(moveKeys('s1', [{ id: key.id, t: 3 }])).toBe(0);
    expect(deleteKeys('s1', [key.id])).toBe(0);
    expect(locateKey(proj().scenes[0]!, key.id)!.key.value).toEqual({ mode: 'angle', yaw: 0.2 });
    lockKey('s1', key.id, false);
    lockTrack('s1', findTrack(proj().scenes[0]!, A, 'head')!.id, true);
    expect(writeKey('s1', A, 'head', { mode: 'angle', yaw: 0.9 }, 5, { label: 'x' })).toBe('locked');
    expect(findTrack(proj().scenes[0]!, A, 'head')!.keys).toHaveLength(1);
    lockTrack('s1', findTrack(proj().scenes[0]!, A, 'head')!.id, false);
    expect(writeKey('s1', A, 'head', { mode: 'angle', yaw: 0.9 }, 5, { label: 'x' })).toBe('ok');
  });

  it('moving keys re-anchors them to the beat they land in; copies leave the original', () => {
    writeKey('s1', A, 'expression', { name: 'exp_smile01' }, 0.5, { label: 'x' });
    const p = proj();
    const beats = storedBeatTimes(p, 0);
    const id = findTrack(p.scenes[0]!, A, 'expression')!.keys[0]!.id;
    expect(moveKeys('s1', [{ id, t: beats[2]!.start + 0.3 }])).toBe(1);
    const k = locateKey(proj().scenes[0]!, id)!.key;
    expect(k.at.beatId).toBe('b3');
    expect(absTime(storedBeatTimes(proj(), 0), k.at)).toBeCloseTo(beats[2]!.start + 0.3, 2);
    moveKeys('s1', [{ id, t: 0.2 }], true);
    expect(findTrack(proj().scenes[0]!, A, 'expression')!.keys).toHaveLength(2);
    expect(useUi.getState().keySel).toHaveLength(1);
  });

  it('copy / paste puts the keys at the playhead keeping their spacing; locked target tracks refuse', () => {
    writeKey('s1', A, 'expression', { name: 'exp_smile01' }, 0.5, { label: 'x' });
    writeKey('s1', A, 'expression', { name: 'exp_sad01' }, 1.5, { label: 'x' });
    const ids = findTrack(proj().scenes[0]!, A, 'expression')!.keys.map((k) => k.id);
    expect(copyKeys('s1', ids)).toBe(2);
    expect(pasteKeys('s1', 4)).toBe(2);
    const keys = findTrack(proj().scenes[0]!, A, 'expression')!.keys;
    expect(keys).toHaveLength(4);
    const times = keys.map((k) => absTime(storedBeatTimes(proj(), 0), k.at)!).sort((x, y) => x - y);
    expect(times[3]! - times[2]!).toBeCloseTo(1, 2);
    lockTrack('s1', findTrack(proj().scenes[0]!, A, 'expression')!.id, true);
    expect(pasteKeys('s1', 6)).toBe(0);
  });

  it('keyNear finds the key at the time or the one whose transition covers it', () => {
    writeKey('s1', A, 'position', { slot: 0, depth: 0.2 }, 1, { label: 'x', duration: 1 });
    expect(keyNear(proj(), 's1', A, 'position', 1.5)).not.toBeNull();
    expect(keyNear(proj(), 's1', A, 'position', 3)).toBeNull();
  });
});

describe('stage and shot edits', () => {
  it('placing a person edits the blocking (source user, one undo step); a position key at / before the time is edited instead; a locked blocking refuses', () => {
    const bg = { width: 2048, ground: { horizonY: 560, floorY: 1040 } };
    expect(placeActorAt('s1', 'a', { x: 700, y: 950 }, bg, 1)).toBe('ok');
    const b = proj().scenes[0]!.blocking.a!;
    expect(b.meta.source).toBe('user');
    expect(b.slot).toBeLessThan(0);
    st().undo();
    expect(proj().scenes[0]!.blocking.a!.slot).toBe(-0.4);
    writeKey('s1', A, 'position', { slot: 0.1, depth: 0.1 }, 1, { label: 'x' });
    setSlotDepth('s1', 'a', { slot: 0.7, depth: 0.5 }, 2);
    expect(findTrack(proj().scenes[0]!, A, 'position')!.keys[0]!.value).toEqual({ slot: 0.7, depth: 0.5 });
    expect(proj().scenes[0]!.blocking.a!.slot).toBe(-0.4);
    st().applyEdit((d) => void (d.scenes[0]!.blocking.b!.meta.locked = true), 'lock');
    expect(setSlotDepth('s1', 'b', { slot: 0, depth: 0.2 }, 1)).toBe('locked');
    expect(proj().scenes[0]!.blocking.b!.slot).toBe(0.4);
  });

  it('in a travel scene the dragged feet position is converted back through the compact stage (and not through the slot scale)', () => {
    const bg = { width: 2048, ground: { horizonY: 560, floorY: 1040 } };
    const stage = buildStageMap([-0.4, 0.4], 150, 1024); // a at x 949, b at x 1099
    expect(placeActorAt('s1', 'a', { x: 1099, y: 950 }, bg, 1, stage)).toBe('ok');
    expect(proj().scenes[0]!.blocking.a!.slot).toBeCloseTo(0.4, 3);
    st().undo();
    expect(placeActorAt('s1', 'a', { x: 1024, y: 950 }, bg, 1, stage)).toBe('ok');
    expect(proj().scenes[0]!.blocking.a!.slot).toBeCloseTo(0, 3);
    // without a stage the same x lands on the classic slot scale
    st().undo();
    placeActorAt('s1', 'a', { x: 1099, y: 950 }, bg, 1);
    expect(proj().scenes[0]!.blocking.a!.slot).toBeCloseTo(((1099 / 2048) - 0.5) / 0.38, 3);
  });

  it('a manual camera is a key at the start of the line; clearing it brings the solver back; locks protect it', () => {
    setManualCamera('s1', 'b2', { x: 800, y: 500, zoom: 2.5 }, 'x');
    const key = manualCameraKey(proj().scenes[0]!, 'b2')!;
    expect(key.value).toEqual({ manual: { x: 800, y: 500, zoom: 2.5 } });
    const c = compileProject(proj(), MINI_CTX).scenes[0]!;
    const b2 = c.beats.find((b) => b.id === 'b2')!;
    expect(c.camera.filter((k) => Math.abs(k.at - b2.start) < 1e-6).at(-1)!.pose).toMatchObject({ x: 800, y: 500, zoom: 2.5 });
    setManualCamera('s1', 'b2', { x: 810, y: 500, zoom: 2.5 }, 'x', 'pan');
    expect(findTrack(proj().scenes[0]!, { kind: 'camera' }, 'camera')!.keys).toHaveLength(1);
    lockKey('s1', key.id, true);
    expect(setManualCamera('s1', 'b2', { x: 1, y: 1, zoom: 1 }, 'x')).toBe('locked');
    lockKey('s1', key.id, false);
    clearManualCamera('s1', 'b2');
    expect(manualCameraKey(proj().scenes[0]!, 'b2')).toBeUndefined();
  });

  it('lines: add / edit / reorder / delete; a locked shot or line refuses edits; the last line cannot be deleted', () => {
    const id = addBeatAfter('s1', 'b1', { text: '新台词' })!;
    expect(proj().scenes[0]!.beats[1]!.id).toBe(id);
    expect(editBeat('s1', id, 'x', (b) => void (b.text = '改')) ).toBe('ok');
    expect(proj().scenes[0]!.beats[1]!.meta.source).toBe('user');
    reorderBeat('s1', id, 0);
    expect(proj().scenes[0]!.beats[0]!.id).toBe(id);
    expect(editShot('s1', 'b1', 'x', (s) => void (s.type = 'cu'))).toBe('ok');
    st().applyEdit((d) => void (d.scenes[0]!.beats[1]!.shot.meta.locked = true), 'lock');
    expect(editShot('s1', 'b1', 'x', (s) => void (s.type = 'ecu'))).toBe('locked');
    expect(proj().scenes[0]!.beats[1]!.shot.type).toBe('cu');
    expect(editShot('s1', 'b1', 'unlock', (s) => void (s.meta.locked = false), undefined, true)).toBe('ok');
    deleteBeat('s1', id);
    expect(proj().scenes[0]!.beats.map((b) => b.id)).toEqual(['b1', 'b2', 'b3']);
    deleteBeat('s1', 'b3');
    deleteBeat('s1', 'b2');
    deleteBeat('s1', 'b1');
    expect(proj().scenes[0]!.beats).toHaveLength(1);
    expect(toastText()).toContain('至少');
  });
});

describe('rule director output is visible and bakeable', () => {
  const style = { 'performance.ruleDirector': true, 'rhythm.enforceMinShot': false, 'performance.gestureEvery': 1 };

  it('compile lists the keys it made on its own, in the shape of real keys', () => {
    const p = miniProject({ style });
    p.scenes[0]!.beats[0]!.emotion = 'happy';
    const a = compileProject(p, MINI_CTX).scenes[0]!.actors.find((x) => x.castId === 'a')!;
    expect(a.ruleKeys.some((k) => k.channel === 'expression')).toBe(true);
    expect(a.ruleKeys.some((k) => k.channel === 'motion')).toBe(true);
    const b = compileProject(p, MINI_CTX).scenes[0]!.actors.find((x) => x.castId === 'b')!;
    expect(b.ruleKeys.some((k) => k.channel === 'head')).toBe(true);
    for (const k of a.ruleKeys) expect(p.scenes[0]!.beats.some((x) => x.id === k.beatId)).toBe(true);
  });

  it('baking every ghost key into real keys leaves the compiled performance unchanged', () => {
    const p = miniProject({ style });
    p.scenes[0]!.beats[0]!.emotion = 'happy';
    p.scenes[0]!.beats[1]!.emotion = 'sad';
    st().open(p, null);
    const before = compileProject(proj(), MINI_CTX).scenes[0]!;
    for (const castId of ['a', 'b']) {
      const keys = before.actors.find((x) => x.castId === castId)!.ruleKeys;
      bakeRuleKeys('s1', castId, keys);
    }
    const after = compileProject(proj(), MINI_CTX).scenes[0]!;
    for (const castId of ['a', 'b']) {
      const x = before.actors.find((a) => a.castId === castId)!;
      const y = after.actors.find((a) => a.castId === castId)!;
      expect(y.expressions).toEqual(x.expressions);
      expect(y.motions).toEqual(x.motions);
      expect(y.yaw.map((k) => [k.at, k.value])).toEqual(x.yaw.map((k) => [k.at, k.value]));
      expect(y.ruleKeys.filter((k) => k.channel !== 'motion' || true).length).toBeLessThanOrEqual(x.ruleKeys.length);
    }
    // baked keys are the user's now
    const tr = findTrack(proj().scenes[0]!, { kind: 'actor', castId: 'a' }, 'expression')!;
    expect(tr.keys.every((k) => k.meta.source === 'user')).toBe(true);
  });

  it('per-person offsets of a shot ride on top of the automatic arrangement', () => {
    const p = miniProject();
    const base = compileProject(p, MINI_CTX).scenes[0]!.actors.find((x) => x.castId === 'a')!;
    p.scenes[0]!.beats[0]!.shot.offsets = { a: { x: 0.1, y: -0.05 } };
    const c = compileProject(p, MINI_CTX).scenes[0]!.actors.find((x) => x.castId === 'a')!;
    const H = Math.min(1119, 2048 / (16 / 9));
    expect(c.shiftX[0]!.value - base.shiftX[0]!.value).toBeCloseTo(0.1 * H, 3);
    expect(c.shiftY[0]!.value - base.shiftY[0]!.value).toBeCloseTo(-0.05 * H, 3);
    const b = compileProject(p, MINI_CTX).scenes[0]!.actors.find((x) => x.castId === 'b')!;
    expect(b.shiftX[0]!.value).toBe(compileProject(miniProject(), MINI_CTX).scenes[0]!.actors.find((x) => x.castId === 'b')!.shiftX[0]!.value);
  });
});
