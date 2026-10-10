import { describe, expect, it } from 'vitest';
import { compileProject } from '../../shared/timeline/compile';
import { evaluate } from '../../shared/timeline/evaluate';
import { MINI_CTX, fakeContext, miniProject } from './helpers/synthetic';

type Raw = Record<string, unknown>;
const dlg = (id: string, speakerId: string, text: string, shot: Raw, extra: Raw = {}): Raw => ({ id, kind: 'dialogue', speakerId, text, shot, ...extra });
const mcu = (focus: string[], extra: Raw = {}) => ({ type: 'mcu', focus, move: 'static', ...extra });
const fixed = (seconds: number) => ({ mode: 'fixed', seconds });
const FPS = 30;
const frames = (from: number, to: number) => Array.from({ length: Math.round((to - from) * FPS) + 1 }, (_, i) => from + i / FPS);
const track = (id: string, channel: string, target: Raw, keys: Raw[]) => ({ id, channel, target, keys: keys.map((k, i) => ({ id: `${id}${i}`, duration: 0, ease: 'linear', ...k })) });
const actor = (castId: string) => ({ kind: 'actor', castId });
const actorOf = (c: ReturnType<typeof compileProject>, t: number, id: string) => evaluate(c, t).actors.find((a) => a.castId === id)!;

describe('V6 rule director', () => {
  const emo = ['happy', 'sad', 'surprised', 'shy', 'happy', 'angry'];
  const lines = (emotions: string[]) =>
    emotions.map((e, i) => dlg(`l${i}`, i % 2 === 0 ? 'a' : 'b', '这是一句大约二十个字的台词，用来撑起一个节拍。', mcu([i % 2 === 0 ? 'a' : 'b']), { emotion: e }));

  it('switches the speaker\'s expression at the start of (nearly) every line, from the emotion tag', () => {
    const c = compileProject(miniProject({ style: { 'performance.ruleDirector': true }, beats: lines(emo) }), MINI_CTX);
    const sc = c.scenes[0]!;
    const all = sc.actors.flatMap((a) => a.expressions);
    expect(all.length).toBeGreaterThanOrEqual(Math.ceil(emo.length * 0.7));
    // each change sits on the line it belongs to, and is named after the emotion
    const a = sc.actors.find((x) => x.castId === 'a')!;
    expect(a.expressions[0]!.at).toBeCloseTo(sc.beats[0]!.start);
    expect(a.expressions[0]!.name).toMatch(/smile|bsmile/);
    expect(a.expressions[1]!.name).toBe('exp_surprised01');
  });

  it('does nothing where the author already keyed that actor (hand-made values win), and nothing at all when switched off', () => {
    const tracks = [track('t', 'expression', actor('a'), [{ at: { beatId: 'l0', offset: 0.5 }, value: { name: 'exp_shy01' } }])];
    const c = compileProject(miniProject({ style: { 'performance.ruleDirector': true }, tracks, beats: lines(emo) }), MINI_CTX);
    const a = c.scenes[0]!.actors.find((x) => x.castId === 'a')!;
    expect(a.expressions.filter((e) => e.at < c.scenes[0]!.beats[1]!.start)).toEqual([{ at: c.scenes[0]!.beats[0]!.start + 0.5, name: 'exp_shy01' }]);
    const off = compileProject(miniProject({ beats: lines(emo) }), MINI_CTX);
    expect(off.scenes[0]!.actors.flatMap((x) => x.expressions)).toEqual([]);
  });

  it('gives the speaker a new gesture on every line (gestureEvery=1) and never repeats the same family twice in a row', () => {
    const c = compileProject(miniProject({ style: { 'performance.ruleDirector': true }, beats: lines(['happy', 'thinking', 'surprised', 'neutral', 'happy', 'thinking']) }), MINI_CTX);
    const sc = c.scenes[0]!;
    for (const id of ['a', 'b']) {
      const shots = sc.actors.find((x) => x.castId === id)!.motions.filter((m) => !m.loop);
      expect(shots).toHaveLength(3);
      for (let i = 1; i < shots.length; i++) expect(shots[i]!.name.replace(/_[LCR]$/, '')).not.toBe(shots[i - 1]!.name.replace(/_[LCR]$/, ''));
    }
    const every2 = compileProject(miniProject({ style: { 'performance.ruleDirector': true, 'performance.gestureEvery': 2 }, beats: lines(['happy', 'thinking', 'surprised', 'neutral', 'happy', 'thinking']) }), MINI_CTX);
    expect(every2.scenes[0]!.actors.find((x) => x.castId === 'a')!.motions.filter((m) => !m.loop).length).toBe(1);
  });

  it('a listener without hand-made head keys turns to the speaker listenerTurnDelay after the line starts', () => {
    const c = compileProject(miniProject({ style: { 'performance.ruleDirector': true, 'performance.listenerTurnDelay': 0.3 }, beats: lines(emo) }), MINI_CTX);
    const sc = c.scenes[0]!;
    const b = sc.actors.find((x) => x.castId === 'b')!;
    expect(b.yaw.some((k) => Math.abs(k.at - (sc.beats[0]!.start + 0.3)) < 1e-9)).toBe(true);
  });
});

