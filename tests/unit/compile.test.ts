import { describe, expect, it } from 'vitest';
import { ProjectSchema } from '../../shared/schema/project';
import { compileProject } from '../../shared/timeline/compile';
import { evaluate } from '../../shared/timeline/evaluate';
import { resolveStyle } from '../../shared/style/ournotes';
import { beatSeconds, sceneTimes } from '../../shared/timeline/time';
import demo from '../fixtures/demo-project.json';
import { MINI_CTX, fakeContext, miniProject } from './helpers/synthetic';

const key = (id: string, beatId: string, offset: number, value: unknown, duration = 0) => ({ id, at: { beatId, offset }, value, duration, ease: 'inOutQuad' });
const actor = (castId: string) => ({ kind: 'actor', castId });

describe('time', () => {
  it('auto duration = max(minLine, chars/readingCps + tail, typewriter + 0.3) + line gap; fixed is as written (V3)', () => {
    const st = resolveStyle(null).values;
    const dur = (text: string) => beatSeconds({ kind: 'dialogue', text, duration: { mode: 'auto', seconds: 0 } }, st);
    expect(dur('短')).toBeCloseTo(1.8);
    expect(dur('一二三四五六七八九十'.repeat(3))).toBeCloseTo(30 / 6.5 + 0.8); // 5.41
    expect(beatSeconds({ kind: 'dialogue', text: 'x', duration: { mode: 'fixed', seconds: 7 } }, st)).toBe(7);
    const slow = resolveStyle({ overrides: { 'rhythm.readingCps': 3, 'rhythm.tail': 0 } }).values;
    expect(beatSeconds({ kind: 'dialogue', text: '一二三四五六七八九十', duration: { mode: 'auto', seconds: 0 } }, slow)).toBeCloseTo(10 / 3);
  });

  it('a transition adds a lead-in before the first beat; scenes are back to back', () => {
    const p = miniProject({ transition: { kind: 'crossfade', duration: 1.5 } });
    const [t] = sceneTimes(p);
    expect(t!.start).toBe(0);
    expect(t!.contentStart).toBe(1.5);
    expect(t!.beats[0]!.start).toBe(1.5);
    expect(t!.beats[1]!.start).toBeCloseTo(t!.beats[0]!.end);
    expect(t!.end).toBeCloseTo(t!.beats[2]!.end);
  });
});

