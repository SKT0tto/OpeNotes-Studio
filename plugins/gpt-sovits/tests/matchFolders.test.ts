import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { PluginServerContext } from '../../../shared/plugins/api';
import { makeWav } from '../../../shared/voice/wav';
import { autoMatch, isLabelName, pickRef, rankRefs, weightVariants } from '../src/match/match';
import { matchRoutes } from '../src/match/routes';
import { scanInstall, type RefFile } from '../src/match/scan';
import { cleanPath, cleanPathList } from '../src/paths';
import { VoiceSettingsStore } from '../src/store';

let pack: string;
const put = (rel: string, content: string | Uint8Array = 'x', base = pack) => {
  const f = path.join(base, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, content);
  return f;
};
const wav = (seconds: number) => makeWav(new Int16Array(Math.round(16000 * seconds)), 16000);
const llmOff: Pick<PluginServerContext, 'llm'> = {
  llm: { available: () => ({ ok: false, message: 'off' }), callJson: (async () => { throw new Error('no'); }) as PluginServerContext['llm']['callJson'] },
};
/** Made-up project cast: the three characters of a project. */
const THREE = [{ key: '001', name: '高松灯' }, { key: '002', name: '千早爱音' }, { key: '003', name: '要乐奈' }];

beforeEach(() => {
  pack = fs.mkdtempSync(path.join(os.tmpdir(), 'sovits-folders-'));
});

describe('cleanPath', () => {
  it('removes spaces and ASCII / curly quotes, and nothing else', () => {
    expect(cleanPath('  "D:\\GPT-SoVITS\\MYGO-models"  ')).toBe('D:\\GPT-SoVITS\\MYGO-models');
    expect(cleanPath('“D:\\a b\\c”')).toBe('D:\\a b\\c');
    expect(cleanPath("'D:\\x'")).toBe('D:\\x');
    expect(cleanPath('‘D:\\x’')).toBe('D:\\x');
    expect(cleanPath('"“D:\\x”"')).toBe('D:\\x');
    expect(cleanPath('D:\\plain')).toBe('D:\\plain');
    expect(cleanPath('"')).toBe('"');
    expect(cleanPath(undefined)).toBe('');
    expect(cleanPathList('"D:\\a"\r\n\n  “D:\\b”  \n')).toEqual(['D:\\a', 'D:\\b']);
  });
  it('settings store cleans every path field', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sovits-store-'));
    const store = new VoiceSettingsStore(path.join(dir, 's.json'));
    const s = store.patch({ sovitsRoot: ' "D:\\models" ', refDirs: ['“D:\\r1”', '  ', '"D:\\r2"'], defaultGptWeights: '"D:\\g.ckpt"', profiles: { '001': { gptWeights: '"D:\\a.ckpt"', sovitsWeights: '“D:\\a.pth”', refAudioPath: "'D:\\a.wav'", promptText: '', promptLang: 'ja', speed: 1 } } });
    expect(s.sovitsRoot).toBe('D:\\models');
    expect(s.refDirs).toEqual(['D:\\r1', 'D:\\r2']);
    expect(s.defaultGptWeights).toBe('D:\\g.ckpt');
    expect(s.profiles['001']).toMatchObject({ gptWeights: 'D:\\a.ckpt', sovitsWeights: 'D:\\a.pth', refAudioPath: 'D:\\a.wav' });
  });
});

