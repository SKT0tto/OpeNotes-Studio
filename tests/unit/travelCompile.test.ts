import { describe, expect, it } from 'vitest';
import { runScenes } from '../../server/llm/sceneRunner';
import type { Project } from '../../shared/schema/project';
import { pushAbout } from '../../shared/staging/travel';
import { bgView, viewWorldHeight } from '../../shared/staging/world';
import { compileProject } from '../../shared/timeline/compile';
import { evaluate } from '../../shared/timeline/evaluate';
import type { CompiledProject } from '../../shared/timeline/types';
import { asTravel, novelProject } from './helpers/travelNovel';
import { MINI_CTX, miniProject } from './helpers/synthetic';

const LONG = '这是一句足够长的台词，用来让这一拍持续好几秒钟，好让运镜有时间完成。';
const beat = (id: string, speaker: string, type: string, focus: string[], extra: Record<string, unknown> = {}, shotExtra: Record<string, unknown> = {}) => ({
  id, kind: 'dialogue', speakerId: speaker, text: LONG, shot: { type, focus, move: 'static', dof: 0, ...shotExtra }, ...extra,
});
/** The two-person mini project plus a third person c in the middle (slots -0.3 / 0 / 0.3). */
function threeProject(beats: Array<Record<string, unknown>>, over: Parameters<typeof miniProject>[0] = {}): Project {
  const p = miniProject({ ...over, beats });
  const s = p.scenes[0]!;
  const at = (slot: number, id: string) => ({ ...s.blocking[id]!, slot, depth: 0.1 });
  return {
    ...p,
    cast: [...p.cast, { id: 'c', characterKey: '003', displayName: 'C' } as Project['cast'][number]],
    scenes: [{ ...s, wardrobe: { ...s.wardrobe, c: { ...s.wardrobe.a! } }, blocking: { a: at(-0.3, 'a'), b: at(0.3, 'b'), c: at(0, 'a') } }],
  };
}
const run = (beats: Array<Record<string, unknown>>, over: Parameters<typeof miniProject>[0] = {}, travel = true) => {
  const p = miniProject({ ...over, beats });
  return compileProject(travel ? asTravel(p) : p, MINI_CTX);
};
const run3 = (beats: Array<Record<string, unknown>>, over: Parameters<typeof miniProject>[0] = {}, travel = true) => {
  const p = threeProject(beats, over);
  return compileProject(travel ? asTravel(p) : p, MINI_CTX);
};
const cam = (c: CompiledProject, t: number) => evaluate(c, t).camera;
/** Every shot change is a cut: the static solutions. */
const NO_MOVES = { style: { 'travel.density': 'off' } };
const MOVES = { style: { 'travel.density': 'more' } };

const SEQ = [
  beat('b1', 'a', 'mcu', ['a']),
  beat('b2', 'a', 'cu', ['a']),
  beat('b3', 'b', 'two_shot', ['a', 'b']),
  beat('b4', 'b', 'mcu', ['b']),
  beat('b5', 'b', 'ecu', ['b']),
];

