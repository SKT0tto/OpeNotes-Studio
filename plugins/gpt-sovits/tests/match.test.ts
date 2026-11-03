import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type { JsonCallRequest, PluginServerContext } from '../../../shared/plugins/api';
import { makeWav } from '../../../shared/voice/wav';
import { autoMatch } from '../src/match/match';
import { aliasesOf, runOf, scoreText, tokens } from '../src/match/names';
import { guessLang, looksLikeSentence, scanInstall } from '../src/match/scan';
import { overwrites } from '../src/web/Dialog';

let root: string;
const touch = (rel: string, content: string | Uint8Array = 'x', mtime?: number) => {
  const f = path.join(root, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, content);
  if (mtime) fs.utimesSync(f, mtime / 1000, mtime / 1000);
};
const wav = (seconds: number) => makeWav(new Int16Array(Math.round(16000 * seconds)), 16000);

const CAST = [{ key: '001', name: '高松灯' }, { key: '002', name: '千早爱音' }, { key: '003', name: '要乐奈' }, { key: '010', name: '丰川祥子' }];

/** A stub for the studio's model call; `answer` is what the "model" says. */
function stubLlm(answer: unknown, ok = true) {
  const calls: Array<JsonCallRequest<unknown>> = [];
  const llm: Pick<PluginServerContext, 'llm'> = {
    llm: {
      available: () => (ok ? { ok: true } : { ok: false, message: '未配置 AI' }),
      callJson: (async (req: JsonCallRequest<unknown>) => {
        calls.push(req);
        return { data: req.schema.parse(answer), cached: false };
      }) as PluginServerContext['llm']['callJson'],
    },
  };
  return { llm, calls };
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'sovits-root-'));
});

describe('names', () => {
  it('folds kanji variants, drops epoch / step / version tags and emotion tags', () => {
    expect(tokens('高松燈-e15')).toEqual(['高松灯']);
    expect(tokens('灯_e8_s200')).toEqual(['灯']);
    expect(tokens('takamatsu_tomori_e8_s200')).toEqual(['takamatsu', 'tomori']);
    expect(tokens('【開心】今日はいい天気')).toEqual(['今日はいい天気']);
    expect(runOf('tomori_e8_s200')).toEqual({ epoch: 8, step: 200 });
    expect(runOf('高松燈-e15')).toEqual({ epoch: 15, step: 0 });
    expect(runOf('plain')).toEqual({ epoch: 0, step: 0 });
  });
  it.each(['高松燈-e15', '灯_e8_s200', 'takamatsu_tomori_e8_s200', 'tomori-e15', '高松灯', 'ともり_e3'])('"%s" names key 001', (name) => {
    expect(scoreText(aliasesOf('001', '高松灯'), [name])).toBeGreaterThanOrEqual(5);
    expect(scoreText(aliasesOf('002', '千早爱音'), [name])).toBeLessThan(5);
  });
  it('knows the Japanese spellings of Ave Mujica / MyGO names', () => {
    expect(scoreText(aliasesOf('010', '丰川祥子'), ['豊川祥子_e10'])).toBeGreaterThanOrEqual(5);
    expect(scoreText(aliasesOf('003', '要乐奈'), ['要楽奈-e5'])).toBeGreaterThanOrEqual(5);
    expect(scoreText(aliasesOf('002', '千早爱音'), ['chihaya_anon_e2'])).toBeGreaterThanOrEqual(5);
  });
  it('reference text from a file name: sentences yes, labels no', () => {
    expect(looksLikeSentence('今日はいい天気')).toBe(true);
    expect(looksLikeSentence('tomori_01')).toBe(false);
    expect(looksLikeSentence('ref3')).toBe(false);
    expect(guessLang('今日はいい天気')).toBe('ja');
    expect(guessLang('今天天气不错')).toBe('zh');
  });
});

