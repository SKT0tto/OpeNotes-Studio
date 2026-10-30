import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { SCENE_TRAVEL_SECTION, SCENE_TRAVEL_VERSION, TRAVEL_EXAMPLE_BEATS, TRAVEL_EXAMPLE_PARAGRAPHS, scenePromptFor } from '../../server/llm/prompts/sceneDirection';
import { validateDirection } from '../../shared/director/validate';
import { SceneDirectionSchema, SceneDirectionTravelSchema, type SceneDirection } from '../../shared/schema/ai';
import { modelJsonSchema } from '../../server/llm/provider';
import { EMOTIONS } from '../../shared/director/vocab';
import { paragraphs, sceneCtx, skeleton } from './helpers/directorFlow';

const project = skeleton();
const scene = project.scenes[2]!;
const base = { ...sceneCtx(project, scene), cameraSystem: 'travel' as const };
const [A, B, C, D] = base.cast.map((c) => c.castId) as [string, string, string, string];
const P0 = base.range.start;

type Shot = Partial<SceneDirection['beats'][number]['shot']>;
interface BeatSpec { speaker?: string | null; text?: string; focus?: string[]; type?: string; intent?: string | null; flow?: string | null; reason?: string; para?: number; enter?: string[]; exit?: string[]; insertTarget?: string | null; kind?: 'dialogue' | 'narration' | 'silent'; shot?: Shot }

const actor = (castId: string, o: { enter?: boolean; exit?: boolean } = {}) => ({ castId, motion: null, expression: null, attention: null, enter: !!o.enter, exit: !!o.exit, move: null });
/** A dialogue beat by default; its text is the paragraph's own text, so it traces back to the source. */
function beat(o: BeatSpec = {}): SceneDirection['beats'][number] {
  const para = o.para ?? P0;
  const kind = o.kind ?? (o.speaker === null ? 'silent' : 'dialogue');
  const speaker = kind === 'dialogue' ? (o.speaker ?? A) : null;
  return {
    keepId: null, paragraph: para, kind, speaker, text: kind === 'silent' ? '' : o.text ?? paragraphs[para]!.text, emotion: EMOTIONS[0]!, reason: o.reason ?? 'r',
    shot: { type: (o.type ?? 'mcu') as never, focus: o.focus ?? (speaker ? [speaker] : [A]), move: 'static', dof: null, ...(o.insertTarget !== undefined ? { insertTarget: o.insertTarget as never } : {}), ...(o.intent !== undefined ? { intent: o.intent as never } : {}), ...(o.flow !== undefined ? { flow: o.flow as never } : {}), ...o.shot },
    cutIn: 'cut', fx: 'none',
    actors: [...(o.enter ?? []).map((c) => actor(c, { enter: true })), ...(o.exit ?? []).map((c) => actor(c, { exit: true }))],
  };
}
const direction = (...beats: SceneDirection['beats']): SceneDirection => SceneDirectionTravelSchema.parse({ reason: 'r', blocking: [], transitionIn: 'cut', bgm: null, costumeChanges: [], beats });
const run = (d: SceneDirection, over: Partial<Parameters<typeof validateDirection>[1]> = {}) => validateDirection(d, { ...base, ...over });

describe('travel two-shot pairs keep their meaning (change 2)', () => {
  it('keeps the model\'s pair when the partner is on stage, even when somebody stands between them', () => {
    // the seating order is A B C D; the pair A + C is not adjacent but both talk to each other
    const v = run(direction(beat({ speaker: A, focus: [A, C], type: 'two_shot' }), beat({ speaker: C, focus: [C, A], type: 'two_shot' })));
    expect(v.errors).toEqual([]);
    expect(v.value.beats.map((b) => b.shot.focus)).toEqual([[A, C], [C, A]]);
    expect(v.warnings.filter((w) => w.includes('双人'))).toEqual([]);
  });

  it('never pairs somebody who has not entered yet: the previous speaker takes his place', () => {
    const v = run(direction(
      beat({ speaker: B, focus: [B] }),
      beat({ speaker: A, focus: [A, D], type: 'two_shot' }),
      beat({ speaker: D, focus: [D], enter: [D] }),
    ));
    // D enters in beat 3, so the 2nd beat cannot show him; B (previous speaker, on stage) is the partner
    expect(v.value.beats[1]!.shot).toMatchObject({ type: 'two_shot', focus: [A, B] });
    expect(v.warnings.join('\n')).toContain('此刻不在台上');
  });

  it('does not pair somebody who has left; with no one to pair the shot becomes a medium shot of the speaker', () => {
    const v = run(direction(
      beat({ speaker: A, focus: [A], exit: [B, C, D] }),
      beat({ speaker: A, focus: [A, B], type: 'two_shot', para: P0 + 1 }),
    ));
    expect(v.value.beats[1]!.shot).toMatchObject({ type: 'ms', focus: [A] });
  });

  it('a locked / user beat (keepId) is never re-paired', () => {
    const b = beat({ speaker: A, focus: [A, D], type: 'two_shot' });
    b.keepId = 'keep1';
    const v = run(direction(b, beat({ speaker: D, focus: [D], enter: [D] })), { fixedBeatIds: new Set(['keep1']) });
    expect(v.value.beats[0]!.shot.focus).toEqual([A, D]);
  });

  it('classic two-shots are not judged by this rule', () => {
    const v = run(direction(beat({ speaker: A, focus: [A, D], type: 'two_shot' }), beat({ speaker: D, focus: [D], enter: [D] })), { cameraSystem: undefined });
    expect(v.value.beats[0]!.shot.focus).toEqual([A, D]);
  });
});


