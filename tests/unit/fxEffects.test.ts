import { describe, expect, it } from 'vitest';
import demo from '../fixtures/demo-project.json';
import { MEMORY_WHITE_HOLD_IN, MEMORY_WHITE_IN, MEMORY_WHITE_OUT, memoryThroughWhite } from '../../shared/director/expand';
import { ProjectSchema } from '../../shared/schema/project';
import { compileProject } from '../../shared/timeline/compile';
import { evaluate } from '../../shared/timeline/evaluate';
import { fakeContext, MINI_CTX, miniProject } from './helpers/synthetic';

const fxTrack = (keys: Array<Record<string, unknown>>, channel = 'fx') => ({
  id: `t_${channel}`, target: { kind: 'screen' }, channel, keys: keys.map((k, i) => ({ id: `k${i}`, duration: 0, ease: 'linear', ...k })),
});

describe('memory effect', () => {
  const memory = (extra: Record<string, unknown> = {}, on = 1) => ({ fx: 'memory', strength: on, roll: 0, ...extra });
  const project = (keys: Array<Record<string, unknown>>) => miniProject({ tracks: [fxTrack(keys)] });

  it('is a function of t only: any seek order gives the same frame', () => {
    const c = compileProject(project([{ at: { beatId: 'b1', offset: 0 }, value: memory({ tone: 'warm', edge: 'bands' }), duration: 1 }, { at: { beatId: 'b3', offset: 0 }, value: memory({}, 0), duration: 0.5 }]), MINI_CTX);
    const ts = [0.2, 5, 0.7, 12, 3, 0.2, 5];
    const first = ts.map((t) => JSON.stringify(evaluate(c, t)));
    const again = [...ts].reverse().map((t) => JSON.stringify(evaluate(c, t))).reverse();
    expect(again).toEqual(first);
    expect(evaluate(c, 0.5).fx.memory).toBeCloseTo(0.5, 3);
    expect(evaluate(c, 2).fx).toMatchObject({ memory: 1, memoryTone: 'warm', memoryEdge: 'bands' });
  });

  it('defaults to the fog edge and the cool tone, and the off key keeps the look of the key before it', () => {
    const c = compileProject(project([{ at: { beatId: 'b1', offset: 0 }, value: memory(), duration: 0 }, { at: { beatId: 'b2', offset: 0 }, value: memory({ tone: 'warm' }), duration: 0 }, { at: { beatId: 'b3', offset: 0 }, value: memory({}, 0), duration: 0.5 }]), MINI_CTX);
    expect(evaluate(c, 0.1).fx).toMatchObject({ memoryTone: 'cool', memoryEdge: 'fog' });
    const last = c.scenes[0]!.beats[2]!;
    expect(evaluate(c, last.start + 0.2).fx).toMatchObject({ memoryTone: 'warm', memoryEdge: 'fog' });
    expect(evaluate(c, last.start + 5).fx.memory).toBe(0);
  });

  it('adds nothing to the compiled / evaluated shape of a project that does not use it', () => {
    const plain = ProjectSchema.parse(demo);
    const models = new Set<string>();
    for (const sc of plain.scenes) {
      Object.values(sc.wardrobe).forEach((w) => models.add(w.modelId));
      for (const t of sc.tracks) if (t.channel === 'costume') t.keys.forEach((k) => models.add(k.value.modelId));
    }
    const c = compileProject(plain, fakeContext([...models], plain.scenes.map((sc) => sc.background.assetId)));
    expect(Object.keys(c.fx)).toEqual(['anxiety', 'glow', 'roll']);
    const m = compileProject(miniProject(), MINI_CTX);
    expect(Object.keys(m.fx)).toEqual(['anxiety', 'glow', 'roll']);
    expect(Object.keys(evaluate(m, 1).fx)).toEqual(['anxiety', 'glow', 'roll']);
    const used = compileProject(project([{ at: { beatId: 'b1', offset: 0 }, value: memory(), duration: 0 }]), MINI_CTX);
    expect(Object.keys(used.fx)).toEqual(['anxiety', 'glow', 'roll', 'memory', 'memoryLook']);
  });

  it('does not touch memory_glow: it still compiles to the glow curve', () => {
    const c = compileProject(project([{ at: { beatId: 'b1', offset: 0 }, value: { fx: 'memory_glow', strength: 1, roll: 0 }, duration: 0 }]), MINI_CTX);
    expect(c.fx.glow.length).toBe(1);
    expect(c.fx.memory).toBeUndefined();
    expect(evaluate(c, 1).fx.glow).toBe(1);
  });

  it('enters and leaves through white (the generated keys)', () => {
    const got: Array<{ channel: string; offset: number; value: unknown; duration: number }> = [];
    const key = (_c: string | null, channel: string, _bi: number, offset: number, value: unknown, _m: unknown, duration = 0) => void got.push({ channel, offset, value, duration });
    const meta = { source: 'ai' as const, locked: false, updatedAt: 0 };
    memoryThroughWhite(key as never, 2, 1, meta, meta, 'warm');
    expect(got).toEqual([
      { channel: 'fade', offset: -MEMORY_WHITE_IN, value: { color: 'white', alpha: 1 }, duration: MEMORY_WHITE_IN },
      { channel: 'fx', offset: 0, value: { fx: 'memory', strength: 1, roll: 0, tone: 'warm' }, duration: 0 },
      { channel: 'fade', offset: MEMORY_WHITE_HOLD_IN, value: { color: 'white', alpha: 0 }, duration: MEMORY_WHITE_OUT },
    ]);
    got.length = 0;
    memoryThroughWhite(key as never, 4, 0, meta, meta);
    expect(got[1]).toEqual({ channel: 'fx', offset: 0, value: { fx: 'memory', strength: 0, roll: 0 }, duration: 0 });
  });

  it('white is full exactly when the memory switches on', () => {
    const keys = (offset: number) => ({ at: { beatId: 'b2', offset } });
    const p = miniProject({
      tracks: [
        fxTrack([{ ...keys(0), value: memory(), duration: 0 }]),
        fxTrack([
          { ...keys(-MEMORY_WHITE_IN), value: { color: 'white', alpha: 1 }, duration: MEMORY_WHITE_IN },
          { ...keys(MEMORY_WHITE_HOLD_IN), value: { color: 'white', alpha: 0 }, duration: MEMORY_WHITE_OUT },
        ], 'fade'),
      ],
    });
    const c = compileProject(p, MINI_CTX);
    const t = c.scenes[0]!.beats[1]!.start;
    expect(evaluate(c, t - 0.01).fx.memory).toBe(0);
    expect(evaluate(c, t - 0.01).fade.alpha).toBeGreaterThan(0.95);
    expect(evaluate(c, t).fx.memory).toBe(1);
    expect(evaluate(c, t).fade.color).toBe('white');
    expect(evaluate(c, t + MEMORY_WHITE_HOLD_IN + MEMORY_WHITE_OUT + 0.01).fade.alpha).toBe(0);
  });
});

