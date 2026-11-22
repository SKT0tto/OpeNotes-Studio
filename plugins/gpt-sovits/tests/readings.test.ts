import { describe, expect, it } from 'vitest';
import { JA_NAMES, JA_NAME_KANA, ROMAJI_ALIASES } from '../../../shared/catalog/romaji';
import { voiceHash } from '../src/service';
import { readingForTts } from '../src/names';

const CAST = ['001', '002', '003', '004', '005', '006', '008', '010', '013', '014'];

describe('readingForTts', () => {
  it('covers all 25 characters in the name tables', () => {
    for (let i = 1; i <= 25; i++) {
      const k = String(i).padStart(3, '0');
      expect(JA_NAMES[k], k).toBeTruthy();
      expect(JA_NAME_KANA[k], k).toBeTruthy();
      expect(ROMAJI_ALIASES[k], k).toBeTruthy();
      expect(JA_NAMES[k]?.full).toBe(`${JA_NAMES[k]?.family}${JA_NAMES[k]?.given}`);
    }
  });
  it('rewrites the misread parts into katakana', () => {
    expect(readingForTts('燈ちゃん、おはよう', CAST)).toBe('トモリちゃん、おはよう');
    expect(readingForTts('高松燈', CAST)).toBe('高松トモリ');
    expect(readingForTts('高松 燈さん', CAST)).toBe('高松 トモリさん');
    expect(readingForTts('豊川祥子', CAST)).toBe('トガワサキコ');
    expect(readingForTts('豊川さんが来た', CAST)).toBe('トガワさんが来た');
    expect(readingForTts('楽奈は寝てる', CAST)).toBe('ラーナは寝てる');
    expect(readingForTts('立希、行くよ', CAST)).toBe('タキ、行くよ');
    expect(readingForTts('八幡さんと愛音', CAST)).toBe('八幡さんとアノン');
    expect(readingForTts('峰月先輩', CAST)).toBe('ミネツキ先輩');
    expect(readingForTts('伊沢さんと浜崎さん', ['017', '019'])).toBe('イザワさんとハマサキさん');
    expect(readingForTts('馬橋さん', ['022'])).toBe('マハシさん');
  });
  it('keeps the parts pyopenjtalk reads correctly', () => {
    expect(readingForTts('若葉さんと三角さん', CAST)).toBe('若葉さんと三角さん');
    expect(readingForTts('藤さん、蛍さん、凪さん', ['014', '016', '018'])).toBe('藤さん、蛍さん、凪さん');
    expect(readingForTts('高松さん', CAST)).toBe('高松さん');
  });
  it('never touches ordinary words', () => {
    for (const t of ['必要だよ', '要は、そういうこと', '重要な話', '要約して', '藤色のリボン', '大事な要件']) expect(readingForTts(t, CAST)).toBe(t);
  });
  it('要 needs an honorific', () => {
    expect(readingForTts('要さん', CAST)).toBe('カナメさん');
    expect(readingForTts('要、来て', CAST)).toBe('要、来て');
  });
  it('leaves other names and kana names alone', () => {
    expect(readingForTts('燈ちゃん', ['002'])).toBe('燈ちゃん');
    expect(readingForTts('燈ちゃん', [])).toBe('燈ちゃん');
    expect(readingForTts('そよさんとにゃむ', CAST)).toBe('そよさんとにゃむ');
    expect(readingForTts('ともりちゃん', CAST)).toBe('ともりちゃん');
  });
  it('the voice hash is computed from the spoken line, not the reading', () => {
    const profile = { promptText: 'x', promptLang: 'ja', speed: 1 } as never;
    const a = voiceHash('燈ちゃん', profile, 'ja');
    expect(a).toBe(voiceHash('燈ちゃん', profile, 'ja'));
    expect(a).not.toBe(voiceHash(readingForTts('燈ちゃん', CAST), profile, 'ja'));
  });
});
