import { describe, expect, it } from 'vitest';
import { BeatSchema, ProjectSchema } from '../../shared/schema/project';
import { compileProject } from '../../shared/timeline/compile';
import { evaluate } from '../../shared/timeline/evaluate';
import demo from '../fixtures/demo-project.json';
import { MINI_CTX, miniProject } from './helpers/synthetic';

type Raw = Record<string, unknown>;
const dlg = (id: string, speakerId: string, text: string, shot: Raw, extra: Raw = {}): Raw => ({ id, kind: 'dialogue', speakerId, text, shot, duration: { mode: 'fixed', seconds: 3 }, ...extra });
const mcu = (focus: string[], extra: Raw = {}) => ({ type: 'mcu', focus, move: 'static', ...extra });
const run = (beats: Raw[], scene: Raw = {}) => compileProject(miniProject({ beats, scene }), MINI_CTX).scenes[0]!;
const runMin = (beats: Raw[], scene: Raw = {}) => compileProject(miniProject({ beats, scene, style: { 'rhythm.enforceMinShot': true } }), MINI_CTX).scenes[0]!;
const SYSTEMS: Array<[string, Raw]> = [['classic', {}], ['travel', { cameraSystem: 'travel' }]];

describe('schema: splitFrom / overflow are optional and never defaulted', () => {
  it('an old project parses to exactly what it was: no new keys on any beat', () => {
    const p = ProjectSchema.parse(demo);
    for (const s of p.scenes) for (const b of s.beats) {
      expect('splitFrom' in b).toBe(false);
      expect('overflow' in b).toBe(false);
    }
    expect(JSON.stringify(ProjectSchema.parse(JSON.parse(JSON.stringify(p))))).toBe(JSON.stringify(p));
  });

  it('round-trips when set, and rejects anything but "expand"', () => {
    const p = miniProject({ beats: [dlg('h', 'a', '首', mcu(['a'])), dlg('c', 'a', '续', mcu(['a']), { splitFrom: 'h', overflow: 'expand' })] });
    const c = p.scenes[0]!.beats[1]!;
    expect(c.splitFrom).toBe('h');
    expect(c.overflow).toBe('expand');
    expect(p.scenes[0]!.beats[0]).not.toHaveProperty('splitFrom');
    expect(ProjectSchema.parse(JSON.parse(JSON.stringify(p))).scenes[0]!.beats[1]).toMatchObject({ splitFrom: 'h', overflow: 'expand' });
    const base = { id: 'x', kind: 'dialogue', text: 't', shot: { type: 'mcu', focus: [] }, style: { overrides: {} } };
    expect(BeatSchema.safeParse({ ...base, overflow: 'shrink' }).success).toBe(false);
    expect(BeatSchema.safeParse({ ...base, splitFrom: '' }).success).toBe(false);
    expect(BeatSchema.safeParse(base).success).toBe(true);
  });
});

describe('evaluate / compile: expand is emitted only when set', () => {
  it('no expand key anywhere for an ordinary line; expand: true for an expanded one', () => {
    const plain = compileProject(miniProject(), MINI_CTX);
    expect(plain.scenes[0]!.beats.every((b) => !('expand' in b))).toBe(true);
    const t = plain.scenes[0]!.beats[0]!.start + 0.5;
    expect('expand' in evaluate(plain, t).subtitle!).toBe(false);
    const c = compileProject(miniProject({ beats: [dlg('h', 'a', '一句话', mcu(['a']), { overflow: 'expand' }), dlg('n', 'b', '另一句', mcu(['b']))] }), MINI_CTX);
    expect(c.scenes[0]!.beats[0]!.expand).toBe(true);
    expect('expand' in c.scenes[0]!.beats[1]!).toBe(false);
    expect(evaluate(c, c.scenes[0]!.beats[0]!.start + 0.5).subtitle!.expand).toBe(true);
    expect('expand' in evaluate(c, c.scenes[0]!.beats[1]!.start + 0.5).subtitle!).toBe(false);
  });
});

