import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { ProjectSchema, type Project } from '../../../shared/schema/project';
import type { JsonCallRequest, PluginServerContext } from '../../../shared/plugins/api';
import { wavSeconds } from '../../../shared/voice/wav';
import { usableVoice } from '../../../shared/voice/lines';
import { VoiceFiles, voiceFileRoutes } from '../../../server/plugins/voiceFiles';
import type { VoiceJobView, VoiceScope } from '../src/schema';
import { voiceRoutes } from '../src/routes';
import { estimateMorae } from '../src/check';
import { VoiceService, voiceHash } from '../src/service';
import { VoiceSettingsStore } from '../src/store';
import { translateLines } from '../src/translate';
import demo from '../../../tests/fixtures/demo-project.json';
import { startFakeSovits, type FakeSovits } from './helpers/fakeSovits';

/** A scripted stand-in for the studio's model call: answers every translate=true line with Japanese made from its text. */
class StubLlm {
  calls = 0;
  lastUser: unknown = null;
  lastRefresh: boolean | undefined = undefined;
  /** ids to leave out of the answer, once. */
  skip = new Set<string>();
  /** answer with this instead (until reset to null). */
  override: unknown = null;
  available: PluginServerContext['llm']['available'] = () => ({ ok: true });
  callJson = async <T,>(req: JsonCallRequest<T>) => {
    this.calls++;
    this.lastUser = req.user;
    this.lastRefresh = req.refresh;
    const input = req.user as { lines: Array<{ id: string; text: string; translate: boolean }> };
    const lines = input.lines.filter((l) => l.translate && !this.skip.has(l.id)).map((l) => ({ id: l.id, ja: `これは${l.text}です` }));
    this.skip.clear();
    const raw = this.override ?? { lines };
    return { data: req.schema.parse(raw), cached: false };
  };
  api(): PluginServerContext['llm'] {
    return { available: () => this.available(), callJson: this.callJson };
  }
}

let sovits: FakeSovits;
let dir: string;
let store: VoiceSettingsStore;
let llm: StubLlm;
let service: VoiceService;
let files: VoiceFiles;
const project = (): Project => ProjectSchema.parse({ ...JSON.parse(JSON.stringify(demo)), id: 'voice_test' });

async function run(p: Project, scope: VoiceScope, opts: { retranslate?: boolean; force?: boolean; regenerate?: boolean; overwriteEdited?: boolean } = {}): Promise<VoiceJobView> {
  const id = service.start(p, scope, opts);
  for (let i = 0; i < 400; i++) {
    const v = service.view(id)!;
    if (v.state !== 'running') return v;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('job did not finish');
}
const wavs = () => (fs.existsSync(path.join(dir, 'projects', 'voice_test', 'voice')) ? fs.readdirSync(path.join(dir, 'projects', 'voice_test', 'voice')).filter((f) => f.endsWith('.wav')).sort() : []);
const ttsCalls = () => sovits.calls.filter((c) => c.path === '/tts');
const profile = (n: string) => ({ gptWeights: `g_${n}.ckpt`, sovitsWeights: `s_${n}.pth`, refAudioPath: `ref_${n}.wav`, promptText: 'こんにちは', promptLang: 'ja', speed: 1 });

beforeAll(async () => {
  sovits = await startFakeSovits();
});
afterAll(async () => {
  await sovits.close();
});
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-svc-'));
  store = new VoiceSettingsStore(path.join(dir, 'voice.local.json'));
  store.patch({ enabled: true, endpoint: sovits.url, profiles: { '001': profile('a'), '002': profile('b') } });
  llm = new StubLlm();
  files = new VoiceFiles(path.join(dir, 'projects'));
  service = new VoiceService({ settings: store, voice: files, llm: llm.api() });
  sovits.calls.length = 0;
  sovits.failText.clear();
  sovits.bogusHeader = false;
  sovits.delayMs = 0;
  sovits.cutNext = [];
});

