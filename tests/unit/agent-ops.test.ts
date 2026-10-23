import { describe, expect, it } from 'vitest';
import { applyOp } from '../../shared/agent/apply';
import { checkOp } from '../../shared/agent/check';
import { AgentOpSchema, liveForbidden, scopeOf, type AgentOp } from '../../shared/agent/ops';
import { beatDetail, findBeats, passageOf, sceneTable } from '../../shared/agent/compact';
import { NUDGE } from '../../shared/agent/tools';
import { findLockViolations } from '../../shared/project/locks';
import { clone } from '../../shared/project/mutate';
import { cat, directedProject } from './helpers/directorFlow';
import { call, makeEnv, sceneOf } from './helpers/agentEnv';

const P = directedProject();
const ctx = { catalog: cat };
const S = P.scenes[2]!;
const beat = (i: number) => S.beats[i]!;
const lock = (p: typeof P, f: (s: (typeof P)['scenes'][number]) => void) => { const c = clone(p); f(c.scenes[2]!); return c; };
type Res = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

describe('passageOf: what "this passage" means', () => {
  it('a dialogue run keeps the silent reactions inside it and stops at narration', () => {
    const kinds = ['narration', 'dialogue', 'dialogue', 'dialogue', 'silent', 'dialogue', 'dialogue', 'narration', 'silent'] as const;
    const beats = kinds.map((kind) => ({ kind })) as unknown as Parameters<typeof passageOf>[0];
    expect(passageOf(beats, 3)).toEqual([1, 6]);
    expect(passageOf(beats, 0)).toEqual([0, 0]);
    expect(passageOf(beats, 8)).toEqual([8, 8]);
  });
});

describe('checkOp: ids, vocabulary and shape', () => {
  it('rejects unknown scene / beat / cast with the valid choices', () => {
    expect(checkOp(P, { op: 'beat_delete', sceneId: 's_99', beatId: 'x' }, ctx).problems[0]).toContain('s_3');
    const r = checkOp(P, { op: 'shot_set', sceneId: 's_3', beatId: 'nope', set: { type: 'cu' } }, ctx);
    expect(r.status).toBe('invalid');
    expect(r.problems[0]).toContain('nope');
    const c = checkOp(P, { op: 'shot_set', sceneId: 's_3', beatId: beat(2).id, set: { focus: ['c_999'] } }, ctx);
    expect(c.status).toBe('invalid');
  });
  it('rejects values outside the schema and the camera vocabulary of the scene', () => {
    expect(checkOp(P, { op: 'shot_set', sceneId: 's_3', beatId: beat(2).id, set: { type: 'ms' } }, ctx).problems[0]).toContain('景别只能取');
    expect(checkOp(P, { op: 'shot_set', sceneId: 's_3', beatId: beat(2).id, set: { type: 'cu', dof: 9 } }, ctx).status).toBe('invalid');
    expect(checkOp(P, { op: 'nonsense', sceneId: 's_3' }, ctx).status).toBe('invalid');
    expect(checkOp(P, { op: 'beat_set', sceneId: 's_3', beatId: beat(2).id, set: { emotion: 'ecstatic' } }, ctx).problems[0]).toContain('情绪只能取');
  });
  it('travel scenes allow ms and intent; classic drops intent with a warning', () => {
    const t = clone(P);
    t.scenes[2]!.cameraSystem = 'travel';
    expect(checkOp(t, { op: 'shot_set', sceneId: 's_3', beatId: beat(2).id, set: { type: 'ms', intent: 'emphasis' } }, ctx).status).toBe('ok');
    const c = checkOp(P, { op: 'shot_set', sceneId: 's_3', beatId: beat(2).id, set: { type: 'cu', intent: 'emphasis' } }, ctx);
    expect(c.status).toBe('ok');
    expect(c.warnings.join()).toContain('经典镜头系统');
    expect((c.op as Extract<AgentOp, { op: 'shot_set' }>).set.intent).toBeUndefined();
  });
  it('a two shot needs exactly two people on stage', () => {
    const b = beat(2);
    expect(checkOp(P, { op: 'shot_set', sceneId: 's_3', beatId: b.id, set: { type: 'two_shot', focus: ['c_005'] } }, ctx).status).toBe('invalid');
    expect(checkOp(P, { op: 'shot_set', sceneId: 's_3', beatId: b.id, set: { type: 'two_shot', focus: ['c_005', 'c_001'] } }, ctx).status).toBe('ok');
  });
  it('never accepts a manual camera keyframe (no coordinates)', () => {
    const r = checkOp(P, { op: 'key_set', sceneId: 's_3', target: { kind: 'camera' }, channel: 'camera', at: { beatId: beat(2).id, offset: 0 }, value: { manual: { x: 1, y: 2, zoom: 3 } } }, ctx);
    expect(r.status).toBe('invalid');
    expect(r.problems.join()).toContain('坐标');
    expect(checkOp(P, { op: 'key_set', sceneId: 's_3', target: { kind: 'camera' }, channel: 'camera', at: { beatId: beat(2).id, offset: 0 }, value: { shot: 'cu', focus: ['c_005'] } }, ctx).status).toBe('ok');
  });
  it('motion and expression must exist in the actor model; look targets must be real', () => {
    expect(checkOp(P, { op: 'key_set', sceneId: 's_3', target: { kind: 'actor', castId: 'c_001' }, channel: 'expression', at: { beatId: beat(2).id, offset: 0 }, value: { name: 'exp_smile01' } }, ctx).status).toBe('ok');
    const odd = checkOp(P, { op: 'key_set', sceneId: 's_3', target: { kind: 'actor', castId: 'c_001' }, channel: 'motion', at: { beatId: beat(2).id, offset: 0.05 }, value: { name: 'fly_away' } }, ctx);
    expect(odd.status === 'invalid' || odd.warnings.length > 0).toBe(true);
    expect(checkOp(P, { op: 'key_set', sceneId: 's_3', target: { kind: 'actor', castId: 'c_001' }, channel: 'gaze', at: { beatId: beat(2).id, offset: 0 }, value: { target: 'c_001' } }, ctx).status).toBe('invalid');
    expect(checkOp(P, { op: 'key_set', sceneId: 's_3', target: { kind: 'actor', castId: 'c_001' }, channel: 'gaze', at: { beatId: beat(2).id, offset: 0 }, value: { target: 'c_77' } }, ctx).status).toBe('invalid');
  });
  it('wardrobe must be an outfit of that character', () => {
    expect(checkOp(P, { op: 'wardrobe_set', sceneId: 's_3', castId: 'c_001', modelId: '002_casual_spring_01' }, ctx).status).toBe('invalid');
    expect(checkOp(P, { op: 'wardrobe_set', sceneId: 's_3', castId: 'c_001', modelId: '001_casual_spring_01' }, ctx).status).toBe('ok');
  });
  it('backgrounds must exist in the catalog', () => {
    expect(checkOp(P, { op: 'bg_set', sceneId: 's_3', at: 'start', assetId: 'nope' }, ctx).status).toBe('invalid');
    expect(checkOp(P, { op: 'bg_set', sceneId: 's_3', at: 'start', assetId: 'bg_roof_night' }, ctx).status).toBe('ok');
  });
});

