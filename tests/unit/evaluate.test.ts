import { describe, expect, it } from 'vitest';
import { compileProject } from '../../shared/timeline/compile';
import { ease } from '../../shared/timeline/easing';
import { DOF_BLUR, evaluate, sceneIndexAt } from '../../shared/timeline/evaluate';
import { sampleKeys } from '../../shared/timeline/sample';
import { lerp } from '../../shared/timeline/easing';
import { MINI_CTX, miniProject } from './helpers/synthetic';

const key = (id: string, beatId: string, offset: number, value: unknown, duration = 0, easeName = 'linear') => ({ id, at: { beatId, offset }, value, duration, ease: easeName });
const actor = (castId: string) => ({ kind: 'actor', castId });

const tracks = [
  { id: 'op', target: actor('a'), channel: 'opacity', keys: [key('o1', 'b1', 0, 0), key('o2', 'b1', 0.2, 1, 1)] },
  { id: 'ex', target: actor('a'), channel: 'expression', keys: [key('e1', 'b2', 0, { name: 'exp_smile01' }), key('e2', 'b3', 0, { name: 'exp_sad01' })] },
  { id: 'hd', target: actor('b'), channel: 'head', keys: [key('h1', 'b1', 0, { mode: 'target', target: 'camera' }), key('h2', 'b2', 0, { mode: 'angle', yaw: -0.9 }, 1, 'inOutQuad')] },
  { id: 'gz', target: actor('a'), channel: 'gaze', keys: [key('g1', 'b2', 0, { x: 0, y: -0.7 }, 0.5)] },
  { id: 'fd', target: { kind: 'screen' }, channel: 'fade', keys: [key('f1', 'b3', 0.5, { color: 'black', alpha: 1 }, 0.5)] },
  { id: 'bg', target: { kind: 'audio' }, channel: 'bgm', keys: [key('m1', 'b2', 0, { assetId: 'music/a.wav', volume: 0.5 })] },
];
const project = miniProject({ tracks });
const compiled = compileProject(project, MINI_CTX);
const sc = compiled.scenes[0]!;
const A = (t: number) => evaluate(compiled, t).actors.find((a) => a.castId === 'a')!;
const B = (t: number) => evaluate(compiled, t).actors.find((a) => a.castId === 'b')!;

describe('sampleKeys / easing', () => {
  const keys = [
    { at: 1, duration: 2, ease: 'linear' as const, value: 10 },
    { at: 5, duration: 0, ease: 'linear' as const, value: 20 },
  ];
  const s = (t: number) => sampleKeys(keys, t, 0, (k) => k.value, lerp);
  it('holds the initial value, interpolates, then holds', () => {
    expect(s(0)).toBe(0);
    expect(s(1)).toBe(0);
    expect(s(2)).toBeCloseTo(5);
    expect(s(3)).toBe(10);
    expect(s(4.99)).toBe(10);
    expect(s(5)).toBe(20);
  });
  it('easing tables hit 0 and 1 and are monotonic', () => {
    for (const name of ['linear', 'inQuad', 'outQuad', 'inOutQuad', 'inOutSine'] as const) {
      expect(ease(name, 0)).toBeCloseTo(0);
      expect(ease(name, 1)).toBeCloseTo(1);
      let last = -1;
      for (let i = 0; i <= 20; i++) {
        const v = ease(name, i / 20);
        expect(v).toBeGreaterThanOrEqual(last);
        last = v;
      }
    }
    expect(ease('inOutQuad', 0.5)).toBeCloseTo(0.5);
    expect(ease('inQuad', 0.5)).toBeLessThan(0.5);
    expect(ease('outQuad', 0.5)).toBeGreaterThan(0.5);
  });
});