describe('one folder is enough', () => {
  const fill = () => {
    put('千早爱音/ano-e8.ckpt');
    put('千早爱音/ano_e10_s5_l128.pth', '04rest');
    put('千早爱音/训练v2模型时收集的ano的参考音频/叙述これはテストの一つ目です.wav', wav(5));
    put('高松灯/tomori-e10.ckpt');
    put('高松灯/tomori_e8_s7_l128.pth', '04rest');
    put('高松灯/训练v4模型时收集的tomori的参考音频/叙述これはテストの二つ目です.mp3', wav(5));
  };
  it('a pack folder given alone is scanned recursively', async () => {
    fill();
    const m = await autoMatch(llmOff, { sovitsRoot: pack, refDirs: [] }, THREE);
    expect(m.rows.map((r) => r.characterKey).sort()).toEqual(['001', '002']);
    expect(m.rows.find((r) => r.characterKey === '002')).toMatchObject({ gpt: path.join(pack, '千早爱音', 'ano-e8.ckpt'), inProject: true });
    expect(m.unmatched).toEqual(['003']);
    expect(m.report[0]).toMatchObject({ path: pack, ckpt: 2, pth: 2, audio: 2 });
  });
  it('a quoted path, a character folder, and a parent folder all work', async () => {
    fill();
    const quoted = await autoMatch(llmOff, { sovitsRoot: `  "${pack}"  `, refDirs: [] }, THREE);
    expect(quoted.rows).toHaveLength(2);
    const one = await autoMatch(llmOff, { sovitsRoot: path.join(pack, '千早爱音'), refDirs: [] }, THREE);
    expect(one.rows.map((r) => r.characterKey)).toEqual(['002']);
    expect(one.rows[0]!.ref?.text).toBe('これはテストの一つ目です');
    const holder = fs.mkdtempSync(path.join(os.tmpdir(), 'sovits-holder-'));
    fs.cpSync(pack, path.join(holder, 'some-pack'), { recursive: true });
    const parent = await autoMatch(llmOff, { sovitsRoot: holder, refDirs: [] }, THREE);
    expect(parent.rows.map((r) => r.characterKey).sort()).toEqual(['001', '002']);
  });
  it('the extra list alone is enough, and a missing folder is a warning, not silence', async () => {
    fill();
    const m = await autoMatch(llmOff, { sovitsRoot: '', refDirs: [`"${pack}"`, path.join(pack, 'nope')] }, THREE);
    expect(m.rows).toHaveLength(2);
    expect(m.warnings.join()).toContain('找不到文件夹');
    expect(m.warnings.join()).toContain('nope');
    const s = scanInstall(pack, ['"' + path.join(pack, 'missing') + '"']);
    expect(s.warnings.join()).toContain('找不到文件夹');
    expect(() => scanInstall(path.join(pack, 'nope'))).toThrow(/找不到文件夹/);
    expect(() => scanInstall('', [])).toThrow(/还没有填模型文件夹/);
    put('afile.txt');
    expect(() => scanInstall(path.join(pack, 'afile.txt'))).toThrow(/不是文件夹/);
  });
  it('an empty result says what was read, how many files of each kind, and what to do', async () => {
    put('notes/readme.txt');
    put('notes/loop.wav', wav(1));
    const m = await autoMatch(llmOff, { sovitsRoot: pack, refDirs: [] }, THREE);
    expect(m.rows).toEqual([]);
    const text = m.warnings.join('\n');
    expect(text).toContain(pack);
    expect(text).toContain('.ckpt 0 个');
    expect(text).toContain('音频 1 个');
    expect(text).toContain('认不出');
    const nothing = fs.mkdtempSync(path.join(os.tmpdir(), 'sovits-empty-'));
    const e = await autoMatch(llmOff, { sovitsRoot: nothing, refDirs: [] }, THREE);
    expect(e.warnings.join('\n')).toContain('没有找到任何模型或参考音频');
  });
  it('skips pretrained models, RVC folders and runtime trees; a large install does not starve a pack', async () => {
    put('Install/api_v2.py');
    put('Install/GPT_weights_v2/tomori-e10.ckpt');
    put('Install/GPT_SoVITS/pretrained_models/base_e1.ckpt');
    put('Install/runtime/Lib/site-packages/x/高松灯_e1.pth');
    put('Install/GPT_SoVITS/高松灯/noise.wav', wav(5));
    put('Install/高松灯RVC模型/tomori_e40.pth', 'PK');
    for (let i = 0; i < 40; i++) put(`Install/output/slicer/${i}.wav`, 'x'); // a big tree of no interest
    put('千早爱音/ano-e8.ckpt', 'x', pack); // the pack
    const m = scanInstall(path.join(pack, 'Install'), [path.join(pack, '千早爱音')]);
    expect(m.gpt.map((w) => path.basename(w.path)).sort()).toEqual(['ano-e8.ckpt', 'tomori-e10.ckpt']);
    expect(m.sovits).toEqual([]);
    expect(m.refs).toEqual([]);
    expect(m.report).toHaveLength(2);
    expect(m.report.every((r) => !r.truncated)).toBe(true);
  });
});

