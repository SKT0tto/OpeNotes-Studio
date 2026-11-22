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
  it('rewrites given names, full names and family names', () => {
    expect(readingForTts('燈ちゃん、おはよう', CAST)).toBe('ともりちゃん、おはよう');
    expect(readingForTts('高松燈', CAST)).toBe('たかまつともり');
    expect(readingForTts('高松 燈さん', CAST)).toBe('たかまつ ともりさん');
    expect(readingForTts('豊川さんが来た', CAST)).toBe('とがわさんが来た');
    expect(readingForTts('楽奈は寝てる', CAST)).toBe('らーなは寝てる');
    expect(readingForTts('立希、行くよ', CAST)).toBe('たき、行くよ');
    expect(readingForTts('八幡さんと愛音', CAST)).toBe('やはたさんとあのん');
    expect(readingForTts('峰月先輩', CAST)).toBe('みねつき先輩');
  });
  it('never touches ordinary words', () => {
    for (const t of ['必要だよ', '要は、そういうこと', '重要な話', '要約して', '藤色のリボン', '大事な要件']) expect(readingForTts(t, CAST)).toBe(t);
  });
  it('single-kanji word-like names need an honorific', () => {
    expect(readingForTts('藤さん', CAST)).toBe('ふじさん');
    expect(readingForTts('要さん', CAST)).toBe('かなめさん');
    expect(readingForTts('要、来て', CAST)).toBe('要、来て');
  });
  it('leaves other names and kana names alone', () => {
    expect(readingForTts('燈ちゃん', ['002'])).toBe('燈ちゃん');
    expect(readingForTts('燈ちゃん', [])).toBe('燈ちゃん');
    expect(readingForTts('そよさんとにゃむ', CAST)).toBe('そよさんとにゃむ');
    expect(readingForTts('ともりちゃん', CAST)).toBe('ともりちゃん');
    expect(readingForTts('長崎さん', ['004'])).toBe('ながさきさん');
  });
  it('the voice hash is computed from the spoken line, not the reading', () => {
    const profile = { promptText: 'x', promptLang: 'ja', speed: 1 } as never;
    const a = voiceHash('燈ちゃん', profile, 'ja');
    expect(a).toBe(voiceHash('燈ちゃん', profile, 'ja'));
    expect(a).not.toBe(voiceHash(readingForTts('燈ちゃん', CAST), profile, 'ja'));
  });
});