describe('a person insert is only for an instrument being played (change 3, v0.6.2)', () => {
  const para = P0;
  const liveId = `${base.cast[0]!.modelId.split('_')[0]}_live-mode_live_01`;
  const liveCast = base.cast.map((c, n) => (n === 0 ? { ...c, modelId: liveId } : c));
  const playing = (b: SceneDirection['beats'][number]) => ({ ...b, actors: [{ ...actor(A), motion: 'play01_01' }] });

  it('travel: a hands insert (even with a prop in the paragraph and the reason) becomes ms', () => {
    const v = run(direction(beat({ speaker: null, kind: 'silent', type: 'insert', insertTarget: 'hands', reason: '捡起石头，握紧手', para, focus: [A] })));
    expect(v.value.beats[0]!.shot.type).toBe('ms');
    expect(v.value.beats[0]!.shot.insertTarget).toBeNull();
    expect(v.warnings.join('\n')).toContain('只用于正在演奏的乐器特写');
  });

  it('travel: an instrument insert without a playing motion also becomes ms (live costume alone is not enough)', () => {
    const v = run(direction(beat({ speaker: null, kind: 'silent', type: 'insert', insertTarget: 'instrument', reason: '弹吉他', para, focus: [A] })), { cast: liveCast });
    expect(v.value.beats[0]!.shot.type).toBe('ms');
  });

  it('travel: playing in a live-mode costume keeps the insert and forces insertTarget=instrument', () => {
    const v = run(direction(playing(beat({ speaker: null, kind: 'silent', type: 'insert', insertTarget: 'face_lower', reason: '拨弦', para, focus: [A] }))), { cast: liveCast });
    expect(v.value.beats[0]!.shot.type).toBe('insert');
    expect(v.value.beats[0]!.shot.insertTarget).toBe('instrument');
  });

  it('travel: a play motion in a non-live costume is not playing', () => {
    const v = run(direction(playing(beat({ speaker: null, kind: 'silent', type: 'insert', insertTarget: 'instrument', reason: '拨弦', para, focus: [A] }))));
    expect(v.value.beats[0]!.shot.type).toBe('ms');
  });

  it('classic falls back to cu', () => {
    const v = run(direction(beat({ speaker: null, kind: 'silent', type: 'insert', insertTarget: 'hands', reason: '捡起石头', para, focus: [A] })), { cameraSystem: undefined });
    expect(v.value.beats[0]!.shot.type).toBe('cu');
  });
});