describe('dim effect', () => {
  const p = (keys: Array<Record<string, unknown>>) => miniProject({ tracks: [fxTrack(keys)] });
  it('ramps with the key, is seekable, and exists only when used', () => {
    const c = compileProject(p([
      { at: { beatId: 'b2', offset: 0 }, value: { fx: 'dim', strength: 1, roll: 0 }, duration: 0.5, ease: 'inOutQuad' },
      { at: { beatId: 'b3', offset: 0 }, value: { fx: 'dim', strength: 0, roll: 0 }, duration: 0.5, ease: 'inOutQuad' },
    ]), MINI_CTX);
    const [, b2, b3] = c.scenes[0]!.beats;
    expect(evaluate(c, b2!.start - 0.1).fx.dim).toBe(0);
    expect(evaluate(c, b2!.start + 0.25).fx.dim).toBeCloseTo(0.5, 5);
    expect(evaluate(c, b2!.start + 0.6).fx.dim).toBe(1);
    expect(evaluate(c, b3!.start + 0.6).fx.dim).toBe(0);
    expect(evaluate(c, b2!.start + 0.25).fx.dim).toBeCloseTo(0.5, 5); // out-of-order seek, same answer
    expect(c.fx.memory).toBeUndefined();
    expect(Object.keys(evaluate(compileProject(miniProject(), MINI_CTX), 1).fx)).toEqual(['anxiety', 'glow', 'roll']);
  });
});