describe.each(SYSTEMS)('compile: a split continuation keeps the head camera (%s)', (_name, scene) => {
  const head = (extra: Raw = {}) => dlg('h', 'a', '前半句。', mcu(['a'], extra));
  const cont = (shot: Raw = mcu(['a']), extra: Raw = {}) => dlg('c', 'a', '后半句。', shot, { splitFrom: 'h', ...extra });

  it('static head + hold continuation: no new shot, no new camera key', () => {
    const alone = run([head()], scene);
    const both = run([head(), cont()], scene);
    expect(both.beats.map((b) => b.shotHeld)).toEqual([false, true]);
    expect(both.camera).toHaveLength(alone.camera.length);
  });

  it('push_in head + hold continuation: still no new key (without splitFrom the continuation snaps back)', () => {
    const alone = run([head({ move: 'push_in' })], scene);
    const both = run([head({ move: 'push_in' }), cont()], scene);
    expect(both.beats.map((b) => b.shotHeld)).toEqual([false, true]);
    expect(both.camera).toHaveLength(alone.camera.length);
    const without = run([head({ move: 'push_in' }), cont(mcu(['a']), { splitFrom: undefined })], scene);
    expect(without.beats[1]!.shotHeld).toBe(false); // the old behaviour for an unmarked line, unchanged
    expect(without.camera.length).toBeGreaterThan(alone.camera.length);
    // the camera stays where the push ended during the continuation
    const c = compileProject(miniProject({ beats: [head({ move: 'push_in' }), cont()], scene }), MINI_CTX);
    const endOfPush = evaluate(c, c.scenes[0]!.beats[0]!.end - 0.01).camera;
    const during = evaluate(c, c.scenes[0]!.beats[1]!.start + 1).camera;
    expect(during.zoom).toBeCloseTo(endOfPush.zoom, 1);
  });

  it('a chain of continuations holds too (each is held against the previous piece)', () => {
    const c2 = dlg('c2', 'a', '第三句。', mcu(['a']), { splitFrom: 'h' });
    expect(run([head({ move: 'push_in' }), cont(), c2], scene).beats.map((b) => b.shotHeld)).toEqual([false, true, true]);
  });

  it('a closer continuation (closer) is a new shot', () => {
    const r = run([head(), cont({ type: 'cu', focus: ['a'], move: 'static' })], scene);
    expect(r.beats[1]!.shotHeld).toBe(false);
    expect(r.beats[1]!.shotType).toBe('cu');
  });

  it('a reaction continuation (another person in focus) is a new shot', () => {
    const r = run([head(), cont({ type: 'cu', focus: ['b'], move: 'static', ...(scene.cameraSystem ? { intent: 'reaction', transition: 'cut' } : {}) })], scene);
    expect(r.beats[1]!.shotHeld).toBe(false);
    expect(r.beats[1]!.focus).toEqual(['b']);
  });

  it('a shot the user set on the continuation wins', () => {
    const userShot = { ...mcu(['a']), meta: { source: 'user', locked: false, updatedAt: 1 } };
    expect(run([head({ move: 'push_in' }), cont(userShot)], scene).beats[1]!.shotHeld).toBe(false);
    const locked = { ...mcu(['a']), meta: { source: 'ai', locked: true, updatedAt: 1 } };
    expect(run([head({ move: 'push_in' }), cont(locked)], scene).beats[1]!.shotHeld).toBe(false);
  });

  it('a continuation with its own move, a dip cut or a moved-away head follows the old path', () => {
    expect(run([head(), cont(mcu(['a'], { move: 'push_in' }))], scene).beats[1]!.shotHeld).toBe(false);
    expect(run([head({ move: 'push_in' }), cont(mcu(['a']), { cutIn: 'dip_black' })], scene).beats[1]!.shotHeld).toBe(false);
    // splitFrom must point at the piece right before it (a moved continuation does not borrow the camera)
    const other = dlg('o', 'b', '别人说。', { type: 'mcu', focus: ['b'], move: 'static' });
    const r = run([head({ move: 'push_in' }), other, cont()], scene);
    expect(r.beats[2]!.shotHeld).toBe(false);
  });

  it('M2: a head held on the previous shot by the minimum-shot rule: the continuation that asks for the head own shot holds that camera too', () => {
    const prev = dlg('p', 'a', '前一句。', { type: 'cu', focus: ['a'], move: 'static' }, { duration: { mode: 'fixed', seconds: 3 } });
    const h = dlg('h', 'a', '前半句。', mcu(['a']), { duration: { mode: 'fixed', seconds: 2 } });
    const c = dlg('c', 'a', '后半句。', mcu(['a']), { splitFrom: 'h', duration: { mode: 'fixed', seconds: 1 } });
    const r = runMin([prev, h, c], scene);
    expect(r.beats.map((b) => b.shotHeld)).toEqual([false, true, true]);
    expect(r.beats.map((b) => b.shotType)).toEqual(['cu', 'cu', 'cu']);
    // without splitFrom the old rules apply: the third line is past the minimum shot length and cuts to mcu
    const plain = runMin([prev, h, { ...c, splitFrom: undefined }], scene);
    expect(plain.beats[2]!.shotType).toBe('mcu');
  });

  it('M2: a closer or a reaction after such a held head still changes the shot', () => {
    const prev = dlg('p', 'a', '前一句。', { type: 'cu', focus: ['a'], move: 'static' }, { duration: { mode: 'fixed', seconds: 3 } });
    const h = dlg('h', 'a', '前半句。', mcu(['a']), { duration: { mode: 'fixed', seconds: 2 } });
    const ecu = dlg('c', 'a', '后半句。', { type: 'ecu', focus: ['a'], move: 'static' }, { splitFrom: 'h', duration: { mode: 'fixed', seconds: 1 } });
    expect(runMin([prev, h, ecu], scene).beats[2]!.shotType).toBe('ecu');
  });

  it('beats without splitFrom compile exactly as before (the new rule is off for them)', () => {
    const plain = [head({ move: 'push_in' }), dlg('c', 'a', '后半句。', mcu(['a']))];
    const a = compileProject(miniProject({ beats: plain, scene }), MINI_CTX);
    const b = compileProject(miniProject({ beats: plain.map((x) => ({ ...x })), scene }), MINI_CTX);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.scenes[0]!.beats[1]!.shotHeld).toBe(false);
  });
});
