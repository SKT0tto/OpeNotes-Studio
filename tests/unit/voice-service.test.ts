import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { ProjectSchema, type Project } from '../../shared/schema/project';
import type { VoiceJobView, VoiceScope } from '../../shared/schema/voice';
import { wavSeconds } from '../../shared/voice/wav';
import { LlmCache } from '../../server/llm/cache';
import { inputText, validateOutput, zeroUsage, type LlmProvider, type StructuredRequest, type StructuredResult } from '../../server/llm/provider';
import { VoiceService, voiceHash } from '../../server/voice/service';
import { voiceRoutes } from '../../server/voice/routes';
import { VoiceSettingsStore } from '../../server/voice/store';
import { translateLines } from '../../server/voice/translate';
import demo from '../fixtures/demo-project.json';
import { startFakeSovits, type FakeSovits } from '../helpers/fakeSovits';

/** A scripted stand-in for the model: answers every translate=true line with Japanese made from its text. */
class StubJa implements LlmProvider {
  readonly id = 'fixture' as const;
  readonly model = 'stub-ja';
  calls = 0;
  /** ids to leave out of the answer, once. */
  skip = new Set<string>();
  async generateStructured<T>(req: StructuredRequest<T>): Promise<Omit<StructuredResult<T>, 'cached'>> {
    this.calls++;
    const input = JSON.parse(inputText(req.input)) as { lines: Array<{ id: string; text: string; translate: boolean }> };
    const lines = input.lines.filter((l) => l.translate && !this.skip.has(l.id)).map((l) => ({ id: l.id, ja: `これは${l.text}です` }));
    this.skip.clear();
    const raw = JSON.stringify({ lines });
    return { data: validateOutput(req.schema, JSON.parse(raw), raw), usage: zeroUsage(), raw, warnings: [] };
  }
  async test() {
    return { model: this.model, latencyMs: 0 };
  }
}

let sovits: FakeSovits;
let dir: string;
let store: VoiceSettingsStore;
let llm: StubJa;
let service: VoiceService;
let noProvider = false;
const project = (): Project => ProjectSchema.parse({ ...JSON.parse(JSON.stringify(demo)), id: 'voice_test' });

async function run(p: Project, scope: VoiceScope, opts: { retranslate?: boolean; force?: boolean } = {}): Promise<VoiceJobView> {
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
  llm = new StubJa();
  noProvider = false;
  service = new VoiceService({ settings: store, projectsDir: path.join(dir, 'projects'), cache: new LlmCache(path.join(dir, 'cache')), provider: () => (noProvider ? { provider: null, message: '未配置 AI' } : { provider: llm }) });
  sovits.calls.length = 0;
  sovits.failText.clear();
  sovits.bogusHeader = false;
  sovits.delayMs = 0;
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
      expect(r.voice.ja).toMatch(/^これは/);
      expect(r.voice.src).toBe(scene.beats.find((b) => b.id === r.beatId)!.text);
      const file = path.join(dir, 'projects', 'voice_test', 'voice', r.voice.file!);
      expect(wavSeconds(fs.readFileSync(file))).toBeCloseTo(r.voice.seconds!, 2);
      expect(r.voice.seconds).toBeCloseTo(0.12 * [...r.voice.ja].length, 1);
      expect(r.voice.hash).toBe(voiceHash(r.voice.ja, { ...profile(p.cast.find((c) => c.id === scene.beats.find((b) => b.id === r.beatId)!.speakerId)!.characterKey === '001' ? 'a' : 'b') }, 'ja'));
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
    // a person edits one Japanese line: only it is synthesised again and its old file goes away
    const target = first.results[0]!;
    const beat = p.scenes[0]!.beats.find((b) => b.id === target.beatId)!;
    beat.voice = { ja: 'ちょっと違う言い方です', jaEdited: true };
    sovits.calls.length = 0;
    const third = await run(p, sc);
    expect(ttsCalls()).toHaveLength(1);
    expect(third.results.find((r) => r.beatId === target.beatId)!.voice).toMatchObject({ ja: 'ちょっと違う言い方です', jaEdited: true });
    expect(wavs()).toHaveLength(n);
    expect(wavs()).not.toContain(target.voice.file);
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
    expect(r.voice.seconds).toBeCloseTo(0.12 * [...r.voice.ja].length, 1);
  });

  it('reports a rejected line and carries on with the rest', async () => {
    const p = project();
    const first = await run(p, { kind: 'scene', sceneId: 's1' });
    const bad = first.results[1]!;
    for (const f of wavs()) fs.rmSync(path.join(dir, 'projects', 'voice_test', 'voice', f));
    sovits.failText.add(bad.voice.ja);
    for (const r of first.results) p.scenes[0]!.beats.find((b) => b.id === r.beatId)!.voice = { ja: r.voice.ja, src: r.voice.src! };
    const v = await run(p, { kind: 'scene', sceneId: 's1' });
    expect(v.state).toBe('done');
    expect(v.errors).toHaveLength(1);
    expect(v.errors[0]!.beatId).toBe(bad.beatId);
    expect(v.errors[0]!.message).toContain('tts failed');
    expect(v.results.find((r) => r.beatId === bad.beatId)!.voice.file).toBeUndefined(); // the Japanese is kept, the sound is not
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
    noProvider = true;
    const v = await run(p, { kind: 'beat', sceneId: 's1', beatId: 's1b1' });
    expect(v.state).toBe('failed');
    expect(v.error).toContain('需要 AI');
    p.scenes[0]!.beats[0]!.voice = { ja: 'もう訳してあります', jaEdited: true };
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
    const r = await translateLines({ provider: llm, cache: null, scene: { title: 't', mood: '' }, lines });
    expect(r.ja.size).toBe(lines.length);
    expect(llm.calls).toBe(2);
    const bad: LlmProvider = { ...llm, generateStructured: async <T,>(req: StructuredRequest<T>) => ({ data: validateOutput(req.schema, { lines: [{ id: lines[0]!.id, ja: '中文没有假名' }] }, ''), usage: zeroUsage(), raw: '', warnings: [] }) } as never;
    const r2 = await translateLines({ provider: bad, cache: null, scene: { title: 't', mood: '' }, lines: lines.slice(0, 1) });
    expect(r2.ja.size).toBe(0);
    expect(r2.failed.size).toBe(1);
  });
});

