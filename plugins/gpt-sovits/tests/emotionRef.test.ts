import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ProjectSchema, type Project } from '../../../shared/schema/project';
import type { PluginServerContext } from '../../../shared/plugins/api';
import { VoiceFiles } from '../../../server/plugins/voiceFiles';
import { refChanged, refSignature, resolveRef } from '../src/lines';
import type { RefCandidate } from '../src/match/match';
import { suggestEmotionPicks, suggestEmotionRefs } from '../src/match/emotionFill';
import { configuredRef } from '../src/match/routes';
import { VoiceSettingsSchema, type VoiceProfile } from '../src/schema';
import { VoiceService, voiceHash } from '../src/service';
import { VoiceSettingsStore } from '../src/store';
import demo from '../../../tests/fixtures/demo-project.json';
import { startFakeSovits, type FakeSovits } from './helpers/fakeSovits';

const main = { refAudioPath: 'main.wav', promptText: 'ふつう', promptLang: 'ja', speed: 1, emotionRefs: { happy: { path: 'happy.wav', text: 'わーい', lang: 'ja' } } } satisfies VoiceProfile;
const prof = main as VoiceProfile & { refAudioPath: string };

describe('resolveRef', () => {
  it('uses the main reference when nothing is configured for the emotion', () => {
    expect(resolveRef(prof, { emotion: 'sad' })).toMatchObject({ source: 'default', main: true, ref: { path: 'main.wav' } });
    expect(resolveRef(prof, {}).main).toBe(true);
  });
  it('line pin > emotion clip > main', () => {
    expect(resolveRef(prof, { emotion: 'happy' })).toMatchObject({ source: 'emotion', emotion: 'happy', main: false, ref: { path: 'happy.wav' } });
    expect(resolveRef(prof, { emotion: 'happy', voice: { src: 'x', ref: 'default' } })).toMatchObject({ source: 'pinned-default', main: true });
    expect(resolveRef(prof, { emotion: 'sad', voice: { src: 'x', ref: 'happy' } })).toMatchObject({ source: 'pinned-emotion', ref: { path: 'happy.wav' } });
    expect(resolveRef(prof, { emotion: 'happy', voice: { src: 'x', ref: { path: 'c.wav', text: 't', lang: 'ja' } } })).toMatchObject({ source: 'pinned-custom', ref: { path: 'c.wav', text: 't' }, main: false });
    expect(resolveRef(prof, { emotion: 'happy', voice: { src: 'x', ref: 'auto' } }).source).toBe('emotion');
  });
  it('a pinned emotion without a clip falls back to the main reference', () => {
    expect(resolveRef(prof, { voice: { src: 'x', ref: 'angry' } })).toMatchObject({ source: 'pinned-default', main: true });
  });
  it('a clip equal to the main reference counts as main', () => {
    const p = { ...prof, emotionRefs: { happy: { path: 'main.wav', text: 'ふつう', lang: 'ja' } } };
    expect(resolveRef(p, { emotion: 'happy' }).main).toBe(true);
  });
  it('signature is empty for main and drives the staleness check', () => {
    const happy = resolveRef(prof, { emotion: 'happy' });
    const plain = resolveRef(prof, { emotion: 'sad' });
    expect(refSignature(plain)).toBe('');
    expect(refSignature(happy)).toContain('happy.wav');
    expect(refChanged({ src: 'x', file: 'a.wav' }, plain)).toBe(false); // an old recording (main) of a main line
    expect(refChanged({ src: 'x', file: 'a.wav' }, happy)).toBe(true);
    expect(refChanged({ src: 'x', file: 'a.wav', refUsed: refSignature(happy) }, happy)).toBe(false);
    expect(refChanged({ src: 'x', file: 'a.wav', refUsed: refSignature(happy) }, plain)).toBe(true);
    expect(refChanged({ src: 'x' }, happy)).toBe(false); // nothing recorded yet
  });
});

