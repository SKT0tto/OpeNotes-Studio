import { describe, expect, it } from 'vitest';
import { dofText } from '../../shared/catalog/labels';
import type { Project } from '../../shared/schema/project';
import { compileProject } from '../../shared/timeline/compile';
import { DOF_BLUR, dofBlurSmooth, evaluate, travelBgBlur } from '../../shared/timeline/evaluate';
import { MINI_CTX, miniProject } from './helpers/synthetic';
import { asTravel, novelProject } from './helpers/travelNovel';

const LONG = '这是一句足够长的台词，用来让这一拍持续好几秒钟，好让运镜有时间完成。';
/** A beat without a depth-of-field level: the travel camera blurs by distance. */
const beat = (id: string, speaker: string, type: string, focus: string[], shotExtra: Record<string, unknown> = {}) => ({
  id, kind: 'dialogue', speakerId: speaker, text: LONG, shot: { type, focus, move: 'static', ...shotExtra },
});
function threeProject(beats: Array<Record<string, unknown>>, over: Parameters<typeof miniProject>[0] = {}, depthC = 0.1): Project {
  const p = miniProject({ ...over, beats });
  const s = p.scenes[0]!;
  const at = (slot: number, id: string, depth = 0.1) => ({ ...s.blocking[id]!, slot, depth });
  return {
    ...asTravel(p),
    cast: [...p.cast, { id: 'c', characterKey: '003', displayName: 'C' } as Project['cast'][number]],
    scenes: [{ ...s, wardrobe: { ...s.wardrobe, c: { ...s.wardrobe.a! } }, blocking: { a: at(-0.3, 'a'), b: at(0.3, 'b'), c: at(0, 'a', depthC) } }],
  };
}
const run3 = (beats: Array<Record<string, unknown>>, over: Parameters<typeof miniProject>[0] = {}, depthC = 0.1) => compileProject(threeProject(beats, over, depthC), MINI_CTX);
const KEEP = { style: { 'travel.neighbours': 'keep' } };
/** Time well inside a settled shot. */
const lateIn = (c: ReturnType<typeof run3>, id: string) => c.scenes[0]!.beats.find((b) => b.id === id)!.end - 0.05;

describe('travelBgBlur: the blur follows the head share of the frame', () => {
  it('calibration: nothing up to a two-shot and a medium shot, light at MCU, strong at CU, capped for ECU', () => {
    expect(travelBgBlur(0.25, 1)).toBe(0);
    expect(travelBgBlur(0.31, 1)).toBe(0);
    expect(travelBgBlur(0.39, 1)).toBe(0);
    expect(travelBgBlur(0.42, 1)).toBe(0);
    expect(travelBgBlur(0.52, 1)).toBeCloseTo(1.5, 0);
    expect(Math.abs(travelBgBlur(0.52, 1) - 1.5)).toBeLessThan(0.2);
    expect(Math.abs(travelBgBlur(0.7, 1) - 5)).toBeLessThan(0.2);
    expect(travelBgBlur(0.95, 1)).toBe(9);
  });
  it('monotone in the head share and in the aperture; zero without aperture', () => {
    let prev = -1;
    for (let s = 0; s <= 1.2; s += 0.02) {
      const b = travelBgBlur(s, 1);
      expect(b).toBeGreaterThanOrEqual(prev);
      prev = b;
    }
    expect(travelBgBlur(0.6, 1.5)).toBeGreaterThan(travelBgBlur(0.6, 1));
    expect(travelBgBlur(0.9, 0)).toBe(0);
  });
});