describe('intent labels follow the picture (change 4)', () => {
  const intents = (d: SceneDirection) => d.beats.map((b) => b.shot.intent);
  const P = (n: number) => P0 + n;

  it('emphasis on another person becomes exchange; emphasis on the same person stays', () => {
    const v = run(direction(
      beat({ speaker: A, focus: [A], intent: 'continue' }),
      beat({ speaker: B, focus: [B], type: 'cu', intent: 'emphasis', para: P(1), reason: '关键句' }),
      beat({ speaker: B, focus: [B], type: 'ecu', intent: 'emphasis', para: P(2) }),
    ));
    expect(intents(v.value)).toEqual(['continue', 'exchange', 'emphasis']);
    expect(v.value.beats[1]!.reason).toBe('关键句（意图已按画面改标：emphasis→exchange，换了人）');
    expect(v.warnings.join('\n')).toContain('已改为 exchange');
  });

  it('continue on another person becomes exchange', () => {
    const v = run(direction(beat({ speaker: A, focus: [A], intent: 'continue' }), beat({ speaker: B, focus: [B], intent: 'continue', para: P(1) })));
    expect(intents(v.value)).toEqual(['continue', 'exchange']);
  });

  it('reveal of somebody who was on screen before (and does not enter) is relabelled; a real entrance stays reveal', () => {
    const v = run(direction(
      beat({ speaker: A, focus: [A], intent: 'continue' }),
      beat({ speaker: B, focus: [B], intent: 'reveal', para: P(1) }),
      beat({ speaker: B, focus: [B], intent: 'reveal', para: P(2) }),
      beat({ speaker: D, focus: [D], intent: 'reveal', para: P(3), enter: [D] }),
    ));
    // B has not been on screen before beat 2 (only A was in focus): the first reveal is fine; the second one shows B again
    expect(intents(v.value)).toEqual(['continue', 'reveal', 'continue', 'reveal']);
  });

  it('a group shot shows everybody on stage: somebody shown afterwards who did not enter is not a reveal', () => {
    const v = run(direction(
      beat({ speaker: A, focus: [], type: 'group', intent: 'continue' }),
      beat({ speaker: C, focus: [C], intent: 'reveal', para: P(1) }),
    ));
    expect(intents(v.value)).toEqual(['continue', 'exchange']);
  });

  it('the hidden person who enters later is still revealed (not on stage in the opening group)', () => {
    const v = run(direction(
      beat({ speaker: A, focus: [], type: 'group', intent: 'continue' }),
      beat({ speaker: A, focus: [A], intent: 'continue', para: P(1), enter: [D] }),
      beat({ speaker: D, focus: [D], intent: 'reveal', para: P(2) }),
    ));
    // D was not on stage during the opening group, so the first close-up of D is a real reveal
    expect(intents(v.value)).toEqual(['continue', 'continue', 'reveal']);
  });

  it('release that moves closer is emphasis (same person) or exchange (another person)', () => {
    const v = run(direction(
      beat({ speaker: A, focus: [A], type: 'mcu', intent: 'continue' }),
      beat({ speaker: A, focus: [A], type: 'cu', intent: 'release', para: P(1) }),
      beat({ speaker: B, focus: [B], type: 'ecu', intent: 'release', para: P(2) }),
      beat({ speaker: B, focus: [B], type: 'ms', intent: 'release', para: P(3) }),
    ));
    expect(intents(v.value)).toEqual(['continue', 'emphasis', 'exchange', 'release']);
  });

  it('a locked beat keeps its label; classic is untouched', () => {
    const locked = beat({ speaker: B, focus: [B], intent: 'emphasis', para: P(1) });
    locked.keepId = 'k1';
    const v = run(direction(beat({ speaker: A, focus: [A], intent: 'continue' }), locked), { fixedBeatIds: new Set(['k1']) });
    expect(intents(v.value)).toEqual(['continue', 'emphasis']);
    const classic = run(direction(beat({ speaker: A, focus: [A], intent: 'continue' }), beat({ speaker: B, focus: [B], intent: 'emphasis', para: P(1) })), { cameraSystem: undefined });
    expect(intents(classic.value)).toEqual([undefined, undefined]);
  });
});

describe('shot.flow is tolerant (change 7)', () => {
  const raw = (flow: unknown) => ({
    reason: 'r', blocking: [], transitionIn: 'cut', bgm: null, costumeChanges: [],
    beats: [{ keepId: null, paragraph: 0, kind: 'silent', speaker: null, text: '', emotion: EMOTIONS[0], reason: 'r', shot: { type: 'ms', focus: [], move: 'static', dof: null, flow }, cutIn: 'cut', fx: 'none', actors: [] }],
  });
  it('an intent word in flow becomes auto instead of a schema failure; real flows are kept', () => {
    expect(SceneDirectionTravelSchema.parse(raw('continue')).beats[0]!.shot.flow).toBe('auto');
    expect(SceneDirectionTravelSchema.parse(raw('reaction')).beats[0]!.shot.flow).toBe('auto');
    expect(SceneDirectionTravelSchema.parse(raw('cut')).beats[0]!.shot.flow).toBe('cut');
    expect(SceneDirectionTravelSchema.parse(raw('move')).beats[0]!.shot.flow).toBe('move');
    expect(SceneDirectionTravelSchema.parse(raw(null)).beats[0]!.shot.flow).toBeNull();
    const missing = raw('cut');
    delete (missing.beats[0]!.shot as { flow?: unknown }).flow;
    expect(SceneDirectionTravelSchema.parse(missing).beats[0]!.shot.flow).toBeUndefined();
  });
  it('the classic schema is unchanged: an unknown flow is simply not part of it', () => {
    expect(JSON.stringify(modelJsonSchema(SceneDirectionSchema))).not.toContain('flow');
  });
  it('the schema the model sees still lists the flow words', () => {
    const json = JSON.stringify(modelJsonSchema(SceneDirectionTravelSchema));
    expect(json).toContain('"flow"');
    expect(json).toContain('"auto","cut","move"');
  });
});