describe('voiceHash with references', () => {
  const base = { refAudioPath: 'a.wav', promptText: 'p', promptLang: 'ja', speed: 1 };
  it('the main reference hashes exactly as before (golden)', () => {
    expect(voiceHash('こんにちは', base, 'ja')).toBe('6e0f57801520deaaf7956076bd32dc719db63688932f632516524ae30a7bdea7');
  });
  it('changes with the reference path, text or language; the table itself is not hashed', () => {
    const h = voiceHash('x', base, 'ja');
    expect(voiceHash('x', { ...base, refAudioPath: 'b.wav' }, 'ja')).not.toBe(h);
    expect(voiceHash('x', { ...base, promptText: 'q' }, 'ja')).not.toBe(h);
    expect(voiceHash('x', { ...base, promptLang: 'en' }, 'ja')).not.toBe(h);
    expect(voiceHash('x', { ...base, emotionRefs: { happy: { path: 'h.wav', text: '', lang: 'ja' } } }, 'ja')).toBe(h);
  });
});

const cand = (o: Partial<RefCandidate> & { path: string }): RefCandidate => ({ text: 'テキスト', lang: 'ja', seconds: 5, tag: '', calm: false, textFrom: 'filename', folder: 'f', ...o });
describe('suggestEmotionRefs', () => {
  it('maps tags to emotions, 3-10 s only, preferring plain delivery', () => {
    const out = suggestEmotionRefs([
      cand({ path: 'a.wav', tag: '叙述', calm: true }),
      cand({ path: 'b.wav', tag: '兴奋', seconds: 8 }),
      cand({ path: 'c.wav', tag: '唐笑', seconds: 4.5 }),
      cand({ path: 'd.wav', tag: '发牢骚' }),
      cand({ path: 'e.wav', tag: '吐槽与调侃' }),
      cand({ path: 'long.wav', tag: '开心', seconds: 14 }),
      cand({ path: 'cry.wav', tag: '哭腔' }),
      cand({ path: 'f.wav', tag: '疑问' }),
      cand({ path: 'g.wav', tag: '劝导' }),
    ]);
    expect(out.neutral?.path).toBe('a.wav');
    expect(out.happy?.path).toBe('c.wav'); // closest to 5 s; never the 14 s one
    expect(out.angry?.path).toBe('d.wav');
    expect(out.sad?.path).toBe('cry.wav'); // the only fit, so used
    expect(out.thinking?.path).toBe('f.wav');
    expect(out.serious?.path).toBe('g.wav');
    expect(out.surprised).toBeUndefined();
    expect(out.neutral).toEqual({ path: 'a.wav', text: 'テキスト', lang: 'ja' });
  });
  it('ignores untagged clips and clips of unknown length', () => {
    const out = suggestEmotionRefs([cand({ path: 'a.wav', tag: '吐槽' }), cand({ path: 'b.wav', tag: '' }), cand({ path: 'x.wav', tag: '劝导', seconds: null })]);
    expect(Object.keys(out)).toEqual(['angry']);
  });
});