describe('flash and dip_white', () => {
  const shot = (type: string, focus: string[]) => ({ type, focus, move: 'static', dof: 0 });
  it('a flash is a white fade: peak 0.85 after 0.08 s, gone at the end of the key, and no new compiled array', () => {
    const p = miniProject({ tracks: [fxTrack([{ at: { beatId: 'b2', offset: 0.1 }, value: { fx: 'flash', strength: 1, roll: 0 }, duration: 0.6 }])] });
    const c = compileProject(p, MINI_CTX);
    expect(Object.keys(c.fx)).toEqual(['anxiety', 'glow', 'roll']);
    const t = c.scenes[0]!.beats[1]!.start + 0.1;
    expect(evaluate(c, t - 0.01).fade.alpha).toBe(0);
    expect(evaluate(c, t + 0.08)).toMatchObject({ fade: { color: 'white' } });
    expect(evaluate(c, t + 0.08).fade.alpha).toBeCloseTo(0.85, 5);
    expect(evaluate(c, t + 0.34).fade.alpha).toBeGreaterThan(0.1);
    expect(evaluate(c, t + 0.34).fade.alpha).toBeLessThan(0.85);
    expect(evaluate(c, t + 0.7).fade.alpha).toBe(0);
    expect(JSON.stringify(evaluate(c, t + 0.2))).toBe(JSON.stringify(evaluate(c, t + 0.2)));
    expect(Object.keys(evaluate(c, t + 0.2).fx)).toEqual(['anxiety', 'glow', 'roll']);
  });

  it('a flash without a key duration lasts 0.8 s; strength scales the peak', () => {
    const p = miniProject({ tracks: [fxTrack([{ at: { beatId: 'b1', offset: 0.2 }, value: { fx: 'flash', strength: 0.5, roll: 0 }, duration: 0 }])] });
    const c = compileProject(p, MINI_CTX);
    const t = c.scenes[0]!.beats[0]!.start + 0.2;
    expect(evaluate(c, t + 0.08).fade.alpha).toBeCloseTo(0.425, 5);
    expect(evaluate(c, t + 0.81).fade.alpha).toBe(0);
  });

  it('cutIn dip_white dips through white with its own longer timing (0.5 / 0.1 / 0.5 s), unlike the 0.2 / 0.2 / 0.25 s black blink', () => {
    const beats = (cutIn: string) => [
      { id: 'b1', kind: 'dialogue', speakerId: 'a', text: '你好呀，今天天气真不错。', shot: shot('two_shot', ['a', 'b']) },
      { id: 'b2', kind: 'dialogue', speakerId: 'b', text: '是啊。', cutIn, shot: shot('mcu', ['b']) },
    ];
    const white = compileProject(miniProject({ beats: beats('dip_white') }), MINI_CTX);
    const black = compileProject(miniProject({ beats: beats('dip_black') }), MINI_CTX);
    // dip_white is deliberately NOT in step with dip_black any more: a strong light needs about a second of white, a black blink is short
    expect(white.fade.map((k) => [k.duration, k.alpha])).toEqual([[0.5, 1], [0.5, 0]]);
    expect(black.fade.map((k) => [k.duration, k.alpha])).toEqual([[0.2, 1], [0.25, 0]]);
    const b2 = white.scenes[0]!.beats[1]!.start;
    expect(white.fade[1]!.at - (white.fade[0]!.at + white.fade[0]!.duration)).toBeCloseTo(0.1, 9);
    expect(white.fade[0]!.at + 0.5 + 0.05).toBeCloseTo(b2, 9);
    expect(white.fade.every((k) => k.color === 'white')).toBe(true);
    expect(black.fade.every((k) => k.color === 'black')).toBe(true);
    const t = white.scenes[0]!.beats[1]!.start - 0.1;
    expect(evaluate(white, t).fade).toMatchObject({ color: 'white' });
    expect(evaluate(white, t).fade.alpha).toBeGreaterThan(0.9);
  });
});

describe('shake effect', () => {
  const withShake = (strength: number, duration: number) => miniProject({ tracks: [fxTrack([{ at: { beatId: 'b2', offset: 0.2 }, value: { fx: 'shake', strength, roll: 0 }, duration }])] });
  it('moves the camera by at most strength * 2 % of the stage height, decaying, and only inside its window', () => {
    const base = compileProject(miniProject(), MINI_CTX);
    const c = compileProject(withShake(1, 0.5), MINI_CTX);
    const t0 = c.scenes[0]!.beats[1]!.start + 0.2;
    const H = 1119; // the synthetic background is 2048 x 1119
    const dev = (t: number) => {
      const a = evaluate(c, t).camera, b = evaluate(base, t).camera;
      return Math.hypot(a.x - b.x, a.y - b.y) * a.zoom;
    };
    expect(dev(t0 - 0.05)).toBe(0);
    expect(dev(t0 + 0.5 + 0.05)).toBe(0);
    let early = 0, late = 0;
    for (let i = 0; i < 25; i++) early = Math.max(early, dev(t0 + i * 0.004));
    for (let i = 0; i < 25; i++) late = Math.max(late, dev(t0 + 0.4 + i * 0.004));
    expect(early).toBeGreaterThan(0.4 * 0.02 * H);
    expect(early).toBeLessThanOrEqual(Math.SQRT2 * 0.02 * H + 1e-9);
    expect(late).toBeLessThan(early * 0.5);
  });

  it('scales with strength, is seekable in any order, and adds only fx.shake', () => {
    const small = compileProject(withShake(0.3, 0.5), MINI_CTX);
    const big = compileProject(withShake(1, 0.5), MINI_CTX);
    const t = big.scenes[0]!.beats[1]!.start + 0.25;
    const off = (c: typeof big) => evaluate(c, t).camera.x - evaluate(compileProject(miniProject(), MINI_CTX), t).camera.x;
    expect(Math.abs(off(small))).toBeCloseTo(0.3 * Math.abs(off(big)), 6);
    const ts = [t, t + 0.1, t - 3, t];
    expect(ts.map((x) => JSON.stringify(evaluate(big, x)))).toEqual([...ts].reverse().map((x) => JSON.stringify(evaluate(big, x))).reverse());
    expect(Object.keys(big.fx)).toEqual(['anxiety', 'glow', 'roll', 'shake']);
    expect(Object.keys(evaluate(big, t).fx)).toEqual(['anxiety', 'glow', 'roll']);
  });

  it('the beat-long move shake still works next to it (they add)', () => {
    const beats = [{ id: 'b1', kind: 'dialogue', speakerId: 'a', text: '你好呀。', shot: { type: 'cu', focus: ['a'], move: 'shake', dof: 0 } }];
    const c = compileProject(miniProject({ beats, tracks: [fxTrack([{ at: { beatId: 'b1', offset: 0.5 }, value: { fx: 'shake', strength: 1, roll: 0 }, duration: 0.5 }])] }), MINI_CTX);
    expect(c.scenes[0]!.shakes.length).toBe(1);
    expect(c.fx.shake?.length).toBe(1);
  });
});