describe('travel compile v2', () => {
  it('writes the scene data: stage map, background model, blur factor; every person has visibility keys', () => {
    const sc = run3(SEQ).scenes[0]!;
    expect(sc.cameraSystem).toBe('travel');
    expect(sc.travel!.version).toBe(11);
    expect(sc.travel!.stage.slots).toEqual([-0.3, 0, 0.3]);
    expect(sc.travel!.bg).toMatchObject({ sigma: 1.2, scale: 0.33, zoomMax: 3.2 });
    expect(sc.travel!.dof).toEqual({ mode: 'original', aperture: 1, depthSpan: 1.5 });
    expect(sc.travel!.focusHead.length).toBeGreaterThan(0);
    expect(sc.travel!.dofManual.length).toBeGreaterThan(0);
    expect(sc.travel!.aspect).toBeCloseTo(16 / 9, 9);
    for (const a of sc.actors) {
      expect('inFocus' in a).toBe(false);
      expect(a.shotVisible.length).toBeGreaterThan(0);
      // the arrangement is constant over the scene (no hand offsets here)
      expect(new Set(a.shiftS.map((k) => k.value)).size).toBe(1);
    }
  });

  it('the people stand one pitch apart on the compact stage (evaluate adds the stage offset to shiftX)', () => {
    const c = run3([beat('b1', 'a', 'group', ['a', 'b', 'c'])]);
    const sc = c.scenes[0]!;
    const st = evaluate(c, sc.contentStart + 0.2);
    const xs = new Map(st.actors.map((a) => [a.castId, a.shiftX]));
    // classic slots -0.3 / 0 / 0.3 are 0.76 * 0.15 * 2048 = 233 world units apart; the compact stage is tighter
    const pitch = sc.travel!.stage.xs[1]! - sc.travel!.stage.xs[0]!;
    expect(pitch).toBeLessThan(233);
    expect(pitch).toBeGreaterThan(100);
    expect(xs.get('a')!).toBeGreaterThan(0);
    expect(xs.get('b')!).toBeLessThan(0);
  });

  it('density off: cuts only, no settle; a forced travel still moves with the distance ease', () => {
    const c = run(SEQ, NO_MOVES);
    expect(c.scenes[0]!.beats.map((b) => b.camTravel?.kind)).toEqual(['cut', 'cut', 'cut', 'cut', 'cut']);
    expect(c.scenes[0]!.beats.every((b) => !!b.camTravel!.reason)).toBe(true);
    const forced = run([beat('b1', 'a', 'mcu', ['a']), beat('b2', 'a', 'cu', ['a'], {}, { transition: 'travel' })], NO_MOVES);
    const sc = forced.scenes[0]!;
    const d = sc.beats[1]!;
    expect(d.camTravel!.kind).toBe('distance');
    expect(d.camTravel!.ease).toBe('outQuad');
    expect(d.camTravel!.seconds).toBeGreaterThanOrEqual(0.4 - 1e-9);
    expect(d.camTravel!.seconds).toBeLessThanOrEqual(Math.min(2, (d.end - d.start) * 0.6) + 1e-9);
    const key = sc.camera.find((k) => k.travel?.kind === 'distance')!;
    expect(key.ease).toBe('outQuad');
    expect(key.at).toBeCloseTo(d.start, 9);
  });

  it('classic output of a project never carries travel fields', () => {
    const c = run(SEQ, {}, false);
    expect(JSON.stringify(c)).not.toMatch(/camTravel|cameraSystem|bgX|inFocus|"travel"/);
  });

  it('every segment ends exactly on the static solution of the same beat; the background has explicit classic endpoints', () => {
    const still = run(SEQ, NO_MOVES);
    const t = run(SEQ, MOVES);
    expect(t.scenes[0]!.beats.some((b) => b.camTravel!.kind === 'distance')).toBe(true);
    t.scenes[0]!.beats.forEach((b, i) => {
      if (b.shotHeld) return;
      const sb = still.scenes[0]!.beats[i]!;
      const want = cam(still, sb.start + sb.camTravel!.seconds);
      const got = cam(t, b.start + b.camTravel!.seconds);
      for (const f of ['x', 'y', 'zoom', 'bgZoom', 'bgX', 'bgY'] as const) expect(got[f], `${b.id}.${f}`).toBeCloseTo(want[f]!, 9);
    });
    for (const k of t.scenes[0]!.camera) {
      expect(k.pose.bgZoom).toBeGreaterThanOrEqual(1);
      expect(Number.isFinite(k.pose.bgX)).toBe(true);
    }
  });

  it('settle starts wider than the static solution (zoom / 1.06) with a zero-length key before it', () => {
    const t = run(SEQ);
    const sc = t.scenes[0]!;
    const i = sc.camera.findIndex((k) => k.travel?.kind === 'settle');
    expect(i).toBeGreaterThan(0);
    const pre = sc.camera[i - 1]!;
    expect(pre.duration).toBe(0);
    expect(pre.pose.zoom).toBeCloseTo(sc.camera[i]!.pose.zoom / 1.06, 9);
    expect(pre.travel).toBeUndefined();
  });

  it('is deterministic and seekable: compile twice, any sampling order, any order of seeking', () => {
    const c1 = run3(SEQ, MOVES);
    const c2 = run3(SEQ, MOVES);
    expect(c1).toEqual(c2);
    const sc = c1.scenes[0]!;
    const times: number[] = [];
    for (const k of sc.camera) for (const f of [0, 0.25, 0.5, 0.75, 1]) times.push(k.at + k.duration * f);
    const asc = [...times].sort((a, b) => a - b).map((t) => evaluate(c1, t));
    const shuffled = [...times].sort((a, b) => Math.sin(a * 12.9) - Math.sin(b * 12.9));
    const byTime = new Map(shuffled.map((t) => [t, evaluate(c1, t)]));
    [...times].sort((a, b) => a - b).forEach((t, i) => expect(byTime.get(t)).toEqual(asc[i]));
    const late = evaluate(c1, times.at(-1)!);
    const early = evaluate(c1, times[2]!);
    expect(evaluate(c1, times.at(-1)!)).toEqual(late);
    expect(evaluate(c1, times[2]!)).toEqual(early);
    expect(evaluate(c2, 5)).toEqual(evaluate(c1, 5));
  });

  it('no jumps between frames (1/120 s) apart from hard cuts: camera, background centre, zoom and opacity', () => {
    const c = run3(SEQ, MOVES);
    const sc = c.scenes[0]!;
    const W = (viewWorldHeight(sc.bg) * 16) / 9;
    const cuts = [sc.start, sc.end, ...sc.beats.map((b) => b.start), ...sc.beats.map((b) => b.end)];
    const dt = 1 / 120;
    let prev = evaluate(c, sc.start);
    let checked = 0;
    for (let t = sc.start + dt; t < sc.end; t += dt) {
      const now = evaluate(c, t);
      const crossing = cuts.some((x) => x > t - dt - 1e-9 && x <= t + 1e-9);
      if (!crossing) {
        checked++;
        expect(Math.abs(now.camera.x - prev.camera.x) * now.camera.zoom / W).toBeLessThanOrEqual(0.03);
        expect(Math.abs(Math.log(now.camera.zoom / prev.camera.zoom))).toBeLessThanOrEqual(0.02);
        const a = bgView(sc.bg, prev.camera, sc.framing);
        const b = bgView(sc.bg, now.camera, sc.framing);
        expect(Math.abs(b.cx - a.cx) * b.zoom / W).toBeLessThanOrEqual(0.03);
        now.actors.forEach((ac, i) => expect(Math.abs(ac.opacity - prev.actors[i]!.opacity)).toBeLessThanOrEqual(0.05));
      }
      prev = now;
    }
    expect(checked).toBeGreaterThan(200);
  });

  it('entrance of a two-person shot reframes (1.3 s); an entrance with a single focus is an ordinary change', () => {
    const blocking = { a: { slot: -0.4, depth: 0.1 }, b: { slot: 0.4, depth: 0.1, enter: { beatId: 'b2', side: 'right' } } };
    const c = run([beat('b1', 'a', 'mcu', ['a']), beat('b2', 'b', 'two_shot', ['a', 'b'])], { scene: { blocking } });
    const b2 = c.scenes[0]!.beats[1]!;
    expect(b2.camTravel).toMatchObject({ kind: 'reframe', seconds: 1.3 });
    const c2 = run([beat('b1', 'a', 'mcu', ['a']), beat('b2', 'b', 'mcu', ['b'])], { scene: { blocking }, ...NO_MOVES });
    expect(c2.scenes[0]!.beats[1]!.camTravel!.kind).not.toBe('reframe');
  });

  it('a long empty shot drifts (start = static solution, end = pushed in); a short one does not; the beat after it settles', () => {
    const empty = (id: string, text: string) => ({ id, kind: 'empty', text, shot: { type: 'establishing', focus: [], move: 'static' } });
    const c = run([beat('b1', 'a', 'mcu', ['a']), { ...empty('e1', ''), pause: 3.5 }, beat('b3', 'a', 'mcu', ['a'])]);
    const sc = c.scenes[0]!;
    const e = sc.beats[1]!;
    if (e.end - e.start >= 1.5) {
      expect(e.camTravel!.kind).toBe('drift');
      const k = sc.camera.find((x) => x.travel?.kind === 'drift')!;
      const start = cam(c, e.start);
      expect(k.pose.zoom).toBeCloseTo(start.zoom * 1.04, 9);
    } else {
      expect(e.camTravel!.kind).toBe('cut');
    }
    expect(sc.beats[2]!.camTravel!.kind).toBe('settle');
  });

  it('an empty shot with its own push_in keeps the push (no drift key clipping it into a jump)', () => {
    const c = run([beat('b1', 'a', 'mcu', ['a']), { id: 'e1', kind: 'empty', text: '', pause: 3.5, shot: { type: 'establishing', focus: [], move: 'push_in' } }, beat('b3', 'a', 'mcu', ['a'])]);
    const sc = c.scenes[0]!;
    const e = sc.beats[1]!;
    expect(sc.camera.some((k) => k.travel?.kind === 'drift')).toBe(false);
    expect(e.camTravel!.kind).toBe('cut');
    expect(cam(c, (e.start + e.end) / 2).zoom).toBeGreaterThan(cam(c, e.start + 1e-3).zoom);
  });

  it('explicit transitions: cut stays a cut even at full share; a travel request the geometry cannot honour warns and cuts', () => {
    const cutC = run([beat('b1', 'a', 'mcu', ['a']), beat('b2', 'a', 'cu', ['a'], {}, { transition: 'cut' })], MOVES);
    expect(cutC.scenes[0]!.beats[1]!.camTravel!.kind).toBe('cut');
    const short = run([{ ...beat('b1', 'a', 'mcu', ['a']) }, { ...beat('b2', 'a', 'cu', ['a'], {}, { transition: 'travel' }), text: '好。' }], NO_MOVES);
    const b2 = short.scenes[0]!.beats[1]!;
    if (b2.end - b2.start < 0.5 / 0.6) {
      expect(b2.camTravel!.kind).toBe('cut');
      expect(short.warnings.some((w) => w.includes('b2'))).toBe(true);
    }
  });

  it('a beat entered through black establishes a stable cut', () => {
    const c = run([beat('b1', 'a', 'mcu', ['a']), beat('b2', 'a', 'cu', ['a'], { cutIn: 'dip_black' })]);
    expect(c.scenes[0]!.beats[1]!.camTravel!.kind).toBe('cut');
  });

  it('a manual camera key inside a forced segment turns it into a cut with one warning', () => {
    const tracks = [{ id: 'tc', target: { kind: 'camera' }, channel: 'camera', keys: [{ id: 'k1', at: { beatId: 'b2', offset: 0.3 }, value: { manual: { x: 1000, y: 560, zoom: 1.2 } }, duration: 0, ease: 'inOutQuad' }] }];
    const c = run([beat('b1', 'a', 'mcu', ['a']), beat('b2', 'a', 'cu', ['a'], {}, { transition: 'travel' })], { tracks });
    expect(c.scenes[0]!.beats[1]!.camTravel!.kind).toBe('cut');
    expect(c.warnings.filter((w) => w.includes('手动相机')).length).toBe(1);
  });

  it('manual offsets move a person on screen without changing the arrangement of the others', () => {
    const c = run3([beat('b1', 'a', 'mcu', ['a'], {}, { offsets: { b: { x: 0.1, y: 0 } } })], NO_MOVES);
    const sc = c.scenes[0]!;
    const H = Math.min(sc.bg.height, sc.bg.width / (16 / 9));
    const bx = sc.actors.find((a) => a.castId === 'b')!.shiftX.at(-1)!.value;
    const ax = sc.actors.find((a) => a.castId === 'a')!.shiftX.at(-1)!.value;
    expect(bx).toBeCloseTo(0.1 * H, 9);
    expect(ax).toBeCloseTo(0, 9);
  });

  it('explicitly-classic scenes of a travel project compile exactly like an all-classic project', () => {
    const p = miniProject({ beats: SEQ });
    const classic = compileProject(p, MINI_CTX);
    const explicit = compileProject({ ...asTravel(p), scenes: p.scenes.map((s) => ({ ...s, cameraSystem: 'classic' as const })) }, MINI_CTX);
    expect(JSON.stringify(explicit)).toBe(JSON.stringify(classic));
    const mixedBase = miniProject({ beats: SEQ });
    const two = { ...mixedBase, scenes: [mixedBase.scenes[0]!, { ...mixedBase.scenes[0]!, id: 's2', cameraSystem: 'travel' as const }] };
    const allClassic = compileProject({ ...two, scenes: two.scenes.map((s) => ({ ...s, cameraSystem: 'classic' as const })) }, MINI_CTX);
    const mixed = compileProject(two, MINI_CTX);
    expect(JSON.stringify(mixed.scenes[0]!)).toBe(JSON.stringify(allClassic.scenes[0]!));
    expect(mixed.scenes[1]!.cameraSystem).toBe('travel');
  });
});