describe('suggestEmotionPicks with real-looking tag lists', () => {
  const tomori = [
    cand({ path: 'n.wav', tag: '叙述', calm: true, seconds: 5 }),
    cand({ path: 'praise.wav', tag: '赞叹', seconds: 4.8 }),
    cand({ path: 'happy.wav', tag: '开心', seconds: 4.1, text: 'ありがとう、立希ちゃん' }),
    cand({ path: 'tears.wav', tag: '真情吐露', seconds: 4.4, text: 'みんなバラバラになって辛くて辛くて' }),
    cand({ path: 'panic.wav', tag: '惊慌失措', seconds: 3.5 }),
    cand({ path: 'sad.wav', tag: '悲伤', seconds: 5 }),
    cand({ path: 'think.wav', tag: '内心独白', seconds: 5 }),
    cand({ path: 'shy.wav', tag: '吐露', seconds: 5 }),
    cand({ path: 'shaky.wav', tag: '颤颤巍巍地吐露', seconds: 5 }),
    cand({ path: 'adv.wav', tag: '劝导', seconds: 5 }),
  ];
  it('a tag equal to the emotion label wins over a synonym', () => {
    expect(suggestEmotionPicks(tomori).happy).toMatchObject({ path: 'happy.wav', weak: false });
  });
  it('an extreme delivery is never used for serious, neutral or thinking', () => {
    const out = suggestEmotionPicks(tomori);
    expect(out.serious?.path).toBe('adv.wav');
    expect(Object.values(out).filter((p) => ['tears.wav', 'panic.wav'].includes(p.path))).toHaveLength(1); // only for its own emotion
    const only = suggestEmotionPicks([cand({ path: 'tears.wav', tag: '真情吐露' }), cand({ path: 'panic.wav', tag: '惊慌失措' }), cand({ path: 's.wav', tag: '悲伤，叙述' })]);
    expect(only.serious).toBeUndefined();
    expect(only.neutral).toBeUndefined();
    expect(only.thinking).toBeUndefined();
    expect(only.shy).toBeUndefined();
  });
  it('an extreme clip is a weak fit only for the emotion it matches', () => {
    const only = suggestEmotionPicks([cand({ path: 'panic.wav', tag: '惊慌失措' })]);
    expect(only.surprised).toMatchObject({ path: 'panic.wav', weak: true });
    expect(suggestEmotionPicks([cand({ path: 'panic.wav', tag: '惊慌失措' }), cand({ path: 'u.wav', tag: '惊讶' })]).surprised).toMatchObject({ path: 'u.wav', weak: false });
    expect(suggestEmotionPicks(tomori).shy).toMatchObject({ path: 'shy.wav', weak: false });
  });
});

describe('store cleaning and the route allow-list', () => {
  const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'voice-emo-')), 'v.json');
  it('keeps known emotions with a path, cleans quotes, drops the rest; old profiles are unchanged', () => {
    const store = new VoiceSettingsStore(tmp());
    const s = store.patch({
      profiles: {
        '001': { refAudioPath: 'm.wav', promptText: '', promptLang: 'ja', speed: 1, emotionRefs: { happy: { path: ' "D:\\r\\h.wav" ', text: ' わ ', lang: '' }, bogus: { path: 'x.wav', text: '', lang: 'ja' }, sad: { path: '  ', text: 't', lang: 'ja' } } },
        '002': { refAudioPath: 'n.wav', promptText: '', promptLang: 'ja', speed: 1 },
      },
    });
    expect(s.profiles['001']!.emotionRefs).toEqual({ happy: { path: 'D:\\r\\h.wav', text: 'わ', lang: 'ja' } });
    expect('emotionRefs' in s.profiles['002']!).toBe(false);
    expect(store.patch({ profiles: { '001': { refAudioPath: 'm.wav', promptText: '', promptLang: 'ja', speed: 1, emotionRefs: {} } } }).profiles['001']!.emotionRefs).toBeUndefined();
  });
  it('only saved clips are playable outside a scan', () => {
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'voice-emo-')), 'h.wav');
    fs.writeFileSync(f, 'x');
    const s = VoiceSettingsSchema.parse({ profiles: { '001': { refAudioPath: 'm.wav', emotionRefs: { happy: { path: f } } } } });
    expect(configuredRef(f, s)).toBeTruthy();
    expect(configuredRef(path.join(path.dirname(f), 'other.wav'), s)).toBeNull();
  });
});

