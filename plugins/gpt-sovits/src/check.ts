/**
 * Missing-word check. GPT-SoVITS sometimes ends a line early, in the middle of the text. The recording is then much shorter than the
 * Japanese needs: `span` (seconds between the first and the last sound at -35 dB) divided by the estimated number of morae falls below
 * ~0.125 s per mora, where a complete take stays well above (172 real runs: the 10 cut-off takes were < 0.125, the next one 0.129).
 * Pure functions on bytes and text; no I/O.
 */

/** Sound threshold in dB below the loudest frame (a quiet voice must not read as "short"). */
export const SOUND_DB = -35;
/** Seconds of sound per estimated mora below which a take is taken for cut off. */
export const MIN_SECONDS_PER_MORA = 0.125;
/**
 * Texts with fewer estimated morae are not checked: `はい` / `うん` are 2, and under ~0.75 s of sound a breath, a lip noise or one fast word
 * moves the ratio by more than the gap between a good and a cut-off take.
 */
export const MIN_MORAE = 6;
/** More takes than this are never made for one line (the first one plus two retries). */
export const MAX_TAKES = 3;

export interface Pcm { sampleRate: number; samples: Float32Array }

/** Decodes a PCM (8/16/24/32-bit integer, 32-bit float) WAV to mono floats in -1..1; null when it is not one. */
export function decodeWav(bytes: Uint8Array): Pcm | null {
  if (bytes.length < 44) return null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (o: number) => String.fromCharCode(bytes[o]!, bytes[o + 1]!, bytes[o + 2]!, bytes[o + 3]!);
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return null;
  let fmt: { format: number; channels: number; rate: number; bits: number } | null = null;
  let pos = 12;
  while (pos + 8 <= bytes.length) {
    const id = tag(pos);
    const size = dv.getUint32(pos + 4, true);
    const body = pos + 8;
    if (id === 'fmt ') {
      if (body + 16 > bytes.length) return null;
      let format = dv.getUint16(body, true);
      if (format === 0xfffe && size >= 26) format = dv.getUint16(body + 24, true); // WAVE_FORMAT_EXTENSIBLE: the sub-format
      fmt = { format, channels: dv.getUint16(body + 2, true), rate: dv.getUint32(body + 4, true), bits: dv.getUint16(body + 14, true) };
    } else if (id === 'data') {
      if (!fmt || fmt.channels < 1 || fmt.rate <= 0) return null;
      const remaining = bytes.length - body;
      const n = size === 0 || size === 0xffffffff || size > remaining ? remaining : size; // streaming headers lie
      const width = fmt.bits / 8;
      if (!Number.isInteger(width) || width < 1 || width > 4) return null;
      if (fmt.format === 3 ? fmt.bits !== 32 : fmt.format !== 1) return null;
      const frames = Math.floor(n / (width * fmt.channels));
      const out = new Float32Array(frames);
      for (let i = 0; i < frames; i++) {
        let sum = 0;
        for (let c = 0; c < fmt.channels; c++) {
          const o = body + (i * fmt.channels + c) * width;
          sum += fmt.format === 3 ? dv.getFloat32(o, true)
            : width === 2 ? dv.getInt16(o, true) / 32768
              : width === 1 ? (bytes[o]! - 128) / 128
                : width === 3 ? ((bytes[o]! | (bytes[o + 1]! << 8) | (bytes[o + 2]! << 16)) << 8 >> 8) / 8388608
                  : dv.getInt32(o, true) / 2147483648;
        }
        out[i] = sum / fmt.channels;
      }
      return { sampleRate: fmt.rate, samples: out };
    }
    pos = body + size + (size % 2);
  }
  return null;
}

export interface Span {
  /** Seconds between the first and the last sound. */
  span: number;
  first: number;
  last: number;
  duration: number;
  /** Loudest 10 ms frame (RMS, full scale = 1). */
  peak: number;
}

const FRAME_SECONDS = 0.01;

/** First and last sound: 10 ms RMS frames at `db` below the loudest frame. Null for silence or an unreadable file. */
export function soundSpan(bytes: Uint8Array, db = SOUND_DB): Span | null {
  const pcm = decodeWav(bytes);
  if (!pcm || pcm.samples.length === 0) return null;
  const size = Math.max(1, Math.round(pcm.sampleRate * FRAME_SECONDS));
  const frames = Math.ceil(pcm.samples.length / size);
  const rms = new Float32Array(frames);
  let peak = 0;
  for (let f = 0; f < frames; f++) {
    const a = f * size;
    const b = Math.min(pcm.samples.length, a + size);
    let sum = 0;
    for (let i = a; i < b; i++) sum += pcm.samples[i]! * pcm.samples[i]!;
    rms[f] = Math.sqrt(sum / (b - a));
    if (rms[f]! > peak) peak = rms[f]!;
  }
  if (peak < 1e-4) return null;
  const limit = peak * 10 ** (db / 20);
  let lo = 0;
  while (lo < frames && rms[lo]! < limit) lo++;
  let hi = frames - 1;
  while (hi > lo && rms[hi]! < limit) hi--;
  const first = (lo * size) / pcm.sampleRate;
  const last = Math.min(pcm.samples.length, (hi + 1) * size) / pcm.sampleRate;
  return { span: Math.max(0, last - first), first, last, duration: pcm.samples.length / pcm.sampleRate, peak };
}

const SMALL_KANA = new Set([...'ゃゅょっぁぃぅぇぉゎャュョッァィゥェォヮ']);
const KANA = /[぀-ヿ]/;
const KANJI = /[㐀-鿿々]/;

/** Spoken length in morae, roughly: kana 1 (the long-vowel mark too), small kana 0, kanji 1.8, digits 1.8, latin letters 0.5; punctuation 0. */
export function estimateMorae(spoken: string): number {
  let n = 0;
  for (const c of spoken.normalize('NFKC')) {
    if (SMALL_KANA.has(c)) continue;
    if (c === 'ー' || KANA.test(c)) n += 1;
    else if (KANJI.test(c) || /\d/.test(c)) n += 1.8;
    else if (/[a-z]/i.test(c)) n += 0.5;
  }
  return n;
}

export interface Verdict {
  /** null = not checked (too short to judge, or the audio could not be read). */
  ok: boolean | null;
  span: number;
  morae: number;
  /** Seconds of sound per mora. */
  ratio: number;
  threshold: number;
}

/** Is this take complete? `speed` is the profile's speech speed: a faster voice needs proportionally less time per mora. */
export function judgeTake(bytes: Uint8Array, spoken: string, speed = 1): Verdict {
  const morae = estimateMorae(spoken);
  const threshold = MIN_SECONDS_PER_MORA / Math.max(1, speed);
  const s = morae >= MIN_MORAE ? soundSpan(bytes) : null;
  if (!s) return { ok: null, span: 0, morae, ratio: 0, threshold };
  const ratio = s.span / morae;
  return { ok: ratio >= threshold, span: s.span, morae, ratio, threshold };
}