const SIDE = [beat('b1', 'a', 'mcu', ['a']), beat('b2', 'c', 'mcu', ['c']), beat('b3', 'b', 'mcu', ['b'])];
const sideRun = (style: Record<string, unknown> = {}, beats = SIDE) => run3(beats, { style: { 'travel.density': 'more', 'travel.landPush': 1.1, ...style } });
const segOf = (sc: ReturnType<typeof sideRun>['scenes'][number], id: string) => {
  const b = sc.beats.find((x) => x.id === id)!;
  const k = sc.camera.find((x) => x.travel && Math.abs(x.at - b.start) < 1e-9)!;
  return { b, k, len: b.camTravel!.seconds };
};

describe('travel compile v2: sideways moves between speakers', () => {
  it('neighbour to neighbour at mcu is a lateral move of about a third of a frame width (0.25-0.7), 1.3-2.3 s, ease-out, landing a little closer', () => {
    const c = sideRun();
    const sc = c.scenes[0]!;
    const W = (viewWorldHeight(sc.bg) * 16) / 9;
    for (const id of ['b2', 'b3']) {
      const { b, k, len } = segOf(sc, id);
      expect(b.camTravel!.kind, id).toBe('lateral');
      expect(b.camTravel!.ease).toBe('outQuad');
      expect(len).toBeGreaterThanOrEqual(0.4 - 1e-9);
      expect(len).toBeLessThanOrEqual(2 + 1e-9);
      const before = cam(c, b.start - 1e-6);
      const after = cam(c, b.start + len);
      const d = (Math.abs(after.x - before.x) * after.zoom) / W;
      expect(d, id).toBeGreaterThanOrEqual(0.25);
      expect(d, id).toBeLessThanOrEqual(0.7);
      // the landing push: the segment ends 1.1 times closer than the static solution
      expect(after.zoom / k.pose.zoom).toBeCloseTo(1, 9);
      const still = cam(run3(SIDE, NO_MOVES), b.start);
      expect(after.zoom / still.zoom).toBeCloseTo(1.1, 9);
      // ease-out: half way in time is well past half way on the way
      const F = k.travel!.anchor!;
      const sx = (t: number) => (F.x - cam(c, t).x) * cam(c, t).zoom;
      const s0 = sx(b.start);
      const s1 = sx(b.start + len);
      expect((sx(b.start + len / 2) - s0) / (s1 - s0)).toBeGreaterThanOrEqual(0.65);
    }
  });

  it('the landing camera is the static solution pushed about the anchor, and the following held lines keep it', () => {
    const c = sideRun();
    const still = run3(SIDE, NO_MOVES);
    const sc = c.scenes[0]!;
    const { b, k, len } = segOf(sc, 'b2');
    const want = pushAbout(cam(still, b.start), k.travel!.anchor!, 1.1);
    const got = cam(c, b.start + len);
    for (const f of ['x', 'y', 'zoom'] as const) expect(got[f], f).toBeCloseTo(want[f], 9);
    expect(cam(c, b.end - 1e-3).x).toBeCloseTo(got.x, 9);
  });

  it('settled background crops match classic for every single-person and two-person shot', () => {
    for (const type of ['ms', 'mcu', 'cu', 'ecu', 'two_shot'] as const) {
      const seq = [beat('b1', 'a', type, type === 'two_shot' ? ['a', 'b'] : ['a'])];
      const classic = run3(seq, NO_MOVES, false);
      const travel = run3(seq, NO_MOVES);
      const a = evaluate(classic, 1), b = evaluate(travel, 1);
      const av = bgView(classic.scenes[0]!.bg, a.camera, a.background.framing);
      const bv = bgView(travel.scenes[0]!.bg, b.camera, b.background.framing);
      for (const field of ['cx', 'cy', 'zoom'] as const) expect(bv[field], type + '/' + field).toBeCloseTo(av[field], 9);
    }
  });

  it('manual background fields and roll survive travel evaluation', () => {
    const manual = { x: 1000, y: 600, zoom: 4, bgZoom: 1.7, roll: 5 };
    const tracks = [{ id: 'camera', target: { kind: 'camera' }, channel: 'camera', keys: [{ id: 'key', at: { beatId: 'b1', offset: 0.1 }, duration: 0, ease: 'linear', value: { manual } }] }];
    const c = run3([beat('b1', 'a', 'mcu', ['a'])], { tracks });
    const st = evaluate(c, 1);
    const want = bgView(c.scenes[0]!.bg, manual, st.background.framing);
    const got = bgView(c.scenes[0]!.bg, st.camera, st.background.framing);
    expect(got).toEqual(want);
    expect(st.fx.roll).toBe(5);
  });

  it('background endpoints stay fixed when the parallax distance scale changes', () => {
    const c = sideRun({ 'travel.landPush': 1 });
    const other = sideRun({ 'travel.landPush': 1, 'travel.parallaxSigma': 2 });
    for (const b of c.scenes[0]!.beats) {
      const t = b.end - 0.05;
      expect(evaluate(c, t).camera).toEqual(evaluate(other, t).camera);
    }
  });

  it('tight single shots show only their person; two-shots show the pair (v7: bystanders leave the stage); groups show everybody, sharp', () => {
    const op = (c: ReturnType<typeof sideRun>, t: number, id: string) => evaluate(c, t).actors.find((a) => a.castId === id)!;
    const c = sideRun({}, [beat('b1', 'a', 'mcu', ['a']), beat('b2', 'a', 'two_shot', ['a', 'b']), beat('b3', 'c', 'group', ['a', 'b', 'c']), beat('b4', 'b', 'cu', ['b']), beat('b5', 'b', 'ecu', ['b'])]);
    const sc = c.scenes[0]!;
    const still = (id: string) => {
      const b = sc.beats.find((x) => x.id === id)!;
      return b.end - 0.05;
    };
    for (const [id, who] of [['b1', 'a'], ['b4', 'b'], ['b5', 'b']] as const) {
      for (const other of ['a', 'b', 'c']) expect(op(c, still(id), other).opacity, `${id}/${other}`).toBeCloseTo(other === who ? 1 : 0, 9);
    }
    for (const id of ['b2', 'b3']) {
      for (const other of ['a', 'b', 'c']) {
        const a = op(c, still(id), other);
        expect(a.opacity, `${id}/${other}`).toBeCloseTo(1, 9); // v10: c stands between a and b, so the two-shot keeps c in frame
        expect(a.blur, `${id}/${other}`).toBe(0);
      }
    }
  });

  it('a move between two tight shots fades the old speaker out and the new one in within the first 0.25 s of the move', () => {
    const c = sideRun();
    const sc = c.scenes[0]!;
    const { b, len } = segOf(sc, 'b2');
    expect(len).toBeGreaterThanOrEqual(0.4);
    const o = (t: number, id: string) => evaluate(c, t).actors.find((a) => a.castId === id)!.opacity;
    expect(o(b.start - 1e-6, 'a')).toBe(1);
    expect(o(b.start - 1e-6, 'c')).toBe(0);
    expect(o(b.start + 0.125, 'a')).toBeGreaterThan(0.3);
    expect(o(b.start + 0.125, 'a')).toBeLessThan(0.7);
    expect(o(b.start + 0.125, 'c')).toBeGreaterThan(0.3);
    expect(o(b.start + 0.125, 'c')).toBeLessThan(0.7);
    expect(o(b.start + 0.3, 'a')).toBe(0);
    expect(o(b.start + 0.3, 'c')).toBe(1);
  });

  it('neighbours "keep": everybody stays visible at every moment', () => {
    const c = sideRun({ 'travel.neighbours': 'keep' });
    const sc = c.scenes[0]!;
    for (let t = sc.start; t < sc.end; t += 0.1) for (const a of evaluate(c, t).actors) expect(a.opacity, `${a.castId}@${t}`).toBeGreaterThan(0.99);
  });

  it('ms: only the current conversation stays in the picture; adjacent ms -> ms still moves', () => {
    const auto = { dof: undefined };
    const c = sideRun({}, [beat('b1', 'a', 'ms', ['a'], {}, auto), beat('b2', 'c', 'ms', ['c'], {}, auto), beat('b3', 'b', 'ms', ['b'], {}, auto)]);
    const sc = c.scenes[0]!;
    for (const b of sc.beats) {
      const st = evaluate(c, b.end - 0.05);
      for (const a of st.actors) {
        // Compact-stage single-person framing takes priority over retaining the previous speaker.
        if (b.focus.includes(a.castId)) expect(a.opacity, `${b.id}/${a.castId}`).toBeCloseTo(1, 9);
        else expect(a.opacity, `${b.id}/${a.castId}`).toBeCloseTo(0, 9);
        if (a.opacity > 0) expect(a.blur).toBe(0);
      }
      expect(st.background.blur).toBe(0);
    }
    for (const id of ['b2', 'b3']) {
      const k = sc.beats.find((x) => x.id === id)!.camTravel!;
      expect(k.kind, id).toBe('lateral');
      expect(k.reason).toContain('交接注意');
    }
  });

  it('a group to a single person (and back) is a regroup', () => {
    const beats = [beat('b1', 'a', 'group', ['a', 'b', 'c']), beat('b2', 'a', 'mcu', ['a']), beat('b3', 'a', 'group', ['a', 'b', 'c'])];
    const sc = sideRun({}, beats).scenes[0]!;
    expect(sc.beats[1]!.camTravel!.kind).toBe('regroup');
    expect(sc.beats[1]!.camTravel!.ease).toBe('outQuad');
    expect(sc.beats[2]!.camTravel!.kind).toBe('regroup');
    const k = sc.camera.find((x) => x.travel?.kind === 'regroup')!;
    expect(k.travel!.anchor).toBeDefined();
  });

  it('the camera and the fades are continuous across the whole lateral sequence (no jumps)', () => {
    const c = sideRun();
    const sc = c.scenes[0]!;
    const W = (viewWorldHeight(sc.bg) * 16) / 9;
    const { b, len } = segOf(sc, 'b2');
    let prev = evaluate(c, b.start);
    for (let t = b.start + 1 / 120; t <= b.start + len; t += 1 / 120) {
      const now = evaluate(c, t);
      expect((Math.abs(now.camera.x - prev.camera.x) * now.camera.zoom) / W).toBeLessThanOrEqual(0.03);
      expect(Math.abs(Math.log(now.camera.zoom / prev.camera.zoom))).toBeLessThanOrEqual(0.02);
      now.actors.forEach((a, i) => expect(Math.abs(a.opacity - prev.actors[i]!.opacity)).toBeLessThanOrEqual(0.05));
      prev = now;
    }
  });
});