describe('daze effect', () => {
  const daze = (extra: Record<string, unknown> = {}, strength = 1) => ({ fx: 'daze', strength, roll: 0, ...extra });
  const proj = (keys: Array<Record<string, unknown>>) => miniProject({ tracks: [fxTrack(keys)] });
  it('blur curve only; the eyelid curve appears only for the blink variant', () => {
    const plain = compileProject(proj([{ at: { beatId: 'b1', offset: 0 }, value: daze(), duration: 0.5 }]), MINI_CTX);
    expect(plain.fx.daze?.length).toBe(1);
    expect(plain.fx.blink).toBeUndefined();
    expect(Object.keys(evaluate(plain, 3).fx)).toEqual(['anxiety', 'glow', 'roll', 'daze']);
    const lids = compileProject(proj([{ at: { beatId: 'b1', offset: 0 }, value: daze({ variant: 'blink' }, 0.6), duration: 0.5 }, { at: { beatId: 'b2', offset: 0 }, value: daze({}, 0), duration: 0.5 }]), MINI_CTX);
    const [, b2] = lids.scenes[0]!.beats;
    expect(evaluate(lids, 1).fx).toMatchObject({ daze: 0.6, blink: 0.6 });
    expect(evaluate(lids, b2!.start + 1).fx).toMatchObject({ daze: 0, blink: 0 });
    expect(evaluate(lids, 0.25).fx.blink).toBeCloseTo(0.3, 5);
  });

  it('is deterministic under any seek order and adds nothing for projects without it', () => {
    const c = compileProject(proj([{ at: { beatId: 'b2', offset: 0 }, value: daze({ variant: 'blink' }), duration: 1 }]), MINI_CTX);
    const ts = [5, 0.1, 5.7, 0.1];
    expect(ts.map((t) => JSON.stringify(evaluate(c, t)))).toEqual([...ts].reverse().map((t) => JSON.stringify(evaluate(c, t))).reverse());
    expect(Object.keys(compileProject(miniProject(), MINI_CTX).fx)).toEqual(['anxiety', 'glow', 'roll']);
  });
});

describe('memory tones sepia and mono', () => {
  it('are accepted by the schema, step-sampled by time, and never leak into old values', () => {
    const key = (beatId: string, tone: string | undefined, strength: number) => ({ at: { beatId, offset: 0 }, value: { fx: 'memory', strength, roll: 0, ...(tone ? { tone } : {}) }, duration: 0 });
    const c = compileProject(miniProject({ tracks: [fxTrack([key('b1', 'sepia', 1), key('b2', 'mono', 1), key('b3', undefined, 0)])] }), MINI_CTX);
    const [b1, b2, b3] = c.scenes[0]!.beats;
    expect(evaluate(c, b1!.start + 0.1).fx.memoryTone).toBe('sepia');
    expect(evaluate(c, b2!.start + 0.1).fx.memoryTone).toBe('mono');
    expect(evaluate(c, b3!.start + 0.1).fx).toMatchObject({ memory: 0, memoryTone: 'mono' });
    expect(() => ProjectSchema.parse(miniProject({ tracks: [fxTrack([key('b1', 'sepia', 1)])] }))).not.toThrow();
  });
});