describe('applyOp: every op group, with before -> after', () => {
  it('beat_set text / kind / emotion / cut-in / duration', () => {
    const p = clone(P);
    const op = AgentOpSchema.parse({ op: 'beat_set', sceneId: 's_3', beatId: beat(2).id, set: { text: '你们终于来了。', emotion: 'sad', cutIn: 'dip_black', duration: { mode: 'fixed', seconds: 3 } }, reason: 't' });
    const r = applyOp(p, op, { genId: 'g', now: 9 });
    expect(r.ok).toBe(true);
    const b = p.scenes[2]!.beats[2]!;
    expect([b.text, b.emotion, b.cutIn, b.duration]).toEqual(['你们终于来了。', 'sad', 'dip_black', { mode: 'fixed', seconds: 3 }]);
    expect(b.meta).toMatchObject({ source: 'ai', genId: 'g', reason: 't' });
    expect(r.changes.map((c) => c.field)).toEqual(expect.arrayContaining(['台词', '情绪', '切入', '时长']));
    expect(scopeOf(op)).toBe('structure');
  });
  it('insert / delete / move / split / merge beats keep ids and enter markers valid', () => {
    const env = makeEnv();
    const s = sceneOf(env);
    const n = s.beats.length;
    expect((call(env, 'edit_structure', { action: 'insert', afterBeatId: s.beats[1]!.id, speaker: 'c_001', text: '……嗯。', emotion: 'shy', reason: 'r' }) as Res).已放入变更集).toBeTruthy();
    expect(s.beats).toHaveLength(n + 1);
    const ins = s.beats[2]!;
    expect([ins.speakerId, ins.text, ins.kind]).toEqual(['c_001', '……嗯。', 'dialogue']);
    call(env, 'edit_structure', { action: 'split', beatId: ins.id, at: 1, reason: 'r' });
    expect(s.beats.slice(2, 4).map((b) => b.text)).toEqual(['…', '…嗯。']);
    call(env, 'edit_structure', { action: 'merge', beatId: ins.id, reason: 'r' });
    expect(s.beats[2]!.text).toBe('……嗯。');
    call(env, 'edit_structure', { action: 'move', beatId: ins.id, afterBeatId: s.beats[5]!.id, reason: 'r' });
    expect(s.beats.findIndex((b) => b.id === ins.id)).toBe(5);
    call(env, 'edit_structure', { action: 'delete', beatId: ins.id, reason: 'r' });
    expect(s.beats).toHaveLength(n);
    for (const bl of Object.values(s.blocking)) for (const m of [bl.enter?.beatId, bl.exit?.beatId]) if (m) expect(s.beats.some((b) => b.id === m)).toBe(true);
  });
  it('shot_set covers type / move / dof / transition / insert box and per-person offsets', () => {
    const env = makeEnv();
    const b = sceneOf(env).beats[7]!;
    call(env, 'set_shot', { beatIds: [b.id], type: 'cu', move: 'push_in', dof: 3, flow: 'cut', reason: 'r' });
    expect(b.shot).toMatchObject({ type: 'cu', move: 'push_in', dof: 3, transition: 'cut' });
    call(env, 'set_shot', { beatIds: [b.id], type: 'insert', insertTarget: 'hands', reason: 'r' });
    expect(b.shot.insertBox).toEqual({ x: 0.12, y: 0.4, w: 0.76, h: 0.26 });
    call(env, 'nudge_shot', { beatId: b.id, castId: 'c_001', dxSteps: -2, dySteps: 1 });
    expect(b.shot.offsets!.c_001).toEqual({ x: -2 * NUDGE.offset, y: NUDGE.offset });
    call(env, 'nudge_shot', { beatId: b.id, castId: 'c_001', dxSteps: -1 });
    expect(b.shot.offsets!.c_001!.x).toBeCloseTo(-3 * NUDGE.offset, 5);
    call(env, 'nudge_shot', { beatId: b.id, castId: 'c_001', resetOffset: true });
    expect(b.shot.offsets).toBeUndefined();
  });
  it('tighter / wider move one rung of the ladder and fill the focus', () => {
    const env = makeEnv();
    const b = sceneOf(env).beats[2]!; // mcu on c_005
    call(env, 'set_shot', { beatIds: [b.id], adjust: 'tighter', reason: 'r' });
    expect(b.shot.type).toBe('cu');
    call(env, 'set_shot', { beatIds: [b.id], adjust: 'wider', steps: 2, reason: 'r' });
    expect(b.shot.type).toBe('two_shot');
    expect(b.shot.focus).toHaveLength(2);
    expect(b.shot.focus).toContain('c_005');
  });
  it('actor keys: motion, expression, look targets, position and a relative slot nudge', () => {
    const env = makeEnv();
    const s = sceneOf(env);
    const b = s.beats[7]!;
    const r = call(env, 'set_actor', { beatId: b.id, castId: 'c_001', motion: 'nod01', expression: 'exp_sad01', gaze: 'down', head: 'c_002', slotSteps: -2, reason: 'r' }) as Res;
    expect(r.错误).toBeUndefined();
    const keyOf = (ch: string) => s.tracks.find((t) => t.channel === ch && t.target.kind === 'actor' && (t.target as { castId: string }).castId === 'c_001')!.keys.find((k) => k.at.beatId === b.id)!;
    expect(keyOf('motion').value).toEqual({ name: 'nod01' });
    expect(keyOf('expression').value).toEqual({ name: 'exp_sad01' });
    expect(keyOf('gaze').value).toEqual({ target: 'down' });
    expect((keyOf('position').value as { slot: number }).slot).toBeCloseTo(-0.2, 3);
    call(env, 'set_actor', { beatId: b.id, castId: 'c_001', slotSteps: -1, reason: 'r' });
    expect((keyOf('position').value as { slot: number }).slot).toBeCloseTo(-0.3, 3);
    expect(call(env, 'set_actor', { beatId: b.id, castId: 'c_001', gaze: 'c_001' })).toMatchObject({ 错误: expect.any(Array) });
  });
  it('fx ranges: memory through white, one-shot limits, dim limit, clear, strength nudge', () => {
    const env = makeEnv();
    const s = sceneOf(env);
    const r = call(env, 'set_fx', { fromBeatId: s.beats[4]!.id, toBeatId: s.beats[6]!.id, fx: 'memory', tone: 'sepia', edge: 'bands', reason: 'r' }) as Res;
    expect(r.错误).toBeUndefined();
    const fxKeys = s.tracks.filter((t) => t.channel === 'fx').flatMap((t) => t.keys).filter((k) => (k.value as { fx: string }).fx === 'memory');
    expect(fxKeys.some((k) => (k.value as { tone?: string; edge?: string }).tone === 'sepia' && (k.value as { edge?: string }).edge === 'bands')).toBe(true);
    expect(s.tracks.some((t) => t.channel === 'fade' && t.keys.length > 0)).toBe(true);
    expect(JSON.stringify(r)).toContain('原文没有回忆线索'); // no textual support: applied anyway, as the user asked
    // re-toning the same memory is a visible change (not an empty one) and is not "adding" a memory
    const retone = call(env, 'set_fx', { fromBeatId: s.beats[4]!.id, toBeatId: s.beats[6]!.id, fx: 'memory', tone: 'mono', reason: 'r' }) as Res;
    expect(JSON.stringify(retone)).toContain('memory·mono');
    expect(JSON.stringify(retone)).not.toContain('原文没有回忆线索');
    expect(call(env, 'set_fx', { fromBeatId: s.beats[4]!.id, toBeatId: s.beats[6]!.id, fx: 'flash' })).toMatchObject({ 错误: expect.any(Array) });
    expect(call(env, 'set_fx', { fromBeatId: s.beats[10]!.id, toBeatId: s.beats[16]!.id, fx: 'dim' })).toMatchObject({ 错误: [expect.stringContaining('压暗最多')] });
    call(env, 'set_fx', { fromBeatId: s.beats[8]!.id, fx: 'shake', strength: 0.4, reason: 'r' });
    const shake = () => (s.tracks.flatMap((t) => t.keys as unknown) as Array<{ value: unknown; at: { beatId: string } }>).find((k) => (k.value as { fx?: string }).fx === 'shake' && k.at.beatId === s.beats[8]!.id)!;
    expect((shake().value as { strength: number }).strength).toBe(0.4);
    call(env, 'set_fx', { fromBeatId: s.beats[8]!.id, fx: 'shake', strengthSteps: 1, reason: 'r' });
    expect((shake().value as { strength: number }).strength).toBeCloseTo(0.6, 5);
    call(env, 'set_fx', { fromBeatId: s.beats[0]!.id, toBeatId: s.beats.at(-1)!.id, fx: 'none', reason: 'r' });
    expect(s.tracks.filter((t) => t.channel === 'fx').flatMap((t) => t.keys).filter((k) => (k.value as { strength: number }).strength > 0)).toHaveLength(0);
  });
  it('changing one fx parameter keeps the others (memory edge + strength survive a re-tone; daze eyelid survives a strength change)', () => {
    const env = makeEnv();
    const s = sceneOf(env);
    const val = (fx: string) => (s.tracks.filter((t) => t.channel === 'fx').flatMap((t) => t.keys) as Array<{ value: Record<string, unknown> }>).map((k) => k.value).filter((v) => v.fx === fx && (v.strength as number) > 0);
    call(env, 'set_fx', { fromBeatId: s.beats[4]!.id, toBeatId: s.beats[6]!.id, fx: 'memory', tone: 'sepia', edge: 'bands', strength: 0.6, reason: 'r' });
    call(env, 'set_fx', { fromBeatId: s.beats[4]!.id, toBeatId: s.beats[6]!.id, fx: 'memory', tone: 'mono', reason: 'r' });
    expect(val('memory')).toHaveLength(1);
    expect(val('memory')[0]).toMatchObject({ tone: 'mono', edge: 'bands', strength: 0.6 });
    // an explicit parameter still wins
    call(env, 'set_fx', { fromBeatId: s.beats[4]!.id, toBeatId: s.beats[6]!.id, fx: 'memory', edge: 'fog', reason: 'r' });
    expect(val('memory')[0]).toMatchObject({ tone: 'mono', edge: 'fog', strength: 0.6 });
    call(env, 'set_fx', { fromBeatId: s.beats[8]!.id, toBeatId: s.beats[9]!.id, fx: 'daze', variant: 'blink', strength: 0.8, reason: 'r' });
    call(env, 'set_fx', { fromBeatId: s.beats[8]!.id, toBeatId: s.beats[9]!.id, fx: 'daze', strength: 0.4, reason: 'r' });
    expect(val('daze')[0]).toMatchObject({ variant: 'blink', strength: 0.4 });
  });
  it('headTilt=down writes a pitched head key that keeps the facing already there', () => {
    const env = makeEnv();
    const s = sceneOf(env);
    const cast = Object.keys(s.wardrobe)[0]!;
    const headKeys = () => s.tracks.filter((t) => t.channel === 'head').flatMap((t) => t.keys as Array<{ at: { beatId: string }; value: Record<string, unknown> }>);
    const r = call(env, 'set_actor', { beatId: s.beats[3]!.id, castId: cast, headTilt: 'down', reason: 'r' }) as Res;
    expect(r.错误).toBeUndefined();
    expect(headKeys().find((k) => k.at.beatId === s.beats[3]!.id && k.value.pitch !== undefined)!.value).toMatchObject({ mode: 'target', pitch: -0.6 });
    expect(JSON.stringify(r)).toContain('低头');
    // an existing facing is kept
    call(env, 'set_actor', { beatId: s.beats[5]!.id, castId: cast, head: 'camera', reason: 'r' });
    call(env, 'set_actor', { beatId: s.beats[6]!.id, castId: cast, headTilt: 'down', reason: 'r' });
    expect(headKeys().find((k) => k.at.beatId === s.beats[6]!.id && k.value.pitch !== undefined)!.value).toMatchObject({ target: 'camera', pitch: -0.6 });
    call(env, 'set_actor', { beatId: s.beats[7]!.id, castId: cast, headTilt: 'level', reason: 'r' });
    expect(headKeys().filter((k) => k.at.beatId === s.beats[7]!.id).every((k) => k.value.pitch === undefined)).toBe(true);
  });
  it('entrances and exits: presence, enter before exit, speaker-before-entrance warned about', () => {
    const env = makeEnv();
    const s = sceneOf(env);
    const firstLine = s.beats.findIndex((b) => b.speakerId === 'c_002');
    expect(firstLine).toBeGreaterThan(-1);
    const r = call(env, 'set_entrance', { castId: 'c_002', enterAt: s.beats[firstLine + 2]!.id, side: 'left', reason: 'r' }) as Res;
    expect(s.blocking.c_002!.enter).toEqual({ beatId: s.beats[firstLine + 2]!.id, side: 'left' });
    expect(JSON.stringify(r.提示)).toContain('不在台上');
    expect(call(env, 'set_entrance', { castId: 'c_002', exitAt: s.beats[0]!.id })).toMatchObject({ 错误: [expect.stringContaining('进场必须早于离场')] });
    const env2 = makeEnv(P, { sceneId: 's_1' });
    const s1 = sceneOf(env2, 's_1');
    expect(s1.wardrobe.c_004).toBeUndefined();
    call(env2, 'set_entrance', { castId: 'c_004', enterAt: s1.beats[3]!.id, reason: 'r' });
    expect(s1.wardrobe.c_004).toBeTruthy();
    expect(s1.blocking.c_004!.enter!.beatId).toBe(s1.beats[3]!.id);
    call(env2, 'set_entrance', { castId: 'c_004', inScene: false });
    expect(s1.wardrobe.c_004).toBeUndefined();
  });
  it('background at the start (title bar follows) and at a beat (track key), plus removing the key', () => {
    const env = makeEnv();
    const s = sceneOf(env);
    call(env, 'set_background', { at: 'start', assetId: 'bg_roof_night', reason: 'r' });
    expect(s.background.assetId).toBe('bg_roof_night');
    expect(s.location!.text).toBe('天台');
    call(env, 'set_background', { at: s.beats[10]!.id, assetId: 'bg_ring_night', transition: 'crossfade', reason: 'r' });
    const key = s.tracks.find((t) => t.channel === 'background')!.keys.find((k) => k.at.beatId === s.beats[10]!.id)!;
    expect(key.value).toMatchObject({ assetId: 'bg_ring_night', transition: 'crossfade', transitionSeconds: 1 });
    call(env, 'set_background', { at: s.beats[10]!.id, assetId: null, reason: 'r' });
    expect(s.tracks.find((t) => t.channel === 'background')?.keys.some((k) => k.at.beatId === s.beats[10]!.id) ?? false).toBe(false);
  });
  it('wardrobe and costume keys; scene settings', () => {
    const env = makeEnv();
    const s = sceneOf(env);
    call(env, 'set_costume', { castId: 'c_001', modelId: '001_casual_spring_01', reason: 'r' });
    expect(s.wardrobe.c_001!.modelId).toBe('001_casual_spring_01');
    call(env, 'set_costume', { castId: 'c_001', modelId: '001_school_winter_hs_1st', atBeatId: s.beats[6]!.id, reason: 'r' });
    expect(s.tracks.some((t) => t.channel === 'costume')).toBe(true);
    call(env, 'set_scene', { title: '新标题', mood: '安静', cameraSystem: 'travel', transitionKind: 'dip_black', transitionSeconds: 1.5 });
    expect([s.title, s.brief?.mood, s.cameraSystem, s.transitionIn.kind, s.transitionIn.duration]).toEqual(['新标题', '安静', 'travel', 'dip_black', 1.5]);
  });
  it('generic keyframes: add / edit / shift in time / delete; ease and duration', () => {
    const env = makeEnv();
    const s = sceneOf(env);
    const b = s.beats[7]!;
    call(env, 'set_keyframe', { channel: 'gaze', castId: 'c_001', beatId: b.id, offset: 0.2, value: { target: 'camera' }, duration: 0.3, ease: 'inOutSine', reason: 'r' });
    const tr = s.tracks.find((t) => t.channel === 'gaze' && (t.target as { castId?: string }).castId === 'c_001')!;
    const k = tr.keys.find((x) => x.at.beatId === b.id && x.at.offset === 0.2)!;
    expect([k.value, k.duration, k.ease]).toEqual([{ target: 'camera' }, 0.3, 'inOutSine']);
    call(env, 'set_keyframe', { channel: 'gaze', castId: 'c_001', keyId: k.id, value: { target: 'away' } });
    expect(k.value).toEqual({ target: 'away' });
    call(env, 'set_keyframe', { channel: 'gaze', castId: 'c_001', keyId: k.id, shiftSteps: 2 });
    expect(k.at.offset).toBeCloseTo(0.4, 2);
    call(env, 'set_keyframe', { channel: 'gaze', castId: 'c_001', keyId: k.id, remove: true });
    expect(tr.keys.some((x) => x.id === k.id)).toBe(false);
    expect(call(env, 'set_keyframe', { channel: 'gaze', beatId: b.id, value: { target: 'camera' } })).toMatchObject({ 错误: [expect.stringContaining('castId')] });
  });
  it('lock_set locks and unlocks a field or unit', () => {
    const env = makeEnv();
    const b = sceneOf(env).beats[3]!;
    call(env, 'set_lock', { unit: 'beat', beatId: b.id, fields: ['text'], reason: 'r' });
    expect(b.meta.lockedFields).toEqual(['text']);
    call(env, 'set_lock', { unit: 'shot', beatId: b.id, locked: true });
    expect(b.shot.meta.locked).toBe(true);
    call(env, 'set_lock', { unit: 'shot', beatId: b.id, locked: false });
    expect(b.shot.meta.locked).toBe(false);
    expect(checkOp(env.sandbox, { op: 'lock_set', sceneId: 's_3', unit: 'beat', beatId: b.id, lockedFields: ['colour'] }, ctx).status).toBe('invalid');
  });
  it('bad tool arguments are reported, not thrown', () => {
    const env = makeEnv();
    expect(call(env, 'set_shot', { beatIds: [] })).toMatchObject({ 错误: expect.any(Array) });
    expect(call(env, 'no_such_tool', {})).toMatchObject({ 错误: expect.any(Array) });
    expect(env.stats.badArgs).toBe(1);
  });
});