describe('travel compile v3: the shot hold span', () => {
  it('a move may run on into the lines that keep the camera: the limit is the hold, not the line', () => {
    const SHORT = '好。';
    const beats = [
      beat('b1', 'a', 'mcu', ['a']),
      { ...beat('b2', 'c', 'mcu', ['c']), text: SHORT },
      beat('b3', 'c', 'mcu', ['c']),
    ];
    const sc = sideRun({}, beats).scenes[0]!;
    const b2 = sc.beats[1]!;
    const b3 = sc.beats[2]!;
    expect(b3.shotHeld).toBe(true);
    expect(b2.camTravel!.kind).toBe('lateral');
    expect(b2.end - b2.start).toBeLessThan(b3.end - b2.start);
    expect(b2.camTravel!.seconds).toBeLessThanOrEqual((b3.end - b2.start) * 0.6 + 1e-9);
    // no new camera key for the held line
    expect(sc.camera.filter((k) => Math.abs(k.at - b3.start) < 1e-9)).toEqual([]);
  });

  it('every shot change carries a reason, held lines carry none', () => {
    const sc = sideRun().scenes[0]!;
    for (const b of sc.beats) {
      if (b.shotHeld) expect(b.camTravel).toBeUndefined();
      else expect(b.camTravel!.reason).toBeTruthy();
    }
  });
});