describe('voice job against a fake GPT-SoVITS', () => {
  it('translates, sets weights once per character, synthesises and measures the files', async () => {
    const p = project();
    const scene = p.scenes[0]!;
    const v = await run(p, { kind: 'scene', sceneId: scene.id });
    expect(v.state).toBe('done');
    const spoken = scene.beats.filter((b) => b.kind === 'dialogue' && b.speakerId && p.cast.find((c) => c.id === b.speakerId)!.characterKey !== '003');
    expect(v.total).toBe(spoken.length);
    expect(v.errors).toEqual([]);
    expect(v.results).toHaveLength(spoken.length);
    for (const r of v.results) {
      expect(r.voice.spoken).toMatch(/^これは/);
      expect(r.voice.src).toBe(scene.beats.find((b) => b.id === r.beatId)!.text);
      const file = path.join(dir, 'projects', 'voice_test', 'voice', r.voice.file!);
      expect(wavSeconds(fs.readFileSync(file))).toBeCloseTo(r.voice.seconds!, 2);
      expect(r.voice.seconds).toBeCloseTo(0.2 * estimateMorae(r.voice.spoken), 1);
      expect(r.voice.hash).toBe(voiceHash(r.voice.spoken, { ...profile(p.cast.find((c) => c.id === scene.beats.find((b) => b.id === r.beatId)!.speakerId)!.characterKey === '001' ? 'a' : 'b') }, 'ja'));
    }
    // weights: once per character
    const weightCalls = sovits.calls.filter((c) => c.path.startsWith('/set_'));
    expect(weightCalls.filter((c) => c.path === '/set_gpt_weights')).toHaveLength(2);
    expect(weightCalls.filter((c) => c.path === '/set_sovits_weights')).toHaveLength(2);
    expect(ttsCalls()).toHaveLength(spoken.length);
    expect(ttsCalls()[0]!.body).toMatchObject({ text_lang: 'ja', prompt_lang: 'ja', media_type: 'wav', streaming_mode: false });
    expect(llm.calls).toBe(1);
    expect(wavs()).toHaveLength(spoken.length);
  });

  it('does not voice narration, actions or characters without a reference audio', async () => {
    const p = project();
    store.patch({ profiles: { '002': null } });
    const v = await run(p, { kind: 'project' });
    const ids = new Set(v.results.map((r) => r.beatId));
    for (const s of p.scenes) for (const b of s.beats) {
      const key = p.cast.find((c) => c.id === b.speakerId)?.characterKey;
      if (b.kind !== 'dialogue' || key !== '001') expect(ids.has(b.id)).toBe(false);
    }
    expect(v.results.length).toBeGreaterThan(0);
  });

  it('skips lines whose hash already has a file, and deletes stale files of a changed line', async () => {
    const p = project();
    const sc: VoiceScope = { kind: 'scene', sceneId: p.scenes[0]!.id };
    const first = await run(p, sc);
    const n = ttsCalls().length;
    // apply the results the way the editor does
    for (const r of first.results) p.scenes[0]!.beats.find((b) => b.id === r.beatId)!.voice = r.voice;
    sovits.calls.length = 0;
    llm.calls = 0;
    const again = await run(p, sc);
    expect(again.state).toBe('done');
    expect(ttsCalls()).toHaveLength(0);
    expect(llm.calls).toBe(0);
    expect(again.results.map((r) => r.voice.file).sort()).toEqual(first.results.map((r) => r.voice.file).sort());
    // a person edits one Japanese line: only it is synthesised again
    const target = first.results[0]!;
    const beat = p.scenes[0]!.beats.find((b) => b.id === target.beatId)!;
    beat.voice = { src: beat.text, spoken: 'ちょっと違う言い方です', spokenEdited: true };
    sovits.calls.length = 0;
    const third = await run(p, sc);
    expect(ttsCalls()).toHaveLength(1);
    expect(third.results.find((r) => r.beatId === target.beatId)!.voice).toMatchObject({ spoken: 'ちょっと違う言い方です', spokenEdited: true });
    expect(wavs()).toHaveLength(n + 1); // the old file stays as an older version (undo may point to it)
    expect(wavs()).toContain(target.voice.file);
    // force re-synthesises everything
    sovits.calls.length = 0;
    await run(p, sc, { force: true });
    expect(ttsCalls()).toHaveLength(n);
  });

  it('handles a streaming header with a bogus data size', async () => {
    sovits.bogusHeader = true;
    const p = project();
    const v = await run(p, { kind: 'beat', sceneId: 's1', beatId: 's1b1' });
    expect(v.state).toBe('done');
    const r = v.results[0]!;
    expect(r.voice.seconds).toBeCloseTo(0.2 * estimateMorae(r.voice.spoken), 1);
  });

  it('reports a rejected line and carries on with the rest', async () => {
    const p = project();
    const first = await run(p, { kind: 'scene', sceneId: 's1' });
    const bad = first.results[1]!;
    for (const f of wavs()) fs.rmSync(path.join(dir, 'projects', 'voice_test', 'voice', f));
    sovits.failText.add(bad.voice.spoken);
    for (const r of first.results) p.scenes[0]!.beats.find((b) => b.id === r.beatId)!.voice = { spoken: r.voice.spoken, src: r.voice.src };
    const v = await run(p, { kind: 'scene', sceneId: 's1' });
    expect(v.state).toBe('done');
    expect(v.errors).toHaveLength(1);
    expect(v.errors[0]!.beatId).toBe(bad.beatId);
    expect(v.errors[0]!.message).toContain('tts failed');
    expect(v.results.find((r) => r.beatId === bad.beatId)?.voice.file).toBeUndefined(); // the Japanese is kept, the sound is not
    expect(v.results.filter((r) => r.voice.file)).toHaveLength(first.results.length - 1);
  });

  it('fails clearly when GPT-SoVITS is not reachable, or rejects the weights', async () => {
    const p = project();
    store.patch({ endpoint: 'http://127.0.0.1:9' });
    const v = await run(p, { kind: 'scene', sceneId: 's1' });
    expect(v.state).toBe('failed');
    expect(v.error).toMatch(/连不上 GPT-SoVITS/);
    store.patch({ endpoint: sovits.url, profiles: { '001': { ...profile('a'), gptWeights: 'missing.ckpt' } } });
    const w = await run(p, { kind: 'scene', sceneId: 's1' });
    expect(w.state).toBe('done');
    expect(w.errors.length).toBeGreaterThan(0);
    expect(w.errors[0]!.message).toMatch(/权重.*weights not found/);
  });

  it('needs a configured AI for translation, but not when the Japanese is already there', async () => {
    const p = project();
    llm.available = () => ({ ok: false, message: '未配置 AI' });
    const v = await run(p, { kind: 'beat', sceneId: 's1', beatId: 's1b1' });
    expect(v.state).toBe('failed');
    expect(v.error).toContain('需要 AI');
    p.scenes[0]!.beats[0]!.voice = { src: p.scenes[0]!.beats[0]!.text, spoken: 'もう訳してあります', spokenEdited: true };
    expect((await run(p, { kind: 'beat', sceneId: 's1', beatId: 's1b1' })).state).toBe('done');
  });

  it('refuses when disabled, when nothing is voiced for a beat, and when a job is already running', async () => {
    const p = project();
    store.patch({ enabled: false });
    expect(() => service.start(p, { kind: 'project' })).toThrow(/还没有启用/);
    store.patch({ enabled: true });
    expect(() => service.start(p, { kind: 'beat', sceneId: 's1', beatId: 's1b2' })).toThrow(/这一句不配音/); // a silent beat
    sovits.delayMs = 150;
    const id = service.start(p, { kind: 'scene', sceneId: 's1' });
    expect(() => service.start(p, { kind: 'scene', sceneId: 's1' })).toThrow(/已有配音任务/);
    service.cancel(id);
    for (let i = 0; i < 200 && service.view(id)!.state === 'running'; i++) await new Promise((r) => setTimeout(r, 10));
    expect(service.view(id)!.state).toBe('cancelled');
  });

  it('asks again for lines the model skipped, then gives up on them', async () => {
    const p = project();
    const lines = p.scenes[0]!.beats.filter((b) => b.kind === 'dialogue' && b.speakerId).map((b) => ({ id: b.id, speaker: 'x', name: 'x', emotion: null, variant: 'normal' as const, text: b.text, translate: true }));
    llm.skip.add(lines[0]!.id);
    const r = await translateLines({ callJson: llm.callJson, scene: { title: 't', mood: '' }, lines });
    expect(r.ja.size).toBe(lines.length);
    expect(llm.calls).toBe(2);
    llm.override = { lines: [{ id: lines[0]!.id, ja: '中文没有假名' }] };
    const r2 = await translateLines({ callJson: llm.callJson, scene: { title: 't', mood: '' }, lines: lines.slice(0, 1) });
    expect(r2.ja.size).toBe(0);
    expect(r2.failed.size).toBe(1);
    llm.override = null;
  });
});