describe('synthesis uses the resolved reference per line', () => {
  let sovits: FakeSovits;
  beforeAll(async () => { sovits = await startFakeSovits(); });
  afterAll(async () => { await sovits.close(); });
  const llm: PluginServerContext['llm'] = {
    available: () => ({ ok: true }),
    callJson: (async (req: { schema: { parse(x: unknown): unknown }; user: unknown }) => ({
      data: req.schema.parse({ lines: (req.user as { lines: Array<{ id: string; text: string; translate: boolean }> }).lines.filter((l) => l.translate).map((l) => ({ id: l.id, ja: `これは${l.text}です` })) }),
      cached: false,
    })) as PluginServerContext['llm']['callJson'],
  };

  it('emotion clip, pin and main reference; main-line hash equals the old formula; a changed pin regenerates only that line', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-emo-svc-'));
    const store = new VoiceSettingsStore(path.join(dir, 'v.json'));
    const p: Project = ProjectSchema.parse({ ...JSON.parse(JSON.stringify(demo)), id: 'voice_emo' });
    const scene = p.scenes[0]!;
    const key = '001';
    const beats = scene.beats.filter((b) => b.kind === 'dialogue' && p.cast.find((c) => c.id === b.speakerId)?.characterKey === key).slice(0, 3);
    expect(beats.length).toBe(3);
    beats[0]!.emotion = 'happy'; // emotion clip
    beats[1]!.emotion = 'happy';
    beats[1]!.voice = { src: beats[1]!.text, ref: 'default' }; // pinned to the main reference
    beats[2]!.emotion = 'sad'; // no clip for sad: main
    store.patch({ enabled: true, endpoint: sovits.url, profiles: { [key]: { refAudioPath: 'main.wav', promptText: 'ふつう', promptLang: 'ja', speed: 1, emotionRefs: { happy: { path: 'happy.wav', text: 'わーい', lang: 'en' } } } } });
    const service = new VoiceService({ settings: store, voice: new VoiceFiles(path.join(dir, 'projects')), llm });
    const run = async () => {
      sovits.calls.length = 0;
      const id = service.start(p, { kind: 'scene', sceneId: scene.id }, {});
      for (let i = 0; i < 400; i++) {
        const v = service.view(id)!;
        if (v.state !== 'running') return v;
        await new Promise((r) => setTimeout(r, 10));
      }
      throw new Error('timeout');
    };
    const v = await run();
    expect(v.errors).toEqual([]);
    const bodyOf = (id: string) => {
      const text = scene.beats.find((x) => x.id === id)!.text;
      return sovits.calls.filter((c) => c.path === '/tts').map((c) => c.body as { text: string; ref_audio_path: string; prompt_text: string; prompt_lang: string }).find((b) => b.text.includes(text));
    };
    expect(bodyOf(beats[0]!.id)).toMatchObject({ ref_audio_path: 'happy.wav', prompt_text: 'わーい', prompt_lang: 'en' });
    expect(bodyOf(beats[1]!.id)).toMatchObject({ ref_audio_path: 'main.wav', prompt_text: 'ふつう' });
    expect(bodyOf(beats[2]!.id)).toMatchObject({ ref_audio_path: 'main.wav' });
    const r = (id: string) => v.results.find((x) => x.beatId === id)!.voice;
    const mainProfile = { refAudioPath: 'main.wav', promptText: 'ふつう', promptLang: 'ja', speed: 1 };
    expect(r(beats[1]!.id).hash).toBe(voiceHash(r(beats[1]!.id).spoken, mainProfile, 'ja'));
    expect(r(beats[2]!.id).hash).toBe(voiceHash(r(beats[2]!.id).spoken, mainProfile, 'ja'));
    expect(r(beats[0]!.id).hash).not.toBe(voiceHash(r(beats[0]!.id).spoken, mainProfile, 'ja'));
    expect(r(beats[0]!.id).refUsed).toContain('happy.wav');
    expect(r(beats[1]!.id).refUsed).toBeUndefined();
    expect(r(beats[1]!.id).ref).toBe('default'); // the pin survives a regeneration
    // apply, then repin one line: only it is made again
    for (const b of beats) b.voice = r(b.id);
    await run();
    expect(sovits.calls.filter((c) => c.path === '/tts')).toHaveLength(0);
    beats[2]!.voice = { ...beats[2]!.voice!, ref: 'happy' };
    const again = await run();
    expect(sovits.calls.filter((c) => c.path === '/tts')).toHaveLength(1);
    expect(again.results.find((x) => x.beatId === beats[2]!.id)!.voice.refUsed).toContain('happy.wav');
  });
});