describe('the travel prompt explains why (change 5); the classic prompt is byte-identical', () => {
  // scene-4 (v0.4 effects) changed only the fx and cutIn lines of scene-3 (promptScene4.test.ts diffs them line by line); this hash pins the new text
  it('classic: text, schema, schema name and version are exactly what scene-7 is (scene-6 plus the long-line rule)', () => {
    const c = scenePromptFor('classic');
    expect(createHash('sha256').update(c.system).digest('hex')).toBe('84ac468b47a6ffdf92a7b0ce9f0458b1974a8121cbb59ceceb20e3672728df0d');
    expect(c.promptVersion).toBe('scene-7');
    expect(c.schemaName).toBe('SceneDirection');
    expect(c.schema).toBe(SceneDirectionSchema);
  });
  it('travel: version scene-7+travel-9; every intent has a question with a right and a wrong example', () => {
    expect(SCENE_TRAVEL_VERSION).toBe('scene-7+travel-9');
    for (const i of ['continue', 'exchange', 'emphasis', 'reaction', 'reveal', 'release', 'rupture']) expect(SCENE_TRAVEL_SECTION).toContain(`- ${i}：`);
    for (const i of ['continue', 'exchange', 'emphasis', 'reaction', 'reveal', 'release']) {
      const line = SCENE_TRAVEL_SECTION.split('\n').find((l) => l.startsWith(`- ${i}：`))!;
      expect(line).toContain('✓');
      expect(line).toContain('✗');
    }
  });
  it('travel: speaker inference, hidden people, object inserts, the pair of the conversation; no more "adjacent" requirement', () => {
    expect(SCENE_TRAVEL_SECTION).toContain('没有署名的连续对白');
    expect(SCENE_TRAVEL_SECTION).toContain('enter=true');
    expect(SCENE_TRAVEL_SECTION).toContain('reason 里写出物件名');
    expect(SCENE_TRAVEL_SECTION).toContain('此刻正在对话的两个人');
    expect(SCENE_TRAVEL_SECTION).not.toContain('舞台上相邻的两位');
    expect(SCENE_TRAVEL_SECTION).toContain('不要按比例配额');
  });
});

describe('the few-shot example in the travel prompt (change 6)', () => {
  it('is shown in the prompt and is a valid, self-consistent answer', () => {
    expect(SCENE_TRAVEL_SECTION).toContain('示范');
    expect(SCENE_TRAVEL_SECTION).not.toContain('"insertTarget":"hands"');
    expect(SCENE_TRAVEL_SECTION).toContain('"enter":true');
    expect(SCENE_TRAVEL_SECTION).toContain('"intent":"release"');
    expect(SCENE_TRAVEL_SECTION.length - SCENE_TRAVEL_SECTION.indexOf('## 示范')).toBeLessThan(2400);
    const beats = TRAVEL_EXAMPLE_BEATS.map((b) => ({
      keepId: null, emotion: EMOTIONS[0]!, cutIn: 'cut', fx: 'none', ...b, actors: ((b as { actors?: Array<{ castId: string; enter: boolean }> }).actors ?? []).map((a) => ({ motion: null, expression: null, attention: null, exit: false, move: null, ...a })),
      shot: { move: 'static', dof: null, ...b.shot },
    }));
    const d = SceneDirectionTravelSchema.parse({ reason: 'r', blocking: [], transitionIn: 'cut', bgm: null, costumeChanges: [], beats });
    expect(d.beats.length).toBe(TRAVEL_EXAMPLE_BEATS.length);
    // validated against a 3-person cast and the example paragraphs: nothing is re-paired or relabelled, and the insert keeps its object
    const ids = ['cA', 'cB', 'cC'];
    const v = validateDirection(d, { ...base, cameraSystem: 'travel', cast: ids.map((castId, n) => ({ ...base.cast[n]!, castId })), paragraphs: TRAVEL_EXAMPLE_PARAGRAPHS.map((text, index) => ({ index, text, start: 0, end: 0 })), range: { start: 0, end: TRAVEL_EXAMPLE_PARAGRAPHS.length - 1 } });
    expect(v.errors).toEqual([]);
    expect(v.warnings.filter((w) => /意图|不在台上|插入镜头|双人/.test(w))).toEqual([]);
    expect(v.value.beats.map((b) => b.shot.type)).toEqual(TRAVEL_EXAMPLE_BEATS.map((b) => b.shot.type));
  });
});