/** A camera move between two shots (a cut, with or without a slow drift after it, is none). */
const isMove = (kind: string) => ['distance', 'lateral', 'regroup'].includes(kind);

describe('travel compile on the example novel', () => {
  it('rule-directed project compiles in travel mode, uses travel segments, and every segment ends on the static solution', async () => {
    const { p, ctx } = await novelProject();
    const still = compileProject({ ...asTravel(p), style: { ...p.style, overrides: { ...p.style.overrides, 'travel.density': 'off' } } }, ctx);
    const t = compileProject(asTravel(p), ctx);
    const kinds = new Set(t.scenes.flatMap((s) => s.beats.map((b) => b.camTravel?.kind)));
    expect(kinds.has('distance') || kinds.has('settle')).toBe(true);
    t.scenes.forEach((s, si) => {
      s.beats.forEach((b, bi) => {
        if (b.shotHeld || b.camTravel!.kind === 'drift' || p.scenes[si]!.beats.find((x) => x.id === b.id)!.shot.move !== 'static') return;
        const sb = still.scenes[si]!.beats[bi]!;
        const want = evaluate(still, sb.start + sb.camTravel!.seconds).camera;
        const got = evaluate(t, b.start + b.camTravel!.seconds).camera;
        const key = s.camera.find((k) => k.travel && Math.abs(k.at - b.start) < 1e-9);
        // a sideways move between equal sizes lands pushed in about its anchor
        const landed = b.camTravel!.kind === 'lateral' && Math.abs(got.zoom / want.zoom - 1.1) < 1e-9;
        const goal = landed ? pushAbout(want, key!.travel!.anchor!, 1.1) : want;
        for (const f of ['x', 'y', 'zoom'] as const) expect(got[f], `${si}/${b.id}.${f}`).toBeCloseTo(goal[f], 6);
      });
    });
  });

  it('example changes retain reasons and conservative structural safety without shot quotas', async () => {
    const { p, ctx } = await novelProject();
    const t = compileProject(asTravel(p), ctx);
    const INFEASIBLE = /舒缓|稳定|强调|交接|隔一人|隔两个人|跨背景|太远|推拉|停留|景别相差|机位相同|手动|不是人物景别|没有上一个镜头|用户指定/;
    const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));
    let moves = 0;
    let changes = 0;
    let adjacentWide = 0;
    for (const s of t.scenes) {
      let prev: { ids: string[]; type: string } | null = null;
      for (const b of s.beats) {
        if (b.shotHeld) continue;
        const k = b.camTravel!;
        expect(k.reason, `${s.id}/${b.id}`).toBeTruthy();
        const isChange = prev !== null && !['settle', 'drift', 'reframe', 'glide'].includes(k.kind) && b.shotType !== 'establishing' && b.shotType !== 'insert';
        if (isChange) {
          changes++;
          if (isMove(k.kind)) moves++;
          const swapped = !sameSet(prev!.ids, b.focus);
          if ((b.shotType === 'cu' || b.shotType === 'ecu') && swapped) {
            expect(isMove(k.kind), `${s.id}/${b.id} into ${b.shotType}`).toBe(false);
          }
          if (b.shotType === 'two_shot' && prev!.type === 'mcu' && b.focus.includes(prev!.ids[0]!)) {
            adjacentWide++;
            expect(isMove(k.kind) || INFEASIBLE.test(k.reason!), `${s.id}/${b.id}: ${k.reason}`).toBe(true);
          }
        }
        if (b.shotType !== 'establishing' && b.shotType !== 'insert') prev = { ids: b.focus, type: b.shotType };
        else prev = null;
      }
    }
    expect(changes).toBeGreaterThan(30);
    expect(adjacentWide).toBeGreaterThan(0);
    expect(moves).toBeGreaterThan(0);
    expect(moves).toBeLessThan(changes);
    expect(t.warnings.filter((w) => /edge-cut/.test(w))).toEqual([]);
  });

  it('density restricts motivated opportunities without forcing a share', async () => {
    const { p, ctx } = await novelProject();
    const share = (density: string) => {
      const t = compileProject({ ...asTravel(p), style: { ...p.style, overrides: { ...p.style.overrides, 'travel.density': density } } }, ctx);
      let moves = 0;
      let changes = 0;
      for (const s of t.scenes) {
        let seen = false;
        for (const b of s.beats) {
          if (b.shotHeld) continue;
          const k = b.camTravel!.kind;
          if (['settle', 'drift', 'reframe', 'glide'].includes(k) || b.shotType === 'establishing' || b.shotType === 'insert') continue;
          if (!seen) {
            seen = true;
          }
          changes++;
          if (isMove(k)) moves++;
        }
      }
      return moves / changes;
    };
    expect(share('less')).toBeLessThanOrEqual(share('original'));
    expect(share('original')).toBeLessThanOrEqual(share('more'));
    expect(share('off')).toBe(0);
  });

  it('example movement durations stay within the geometric timing limits', async () => {
    const { p, ctx } = await novelProject();
    const t = compileProject(asTravel(p), ctx);
    const secs: number[] = [];
    for (const s of t.scenes) {
      for (const b of s.beats) {
        const k = b.camTravel;
        if (b.shotHeld || !k || !['distance', 'lateral', 'regroup'].includes(k.kind)) continue;
        expect(k.ease).toBe('outQuad');
        expect(k.seconds).toBeGreaterThanOrEqual(0.4 - 1e-9);
        expect(k.seconds).toBeLessThanOrEqual(2 + 1e-9);
        secs.push(k.seconds);
      }
    }
    secs.sort((a, b) => a - b);
    expect(secs.length).toBeGreaterThan(5);
    const median = secs[Math.floor(secs.length / 2)]!;
    expect(median).toBeGreaterThanOrEqual(0.4);
    expect(median).toBeLessThanOrEqual(2);
  });

  it('the rule director also directs scenes of a travel project (travel schema name)', async () => {
    const { project, deps } = await novelProject();
    const items = await runScenes(deps, asTravel(project), project.scenes.map((s) => s.id), ['scene'], 'g2', 3);
    expect(items.length).toBeGreaterThan(0);
    for (const i of items) expect(i.result, JSON.stringify(i.error ?? null)).toBeTruthy();
  });
});

