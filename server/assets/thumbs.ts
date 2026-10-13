/**
 * Thumbnails of backgrounds without any native image library: a small PNG decoder (8-bit, not interlaced), an area-average downscale
 * and a PNG encoder, all on node:zlib. The asset library's backgrounds are plain PNGs; anything else (16-bit, interlaced) is served as is.
 * Results are cached under data/cache/thumbs/ (not part of the repository). When the original is missing the client falls back to the
 * contact sheets in .verify/bg (a descriptor from `/api/thumbs/backgrounds/:id/sheet`), and when those are missing too, to a placeholder card.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { Router } from 'express';
import { BACKGROUND_ID_RE } from '../../shared/schema/ground';
import type { StudioConfig } from '../config';

export interface Raster {
  width: number;
  height: number;
  /** RGBA, 4 bytes per pixel. */
  data: Uint8Array;
}

const SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

export function decodePng(buf: Buffer): Raster | null {
  if (buf.length < 33 || !buf.subarray(0, 8).equals(SIG)) return null;
  let off = 8;
  let w = 0, h = 0, depth = 0, ctype = 0, interlace = 0;
  let palette: Buffer | null = null;
  let trns: Buffer | null = null;
  const idat: Buffer[] = [];
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('latin1', off + 4, off + 8);
    const body = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      w = body.readUInt32BE(0); h = body.readUInt32BE(4); depth = body[8]!; ctype = body[9]!; interlace = body[12]!;
    } else if (type === 'PLTE') palette = Buffer.from(body);
    else if (type === 'tRNS') trns = Buffer.from(body);
    else if (type === 'IDAT') idat.push(body);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  if (!w || !h || depth !== 8 || interlace !== 0 || w * h > 64_000_000) return null;
  const channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[ctype];
  if (!channels || (ctype === 3 && !palette)) return null;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * channels;
  if (raw.length < (stride + 1) * h) return null;
  const px = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y++) {
    const ft = raw[y * (stride + 1)]!;
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    for (let i = 0; i < stride; i++) {
      const x = raw[src + i]!;
      const a = i >= channels ? px[dst + i - channels]! : 0;
      const b = y > 0 ? px[dst - stride + i]! : 0;
      const c = i >= channels && y > 0 ? px[dst - stride + i - channels]! : 0;
      let v: number;
      switch (ft) {
        case 0: v = x; break;
        case 1: v = x + a; break;
        case 2: v = x + b; break;
        case 3: v = x + ((a + b) >> 1); break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default: return null;
      }
      px[dst + i] = v & 255;
    }
  }
  const out = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    let r: number, g: number, bl: number, al = 255;
    if (ctype === 6) { r = px[i * 4]!; g = px[i * 4 + 1]!; bl = px[i * 4 + 2]!; al = px[i * 4 + 3]!; }
    else if (ctype === 2) { r = px[i * 3]!; g = px[i * 3 + 1]!; bl = px[i * 3 + 2]!; }
    else if (ctype === 0) { r = g = bl = px[i]!; }
    else if (ctype === 4) { r = g = bl = px[i * 2]!; al = px[i * 2 + 1]!; }
    else { const k = px[i]!; r = palette![k * 3]!; g = palette![k * 3 + 1]!; bl = palette![k * 3 + 2]!; al = trns && k < trns.length ? trns[k]! : 255; }
    out[i * 4] = r; out[i * 4 + 1] = g; out[i * 4 + 2] = bl; out[i * 4 + 3] = al;
  }
  return { width: w, height: h, data: out };
}

/** Area-average downscale to `width` (keeps the aspect ratio). */
export function downscale(src: Raster, width: number): Raster {
  const w = Math.max(1, Math.min(width, src.width));
  const h = Math.max(1, Math.round((src.height * w) / src.width));
  const out = new Uint8Array(w * h * 4);
  const sx = src.width / w, sy = src.height / h;
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor(y * sy), y1 = Math.max(y0 + 1, Math.min(src.height, Math.ceil((y + 1) * sy)));
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor(x * sx), x1 = Math.max(x0 + 1, Math.min(src.width, Math.ceil((x + 1) * sx)));
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let yy = y0; yy < y1; yy++) {
        let i = (yy * src.width + x0) * 4;
        for (let xx = x0; xx < x1; xx++, i += 4) { r += src.data[i]!; g += src.data[i + 1]!; b += src.data[i + 2]!; a += src.data[i + 3]!; n++; }
      }
      const o = (y * w + x) * 4;
      out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n; out[o + 3] = a / n;
    }
  }
  return { width: w, height: h, data: out };
}

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
const crc32 = (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = CRC[(c ^ x) & 255]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type: string, body: Buffer) => {
  const head = Buffer.alloc(8); head.writeUInt32BE(body.length, 0); head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0);
  return Buffer.concat([head, body, crc]);
};