describe('scan', () => {
  it('finds weights with their version family and reference audio with text from txt / list / file name', () => {
    touch('GPT_weights_v2Pro/tomori-e15.ckpt');
    touch('GPT_weights/old-e5.ckpt');
    touch('SoVITS_weights_v2Pro/tomori_e8_s200.pth');
    touch('pretrained_models/gsv-v2final-pretrained/s2G2333k.pth');
    touch('GPT_SoVITS/pretrained_models/s1bert25hz.ckpt');
    touch('ref/高松灯/【平静】今日はいい天気.wav', wav(5));
    touch('ref/a.wav', wav(4));
    touch('ref/a.txt', 'テキストです\n');
    touch('ref/b.wav', wav(4));
    touch('ref/x.list', 'D:/somewhere/b.wav|tomori|JA|リストの文です\n');
    touch('参考音频/c.wav', wav(4));
    const s = scanInstall(root);
    expect(s.gpt.map((w) => [w.rel, w.family]).sort()).toEqual([['GPT_weights/old-e5.ckpt', 'v1'], ['GPT_weights_v2Pro/tomori-e15.ckpt', 'v2Pro']]);
    expect(s.sovits.map((w) => w.family)).toEqual(['v2Pro']);
    expect(s.gpt.every((w) => !w.rel.includes('pretrained'))).toBe(true);
    const by = (b: string) => s.refs.find((r) => r.rel.endsWith(b))!;
    expect(by('今日はいい天気.wav')).toMatchObject({ text: '今日はいい天気', textFrom: 'filename', lang: 'ja', tag: '平静', folders: ['高松灯'] });
    expect(by('ref/a.wav')).toMatchObject({ text: 'テキストです', textFrom: 'txt' });
    expect(by('b.wav')).toMatchObject({ text: 'リストの文です', textFrom: 'list', lang: 'ja' });
    expect(by('c.wav')).toMatchObject({ text: '', textFrom: 'none' });
    expect(by('a.wav').seconds).toBeCloseTo(4, 1);
  });
  it('explains a missing folder', () => {
    expect(() => scanInstall(path.join(root, 'nope'))).toThrow(/同一台电脑/);
    expect(() => scanInstall('')).toThrow(/还没有填/);
  });
});

describe('auto match by name', () => {
  it('matches every spelling to key 001 and takes the highest epoch, GPT and SoVITS from the same family', async () => {
    touch('GPT_weights_v2Pro/高松燈-e8.ckpt');
    touch('GPT_weights_v2Pro/高松燈-e15.ckpt');
    touch('SoVITS_weights_v2Pro/灯_e8_s200.pth');
    touch('SoVITS_weights_v2Pro/灯_e4_s100.pth');
    touch('GPT_weights/takamatsu_tomori_e30.ckpt'); // a higher epoch, but in another family without a SoVITS pair
    const r = await autoMatch(stubLlm({ matches: [] }, false).llm, { sovitsRoot: root, refDirs: [] }, CAST);
    const row = r.rows.find((x) => x.characterKey === '001')!;
    expect(row.source).toBe('filename');
    expect(row.gpt).toBe(path.join(root, 'GPT_weights_v2Pro', '高松燈-e15.ckpt'));
    expect(row.sovits).toBe(path.join(root, 'SoVITS_weights_v2Pro', '灯_e8_s200.pth'));
    expect(r.unmatched).toEqual(['002', '003', '010']);
    expect(r.ai).toBe('unavailable');
  });
  it('a per-character reference folder counts, and the file name (minus tags and extension) is the reference text', async () => {
    touch('ref/高松灯/【平静】今日はいい天気.wav', wav(5));
    touch('ref/高松灯/short.wav', wav(1));
    touch('ref/anon/【怒り】もう知らない.wav', wav(5));
    touch('ref/tomori/foo.wav', wav(5));
    const r = await autoMatch(stubLlm({ matches: [] }, false).llm, { sovitsRoot: root, refDirs: [] }, CAST);
    expect(r.rows.find((x) => x.characterKey === '001')!.ref).toMatchObject({ text: '今日はいい天気', lang: 'ja' });
    expect(r.rows.find((x) => x.characterKey === '002')!.ref).toMatchObject({ text: 'もう知らない' });
  });
  it('uses folders the person added, named after the character', async () => {
    const extra = fs.mkdtempSync(path.join(os.tmpdir(), 'refs-'));
    const dir = path.join(extra, '千早愛音');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, '【通常】おはよう、今日もよろしく.wav'), wav(4));
    const r = await autoMatch(stubLlm({ matches: [] }, false).llm, { sovitsRoot: root, refDirs: [dir] }, CAST);
    expect(r.rows.find((x) => x.characterKey === '002')!.ref).toMatchObject({ text: 'おはよう、今日もよろしく' });
  });
  it('leaves ambiguous files alone (two characters named equally)', async () => {
    touch('GPT_weights/tomori_anon_e5.ckpt');
    const r = await autoMatch(stubLlm({ matches: [] }, false).llm, { sovitsRoot: root, refDirs: [] }, CAST);
    expect(r.rows).toEqual([]);
  });
});