describe('travel depth of field on the compiled scene', () => {
  it('tight singles blur the background by their size; two-shots and groups stay sharp', () => {
    const c = run3([
      beat('b1', 'a', 'group', ['a', 'b', 'c']), beat('b2', 'b', 'two_shot', ['a', 'b']), beat('b3', 'a', 'mcu', ['a']), beat('b4', 'b', 'cu', ['b']), beat('b5', 'a', 'ecu', ['a']),
    ]);
    const bg = (id: string) => evaluate(c, lateIn(c, id)).background.blur;
    expect(bg('b1')).toBeLessThanOrEqual(0.1);
    expect(bg('b2')).toBeLessThanOrEqual(0.1);
    expect(bg('b3')).toBeGreaterThan(0.5);
    expect(bg('b4')).toBeGreaterThan(bg('b3'));
    expect(bg('b5')).toBeGreaterThanOrEqual(bg('b4'));
    expect(bg('b5')).toBeGreaterThanOrEqual(6);
  });

  it('people in the focused row are sharp at the same depth; at a depth difference of 0.5 they blur by a third of the background', () => {
    const beats = [beat('b1', 'a', 'cu', ['a'])];
    const same = run3(beats, KEEP, 0.1);
    const t = lateIn(same, 'b1');
    const st = evaluate(same, t);
    expect(st.background.blur).toBeGreaterThan(3);
    for (const a of st.actors) expect(a.blur, a.castId).toBe(0);
    const apart = run3(beats, KEEP, 0.6);
    const sa = evaluate(apart, lateIn(apart, 'b1'));
    const c = sa.actors.find((a) => a.castId === 'c')!;
    expect(c.blur / sa.background.blur).toBeGreaterThan(0.31);
    expect(c.blur / sa.background.blur).toBeLessThan(0.35);
    expect(sa.actors.find((a) => a.castId === 'a')!.blur).toBe(0);
  });

  it('the mode "off" blurs nothing, "strong" blurs a two-shot too', () => {
    const beats = [beat('b1', 'a', 'cu', ['a']), beat('b2', 'b', 'two_shot', ['a', 'b'])];
    const off = run3(beats, { style: { 'travel.dofMode': 'off', 'travel.neighbours': 'keep' } }, 0.6);
    for (const t of [lateIn(off, 'b1'), lateIn(off, 'b2')]) {
      const st = evaluate(off, t);
      expect(st.background.blur).toBe(0);
      for (const a of st.actors) expect(a.blur).toBe(0);
    }
    const strong = run3(beats, { style: { 'travel.dofMode': 'strong' } });
    const normal = run3(beats);
    expect(evaluate(strong, lateIn(strong, 'b2')).background.blur).toBeGreaterThan(0.1);
    expect(evaluate(normal, lateIn(normal, 'b2')).background.blur).toBeLessThanOrEqual(0.1);
    expect(evaluate(strong, lateIn(strong, 'b1')).background.blur).toBeGreaterThan(evaluate(normal, lateIn(normal, 'b1')).background.blur);
  });

  it('a shot with its own depth-of-field level uses that level for the background', () => {
    const c = run3([beat('b1', 'a', 'cu', ['a'], { dof: 5 }), beat('b2', 'b', 'group', ['a', 'b', 'c'], { dof: 0 })]);
    expect(evaluate(c, lateIn(c, 'b1')).background.blur).toBeCloseTo(dofBlurSmooth(5), 9);
    expect(dofBlurSmooth(5)).toBe(DOF_BLUR[5]);
    expect(evaluate(c, lateIn(c, 'b2')).background.blur).toBe(0);
  });

  it('the aperture scales the blur', () => {
    const beats = [beat('b1', 'a', 'cu', ['a'])];
    const one = run3(beats);
    const half = run3(beats, { style: { 'travel.aperture': 0.5 } });
    expect(evaluate(half, lateIn(half, 'b1')).background.blur).toBeCloseTo(evaluate(one, lateIn(one, 'b1')).background.blur * 0.5, 9);
  });

  it('the background blur eases continuously during moves (1/120 s steps apart from the cuts)', () => {
    const beats = [beat('b1', 'a', 'mcu', ['a']), beat('b2', 'c', 'mcu', ['c']), beat('b3', 'c', 'cu', ['c']), beat('b4', 'b', 'two_shot', ['a', 'b'])];
    const c = run3(beats, { style: { 'travel.density': 'more' } });
    const sc = c.scenes[0]!;
    const cuts = [sc.start, sc.end, ...sc.beats.map((b) => b.start), ...sc.beats.map((b) => b.end)];
    expect(sc.beats.filter((b) => b.camTravel && b.camTravel.kind !== 'cut').length).toBeGreaterThan(1);
    let prev = evaluate(c, sc.start);
    let moved = 0;
    for (let t = sc.start + 1 / 120; t < sc.end; t += 1 / 120) {
      const now = evaluate(c, t);
      if (!cuts.some((x) => x > t - 1 / 120 - 1e-9 && x <= t + 1e-9)) {
        expect(Math.abs(now.background.blur - prev.background.blur), `bg ${t}`).toBeLessThan(0.3);
        if (now.background.blur !== prev.background.blur) moved++;
      }
      prev = now;
    }
    expect(moved).toBeGreaterThan(10);
  });
});

describe('travel depth of field on the example novel', () => {
  it('after a move has settled the background blur matches the shot size', async () => {
    const { p, ctx } = await novelProject();
    const c = compileProject(asTravel(p), ctx);
    const by: Record<string, number[]> = {};
    for (const s of c.scenes) {
      for (const b of s.beats) {
        if (b.shotHeld || b.shotType === 'establishing' || b.shotType === 'insert') continue;
        const t = Math.min(b.end - 0.01, b.start + (b.camTravel?.seconds ?? 0) + 0.05);
        if (t < b.start + (b.camTravel?.seconds ?? 0)) continue; // the move runs on past this line
        (by[b.shotType] ??= []).push(evaluate(c, t).background.blur);
      }
    }
    for (const x of by.group ?? []) expect(x).toBeLessThanOrEqual(0.1);
    for (const x of by.two_shot ?? []) expect(x).toBeLessThanOrEqual(0.1);
    expect((by.mcu ?? []).length).toBeGreaterThan(0);
    for (const x of by.mcu ?? []) {
      expect(x).toBeGreaterThanOrEqual(0.8);
      expect(x).toBeLessThanOrEqual(2.6);
    }
    for (const x of by.cu ?? []) {
      expect(x).toBeGreaterThanOrEqual(3.5);
      expect(x).toBeLessThanOrEqual(6.8);
    }
    for (const x of by.ecu ?? []) expect(x).toBeGreaterThanOrEqual(6);
  });
});

describe('depth-of-field text in the editor (timeline blocks, storyboard cards)', () => {
  it('a travel scene without a manual level says the blur follows the shot distance; a manual level or a classic scene shows the level', () => {
    expect(dofText(true, undefined, 3)).toBe('景深 按景距');
    expect(dofText(true, 5, 5)).toBe('景深 5');
    expect(dofText(false, undefined, 3)).toBe('景深 3');
  });
});