describe('new versions of one line (regenerate)', () => {
  const sc = { kind: 'beat' as const, sceneId: 's1', beatId: 's1b1' };
  const apply = (p: Project, v: VoiceJobView) => void (p.scenes[0]!.beats.find((b) => b.id === 's1b1')!.voice = v.results[0]!.voice);
  const beatFiles = () => wavs().filter((f) => f.startsWith('s1b1-'));

  it('always synthesises, even when the hash matches; sends and stores a seed; the previous version stays', async () => {
    const p = project();
    const first = await run(p, sc);
    apply(p, first);
    // every take has a seed (so it can be reproduced) and a file name made with it
    const firstSeed = first.results[0]!.voice.seed!;
    expect(Number.isInteger(firstSeed)).toBe(true);
    expect(ttsCalls()[0]!.body!.seed).toBe(firstSeed);
    const oldFile = first.results[0]!.voice.file!;
    expect(oldFile).toMatch(new RegExp(`^s1b1-[0-9a-f]{8}-${firstSeed}[.]wav$`));
    sovits.calls.length = 0;
    const again = await run(p, sc); // a plain run reuses the file
    expect(ttsCalls()).toHaveLength(0);
    expect(again.results[0]!.voice.file).toBe(oldFile); // the take is reused, not made again
    const v2 = await run(p, sc, { regenerate: true });
    expect(v2.state).toBe('done');
    expect(ttsCalls()).toHaveLength(1);
    const seed = ttsCalls()[0]!.body!.seed as number;
    expect(Number.isInteger(seed)).toBe(true);
    expect(seed).toBeGreaterThanOrEqual(0);
    const r = v2.results[0]!.voice;
    expect(r.seed).toBe(seed);
    expect(r.hash).toBe(first.results[0]!.voice.hash); // the same Japanese, a different take
    expect(r.file).toBe(`${oldFile.replace(/-\d+\.wav$/, '')}-${seed}.wav`);
    expect(r.file).not.toBe(oldFile);
    expect(beatFiles().sort()).toEqual([oldFile, r.file!].sort()); // undo can go back to the old file
    // the normal job afterwards keeps the chosen version and does not synthesise again
    apply(p, v2);
    sovits.calls.length = 0;
    const normal = await run(p, { kind: 'scene', sceneId: 's1' });
    expect(ttsCalls().filter((c) => c.body!.text === r.spoken)).toHaveLength(0);
    expect(normal.results.find((x) => x.beatId === 's1b1')!.voice).toMatchObject({ file: r.file, seed });
    expect(beatFiles()).toContain(oldFile);
  });

  it('keeps the newest 5 versions of a line and the one the line points to, and prunes the rest', async () => {
    const p = project();
    const made: string[] = [];
    for (let i = 0; i < 8; i++) {
      const v = await run(p, sc, { regenerate: true });
      apply(p, v);
      made.push(v.results[0]!.voice.file!);
    }
    const files = beatFiles();
    expect(files).toHaveLength(5);
    expect(files).toContain(made[7]);
    expect(files).toContain(made[6]); // the previous version is always kept
    // a normal job's cleanup respects the same limit and never deletes kept versions
    await run(p, { kind: 'scene', sceneId: 's1' });
    expect(beatFiles().sort()).toEqual(files.sort());
    // other lines are untouched
    expect(wavs().some((f) => !f.startsWith('s1b1-'))).toBe(true);
  });

  it('is for one line only', () => {
    expect(() => service.start(project(), { kind: 'scene', sceneId: 's1' }, { regenerate: true })).toThrow(/单独一句/);
  });

  it('retranslates one line with its neighbours as context, fresh (not cached), then synthesises a new version', async () => {
    const p = project();
    const first = await run(p, sc);
    apply(p, first);
    llm.calls = 0;
    sovits.calls.length = 0;
    const v = await run(p, sc, { regenerate: true, retranslate: true });
    expect(llm.calls).toBe(1);
    expect(llm.lastRefresh).toBe(true);
    const sent = llm.lastUser as { lines: Array<{ id: string; translate: boolean }> };
    expect(sent.lines.filter((l) => l.translate).map((l) => l.id)).toEqual(['s1b1']);
    expect(sent.lines.length).toBeGreaterThan(1); // the lines before / after come along as context
    expect(ttsCalls()).toHaveLength(1);
    expect(v.results[0]!.voice.seed).toBeDefined();
  });

  it('keeps a hand-edited line unless the person confirmed overwriting it', async () => {
    const p = project();
    const b = p.scenes[0]!.beats.find((x) => x.id === 's1b1')!;
    b.voice = { src: b.text, spoken: '手で直した日本語です', spokenEdited: true };
    const kept = await run(p, sc, { regenerate: true, retranslate: true });
    expect(kept.results[0]!.voice).toMatchObject({ spoken: '手で直した日本語です', spokenEdited: true });
    expect(llm.calls).toBe(0);
    const over = await run(p, sc, { regenerate: true, retranslate: true, overwriteEdited: true });
    expect(llm.calls).toBe(1);
    expect(over.results[0]!.voice.spoken).toMatch(/^これは/);
    expect(over.results[0]!.voice.spokenEdited).toBeUndefined();
  });
});

