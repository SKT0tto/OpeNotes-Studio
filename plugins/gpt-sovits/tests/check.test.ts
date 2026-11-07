import { describe, expect, it } from 'vitest';
import { makeWav } from '../../../shared/voice/wav';
import { MIN_MORAE, decodeWav, estimateMorae, judgeTake, soundSpan } from '../src/check';

const RATE = 16000;
/** `lead` s of near-silence, `sound` s of tone, `tail` s of near-silence. */
function tone(lead: number, sound: number, tail: number, amp = 8000): Uint8Array {
  const n = Math.round((lead + sound + tail) * RATE);
  const a = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / RATE;
    const on = t >= lead && t < lead + sound;
    a[i] = Math.round(Math.sin((2 * Math.PI * 220 * i) / RATE) * (on ? amp : 3)); // 3/32768 = -80 dBFS
  }
  return makeWav(a, RATE);
}

describe('soundSpan', () => {
  it('finds the first and last sound at -35 dB and ignores the near-silence around it', () => {
    const s = soundSpan(tone(0.4, 1.5, 0.7))!;
    expect(s.first).toBeCloseTo(0.4, 1);
    expect(s.last).toBeCloseTo(1.9, 1);
    expect(s.span).toBeCloseTo(1.5, 1);
    expect(s.duration).toBeCloseTo(2.6, 2);
  });
  it('does not depend on the loudness of the voice', () => {
    expect(soundSpan(tone(0.2, 1, 0.2, 20000))!.span).toBeCloseTo(soundSpan(tone(0.2, 1, 0.2, 2000))!.span, 1);
  });
  it('is null for silence and for bytes that are not a WAV; reads a streaming header', () => {
    expect(soundSpan(makeWav(new Int16Array(RATE), RATE))).toBeNull();
    expect(soundSpan(new Uint8Array(100))).toBeNull();
    expect(decodeWav(makeWav(new Int16Array([1, 2, 3, 4]), RATE, { bogusSize: true }))!.samples).toHaveLength(4);
  });
});

describe('estimateMorae', () => {
  it('counts kana 1, small kana 0, kanji 1.8, and ignores punctuation', () => {
    expect(estimateMorae('はい')).toBe(2);
    expect(estimateMorae('きょう、ね。')).toBe(3); // き ょ(0) う ね
    expect(estimateMorae('がっこう')).toBe(3); // っ is 0
    expect(estimateMorae('本当に')).toBeCloseTo(4.6);
    expect(estimateMorae('ラーメン！？…')).toBe(4);
    expect(estimateMorae('')).toBe(0);
  });
});

describe('judgeTake', () => {
  const text = 'これは本当にちょっと長い台詞ですよね'; // about 25 morae
  const morae = estimateMorae(text);
  it('passes a take with enough sound per mora and fails one that ends early', () => {
    expect(judgeTake(tone(0.1, morae * 0.18, 0.1), text).ok).toBe(true);
    const bad = judgeTake(tone(0.1, morae * 0.07, 0.1), text);
    expect(bad.ok).toBe(false);
    expect(bad.ratio).toBeCloseTo(0.07, 2);
  });
  it('does not judge text under the mora floor, or audio it cannot read', () => {
    expect(estimateMorae('うん')).toBeLessThan(MIN_MORAE);
    expect(judgeTake(tone(0, 0.05, 0), 'うん').ok).toBeNull();
    expect(judgeTake(new Uint8Array(10), text).ok).toBeNull();
  });
  it('allows a faster voice proportionally less time per mora', () => {
    const take = tone(0.1, morae * 0.095, 0.1);
    expect(judgeTake(take, text, 1).ok).toBe(false);
    expect(judgeTake(take, text, 1.4).ok).toBe(true);
  });
});