describe('locks and hand-made content', () => {
  it('a locked shot needs the user: needs_unlock, nothing applied, same verdict as the editor gate', () => {
    const p = lock(P, (s) => { s.beats[3]!.shot.meta.locked = true; });
    const op = { op: 'shot_set', sceneId: 's_3', beatId: beat(3).id, set: { type: 'ecu' } } as const;
    const r = checkOp(p, op, ctx);
    expect(r.status).toBe('needs_unlock');
    expect(r.violations[0]!.label).toContain('镜头');
    const sim = clone(p);
    applyOp(sim, op, { genId: 'g', now: 1 });
    expect(findLockViolations(p, sim).length).toBeGreaterThan(0);
    const env = makeEnv(p);
    const out = call(env, 'set_shot', { beatIds: [beat(3).id], type: 'ecu', reason: 'r' }) as Res;
    expect(out.待用户确认).toBeTruthy();
    expect(env.pending).toHaveLength(1);
    expect(env.applied).toHaveLength(0);
    expect(sceneOf(env).beats[3]!.shot.type).toBe(beat(3).shot.type);
  });
  it('field locks protect only their field', () => {
    const p = lock(P, (s) => { s.beats[3]!.shot.meta.lockedFields = ['type']; });
    expect(checkOp(p, { op: 'shot_set', sceneId: 's_3', beatId: beat(3).id, set: { type: 'ecu' } }, ctx).status).toBe('needs_unlock');
    expect(checkOp(p, { op: 'shot_set', sceneId: 's_3', beatId: beat(3).id, set: { dof: 4 } }, ctx).status).toBe('ok');
  });
  it('a locked beat protects its text but not its shot or rhythm (own units)', () => {
    const p = lock(P, (s) => { s.beats[3]!.meta.locked = true; });
    expect(checkOp(p, { op: 'beat_set', sceneId: 's_3', beatId: beat(3).id, set: { text: 'x' } }, ctx).status).toBe('needs_unlock');
    expect(checkOp(p, { op: 'shot_set', sceneId: 's_3', beatId: beat(3).id, set: { type: 'cu' } }, ctx).status).toBe('ok');
    expect(checkOp(p, { op: 'timing', sceneId: 's_3', beatIds: [beat(3).id], set: { 'rhythm.lineGap': 0.5 } }, ctx).status).toBe('ok');
  });
  it('hand-made content needs confirmation unless the user named it, and then stays recorded as user', () => {
    const p = lock(P, (s) => { s.beats[3]!.shot.meta.source = 'user'; });
    const op = { op: 'shot_set', sceneId: 's_3', beatId: beat(3).id, set: { type: 'cu' } } as const;
    const r = checkOp(p, op, ctx);
    expect(r.status).toBe('needs_confirm');
    expect(r.overwrote[0]).toContain('镜头');
    expect(checkOp(p, { ...op, overrideUser: true }, ctx).status).toBe('ok');
    const sim = clone(p);
    applyOp(sim, { ...op, overrideUser: true }, { genId: 'g', now: 1 });
    expect(sim.scenes[2]!.beats[3]!.shot.meta.source).toBe('user');
    const env = makeEnv(p);
    expect(call(env, 'set_shot', { beatIds: [beat(3).id], type: 'cu', overwriteManual: true, reason: 'r' })).toHaveProperty('已放入变更集');
  });
  it('clearing effects skips locked keys and says so', () => {
    const env = makeEnv();
    const s = sceneOf(env);
    call(env, 'set_fx', { fromBeatId: s.beats[2]!.id, fx: 'shake', reason: 'r' });
    call(env, 'set_fx', { fromBeatId: s.beats[6]!.id, fx: 'shake', reason: 'r' });
    const k = s.tracks.filter((t) => t.channel === 'fx').flatMap((t) => t.keys).find((x) => x.at.beatId === s.beats[6]!.id)!;
    k.meta.locked = true;
    const out = call(env, 'set_fx', { fromBeatId: s.beats[0]!.id, toBeatId: s.beats.at(-1)!.id, fx: 'none', reason: 'r' }) as Res;
    expect(JSON.stringify(out.已放入变更集)).toContain('跳过');
    expect(s.tracks.filter((t) => t.channel === 'fx').flatMap((t) => t.keys).some((x) => x.id === k.id)).toBe(true);
    // ... and the locked one is not silently dropped: an "unlock and apply" item waits under "needs you"
    expect(env.pending).toHaveLength(1);
    expect(env.pending[0]!.status).toBe('needs_unlock');
    expect(env.pending[0]!.op).toMatchObject({ op: 'fx_range', fx: 'none', includeProtected: true });
    expect(JSON.stringify(out.待用户确认)).toContain('锁');
  });
});