describe('missing words after synthesis', () => {
  const sc = { kind: 'beat' as const, sceneId: 's1', beatId: 's1b1' };
  const beatOf = (p: Project) => p.scenes[0]!.beats.find((b) => b.id === 's1b1')!;
  const longJa = (p: Project) => void (beatOf(p).voice = { src: beatOf(p).text, spoken: 'これは本当にちょっと長い台詞ですよね、聞いてください', spokenEdited: true });

  it('retries a take that ends early with a new seed and keeps the first complete one', async () => {
    const p = project();
    longJa(p);
    sovits.cutNext = [0.3];
    const v = await run(p, sc);
    expect(v.state).toBe('done');
    expect(ttsCalls()).toHaveLength(2);
    expect(new Set(ttsCalls().map((c) => c.body!.seed)).size).toBe(2);
    expect(v.retries).toBe(1);
    expect(v.warnings).toEqual([]);
    expect(v.completed).toBe(1);
    expect(v.results[0]!.voice.suspect).toBeUndefined();
    expect(v.results[0]!.voice.seed).toBe(ttsCalls()[1]!.body!.seed);
    expect(v.message).toContain('重试 1 次');
    expect(wavs().filter((f) => f.startsWith('s1b1-'))).toHaveLength(1); // only the kept take is written
  });
  it('after two retries keeps the longest take and warns about that line', async () => {
    const p = project();
    longJa(p);
    sovits.cutNext = [0.3, 0.5, 0.4];
    const v = await run(p, sc);
    expect(v.state).toBe('done');
    expect(ttsCalls()).toHaveLength(3);
    expect(v.retries).toBe(2);
    expect(v.warnings).toHaveLength(1);
    expect(v.warnings[0]!.message).toContain('可能没读完');
    const r = v.results[0]!.voice;
    expect(r.suspect).toBe(true);
    expect(r.seed).toBe(ttsCalls()[1]!.body!.seed); // the 0.5 one is the longest
    expect(r.seconds).toBeCloseTo(0.2 * estimateMorae(r.spoken) * 0.5, 1);
  });
  it('does not judge very short text', async () => {
    const p = project();
    beatOf(p).voice = { src: beatOf(p).text, spoken: 'うん。', spokenEdited: true };
    sovits.cutNext = [0.2];
    const v = await run(p, sc);
    expect(ttsCalls()).toHaveLength(1);
    expect(v.retries).toBe(0);
    expect(v.warnings).toEqual([]);
  });
});