describe('V3 minimum shot length', () => {
  const beats = [
    dlg('b1', 'a', 'x', mcu(['a']), { duration: fixed(2) }),
    dlg('b2', 'a', 'y', { type: 'group', focus: ['a'], move: 'static' }, { duration: fixed(2) }),
    dlg('b3', 'a', 'z', { type: 'cu', focus: ['a'], move: 'static' }, { duration: fixed(2) }),
  ];
  const run = (over: Raw = {}, bs: Raw[] = beats) => compileProject(miniProject({ style: { 'rhythm.enforceMinShot': true, ...over }, beats: bs }), MINI_CTX).scenes[0]!;

  it('a short line keeps the previous camera until minShotSeconds have passed', () => {
    const sc = run();
    expect(sc.beats.map((b) => b.shotHeld)).toEqual([false, true, false]);
    expect(sc.beats[1]!.shotType).toBe('mcu');
    expect(sc.camera).toHaveLength(2);
    expect(run({ 'rhythm.minShotSeconds': 1 }).beats.map((b) => b.shotHeld)).toEqual([false, false, false]);
    expect(run({ 'rhythm.enforceMinShot': false }).beats.map((b) => b.shotHeld)).toEqual([false, false, false]);
  });

  it('N5: a closer size, another focus or a camera move is never swallowed by the rule', () => {
    const wider = [beats[0]!, beats[1]!];
    expect(run({}, wider).beats.map((b) => b.shotHeld)).toEqual([false, true]);
    expect(run({}, [beats[0]!, beats[2]!]).beats.map((b) => b.shotHeld)).toEqual([false, false]); // closer: mcu -> cu
    expect(run({}, [beats[0]!, dlg('b2', 'b', 'y', { type: 'group', focus: ['b'], move: 'static' }, { duration: fixed(2) })]).beats.map((b) => b.shotHeld)).toEqual([false, false]); // other person
    expect(run({}, [beats[0]!, dlg('b2', 'a', 'y', { type: 'group', focus: ['a'], move: 'push_in' }, { duration: fixed(2) })]).beats.map((b) => b.shotHeld)).toEqual([false, false]); // camera move
  });

  it('hand-made shots (locked / user) and dip cuts are never held', () => {
    const locked = beats.map((b, i) => (i === 1 ? { ...b, shot: { ...(b.shot as Raw), meta: { source: 'user', locked: false, updatedAt: 1 } } } : b));
    expect(run({}, locked).beats[1]!.shotHeld).toBe(false);
    const dip = beats.map((b, i) => (i === 1 ? { ...b, cutIn: 'dip_black' } : b));
    expect(run({}, dip).beats[1]!.shotHeld).toBe(false);
  });
});