describe('a locked effect is never skipped silently', () => {
  it('clearing only a locked effect changes nothing but still leaves an unlock-and-apply item', () => {
    const env = makeEnv();
    const s = sceneOf(env);
    call(env, 'set_fx', { fromBeatId: s.beats[4]!.id, fx: 'shake', reason: 'r' });
    s.tracks.filter((t) => t.channel === 'fx').flatMap((t) => t.keys).forEach((k) => { k.meta.locked = true; });
    const n = env.applied.length;
    const out = call(env, 'set_fx', { fromBeatId: s.beats[4]!.id, fx: 'none', reason: 'r' }) as Res;
    expect(env.applied).toHaveLength(n);
    expect(env.pending).toHaveLength(1);
    expect(env.pending[0]!.status).toBe('needs_unlock');
    expect(JSON.stringify(out.待用户确认)).toContain('锁');
  });
});

describe('rhythm is its own scope', () => {
  it('slower / gap / reset write only beat.style rhythm overrides', () => {
    const env = makeEnv();
    const s = sceneOf(env);
    const ids = [s.beats[2]!.id, s.beats[3]!.id];
    const shotBefore = JSON.stringify(s.beats.map((b) => b.shot));
    call(env, 'set_timing', { beatIds: ids, pace: 'slower', reason: 'r' });
    const o = s.beats[2]!.style.overrides;
    expect(o['rhythm.readingCps'] as number).toBeCloseTo(6.5 * NUDGE.pace, 1);
    expect(o['rhythm.tail'] as number).toBeCloseTo(1.1, 2);
    expect(o['rhythm.lineGap'] as number).toBeCloseTo(0.2, 2);
    call(env, 'set_timing', { beatIds: [ids[0]!], gapSteps: 2, reason: 'r' });
    expect(s.beats[2]!.style.overrides['rhythm.lineGap'] as number).toBeCloseTo(0.8, 2);
    expect(s.beats[3]!.style.overrides['rhythm.lineGap'] as number).toBeCloseTo(0.2, 2);
    expect(JSON.stringify(s.beats.map((b) => b.shot))).toBe(shotBefore);
    expect(s.beats[2]!.style.meta.source).toBe('ai');
    call(env, 'set_timing', { beatIds: ids, reset: true });
    expect(Object.keys(s.beats[2]!.style.overrides).filter((k) => k.startsWith('rhythm.'))).toEqual([]);
    expect(env.applied.every((r) => r.changes.every((c) => c.scope === 'rhythm'))).toBe(true);
  });
  it('camera edits never touch rhythm; a rhythm lock and a shot lock are independent', () => {
    const p = lock(P, (s) => { s.beats[3]!.style.meta.locked = true; });
    expect(checkOp(p, { op: 'shot_set', sceneId: 's_3', beatId: beat(3).id, set: { type: 'cu' } }, ctx).status).toBe('ok');
    expect(checkOp(p, { op: 'timing', sceneId: 's_3', beatIds: [beat(3).id], set: { 'rhythm.lineGap': 1 } }, ctx).status).toBe('needs_unlock');
    const q = lock(P, (s) => { s.beats[3]!.shot.meta.locked = true; });
    expect(checkOp(q, { op: 'timing', sceneId: 's_3', beatIds: [beat(3).id], set: { 'rhythm.lineGap': 1 } }, ctx).status).toBe('ok');
    const sim = clone(P);
    applyOp(sim, { op: 'shot_set', sceneId: 's_3', beatId: beat(3).id, set: { type: 'cu' } }, { genId: 'g', now: 1 });
    expect(sim.scenes[2]!.beats[3]!.style).toEqual(P.scenes[2]!.beats[3]!.style);
  });
  it('rejects rhythm values outside the editor ranges and non-rhythm paths', () => {
    expect(checkOp(P, { op: 'timing', sceneId: 's_3', beatIds: [beat(3).id], set: { 'rhythm.lineGap': 9 } }, ctx).status).toBe('invalid');
    expect(checkOp(P, { op: 'timing', sceneId: 's_3', beatIds: [beat(3).id], set: { 'dialog.textSize': 0.05 } }, ctx).status).toBe('invalid');
    expect(scopeOf({ op: 'timing', sceneId: 's', beatIds: ['a'], set: {} })).toBe('rhythm');
  });
});