describe('a take is never overwritten', () => {
  const sc = { kind: 'beat' as const, sceneId: 's1', beatId: 's1b1' };
  const beatOf = (p: Project) => p.scenes[0]!.beats.find((b) => b.id === 's1b1')!;
  const dirOf = () => path.join(dir, 'projects', 'voice_test', 'voice');

  it('force makes new files and leaves the old bytes alone', async () => {
    const p = project();
    const first = await run(p, sc);
    beatOf(p).voice = first.results[0]!.voice;
    const oldFile = first.results[0]!.voice.file!;
    const before = fs.readFileSync(path.join(dirOf(), oldFile));
    const again = await run(p, sc, { force: true });
    expect(ttsCalls()).toHaveLength(2);
    const nf = again.results[0]!.voice.file!;
    expect(nf).not.toBe(oldFile);
    expect(fs.readFileSync(path.join(dirOf(), oldFile)).equals(before)).toBe(true);
    expect(fs.existsSync(path.join(dirOf(), nf))).toBe(true);
  });
  it('reuses an old-format file (no seed) when the line does not point to any', async () => {
    const p = project();
    const first = await run(p, sc);
    const hash = first.results[0]!.voice.hash!;
    const seeded = first.results[0]!.voice.file!;
    const legacy = `s1b1-${hash.slice(0, 8)}.wav`;
    fs.writeFileSync(path.join(dirOf(), legacy), fs.readFileSync(path.join(dirOf(), seeded)));
    fs.rmSync(path.join(dirOf(), seeded));
    beatOf(p).voice = { src: beatOf(p).text, spoken: first.results[0]!.voice.spoken };
    sovits.calls.length = 0;
    const v = await run(p, sc);
    expect(ttsCalls()).toHaveLength(0);
    expect(v.results[0]!.voice).toMatchObject({ file: legacy });
    expect(v.results[0]!.voice.seed).toBeUndefined();
  });
  it('an ordinary run with no pointer reuses the newest seeded take', async () => {
    const p = project();
    const a = await run(p, sc);
    const b = await run(p, sc, { regenerate: true });
    beatOf(p).voice = { src: beatOf(p).text, spoken: a.results[0]!.voice.spoken };
    sovits.calls.length = 0;
    const v = await run(p, sc);
    expect(ttsCalls()).toHaveLength(0);
    expect(v.results[0]!.voice.file).toBe(b.results[0]!.voice.file);
  });
});

