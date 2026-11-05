import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type { PluginServerContext } from '../../../shared/plugins/api';
import { makeWav } from '../../../shared/voice/wav';
import { autoMatch, pickRef, pickWeights } from '../src/match/match';
import { mp3Seconds, mp3SecondsOf } from '../src/match/mp3';
import { runOf, stemOf, versionIn } from '../src/match/names';
import { scanInstall, type RefFile, type WeightFile } from '../src/match/scan';
import { splitBareTag } from '../src/match/tags';

let root: string;
let pack: string;
const put = (base: string, rel: string, content: string | Uint8Array = 'x') => {
  const f = path.join(base, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, content);
  return f;
};
const wav = (seconds: number) => makeWav(new Int16Array(Math.round(16000 * seconds)), 16000);
const llmOff: Pick<PluginServerContext, 'llm'> = {
  llm: { available: () => ({ ok: false, message: 'off' }), callJson: (async () => { throw new Error('no'); }) as PluginServerContext['llm']['callJson'] },
};
const CAST = [{ key: '001', name: '高松灯' }, { key: '002', name: '千早爱音' }, { key: '004', name: '长崎素世' }];

/** MPEG1 layer III, 128 kbps, 44.1 kHz stereo: 417-byte frames of 1152 samples (optionally behind an ID3v2 tag of `id3` bytes). */
const mp3 = (frames: number, id3 = 0) => {
  const out = new Uint8Array(id3 + frames * 417);
  if (id3) out.set([0x49, 0x44, 0x33, 3, 0, 0, 0, 0, (id3 - 10) >> 7, (id3 - 10) & 0x7f]);
  for (let i = 0; i < frames; i++) out.set([0xff, 0xfb, 0x90, 0x00], id3 + i * 417);
  return out;
};

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'sovits-root-'));
  pack = fs.mkdtempSync(path.join(os.tmpdir(), 'sovits-pack-'));
});

const w = (rel: string, over: Partial<WeightFile> = {}): WeightFile => ({
  path: '/' + rel, rel, parts: [rel], family: 'f', epoch: runOf(rel).epoch, step: 0, mtime: 0, stem: stemOf(rel), version: '', ...over,
});
const r = (rel: string, over: Partial<RefFile> = {}): RefFile => ({
  path: '/' + rel, rel, folders: [], base: rel, text: 'おはよう', lang: 'ja', seconds: 5, tag: '', textFrom: 'filename', ...over,
});

describe('weights in extra folders', () => {
  it('finds .ckpt / .pth inside a pack, owned through its character folders, in one family; RVC folders are skipped', async () => {
    put(pack, '千早爱音/xx-e8.ckpt');
    put(pack, '千早爱音/xx_e10_s5_l128.pth', '04rest');
    put(pack, '千早爱音/ref/line.wav', wav(4));
    put(pack, '高松灯RVC模型/something_e40.pth', 'PK');
    put(pack, '高松灯/tom-e10.ckpt');
    const s = scanInstall(root, [pack]);
    expect(s.gpt).toHaveLength(2);
    expect(s.sovits).toHaveLength(1);
    expect(s.sovits[0]).toMatchObject({ version: 'v4', stem: 'xx', epoch: 10, step: 5 });
    expect(s.gpt[0]!.family).toBe(s.sovits[0]!.family);
    const m = await autoMatch(llmOff, { sovitsRoot: root, refDirs: [pack] }, CAST);
    const row = m.rows.find((x) => x.characterKey === '002')!;
    expect(row.gpt).toBe(path.join(pack, '千早爱音', 'xx-e8.ckpt'));
    expect(row.sovits).toBe(path.join(pack, '千早爱音', 'xx_e10_s5_l128.pth'));
    expect(m.rows.find((x) => x.characterKey === '001')!.sovits).toBeUndefined();
  });
  it('skips rvc folders in the install weight folders too, case-insensitively, and does not count a pack inside the root twice', () => {
    put(root, 'SoVITS_weights_v2/RVC_tools/a_e1.pth');
    put(root, 'SoVITS_weights_v2/ok_e1.pth');
    put(root, 'GPT_weights_v2/ok-e1.ckpt');
    const s = scanInstall(root, [path.join(root, 'GPT_weights_v2'), path.join(root, 'SoVITS_weights_v2')]);
    expect(s.sovits.map((x) => x.rel)).toEqual(['SoVITS_weights_v2/ok_e1.pth']);
    expect(s.gpt).toHaveLength(1);
    expect(s.gpt[0]!.family).toBe('v2');
  });
});