describe('narrative travel compile regressions', () => {
  it('reaction and rupture survive identical framing and never receive cut drift', () => {
    for (const intent of ['reaction', 'rupture'] as const) {
      const sc = run([beat('b1', 'a', 'mcu', ['a']), beat('b2', 'a', 'mcu', ['a'], {}, { intent, meta: { source: 'ai', locked: false, updatedAt: 0 } })]).scenes[0]!;
      expect(sc.beats[1]!.shotHeld).toBe(false);
      expect(sc.beats[1]!.camTravel!.kind).toBe('cut');
      expect(sc.camera.some((k) => k.travel?.kind === 'cutDrift')).toBe(false);
    }
    const sc = run([beat('b1', 'a', 'mcu', ['a']), beat('b2', 'a', 'mcu', ['a'], {}, { transition: 'cut' })]).scenes[0]!;
    expect(sc.beats[1]!.shotHeld).toBe(false);
  });
  it('an AI reveal without a new focus and an AI move that widens cannot interrupt minimum viewing time', () => {
    for (const [before, after, intent] of [['cu', 'mcu', 'reveal'], ['mcu', 'ms', 'emphasis']] as const) {
      const raw = [
        beat('b1', 'a', before, ['a'], { text: '嗯。' }),
        beat('b2', 'a', after, ['a'], { text: '我不要这种东西。' }, { intent, transition: 'travel', meta: { source: 'ai', locked: false, updatedAt: 0 } }),
      ];
      const rhythm = { style: { 'rhythm.enforceMinShot': true } };
      const t = run(raw, rhythm), classic = run(raw, rhythm, false);
      expect(classic.scenes[0]!.beats[1]!.shotHeld).toBe(true);
      expect(t.scenes[0]!.beats[1]!.shotHeld).toBe(true);
      expect(t.scenes[0]!.beats[1]!.shotType).toBe(before);
      expect(t.scenes[0]!.beats[1]!.camTravel).toBeUndefined();
      const beatStart = t.scenes[0]!.beats[1]!.start;
      expect(t.scenes[0]!.camera.some((k) => Math.abs(k.at - beatStart) < 1e-9)).toBe(false);
    }
  });
  it('a reveal with a changed focus, a real emphasis push, AI cut and locked/user transitions remain deliberate changes', () => {
    for (const shot of [
      { intent: 'reveal', focus: ['b'], meta: { source: 'ai', locked: false, updatedAt: 0 } },
      { type: 'cu', intent: 'emphasis', transition: 'travel', meta: { source: 'ai', locked: false, updatedAt: 0 } },
      { type: 'cu', focus: ['b'], intent: 'emphasis', transition: 'cut', meta: { source: 'ai', locked: false, updatedAt: 0 } },
      { intent: 'reveal', transition: 'cut', meta: { source: 'user', locked: false, updatedAt: 0 } },
      { intent: 'reveal', transition: 'travel', meta: { source: 'user', locked: false, updatedAt: 0 } },
      { intent: 'reveal', transition: 'travel', meta: { source: 'ai', locked: false, lockedFields: ['transition'], updatedAt: 0 } },
    ]) {
      const raw = [beat('b1', 'a', 'mcu', ['a'], { text: '嗯。' }), beat('b2', 'a', 'mcu', ['a'], {}, shot)];
      expect(run(raw, { style: { 'rhythm.enforceMinShot': true } }).scenes[0]!.beats[1]!.shotHeld).toBe(false);
    }
  });
  it('v10: an AI cut on an unchanged focus is only a suggestion and the minimum viewing time still applies', () => {
    const raw = [beat('b1', 'a', 'mcu', ['a'], { text: '嗯。' }), beat('b2', 'a', 'mcu', ['a'], {}, { intent: 'reveal', transition: 'cut', meta: { source: 'ai', locked: false, updatedAt: 0 } })];
    expect(run(raw, { style: { 'rhythm.enforceMinShot': true } }).scenes[0]!.beats[1]!.shotHeld).toBe(true);
  });
  it('v10: a two-shot of people with somebody standing between keeps the middle person in frame', () => {
    const c = run3([beat('b1', 'a', 'mcu', ['a']), beat('b2', 'a', 'two_shot', ['a', 'b']), beat('b3', 'b', 'mcu', ['b'])]);
    const b2 = c.scenes[0]!.beats.find((x) => x.id === 'b2')!;
    for (const id of ['a', 'b', 'c']) expect(evaluate(c, b2.end - 0.05).actors.find((a) => a.castId === id)!.opacity, id).toBeCloseTo(1, 9);
  });
  it('scene and beat renaming preserves every camera key, including empty drift', () => {
    const p = asTravel(threeProject([beat('b1', 'a', 'mcu', ['a']), beat('b2', 'c', 'mcu', ['c']), beat('b3', 'a', 'mcu', ['a']), beat('b4', 'a', 'group', [], { kind: 'empty' })]));
    const renamed = structuredClone(p);
    renamed.scenes[0]!.id = 'renamed-scene';
    renamed.scenes[0]!.beats.forEach((b, i) => { b.id = `renamed-${i}`; });
    const a = compileProject(p, MINI_CTX), b = compileProject(renamed, MINI_CTX);
    expect(a.scenes[0]!.camera).toEqual(b.scenes[0]!.camera);
    expect(a.scenes[0]!.beats.map((x) => x.camTravel)).toEqual(b.scenes[0]!.beats.map((x) => x.camTravel));
    for (const t of [0, 1, 3, 6, a.duration / 2, a.duration - 0.1]) expect(evaluate(a, t).camera).toEqual(evaluate(b, t).camera);
  });
  it('short sequential automatic moves stop after two and leave stable viewing time', () => {
    for (const source of ['ai', 'default'] as const) {
      const raw = Array.from({ length: 12 }, (_, i) => beat(`b${i}`, i % 2 ? 'c' : 'a', 'mcu', [i % 2 ? 'c' : 'a'], { text: '今天见。' }, { intent: 'exchange', meta: { source, locked: false, updatedAt: 0 } }));
      const sc = run3(raw, MOVES).scenes[0]!;
      let runLength = 0, rested = 0;
      for (const b of sc.beats) {
        if (b.camTravel && isMove(b.camTravel.kind)) runLength++;
        else { if (b.camTravel?.reason?.includes('稳定观看')) rested++; runLength = 0; }
        expect(runLength).toBeLessThanOrEqual(2);
      }
      expect(rested).toBeGreaterThan(0);
    }
  });
  it('legacy manual choices win, while AI flow cannot override reaction; transition locks remain explicit', () => {
    for (const source of ['default', 'user', 'ai', 'rule'] as const) {
      const sc = run3([beat('b1', 'a', 'mcu', ['a']), beat('b2', 'c', 'mcu', ['c'], {}, { transition: 'travel', intent: 'reaction', meta: { source, locked: false, updatedAt: 0 } })]).scenes[0]!;
      expect(sc.beats[1]!.camTravel!.kind, source).toBe(source === 'ai' || source === 'rule' ? 'cut' : 'lateral');
    }
    const sc = run3([beat('b1', 'a', 'mcu', ['a']), beat('b2', 'c', 'mcu', ['c'], {}, { transition: 'travel', intent: 'reaction', meta: { source: 'ai', locked: false, lockedFields: ['transition'], updatedAt: 0 } })]).scenes[0]!;
    expect(sc.beats[1]!.camTravel!.kind).toBe('lateral');
  });
  it('legacy cutDrift storage cannot add arbitrary drift to a reaction', () => {
    const raw = [beat('b1', 'a', 'mcu', ['a']), beat('b2', 'c', 'cu', ['c'], {}, { intent: 'reaction' })];
    const a = run3(raw, { style: { 'travel.cutDrift': true } }), b = run3(raw, { style: { 'travel.cutDrift': false } });
    expect(a.scenes[0]!.camera).toEqual(b.scenes[0]!.camera);
  });
});

describe('travel static parity regressions', () => {
  it('default sideways landing has the static shot size, without an implicit extra push', () => {
    const moving = run3(SIDE, MOVES), still = run3(SIDE, NO_MOVES);
    for (const b of moving.scenes[0]!.beats) {
      expect(cam(moving, b.end - 0.05).zoom).toBeCloseTo(cam(still, b.end - 0.05).zoom, 9);
    }
  });
  it('an explicit pan moves the background as well as the people', () => {
    const c = run3([beat('b1', 'a', 'mcu', ['a'], {}, { move: 'pan', transition: 'cut' })]);
    const b = c.scenes[0]!.beats[0]!;
    const a = evaluate(c, b.start + 0.01), z = evaluate(c, b.end - 0.01);
    expect(z.camera.x).toBeGreaterThan(a.camera.x);
    expect(z.camera.bgX!).toBeGreaterThan(a.camera.bgX!);
  });
});