describe('V4 dip, scene change, location banner', () => {
  const two = [
    dlg('b1', 'a', '第一句话说得很长很长很长。', mcu(['a']), { duration: fixed(4) }),
    dlg('b2', 'b', '第二句话也说得很长很长很长。', mcu(['b']), { duration: fixed(4), cutIn: 'dip_black' }),
  ];

  it('a dip takes 0.6-0.8 s in total, has pure black frames in the middle and hides the dialogue unless asked to keep it', () => {
    const c = compileProject(miniProject({ beats: two }), MINI_CTX);
    const t2 = c.scenes[0]!.beats[1]!.start;
    const alpha = frames(t2 - 1, t2 + 1).map((t) => ({ t, a: evaluate(c, t).fade.alpha }));
    const visible = alpha.filter((x) => x.a > 0.001);
    const span = visible.at(-1)!.t - visible[0]!.t;
    expect(span).toBeGreaterThanOrEqual(0.6 - 2 / FPS);
    expect(span).toBeLessThanOrEqual(0.8 + 2 / FPS);
    expect(alpha.filter((x) => x.a === 1).length).toBeGreaterThanOrEqual(3);
    expect(alpha[0]!.a).toBe(0);
    expect(alpha.at(-1)!.a).toBe(0);
    // the cut itself (new text, new shot) happens while the screen is black
    expect(evaluate(c, t2).fade.alpha).toBe(1);
    expect(evaluate(c, t2 + 0.1).subtitle).toBeNull(); // hidden during the dip
    expect(evaluate(c, t2 + 0.6).subtitle).not.toBeNull();
    const keep = compileProject(miniProject({ beats: [two[0]!, { ...two[1]!, cutInKeepDialog: true }] }), MINI_CTX);
    expect(evaluate(keep, t2 + 0.15).subtitle?.beatId).toBe('b2');
  });

  it('scene_black: 0.5 s pause + 0.8 s fade out + 1.2 s black before the content, 0.9 s fade in inside it, dialogue hidden', () => {
    const c = compileProject(miniProject({ transition: { kind: 'scene_black', duration: 0 }, scene: { location: { text: '某处', show: true } } }), MINI_CTX);
    const sc = c.scenes[0]!;
    expect(sc.contentStart).toBeCloseTo(2.5);
    const tr = evaluate(c, 1.0).transition!;
    expect(tr).toMatchObject({ kind: 'scene_black', pause: 0.5, out: 0.8, hold: 1.2 });
    expect(tr.seconds).toBeCloseTo(1.0);
    expect(evaluate(c, 2.49).transition).not.toBeNull();
    expect(evaluate(c, 2.5).transition).toBeNull();
    expect(evaluate(c, 2.5).fade.alpha).toBe(1);
    expect(evaluate(c, 2.5 + 0.45).fade.alpha).toBeCloseTo(0.5, 1);
    expect(evaluate(c, 2.5 + 0.9).fade.alpha).toBeCloseTo(0, 5);
    expect(evaluate(c, 1.0).subtitle).toBeNull();
  });

  it('a location scene starts with an automatic establishing shot: no people, background at 1x, dof 0, dialogue hidden, banner 0.9 s after the fade-in', () => {
    const c = compileProject(miniProject({ transition: { kind: 'scene_black', duration: 0 }, scene: { location: { text: '车库练习室', show: true } } }), MINI_CTX);
    const sc = c.scenes[0]!;
    const est = sc.beats[0]!;
    expect(est.id).toBe('s1:est');
    expect(est.kind).toBe('establishing');
    expect(est.shotType).toBe('establishing');
    expect(est.dof).toBe(0);
    expect(est.end - est.start).toBeCloseTo(0.9 + 0.9 + 0.25 + 1.9 + 0.2 + 0.5); // fade-in + delay + banner + gap
    const mid = est.start + 2.0;
    const s = evaluate(c, mid);
    expect(s.camera.zoom).toBe(1);
    expect(s.background.blur).toBe(0);
    expect(s.actors.every((a) => a.opacity === 0)).toBe(true);
    expect(s.subtitle).toBeNull();
    // banner: slide in 0.25 s, hold 1.9 s, slide out 0.2 s, starting 0.9 s after the fade-in finished
    const start = est.start + 0.9 + 0.9;
    expect(evaluate(c, start - 0.01).location).toBeNull();
    expect(evaluate(c, start + 0.1).location).toMatchObject({ text: '车库练习室', phase: 'in' });
    expect(evaluate(c, start + 1.0).location).toMatchObject({ phase: 'hold', progress: 1 });
    expect(evaluate(c, start + 0.25 + 1.9 + 0.1).location).toMatchObject({ phase: 'out' });
    expect(evaluate(c, start + 0.25 + 1.9 + 0.2 + 0.01).location).toBeNull();
    // the first real line starts afterwards, people have faded in by then
    expect(sc.beats[1]!.start).toBeCloseTo(est.end);
    expect(actorOf(c, sc.beats[1]!.start + 0.3, 'a').opacity).toBe(1);
    expect(compileProject(miniProject({ transition: { kind: 'scene_black', duration: 0 } }), MINI_CTX).scenes[0]!.beats[0]!.id).toBe('b1'); // no banner, no automatic shot
  });
});