describe('cancel or failure keeps the voices that are there', () => {
  const sc: VoiceScope = { kind: 'scene', sceneId: 's1' };
  const voicedBeats = (p: Project) => p.scenes[0]!.beats.filter((b) => b.kind === 'dialogue' && b.speakerId && p.cast.find((c) => c.id === b.speakerId)!.characterKey !== '003');
  async function withVoices(): Promise<Project> {
    const p = project();
    const first = await run(p, sc);
    for (const r of first.results) p.scenes[0]!.beats.find((b) => b.id === r.beatId)!.voice = r.voice;
    return p;
  }

  it('a cancelled "force" job only replaces the lines it finished', async () => {
    const p = await withVoices();
    const olds = new Map(voicedBeats(p).map((b) => [b.id, b.voice!.file!]));
    sovits.delayMs = 120;
    const id = service.start(p, sc, { force: true });
    for (let i = 0; i < 300 && service.view(id)!.completed < 2; i++) await new Promise((r) => setTimeout(r, 10));
    service.cancel(id);
    for (let i = 0; i < 300 && service.view(id)!.state === 'running'; i++) await new Promise((r) => setTimeout(r, 10));
    const v = service.view(id)!;
    expect(v.state).toBe('cancelled');
    expect(v.completed).toBeGreaterThanOrEqual(2);
    expect(v.completed).toBeLessThan(voicedBeats(p).length);
    expect(v.message).toContain(`已完成 ${v.completed} 句`);
    // applying the results the way the editor does: no line loses its audio
    for (const r of v.results) p.scenes[0]!.beats.find((b) => b.id === r.beatId)!.voice = r.voice;
    for (const b of voicedBeats(p)) expect(b.voice?.file, b.id).toBeTruthy();
    expect(voicedBeats(p).filter((b) => b.voice!.file !== olds.get(b.id))).toHaveLength(v.completed);
    for (const b of voicedBeats(p)) expect(usableVoice(b), b.id).not.toBeNull();
  });
  it('an unreachable server under "force" leaves every line as it was', async () => {
    const p = await withVoices();
    store.patch({ endpoint: 'http://127.0.0.1:9' });
    const v = await run(p, sc, { force: true });
    expect(v.state).toBe('failed');
    expect(v.completed).toBe(0);
    expect(v.message).toContain('已完成 0 句');
    expect(v.results).toHaveLength(0); // unchanged Japanese: nothing to write at all
  });
  it('a retranslation that cannot be voiced keeps the old audio of a line it still matches', async () => {
    const p = await withVoices();
    const b = voicedBeats(p)[0]!;
    const oldFile = b.voice!.file!;
    store.patch({ endpoint: 'http://127.0.0.1:9' });
    llm.override = { lines: voicedBeats(p).map((x) => ({ id: x.id, ja: `新しい訳です${x.id}` })) };
    const v = await run(p, sc, { retranslate: true });
    expect(v.state).toBe('failed');
    const r = v.results.find((x) => x.beatId === b.id)!;
    expect(r.voice.spoken).toBe(`新しい訳です${b.id}`);
    expect(r.voice.file).toBe(oldFile); // still the recording of this Chinese line
    // a line whose Chinese text changed has no valid old audio to keep
    b.text = `${b.text}改`;
    const w = await run(p, { kind: 'beat', sceneId: 's1', beatId: b.id }, { retranslate: true });
    llm.override = null;
    expect(w.results[0]?.voice.file).toBeUndefined();
  });
});