describe('compile', () => {
  it('is deterministic (pure)', () => {
    const p = miniProject();
    expect(compileProject(p, MINI_CTX)).toEqual(compileProject(p, MINI_CTX));
  });

  it('keyframes are relative to their beat: lengthening an earlier beat moves them', () => {
    const tracks = [{ id: 't', target: actor('a'), channel: 'expression', keys: [key('k', 'b2', 0.3, { name: 'exp_smile01' })] }];
    const short = compileProject(miniProject({ tracks }), MINI_CTX);
    const long = compileProject(miniProject({ tracks, text: ['这是一句很长很长很长很长很长很长很长的台词。', '是啊。', '我们去哪里？'] }), MINI_CTX);
    const at = (c: typeof short) => c.scenes[0]!.actors.find((a) => a.castId === 'a')!.expressions[0]!.at;
    const b2 = (c: typeof short) => c.scenes[0]!.beats[1]!.start;
    expect(at(short)).toBeCloseTo(b2(short) + 0.3);
    expect(at(long)).toBeCloseTo(b2(long) + 0.3);
    expect(b2(long)).toBeGreaterThan(b2(short));
  });

  it('two actors facing each other pick opposite idle variants and opposite desired yaw', () => {
    const c = compileProject(miniProject(), MINI_CTX).scenes[0]!;
    const a = c.actors.find((x) => x.castId === 'a')!;
    const b = c.actors.find((x) => x.castId === 'b')!;
    expect(a.yaw[0]!.value).toBeGreaterThan(0.5); // a is on the left: faces screen-right
    expect(b.yaw[0]!.value).toBeLessThan(-0.5);
    expect(a.motions[0]!.name).toBe('mtn_idle01_L'); // headSign +1: _L faces screen-right
    expect(b.motions[0]!.name).toBe('mtn_idle01_R');
  });

  it('head keys resolve targets in WORLD space: facing the camera is frontal (slight lean), away flips', () => {
    const tracks = [
      { id: 't', target: actor('a'), channel: 'head', keys: [key('k1', 'b1', 0, { mode: 'target', target: 'camera' }), key('k2', 'b2', 0, { mode: 'target', target: 'away' }), key('k3', 'b3', 0, { mode: 'angle', yaw: -0.4 })] },
    ];
    const a = compileProject(miniProject({ tracks }), MINI_CTX).scenes[0]!.actors.find((x) => x.castId === 'a')!;
    const vals = a.yaw.map((k) => k.value);
    expect(vals[1]).toBeCloseTo(0.15); // camera, leaning to the partner on the right
    expect(vals[2]).toBeLessThan(-0.5); // away from the partner
    expect(vals[3]).toBe(-0.4);
  });

  it('a motion family resolves to the variant matching the facing; one-shots return to idle', () => {
    const tracks = [{ id: 't', target: actor('a'), channel: 'motion', keys: [key('k', 'b2', 0, { name: 'nod01' })] }];
    const a = compileProject(miniProject({ tracks }), MINI_CTX).scenes[0]!.actors.find((x) => x.castId === 'a')!;
    const nod = a.motions.find((m) => m.name.includes('nod01'))!;
    expect(nod.name).toBe('mtn_nod01_L');
    expect(nod.loop).toBe(false);
    const back = a.motions.find((m) => m.at > nod.at)!;
    expect(back.name).toContain('idle01');
    expect(back.at).toBeCloseTo(nod.at + nod.length);
  });

  it('unknown motions are mapped to the closest one the model has (never invented, never silently dropped); unknown beats are dropped with a warning', () => {
    const tracks = [
      { id: 't1', target: actor('a'), channel: 'motion', keys: [key('k1', 'b1', 0, { name: 'doesnotexist99' })] },
      { id: 't2', target: actor('a'), channel: 'expression', keys: [key('k2', 'b1', 0, { name: 'exp_nope' }), key('k3', 'ghost', 0, { name: 'exp_smile01' })] },
    ];
    const out = compileProject(miniProject({ tracks }), MINI_CTX);
    const a = out.scenes[0]!.actors.find((x) => x.castId === 'a')!;
    const model = MINI_CTX.models.mA!.motions.map((m) => m.name);
    expect(a.motions.every((m) => model.includes(m.name))).toBe(true); // only real motions
    expect(a.motions.filter((m) => !m.loop)).toHaveLength(1); // the unknown one became a real gesture, at its time
    expect(a.expressions).toEqual([]); // nothing close in the (synthetic) model: dropped
    const warned = out.warnings.join(' | ');
    expect(warned).toMatch(/doesnotexist99.*mapped to mtn_/);
    expect(warned).toMatch(/exp_nope/);
    expect(warned).toMatch(/ghost/);
  });

  it('a costume change is a discrete model key plus a fresh idle for the new model', () => {
    const tracks = [{ id: 't', target: actor('a'), channel: 'costume', keys: [key('k', 'b2', 0.1, { modelId: 'mA2' })] }];
    const a = compileProject(miniProject({ tracks }), MINI_CTX).scenes[0]!.actors.find((x) => x.castId === 'a')!;
    expect(a.models).toHaveLength(1);
    expect(a.models[0]!.modelId).toBe('mA2');
    expect(a.motions.some((m) => Math.abs(m.at - a.models[0]!.at) < 1e-9)).toBe(true);
  });

  it('every beat gets a camera pose; push_in produces a second, tighter key', () => {
    const c = compileProject(miniProject(), MINI_CTX).scenes[0]!;
    expect(c.camera.length).toBeGreaterThanOrEqual(4); // 3 beats + push_in end
    const bust = c.camera.filter((k) => k.at >= c.beats[1]!.start && k.at < c.beats[2]!.start);
    expect(bust).toHaveLength(2);
    expect(bust[1]!.pose.zoom).toBeGreaterThan(bust[0]!.pose.zoom);
    expect(c.dof.map((k) => k.value)).toEqual([0, 3, 5]);
  });

  it('refuses unknown backgrounds and uncalibrated models loudly', () => {
    expect(() => compileProject(miniProject(), fakeContext(['mA', 'mB'], []))).toThrow(/unknown background/);
    expect(() => compileProject(miniProject(), fakeContext(['mA'], ['bg1']))).toThrow(/no calibration/);
  });
});

describe('gaze at the camera (M4)', () => {
  it('is an absolute direction: with the head turned to yaw 0.8 the eyes still counter-rotate to the lens', () => {
    const tracks = [
      { id: 'h', target: actor('a'), channel: 'head', keys: [key('k1', 'b1', 0, { mode: 'angle', yaw: 0.8 })] },
      { id: 'g', target: actor('a'), channel: 'gaze', keys: [key('k2', 'b1', 0, { target: 'camera' })] },
    ];
    const c = compileProject(miniProject({ tracks }), MINI_CTX);
    const g = c.scenes[0]!.actors.find((x) => x.castId === 'a')!.gaze.at(-1)!;
    expect([g.w, g.dir]).toEqual([1, 0]);
    const a = evaluate(c, c.scenes[0]!.beats[0]!.start + 1).actors.find((x) => x.castId === 'a')!;
    expect(a.desiredYaw).toBeCloseTo(0.8);
    expect(a.gaze.x).toBeCloseTo(-0.56);
  });
});