describe('V6 entrances and exits, empty and silent beats', () => {
  const beats = [
    dlg('b1', 'a', '第一句话说得很长很长很长。', mcu(['a']), { duration: fixed(3) }),
    dlg('b2', 'b', '第二句话也说得很长很长很长。', { type: 'two_shot', focus: ['b', 'a'], move: 'static' }, { duration: fixed(3.5) }),
    { id: 'b3', kind: 'empty', shot: mcu(['a']) },
    { id: 'b4', kind: 'silent', shot: mcu(['b']) },
    dlg('b5', 'a', '第五句话也说得很长很长。', mcu(['a']), { duration: fixed(3) }),
  ];
  const blocking = { a: { slot: -0.4, depth: 0.1 }, b: { slot: 0.4, depth: 0.1, enter: { beatId: 'b2', side: 'right' } } };
  const c = compileProject(miniProject({ beats, scene: { blocking } }), MINI_CTX);
  const sc = c.scenes[0]!;
  const t = (id: string) => sc.beats.find((b) => b.id === id)!;

  it('an actor who enters is absent before, fades in over 0.2 s (6 +-1 frames) and slides in 0.04H from its side', () => {
    const b2 = t('b2').start;
    expect(actorOf(c, b2 - 0.05, 'b').opacity).toBe(0);
    const mid = frames(b2 - 0.1, b2 + 0.5).map((x) => actorOf(c, x, 'b').opacity).filter((o) => o > 0.001 && o < 0.999);
    expect(mid.length).toBeGreaterThanOrEqual(5);
    expect(mid.length).toBeLessThanOrEqual(7);
    expect(actorOf(c, b2 + 0.25, 'b').opacity).toBe(1);
    expect(actorOf(c, b2, 'b').slideH).toBeCloseTo(0.04);
    expect(actorOf(c, b2 + 0.2, 'b').slideH).toBeCloseTo(0, 6);
    expect(actorOf(c, b2 + 0.02, 'a').opacity).toBe(1); // the other one is not touched
  });

  it('the entrance reframes the camera over 0.8 s (single -> two-shot), eased out', () => {
    const k = sc.camera.find((x) => Math.abs(x.at - t('b2').start) < 1e-9)!;
    expect(k.duration).toBeCloseTo(0.8);
    expect(k.ease).toBe('outCubic');
    const before = evaluate(c, t('b2').start - 0.01).camera;
    const after = evaluate(c, t('b2').start + 0.8).camera;
    expect(after.zoom).toBeLessThan(before.zoom);
  });

  it('an empty beat fades everyone out in 0.25 s with the dialogue hidden, and the next beat fades them in again', () => {
    const b3 = t('b3').start;
    expect(actorOf(c, b3 - 0.01, 'a').opacity).toBe(1);
    const fade = frames(b3, b3 + 0.4).map((x) => actorOf(c, x, 'a').opacity).filter((o) => o > 0.001 && o < 0.999);
    expect(fade.length).toBeGreaterThanOrEqual(6);
    expect(fade.length).toBeLessThanOrEqual(8);
    expect(actorOf(c, b3 + 0.5, 'a').opacity).toBe(0);
    expect(actorOf(c, b3 + 0.5, 'b').opacity).toBe(0);
    expect(evaluate(c, b3 + 0.5).subtitle).toBeNull();
    // silent beat (b4): people are back, dialogue still hidden
    expect(actorOf(c, t('b4').start + 0.5, 'a').opacity).toBe(1);
    expect(evaluate(c, t('b4').start + 0.5).subtitle).toBeNull();
    expect(evaluate(c, t('b5').start + 0.5).subtitle?.beatId).toBe('b5');
  });

  it('default durations: empty and silent beats last 1.8 s', () => {
    expect(t('b3').end - t('b3').start).toBeCloseTo(1.8);
    expect(t('b4').end - t('b4').start).toBeCloseTo(1.8);
  });

  it('an exit fades the actor out and keeps it away', () => {
    const c2 = compileProject(miniProject({ beats, scene: { blocking: { a: { slot: -0.4, depth: 0.1, exit: { beatId: 'b2' } }, b: { slot: 0.4, depth: 0.1 } } } }), MINI_CTX);
    const b2 = c2.scenes[0]!.beats[1]!.start;
    expect(actorOf(c2, b2 - 0.01, 'a').opacity).toBe(1);
    expect(actorOf(c2, b2 + 0.4, 'a').opacity).toBe(0);
    expect(actorOf(c2, c2.duration, 'a').opacity).toBe(0);
  });

  it('unknown beat ids in enter / exit are reported, not silently invented', () => {
    const out = compileProject(miniProject({ scene: { blocking: { a: { slot: -0.4, depth: 0.1, enter: { beatId: 'nope', side: 'left' } }, b: { slot: 0.4, depth: 0.1 } } } }), MINI_CTX);
    expect(out.warnings.join('\n')).toMatch(/nope/);
  });
});