describe('experiment stems', () => {
  it('stemOf / runOf / versionIn', () => {
    expect(stemOf('soyo非夹-e10.ckpt')).toBe('soyo非夹');
    expect(stemOf('soyo_e8_s3520_l128.pth')).toBe('soyo');
    expect(stemOf('plain.ckpt')).toBe('plain');
    expect(runOf('soyo_e8_s3520_l128.pth')).toEqual({ epoch: 8, step: 3520 });
    expect(versionIn('训练v4模型时收集的soyo的参考音频')).toBe('v4');
    expect(versionIn('GPT_weights_v2Pro')).toBe('v2pro');
    expect(versionIn('nothing')).toBe('');
  });
  it('pairs GPT and SoVITS by stem, the plain stem before a qualified one, then the highest epoch', () => {
    const g = [w('soyo-e10.ckpt'), w('soyo非夹-e12.ckpt'), w('soyo-e5.ckpt')];
    const s = [w('soyo非夹_e8_s616_l128.pth'), w('soyo_e8_s3520_l128.pth')];
    const p = pickWeights(g, s);
    expect(p.gpt!.rel).toBe('soyo-e10.ckpt');
    expect(p.sovits!.rel).toBe('soyo_e8_s3520_l128.pth');
  });
  it('falls back to the best of each when no stem is shared, or only one side exists', () => {
    const p = pickWeights([w('高松燈-e8.ckpt'), w('高松燈-e15.ckpt')], [w('灯_e8_s200.pth'), w('灯_e4_s100.pth')]);
    expect(p.gpt!.rel).toBe('高松燈-e15.ckpt');
    expect(p.sovits!.rel).toBe('灯_e8_s200.pth');
    expect(pickWeights([w('a-e1.ckpt')], []).gpt!.rel).toBe('a-e1.ckpt');
    expect(pickWeights([], [])).toEqual({});
  });
});

describe('bare emotion tags', () => {
  it('strips the tag chain and keeps real Japanese', () => {
    expect(splitBareTag('叙述ほんと。わたしもわかる')).toEqual({ tag: '叙述', rest: 'ほんと。わたしもわかる', suspect: false });
    expect(splitBareTag('疑问楽奈ちゃん……？どうしたの')).toMatchObject({ tag: '疑问', rest: '楽奈ちゃん……？どうしたの' });
    expect(splitBareTag('交谈，疑惑あの……ですか')).toMatchObject({ tag: '交谈，疑惑', rest: 'あの……ですか' });
    expect(splitBareTag('回忆叙述ここは、そう')).toMatchObject({ tag: '回忆，叙述', rest: 'ここは、そう' });
    expect(splitBareTag('犹豫……まあ、そうだね')).toMatchObject({ tag: '犹豫', rest: '……まあ、そうだね' });
    expect(splitBareTag('开心，笑あはは、いいね')).toMatchObject({ tag: '开心，笑', rest: 'あはは、いいね' });
    expect(splitBareTag('主唱太拼命了必死にやるしかできない!')).toMatchObject({ tag: '主唱太拼命了', rest: '必死にやるしかできない!' });
  });
  it('leaves names without kana, and plain Japanese, alone', () => {
    expect(splitBareTag('叙述今天天气不错')).toEqual({ tag: '', rest: '叙述今天天气不错', suspect: false });
    expect(splitBareTag('楽奈ちゃん、こんにちは')).toEqual({ tag: '', rest: '楽奈ちゃん、こんにちは', suspect: false });
    expect(splitBareTag('叙述交流が大事だよ')).toMatchObject({ tag: '叙述', rest: '交流が大事だよ' }); // a Japanese word right behind a tag is text
  });
  it('flags an unresolved simplified-Chinese run', () => {
    expect(splitBareTag('这个标签没见过です')).toMatchObject({ tag: '', suspect: true });
    expect(splitBareTag('叙述楽奈ちゃん').suspect).toBe(false);
  });
  it('scan puts the tag into RefFile.tag, the rest into the text, and marks suspects', () => {
    put(root, 'ref/高松灯/叙述ほんと、そうだね.wav', wav(4));
    put(root, 'ref/高松灯/【平静】今日はいい天気.wav', wav(4));
    put(root, 'ref/高松灯/这个说法没见过ですね.wav', wav(4));
    const s = scanInstall(root);
    const by = (b: string) => s.refs.find((x) => x.rel.includes(b))!;
    expect(by('ほんと')).toMatchObject({ tag: '叙述', text: 'ほんと、そうだね', base: 'ほんと、そうだね' });
    expect(by('今日は')).toMatchObject({ tag: '平静', text: '今日はいい天気' });
    expect(by('ですね')).toMatchObject({ textSuspect: true });
    expect(by('今日は').textSuspect).toBeUndefined();
  });
});