describe('track meta (M3)', () => {
  it('every track carries a meta that defaults and survives a schema round trip', () => {
    const tracks = [{ id: 't', target: actor('a'), channel: 'expression', keys: [] }, { id: 't2', target: actor('a'), channel: 'head', meta: { source: 'user', locked: true, updatedAt: 5 }, keys: [] }];
    const p = miniProject({ tracks });
    expect(p.scenes[0]!.tracks[0]!.meta).toEqual({ source: 'default', locked: false, updatedAt: 0 });
    expect(p.scenes[0]!.tracks[1]!.meta).toEqual({ source: 'user', locked: true, updatedAt: 5 });
    expect(ProjectSchema.parse(JSON.parse(JSON.stringify(p)))).toEqual(p);
  });
});

describe('demo project', () => {
  const parsed = ProjectSchema.parse(demo);
  const ids = new Set<string>();
  const bgs = new Set<string>();
  for (const s of parsed.scenes) {
    bgs.add(s.background.assetId);
    Object.values(s.wardrobe).forEach((w) => ids.add(w.modelId));
    for (const t of s.tracks) if (t.channel === 'costume') t.keys.forEach((k) => ids.add(k.value.modelId));
  }

  it('is valid, round-trips through the schema and has 3 scenes with a transition each', () => {
    expect(ProjectSchema.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed);
    expect(parsed.scenes).toHaveLength(3);
    expect(parsed.scenes.map((s) => s.transitionIn.kind)).toEqual(['dip_black', 'scene_black', 'dip_black']);
  });

  it('compiles with no warnings against a synthetic catalog and contains a costume change', () => {
    const out = compileProject(parsed, fakeContext([...ids], [...bgs]));
    // an intruder that cannot be moved out of a single-person shot is hidden for it (N4) and reported
    expect(out.warnings.filter((w) => !/edge-cut .*hidden for this shot/.test(w))).toEqual([]);
    expect(out.duration).toBeGreaterThan(20);
    expect(out.scenes.some((s) => s.actors.some((a) => a.models.length > 0))).toBe(true);
    expect(out.scenes.map((s) => s.start)).toEqual([...out.scenes.map((s) => s.start)].sort((a, b) => a - b));
  });

  it('the closing black-out starts only after the last line has finished typing (M5)', () => {
    const out = compileProject(parsed, fakeContext([...ids], [...bgs]));
    const last = out.scenes.at(-1)!.beats.filter((b) => b.kind === 'dialogue').at(-1)!;
    expect(out.fade.at(-1)!.at).toBeGreaterThanOrEqual(last.textEnd);
  });

  it('V3/V1/V6 acceptance on the demo: pacing, shot language, performance density', () => {
    const out = compileProject(parsed, fakeContext([...ids], [...bgs]));
    const lines = out.scenes.flatMap((s) => s.beats).filter((b) => b.kind === 'dialogue' || b.kind === 'narration');
    const avgLine = lines.reduce((a, b) => a + (b.end - b.start), 0) / lines.length;
    expect(avgLine).toBeGreaterThanOrEqual(3.5);
    const camChanges = out.scenes.reduce((n, s) => n + s.beats.filter((b) => !b.shotHeld).length, 0);
    expect(out.duration / camChanges).toBeGreaterThanOrEqual(5);
    // never a full-body / knee shot: only the original's ladder is used
    const used = new Set(out.scenes.flatMap((s) => s.beats.map((b) => b.shotType)));
    for (const t of used) expect(['establishing', 'group', 'two_shot', 'mcu', 'cu', 'ecu', 'insert']).toContain(t);
    expect(used.has('ecu') && used.has('cu') && used.has('two_shot') && used.has('group')).toBe(true);
    // a 20 s two-person stretch of scene 1: >= 6 motion changes, expression changes >= 0.7 x lines
    const s1 = out.scenes[0]!;
    const from = s1.beats.find((b) => b.id === 's1b3')!.start;
    const win = (at: number) => at >= from && at < from + 20;
    const motions = s1.actors.flatMap((a) => a.motions).filter((m) => win(m.at)).length;
    const exprs = s1.actors.flatMap((a) => a.expressions).filter((e) => win(e.at)).length;
    const spoken = s1.beats.filter((b) => b.kind === 'dialogue' && win(b.start)).length;
    expect(motions).toBeGreaterThanOrEqual(6);
    expect(exprs).toBeGreaterThanOrEqual(spoken * 0.7);
  });
});
