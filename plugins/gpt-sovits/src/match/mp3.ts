import fs from 'node:fs';

const BITRATE_V1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const BITRATE_V2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
const RATE: Record<number, number[]> = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };

interface Frame { length: number; samples: number; rate: number; mono: boolean; v1: boolean }

function header(b: Uint8Array, at: number): Frame | null {
  if (at + 4 > b.length || b[at] !== 0xff || (b[at + 1]! & 0xe0) !== 0xe0) return null;
  const version = (b[at + 1]! >> 3) & 3; // 3 = MPEG1, 2 = MPEG2, 0 = MPEG2.5
  const layer = (b[at + 1]! >> 1) & 3; // 1 = layer III
  const bi = b[at + 2]! >> 4;
  const si = (b[at + 2]! >> 2) & 3;
  if (version === 1 || layer !== 1 || bi === 0 || bi === 15 || si === 3) return null;
  const v1 = version === 3;
  const kbps = (v1 ? BITRATE_V1 : BITRATE_V2)[bi]!;
  const rate = RATE[version]![si]!;
  const pad = (b[at + 2]! >> 1) & 1;
  return { length: Math.floor(((v1 ? 144 : 72) * kbps * 1000) / rate) + pad, samples: v1 ? 1152 : 576, rate, mono: (b[at + 3]! >> 6) === 3, v1 };
}

/** Seconds of an MPEG audio layer III stream in memory: a Xing / Info frame count when there is one, else the sum of the frames. Null when unreadable. */
export function mp3SecondsOf(b: Uint8Array): number | null {
  try {
    let pos = 0;
    if (b.length >= 10 && b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) {
      pos = 10 + (((b[6]! & 0x7f) << 21) | ((b[7]! & 0x7f) << 14) | ((b[8]! & 0x7f) << 7) | (b[9]! & 0x7f)) + (b[5]! & 0x10 ? 10 : 0);
    }
    // the first real frame: two consecutive valid headers, so a stray 0xFF in tag data is not taken for one
    let first: Frame | null = null;
    for (; pos < b.length - 4 && !first; pos++) {
      const f = header(b, pos);
      if (f && header(b, pos + f.length)) first = f;
      else if (f && pos + f.length >= b.length - 4) first = f;
      if (first) break;
    }
    if (!first) return null;
    const start = pos;
    const x = start + 4 + (first.v1 ? (first.mono ? 17 : 32) : first.mono ? 9 : 17);
    const tag = String.fromCharCode(b[x] ?? 0, b[x + 1] ?? 0, b[x + 2] ?? 0, b[x + 3] ?? 0);
    if ((tag === 'Xing' || tag === 'Info') && ((b[x + 7] ?? 0) & 1)) {
      const frames = ((b[x + 8]! << 24) | (b[x + 9]! << 16) | (b[x + 10]! << 8) | b[x + 11]!) >>> 0;
      if (frames > 0) return (frames * first.samples) / first.rate;
    }
    let total = 0;
    let at = start;
    while (at < b.length) {
      const f = header(b, at);
      if (!f) {
        // junk or a trailing tag: look for the next frame a little further on, otherwise stop
        let next = -1;
        for (let i = at + 1; i < Math.min(b.length - 4, at + 4096); i++) if (header(b, i)) { next = i; break; }
        if (next < 0) break;
        at = next;
        continue;
      }
      total += f.samples / f.rate;
      at += f.length;
    }
    return total > 0 ? total : null;
  } catch {
    return null;
  }
}

/** Seconds of an mp3 file; null for anything else (unreadable, huge, not mpeg). Never throws. */
export function mp3Seconds(file: string): number | null {
  try {
    if (fs.statSync(file).size > 64 * 1024 * 1024) return null;
    return mp3SecondsOf(fs.readFileSync(file));
  } catch {
    return null;
  }
}
