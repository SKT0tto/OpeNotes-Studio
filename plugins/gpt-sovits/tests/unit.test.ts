import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ProjectSchema } from '../../../shared/schema/project';
import { hasWords, profileOfBeat, spokenText } from '../src/lines';
import { VoiceSettingsSchema, effectiveProfile, weightsLeak } from '../src/schema';
import { VOICE_FILE, voiceFileName, voiceHash } from '../src/service';
import { VoiceSettingsStore } from '../src/store';
import { fixNames } from '../src/names';
import { cleanJa } from '../src/translate';
import { VOICE_JA_PROMPT_VERSION, VOICE_JA_SYSTEM } from '../src/prompt';
import demo from '../../../tests/fixtures/demo-project.json';

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
    expect(() => store.patch({ endpoint: 3 })).toThrow();
  });
});

describe('effective weights and the leak guard', () => {
  const base = { refAudioPath: 'r.wav', promptText: '', promptLang: 'ja', speed: 1 };
  const settings = (o: object = {}) => VoiceSettingsSchema.parse({ enabled: true, ...o });
  it('a blank profile weight falls back to the default; an explicit one wins', () => {
    const s = settings({ defaultGptWeights: 'dg.ckpt', defaultSovitsWeights: 'ds.pth' });
    expect(effectiveProfile(s, base)).toMatchObject({ gptWeights: 'dg.ckpt', sovitsWeights: 'ds.pth' });
    expect(effectiveProfile(s, { ...base, gptWeights: 'own.ckpt' })).toMatchObject({ gptWeights: 'own.ckpt', sovitsWeights: 'ds.pth' });
    expect(effectiveProfile(settings(), base).gptWeights).toBeUndefined();
  });
  it('blank weights leak only when another profile uses explicit ones', () => {
    const a = { ...base, gptWeights: 'a.ckpt', sovitsWeights: 'a.pth' };
    expect(weightsLeak(settings({ profiles: { x: base, y: base } }), base)).toEqual([]); // everyone shares the start-up model
    expect(weightsLeak(settings({ profiles: { a, x: base } }), base)).toEqual(['GPT', 'SoVITS']);
    expect(weightsLeak(settings({ profiles: { a, x: { ...base, gptWeights: 'x.ckpt' } } }), { ...base, gptWeights: 'x.ckpt' })).toEqual(['SoVITS']);
    expect(weightsLeak(settings({ defaultGptWeights: 'd.ckpt', defaultSovitsWeights: 'd.pth', profiles: { a, x: base } }), base)).toEqual([]);
  });
  it('the hash follows the default weights', () => {
    const h = (s: object) => voiceHash('こんにちは', effectiveProfile(settings(s), base), 'ja');
    expect(h({ defaultGptWeights: 'a.ckpt' })).not.toBe(h({}));
    expect(h({ defaultGptWeights: 'a.ckpt' })).not.toBe(h({ defaultGptWeights: 'b.ckpt' }));
    expect(h({ defaultGptWeights: 'a.ckpt' })).toBe(h({ defaultGptWeights: 'a.ckpt' }));
  });
  it('the store keeps and clears the defaults', () => {
    const store = new VoiceSettingsStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'voice-')), 'v.json'));
    expect(store.patch({ defaultGptWeights: ' g.ckpt ' }).defaultGptWeights).toBe('g.ckpt');
    expect(store.patch({ enabled: true }).defaultGptWeights).toBe('g.ckpt');
    expect(store.patch({ defaultGptWeights: '' }).defaultGptWeights).toBeUndefined();
  });
});

describe('fixNames', () => {
  it('writes a name used as a name in its Japanese spelling', () => {
    expect(fixNames('灯ちゃん、おはよう', ['001'])).toBe('燈ちゃん、おはよう');
    expect(fixNames('灯の', ['001'])).toBe('燈の');
    expect(fixNames('灯', ['001'])).toBe('燈');
    expect(fixNames('ねえ、灯。', ['001'])).toBe('ねえ、燈。');
    expect(fixNames('高松灯さん', ['001'])).toBe('高松燈さん');
    expect(fixNames('爱音って呼んで', ['002'])).toBe('愛音って呼んで');
    expect(fixNames('若叶さんと丰川祥子', ['007', '010'])).toBe('若葉さんと豊川祥子');
  });
  it('does not touch the character inside longer words', () => {
    for (const t of ['灯り', '電灯', '灯台', '街灯の下で', '灯火']) expect(fixNames(t, ['001'])).toBe(t);
  });
  it('only repairs variant spellings: other names and unknown keys stay', () => {
    expect(fixNames('爽世ちゃん', ['004'])).toBe('爽世ちゃん'); // そよ is a different spelling, not a kanji variant
    expect(fixNames('灯ちゃん', ['999'])).toBe('灯ちゃん');
    expect(fixNames('灯ちゃん', [])).toBe('灯ちゃん');
  });
  it('the prompt demands exact names and carries the new version', () => {
    expect(VOICE_JA_PROMPT_VERSION).toBe('voice-ja-4');
    expect(VOICE_JA_SYSTEM).toContain('characters[].ja');
  });
});