describe('replay determinism, readback and live-mode filter', () => {
  it('replaying the recorded ops on the original project gives the sandbox result (so one undo step is exact)', () => {
    const env = makeEnv();
    const s = sceneOf(env);
    call(env, 'set_shot', { beatIds: [s.beats[2]!.id, s.beats[3]!.id], adjust: 'tighter', reason: 'r' });
    call(env, 'set_timing', { beatIds: [s.beats[2]!.id], pace: 'slower', reason: 'r' });
    call(env, 'set_fx', { fromBeatId: s.beats[8]!.id, fx: 'shake', reason: 'r' });
    call(env, 'edit_structure', { action: 'insert', afterBeatId: s.beats[4]!.id, speaker: 'c_001', text: '嗯。', reason: 'r' });
    expect(env.applied.length).toBeGreaterThanOrEqual(4);
    const replay = clone(P);
    for (const r of env.applied) expect(applyOp(replay, r.op, { genId: 'agent_t', now: 5000 }).ok).toBe(true);
    expect(JSON.stringify(replay.scenes)).toBe(JSON.stringify(env.sandbox.scenes));
    for (const r of env.applied.filter((x) => x.op.op === 'shot_set' || x.op.op === 'timing')) expect(applyOp(clone(env.sandbox), r.op, { genId: 'agent_t', now: 5000 }).changes).toEqual([]);
  });
  it('tables and readbacks show what the editor shows (lock / hand-made flags)', () => {
    const p = lock(P, (s) => { s.beats[3]!.shot.meta.locked = true; s.beats[4]!.meta.source = 'user'; });
    const t = sceneTable(p, 's_3', { from: 4, to: 5 });
    expect(t).toContain('锁:镜头');
    expect(t).toContain('手改:句');
    expect(beatDetail(p, 's_3', beat(2).id)).toContain(beat(2).text);
    expect(findBeats(p, { speaker: '灯', text: '想换一个说法' })[0]).toMatchObject({ sceneId: 's_3', speaker: '高松灯' });
    expect(findBeats(p, { speaker: 'c_005', sceneId: 's_3' }).length).toBeGreaterThan(1);
  });
  it('live mode never takes entrances, exits, backgrounds, structure or locks', () => {
    const op = (o: unknown) => AgentOpSchema.parse(o);
    expect(liveForbidden(op({ op: 'stage_set', sceneId: 's', castId: 'c', enter: null }))).toBe(true);
    expect(liveForbidden(op({ op: 'bg_set', sceneId: 's', at: 'start', assetId: 'x' }))).toBe(true);
    expect(liveForbidden(op({ op: 'lock_set', sceneId: 's', unit: 'beat', beatId: 'a' }))).toBe(true);
    expect(liveForbidden(op({ op: 'shot_set', sceneId: 's', beatId: 'a', set: { type: 'cu' } }))).toBe(false);
    expect(liveForbidden(op({ op: 'stage_set', sceneId: 's', castId: 'c', slot: 0.1 }))).toBe(false);
  });
});

