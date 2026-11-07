import { describe, expect, it } from 'vitest';
import { addressAlternatives, addressForm, addressForms, selfForm, selfForms } from '../../../shared/catalog/addressing';
import data from '../../../shared/data/addressing.json';
import characters from '../../../shared/data/characters.json';
import { fixAddress } from '../src/names';
import { VOICE_JA_SYSTEM } from '../src/prompt';

const CAST = ['001', '002', '003', '004', '005'];

describe('addressing table parsing', () => {
  it('takes the current step of a → chain and the first 、 alternative', () => {
    expect(addressForm('002', '001')).toBe('ともりん'); // 高松さん→燈ちゃん→ともりん
    expect(addressForm('002', '008')).toBe('海鈴ちゃん');
    expect(addressForm('008', '009')).toBe('祐天寺さん'); // 祐天寺さん、にゃむち、ニャムコ
    expect(addressForm('001', '002')).toBe('あのちゃん');
  });
  it('takes the persona before the first / and gives null for -', () => {
    expect(addressForm('001', '007')).toBe('睦ちゃん'); // 睦ちゃん/-
    expect(addressForm('007', '001')).toBe('燈');
    expect(addressForm('003', '007')).toBeNull(); // -/モーティス
    expect(addressForms('003', '007')).toEqual(['モーティス']);
  });
  it('use[to] wins', () => {
    expect(addressForm('005', '003')).toBe('楽奈'); // 野良猫、楽奈 with use
    expect(addressForm('010', '006')).toBe('初華'); // 初華、初音さん→初音 with use
  });
  it('addressForms lists every form once, without -', () => {
    expect(addressForms('002', '001')).toEqual(['高松さん', '燈ちゃん', 'ともりん']);
    expect(addressForms('001', '007')).toEqual(['睦ちゃん']);
    expect(addressForms('008', '009')).toEqual(['祐天寺さん', 'にゃむち', 'ニャムコ']);
    expect(addressAlternatives('005', '003')).toEqual(['野良猫']);
  });
  it('self forms: reading in （）, last step, first alternative', () => {
    expect(selfForm('010')).toBe('わたくし');
    expect(selfForms('010')).toEqual(['わたくし']);
    expect(selfForm('011')).toBe('ぼく');
    expect(selfForm('009')).toBe('アタシ');
    expect(selfForms('009')).toEqual(['アタシ', 'にゃむ']);
    expect(selfForm('007')).toBe('私');
    expect(selfForm('005')).toBe('私');
  });
  it('unknown speaker or pair is null / []', () => {
    expect(addressForm('999', '001')).toBeNull();
    expect(addressForm('001', '999')).toBeNull();
    expect(addressForm('001', '001')).toBeNull();
    expect(addressForms('999', '001')).toEqual([]);
    expect(selfForm('999')).toBeNull();
    expect(selfForm('017')).toBeNull();
    expect(selfForms('017')).toEqual([]);
  });
});

describe('addressing data sanity', () => {
  const keys = new Set(characters.characters.map((c) => c.key));
  const people = data.people as Record<string, { self?: string; to?: Record<string, string>; use?: Record<string, string> }>;
  it('every key exists in characters.json and every default is a non-empty string', () => {
    for (const [k, p] of Object.entries(people)) {
      expect(keys.has(k), k).toBe(true);
      for (const to of Object.keys(p.to ?? {})) {
        expect(keys.has(to), `${k}->${to}`).toBe(true);
        const f = addressForm(k, to);
        // null is allowed only where the cell has no persona of its own (-/…)
        if (f !== null) expect(f.length, `${k}->${to}`).toBeGreaterThan(0);
        else expect(p.to![to]!.trim().startsWith('-'), `${k}->${to}`).toBe(true);
      }
      for (const to of Object.keys(p.use ?? {})) expect(keys.has(to)).toBe(true);
      if (p.self) expect(selfForm(k)?.length ?? 0, k).toBeGreaterThan(0);
    }
  });
});

describe('fixAddress', () => {
  it('爱音 calls 灯 ともりん', () => {
    expect(fixAddress('燈ちゃん、待ってよ', '002', CAST)).toBe('ともりん、待ってよ');
    expect(fixAddress('ねえ燈。', '002', CAST)).toBe('ねえともりん。');
    expect(fixAddress('燈さんは？', '002', CAST)).toBe('ともりんは？');
  });
  it('灯 calls 立希 立希ちゃん, without applying twice', () => {
    expect(fixAddress('立希、来て', '001', CAST)).toBe('立希ちゃん、来て');
    expect(fixAddress('立希さんは？', '001', CAST)).toBe('立希ちゃんは？');
    expect(fixAddress('立希ちゃん、来て', '001', CAST)).toBe('立希ちゃん、来て');
    expect(fixAddress('立希ちゃんと立希', '001', CAST)).toBe('立希ちゃんと立希ちゃん');
  });
  it('立希 says 私, not あたし', () => {
    expect(fixAddress('あたしは行かない', '005', CAST)).toBe('私は行かない');
    expect(fixAddress('それが、あたしの仕事', '005', CAST)).toBe('それが、私の仕事');
    expect(fixAddress('僕もだ。俺は', '005', CAST)).toBe('私もだ。私は');
  });
  it('leaves 私 / わたし, own forms and longer words alone', () => {
    expect(fixAddress('わたしは行く', '005', CAST)).toBe('わたしは行く');
    expect(fixAddress('アタシはにゃむ', '009', CAST)).toBe('アタシはにゃむ');
    expect(fixAddress('ぼくじょうの朝、僕達は', '005', CAST)).toBe('ぼくじょうの朝、私達は');
    expect(fixAddress('俺様は', '005', CAST)).toBe('俺様は');
    expect(fixAddress('私（わたくし）', '010', CAST)).toBe('私（わたくし）');
  });
  it('skips family-name forms, the speaker, longer words and non-cast', () => {
    expect(fixAddress('高松さん、おはよう', '002', CAST)).toBe('高松さん、おはよう');
    expect(fixAddress('高松燈さん', '002', CAST)).toBe('高松燈さん');
    expect(fixAddress('燈ちゃん', '001', CAST)).toBe('燈ちゃん'); // the speaker is not addressed
    expect(fixAddress('燈ちゃん', '002', ['002'])).toBe('燈ちゃん'); // 灯 not in the cast
    expect(fixAddress('そよ風が吹く', '001', CAST)).toBe('そよ風が吹く');
  });
  it('unknown pairs, unknown speaker and no data: unchanged', () => {
    expect(fixAddress('燈、あたしは', '999', CAST)).toBe('燈、あたしは');
    expect(fixAddress('燈、あたしは', null, CAST)).toBe('燈、あたしは');
    expect(fixAddress('立希、あたしは', '017', ['016', '017'])).toBe('立希、あたしは');
    expect(fixAddress('愛音、燈', '003', ['003'])).toBe('愛音、燈');
  });
});

describe('prompt', () => {
  it('asks for address and self', () => {
    expect(VOICE_JA_SYSTEM).toContain('characters[speaker].address');
    expect(VOICE_JA_SYSTEM).toContain('self');
  });
});
