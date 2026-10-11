import { describe, expect, it } from 'vitest';
import { ProjectSchema } from '../../shared/schema/project';
import { solveShotDetailed, visibleShare, type FramingActor } from '../../shared/staging/framing';
import { placeActor } from '../../shared/staging/ground';
import { defaultGround, viewRect, type BgInfo } from '../../shared/staging/world';
import { OURNOTES_STYLE, PRESETS, resolveStyle } from '../../shared/style/ournotes';
import { compileProject } from '../../shared/timeline/compile';
import { evaluate } from '../../shared/timeline/evaluate';
import demo from '../fixtures/demo-project.json';
import { MINI_CTX, fakeCalibration, miniProject } from './helpers/synthetic';

type Raw = Record<string, unknown>;
const dlg = (id: string, speakerId: string, shot: Raw, extra: Raw = {}): Raw => ({ id, kind: 'dialogue', speakerId, text: '一句台词。', duration: { mode: 'fixed', seconds: 2 }, shot, ...extra });
const shot = (type: string, focus: string[], extra: Raw = {}) => ({ type, focus, move: 'static', ...extra });

describe('N1 hard cut is the default', () => {
  const beats = [dlg('b1', 'a', shot('mcu', ['a'])), dlg('b2', 'b', shot('mcu', ['b'])), dlg('b3', 'a', shot('cu', ['a'], { transition: 'glide' }))];
  const sc = () => compileProject(miniProject({ beats }), MINI_CTX).scenes[0]!;

  it('the original preset has glideSeconds 0 and bandori-plate keeps the old slide', () => {
    expect(OURNOTES_STYLE.performance.glideSeconds).toBe(0);
    expect(PRESETS['bandori-plate']!.values.performance.glideSeconds).toBe(0.5);
  });

  it('a camera change inside a scene jumps: the key has no duration and no in-between pose is ever shown', () => {
    const s = sc();
    expect(s.camera[1]!.duration).toBe(0);
    const c = compileProject(miniProject({ beats: beats.slice(0, 2) }), MINI_CTX);
    const cut = c.scenes[0]!.beats[1]!.start;
    const before = evaluate(c, cut - 1 / 30).camera;
    const after = evaluate(c, cut).camera;
    expect(after.x).not.toBeCloseTo(before.x, 0);
    for (let i = 0; i < 30; i++) expect(evaluate(c, cut + i / 30).camera).toEqual(after);
  });

  it('shot.transition = glide opts a single beat into the slide; the style can still make every cut glide', () => {
    const s = sc();
    const glide = s.camera.find((k) => Math.abs(k.at - s.beats[2]!.start) < 1e-6)!;
    expect(glide.duration).toBeGreaterThan(0);
    const style = compileProject(miniProject({ style: { 'performance.glideSeconds': 0.4 }, beats: beats.slice(0, 2) }), MINI_CTX).scenes[0]!;
    expect(style.camera[1]!.duration).toBeCloseTo(0.4);
    const forcedCut = compileProject(miniProject({ style: { 'performance.glideSeconds': 0.4 }, beats: [beats[0]!, dlg('b2', 'b', shot('mcu', ['b'], { transition: 'cut' }))] }), MINI_CTX).scenes[0]!;
    expect(forcedCut.camera[1]!.duration).toBe(0);
  });

  it('the demo no longer uses camera moves (SR 3: no push-in in the original)', () => {
    const p = ProjectSchema.parse(demo);
    expect(p.scenes.flatMap((s) => s.beats).filter((b) => b.shot.move !== 'static')).toEqual([]);
  });
});