describe('names in translations', () => {
  it('repairs a name in a translation that was cached on the line', async () => {
    const p = project();
    const b = p.scenes[0]!.beats.find((x) => x.kind === 'dialogue' && p.cast.find((c) => c.id === x.speakerId)!.characterKey === '001')!;
    b.voice = { src: b.text, spoken: '灯ちゃん、おはよう' };
    const v = await run(p, { kind: 'beat', sceneId: p.scenes[0]!.id, beatId: b.id });
    expect(v.results[0]!.voice.spoken).toBe('燈ちゃん、おはよう');
    expect(llm.calls).toBe(0);
  });
  it('gives the model every cast member with the official Japanese spelling, and repairs variant spellings after', async () => {
    const p = project();
    const b = p.scenes[0]!.beats.find((x) => x.kind === 'dialogue' && p.cast.find((c) => c.id === x.speakerId)!.characterKey === '001')!;
    llm.override = { lines: p.scenes[0]!.beats.filter((x) => x.kind === 'dialogue' && x.speakerId).map((x) => ({ id: x.id, ja: x.id === b.id ? '灯ちゃん、おはよう。高松灯さんだよね' : 'これはテストです' })) };
    const v = await run(p, { kind: 'scene', sceneId: p.scenes[0]!.id });
    llm.override = null;
    expect(v.results.find((r) => r.beatId === b.id)!.voice.spoken).toBe('燈ちゃん、おはよう。高松燈さんだよね');
    const sent = llm.lastUser as { characters: Array<{ key: string; ja?: string; given?: string; family?: string }> };
    expect(sent.characters.find((c) => c.key === '001')).toMatchObject({ ja: '高松燈', given: '燈', family: '高松' });
    expect(sent.characters.find((c) => c.key === '003')).toMatchObject({ ja: '要楽奈' }); // a cast member who does not speak here
  });
  it('leaves hand-edited Japanese alone', async () => {
    const p = project();
    const b = p.scenes[0]!.beats.find((x) => x.kind === 'dialogue' && p.cast.find((c) => c.id === x.speakerId)!.characterKey === '001')!;
    b.voice = { src: b.text, spoken: '灯ちゃん', spokenEdited: true };
    const v = await run(p, { kind: 'beat', sceneId: p.scenes[0]!.id, beatId: b.id });
    expect(v.results[0]!.voice.spoken).toBe('灯ちゃん');
  });
});

