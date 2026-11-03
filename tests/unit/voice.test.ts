import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ProjectSchema, type Project } from '../../shared/schema/project';
import { VoiceSettingsSchema } from '../../shared/schema/voice';
import { exportEnvelope, parseImport } from '../../shared/project/exchange';
import { resolveStyle } from '../../shared/style/ournotes';
import { compileProject } from '../../shared/timeline/compile';
import { beatSeconds, sceneTimes } from '../../shared/timeline/time';
import { hasWords, profileOfBeat, spokenText, usableVoice } from '../../shared/voice/lines';
import { makeWav, wavSeconds } from '../../shared/voice/wav';
import { VOICE_FILE, voiceFileName, voiceHash } from '../../server/voice/service';
import { VoiceSettingsStore } from '../../server/voice/store';
import { cleanJa } from '../../server/voice/translate';
import demo from '../fixtures/demo-project.json';
import { MINI_CTX, miniProject } from './helpers/synthetic';

const st = resolveStyle(null).values;
const dur = (voice?: { ja?: string; file?: string; seconds?: number; src?: string }, text = '短') =>
  beatSeconds({ kind: 'dialogue', text, duration: { mode: 'auto', seconds: 0 }, ...(voice ? { voice: { ja: 'x', ...voice } } : {}) }, st);

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

describe('voice hash and file names', () => {
  const profile = { refAudioPath: 'a.wav', promptText: 'p', promptLang: 'ja', speed: 1 };
  it('changes with the text, the profile and the language, and nothing else', () => {
    const h = voiceHash('こんにちは', profile, 'ja');
    expect(voiceHash('こんにちは', { ...profile }, 'ja')).toBe(h);
    expect(voiceHash('こんばんは', profile, 'ja')).not.toBe(h);
    expect(voiceHash('こんにちは', { ...profile, speed: 1.1 }, 'ja')).not.toBe(h);
    expect(voiceHash('こんにちは', { ...profile, gptWeights: 'g.ckpt' }, 'ja')).not.toBe(h);
    expect(voiceHash('こんにちは', profile, 'en')).not.toBe(h);
  });
  it('file names are safe and recognised by the serving route', () => {
    const f = voiceFileName('s1:b/2', voiceHash('x', profile, 'ja'));
    expect(f).toMatch(VOICE_FILE);
    expect(VOICE_FILE.test('../project.json')).toBe(false);
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
    expect(beatSeconds({ kind: 'dialogue', text: '短', duration: { mode: 'fixed', seconds: 2 }, voice: { ja: 'x', file: 'a.wav', seconds: 9 } }, st)).toBe(2);
    expect(usableVoice({ text: '短', voice: { ja: 'x', file: 'a.wav', seconds: 1, src: '短' } })).toEqual({ file: 'a.wav', seconds: 1 });
  });
});

describe('compile with voice', () => {
  const voiced = (): Project => {
    const p = miniProject();
    const b = p.scenes[0]!.beats.find((x) => x.kind === 'dialogue' && x.speakerId)!;
    b.voice = { ja: 'こんにちは', file: 'b-12345678.wav', seconds: 5 };
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
    raw.scenes[0].beats[0].voice = { ja: 'やあ', jaEdited: true, file: 'x-00000000.wav', seconds: 1.5, hash: 'h' };
    const p = ProjectSchema.parse(raw);
    expect(p.scenes[0]!.beats[0]!.voice).toEqual({ ja: 'やあ', jaEdited: true, file: 'x-00000000.wav', seconds: 1.5, hash: 'h' });
    raw.scenes[0].beats[0].voice = { ja: 3 };
    expect(() => ProjectSchema.parse(raw)).toThrow();
  });
  it('export keeps the Japanese text but not the audio files; import still works', () => {
    const raw = JSON.parse(JSON.stringify(demo));
    raw.scenes[0].beats[0].voice = { ja: 'やあ', file: 'x-00000000.wav', seconds: 1.5, hash: 'h' };
    const env = exportEnvelope(ProjectSchema.parse(raw), 'v');
    const r = parseImport(JSON.stringify(env));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.project.scenes[0]!.beats[0]!.voice).toEqual({ ja: 'やあ' });
  });
});

describe('lines and translation checks', () => {
  const project = ProjectSchema.parse(demo);
  const beat = { kind: 'dialogue' as const, speakerId: 'c_001' };
  it('only spoken dialogue of a voiced character is voiced', () => {
    const profiles = { '001': { refAudioPath: 'r.wav', promptText: '', promptLang: 'ja', speed: 1 }, '002': { promptText: '', promptLang: 'ja', speed: 1 } };
    expect(profileOfBeat(project, beat, profiles)?.characterKey).toBe('001');
    expect(profileOfBeat(project, { kind: 'dialogue', speakerId: 'c_002' }, profiles)).toBeNull(); // no reference audio
    expect(profileOfBeat(project, { kind: 'narration', speakerId: 'c_001' }, profiles)).toBeNull();
    expect(profileOfBeat(project, { kind: 'dialogue' }, profiles)).toBeNull();
    expect(profileOfBeat(project, { kind: 'action', speakerId: 'c_001' }, profiles)).toBeNull();
  });
  it('spokenText removes brackets, stage directions and name plates', () => {
    expect(spokenText('（我不知道……）')).toBe('我不知道……');
    expect(spokenText('「早上好」')).toBe('早上好');
    expect(spokenText('灯：你好', ['灯'])).toBe('你好');
    expect(spokenText('你好（笑）再见')).toBe('你好再见');
    expect(hasWords('……')).toBe(false);
    expect(hasWords('啊……')).toBe(true);
  });
  it('cleanJa keeps Japanese and drops wrappers; a non-Japanese answer is refused', () => {
    expect(cleanJa('「おはよう」')).toBe('おはよう');
    expect(cleanJa('  ふふっ、 そうだね ')).toBe('ふふっ、 そうだね');
    expect(cleanJa('早上好')).toBeNull();
    expect(cleanJa('')).toBeNull();
  });
});

describe('VoiceSettingsStore', () => {
  const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'voice-')), 'voice.local.json');
  it('defaults to off and keeps profiles per character', () => {
    const store = new VoiceSettingsStore(tmp());
    expect(store.read()).toEqual(VoiceSettingsSchema.parse({}));
    expect(store.read().enabled).toBe(false);
    const s = store.patch({ enabled: true, endpoint: 'http://127.0.0.1:9999/', profiles: { '001': { refAudioPath: ' r.wav ', promptText: 'x', promptLang: '', speed: 1.1 } } });
    expect(s.endpoint).toBe('http://127.0.0.1:9999');
    expect(s.profiles['001']).toEqual({ refAudioPath: 'r.wav', promptText: 'x', promptLang: 'ja', speed: 1.1 });
    expect(store.patch({ profiles: { '001': null } }).profiles).toEqual({});
    expect(() => store.patch({ volume: 3 })).toThrow();
  });
});