describe('V5 depth of field and actor tint', () => {
  const beats = (shots: Raw[]) => shots.map((s, i) => dlg(`d${i}`, 'a', '一句台词一句台词一句台词。', s, { duration: fixed(5) }));
  const dofs = (c: ReturnType<typeof compileProject>) => c.scenes[0]!.beats.map((b) => b.dof);
  const shots = [{ type: 'two_shot', focus: ['a', 'b'] }, mcu(['a']), { type: 'cu', focus: ['a'] }, { type: 'ecu', focus: ['a'] }];

  it('follows the shot size when not set by hand: two_shot/mcu 2, cu 5, ecu 6', () => {
    expect(dofs(compileProject(miniProject({ beats: beats(shots) }), MINI_CTX))).toEqual([2, 2, 5, 6]);
  });

  it('a dark background adds one level (max 6); a hand-set value always wins; establishing stays sharp', () => {
    const ctx = fakeContext(['mA', 'mB', 'mA2'], ['bg1']);
    ctx.backgrounds.bg1!.luma = 0.08;
    expect(dofs(compileProject(miniProject({ beats: beats(shots) }), ctx))).toEqual([3, 3, 6, 6]);
    const manual = beats(shots).map((b, i) => (i === 1 ? { ...b, shot: { ...(b.shot as Raw), dof: 0 } } : b));
    expect(dofs(compileProject(miniProject({ beats: manual }), ctx))[1]).toBe(0);
    const est = [{ id: 'e', kind: 'establishing', shot: { type: 'establishing', focus: [], move: 'static' } }];
    expect(dofs(compileProject(miniProject({ beats: est }), ctx))).toEqual([0]);
  });

  it('table values are style fields: a scene override changes the level for every beat of the scene', () => {
    const c = compileProject(miniProject({ beats: beats(shots), scene: { style: { overrides: { 'shots.mcu.dof': 4 } } } }), MINI_CTX);
    expect(dofs(c)).toEqual([2, 4, 5, 6]);
  });

  it('actors are multiplied by 0.92 (not darkened with the background); a style override and listener dimming apply', () => {
    const c = compileProject(miniProject(), MINI_CTX);
    const t = c.scenes[0]!.beats[0]!.start + 0.5;
    expect(actorOf(c, t, 'a').tint).toBeCloseTo(0.92);
    expect(actorOf(c, t, 'b').tint).toBeCloseTo(0.92); // the listener is not dimmed
    const dim = compileProject(miniProject({ style: { 'stage.actorTint': 0.8, 'stage.listenerDim': 0.25 } }), MINI_CTX);
    expect(actorOf(dim, t, 'a').tint).toBeCloseTo(0.8);
    expect(actorOf(dim, t, 'b').tint).toBeCloseTo(0.6);
  });
});