describe('per-character models', () => {
  it('fails a line whose character has no weights while another character uses its own', async () => {
    store.patch({ profiles: { '001': profile('a'), '002': { ...profile('b'), gptWeights: '', sovitsWeights: '' } } });
    const p = project();
    const v = await run(p, { kind: 'scene', sceneId: 's1' });
    const key = (id: string) => p.cast.find((c) => c.id === p.scenes[0]!.beats.find((b) => b.id === id)!.speakerId)!.characterKey;
    expect(v.errors.length).toBeGreaterThan(0);
    for (const e of v.errors) {
      expect(key(e.beatId)).toBe('002');
      expect(e.message).toContain('没有填权重');
    }
    expect(v.results.some((r) => r.voice.file && key(r.beatId) === '001')).toBe(true);
  });
  it('uses the default weights for a blank profile, once', async () => {
    store.patch({ defaultGptWeights: 'dg.ckpt', defaultSovitsWeights: 'ds.pth', profiles: { '001': { ...profile('a'), gptWeights: '', sovitsWeights: '' }, '002': { ...profile('b'), gptWeights: '', sovitsWeights: '' } } });
    const v = await run(project(), { kind: 'scene', sceneId: 's1' });
    expect(v.errors).toEqual([]);
    const w = sovits.calls.filter((c) => c.path.startsWith('/set_'));
    expect(w.map((c) => c.query!.weights_path).sort()).toEqual(['dg.ckpt', 'ds.pth']);
  });
});

describe('voice routes', () => {
  let base: string;
  let close: () => void;
  beforeAll(async () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-route-'));
    const st = new VoiceSettingsStore(path.join(d, 'v.json'));
    const vf = new VoiceFiles(path.join(d, 'projects'));
    const svc = new VoiceService({ settings: st, voice: vf, llm: new StubLlm().api() });
    fs.mkdirSync(path.join(d, 'projects', 'p1', 'voice'), { recursive: true });
    fs.writeFileSync(path.join(d, 'projects', 'p1', 'voice', 'b1-0123abcd.wav'), 'RIFFdata');
    const app = express();
    const router = express.Router();
    router.use(express.json());
    voiceRoutes(router, st, svc);
    app.use('/api/plugins/gpt-sovits', router);
    app.use(voiceFileRoutes(vf));
    const server = app.listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    close = () => server.close();
  });
  afterAll(() => close());

  it('serves settings and tests the connection', async () => {
    expect(await (await fetch(`${base}/api/plugins/gpt-sovits/settings`)).json()).toMatchObject({ enabled: false, endpoint: 'http://127.0.0.1:9880', textLang: 'ja' });
    const put = await fetch(`${base}/api/plugins/gpt-sovits/settings`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: true, endpoint: sovits.url }) });
    expect((await put.json()).enabled).toBe(true);
    expect((await fetch(`${base}/api/plugins/gpt-sovits/settings`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ endpoint: 5 }) })).status).toBe(400);
    expect(await (await fetch(`${base}/api/plugins/gpt-sovits/test`, { method: 'POST' })).json()).toMatchObject({ ok: true });
    expect(await (await fetch(`${base}/api/plugins/gpt-sovits/test`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ endpoint: 'http://127.0.0.1:9' }) })).json()).toMatchObject({ ok: false });
  });
  it('previews a voice and serves files only by safe names', async () => {
    await fetch(`${base}/api/plugins/gpt-sovits/settings`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ profiles: { '001': profile('a') } }) });
    const res = await fetch(`${base}/api/plugins/gpt-sovits/preview`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ characterKey: '001' }) });
    expect(res.headers.get('content-type')).toContain('audio/wav');
    expect(wavSeconds(new Uint8Array(await res.arrayBuffer()))).toBeGreaterThan(0.5);
    expect((await fetch(`${base}/api/plugins/gpt-sovits/preview`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ characterKey: '999' }) })).status).toBe(400);
    expect((await fetch(`${base}/api/projects/p1/voice/b1-0123abcd.wav`)).status).toBe(200);
    expect((await fetch(`${base}/api/projects/p1/voice/..%2Fproject.json`)).status).toBe(400);
    expect((await fetch(`${base}/api/projects/p1/voice/b2-0123abcd.wav`)).status).toBe(404);
    expect((await fetch(`${base}/api/plugins/gpt-sovits/jobs/nope`)).status).toBe(404);
  });
});