describe('voice routes', () => {
  let base: string;
  let close: () => void;
  beforeAll(async () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-route-'));
    const st = new VoiceSettingsStore(path.join(d, 'v.json'));
    const svc = new VoiceService({ settings: st, projectsDir: path.join(d, 'projects'), cache: null, provider: () => ({ provider: new StubJa() }) });
    fs.mkdirSync(path.join(d, 'projects', 'p1', 'voice'), { recursive: true });
    fs.writeFileSync(path.join(d, 'projects', 'p1', 'voice', 'b1-0123abcd.wav'), 'RIFFdata');
    const app = express();
    app.use(voiceRoutes(st, svc));
    const server = app.listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    close = () => server.close();
  });
  afterAll(() => close());

  it('serves settings and tests the connection', async () => {
    expect(await (await fetch(`${base}/api/voice/settings`)).json()).toMatchObject({ enabled: false, endpoint: 'http://127.0.0.1:9880', volume: 1, textLang: 'ja' });
    const put = await fetch(`${base}/api/voice/settings`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: true, endpoint: sovits.url }) });
    expect((await put.json()).enabled).toBe(true);
    expect((await fetch(`${base}/api/voice/settings`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ volume: 9 }) })).status).toBe(400);
    expect(await (await fetch(`${base}/api/voice/test`, { method: 'POST' })).json()).toMatchObject({ ok: true });
    expect(await (await fetch(`${base}/api/voice/test`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ endpoint: 'http://127.0.0.1:9' }) })).json()).toMatchObject({ ok: false });
  });
  it('previews a voice and serves files only by safe names', async () => {
    await fetch(`${base}/api/voice/settings`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ profiles: { '001': profile('a') } }) });
    const res = await fetch(`${base}/api/voice/preview`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ characterKey: '001' }) });
    expect(res.headers.get('content-type')).toContain('audio/wav');
    expect(wavSeconds(new Uint8Array(await res.arrayBuffer()))).toBeGreaterThan(0.5);
    expect((await fetch(`${base}/api/voice/preview`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ characterKey: '999' }) })).status).toBe(400);
    expect((await fetch(`${base}/api/projects/p1/voice/b1-0123abcd.wav`)).status).toBe(200);
    expect((await fetch(`${base}/api/projects/p1/voice/..%2Fproject.json`)).status).toBe(400);
    expect((await fetch(`${base}/api/projects/p1/voice/b2-0123abcd.wav`)).status).toBe(404);
    expect((await fetch(`${base}/api/voice/jobs/nope`)).status).toBe(404);
  });
});