describe('V7 emotion effects and V1 legacy shots', () => {
  it('fx keys drive anxiety / glow strength and the Dutch roll, with their own fade times', () => {
    const tracks = [
      track('f', 'fx', { kind: 'screen' }, [
        { at: { beatId: 'b2', offset: 0 }, value: { fx: 'vignette_anxiety', strength: 1, roll: 0 }, duration: 0.6 },
        { at: { beatId: 'b2', offset: 0 }, value: { fx: 'dutch', strength: 1, roll: -10 } },
        { at: { beatId: 'b3', offset: 0 }, value: { fx: 'memory_glow', strength: 0.5, roll: 0 } },
        { at: { beatId: 'b3', offset: 0 }, value: { fx: 'vignette_anxiety', strength: 0, roll: 0 } },
      ]),
    ];
    const c = compileProject(miniProject({ tracks }), MINI_CTX);
    const [, b2, b3] = c.scenes[0]!.beats;
    expect(evaluate(c, b2!.start - 0.1).fx).toEqual({ anxiety: 0, glow: 0, roll: 0 });
    expect(evaluate(c, b2!.start + 0.3).fx.anxiety).toBeCloseTo(0.5, 1);
    expect(evaluate(c, b2!.start + 1).fx).toEqual({ anxiety: 1, glow: 0, roll: -10 });
    expect(evaluate(c, b3!.start + 0.1).fx).toEqual({ anxiety: 0, glow: 0.5, roll: -10 });
    expect(evaluate(c, b2!.start + 1).ui.fx.dutchRoll).toBe(10);
  });

  it('legacy shot names are mapped (closeup -> cu, bust/medium -> mcu), "wide" becomes a group with a warning', () => {
    const beats = [
      dlg('b1', 'a', '一二三四五六七八九十。', { type: 'closeup', focus: ['a'], move: 'static' }),
      dlg('b2', 'a', '一二三四五六七八九十。', { type: 'bust', focus: ['a'], move: 'static' }),
      dlg('b3', 'a', '一二三四五六七八九十。', { type: 'wide', focus: [], move: 'static' }),
    ];
    const out = compileProject(miniProject({ beats }), MINI_CTX);
    expect(out.scenes[0]!.beats.map((b) => b.shotType)).toEqual(['cu', 'mcu', 'group']);
    expect(out.warnings.filter((w) => /wide/.test(w))).toHaveLength(1);
  });
});

describe('style layers reach the compiled output', () => {
  it('beat > scene > project: durations, dialogue style and camera size follow the nearest override', () => {
    const beats = [
      dlg('b1', 'a', '短。', mcu(['b'])),
      dlg('b2', 'a', '短。', mcu(['a']), { style: { overrides: { 'rhythm.minLine': 9, 'dialog.nameSize': 0.05, 'shots.mcu.headH': 0.7 } } }),
    ];
    const c = compileProject(miniProject({ style: { 'rhythm.minLine': 3 }, scene: { style: { overrides: { 'rhythm.minLine': 5 } } }, beats }), MINI_CTX);
    const [b1, b2] = c.scenes[0]!.beats;
    expect(b1!.end - b1!.start).toBeCloseTo(5);
    expect(b2!.end - b2!.start).toBeCloseTo(9);
    expect(evaluate(c, b2!.start + 1).ui.dialog.nameSize).toBe(0.05);
    expect(evaluate(c, b1!.start + 1).ui.dialog.nameSize).toBeCloseTo(32 / 1080);
    const zoom = (t: number) => evaluate(c, t).camera.zoom;
    expect(zoom(b2!.start + 1) / zoom(b1!.start + 1)).toBeCloseTo(0.7 / 0.52, 1);
  });
});