export function encodePng(r: Raster): Buffer {
  const stride = r.width * 4;
  const raw = Buffer.alloc((stride + 1) * r.height);
  for (let y = 0; y < r.height; y++) { raw[y * (stride + 1)] = 0; Buffer.from(r.data.buffer, r.data.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1); }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(r.width, 0); ihdr.writeUInt32BE(r.height, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([SIG, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 6 })), chunk('IEND', Buffer.alloc(0))]);
}

export interface SheetCell { sheet: string; x: number; y: number; w: number; h: number; sheetW: number; sheetH: number }

export interface ThumbOptions {
  /** Directory of the contact sheets and their `sheet-index.json` (developer machines only; `.verify/bg`). */
  sheetDir?: string;
}

const exists = (p: string) => fs.stat(p).then(() => true, () => false);

export function thumbRoutes(config: StudioConfig, opts: ThumbOptions = {}): Router {
  const r = Router();
  const cacheDir = path.join(config.dataDir, 'cache', 'thumbs');
  const sheetDir = path.resolve(opts.sheetDir ?? path.join('.verify', 'bg'));
  const inflight = new Map<string, Promise<Buffer | null>>();

  async function thumb(id: string, width: number): Promise<Buffer | null> {
    const src = path.join(config.assetRoot, 'backgrounds', `${id}.png`);
    const st = await fs.stat(src).catch(() => null);
    if (!st) return null;
    const cache = path.join(cacheDir, `${id}-${width}-${Math.round(st.mtimeMs)}.png`);
    const hit = await fs.readFile(cache).catch(() => null);
    if (hit) return hit;
    let p = inflight.get(cache);
    if (!p) {
      p = (async () => {
        const dec = decodePng(await fs.readFile(src));
        if (!dec) return null;
        const png = encodePng(downscale(dec, width));
        await fs.mkdir(cacheDir, { recursive: true });
        const tmp = `${cache}.${process.pid}.tmp`;
        await fs.writeFile(tmp, png);
        await fs.rename(tmp, cache).catch(() => fs.rm(tmp, { force: true }));
        return png;
      })().finally(() => inflight.delete(cache));
      inflight.set(cache, p);
    }
    return p;
  }

  r.get('/api/thumbs/backgrounds/:id', async (req, res) => {
    const id = String(req.params.id);
    if (!BACKGROUND_ID_RE.test(id)) return void res.status(400).json({ error: 'invalid background id' });
    const width = Math.min(1024, Math.max(64, Number(req.query.w) || 320));
    try {
      const buf = await thumb(id, width);
      if (!buf) {
        // not decodable here: serve the original when it exists
        const orig = path.join(config.assetRoot, 'backgrounds', `${id}.png`);
        if (await exists(orig)) return void res.sendFile(orig);
        return void res.status(404).json({ error: 'original missing' });
      }
      res.set('Content-Type', 'image/png').set('Cache-Control', 'public, max-age=3600').send(buf);
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  /** Where the background sits on a contact sheet (the client crops it), or 404 when there is no sheet. */
  r.get('/api/thumbs/backgrounds/:id/sheet', async (req, res) => {
    const id = String(req.params.id);
    if (!BACKGROUND_ID_RE.test(id)) return void res.status(400).json({ error: 'invalid background id' });
    try {
      const index = JSON.parse(await fs.readFile(path.join(sheetDir, 'sheet-index.json'), 'utf8')) as Record<string, SheetCell>;
      const cell = index[id];
      if (!cell || !/^[\w-]+\.jpg$/.test(cell.sheet) || !(await exists(path.join(sheetDir, cell.sheet)))) return void res.status(404).json({ error: 'no contact sheet' });
      res.json({ ...cell, url: `/api/thumbs/sheets/${cell.sheet}` });
    } catch {
      res.status(404).json({ error: 'no contact sheet' });
    }
  });

  r.get('/api/thumbs/sheets/:name', async (req, res) => {
    const name = String(req.params.name);
    if (!/^[\w-]+\.jpg$/.test(name)) return void res.status(400).json({ error: 'invalid sheet name' });
    const file = path.join(sheetDir, name);
    if (!(await exists(file))) return void res.status(404).json({ error: 'no contact sheet' });
    res.set('Cache-Control', 'public, max-age=3600').sendFile(file);
  });
  return r;
}