describe('auto match: AI fallback', () => {
  it('asks only about unclaimed files for unmatched characters and keeps real paths only', async () => {
    touch('GPT_weights_v2Pro/tomori-e15.ckpt');
    touch('GPT_weights_v2Pro/ksm_e10.ckpt');
    touch('SoVITS_weights_v2Pro/ksm_e10_s300.pth');
    const stub = stubLlm({
      matches: [
        { characterKey: '003', gpt: 'GPT_weights_v2Pro/ksm_e10.ckpt', sovits: 'SoVITS_weights_v2Pro/ksm_e10_s300.pth', ref: null, reason: 'ksm 是 户山香澄的缩写' },
        { characterKey: '002', gpt: 'GPT_weights_v2Pro/not-in-the-list.ckpt', reason: '编造' },
        { characterKey: '010', gpt: '../../etc/passwd', reason: '越界' },
        { characterKey: '001', gpt: 'GPT_weights_v2Pro/ksm_e10.ckpt', reason: '001 已经按文件名匹配，AI 不该再改' },
        { characterKey: 'zzz', gpt: 'GPT_weights_v2Pro/ksm_e10.ckpt', reason: '不存在的角色' },
      ],
    });
    const r = await autoMatch(stub.llm, { sovitsRoot: root, refDirs: [] }, CAST);
    expect(stub.calls).toHaveLength(1);
    const sent = stub.calls[0]!.user as { characters: Array<{ characterKey: string }>; files: { gpt: string[] } };
    expect(sent.characters.map((c) => c.characterKey)).toEqual(['002', '003', '010']); // 001 was matched by name
    expect(sent.files.gpt).toEqual(['GPT_weights_v2Pro/ksm_e10.ckpt']); // tomori's file is claimed
    expect(r.ai).toBe('used');
    const ai = r.rows.find((x) => x.source === 'ai')!;
    expect(ai).toMatchObject({ characterKey: '003', reason: 'ksm 是 户山香澄的缩写', gpt: path.join(root, 'GPT_weights_v2Pro', 'ksm_e10.ckpt'), sovits: path.join(root, 'SoVITS_weights_v2Pro', 'ksm_e10_s300.pth') });
    expect(r.rows.filter((x) => x.source === 'ai')).toHaveLength(1);
    expect(r.rows.find((x) => x.characterKey === '001')!.source).toBe('filename');
    expect(r.unmatched).toEqual(['002', '010']);
  });
  it('is not called when nothing is left to match, or when no AI is configured; a failing call only warns', async () => {
    touch('GPT_weights/tomori-e1.ckpt');
    const none = stubLlm({ matches: [] });
    expect((await autoMatch(none.llm, { sovitsRoot: root, refDirs: [] }, [CAST[0]!])).ai).toBe('not-needed');
    expect(none.calls).toHaveLength(0);
    touch('GPT_weights/mystery.ckpt');
    const off = stubLlm({ matches: [] }, false);
    expect((await autoMatch(off.llm, { sovitsRoot: root, refDirs: [] }, CAST)).ai).toBe('unavailable');
    expect(off.calls).toHaveLength(0);
    const bad: Pick<PluginServerContext, 'llm'> = { llm: { available: () => ({ ok: true }), callJson: (async () => { throw new Error('boom'); }) as PluginServerContext['llm']['callJson'] } };
    const r = await autoMatch(bad, { sovitsRoot: root, refDirs: [] }, CAST);
    expect(r.ai).toBe('failed');
    expect(r.warnings.join()).toContain('boom');
    expect(r.rows.map((x) => x.characterKey)).toEqual(['001']);
  });
});

describe('review table', () => {
  it('rows that would replace a filled field start unchecked', () => {
    const row = { characterKey: '001', name: '高松灯', gpt: 'a.ckpt', source: 'filename' as const };
    expect(overwrites(row, undefined)).toBe(false);
    expect(overwrites(row, { promptText: '', promptLang: 'ja', speed: 1 })).toBe(false);
    expect(overwrites(row, { promptText: '', promptLang: 'ja', speed: 1, gptWeights: 'a.ckpt' })).toBe(false);
    expect(overwrites(row, { promptText: '', promptLang: 'ja', speed: 1, gptWeights: 'other.ckpt' })).toBe(true);
  });
});
