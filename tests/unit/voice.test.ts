import { describe, expect, it } from 'vitest';
import { ProjectSchema, type Project } from '../../shared/schema/project';
import { exportEnvelope, parseImport } from '../../shared/project/exchange';
import { resolveStyle } from '../../shared/style/ournotes';
import { compileProject } from '../../shared/timeline/compile';
import { beatSeconds, sceneTimes } from '../../shared/timeline/time';
import { usableVoice } from '../../shared/voice/lines';
import { makeWav, wavSeconds } from '../../shared/voice/wav';
import demo from '../fixtures/demo-project.json';
import { MINI_CTX, miniProject } from './helpers/synthetic';

const st = resolveStyle(null).values;
const dur = (voice?: { file?: string; seconds?: number; src?: string }, text = '短') =>
  beatSeconds({ kind: 'dialogue', text, duration: { mode: 'auto', seconds: 0 }, ...(voice ? { voice: { src: text, ...voice } } : {}) }, st);

describe('wavSeconds', () => {
  it('reads the length of a normal header', () => {
    expect(wavSeconds(makeWav(new Int16Array(16000), 16000))).toBeCloseTo(1);
    expect(wavSeconds(makeWav(new Int16Array(24000 * 3), 24000))).toBeCloseTo(3);
  });
  it('uses the file size when a streaming header has a bogus data size', () => {
    expect(wavSeconds(makeWav(new Int16Array(8000), 16000, { bogusSize: true }))).toBeCloseTo(0.5);
    const zero = makeWav(new Int16Array(16000), 16000);
    new DataView(zero.buffer).setUint32(40, 0, true);
    expect(wavSeconds(zero)).toBeCloseTo(1);
  });
  it('skips extra chunks and rejects non-WAV bytes', () => {
    const base = makeWav(new Int16Array(16000), 16000);
    const list = new Uint8Array([...'LIST'].map((c) => c.charCodeAt(0)).concat([4, 0, 0, 0, 1, 2, 3, 4]));
    const withList = new Uint8Array([...base.slice(0, 36), ...list, ...base.slice(36)]);
    expect(wavSeconds(withList)).toBeCloseTo(1);
    expect(wavSeconds(new Uint8Array([1, 2, 3]))).toBeNull();
    expect(wavSeconds(new TextEncoder().encode('{"message":"error"} padding padding'))).toBeNull();
  });
});

describe('beatSeconds with a voice', () => {
  it('is unchanged without a voice and for a voice that is shorter than the text', () => {
    expect(dur()).toBeCloseTo(1.8);
    expect(dur({ file: 'a.wav', seconds: 0.4 })).toBeCloseTo(1.8);
    expect(dur({})).toBeCloseTo(1.8); // no file yet
  });
  it('lasts at least voice + tail + line gap', () => {
    const r = st.rhythm;
    expect(dur({ file: 'a.wav', seconds: 6 })).toBeCloseTo(6 + r.tail + r.lineGap);
  });
  it('ignores a recording made for other text, and never touches a fixed duration', () => {
    expect(dur({ file: 'a.wav', seconds: 6, src: '别的字' })).toBeCloseTo(1.8);
    expect(beatSeconds({ kind: 'dialogue', text: '短', duration: { mode: 'fixed', seconds: 2 }, voice: { src: '短', file: 'a.wav', seconds: 9 } }, st)).toBe(2);
    expect(usableVoice({ text: '短', voice: { src: '短', file: 'a.wav', seconds: 1 } })).toEqual({ file: 'a.wav', seconds: 1 });
  });
});

describe('compile with voice', () => {
  const voiced = (): Project => {
    const p = miniProject();
    const b = p.scenes[0]!.beats.find((x) => x.kind === 'dialogue' && x.speakerId)!;
    b.voice = { src: b.text, spoken: 'こんにちは', file: 'b-12345678.wav', seconds: 5 };
    return p;
  };
  it('emits a voice event at the beat start and lengthens the beat', () => {
    const plain = miniProject();
    const p = voiced();
    const c = compileProject(p, MINI_CTX);
    expect(c.voice).toHaveLength(1);
    const beat = p.scenes[0]!.beats.find((x) => x.voice)!;
    const t = sceneTimes(p)[0]!.beats.find((x) => x.beatId === beat.id)!;
    expect(c.voice![0]).toMatchObject({ beatId: beat.id, at: t.start, seconds: 5, speakerId: beat.speakerId });
    expect(c.voice![0]!.url).toBe(`/api/projects/${p.id}/voice/b-12345678.wav`);
    expect(c.duration).toBeGreaterThan(compileProject(plain, MINI_CTX).duration);
  });
  it('a project without voice compiles to an object with no voice key', () => {
    expect('voice' in compileProject(miniProject(), MINI_CTX)).toBe(false);
  });
});

describe('schema compatibility', () => {
  it('an old project parses identically and gains no voice keys', () => {
    const p = ProjectSchema.parse(demo);
    expect(JSON.stringify(p)).not.toContain('"voice"');
    expect(ProjectSchema.parse(JSON.parse(JSON.stringify(p)))).toEqual(p);
  });
  it('voice survives a parse and is optional', () => {
    const raw = JSON.parse(JSON.stringify(demo));
    raw.scenes[0].beats[0].voice = { src: '好', spoken: 'やあ', spokenEdited: true, file: 'x-00000000.wav', seconds: 1.5, hash: 'h', by: 'p' };
    const p = ProjectSchema.parse(raw);
    expect(p.scenes[0]!.beats[0]!.voice).toEqual({ src: '好', spoken: 'やあ', spokenEdited: true, file: 'x-00000000.wav', seconds: 1.5, hash: 'h', by: 'p' });
    raw.scenes[0].beats[0].voice = { spoken: 3 };
    expect(() => ProjectSchema.parse(raw)).toThrow();
  });
  it('export keeps the Japanese text but not the audio files; import still works', () => {
    const raw = JSON.parse(JSON.stringify(demo));
    raw.scenes[0].beats[0].voice = { src: '好', spoken: 'やあ', file: 'x-00000000.wav', seconds: 1.5, hash: 'h' };
    const env = exportEnvelope(ProjectSchema.parse(raw), 'v');
    const r = parseImport(JSON.stringify(env));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.project.scenes[0]!.beats[0]!.voice).toEqual({ src: '好', spoken: 'やあ' });
  });
});