describe('evaluate', () => {
  const t0 = sc.beats[0]!.start;
  it('interpolates continuous channels (opacity 0 -> 1 over 1 s starting 0.2 s into the beat)', () => {
    expect(A(t0).opacity).toBe(0);
    expect(A(t0 + 0.7).opacity).toBeCloseTo(0.5);
    expect(A(t0 + 1.5).opacity).toBe(1);
  });

  it('discrete channels take the latest value before t', () => {
    expect(A(sc.beats[0]!.start).expression).toBeNull();
    expect(A(sc.beats[1]!.start - 0.01).expression).toBeNull();
    expect(A(sc.beats[1]!.start).expression).toBe('exp_smile01');
    expect(A(sc.beats[2]!.start + 0.01).expression).toBe('exp_sad01');
  });

  it('head residual = desired yaw minus what the current variant already bakes in', () => {
    // a starts facing b (right) with the _L variant (+22 deg = 0.73): residual is small and positive
    const a = A(t0);
    expect(a.desiredYaw).toBeGreaterThan(0.5);
    expect(a.motion!.name).toBe('mtn_idle01_L');
    expect(a.head).toBeCloseTo(a.desiredYaw - 22 / 30, 2);
    expect(a.body).toBeCloseTo(a.head * 0.8, 6);
  });

  it('head and gaze are independent: b turns the head while a looks down', () => {
    const t = sc.beats[1]!.start + 2;
    expect(B(t).desiredYaw).toBeCloseTo(-0.9, 2);
    expect(A(t).gaze.y).toBeCloseTo(-0.7);
    expect(A(t).desiredYaw).toBeGreaterThan(0.5); // a still faces b
  });

  it('listener / speaker state: only the speaker talks, and only while text is revealed', () => {
    const b0 = sc.beats[0]!;
    const mid = (b0.start + b0.textEnd) / 2;
    expect(A(mid).talking).toBe(true);
    expect(A(mid).mouth).toBeGreaterThan(0);
    expect(B(mid).talking).toBe(false);
    expect(A(b0.textEnd + 0.05).talking).toBe(false);
    expect(A(b0.textEnd + 0.05).mouth).toBe(0);
  });

  it('subtitle reveals chars at the text speed and holds the full line', () => {
    const b0 = sc.beats[0]!;
    const total = [...b0.text].length;
    expect(evaluate(compiled, b0.start).subtitle!.visibleChars).toBe(0);
    expect(evaluate(compiled, b0.start + 0.35).subtitle!.visibleChars).toBe(3); // 10 cps
    expect(evaluate(compiled, b0.textEnd + 0.1).subtitle!.visibleChars).toBe(total);
    expect(evaluate(compiled, b0.start + 0.35).subtitle!.speakerId).toBe('a');
  });

  it('camera follows the beat shots; dof drives the background blur', () => {
    const early = evaluate(compiled, sc.beats[0]!.start + 0.1).camera;
    const late = evaluate(compiled, sc.beats[2]!.start + 1).camera;
    expect(late.zoom).toBeGreaterThan(early.zoom);
    const s = evaluate(compiled, sc.beats[2]!.start + 1);
    expect(s.background.blur).toBe(DOF_BLUR[5]);
    expect(evaluate(compiled, sc.beats[0]!.start + 0.1).background.blur).toBe(0);
  });

  it('out-of-focus actors blur only when depth differs and dof is on', () => {
    const t = sc.beats[2]!.start + 1; // closeup of a, dof 5, b at the same depth
    expect(B(t).blur).toBe(0);
  });

  it('screen fade and bgm are global timelines', () => {
    const end = evaluate(compiled, compiled.duration);
    expect(end.fade).toEqual({ color: 'black', alpha: 1 });
    expect(evaluate(compiled, 0).fade.alpha).toBe(0);
    expect(evaluate(compiled, sc.beats[1]!.start + 0.1).audio.bgm).toEqual({ assetId: 'music/a.wav', volume: 0.5 });
    expect(evaluate(compiled, 0).audio.bgm).toBeNull();
  });

  it('is a pure function of t: random-order evaluation equals sequential stepping (seek idempotence)', () => {
    const times = Array.from({ length: 80 }, (_, i) => (i / 79) * compiled.duration);
    const sequential = times.map((t) => evaluate(compiled, t));
    const shuffled = [...times.keys()].sort((a, b) => ((a * 7919) % 83) - ((b * 7919) % 83));
    for (const i of shuffled) expect(evaluate(compiled, times[i]!)).toEqual(sequential[i]);
    const again = evaluate(compiled, times[40]!);
    evaluate(compiled, 0);
    evaluate(compiled, compiled.duration);
    expect(evaluate(compiled, times[40]!)).toEqual(again);
  });

  it('clamps t to [0, duration] and finds scenes', () => {
    expect(evaluate(compiled, -5).t).toBe(0);
    expect(evaluate(compiled, 1e6).t).toBe(compiled.duration);
    expect(sceneIndexAt(compiled, 1)).toBe(0);
  });
});

describe('transitions in evaluate', () => {
  it('reports progress during the lead-in only', () => {
    const p = miniProject({ transition: { kind: 'crossfade', duration: 2 } });
    const c = compileProject(p, MINI_CTX);
    expect(evaluate(c, 0.5).transition).toMatchObject({ kind: 'crossfade', progress: 0.25 });
    expect(evaluate(c, 1.5).transition!.progress).toBeCloseTo(0.75);
    expect(evaluate(c, 2.01).transition).toBeNull();
    expect(evaluate(compileProject(miniProject(), MINI_CTX), 0.1).transition).toBeNull();
  });
});

describe('head pitch (低头)', () => {
  const pitched = compileProject(miniProject({ tracks: [
    { id: 'hd', target: actor('b'), channel: 'head', keys: [key('h1', 'b1', 0, { mode: 'target', target: 'auto', pitch: -0.6 }), key('h2', 'b2', 0, { mode: 'target', target: 'camera' })] },
  ] }), MINI_CTX);
  const at = (t: number) => evaluate(pitched, t).actors.find((a) => a.castId === 'b')!;
  it('a head key with a pitch lowers the head until the next head key resets it; other actors and unpitched projects carry no pitch', () => {
    const b2 = pitched.scenes[0]!.beats[1]!.start;
    expect(at(pitched.scenes[0]!.beats[0]!.start + 0.5).headPitch).toBeCloseTo(-0.6, 5);
    expect(at(b2 + 0.5).headPitch ?? 0).toBeCloseTo(0, 5);
    expect(evaluate(pitched, 0.5).actors.find((a) => a.castId === 'a')!.headPitch).toBeUndefined();
    expect(Object.keys(B(0.5))).not.toContain('headPitch');
  });
});
