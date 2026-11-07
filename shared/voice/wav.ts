/**
 * Duration of a PCM WAV from its header. Streaming encoders write a bogus data size (0, 0xFFFFFFFF, or more than the file holds):
 * then the data chunk is taken to run to the end of the file. Returns null when this is not a WAV we can read.
 */
export function wavSeconds(bytes: Uint8Array): number | null {
  if (bytes.length < 12) return null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (o: number) => String.fromCharCode(bytes[o]!, bytes[o + 1]!, bytes[o + 2]!, bytes[o + 3]!);
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return null;
  let byteRate = 0;
  let pos = 12;
  while (pos + 8 <= bytes.length) {
    const id = tag(pos);
    const size = dv.getUint32(pos + 4, true);
    const body = pos + 8;
    if (id === 'fmt ') {
      if (body + 16 > bytes.length) return null;
      byteRate = dv.getUint32(body + 8, true);
    } else if (id === 'data') {
      if (byteRate <= 0) return null;
      const remaining = bytes.length - body;
      const n = size === 0 || size === 0xffffffff || size > remaining ? remaining : size;
      return n / byteRate;
    }
    pos = body + size + (size % 2);
  }
  return null;
}

/** Builds a mono 16-bit PCM WAV (tests, fake servers). `bogusSize` writes a streaming-style header (data size 0xFFFFFFFF). */
export function makeWav(samples: Int16Array, sampleRate = 32000, opts: { bogusSize?: boolean } = {}): Uint8Array {
  const dataBytes = samples.length * 2;
  const out = new Uint8Array(44 + dataBytes);
  const dv = new DataView(out.buffer);
  const put = (o: number, s: string) => [...s].forEach((c, i) => (out[o + i] = c.charCodeAt(0)));
  put(0, 'RIFF');
  dv.setUint32(4, opts.bogusSize ? 0xffffffff : 36 + dataBytes, true);
  put(8, 'WAVE');
  put(12, 'fmt ');
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true);
  dv.setUint16(22, 1, true);
  dv.setUint32(24, sampleRate, true);
  dv.setUint32(28, sampleRate * 2, true);
  dv.setUint16(32, 2, true);
  dv.setUint16(34, 16, true);
  put(36, 'data');
  dv.setUint32(40, opts.bogusSize ? 0xffffffff : dataBytes, true);
  for (let i = 0; i < samples.length; i++) dv.setInt16(44 + i * 2, samples[i]!, true);
  return out;
}