describe('ownership', () => {
  it('a folder named after a character who is not in the project is not given to a project character', async () => {
    // 3 characters requested; the files in the 长崎 folder mention 愛音 in their names
    put('长崎素世/soyo-e10.ckpt');
    put('长崎素世/ref/叙述愛音ちゃんも、一緒に行こうよ.wav', wav(5));
    put('千早爱音/ano-e8.ckpt');
    put('千早爱音/ref/叙述おはよう、今日もよろしくね.wav', wav(5));
    const m = await autoMatch(llmOff, { sovitsRoot: pack, refDirs: [] }, THREE);
    const anon = m.rows.find((r) => r.characterKey === '002')!;
    expect(anon.ref?.text).toBe('おはよう、今日もよろしくね');
    expect(anon.candidates).toHaveLength(1);
    // the owner of the other folder is listed as a row of her own, unticked
    const soyo = m.rows.find((r) => r.characterKey === '004')!;
    expect(soyo).toMatchObject({ inProject: false, name: '长崎爽世' });
    expect(soyo.ref?.text).toBe('愛音ちゃんも、一緒に行こうよ');
    expect(m.rows.filter((r) => r.inProject).map((r) => r.characterKey)).toEqual(['002']);
  });
  it('a sentence-style file name never decides, a label-style one may', async () => {
    put('misc/叙述愛音ちゃんと一緒に帰ろうかな.wav', wav(5));
    put('misc/tomori_01.wav', wav(5));
    put('misc/愛音_02.wav', wav(5));
    const s = scanInstall(pack);
    const m = await autoMatch(llmOff, { sovitsRoot: pack, refDirs: [] }, THREE);
    expect(s.refs).toHaveLength(3);
    expect(m.rows.find((r) => r.characterKey === '002')!.candidates.map((c) => path.basename(c.path))).toEqual(['愛音_02.wav']);
    expect(m.rows.find((r) => r.characterKey === '001')!.candidates.map((c) => path.basename(c.path))).toEqual(['tomori_01.wav']);
    expect(isLabelName('tomori_01')).toBe(true);
    expect(isLabelName('愛音')).toBe(true);
    expect(isLabelName('愛音ちゃんも、一緒に行こうよ')).toBe(false);
    expect(isLabelName('はい。')).toBe(false);
  });
  it('weights in a folder of somebody else are not taken either', async () => {
    put('长崎素世/愛音-e10.ckpt');
    const m = await autoMatch(llmOff, { sovitsRoot: pack, refDirs: [] }, THREE);
    expect(m.rows.find((r) => r.characterKey === '002')).toBeUndefined();
    expect(m.rows.find((r) => r.characterKey === '004')!.gpt).toBeTruthy();
  });
});

describe('reference ranking', () => {
  const r = (rel: string, over: Partial<RefFile> = {}): RefFile => ({
    path: '/' + rel, rel, folders: ['训练v4模型时收集的x的参考音频'], base: rel, text: 'これは長めのテストです', lang: 'ja', seconds: 5, tag: '叙述', textFrom: 'filename', ...over,
  });
  it('treats 叙述 as calm and demotes strong emotions, shouting, questions and pause-heavy text', () => {
    const calm = r('calm.mp3');
    for (const bad of [r('a.mp3', { tag: '颤颤巍巍地吐露' }), r('b.mp3', { tag: '兴奋' }), r('c.mp3', { tag: '悲伤' }), r('d.mp3', { tag: '惊慌' }), r('e.mp3', { tag: '生气' }), r('f.mp3', { tag: '哈？' })]) expect(pickRef([bad, calm])).toBe(calm);
    expect(pickRef([r('x.mp3', { text: 'ええと……あの……その……' , tag: '' }), calm])).toBe(calm);
    expect(pickRef([r('q.mp3', { text: 'これは長めのテストですか？' }), calm])).toBe(calm);
    expect(pickRef([r('lead.mp3', { text: '……これは長めのテストです' }), calm])).toBe(calm);
    expect(pickRef([r('mixed.mp3', { tag: '愉快叙述' }), calm])).toBe(calm);
    expect(pickRef([r('chain.mp3', { tag: '叙述，提示' }), calm])).toBe(calm); // plain narration before a compound tag
  });
  it('leaves out clips outside 3-10 s outright, whatever else is good about them', () => {
    const ok = r('ok.mp3', { tag: '', seconds: 5, text: '' });
    expect(pickRef([r('short.mp3', { seconds: 2.9 }), r('long.mp3', { seconds: 10.1 }), ok])).toBe(ok);
    expect(rankRefs([r('short.mp3', { seconds: 2.9 }), r('long.mp3', { seconds: 10.1 })])).toEqual([]);
    expect(rankRefs([r('edge.mp3', { seconds: 3 }), r('edge2.mp3', { seconds: 10 })])).toHaveLength(2);
  });
  it('trusts clean v4 transcripts over rough v2 recognition, and a text without latin noise', () => {
    const v4 = r('v4.mp3');
    const v2 = r('v2.wav', { folders: ['训练v2模型时收集的x的参考音频'] });
    expect(pickRef([v2, v4])).toBe(v4);
    expect(pickRef([r('noise.mp3', { text: 'これは g とか f とか言ってる' }), v4])).toBe(v4);
  });
  it('among equals the shorter text and a plain length win, and the order is stable', () => {
    const a = r('a.mp3', { text: 'これは短いです', seconds: 4.4 });
    const b = r('b.mp3', { text: 'これはもっと長い文章になっています', seconds: 4.6 });
    expect(rankRefs([b, a]).map((x) => x.rel)).toEqual(['a.mp3', 'b.mp3']);
  });
});