describe('N3 / N4 solver', () => {
  const bg: BgInfo = { width: 2048, height: 1119, ground: defaultGround(2048, 1119) };
  const cal = fakeCalibration('m');
  const actor = (id: string, slot: number, depth: number): FramingActor => {
    const p = placeActor(cal, { slot, depth }, bg);
    return { id, head: p.headBox, body: p.bodyBox, yaw: 0 };
  };

  it('two-shot arranges the faces at +-faceX, whatever the distance between the people', () => {
    for (const gap of [0.2, 0.5, 0.9]) {
      const a = actor('a', -gap / 2, 0.08);
      const b = actor('b', gap / 2, 0.1);
      const r = solveShotDetailed({ type: 'two_shot', focus: [a, b], bg });
      const Hv = viewRect(bg, r.pose).h;
      expect(r.shifts.a!.dx + a.head.x + a.head.w / 2 - r.pose.x).toBeCloseTo(-OURNOTES_STYLE.framing.twoShotFaceX * Hv, 3);
      expect(r.shifts.b!.dx + b.head.x + b.head.w / 2 - r.pose.x).toBeCloseTo(OURNOTES_STYLE.framing.twoShotFaceX * Hv, 3);
    }
  });

  it('three-person groups are laid out left to right, evenly spaced and symmetric about the frame centre', () => {
    const [l, m, r] = [actor('l', -0.5, 0.1), actor('m', 0.0, 0.1), actor('r', 0.5, 0.1)];
    const s = solveShotDetailed({ type: 'group', focus: [r, l, m], bg });
    const Hv = viewRect(bg, s.pose).h;
    const x = (a: FramingActor) => (s.shifts[a.id]!.dx + a.head.x + a.head.w / 2 - s.pose.x) / Hv;
    expect(x(l)).toBeLessThan(x(m));
    expect(x(m)).toBeLessThan(x(r));
    expect(x(l) + x(r)).toBeCloseTo(0, 3);
    expect(x(m) - x(l)).toBeCloseTo(x(r) - x(m), 3);
  });

  it('the style fields drive the layout (heightEqualize / sizeEqualize = 0 leave eye lines and sizes alone)', () => {
    const a = actor('a', -0.2, 0.05);
    const b = actor('b', 0.2, 0.5);
    const none = solveShotDetailed({ type: 'two_shot', focus: [a, b], bg, style: resolveStyle({ overrides: { 'framing.heightEqualize': 0, 'framing.sizeEqualize': 0 } }).values });
    expect(none.shifts.a!.dy).toBeCloseTo(0, 6);
    expect(none.shifts.a!.s).toBe(1);
    const eq = solveShotDetailed({ type: 'two_shot', focus: [a, b], bg });
    expect(eq.shifts.a!.s).not.toBeCloseTo(eq.shifts.b!.s, 2);
  });

  it('N4: long hair counts - a person just outside the frame edge is already touched by the hair', () => {
    const f = actor('f', 0, 0.1);
    const solved = solveShotDetailed({ type: 'mcu', focus: [f], bg });
    const v = viewRect(bg, solved.pose);
    const x = v.x + v.w + f.head.w * 0.2;
    const by: FramingActor = { id: 'x', head: { ...f.head, x }, body: { ...f.body, x }, yaw: 0 };
    expect(visibleShare(by, bg, solved.pose, { ...OURNOTES_STYLE.framing, hairSpread: 0 })).toBe(0);
    expect(visibleShare(by, bg, solved.pose)).toBeGreaterThan(0);
  });

  it('N4: an intruder that cannot be moved out of a single-person shot is hidden for it and reported', () => {
    const c = compileProject(
      miniProject({ beats: [dlg('b1', 'a', shot('ecu', ['a']))], scene: { blocking: { a: { slot: -0.2, depth: 0.1 }, b: { slot: 0.0, depth: 0.1 } } } }),
      MINI_CTX,
    );
    const s = c.scenes[0]!;
    const b = s.actors.find((a) => a.castId === 'b')!;
    const hidden = b.shotVisible.at(-1)!.value === 0;
    expect(evaluate(c, s.beats[0]!.start + 0.5).actors.find((a) => a.castId === 'b')!.opacity).toBe(hidden ? 0 : 1);
    expect(c.warnings.some((w) => /edge-cut.*hidden for this shot/.test(w))).toBe(hidden);
  });
});

describe('N5 / N7 / N8 / N9 style data', () => {
  it('the new fields exist with the documented defaults', () => {
    const v = OURNOTES_STYLE;
    expect(v.hud.menuTop).toBe(0.064);
    expect(v.hud.autoFollowsDialog).toBe(true);
    expect(v.hud.autoSpinDegPerSec).toBe(72);
    expect(v.fx.anxietySmoke).toBeGreaterThan(0);
    expect(v.fx.anxietyTint).toMatch(/^#[0-9a-f]{6}$/i);
    expect(v.framing.groupSpacing).toBeGreaterThan(1);
    expect(v.framing.twoShotFaceX).toBe(0.47);
  });
});