describe('several beats in one call are independent', () => {
  it('a locked beat in a multi-beat timing or shot edit goes to the user; the other beats still change', () => {
    const p = lock(P, (s) => { s.beats[3]!.style.meta.locked = true; s.beats[5]!.shot.meta.locked = true; });
    const env = makeEnv(p);
    const ids = [beat(2).id, beat(3).id, beat(4).id];
    call(env, 'set_timing', { beatIds: ids, pace: 'slower', reason: 'r' });
    const s = sceneOf(env);
    expect(s.beats[2]!.style.overrides['rhythm.readingCps']).toBeDefined();
    expect(s.beats[4]!.style.overrides['rhythm.readingCps']).toBeDefined();
    expect(s.beats[3]!.style.overrides['rhythm.readingCps']).toBeUndefined();
    expect(env.pending.map((r) => (r.op as { beatIds: string[] }).beatIds)).toEqual([[beat(3).id]]);
    // the locked one first: the rest must not be dropped
    call(env, 'set_shot', { beatIds: [beat(5).id, beat(6).id], dof: 5, reason: 'r' });
    expect(env.pending.some((r) => r.op.op === 'shot_set' && (r.op as { beatId: string }).beatId === beat(5).id)).toBe(true);
    expect(env.applied.some((r) => r.op.op === 'shot_set' && (r.op as { beatId: string }).beatId === beat(6).id)).toBe(true);
  });
});

describe('motion / expression names the model writes', () => {
  it('a label or a name without its prefix resolves to the real name; anything else is an error, never a different expression', () => {
    const k = (channel: string, name: string) => checkOp(P, { op: 'key_set', sceneId: 's_3', target: { kind: 'actor', castId: 'c_001' }, channel, at: { beatId: beat(2).id, offset: 0 }, value: { name } } as AgentOp, ctx);
    const byLabel = k('expression', '微笑 3');
    expect(byLabel.status).toBe('ok');
    expect((byLabel.op as { value: { name: string } }).value.name).toBe('exp_smile03');
    expect((k('expression', 'smile03').op as { value: { name: string } }).value.name).toBe('exp_smile03');
    expect((k('motion', '挥手').op as { value: { name: string } }).value.name).toBe('bye01');
    const bad = k('expression', '大笑');
    expect(bad.status).toBe('invalid');
    expect(bad.problems[0]).toContain('exp_smile01');
  });
});