describe('mp3 duration', () => {
  it('sums MPEG1 layer III frames, skipping an ID3v2 tag', () => {
    expect(mp3SecondsOf(mp3(100))).toBeCloseTo((100 * 1152) / 44100, 3);
    expect(mp3SecondsOf(mp3(100, 300))).toBeCloseTo((100 * 1152) / 44100, 3);
  });
  it('reads an MPEG2 stream (576 samples per frame) and a Xing frame count', () => {
    // MPEG2 layer III, 64 kbps, 22.05 kHz: 72 * 64000 / 22050 = 208 bytes
    const f2 = new Uint8Array(208 * 50);
    for (let i = 0; i < 50; i++) f2.set([0xff, 0xf3, 0x80, 0x00], i * 208);
    expect(mp3SecondsOf(f2)).toBeCloseTo((50 * 576) / 22050, 3);
    const x = mp3(3);
    x.set([...'Xing'].map((c) => c.charCodeAt(0)), 4 + 32);
    x.set([0, 0, 0, 1, 0, 0, 0x03, 0xe8], 4 + 32 + 4); // frames flag, 1000 frames
    expect(mp3SecondsOf(x)).toBeCloseTo((1000 * 1152) / 44100, 3);
  });
  it('never throws: junk, empty, truncated, missing file', () => {
    expect(mp3SecondsOf(new Uint8Array(0))).toBeNull();
    expect(mp3SecondsOf(new Uint8Array(500).fill(0xff))).toBeNull();
    expect(mp3SecondsOf(new Uint8Array([0x49, 0x44, 0x33, 3, 0, 0, 0x7f, 0x7f, 0x7f, 0x7f]))).toBeNull();
    expect(mp3SecondsOf(mp3(10).subarray(0, 600))).not.toBeNull();
    expect(mp3Seconds(path.join(root, 'nope.mp3'))).toBeNull();
  });
  it('scan gives mp3 references a length', () => {
    put(root, 'ref/a/よろしくお願いします.mp3', mp3(130)); // about 3.4 s
    expect(scanInstall(root).refs[0]!.seconds).toBeCloseTo(3.4, 1);
  });
});

describe('pickRef', () => {
  it('prefers the reference folder of the model version, and plain voice over variant subfolders', () => {
    const v2 = r('v2/a.wav', { folders: ['训练v2模型时收集的x的参考音频'] });
    const v4 = r('v4/a.mp3', { folders: ['训练v4模型时收集的x的参考音频'] });
    const v4variant = r('v4/夹子音/a.mp3', { folders: ['训练v4模型时收集的x的参考音频', '夹子音'] });
    expect(pickRef([v2, v4variant, v4], { version: 'v4' })).toBe(v4);
    expect(pickRef([v2, v4, v4variant])).toBe(v2); // no version: the old ranking
    const long = r('v4/b.mp3', { folders: ['训练v4模型时收集的x的参考音频'], seconds: 6 });
    expect(pickRef([v4variant, long], { version: 'v4' })).toBe(long);
  });
  it('ranks a suspect text low, and an mp3 with a length competes with a wav', () => {
    const bad = r('a.wav', { textSuspect: true });
    const ok = r('b.mp3', { seconds: 4 });
    expect(pickRef([bad, ok])).toBe(ok);
    expect(pickRef([r('x.wav', { seconds: 1 }), r('y.mp3', { seconds: 5 })])!.rel).toBe('y.mp3');
  });
  it('end to end: a v4 pack picks the v4 folder, the plain model and its own pair', async () => {
    put(pack, '长崎素世/soyo-e10.ckpt');
    put(pack, '长崎素世/soyo非夹-e10.ckpt');
    put(pack, '长崎素世/soyo_e8_s3520_l128.pth', '04..');
    put(pack, '长崎素世/soyo非夹_e8_s616_l128.pth', '04..');
    put(pack, '长崎素世/训练v2模型时收集的soyo的参考音频/叙述おはよう、今日も。.wav', wav(5));
    put(pack, '长崎素世/训练v4模型时收集的soyo的参考音频/叙述こんにちは、いい天気。.mp3', mp3(130));
    put(pack, '长崎素世/训练v4模型时收集的soyo的参考音频/夹子音/疑问ええと、どうしたの。.mp3', mp3(130));
    const m = await autoMatch(llmOff, { sovitsRoot: root, refDirs: [pack] }, CAST);
    const row = m.rows.find((x) => x.characterKey === '004')!;
    expect(path.basename(row.gpt!)).toBe('soyo-e10.ckpt');
    expect(path.basename(row.sovits!)).toBe('soyo_e8_s3520_l128.pth');
    expect(row.ref).toMatchObject({ text: 'こんにちは、いい天気。', lang: 'ja' });
    expect(row.ref!.path).toContain('训练v4');
    expect(row.ref!.path).not.toContain('夹子音');
  });
});