describe('weight variants', () => {
  const w = (rel: string, stem: string, epoch: number) => ({ path: '/' + rel, rel, parts: [rel], family: 'pack:x', epoch, step: 0, mtime: 0, stem, version: 'v4' });
  it('lists one entry per experiment, GPT and SoVITS paired by stem, the plain stem first', () => {
    const v = weightVariants(
      [w('soyo-e10.ckpt', 'soyo', 10), w('soyo非夹-e10.ckpt', 'soyo非夹', 10), w('soyo-e5.ckpt', 'soyo', 5)],
      [w('soyo_e8.pth', 'soyo', 8), w('soyo非夹_e8.pth', 'soyo非夹', 8)],
    );
    expect(v.map((x) => x.label)).toEqual(['soyo', 'soyo非夹']);
    expect(v[0]!.gpt!.rel).toBe('soyo-e10.ckpt');
    expect(v[1]!.sovits!.rel).toBe('soyo非夹_e8.pth');
  });
});

describe('streaming a reference clip', () => {
  const servers: Array<() => void> = [];
  afterAll(() => servers.forEach((c) => c()));
  async function serve() {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sovits-route-'));
    const store = new VoiceSettingsStore(path.join(d, 's.json'));
    const app = express();
    const router = express.Router();
    router.use(express.json());
    matchRoutes({ router, llm: llmOff.llm } as unknown as PluginServerContext, store);
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    router.use(((err: { status?: number; message: string }, _req, res, _next) => void res.status(err.status ?? 500).json({ error: err.message })) as express.ErrorRequestHandler);
    app.use('/p', router);
    const server = app.listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    servers.push(() => server.close());
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}/p`;
  }
  it('plays only audio inside the folders of the latest scan', async () => {
    const clip = put('高松灯/叙述これはテストの一つ目です.wav', wav(4));
    const secret = put('../secret-outside.wav', wav(4), pack);
    const base = await serve();
    const get = (p: string) => fetch(`${base}/ref-audio?path=${encodeURIComponent(p)}`);
    expect((await get(clip)).status).toBe(404); // nothing scanned yet
    const body = { characters: THREE, sovitsRoot: `"${pack}"` };
    const m = await fetch(`${base}/match`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    expect(m.status).toBe(200);
    const res = await get(clip);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('audio/wav');
    expect((await res.arrayBuffer()).byteLength).toBeGreaterThan(1000);
    expect((await get(secret)).status).toBe(404); // outside the scanned folder
    expect((await get(path.join(pack, '..', path.basename(secret)))).status).toBe(404);
    put('高松灯/notes.txt', 'private');
    expect((await get(path.join(pack, '高松灯', 'notes.txt'))).status).toBe(404); // not audio
    expect((await get('relative.wav')).status).toBe(404);
    const bad = await fetch(`${base}/match`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ characters: THREE, sovitsRoot: path.join(pack, 'nope') }) });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toContain('找不到文件夹');
  });
});
